// bracket_core.js — トーナメントプレビューの純粋計算コア (DOM / fetch 非依存)。
//   - フェーズごとのプール割り (スネーク) とプール内勝者側ブラケットの構造を作る。
//   - スネーク/スロット順は seed_optimizer.js の検証済みプリミティブをそのまま使う。
//   - 進出予測は「シード通り (小さいシードが勝つ)」前提。次フェーズは進出者を
//     全体シード順で再スネーク (= start.gg 自動進出の期待強度順と等価。
//     docs/seed_preview_design.md §3 で実データ検証済み)。

(function (global) {
  'use strict';

  const O = (typeof module !== 'undefined' && module.exports)
    ? require('../seeding/seed_optimizer.js')
    : global.SeedOptimizer;

  // フェーズ参加者 Nf 人をプール P 個へスネーク割り。
  // 返り値: pools[poolIdx] = [globalIdx...] (0始まり。昇順 = プール内シード順)。
  function phasePools(Nf, P) {
    const pools = Array.from({ length: P }, () => []);
    for (let i = 0; i < Nf; i++) pools[O.poolOfSeed(i, P)].push(i);
    return pools;
  }

  // プール内 (ローカルシード 1..M) の勝者側ブラケット構造。
  // 返り値: { B, rounds: [[{a,b,w}...]] }。a/b はローカルシード or null (bye)、
  // w = 勝者予測 (小さいシード)。rounds[0] が1回戦。
  function poolRounds(M) {
    if (M < 1) return { B: 0, rounds: [] };
    const B = O.nextPow2(Math.max(2, M));
    const order = O.seedSlotOrder(B);
    let cur = order.map((s) => (s <= M ? s : null));
    const rounds = [];
    while (cur.length > 1) {
      const matches = [];
      const next = [];
      for (let m = 0; m < cur.length; m += 2) {
        const a = cur[m], b = cur[m + 1];
        const w = (a == null) ? b : (b == null) ? a : Math.min(a, b);
        matches.push({ a, b, w });
        next.push(w);
      }
      rounds.push(matches);
      cur = next;
    }
    return { B, rounds };
  }

  // ダブルイリミネーション一式: 勝者側 + 敗者側 + グランドファイナル。
  // 敗者側は minor/major 交互の標準構造。ドロップ (WRj 敗者の並び替え) は
  // start.gg の実ブラケット (prereq グラフ) から解読した規則:
  //   落ちる先の敗者側ラウンド番号 L(2j) 基準で
  //   L4 = 全反転 / L6 = 半分ごとに反転 / L8 = 半分入替 / L10 以降 = そのまま。
  // スマパ#241 (64人フルDE)・新京都DSW#64 (28人)・渋谷達#136 (24人) の全ラウンド一致で
  // 検証済み (敗者側直入りのカスタム構成でも同じラウンド番号規則だった)。
  // L10 以降が大人数になる超大型 (B=256 級) の深部は実例が無く「そのまま」と仮定。
  // adv = そのプールから進出する人数 (予選プール)。渡すと**進出者が確定した時点で
  // 打ち切る** (2人抜けのプールに GF は無い、等)。省略 / 0 / M 以上 = 優勝まで (最終フェーズ)。
  // 返り値: { B, winners:[[{a,b,w,l}...]], losers:[[{a,b,w,l,drop}...]], gf:{a,b,w}|null,
  //           wTotal, lTotal, cut, advancers:[ローカルシード]|null }
  //   a/b/w/l はローカルシード or null (bye)。drop = そのラウンドの b 側が
  //   勝者側 WR何回戦 の敗者か (major ラウンドのみ。表示バッジ用)。
  //   wTotal/lTotal = 打ち切り前のラウンド数 (「決勝」等の表示名を変えないため)。
  function poolDoubleElim(M, adv) {
    if (M < 2) return truncateForAdvance({ B: M < 1 ? 0 : 2, winners: poolRounds(M).rounds, losers: [], gf: null }, M, adv);
    const base = poolRounds(M);
    const B = base.B;
    // 勝者側に敗者 (l) を付与
    const winners = base.rounds.map((matches) => matches.map((m) => ({
      a: m.a, b: m.b, w: m.w,
      l: (m.a != null && m.b != null) ? Math.max(m.a, m.b) : null,
    })));
    const k = winners.length;              // WR 数 = log2(B)
    if (B === 2) {
      // 2人ブラケット: 敗者側なし。GF = 決勝の再戦相当は表示しない (winners のみ)
      return truncateForAdvance(
        { B, winners, gf: { a: winners[0][0].w, b: winners[0][0].l, w: winners[0][0].w }, losers: [] }, M, adv);
    }
    const losers = [];
    // L1 (minor): WR1 敗者を隣接ペアで
    let cur = [];
    {
      const l1src = winners[0].map((m) => m.l);
      const round = [];
      for (let i = 0; i < l1src.length; i += 2) {
        const a = l1src[i], b = l1src[i + 1];
        const w = (a == null) ? b : (b == null) ? a : Math.min(a, b);
        round.push({ a, b, w, l: (a != null && b != null) ? Math.max(a, b) : null });
        cur.push(w);
      }
      losers.push(round);
    }
    // 以降 j=2..k: major (WRj 敗者ドロップ, 1:1) → minor (ペア) …最後は major で終わる
    for (let j = 2; j <= k; j++) {
      let drops = winners[j - 1].map((m) => m.l);
      const n = drops.length;
      // 落ちる先 = L(2j)。j=2:全反転 / j=3:半分ごと反転 / j=4:半分入替 / j>=5:そのまま
      if (j === 2) {
        drops = drops.slice().reverse();
      } else if (j === 3 && n > 1) {
        const h = n / 2;
        drops = drops.slice(0, h).reverse().concat(drops.slice(h).reverse());
      } else if (j === 4 && n > 1) {
        const h = n / 2;
        drops = drops.slice(h).concat(drops.slice(0, h));
      }
      const major = [];
      const next = [];
      for (let i = 0; i < cur.length; i++) {
        const a = cur[i], b = drops[i];
        const w = (a == null) ? b : (b == null) ? a : Math.min(a, b);
        major.push({ a, b, w, l: (a != null && b != null) ? Math.max(a, b) : null, drop: j });
        next.push(w);
      }
      losers.push(major);
      cur = next;
      if (cur.length > 1) {                 // minor でペア
        const minor = [];
        const nn = [];
        for (let i = 0; i < cur.length; i += 2) {
          const a = cur[i], b = cur[i + 1];
          const w = (a == null) ? b : (b == null) ? a : Math.min(a, b);
          minor.push({ a, b, w, l: (a != null && b != null) ? Math.max(a, b) : null });
          nn.push(w);
        }
        losers.push(minor);
        cur = nn;
      }
    }
    const wbChamp = winners[k - 1][0].w;
    const lbChamp = cur[0];
    const gf = { a: wbChamp, b: lbChamp, w: (wbChamp == null) ? lbChamp : (lbChamp == null) ? wbChamp : Math.min(wbChamp, lbChamp) };
    return truncateForAdvance({ B, winners, losers, gf }, M, adv);
  }

  // 実施順に並べたラウンド列。W1 → L1 → W2 → L(major) → L(minor) → W3 → … → GF。
  // major = 勝者側から敗者が落ちてくるラウンド (drop 付き)、minor = 敗者側どうし。
  function playOrder(de) {
    const seq = [];
    if (!de.winners.length) return seq;
    seq.push({ k: 'W', i: 0 });
    let li = 0;
    if (de.losers.length) seq.push({ k: 'L', i: li++ });        // L1 (WR1 敗者)
    for (let j = 1; j < de.winners.length; j++) {
      seq.push({ k: 'W', i: j });
      if (li < de.losers.length) seq.push({ k: 'L', i: li++ });  // WR(j+1) 敗者が落ちる major
      const nxt = de.losers[li];
      if (nxt && !(nxt[0] && nxt[0].drop)) seq.push({ k: 'L', i: li++ });   // 続く minor
    }
    if (de.gf) seq.push({ k: 'G' });
    return seq;
  }

  // 進出 adv 人が決まった時点でラウンドを打ち切る。
  // 脱落するのは敗者側 (と GF) の試合だけなので、実施順に脱落数を積んで
  // 残り人数が adv 以下になったラウンドまでを残す。bye の試合は誰も落とさない。
  function truncateForAdvance(de, M, adv) {
    const out = Object.assign({}, de, {
      wTotal: de.winners.length, lTotal: de.losers.length, cut: false, advancers: null,
    });
    if (!(adv > 0) || !(M > adv)) return out;
    const elimOf = (round) => round.reduce((n, m) => n + ((m.a != null && m.b != null) ? 1 : 0), 0);
    const seq = playOrder(de);
    let remain = M, keepW = 0, keepL = 0, keepGf = false, cutAt = seq.length;
    for (let s = 0; s < seq.length; s++) {
      const step = seq[s];
      if (step.k === 'W') { keepW = step.i + 1; continue; }      // 勝者側では誰も落ちない
      if (step.k === 'L') { keepL = step.i + 1; remain -= elimOf(de.losers[step.i]); }
      else { keepGf = true; remain -= 1; }
      if (remain <= adv) { cutAt = s; break; }
    }
    // 進出が決まった後も、次に脱落者が出るまでの勝者側ラウンドは実施される
    // (誰も落とさないが順位を決めるため)。実ブラケット (りぷぶらSP15 予選 11人6抜け /
    // 篝火15 Phase1 21人 : 勝者側が1ラウンド分先まで進む) と一致させるための扱い。
    for (let s = cutAt + 1; s < seq.length && seq[s].k === 'W'; s++) keepW = seq[s].i + 1;
    if (keepW === de.winners.length && keepL === de.losers.length && keepGf) return out;
    const elim = new Set();
    for (let i = 0; i < keepL; i++) {
      for (const m of de.losers[i]) if (m.a != null && m.b != null && m.l != null) elim.add(m.l);
    }
    if (keepGf && de.gf && de.gf.a != null && de.gf.b != null) {
      elim.add(de.gf.a === de.gf.w ? de.gf.b : de.gf.a);
    }
    const advancers = [];
    for (let s = 1; s <= M; s++) if (!elim.has(s)) advancers.push(s);
    out.winners = de.winners.slice(0, keepW);
    out.losers = de.losers.slice(0, keepL);
    out.gf = keepGf ? de.gf : null;
    out.cut = true;
    out.advancers = advancers;
    return out;
  }

  // 実際に発生する予測マッチアップ (bye を除く)。[{r, a, b}] (r は 1始まり、a < b)。
  function poolMatchups(roundsObj) {
    const out = [];
    roundsObj.rounds.forEach((matches, ri) => {
      for (const m of matches) {
        if (m.a != null && m.b != null) out.push({ r: ri + 1, a: Math.min(m.a, m.b), b: Math.max(m.a, m.b) });
      }
    });
    return out;
  }

  // ラウンド表示名。総ラウンド数 R のうち r (1始まり)。
  function roundName(r, R) {
    if (r === R) return '決勝';
    if (r === R - 1) return '準決勝';
    return r + '回戦';
  }

  // 経過日数の簡易表示。
  function fmtRelDays(days) {
    if (days == null || !(days >= 0)) return '';
    if (days === 0) return '今日';
    if (days < 7) return days + '日前';
    if (days < 30) return Math.floor(days / 7) + '週間前';
    if (days < 365) return Math.floor(days / 30.4) + 'ヶ月前';
    return (days / 365).toFixed(1).replace(/\.0$/, '') + '年前';
  }

  // 敗者側ラウンド表示名 (idx は 0始まり、total = losers.length)。
  function lbRoundName(idx, total) {
    if (idx === total - 1) return '敗者側決勝';
    if (idx === total - 2) return '敗者側準決勝';
    return '敗者側' + (idx + 1) + '回戦';
  }

  const API = { phasePools, poolRounds, poolDoubleElim, poolMatchups, playOrder, roundName, lbRoundName, fmtRelDays };
  global.BracketCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
