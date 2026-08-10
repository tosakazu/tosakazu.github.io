// SPSP 共通ナビゲーション (template + dropdown). 各ページは
//   <div id="nav-root"></div>
//   <script src="<prefix>nav.js"></script>
// だけ書けばよい。CSS とイベントは self-injection。

// ── Google Analytics 4 (gtag.js) ──
// 全ページに含まれる nav.js から inject することで <head> 編集を省略.
// 二重ロードガード: 既に gtag が読まれていれば skip.
//
// 動的ページ (= URL の query param でコンテンツが切り替わるページ) は
//   - /p/index.html?uid=<num>        プレイヤー
//   - /t/index.html?id=<num>         大会
//   - /c/ranking.html?char=<num>     使い手 (キャラ別)
//   - /local/ranking.html?series=<>  ローカルランキング
// で、コンテンツ名が async ロード後に決まるので nav.js 自動 pageview は skip し、
// ページ側で window.SPSPTrackPage(title, virtualPath) を呼ぶ形にする.
(function () {
  if (window.__SPSP_GA_LOADED) return;
  window.__SPSP_GA_LOADED = true;
  const GA_ID = 'G-TDKBJVDB4S';
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  (document.head || document.documentElement).appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());

  const _p = location.pathname;
  const _isDynamic = (
    /\/p\/(index\.html)?$/.test(_p) ||
    /\/t\/(index\.html)?$/.test(_p) ||
    /\/c\/ranking\.html$/.test(_p) ||
    /\/local\/ranking\.html$/.test(_p)
  );
  window.gtag('config', GA_ID, { send_page_view: !_isDynamic });

  // ページ側からコンテンツロード後に呼ぶ helper.
  //   title:       GA4 「ページ タイトル」に出る (= ユーザー表示用名)
  //   virtualPath: GA4 「ページ パス」に出る (= 例: /p/uid12345). 省略時は実 URL.
  window.SPSPTrackPage = function (title, virtualPath) {
    const path = virtualPath || (location.pathname + location.search);
    window.gtag('event', 'page_view', {
      page_title: title || document.title,
      page_location: location.origin + path,
      page_path: path,
    });
  };
})();

