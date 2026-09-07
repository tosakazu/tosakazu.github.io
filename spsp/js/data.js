// data.js — ビルド出力の読み込み (サイト共通)。以前は latest_tjpr_full.jsonl の行パースが 11 ページに、
// meta.json の取得が 8 ページにコピーされていた。
//   SPSPData.parseJsonl(text)  → 1 行 1 レコードの配列 (空行・壊れた行は飛ばす)
//   SPSPData.fetchJsonl(url)   → fetch + parseJsonl (HTTP エラーは throw)
//   SPSPData.fetchJson(url)    → fetch + json (HTTP エラーは throw)
//   SPSPData.fetchJsonOptional(url) → 無い/失敗なら null (任意データ用)
(function (global) {
  'use strict';
  function parseJsonl(text) {
    var out = [];
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln || !ln.trim()) continue;
      try { out.push(JSON.parse(ln)); } catch (e) { /* 壊れた行は飛ばす */ }
    }
    return out;
  }
  function fetchJsonl(url, init) {
    return fetch(url, init).then(function (r) {
      if (!r.ok) throw new Error(url + ' 取得失敗 (HTTP ' + r.status + ')');
      return r.text();
    }).then(parseJsonl);
  }
  function fetchJson(url, init) {
    return fetch(url, init).then(function (r) {
      if (!r.ok) throw new Error(url + ' 取得失敗 (HTTP ' + r.status + ')');
      return r.json();
    });
  }
  function fetchJsonOptional(url, init) {
    return fetch(url, init).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  var api = { parseJsonl: parseJsonl, fetchJsonl: fetchJsonl, fetchJson: fetchJson, fetchJsonOptional: fetchJsonOptional };
  global.SPSPData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
