// Writer: table of contents and comments (the review tools). Loaded after app.js, uses its editor, dialogs and selection.
// Both are stored inside the document itself, so they survive crash recovery:
//   <div class="toc">...</div>                         the contents list (rebuilt from the headings, with page numbers)
//   <span class="cm" data-cid data-author data-date data-text data-replies data-done>text</span>   a comment on that text
// On export they become a real Word contents list and real Word comments (with replies); opening a .docx brings them back.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const $ = (s) => document.querySelector(s);
  const { ed, sheet, GAP, msg, modal, exec, saveDraftSoon, markPages, countWords } = MTRX.w;
  const savedRange = () => MTRX.w.saved();
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ======================= table of contents =======================
  const pageOfEl = (el) => {
    const ph = parseFloat(sheet.style.getPropertyValue('--ph')) || 1056;
    return Math.floor(el.offsetTop / (ph + GAP)) + 1;
  };
  const headings = () => [...ed.querySelectorAll('h1,h2,h3')].filter((h) => !h.closest('.toc') && h.textContent.trim());
  const tocHtml = (title) => {
    const items = headings().map((h) => `<div class="toc-i" data-l="${h.tagName[1]}"><span class="tx">${esc(h.textContent.trim())}</span><span class="pg">${pageOfEl(h)}</span></div>`).join('');
    return `<div class="toc" contenteditable="false"><div class="toc-t">${esc(title)}</div>${items || '<div class="toc-i" data-l="1"><span class="tx">No headings yet. Use Heading 1, 2 or 3 and update.</span></div>'}</div>`;
  };
  // Fill an existing contents block from the headings (called before every export too).
  function updateToc() {
    const t = ed.querySelector('.toc'); if (!t) return false;
    const title = t.querySelector('.toc-t')?.textContent || 'Table of contents';
    const fresh = document.createElement('div'); fresh.innerHTML = tocHtml(title);
    t.replaceChildren(...fresh.firstChild.childNodes);
    if (typeof markPages === 'function') markPages();
    // inserting lines can push headings onto another page: one more pass settles the numbers
    const again = headings().map((h) => pageOfEl(h)).join();
    if (again !== [...t.querySelectorAll('.pg')].map((p) => p.textContent).join()) {
      const f2 = document.createElement('div'); f2.innerHTML = tocHtml(title); t.replaceChildren(...f2.firstChild.childNodes);
      if (typeof markPages === 'function') markPages();
    }
    return true;
  }
  function insertToc() {
    if (ed.querySelector('.toc')) { updateToc(); saveDraftSoon(); return msg('Table of contents updated'); }
    ed.focus();
    const s = getSelection();
    let b = savedRange() ? savedRange().startContainer : (s.rangeCount ? s.anchorNode : null);
    while (b && b.parentNode !== ed) b = b.parentNode;
    const idx = b ? [...ed.childNodes].indexOf(b) : 0;
    const r = document.createRange(); r.setStart(ed, Math.max(0, idx)); r.collapse(true);
    s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertHTML', false, tocHtml('Table of contents'));
    updateToc(); saveDraftSoon(); countWords();
    if (!headings().length) msg('Add headings (Heading 1, 2, 3) and choose Update contents');
  }
  function deleteToc() { const t = ed.querySelector('.toc'); if (t) { t.remove(); markPages(); saveDraftSoon(); } }
  // The contents block goes to the model with its lines.
  MTRX.tocModel = () => {
    const t = ed.querySelector('.toc'); if (!t) return null;
    updateToc();
    return {
      type: 'toc', title: t.querySelector('.toc-t')?.textContent || '',
      entries: [...t.querySelectorAll('.toc-i')].filter((i) => i.querySelector('.pg') || headings().length).map((i) => ({ level: +i.dataset.l || 1, text: i.querySelector('.tx')?.textContent || '', page: +(i.querySelector('.pg')?.textContent || 0) || 0 })),
    };
  };

  // ======================= comments =======================
  const reps = (sp) => { try { const l = JSON.parse(sp.dataset.replies || '[]'); return Array.isArray(l) ? l : []; } catch { return []; } };
  const spans = () => [...ed.querySelectorAll('span.cm')];
  // All spans that belong to one comment (the text may be split by formatting).
  const group = (id) => spans().filter((s) => s.dataset.cid === id);
  const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';
  const when = (d) => { const t = Date.parse(d || ''); return t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
  const author = () => MTRX.prefs.get('author', '');

  // A comment model for export, from the attributes of one span.
  MTRX.commentOf = (sp) => ({
    id: +sp.dataset.cid || 0, author: sp.dataset.author || '', date: sp.dataset.date || '', text: sp.dataset.text || '',
    replies: reps(sp).map((r) => ({ author: r.a || '', date: r.d || '', text: r.t || '' })),
  });

  function addComment() {
    const r = savedRange();
    if (!r || r.collapsed || !ed.contains(r.commonAncestorContainer)) return msg('Select the text you want to comment on first');
    const tmp = document.createElement('div'); tmp.appendChild(r.cloneContents());
    if (tmp.querySelector('p,div,h1,h2,h3,li,ul,ol,table,tr,td,th,img,sup.fn,br')) return msg('Select text inside one paragraph');
    const anc = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    if (tmp.querySelector('span.cm') || anc.closest('span.cm')) return msg('That text already has a comment');
    if (anc.closest('.toc')) return msg('Comments go on your own text, not on the contents list');
    modal('Add comment',
      `<label>Your name</label><input id="m-cn" maxlength="60" value="${esc(author())}"><label>Comment</label><textarea id="m-ct" maxlength="2000" rows="4"></textarea>`,
      (m) => {
        const t = m.querySelector('#m-ct').value.trim(), who = m.querySelector('#m-cn').value.trim();
        if (!t) return;
        MTRX.prefs.set('author', who);
        const id = String(Math.max(0, ...spans().map((s) => +s.dataset.cid || 0)) + 1);
        exec('insertHTML', `<span class="cm" data-cid="${id}" data-author="${esc(who)}" data-date="${nowIso()}" data-text="${esc(t)}">${tmp.innerHTML}</span>`);
        saveDraftSoon(); render(true); openPanel(true); focusCard(id);
      }, 'Add');
    setTimeout(() => ($('#m-cn').value ? $('#m-ct') : $('#m-cn'))?.focus(), 30);
  }

  function editComment(id) {
    const sp = group(id)[0]; if (!sp) return;
    modal('Edit comment', `<label>Comment</label><textarea id="m-ct" maxlength="2000" rows="4"></textarea>`, (m) => {
      const t = m.querySelector('#m-ct').value.trim(); if (!t) return;
      group(id).forEach((s) => { s.dataset.text = t; });
      saveDraftSoon(); render();
    }, 'Save');
    $('#m-ct').value = sp.dataset.text || '';
  }
  function replyTo(id) {
    const sp = group(id)[0]; if (!sp) return;
    modal('Reply', `<label>Your name</label><input id="m-cn" maxlength="60" value="${esc(author())}"><label>Reply</label><textarea id="m-ct" maxlength="2000" rows="3"></textarea>`, (m) => {
      const t = m.querySelector('#m-ct').value.trim(), who = m.querySelector('#m-cn').value.trim(); if (!t) return;
      MTRX.prefs.set('author', who);
      const list = [...reps(sp), { a: who, d: nowIso(), t }];
      group(id).forEach((s) => { s.dataset.replies = JSON.stringify(list); });
      saveDraftSoon(); render();
    }, 'Reply');
    setTimeout(() => $('#m-ct')?.focus(), 30);
  }
  function resolveComment(id) {
    const g = group(id), on = !g[0]?.dataset.done;
    g.forEach((s) => { if (on) s.dataset.done = '1'; else s.removeAttribute('data-done'); });
    saveDraftSoon(); render();
  }
  function deleteComment(id) {
    group(id).forEach((s) => s.replaceWith(...s.childNodes));
    ed.normalize(); saveDraftSoon(); render(); countWords();
  }

  // ---- the comments panel ----
  const panel = document.createElement('aside');
  panel.id = 'cm-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Comments');
  document.body.appendChild(panel);
  let wantOpen = false;
  function openPanel(on) {
    wantOpen = on === undefined ? !wantOpen : !!on;
    panel.hidden = !wantOpen || !document.body.classList.contains('writer-on');
    document.body.classList.toggle('cm-open', !panel.hidden);
    place();
  }
  function place() {
    const d = $('#desk'); if (!d) return;
    const t = d.getBoundingClientRect().top;
    panel.style.top = t + 'px'; panel.style.bottom = (document.querySelector('footer.status')?.offsetHeight || 28) + 'px';
  }
  const onWriter = () => !document.body.classList.contains('home') && !document.body.classList.contains('pdf') && !document.body.classList.contains('sheets') && !document.body.classList.contains('solve');
  new MutationObserver(() => { document.body.classList.toggle('writer-on', onWriter()); panel.hidden = !wantOpen || !onWriter(); document.body.classList.toggle('cm-open', !panel.hidden); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.body.classList.toggle('writer-on', onWriter());
  window.addEventListener('resize', place);

  function card(id) {
    const g = group(id), sp = g[0];
    const done = !!sp.dataset.done;
    const c = document.createElement('div'); c.className = 'cm-card' + (done ? ' done' : ''); c.dataset.cid = id;
    const quote = g.map((s) => s.textContent).join(' ').trim();
    c.innerHTML = `<div class="cm-q">${esc(quote.length > 80 ? quote.slice(0, 80) + '…' : quote)}</div>
      <div class="cm-h"><b>${esc(sp.dataset.author || 'Reviewer')}</b><span>${esc(when(sp.dataset.date))}</span></div>
      <div class="cm-t">${esc(sp.dataset.text || '')}</div>
      ${reps(sp).map((r) => `<div class="cm-r"><div class="cm-h"><b>${esc(r.a || 'Reviewer')}</b><span>${esc(when(r.d))}</span></div><div class="cm-t">${esc(r.t || '')}</div></div>`).join('')}
      <div class="cm-b"><button data-a="reply">Reply</button><button data-a="edit">Edit</button><button data-a="done">${done ? 'Reopen' : 'Resolve'}</button><button data-a="del">Delete</button></div>`;
    c.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    c.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) { sp.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(id); return; }
      ({ reply: replyTo, edit: editComment, done: resolveComment, del: deleteComment })[b.dataset.a](id);
    });
    return c;
  }
  function render(keepClosed) {
    const ids = [...new Set(spans().map((s) => s.dataset.cid))];
    const open = ids.filter((i) => !group(i)[0].dataset.done).length;
    const btn = $('#btn-comments'); if (btn) btn.querySelector('span').textContent = ids.length ? `Comments (${ids.length})` : 'Comments';
    panel.replaceChildren();
    const head = document.createElement('div'); head.className = 'cm-top';
    head.innerHTML = `<b>Comments</b><span>${ids.length ? `${open} open` : ''}</span><button class="cm-x" aria-label="Close comments" title="Close">×</button>`;
    head.querySelector('.cm-x').onclick = () => openPanel(false);
    panel.appendChild(head);
    if (!ids.length) {
      const e = document.createElement('div'); e.className = 'cm-empty'; e.textContent = 'No comments yet. Select some text and choose Comment.'; panel.appendChild(e);
    }
    ids.forEach((id) => panel.appendChild(card(id)));
    if (!keepClosed && ids.length && wantOpen === false && !MTRX._cmAuto) { /* the panel only opens by itself when a file is opened */ }
  }
  function flash(id) {
    group(id).forEach((s) => { s.classList.add('cm-on'); setTimeout(() => s.classList.remove('cm-on'), 1400); });
  }
  function focusCard(id) {
    const c = panel.querySelector(`.cm-card[data-cid="${id}"]`); if (c) { c.scrollIntoView({ block: 'nearest' }); c.classList.add('cm-pulse'); setTimeout(() => c.classList.remove('cm-pulse'), 1200); }
  }
  // Click on commented text: open the panel at that comment.
  ed.addEventListener('click', (e) => {
    const sp = e.target.closest?.('span.cm'); if (!sp) return;
    if (!wantOpen) openPanel(true);
    focusCard(sp.dataset.cid);
  });
  // Keep the list in step with typing (a comment whose text is all deleted disappears with it).
  let t;
  ed.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { if (spans().length || panel.querySelector('.cm-card')) render(); }, 300); });

  // Called when a file or draft is loaded: show the comments, and open the panel when there are some.
  MTRX.reviewLoaded = () => {
    render();
    if (spans().length) openPanel(true);
  };

  // ======================= wiring =======================
  $('#ins-toc').onclick = insertToc;
  $('#ins-comment').onclick = addComment;
  $('#btn-comments').onclick = () => { render(); openPanel(); };
  MTRX.review = { insertToc, updateToc, deleteToc, addComment, openPanel, render };
  render();
})();
