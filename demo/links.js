// Writer: hyperlinks. Insert or edit a link on the selected text; Ctrl+click opens it. Saved as real links in .docx.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const $ = (s) => document.querySelector(s);
  const { ed, msg, modal, exec, saveDraftSoon } = MTRX.w;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const OK = /^https?:\/\/[^\s"'<>]{1,2000}$/i;

  const open = (url) => {
    const inv = window.__TAURI__?.core?.invoke;
    if (inv) inv('open_url', { url }).catch(() => msg('That link could not be opened'));
    else window.open(url, '_blank', 'noopener');
  };

  // The link the caret or selection sits in, if any.
  const linkAt = (r) => { const n = r && r.commonAncestorContainer; const el = n && (n.nodeType === 1 ? n : n.parentElement); return el && el.closest && el.closest('a[href]'); };

  function dialog() {
    const r = MTRX.w.saved();
    if (!r || !ed.contains(r.commonAncestorContainer)) return msg('Click in your text first');
    const a = linkAt(r);
    const sel = r.toString();
    const tmp = document.createElement('div'); tmp.appendChild(r.cloneContents());
    if (!a && tmp.querySelector('p,div,h1,h2,h3,li,ul,ol,table,img,br,sup.fn')) return msg('Select text inside one paragraph');
    if (a && a.closest('.toc')) return;
    modal(a ? 'Edit link' : 'Insert link',
      `<label>Text to show</label><input id="m-lt" maxlength="300" value="${esc(a ? a.textContent : sel)}"><label>Web address</label><input id="m-lu" maxlength="2000" placeholder="https://example.com" value="${esc(a ? a.getAttribute('href') : 'https://')}">${a ? '<label><input type="checkbox" id="m-lr" style="width:auto"> Remove this link (keep the text)</label>' : ''}`,
      (m) => {
        let url = m.querySelector('#m-lu').value.trim();
        const text = m.querySelector('#m-lt').value || url;
        if (a && m.querySelector('#m-lr')?.checked) { a.replaceWith(...a.childNodes); ed.normalize(); saveDraftSoon(); return; }
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        if (!OK.test(url)) return msg('Links must start with http:// or https://');
        if (a) { a.setAttribute('href', url); if (a.textContent !== text) a.textContent = text; saveDraftSoon(); return; }
        exec('insertHTML', `<a href="${esc(url)}">${esc(text)}</a>`);
        saveDraftSoon();
      }, a ? 'Save' : 'Insert');
    setTimeout(() => $('#m-lu')?.focus(), 30);
  }

  ed.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) open(a.getAttribute('href'));
    else msg('Ctrl+click to open this link');
  });
  ed.addEventListener('mouseover', (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a && !a.title) a.title = a.getAttribute('href') + ' (Ctrl+click to open)'; });

  $('#ins-link').onclick = dialog;
  MTRX.links = { dialog };
})();
