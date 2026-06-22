// seed_data.js — シード被り回避の「データ取得・集計」層。
//   - fetch は行うが DOM には触れない。fetchPlayer / fetchPrefs は注入可能（テスト・別環境用）。
//   - 出力は seed_optimizer.optimize() の入力データ部（prefByUid / prefCounts / recentPair / recentMeta）。
// 設計: docs/seed_collision_avoidance.md §3
//
// フォールバック方針（ユーザー合意済みのみ）:
//   - 都道府県不明 → 地域罰則 0（prefByUid に載らない）。
//   - 選手 JSON が DB 未登録(404) → 対戦履歴なし扱い（= 罰則 0）。これは「データが無い」事実であり
//     黙った劣化ではない。呼び出し側に missing として返し UI で明示する。
//   - 通信エラー(404 以外) → errors に積んで返す。黙ってスキップしない。

(function (global) {
  'use strict';

  const EPOCH_DAYS = 1 / 86400000;
  // 'YYYY-MM-DD' → epoch days（UTC基準, 整数）。
  function dateToDays(iso) {
    const t = Date.parse(iso + 'T00:00:00Z');
    return Number.isFinite(t) ? Math.floor(t * EPOCH_DAYS) : null;
  }

  function sizeWeightFn(kind) {
    switch (kind) {
      case 'sqrt': return (n) => Math.sqrt(Math.max(n, 2));
      case 'linear': return (n) => Math.max(n, 2);
      case 'log2':
      default: return (n) => Math.log2(Math.max(n, 2));
    }
  }

  // 日付減衰: Δ日 <= plateau は固定重み1、plateau〜cutoff で急減し cutoff(既定365)で0、以降0。
  // 減少は (1 - x)^pow（x=(Δ-plateau)/(cutoff-plateau)）。pow を大きくするほど急減。
  function recentDecayFn(plateau, cutoff, pow) {
    const span = Math.max(1e-9, cutoff - plateau);
    return (delta) => {
      if (delta <= plateau) return 1;
      if (delta >= cutoff) return 0;
      const x = (delta - plateau) / span;
      return Math.pow(1 - x, pow);
    };
  }

  function pairKey(a, b) { return a < b ? a + ':' + b : b + ':' + a; }

  // 地域グルーピング: 被り回避では近隣の県を同一地域として扱う。
  // 既定で南関東(埼玉・千葉・神奈川・東京)を1グループにまとめる。
  const DEFAULT_REGION_GROUPS = {
    '埼玉県': '南関東', '千葉県': '南関東', '神奈川県': '南関東', '東京都': '南関東',
  };

  const DEFAULT_DATA_PARAMS = {
    recentPlateauDays: 182.5, // この日数までは固定重み（半年）
    recentCutoffDays: 365,    // この日数で重み0（以降も0）
    recentDecayPow: 3,        // plateau〜cutoff の急減度（大きいほど急）
    sizeWeight: 'log2',       // 大会規模重み
    todayDays: null,          // null なら実行時の現在日
  };

  // ── デフォルト fetch（ブラウザ用）。prefix は seed ページからの相対パス基準。
  function defaultFetchers(prefix) {
    prefix = prefix || '../';
    return {
      fetchPlayer: async (uid) => {
        const res = await fetch(`${prefix}players/${uid}.json`);
        if (res.status === 404) return { __missing: true };
        if (!res.ok) throw new Error(`players/${uid}.json HTTP ${res.status}`);
        return res.json();
      },
      fetchPrefs: async () => {
        const res = await fetch(`${prefix}data/player_prefectures.json`);
        if (!res.ok) throw new Error(`player_prefectures.json HTTP ${res.status}`);
        return res.json();
      },
    };
  }

  // 同時実行数を制限して player JSON を取得。
  async function fetchAllPlayers(uids, fetchPlayer, concurrency, onProgress) {
    const players = {};           // uid -> json
    const missing = [];           // DB 未登録(404)
    const errors = [];            // 通信エラー
    let done = 0;
    const queue = uids.slice();
    async function worker() {
      while (queue.length) {
        const uid = queue.shift();
        try {
          const j = await fetchPlayer(uid);
          if (j && j.__missing) missing.push(uid);
          else players[uid] = j;
        } catch (e) {
          errors.push({ uid, message: String(e && e.message || e) });
        }
        done++;
        if (onProgress) onProgress({ phase: 'fetch', done, total: uids.length });
      }
    }
    const workers = [];
    for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
    await Promise.all(workers);
    return { players, missing, errors };
  }

  // メイン: ランキング(uid配列) → optimizer 入力データ部。
  async function buildSeedData(ranking, opts) {
    opts = opts || {};
    const params = Object.assign({}, DEFAULT_DATA_PARAMS, opts.params || {});
    const fetchers = Object.assign(defaultFetchers(opts.prefix), opts);
    const onProgress = opts.onProgress || null;
    const concurrency = opts.concurrency || 8;

    const attendeeSet = new Set(ranking);
    const decayFn = recentDecayFn(params.recentPlateauDays, params.recentCutoffDays, params.recentDecayPow);
    const sw = sizeWeightFn(params.sizeWeight);
    const todayDays = (params.todayDays != null)
      ? params.todayDays : Math.floor(Date.now() * EPOCH_DAYS);

    // 都道府県（地域グルーピング適用。既定で南関東をまとめる）。
    const regionGroups = opts.regionGroups || DEFAULT_REGION_GROUPS;
    const prefAll = await fetchers.fetchPrefs();
    const prefByUid = {};
    const prefCounts = {};
    for (const uid of ranking) {
      const praw = prefAll[String(uid)] || prefAll[uid] || null;
      const p = praw ? (regionGroups[praw] || praw) : null;
      prefByUid[uid] = p;
      if (p) prefCounts[p] = (prefCounts[p] || 0) + 1;
    }

    // 選手 JSON
    const { players, missing, errors } = await fetchAllPlayers(
      ranking, fetchers.fetchPlayer, concurrency, onProgress);

    // 直近対戦罰則（疎）。各 a の recent_matches を走査し、a<opp のときだけ加算（二重計上回避）。
    const recentPair = {};
    const recentMeta = {};
    for (const uid of ranking) {
      const pj = players[uid];
      if (!pj || !Array.isArray(pj.recent_matches)) continue;
      // event_id -> nent（自分の tournaments[] から）
      const nentOf = {};
      if (Array.isArray(pj.tournaments)) {
        for (const t of pj.tournaments) if (t && t.event_id != null) nentOf[t.event_id] = t.nent;
      }
      for (const m of pj.recent_matches) {
        const opp = m.opp_uid;
        if (opp == null || opp === uid) continue;
        if (!attendeeSet.has(opp)) continue;
        if (!(uid < opp)) continue;       // 片側のみ集計
        const dd = m.date ? dateToDays(m.date) : null;
        if (dd == null) continue;
        const decay = decayFn(todayDays - dd);
        if (decay <= 0) continue;          // 365日超は罰則0
        const nent = nentOf[m.event_id];
        const sizeW = (nent != null) ? sw(nent) : sw(2);  // nent 不明時は最小規模(log2(2)=1)。要約: §3.2 で結合可を確認済
        const val = decay * sizeW;
        const key = pairKey(uid, opp);
        recentPair[key] = (recentPair[key] || 0) + val;
        const meta = recentMeta[key] || (recentMeta[key] = { penalty: 0, count: 0, lastDate: null, lastDeltaDays: null });
        meta.penalty += val;
        meta.count += 1;
        if (!meta.lastDate || m.date > meta.lastDate) meta.lastDate = m.date;
        const delta = todayDays - dd;
        if (meta.lastDeltaDays == null || delta < meta.lastDeltaDays) meta.lastDeltaDays = delta;
      }
    }

    return {
      prefByUid, prefCounts, recentPair, recentMeta,
      meta: {
        attendees: ranking.length,
        withPlayerJson: Object.keys(players).length,
        missing,                 // DB 未登録 uid（履歴なし扱い）
        errors,                  // 通信エラー（UI で明示すべき）
        prefIdentified: Object.values(prefByUid).filter(Boolean).length,
      },
    };
  }

  const API = {
    buildSeedData, fetchAllPlayers, defaultFetchers,
    dateToDays, sizeWeightFn, recentDecayFn, pairKey,
    DEFAULT_DATA_PARAMS, DEFAULT_REGION_GROUPS,
  };
  global.SeedData = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
