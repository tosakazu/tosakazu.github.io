// logo.js — SPSP ロゴ (背面ティア + ワードマーク + 正式名称)。
//
//   1. ヘッダーのブランド表示 (静止・アニメーション後の姿)
//   2. データ読み込み中のオーバーレイ (アニメーション再生 → 消える)
//
// 両方が同じ組み立て関数を使うので、見た目がずれない。
//
// 注意:
// - 外部フォントは読まない。全ページの nav から読まれるので、描画を止める
//   リクエストを増やさない (callback.html の外部リソース禁止 INV-8 とも整合)。
// - 背面のティアは 5 段 = レベル構造。上ほど短く・濃い (上位ほど少数)。
(function (global) {
  'use strict';

  var WORD = 'SPSP';
  // 正式名称は 2 行。[文字, アクセント色にするか]
  var SUB_LINES = [['SAIKYO PLAYERS', false], ['SPECIAL', true]];
  // 背面ティア (上 = 最上位)。w = 幅, a = 不透明度
  var TIERS = [
    { w: '21%', a: 0.30 },
    { w: '41%', a: 0.15 },
    { w: '61%', a: 0.12 },
    { w: '80%', a: 0.09 },
    { w: '100%', a: 0.07 },
  ];

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  /**
   * ロゴ本体を root に組み立てる。
   *   opts.sub : 正式名称を出すか (ヘッダーでは出さない)
   */
  function build(root, opts) {
    var o = opts || {};
    root.textContent = '';

    var lockup = el('div', 'spsp__lockup');

    var tiers = el('div', 'spsp__tiers');
    tiers.setAttribute('aria-hidden', 'true');
    TIERS.forEach(function (t, i) {
      var b = el('b');
      b.style.setProperty('--w', t.w);
      b.style.setProperty('--a', t.a);
      b.style.setProperty('--i', i);
      tiers.appendChild(b);
    });
    lockup.appendChild(tiers);

    var text = el('div', 'spsp__text');
    text.setAttribute('aria-hidden', 'true');

    var wrap = el('div', 'spsp__wordwrap');
    var word = el('div', 'spsp__word');
    word.textContent = WORD;
    wrap.appendChild(word);
    wrap.appendChild(el('i', 'spsp__scan'));
    text.appendChild(wrap);

    if (o.sub) {
      var sub = el('div', 'spsp__sub');
      var j = 0;
      SUB_LINES.forEach(function (pair) {
        var line = el('span', 'spsp__line' + (pair[1] ? ' spsp__line--accent' : ''));
        line.dataset.line = pair[0];
        var inner = el('span', 'spsp__linein');
        pair[0].split('').forEach(function (ch) {
          var u = document.createElement('u');
          u.textContent = ch;
          u.style.setProperty('--j', j++);
          inner.appendChild(u);
        });
        line.appendChild(inner);
        sub.appendChild(line);
      });
      text.appendChild(sub);
    }

    lockup.appendChild(text);
    root.appendChild(lockup);
    return root;
  }

  /**
   * 正式名称の字間を詰め/広げて、2 行ともワードマークと同じ幅に揃える。
   *
   * 字間を CSS で固定すると行ごとに端がそろわない (文字数が違うため)。
   * 実測してから 1 文字あたりの追加量を出す。フォント読み込み後と
   * 画面幅変更後にもう一度呼ぶこと。
   */
  function fit(root) {
    if (!root) return;
    var word = root.querySelector('.spsp__word');
    if (!word) return;
    var target = word.getBoundingClientRect().width;
    if (!target) return;                       // 非表示中は測れないので何もしない
    root.querySelectorAll('.spsp__line').forEach(function (line) {
      var inner = line.querySelector('.spsp__linein');
      var n = (line.dataset.line || '').length;
      if (!inner || !n) return;
      line.style.letterSpacing = '0px';
      line.style.textIndent = '0px';
      var natural = inner.getBoundingClientRect().width;
      var ls = (target - natural) / n;
      if (ls > 0.5) {
        line.style.letterSpacing = ls + 'px';
        line.style.textIndent = (ls / 2) + 'px';   // 行末に出る余白ぶんを戻して中央をそろえる
      } else {
        line.style.letterSpacing = '.18em';
        line.style.textIndent = '.09em';
      }
    });
  }

  // 一巡にかかる時間 (logo.css の遅延 + 再生時間の合計に合わせる)。
  // これを過ぎても消えないときは繰り返しに入る。
  var INTRO_MS = 1300;

  // ── 読み込み中の差し込み ──
  //
  // 画面全体を覆うのではなく、「読み込み中…」と書いてあった場所にそのまま置く。
  // データが届いたときページ側が中身を差し替えるので、後始末は要らない。

  /** node の中身をロゴ (再生付き) に置き換える。 */
  function inline(node, opts) {
    if (!node || node.querySelector('.spsp')) return;    // 二重に入れない
    var o = opts || {};
    var box = el('div', 'spsp-inline');
    var mark = el('div', 'spsp is-anim');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', 'SPSP — 読み込み中');
    build(mark, { sub: o.sub !== false });
    box.appendChild(mark);
    node.textContent = '';
    node.appendChild(box);
    fit(mark);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { fit(mark); });
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { mark.classList.add('is-on'); });
    });
    // 一巡し終わっても読み込みが続いているときは、繰り返しに移る。
    // (枠ごと差し替えられたら DOM から消えるので、後始末は要らない)
    setTimeout(function () {
      if (mark.isConnected !== false) mark.classList.add('is-loop');
    }, INTRO_MS);
    return mark;
  }

  // 「読み込み中」と書いてある枠を探して差し替える。
  // 各ページに手を入れなくて済むよう、nav.js から 1 回呼ぶだけにしている。
  // 表の空行や本文の読み込み枠だけ。行を開いたときの小さな
  // 「詳細情報を取得中…」(.loading-msg) は対象外 — ロゴを出すには小さすぎる。
  var LOADING_SEL = '.empty-msg, #loading';
  var LOADING_RE = /読み込み中|ロード中/;

  function autoInline(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll(LOADING_SEL);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!LOADING_RE.test(n.textContent || '')) continue;
      // 「見つかりません」等の予備枠は display:none で置いてあるので触らない
      if (n.style && n.style.display === 'none') continue;
      inline(n, { sub: true });
    }
  }

  /** ヘッダーのブランド枠に静止ロゴを入れる (アニメーションなし・正式名称なし)。 */
  function mountHeader(node) {
    if (!node) return;
    node.className = 'spsp';
    build(node, { sub: false });
  }

  function prefersReducedMotion() {
    try {
      return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) { return false; }
  }

  global.SPSPLogo = {
    build: build,
    fit: fit,
    TIERS: TIERS,
    SUB_LINES: SUB_LINES,
    inline: inline,
    autoInline: autoInline,
    mountHeader: mountHeader,
    prefersReducedMotion: prefersReducedMotion,
  };
})(typeof window !== 'undefined' ? window : globalThis);
