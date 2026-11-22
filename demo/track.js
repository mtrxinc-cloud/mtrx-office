// Writer: Track changes. With tracking on, typing becomes a suggested insertion and deleting only marks the text as deleted,
// so a reviewer can accept or reject each change. Stored in the document as
//   <span class="tc" data-k="ins|del" data-a="author" data-d="date">text</span>
// and saved as real Word tracked changes (w:ins / w:del); a .docx with tracked changes opens with them intact.
// Limits: Enter, merging paragraphs and formatting changes are not tracked, and pasting in tracking mode pastes plain text.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const $ = (s) => document.querySelector(s);
  const { ed, msg, modal, saveDraftSoon, markPages, countWords } = MTRX.w;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const iso = () => new Date().toISOString().slice(0, 19) + 'Z';
  const who = () => MTRX.prefs.get('author', '') || 'Author';
  let on = false, inner = false; // inner: our own execCommand is running, do not intercept it

  const tcOf = (n) => (n && (n.nodeType === 1 ? n : n.parentElement))?.closest?.('span.tc');
  const spanHtml = (k, html) => `<span class="tc" data-k="${k}" data-a="${esc(who())}" data-d="${iso()}" data-n="1">${html}</span>`;
  const run = (fn) => { inner = true; try { return fn(); } finally { inner = false; } };
  const exec = (cmd, val) => run(() => document.execCommand(cmd, false, val));
  const select = (r) => { const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
  const fresh = () => { const s = ed.querySelector('span.tc[data-n]'); if (s) delete s.dataset.n; return s; };

  // ---- typing -----------------------------------------------------------------
  function insertTracked(html) {
    const sel = getSelection(); if (!sel.rangeCount) return;
    const tc = tcOf(sel.getRangeAt(0).startContainer);
    if (tc && tc.dataset.k === 'del') { const r = document.createRange(); r.setStartAfter(tc); r.collapse(true); select(r); }
    const own = tcOf(getSelection().getRangeAt(0).startContainer);
    if (own && own.dataset.k === 'ins' && own.dataset.a === who()) { exec('insertHTML', html); return; } // typing inside your own insertion
    exec('insertHTML', spanHtml('ins', html));
    const sp = fresh();
    if (sp) { const r = document.createRange(); r.selectNodeContents(sp); r.collapse(false); select(r); } // caret inside, so the next letters extend it
  }

  // ---- deleting: mark the text as deleted (own fresh insertions are really removed) -------------
  function delRange(range, dir) {
    const segs = [];
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (range.intersectsNode(n) && !n.parentElement.closest('.toc,.pb,.cs') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const s = n === range.startContainer ? range.startOffset : 0, e = n === range.endContainer ? range.endOffset : n.length;
      if (e > s) segs.push({ n, s, e });
    }
    if (!segs.length) return false;
    let first = null, last = null, touched = null;
    for (const { n, s, e } of segs.reverse()) {
      const tc = tcOf(n);
      touched = tc || touched;
      if (tc && tc.dataset.k === 'del') { first = first || tc; last = last && last.compareDocumentPosition(tc) & 4 ? last : last || tc; continue; }
      const r = document.createRange(); r.setStart(n, s); r.setEnd(n, e); select(r);
      if (tc && tc.dataset.k === 'ins' && tc.dataset.a === who()) { exec('delete'); continue; }
      exec('insertHTML', spanHtml('del', esc(n.data.slice(s, e))));
      const sp = fresh(); if (sp) { last = last || sp; first = sp; }
    }
    const r = document.createRange();
    if (first && last) { dir === 'back' ? r.setStartBefore(first) : r.setStartAfter(last); r.collapse(true); select(r); }
    return true;
  }

  ed.addEventListener('beforeinput', (e) => {
    if (!on || inner || e.isComposing) return;
    const t = e.inputType, sel = getSelection();
    if (!sel.rangeCount || !ed.contains(sel.anchorNode)) return;
    if (t === 'insertText' && e.data) {
      let r = sel.getRangeAt(0);
      const own = tcOf(r.startContainer);
      if (r.collapsed && own && own.dataset.k === 'ins' && own.dataset.a === who()) return; // plain typing inside your insertion
      e.preventDefault();
      if (!r.collapsed) delRange(r, 'fwd');
      insertTracked(e.data === ' ' ? '&nbsp;' : esc(e.data));
    } else if (t === 'insertFromPaste' && e.dataTransfer) {
      const txt = e.dataTransfer.getData('text/plain'); if (!txt) return;
      e.preventDefault();
      const r = sel.getRangeAt(0); if (!r.collapsed) delRange(r, 'fwd');
      insertTracked(esc(txt.replace(/\r/g, '')).replace(/\n/g, '<br>'));
    } else if (t.startsWith('delete')) {
      const tr = e.getTargetRanges && e.getTargetRanges()[0];
      const range = document.createRange();
      if (tr) { range.setStart(tr.startContainer, tr.startOffset); range.setEnd(tr.endContainer, tr.endOffset); } else range.setStart(sel.anchorNode, sel.anchorOffset), range.setEnd(sel.focusNode, sel.focusOffset);
      if (range.collapsed) return;
      if (delRange(range, /Backward/.test(t) ? 'back' : 'fwd')) e.preventDefault(); // across paragraphs: left to the browser (not tracked)
    } else return;
    markPages(); saveDraftSoon(); countWords();
  });

  // ---- accept / reject ----------------------------------------------------------
  const all = () => [...ed.querySelectorAll('span.tc')];
  function resolve(sp, accept) {
    const keep = (sp.dataset.k === 'ins') === accept; // accept an insertion or reject a deletion: the text stays
    const r = document.createRange(); r.selectNode(sp); select(r);
    exec(keep ? 'insertHTML' : 'delete', keep ? sp.innerHTML : undefined);
  }
  function inSelection() {
    const sel = getSelection(); if (!sel.rangeCount || !ed.contains(sel.anchorNode)) return [];
    const r = sel.getRangeAt(0);
    if (r.collapsed) { const t = tcOf(r.startContainer); return t ? [t] : []; }
    return all().filter((s) => r.intersectsNode(s));
  }
  function mark(sp) {
    all().forEach((s) => s.classList.remove('cur'));
    if (!sp) return;
    sp.classList.add('cur'); sp.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const r = document.createRange(); r.selectNodeContents(sp); select(r);
  }
  function step(dir) {
    const list = all(); if (!list.length) return msg('No tracked changes');
    const sel = getSelection(), r = sel.rangeCount ? sel.getRangeAt(0) : null;
    let i;
    if (!r || !ed.contains(sel.anchorNode)) i = dir > 0 ? 0 : list.length - 1;
    else if (dir > 0) { i = list.findIndex((s) => r.comparePoint(s, 0) > 0 || (!r.collapsed && false)); if (i < 0) i = 0; }
    else { for (i = list.length - 1; i >= 0; i--) if (r.comparePoint(list[i], 0) < 0 && !list[i].contains(r.startContainer)) break; if (i < 0) i = list.length - 1; }
    mark(list[i]);
  }
  function act(accept) {
    const list = inSelection();
    if (!list.length) return msg('Put the cursor on a change, or choose Next');
    list.reverse().forEach((s) => resolve(s, accept));
    finish(); step(1);
  }
  function actAll(accept) {
    const list = all(); if (!list.length) return msg('No tracked changes');
    list.reverse().forEach((s) => resolve(s, accept));
    finish(); msg((accept ? 'Accepted ' : 'Rejected ') + list.length + ' change' + (list.length === 1 ? '' : 's'));
  }
  const finish = () => { all().forEach((s) => s.classList.remove('cur')); markPages(); saveDraftSoon(); countWords(); };

  // ---- on / off -------------------------------------------------------------------
  function set(v) {
    on = v;
    const b = $('#tc-toggle'); if (b) b.setAttribute('aria-pressed', String(on));
    msg(on ? 'Track changes is on: your edits are marked as suggestions' : 'Track changes is off');
  }
  function toggle() {
    if (on) return set(false);
    if (MTRX.prefs.get('author', '')) return set(true);
    modal('Track changes', `<label>Your name (shown on each change)</label><input id="m-tn" maxlength="60" placeholder="e.g. Mary Banda"><p style="font-size:12px;color:#7b5d66;margin:8px 0 0">Changes you make are marked in colour. You or a reviewer can accept or reject each one.</p>`,
      (m) => { MTRX.prefs.set('author', m.querySelector('#m-tn').value.trim().slice(0, 60) || 'Author'); set(true); }, 'Start tracking');
    const i = $('#m-tn'); if (i) i.focus();
  }

  $('#tc-toggle').onclick = toggle;
  $('#tc-next').onclick = () => step(1);
  $('#tc-prev').onclick = () => step(-1);
  $('#tc-accept').onclick = () => act(true);
  $('#tc-reject').onclick = () => act(false);
  $('#tc-acceptall').onclick = () => actAll(true);
  $('#tc-rejectall').onclick = () => actAll(false);
  ['#tc-next', '#tc-prev', '#tc-accept', '#tc-reject'].forEach((s) => $(s).addEventListener('mousedown', (e) => e.preventDefault())); // keep the text selection
  MTRX.track = { toggle, step, act, actAll, isOn: () => on };
})();
