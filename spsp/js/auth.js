// auth.js — セッション (ログイン) の保存と読み出し。DOM 非依存・純粋。
//   トークンの中身は GAS だけが検証できる (HMAC)。クライアント側は
//   有効期限の目安 (exp) と表示用のユーザー情報だけを扱う。
(function (global) {
  'use strict';

  var KEY = 'spsp_session_v1';

  /**
   * localStorage から読む。壊れている・期限切れなら消して null。
   * storage は環境により例外を投げるので全部 try で包む。
   */
  function load(storage) {
    var st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return null;
    var raw = null;
    try {
      raw = st.getItem(KEY);
    } catch (_) {
      return null;
    }
    if (!raw) return null;
    var s;
    try {
      s = JSON.parse(raw);
    } catch (_) {
      try { st.removeItem(KEY); } catch (_) { /* noop */ }
      return null;
    }
    if (!s || typeof s.token !== 'string' || !s.token || !s.user || !s.user.id) {
      try { st.removeItem(KEY); } catch (_) { /* noop */ }
      return null;
    }
    if (typeof s.exp === 'number' && Date.now() > s.exp) {
      try { st.removeItem(KEY); } catch (_) { /* noop */ }
      return null;
    }
    return s;
  }

  /** login レスポンス { token, user, exp } を保存する。 */
  function save(sess, storage) {
    var st = storage || localStorage;
    st.setItem(KEY, JSON.stringify({
      token: String(sess.token),
      user: {
        id: String(sess.user.id),
        slug: typeof sess.user.slug === 'string' ? sess.user.slug : '',
        gamerTag: typeof sess.user.gamerTag === 'string' ? sess.user.gamerTag : '',
      },
      exp: typeof sess.exp === 'number' ? sess.exp : null,
    }));
  }

  function clear(storage) {
    var st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return;
    try { st.removeItem(KEY); } catch (_) { /* noop */ }
  }

  /** 表示名 (gamerTag > slug > uid)。 */
  function displayName(sess) {
    if (!sess || !sess.user) return '';
    return sess.user.gamerTag || sess.user.slug || String(sess.user.id);
  }

  var API = { KEY: KEY, load: load, save: save, clear: clear, displayName: displayName };
  global.SpspAuth = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
