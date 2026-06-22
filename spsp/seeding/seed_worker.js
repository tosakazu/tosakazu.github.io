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
  if (msg.type === 'stop') { stopRequested = true; return; }
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

  const baseMode = (input.params && input.params.mode) || input.mode || 'multistart-sa';
  const isMulti = baseMode.indexOf('multistart') === 0;
  const innerMode = isMulti ? baseMode.replace('multistart-', '') : baseMode;
  const restarts = isMulti ? Math.max(1, (input.params && input.params.restarts) || 8) : 1;
  const baseSeed = (input.params && input.params.rngSeed) || 12345;

  let best = null;

  for (let k = 0; k < restarts; k++) {
    if (stopRequested) break;
    const inp = Object.assign({}, input, {
      params: Object.assign({}, input.params, {
        mode: innerMode, restarts: 1, rngSeed: baseSeed + k * 97,
      }),
    });
    const res = SeedOptimizer.optimize(inp, {
      onProgress: (p) => self.postMessage(Object.assign({ type: 'progress', round: k, restarts }, p)),
      shouldStop: () => stopRequested,
    });

    // 非対応形式（1プール×非DE）はそのまま返して終了。
    if (res && res.unsupported) {
      self.postMessage({ type: 'done', result: res });
      running = false;
      return;
    }
    if (!best || res.report.after.total < best.report.after.total - 1e-12) best = res;

    self.postMessage({
      type: 'checkpoint', round: k, restarts,
      bestScore: best.report.after.total,
      beforeScore: best.report.before.total,
      seedOrder: best.seedOrder,
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
