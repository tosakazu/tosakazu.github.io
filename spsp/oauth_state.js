// oauth_state.js — 投稿フローの純粋ロジック (DOM / fetch 非依存)。
//   - post.js (発行側) と callback.js (検証側) の両方から読む。encode/decode が
//     食い違うと認証が通らなくなるので、必ず 1 か所に置く。
//   - Node からも require できる (tests/post/*.cjs)。
(function (global) {
  'use strict';

  var NONCE_KEY = 'spsp_oauth_nonce';
  // nonce を localStorage にも置くときのキーと有効期限。
  //
  // sessionStorage は **タブ (browsing context) ごと** に分かれる。start.gg から
  // 戻るときに別タブ / 別 webview で開かれると、認証を始めたタブの
  // sessionStorage は読めず「照合情報が無い」で必ず失敗する。
  // X や Discord のアプリ内ブラウザでは実際にこれが起きていた
  // (2026-08-16 の失敗ログ 17 件中 11 件が state_missing)。
  //
  // localStorage はタブをまたいで共有されるのでこれを回避できる。
  // CSRF 防止の要点は「攻撃者が値を知らない・仕込めない」ことで、
  // localStorage も同一オリジンからしか触れないため保護は保たれる。
  // 取り違えを防ぐため **使ったら必ず消す** + 期限切れは無効にする。
  var NONCE_LS_KEY = 'spsp_oauth_nonce_ls';
  var NONCE_TTL_MS = 15 * 60 * 1000;
  var DRAFT_KEY = 'spsp_draft';
  // 認可から戻ったとき callback が何をするか ('post' | 'login')。
  // 無ければ 'post' (後方互換)。callback は読み取り後すぐ消す。
  var INTENT_KEY = 'spsp_oauth_intent';

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

  /** 戻り先に ?<flag>=1 を付ける (既存のクエリを壊さない)。 */
  function withFlag(path, flag) {
    return path + (path.indexOf('?') === -1 ? '?' : '&') + flag + '=1';
  }

  /** 戻り先に ?posted=1 を付ける。 */
  function withPosted(path) {
    return withFlag(path, 'posted');
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
  // ── nonce の保存 / 取り出し ──
  // 読み書きは storage が使えない環境 (プライベートブラウズ等) でも落とさない。

  function saveNonce(nonce, now) {
    var t = (now === undefined) ? Date.now() : now;
    try { sessionStorage.setItem(NONCE_KEY, nonce); } catch (_) { /* 続行 */ }
    try {
      localStorage.setItem(NONCE_LS_KEY, JSON.stringify({ n: nonce, t: t }));
    } catch (_) { /* 続行 */ }
  }

  /**
   * 保存した nonce を取り出して消す (単回使用)。
   * 同一タブなら sessionStorage、別タブに飛ばされていたら localStorage から拾う。
   * 期限切れは無効として null を返す。
   */
  function takeNonce(now) {
    var t = (now === undefined) ? Date.now() : now;
    var v = null;
    try { v = sessionStorage.getItem(NONCE_KEY); } catch (_) { /* 次を試す */ }
    var ls = null;
    try { ls = localStorage.getItem(NONCE_LS_KEY); } catch (_) { /* 無視 */ }
    if (!v && ls) {
      try {
        var o = JSON.parse(ls);
        if (o && typeof o.n === 'string' && typeof o.t === 'number'
            && (t - o.t) >= 0 && (t - o.t) <= NONCE_TTL_MS) {
          v = o.n;
        }
      } catch (_) { /* 壊れていれば無効 */ }
    }
    clearNonce();
    return v || null;
  }

  function clearNonce() {
    try { sessionStorage.removeItem(NONCE_KEY); } catch (_) { /* noop */ }
    try { localStorage.removeItem(NONCE_LS_KEY); } catch (_) { /* noop */ }
  }

  // ── アプリ内ブラウザの判定 ──
  //
  // X / Discord などのアプリ内ブラウザで認証を始めると、start.gg アプリに
  // 遷移したあと **通常の Safari** に戻ってくることがある (2026-08-17 実機確認)。
  // このときブラウザ自体が変わるので、sessionStorage も localStorage も
  // 引き継がれず必ず失敗する。保存領域の共有では解決できないため、
  // 事前に気づいてもらうための判定。
  //
  // UA は自己申告で完全な判定はできない。あくまで案内を出すための目安として使い、
  // これで認証を止めることはしない。
  var INAPP_PATTERNS = [
    { re: /Twitter|TwitterAndroid/i, name: 'X' },
    { re: /FBAN|FBAV|FB_IAB/i, name: 'Facebook' },
    { re: /Instagram/i, name: 'Instagram' },
    { re: /Line\//i, name: 'LINE' },
    { re: /Discord/i, name: 'Discord' }
  ];

  /** アプリ内ブラウザらしければ名前、そうでなければ null。 */
  function inAppBrowser(ua) {
    var u = String(ua || '');
    for (var i = 0; i < INAPP_PATTERNS.length; i++) {
      if (INAPP_PATTERNS[i].re.test(u)) return INAPP_PATTERNS[i].name;
    }
    return null;
  }

  /** 失敗ログ用の粗いブラウザ種別 (個人特定に使えない粒度に留める)。 */
  function browserTag(ua) {
    var app = inAppBrowser(ua);
    if (app) return 'inapp:' + app;
    var u = String(ua || '');
    if (/CriOS/i.test(u)) return 'ios-chrome';
    if (/iPhone|iPad|iPod/i.test(u)) return 'ios-safari';
    if (/Android/i.test(u)) return 'android';
    return 'other';
  }

  function isCanonicalOrigin(cfg, origin) {
    return String(origin) === String(cfg.CANONICAL_ORIGIN);
  }

  var API = {
    NONCE_KEY: NONCE_KEY,
    NONCE_LS_KEY: NONCE_LS_KEY,
    NONCE_TTL_MS: NONCE_TTL_MS,
    saveNonce: saveNonce,
    takeNonce: takeNonce,
    clearNonce: clearNonce,
    DRAFT_KEY: DRAFT_KEY,
    INTENT_KEY: INTENT_KEY,
    encodeState: encodeState,
    decodeState: decodeState,
    safeReturnPath: safeReturnPath,
    withFlag: withFlag,
    withPosted: withPosted,
    validateBody: validateBody,
    buildAuthorizeUrl: buildAuthorizeUrl,
    missingConfig: missingConfig,
    isCanonicalOrigin: isCanonicalOrigin,
    inAppBrowser: inAppBrowser,
    browserTag: browserTag,
    // テスト用
    encodeBase64Url: encodeBase64Url,
    decodeBase64Url: decodeBase64Url,
  };

  global.SpspOAuthState = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
