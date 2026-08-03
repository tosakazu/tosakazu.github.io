// seed_worker.js — seed_optimizer.js を Web Worker 内で実行するグルー。
//   - メイン→Worker: {type:'start', input} / {type:'stop'}
//   - Worker→メイン: {type:'progress'|'checkpoint'|'done'|'error', ...}
// 多点スタートは worker 側でループ化し、各リスタート間で setTimeout イールドして
// 'stop' メッセージを処理できるようにする（計算は別スレッドなのでメインUIは常に応答）。
// gh-pages では COOP/COEP ヘッダが設定できず SharedArrayBuffer が使えないための設計。

/* global importScripts, SeedOptimizer */
importScripts('seed_optimizer.js');

let stopRequested = false;
let running = false;

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === 'stop') {
    // 注意: optimize() は同期実行のため、停止が効くのは「現在のリスタート完了後」
    // （リスタート間の setTimeout イールドでこのハンドラが走る）。restarts=1 の
    // 単発モードでは実質完走まで止まらない。UI 側はその旨を表示すること。
    stopRequested = true;
    self.postMessage({ type: 'progress', stage: 'stop-requested' });
    return;
  }
  if (msg.type === 'start') {
    if (running) return;
    run(msg.input).catch((err) => {
      self.postMessage({ type: 'error', message: String(err && err.stack || err) });
      running = false;
    });
  }
};

async function run(input) {
  running = true;
  stopRequested = false;
  let lastProgressTs = 0;   // iter 進捗のスロットリング用

  const baseMode = (input.params && input.params.mode) || input.mode || 'multistart-sa';
  const isMulti = baseMode.indexOf('multistart') === 0;
  const innerMode = isMulti ? baseMode.replace('multistart-', '') : baseMode;
  // restarts 既定は optimizer の MODE_DEFAULTS と揃える（以前は 8 固定でベンチと乖離）。
  const modeDefaults = (SeedOptimizer.MODE_DEFAULTS || {})[baseMode] || {};
  const restarts = isMulti
    ? Math.max(1, (input.params && input.params.restarts) || modeDefaults.restarts || 8) : 1;
  const baseSeed = (input.params && input.params.rngSeed) || 12345;

  let best = null;

  for (let k = 0; k < restarts; k++) {
    if (stopRequested) break;
    // 各リスタートは「同じ良い初期解(ランキングsnake)＋乱数シード違いのSA」。
    // 初期攪乱(_perturbStart)はベンチで逆に悪化したため使わない（良い出発点を維持する方が強い）。
    const inp = Object.assign({}, input, {
      params: Object.assign({}, input.params, {
        mode: innerMode, restarts: 1, rngSeed: baseSeed + k * 97,
      }),
    });
    const res = SeedOptimizer.optimize(inp, {
      // iter 進捗は 100ms にスロットリング (事前計算高速化で素の頻度は ~1ms 毎になった)。
      // stage 付き (phase 開始等) はそのまま通す。
      onProgress: (p) => {
        if (p.stage == null && p.iter != null) {
          const now = Date.now();
          if (now - lastProgressTs < 100) return;
          lastProgressTs = now;
        }
        self.postMessage(Object.assign({ type: 'progress', round: k, restarts }, p));
      },
      shouldStop: () => stopRequested,
    });

    // 非対応形式（1プール×非DE）はそのまま返して終了。
    if (res && res.unsupported) {
      self.postMessage({ type: 'done', result: res });
      running = false;
      return;
    }
    // ベスト選択: 分離スコア(after.total)優先、同点なら order 罰則（元順位からのズレ）が
    // 小さい方。被り全解消(total=0)が複数リスタートで出たとき無駄にシャッフルされた解を
    // 先勝ちで返さないため。
    const better = !best ||
      res.report.after.total < best.report.after.total - 1e-12 ||
      (Math.abs(res.report.after.total - best.report.after.total) <= 1e-12 &&
       (res.report.after.order || 0) < (best.report.after.order || 0) - 1e-12);
    if (better) best = res;

    self.postMessage({
      type: 'checkpoint', round: k, restarts,
      bestScore: best.report.after.total,
      beforeScore: best.report.before.total,
      seedOrder: best.seedOrder,
      // このラウンドのステップ統計 (phase 別 iters/maxIters)。UI で % 表示に使う。
      roundStats: res.searchStats || null,
      // 中間レポート: ここまでのベスト解の完全な結果 (レポート/プール込み)。
      // UI はこれで各ラウンド終了時に中間レポートを描画できる。
      intermediate: best,
    });
    // イールドして 'stop' メッセージを処理可能にする。
    await new Promise((r) => setTimeout(r, 0));
  }

  if (best) {
    best.stoppedEarly = best.stoppedEarly || stopRequested;
    self.postMessage({ type: 'done', result: best });
  } else {
    self.postMessage({ type: 'error', message: 'no result' });
  }
  running = false;
}