(function () {
  const scriptEl = document.currentScript || (function () {
    const s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();
  const relSrc = scriptEl ? scriptEl.getAttribute('src') || '' : '';
  // "nav.js" → "./", "../nav.js" → "../", "../../nav.js" → "../../"
  const prefix = relSrc.replace(/nav\.js$/, '') || './';
  const p = location.pathname;

  function currentPage() {
    if (/\/overview\.html$/.test(p)) return 'overview';
    if (/\/details\.html$/.test(p))  return 'details';
    if (/\/eval\.html$/.test(p))     return 'eval';
    if (/\/math\.html$/.test(p))     return 'math';
    if (/\/seed-upload\//.test(p))   return 'seed-upload';
    if (/\/seed\//.test(p))          return 'seed';
    if (/\/priority\//.test(p))      return 'priority';
    if (/\/local\/ranking\.html$/.test(p)) return 'local-ranking';
    if (/\/local\//.test(p))         return 'local-series';
    if (/\/c\/ranking\.html$/.test(p)) return 'char-ranking';
    if (/\/c\//.test(p))             return 'char-list';
    if (/\/pref\/ranking\.html$/.test(p)) return 'pref-ranking';
    if (/\/pref\//.test(p))          return 'pref-list';
    if (/\/events\//.test(p))        return 'events';
    if (/\/sim\//.test(p))           return 'sim';
    if (/\/news\//.test(p))          return 'news';
    if (/\/p\//.test(p))             return 'player';
    if (/\/t\//.test(p))             return 'tournament';
    return 'ranking';
  }
  const cur = currentPage();
  const isRanking = cur === 'ranking' || cur === 'local-series' || cur === 'local-ranking' || cur === 'char-list' || cur === 'char-ranking' || cur === 'pref-list' || cur === 'pref-ranking' || cur === 'events' || cur === 'sim';
  const isSeeding = cur === 'seed' || cur === 'seed-upload' || cur === 'priority';
  const isMethod  = ['overview', 'details', 'eval', 'math'].includes(cur);

  const html =
    `<nav class="nav">
      <span class="brand"><a href="${prefix}index.html">SPSP</a></span>
      <div class="nav-dropdown${isRanking ? ' has-current' : ''}">
        <button type="button" class="nav-trigger" aria-haspopup="true" aria-expanded="false">ランキング<span class="caret">▾</span></button>
        <div class="nav-menu" role="menu">
          <a href="${prefix}index.html"${cur === 'ranking' ? ' class="current"' : ''} role="menuitem">全国ランキング</a>
          <a href="${prefix}local/"${cur === 'local-series' || cur === 'local-ranking' ? ' class="current"' : ''} role="menuitem">ローカルランキング</a>
          <a href="${prefix}c/"${cur === 'char-list' || cur === 'char-ranking' ? ' class="current"' : ''} role="menuitem">使い手ランキング</a>
          <a href="${prefix}pref/"${cur === 'pref-list' || cur === 'pref-ranking' ? ' class="current"' : ''} role="menuitem">都道府県別ランキング</a>
          <a href="${prefix}events/"${cur === 'events' ? ' class="current"' : ''} role="menuitem">大会一覧</a>
          <a href="${prefix}sim/"${cur === 'sim' ? ' class="current"' : ''} role="menuitem">ポイントシミュレーション</a>
        </div>
      </div>
      <div class="nav-dropdown${isSeeding ? ' has-current' : ''}">
        <button type="button" class="nav-trigger" aria-haspopup="true" aria-expanded="false">シーディング<span class="caret">▾</span></button>
        <div class="nav-menu" role="menu">
          <a href="${prefix}seed/"${cur === 'seed' ? ' class="current"' : ''} role="menuitem">シード生成</a>
          <a href="${prefix}seed-upload/"${cur === 'seed-upload' ? ' class="current"' : ''} role="menuitem">シードアップロード</a>
          <a href="${prefix}priority/"${cur === 'priority' ? ' class="current"' : ''} role="menuitem">優先枠作成</a>
        </div>
      </div>
      <div class="nav-dropdown${isMethod ? ' has-current' : ''}">
        <button type="button" class="nav-trigger" aria-haspopup="true" aria-expanded="false">解説<span class="caret">▾</span></button>
        <div class="nav-menu" role="menu">
          <a href="${prefix}overview.html"${cur === 'overview' ? ' class="current"' : ''} role="menuitem">基本編</a>
          <a href="${prefix}details.html"${cur === 'details' ? ' class="current"' : ''} role="menuitem">理論編・概念</a>
          <a href="${prefix}eval.html"${cur === 'eval' ? ' class="current"' : ''} role="menuitem">理論編・評価</a>
          <a href="${prefix}math.html"${cur === 'math' ? ' class="current"' : ''} role="menuitem">理論編・数式</a>
        </div>
      </div>
      <div class="nav-dropdown nav-news${cur === 'news' ? ' has-current' : ''}">
        <button type="button" class="nav-trigger nav-news-trigger${cur === 'news' ? ' current' : ''}" aria-haspopup="true" aria-expanded="false" aria-label="お知らせ">
          <span class="nav-news-bell">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
          </span>
        </button>
        <div class="nav-news-panel" role="menu">
          <a class="news-section" id="__nav_news_today_section" href="${prefix}news/?filter=auto">
            <div class="news-section-title">📢 速報</div>
            <div class="news-section-body" id="__nav_news_today">読み込み中…</div>
          </a>
          <a class="news-section" id="__nav_news_announce_section" href="${prefix}news/?filter=announcement">
            <div class="news-section-title">📌 通知</div>
            <div class="news-section-body" id="__nav_news_announce">読み込み中…</div>
          </a>
          <a class="news-section-foot" href="${prefix}news/">すべて見る →</a>
        </div>
      </div>
      <span class="meta" id="meta-info"></span>
    </nav>`;

  // Inject styles (idempotent)
  if (!document.getElementById('__spsp_nav_css')) {
    const style = document.createElement('style');
    style.id = '__spsp_nav_css';
    style.textContent = `
      :root { --nav-height: 42px; }
      html { scroll-padding-top: var(--nav-height); }
      .nav { background:#fff; border-bottom:1px solid #e5e7eb;
             padding:6px 24px; display:flex; gap:24px; align-items:center;
             position:sticky; top:0; z-index:30;
             font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans",sans-serif;
             line-height:1.2; }
      .nav a { color:#6b7280; text-decoration:none; font-size:14px;
               padding:4px 8px; border-radius:4px; }
      .nav a:hover { color:#111827; background:#f3f4f6; }
      .nav a.current { color:#dc2626; background:#f3f4f6; }
      .nav .brand { font-size:16px; color:#111827; font-weight:600; margin-right:16px; }
      .nav .brand a { color:#111827; font-size:16px; padding:0; font-weight:600; }
      .nav .brand a:hover { background:transparent; }
      .nav .meta { margin-left:auto; color:#9ca3af; font-size:12px; }
      .nav-dropdown { position:relative; }
      .nav-trigger { cursor:pointer; user-select:none;
                     color:#6b7280; background:transparent; border:none;
                     font-size:14px; padding:4px 8px; border-radius:4px;
                     font-family:inherit;
                     display:inline-flex; align-items:center; gap:2px; }
      .nav-trigger:hover { color:#111827; background:#f3f4f6; }
      .nav-dropdown.has-current > .nav-trigger { color:#dc2626; background:#f3f4f6; }
      .caret { font-size:10px; opacity:.7; }
      .nav-menu { display:none; position:absolute; top:100%; left:0;
                  background:#fff; border:1px solid #e5e7eb;
                  border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,.08);
                  min-width:200px; padding:4px 0; z-index:31; }
      .nav-menu a { display:block; padding:7px 14px; border-radius:0; font-size:13px; }
      .nav-menu a:hover { background:#f3f4f6; }
      .nav-menu a.current { color:#dc2626; background:#fef3c7; }
      /* クリックで開閉. hover による自動展開は無効 (= 閉じる挙動とぶつかるため). */
      .nav-dropdown.open .nav-menu { display:block; }
      /* News dropdown */
      .nav-news .nav-news-trigger { color:#6b7280; display:inline-flex; align-items:center;
                                     padding:4px 8px; }
      .nav-news.has-current .nav-news-trigger { color:#dc2626; background:#f3f4f6; }
      .nav-news-bell { position:relative; display:inline-flex; line-height:0; }
      .nav-news-bell.has-unread::before { content:''; position:absolute; top:-2px; left:-2px;
                                            width:7px; height:7px; background:#fca5a5;
                                            border-radius:50%; }
      .nav-news-panel { display:none; position:absolute; top:100%; right:0;
                        background:#fff; border:1px solid #e5e7eb;
                        border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,.08);
                        width:340px; max-width:90vw; padding:10px 0; z-index:31; }
      .nav-news.open .nav-news-panel { display:block; }
      a.news-section { display:block; padding:8px 14px; text-decoration:none;
                       color:inherit; transition:background-color .12s; border-radius:0; }
      a.news-section:hover { background:#fef2f2; }
      a.news-section + a.news-section { border-top:1px solid #f3f4f6; }
      .news-section-title { font-size:11px; color:#6b7280; font-weight:600;
                             margin-bottom:6px; letter-spacing:0.05em; }
      a.news-section:hover .news-section-title { color:#dc2626; }
      .news-section-body { font-size:12px; color:#111827; line-height:1.55; }
      .news-section-body .news-item { padding:3px 0; }
      .news-section-body .news-item .date { color:#9ca3af; font-size:10px;
                                              font-family:ui-monospace,monospace; margin-right:6px; }
      .news-section-body .empty { color:#9ca3af; font-size:11px; }
      a.news-section-foot { display:block; padding:8px 14px; border-top:1px solid #f3f4f6;
                            text-align:right; text-decoration:none; color:#dc2626;
                            font-size:11px; transition:background-color .12s; }
      a.news-section-foot:hover { background:#fef2f2; text-decoration:underline; }
      @media (max-width:720px) {
        .nav { padding:4px 12px; gap:8px; flex-wrap:wrap; }
        .nav .brand { font-size:14px; margin-right:8px; }
        .nav .brand a { font-size:14px; }
        .nav a, .nav-trigger { padding:3px 6px; font-size:12px; }
        .nav .meta { width:100%; margin-left:0; font-size:10px; }
        .nav-menu { min-width:160px; }
        /* News panel: 画面右上に固定し viewport からはみ出さないように. */
        .nav-news-panel { position:fixed; top:48px; right:8px; left:auto;
                          width:auto; max-width:calc(100vw - 16px); }
      }
      @media (max-width:380px) {
        .nav .brand, .nav .brand a { font-size:13px; }
        .nav a, .nav-trigger { font-size:11px; }
      }
    `;
    document.head.appendChild(style);
  }

  // Inject HTML as direct child of body (= sticky に必要な full-height 親).
  // #nav-root placeholder があれば nav 要素で REPLACE (= 中に入れず置換).
  // host の中に入れると host = nav の高さしか無くなり sticky の親がスクロール
  // 空間を持たないため、scroll 時に nav 含めて画面外に出てしまう.
  function inject() {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const navEl = tmp.firstElementChild;
    const host = document.getElementById('nav-root');
    if (host && host.parentNode) {
      host.parentNode.replaceChild(navEl, host);
    } else {
      document.body.insertBefore(navEl, document.body.firstChild);
    }
    measureNavHeight(navEl);
  }
  // nav 高さを CSS 変数 (--nav-height) として設定. sticky thead が nav の下に
  // ぴったり収まるよう、ranking-table.css 等で `top: var(--nav-height)` を参照可能.
  // mobile で wrap して 2 行になったり, news ticker で増減した場合にも追従.
  function measureNavHeight(navEl) {
    if (!navEl) navEl = document.querySelector('.nav');
    if (!navEl) return;
    const apply = () => {
      const h = Math.round(navEl.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--nav-height', `${h}px`);
    };
    apply();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(apply);
      ro.observe(navEl);
    } else {
      window.addEventListener('resize', apply);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }

  // Load news.json into news dropdown
  function escHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  const LS_OPENED = 'spsp_news_last_opened';
  let __latestNewsTs = 0;  // 直近 fetch で観測した最新 entry ts. refresh 時に再評価.
  function readTs() {
    const keys = [LS_OPENED, 'spsp_ticker_dismissed_news-ticker-auto', 'spsp_ticker_dismissed_news-ticker-ann'];
    let m = 0;
    for (const k of keys) {
      try { m = Math.max(m, parseInt(localStorage.getItem(k) || '0', 10) || 0); } catch (e) {}
    }
    return m;
  }
  function refreshUnreadBadge() {
    const bell = document.querySelector('.nav-news-bell');
    if (!bell) return;
    if (__latestNewsTs > readTs()) bell.classList.add('has-unread');
    else bell.classList.remove('has-unread');
  }
  function markNewsOpened() {
    try { localStorage.setItem(LS_OPENED, String(Date.now())); } catch (e) {}
    refreshUnreadBadge();
  }
  // index.html の ticker × からも呼べるよう公開.
  window.SPSPNews = { refreshUnreadBadge };
  function loadNews() {
    const elT = document.getElementById('__nav_news_today');
    const elA = document.getElementById('__nav_news_announce');
    const secT = document.getElementById('__nav_news_today_section');
    const secA = document.getElementById('__nav_news_announce_section');
    if (!elT || !elA) return;
    // 表示期間: 投稿時刻から n.days 日 (省略時 1 日) 経過するまで.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const entryTs = (n) => {
      if (n.datetime) { const t = new Date(n.datetime).getTime(); return isNaN(t) ? 0 : t; }
      if (n.date) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(n.date);
        if (m) return new Date(+m[1], +m[2]-1, +m[3]).getTime();
      }
      return 0;
    };
    const entryWindowMs = (n) => Math.max(1, Number(n.days) || 1) * DAY_MS;
    const withinWindow = (n) => { const t = entryTs(n); return t > 0 && (nowMs - t) <= entryWindowMs(n); };
    fetch(prefix + 'news.json').then(r => r.json()).then(data => {
      const today = (data.auto_news || []).filter(withinWindow);
      const ann = (data.announcements || []).filter(withinWindow);
      // 空セクションは非表示 (= ない時は出さない)
      if (today.length) {
        elT.innerHTML = today.map(n => `<div class="news-item"><span class="date">${escHTML(n.date)}</span>${escHTML(n.title)}</div>`).join('');
        if (secT) secT.style.display = '';
      } else {
        if (secT) secT.style.display = 'none';
      }
      if (ann.length) {
        elA.innerHTML = ann.map(n => `<div class="news-item"><span class="date">${escHTML(n.date)}</span>${escHTML(n.title)}</div>`).join('');
        if (secA) secA.style.display = '';
      } else {
        if (secA) secA.style.display = 'none';
      }
      // 未読判定: 24h 以内 entry の最新 ts > 既読 ts なら赤丸表示.
      // 既読 ts = max(news 開いた時刻, ticker × タップ時刻 auto/ann).
      // entryTs は now で clamp (= future 予約 entry も「現在発信」扱いで既読化できるように).
      __latestNewsTs = Math.max(0, ...today.concat(ann).map(n => Math.min(entryTs(n), nowMs)));
      refreshUnreadBadge();
    }).catch(() => {
      if (secT) secT.style.display = 'none';
      if (secA) secA.style.display = 'none';
    });
    // /news/ ページに居る場合は到達時点で既読扱い.
    if (cur === 'news') markNewsOpened();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadNews);
  } else {
    setTimeout(loadNews, 0);
  }

  // 全ページ共通の meta 表示 (= "最終更新 YYYY-MM-DD HH:MM · vXXX") を nav の右側に出す.
  // 個別ページが上書き設定する場合もあるため、すでに textContent があれば触らない.
  function populateMetaInfo() {
    const navMeta = document.getElementById('meta-info');
    if (!navMeta || navMeta.textContent.trim()) return;
    const SITE_VERSION_FULL = '__SITE_VERSION__';
    const versionShort = SITE_VERSION_FULL.split(' · ')[0] || SITE_VERSION_FULL;
    // versionShort が "__SITE_VERSION__" のまま (= ローカル未 stamp) なら version 部分省略.
    const isStamped = !versionShort.includes('SITE_VERSION');
    fetch(prefix + 'meta.json').then(r => r.ok ? r.json() : null).then(meta => {
      if (!meta) {
        if (isStamped) navMeta.textContent = versionShort;
        return;
      }
      const genTime = String(meta.generated_at || meta.eval_date || '').split('.')[0].replace('T', ' ');
      navMeta.textContent = `最終更新 ${genTime}${isStamped ? ' · ' + versionShort : ''}`;
    }).catch(() => {
      if (isStamped) navMeta.textContent = versionShort;
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', populateMetaInfo);
  } else {
    setTimeout(populateMetaInfo, 0);
  }

  // Click-to-toggle dropdown (mobile-friendly).
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.nav-trigger');
    if (trigger) {
      const drop = trigger.closest('.nav-dropdown');
      const wasOpen = drop.classList.contains('open');
      document.querySelectorAll('.nav-dropdown.open').forEach(d => {
        d.classList.remove('open');
        const t = d.querySelector('.nav-trigger');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
      if (!wasOpen) {
        drop.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        if (drop.classList.contains('nav-news')) markNewsOpened();
      }
      e.stopPropagation();
      return;
    }
    if (!e.target.closest('.nav-menu') && !e.target.closest('.nav-news-panel')) {
      document.querySelectorAll('.nav-dropdown.open').forEach(d => {
        d.classList.remove('open');
        const t = d.querySelector('.nav-trigger');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
    }
  });
})();
