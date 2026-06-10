/* SPSP 共有ボタン共通ロジック.
 *
 * 使い方:
 *   <script src="../share.js"></script>
 *   SPSPShare.setup(document.getElementById('share-icon-btn'), () => ({
 *     title: '...',
 *     text:  '...',
 *     url:   location.href,
 *   }));
 *
 * 挙動:
 *   1. navigator.share あり (= HTTPS / mobile)    → ネイティブ共有シート
 *   2. なし or 失敗 → クリップボードコピー + alert
 *      (Clipboard API → execCommand('copy') の順でフォールバック)
 */
(function () {
  'use strict';

  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  async function share(getData) {
    const data = (typeof getData === 'function') ? getData() : getData;
    const payload = {
      title: data.title || document.title,
      text:  data.text  || '',
      url:   data.url   || location.href,
    };
    if (navigator.share) {
      try { await navigator.share(payload); return; }
      catch (err) {
        if (err.name === 'AbortError') return;
        // 続行: native share 失敗時は clipboard に fallback
      }
    }
    const ok = await copyToClipboard(payload.url);
    alert(ok ? 'URL をクリップボードにコピーしました' : 'コピー失敗:\n' + payload.url);
  }

  function setup(btn, getData) {
    if (!btn) return;
    btn.addEventListener('click', () => share(getData));
  }

  window.SPSPShare = { setup, share, copyToClipboard };
})();
