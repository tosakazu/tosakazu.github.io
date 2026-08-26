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
  // lbStart = 敗者側スタートの人数 (下位シードから)。トップカット等で
  // 「予選1位は勝者側、2位以下は敗者側から」という構成を再現する。
  function poolDoubleElim(M, adv, lbStart) {
    const d = Math.max(0, Math.min(lbStart | 0, Math.max(0, M - 2)));
    if (d > 0) return truncateForAdvance(splitStartDoubleElim(M, d), M, adv);
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
      cur = pushMajorMinor(losers, cur, winners[j - 1].map((m) => m.l), j, j);
    }
    const wbChamp = winners[k - 1][0].w;
    const lbChamp = cur[0];
    const gf = { a: wbChamp, b: lbChamp, w: (wbChamp == null) ? lbChamp : (lbChamp == null) ? wbChamp : Math.min(wbChamp, lbChamp) };
    return truncateForAdvance({ B, winners, losers, gf }, M, adv);
  }

  function mkMatch(a, b, extra) {
    const w = (a == null) ? b : (b == null) ? a : Math.min(a, b);
    return Object.assign({ a, b, w, l: (a != null && b != null) ? Math.max(a, b) : null }, extra || null);
  }

  // WRj 敗者の並び替え (落ちる先の敗者側ラウンド番号基準の規則)。
  function permuteDrops(drops, j) {
    const n = drops.length;
    if (j === 2) return drops.slice().reverse();
    if (n <= 1) return drops;
    const h = n / 2;
    if (j === 3) return drops.slice(0, h).reverse().concat(drops.slice(h).reverse());
    if (j === 4) return drops.slice(h).concat(drops.slice(0, h));
    return drops;
  }

  // major (勝者側 WRj の敗者が 1:1 で落ちてくる) → minor (敗者側どうしのペア) を積む。
  // 返り値 = minor 後の生存者列。
  function pushMajorMinor(losers, cur, dropsRaw, wRound, permKey) {
    const drops = permuteDrops(dropsRaw, permKey);
    const major = [], next = [];
    for (let i = 0; i < cur.length; i++) {
      const m = mkMatch(cur[i], drops[i], { drop: wRound });
      major.push(m); next.push(m.w);
    }
    losers.push(major);
    cur = next;
    if (cur.length > 1) {
      const minor = [], nn = [];
      for (let i = 0; i < cur.length; i += 2) {
        const m = mkMatch(cur[i], cur[i + 1]);
        minor.push(m); nn.push(m.w);
      }
      losers.push(minor);
      cur = nn;
    }
    return cur;
  }

  // ── 敗者側スタートありのプール (トップカット等) ────────────────
  // 上位 w = M-d 人が勝者側、下位 d 人が敗者側から始まる構成。
  // 敗者側直入り d 人は **上位半分 A × 下位半分 B** で必ず当たる
  // (start.gg 実プール 74 件中 72 件で成立)。A[i] の相手 = B[perm(i)]。
  //
  // perm は「n (= d/2) と target (= 勝者側 WR1 の敗者数)」で変わり、
  // 同じ形でも大会によって食い違う場合がある (規則としては閉じていない)。
  // ここでは **篝火 / ウメブラ 系の実ブラケットで観測した並び**を採用する
  // (LB_ENTRY_PERM。括弧内は観測ソース)。表に無い形は XOR 系フォールバック。
  //
  // 観測済みの並びはすべて **perm(i) = i XOR mask** で表せる (2026-08-20 解析):
  //   D/target = 2 (直入りが枠のちょうど半分) → mask = n-2 (2つ組の反転)
  //   D/target = 4                            → mask = 交互ビット (bit k-2, k-4, … ≥0)
  //     '16:8'=5(0101) / '32:16'=10(01010) / '64:32'=21(10101) と系列が続く。
  const LB_ENTRY_PERM = {
    '4:2': [1, 0, 3, 2],                                                // 勝4+敗8 (風雲#2 実測)
    '4:4': [3, 2, 1, 0],                                                // 勝8+敗8 (ウメブラSP10 TOP16。
                                                                        //   ユニブラ#8 は [1,0,3,2] で食い違う)
    '8:4': [2, 3, 0, 1, 6, 7, 4, 5],                                    // 勝8+敗16 (ウメブラSP4/SP5 Round2 計6。
                                                                        //   SP10 R3/Top24 は別配列で食い違う)
    '8:8': [6, 7, 4, 5, 2, 3, 0, 1],                                    // 勝16+敗16 (篝火3/他1)
    '16:8': [5, 4, 7, 6, 1, 0, 3, 2, 13, 12, 15, 14, 9, 8, 11, 10],     // 勝16+敗32 (篝火2/ウメブラ7)
    '16:16': [14, 15, 12, 13, 10, 11, 8, 9, 6, 7, 4, 5, 2, 3, 0, 1],    // 勝32+敗32 (ウメブラ/西武撃/アブスマ。
                                                                        //   篝火 は全反転で食い違うため
                                                                        //   8:8 と同じ「2つ組の反転」を採る)
    '32:16': [10, 11, 8, 9, 14, 15, 12, 13, 2, 3, 0, 1, 6, 7, 4, 5,     // 勝32+敗64 (篝火10)
      26, 27, 24, 25, 30, 31, 28, 29, 18, 19, 16, 17, 22, 23, 20, 21],
    // 勝64+敗128 (グランドスラム19 ベスト192 実測 = i XOR 21)。192人本戦で使われる。
    '64:32': Array.from({ length: 64 }, (_, i) => i ^ 21),
  };

  // 交互ビットマスク: bit k-2, k-4, … (≥0)。5, 10, 21, 42, … の系列。
  function _altMask(k) {
    let m = 0;
    for (let b = k - 2; b >= 0; b -= 2) m |= (1 << b);
    return m;
  }

  function permLbEntry(i, n, target) {
    const tbl = LB_ENTRY_PERM[n + ':' + target];
    if (tbl && tbl.length === n) return tbl[i];
    // 表に無い形: 観測済みの並びを説明する XOR 系列で補間する。
    //   D/target == 2 → 2つ組の反転 (n-2)。小さい n は実測に合わせ全反転寄り。
    //   それ以外 (≥4) → 交互ビットマスク ('8:4'=2 は旧フォールバックとも同値)。
    const ratio = (2 * n) / Math.max(1, target);
    let mask;
    if (ratio === 2) mask = n >= 8 ? n - 2 : (n === 4 ? 3 : 1);
    else mask = _altMask(Math.max(2, Math.round(Math.log2(n))));
    const j = i ^ mask;
    return j < n ? j : i;
  }

  // 敗者側直入り d 人を、最初の敗者側ラウンドのスロット列にする。
  // target = 勝者側 WR1 の敗者数 (= Bw/2)。d が target 以下ならそのまま並べる。
  function lbEntrySlots(w, d, target) {
    if (d <= target) {
      const out = [];
      for (let i = 0; i < target; i++) out.push(i < d ? w + 1 + i : null);
      return out;
    }
    let D = target;
    while (D < d) D *= 2;
    const n = D / 2;
    const seed = (i) => (i < d ? w + 1 + i : null);
    const slots = [];
    for (let i = 0; i < n; i++) {
      slots.push(seed(i));                       // A = 直入り勢の上位半分
      slots.push(seed(n + permLbEntry(i, n, target)));   // B = 下位半分 (規則で並べ替え)
    }
    return slots;
  }

  // 直入りペアの並びが「実測テーブル由来」か「XOR 系列による推定」かを返す。
  // 推定の場合は UI 側で明示する (黙って劣化させない方針)。
  function lbEntryObserved(w, d) {
    const Bw = nextPow2Safe(w);
    const target = Math.max(1, Bw / 2);
    if (d <= target) return true;   // ペア無し (そのまま埋めるだけ) = 推定要素なし
    let D = target;
    while (D < d) D *= 2;
    const n = D / 2;
    const tbl = LB_ENTRY_PERM[n + ':' + target];
    return !!(tbl && tbl.length === n);
  }

  function nextPow2Safe(w) {
    return Math.pow(2, Math.ceil(Math.log2(Math.max(2, w))));
  }

  function splitStartDoubleElim(M, d) {
    const w = M - d;
    const base = poolRounds(w);
    const Bw = base.B;
    const winners = base.rounds.map((ms) => ms.map((m) => mkMatch(m.a, m.b)));
    const k = winners.length;
    const target = Math.max(1, Bw / 2);
    const losers = [];
    let cur = lbEntrySlots(w, d, target);
    while (cur.length > target) {          // 直入り勢だけで戦う前半ラウンド
      const round = [], next = [];
      for (let i = 0; i < cur.length; i += 2) {
        const m = mkMatch(cur[i], cur[i + 1]);
        round.push(m); next.push(m.w);
      }
      losers.push(round);
      cur = next;
    }
    // 以降は標準と同じ major → minor の交互。WR1 の敗者から合流する。
    for (let j = 1; j <= k; j++) {
      // 合流1回目 (WR1 の敗者) を標準構成の j=2 相当として扱う
      cur = pushMajorMinor(losers, cur, winners[j - 1].map((m) => m.l), j, j + 1);
    }
    return {
      B: Bw, winners, losers, lbStart: d, gf: mkMatch(winners[k - 1][0].w, cur[0]),
      // 直入りペアが実測テーブルに無い形なら true (UI が「推定」と明示する)
      lbEntryEstimated: !lbEntryObserved(w, d),
    };
  }

  // 実施順に並べたラウンド列。W1 → L1 → W2 → L(major) → L(minor) → W3 → … → GF。
  // major = 勝者側から敗者が落ちてくるラウンド (drop 付き)、minor = 敗者側どうし。
  // 敗者側スタートありの構成では、直入り勢だけの前半ラウンドが勝者側より先に来る。
  function playOrder(de) {
    const seq = [];
    if (!de.winners.length) return seq;
    let wNext = 0;
    const emitW = (upto) => {
      while (wNext < upto && wNext < de.winners.length) seq.push({ k: 'W', i: wNext++ });
    };
    if (!de.lbStart) emitW(1);           // 標準構成: L1 は WR1 の敗者なので WR1 が先
    de.losers.forEach((round, i) => {
      const drop = round[0] && round[0].drop;
      if (drop) emitW(drop);             // その major に必要な勝者側ラウンドまで進める
      seq.push({ k: 'L', i });
    });
    emitW(de.winners.length);
    if (de.gf) seq.push({ k: 'G' });
    return seq;
  }

  // 進出 adv 人が決まった時点でラウンドを打ち切る。
  // 脱落するのは敗者側 (と GF) の試合だけなので、実施順に脱落数を積んで
  // 残り人数が adv 以下になったラウンドまでを残す。bye の試合は誰も落とさない。
  function truncateForAdvance(de, M, adv) {
    const out = Object.assign({}, de, {
      wTotal: de.winners.length, lTotal: de.losers.length, cut: false, advancers: null, undefeated: null,
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
    // minor (敗者側どうし) で打ち切った場合だけ、続く勝者側ラウンドも実施される。
    // 次のドロップを供給する勝者側ラウンドは既に走っているため。major で打ち切った
    // ときは供給済みなので勝者側も止まる。実ブラケット4件と一致する扱い:
    //   minor で終わる例: りぷぶらSP15 予選 (11人6抜け) / 篝火15 Phase1 A100 (21人12抜け)
    //   major で終わる例: りぷぶらSP15 Aクラス (48人8抜け) / 篝火15 Phase2 D100 (24人3抜け)
    const cutStep = seq[cutAt];
    const cutMinor = cutStep && cutStep.k === 'L' &&
      !(de.losers[cutStep.i][0] && de.losers[cutStep.i][0].drop);
    if (cutMinor) {
      for (let s = cutAt + 1; s < seq.length && seq[s].k === 'W'; s++) keepW = seq[s].i + 1;
    }
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
    // 通過者のうち「無敗のまま」通過した人 = 次フェーズを勝者側から始める人。
    // 敗者側スタート勢は 1 敗の扱いなので、ここには入らない。
    const lost = new Set(lbStart(de));
    const rounds = de.winners.slice(0, keepW).concat(de.losers.slice(0, keepL));
    for (const r of rounds) for (const m of r) if (m.a != null && m.b != null && m.l != null) lost.add(m.l);
    if (keepGf && de.gf && de.gf.a != null && de.gf.b != null) {
      lost.add(de.gf.a === de.gf.w ? de.gf.b : de.gf.a);
    }
    out.winners = de.winners.slice(0, keepW);
    out.losers = de.losers.slice(0, keepL);
    out.gf = keepGf ? de.gf : null;
    out.cut = true;
    out.advancers = advancers;
    out.undefeated = advancers.filter((s) => !lost.has(s));
    return out;
  }

  // 敗者側スタート勢のローカルシード列 (= 最初から 1 敗相当の扱い)。
  function lbStart(de) {
    const out = [];
    if (!de.lbStart) return out;
    for (const m of de.losers[0] || []) { if (m.a != null) out.push(m.a); if (m.b != null) out.push(m.b); }
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

  const API = { phasePools, poolRounds, poolDoubleElim, poolMatchups, playOrder, roundName, lbRoundName, fmtRelDays, lbEntryObserved };
  global.BracketCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
