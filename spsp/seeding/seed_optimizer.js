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

  // シード通り勝ち上がった場合に実際に発生する勝者側の試合一覧。
  // 各ブラケットノードで「左右サブツリーの最小シード同士」が当たる (小さい方が勝ち進む)。
  // N 人 (シード 1..N が存在、N+1..B は bye) のとき試合数は N-1。
  // 返り値: [{a, b, round}] (a < b は 1始まりシード番号、round は 1=1回戦)。
  function projectedMatches(N, B) {
    const order = seedSlotOrder(B);
    // leaves: slot 順の存在シード (bye = Infinity)
    let cur = order.map((s) => (s <= N ? s : Infinity));
    const out = [];
    let round = 1;
    while (cur.length > 1) {
      const next = [];
      for (let m = 0; m < cur.length; m += 2) {
        const a = cur[m], b = cur[m + 1];
        if (a !== Infinity && b !== Infinity) {
          out.push({ a: Math.min(a, b), b: Math.max(a, b), round });
        }
        next.push(Math.min(a, b));
      }
      cur = next;
      round++;
    }
    return out;
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
    // 同シリーズ再マッチ罰則（既定 OFF）。「今回シードする大会と同じシリーズで既に
    // 当たっているペア」を、通常の再対戦より重く罰する。対象シリーズの判定と
    // 同シリーズ分の罰則集計 (seriesPair) はデータ層 (seed_data.js) の担当。
    //   'add'  : 通常罰則に W_series × 同シリーズ分の罰則を上乗せ（試合ごとの
    //            重み = 時間減衰×大会規模 を保ったまま加算する）
    //   'mult' : 同シリーズで当たっているペアの再対戦罰則を seriesMult 倍する
    //            （何回・どの規模で当たったかに依らず一律の倍率）
    avoidSeriesRematch: false,
    seriesMode: 'add',                   // 'add' | 'mult'
    W_series: 0.3,                       // seriesMode='add' のときの上乗せ重み
    seriesMult: 2.0,                     // seriesMode='mult' のときの倍率
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
    // 順位帯ごとのシードズレ上限 (maxSeedShift の順位依存版・全スコープ共通)。
    // 配列 index k の値 rk = 「±k ズレまでしか許さないのは何位まで」。
    // 例 [null, 8, 16, 32]: 1-8位 ±1 / 9-16位 ±2 / 17-32位 ±3 / 33位〜 無制限。
    // [4] なら 1-4位 固定 (±0)・5位〜 無制限。指定 tier は昇順必須。null=制約なし。
    shiftLimitRanks: null,
    // true なら DE 想定順位 (dePlaceOfSeed: 1,2,3,4,5,5,7,7,9×4,…) が全員
    // 元シードから不変になる範囲でのみ入れ替える（同タイ帯内の移動のみ許可）。
    keepDePlace: false,
    // 最適化スコープ。'pools'=現行 (inter+intra のプール構造ベース)。
    // 'winners'=プール(予選/本戦)構造を無視し、全体を1つの勝者側 DE ブラケットと
    // みなして被りを最適化。ハード制約は DE 想定順位 (タイ帯) 不変のみ
    // (+maxSeedShift 指定時はそれも有効)。kInter/kIntra/enableIntra は適用されず、
    // 移動の抑制は W_order のシードズレ罰則 (正則化) で制御する。
    bracketScope: 'pools',
    // winners スコープの既定回戦重みは roundWeights とは別 (optimize 内で
    // winnersRoundWeights を全深さぶん生成)。roundWeights 明示指定時はそれが優先。
    // winners スコープでプール内順位 (snake 行番号) の可動制約 (kIntra と同じ規則) を
    // 追加するオプション。既定 OFF (= タイ帯不変のみが制約)。
    winnersPoolRankLimit: false,
    // プール/ウェーブ固定 (ハード制約)。uid → 'pool' | 'wave'。
    // 'pool' = 元ランキング位置の snake プールから動かさない (プール内変動は可)。
    // 'wave' = 元ランキング位置のプールと同じウェーブのプール内でのみ動ける。
    // 'wave' 指定には poolWaves が必須 (無指定は fail-loud で throw)。null = 固定なし。
    seedLocks: null,
    // プール index (0始まり) → ウェーブ index (0始まり) の配列。長さ = poolCount。
    // ウェーブ = 連続するプールの塊 (A,B,C,… の連番アルファベット)。null = ウェーブなし。
    poolWaves: null,
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

  // winners スコープの既定回戦重み: R1=1, R2=0.5, R3 以降は 0.2 から毎回戦 ×0.9 の
  // 緩やかな単調減少。早期 (R1,R2) の被りを強く避けつつ、後段も「当たりを遅らせる」
  // こと自体に僅かな価値を持たせる (決勝まで勾配があり、かつ ~0.1 以上で無視されない)。
  function winnersRoundWeights(rounds) {
    const w = [];
    for (let r = 1; r <= rounds; r++) {
      if (r === 1) w.push(1.0);
      else if (r === 2) w.push(0.5);
      else w.push(0.2 * Math.pow(0.9, r - 3));
    }
    return w;
  }

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
  function buildPairPenalty(params, prefByUid, prefCounts, recentPair, seriesPair) {
    const pw = prefWeightFn(params.prefWeight);
    const wByPref = {};
    for (const k in prefCounts) wByPref[k] = pw(prefCounts[k]);
    const Wr = params.W_region, Wn = params.W_recent;
    const useRegion = params.avoidRegion !== false;   // 既定 ON
    const useRecent = params.avoidRecent !== false;   // 既定 ON
    // 同シリーズ再マッチは「再対戦罰則の上乗せ」なので、再対戦を考慮しない設定では効かせない。
    const sp = seriesPair || {};
    const useSeries = params.avoidSeriesRematch === true && useRecent;
    const seriesMult = params.seriesMult != null ? params.seriesMult : 2.0;
    const Ws = params.W_series != null ? params.W_series : 0.3;
    const multMode = params.seriesMode === 'mult';
    return function (a, b) {
      let region = 0;
      if (useRegion) {
        const pa = prefByUid[a], pb = prefByUid[b];
        if (pa && pb && pa === pb) region = (wByPref[pa] != null ? wByPref[pa] : pw(prefCounts[pa] || 2));
      }
      const key = pairKey(a, b);
      const recent = useRecent ? (recentPair[key] || 0) : 0;
      const series = useSeries ? (sp[key] || 0) : 0;
      if (multMode) return Wr * region + Wn * recent * (series > 0 ? seriesMult : 1);
      return Wr * region + Wn * recent + Ws * series;
    };
  }

  // レポート/スコア表示用: ペアの同シリーズ成分だけを返す関数を作る。
  // buildPairPenalty と同じ判定を使う（レポートと目的関数がズレないように一本化）。
  function seriesPenaltyFn(params, recentPair, seriesPair) {
    const sp = seriesPair || {};
    const useRecent = params.avoidRecent !== false;
    const useSeries = params.avoidSeriesRematch === true && useRecent;
    if (!useSeries) return () => 0;
    const seriesMult = params.seriesMult != null ? params.seriesMult : 2.0;
    const Ws = params.W_series != null ? params.W_series : 0.3;
    const Wn = params.W_recent;
    if (params.seriesMode === 'mult') {
      return (a, b) => {
        const key = pairKey(a, b);
        return (sp[key] || 0) > 0 ? Wn * (recentPair[key] || 0) * (seriesMult - 1) : 0;
      };
    }
    return (a, b) => Ws * (sp[pairKey(a, b)] || 0);
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

  // ───────────────────────── 事前計算 (全フェーズ共有) ─────────────────────────
  // ペア罰則行列 ppm[ia*N+ib] = pp(uid_ia, uid_ib)。uid → index は元 ranking 順で固定。
  // delta / full スコアの pp() 呼び出し (pairKey 文字列生成込み) を配列参照に置き換える。
  function buildPairMatrix(ranking, pp) {
    const N = ranking.length;
    const uidIdx = {};
    ranking.forEach((u, i) => { uidIdx[u] = i; });
    const ppm = new Float64Array(N * N);
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        const v = pp(ranking[a], ranking[b]);
        if (v !== 0) { ppm[a * N + b] = v; ppm[b * N + a] = v; }
      }
    }
    return { uidIdx, ppm, N };
  }
  // 回戦重み行列 rwm[a*B+b] = rw(earliestMeetRound(a,b))。ブラケットサイズごとに
  // cache (呼び出し側が同一重み関数スコープで使い回す) に保持。
  function rwSlotMatrix(B, rw, cache) {
    if (cache[B]) return cache[B];
    const m = new Float64Array(B * B);
    for (let a = 0; a < B; a++) {
      for (let b = 0; b < B; b++) {
        if (a !== b) m[a * B + b] = rw(earliestMeetRound(a, b));
      }
    }
    cache[B] = m;
    return m;
  }

  // ───────────────────────── 可動制約 ─────────────────────────
  // shiftLimitRanks → 「元順位 rank1 の選手が許されるシードズレ上限」関数 (無指定なら null)。
  // 指定 tier のどれにも該当しない順位は無制限 (Infinity)。
  function shiftCapFn(params) {
    const arr = params.shiftLimitRanks;
    if (!Array.isArray(arr) || !arr.some((v) => v != null)) return null;
    const tiers = [];
    arr.forEach((v, k) => { if (v != null) tiers.push([v, k]); });
    return (rank1) => {
      for (let t = 0; t < tiers.length; t++) {
        if (rank1 <= tiers[t][0]) return tiers[t][1];
      }
      return Infinity;
    };
  }

  // プール/ウェーブ固定 (seedLocks) の判定関数を構築。null = 固定なし。
  // 基準は「元ランキング位置の snake プール」(= origRank から導出)。何回 swap を
  // 重ねても各自の元プール/元ウェーブから出ない (可動制約と同じ origRank 基準)。
  function buildLockCheck(params, P) {
    const locks = params.seedLocks;
    if (!locks) return null;
    const uids = Object.keys(locks);
    if (!uids.length) return null;
    const waves = params.poolWaves || null;
    const origRank = params._origRank || {};
    return function (uid, newPool) {
      const l = locks[uid];
      if (!l) return true;
      const orig = origRank[uid];
      if (orig == null) return true;   // ランキング外 uid の指定は制約なし
      const origPool = poolOfSeed(orig - 1, P);
      if (l === 'pool') return newPool === origPool;
      return waves[newPool] === waves[origPool];   // 'wave' (poolWaves は resolveParams で検証済み)
    };
  }

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

  // params._verifyMoves 用（テスト専用・O(n^2)）: 候補集合から導いた「交換可能」関係が
  // swapAllowed と完全に一致するかを総当たりで確認する。候補集合が狭すぎて有効手を
  // 取りこぼしていないかを検出する（広すぎる側は randomNeighbor の swapAllowed 再確認で防いでいる）。
  function verifyMoveSets(order, groups, candSet, swapAllowed, phase) {
    for (const g of groups) {
      for (const a of g) {
        for (const b of g) {
          if (a === b) continue;
          const viaCand = candSet(order[a]).has(b) && candSet(order[b]).has(a);
          if (viaCand !== swapAllowed(order, a, b)) {
            throw new Error('候補集合が swapAllowed と不一致 (' + phase + '): ' +
              a + ',' + b + ' → 候補=' + viaCand + ' / swapAllowed=' + !viaCand);
          }
        }
      }
    }
  }

  // ───────────────────────── inter 最適化 ─────────────────────────
  // 状態: seedOrder(uid 配列)。プール membership を pools[p]=seedIndex 配列で保持。
  function interOptimize(seedOrder, P, pp, params, rng, ctx, orderOf, pre) {
    const N = seedOrder.length;
    const kInter = kInterFn(params);
    const { uidIdx, ppm } = pre || buildPairMatrix(seedOrder, pp);
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
    const shiftCap = shiftCapFn(params);
    const keepDe = params.keepDePlace === true;
    const origRank = params._origRank || {};
    const lockCheck = buildLockCheck(params, P);
    function swapAllowed(order, i, j) {
      const pi = poolOfSeed(i, P), pj = poolOfSeed(j, P);
      const X = order[i], Y = order[j];
      const rowX = rowOfSeed(i, P) + 1, rowY = rowOfSeed(j, P) + 1; // 同じはず
      if (Math.abs(pj - initPool[X]) > kInter(rowX)) return false;   // X→pool pj
      if (Math.abs(pi - initPool[Y]) > kInter(rowY)) return false;   // Y→pool pi
      // プール/ウェーブ固定 (inter swap は必ずプールが変わるので固定者は元プール/ウェーブ内のみ)
      if (lockCheck && (!lockCheck(X, pj) || !lockCheck(Y, pi))) return false;
      if (maxShift != null) {
        if (Math.abs((j + 1) - (origRank[X] || (j + 1))) > maxShift) return false; // X→seed j+1
        if (Math.abs((i + 1) - (origRank[Y] || (i + 1))) > maxShift) return false; // Y→seed i+1
      }
      if (shiftCap) {
        const oX = origRank[X] || (j + 1), oY = origRank[Y] || (i + 1);
        if (Math.abs((j + 1) - oX) > shiftCap(oX)) return false;
        if (Math.abs((i + 1) - oY) > shiftCap(oY)) return false;
      }
      if (keepDe) {
        if (dePlaceOfSeed(j + 1) !== dePlaceOfSeed(origRank[X] || (j + 1))) return false;
        if (dePlaceOfSeed(i + 1) !== dePlaceOfSeed(origRank[Y] || (i + 1))) return false;
      }
      return true;
    }

    // inter swap の Δ（プール pi, pj の内部ペア和の変化 + order 罰則の変化）。pools は uid 配列。
    // pp() 呼び出しは ppm (事前計算行列) の参照に置き換え済み。
    function interDelta(order, pools, i, j) {
      const pi = poolOfSeed(i, P), pj = poolOfSeed(j, P);
      const X = order[i], Y = order[j];
      const rx = uidIdx[X] * N, ry = uidIdx[Y] * N;
      const poolI = pools[pi], poolJ = pools[pj];
      let d = 0;
      for (const z of poolI) { if (z !== X) { const iz = uidIdx[z]; d += ppm[ry + iz] - ppm[rx + iz]; } }
      for (const z of poolJ) { if (z !== Y) { const iz = uidIdx[z]; d += ppm[rx + iz] - ppm[ry + iz]; } }
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

    // ── 有効手の候補集合 ──
    // swapAllowed の各ルールは判定基準が origRank / initPool（フェーズ中不変）なので、
    // 「その uid が行き先に座れるか」= (uid, 行き先) だけの述語 posOk に分解できる:
    //     swapAllowed(i, j) ≡ posOk(order[i], j) && posOk(order[j], i)
    // よって行き先を候補集合から引けば片側は常に成立し、残る棄却は相手側の1チェックだけ。
    // 候補集合は盤面に依存しないので前計算1回で済む（swap ごとの更新は不要）。
    function posOkInter(uid, j) {
      const pj = poolOfSeed(j, P), rowJ = rowOfSeed(j, P) + 1;
      if (Math.abs(pj - initPool[uid]) > kInter(rowJ)) return false;
      if (lockCheck && !lockCheck(uid, pj)) return false;
      if (maxShift != null && Math.abs((j + 1) - (origRank[uid] || (j + 1))) > maxShift) return false;
      if (shiftCap) {
        const o = origRank[uid] || (j + 1);
        if (Math.abs((j + 1) - o) > shiftCap(o)) return false;
      }
      if (keepDe && dePlaceOfSeed(j + 1) !== dePlaceOfSeed(origRank[uid] || (j + 1))) return false;
      return true;
    }
    // uid → 座れるスロット（同一 row 内。inter swap は row を変えないので候補も row 内で閉じる）。
    const candInter = {}, candInterSet = {};
    // 可動な選手が座るスロット。動けない選手（候補 1 個以下）は誰とも交換できないので、
    // そのスロットの占有者は永久に変わらない ⇒ この配列も静的でよい。
    const movableInter = [];
    for (let s = 0; s < N; s++) {
      const uid = seedOrder[s], lst = [];
      for (const j of rowSeeds[rowOfSeed(s, P)]) if (posOkInter(uid, j)) lst.push(j);
      candInter[uid] = lst; candInterSet[uid] = new Set(lst);
      if (lst.length >= 2) movableInter.push(s);
    }

    // 有効な近傍 swap をランダムに1つ返す（{i,j} または null）。
    // 候補集合で絞った上で、最後に必ず swapAllowed を通す（候補集合が誤っていても
    // 制約違反の手は出さない。正しければこの再確認は常に true で通過する）。
    function randomNeighbor(order) {
      if (params._verifyMoves) verifyMoveSets(order, rowSeeds, (u) => candInterSet[u], swapAllowed, 'inter');
      if (movableInter.length < 2) return null;
      for (let tries = 0; tries < 40; tries++) {
        const a = movableInter[randInt(rng, movableInter.length)];
        const cand = candInter[order[a]];
        const b = cand[randInt(rng, cand.length)];
        if (a === b) continue;
        if (poolOfSeed(a, P) === poolOfSeed(b, P)) continue;
        if (!candInterSet[order[b]].has(a)) continue;
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

    // full スコアも ppm 参照 (scoreInterFull と同じ走査順・同値)。
    function interFullM(order) {
      const pools = poolsOf(order);
      let total = 0;
      for (const pool of pools) {
        for (let a = 0; a < pool.length; a++) {
          const rA = uidIdx[pool[a]] * N;
          for (let b = a + 1; b < pool.length; b++) total += ppm[rA + uidIdx[pool[b]]];
        }
      }
      return total;
    }
    const result = runSearch({
      state: seedOrder.slice(),
      makePools: poolsOf,
      scoreFull: (order) => interFullM(order) + interOrderTotal(order),
      randomNeighbor,
      delta: interDelta,
      applySwap,
      params, rng, ctx, phaseName: 'inter',
    });
    return result;
  }

  // ───────────────────────── intra 最適化（プール単位） ─────────────────────────
  // poolUids: within-pool seed 順の uid 配列。プール内でのみ swap。
  function intraOptimizePool(poolUids, pp, params, rng, ctx, poolLabel, orderOf, globalSeeds, pre, rwmCache) {
    const M = poolUids.length;
    if (M < 2) return { state: poolUids.slice(), score: 0, iters: 0, maxIters: 0 };
    const rw = roundWeightFn(params.roundWeights);
    const kIntra = kIntraFn(params);
    const B = nextPow2(M);
    const slotOf = slotOfSeedMap(B);
    // 事前計算: ペア罰則行列 (全体共有) + 回戦重み行列 (ブラケットサイズごとにキャッシュ)。
    const { uidIdx, ppm, N: NG } = pre || buildPairMatrix(poolUids, pp);
    const rwm = rwSlotMatrix(B, rw, rwmCache || {});
    // 初期 within-pool rank（1始まり）を uid ごとに記録。
    const initRank = {};
    for (let i = 0; i < M; i++) initRank[poolUids[i]] = i + 1;
    // 位置 k の uid は globalSeeds[k]+1 のシードに座る（order 罰則と maxSeedShift 判定に使用）。
    const gs1 = globalSeeds ? globalSeeds.map((s) => s + 1) : null;
    const maxShift = params.maxSeedShift != null ? params.maxSeedShift : null;
    const shiftCap = shiftCapFn(params);
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
      if (shiftCap && gs1) {
        const oA = origRank[A] || gs1[j], oB = origRank[B2] || gs1[i];
        if (Math.abs(gs1[j] - oA) > shiftCap(oA)) return false;
        if (Math.abs(gs1[i] - oB) > shiftCap(oB)) return false;
      }
      // keepDePlace: 交換後のグローバルシードの DE 想定順位が元シードと同じタイ帯か。
      if (keepDe && gs1) {
        if (dePlaceOfSeed(gs1[j]) !== dePlaceOfSeed(origRank[A] || gs1[j])) return false;
        if (dePlaceOfSeed(gs1[i]) !== dePlaceOfSeed(origRank[B2] || gs1[i])) return false;
      }
      return true;
    }

    // Δ: i,j の within-pool seed(=slot) を入れ替えた時のスコア変化 (全て行列参照)。
    // (rwJK-rwIK)*pp(A,C) + (rwIK-rwJK)*pp(B,C) = (rwJK-rwIK)*(ppA-ppB) に因数分解。
    function intraDelta(order, _pools, i, j) {
      const wI = slotOf[i + 1] * B, wJ = slotOf[j + 1] * B;
      const ra = uidIdx[order[i]] * NG, rb = uidIdx[order[j]] * NG;
      let d = 0;
      for (let k = 0; k < M; k++) {
        if (k === i || k === j) continue;
        const sK = slotOf[k + 1];
        const ic = uidIdx[order[k]];
        d += (rwm[wJ + sK] - rwm[wI + sK]) * (ppm[ra + ic] - ppm[rb + ic]);
      }
      if (orderOf && gs1) {  // A→位置 j のシード, B→位置 i のシード
        const A = order[i], Bp = order[j];
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

    // ── 有効手の候補集合 ──
    // swapAllowed の各ルールは判定基準が origRank / initRank（フェーズ中不変）なので、
    // 「その uid が行き先に座れるか」= (uid, 行き先) だけの述語 posOk に分解できる:
    //     swapAllowed(i, j) ≡ posOk(order[i], j) && posOk(order[j], i)
    // よって行き先を候補集合から引けば片側は常に成立し、残る棄却は相手側の1チェックだけ。
    // 候補集合は盤面に依存しないので前計算1回で済む（swap ごとの更新は不要）。
    function posOkIntra(uid, k) {
      if (Math.abs((k + 1) - initRank[uid]) > kIntra(initRank[uid], M)) return false;
      if (maxShift != null && gs1 && Math.abs(gs1[k] - (origRank[uid] || gs1[k])) > maxShift) return false;
      if (shiftCap && gs1) {
        const o = origRank[uid] || gs1[k];
        if (Math.abs(gs1[k] - o) > shiftCap(o)) return false;
      }
      if (keepDe && gs1 && dePlaceOfSeed(gs1[k]) !== dePlaceOfSeed(origRank[uid] || gs1[k])) return false;
      return true;
    }
    const candIntra = {}, candIntraSet = {}, movableIntra = [];
    for (let k = 0; k < M; k++) {
      const uid = poolUids[k], lst = [];
      for (let q = 0; q < M; q++) if (posOkIntra(uid, q)) lst.push(q);
      candIntra[uid] = lst; candIntraSet[uid] = new Set(lst);
      if (lst.length >= 2) movableIntra.push(k);
    }

    function randomNeighbor(order) {
      if (params._verifyMoves) {
        const all = []; for (let q = 0; q < M; q++) all.push(q);
        verifyMoveSets(order, [all], (u) => candIntraSet[u], swapAllowed, 'intra:' + poolLabel);
      }
      if (movableIntra.length < 2) return null;
      for (let tries = 0; tries < 40; tries++) {
        const i = movableIntra[randInt(rng, movableIntra.length)];
        const cand = candIntra[order[i]];
        const j = cand[randInt(rng, cand.length)];
        if (i === j) continue;
        if (!candIntraSet[order[j]].has(i)) continue;
        if (!swapAllowed(order, i, j)) continue;   // 最終確認（制約違反は絶対に出さない）
        return { i, j };
      }
      return null;
    }
    function applySwap(order, _pools, i, j) {
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }

    // full スコアも行列参照 (scoreIntraPoolFull と同じ走査順・同値)。
    function intraFullM(order) {
      let total = 0;
      for (let a = 0; a < M; a++) {
        const wA = slotOf[a + 1] * B, rA = uidIdx[order[a]] * NG;
        for (let b = a + 1; b < M; b++) {
          total += rwm[wA + slotOf[b + 1]] * ppm[rA + uidIdx[order[b]]];
        }
      }
      return total;
    }
    const result = runSearch({
      state: poolUids.slice(),
      makePools: null,
      scoreFull: (order) => intraFullM(order) + intraOrderTotal(order),
      randomNeighbor,
      delta: intraDelta,
      applySwap,
      params, rng, ctx, phaseName: 'intra:' + poolLabel,
    });
    return result;
  }

  // ───────────────────────── winners 最適化（全体=1勝者側ブラケット） ─────────────────────────
  // プール構造を無視し、グローバルシード列全体を 1 つの勝者側 DE ブラケットとみなして
  // 当たり回戦重み付きの被り罰則を最適化する。ハード制約は「各選手の DE 想定順位
  // (タイ帯) が元シードから不変」のみ (+maxSeedShift 指定時)。タイ帯は 1,2,3,4 が
  // 単独帯 (=不動)、以降 {5,6},{7,8},{9..12},{13..16},{17..24},… と広がる。
  function winnersOptimize(seedOrder, pp, params, rng, ctx, orderOf, P, opts) {
    opts = opts || {};
    const N = seedOrder.length;
    if (N < 2) return { state: seedOrder.slice(), score: 0, iters: 0, maxIters: 0 };
    // 勝者側成分の回戦重み (optimize が params._winnersWeights に設定。直接呼び出し時は生成)。
    const rw = roundWeightFn(params._winnersWeights ||
      winnersRoundWeights(Math.max(1, Math.round(Math.log2(nextPow2(N))))));
    const B = nextPow2(N);
    const origRank = params._origRank || {};
    const maxShift = params.maxSeedShift != null ? params.maxSeedShift : null;
    const shiftCapW = shiftCapFn(params);
    const lockCheckW = buildLockCheck(params, P);
    // 位置 (0始まり) → タイ帯。帯内の swap だけを近傍にする（末尾帯は N で切れていてよい）。
    const posByBand = {};
    const bandOfPos = new Array(N);
    for (let s = 0; s < N; s++) {
      const b = dePlaceOfSeed(s + 1);
      bandOfPos[s] = b;
      (posByBand[b] || (posByBand[b] = [])).push(s);
    }
    // オプション: プール内順位に基づく可動制約 (= pools スコープの kIntra と同じ規則を
    // snake 行番号 = プール内順位に適用)。既定 OFF。ON のとき各自のプール内順位
    // (rowOfSeed+1) が元の順位から ±kIntra(元順位, プールサイズ) 内に制限される。
    const poolRankLimit = params.winnersPoolRankLimit === true && P >= 1;
    const kIntra = poolRankLimit ? kIntraFn(params) : null;
    const poolM = poolRankLimit ? Math.ceil(N / P) : 0;
    function rowOk(uid, newPos0) {
      const orig1 = origRank[uid] || (newPos0 + 1);
      const origRow = rowOfSeed(orig1 - 1, P) + 1;
      const newRow = rowOfSeed(newPos0, P) + 1;
      return Math.abs(newRow - origRow) <= kIntra(origRow, poolM);
    }

    function swapAllowed(order, i, j) {
      const X = order[i], Y = order[j];
      // タイ帯不変（origRank 基準なので、何回 swap を重ねても各自の元帯から出ない）。
      if (dePlaceOfSeed(j + 1) !== dePlaceOfSeed(origRank[X] || (j + 1))) return false;
      if (dePlaceOfSeed(i + 1) !== dePlaceOfSeed(origRank[Y] || (i + 1))) return false;
      if (maxShift != null) {
        if (Math.abs((j + 1) - (origRank[X] || (j + 1))) > maxShift) return false;
        if (Math.abs((i + 1) - (origRank[Y] || (i + 1))) > maxShift) return false;
      }
      if (shiftCapW) {
        const oX = origRank[X] || (j + 1), oY = origRank[Y] || (i + 1);
        if (Math.abs((j + 1) - oX) > shiftCapW(oX)) return false;
        if (Math.abs((i + 1) - oY) > shiftCapW(oY)) return false;
      }
      if (poolRankLimit) {
        if (!rowOk(X, j) || !rowOk(Y, i)) return false;
      }
      // プール/ウェーブ固定 (winners 位置 → snake プールで判定。P==1 は常にプール0で無制約)
      if (lockCheckW && (!lockCheckW(X, poolOfSeed(j, P)) || !lockCheckW(Y, poolOfSeed(i, P)))) return false;
      return true;
    }

    // ── 有効手の候補集合 ──
    // swapAllowed の各ルールは判定基準が origRank / タイ帯（フェーズ中不変）なので、
    // 「その uid が行き先に座れるか」= (uid, 行き先) だけの述語 posOk に分解できる:
    //     swapAllowed(i, j) ≡ posOk(order[i], j) && posOk(order[j], i)
    // よって行き先を候補集合から引けば片側は常に成立し、残る棄却は相手側の1チェックだけ。
    // 候補集合は盤面に依存しないので前計算1回で済む（swap ごとの更新は不要）。
    function posOkWinners(uid, k) {
      if (dePlaceOfSeed(k + 1) !== dePlaceOfSeed(origRank[uid] || (k + 1))) return false;
      if (maxShift != null && Math.abs((k + 1) - (origRank[uid] || (k + 1))) > maxShift) return false;
      if (shiftCapW) {
        const o = origRank[uid] || (k + 1);
        if (Math.abs((k + 1) - o) > shiftCapW(o)) return false;
      }
      if (poolRankLimit && !rowOk(uid, k)) return false;
      if (lockCheckW && !lockCheckW(uid, poolOfSeed(k, P))) return false;
      return true;
    }
    // 候補はタイ帯不変が必須なので、各自の帯の中だけを見れば足りる。
    const candWin = {}, candWinSet = {}, movableWin = [];
    for (let s = 0; s < N; s++) {
      const uid = seedOrder[s], lst = [];
      for (const k of (posByBand[bandOfPos[s]] || [])) if (posOkWinners(uid, k)) lst.push(k);
      candWin[uid] = lst; candWinSet[uid] = new Set(lst);
      if (lst.length >= 2) movableWin.push(s);
    }

    // 有効な近傍 swap をランダムに1つ返す（候補集合から引き、最後に swapAllowed で再確認）。
    function randomNeighbor(order) {
      if (params._verifyMoves) {
        verifyMoveSets(order, Object.keys(posByBand).map((b) => posByBand[b]),
          (u) => candWinSet[u], swapAllowed, 'winners');
      }
      if (movableWin.length < 2) return null;
      for (let tries = 0; tries < 40; tries++) {
        const i = movableWin[randInt(rng, movableWin.length)];
        const cand = candWin[order[i]];
        const j = cand[randInt(rng, cand.length)];
        if (i === j) continue;
        if (!candWinSet[order[j]].has(i)) continue;
        if (!swapAllowed(order, i, j)) continue;
        return { i, j };
      }
      return null;
    }

    // ── 目的関数: シード通り勝ち上がったときに実際に発生する試合のみ ──
    // 「当たりうる」全ペアではなく、各位置ペアが実際に対戦する N-1 試合だけを
    // rw(round) 重み付きで罰則評価する (試合は位置で固定、占有者の swap で中身が変わる)。
    // 各位置の対戦相手は O(log B) 個なので delta も O(log B)。
    // ppm = 事前計算のペア罰則行列 (optimize から共有。直接呼び出し時は構築)。
    const { uidIdx, ppm } = opts.pre || buildPairMatrix(seedOrder, pp);
    const pmw = projectedMatches(N, B).map((m) => ({ a: m.a, b: m.b, w: rw(m.round) }));
    const adjPos = Array.from({ length: N + 1 }, () => []);   // 位置(1始まり) → [{q, w}]
    for (const m of pmw) {
      adjPos[m.a].push({ q: m.b, w: m.w });
      adjPos[m.b].push({ q: m.a, w: m.w });
    }

    // 合成モード (combinePools): プール成分 (inter ペア罰則 + intra 回戦重み) も
    // delta / full スコアに含める。位置→プール/プール内スロットは静的。
    const combinePools = opts.combinePools === true && P >= 2;
    const runIntraPool = opts.runIntraPool !== false;
    const rwPool = roundWeightFn(params.roundWeights);
    let poolIdOf = null, wSlotOf = null, posByPool = null, poolRwm = null, poolB = null;
    if (combinePools) {
      poolIdOf = new Array(N); wSlotOf = new Array(N);
      posByPool = Array.from({ length: P }, () => []);
      poolRwm = new Array(P); poolB = new Array(P);
      const rwmCache = opts.rwmCache || {};
      for (let s = 0; s < N; s++) { const p = poolOfSeed(s, P); poolIdOf[s] = p; posByPool[p].push(s); }
      for (let p = 0; p < P; p++) {
        const Bp = nextPow2(posByPool[p].length);
        const sm = slotOfSeedMap(Bp);
        posByPool[p].forEach((s, r0) => { wSlotOf[s] = sm[r0 + 1]; });
        poolB[p] = Bp;
        poolRwm[p] = rwSlotMatrix(Bp, rwPool, rwmCache);
      }
    }
    // プール成分の delta: 位置 i の占有者 A→B / 位置 j の B→A による
    // 同プールペア罰則 (重み 1 + intra 回戦重み) の変化。同プール swap では
    // inter 成分 (重み1) が対称キャンセルし intra 成分だけが残る = intraDelta と等価。
    function poolDelta(order, i, j) {
      const ra = uidIdx[order[i]] * N, rb = uidIdx[order[j]] * N;
      let d = 0;
      const pi = poolIdOf[i], pj = poolIdOf[j];
      const mi = poolRwm[pi], bi = poolB[pi], wi = wSlotOf[i] * bi;
      for (const k of posByPool[pi]) {
        if (k === i || k === j) continue;
        const w = 1 + (runIntraPool ? mi[wi + wSlotOf[k]] : 0);
        const ic = uidIdx[order[k]];
        d += w * (ppm[rb + ic] - ppm[ra + ic]);
      }
      const mj = poolRwm[pj], bj = poolB[pj], wj = wSlotOf[j] * bj;
      for (const k of posByPool[pj]) {
        if (k === i || k === j) continue;
        const w = 1 + (runIntraPool ? mj[wj + wSlotOf[k]] : 0);
        const ic = uidIdx[order[k]];
        d += w * (ppm[ra + ic] - ppm[rb + ic]);
      }
      return d;
    }

    // Δ: 位置 i,j の占有者交換で変わるのは両位置の射影対戦の中身 (+合成時はプール成分)。
    function winnersDelta(order, _pools, i, j) {
      const ra = uidIdx[order[i]] * N, rb = uidIdx[order[j]] * N;
      let d = 0;
      for (const e of adjPos[i + 1]) {
        const k0 = e.q - 1;
        if (k0 === j) continue;                 // (i,j) 同士の対戦は swap 不変
        const ic = uidIdx[order[k0]];
        d += e.w * (ppm[rb + ic] - ppm[ra + ic]);   // 位置 i: A→B
      }
      for (const e of adjPos[j + 1]) {
        const k0 = e.q - 1;
        if (k0 === i) continue;
        const ic = uidIdx[order[k0]];
        d += e.w * (ppm[ra + ic] - ppm[rb + ic]);   // 位置 j: B→A
      }
      if (combinePools) d += poolDelta(order, i, j);
      if (orderOf) {
        const A = order[i], Bp = order[j];
        d += (orderOf(A, j + 1) + orderOf(Bp, i + 1)) - (orderOf(A, i + 1) + orderOf(Bp, j + 1));
      }
      return d;
    }
    function orderTotal(order) {
      if (!orderOf) return 0;
      let t = 0;
      for (let s = 0; s < N; s++) t += orderOf(order[s], s + 1);
      return t;
    }
    function winnersScoreFull(order) {
      let total = 0;
      for (const m of pmw) {
        total += m.w * ppm[uidIdx[order[m.a - 1]] * N + uidIdx[order[m.b - 1]]];
      }
      if (combinePools) {
        total += scoreInterFull(order, P, pp);
        if (runIntraPool) {
          for (const pool of poolsFromSeedOrder(order, P)) total += scoreIntraPoolFull(pool, pp, rwPool);
        }
      }
      return total + orderTotal(order);
    }
    function applySwap(order, _pools, i, j) {
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }

    return runSearch({
      state: seedOrder.slice(),
      makePools: null,
      scoreFull: winnersScoreFull,
      randomNeighbor,
      delta: winnersDelta,
      applySwap,
      params, rng, ctx, phaseName: 'winners',
    });
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
    let itersUsed = 0;   // 実際に回した近傍ステップ数 (全リスタート合算・early stop 込み)

    for (let k = 0; k < restarts; k++) {
      if (ctx.shouldStop && ctx.shouldStop()) break;
      // 初期解: k=0 は基準そのまま。k>0（または _perturbStart 指定時）は制約内ランダム swap で攪乱。
      // Worker 経由の多点は restarts=1 を繰り返すので _perturbStart で各リスタートの初期攪乱を制御する。
      let state = opt.state.slice();
      let pools = opt.makePools ? opt.makePools(state) : null;
      if (k > 0 || params._perturbStart) {
        // 攪乱強度 = stateSize × perturbScale (既定 1.0)。制約内 swap なので実効攪乱は
        // 受理された分のみ (perturbScale を上げると強く混ざる)。
        const perturb = Math.max(1, Math.floor(stateSize * (params.perturbScale != null ? params.perturbScale : 1.0)));
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
        itersUsed++;
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
          // iter/maxIters で「このフェーズの何%処理中か」を UI 側で出せる。
          ctx.onProgress({ phase: opt.phaseName, restart: k, iter, maxIters, score });
        }
      }
      if (!best || bestSeen < best.score - 1e-12) {
        best = { state: bestState, score: bestSeen };
      }
    }
    // ステップ統計 (= 進捗レポート用)。maxIters は全リスタート合算の上限。
    if (best) { best.iters = itersUsed; best.maxIters = maxIters * restarts; }
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
    // shiftLimitRanks: 指定 tier は 1 以上の数値かつ昇順 (逆転すると狭い tier が
    // 広い tier に無言で食われる) のみ許可。
    if (out.shiftLimitRanks != null) {
      if (!Array.isArray(out.shiftLimitRanks)) {
        throw new Error('shiftLimitRanks は配列または null にしてください。');
      }
      let prev = 0;
      out.shiftLimitRanks.forEach((v, k) => {
        if (v == null) return;
        if (typeof v !== 'number' || !isFinite(v) || v < 1) {
          throw new Error(`shiftLimitRanks[${k}] は 1 以上の数値か null にしてください。`);
        }
        if (v <= prev) {
          throw new Error('shiftLimitRanks の指定 tier は昇順にしてください (±' + k + ' の順位が前の tier 以下)。');
        }
        prev = v;
      });
    }
    // seedLocks: 値は 'pool' | 'wave' のみ。不正値が「無言で固定なし」にならないよう弾く。
    if (out.seedLocks != null) {
      if (typeof out.seedLocks !== 'object' || Array.isArray(out.seedLocks)) {
        throw new Error('seedLocks は {uid: "pool"|"wave"} のオブジェクトまたは null にしてください。');
      }
      let hasWaveLock = false;
      for (const uid of Object.keys(out.seedLocks)) {
        const v = out.seedLocks[uid];
        if (v !== 'pool' && v !== 'wave') {
          throw new Error(`seedLocks[${uid}] は 'pool' か 'wave' にしてください (現値: ${v})`);
        }
        if (v === 'wave') hasWaveLock = true;
      }
      if (hasWaveLock && out.poolWaves == null) {
        throw new Error("seedLocks の 'wave' 固定には poolWaves (プール→ウェーブ対応) が必要です。");
      }
    }
    // poolWaves: 0 以上の数値配列のみ (長さ = poolCount の検証は optimize 側)。
    if (out.poolWaves != null &&
        (!Array.isArray(out.poolWaves) || out.poolWaves.length === 0 ||
         out.poolWaves.some((w) => typeof w !== 'number' || !isFinite(w) || w < 0))) {
      throw new Error('poolWaves は 0 以上の数値配列または null にしてください。');
    }
    // keepDePlace は truthy 文字列等が「無言で無効」にならないよう boolean に正規化。
    out.keepDePlace = !!out.keepDePlace;
    out.winnersPoolRankLimit = !!out.winnersPoolRankLimit;
    // bracketScope の typo が「無言で pools 扱い」にならないよう明示的に弾く。
    if (out.bracketScope !== 'pools' && out.bracketScope !== 'winners') {
      throw new Error('未知の bracketScope: ' + out.bracketScope + " (対応: 'pools', 'winners')");
    }
    // winnersRoundWeights (勝者側成分の回戦重み上書き) は roundWeights と同じ規則で検証。
    if (out.winnersRoundWeights != null &&
        (!Array.isArray(out.winnersRoundWeights) || out.winnersRoundWeights.length === 0 ||
         out.winnersRoundWeights.some((w) => typeof w !== 'number' || !isFinite(w) || w < 0))) {
      throw new Error('winnersRoundWeights は 1 要素以上の非負数値配列にしてください。');
    }
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
  function fullReport(seedOrderBefore, seedOrderAfter, P, pp, params, runIntra, reportIntra, recentPair, recentMeta, seriesPair) {
    const rw = roundWeightFn(params.roundWeights);
    const prefByUid = params._prefByUid || {}, origRank = params._origRank || {};
    const pwFn = prefWeightFn(params.prefWeight);
    const Wr = params.W_region, Wn = params.W_recent, Wo = params.W_order || 0, oPow = params.orderPow != null ? params.orderPow : 1;
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
    // 同シリーズ上乗せ分（目的関数 pp と同じ判定。'add' は Ws×同シリーズ罰則、
    // 'mult' は Wn×再対戦罰則×(倍率−1)）。OFF なら常に 0。
    const seriesW = seriesPenaltyFn(params, recentPair || {}, seriesPair || {});
    // セル別（プール間/内 × 地域/直近）と order 罰則のスコアを計算。
    function poolScores(order) {
      const pools = poolsFromSeedOrder(order, P);
      let interRegion = 0, interRecent = 0, intraRegion = 0, intraRecent = 0;
      let interSeries = 0, intraSeries = 0;   // 内訳表示用（interRecent / intraRecent に含まれている分）
      for (const pool of pools) {
        const Bn = nextPow2(pool.length), sOf = slotOfSeedMap(Bn);
        for (let i = 0; i < pool.length; i++)
          for (let j = i + 1; j < pool.length; j++) {
            const a = pool[i], b = pool[j];
            const sw = seriesW(a, b);
            const rg = Wr * regionW(a, b), rc = Wn * recentW(a, b) + sw;
            interRegion += rg; interRecent += rc; interSeries += sw;
            if (runIntra) {
              const w = rw(earliestMeetRound(sOf[i + 1], sOf[j + 1]));
              intraRegion += w * rg; intraRecent += w * rc; intraSeries += w * sw;
            }
          }
      }
      let order_ = 0;
      if (Wo > 0) order.forEach((u, s) => { order_ += Wo * Math.pow(Math.abs((s + 1) - (origRank[u] || (s + 1))), oPow); });
      const inter = interRegion + interRecent, intra = intraRegion + intraRecent;
      const ret = { inter, intra, total: inter + intra, interRegion, interRecent, intraRegion, intraRecent,
                    interSeries, intraSeries, order: order_ };
      // 勝者側スコープ時は射影対戦 (シード通り実対戦) 成分も合算する。
      if (params._winnersWeights) {
        const rwW = roundWeightFn(params._winnersWeights);
        let winners = 0;
        for (const m of projectedMatches(order.length, nextPow2(order.length))) {
          const a = order[m.a - 1], b = order[m.b - 1];
          winners += rwW(m.round) * (Wr * regionW(a, b) + Wn * recentW(a, b));
        }
        ret.winners = winners;
        ret.total += winners;
      }
      return ret;
    }
    const before = poolScores(seedOrderBefore);
    const after = poolScores(seedOrderAfter);
    // P==1 は inter(プール所属ペア罰則)が最適化で不変の定数項なので、改善率は動かせる
    // 成分だけで計算する（総和だと希釈される）: 勝者側 P==1 は winners 成分、
    // pools P==1 は intra 成分、P>=2 は total。
    const pctBase = P === 1 ? (params._winnersWeights ? 'winners' : 'intra') : 'total';
    const improvementPct = before[pctBase] > 0
      ? (1 - after[pctBase] / before[pctBase]) * 100 : 0;

    // 残存懸念を「プール間（誰が同プールか・回戦非依存）」と
    // 「プール内（同プール内で早期回戦に当たるか・DE時のみ）」に分けて報告する。
    // 最適化前後の比較 UI 用に、同じ構造を before/after 双方の並びで計算する。
    const prefCounts = params._prefCounts || {};
    const earlyRound = params.earlyRoundThreshold || 3;   // 「早期回戦」の閾値
    const reportRecentMaxDays = params.reportRecentMaxDays != null ? params.reportRecentMaxDays : 182.5; // レポート表示は半年以内
    // 最多地域（報告から除外）。
    let mostPopRegion = null, _mp = -1;
    for (const r in prefCounts) { if (prefCounts[r] > _mp) { _mp = prefCounts[r]; mostPopRegion = r; } }

    function concernsFor(orderArr) {
    const poolsCur = poolsFromSeedOrder(orderArr, P);
    // 同プール全ペアを走査し、地域(少数派/多数派)・直近・最早回戦を集計。
    const sepByPref = {};   // プール間: 分離可能県(少数派)の同プール被り = 理想違反
    const majByPref = {};   // プール間: 多数派県(>P)の同プール被り数 = 鳩の巣で不可避
    const recentInter = []; // プール間: 同プール直近対戦ペア
    const recentIntra = []; // プール内: 早期回戦で当たる直近対戦ペア
    const intraEarlyMatchups = []; // プール内: 早期回戦で当たる同地域ペア（最多地域を除く）
    for (let pi = 0; pi < poolsCur.length; pi++) {
      const pool = poolsCur[pi];
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
                             lastNent: (meta && meta.lastNent != null) ? meta.lastNent : null,
                             // 対象シリーズでの対戦回数と最終日 (0 / null = 同シリーズでは未対戦)
                             seriesCount: (meta && meta.seriesCount) || 0,
                             seriesLastDate: (meta && meta.seriesLastDate) || null,
                             // 個別対戦履歴（UI のペア展開表示用。recentMeta に無い古い形式では null）
                             matches: (meta && Array.isArray(meta.matches)) ? meta.matches : null };
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

    // ⑤ 予選抜け後 (本戦想定): 全体を 1 つの勝者側 DE ブラケットとみなし、シード通り
    // 勝ち上がった場合に**実際に発生する試合** (projectedMatches, N-1 試合) のうち
    // earlyRound より後の回戦のものについて 直近対戦/同地域 ペアを列挙する。
    // プール構造とは独立 (別プールのペアも本戦で当たり得る) の見積もり。
    const postRecent = [], postRegion = [];
    {
      const Nn = orderArr.length;
      for (const m of projectedMatches(Nn, nextPow2(Nn))) {
        if (m.round <= earlyRound) continue;
        const a = orderArr[m.a - 1], b = orderArr[m.b - 1];
        const pa = params._prefByUid[a], pb = params._prefByUid[b];
        if (pa && pb && pa === pb && pa !== mostPopRegion) {
          postRegion.push({ a, b, seedA: m.a, seedB: m.b, round: m.round, region: pa, prefCount: prefCounts[pa] || 0 });
        }
        const rawRecent = (recentPair && recentPair[pairKey(a, b)]) || 0;
        if (rawRecent > 0) {
          const meta = recentMeta && recentMeta[pairKey(a, b)];
          const withinReport = !meta || meta.lastDeltaDays == null || meta.lastDeltaDays <= reportRecentMaxDays;
          if (withinReport) {
            postRecent.push({ a, b, seedA: m.a, seedB: m.b, round: m.round, recentPenalty: rawRecent,
                              lastDate: meta ? meta.lastDate : null, count: meta ? meta.count : null,
                              lastTournament: (meta && meta.lastTournament) || null,
                              lastNent: (meta && meta.lastNent != null) ? meta.lastNent : null,
                              seriesCount: (meta && meta.seriesCount) || 0,
                              seriesLastDate: (meta && meta.seriesLastDate) || null,
                              matches: (meta && Array.isArray(meta.matches)) ? meta.matches : null });
          }
        }
      }
      // 早い回戦 (= 予選抜け直後) 優先、同回戦は罰則/人数少ない地域を先に。
      postRecent.sort((x, y) => x.round - y.round || y.recentPenalty - x.recentPenalty);
      postRegion.sort((x, y) => x.round - y.round || x.prefCount - y.prefCount);
    }

    // 各プールの地域内訳（地域バランス表示用）。
    const poolComposition = poolsCur.map((pool) => {
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
        // プール間（誰が同プールか・回戦非依存）
        inter: {
          region: {
            poolComposition,    // 各プールの地域内訳（地域バランス）
            spread: regionSpread, // 地域ごとのプール間分布(min..max, ideal)
            separable: sepByPref, separablePairs: sum(sepByPref),   // 参考: 分散できるはずの被り
            majority: majByPref, majorityPairs: sum(majByPref),     // 参考: 人数多く回避不能
          },
          recent: { pairs: recentInter.length, top: recentInter.slice(0, 10),
                    // 同シリーズで既に当たっているペアの数 (罰則 ON/OFF に関係なく数える)
                    sameSeriesPairs: recentInter.filter((x) => x.seriesCount > 0).length,
                    sameSeriesTop: recentInter.filter((x) => x.seriesCount > 0).slice(0, 10) },
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
          recent: { pairs: recentIntra.length, top: recentIntra.slice(0, 10),
                    sameSeriesPairs: recentIntra.filter((x) => x.seriesCount > 0).length,
                    sameSeriesTop: recentIntra.filter((x) => x.seriesCount > 0).slice(0, 10) },
        } : null,
        // 予選抜け後 (本戦想定): 全体勝者側ブラケットで earlyRound より後に当たるペア。
        // シード通り進出した場合の見積もり (プール構造非依存)。
        postPool: {
          threshold: earlyRound,
          region: { pairs: postRegion.length, top: postRegion.slice(0, 20), excludedRegion: mostPopRegion },
          recent: { pairs: postRecent.length, top: postRecent.slice(0, 10),
                    sameSeriesPairs: postRecent.filter((x) => x.seriesCount > 0).length,
                    sameSeriesTop: postRecent.filter((x) => x.seriesCount > 0).slice(0, 10) },
        },
    };
    }  // concernsFor

    return {
      before, after, improvementPct,
      // 同シリーズ再マッチの対象シリーズ (null = 判定なし / 機能OFF)。UI の見出しに使う。
      targetSeries: params._targetSeries || null,
      seriesRematchOn: params.avoidSeriesRematch === true && params.avoidRecent !== false,
      residualConcerns: concernsFor(seedOrderAfter),
      // 最適化前の同構造 (UI の前後比較用)。
      residualConcernsBefore: concernsFor(seedOrderBefore),
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

    // モード別既定を適用（input.params が最優先）。
    const reqMode = (input.params && input.params.mode) || DEFAULT_PARAMS.mode;
    const params = resolveParams(Object.assign({}, MODE_DEFAULTS[reqMode] || {}, input.params));
    // poolWaves はプール数と同じ長さのみ (ズレると固定判定が黙って壊れる)。
    if (params.poolWaves != null && params.poolWaves.length !== P) {
      throw new Error(`poolWaves の長さ (${params.poolWaves.length}) が poolCount (${P}) と一致しません。`);
    }
    // 勝者側ブラケットスコープはプール構造を使わない（P は出力プール表示にのみ使用）。
    const winnersScope = params.bracketScope === 'winners';
    let gate = null;
    if (winnersScope) {
      if (input.format !== 'DOUBLE_ELIMINATION') {
        return { unsupported: true, reason: '勝者側ブラケット最適化はダブルイリミネーションのみ対応です。' };
      }
      if (!(P >= 1)) throw new Error('poolCount は 1 以上にしてください。');
      // 勝者側は「追加」フェーズ: P>=2 ではプール最適化 (inter/intra) を通常どおり
      // 実行した上で勝者側フェーズを重ねる。P==1 は勝者側のみ (プール構造が無いので
      // 「当たりうる」ベースの intra は使わず、シード通り実対戦だけを見る)。
      gate = (P >= 2) ? { runInter: true, runIntra: true } : { runInter: false, runIntra: false };
      // 全フェーズで DE 想定順位 (タイ帯) 不変をハード制約にする。
      params.keepDePlace = true;
      // 勝者側成分の回戦重み (プール成分の roundWeights とは独立)。
      const roundsW = Math.max(1, Math.round(Math.log2(nextPow2(N))));
      params._winnersWeights = (Array.isArray(params.winnersRoundWeights) && params.winnersRoundWeights.length)
        ? params.winnersRoundWeights : winnersRoundWeights(roundsW);
    } else {
      gate = gateFormat(P, input.format);
      if (gate.unsupported) return { unsupported: true, reason: gate.reason };
    }
    // プール内変動(intra)の実効可否。P>=2 のときだけ UI トグルで無効化できる。
    // P==1×DE は intra が唯一の被り回避なので常に実行する（トグル対象外）。
    const runIntra = gate.runIntra && !(P >= 2 && params.enableIntra === false);
    const rng = makeRng(params.rngSeed);
    const prefByUid = input.prefByUid || {};
    const prefCounts = input.prefCounts || derivePrefCounts(ranking, prefByUid);
    const recentPair = input.recentPair || {};
    params._prefByUid = prefByUid; // レポート用
    params._prefCounts = prefCounts; // レポート用（少数派/多数派の判定）
    const seriesPair = input.seriesPair || {};
    params._targetSeries = input.targetSeries || null;   // レポート表示用
    const pp = buildPairPenalty(params, prefByUid, prefCounts, recentPair, seriesPair);
    // 事前計算 (全フェーズ共有): ペア罰則行列 + 回戦重み行列キャッシュ (rwPool 用)。
    const pre = buildPairMatrix(ranking, pp);
    const rwmCache = {};

    // 元ランキングからのズレ罰則: シードが元順位から離れるほど少し罰する（形を保つ）。
    const origRank = {};
    ranking.forEach((u, i) => { origRank[u] = i + 1; });
    params._origRank = origRank; // レポート用
    const Wo = params.W_order || 0, oPow = params.orderPow != null ? params.orderPow : 1;
    const orderOf = Wo > 0
      ? (uid, seed1) => Wo * Math.pow(Math.abs(seed1 - origRank[uid]), oPow)
      : null;
    // プールごとのグローバルシード位置（intra の order 罰則用）。
    const globalSeedsByPool = [];
    for (let p = 0; p < P; p++) globalSeedsByPool.push([]);
    for (let s = 0; s < N; s++) globalSeedsByPool[poolOfSeed(s, P)].push(s);
    const seedOrderBefore = ranking.slice();
    // 探索開始点。既定 = ranking そのもの。input.initialSeedOrder で差し替え可
    // (多点スタートの初期化戦略用。ranking の permutation であること。制約判定・
    // order 罰則の基準 (origRank) はあくまで ranking)。
    let seedOrder = ranking.slice();
    if (input.initialSeedOrder != null) {
      const init = input.initialSeedOrder;
      if (!Array.isArray(init) || init.length !== N ||
          init.slice().sort().join(' ') !== ranking.slice().sort().join(' ')) {
        throw new Error('initialSeedOrder は ranking の permutation にしてください。');
      }
      seedOrder = init.slice();
    }
    let stoppedEarly = false;

    // 1) inter
    const searchStats = [];
    if (gate.runInter) {
      if (ctx.onProgress) ctx.onProgress({ phase: 'inter', stage: 'start' });
      const r = interOptimize(seedOrder, P, pp, params, rng, ctx, orderOf, pre);
      if (r) {
        seedOrder = r.state;
        searchStats.push({ phase: 'inter', iters: r.iters || 0, maxIters: r.maxIters || 0 });
      }
      if (ctx.onCheckpoint) ctx.onCheckpoint({ phase: 'inter', seedOrder: seedOrder.slice() });
      if (ctx.shouldStop && ctx.shouldStop()) stoppedEarly = true;
    }

    // 2) intra（プールごと独立）
    if (runIntra && !stoppedEarly) {
      const pools = poolsFromSeedOrder(seedOrder, P);
      for (let pi = 0; pi < pools.length; pi++) {
        if (ctx.shouldStop && ctx.shouldStop()) { stoppedEarly = true; break; }
        if (ctx.onProgress) ctx.onProgress({ phase: 'intra', pool: pi, stage: 'start' });
        const r = intraOptimizePool(pools[pi], pp, params, rng, ctx, String(pi), orderOf, globalSeedsByPool[pi], pre, rwmCache);
        if (r) {
          pools[pi] = r.state;
          searchStats.push({ phase: 'intra:' + pi, iters: r.iters || 0, maxIters: r.maxIters || 0 });
        }
        if (ctx.onCheckpoint) ctx.onCheckpoint({ phase: 'intra', pool: pi });
      }
      seedOrder = seedOrderFromPools(pools, P, N);
    }

    // 3) 勝者側フェーズ (winners スコープのみ・プール最適化の後に追加で実行)。
    //    delta にプール成分 (inter ペア罰則 + intra 回戦重み) も含めるので、
    //    プール分離を壊す移動は損として評価される (= 純追加の合成目的関数)。
    if (winnersScope && !stoppedEarly) {
      if (ctx.onProgress) ctx.onProgress({ phase: 'winners', stage: 'start' });
      const r = winnersOptimize(seedOrder, pp, params, rng, ctx, orderOf, P,
        { combinePools: P >= 2, runIntraPool: runIntra, pre: pre, rwmCache: rwmCache });
      if (r) {
        seedOrder = r.state;
        searchStats.push({ phase: 'winners', iters: r.iters || 0, maxIters: r.maxIters || 0 });
      }
      if (ctx.onCheckpoint) ctx.onCheckpoint({ phase: 'winners', seedOrder: seedOrder.slice() });
      if (ctx.shouldStop && ctx.shouldStop()) stoppedEarly = true;
    }

    const reportRunIntra = runIntra || (winnersScope && P === 1);
    const report = fullReport(seedOrderBefore, seedOrder, P, pp, params, reportRunIntra,
      gate.runIntra || winnersScope, recentPair, input.recentMeta, seriesPair);
    const poolsOut = poolsFromSeedOrder(seedOrder, P);

    return {
      seedOrder,
      pools: poolsOut,
      bracketByPool: (runIntra || winnersScope) ? poolsOut.map((x) => x.slice()) : null,
      report,
      stoppedEarly,
      ranAfter: Object.assign({ runInter: gate.runInter, runIntra: runIntra },
        winnersScope ? { runWinners: true } : {}),
      searchStats,
    };
  }

  const API = {
    optimize,
    // 個別関数（テスト・再利用）
    makeRng, randInt,
    poolOfSeed, rowOfSeed, seedSlotOrder, slotOfSeedMap, earliestMeetRound, nextPow2,
    dePlaceOfSeed, projectedMatches,
    buildPairPenalty, seriesPenaltyFn, derivePrefCounts, prefWeightFn, roundWeightFn, pairKey,
    scoreInterFull, scoreIntraPoolFull,
    poolsFromSeedOrder, seedOrderFromPools, gateFormat,
    kInterFn, kIntraFn, shiftCapFn, resolveParams, winnersOptimize, buildLockCheck,
    DEFAULT_PARAMS, MODE_DEFAULTS, winnersRoundWeights,
  };

  global.SeedOptimizer = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
