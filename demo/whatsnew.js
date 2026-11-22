// Shared "What's new" popup: the same for every app. Shown once after an update (never on a first install, the welcome
// tour covers that). Help > What's new reopens it. To announce a release, edit NOTES below (hand-written, short, plain).
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const NOTES = {
    // shown by default
    top: [
      ['All apps', 'Never lose work.', 'A safe copy is kept as you type and offered back after a crash.'],
      ['All apps', 'One window.', 'Opening a file uses the window that is already open.'],
      ['Writer', 'Comments and contents.', 'Comment on text with replies, and add a table of contents. Both save into Word.'],
      ['Writer', 'More formatting.', 'Links, line spacing, indents, nested lists and a styles gallery.'],
      ['Writer', 'Writing assistance.', 'Suggests words (Tab to accept), fixes capitals, names and apostrophes, and adds full stops. Ctrl+Z undoes a change.'],
      ['Writer', 'Templates.', 'Start from an assignment cover page, essay, lab report, CV, letter or minutes.'],
      ['Writer', 'Headers and footers.', 'Left, centre and right text, page numbers, "Page X of Y" and a different first page.'],
      ['Writer', 'Columns and callout boxes.', 'Two or three columns across pages, and shaded note boxes. Both save into Word.'],
      ['PDF', 'Fill in forms.', 'Fillable PDFs show shaded fields you can type in, tick or pick from; they save into the PDF.'],
      ['PDF', 'Signatures.', 'Draw or type your signature once, then place it on any PDF.'],
      ['PDF', 'Reorder pages.', 'Drag page thumbnails into a new order; your edits move with them.'],
      ['Writer', 'Page borders.', 'Put a box around every page from the Layout tab; it saves to Word and shows in the PDF.'],
      ['Writer', 'Track changes.', 'Turn it on from the Review tab (Ctrl+Shift+E). Edits show as suggestions you can accept or reject, and they save as real Word tracked changes.'],
      ['Writer', 'Equations.', 'Type or click fractions, roots, sums, integrals and Greek letters with a live preview (Alt+=).'],
      ['Writer', 'Better tables.', 'Merge and split cells, shade cells, choose borders and pick ready-made table styles.'],
      ['Writer', 'Fonts.', '32 free fonts built in, and Word files with unknown fonts now show their text.'],
      ['Sheets', 'New formulas', 'XLOOKUP, IFS, TEXT, plus find & replace and print.'],
      ['Solve', 'Maths that shows its working.', 'A new app: type a problem, get the answer step by step with pictures and graphs, then practise similar questions.'],
      ['PDF', 'Convert to Writer, much better.', 'Keeps fonts, colours, page size, margins, headers and footers, tables and check boxes. Scanned pages are read too, and "same look, editable" keeps the page exactly as it appears.'],
      ['Writer', 'Letterheads.', 'Word files with a logo or coloured header and footer now show them on every page and keep them when you save.'],
      ['PDF', 'Ticks and crosses.', 'Stamp a tick or cross on any PDF box, and add check boxes in Writer.'],
    ],
    // shown under "See all changes"
    more: [
      ['All apps', 'Update notice', 'The update button now shows on every screen.'],
      ['All apps', 'Report a problem', 'A new Help option collects the details to send us.'],
      ['Writer', 'Better Word files', 'Content controls, tracked insertions and nested tables keep their text.'],
      ['Writer', 'Tables from PDFs', 'Merged cells and tables with no drawn lines are rebuilt as real tables.'],
      ['Sheets', 'Charts and validation', 'Charts, drop-down lists and fill series.'],
    ],
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = (l) => l.map(([t, b, x]) => `<li><span class="tag">${esc(t)}</span><span class="t"><b>${esc(b)}</b> ${esc(x)}</span></li>`).join('');

  async function version() {
    try { const v = await window.__TAURI__?.app?.getVersion?.(); if (v) return v; } catch { /* fall through */ }
    return ((document.getElementById('ver') || {}).textContent || '').replace(/^v/, '') || null;
  }

  let el = null;
  function close() { if (el) { el.remove(); el = null; document.removeEventListener('keydown', onKey, true); } }
  function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } }

  async function show() {
    if (el) return;
    const v = await version();
    el = document.createElement('div');
    el.className = 'wn-bg';
    el.innerHTML = `<div class="wn-card" role="dialog" aria-label="What's new"><span class="wn-ver">VERSION ${esc(v || '')}</span><h2>What's new</h2>` +
      `<div class="wn-sub">Updated just now. Here is what changed.</div><ul id="wn-list">${rows(NOTES.top)}</ul>` +
      `<div class="wn-row"><a id="wn-more">See all changes</a><button id="wn-ok">Got it</button></div></div>`;
    document.body.appendChild(el);
    el.querySelector('#wn-ok').onclick = close;
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
    el.querySelector('#wn-more').onclick = (e) => { el.querySelector('#wn-list').innerHTML = rows(NOTES.top.concat(NOTES.more)); e.target.remove(); };
    document.addEventListener('keydown', onKey, true);
    el.querySelector('#wn-ok').focus();
  }

  // Call once the app is ready: shows the popup if the version changed since last time.
  async function check() {
    if (window.top !== window) return;
    const v = await version(); if (!v) return;
    const seen = MTRX.prefs.get('whatsnew.seen', null);
    if (seen === v) return;
    const firstInstall = seen == null && !MTRX.prefs.get('tour.writer', false);
    MTRX.prefs.set('whatsnew.seen', v);
    if (!firstInstall) show();
  }

  MTRX.whatsNew = { show, check };
  const go = () => setTimeout(check, 1200);
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
})();
