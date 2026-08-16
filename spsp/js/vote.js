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


  /** ひらがな→カタカナ + 小文字化 (キャラ名の自由入力用の正規化)。 */
  function normChar(sIn) {
    return String(sIn).replace(/[ぁ-ゖ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) + 0x60);
    }).toLowerCase();
  }

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  var session = null;
  var selected = null;     // { uid, display }
  var playersIndex = null; // [{ uid, display, low, ens }]
  var charList = null;
  var selCharId = null;      // グリッドで選択中のキャラ
  var lastCandidates = null; // 選択中の選手のダブルメイン候補 (null = 全キャラ)

  /**
   * 文字列と {hl: 名前} の配列を要素として流し込む。名前のハイライトは
   * <strong class="hl"> で行い、innerHTML は使わない (名前は任意文字列)。
   */
  function setRich(el, parts) {
    el.textContent = '';
    (Array.isArray(parts) ? parts : [parts]).forEach(function (p) {
      if (p && typeof p === 'object' && p.hl !== undefined) {
        var st = document.createElement('strong');
        st.className = 'hl';
        st.textContent = p.hl;
        el.appendChild(st);
      } else {
        el.appendChild(document.createTextNode(String(p)));
      }
    });
  }

  /** msg は文字列か setRich のパーツ配列 (強調したい語があるとき)。 */
  function setStatus(kind, msg) {
    els.status.className = 'status ' + kind;
    var empty = Array.isArray(msg) ? !msg.length : !msg;
    if (Array.isArray(msg)) setRich(els.status, msg);
    else els.status.textContent = msg;
    els.status.hidden = empty;
  }

  /**
   * ブラウザ側でしか観測できない失敗を GAS の errors シートに送る。
   * 失敗しても画面には何も出さない (報告のために操作を止めない)。
   * 個人情報は送らない: kind と、原因切り分けに要る短い note だけ。
   */
  function reportError(kind, note) {
    try {
      if (!CFG || !CFG.GAS_ENDPOINT) return;
      fetch(CFG.GAS_ENDPOINT, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'client_error',
          flow: 'vote',
          kind: kind,
          note: note || '',
          token: session ? session.token : null,
        }),
      }).catch(function () { /* 記録できなくても続行 */ });
    } catch (_) { /* 同上 */ }
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
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.display;
      btn.appendChild(nm);
      if (p.ens) {
        var rk = document.createElement('span');
        rk.className = 'rank';
        rk.textContent = p.ens + '位';
        btn.appendChild(rk);
      }
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
   *   null → 使用実績が無い (全キャラ可) / [] → 明確なメイン (不可) /
   *   [{id,name}..] → ダブルメイン圏 (この中からのみ)
   *
   * - 基準は **最大 pct** (先頭ではない)。ビルドが投票採用で並びを変えるため、
   *   characters[0] が最大 pct とは限らない (v3/v4/char_vote.py)。
   * - pct を持たないエントリ (= 投票由来。ビルドが使用実績ゼロの人に足したもの) は
   *   実績として数えない。実績が 1 つも無ければ null (= 再投票可)。
   */
  function voteCandidates(chars) {
    if (!chars || !chars.length) return null;
    var measured = [];
    for (var i = 0; i < chars.length; i++) {
      var p = Number(chars[i] && chars[i].pct);
      if (isFinite(p) && chars[i].id !== undefined && chars[i].id !== null) {
        measured.push({ id: String(chars[i].id), name: String(chars[i].name || ''), pct: p });
      }
    }
    if (!measured.length) return null; // 投票由来のみ = 実績なし扱い
    var top = -Infinity;
    measured.forEach(function (c) { if (c.pct > top) top = c.pct; });
    var out = measured.filter(function (c) { return top - c.pct <= CFG.DOUBLE_MAIN_PCT_GAP; })
      .map(function (c) { return { id: c.id, name: c.name }; });
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

  /**
   * ダブルメイン圏の候補キャラを認証前の画面にチップで見せる。
   * 絵文字はキャラ一覧から引く (取得失敗しても名前だけで出す)。
   */
  function renderAuthCands(candidates) {
    els.authCands.textContent = '';
    if (!candidates || !candidates.length) return;
    var put = function (byId) {
      els.authCands.textContent = '';
      candidates.forEach(function (cand) {
        var chip = document.createElement('span');
        chip.className = 'cand-chip';
        var c = byId && byId[cand.id];
        chip.textContent = (c && c.emoji ? c.emoji + ' ' : '') + cand.name;
        els.authCands.appendChild(chip);
      });
    };
    put(null); // まず名前だけで即表示
    loadCharList().then(function () {
      var byId = {};
      charList.forEach(function (c) { byId[c.id] = c; });
      put(byId); // 絵文字付きに差し替え
    }).catch(function () { /* チップは補助表示なので失敗は無視 */ });
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
          showIneligible(['「', { hl: sel.display }, '」はメインキャラが明確なため投票できません。'],
            ['投票できるのは、キャラ情報が無い選手か、メインキャラ判定が僅差の選手のみです。現在の登録: ', { hl: names }], true);
          return;
        }
        lastCandidates = r.state === 'double' ? r.candidates : null;
        if (r.state === 'double') {
          var parts = ['「', { hl: sel.display }, '」は'];
          r.candidates.forEach(function (c) { parts.push('「', { hl: c.name }, '」'); });
          parts.push('のメインキャラ判定が僅差です。本人確認のうえ、この中からどれをメインとするか投票できます (本人のアカウントでログインする必要があります)。');
          setRich(els.authMsg, parts);
          renderAuthCands(r.candidates);
        } else {
          setRich(els.authMsg, ['「', { hl: sel.display }, '」はキャラ投票の対象です。本人確認のため start.gg で認証してください (本人のアカウントでログインする必要があります)。']);
          renderAuthCands(null);
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
            ['ログイン中の start.gg アカウント (', { hl: AUTH.displayName(session) }, ') は SPSP のデータベースに見つかりませんでした。大会結果が取り込まれると投票できるようになります。'], false);
          return;
        }
        if (r.state === 'char_exists') {
          var names = r.chars.map(function (c) { return c.name; }).join(' / ');
          showIneligible('メインキャラが明確なため投票できません。',
            ['投票できるのは、キャラ情報が無い選手か、メインキャラ判定が僅差の選手のみです。現在の登録: ', { hl: names }], false);
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
    setRich(els.inelTitle, title);
    setRich(els.inelDetail, detail);
    els.backBtn.hidden = !allowBack;
    showSection('ineligible');
  }

  function backToSelect() {
    selected = null;
    lastCandidates = null;
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
    lastCandidates = null;
    render();
  }

  // ── 投票フォーム ──

  var charListPromise = null;

  /** キャラ一覧 (絵文字付き・ファイター番号順) を 1 回だけ読む。 */
  function loadCharList() {
    if (charListPromise) return charListPromise;
    charListPromise = fetch('data/char_emoji.json')
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(function (json) {
        charList = Object.keys(json).map(function (id) {
          return { id: id, name: json[id].name, emoji: json[id].emoji || '' };
        });
        // 並びは公式ファイター番号順 (js/fighter_number.js。キャラ別ランキングと共有)
        var FN = window.FIGHTER_NUMBER || {};
        charList.forEach(function (c) {
          c.ord = FN[c.id] !== undefined ? FN[c.id] : 9999; // 未知の id は末尾
        });
        charList.sort(function (a, b) {
          return a.ord - b.ord || a.name.localeCompare(b.name, 'ja');
        });
        return charList;
      });
    charListPromise.catch(function () { charListPromise = null; }); // 失敗時は再試行できるように
    return charListPromise;
  }

  /**
   * candidates が配列 (ダブルメイン圏) なら、その候補だけを選択肢に出す。
   * null なら全キャラ。
   */
  function showForm(candidates) {
    showSection('form');
    if (candidates && candidates.length) {
      var hintParts = ['メインキャラ判定が僅差のため、'];
      candidates.forEach(function (c) { hintParts.push('「', { hl: c.name }, '」'); });
      hintParts.push(' の中からどれをメインとするか投票できます。');
      setRich(els.formHint, hintParts);
      els.formHint.hidden = false;
    } else {
      els.formHint.textContent = '';
      els.formHint.hidden = true;
    }

    loadCharList()
      .then(function () { buildOptions(candidates); })
      .catch(function () {
        setStatus('error', 'キャラ一覧の取得に失敗しました。再読み込みしてください。');
      });
  }

  function buildOptions(candidates) {
    els.charSearch.value = '';
    var allowed = null;
    if (candidates && candidates.length) {
      allowed = {};
      candidates.forEach(function (c) { allowed[c.id] = true; });
    }
    selCharId = null;
    els.grid.textContent = '';
    charList.forEach(function (c) {
      if (allowed && !allowed[c.id]) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vt-char';
      btn.dataset.id = c.id;
      btn.dataset.name = c.name;
      var em = document.createElement('span');
      em.className = 'em';
      em.textContent = c.emoji || '🎮';
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = c.name;
      btn.appendChild(em);
      btn.appendChild(nm);
      btn.addEventListener('click', function () {
        selCharId = c.id;
        var prev = els.grid.querySelector('.sel');
        if (prev) prev.classList.remove('sel');
        btn.classList.add('sel');
      });
      els.grid.appendChild(btn);
    });
  }

  function applyCharFilter() {
    var q = normChar(els.charSearch.value.trim());
    var visible = [];
    Array.from(els.grid.children).forEach(function (btn) {
      var hit = !q || normChar(btn.dataset.name || '').indexOf(q) !== -1;
      btn.hidden = !hit;
      if (hit) visible.push(btn);
    });
    // 1 件に絞れたらそのまま選択扱いにする (自由入力での選択)
    if (q && visible.length === 1) {
      selCharId = visible[0].dataset.id;
      var prev = els.grid.querySelector('.sel');
      if (prev && prev !== visible[0]) prev.classList.remove('sel');
      visible[0].classList.add('sel');
    }
  }

  function submitVote() {
    setStatus('', '');
    var charId = selCharId;
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
      body: JSON.stringify({
        action: 'vote',
        token: session ? session.token : null,
        charId: charId,
      }),
    }).then(function (res) {
      return res.json();
    }).then(function (json) {
      els.voteBtn.disabled = false;
      if (json && json.ok) {
        // 反映まで待つことを明示しておく。書かないと「反映されない」と思って
        // 同じ内容で投票し直す人が出る (2026-08-14 に実例あり)。
        setStatus('ok', [json.charName + ' で投票を受け付けました。サイトへの反映は次回の更新 (',
          { hl: '最大3時間後' }, ') になります。すぐには変わりませんが、投票し直す必要はありません。']);
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
      reportError('network', 'vote fetch failed');
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
      // GAS を通らない失敗なので、報告しないと運営側から永久に見えない。
      reportError('account_mismatch', 'selected=' + sel.uid + ' authed=' + session.user.id);
      // いちばん多い失敗。「一致しません」だけだと次に何をすればいいか分からないので、
      // 起きがちな原因と、それぞれの対処まで書く。
      // 特に start.gg 側はログインしたままなので、再認証しても同じアカウントで
      // 素通りして同じ画面に戻ってくる (ここを書かないと無限ループになる)。
      showIneligible(
        ['認証したアカウントが、選んだ選手と一致しません。'],
        ['選んだ選手: ', { hl: sel.display },
          ' / 認証したアカウント: ', { hl: AUTH.displayName(session) }, '\n\n',
          'キャラ投票は本人のアカウントでのみ行えます。次のどれかに当てはまらないか確認してください。\n',
          '・別の人を選んでいる → 上の「ログアウト」を押して選び直してください。\n',
          '・自分に複数の start.gg アカウントがある → SPSP 側で別人として扱われています。',
          'X (@smash_tskz) の DM でご連絡いただければ統合します。\n',
          '・start.gg で別のアカウントにログインしている → ',
          'start.gg でログアウトしてから、こちらでもログアウトして認証し直してください。',
          'こちらでログアウトするだけでは、start.gg 側は同じアカウントのままなので同じ結果になります。'],
        false);
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
      authCands: $('vt-auth-cands'),
      formHint: $('vt-form-hint'),
      backBtn: $('vt-back-btn'),
      back2Btn: $('vt-back2-btn'),
      loginBtn: $('vt-login-btn'),
      logoutBtn: $('vt-logout-btn'),
      voteBtn: $('vt-vote-btn'),
      grid: $('vt-char-grid'),
      charSearch: $('vt-char-search'),
      status: $('vt-status'),
      who: $('vt-who'),
      whoName: $('vt-who-name'),
      inelTitle: $('vt-inel-title'),
      inelDetail: $('vt-inel-detail'),
      canonical: $('vt-canonical'),
    };
    if (!els.select) return;

    els.search.addEventListener('input', renderResults);
    els.charSearch.addEventListener('input', applyCharFilter);
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
