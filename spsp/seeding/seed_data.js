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

  // 日付減衰: 制御点 [[日, 重み], ...] の折れ線（線形補間）。
  //   Δ ≤ 最初の点 → その重み（=1）。Δ ≥ 最後の点 → 0。間は線形補間。
  //   既定で 0:1 / 30:0.9 / 91:0.7 / 182.5:0.5 / 273.75:0.12 / 365:0（1ヶ月・3ヶ月・半年に差、半年以降は急減）。
  function recentDecayFn(points) {
    const pts = (points && points.length ? points : [[0, 1], [365, 0]]).slice()
      .map((p) => [Number(p[0]), Number(p[1])]).sort((a, b) => a[0] - b[0]);
    return (delta) => {
      if (delta <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        if (delta <= pts[i][0]) {
          const d0 = pts[i - 1][0], w0 = pts[i - 1][1], d1 = pts[i][0], w1 = pts[i][1];
          return w0 + (w1 - w0) * ((delta - d0) / Math.max(1e-9, d1 - d0));
        }
      }
      return 0; // 最後の点より後は0
    };
  }

  function pairKey(a, b) { return a < b ? a + ':' + b : b + ':' + a; }

  // 地域グルーピング: 被り回避では近隣の県を同一地域として扱う。
  // 各グループは UI トグルで個別に ON/OFF できる（buildRegionGroups）。
  const REGION_GROUP_DEFS = {
    // 南関東(埼玉・千葉・神奈川・東京)。既定 ON。
    minamiKanto: { '埼玉県': '南関東', '千葉県': '南関東', '神奈川県': '南関東', '東京都': '南関東' },
    // 京阪神(兵庫・大阪・京都)。既定 OFF。
    keihanshin: { '兵庫県': '京阪神', '大阪府': '京阪神', '京都府': '京阪神' },
  };

  // トグル指定からグルーピング表を組み立てる。既定: 南関東 ON / 京阪神 OFF。
  function buildRegionGroups(opts) {
    opts = opts || {};
    const g = {};
    if (opts.minamiKanto !== false) Object.assign(g, REGION_GROUP_DEFS.minamiKanto);
    if (opts.keihanshin === true) Object.assign(g, REGION_GROUP_DEFS.keihanshin);
    return g;
  }

  // 既定（南関東のみ）。後方互換のため従来名も残す。
  const DEFAULT_REGION_GROUPS = buildRegionGroups();

  const DEFAULT_DATA_PARAMS = {
    // 日付減衰の制御点 [[日, 重み], ...]（線形補間。最後の点より後は0）。
    // 1ヶ月まではフル(1.0)＝直後の再戦を徹底回避、3ヶ月0.5/半年0.25/1年0。
    recentDecayPoints: [[0, 1], [30, 1], [91, 0.5], [182.5, 0.25], [365, 0]],
    sizeWeight: 'log2',          // 大会規模重み
    todayDays: null,             // null なら実行時の現在日
    // ペア内集計: 同じ2人が複数回対戦した分の罰則をどうまとめるか。
    //   'max'(既定): そのペアの最も重い1試合だけ採用（対戦回数に依らず横並び）。
    //   'sum'       : 全対戦の罰則を合算（頻度の高い常連カードほど重く＝強く分離）。
    recentAgg: 'max',
    // true なら平日扱いの大会 (is_weekend=false = 平日開催 + 実質平日 + プレ大会) での
    // 対戦を直近対戦罰則の集計から除外する。休日/平日の判定は出場者全員の
    // tournaments[] から作る event_id→is_weekend 表による。表に無い大会（is_weekend
    // 不明）は除外しない（= 保守的に再対戦回避の対象に残す。件数は meta で明示）。
    excludeWeekday: false,
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
    const decayFn = recentDecayFn(params.recentDecayPoints);
    const sw = sizeWeightFn(params.sizeWeight);
    // 試合日付は JST のカレンダー日付なので「今日」も JST 基準で数える
    // （UTC floor だと JST 朝9時まで前日扱いになり decay 境界が1日ずれる）。
    const JST_OFFSET_MS = 9 * 3600000;
    const todayDays = (params.todayDays != null)
      ? params.todayDays : Math.floor((Date.now() + JST_OFFSET_MS) * EPOCH_DAYS);

    // 都道府県（地域グルーピング適用。既定で南関東をまとめる）。
    // prefsOptional=true（例: 地域被り回避 OFF でレポート表示にしか使わない）のときは
    // 取得失敗を致命にせず meta.prefsError に積んで続行する。既定(false)は従来どおり throw。
    const regionGroups = opts.regionGroups || DEFAULT_REGION_GROUPS;
    const prefByUid = {};
    const prefCounts = {};
    let prefsError = null;
    let prefAll = {};
    try {
      prefAll = await fetchers.fetchPrefs();
    } catch (e) {
      if (opts.prefsOptional === true) prefsError = String(e && e.message || e);
      else throw e;
    }
    for (const uid of ranking) {
      const praw = prefAll[String(uid)] || prefAll[uid] || null;
      const p = praw ? (regionGroups[praw] || praw) : null;
      prefByUid[uid] = p;
      if (p) prefCounts[p] = (prefCounts[p] || 0) + 1;
    }

    // 選手 JSON
    const { players, missing, errors } = await fetchAllPlayers(
      ranking, fetchers.fetchPlayer, concurrency, onProgress);

    // 直近対戦罰則（疎）。両方向から走査する: 以前は a<opp の片側だけ集計していたが、
    // 低 uid 側の JSON が DB 未登録(404)/欠損だと高 uid 側に記録があっても罰則が消え、
    // どちらが消えるかが uid の大小という偶然で決まっていた。
    // 同一試合が両者のファイルに載る通常ケースは試合キーで二重計上を防ぐ。
    const recentPair = {};
    const recentMeta = {};
    const seenMatch = new Set();   // pair|event|phase|round|date（同一試合の両側記録デデュープ）
    // excludeWeekday 用: event_id → is_weekend（計算上の休日扱い）。出場者全員の
    // tournaments[] を先に走査して作る（片側の JSON にしか大会情報が無くても
    // どちらの選手から処理しても同じ判定になる = 対称）。
    const weekendOf = {};
    if (params.excludeWeekday) {
      for (const uid of ranking) {
        const pj = players[uid];
        if (!pj || !Array.isArray(pj.tournaments)) continue;
        for (const t of pj.tournaments) {
          if (t && t.event_id != null && typeof t.is_weekend === 'boolean') weekendOf[t.event_id] = t.is_weekend;
        }
      }
    }
    let weekdayExcludedMatches = 0;   // excludeWeekday で除外した試合数（UI 明示用）
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
        const dd = m.date ? dateToDays(m.date) : null;
        if (dd == null) continue;
        const matchKey = pairKey(uid, opp) + '|' + (m.event_id != null ? m.event_id : '') +
          '|' + (m.phase_name || '') + '|' + (m.round != null ? m.round : '') +
          '|' + (m.round_text || '') + '|' + m.date;
        if (seenMatch.has(matchKey)) continue;   // 相手側ファイルで集計済みの同一試合
        seenMatch.add(matchKey);
        if (params.excludeWeekday && m.event_id != null && weekendOf[m.event_id] === false) {
          weekdayExcludedMatches++;   // ユニーク試合単位（dedup 後）でカウント
          continue;   // 平日扱いの大会（実質平日・プレ含む）は考慮しない
        }
        const decay = decayFn(todayDays - dd);
        if (decay <= 0) continue;          // 365日超は罰則0
        const nent = nentOf[m.event_id];
        const sizeW = (nent != null) ? sw(nent) : sw(2);  // nent 不明時は最小規模(log2(2)=1)。要約: §3.2 で結合可を確認済
        const val = decay * sizeW;
        const key = pairKey(uid, opp);
        const useMax = params.recentAgg !== 'sum';   // 既定 max
        recentPair[key] = useMax
          ? Math.max(recentPair[key] || 0, val)
          : (recentPair[key] || 0) + val;
        const meta = recentMeta[key] || (recentMeta[key] = {
          penalty: 0, count: 0, lastDate: null, lastDeltaDays: null,
          lastTournament: null, lastNent: null,
        });
        meta.penalty = useMax ? Math.max(meta.penalty, val) : meta.penalty + val;
        meta.count += 1;
        if (!meta.lastDate || m.date > meta.lastDate) {
          meta.lastDate = m.date;
          meta.lastTournament = m.tournament_name || null;
          meta.lastNent = (nent != null) ? nent : null;
        }
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
        prefsError,              // prefsOptional=true で取得失敗したときのメッセージ（UI で明示）
        weekdayExcludedMatches,  // excludeWeekday=true で除外したユニーク試合数（false なら 0）
      },
    };
  }

  const API = {
    buildSeedData, fetchAllPlayers, defaultFetchers,
    dateToDays, sizeWeightFn, recentDecayFn, pairKey,
    buildRegionGroups,
    DEFAULT_DATA_PARAMS, DEFAULT_REGION_GROUPS, REGION_GROUP_DEFS,
  };
  global.SeedData = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
