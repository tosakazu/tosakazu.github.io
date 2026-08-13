// oauth_state.js — 投稿フローの純粋ロジック (DOM / fetch 非依存)。
//   - post.js (発行側) と callback.js (検証側) の両方から読む。encode/decode が
//     食い違うと認証が通らなくなるので、必ず 1 か所に置く。
//   - Node からも require できる (tests/post/*.cjs)。
(function (global) {
  'use strict';

  var NONCE_KEY = 'spsp_oauth_nonce';
  var DRAFT_KEY = 'spsp_draft';

  // ── base64url (UTF-8 安全) ──
  // state は URL のクエリに載るので、+ / = を含まない base64url を使う。

  function encodeBase64Url(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeBase64Url(s) {
    var b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /** { n: nonce, r: 戻り先パス } → state 文字列。 */
  function encodeState(obj) {
    return encodeBase64Url(JSON.stringify({ n: String(obj.n), r: String(obj.r) }));
  }

  /** state 文字列 → { n, r }。壊れていれば null (呼び出し側は認証エラー扱い)。 */
  function decodeState(s) {
    if (typeof s !== 'string' || !s) return null;
    var o;
    try {
      o = JSON.parse(decodeBase64Url(s));
    } catch (_) {
      return null;
    }
    if (!o || typeof o !== 'object') return null;
    if (typeof o.n !== 'string' || !o.n) return null;
    return { n: o.n, r: typeof o.r === 'string' ? o.r : '' };
  }

  /**
   * INV-7: 戻り先は `/spsp/` 配下の相対パスのみ許可する。
   * 絶対 URL・スキーム付き・プロトコル相対 (`//`)・`..` を含むものは拒否し、
   * `/spsp/index.html` を返す。
   */
  function safeReturnPath(r, base) {
    var b = base || '/spsp/';
    var fallback = b + 'index.html';
    if (typeof r !== 'string' || !r) return fallback;
    // 制御文字・空白混じりは弾く (改行での細工を含む)
    if (/[\x00-\x20\x7f]/.test(r)) return fallback;
    if (r.indexOf(b) !== 0) return fallback;      // /spsp/ で始まること = 相対でも絶対 URL でもない
    if (r.indexOf('//') === 0) return fallback;   // プロトコル相対
    if (r.indexOf(':') !== -1) return fallback;   // スキーム付き
    if (r.indexOf('\\') !== -1) return fallback;
    if (r.split('/').indexOf('..') !== -1) return fallback;
    return r;
  }

  /** 戻り先に ?posted=1 を付ける (既存のクエリを壊さない)。 */
  function withPosted(path) {
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'posted=1';
  }

  /**
   * 本文の検証。GAS 側 sanitizeBody_ / handlePost_ と同じ規則。
   * { ok: true, body } / { ok: false, message } を返す。
   */
  function validateBody(raw, max) {
    var limit = max || 1000;
    var t = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    var out = '';
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if (c === 9 || c === 10) { out += t.charAt(i); continue; }
      if (c < 32) continue;
      if (c >= 127 && c <= 159) continue;
      out += t.charAt(i);
    }
    out = out.trim();
    if (!out.length) return { ok: false, message: '本文を入力してください。' };
    if (out.length > limit) {
      return { ok: false, message: '本文が長すぎます (' + limit + '文字まで)。' };
    }
    return { ok: true, body: out };
  }

  /** 認可 URL を組み立てる。redirect_uri は必ず encode する。 */
  function buildAuthorizeUrl(cfg, state) {
    var q = [
      'response_type=code',
      'client_id=' + encodeURIComponent(cfg.CLIENT_ID),
      'scope=' + encodeURIComponent(cfg.SCOPE),
      'redirect_uri=' + encodeURIComponent(cfg.REDIRECT_URI),
      'state=' + encodeURIComponent(state),
    ].join('&');
    return cfg.AUTHORIZE_URL + '?' + q;
  }

  /** 設定のプレースホルダ置き換え漏れを検出する。未設定キーの配列を返す。 */
  function missingConfig(cfg) {
    var out = [];
    ['CLIENT_ID', 'GAS_ENDPOINT'].forEach(function (k) {
      var v = cfg && cfg[k];
      if (!v || String(v).indexOf('{{') === 0) out.push(k);
    });
    return out;
  }

  /** 正規の配信元 (GitHub Pages) にいるか。spsp.games 等では false。 */
  function isCanonicalOrigin(cfg, origin) {
    return String(origin) === String(cfg.CANONICAL_ORIGIN);
  }

  var API = {
    NONCE_KEY: NONCE_KEY,
    DRAFT_KEY: DRAFT_KEY,
    encodeState: encodeState,
    decodeState: decodeState,
    safeReturnPath: safeReturnPath,
    withPosted: withPosted,
    validateBody: validateBody,
    buildAuthorizeUrl: buildAuthorizeUrl,
    missingConfig: missingConfig,
    isCanonicalOrigin: isCanonicalOrigin,
    // テスト用
    encodeBase64Url: encodeBase64Url,
    decodeBase64Url: decodeBase64Url,
  };

  global.SpspOAuthState = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
