// html.js — HTML エスケープ (サイト共通)。以前は 16 ファイルにほぼ同じ関数がコピーされ、null の扱いと ' の
// エスケープが 3 通りに分かれていた。ここ 1 本に寄せる。ページはこの script を他より先に読む。
// 使い方: escapeHtml(s)  (グローバル。SPSPHtml.escapeHtml も同じ)。null / undefined は '' になる。
(function (global) {
  'use strict';
  var MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return MAP[c]; });
  }
  var api = { escapeHtml: escapeHtml };
  global.SPSPHtml = api;
  global.escapeHtml = escapeHtml;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
