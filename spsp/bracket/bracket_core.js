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
  // 返り値: { B, winners:[[{a,b,w,l}...]], losers:[[{a,b,w,l,drop}...]], gf:{a,b,w}|null }
  //   a/b/w/l はローカルシード or null (bye)。drop = そのラウンドの b 側が
  //   勝者側 WR何回戦 の敗者か (major ラウンドのみ。表示バッジ用)。
  function poolDoubleElim(M) {
    if (M < 2) return { B: M < 1 ? 0 : 2, winners: poolRounds(M).rounds, losers: [], gf: null };
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
      return { B, winners, gf: { a: winners[0][0].w, b: winners[0][0].l, w: winners[0][0].w }, losers: [] };
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
    return { B, winners, losers, gf };
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

  const API = { phasePools, poolRounds, poolDoubleElim, poolMatchups, roundName, lbRoundName, fmtRelDays };
  global.BracketCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
