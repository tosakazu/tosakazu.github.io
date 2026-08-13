// vote.js — キャラ投票ページ。
//
// フロー (2026-08-14 改: 認証の前に選手を選ばせ、投票可否を先に見せる):
//
//   未ログイン:
//     1. 選手名で検索して自分を選ぶ (latest_tjpr_full.jsonl)
//     2. その場で投票可否を判定 (players/<uid>.json。認証不要)
//        - キャラ情報あり → 理由を明示して終わり (認証まで行かせない)
//        - 無し           → 「start.gg で本人確認して投票に進む」
//     3. OAuth → callback (login) → ?login=1 で復帰
//     4. 認証アカウントと選択した選手が一致するか確認 → 一致すれば投票フォーム
//   ログイン済みで来た場合:
//     選択をスキップし、自分 (セッションの uid) の資格判定へ直行
//
// 投票は常に「認証した本人」について行われる (GAS がトークンの uid で確定判定)。
// 選択はあくまで事前確認と UX のため。別人を選んで認証しても別人には投票できない。
(function () {
  'use strict';

  var CFG = window.SPSP_POST_CONFIG;
  var S = window.SpspOAuthState;
  var AUTH = window.SpspAuth;

  var SEL_KEY = 'spsp_vote_sel'; // OAuth リダイレクトをまたいで選択を覚える

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  var session = null;
  var selected = null;     // { uid, display }
  var playersIndex = null; // [{ uid, display, low, ens }]
  var charList = null;

  function setStatus(kind, msg) {
    els.status.className = 'status ' + kind;
    els.status.textContent = msg;
    els.status.hidden = !msg;
  }

  function showSection(name) {
    ['select', 'check', 'ineligible', 'auth', 'form'].forEach(function (k) {
      els[k].hidden = (k !== name);
    });
  }

  // ── 選択の退避 (認証リダイレクトをまたぐ) ──

  function saveSel(sel) {
    try { sessionStorage.setItem(SEL_KEY, JSON.stringify(sel)); } catch (_) { /* noop */ }
  }
  function takeSel() {
    var raw = null;
    try {
      raw = sessionStorage.getItem(SEL_KEY);
      sessionStorage.removeItem(SEL_KEY);
    } catch (_) { /* noop */ }
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      return (o && o.uid) ? { uid: String(o.uid), display: String(o.display || '') } : null;
    } catch (_) {
      return null;
    }
  }

  // ── 選手検索 (未ログイン時のみ読む。優先枠ページと同じ jsonl) ──

  function ensureIndex() {
    if (playersIndex) return;
    els.idxStatus.textContent = '選手一覧を読み込み中…';
    fetch('latest_tjpr_full.jsonl')
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.text();
      })
      .then(function (text) {
        var out = [];
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          var rec;
          try { rec = JSON.parse(lines[i]); } catch (_) { continue; }
          if (!rec || rec.user_id === undefined || !rec.display) continue;
          out.push({
            uid: String(rec.user_id),
            display: rec.display,
            low: rec.display.toLowerCase(),
            ens: (rec.ranks && rec.ranks.ensemble) || null,
          });
        }
        playersIndex = out;
        els.idxStatus.textContent = '';
        renderResults();
      })
      .catch(function () {
        els.idxStatus.textContent = '選手一覧の読み込みに失敗しました。再読み込みしてください。';
      });
  }

  function renderResults() {
    var q = els.search.value.trim().toLowerCase();
    els.results.textContent = '';
    if (!playersIndex || !q) return;

    var hits = [];
    for (var i = 0; i < playersIndex.length; i++) {
      if (playersIndex[i].low.indexOf(q) !== -1) hits.push(playersIndex[i]);
    }
    hits.sort(function (a, b) { return (a.ens || Infinity) - (b.ens || Infinity); });

    var top = hits.slice(0, 20);
    top.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vt-result';
      btn.textContent = p.display + (p.ens ? ' (' + p.ens + '位)' : '');
      btn.addEventListener('click', function () { selectPlayer({ uid: p.uid, display: p.display }); });
      els.results.appendChild(btn);
    });
    if (hits.length > top.length) {
      var more = document.createElement('p');
      more.className = 'hint';
      more.textContent = '他 ' + (hits.length - top.length) + ' 件。名前を絞り込んでください。';
      els.results.appendChild(more);
    }
    if (!hits.length) {
      var none = document.createElement('p');
      none.className = 'hint';
      none.textContent = '見つかりません。SPSP にデータがある選手のみ投票できます。';
      els.results.appendChild(none);
    }
  }

  // ── 資格判定 (players/<uid>.json) ──

  /**
   * characters から「投票できる候補」を返す (GAS 側 voteCandidates_ と同じ規則)。
   *   null → データ無し (全キャラ可) / [] → 明確なメイン (不可) /
   *   [{id,name}..] → ダブルメイン圏 (この中からのみ)
   */
  function voteCandidates(chars) {
    if (!chars || !chars.length) return null;
    var top = Number(chars[0] && chars[0].pct);
    if (!isFinite(top)) return [];
    var out = [];
    for (var i = 0; i < chars.length; i++) {
      var p = Number(chars[i].pct);
      if (!isFinite(p)) continue;
      if (top - p <= CFG.DOUBLE_MAIN_PCT_GAP) {
        var id = chars[i].id;
        if (id === undefined || id === null) continue;
        out.push({ id: String(id), name: String(chars[i].name || '') });
      }
    }
    return out.length >= 2 ? out : [];
  }

  function fetchEligibility(uid) {
    return fetch('players/' + encodeURIComponent(uid) + '.json').then(function (res) {
      if (res.status === 404) return { state: 'not_player' };
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json().then(function (rec) {
        var chars = rec && rec.characters;
        var candidates = voteCandidates(chars);
        if (candidates === null) return { state: 'eligible', candidates: null };
        if (candidates.length >= 2) return { state: 'double', candidates: candidates };
        return { state: 'char_exists', chars: chars };
      });
    });
  }

  /** 未ログイン: 選手を選んだ → 可否を先に見せる。 */
  function selectPlayer(sel) {
    selected = sel;
    setStatus('', '');
    showSection('check');
    fetchEligibility(sel.uid)
      .then(function (r) {
        if (r.state === 'not_player') {
          showIneligible('この選手のデータが見つかりません。',
            'SPSP にデータがある選手のみ投票できます。', true);
          return;
        }
        if (r.state === 'char_exists') {
          var names = r.chars.map(function (c) { return c.name; }).join(' / ');
          showIneligible('「' + sel.display + '」はメインキャラが明確なため投票できません。',
            '投票できるのは、キャラ情報が無い選手か、メインキャラ判定が僅差の選手のみです。現在の登録: ' + names, true);
          return;
        }
        if (r.state === 'double') {
          var cn = r.candidates.map(function (c) { return '「' + c.name + '」'; }).join('');
          els.authMsg.textContent =
            '「' + sel.display + '」は ' + cn + ' のメインキャラ判定が僅差です。本人確認のうえ、どちらをメインとするか投票できます (本人のアカウントでログインする必要があります)。';
        } else {
          els.authMsg.textContent =
            '「' + sel.display + '」はキャラ投票の対象です。本人確認のため start.gg で認証してください (本人のアカウントでログインする必要があります)。';
        }
        showSection('auth');
      })
      .catch(function () {
        showSection('select');
        setStatus('error', '選手データの取得に失敗しました。もう一度選択してください。');
      });
  }

  /** ログイン済み: 自分の資格判定 → フォームへ。 */
  function checkSelf() {
    showSection('check');
    fetchEligibility(session.user.id)
      .then(function (r) {
        if (r.state === 'not_player') {
          showIneligible('キャラ投票は SPSP にデータがある選手のみ行えます。',
            'ログイン中の start.gg アカウント (' + AUTH.displayName(session) + ') は SPSP のデータベースに見つかりませんでした。大会結果が取り込まれると投票できるようになります。', false);
          return;
        }
        if (r.state === 'char_exists') {
          var names = r.chars.map(function (c) { return c.name; }).join(' / ');
          showIneligible('メインキャラが明確なため投票できません。',
            '投票できるのは、キャラ情報が無い選手か、メインキャラ判定が僅差の選手のみです。現在の登録: ' + names, false);
          return;
        }
        showForm(r.candidates);
      })
      .catch(function () {
        showSection('select');
        setStatus('error', '選手データの取得に失敗しました。再読み込みしてください。');
      });
  }

  function showIneligible(title, detail, allowBack) {
    els.inelTitle.textContent = title;
    els.inelDetail.textContent = detail;
    els.backBtn.hidden = !allowBack;
    showSection('ineligible');
  }

  function backToSelect() {
    selected = null;
    setStatus('', '');
    showSection('select');
    ensureIndex();
  }

  // ── 認証 (選択済みの選手が対象のときだけ到達する) ──

  function startLogin() {
    setStatus('', '');

    var missing = S.missingConfig(CFG);
    if (missing.length) {
      setStatus('error', 'この機能はまだ設定されていません (' + missing.join(', ') + ')。');
      return;
    }
    if (!S.isCanonicalOrigin(CFG, location.origin)) {
      setStatus('error', '認証はこのURLからは行えません。');
      els.canonical.hidden = false;
      return;
    }

    var nonce;
    try {
      nonce = crypto.randomUUID();
    } catch (_) {
      setStatus('error', 'お使いのブラウザでは認証できません。');
      return;
    }
    try {
      sessionStorage.setItem(S.NONCE_KEY, nonce);
      sessionStorage.setItem(S.INTENT_KEY, 'login');
      sessionStorage.removeItem(S.DRAFT_KEY);
    } catch (_) {
      setStatus('error', 'ブラウザの保存領域が使えないため認証できません (プライベートモード等)。');
      return;
    }
    if (selected) saveSel(selected);

    var state = S.encodeState({ n: nonce, r: location.pathname + location.search });
    els.loginBtn.disabled = true;
    setStatus('', 'start.gg に移動しています…');
    location.assign(S.buildAuthorizeUrl(CFG, state));
  }

  function logout() {
    AUTH.clear();
    session = null;
    selected = null;
    render();
  }

  // ── 投票フォーム ──

  /**
   * candidates が配列 (ダブルメイン圏) なら、その候補だけを選択肢に出す。
   * null なら全キャラ。
   */
  function showForm(candidates) {
    showSection('form');
    if (candidates && candidates.length) {
      els.formHint.textContent =
        'メインキャラ判定が僅差のため、' +
        candidates.map(function (c) { return '「' + c.name + '」'; }).join('') +
        ' の中からどれをメインとするか投票できます。';
      els.formHint.hidden = false;
    } else {
      els.formHint.textContent = '';
      els.formHint.hidden = true;
    }

    if (charList) {
      buildOptions(candidates);
      return;
    }
    fetch('data/char_emoji.json')
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(function (json) {
        charList = Object.keys(json).map(function (id) {
          return { id: id, name: json[id].name, emoji: json[id].emoji || '' };
        });
        charList.sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
        buildOptions(candidates);
      })
      .catch(function () {
        setStatus('error', 'キャラ一覧の取得に失敗しました。再読み込みしてください。');
      });
  }

  function buildOptions(candidates) {
    var allowed = null;
    if (candidates && candidates.length) {
      allowed = {};
      candidates.forEach(function (c) { allowed[c.id] = true; });
    }
    els.select_.innerHTML = '';
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = 'キャラを選択…';
    els.select_.appendChild(opt0);
    charList.forEach(function (c) {
      if (allowed && !allowed[c.id]) return;
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = (c.emoji ? c.emoji + ' ' : '') + c.name;
      els.select_.appendChild(opt);
    });
  }

  function submitVote() {
    setStatus('', '');
    var charId = els.select_.value;
    if (!charId) {
      setStatus('error', 'キャラを選択してください。');
      return;
    }
    els.voteBtn.disabled = true;
    setStatus('', '送信中…');

    fetch(CFG.GAS_ENDPOINT, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'vote', token: session.token, charId: charId }),
    }).then(function (res) {
      return res.json();
    }).then(function (json) {
      els.voteBtn.disabled = false;
      if (json && json.ok) {
        setStatus('ok', json.charName + ' で投票を受け付けました。サイトへの反映は次回の更新時になります。');
        return;
      }
      var code = json && json.error && json.error.code;
      var msg = (json && json.error && json.error.message) ? json.error.message : '投票に失敗しました。';
      if (code === 'auth_failed') {
        AUTH.clear();
        session = null;
        render();
      }
      setStatus('error', msg);
    }).catch(function () {
      els.voteBtn.disabled = false;
      setStatus('error', '通信に失敗しました。時間をおいてやり直してください。');
    });
  }

  // ── 全体の描画 ──

  function render() {
    session = AUTH.load();

    if (!session) {
      els.who.hidden = true;
      backToSelect();
      return;
    }

    els.whoName.textContent = AUTH.displayName(session);
    els.who.hidden = false;

    // 認証から戻った直後: 選択した選手と認証アカウントの一致を確認する。
    // 投票は常に認証した本人に対して行われるので、不一致なら明示して止める。
    var sel = takeSel();
    if (sel && sel.uid !== session.user.id) {
      showIneligible('認証したアカウントが選択した選手と一致しません。',
        '選択: ' + sel.display + ' / 認証: ' + AUTH.displayName(session) +
        '。本人のアカウントで認証し直すには、いったんログアウトしてください。', false);
      return;
    }
    checkSelf();
  }

  function handleReturn() {
    var params = new URLSearchParams(location.search);
    if (params.get('login') !== '1') return;
    setStatus('ok', 'start.gg の認証が完了しました。');
    params.delete('login');
    var q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
  }

  function init() {
    els = {
      select: $('vt-select'),
      check: $('vt-check'),
      ineligible: $('vt-ineligible'),
      auth: $('vt-auth'),
      form: $('vt-form'),
      search: $('vt-search'),
      results: $('vt-results'),
      idxStatus: $('vt-idx-status'),
      authMsg: $('vt-auth-msg'),
      formHint: $('vt-form-hint'),
      backBtn: $('vt-back-btn'),
      back2Btn: $('vt-back2-btn'),
      loginBtn: $('vt-login-btn'),
      logoutBtn: $('vt-logout-btn'),
      voteBtn: $('vt-vote-btn'),
      select_: $('vt-char'),
      status: $('vt-status'),
      who: $('vt-who'),
      whoName: $('vt-who-name'),
      inelTitle: $('vt-inel-title'),
      inelDetail: $('vt-inel-detail'),
      canonical: $('vt-canonical'),
    };
    if (!els.select) return;

    els.search.addEventListener('input', renderResults);
    els.backBtn.addEventListener('click', backToSelect);
    els.back2Btn.addEventListener('click', backToSelect);
    els.loginBtn.addEventListener('click', startLogin);
    els.logoutBtn.addEventListener('click', logout);
    els.voteBtn.addEventListener('click', submitVote);

    handleReturn();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
