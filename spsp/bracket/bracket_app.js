// bracket_app.js — トーナメントプレビューの UI 層。
//   - URL フラグメント (SeedShare) からペイロードを復号し、フェーズ/プールを選んで
//     勝者側 (+オプションで敗者側+グランドファイナル) のブラケットを表示する。
//     全表示状態は URL と同期 (replaceState)。
//   - 描画は絶対配置 + SVG 接続線 (bp-round 列 / bp-links)。座標系は
//     PITCH (1回戦の縦ピッチ) を基準に、ラウンド r の m 試合目の中心 =
//     (m+0.5) * PITCH * 2^r。敗者側はラウンドごとの試合数で等分割。
//   - 選手情報は表示中プールの players/<uid>.json を遅延取得
//     (404=未登録 / それ以外はリトライ付き。失敗は明示)。
//     居住地・直近対戦の集計は seed_data.js の buildSeedData をプール単位で呼ぶ。
//   - ペイロード仕様: docs/seed_preview_design.md

(function () {
  'use strict';

  const S = window.SeedShare;
  const C = window.BracketCore;
  const D = window.SeedData;
  const O = window.SeedOptimizer;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // レイアウト定数 (px)
  const COLW = 232;      // 列 (試合カード) 幅
  const GAP = 34;        // 列間 (接続線) 幅
  const PITCH = 104;     // 1回戦の縦ピッチ
  const MATCH_H = 58;    // カードの基準高 (スロット2段。バッジは下にはみ出す)
  const TITLE_H = 26;    // ラウンド見出しの高さ
  const SLOT_DY = 13;    // カード中心から見た上段/下段スロットのおおよその中心
  const slotY = (centerY, bottom) => centerY + (bottom ? SLOT_DY : -SLOT_DY);

  const STATE = {
    payload: null,
    blob: null,           // 現在の payload の base64url (URL の d=)
    view: { ph: 0, pool: null, wd: 1, lb: 0, hi: null },
    prefsRaw: null,       // uid(str) -> 都道府県 (生値。表示用)
    overseas: null,       // Set<uid> (海外勢)
    players: new Map(),   // uid -> json | {__missing:true} | {__error:msg}
    poolAgg: new Map(),   // "ph:pool:wd:N" -> buildSeedData の結果
    charByUid: new Map(), // uid -> {name, emoji} (メイン使用キャラ)
    renderToken: 0,       // 非同期描画の競合ガード
    phasesEdited: false,  // このページでフェーズ構成を編集したか (データ版が共有元とズレる理由の説明用)
  };

  // ── エラー/ステータス表示 ───────────────────────────────
  function showError(msg) { const el = $('bp-error'); el.textContent = msg; el.hidden = false; }
  function clearError() { $('bp-error').hidden = true; }
  function setStatus(msg) { $('bp-status').textContent = msg || ''; }

  // ── URL 同期 ────────────────────────────────────────────
  function syncUrl() {
    if (!STATE.blob) return;
    const frag = S.buildFragment(STATE.view, STATE.blob);
    history.replaceState(null, '', location.pathname + location.search + frag);
    const len = location.href.length;
    $('bp-url-len').textContent = `URL ${len.toLocaleString()}字` + (len > 9500 ? ' (LINE等では長すぎる場合あり → CSV共有推奨)' : '');
  }

  // ── データ取得 (404=missing / それ以外は3回までリトライ) ──
  async function fetchJson(url) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * attempt));
      try {
        const res = await fetch(url);
        if (res.status === 404) return { __missing: true };
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('fetch 失敗');
  }

  async function loadStaticData() {
    const warns = [];
    try {
      STATE.prefsRaw = await fetchJson('../data/player_prefectures.json');
      if (STATE.prefsRaw.__missing) { STATE.prefsRaw = {}; warns.push('都道府県データがありません'); }
    } catch (e) { STATE.prefsRaw = {}; warns.push('都道府県データの取得に失敗: ' + e.message); }
    try {
      const ov = await fetchJson('../data/overseas.json');
      STATE.overseas = new Set((ov && ov.uids) || []);
    } catch (e) { STATE.overseas = new Set(); warns.push('海外勢データの取得に失敗: ' + e.message); }
    // メイン使用キャラの絵文字 (プレイヤーページと同じ定義: character_index の
    // main_by_char を逆引きして char_emoji の絵文字を引く)。無くても表示は続ける。
    try {
      const [idx, emo] = await Promise.all([
        fetchJson('../data/character_index.json'),
        fetchJson('../data/char_emoji.json'),
      ]);
      const mbc = idx && idx.main_by_char;
      if (mbc && emo && !emo.__missing) {
        for (const cid in mbc) {
          const c = emo[cid];
          if (!c || !c.emoji) continue;
          for (const u of mbc[cid] || []) STATE.charByUid.set(Number(u), c);
        }
      }
    } catch (e) { warns.push('キャラデータの取得に失敗: ' + e.message); }
    return warns;
  }

  // メイン使用キャラ ({name, emoji}) or null
  function mainCharOf(gi) {
    const uid = uidOf(gi);
    return (uid != null && STATE.charByUid.get(uid)) || null;
  }

  // 取得済み判定。__error (通信断・5xx) は一時的なことが多いので未取得扱いにして
  // 次の描画で再試行する (__missing = 404 = DB 未登録は確定なので再試行しない)。
  function playerLoaded(uid) {
    const p = STATE.players.get(uid);
    return p != null && !p.__error;
  }

  async function ensurePlayers(uids, onProgress) {
    const targets = uids.filter((u) => u != null && !playerLoaded(u));
    let done = 0;
    const queue = targets.slice();
    async function worker() {
      while (queue.length) {
        const uid = queue.shift();
        try {
          STATE.players.set(uid, await fetchJson(`../players/${uid}.json`));
        } catch (e) {
          // 通信エラー: __missing とは区別して保持 (missing=DB未登録, error=取得失敗)
          STATE.players.set(uid, { __error: String(e && e.message || e) });
        }
        done++;
        if (onProgress) onProgress(done, targets.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  // プール内の直近対戦・地域集計 (キャッシュ付き)。uids は uid のある参加者のみ渡す。
  async function getPoolAgg(uids, cacheKey) {
    if (STATE.poolAgg.has(cacheKey)) return STATE.poolAgg.get(cacheKey);
    const agg = await D.buildSeedData(uids, {
      fetchPlayer: async (uid) => {
        const pj = STATE.players.get(uid);
        return (pj && !pj.__error) ? pj : { __missing: true };
      },
      fetchPrefs: async () => STATE.prefsRaw || {},
      prefsOptional: true,
      params: { excludeWeekday: STATE.view.wd === 0 },
    });
    STATE.poolAgg.set(cacheKey, agg);
    return agg;
  }

  // ── 参加者ヘルパ ────────────────────────────────────────
  function uidOf(gi) { return STATE.payload.uids[gi]; }

  // 表示名の解決: players/<uid>.json → 共有データの names → '' (呼び出し側で扱う)
  function resolvedName(gi) {
    const uid = uidOf(gi);
    if (uid != null) {
      const pj = STATE.players.get(uid);
      if (pj && !pj.__missing && !pj.__error && pj.display) return pj.display;
    }
    return (STATE.payload.names && STATE.payload.names[String(gi)]) || '';
  }

  function nameOf(gi) { return resolvedName(gi) || '不明'; }

  // 居住地表示 (都道府県 or 国名)。不明は ''。
  function residenceOf(gi) {
    const uid = uidOf(gi);
    if (uid == null) return '';
    if (STATE.overseas && STATE.overseas.has(uid)) {
      const pj = STATE.players.get(uid);
      return (pj && !pj.__missing && !pj.__error && (pj.country_ja || pj.country)) || '海外';
    }
    return (STATE.prefsRaw && STATE.prefsRaw[String(uid)]) || '';
  }

  // ── フェーズ/プールの構造 ────────────────────────────────
  function phaseCounts() { return S.phaseEntrantCounts(STATE.payload.phases, STATE.payload.uids.length); }

  function currentPhase() {
    const ph = Math.max(0, Math.min(STATE.view.ph, STATE.payload.phases.length - 1));
    STATE.view.ph = ph;
    return ph;
  }

  function phaseWaveMap(ph) {
    const P = STATE.payload.phases[ph].pools;
    if (ph === 0 && Array.isArray(STATE.payload.wv) && STATE.payload.wv.length === P) return STATE.payload.wv;
    return S.chunkWaveMap(P, 1);
  }

  function poolLabels(ph) {
    const P = STATE.payload.phases[ph].pools;
    const wm = phaseWaveMap(ph);
    return Array.from({ length: P }, (_, i) => S.poolLabel(i, wm));
  }

  function currentPoolIdx() {
    const labels = poolLabels(currentPhase());
    const i = STATE.view.pool ? labels.indexOf(STATE.view.pool) : 0;
    return Math.max(0, i);
  }

  function aggKey(ph, poolIdx) { return `${ph}:${poolIdx}:${STATE.view.wd}:${STATE.payload.uids.length}`; }

  // ── 描画: タブ / プール選択 ──────────────────────────────
  function renderTabs() {
    const counts = phaseCounts();
    const ph = currentPhase();
    $('bp-phase-tabs').innerHTML = STATE.payload.phases.map((p, i) =>
      `<button class="bp-tab${i === ph ? ' on' : ''}" data-ph="${i}">${esc(p.name)} <small>${counts[i]}人/${p.pools}プール</small></button>`
    ).join('');
  }

  function renderPoolSelect() {
    const ph = currentPhase();
    const labels = poolLabels(ph);
    const wm = phaseWaveMap(ph);
    const sel = $('bp-pool-select');
    const cur = STATE.view.pool && labels.indexOf(STATE.view.pool) >= 0 ? STATE.view.pool : labels[0];
    STATE.view.pool = cur;
    const hasWaves = wm.some((w) => w > 0);
    if (hasWaves) {
      const groups = new Map();
      labels.forEach((lb, i) => {
        const w = S.waveLetter(wm[i]);
        if (!groups.has(w)) groups.set(w, []);
        groups.get(w).push(lb);
      });
      sel.innerHTML = [...groups.entries()].map(([w, ls]) =>
        `<optgroup label="ウェーブ ${esc(w)}">` +
        ls.map((lb) => `<option value="${esc(lb)}"${lb === cur ? ' selected' : ''}>${esc(lb)}</option>`).join('') +
        '</optgroup>'
      ).join('');
    } else {
      sel.innerHTML = labels.map((lb) =>
        `<option value="${esc(lb)}"${lb === cur ? ' selected' : ''}>${esc(lb)}</option>`).join('');
    }
  }

  // ── 描画: ブラケット本体 ─────────────────────────────────
  // 名前は共有データ (payload.names) だけで出せるので、**選手 JSON の取得を待たずに
  // まず描画する**。居住地・直近対戦のバッジは取得完了後の再描画で付く。
  // (上位帯の players/<uid>.json は 1 人 0.5〜1.7MB あり、64 人プールでは数十 MB になる。
  //  ここを待つと回線次第で真っ白なまま・失敗すると名前まで出ない、という状態になっていた)
  async function renderBracket() {
    const token = ++STATE.renderToken;
    const ph = currentPhase();
    const counts = phaseCounts();
    const P = STATE.payload.phases[ph].pools;
    const pools = C.phasePools(counts[ph], P);
    const labels = poolLabels(ph);
    const poolIdx = currentPoolIdx();
    STATE.view.pool = labels[poolIdx];
    syncUrl();

    const members = pools[poolIdx];           // globalIdx (0始まり) 昇順 = ローカルシード順
    const M = members.length;
    const adv = advOfPhase(ph);
    const lbIn = lbOfPhase(ph, M);
    $('bp-pool-info').textContent = `${labels[poolIdx]}: ${M}人` +
      (ph > 0 ? ' (シード通り進出の予測メンバー)' : '') +
      (lbIn > 0 ? ` / 勝者側スタート${M - lbIn}人・敗者側スタート${lbIn}人` : '') +
      (ph > 0 ? ` / 前フェーズの無敗通過 ${undefeatedCount(ph - 1)}人` : '') +
      (adv > 0 && adv < M ? ` / 上位${adv}人が通過 (通過が決まるところまで表示)` : '');

    const host = $('bp-bracket');
    if (M === 0) { host.innerHTML = '<div class="bp-hint">このプールに参加者がいません。</div>'; return; }

    const uids = members.map((gi) => uidOf(gi)).filter((u) => u != null);
    const cachedAgg = STATE.poolAgg.get(aggKey(ph, poolIdx)) || null;
    drawBracket(host, members, cachedAgg);

    // ここから先は付加情報 (居住地・直近対戦・プロフィール) の取得
    const pending = uids.filter((u) => !playerLoaded(u));
    if (pending.length) {
      setStatus(`選手データ取得中 0/${pending.length}…`);
      await ensurePlayers(uids, (d, t) => {
        if (token === STATE.renderToken) setStatus(`選手データ取得中 ${d}/${t}…`);
      });
      if (token !== STATE.renderToken) return;
    }
    let agg = cachedAgg;
    let aggWarn = '';
    try {
      agg = await getPoolAgg(uids, aggKey(ph, poolIdx));
    } catch (e) {
      aggWarn = '直近対戦の集計に失敗: ' + e.message;
    }
    if (token !== STATE.renderToken) return;

    drawBracket(host, members, agg);
    setStatus(statusLine(members, uids, agg, aggWarn));
  }

  // そのフェーズの1プールあたり進出人数 (最終フェーズは 0 = 優勝まで)。
  function advOfPhase(ph) {
    const p = STATE.payload.phases[ph];
    if (ph === STATE.payload.phases.length - 1) return 0;
    return Math.max(0, p.adv | 0);
  }

  // 前フェーズを**無敗のまま**通過した人数 (= 次フェーズを勝者側から始める人数)。
  // 1敗して通過した人を勝者側に置くと「敗者側から勝者側に上がる」ことになるので、
  // 敗者側スタートの既定値はこれで決める。
  const _undefCache = new Map();
  function undefeatedCount(ph) {
    const key = ph + ':' + STATE.payload.uids.length + ':' + JSON.stringify(STATE.payload.phases);
    if (_undefCache.has(key)) return _undefCache.get(key);
    const counts = phaseCounts();
    const P = Math.max(1, STATE.payload.phases[ph].pools | 0);
    const pools = C.phasePools(counts[ph], P);
    let n = 0;
    for (const members of pools) {
      if (!members.length) continue;
      const de = C.poolDoubleElim(members.length, advOfPhase(ph), lbOfPhase(ph, members.length));
      n += de.undefeated ? de.undefeated.length : 1;
    }
    _undefCache.set(key, n);
    return n;
  }

  // そのフェーズの1プールあたり敗者側スタート人数。
  // 明示指定 (phases[].lb) が無ければ「前フェーズを無敗で通過した人だけが勝者側」。
  function lbOfPhase(ph, poolSize) {
    const p = STATE.payload.phases[ph];
    const cap = Math.max(0, poolSize - 2);
    if (p.lb != null) return Math.max(0, Math.min(p.lb | 0, cap));
    if (ph === 0) return 0;
    const wb = Math.ceil(undefeatedCount(ph - 1) / Math.max(1, p.pools | 0));
    return Math.max(0, Math.min(poolSize - wb, cap));
  }

  function drawBracket(host, members, agg) {
    const ph = currentPhase();
    // 出どころチップは枠の左外に出るので、フェーズ1以降は左に余白を足す
    host.classList.toggle('has-prev', ph > 0);
    const de = C.poolDoubleElim(members.length, advOfPhase(ph), lbOfPhase(ph, members.length));
    const showLb = STATE.view.lb === 1 && de.losers.length > 0;
    const ctx = { members, agg, de, lastAt: lastAppearance(de, 'last'), firstAt: lastAppearance(de, 'first') };
    // GF 列は敗者側を出していて、かつ GF が実施される (= 優勝まで戦う) ときだけ
    let html = renderWinnersSection(de, ctx, showLb && played(de.gf));
    if (showLb) {
      html += '<div class="bp-sec-label">敗者側ブラケット</div>';
      html += renderLosersSection(de, ctx);
    } else if (STATE.view.lb === 1) {
      html += '<div class="bp-hint">このプールには敗者側がありません。</div>';
    }
    host.innerHTML = html;
  }

  // ステータス行 (fail-loud: 未登録・取得失敗・名前なしを理由付きで区別する)
  function statusLine(members, uids, agg, aggWarn) {
    const missing = uids.filter((u) => { const p = STATE.players.get(u); return p && p.__missing; });
    const errored = uids.filter((u) => { const p = STATE.players.get(u); return p && p.__error; });
    const unnamed = members.filter((gi) => !resolvedName(gi));
    const parts = [];
    if (missing.length) parts.push(`SPSP 未登録/データなし ${missing.length}人`);
    // 取得失敗があるときだけ再取得ボタンを出す (普段は出す意味がない)
    $('bp-reload').hidden = !errored.length;
    if (errored.length) {
      const why = STATE.players.get(errored[0]).__error;
      parts.push(`⚠ 選手データの取得失敗 ${errored.length}人 (${why}) — 右上の「🔄 選手データを再取得」で取り直せます`);
    }
    if (unnamed.length) {
      parts.push(`⚠ 名前が分からない参加者 ${unnamed.length}人: ` +
        unnamed.slice(0, 10).map((gi) => `シード${gi + 1} (${describeNameGap(gi)})`).join(', ') +
        (unnamed.length > 10 ? ' …' : ''));
    }
    const split = splitStartWarning(currentPhase(), members.length);
    if (split) parts.push(split);
    // 敗者側直入りのペアが実測テーブルに無い形なら、推定であることを明示する
    {
      const ph = currentPhase();
      const de = C.poolDoubleElim(members.length, advOfPhase(ph), lbOfPhase(ph, members.length));
      if (de.lbEntryEstimated) {
        parts.push('ℹ この人数構成の敗者側直入りの組み合わせは実ブラケットの観測例が無く、' +
          '既知のパターンからの推定です (実際の組み合わせと入れ替わる可能性があります)');
      }
    }
    if (agg && agg.meta && agg.meta.weekdayExcludedMatches) parts.push(`平日大会の対戦 ${agg.meta.weekdayExcludedMatches} 件を除外中`);
    if (aggWarn) parts.push(aggWarn);
    return parts.join(' / ');
  }

  // 勝者側スタート人数が「前フェーズを無敗で通過した人数」と食い違っていたら知らせる。
  // 食い違い自体は設定として許すが (実際にそう組む大会もある)、黙って通さない。
  function splitStartWarning(ph, M) {
    if (ph === 0 || !M) return '';
    const u = undefeatedCount(ph - 1);
    const P = Math.max(1, STATE.payload.phases[ph].pools | 0);
    const want = Math.max(0, Math.min(Math.ceil(u / P), M - 0));
    const wb = M - lbOfPhase(ph, M);
    if (wb === want) return '';
    return `⚠ 前フェーズを無敗で通過したのは ${u}人 (1プールあたり ${want}人) ですが、` +
      `勝者側スタートは ${wb}人 の設定です — ` +
      (wb > want ? '1敗で通過した人が勝者側から始まります' : '無敗で通過した人が敗者側から始まります') +
      ' (フェーズ構成の「敗者側スタート」で調整)';
  }

  // 名前が出せない理由 (共有データにも players/<uid>.json にも無い、のどれか)
  function describeNameGap(gi) {
    const uid = uidOf(gi);
    if (uid == null) return '共有データに名前なし';
    const pj = STATE.players.get(uid);
    if (!pj) return `uid ${uid}: 未取得`;
    if (pj.__error) return `uid ${uid}: 取得失敗 ${pj.__error}`;
    if (pj.__missing) return `uid ${uid}: SPSP DB になし`;
    return `uid ${uid}: 選手データに表示名なし`;
  }

  // 勝者側 (+GF) セクション。列 = WR1..WRk (+GF)。
  function renderWinnersSection(de, ctx, withGf) {
    const R = de.winners.length;
    const n1 = de.winners[0].length;
    const height = TITLE_H + n1 * PITCH;
    const nCols = R + (withGf ? 1 : 0);
    const width = nCols * COLW + (nCols - 1) * GAP;
    const center = (r, m) => (m + 0.5) * PITCH * Math.pow(2, r);

    let cols = '';
    for (let r = 0; r < R; r++) {
      // 表示名は打ち切り前のラウンド数基準 (2人抜けプールの最終戦を「決勝」と呼ばない)
      const title = withGf && r === R - 1 ? '勝者側決勝' : C.roundName(r + 1, de.wTotal);
      const cells = de.winners[r].map((m, i) => (played(m)
        ? matchDiv(m, ctx, TITLE_H + center(r, i) - MATCH_H / 2, null, `W:${r}:${i}`) : '')).join('');
      cols += `<div class="bp-round" style="left:${r * (COLW + GAP)}px">` +
        `<div class="bp-round-title">${esc(title)}</div>${cells}</div>`;
    }
    if (withGf) {
      const gfTop = TITLE_H + center(R - 1, 0) - MATCH_H / 2;
      cols += `<div class="bp-round" style="left:${R * (COLW + GAP)}px">` +
        `<div class="bp-round-title">グランドファイナル</div>` +
        matchDiv({ a: de.gf.a, b: de.gf.b, w: de.gf.w }, ctx, gfTop, '敗者側優勝') + '</div>';
    }

    let svgs = '';
    for (let r = 1; r < R; r++) {
      const paths = de.winners[r].map((m, i) => {
        if (!played(m)) return '';
        const cy = TITLE_H + center(r, i);
        const src = [de.winners[r - 1][2 * i], de.winners[r - 1][2 * i + 1]];
        // 上の試合の勝者 → 上段 / 下の試合の勝者 → 下段 (勝者側は a=勝ち上がりで固定)
        return [0, 1].map((k) => (played(src[k])
          ? link(slotY(TITLE_H + center(r - 1, 2 * i + k), false), slotY(cy, k === 1))
          : '')).join('');
      }).join('');
      svgs += linkSvg(r, height, paths);
    }
    if (withGf) {
      const y = TITLE_H + center(R - 1, 0);
      // 勝者側決勝の勝者 → GF 上段。敗者側優勝の枠は左に対応する枠が無いので線は引かない。
      svgs += linkSvg(R, height, link(slotY(y, false), slotY(y, false)));
    }
    return `<div class="bp-sec" style="width:${width}px;height:${height}px">${cols}${svgs}</div>`;
  }

  // 敗者側セクション。ラウンドごとの試合数で縦を等分割。
  function renderLosersSection(de, ctx) {
    const rounds = de.losers;
    const counts = rounds.map((r) => r.length);
    const secH = Math.max(...counts) * PITCH;
    const height = TITLE_H + secH;
    const width = rounds.length * COLW + (rounds.length - 1) * GAP;
    const center = (li, m) => (m + 0.5) * (secH / counts[li]);

    let cols = '';
    rounds.forEach((matches, li) => {
      const cells = matches.map((m, i) => (played(m)
        ? matchDiv(m, ctx, TITLE_H + center(li, i) - MATCH_H / 2, null, `L:${li}:${i}`, true) : '')).join('');
      cols += `<div class="bp-round bp-lb" style="left:${li * (COLW + GAP)}px">` +
        `<div class="bp-round-title">${esc(C.lbRoundName(li, de.lTotal))}</div>${cells}</div>`;
    });

    let svgs = '';
    for (let li = 1; li < rounds.length; li++) {
      const major = counts[li] === counts[li - 1];   // 勝者側から 1 人ずつ落ちてくるラウンド
      const paths = rounds[li].map((m, i) => {
        if (!played(m)) return '';
        const cy = TITLE_H + center(li, i);
        // 表示は勝ち上がる側を上段にしているので、a/b がどちらの段かはここで決まる
        const bTop = m.b != null && m.w === m.b;
        const yA = slotY(cy, bTop), yB = slotY(cy, !bTop);
        if (major) {
          // a = 前ラウンドの勝ち上がりだけ線を引く。b = 勝者側から落ちてくる側は
          // 左に対応する枠が無いので線は引かない (どこから来たかは枠内のバッジで示す)。
          const from = rounds[li - 1][i];
          return played(from) ? link(slotY(TITLE_H + center(li - 1, i), false), yA) : '';
        }
        // 敗者側どうしのペアリング: 上の試合の勝者 → a / 下の試合の勝者 → b
        const src = [rounds[li - 1][2 * i], rounds[li - 1][2 * i + 1]];
        return [0, 1].map((k) => (played(src[k])
          ? link(slotY(TITLE_H + center(li - 1, 2 * i + k), false), k === 0 ? yA : yB)
          : '')).join('');
      }).join('');
      svgs += linkSvg(li, height, paths);
    }
    return `<div class="bp-sec" style="width:${width}px;height:${height}px">${cols}${svgs}</div>`;
  }

  function linkSvg(colIdx, height, paths) {
    const left = colIdx * (COLW + GAP) - GAP;
    return `<svg class="bp-links" style="left:${left}px" width="${GAP}" height="${height}" ` +
      `viewBox="0 0 ${GAP} ${height}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
  }

  // 実施される試合か (片方でも空きなら bye = 非表示)
  function played(m) { return !!(m && m.a != null && m.b != null); }

  // 前の列のスロット (y1) → この列のスロット (y2) を結ぶ折れ線 (水平→垂直→水平)。
  // カード中心ではなく**スロット単位**で結ぶので、誰が次のどの枠に入るかが線で追える。
  function link(y1, y2) {
    const h = GAP / 2;
    return `<path d="M0 ${y1} H ${h} V ${y2} H ${GAP}"/>`;
  }

  function slotHtml(local, m, ctx, dropBadge, isB, key) {
    if (local == null) {
      return '<div class="bp-slot bp-bye"><div class="bp-line">' +
        '<span class="bp-seed"></span><span class="bp-name">BYE</span></div></div>';
    }
    const gi = ctx.members[local - 1];
    const uid = uidOf(gi);
    const pj = uid != null ? STATE.players.get(uid) : null;
    const nodb = uid == null || (pj && (pj.__missing || pj.__error));
    const res = residenceOf(gi);
    const hi = STATE.view.hi === gi;
    const cls = 'bp-slot' + (m.w === local ? ' bp-win' : '') + (nodb ? ' bp-nodb' : '') + (hi ? ' bp-hi' : '');
    // その選手が最後に出る試合なら、次フェーズのどこから始まるかを出す
    const last = key != null && ctx.lastAt && ctx.lastAt.get(local) === key + (isB ? ':b' : ':a');
    const ch = mainCharOf(gi);
    // 名前の下 (同じ枠の中) に並べるタグ: 落ちてきた元・落ちる先・居住地
    const tags = [
      dropFromBadge(ctx, local, gi, key),
      dropToBadge(ctx, m, local, gi, key),
      isB && dropBadge ? `<span class="bp-drop">${esc(dropBadge)}</span>` : '',
      res ? `<span class="bp-res">${esc(res)}</span>` : '',
    ].filter(Boolean).join('');
    const first = key != null && ctx.firstAt && ctx.firstAt.get(local) === key + (isB ? ':b' : ':a');
    return `<div class="${cls}">` +
      '<div class="bp-line">' +
      `<span class="bp-seed">${gi + 1}</span>` +
      (ch ? `<span class="bp-char" title="${esc(ch.name)}">${esc(ch.emoji)}</span>` : '') +
      `<span class="bp-name" data-gi="${gi}">${esc(nameOf(gi))}</span>` +
      '</div>' +
      (tags ? `<div class="bp-tags">${tags}</div>` : '') +
      // フェーズをまたぐ導線は枠の外 (出どころ=左 / 進出先=右)
      (first ? prevChip(gi) : '') +
      (last ? nextChip(gi) : '') + '</div>';
  }

  // 敗者側の枠に「↓勝者側○回戦」。その選手が敗者側で初めて出る枠にだけ出し、
  // クリックで落ちてきた元の試合へ飛べるようにする。
  // ドロップ戦 (major) だけでなく、敗者側1回戦のようなペアリング戦にも出る。
  // 敗者側スタート勢は勝者側に出ていないので何も出さない。
  function dropFromBadge(ctx, local, gi, key) {
    if (key == null || key[0] !== 'L') return '';
    const li = parseInt(key.split(':')[1], 10);
    const firstLb = ctx.de.losers.findIndex((round) => round.some((lm) => lm.a === local || lm.b === local));
    if (firstLb !== li) return '';                       // 敗者側での初登場だけ
    const r = ctx.de.winners.findIndex((round) => round.some((wm) => wm.l === local));
    if (r < 0) return '';                                // 敗者側スタート
    const mi = ctx.de.winners[r].findIndex((wm) => wm.l === local);
    return `<button class="bp-drop bp-jump" data-jump="W:${r}:${mi}" data-jump-gi="${gi}"` +
      ` title="落ちてきた元の試合へ">↓勝者側${esc(C.roundName(r + 1, ctx.de.wTotal))}</button>`;
  }

  // 勝者側の枠に「負けたら敗者側○回戦へ」。クリックでその試合へ飛ぶ。
  function dropToBadge(ctx, m, local, gi, key) {
    if (key == null || key[0] !== 'W' || m.l !== local) return '';   // 負ける側だけに出す
    // 落ちる先 = その選手が敗者側で最初に現れる試合 (組まれていなければ出さない)
    const li = ctx.de.losers.findIndex((round) => round.some((lm) => lm.a === local || lm.b === local));
    if (li < 0) return '';
    const mi = ctx.de.losers[li].findIndex((lm) => lm.a === local || lm.b === local);
    return `<button class="bp-dropto bp-jump" data-jump="L:${li}:${mi}" data-jump-gi="${gi}"` +
      ` title="ここで負けたときに落ちる試合へ">↓ ${esc(C.lbRoundName(li, ctx.de.lTotal))}</button>`;
  }

  // 指定の試合までスクロールし、その選手をハイライトする。
  // 敗者側が非表示なら表示に切り替えてから飛ぶ。
  function jumpToMatch(key, gi) {
    if (key[0] === 'L' && STATE.view.lb !== 1) {
      STATE.view.lb = 1;
      $('bp-lb').checked = true;
    }
    STATE.view.hi = gi;
    hidePop();
    renderAll();
    let tries = 0;
    const tick = () => {
      const el = document.querySelector(`.bp-match[data-key="${key}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        el.classList.add('bp-flash');
        return;
      }
      if (tries++ < 20) setTimeout(tick, 50);
    };
    tick();
  }

  // 次フェーズの入り口 (プール・シード番号・勝者側/敗者側スタート) を示すチップ。
  // クリックでそのフェーズ・プールを開き、本人をハイライトする。
  function nextChip(gi) {
    const d = nextDest(gi);
    if (!d) return '';
    return `<button class="bp-next" data-next="${gi}" title="${esc(d.phaseName)} の ${esc(d.pool)} を開く">` +
      `→ ${esc(d.pool)} #${d.localSeed}${d.side === 'losers' ? ' 敗者側' : ''}</button>`;
  }

  // 前フェーズのどのプールから来たか。フェーズ0なら null。
  function prevSource(gi) {
    const ph = currentPhase();
    if (ph === 0) return null;
    const counts = phaseCounts();
    const pp = STATE.payload.phases[ph - 1];
    const P = Math.max(1, pp.pools | 0);
    const poolIdx = O.poolOfSeed(gi, P);
    const members = C.phasePools(counts[ph - 1], P)[poolIdx];
    return {
      ph: ph - 1, pool: poolLabels(ph - 1)[poolIdx], localSeed: members.indexOf(gi) + 1,
      phaseName: pp.name || `フェーズ${ph}`,
    };
  }

  // 前フェーズの出どころチップ (その選手が現フェーズで最初に出る枠に付ける)。
  function prevChip(gi) {
    const s = prevSource(gi);
    if (!s || s.localSeed < 1) return '';
    return `<button class="bp-prev" data-prev="${gi}" title="${esc(s.phaseName)} の ${esc(s.pool)} を開く">` +
      `← ${esc(s.pool)} #${s.localSeed}</button>`;
  }

  function gotoPrevPhase(gi) {
    const s = prevSource(gi);
    if (!s) return;
    STATE.view.ph = s.ph;
    STATE.view.pool = s.pool;
    STATE.view.hi = gi;
    hidePop();
    renderAll();
    scrollToHighlight();
  }

  function scrollToHighlight() {
    let tries = 0;
    const tick = () => {
      const el = document.querySelector('.bp-slot.bp-hi');
      if (el) { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); return; }
      if (tries++ < 20) setTimeout(tick, 50);
    };
    tick();
  }

  // gi (現フェーズのグローバル index) が次フェーズでどこに入るか。進出しないなら null。
  function nextDest(gi) {
    const ph = currentPhase();
    if (ph >= STATE.payload.phases.length - 1) return null;
    const counts = phaseCounts();
    const nextN = counts[ph + 1];
    if (!(gi < nextN)) return null;
    const np = STATE.payload.phases[ph + 1];
    const P = Math.max(1, np.pools | 0);
    const poolIdx = O.poolOfSeed(gi, P);
    const membersNext = C.phasePools(nextN, P)[poolIdx];
    const localSeed = membersNext.indexOf(gi) + 1;
    const lb = lbOfPhase(ph + 1, membersNext.length);
    return {
      ph: ph + 1, pool: poolLabels(ph + 1)[poolIdx], localSeed,
      side: (lb > 0 && localSeed > membersNext.length - lb) ? 'losers' : 'winners',
      phaseName: np.name || `フェーズ${ph + 2}`,
    };
  }

  // 次フェーズのそのプールを開き、本人をハイライトして画面内に入れる。
  function gotoNextPhase(gi) {
    const d = nextDest(gi);
    if (!d) return;
    STATE.view.ph = d.ph;
    STATE.view.pool = d.pool;
    STATE.view.hi = gi;
    hidePop();
    renderAll();
    scrollToHighlight();   // 描画は非同期なので出るまで待つ
  }

  // 各選手が最後に登場する枠 (そこに次フェーズのチップを付ける)。
  function lastAppearance(de, which) {
    const map = new Map();
    const keepFirst = which === 'first';
    const put = (s, k) => { if (s != null && !(keepFirst && map.has(s))) map.set(s, k); };
    for (const step of C.playOrder(de)) {
      const rows = step.k === 'W' ? de.winners[step.i] : (step.k === 'L' ? de.losers[step.i] : null);
      if (!rows) continue;
      rows.forEach((m, i) => {
        if (m.a == null || m.b == null) return;      // bye は表示しないので付けない
        const key = `${step.k}:${step.i}:${i}`;
        put(m.a, key + ':a'); put(m.b, key + ':b');
      });
    }
    return map;
  }

  // winnerFirst: 勝ち上がる側を上のスロットに描く (敗者側は a=生存者/b=ドロップ の並びなので、
  // そのままだと勝つ側が下に来てしまう。勝者側は元から上が勝ち上がる)
  function matchDiv(m, ctx, top, dropBadge, key, winnerFirst) {
    let flags = '';
    if (m.a != null && m.b != null) {
      const ga = ctx.members[m.a - 1], gb = ctx.members[m.b - 1];
      const ua = uidOf(ga), ub = uidOf(gb);
      const agg = ctx.agg;
      if (agg && ua != null && ub != null) {
        // 同居住地: 県が完全一致なら県名、地域グループ (南関東等) 一致なら地域名。
        // 海外同士は同一国のとき国名。
        const bothOverseas = STATE.overseas.has(ua) && STATE.overseas.has(ub);
        if (bothOverseas) {
          const ca = residenceOf(ga), cb = residenceOf(gb);
          if (ca && ca === cb && ca !== '海外') flags += `<span class="bp-flag bp-flag-region">同: ${esc(ca)}</span>`;
        } else {
          const ra = STATE.prefsRaw && STATE.prefsRaw[String(ua)];
          const rb = STATE.prefsRaw && STATE.prefsRaw[String(ub)];
          const pa = agg.prefByUid[ua], pb = agg.prefByUid[ub];
          if (ra && ra === rb) flags += `<span class="bp-flag bp-flag-region">同: ${esc(ra)}</span>`;
          else if (pa && pa === pb) flags += `<span class="bp-flag bp-flag-region">同地域: ${esc(pa)}</span>`;
        }
        const meta = agg.recentMeta[D.pairKey(ua, ub)];
        if (meta && meta.lastDeltaDays != null) {
          flags += `<span class="bp-flag bp-flag-recent" data-pair="${ua}:${ub}">` +
            `直近対戦 ${esc(C.fmtRelDays(meta.lastDeltaDays))}${meta.count > 1 ? ` (${meta.count}回)` : ''}</span>`;
        }
      }
    }
    const ghost = (m.a == null && m.b == null) ? ' bp-ghost' : '';
    const slotA = slotHtml(m.a, m, ctx, dropBadge, false, key);
    const slotB = slotHtml(m.b, m, ctx, dropBadge, true, key);
    const swap = winnerFirst && m.b != null && m.w === m.b;
    return `<div class="bp-match${ghost}"${key ? ` data-key="${key}"` : ''} style="top:${top}px">` +
      (swap ? slotB + slotA : slotA + slotB) +
      (flags ? `<div class="bp-flags">${flags}</div>` : '') + '</div>';
  }

  // ── ポップアップ ─────────────────────────────────────────
  function showPop(anchor, html) {
    const pop = $('bp-pop');
    pop.innerHTML = '<span class="bp-pop-close">✕</span>' + html;
    pop.hidden = false;
    const card = anchor.closest && anchor.closest('.bp-match');
    pop.dataset.anchor = (card && card.dataset.key) || '';
    const r = anchor.getBoundingClientRect();
    const top = r.bottom + window.scrollY + 6;
    let left = r.left + window.scrollX;
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    const w = pop.offsetWidth;
    if (left + w > window.scrollX + document.documentElement.clientWidth - 8) {
      left = Math.max(8, window.scrollX + document.documentElement.clientWidth - w - 8);
      pop.style.left = left + 'px';
    }
  }
  function hidePop() { $('bp-pop').hidden = true; }

  function playerPopHtml(gi) {
    const uid = uidOf(gi);
    const pj = uid != null ? STATE.players.get(uid) : null;
    const name = nameOf(gi);
    const mainCh = mainCharOf(gi);
    let h = `<h3>${mainCh ? esc(mainCh.emoji) + ' ' : ''}${esc(name)} ` +
      `<span class="bp-pop-sub">シード ${gi + 1}${mainCh ? ' ・ ' + esc(mainCh.name) : ''}</span></h3>`;
    if (uid == null) return h + '<div class="bp-pop-sub">SPSP 未登録の参加者 (uid なし)。名前は共有データの表記です。</div>';
    if (pj && pj.__error) return h + `<div class="bp-pop-sub">選手データの取得に失敗しました (${esc(pj.__error)})。再読み込みで再試行されます。</div>`;
    if (!pj || pj.__missing) {
      return h + `<div class="bp-pop-sub">SPSP DB にデータがありません (uid: ${uid})。</div>`;
    }
    const res = residenceOf(gi);
    const rank = pj.ranks && pj.ranks.ensemble;
    h += '<div>' + (rank ? `SPSP 総合 <b>${rank}位</b>` : 'ランキング外') + (res ? ` ・ 📍 ${esc(res)}` : '') + '</div>';
    const ts = (pj.tournaments || []).slice(0, 3);
    if (ts.length) {
      h += '<table>' + ts.map((t) =>
        `<tr><td>${esc(t.date || '')}</td><td>${esc(t.name || '')}</td>` +
        `<td>${t.place != null ? t.place + '位' : ''}${t.nent ? '/' + t.nent + '人' : ''}</td></tr>`
      ).join('') + '</table>';
    }
    h += `<div style="margin-top:6px"><a href="../p/?uid=${uid}" target="_blank" rel="noopener">プレイヤーページを開く →</a></div>`;
    return h;
  }

  function recentPopHtml(ua, ub) {
    const agg = STATE.poolAgg.get(aggKey(currentPhase(), currentPoolIdx()));
    const meta = agg && agg.recentMeta[D.pairKey(ua, ub)];
    if (!meta) return '<div class="bp-pop-sub">対戦データがありません。</div>';
    const nm = (uid) => {
      const gi = STATE.payload.uids.indexOf(uid);
      return gi >= 0 ? nameOf(gi) : String(uid);
    };
    let h = `<h3>${esc(nm(ua))} vs ${esc(nm(ub))}</h3>`;
    h += `<div class="bp-pop-sub">直近1年の対戦 ${meta.count} 回` +
      (STATE.view.wd === 0 ? ' (平日大会を除く)' : '') + '</div>';
    h += '<table>' + meta.matches.map((m) =>
      `<tr><td>${esc(m.date)}</td><td>${esc(m.tournament || '不明')}</td><td>${m.nent ? m.nent + '人' : ''}</td></tr>`
    ).join('') + '</table>';
    return h;
  }

  // ── フェーズ構成エディタ ─────────────────────────────────
  function renderPhaseEditor() {
    const counts = phaseCounts();
    $('bp-phase-rows').innerHTML = STATE.payload.phases.map((p, i) => {
      const isFinal = i === STATE.payload.phases.length - 1;
      return `<div class="bp-phase-row" data-idx="${i}">` +
        `<label class="bp-f bp-f-name"><span>フェーズ名</span>` +
        `<input type="text" data-f="name" value="${esc(p.name)}" placeholder="予選"></label>` +
        `<label class="bp-f"><span>プール数</span>` +
        `<input type="number" data-f="pools" value="${p.pools}" min="1" inputmode="numeric"></label>` +
        `<label class="bp-f"><span>各プール進出</span>` +
        `<input type="number" data-f="adv" value="${p.adv || 0}" min="0" inputmode="numeric"` +
        `${isFinal ? ' disabled title="最終フェーズでは使いません"' : ''}></label>` +
        `<label class="bp-f"><span title="下位シードから何人が敗者側スタートか (予選2位は敗者側から、等)">敗者側スタート</span>` +
        `<input type="number" data-f="lb" value="${effectiveLb(i)}" min="0" inputmode="numeric"></label>` +
        `<span class="bp-count">${counts[i] != null ? counts[i] + '人' : ''}</span>` +
        (STATE.payload.phases.length > 1 ? `<button class="bp-btn" data-del="${i}">削除</button>` : '') +
        '</div>';
    }).join('');
  }

  // エディタに出す敗者側スタート人数 (未指定なら既定値を見せる)。
  function effectiveLb(ph) {
    const counts = phaseCounts();
    const P = Math.max(1, STATE.payload.phases[ph].pools | 0);
    const pools = C.phasePools(counts[ph], P);
    const size = pools.length && pools[0].length ? pools[0].length : counts[ph];
    return lbOfPhase(ph, size);
  }

  function readPhaseEditor() {
    return [...$('bp-phase-rows').querySelectorAll('.bp-phase-row')].map((row, i) => {
      const out = {
        name: row.querySelector('[data-f="name"]').value.trim(),
        pools: parseInt(row.querySelector('[data-f="pools"]').value, 10),
        adv: parseInt(row.querySelector('[data-f="adv"]').value, 10) || 0,
      };
      // 敗者側スタートは既定値のままなら持たせない = 前フェーズの結果に追従し続ける。
      // 明示的に別の数を入れたときだけ固定値として保存する。
      const typed = parseInt(row.querySelector('[data-f="lb"]').value, 10) || 0;
      if (i < STATE.payload.phases.length && typed !== effectiveLb(i)) out.lb = typed;
      else if (i >= STATE.payload.phases.length && typed) out.lb = typed;
      return out;
    });
  }

  async function applyPhases(phasesIn) {
    const st = $('bp-phase-status');
    // 最後のフェーズが 2 プール以上ならそこで終われないので、次フェーズを自動で足す
    const phases = S.withFinalPhase(phasesIn, STATE.payload.uids.length);
    const added = phases.length > phasesIn.length;
    const errors = S.validatePhases(phases, STATE.payload.uids.length);
    if (errors.length) { st.textContent = '❌ ' + errors.join(' / '); return; }
    const oldP0 = STATE.payload.phases[0].pools;
    STATE.payload.phases = phases;
    if (phases[0].pools !== oldP0) {
      // 予選プール数が変わったら wv を同じウェーブ数で作り直す
      const oldWv = STATE.payload.wv || [0];
      const W = oldWv.reduce((m, w) => Math.max(m, w), 0) + 1;
      STATE.payload.wv = S.chunkWaveMap(phases[0].pools, W);
    }
    STATE.blob = await S.encodePayload(STATE.payload);
    STATE.poolAgg.clear();
    STATE.view.ph = Math.min(STATE.view.ph, phases.length - 1);
    STATE.view.pool = null;
    st.textContent = '✅ 適用しました' + (added ? ` (プールが2つ以上あるので「${phases[phases.length - 1].name}」を追加)` : '');
    renderAll();
  }

  // ── CSV 保存 / 読み込み ──────────────────────────────────
  function exportCsv() {
    const P0 = STATE.payload.phases[0].pools;
    const wm = phaseWaveMap(0);
    const csv = S.buildWorkCsv(STATE.payload, {
      nameOf: resolvedName,
      poolLabelOf: (i) => (P0 >= 2 && i < phaseCounts()[0]) ? S.poolLabel(O.poolOfSeed(i, P0), wm) : '',
      view: STATE.view,
    });
    const name = String(STATE.payload.ev || 'bracket').replace(/[^\w\-ぁ-んァ-ヶ一-龠]/g, '_').slice(0, 40);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `spsp_bracket_${name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`💾 ${STATE.payload.uids.length}人のシード順・フェーズ構成・表示状態を CSV に保存しました。下の「CSV を読み込む」で復元できます。`);
  }

  async function importCsv(file) {
    const st = $('bp-csv-status');
    try {
      const text = await file.text();
      const { payload, warnings, view } = S.workCsvToPayload(text, { ev: file.name.replace(/\.csv$/i, '') });
      STATE.payload = payload;
      STATE.blob = await S.encodePayload(payload);
      STATE.phasesEdited = false;   // 別のデータを読み込んだので編集フラグは持ち越さない
      STATE.players.clear(); STATE.poolAgg.clear();
      await ensureFinalPhase();
      STATE.view = view || { ph: 0, pool: null, wd: STATE.view.wd, lb: STATE.view.lb };
      clearError();
      st.textContent = `✅ ${payload.uids.length}人を読み込みました` + (warnings.length ? ' / ⚠ ' + warnings.join(' / ') : '');
      $('bp-controls').hidden = false;
      renderAll();
    } catch (e) {
      st.textContent = '';
      showError('CSV を読み込めませんでした: ' + e.message);
    }
  }

  // 最終フェーズが 2 プール以上なら次フェーズを補って blob を作り直す。
  // 単一フェーズで発行された古い共有 URL もこれで正しい構成になる。
  async function ensureFinalPhase() {
    const fixed = S.withFinalPhase(STATE.payload.phases, STATE.payload.uids.length);
    if (fixed.length === STATE.payload.phases.length) return;
    STATE.payload.phases = fixed;
    STATE.blob = await S.encodePayload(STATE.payload);
  }

  // ── データ版 ────────────────────────────────────────────
  // 「相手と同じデータを見ているか」を突き合わせるための短いハッシュ。
  // 見る側の状態 (どのフェーズ/プールを開いているか) では変わらない。
  // 逆にこのページでフェーズ構成を編集したら変わる = 別のデータになったということ。
  function renderVersion() {
    const el = $('bp-version');
    if (!el) return;
    const v = S.payloadVersion(STATE.payload);
    const edited = STATE.phasesEdited === true;
    el.innerHTML = 'データ版 <code>' + v + '</code>' +
      (edited ? ' <span>（このページでフェーズ構成を変更済み）</span>' : '');
    el.classList.toggle('bp-version-edited', edited);
    el.title = '共有元と同じ値なら、同じシード順・同じフェーズ構成を見ています。' +
      'どのプールを開いているかでは変わりません。';
    el.hidden = false;
  }

  // ── 全体描画 ────────────────────────────────────────────
  function renderAll() {
    $('bp-event').textContent = STATE.payload.ev || '';
    renderVersion();
    renderTabs();
    renderPoolSelect();
    renderPhaseEditor();
    $('bp-wd').checked = STATE.view.wd !== 0;
    $('bp-lb').checked = STATE.view.lb === 1;
    renderBracket();   // async (内部で syncUrl)
  }

  // ── イベント配線 ────────────────────────────────────────
  function wireEvents() {
    $('bp-phase-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ph]');
      if (!b) return;
      STATE.view.ph = parseInt(b.dataset.ph, 10);
      STATE.view.pool = null;
      STATE.view.hi = null;
      renderTabs(); renderPoolSelect(); renderBracket();
    });
    $('bp-pool-select').addEventListener('change', () => {
      STATE.view.pool = $('bp-pool-select').value;
      STATE.view.hi = null;
      renderBracket();
    });
    const movePool = (d) => {
      const labels = poolLabels(currentPhase());
      const i = Math.max(0, labels.indexOf(STATE.view.pool));
      const ni = (i + d + labels.length) % labels.length;
      STATE.view.pool = labels[ni];
      STATE.view.hi = null;
      renderPoolSelect(); renderBracket();
    };
    $('bp-pool-prev').addEventListener('click', () => movePool(-1));
    $('bp-pool-next').addEventListener('click', () => movePool(1));
    $('bp-wd').addEventListener('change', () => {
      STATE.view.wd = $('bp-wd').checked ? 1 : 0;
      renderBracket();
    });
    $('bp-lb').addEventListener('change', () => {
      STATE.view.lb = $('bp-lb').checked ? 1 : 0;
      renderBracket();
    });
    $('bp-copy-url').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        $('bp-copy-url').textContent = '✅ コピーしました';
      } catch (e) {
        $('bp-copy-url').textContent = '❌ コピー失敗 (アドレスバーから手動で)';
      }
      setTimeout(() => { $('bp-copy-url').textContent = '🔗 URLをコピー'; }, 1800);
    });
    $('bp-csv-save').addEventListener('click', exportCsv);
    // 取得失敗した選手データだけ捨てて取り直す (404 = DB 未登録は確定なので残す)
    $('bp-reload').addEventListener('click', () => {
      for (const [u, p] of [...STATE.players.entries()]) if (p && p.__error) STATE.players.delete(u);
      STATE.poolAgg.clear();
      renderBracket();
    });
    $('bp-phase-add').addEventListener('click', () => {
      const phases = readPhaseEditor();
      phases.push({ name: 'Top ' + (phases.length + 1), pools: 1, adv: 0 });
      STATE.payload.phases = phases;   // 表示のみ更新 (適用で検証)
      renderPhaseEditor();
    });
    $('bp-phase-rows').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      const phases = readPhaseEditor();
      phases.splice(parseInt(del.dataset.del, 10), 1);
      STATE.payload.phases = phases;
      renderPhaseEditor();
    });
    $('bp-phase-apply').addEventListener('click', () => {
      STATE.phasesEdited = true;   // 以降、データ版が共有元と違って当然になる
      applyPhases(readPhaseEditor());
    });
    $('bp-csv-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importCsv(f);
      e.target.value = '';
    });
    // ポップアップ (プレイヤー概要 / 直近対戦の詳細)
    $('bp-bracket').addEventListener('click', (e) => {
      // 次フェーズチップ: そのフェーズ・プールを開いて本人をハイライト
      const nx = e.target.closest('.bp-next[data-next]');
      if (nx) { gotoNextPhase(parseInt(nx.dataset.next, 10)); return; }
      const pv = e.target.closest('.bp-prev[data-prev]');
      if (pv) { gotoPrevPhase(parseInt(pv.dataset.prev, 10)); return; }
      const jump = e.target.closest('.bp-jump[data-jump]');
      if (jump) { jumpToMatch(jump.dataset.jump, parseInt(jump.dataset.jumpGi, 10)); return; }
      const nameEl = e.target.closest('.bp-name[data-gi]');
      if (nameEl) {
        // 名前クリック = その選手をハイライト (もう一度で解除) + 概要ポップアップ
        const gi = parseInt(nameEl.dataset.gi, 10);
        const card = nameEl.closest('.bp-match');
        const mk = card && card.dataset.key;
        STATE.view.hi = (STATE.view.hi === gi) ? null : gi;
        const html = playerPopHtml(gi);
        renderBracket();
        // 再描画で元の要素は消えるので、**押した試合と同じカード**の枠を基準に開く
        // (先頭の出現を使うと、敗者側で押しても勝者側の位置に出てしまう)
        const anchor = (mk && document.querySelector(`.bp-match[data-key="${mk}"] .bp-name[data-gi="${gi}"]`))
          || document.querySelector(`.bp-name[data-gi="${gi}"]`) || nameEl;
        showPop(anchor, html);
        return;
      }
      const flag = e.target.closest('.bp-flag-recent[data-pair]');
      if (flag) {
        const [ua, ub] = flag.dataset.pair.split(':').map(Number);
        showPop(flag, recentPopHtml(ua, ub));
      }
    });
    document.addEventListener('click', (e) => {
      const pop = $('bp-pop');
      if (pop.hidden) return;
      if (e.target.closest('.bp-pop-close')) { hidePop(); return; }
      if (!e.target.closest('.bp-pop') && !e.target.closest('.bp-name') && !e.target.closest('.bp-flag-recent')) hidePop();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePop(); });
  }

  // ── 起動 ────────────────────────────────────────────────
  async function init() {
    wireEvents();
    const frag = S.parseFragment(location.hash);
    STATE.view = frag.view;
    const staticWarns = await loadStaticData();
    if (staticWarns.length) setStatus('⚠ ' + staticWarns.join(' / '));
    if (!frag.d) {
      showError('共有データ (URL の #d=…) がありません。シードページの「トーナメントプレビュー」からリンクを発行するか、下の CSV 読み込みを使ってください。');
      $('bp-csv-panel').open = true;
      return;
    }
    try {
      STATE.payload = await S.decodePayload(frag.d);
      STATE.blob = frag.d;
      await ensureFinalPhase();
    } catch (e) {
      showError('共有データを読み込めませんでした: ' + e.message);
      $('bp-csv-panel').open = true;
      return;
    }
    $('bp-controls').hidden = false;
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
