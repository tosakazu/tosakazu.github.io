// seed_optimizer.js — シード被り回避の純粋計算コア。
//   - fetch / DOM / start.gg に一切依存しない（Web Worker 内・Node テストの両方で動く）。
//   - 入力: ランキング(シード順) + 事前構築済みデータ(都道府県・ペア直近対戦罰則)。
//   - 出力: 最適化済みシード順 + プール + プール内ブラケット + レポート。
// 設計: docs/seed_collision_avoidance.md
//
// 重要な統一: inter/intra 双方を「グローバルシード列の置換」に帰着する。
//   - poolOfSeed(i,P)/rowOfSeed(i,P) は start.gg 標準 serpentine（実データで確定）。
//   - inter swap = 同一 row の2シード交換（プール変更・プール内順位は不変）。
//   - intra swap = 同一 pool の2シード交換（プール不変・プール内順位=row 変更）。

(function (global) {
  'use strict';

  // ───────────────────────── 乱数（決定的・テスト可能） ─────────────────────────
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randInt(rng, n) { return Math.floor(rng() * n); }

  // ───────────────────────── snake / bracket 形状 ─────────────────────────
  // s: 0始まりグローバルシード index。P: プール数。返り値は 0始まりプール番号。
  function poolOfSeed(s, P) {
    const row = Math.floor(s / P);
    const col = s % P;
    return (row % 2 === 0) ? col : (P - 1 - col);
  }
  function rowOfSeed(s, P) { return Math.floor(s / P); }

  // 標準シードのスロット順。bracket サイズ B(=2^k) に対し seedAtSlot[slot]=seed(1始まり)。
  // seedSlotOrder(4)=[1,4,2,3], seedSlotOrder(8)=[1,8,4,5,2,7,3,6]。
  function seedSlotOrder(B) {
    let order = [1];
    while (order.length < B) {
      const n = order.length * 2;
      const next = [];
      for (const s of order) { next.push(s); next.push(n + 1 - s); }
      order = next;
    }
    return order;
  }
  function nextPow2(n) { let b = 1; while (b < n) b *= 2; return b; }

  // seed(1始まり) → slot(0始まり) の写像（bracket サイズ B）。
  function slotOfSeedMap(B) {
    const order = seedSlotOrder(B);
    const map = new Array(B + 1);
    for (let slot = 0; slot < B; slot++) map[order[slot]] = slot;
    return map;
  }

  // 2 スロットが当たりうる最早回戦（1=1回戦）。round = min{t: ⌊p/2^t⌋==⌊q/2^t⌋}。
  function earliestMeetRound(p, q) {
    let t = 1;
    while ((p >> t) !== (q >> t)) t++;
    return t;
  }

  // シード s(1始まり) のダブルイリミネーション想定順位 (= 全試合シードどおりに
  // 決まった場合の最終順位)。1,2,3,4 の後はタイ帯 5,5 / 7,7 / 9×4 / 13×4 /
  // 17×8 / 25×8 / 33×16 … (帯幅は2段ごとに倍) で並ぶ。
  function dePlaceOfSeed(seed1) {
    if (seed1 <= 4) return seed1;
    let start = 5, size = 2, step = 0;
    while (seed1 >= start + size) {
      start += size;
      step++;
      if (step % 2 === 0) size *= 2;
    }
    return start;
  }

  // ───────────────────────── デフォルトパラメータ ─────────────────────────
  const DEFAULT_PARAMS = {
    // 罰則のオンオフ（UI トグル対応）。false で該当罰則を完全に無効化する。
    avoidRegion: true,                   // 地域被り（同一都道府県/地域）を避けるか
    avoidRecent: true,                   // 直近の再対戦を避けるか
    enableIntra: true,                   // プール内変動（intra 最適化）を行うか（P>=2 のときのみ有効）
    W_region: 1.0,
    W_recent: 0.3,                       // 直近対戦の重み（W_region との大小は自由）
    W_order: 0.001,                      // 元ランキングからのシードズレ罰則(タイブレーカー級, 分離は不悪化)。0で無効
    orderPow: 2,                         // ズレ罰則の指数（1=線形, 2=2乗で大きなズレを強く罰）。既定2=大移動を選択的に抑制
    prefWeight: 'inv_sqrt',              // 県別出場人数 count → 重み（人数が少ない県ほど大きい）
    roundWeights: [1.0, 0.6, 0.4, 0.06, 0.02], // R1..; 超過は末尾を使用（R3を強めて3回戦被りを回避）
    reportRecentMaxDays: 182.5,          // レポートに載せる直近対戦の最大経過日数（半年）。スコアには無関係
    // 可動制約（初期順位基準）。null ならデフォルト式。
    kInter: null,   // (row1based) -> 動けるプール数。default: 1,2位=0固定 / 3位以降 2^(row-3)
    kIntra: null,   // (rank1based, M) -> 動ける順位数。default: 上位1/4=0固定 / 残り±1
    // 最終シード番号が元順位から動ける最大数（inter/intra 合成後）。null=無制限。
    // k_inter/k_intra はプール/順位単位で snake 番号上は最大 2P-1 動き得るため、
    // 「シード番号でどれだけ動いたか」を直接キャップしたいときに使う。
    maxSeedShift: null,
    // true なら DE 想定順位 (dePlaceOfSeed: 1,2,3,4,5,5,7,7,9×4,…) が全員
    // 元シードから不変になる範囲でのみ入れ替える（同タイ帯内の移動のみ許可）。
    keepDePlace: false,
    // 探索
    mode: 'multistart-sa',               // 'hillclimb'|'sa'|'multistart-hillclimb'|'multistart-sa'
    restarts: 15,
    maxIters: null,                      // null なら状態サイズ×maxItersScale
    maxItersScale: 1000,                 // maxIters = max(500, stateSize*scale)。既定=参加人数×1000
    saT0: null,                          // null なら自動推定
    saCooling: 0.999,
    saMinT: 1e-4,
    rngSeed: 12345,
  };

  // モード別の既定（ベンチで調整）。input.params が明示した値が最優先、無ければここ、無ければ DEFAULT_PARAMS。
  // 多点系は restarts/scale を上げて分離精度を優先（~10-20s。実大会ベンチで R1-3 を大幅削減）。
  const MODE_DEFAULTS = {
    'hillclimb':            { restarts: 1, maxItersScale: 1500 },           // 単発: 反復多め
    'sa':                   { restarts: 1, saCooling: 0.999, maxItersScale: 1000 },
    'multistart-hillclimb': { restarts: 15, maxItersScale: 1000 },
    'multistart-sa':        { restarts: 15, saCooling: 0.999, maxItersScale: 1000 },
  };

  function prefWeightFn(kind) {
    switch (kind) {
      case 'inv': return (c) => 1 / c;
      case 'inv_log': return (c) => 1 / Math.log2(1 + c);
      case 'const': return () => 1;
      case 'inv_sqrt':
      default: return (c) => 1 / Math.sqrt(c);
    }
  }

  function pairKey(a, b) { return a < b ? a + ':' + b : b + ':' + a; }

  // 県別出場人数を ranking と prefByUid から導出。
  function derivePrefCounts(ranking, prefByUid) {
    const c = {};
    for (const uid of ranking) {
      const p = prefByUid[uid];
      if (p) c[p] = (c[p] || 0) + 1;
    }
    return c;
  }

  // pairPenalty(a,b) を返すクロージャを構築（O(1) 参照）。
  // 地域罰則は県ごとの連続重み(既定 1/√人数)。少数派を特別にハード罰則しない＝
  // 重みに応じてどの県もいい感じに分散する。
  function buildPairPenalty(params, prefByUid, prefCounts, recentPair) {
    const pw = prefWeightFn(params.prefWeight);
    const wByPref = {};
    for (const k in prefCounts) wByPref[k] = pw(prefCounts[k]);
    const Wr = params.W_region, Wn = params.W_recent;
    const useRegion = params.avoidRegion !== false;   // 既定 ON
    const useRecent = params.avoidRecent !== false;   // 既定 ON
    return function (a, b) {
      let region = 0;
      if (useRegion) {
        const pa = prefByUid[a], pb = prefByUid[b];
        if (pa && pb && pa === pb) region = (wByPref[pa] != null ? wByPref[pa] : pw(prefCounts[pa] || 2));
      }
      const recent = useRecent ? (recentPair[pairKey(a, b)] || 0) : 0;
      return Wr * region + Wn * recent;
    };
  }

  function roundWeightFn(roundWeights) {
    const last = roundWeights[roundWeights.length - 1];
    return (r) => (r <= roundWeights.length ? roundWeights[r - 1] : last);
  }

  // ───────────────────────── スコア（full / 検証用） ─────────────────────────
  // inter: 各プール内の全ペアに pairPenalty を適用し総和。
  function scoreInterFull(seedOrder, P, pp) {
    const N = seedOrder.length;
    const pools = [];
    for (let p = 0; p < P; p++) pools.push([]);
    for (let s = 0; s < N; s++) pools[poolOfSeed(s, P)].push(seedOrder[s]);
    let total = 0;
    for (const pool of pools) {
      for (let i = 0; i < pool.length; i++)
        for (let j = i + 1; j < pool.length; j++)
          total += pp(pool[i], pool[j]);
    }
    return total;
  }

  // intra: プール内（within-pool seed 順に並んだ uid 配列）の、勝者側で当たりうる全ペアに
  //        roundWeight(最早回戦) を掛けて総和。
  function scoreIntraPoolFull(poolUids, pp, rw) {
    const M = poolUids.length;
    if (M < 2) return 0;
    const B = nextPow2(M);
    const slotOf = slotOfSeedMap(B);     // seed(1始まり) -> slot
    // within-pool seed = index+1
    let total = 0;
    for (let i = 0; i < M; i++) {
      const slotI = slotOf[i + 1];
      for (let j = i + 1; j < M; j++) {
        const slotJ = slotOf[j + 1];
        const r = earliestMeetRound(slotI, slotJ);
        total += rw(r) * pp(poolUids[i], poolUids[j]);
      }
    }
    return total;
  }

  // ───────────────────────── 可動制約 ─────────────────────────
  function kInterFn(params) {
    if (typeof params.kInter === 'function') return params.kInter;
    if (Array.isArray(params.kInter)) {
      const arr = params.kInter;
      return (row1) => (row1 <= arr.length ? arr[row1 - 1] : arr[arr.length - 1]);
    }
    // 既定: プール内1位・2位は固定（0）、3位以降は倍々に可動（3位=1,4位=2,5位=4,6位=8,…）。
    // 下位ほど大きく動かせるので分離精度が上がる。上限はプール数で実質的に頭打ち。
    return (row1) => (row1 <= 2 ? 0 : Math.pow(2, row1 - 3));
  }
  function kIntraFn(params) {
    if (typeof params.kIntra === 'function') return params.kIntra;
    if (Array.isArray(params.kIntra)) {
      const arr = params.kIntra;
      return (rank1) => (rank1 <= arr.length ? arr[rank1 - 1] : arr[arr.length - 1]);
    }
    // 既定: 上位1/4は固定(0)、残りは ±1 のみ。最大可動1順位で動きを最小限に。
    return (rank1, M) => (rank1 <= M / 4 ? 0 : 1);
  }

  // ───────────────────────── inter 最適化 ─────────────────────────
  // 状態: seedOrder(uid 配列)。プール membership を pools[p]=seedIndex 配列で保持。
  function interOptimize(seedOrder, P, pp, params, rng, ctx, orderOf) {
    const N = seedOrder.length;
    const kInter = kInterFn(params);
    // 各 uid の inter 初期プール（= 入力 snake のプール）。
    const initPool = {};
    for (let s = 0; s < N; s++) initPool[seedOrder[s]] = poolOfSeed(s, P);

    // row ごとの seedIndex 群（同一 row 内でのみ swap）。
    const rowSeeds = [];
    for (let s = 0; s < N; s++) {
      const r = rowOfSeed(s, P);
      (rowSeeds[r] || (rowSeeds[r] = [])).push(s);
    }

    // プール membership（uid 配列）を現状から作る。
    function poolsOf(order) {
      const pools = [];
      for (let p = 0; p < P; p++) pools.push([]);
      for (let s = 0; s < N; s++) pools[poolOfSeed(s, P)].push(order[s]);
      return pools;
    }

    // 1 swap の制約チェック: seed i,j(同 row,別 pool)を交換しても両者が初期プール±k 内か。
    // maxSeedShift 指定時はシード番号ベースの変位（元順位比）も両者ともキャップ内か。
    // keepDePlace 指定時は DE 想定順位（タイ帯）が元シードから不変か。
    const maxShift = params.maxSeedShift != null ? params.maxSeedShift : null;
    const keepDe = params.keepDePlace === true;
    const origRank = params._origRank || {};
    function swapAllowed(order, i, j) {
      const pi = poolOfSeed(i, P), pj = poolOfSeed(j, P);
      const X = order[i], Y = order[j];
      const rowX = rowOfSeed(i, P) + 1, rowY = rowOfSeed(j, P) + 1; // 同じはず
      if (Math.abs(pj - initPool[X]) > kInter(rowX)) return false;   // X→pool pj
      if (Math.abs(pi - initPool[Y]) > kInter(rowY)) return false;   // Y→pool pi
      if (maxShift != null) {
        if (Math.abs((j + 1) - (origRank[X] || (j + 1))) > maxShift) return false; // X→seed j+1
        if (Math.abs((i + 1) - (origRank[Y] || (i + 1))) > maxShift) return false; // Y→seed i+1
      }
      if (keepDe) {
        if (dePlaceOfSeed(j + 1) !== dePlaceOfSeed(origRank[X] || (j + 1))) return false;
        if (dePlaceOfSeed(i + 1) !== dePlaceOfSeed(origRank[Y] || (i + 1))) return false;
      }
      return true;
    }

    // inter swap の Δ（プール pi, pj の内部ペア和の変化 + order 罰則の変化）。pools は uid 配列。
    function interDelta(order, pools, i, j) {
      const pi = poolOfSeed(i, P), pj = poolOfSeed(j, P);
      const X = order[i], Y = order[j];
      const poolI = pools[pi], poolJ = pools[pj];
      let before = 0, after = 0;
      for (const z of poolI) { if (z !== X) { before += pp(X, z); after += pp(Y, z); } }
      for (const z of poolJ) { if (z !== Y) { before += pp(Y, z); after += pp(X, z); } }
      let d = after - before;
      if (orderOf) {  // X→seed j+1, Y→seed i+1
        d += (orderOf(X, j + 1) + orderOf(Y, i + 1)) - (orderOf(X, i + 1) + orderOf(Y, j + 1));
      }
      return d;
    }
    function interOrderTotal(order) {
      if (!orderOf) return 0;
      let t = 0;
      for (let s = 0; s < N; s++) t += orderOf(order[s], s + 1);
      return t;
    }

    // 有効な近傍 swap をランダムに1つ返す（{i,j} または null）。
    function randomNeighbor(order) {
      for (let tries = 0; tries < 40; tries++) {
        const r = randInt(rng, rowSeeds.length);
        const seedsInRow = rowSeeds[r];
        if (!seedsInRow || seedsInRow.length < 2) continue;
        const a = seedsInRow[randInt(rng, seedsInRow.length)];
        const b = seedsInRow[randInt(rng, seedsInRow.length)];
        if (a === b) continue;
        if (poolOfSeed(a, P) === poolOfSeed(b, P)) continue;
        if (!swapAllowed(order, a, b)) continue;
        return { i: a, j: b };
      }
      return null;
    }

    function applySwap(order, pools, i, j) {
      const pi = poolOfSeed(i, P), pj = poolOfSeed(j, P);
      const X = order[i], Y = order[j];
      order[i] = Y; order[j] = X;
      // pools 更新
      const poolI = pools[pi], poolJ = pools[pj];
      poolI[poolI.indexOf(X)] = Y;
      poolJ[poolJ.indexOf(Y)] = X;
    }

    const result = runSearch({
      state: seedOrder.slice(),
      makePools: poolsOf,
      scoreFull: (order) => scoreInterFull(order, P, pp) + interOrderTotal(order),
      randomNeighbor,
      delta: interDelta,
      applySwap,
      params, rng, ctx, phaseName: 'inter',
    });
    return result;
  }

  // ───────────────────────── intra 最適化（プール単位） ─────────────────────────
  // poolUids: within-pool seed 順の uid 配列。プール内でのみ swap。
  function intraOptimizePool(poolUids, pp, params, rng, ctx, poolLabel, orderOf, globalSeeds) {
    const M = poolUids.length;
    if (M < 2) return { state: poolUids.slice(), score: 0, iters: 0 };
    const rw = roundWeightFn(params.roundWeights);
    const kIntra = kIntraFn(params);
    const B = nextPow2(M);
    const slotOf = slotOfSeedMap(B);
    // 初期 within-pool rank（1始まり）を uid ごとに記録。
    const initRank = {};
    for (let i = 0; i < M; i++) initRank[poolUids[i]] = i + 1;
    // 位置 k の uid は globalSeeds[k]+1 のシードに座る（order 罰則と maxSeedShift 判定に使用）。
    const gs1 = globalSeeds ? globalSeeds.map((s) => s + 1) : null;
    const maxShift = params.maxSeedShift != null ? params.maxSeedShift : null;
    const keepDe = params.keepDePlace === true;
    const origRank = params._origRank || {};

    function swapAllowed(order, i, j) {
      const A = order[i], B2 = order[j];
      // プール間移動した選手も他と同じ ±k 制約で動ける。
      // （旧実装は移動者を intra 固定していたが、実データ検証で参加者の約8割が
      //   固定され再対戦回避の主なボトルネックになっていたため撤廃。合成変位は
      //   inter 行内(P-1) + intra ±1行(P) の加算で最大 2P-1 に収まる。）
      // 交換後の rank（=index+1）が各自の初期 rank ±k 内か。
      if (Math.abs((j + 1) - initRank[A]) > kIntra(initRank[A], M)) return false;
      if (Math.abs((i + 1) - initRank[B2]) > kIntra(initRank[B2], M)) return false;
      // maxSeedShift: 交換後のグローバルシード番号が元順位 ±maxShift 内か（inter 変位との合成後）。
      if (maxShift != null && gs1) {
        if (Math.abs(gs1[j] - (origRank[A] || gs1[j])) > maxShift) return false;
        if (Math.abs(gs1[i] - (origRank[B2] || gs1[i])) > maxShift) return false;
      }
      // keepDePlace: 交換後のグローバルシードの DE 想定順位が元シードと同じタイ帯か。
      if (keepDe && gs1) {
        if (dePlaceOfSeed(gs1[j]) !== dePlaceOfSeed(origRank[A] || gs1[j])) return false;
        if (dePlaceOfSeed(gs1[i]) !== dePlaceOfSeed(origRank[B2] || gs1[i])) return false;
      }
      return true;
    }

    // Δ: i,j の within-pool seed(=slot) を入れ替えた時のスコア変化。
    function intraDelta(order, _pools, i, j) {
      const slotI = slotOf[i + 1], slotJ = slotOf[j + 1];
      const A = order[i], Bp = order[j];
      let d = 0;
      for (let k = 0; k < M; k++) {
        if (k === i || k === j) continue;
        const slotK = slotOf[k + 1];
        const C = order[k];
        // A: 旧 slotI → 新 slotJ
        d += (rw(earliestMeetRound(slotJ, slotK)) - rw(earliestMeetRound(slotI, slotK))) * pp(A, C);
        // B: 旧 slotJ → 新 slotI
        d += (rw(earliestMeetRound(slotI, slotK)) - rw(earliestMeetRound(slotJ, slotK))) * pp(Bp, C);
      }
      if (orderOf && gs1) {  // A→位置 j のシード, B→位置 i のシード
        d += (orderOf(A, gs1[j]) + orderOf(Bp, gs1[i])) - (orderOf(A, gs1[i]) + orderOf(Bp, gs1[j]));
      }
      return d; // (A,B) ペアは slot 入替でも最早回戦が対称ゆえ不変
    }
    function intraOrderTotal(order) {
      if (!orderOf || !gs1) return 0;
      let t = 0;
      for (let k = 0; k < M; k++) t += orderOf(order[k], gs1[k]);
      return t;
    }

    function randomNeighbor(order) {
      for (let tries = 0; tries < 40; tries++) {
        const i = randInt(rng, M), j = randInt(rng, M);
        if (i === j) continue;
        if (!swapAllowed(order, i, j)) continue;
        return { i, j };
      }
      return null;
    }
    function applySwap(order, _pools, i, j) {
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }

    const result = runSearch({
      state: poolUids.slice(),
      makePools: null,
      scoreFull: (order) => scoreIntraPoolFull(order, pp, rw) + intraOrderTotal(order),
      randomNeighbor,
      delta: intraDelta,
      applySwap,
      params, rng, ctx, phaseName: 'intra:' + poolLabel,
    });
    return result;
  }

  // ───────────────────────── 汎用探索（山登り / SA / 多点） ─────────────────────────
  function runSearch(opt) {
    const { params, rng, ctx } = opt;
    const mode = params.mode;
    const multi = mode === 'multistart-sa' || mode === 'multistart-hillclimb';
    const useSA = mode === 'sa' || mode === 'multistart-sa';
    const restarts = multi ? Math.max(1, params.restarts) : 1;
    const stateSize = opt.state.length;
    const maxIters = params.maxIters || Math.max(500, stateSize * (params.maxItersScale || 40));

    let best = null;

    for (let k = 0; k < restarts; k++) {
      if (ctx.shouldStop && ctx.shouldStop()) break;
      // 初期解: k=0 は基準そのまま。k>0（または _perturbStart 指定時）は制約内ランダム swap で攪乱。
      // Worker 経由の多点は restarts=1 を繰り返すので _perturbStart で各リスタートの初期攪乱を制御する。
      let state = opt.state.slice();
      let pools = opt.makePools ? opt.makePools(state) : null;
      if (k > 0 || params._perturbStart) {
        const perturb = stateSize;
        for (let t = 0; t < perturb; t++) {
          const nb = opt.randomNeighbor(state);
          if (nb) opt.applySwap(state, pools, nb.i, nb.j);
        }
      }
      let score = opt.scoreFull(state);

      // SA 温度初期値（自動推定）。
      let T = params.saT0;
      if (useSA && (T == null)) {
        let acc = 0, n = 0;
        for (let s = 0; s < 30; s++) {
          const nb = opt.randomNeighbor(state);
          if (!nb) continue;
          acc += Math.abs(opt.delta(state, pools, nb.i, nb.j)); n++;
        }
        T = n ? Math.max((acc / n) * 1.5, 1e-3) : 1.0;
      }

      // 探索中の最良解を保持（SA は最終状態が最良とは限らないため）＋ 収束で早期終了。
      let bestSeen = score, bestState = state.slice(), sinceBest = 0;
      // best が連続で更新されない回数がこの閾値を超えたら収束打ち切り（緩め: maxIters の一定割合）。
      const earlyStop = params.earlyStopIters || Math.max(10000, Math.floor(maxIters * (params.earlyStopFrac != null ? params.earlyStopFrac : 0.3)));
      for (let iter = 0; iter < maxIters; iter++) {
        if ((iter & 1023) === 0 && ctx.shouldStop && ctx.shouldStop()) break;
        const nb = opt.randomNeighbor(state);
        if (!nb) break;
        const d = opt.delta(state, pools, nb.i, nb.j);
        let accept;
        if (d <= 0) accept = true;
        else if (useSA) accept = rng() < Math.exp(-d / Math.max(T, params.saMinT));
        else accept = false;
        if (accept) {
          opt.applySwap(state, pools, nb.i, nb.j);
          score += d;
          if (params._verifyDelta) {
            const full = opt.scoreFull(state);
            if (Math.abs(full - score) > 1e-6) {
              throw new Error('delta 不整合: incremental=' + score + ' full=' + full +
                ' (' + opt.phaseName + ')');
            }
          }
        }
        if (score < bestSeen - 1e-12) { bestSeen = score; bestState = state.slice(); sinceBest = 0; }
        else sinceBest++;
        if (useSA) T *= params.saCooling;
        // best が earlyStop 回連続で更新されなければ収束とみなし打ち切り（SA/山登り共通）。
        if (sinceBest > earlyStop) break;
        if (ctx.onProgress && (iter & 255) === 0) {
          ctx.onProgress({ phase: opt.phaseName, restart: k, iter, score });
        }
      }
      if (!best || bestSeen < best.score - 1e-12) {
        best = { state: bestState, score: bestSeen };
      }
    }
    return best;
  }

  // ───────────────────────── トップレベル ─────────────────────────
  function resolveParams(p) {
    const out = Object.assign({}, DEFAULT_PARAMS, p || {});
    // W_region と W_recent の大小は自由（どちらを優先するかは運用判断。
    // 以前は W_region > W_recent を強制していたが 2026-07 に撤廃）。
    // 以下は「黙って壊れる」系の退行防止（fail-loud 方針）:
    // roundWeights が空/非数値だと intra スコアが NaN になり、エラーなしで恒等解が返る。
    if (!Array.isArray(out.roundWeights) || out.roundWeights.length === 0 ||
        out.roundWeights.some((w) => typeof w !== 'number' || !isFinite(w) || w < 0)) {
      throw new Error('roundWeights は 1 要素以上の非負数値配列にしてください。');
    }
    // kInter/kIntra 配列に負値/非数があると全 swap が拒否され、無言で入力がそのまま返る。
    for (const name of ['kInter', 'kIntra']) {
      const v = out[name];
      if (Array.isArray(v) && v.some((k) => typeof k !== 'number' || !isFinite(k) || k < 0)) {
        throw new Error(name + ' 配列の要素は 0 以上の数値にしてください。');
      }
    }
    // maxSeedShift が負/非数だと全 swap が拒否され、無言で入力がそのまま返る。
    if (out.maxSeedShift != null &&
        (typeof out.maxSeedShift !== 'number' || !isFinite(out.maxSeedShift) || out.maxSeedShift < 0)) {
      throw new Error('maxSeedShift は 0 以上の数値または null にしてください。');
    }
    // keepDePlace は truthy 文字列等が「無言で無効」にならないよう boolean に正規化。
    out.keepDePlace = !!out.keepDePlace;
    // 未知 mode は単発 hillclimb に無言降格していたため明示的に弾く。
    if (out.mode != null && !MODE_DEFAULTS[out.mode]) {
      throw new Error('未知の mode: ' + out.mode + ' (対応: ' + Object.keys(MODE_DEFAULTS).join(', ') + ')');
    }
    return out;
  }

  // 形式ゲーティング（docs §5）。戻り値 {runInter, runIntra} または {unsupported}。
  function gateFormat(P, format) {
    const isDE = format === 'DOUBLE_ELIMINATION';
    if (P >= 2) return { runInter: true, runIntra: isDE };
    if (P === 1) {
      if (isDE) return { runInter: false, runIntra: true };
      return { unsupported: true, reason: '1プール×非ダブルイリミネーションは被り回避非対応です。' };
    }
    throw new Error('poolCount は 1 以上にしてください。');
  }

  // seedOrder からプール（within-pool seed 順 uid 配列）を作る。
  function poolsFromSeedOrder(seedOrder, P) {
    const pools = [];
    for (let p = 0; p < P; p++) pools.push([]);
    // s 昇順で push すれば各プール内も within-pool seed 昇順になる。
    for (let s = 0; s < seedOrder.length; s++) pools[poolOfSeed(s, P)].push(seedOrder[s]);
    return pools;
  }

  // プール内 within-pool 順の uid 配列群を、グローバル seedOrder に書き戻す。
  function seedOrderFromPools(pools, P, N) {
    const order = new Array(N);
    const cursor = new Array(P).fill(0);
    for (let s = 0; s < N; s++) {
      const p = poolOfSeed(s, P);
      order[s] = pools[p][cursor[p]++];
    }
    return order;
  }

  // runIntra: intra 最適化を実行したか（スコアの回戦重み付けに使用）。
  // reportIntra: プール内（早期回戦）レポートを出すか。DE なら intra 最適化を
  //   オフにしていても既定ブラケット順の当たりは確定しているので出せる。
  function fullReport(seedOrderBefore, seedOrderAfter, P, pp, params, runIntra, reportIntra, recentPair, recentMeta) {
    const rw = roundWeightFn(params.roundWeights);
    const prefByUid = params._prefByUid || {}, origRank = params._origRank || {};
    const pwFn = prefWeightFn(params.prefWeight);
    const Wr = params.W_region, Wn = params.W_recent, Wo = params.W_order || 0, oPow = params.orderPow || 1;
    // 罰則のオンオフを反映（無効化した成分はスコア 0 に＝改善率が実効目的を表す）。
    const useRegion = params.avoidRegion !== false, useRecent = params.avoidRecent !== false;
    const regionW = useRegion
      ? (a, b) => { const pa = prefByUid[a], pb = prefByUid[b]; return (pa && pb && pa === pb) ? pwFn((params._prefCounts || {})[pa] || 2) : 0; }
      : () => 0;
    // 直近対戦成分は目的関数と同じ recentPair から読む（recentMeta は表示用メタのみ）。
    // 以前は recentMeta.penalty を読んでいたため、recentPair だけ渡す呼び出し
    // (= docs §8.1 の契約どおり) でレポート/リスタート選択から直対成分が消えていた。
    const recentW = useRecent
      ? (a, b) => (recentPair && recentPair[pairKey(a, b)]) || 0
      : () => 0;
    // セル別（プール間/内 × 地域/直近）と order 罰則のスコアを計算。
    function poolScores(order) {
      const pools = poolsFromSeedOrder(order, P);
      let interRegion = 0, interRecent = 0, intraRegion = 0, intraRecent = 0;
      for (const pool of pools) {
        const Bn = nextPow2(pool.length), sOf = slotOfSeedMap(Bn);
        for (let i = 0; i < pool.length; i++)
          for (let j = i + 1; j < pool.length; j++) {
            const a = pool[i], b = pool[j];
            const rg = Wr * regionW(a, b), rc = Wn * recentW(a, b);
            interRegion += rg; interRecent += rc;
            if (runIntra) { const w = rw(earliestMeetRound(sOf[i + 1], sOf[j + 1])); intraRegion += w * rg; intraRecent += w * rc; }
          }
      }
      let order_ = 0;
      if (Wo > 0) order.forEach((u, s) => { order_ += Wo * Math.pow(Math.abs((s + 1) - (origRank[u] || (s + 1))), oPow); });
      const inter = interRegion + interRecent, intra = intraRegion + intraRecent;
      return { inter, intra, total: inter + intra, interRegion, interRecent, intraRegion, intraRecent, order: order_ };
    }
    const before = poolScores(seedOrderBefore);
    const after = poolScores(seedOrderAfter);
    // P==1 は inter(プール所属ペア罰則)が最適化で不変の定数項なので、
    // 改善率は実際に動かせる intra 成分だけで計算する（total だと希釈される）。
    const pctBase = P === 1 ? 'intra' : 'total';
    const improvementPct = before[pctBase] > 0
      ? (1 - after[pctBase] / before[pctBase]) * 100 : 0;

    // 残存懸念を「プール間（誰が同プールか・回戦非依存）」と
    // 「プール内（同プール内で早期回戦に当たるか・DE時のみ）」に分けて報告する。
    const poolsAfter = poolsFromSeedOrder(seedOrderAfter, P);
    const prefCounts = params._prefCounts || {};
    const earlyRound = params.earlyRoundThreshold || 3;   // 「早期回戦」の閾値
    const reportRecentMaxDays = params.reportRecentMaxDays != null ? params.reportRecentMaxDays : 182.5; // レポート表示は半年以内
    // 最多地域（報告から除外）。
    let mostPopRegion = null, _mp = -1;
    for (const r in prefCounts) { if (prefCounts[r] > _mp) { _mp = prefCounts[r]; mostPopRegion = r; } }

    // 同プール全ペアを走査し、地域(少数派/多数派)・直近・最早回戦を集計。
    const sepByPref = {};   // プール間: 分離可能県(少数派)の同プール被り = 理想違反
    const majByPref = {};   // プール間: 多数派県(>P)の同プール被り数 = 鳩の巣で不可避
    const recentInter = []; // プール間: 同プール直近対戦ペア
    const recentIntra = []; // プール内: 早期回戦で当たる直近対戦ペア
    const intraEarlyMatchups = []; // プール内: 早期回戦で当たる同地域ペア（最多地域を除く）
    for (let pi = 0; pi < poolsAfter.length; pi++) {
      const pool = poolsAfter[pi];
      const B = nextPow2(pool.length), slotOf = slotOfSeedMap(B);
      for (let i = 0; i < pool.length; i++)
        for (let j = i + 1; j < pool.length; j++) {
          const a = pool[i], b = pool[j];
          const round = reportIntra ? earliestMeetRound(slotOf[i + 1], slotOf[j + 1]) : null;
          // 地域（プール間：同プール被り）
          const pa = params._prefByUid[a], pb = params._prefByUid[b];
          if (pa && pb && pa === pb) {
            const cnt = prefCounts[pa] || 0;
            if (cnt > 0 && cnt <= P) {
              sepByPref[pa] = sepByPref[pa] || []; sepByPref[pa].push({ a, b, pool: pi, prefCount: cnt, round });
            } else {
              majByPref[pa] = (majByPref[pa] || 0) + 1;
            }
            // プール内：早期回戦(<=earlyRound)で当たる同地域ペアを列挙（最多地域は除外）。
            if (reportIntra && round <= earlyRound && pa !== mostPopRegion) {
              intraEarlyMatchups.push({ a, b, pool: pi, round, region: pa, prefCount: cnt });
            }
          }
          // 直近対戦（レポートには最終対戦が reportRecentMaxDays 以内=半年のものだけ載せる。
          // 最適化のスコアは引き続き全期間(<=cutoff)を使う）。
          // 罰則値は目的関数と同じ recentPair、日付/回数の表示は recentMeta（無ければ省略）。
          const rawRecent = (recentPair && recentPair[pairKey(a, b)]) || 0;
          if (rawRecent > 0) {
            const meta = recentMeta && recentMeta[pairKey(a, b)];
            const withinReport = !meta || meta.lastDeltaDays == null || meta.lastDeltaDays <= reportRecentMaxDays;
            if (withinReport) {
              const item = { a, b, pool: pi, round, recentPenalty: rawRecent,
                             lastDate: meta ? meta.lastDate : null, count: meta ? meta.count : null,
                             lastTournament: (meta && meta.lastTournament) || null,
                             lastNent: (meta && meta.lastNent != null) ? meta.lastNent : null };
              recentInter.push(item);
              if (reportIntra && round <= earlyRound) recentIntra.push(item);
            }
          }
        }
    }
    // 新しい対戦が先。日付ありを日付なしより先に。同日付は罰則の大きい順（一貫比較器）。
    const byRecency = (x, y) => {
      if (x.lastDate && y.lastDate) {
        if (x.lastDate !== y.lastDate) return x.lastDate < y.lastDate ? 1 : -1;
        return y.recentPenalty - x.recentPenalty;
      }
      if (x.lastDate) return -1;
      if (y.lastDate) return 1;
      return y.recentPenalty - x.recentPenalty;
    };
    recentInter.sort(byRecency); recentIntra.sort(byRecency);
    const sum = (obj) => Object.values(obj).reduce((s, v) => s + (Array.isArray(v) ? v.length : v), 0);

    // 各プールの地域内訳（地域バランス表示用）。
    const poolComposition = poolsAfter.map((pool) => {
      const counts = {}; let unknown = 0;
      for (const uid of pool) { const p = params._prefByUid[uid]; if (p) counts[p] = (counts[p] || 0) + 1; else unknown++; }
      return { size: pool.length, counts, unknown };
    });
    // 地域ごとのプール間分布（total>=2 のみ）。min..max が小さいほど均等に散っている。
    const regionTotals = {};
    poolComposition.forEach((pc) => { for (const r in pc.counts) regionTotals[r] = (regionTotals[r] || 0) + pc.counts[r]; });
    const regionSpread = {};
    Object.keys(regionTotals).forEach((r) => {
      if (regionTotals[r] < 2) return;
      const per = poolComposition.map((pc) => pc.counts[r] || 0);
      const ideal = regionTotals[r] / P;   // 完全均等ならこの値（±1 が理想範囲）
      regionSpread[r] = { total: regionTotals[r], per, min: Math.min.apply(null, per), max: Math.max.apply(null, per), ideal };
    });

    // 4セル構成: {プール間, プール内} × {同一地域, 直近対戦}。
    return {
      before, after, improvementPct,
      residualConcerns: {
        // プール間（誰が同プールか・回戦非依存）
        inter: {
          region: {
            poolComposition,    // 各プールの地域内訳（地域バランス）
            spread: regionSpread, // 地域ごとのプール間分布(min..max, ideal)
            separable: sepByPref, separablePairs: sum(sepByPref),   // 参考: 分散できるはずの被り
            majority: majByPref, majorityPairs: sum(majByPref),     // 参考: 人数多く回避不能
          },
          recent: { pairs: recentInter.length, top: recentInter.slice(0, 10) },
        },
        // プール内（同プール内で早期回戦に当たるか）。DE 時のみ
        // （intra 最適化オフでも既定ブラケット順の当たりとして報告する）。
        intra: reportIntra ? {
          earlyRound,
          region: {
            // 早期回戦で当たる同地域ペア（最多地域は除外）。回戦が早い順。
            earlyMatchups: intraEarlyMatchups.slice().sort((x, y) => x.round - y.round).slice(0, 20),
            earlyPairs: intraEarlyMatchups.length,
            excludedRegion: mostPopRegion,                  // 報告から除外した最多地域
          },
          recent: { pairs: recentIntra.length, top: recentIntra.slice(0, 10) },
        } : null,
      },
    };
  }

  // メイン関数。
  function optimize(input, callbacks) {
    callbacks = callbacks || {};
    const ctx = {
      onProgress: callbacks.onProgress || null,
      onCheckpoint: callbacks.onCheckpoint || null,
      shouldStop: callbacks.shouldStop || null,
    };
    const P = input.poolCount;
    const ranking = input.ranking.slice();
    const N = ranking.length;
    const gate = gateFormat(P, input.format);
    if (gate.unsupported) return { unsupported: true, reason: gate.reason };

    // モード別既定を適用（input.params が最優先）。
    const reqMode = (input.params && input.params.mode) || DEFAULT_PARAMS.mode;
    const params = resolveParams(Object.assign({}, MODE_DEFAULTS[reqMode] || {}, input.params));
    // プール内変動(intra)の実効可否。P>=2 のときだけ UI トグルで無効化できる。
    // P==1×DE は intra が唯一の被り回避なので常に実行する（トグル対象外）。
    const runIntra = gate.runIntra && !(P >= 2 && params.enableIntra === false);
    const rng = makeRng(params.rngSeed);
    const prefByUid = input.prefByUid || {};
    const prefCounts = input.prefCounts || derivePrefCounts(ranking, prefByUid);
    const recentPair = input.recentPair || {};
    params._prefByUid = prefByUid; // レポート用
    params._prefCounts = prefCounts; // レポート用（少数派/多数派の判定）
    const pp = buildPairPenalty(params, prefByUid, prefCounts, recentPair);

    // 元ランキングからのズレ罰則: シードが元順位から離れるほど少し罰する（形を保つ）。
    const origRank = {};
    ranking.forEach((u, i) => { origRank[u] = i + 1; });
    params._origRank = origRank; // レポート用
    const Wo = params.W_order || 0, oPow = params.orderPow || 1;
    const orderOf = Wo > 0
      ? (uid, seed1) => Wo * Math.pow(Math.abs(seed1 - origRank[uid]), oPow)
      : null;
    // プールごとのグローバルシード位置（intra の order 罰則用）。
    const globalSeedsByPool = [];
    for (let p = 0; p < P; p++) globalSeedsByPool.push([]);
    for (let s = 0; s < N; s++) globalSeedsByPool[poolOfSeed(s, P)].push(s);
    const seedOrderBefore = ranking.slice();
    let seedOrder = ranking.slice();
    let stoppedEarly = false;

    // 1) inter
    if (gate.runInter) {
      if (ctx.onProgress) ctx.onProgress({ phase: 'inter', stage: 'start' });
      const r = interOptimize(seedOrder, P, pp, params, rng, ctx, orderOf);
      if (r) seedOrder = r.state;
      if (ctx.onCheckpoint) ctx.onCheckpoint({ phase: 'inter', seedOrder: seedOrder.slice() });
      if (ctx.shouldStop && ctx.shouldStop()) stoppedEarly = true;
    }

    // 2) intra（プールごと独立）
    if (runIntra && !stoppedEarly) {
      const pools = poolsFromSeedOrder(seedOrder, P);
      for (let pi = 0; pi < pools.length; pi++) {
        if (ctx.shouldStop && ctx.shouldStop()) { stoppedEarly = true; break; }
        if (ctx.onProgress) ctx.onProgress({ phase: 'intra', pool: pi, stage: 'start' });
        const r = intraOptimizePool(pools[pi], pp, params, rng, ctx, String(pi), orderOf, globalSeedsByPool[pi]);
        if (r) pools[pi] = r.state;
        if (ctx.onCheckpoint) ctx.onCheckpoint({ phase: 'intra', pool: pi });
      }
      seedOrder = seedOrderFromPools(pools, P, N);
    }

    const report = fullReport(seedOrderBefore, seedOrder, P, pp, params, runIntra, gate.runIntra, recentPair, input.recentMeta);
    const poolsOut = poolsFromSeedOrder(seedOrder, P);

    return {
      seedOrder,
      pools: poolsOut,
      bracketByPool: runIntra ? poolsOut.map((x) => x.slice()) : null,
      report,
      stoppedEarly,
      ranAfter: { runInter: gate.runInter, runIntra: runIntra },
    };
  }

  const API = {
    optimize,
    // 個別関数（テスト・再利用）
    makeRng, randInt,
    poolOfSeed, rowOfSeed, seedSlotOrder, slotOfSeedMap, earliestMeetRound, nextPow2,
    dePlaceOfSeed,
    buildPairPenalty, derivePrefCounts, prefWeightFn, roundWeightFn, pairKey,
    scoreInterFull, scoreIntraPoolFull,
    poolsFromSeedOrder, seedOrderFromPools, gateFormat,
    kInterFn, kIntraFn, resolveParams,
    DEFAULT_PARAMS, MODE_DEFAULTS,
  };

  global.SeedOptimizer = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
