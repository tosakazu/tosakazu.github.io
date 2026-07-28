/* SPSP ポイント予想 計算コア (v3 エンジンの JS 移植)
 *
 * 移植元 (spsp-ranking-v2):
 *  - glicko2: ranking_eval/.venv/.../glicko2/glicko2.py (Ryan Kirkman 2.1.0)
 *    ※ _f が rd^2 でなく rating^2 を使う「本家ライブラリのバグ」まで忠実に再現する
 *      (本番エンジンがこのライブラリで学習しているため、直すと数値が合わない)
 *  - banzuke: eval/smash_banzuke.py build_de_losers_round_participants
 *  - tier:    eval/jjpr_v3.py placement_to_tier
 *  - TJPR:    v3/eval_bt_lv_shared.py compute_tjpr_at_lv / _pt_agg
 *  - gating:  v3/eval_bt_lv_shared.py LV_DEFS / LV_TFILTERS (本番 env 適用後)
 *  - 非活動RD膨張: v3/eval_bt_lv_shared.py _apply_inactivity
 *
 * ブラウザ (window.SPSPCalc) と node (module.exports) の両方で使える。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SPSPCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ELO_PER_UNIT = 400 / (Math.LN10 * Math.SQRT2 * (25 / 6)); // 29.480887025826014
  var ELO_PER_UNIT_DISP = 29.4809;   // postprocess の表示用丸め定数
  var TJPR_ELO_SCALE = 17.5;
  var TJPR_DEFAULT_RATE = 1500.0;
  var DECAY_R = 0.96;                // 月次減衰
  var PD = 0.3;                      // top-N 以降の位置減衰
  var RAW_CAP = 9.965784284662087;   // -log2(1e-3)
  var PEAK_WINDOW_SEC = 180 * 86400;

  // ---- glicko2 (忠実移植) -------------------------------------------------
  var G2_SCALE = 173.7178;
  var TAU = 0.5;

  function G2Player(rating, rd, vol) {
    this.r = ((rating === undefined ? 1500 : rating) - 1500) / G2_SCALE; // 内部 μ
    this.d = (rd === undefined ? 350 : rd) / G2_SCALE;                    // 内部 φ
    this.vol = vol === undefined ? 0.06 : vol;
  }
  G2Player.prototype.rating = function () { return this.r * G2_SCALE + 1500; };
  G2Player.prototype.rd = function () { return this.d * G2_SCALE; };
  G2Player.prototype._g = function (phi) {
    return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
  };
  G2Player.prototype._E = function (mu2, phi2) {
    return 1 / (1 + Math.exp(-this._g(phi2) * (this.r - mu2)));
  };
  // ライブラリバグ再現: 本来 phi^2 (rd) のところ rating^2 (μ) を使っている
  G2Player.prototype._f = function (x, delta, v, a) {
    var ex = Math.exp(x);
    var mu2 = this.r * this.r;
    var num1 = ex * (delta * delta - mu2 - v - ex);
    var denom1 = 2 * (mu2 + v + ex) * (mu2 + v + ex);
    return num1 / denom1 - (x - a) / (TAU * TAU);
  };
  G2Player.prototype._newVol = function (muL, phiL, outL, v) {
    var a = Math.log(this.vol * this.vol);
    var eps = 0.000001;
    var A = a;
    var delta = this._delta(muL, phiL, outL, v);
    var B;
    if (delta * delta > this.d * this.d + v) {
      B = Math.log(delta * delta - this.d * this.d - v);
    } else {
      var k = 1;
      while (this._f(a - k * Math.sqrt(TAU * TAU), delta, v, a) < 0) k += 1;
      B = a - k * Math.sqrt(TAU * TAU);
    }
    var fA = this._f(A, delta, v, a);
    var fB = this._f(B, delta, v, a);
    while (Math.abs(B - A) > eps) {
      var C = A + (A - B) * fA / (fB - fA);
      var fC = this._f(C, delta, v, a);
      if (fC * fB <= 0) { A = B; fA = fB; } else { fA = fA / 2.0; }
      B = C; fB = fC;
    }
    return Math.exp(A / 2);
  };
  G2Player.prototype._delta = function (muL, phiL, outL, v) {
    var s = 0;
    for (var i = 0; i < muL.length; i++) s += this._g(phiL[i]) * (outL[i] - this._E(muL[i], phiL[i]));
    return v * s;
  };
  G2Player.prototype._v = function (muL, phiL) {
    var s = 0;
    for (var i = 0; i < muL.length; i++) {
      var E = this._E(muL[i], phiL[i]);
      var g = this._g(phiL[i]);
      s += g * g * E * (1 - E);
    }
    return 1 / s;
  };
  // ratingList/rdList は表示スケール, outcomeList は 1/0
  G2Player.prototype.update = function (ratingList, rdList, outcomeList) {
    var muL = ratingList.map(function (x) { return (x - 1500) / G2_SCALE; });
    var phiL = rdList.map(function (x) { return x / G2_SCALE; });
    var v = this._v(muL, phiL);
    this.vol = this._newVol(muL, phiL, outcomeList, v);
    this.d = Math.sqrt(this.d * this.d + this.vol * this.vol);   // preRatingRD
    this.d = 1 / Math.sqrt(1 / (this.d * this.d) + 1 / v);
    var s = 0;
    for (var i = 0; i < muL.length; i++) s += this._g(phiL[i]) * (outcomeList[i] - this._E(muL[i], phiL[i]));
    this.r += this.d * this.d * s;
  };

  // 非活動 RD 膨張 (_apply_inactivity)
  function applyInactivity(player, daysSinceLast) {
    if (daysSinceLast <= 30.0) return;
    var target = 128.0 / (1 + Math.exp(-(daysSinceLast - 540.0) / 180.0));
    if (player.rd() < target) player.d = target / G2_SCALE;
  }

  // ---- placement_to_tier (jjpr_v3.py) -------------------------------------
  function placementToTier(place) {
    if (place <= 0) return 0;
    if (place <= 4) return place - 1;
    var pos = 5, tier = 4, size = 2;
    for (;;) {
      if (place < pos + size) return tier;
      pos += size;
      tier += 1;
      if (tier % 2 === 0) size *= 2;
    }
  }

  // その tier の代表順位 (表示用): tier→その tier の最良順位
  function tierBestPlace(tier) {
    if (tier <= 3) return tier + 1;
    var pos = 5, t = 4, size = 2;
    while (t < tier) { pos += size; t += 1; if (t % 2 === 0) size *= 2; }
    return pos;
  }

  // ---- build_de_losers_round_participants (smash_banzuke.py) --------------
  function buildDeLosersRounds(n) {
    var bracketSize = 1;
    while (bracketSize < n) bracketSize *= 2;
    var winnersRounds = Math.round(Math.log2(bracketSize));

    var winnersActive = [];
    for (var i = 0; i < Math.min(n, bracketSize); i++) winnersActive.push(i);
    var dropdownsByWr = {};
    for (var wr = 0; wr < winnersRounds; wr++) {
      winnersActive.sort(function (a, b) { return a - b; });
      var half = Math.floor(winnersActive.length / 2);
      dropdownsByWr[wr] = winnersActive.slice(0, half);
      winnersActive = winnersActive.slice(half);
    }

    var targetRounds = Math.max(0, placementToTier(bracketSize));
    var lrTarget = Math.max(0, targetRounds - 1);
    var lrRounds = [];
    var lrActive = (dropdownsByWr[0] || []).slice().sort(function (a, b) { return a - b; });
    var wrIdx = 1;

    while (lrRounds.length < lrTarget) {
      if (lrActive.length >= 2) {
        lrRounds.push(lrActive.slice());
        lrActive.sort(function (a, b) { return a - b; });
        var h = Math.floor(lrActive.length / 2);
        lrActive = lrActive.slice(h);
      } else {
        lrRounds.push(lrActive.slice());
      }
      if (lrRounds.length >= lrTarget) break;
      if (wrIdx < winnersRounds && dropdownsByWr.hasOwnProperty(wrIdx)) {
        var combined = lrActive.concat(dropdownsByWr[wrIdx]).sort(function (a, b) { return a - b; });
        lrRounds.push(combined.slice());
        var h2 = Math.floor(combined.length / 2);
        lrActive = combined.slice(h2);
        wrIdx += 1;
      } else {
        lrRounds.push(lrActive.slice());
        if (lrActive.length >= 2) {
          var h3 = Math.floor(lrActive.length / 2);
          lrActive = lrActive.slice(h3);
        }
      }
    }

    if (targetRounds > 0 && bracketSize >= 2) {
      var top2 = [];
      var lim = Math.min(n, bracketSize);
      for (var j = Math.max(0, lim - 2); j < lim; j++) top2.push(j);
      lrRounds.push(top2);
    }
    return lrRounds;
  }

  // ---- TJPR (compute_tjpr_at_lv 相当) -------------------------------------
  var LV_PARAMS = {
    1: { base: 1700, floor: 350, topN: 1 },
    2: { base: 1900, floor: 700, topN: 3 },
    3: { base: 1900, floor: 700, topN: 3 },
    4: { base: 1900, floor: 700, topN: 3 },
    5: { base: 1900, floor: 700, topN: 3 },
  };

  // 本番 env 適用後の LV フィルタ (TJPR カスケード = BT gating と同一)
  // ⚠️ site/p/index.html buildYosouSection の MIN_NENT_GT と同期して更新すること
  var LV_FILTERS = {
    1: null,
    2: { minNentGt: 8 },
    3: { minNentGt: 24, weekendOnly: true, excludeCapped: true },
    4: { minNentGt: 32, weekendOnly: true, excludeCapped: true },
    5: { minNentGt: 48, weekendOnly: true, excludeCapped: true },
  };

  // meta: {nent, isWeekend, isCapped}
  function tournamentPassesLv(lv, meta) {
    var f = LV_FILTERS[lv];
    if (!f) return true;
    if (f.minNentGt !== undefined && meta.nent <= f.minNentGt) return false;
    if (f.weekendOnly && !meta.isWeekend) return false;
    if (f.excludeCapped && meta.isCapped) return false;
    return true;
  }

  // 大会の banzuke キャッシュを作る。
  // ratings: 参加者の現在レート配列 (未収録は 1500 を呼び出し側で入れる)
  // 返り値: {norm (昇順), rounds, n, nent, roundValuesByLv: {}}
  function buildBanzuke(ratings, nent) {
    var pool = ratings.slice();
    // EXCLUDE_TOP1: 最高レート 1 名を対戦相手プールから除外
    if (pool.length > 0) {
      var maxI = 0;
      for (var i = 1; i < pool.length; i++) if (pool[i] > pool[maxI]) maxI = i;
      pool.splice(maxI, 1);
    }
    pool.sort(function (a, b) { return a - b; });
    return { norm: pool, n: pool.length, nent: nent, rounds: buildDeLosersRounds(pool.length) };
  }

  // place 位を取った場合の素点 (weighted_raw = tjpr_raw 相当)
  function tjprRawForPlace(banzuke, lv, place) {
    var p = LV_PARAMS[lv] || LV_PARAMS[2];
    var norm = banzuke.norm, rounds = banzuke.rounds;
    var maxTier = placementToTier(banzuke.n);
    var rw = Math.min(Math.max(0, maxTier - placementToTier(place)), rounds.length);
    var sum = 0;
    for (var j = 0; j < rw; j++) {
      var idx = rounds[j];
      if (!idx.length) continue;   // 空ラウンドは 0
      var m = 0;
      for (var k = 0; k < idx.length; k++) {
        var r = Math.max(norm[idx[k]], p.floor);
        var val = Math.log2(1 + Math.pow(10, (r - p.base) / 400));
        m += Math.min(val, RAW_CAP);
      }
      sum += m / idx.length;
    }
    var sizeW = Math.sqrt(Math.log2(Math.max(banzuke.nent, 2)));
    return sum * sizeW;
  }

  // エントリ集合の再集計 (_pt_agg): entries = [raw*age, ...]
  function aggregateEntries(entries, lv) {
    var topN = (LV_PARAMS[lv] || LV_PARAMS[2]).topN;
    var es = entries.slice().sort(function (a, b) { return b - a; });
    var total = 0;
    for (var i = 0; i < es.length; i++) {
      var pos = i < topN ? 1.0 : Math.pow(PD, i - topN + 1);
      total += es[i] * pos;
    }
    return total;
  }

  // players/<uid>.json からエンジン内部のエントリ列 (raw*age 相当) を復元する。
  // per-tour LV の内部値は表示用 tjpr_raw*tjpr_age と食い違う行があるため、
  // pos が十分大きい行は tjpr_w/tjpr_pos (エンジン真値) を使い、
  // pos が極小の行は丸め誤差が爆発するので tjpr_raw*tjpr_age に切り替える。
  // 復元誤差は上位行では 0、深い行でも合計 ~0.01 以下 (寄与が pos で減衰するため)。
  function extractEntries(playerJson) {
    var lv = playerJson.scores.shared_cascade_lv;
    var out = [];
    var ts = playerJson.tournaments || [];
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      if (t.tjpr_lv !== lv || !lv) continue;
      var e;
      if (t.tjpr_pos >= 0.005) e = t.tjpr_w / t.tjpr_pos;
      else e = (t.tjpr_raw || 0) * (t.tjpr_age || 0);
      out.push(e);
    }
    return out;
  }

  // ---- 180d peak ----------------------------------------------------------
  // history: [{ts, rating}] (トーナメント毎の更新後レート), atTs 時点の peak。
  // 窓内に履歴が無い場合は currentRating に carry-forward。
  function peakAt(history, atTs, currentRating) {
    var best = -Infinity;
    for (var i = 0; i < history.length; i++) {
      if (history[i].ts >= atTs - PEAK_WINDOW_SEC && history[i].ts <= atTs) {
        if (history[i].rating > best) best = history[i].rating;
      }
    }
    return best === -Infinity ? currentRating : best;
  }

  // ---- 総合評価 (ensemble) 暫定順位の近似 -----------------------------------
  // エンジンは Lv カスケード内で (bt_rank + tj_rank)/2 の ens_rank を作り、
  // (-max_lv, ens_r, uid) ソート + jp-counter で表示順位を決める。
  // Lv(n+1) の cohort は「Lv(n) の ens rank 上位 N (2048/1024/512/256, 灰色も
  // 枠を消費)」で選抜されるため、帯の先頭に居るプレイヤーは Lv 昇格を伴わないと
  // 総合順位が動かない。ここでは cohort(n) を「現在の判定 Lv >= n のプレイヤー
  // (+自分)」で近似し、他人のスコアは固定のまま自分の bt/tjpr だけ動かして
  //   1) 現 Lv 以上の各段で自分の raw ens rank (灰色込み) を計算し、
  //      「現在スコアでは枠外 (rank0 > N) だった段の枠を跨いだ」場合のみ昇格
  //      (エクスポート済み tjpr_score は各自の判定 Lv での集計値のため、
  //       現 Lv より下の段の閾値判定は再現できない。降格も非モデル化)
  //   2) 到達 Lv 帯の中で表示順位を数える
  // という手順で raw 順位を出す。エンジンでは自分が誰かを追い抜くと相手側の
  // rank も 1 悪化するため、同帯の各相手の ens には「自分が上に居る分
  // (+0.5×2系列)」を都度加算して比較する。絶対値には cohort 境界の誤差が
  // 乗るため、呼び出し側で現在順位にアンカーして差分適用すること。
  // others: [{lv, tj, bt, gray, uid}] (自分を除く) / self: {lv, uid, tj, bt}
  var LV_TOPN = { 2: 2048, 3: 1024, 4: 512, 5: 256 };  // Lv(n) cohort = 前Lv上位N
  function createEnsemblePredictor(others, self) {
    var myUid = self.uid;
    var myLv = Math.max(1, Math.min(5, self.lv || 1));
    function cmp(a, b) { return b.v - a.v || a.uid - b.uid; }
    // 自分の現 Lv 以上の各段 n の cohort (lv >= n) データ
    var L = {};
    for (var n = myLv; n <= 5; n++) L[n] = { btPairs: [], tjPairs: [], higher: 0 };
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      for (var m = myLv; m <= 5; m++) {
        if (o.lv > m && !o.gray) L[m].higher++;
        if (o.lv >= m) {
          L[m].btPairs.push({ v: o.bt, uid: o.uid });
          L[m].tjPairs.push({ v: o.tj, uid: o.uid });
        }
      }
    }
    // (v desc, uid asc) 順に並べた cohort 内での順位 (エンジンの tie-break と同一)
    function rankOf(pairs, v, uid) {
      var lo = 0, hi = pairs.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        var p = pairs[mid];
        if (p.v > v || (p.v === v && p.uid < uid)) lo = mid + 1; else hi = mid;
      }
      return lo + 1;
    }
    for (var n2 = myLv; n2 <= 5; n2++) {
      var c = L[n2];
      c.btPairs.sort(cmp);
      c.tjPairs.sort(cmp);
      // cohort(n) 内の「他人全員」(lv>=n, 灰色込み) の base ens。
      // ensList (昇順) = 昇格枠の消費判定用 / sameBase (lv==n 非灰色) = 帯内順位カウント用
      c.sameBase = [];
      var full = [];
      for (var j = 0; j < others.length; j++) {
        var o2 = others[j];
        if (o2.lv < n2) continue;
        var e = (rankOf(c.btPairs, o2.bt, o2.uid) + rankOf(c.tjPairs, o2.tj, o2.uid)) / 2;
        full.push({ ens: e, uid: o2.uid });
        if (o2.lv === n2 && !o2.gray) {
          c.sameBase.push({ ens: e, bt: o2.bt, tj: o2.tj, uid: o2.uid });
        }
      }
      full.sort(function (a, b) { return a.ens - b.ens || a.uid - b.uid; });
      c.ensList = full;
    }
    function myEnsAt(n, tj, bt) {
      return (rankOf(L[n].btPairs, bt, myUid) + rankOf(L[n].tjPairs, tj, myUid)) / 2;
    }
    // cohort(n) 内での自分の raw rank (灰色込み、昇格枠の判定用)
    function rawRankAt(n, tj, bt) {
      var myEns = myEnsAt(n, tj, bt);
      var list = L[n].ensList;
      var lo = 0, hi = list.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        var p = list[mid];
        if (p.ens < myEns || (p.ens === myEns && p.uid < myUid)) lo = mid + 1; else hi = mid;
      }
      return lo + 1;
    }
    // 現在スコアでの各段の raw rank (昇格の「枠跨ぎ」判定の基準)
    var rank0 = {};
    for (var n3 = myLv; n3 < 5; n3++) rank0[n3] = rawRankAt(n3, self.tj, self.bt);
    // このスコアで到達する Lv: 現在は枠外だった段の枠 (上位N) を実際に跨いだ時のみ昇格
    function bandAt(tj, bt) {
      var n = myLv;
      while (n < 5 && rank0[n] > LV_TOPN[n + 1] && rawRankAt(n, tj, bt) <= LV_TOPN[n + 1]) n++;
      return n;
    }
    return {
      // このスコアで到達する Lv (昇格モデル適用後)。現在スコアでは self.lv を返す
      predictLv: function (tj, bt) { return bandAt(tj, bt); },
      predictRaw: function (tj, bt) {
        var eLv = bandAt(tj, bt);
        var c = L[eLv];
        var myEns = myEnsAt(eLv, tj, bt);
        var above = 0;
        for (var k = 0; k < c.sameBase.length; k++) {
          var s = c.sameBase[k];
          var sEns = s.ens +
            ((bt > s.bt || (bt === s.bt && myUid < s.uid)) ? 0.5 : 0) +
            ((tj > s.tj || (tj === s.tj && myUid < s.uid)) ? 0.5 : 0);
          if (sEns < myEns || (sEns === myEns && s.uid < myUid)) above++;
        }
        return c.higher + above + 1;
      },
    };
  }

  // ---- 暫定順位 (jp-counter 簡約) ------------------------------------------
  // sortedScores: 降順ソート済み [{score, gray, uid?}]。newScore の非グレー暫定順位。
  // エンジンのタイブレーク (-score, uid 昇順) に合わせ、同点は uid の小さい方を上位にする。
  function provisionalRank(sortedScores, newScore, selfUid) {
    var jp = 0;
    for (var i = 0; i < sortedScores.length; i++) {
      var it = sortedScores[i];
      if (it.score < newScore) break;
      if (it.gray) continue;
      if (it.score > newScore ||
          (selfUid != null && it.uid != null && it.uid < selfUid)) jp += 1;
    }
    return jp + 1;
  }

  return {
    ELO_PER_UNIT: ELO_PER_UNIT,
    ELO_PER_UNIT_DISP: ELO_PER_UNIT_DISP,
    TJPR_ELO_SCALE: TJPR_ELO_SCALE,
    TJPR_DEFAULT_RATE: TJPR_DEFAULT_RATE,
    DECAY_R: DECAY_R,
    G2Player: G2Player,
    applyInactivity: applyInactivity,
    placementToTier: placementToTier,
    tierBestPlace: tierBestPlace,
    buildDeLosersRounds: buildDeLosersRounds,
    buildBanzuke: buildBanzuke,
    tjprRawForPlace: tjprRawForPlace,
    aggregateEntries: aggregateEntries,
    extractEntries: extractEntries,
    tournamentPassesLv: tournamentPassesLv,
    peakAt: peakAt,
    provisionalRank: provisionalRank,
    createEnsemblePredictor: createEnsemblePredictor,
    LV_PARAMS: LV_PARAMS,
    LV_FILTERS: LV_FILTERS,
  };
});
