// player_data.js — 分割された配信 JSON から選手レコードを組み立てる (サイト共通)。
//
// ビルドは選手ごとの JSON を 3 つに分けて出す (docs/refactor/04_player_json_split.md):
//   players/<uid>.json    安定部分 (出場したときしか変わらない)
//   history/<uid>.json    固定グリッド日付のランク履歴 [{date, ens, tjpr_r, ...}]
//   players_current.json  全選手の揮発部分 {eval_date, eval_ts, decay_r, columns, players: {uid: [列形式]}}
// assemble() はこれらを以前の players/<uid>.json と同じ形 (1 オブジェクト) に戻す。既存ページは
// 読み込み部分だけ差し替えれば残りはそのまま動く。減衰後の値 (tjpr_w / tjpr_age) と
// 「N 日前」は評価日から計算する。
//
//   SPSPPlayerData.assemble(stable, currentRec, history, ctx) → 旧 detail record
//       ctx = {eval_ts, eval_date, decay_r}  (players_current.json の eval_ts / eval_date と meta.json の decay_r。無ければ既定)
//   SPSPPlayerData.load(prefix, uid, opts)  → Promise<旧 detail record | null>
//       prefix = '../' 等 (サイトルートまでの相対)。players_current.json は 1 度だけ取得して共有する。
//   SPSPPlayerData.loadCurrent(prefix)      → Promise<players_current.json の中身> (共有キャッシュ)
//   SPSPPlayerData.currentOf(cur, uid)      → uid の揮発部分 (ranks / scores / peak_ranks …) を入れ子 dict で
//   SPSPPlayerData.currentRank(cur, uid, key='ensemble') → 現在の全国順位 (無ければ null)
//   SPSPPlayerData.tjprWeight(entry, ctx)   → {age, w}
//   SPSPPlayerData.daysAgoLabel(days)       → "N日前" / "now" (旧 peak_ranks.when と同じ表記)
//
// 分割の定義は spsp/split_output.py。両者は鏡なので片方を変えたらもう片方も変える
// (tests/split/test_assemble.mjs が旧形式との一致を確かめる)。
(function (global) {
  'use strict';

  var DEFAULT_DECAY_R = 0.96;
  var DAY = 86400;

  // 旧 record のキー順 (見た目の互換のためだけ。消費側は順序に依存しない)
  var SCORE_ORDER = ['tjpr_score', 'tjpr_elo', 'tjpr_level', 'bt_gated_ordinal', 'bt_gated_elo',
    'bt_internal_ordinal', 'bt_internal_elo', 'bt_all_ordinal', 'bt_all_elo',
    'ensemble_avg_rank', 'ensemble_avg_score', 'bt_internal_d_last', 'shared_cascade_lv', 'shared_cascade_ens_r'];
  var META_ORDER = ['tour_count_3y', 'bt_weekday_included', 'matches_count_3y', 'tour_count_by_period',
    'match_count_by_period', 'debut', 'provisional'];
  var RADAR_ORDER = ['tjpr_pt', 'spr_upper', 'spr_stability', 'bt_pt', 'uf_upper', 'uf_stability',
    'spr_upper_raw', 'spr_neg_raw', 'uf_upper_raw', 'uf_lost_raw'];

  function mergeOrdered(a, b, order) {
    // a (安定) と b (揮発) を order の順で 1 つに。order に無いキーは後ろに (a → b の順)
    var out = {}, k, i;
    a = a || {}; b = b || {};
    for (i = 0; i < order.length; i++) {
      k = order[i];
      if (k in b) out[k] = b[k]; else if (k in a) out[k] = a[k];
    }
    for (k in a) if (!(k in out)) out[k] = a[k];
    for (k in b) if (!(k in out)) out[k] = b[k];
    return out;
  }

  // 減衰: spsp/learn.py の weighted = raw_pts × age_decay × pos_factor、age_decay = r^(days/30)、
  // days = (評価日 23:59:59 − 大会時刻) の日数 (切り捨て)。
  function tjprWeight(e, ctx) {
    var r = (ctx && ctx.decay_r) || DEFAULT_DECAY_R;
    var evalTs = ctx && ctx.eval_ts;
    var age = 1.0;
    if (evalTs != null && e && e.ts != null) {
      var days = Math.floor((evalTs - e.ts) / DAY);
      age = Math.pow(r, days / 30.0);
    }
    var raw = (e && e.tjpr_raw) || 0, pos = (e && e.tjpr_pos) || 0;
    var w = raw * pos * age;
    return { age: age, w: Math.round(w * 1e4) / 1e4 };
  }

  function entryKey(e) {
    return (e.event_id != null ? 'e' + e.event_id : 'v' + e.parent_event_id + ':' + e.class_letter);
  }

  function withWeight(e, ctx) {
    // 評価日が分からない (players_current.json が無い = 旧形式のデータ) なら、入っている旧値をそのまま使う
    if (!(ctx && ctx.eval_ts != null) && e && e.tjpr_w != null) return e;
    // 旧エントリと同じキー順: ... tjpr_raw, tjpr_age, tjpr_pos, tjpr_w, tjpr_lv ...
    var wa = tjprWeight(e, ctx), out = {}, k, done = false;
    for (k in e) {
      out[k] = e[k];
      if (k === 'tjpr_raw') { out.tjpr_age = wa.age; }
      if (k === 'tjpr_pos') { out.tjpr_w = wa.w; done = true; }
    }
    if (!done) { out.tjpr_age = wa.age; out.tjpr_w = wa.w; }
    return out;
  }

  function daysAgoLabel(days) {
    if (days == null) return null;
    return days <= 0 ? 'now' : (days + '日前');
  }

  function historyWithDays(rows, ctx) {
    // date → d (評価日から N 日前)。チャートは d で動くのでそのまま使える
    // 評価日 (YYYY-MM-DD) と行の日付の差を暦日で取る (UTC 同士で parse するのでタイムゾーンに依らない)
    var evalDay = ctx && ctx.eval_date ? Date.parse(ctx.eval_date) : null;
    var out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var h = rows[i], row = {}, k;
      for (k in h) {
        if (k === 'date') {
          row.d = evalDay != null ? Math.round((evalDay - Date.parse(h.date)) / (DAY * 1000)) : null;
        } else row[k] = h[k];
      }
      out.push(row);
    }
    return out;
  }

  function assemble(stable, cur, history, ctx) {
    if (!stable) return null;
    cur = cur || {};
    ctx = ctx || {};
    var byKey = {}, tours = [], i, e;
    for (i = 0; i < (stable.tournaments || []).length; i++) {
      e = withWeight(stable.tournaments[i], ctx);
      tours.push(e);
      byKey[entryKey(e)] = e;
    }
    var out = {}, k;
    for (k in stable) {
      if (k === 'display') {
        out.display = stable.display;
        out.ranks = cur.ranks || stable.ranks || {};
        out.scores = mergeOrdered(stable.scores, cur.scores, SCORE_ORDER);
        out.metadata = mergeOrdered(stable.metadata, cur.metadata, META_ORDER);
        out.tjpr_lv_breakdown = cur.tjpr_lv_breakdown || stable.tjpr_lv_breakdown || {};
      } else if (k === 'scores' || k === 'metadata' || k === 'ranks' || k === 'tjpr_lv_breakdown') {
        continue;   // display のところで揮発分と合わせて入れた
      } else if (k === 'tournaments') {
        out.tournaments = tours;
        out.history = (history && history.length) ? historyWithDays(history, ctx) : (stable.history || []);
      } else if (k === 'history') {
        continue;   // tournaments のところで入れた (旧形式なら stable.history がそのまま)
      } else if (k === 'top_tjpr_contribs') {
        // tournaments[] の slim 版。減衰計算に要る ts / tjpr_pos は tournaments[] 側から借り、tjpr_w だけ足す
        out[k] = (stable[k] || []).map(function (s) {
          var t = byKey[entryKey(s)];
          var w = t ? t.tjpr_w : tjprWeight(s, ctx).w;
          return insertAfter(s, 'tjpr_raw', 'tjpr_w', w);
        });
      } else if (k === 'top_spr') {
        // 旧 top_spr は base フェーズの tjpr_* を持っていて tournaments[] と食い違っていた。
        // 今は tournaments[] の同じ大会の最終値を入れる (spsp/split_output.py 参照)
        out[k] = (stable[k] || []).map(function (s) {
          var t = byKey[entryKey(s)] || {};
          var o = insertAfter(s, 'spr', 'tjpr_w', t.tjpr_w != null ? t.tjpr_w : 0);
          o = insertAfter(o, 'tjpr_w', 'tjpr_raw', t.tjpr_raw != null ? t.tjpr_raw : 0);
          o = insertAfter(o, 'tjpr_raw', 'tjpr_lv', t.tjpr_lv != null ? t.tjpr_lv : 0);
          return insertAfter(o, 'tjpr_lv', 'tjpr_counted', !!t.tjpr_counted);
        });
      } else if (k === 'radar') {
        out.radar = mergeOrdered(stable.radar, cur.radar, RADAR_ORDER);
        out.peak_ranks = cur.peak_ranks || stable.peak_ranks || {};
        out.peak_ranks_1y = cur.peak_ranks_1y || stable.peak_ranks_1y || {};
      } else if (k === 'peak_ranks' || k === 'peak_ranks_1y') {
        continue;   // radar のところで入れた
      } else {
        out[k] = stable[k];
      }
    }
    return out;
  }

  function insertAfter(obj, afterKey, key, value) {
    // obj のコピーに key=value を afterKey の直後に入れる (afterKey が無ければ末尾)
    var o = {}, k, done = false;
    for (k in obj) { o[k] = obj[k]; if (k === afterKey) { o[key] = value; done = true; } }
    if (!done) o[key] = value;
    return o;
  }

  // ── players_current.json (列形式) の復号。列の並びは spsp/split_output.py の CURRENT_COLUMNS と鏡 ──
  var OPTIONAL_COLUMNS = { 'scores.shared_cascade_lv': 1, 'scores.shared_cascade_ens_r': 1,
    'tjpr_lv_breakdown.1': 1, 'tjpr_lv_breakdown.2': 1, 'tjpr_lv_breakdown.3': 1, 'tjpr_lv_breakdown.4': 1, 'tjpr_lv_breakdown.5': 1 };
  function setPath(obj, path, value) {
    var parts = path.split('.'), cur = obj, i;
    for (i = 0; i < parts.length - 1; i++) { if (!(parts[i] in cur)) cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
  }
  function decodeCurrentRow(file, row) {
    // file = players_current.json 全体 (columns を持つ)、row = players[uid] の配列 → 入れ子 dict
    if (!row) return null;
    var cols = file.columns || [], out = {}, i, col, v;
    for (i = 0; i < cols.length; i++) {
      col = cols[i]; v = row[i];
      if (/\.when$/.test(col)) v = (v == null) ? null : daysAgoLabel(v);
      else if (v == null && OPTIONAL_COLUMNS[col]) continue;
      setPath(out, col, v);
    }
    // 順序を旧形式に揃える (ranks, scores, metadata, tjpr_lv_breakdown, radar, peak_ranks, peak_ranks_1y)
    var ordered = {}, keys = ['ranks', 'scores', 'metadata', 'tjpr_lv_breakdown', 'radar', 'peak_ranks', 'peak_ranks_1y'];
    for (i = 0; i < keys.length; i++) if (keys[i] in out) ordered[keys[i]] = out[keys[i]];
    if (!('tjpr_lv_breakdown' in ordered)) ordered.tjpr_lv_breakdown = {};
    return ordered;
  }
  function currentOf(file, uid) {
    // players_current.json から uid の揮発部分を入れ子 dict で。列形式でも入れ子形式でも読める
    var p = file && file.players && file.players[String(uid)];
    if (!p) return null;
    return Array.isArray(p) ? decodeCurrentRow(file, p) : p;
  }
  function currentRank(file, uid, key) {
    var p = currentOf(file, uid);
    var r = p && p.ranks && p.ranks[key || 'ensemble'];
    return (r != null && r > 0) ? r : null;
  }

  // ── 読み込み (ブラウザ用。fetch が無い環境では使わない) ──
  // players_current.json が無い (404) ときは空として続ける: ページ (site/) の更新とデータ (nightly) の更新には
  // 時間差があるので、新しいページ + 旧形式のデータ (players/<uid>.json に ranks 等が入っている) でも動くように。
  // assemble は安定側に残っている旧フィールド (ranks / history / peak_ranks …) をそのまま通す。
  var EMPTY_CURRENT = { eval_date: null, eval_ts: null, columns: [], players: {} };
  var _currentPromise = {};
  function loadCurrent(prefix) {
    prefix = prefix || '';
    if (!_currentPromise[prefix]) {
      _currentPromise[prefix] = fetch(prefix + 'players_current.json').then(function (r) {
        if (r.status === 404) return EMPTY_CURRENT;
        if (!r.ok) throw new Error('players_current.json 取得失敗 (HTTP ' + r.status + ')');
        return r.json();
      });
    }
    return _currentPromise[prefix];
  }

  function load(prefix, uid, opts) {
    prefix = prefix || '';
    opts = opts || {};
    // 404 = DB 未登録 (null で返す)。それ以外の失敗 (5xx / 通信) は throw (呼び出し側が再試行できるように区別する)
    var stableP = fetch(prefix + 'players/' + encodeURIComponent(uid) + '.json').then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('players/' + uid + '.json HTTP ' + r.status);
      return r.json();
    });
    var histP = opts.history === false ? Promise.resolve([])
      : fetch(prefix + 'history/' + encodeURIComponent(uid) + '.json').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    var curP = loadCurrent(prefix);
    return Promise.all([stableP, histP, curP]).then(function (res) {
      var stable = res[0], hist = res[1], cur = res[2];
      if (!stable) return null;
      var ctx = { eval_ts: cur.eval_ts, eval_date: cur.eval_date, decay_r: opts.decay_r || cur.decay_r };
      return assemble(stable, currentOf(cur, uid), hist, ctx);
    });
  }

  var api = {
    assemble: assemble, tjprWeight: tjprWeight, daysAgoLabel: daysAgoLabel,
    historyWithDays: historyWithDays, currentRank: currentRank, currentOf: currentOf, decodeCurrentRow: decodeCurrentRow,
    load: load, loadCurrent: loadCurrent,
    SCORE_ORDER: SCORE_ORDER, META_ORDER: META_ORDER, RADAR_ORDER: RADAR_ORDER,
  };
  global.SPSPPlayerData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
