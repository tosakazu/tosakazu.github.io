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

  const STATE = {
    payload: null,
    blob: null,           // 現在の payload の base64url (URL の d=)
    view: { ph: 0, pool: null, wd: 1, lb: 0 },
    prefsRaw: null,       // uid(str) -> 都道府県 (生値。表示用)
    overseas: null,       // Set<uid> (海外勢)
    players: new Map(),   // uid -> json | {__missing:true} | {__error:msg}
    poolAgg: new Map(),   // "ph:pool:wd:N" -> buildSeedData の結果
    renderToken: 0,       // 非同期描画の競合ガード
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
    return warns;
  }

  async function ensurePlayers(uids, onProgress) {
    const targets = uids.filter((u) => u != null && !STATE.players.has(u));
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
    $('bp-pool-info').textContent = `${labels[poolIdx]}: ${M}人` + (ph > 0 ? ' (シード通り進出の予測メンバー)' : '');

    const host = $('bp-bracket');
    if (M === 0) { host.innerHTML = '<div class="bp-hint">このプールに参加者がいません。</div>'; return; }

    // 選手 JSON を取得してから描画 (名前・国名・直近対戦に必要)
    const uids = members.map((gi) => uidOf(gi)).filter((u) => u != null);
    setStatus('選手データ取得中…');
    await ensurePlayers(uids, (d, t) => { if (token === STATE.renderToken) setStatus(`選手データ取得中 ${d}/${t}…`); });
    if (token !== STATE.renderToken) return;
    let agg = null;
    let aggWarn = '';
    try {
      agg = await getPoolAgg(uids, aggKey(ph, poolIdx));
    } catch (e) {
      aggWarn = '直近対戦の集計に失敗: ' + e.message;
    }
    if (token !== STATE.renderToken) return;

    // ステータス行 (fail-loud: 未登録と取得失敗を区別して明示)
    const missing = uids.filter((u) => { const p = STATE.players.get(u); return p && p.__missing; });
    const errored = uids.filter((u) => { const p = STATE.players.get(u); return p && p.__error; });
    const unnamed = members.filter((gi) => !resolvedName(gi));
    const statusParts = [];
    if (missing.length) statusParts.push(`SPSP 未登録/データなし ${missing.length}人`);
    if (errored.length) statusParts.push(`⚠ 選手データの取得失敗 ${errored.length}人 (再読み込みで再試行されます)`);
    if (unnamed.length) statusParts.push(`⚠ 名前を復元できない参加者 ${unnamed.length}人 (uid: ${unnamed.map((gi) => uidOf(gi)).join(', ')})`);
    if (agg && agg.meta && agg.meta.weekdayExcludedMatches) statusParts.push(`平日大会の対戦 ${agg.meta.weekdayExcludedMatches} 件を除外中`);
    if (aggWarn) statusParts.push(aggWarn);
    setStatus(statusParts.join(' / '));

    const de = C.poolDoubleElim(M);
    const showLb = STATE.view.lb === 1 && de.losers.length > 0;
    const ctx = { members, agg };

    let html = renderWinnersSection(de, ctx, showLb);
    if (showLb) {
      html += '<div class="bp-sec-label">敗者側ブラケット <span class="bp-sec-note">(ドロップ位置は start.gg 標準ブラケットの実データと一致することを検証済み)</span></div>';
      html += renderLosersSection(de, ctx);
    } else if (STATE.view.lb === 1) {
      html += '<div class="bp-hint">このプールには敗者側がありません。</div>';
    }
    host.innerHTML = html;
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
      const title = withGf && r === R - 1 ? '勝者側決勝' : C.roundName(r + 1, R);
      const cells = de.winners[r].map((m, i) =>
        matchDiv(m, ctx, TITLE_H + center(r, i) - MATCH_H / 2, null)).join('');
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
      const paths = de.winners[r].map((m, i) => elbowPath(
        TITLE_H + center(r - 1, 2 * i), TITLE_H + center(r - 1, 2 * i + 1), TITLE_H + center(r, i))).join('');
      svgs += linkSvg(r, height, paths);
    }
    if (withGf) {
      const y = TITLE_H + center(R - 1, 0);
      svgs += linkSvg(R, height, `<path d="M0 ${y} H ${GAP}"/>`);
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
    const k = de.winners.length;

    let cols = '';
    rounds.forEach((matches, li) => {
      const cells = matches.map((m, i) => matchDiv(
        m, ctx, TITLE_H + center(li, i) - MATCH_H / 2,
        m.drop ? `↓勝者側${C.roundName(m.drop, k)}` : null)).join('');
      cols += `<div class="bp-round bp-lb" style="left:${li * (COLW + GAP)}px">` +
        `<div class="bp-round-title">${esc(C.lbRoundName(li, rounds.length))}</div>${cells}</div>`;
    });

    let svgs = '';
    for (let li = 1; li < rounds.length; li++) {
      let paths = '';
      if (counts[li] === counts[li - 1]) {
        // major: 1:1 の直線 (ドロップ側は勝者側から来るのでバッジのみ)
        paths = rounds[li].map((m, i) => {
          const y1 = TITLE_H + center(li - 1, i), y2 = TITLE_H + center(li, i);
          return `<path d="M0 ${y1} C ${GAP / 2} ${y1} ${GAP / 2} ${y2} ${GAP} ${y2}"/>`;
        }).join('');
      } else {
        paths = rounds[li].map((m, i) => elbowPath(
          TITLE_H + center(li - 1, 2 * i), TITLE_H + center(li - 1, 2 * i + 1), TITLE_H + center(li, i))).join('');
      }
      svgs += linkSvg(li, height, paths);
    }
    return `<div class="bp-sec" style="width:${width}px;height:${height}px">${cols}${svgs}</div>`;
  }

  function linkSvg(colIdx, height, paths) {
    const left = colIdx * (COLW + GAP) - GAP;
    return `<svg class="bp-links" style="left:${left}px" width="${GAP}" height="${height}" ` +
      `viewBox="0 0 ${GAP} ${height}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
  }

  // 2 本の入力 (y1,y2) → 出力 (yt) のエルボー接続
  function elbowPath(y1, y2, yt) {
    const h = GAP / 2;
    return `<path d="M0 ${y1} H ${h} V ${yt} H ${GAP}"/><path d="M0 ${y2} H ${h} V ${yt}"/>`;
  }

  function slotHtml(local, m, ctx, dropBadge, isB) {
    if (local == null) {
      return `<div class="bp-slot bp-bye"><span class="bp-seed"></span><span class="bp-name">BYE</span></div>`;
    }
    const gi = ctx.members[local - 1];
    const uid = uidOf(gi);
    const pj = uid != null ? STATE.players.get(uid) : null;
    const nodb = uid == null || (pj && (pj.__missing || pj.__error));
    const res = residenceOf(gi);
    const cls = 'bp-slot' + (m.w === local ? ' bp-win' : '') + (nodb ? ' bp-nodb' : '');
    return `<div class="${cls}"><span class="bp-seed">${gi + 1}</span>` +
      `<span class="bp-name" data-gi="${gi}">${esc(nameOf(gi))}</span>` +
      (isB && dropBadge ? `<span class="bp-drop">${esc(dropBadge)}</span>` : '') +
      (res ? `<span class="bp-res">${esc(res)}</span>` : '') + '</div>';
  }

  function matchDiv(m, ctx, top, dropBadge) {
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
    return `<div class="bp-match${ghost}" style="top:${top}px">` +
      slotHtml(m.a, m, ctx, dropBadge, false) + slotHtml(m.b, m, ctx, dropBadge, true) +
      (flags ? `<div class="bp-flags">${flags}</div>` : '') + '</div>';
  }

  // ── ポップアップ ─────────────────────────────────────────
  function showPop(anchor, html) {
    const pop = $('bp-pop');
    pop.innerHTML = '<span class="bp-pop-close">✕</span>' + html;
    pop.hidden = false;
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
    let h = `<h3>${esc(name)} <span class="bp-pop-sub">シード ${gi + 1}</span></h3>`;
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
        `<input type="text" data-f="name" value="${esc(p.name)}" placeholder="フェーズ名">` +
        `プール数 <input type="number" data-f="pools" value="${p.pools}" min="1">` +
        `各プール進出 <input type="number" data-f="adv" value="${p.adv || 0}" min="0"${isFinal ? ' disabled title="最終フェーズでは使いません"' : ''}>` +
        `<span class="bp-count">${counts[i] != null ? counts[i] + '人' : ''}</span>` +
        (STATE.payload.phases.length > 1 ? `<button class="bp-btn" data-del="${i}">削除</button>` : '') +
        '</div>';
    }).join('');
  }

  function readPhaseEditor() {
    return [...$('bp-phase-rows').querySelectorAll('.bp-phase-row')].map((row) => ({
      name: row.querySelector('[data-f="name"]').value.trim(),
      pools: parseInt(row.querySelector('[data-f="pools"]').value, 10),
      adv: parseInt(row.querySelector('[data-f="adv"]').value, 10) || 0,
    }));
  }

  async function applyPhases(phases) {
    const st = $('bp-phase-status');
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
    st.textContent = '✅ 適用しました';
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
      STATE.players.clear(); STATE.poolAgg.clear();
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

  // ── 全体描画 ────────────────────────────────────────────
  function renderAll() {
    $('bp-event').textContent = STATE.payload.ev || '';
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
      renderTabs(); renderPoolSelect(); renderBracket();
    });
    $('bp-pool-select').addEventListener('change', () => {
      STATE.view.pool = $('bp-pool-select').value;
      renderBracket();
    });
    const movePool = (d) => {
      const labels = poolLabels(currentPhase());
      const i = Math.max(0, labels.indexOf(STATE.view.pool));
      const ni = (i + d + labels.length) % labels.length;
      STATE.view.pool = labels[ni];
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
    $('bp-phase-apply').addEventListener('click', () => applyPhases(readPhaseEditor()));
    $('bp-csv-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importCsv(f);
      e.target.value = '';
    });
    // ポップアップ (プレイヤー概要 / 直近対戦の詳細)
    $('bp-bracket').addEventListener('click', (e) => {
      const nameEl = e.target.closest('.bp-name[data-gi]');
      if (nameEl) { showPop(nameEl, playerPopHtml(parseInt(nameEl.dataset.gi, 10))); return; }
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
