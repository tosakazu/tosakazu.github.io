// SPSP shared player-detail expander.
// canonical (= site/index.html inline) を SSoT として書き出した共有モジュール.
//
// 使い方:
//   <script src="../player-detail.js"></script>
//   ...
//   // 任意の cfg を作って渡す:
//   const cfg = {
//     getMeta: () => STATE.masterMeta,       // META.params 用
//     getDataArray: () => STATE.data,        // opp rank/name lookup
//     getMasterMap: () => STATE.masterMap,   // (optional) DATA に居ない uid の fallback
//     pathPrefix: '../',                     // 'players/' / 't/' / 'p/' の前置 ('' for main)
//   };
//   const html = SPSPDetail.buildDetailContent(rec, cfg);   // tabs (大会別/直接対決) 含む inner HTML
//   const data = await SPSPDetail.fetchPlayerDetail(rec.user_id, cfg);  // DETAIL_CACHE 内蔵
//
// SPSPDetail.tourSortMode は ('contribution' | 'date') 切替式. 呼出側で
// SPSPDetail.toggleSortMode() を実行すると mode が反転する.
// 詳細パネル内部のクリック (.detail-tab / .h2h-expand-btn / .tour-sort-toggle / .expand-rows)
// は呼出側 page で tbody-level listener として処理する.
//
// 注: <tr class="detail-row"><td colspan="N">...</td></tr> の包みは呼出側で生成.
//     buildDetailContent は inner HTML のみを返す.
// 注: chart 関連は本モジュールには含まれない (= main canonical に従う).
// 注: CSS はページ毎の inline で管理する (= 本モジュールは style を inject しない).
//
// 依存: なし (vanilla JS).
(function (global) {
  'use strict';
  if (global.SPSPDetail) return;

  // ─── Helpers ───
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // tourSortMode: 'contribution' | 'date' (page-level, shared across players)
  let tourSortMode = 'contribution';

  function sortTournaments(ts) {
    const arr = ts.slice();
    if (tourSortMode === 'contribution') {
      arr.sort((a, b) => {
        // 影響順 = 当時その大会で獲得した raw pt の大きい順.
        const aw = a.tjpr_pts_at || 0, bw = b.tjpr_pts_at || 0;
        if (bw !== aw) return bw - aw;
        return (b.date || '').localeCompare(a.date || '');
      });
    } else {
      // date 同日は ts (開始時刻) でタイブレーク (= 下位クラスは本戦より後 = 上に表示)
      arr.sort((a, b) => (b.date || '').localeCompare(a.date || '') || ((b.ts || 0) - (a.ts || 0)));
    }
    return arr;
  }

  function toggleSortMode() {
    tourSortMode = (tourSortMode === 'contribution') ? 'date' : 'contribution';
    return tourSortMode;
  }

  // 内部 path resolver: pathPrefix 経由で players / t / p を組み立てる.
  function resolvePaths(cfg) {
    const pre = (cfg && cfg.pathPrefix != null) ? cfg.pathPrefix : '';
    return {
      playersPath: (cfg && cfg.playersPath) || (pre + 'players/'),
      tPath: (cfg && cfg.tPath) || (pre + 't/'),
      pPath: (cfg && cfg.pPath) || (pre + 'p/'),
    };
  }

  // data lookup helpers: 主に opp の rank / name 解決用.
  function buildLookup(cfg) {
    const dataArr = (cfg && cfg.getDataArray) ? (cfg.getDataArray() || []) : [];
    const dataByUid = new Map();
    for (const r of dataArr) {
      if (r && r.user_id != null) dataByUid.set(Number(r.user_id), r);
    }
    const masterMap = (cfg && cfg.getMasterMap) ? (cfg.getMasterMap() || null) : null;
    function getMasterRec(uid) {
      if (!masterMap) return null;
      const key = Number(uid);
      // Map<number, rec>
      if (typeof masterMap.get === 'function') {
        return masterMap.get(key) || masterMap.get(uid) || null;
      }
      return null;
    }
    function ensembleRankOf(uid) {
      if (uid == null) return Infinity;
      const rr = dataByUid.get(Number(uid));
      if (rr && rr.ranks) {
        const g = rr.ranks.global_ensemble != null ? rr.ranks.global_ensemble : rr.ranks.ensemble;
        if (typeof g === 'number' && g > 0) return g;
      }
      const mr = getMasterRec(uid);
      if (mr && mr.ranks && typeof mr.ranks.ensemble === 'number') return mr.ranks.ensemble;
      return Number.POSITIVE_INFINITY;
    }
    function nameOf(uid, sample) {
      const rr = dataByUid.get(Number(uid));
      if (rr && rr.display) return rr.display;
      const mr = getMasterRec(uid);
      if (mr && mr.display) return mr.display;
      if (sample && sample.opp_display) return sample.opp_display;
      return `uid:${uid}`;
    }
    return { dataByUid, ensembleRankOf, nameOf };
  }

  // ─── 大会別: buildTournamentTable ───
  // canonical: site/index.html buildTournamentTable (line ~1028).
  function buildTournamentTable(rec, cfg) {
    cfg = cfg || {};
    const ts = sortTournaments(rec.tournaments || []);
    if (!ts.length) return '<div class="empty-msg">大会データなし</div>';
    const meta = (cfg.getMeta && cfg.getMeta()) || {};
    const params = meta.params || {};
    const scale = params.TJPR_ELO_SCALE || 100.0;
    const ELO_PER_UNIT = params.ELO_PER_UNIT || 29.4809;
    const TOP_N = 10;
    const paths = resolvePaths(cfg);
    const { ensembleRankOf } = buildLookup(cfg);

    // event_id → recent_matches[] map (大会ごとの対戦相手)
    const matchesByEvent = {};
    for (const m of (rec.recent_matches || [])) {
      if (!m.event_id) continue;
      (matchesByEvent[m.event_id] = matchesByEvent[m.event_id] || []).push(m);
    }
    function renderMainOpponents(eid, max = 5) {
      const ms = matchesByEvent[eid] || [];
      if (!ms.length) return '<span style="color:#9ca3af">−</span>';
      // SPSP ランク昇順 (= 強い相手から先)
      const sorted = ms.slice().sort((a, b) => ensembleRankOf(a.opp_uid) - ensembleRankOf(b.opp_uid));
      const shown = sorted.slice(0, max);
      return shown.map(m => {
        const dCol = m.won ? '#16a34a' : '#2563eb';
        const mark = m.won ? '◯' : '✗';
        const oppLink = m.opp_uid
          ? `<a href="${paths.pPath}?uid=${m.opp_uid}" style="color:${dCol};text-decoration:none;font-weight:500" onclick="event.stopPropagation()">${escapeHtml(m.opp_display || '')}</a>`
          : `<span style="color:${dCol}">${escapeHtml(m.opp_display || '')}</span>`;
        return `<span style="color:${dCol}">${mark}</span> ${oppLink}`;
      }).join(' · ') + (ms.length > max ? ` <span style="color:#9ca3af">他 ${ms.length - max}</span>` : '');
    }

    const rowHtml = (t, idx) => {
      const wkClass = t.is_weekend ? 'weekend' : 'weekday';
      const countedClass = t.tjpr_counted ? 'counted' : '';
      const hiddenCls = idx >= TOP_N ? 'extra-row hidden-row' : '';
      const cls = `${wkClass} ${countedClass} ${hiddenCls}`.trim();
      // 当時のレベル: 実 cascade スナップショット由来の at_lv (= 当時の TJPR レベル).
      // 接尾辞 (+/メダル) は当時の全国順位 (pretour_ranks.ensemble) で判定.
      const _lv = t.at_lv || 0;
      const _lvr = (t.pretour_ranks && t.pretour_ranks.ensemble) || null;
      let _lvsfx = '';
      if (_lv === 5 && _lvr) _lvsfx = _lvr<=8?'👑':_lvr<=16?'🥇':_lvr<=32?'🥈':_lvr<=64?'🥉':_lvr<=128?'+':'';
      else if (_lv > 0 && _lvr) { const _c = {4:384,3:768,2:1536,1:3072}[_lv]; _lvsfx = (_c && _lvr<=_c)?'+':''; }
      const lvBadge = _lv > 0
        ? `<span class="lv-badge lv-${_lv}">Lv${_lv}${_lvsfx}</span>`
        : '<span style="opacity:0.4">−</span>';
      const dayTag = t.is_weekend
        ? '<span class="tag-wk">休日</span>'
        : '<span class="tag-wd">平日</span>';
      const smTag = '';
      const preTag = t.is_pre ? '<span class="tag-pre">プレ大会</span>' : '';
      const resTag = t.is_restricted ? '<span class="tag-res">制限</span>' : '';
      const lcTag = t.is_lower_class ? '<span class="tag-lc">下位クラス</span>' : '';
      // 直対評価: 当時の BT レート変動 (時系列の bt_d=peak180 主 / bt_internal_d を ( ) 内).
      // bt_used=false (= 当時その大会で BT 未更新) は "−".
      const btDelta = (t.bt_d || 0) * ELO_PER_UNIT;
      const btIntDelta = (t.bt_internal_d || 0) * ELO_PER_UNIT;
      const btDeltaCls = btDelta > 0 ? 'pos' : (btDelta < 0 ? 'neg' : '');
      const btIntStr = Math.abs(btIntDelta) > 0.01
        ? ` <span style="color:#9ca3af;font-size:10px">(${btIntDelta > 0 ? '+' : ''}${btIntDelta.toFixed(2)})</span>`
        : '';
      const btCellStr = t.bt_used
        ? `${btDelta > 0 ? '+' : ''}${btDelta.toFixed(2)}${btIntStr}`
        : '<span style="opacity:0.4">−</span>';
      const oppHtml = renderMainOpponents(t.event_id);
      const oppRowCls = `tour-opp-row ${cls}`.trim();
      // 順位評価: 当時その大会で獲得した raw pt (tjpr_pts_at). null = 当時の計上対象外.
      const ptsAt = t.tjpr_pts_at;
      const ptCell = ptsAt == null
        ? '<span style="opacity:0.4">−</span>'
        : `${(ptsAt * scale).toFixed(2)}`;
      return `
        <tr class="${cls} tour-main-row">
          <td>${t.date}</td>
          <td>${t.event_id ? `<a href="${paths.tPath}?id=${t.event_id}" style="color:#dc2626;text-decoration:none" onclick="event.stopPropagation()">${escapeHtml(t.name)}</a>` : escapeHtml(t.name)} ${smTag}${preTag}${resTag}${lcTag} / <span style="color:#6b7280">${escapeHtml(t.event)}</span></td>
          <td class="num">${t.place || '−'}</td>
          <td class="num">${t.nent}</td>
          <td>${dayTag}</td>
          <td>${lvBadge}</td>
          <td class="num">${ptCell}</td>
          <td class="num ${btDeltaCls}">${btCellStr}</td>
        </tr>
        <tr class="${oppRowCls}">
          <td colspan="8" style="font-size:11px;color:#6b7280;padding:0 8px 6px">${oppHtml}</td>
        </tr>
      `;
    };
    const rows = ts.map(rowHtml).join('');
    const sortLabel = tourSortMode === 'contribution'
      ? '🔽 影響順 <span style="color:#9ca3af">(クリックで時系列順)</span>'
      : '🔽 時系列順 <span style="color:#9ca3af">(クリックで影響順)</span>';
    const extra = ts.length - TOP_N;
    const expandBtn = extra > 0
      ? `<div class="expand-rows" data-uid="${rec.user_id}"
             style="text-align:center;font-size:12px;color:#374151;cursor:pointer;user-select:none;margin-top:8px;padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px">
           ▼ 残り ${extra} 件を表示
         </div>`
      : '';
    return `
        <div class="tour-sort-toggle" data-uid="${rec.user_id}"
             style="font-size:11px;color:#374151;cursor:pointer;user-select:none;margin-bottom:6px;display:inline-block;padding:3px 10px;background:#ffffff;border:1px solid #e5e7eb;border-radius:4px">
          ${sortLabel}
        </div>
        <div class="hscroll">
          <table class="tour-table" data-uid="${rec.user_id}">
            <thead><tr>
              <th>日付</th><th>大会</th><th class="num">順位</th><th class="num">人数</th>
              <th>区分</th><th>当時Lv</th>
              <th class="num">順位評価pt</th>
              <th class="num">直対評価 Δ</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${expandBtn}
    `;
  }

  // ─── 直接対決: buildH2HSection ───
  // canonical: site/index.html buildH2HSection (line ~1134).
  function buildH2HSection(rec, cfg) {
    cfg = cfg || {};
    // 直対評価対象 (= peak180 or 内部レートが動いた試合)
    const allMatches = (rec.recent_matches || []).filter(m =>
      (Math.abs(m.bt_d || 0) > 1e-9) || (Math.abs(m.bt_internal_d || 0) > 1e-9));
    if (allMatches.length === 0) {
      return '<div class="empty-msg" style="padding:16px">直対評価の対象となる直近の対戦データがありません</div>';
    }
    // 直近 5 大会の試合だけ抽出
    const seenTids = [];
    const seenTidSet = new Set();
    for (const m of allMatches) {
      if (!seenTidSet.has(m.event_id)) {
        seenTids.push(m.event_id);
        seenTidSet.add(m.event_id);
        if (seenTids.length >= 5) break;
      }
    }
    const recent5 = new Set(seenTids);
    const matches = allMatches.filter(m => recent5.has(m.event_id));
    // 勝ち/負けで分けて opp uid ごとに集計
    const winsBy = {}, lossBy = {};
    for (const m of matches) {
      const bucket = m.won ? winsBy : lossBy;
      if (!bucket[m.opp_uid]) bucket[m.opp_uid] = [];
      bucket[m.opp_uid].push(m);
    }
    const paths = resolvePaths(cfg);
    const { ensembleRankOf, nameOf } = buildLookup(cfg);
    const meta = (cfg.getMeta && cfg.getMeta()) || {};
    const ELO_PER_UNIT = (meta.params && meta.params.ELO_PER_UNIT) || 29.4809;
    function oppCard(uid, msList, kind) {
      const oRank = ensembleRankOf(uid);
      const oName = nameOf(uid, msList && msList[0]);
      const rankBadge = (oRank !== Infinity) ? `#${oRank}` : '?';
      const sortedMs = msList.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const rows = sortedMs.map(m => {
        // per-match の rate 変化は内部レート (current) のみ
        const d = (m.bt_internal_d != null ? m.bt_internal_d : (m.bt_d || 0)) * ELO_PER_UNIT;
        const sign = d > 0 ? '+' : '';
        const cls = d > 0 ? 'pos' : (d < 0 ? 'neg' : '');
        return `<div class="h2h-match">
          <span class="h2h-date">${m.date}</span>
          <span class="h2h-tname">${m.event_id
            ? `<a href="${paths.tPath}?id=${m.event_id}" onclick="event.stopPropagation()">${escapeHtml(m.tournament_name || '')}</a>`
            : escapeHtml(m.tournament_name || '')}</span>
          <span class="h2h-delta ${cls}">${sign}${d.toFixed(1)}</span>
        </div>`;
      }).join('');
      return `<div class="h2h-opp h2h-${kind}">
        <div class="h2h-head">
          <a class="h2h-opp-name" href="${paths.pPath}?uid=${uid}" onclick="event.stopPropagation()">${escapeHtml(oName)}</a>
          <span class="h2h-rank">${rankBadge}</span>
        </div>
        ${rows}
      </div>`;
    }
    const H2H_INIT = 5, H2H_MAX = 10;
    const allWins = Object.keys(winsBy).sort((a, b) => ensembleRankOf(a) - ensembleRankOf(b));
    const allLoss = Object.keys(lossBy).sort((a, b) => ensembleRankOf(b) - ensembleRankOf(a));
    function colHtml(allUids, byMap, kind) {
      if (!allUids.length) return '<div class="empty-msg" style="padding:8px">該当なし</div>';
      const initial = allUids.slice(0, H2H_INIT).map(uid => oppCard(uid, byMap[uid], kind)).join('');
      const extras = allUids.slice(H2H_INIT, H2H_MAX);
      if (!extras.length) return initial;
      const extrasHtml = extras.map(uid => oppCard(uid, byMap[uid], kind)).join('');
      return `${initial}<div class="h2h-extra" style="display:none">${extrasHtml}</div>`;
    }
    const hasExtra = (allWins.length > H2H_INIT) || (allLoss.length > H2H_INIT);
    const expandBtn = hasExtra
      ? `<div class="h2h-expand" style="text-align:center;margin-top:8px">
           <button type="button" class="h2h-expand-btn"
             style="font-size:12px;color:#374151;cursor:pointer;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:6px 14px;font-family:inherit">▼ もっと見る</button>
         </div>`
      : '';
    return `
      <div class="h2h-section">
        <div class="h2h-col">
          <h5>📈 勝った相手 <span style="color:#9ca3af;font-weight:400;font-size:10px">SPSP 上位順</span></h5>
          <div class="h2h-list">${colHtml(allWins, winsBy, 'win')}</div>
        </div>
        <div class="h2h-col">
          <h5>📉 負けた相手 <span style="color:#9ca3af;font-weight:400;font-size:10px">SPSP 下位順</span></h5>
          <div class="h2h-list">${colHtml(allLoss, lossBy, 'loss')}</div>
        </div>
      </div>
      ${expandBtn}
    `;
  }

  // ─── buildDetailContent: tabs (大会別 / 直接対決) を包む inner HTML ───
  // canonical: site/index.html buildDetailContent (line ~1239).
  function buildDetailContent(rec, cfg) {
    return `
      <div class="detail-section">
        <div class="detail-tabs" data-uid="${rec.user_id}">
          <div class="detail-tab active" data-tab="tour">📋 大会別の詳細</div>
          <div class="detail-tab" data-tab="h2h">⚔ 直接対決</div>
        </div>
        <div class="detail-tab-content tab-tour">
          ${buildTournamentTable(rec, cfg)}
        </div>
        <div class="detail-tab-content tab-h2h" style="display:none">
          ${buildH2HSection(rec, cfg)}
        </div>
      </div>
    `;
  }

  // ─── Per-player detail cache + fetch ───
  const DETAIL_CACHE = new Map();
  async function fetchPlayerDetail(uid, cfg) {
    if (uid == null) throw new Error('user_id がありません (DB 不在プレイヤー)');
    if (DETAIL_CACHE.has(uid)) return DETAIL_CACHE.get(uid);
    const paths = resolvePaths(cfg);
    const res = await fetch(`${paths.playersPath}${uid}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    DETAIL_CACHE.set(uid, data);
    return data;
  }

  // ─── Public API ───
  global.SPSPDetail = {
    buildDetailContent,
    buildTournamentTable,
    buildH2HSection,
    fetchPlayerDetail,
    escapeHtml,
    sortTournaments,         // export for use in pages that want pre-sort
    toggleSortMode,          // 'contribution' <-> 'date'
    get tourSortMode() { return tourSortMode; },
    setSortMode(mode) { if (mode === 'contribution' || mode === 'date') tourSortMode = mode; },
    DETAIL_CACHE,            // expose for advanced use (= bulk history loaders)
  };
})(window);
