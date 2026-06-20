/* SPSP ranking table — 共有コンポーネント.
 *
 * 全体ランキング (site/index.html), ローカルランキング (site/local/ranking.html),
 * シード生成 (site/seed/index.html) の共通テーブルを 1 つの class に集約.
 *
 * 使用例:
 *   const t = new window.SPSPRankingTable.RankingTable({
 *     table: document.getElementById('ranktable'),
 *     rows: [...players],
 *     method: 'ensemble',
 *     columns: ['rank','display','avg_rank','score','tjpr_lv','tour_count','bt_weekday',
 *               'rank_tjpr','rank_bt_gated'],
 *     rowClick: 'expand' | 'select' | 'none' | (rec, tr, e) => {...},
 *     pageSize: 100,
 *     infiniteScroll: true,
 *     totalForRankFrac: 'rows' | 'meta' | (state) => N,
 *     playerHrefPrefix: '' | '../' | ...,
 *     showTopTours: true,
 *     showDisplayBadges: true,        // mobile display-lv-mobile + display-gate-mobile
 *     btWeekdayStyle: 'pill' | 'yn',  // 常連/レア pill vs ✓/− icon
 *   });
 *   t.setRows(...); t.setMethod(...); t.setFilterText(...); t.setSort(key,dir);
 *   t.refresh();
 *
 *   イベント:
 *     t.on('row-click', ({rec, tr, ev}) => {...});  // user click handling のフック
 *     t.on('rendered', ({shown, filtered}) => {...});
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // === Format helpers ===
  function getRank(rec, method) {
    return (rec.ranks && rec.ranks[method]) || Infinity;
  }
  // 海外勢ホワイトリスト適用後の表示順位 (= 何位「相当」かを示す).
  // 海外勢は実順位、それ以外は海外勢を数えない JP-only counter。
  function getDisplayRank(rec, method) {
    if (rec._display_rank && rec._display_rank[method] != null) {
      return rec._display_rank[method];
    }
    return getRank(rec, method);
  }
  // 計測中 (= 2年で集計対象大会 3 未満. build が metadata.provisional に出力).
  function isProvisional(rec) {
    return !!(rec.metadata && rec.metadata.provisional);
  }
  // rows の各レコードに _display_rank[method] と _is_overseas / _is_gray を付与する.
  // overseasUids: Set<number> | number[] | null
  // 灰色 (= JP カウント対象外) = 海外上位 or 計測中.
  // methods: 処理対象の method 名一覧 (省略時は rows.ranks に現れる全 method).
  //   サブページ (= 使い手/ローカル) では rec.ranks.tjpr 等が GLOBAL 順位を保持しているため、
  //   ローカルプール上での jp-counter 計算は意味を持たない. その場合は ['ensemble'] のみ
  //   渡してメイン rank 列だけ処理する.
  // 同一 rows を 2 回処理しても idempotent.
  function computeDisplayRanks(rows, overseasUids, methods) {
    if (!rows || !rows.length) return;
    const setUids = overseasUids instanceof Set
      ? overseasUids
      : new Set(overseasUids || []);
    // method 一覧
    let methodList = methods;
    if (!methodList) {
      const ms = new Set();
      for (const r of rows) {
        if (r.ranks) for (const k of Object.keys(r.ranks)) ms.add(k);
      }
      methodList = Array.from(ms);
    }
    // 海外勢 / 灰色フラグ
    let anyGray = false;
    for (const r of rows) {
      r._is_overseas = setUids.has(r.user_id);
      r._is_gray = r._is_overseas || isProvisional(r);
      if (r._is_gray) anyGray = true;
    }
    // 指定 method の _display_rank をリセット (再計算前提)
    for (const r of rows) {
      if (!r._display_rank) r._display_rank = {};
      for (const m of methodList) delete r._display_rank[m];
    }
    if (!anyGray) return;  // 灰色なしなら _display_rank 計算不要
    for (const method of methodList) {
      // 同順位 (= 灰色の相当順位と JP の本順位が同じ数字) は灰色を先に並べる.
      // これでサーバ保存済み jp-counter 値を入力にしても再計算が冪等になる
      // (= 灰色を JP の後に数えると相当順位が +1 ずれる).
      const ranked = rows
        .filter(r => r.ranks && r.ranks[method] != null && r.ranks[method] > 0)
        .slice()
        .sort((a, b) => (a.ranks[method] - b.ranks[method])
          || ((b._is_gray ? 1 : 0) - (a._is_gray ? 1 : 0)));
      let jp = 0;
      for (const r of ranked) {
        if (r._is_gray) {
          // 灰色勢: 「JP only で見たら何位相当か」(= 上位 JP 数 + 1).
          // jp_counter は進めない (= JP 相当順位を圧縮表示する仕様).
          r._display_rank[method] = jp + 1;
        } else {
          jp += 1;
          r._display_rank[method] = jp;
        }
      }
    }
  }
  function getScore(rec, method) {
    if (!rec.scores) return -getRank(rec, 'ensemble');
    switch (method) {
      case 'tjpr':     return rec.scores.tjpr_score;
      case 'bt_gated': return rec.scores.bt_gated_elo;
      case 'ensemble':
      default:         return -getRank(rec, 'ensemble');
    }
  }
  function formatScore(rec, method) {
    if (rec.unranked || !rec.scores) return '–';
    switch (method) {
      case 'tjpr':     return rec.scores.tjpr_elo != null ? rec.scores.tjpr_elo.toFixed(2) : '–';
      case 'bt_gated': return rec.scores.bt_gated_elo != null ? rec.scores.bt_gated_elo.toFixed(2) : '–';
      case 'ensemble':
      default: {
        const e = rec.scores.ensemble_avg_score != null
          ? rec.scores.ensemble_avg_score
          : (rec.scores.tjpr_elo + rec.scores.bt_gated_elo) / 2;
        return e != null ? e.toFixed(1) : '–';
      }
    }
  }
  function formatAvgRank(rec) {
    if (rec.unranked || !rec.scores) return '–';
    const ar = rec.scores.ensemble_avg_rank;
    return ar != null ? `#${ar.toFixed(1)}` : '–';
  }

  // === Built-in column definitions ===
  // 各 col 定義:
  //   { label, sortable?, sortKey?, css, headerCss?, value?(rec, ctx), cell(rec, ctx) }
  // - sortable=true で thead に sortable class が付き、sortKey で比較関数が呼ばれる
  // - value(rec, ctx) は sort 比較用の数値 (大きいほど後ろ); 省略時は cell から判定不可なので
  //   sort 不可
  // - cell(rec, ctx) は `<td>` の innerHTML を返す
  const BUILTIN_COLUMNS = {
    rank: {
      label: '#', sortable: true, sortKey: 'rank', css: 'col-rank',
      // sort 用 value は実順位 (= 真の並び順を維持. display_rank だと
      // 海外勢の equiv rank と JP-only counter の重複でソートが乱れる).
      value: (rec, ctx) => getRank(rec, ctx.method),
      cell: (rec, ctx) => {
        const r = getDisplayRank(rec, ctx.method);
        const total = ctx.totalForRankFrac;
        return r === Infinity ? '–' : `${r} <span class="rank-frac">/ ${total}</span>`;
      },
    },
    display: {
      label: 'プレイヤー', sortable: true, sortKey: 'display', css: 'col-display',
      value: (rec) => rec.display,
      cell: (rec, ctx) => {
        // LV は共通 cascade 由来 (= shared_cascade_lv)。fallback で旧 tjpr_level
        const lv = (rec.scores && (rec.scores.shared_cascade_lv || rec.scores.tjpr_level)) || 0;
        const lvClass = lv > 0 ? `lv-${lv}` : '';
        // レベル接尾辞: Lv5 は順位で 👑(≤8)/🥇(≤16)/🥈(≤32)/🥉(≤64)/+(≤128)、
        // Lv1-4 は +カットオフ(384/768/1536/3072)以内なら「+」。
        // 👑/メダルは「全国での到達度」を表すので、絞り込みビュー(使い手/都道府県別=
        // ensemble がローカル順位に再付番される)では global_ensemble を使う。
        // 本番ランキングは global_ensemble 未設定なので ensemble(=全国順位) に fallback。
        const _rk = (rec.ranks && (rec.ranks.global_ensemble || rec.ranks.ensemble)) || 0;
        let lvSuffix = '';
        if (lv === 5 && _rk) {
          lvSuffix = _rk <= 8 ? '👑' : _rk <= 16 ? '🥇' : _rk <= 32 ? '🥈'
                   : _rk <= 64 ? '🥉' : _rk <= 128 ? '+' : '';
        } else if (lv > 0 && _rk) {
          const _c = { 4: 384, 3: 768, 2: 1536, 1: 3072 }[lv];
          lvSuffix = (_c && _rk <= _c) ? '+' : '';
        }
        // 計測中 (= 2年で集計対象大会 3 未満) → "計測中" pill. それ以外は表示なし.
        // 海外上位と同居可 (= 両方付く. 処理上の灰色判定は海外上位が優先).
        const btPill = isProvisional(rec)
          ? '<span class="gate-pill rookie">計測中</span>'
          : '';

        const nameHtml = rec.unranked
          ? `<span class="player-name">${escapeHtml(rec.display)}</span>`
          : `<a class="player-name" href="${ctx.playerHrefPrefix}p/?uid=${rec.user_id}" onclick="event.stopPropagation()">${escapeHtml(rec.display)}</a>`;
        // メイン使用キャラの絵文字 (= 名前の左)。
        const charEmoji = rec.main_char_emoji
          ? `<span class="main-char-emoji" title="メイン使用キャラ">${rec.main_char_emoji}</span>`
          : '';

        const lvMobile = (ctx.showDisplayBadges && lv > 0)
          ? `<span class="display-lv-mobile"><span class="lv-badge ${lvClass}">Lv${lv}${lvSuffix}</span></span>`
          : '';
        const gateMobile = ctx.showDisplayBadges
          ? `<span class="display-gate-mobile">${btPill}</span>`
          : '';

        const gRank = rec.ranks && rec.ranks.global_ensemble;
        const gRankBadge = (ctx.showGlobalRank && gRank)
          ? `<span class="global-rank-badge">全国 #${gRank}</span>`
          : '';

        // 海外上位 (= site/data/overseas.json 該当者). 行背景の薄灰色と合わせて識別.
        const overseasBadge = rec._is_overseas
          ? '<span class="overseas-badge">海外上位</span>'
          : '';
        // 全一/全二/全三 (= 各キャラのメイン使い手 #1/#2/#3, 海外勢除外後).
        // attachZenichi() で rec._zenichi = {1: [...], 2: [...], 3: [...]} を入れておく.
        const _rankKanji = { 1: '一', 2: '二', 3: '三' };
        let zenichiBadge = '';
        if (rec._zenichi) {
          for (const rank of [1, 2, 3]) {
            const chars = rec._zenichi[rank];
            if (chars && chars.length) {
              const label = `全${_rankKanji[rank]}`;
              zenichiBadge += `<span class="zenichi-badge zenichi-${rank}" title="${escapeHtml(chars.join('・'))}${label}">${label}</span>`;
            }
          }
        }

        // ローカルランキング系: 参加回数 / 最終参加日 を mobile では display 内 badge として出す.
        // (PC では別列で見える. mobile は列が消えるので display 内に詰める)
        const localN = rec.localN;
        const localLast = rec.localLast;
        const localBadge = (ctx.showLocalExtras && (localN != null || localLast))
          ? `<span class="local-extras-mobile">${localN != null ? `参加 ${localN}` : ''}${localN != null && localLast ? ' · ' : ''}${localLast ? `最終 ${escapeHtml(localLast)}` : ''}</span>`
          : '';

        // top_tours は表示用 (= 大会名 + 順位). クリックでは大会ページに飛ばない
        // (= 行全体クリックで詳細展開する UX を優先、誤クリック防止).
        const topTours = (ctx.showTopTours && rec.top_tours && rec.top_tours.length)
          ? `<div class="top-tours">${rec.top_tours.map(t => {
              const seriesText = escapeHtml(t.series || '');
              const numText = (t.num != null) ? `<span class="num">${t.num}</span>` : '';
              const inner = `<span class="series">${seriesText}</span>${numText}`;
              const placePart = (t.place != null && t.nent != null)
                ? `<span class="place">${t.place}/${t.nent}</span>` : '';
              return `<span class="tour-chip">${inner}${placePart}</span>`;
            }).join('<span class="sep">·</span>')}</div>`
          : '';

        return `<div class="display-line">${charEmoji}${nameHtml}${lvMobile}${gateMobile}${overseasBadge}${zenichiBadge}${gRankBadge}${localBadge}</div>${topTours}`;
      },
    },
    avg_rank: {
      label: '平均順位', sortable: true, sortKey: 'avg_rank', css: 'col-avg-rank',
      value: (rec) => rec.scores && rec.scores.ensemble_avg_rank != null
        ? rec.scores.ensemble_avg_rank : 99999,
      cell: (rec) => formatAvgRank(rec),
    },
    score: {
      label: 'スコア', sortable: true, sortKey: 'score', css: 'col-score',
      value: (rec, ctx) => -getScore(rec, ctx.method),
      cell: (rec, ctx) => formatScore(rec, ctx.method),
    },
    tjpr_lv: {
      label: 'Lv', sortable: true, sortKey: 'shared_cascade_lv', css: 'col-tjpr-lv',
      value: (rec) => -((rec.scores && (rec.scores.shared_cascade_lv || rec.scores.tjpr_level)) || 0),
      cell: (rec) => {
        const lv = (rec.scores && (rec.scores.shared_cascade_lv || rec.scores.tjpr_level)) || 0;
        const lvClass = lv > 0 ? `lv-${lv}` : '';
        return lv > 0 ? `<span class="lv-badge ${lvClass}">Lv${lv}</span>` : '–';
      },
    },
    tour_count: {
      label: '大会数', sortable: true, sortKey: 'tour_count_3y', css: 'col-tour-count',
      value: (rec) => -((rec.metadata && rec.metadata.tour_count_3y) || 0),
      cell: (rec) => (rec.metadata && rec.metadata.tour_count_3y != null)
        ? rec.metadata.tour_count_3y : '–',
    },
    bt_weekday: {
      label: '計測中', sortable: false, css: 'col-bt-weekday',
      cell: (rec, ctx) => {
        const prov = isProvisional(rec);
        if (ctx.btWeekdayStyle === 'yn') {
          return prov ? '<span class="yn-yes">✓</span>' : '<span class="yn-no">−</span>';
        }
        // 'pill' (default): 計測中 → pill、それ以外 → 空
        return prov
          ? '<span class="gate-pill rookie">計測中</span>'
          : '';
      },
    },
    rank_tjpr: {
      label: '順位評', sortable: true, sortKey: 'rank_tjpr', css: 'col-other-rank',
      value: (rec) => (rec.ranks && rec.ranks.tjpr) || 99999,
      cell: (rec) => {
        const r = getDisplayRank(rec, 'tjpr');
        return r === Infinity ? '–' : r;
      },
    },
    rank_bt_gated: {
      label: '直対評', sortable: true, sortKey: 'rank_bt_gated', css: 'col-other-rank',
      value: (rec) => (rec.ranks && rec.ranks.bt_gated) || 99999,
      cell: (rec) => {
        const r = getDisplayRank(rec, 'bt_gated');
        return r === Infinity ? '–' : r;
      },
    },
  };

  function resolveColumn(spec) {
    if (typeof spec === 'string') {
      const col = BUILTIN_COLUMNS[spec];
      if (!col) throw new Error(`Unknown column id: ${spec}`);
      return Object.assign({ id: spec }, col);
    }
    if (spec && typeof spec === 'object' && spec.id) {
      // custom column. Required: id, label, css, cell. Optional: sortable, sortKey, value, headerCss.
      return spec;
    }
    throw new Error(`Invalid column spec: ${JSON.stringify(spec)}`);
  }

  class RankingTable {
    constructor(opts) {
      this.table = opts.table || document.getElementById('ranktable');
      if (!this.table) throw new Error('RankingTable: table element not found');

      this.rows = opts.rows || [];
      this.method = opts.method || 'ensemble';
      this.filterText = opts.filterText || '';
      this.sort = opts.sort || { key: 'rank', dir: 'asc' };
      this.pageSize = opts.pageSize || 100;
      this.infiniteScroll = opts.infiniteScroll !== false;
      this.currentCap = this.pageSize;

      this.totalForRankFrac = opts.totalForRankFrac || 'rows';
      this.playerHrefPrefix = opts.playerHrefPrefix != null ? opts.playerHrefPrefix : '';
      this.showTopTours = opts.showTopTours !== false;
      this.showDisplayBadges = opts.showDisplayBadges !== false;
      this.showGlobalRank = !!opts.showGlobalRank;
      this.showLocalExtras = !!opts.showLocalExtras;
      this.btWeekdayStyle = opts.btWeekdayStyle || 'pill';

      this.columns = (opts.columns || [
        'rank','display','avg_rank','score','tjpr_lv',
        'tour_count','bt_weekday','rank_tjpr','rank_bt_gated',
      ]).map(resolveColumn);

      // Row click mode: 'expand' | 'select' | 'none' | callback
      this.rowClick = opts.rowClick || 'none';
      this.selectedUids = new Set();
      this._listeners = {};

      this._lastFiltered = [];
      this._render();

      // thead click → sort
      this.table.addEventListener('click', (e) => {
        const th = e.target.closest('th.sortable');
        if (th) {
          const key = th.dataset.sort;
          if (!key) return;
          if (this.sort.key === key) {
            this.sort.dir = this.sort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            this.sort = { key, dir: 'asc' };
          }
          this.refresh();
        }
      });

      // tbody click → row click
      this.table.addEventListener('click', (e) => {
        const tr = e.target.closest('tr.main-row');
        if (!tr || !this.table.contains(tr)) return;
        const uid = parseInt(tr.dataset.uid, 10);
        if (isNaN(uid)) return;
        const idx = parseInt(tr.dataset.idx, 10);
        const rec = (this._lastFiltered[idx] != null) ? this._lastFiltered[idx] : null;
        this._handleRowClick(rec, tr, e);
      });

      // Infinite scroll
      if (this.infiniteScroll) {
        this._scrollHandler = () => {
          if (this._lastFiltered.length <= this.currentCap) return;
          const doc = document.documentElement;
          if (doc.scrollHeight - window.scrollY - window.innerHeight < 600) {
            this.currentCap += this.pageSize;
            this._renderBody();
          }
        };
        window.addEventListener('scroll', this._scrollHandler, { passive: true });
      }
    }

    // === Public API ===
    setRows(rows) {
      this.rows = rows || [];
      this.currentCap = this.pageSize;
      this.refresh();
    }
    setMethod(method) {
      this.method = method;
      this.refresh();
    }
    setFilterText(text) {
      this.filterText = text || '';
      this.currentCap = this.pageSize;
      this.refresh();
    }
    setSort(key, dir) {
      this.sort = { key, dir: dir || 'asc' };
      this.refresh();
    }
    setColumns(cols) {
      this.columns = cols.map(resolveColumn);
      this._render();
    }
    setColumnVisibility(id, visible) {
      // 簡易: 該当 column 自体は残し、CSS 切替 (not implemented yet — call setColumns instead)
      throw new Error('setColumnVisibility not implemented; use setColumns to update column list');
    }
    setPlayerHrefPrefix(prefix) {
      this.playerHrefPrefix = prefix;
      this.refresh();
    }
    setRowClick(mode) {
      this.rowClick = mode;
    }
    refresh() {
      this._renderBody();
      this._updateHeaderSortIndicators();
    }
    on(eventName, handler) {
      if (!this._listeners[eventName]) this._listeners[eventName] = [];
      this._listeners[eventName].push(handler);
    }
    emit(eventName, data) {
      if (!this._listeners[eventName]) return;
      this._listeners[eventName].forEach(fn => {
        try { fn(data); } catch (e) { console.error(`Listener error for ${eventName}:`, e); }
      });
    }
    getSelectedUids() {
      return Array.from(this.selectedUids);
    }
    clearSelection() {
      this.selectedUids.clear();
      this.table.querySelectorAll('tr.main-row.row-selected').forEach(tr => {
        tr.classList.remove('row-selected');
      });
      this.emit('select-change', this.getSelectedUids());
    }
    getLastFiltered() {
      return this._lastFiltered;
    }
    destroy() {
      if (this._scrollHandler) {
        window.removeEventListener('scroll', this._scrollHandler);
      }
    }

    // === Internal ===
    _render() {
      // thead
      const thead = this.table.querySelector('thead') || (() => {
        const t = document.createElement('thead');
        this.table.insertBefore(t, this.table.firstChild);
        return t;
      })();
      thead.innerHTML = '<tr>' + this.columns.map(col => {
        const cls = (col.sortable ? 'sortable ' : '') + col.css;
        const dataSort = col.sortable ? ` data-sort="${col.sortKey || col.id}"` : '';
        return `<th class="${cls}"${dataSort}>${col.label}</th>`;
      }).join('') + '</tr>';

      // tbody
      let tbody = this.table.querySelector('tbody');
      if (!tbody) {
        tbody = document.createElement('tbody');
        this.table.appendChild(tbody);
      }
      this._tbody = tbody;
      this._renderBody();
      this._updateHeaderSortIndicators();
    }

    _renderBody() {
      const tbody = this._tbody;
      if (!tbody) return;

      const ft = (this.filterText || '').toLowerCase();
      let filtered = this.rows;
      if (ft) {
        filtered = this.rows.filter(r =>
          (r.display && r.display.toLowerCase().includes(ft)) ||
          String(r.user_id).includes(ft)
        );
      }

      // Sort
      const { key, dir } = this.sort;
      const sign = dir === 'asc' ? 1 : -1;
      const sortCol = this.columns.find(c => c.sortKey === key || c.id === key);
      const compare = (a, b) => {
        if (key === 'display') {
          return sign * (a.display || '').localeCompare(b.display || '');
        }
        if (sortCol && sortCol.value) {
          const va = sortCol.value(a, this._ctx());
          const vb = sortCol.value(b, this._ctx());
          if (typeof va === 'string' || typeof vb === 'string') {
            return sign * String(va).localeCompare(String(vb));
          }
          return sign * (va - vb);
        }
        return 0;
      };
      filtered = filtered.slice().sort(compare);
      this._lastFiltered = filtered;

      const cap = this.currentCap;
      const shown = filtered.slice(0, cap);
      const ctx = this._ctx();
      const colspan = this.columns.length;

      const html = [];
      shown.forEach((rec, idx) => {
        let rowCls = rec.unranked ? 'main-row unranked' : 'main-row';
        if (rec._is_overseas) rowCls += ' is-overseas';
        else if (isProvisional(rec)) rowCls += ' is-provisional';
        const selectedCls = (this.selectedUids.has(rec.user_id)) ? ' row-selected' : '';
        html.push(`<tr class="${rowCls}${selectedCls}" data-idx="${idx}" data-uid="${rec.user_id}">`);
        this.columns.forEach(col => {
          let cellHtml;
          try { cellHtml = col.cell(rec, ctx); }
          catch (e) { console.error(`Column ${col.id} cell error:`, e); cellHtml = '–'; }
          html.push(`<td class="${col.css}">${cellHtml}</td>`);
        });
        html.push('</tr>');
      });
      if (filtered.length > cap) {
        html.push(`<tr id="load-more-row"><td colspan="${colspan}" class="empty-msg">下までスクロールでさらに表示 (残り ${filtered.length - cap} 名)</td></tr>`);
      } else if (filtered.length === 0) {
        html.push(`<tr><td colspan="${colspan}" class="empty-msg">該当者なし</td></tr>`);
      }
      tbody.innerHTML = html.join('');

      this.emit('rendered', { shown, filtered });
    }

    _updateHeaderSortIndicators() {
      const ths = this.table.querySelectorAll('thead th.sortable');
      ths.forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.sort === this.sort.key) {
          th.classList.add(this.sort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }
      });
    }

    _ctx() {
      let total;
      if (typeof this.totalForRankFrac === 'function') {
        total = this.totalForRankFrac(this);
      } else if (this.totalForRankFrac === 'rows') {
        total = this.rows.length;
      } else if (this.totalForRankFrac === 'meta') {
        total = (this.meta && this.meta.n_players) || this.rows.length;
      } else {
        total = this.totalForRankFrac;
      }
      return {
        method: this.method,
        totalForRankFrac: total,
        playerHrefPrefix: this.playerHrefPrefix,
        showTopTours: this.showTopTours,
        showDisplayBadges: this.showDisplayBadges,
        showGlobalRank: this.showGlobalRank,
        showLocalExtras: this.showLocalExtras,
        btWeekdayStyle: this.btWeekdayStyle,
      };
    }

    _handleRowClick(rec, tr, ev) {
      // emit first; allow external handlers to intercept
      this.emit('row-click', { rec, tr, ev });
      if (rec == null) return;

      const mode = this.rowClick;
      if (typeof mode === 'function') {
        try { mode(rec, tr, ev); } catch (e) { console.error('rowClick callback error:', e); }
        return;
      }
      if (mode === 'select') {
        const uid = rec.user_id;
        if (this.selectedUids.has(uid)) {
          this.selectedUids.delete(uid);
          tr.classList.remove('row-selected');
        } else {
          this.selectedUids.add(uid);
          tr.classList.add('row-selected');
        }
        this.emit('select-change', this.getSelectedUids());
      } else if (mode === 'expand') {
        // Try to delegate to SPSPDetail if available
        if (global.SPSPDetail && typeof global.SPSPDetail.buildDetailContent === 'function') {
          this._toggleExpand(rec, tr);
        } else {
          console.warn('rowClick="expand" but window.SPSPDetail is not loaded.');
        }
      }
      // 'none' → do nothing built-in
    }

    _toggleExpand(rec, tr) {
      const next = tr.nextElementSibling;
      const colspan = this.columns.length;
      if (next && next.classList && next.classList.contains('detail-row')) {
        next.remove();
        tr.classList.remove('expanded');
        return;
      }
      // Close any other open detail row
      const open = this.table.querySelector('tr.detail-row');
      if (open) {
        const prev = open.previousElementSibling;
        if (prev) prev.classList.remove('expanded');
        open.remove();
      }
      tr.classList.add('expanded');
      const detail = document.createElement('tr');
      detail.className = 'detail-row';
      detail.innerHTML = `<td colspan="${colspan}"><div class="detail-inner">Loading...</div></td>`;
      tr.parentNode.insertBefore(detail, tr.nextSibling);
      const inner = detail.querySelector('.detail-inner');
      // SPSPDetail.buildDetailContent expects (rec, meta?) and may be async.
      const result = global.SPSPDetail.buildDetailContent(rec, this.meta);
      if (result && typeof result.then === 'function') {
        result.then(html => { if (inner) inner.innerHTML = html; })
              .catch(err => { if (inner) inner.innerHTML = `<div class="empty-msg">エラー: ${escapeHtml(err.message)}</div>`; });
      } else {
        inner.innerHTML = result;
      }
    }
  }

  // rows の各レコードに _zenichi: {1: [charName...], 2: [...], 3: [...]} を付与.
  // 全一/全二/全三 = キャラ毎の main_by_char[id] の海外勢を除いた 1, 2, 3 番手.
  // 一人で複数キャラの場合は配列に全キャラ名が入る.
  function attachZenichi(rows, charIndex, overseasUids) {
    if (!rows || !charIndex || !charIndex.characters) return;
    const setUids = overseasUids
      ? (overseasUids instanceof Set ? overseasUids : new Set(overseasUids))
      : new Set();
    // uidToRanks: uid -> {1: [chars], 2: [chars], 3: [chars]}
    const uidToRanks = new Map();
    const addEntry = (uid, rank, charName) => {
      let m = uidToRanks.get(uid);
      if (!m) { m = {}; uidToRanks.set(uid, m); }
      if (!m[rank]) m[rank] = [];
      m[rank].push(charName);
    };
    for (const c of charIndex.characters) {
      const uids = (charIndex.main_by_char && charIndex.main_by_char[String(c.id)]) || [];
      // 海外勢をスキップしながら 1..3 位を拾う.
      let rank = 0;
      for (const u of uids) {
        if (setUids.has(u)) continue;
        rank += 1;
        addEntry(u, rank, c.name);
        if (rank >= 3) break;
      }
    }
    for (const r of rows) {
      const m = uidToRanks.get(r.user_id);
      if (m) r._zenichi = m;
    }
  }

  // === Public API ===
  global.SPSPRankingTable = {
    RankingTable,
    BUILTIN_COLUMNS,
    escapeHtml,
    formatScore,
    formatAvgRank,
    getRank,
    getDisplayRank,
    getScore,
    computeDisplayRanks,
    attachZenichi,
    isProvisional,
  };
})(window);
