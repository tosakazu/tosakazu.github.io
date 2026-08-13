// callback.js — start.gg からの戻り先。処理順は設計書 §5.2 のとおり厳守する。
//
//   1. code / state を読む
//   2. すぐ URL からクエリを消す (INV-6)
//   3. state の nonce を検証。不一致なら GAS に送らない
//   4. 下書きを取り出す
//   5. GAS に POST
//   6. 成否に応じて戻る
//
// このファイルとページには外部リソースを一切足さないこと (INV-8)。
// nav.js は Google Analytics を読み込むので、ここでは**読まない**。
(function () {
  'use strict';

  var CFG = window.SPSP_POST_CONFIG;
  var S = window.SpspOAuthState;

  function show(kind, title, detail, backPath) {
    var root = document.getElementById('cb-root');
    root.className = 'cb ' + kind;

    var h = document.createElement('p');
    h.className = 'cb-title';
    h.textContent = title;

    root.textContent = '';
    root.appendChild(h);

    if (detail) {
      var d = document.createElement('p');
      d.className = 'cb-detail';
      d.textContent = detail; // textContent なので本文由来の文字列でも安全
      root.appendChild(d);
    }
    if (backPath) {
      var a = document.createElement('a');
      a.className = 'cb-back';
      a.href = backPath;
      a.textContent = '投稿ページに戻る';
      root.appendChild(a);
    }
  }

  function run() {
    // ── 1. 取得 ──
    var params = new URLSearchParams(location.search);
    var code = params.get('code');
    var state = params.get('state');
    var oauthError = params.get('error');

    // ── 2. INV-6: 何をするより先に URL から code を消す ──
    history.replaceState(null, '', location.pathname);

    var backDefault = CFG.CANONICAL_BASE + 'post.html';

    if (oauthError) {
      show('error', '認証がキャンセルされました', null, backDefault);
      return;
    }
    if (!code || !state) {
      show('error', '認証エラー', '認証情報が不足しています。もう一度お試しください。', backDefault);
      return;
    }

    // ── 3. state 検証 (nonce)。ここで弾いたら GAS には一切送らない ──
    var st = S.decodeState(state);
    var stored = null;
    try {
      stored = sessionStorage.getItem(S.NONCE_KEY);
    } catch (_) { /* stored は null のまま */ }

    if (!st || !stored || st.n !== stored) {
      show('error', '認証エラー',
        '認証の照合に失敗しました。投稿ページからやり直してください。', backDefault);
      return;
    }

    var back = S.safeReturnPath(st.r, CFG.CANONICAL_BASE); // INV-7

    // ── 4. 下書き ──
    var body = null;
    try {
      body = sessionStorage.getItem(S.DRAFT_KEY);
    } catch (_) { /* body は null のまま */ }

    if (!body) {
      show('error', '下書きが見つかりません',
        '投稿する本文が残っていません。投稿ページからやり直してください。', back);
      return;
    }

    var missing = S.missingConfig(CFG);
    if (missing.length) {
      show('error', '設定エラー', '投稿機能はまだ設定されていません。', back);
      return;
    }

    // ── 5. GAS へ ──
    // Content-Type: text/plain は CORS preflight を避けるため (GAS は
    // preflight に応答できない)。GAS はリダイレクト経由で応答するので follow。
    fetch(CFG.GAS_ENDPOINT, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'post', code: code, body: body }),
    }).then(function (res) {
      return res.json();
    }).then(function (json) {
      // ── 6. 成否 ──
      if (json && json.ok) {
        try {
          sessionStorage.removeItem(S.NONCE_KEY);
          sessionStorage.removeItem(S.DRAFT_KEY);
        } catch (_) { /* 消せなくても遷移する */ }
        location.replace(S.withPosted(back));
        return;
      }
      var msg = (json && json.error && json.error.message)
        ? json.error.message
        : '投稿に失敗しました。';
      // 下書きは残したまま戻す (書き直さずに再試行できる)
      show('error', '投稿できませんでした', msg, back);
    }).catch(function () {
      show('error', '投稿できませんでした',
        '通信に失敗しました。時間をおいてやり直してください。', back);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
