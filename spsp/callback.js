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
  var AUTH = window.SpspAuth;

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
      // 戻り先は投票 / 投稿の 2 種類。ラベルが実際の遷移先と食い違わないようにする。
      a.textContent = (backPath.indexOf('vote') >= 0)
        ? 'キャラ投票ページに戻る' : '投稿ページに戻る';
      root.appendChild(a);
    }
  }

  /**
   * 認証前の失敗はここでしか観測できない (GAS を通らない) ので、記録だけ送る。
   * 送るのは種別と短い手掛かりのみ。code / token は絶対に載せない。
   */
  function reportError(kind, note) {
    try {
      if (!CFG || !CFG.GAS_ENDPOINT) return;
      fetch(CFG.GAS_ENDPOINT, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'client_error', flow: 'callback', kind: kind, note: note || '',
        }),
      }).catch(function () { /* 記録できなくても画面は出す */ });
    } catch (_) { /* 同上 */ }
  }

  /** start.gg が返した OAuth エラーを、利用者が次にとれる行動に翻訳する。 */
  function describeOAuthError(code, desc) {
    var base;
    switch (code) {
      case 'invalid_scope':
      case 'unauthorized_client':
      case 'invalid_client':
        base = 'SPSP 側のアプリ設定に問題がある可能性があります。運営にご連絡ください。';
        break;
      case 'server_error':
      case 'temporarily_unavailable':
        base = 'start.gg 側が一時的に応答できない状態です。時間をおいてやり直してください。';
        break;
      case 'invalid_request':
        base = '認証のリクエストが正しく組み立てられませんでした。'
          + 'URL を直接開いた場合に起きます。投票ページの認証ボタンからやり直してください。';
        break;
      default:
        base = 'start.gg から「' + code + '」という応答が返りました。'
          + '時間をおいてやり直しても直らない場合は、この表示を添えて運営にご連絡ください。';
    }
    // start.gg が説明文を付けてきたときは併記する (原因の特定に役立つため)
    return desc ? base + '\n\n(start.gg からの説明: ' + desc + ')' : base;
  }

  function run() {
    // ── 1. 取得 ──
    var params = new URLSearchParams(location.search);
    var code = params.get('code');
    var state = params.get('state');
    var oauthError = params.get('error');
    var oauthErrorDesc = params.get('error_description');

    // ── 2. INV-6: 何をするより先に URL から code を消す ──
    history.replaceState(null, '', location.pathname);

    var backDefault = CFG.CANONICAL_BASE + 'post.html';

    if (oauthError) {
      // start.gg が返す error は OAuth 2.0 の標準コード。
      // 「キャンセル」以外もここに来るので、素通しで一括りにしない。
      if (oauthError === 'access_denied') {
        reportError('oauth_denied', S.browserTag(navigator.userAgent));
        show('error', '認証がキャンセルされました',
          'start.gg の画面で「許可しない」を選んだか、認証を途中でやめた場合に表示されます。'
          + 'もう一度試す場合は、start.gg の画面で「Authorize (許可)」を押してください。',
          backDefault);
      } else {
        reportError('oauth_error', String(oauthError).slice(0, 60));
        show('error', 'start.gg 側で認証を完了できませんでした',
          describeOAuthError(oauthError, oauthErrorDesc), backDefault);
      }
      return;
    }
    if (!code || !state) {
      reportError('no_code', 'code=' + (code ? 'y' : 'n') + ' state=' + (state ? 'y' : 'n')
        + ' ' + S.browserTag(navigator.userAgent));
      show('error', '認証エラー',
        'start.gg から認証情報が返ってきませんでした。'
        + 'URL を直接開いた場合や、ブラウザの「戻る」で認証画面に戻った場合に起きます。'
        + '投票ページの認証ボタンからやり直してください。', backDefault);
      return;
    }

    // ── 3. state 検証 (nonce)。ここで弾いたら GAS には一切送らない ──
    var st = S.decodeState(state);
    // 単回使用。ここで取り出したら保存側は消える (成功時の removeItem は不要)。
    var stored = S.takeNonce();

    if (!st || !stored || st.n !== stored) {
      var tag = S.browserTag(navigator.userAgent);
      reportError(!stored ? 'state_missing' : 'state_mismatch', tag);
      show('error', '認証エラー',
        !stored
          ? '認証を始めたときの情報が、このブラウザに残っていませんでした。\n\n'
            + '多いのは、X や Discord のアプリの中のブラウザから始めた場合です。'
            + '認証の途中で start.gg のアプリに移り、そのあと通常の Safari / Chrome に'
            + '戻ってくるため、始めたブラウザと戻ったブラウザが別物になり、'
            + '照合できなくなります。\n\n'
            + 'お手数ですが、Safari や Chrome を自分で開き、'
            + 'そこで投票ページを開き直してから認証してください。'
            + '(このほか、プライベートブラウズや、認証画面を長時間放置した場合にも起きます)'
          : '認証の照合に失敗しました。安全のため中断しました。'
            + '心当たりがなければ、もう一度最初からやり直してください。',
        backDefault);
      return;
    }

    var back = S.safeReturnPath(st.r, CFG.CANONICAL_BASE); // INV-7

    // フローの種別 (post = 投稿 / login = ログインだけしてページに戻る)。
    // 読んだらすぐ消す (放置すると次の別フローに紛れ込む)。
    var intent = null;
    try {
      intent = sessionStorage.getItem(S.INTENT_KEY);
      sessionStorage.removeItem(S.INTENT_KEY);
    } catch (_) { /* intent は null のまま */ }

    var missing = S.missingConfig(CFG);
    if (missing.length) {
      show('error', '設定エラー',
        'この機能はまだ設定が完了していません。運営にご連絡ください。', back);
      return;
    }

    if (intent === 'login') {
      runLogin(code, back);
      return;
    }

    // ── 4. 下書き (post フロー) ──
    var body = null;
    try {
      body = sessionStorage.getItem(S.DRAFT_KEY);
    } catch (_) { /* body は null のまま */ }

    if (!body) {
      show('error', '下書きが見つかりません',
        '投稿する本文が残っていません。投稿ページからやり直してください。', back);
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
        try { sessionStorage.removeItem(S.DRAFT_KEY); } catch (_) { /* 消せなくても遷移する */ }
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

  /**
   * login フロー: code をセッショントークンに替えて localStorage に保存し、
   * 元のページに ?login=1 で戻る。シートには何も書かれない。
   */
  function runLogin(code, back) {
    fetch(CFG.GAS_ENDPOINT, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login', code: code }),
    }).then(function (res) {
      return res.json();
    }).then(function (json) {
      if (json && json.ok && json.token && json.user) {
        AUTH.save({ token: json.token, user: json.user, exp: json.exp });
        location.replace(S.withFlag(back, 'login'));
        return;
      }
      var msg = (json && json.error && json.error.message)
        ? json.error.message
        : '認証に失敗しました。';
      // server 側にも残るが、どの経路で来たかを見るために種別だけ添える
      reportError('login_failed', (json && json.error && json.error.code) || 'unknown');
      show('error', 'ログインできませんでした', msg, back);
    }).catch(function () {
      reportError('network', 'login fetch failed');
      show('error', 'ログインできませんでした',
        '通信に失敗しました。時間をおいてやり直してください。', back);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
