// post.js — 投稿フォーム。本文を退避して start.gg の認可へ飛ばす。
(function () {
  'use strict';

  var CFG = window.SPSP_POST_CONFIG;
  var S = window.SpspOAuthState;

  var $ = function (id) { return document.getElementById(id); };

  var els = {};

  function setStatus(kind, msg) {
    var box = els.status;
    box.className = 'status ' + kind;
    box.textContent = msg;
    box.hidden = !msg;
  }

  function updateCount() {
    var n = els.body.value.length;
    els.count.textContent = n + ' / ' + CFG.BODY_MAX;
    els.count.classList.toggle('over', n > CFG.BODY_MAX);
  }

  /**
   * 投稿。sessionStorage に本文と nonce を置いてから認可へリダイレクトする。
   * 戻り先 (state.r) は現在のパス + クエリ。callback 側で INV-7 の検証を通す。
   */
  function onSubmit() {
    setStatus('', '');

    var missing = S.missingConfig(CFG);
    if (missing.length) {
      setStatus('error', '投稿機能はまだ設定されていません (' + missing.join(', ') + ')。');
      return;
    }

    // 正規の配信元以外 (検証・ビルド用の配信) では認可を始めない。
    // redirect_uri が GitHub Pages 固定なので、始めても sessionStorage が
    // 別オリジンになって必ず失敗する。
    if (!S.isCanonicalOrigin(CFG, location.origin)) {
      setStatus('error', '投稿はこのURLからは行えません。');
      els.canonical.hidden = false;
      return;
    }

    var v = S.validateBody(els.body.value, CFG.BODY_MAX);
    if (!v.ok) {
      setStatus('error', v.message);
      return;
    }

    var nonce;
    try {
      nonce = crypto.randomUUID();
    } catch (_) {
      setStatus('error', 'お使いのブラウザでは投稿できません。');
      return;
    }

    try {
      sessionStorage.setItem(S.NONCE_KEY, nonce);
      sessionStorage.setItem(S.DRAFT_KEY, v.body);
    } catch (_) {
      setStatus('error', 'ブラウザの保存領域が使えないため投稿できません (プライベートモード等)。');
      return;
    }

    var state = S.encodeState({ n: nonce, r: location.pathname + location.search });
    els.submit.disabled = true;
    setStatus('', 'start.gg に移動しています…');
    location.assign(S.buildAuthorizeUrl(CFG, state));
  }

  /** 投稿完了で戻ってきたときの表示。下書きは消す。 */
  function handleReturn() {
    var params = new URLSearchParams(location.search);
    if (params.get('posted') !== '1') return;

    try {
      sessionStorage.removeItem(S.DRAFT_KEY);
      sessionStorage.removeItem(S.NONCE_KEY);
    } catch (_) { /* 消せなくても表示は進める */ }

    els.body.value = '';
    setStatus('ok', '投稿を受け付けました。サイトへの反映は次回の更新時になります。');

    // 再読み込みで完了表示が残らないようにクエリを落とす。
    // (state.r に posted=1 が混ざるのも防ぐ)
    params.delete('posted');
    var q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
  }

  function init() {
    els = {
      body: $('post-body'),
      count: $('post-count'),
      submit: $('post-submit'),
      status: $('post-status'),
      canonical: $('post-canonical'),
    };
    if (!els.body) return;

    els.body.setAttribute('maxlength', String(CFG.BODY_MAX));
    els.body.addEventListener('input', updateCount);
    els.submit.addEventListener('click', onSubmit);

    updateCount();
    handleReturn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
