// Find & replace, outline / page panel, ruler, symbols, date, change case, clear formatting.
// Pure UI on top of the editor DOM: nothing here changes what is saved to .docx except the text the user inserts.
(() => {
const $ = (s) => document.querySelector(s);
const ed = $('#editor'), desk = $('#desk'), sheet = $('#sheet');
if (!ed || !desk || !sheet) return;
const store = {
  get(k, d) { try { const v = localStorage.getItem('mtrx.writer.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mtrx.writer.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const keepFocus = (b) => { b.addEventListener('mousedown', (e) => e.preventDefault()); return b; };
const inWriter = () => !/(pdf|home|sheets|solve)/.test(document.body.className) && $('#modal-bg').hidden;
// The whole white page takes typing (margins included): a click there puts the caret at the nearest text.
// The grey desk around the page does not.
[desk, sheet].forEach((n) => n.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !inWriter()) return;
  if (e.target !== desk && e.target !== sheet && e.target.id !== 'zoomwrap') return;
  e.preventDefault();
  if (e.target !== sheet) { const s = getSelection(); if (s.rangeCount && ed.contains(s.anchorNode)) s.removeAllRanges(); ed.blur(); return; }
  const b = ed.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX, b.left + 1), b.right - 2), y = Math.min(Math.max(e.clientY, b.top + 1), b.bottom - 2);
  const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
  ed.focus({ preventScroll: true });
  if (r && ed.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  // keep drag-to-select working from the margin
  const mv = (m) => { const cx = Math.min(Math.max(m.clientX, b.left + 1), b.right - 2), cy = Math.min(Math.max(m.clientY, b.top + 1), b.bottom - 2), q = document.caretRangeFromPoint(cx, cy), s = getSelection(); if (q && s.rangeCount && ed.contains(q.startContainer)) s.extend(q.startContainer, q.startOffset); };
  const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
}));

// ---------- Find & replace ----------
const hl = window.CSS && CSS.highlights && typeof Highlight !== 'undefined';
const bar = el('div', 'findbar'); bar.hidden = true;
bar.innerHTML = `<div class="fr"><input id="f-q" placeholder="Find" spellcheck="false" aria-label="Find"><span id="f-n" class="fn">0/0</span>
<button type="button" id="f-case" title="Match case">Aa</button><button type="button" id="f-prev" title="Previous (Shift+Enter)">&#8593;</button><button type="button" id="f-next" title="Next (Enter)">&#8595;</button><button type="button" id="f-x" title="Close (Esc)">&times;</button></div>
<div class="fr rep"><input id="f-r" placeholder="Replace with" spellcheck="false" aria-label="Replace with"><button type="button" id="f-rep">Replace</button><button type="button" id="f-all">All</button></div>`;
document.body.appendChild(bar);
const fq = $('#f-q'), fr = $('#f-r');
let matches = [], cur = -1, matchCase = false;
function collect() {
  matches = [];
  const q = fq.value;
  if (!q) return;
  const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('.pb') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const needle = matchCase ? q : q.toLowerCase();
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = matchCase ? n.data : n.data.toLowerCase();
    for (let i = t.indexOf(needle); i !== -1; i = t.indexOf(needle, i + needle.length)) {
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + q.length); matches.push(r);
    }
  }
}
function paint() {
  if (hl) {
    CSS.highlights.set('find-all', new Highlight(...matches));
    if (cur >= 0 && matches[cur]) CSS.highlights.set('find-cur', new Highlight(matches[cur])); else CSS.highlights.delete('find-cur');
  }
  $('#f-n').textContent = matches.length ? (cur + 1) + '/' + matches.length : (fq.value ? 'None' : '0/0');
}
function go(i, scroll = true) {
  if (!matches.length) { cur = -1; paint(); return; }
  cur = (i + matches.length) % matches.length;
  paint();
  if (scroll) {
    const r = matches[cur].getBoundingClientRect(), d = desk.getBoundingClientRect();
    if (r.top < d.top + 60 || r.bottom > d.bottom - 40) desk.scrollTop += r.top - d.top - d.height / 3;
  }
}
function refind(keep = true) {
  const at = keep && cur >= 0 && matches[cur] ? matches[cur] : null;
  collect();
  cur = -1;
  if (at) cur = matches.findIndex((m) => m.startContainer === at.startContainer && m.startOffset >= at.startOffset);
  go(cur < 0 ? 0 : cur, false);
}
function openFind(replace) {
  if (!inWriter()) return;
  bar.hidden = false; bar.classList.toggle('with-rep', !!replace); bar.style.top = desk.getBoundingClientRect().top + 34 + 'px';
  const s = getSelection();
  if (s.rangeCount && !s.isCollapsed && ed.contains(s.anchorNode) && s.toString().length < 80 && !s.toString().includes('\n')) fq.value = s.toString();
  fq.focus(); fq.select(); refind(false);
}
function closeFind() {
  bar.hidden = true; matches = []; cur = -1;
  if (hl) { CSS.highlights.delete('find-all'); CSS.highlights.delete('find-cur'); }
  ed.focus();
}
function replaceRange(r, text) {
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  ed.focus();
  if (text) document.execCommand('insertText', false, text); else document.execCommand('delete'); // insertText ignores ''
}
fq.addEventListener('input', () => refind(false));
fq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(cur + (e.shiftKey ? -1 : 1)); } });
fr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#f-rep').click(); } });
$('#f-next').onclick = () => go(cur + 1);
$('#f-prev').onclick = () => go(cur - 1);
$('#f-x').onclick = closeFind;
$('#f-case').onclick = (e) => { matchCase = !matchCase; e.currentTarget.classList.toggle('on', matchCase); refind(false); };
$('#f-rep').onclick = () => {
  if (cur < 0 || !matches[cur]) { go(0); return; }
  const idx = cur; replaceRange(matches[idx], fr.value); collect(); go(Math.min(idx, matches.length - 1));
};
$('#f-all').onclick = () => {
  const list = matches.slice().reverse(), n = list.length;
  list.forEach((r) => replaceRange(r, fr.value));
  collect(); cur = -1; paint();
  const m = $('#msg'); if (m) m.textContent = n ? 'Replaced ' + n + (n === 1 ? ' match' : ' matches') : 'No matches';
};
bar.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFind(); } });
let findTimer = 0;
// Any change to the document (typing, replace, opening another file, table edits) invalidates the match ranges.
new MutationObserver(() => { if (bar.hidden) return; clearTimeout(findTimer); findTimer = setTimeout(() => refind(true), 250); }).observe(ed, { childList: true, subtree: true, characterData: true });
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !inWriter()) return;
  const k = e.key.toLowerCase();
  if (k === 'f' && !e.shiftKey) { e.preventDefault(); openFind(false); }
  else if (k === 'h' && !e.shiftKey) { e.preventDefault(); openFind(true); }
}, true);

// ---------- Side panel: outline + pages ----------
const side = el('aside', 'side'); side.id = 'side'; side.hidden = true;
side.innerHTML = '<div class="side-tabs"><button type="button" data-t="outline" class="on">Outline</button><button type="button" data-t="pages">Pages</button></div><div class="side-body" id="side-body"></div>';
document.body.appendChild(side);
let sideOpen = store.get('side', false), sideTab = store.get('sideTab', 'outline');
const sideBody = $('#side-body');
const deskTopOf = (node) => node.getBoundingClientRect().top - desk.getBoundingClientRect().top + desk.scrollTop;
function jump(node, caret) {
  desk.scrollTop = deskTopOf(node) - 36;
  if (caret) { const r = document.createRange(); r.selectNodeContents(node); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); ed.focus({ preventScroll: true }); }
}
function renderSide() {
  if (!sideOpen || !inWriter()) return;
  side.querySelectorAll('.side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === sideTab));
  sideBody.textContent = '';
  if (sideTab === 'outline') {
    const hs = [...ed.querySelectorAll('h1,h2,h3')].filter((h) => h.textContent.trim());
    if (!hs.length) { sideBody.appendChild(el('p', 'side-empty', 'Headings you add (Heading 1–3) appear here so you can jump around the document.')); return; }
    hs.forEach((h) => {
      const b = el('button', 'ol l' + h.tagName[1], h.textContent.trim().slice(0, 80));
      b.type = 'button'; b.onclick = () => jump(h, true); sideBody.appendChild(b);
    });
  } else {
    const boxes = [...sheet.querySelectorAll('.pgbox')], kids = [...ed.children];
    boxes.forEach((pb, i) => {
      const top = pb.offsetTop, bottom = top + pb.offsetHeight;
      const first = kids.find((k) => k.offsetTop >= top - 2 && k.offsetTop < bottom && k.textContent.trim());
      const b = el('button', 'thumb'); b.type = 'button';
      const card = el('span', 'tcard', first ? first.textContent.trim().slice(0, 70) : '');
      b.append(card, el('span', 'tnum', 'Page ' + (i + 1)));
      b.onclick = () => { desk.scrollTop = deskTopOf(pb) - 24; };
      sideBody.appendChild(b);
    });
  }
}
let sideTimer = 0;
const renderSideSoon = () => { clearTimeout(sideTimer); sideTimer = setTimeout(renderSide, 250); };
ed.addEventListener('input', renderSideSoon);
new MutationObserver(renderSideSoon).observe(sheet, { childList: true });
side.querySelectorAll('.side-tabs button').forEach((b) => { b.onclick = () => { sideTab = b.dataset.t; store.set('sideTab', sideTab); renderSide(); }; });

// ---------- Ruler ----------
const ruler = el('div', 'ruler'); ruler.id = 'ruler'; ruler.hidden = true;
document.body.appendChild(ruler);
let rulerOn = store.get('ruler', true), raf = 0;
function drawRuler() {
  raf = 0;
  if (!rulerOn || !inWriter()) return;
  const d = desk.getBoundingClientRect(), s = sheet.getBoundingClientRect();
  ruler.style.left = d.left + 'px'; ruler.style.width = desk.clientWidth + 'px'; ruler.style.top = d.top + 'px';
  const sc = s.width / sheet.offsetWidth, x0 = s.left - d.left;
  const cs = getComputedStyle(sheet), ml = parseFloat(cs.getPropertyValue('--ml')) || 96, mr = parseFloat(cs.getPropertyValue('--mr')) || 96, pw = sheet.offsetWidth;
  const frag = document.createDocumentFragment();
  const strip = el('div', 'rstrip'); strip.style.left = x0 + 'px'; strip.style.width = s.width + 'px';
  const body = el('div', 'rbody'); body.style.left = ml * sc + 'px'; body.style.width = (pw - ml - mr) * sc + 'px';
  strip.appendChild(body);
  const step = 96 / 8;
  for (let k = Math.ceil(-ml / step); k * step <= pw - ml; k++) {
    const x = (ml + k * step) * sc;
    if (x < 0 || x > s.width) continue;
    const t = el('i', k % 8 === 0 ? 'in' : k % 4 === 0 ? 'half' : 'q'); t.style.left = x + 'px'; strip.appendChild(t);
    if (k % 8 === 0 && k !== 0) { const n = el('b', null, String(Math.abs(k / 8))); n.style.left = x + 'px'; strip.appendChild(n); }
  }
  frag.appendChild(strip);
  ruler.textContent = ''; ruler.appendChild(frag);
}
const drawRulerSoon = () => { if (!raf) raf = requestAnimationFrame(drawRuler); };
desk.addEventListener('scroll', drawRulerSoon, { passive: true });
addEventListener('resize', drawRulerSoon);
new ResizeObserver(drawRulerSoon).observe(sheet);
new MutationObserver(drawRulerSoon).observe(sheet, { attributes: true, attributeFilter: ['style'] });
ruler.addEventListener('dblclick', () => { const b = $('#page-setup'); if (b) b.click(); });
ruler.title = 'Double-click to change margins';

// ---------- Layout / toggles ----------
function layout() {
  const w = inWriter();
  side.hidden = !(sideOpen && w);
  ruler.hidden = !(rulerOn && w);
  document.body.classList.toggle('has-side', sideOpen && w);
  document.body.classList.toggle('has-ruler', rulerOn && w);
  const st = $('.status'), dTop = desk.getBoundingClientRect().top;
  if (!side.hidden) { side.style.top = dTop + 'px'; side.style.bottom = (st ? st.offsetHeight : 28) + 'px'; renderSide(); }
  drawRulerSoon();
}
function setSide(v) { sideOpen = v; store.set('side', v); const b = $('#t-side'); if (b) b.classList.toggle('on', v); layout(); }
function setRuler(v) { rulerOn = v; store.set('ruler', v); const b = $('#t-ruler'); if (b) b.classList.toggle('on', v); layout(); }
const status = $('.status'), zoomCtl = $('#zoom');
if (status && zoomCtl) {
  const grp = el('span', 'viewtog');
  const mk = (id, label, title) => { const b = el('button', null, label); b.type = 'button'; b.id = id; b.title = title; return b; };
  const bs = mk('t-side', 'Panel', 'Outline and pages panel (Ctrl+Shift+O)'), br = mk('t-ruler', 'Ruler', 'Show / hide ruler');
  bs.onclick = () => setSide(!sideOpen); br.onclick = () => setRuler(!rulerOn);
  bs.classList.toggle('on', sideOpen); br.classList.toggle('on', rulerOn);
  grp.append(bs, br); status.insertBefore(grp, zoomCtl);
}
new MutationObserver(layout).observe(document.body, { attributes: true, attributeFilter: ['class'] });
addEventListener('resize', layout);
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o' && inWriter()) { e.preventDefault(); setSide(!sideOpen); }
}, true);
layout();

// ---------- Symbols, date, case, clear formatting ----------
const SYMS = '© ® ™ § ¶ † ‡ • … – — « » “ ” ‘ ’ ° ± × ÷ ≠ ≈ ≤ ≥ ∞ √ µ π Ω Δ Σ α β γ λ ← → ↑ ↓ ↔ ⇒ € £ ¥ ¢ ½ ¼ ¾ ² ³ ✓ ✗ ★ ☆ ♥ ♦ ♣ ♠ ☺ ♪ ☀ ✉'.split(' ');
// Check boxes: plain ☐ / ☑ characters (they survive .docx save and open as real text in Word).
// Click one in the editor to tick or untick it. "Checklist" puts a box at the start of each selected line.
const BOX = { '☐': '☑', '☑': '☐' };
ed.addEventListener('click', (e) => {
  if (e.button !== 0 || !document.caretRangeFromPoint) return;
  const r = document.caretRangeFromPoint(e.clientX, e.clientY);
  const n = r && r.startContainer;
  if (!n || n.nodeType !== 3) return;
  for (const o of [r.startOffset, r.startOffset - 1]) {
    const c = n.data[o];
    if (!BOX[c]) continue;
    const g = document.createRange(); g.setStart(n, o); g.setEnd(n, o + 1);
    const b = g.getBoundingClientRect();
    if (e.clientX < b.left - 1 || e.clientX > b.right + 1 || e.clientY < b.top - 1 || e.clientY > b.bottom + 1) continue;
    const s = getSelection(); s.removeAllRanges(); s.addRange(g);
    document.execCommand('insertText', false, BOX[c]);
    return;
  }
});
MTRX.checkbox = {
  insert() { ed.focus(); document.execCommand('insertText', false, '☐ '); },
  checklist() {
    ed.focus();
    const s = getSelection(); if (!s.rangeCount) return;
    const blocks = [...ed.children].filter((b) => s.containsNode(b, true));
    if (!blocks.length) return MTRX.checkbox.insert();
    const allBoxed = blocks.every((b) => /^[☐☑]\s/.test(b.textContent));
    blocks.forEach((b) => {
      const r = document.createRange(); r.selectNodeContents(b); r.collapse(true);
      s.removeAllRanges(); s.addRange(r);
      if (allBoxed) { r.setEnd(b.firstChild?.nodeType === 3 ? b.firstChild : b, 0); }
      if (!allBoxed) document.execCommand('insertText', false, '☐ ');
      else { const t = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode(); if (t) { const g = document.createRange(); g.setStart(t, 0); g.setEnd(t, 2); s.removeAllRanges(); s.addRange(g); document.execCommand('delete'); } }
    });
  },
};
const pop = el('div', 'sympop'); pop.hidden = true;
SYMS.forEach((c) => { const b = keepFocus(el('button', null, c)); b.type = 'button'; b.onclick = () => { ed.focus(); document.execCommand('insertText', false, c); }; pop.appendChild(b); });
document.body.appendChild(pop);
const symBtn = $('#ins-sym');
if (symBtn) {
  keepFocus(symBtn).onclick = (e) => {
    e.stopPropagation();
    if (!pop.hidden) { pop.hidden = true; return; }
    const r = symBtn.getBoundingClientRect(); pop.hidden = false;
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + 'px'; pop.style.top = r.bottom + 6 + 'px';
  };
  addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !symBtn.contains(e.target)) pop.hidden = true; }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true; }, true);
}
const dateBtn = $('#ins-date');
if (dateBtn) keepFocus(dateBtn).onclick = () => { ed.focus(); document.execCommand('insertText', false, new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })); };

const caseSel = $('#sel-case');
const titleCase = (t) => t.toLowerCase().replace(/(^|[\s\-(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
if (caseSel) {
  caseSel.onchange = () => {
    const s = getSelection(), mode = caseSel.value; caseSel.value = '';
    if (!mode || !s.rangeCount || s.isCollapsed || !ed.contains(s.anchorNode)) return;
    const t = s.toString();
    const out = mode === 'upper' ? t.toUpperCase() : mode === 'lower' ? t.toLowerCase() : mode === 'title' ? titleCase(t) : t.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    ed.focus(); document.execCommand('insertText', false, out);
  };
}
const clr = $('#fmt-clear');
if (clr) keepFocus(clr).onclick = () => { ed.focus(); document.execCommand('removeFormat'); };
const findBtn = $('#btn-find');
if (findBtn) keepFocus(findBtn).onclick = () => openFind(false);

// ---------- Drag the corner of a table to add / remove rows and columns ----------
const grip = el('div', 'tgrip'); grip.hidden = true; grip.title = 'Drag to add rows and columns'; document.body.appendChild(grip);
let gTable = null, gRaf = 0, drag = null;
const tableAtCaret = () => { const s = getSelection(); const n = s.rangeCount ? s.anchorNode : null; const t = n && (n.nodeType === 1 ? n : n.parentElement).closest('table'); return t && ed.contains(t) ? t : null; };
let placeGrip = function () {
  gRaf = 0;
  if (!gTable || !gTable.isConnected || !inWriter()) { grip.hidden = true; return; }
  const r = gTable.getBoundingClientRect(), d = desk.getBoundingClientRect();
  if (r.bottom < d.top || r.top > d.bottom) { grip.hidden = true; return; }
  grip.hidden = false; grip.style.left = r.right - 7 + 'px'; grip.style.top = r.bottom - 7 + 'px';
}
const placeGripSoon = () => { if (!gRaf) gRaf = requestAnimationFrame(placeGrip); };
document.addEventListener('selectionchange', () => { if (drag) return; const t = tableAtCaret(); if (t || !gTable || !gTable.matches(':hover')) gTable = t; placeGripSoon(); });
ed.addEventListener('mouseover', (e) => { if (drag) return; const t = e.target.closest && e.target.closest('table'); if (t) { gTable = t; placeGripSoon(); } });
desk.addEventListener('scroll', placeGripSoon, { passive: true });
addEventListener('resize', placeGripSoon);
ed.addEventListener('input', placeGripSoon);
new ResizeObserver(placeGripSoon).observe(sheet);
new MutationObserver(placeGripSoon).observe(sheet, { attributes: true, attributeFilter: ['style'] });
// Keep explicit column widths (row-0 cell widths, in %) adding up to 100 after columns are added or removed.
function normCols(t) {
  if (!t || t.style.tableLayout !== 'fixed' || !t.rows[0]) return;
  const cells = [...t.rows[0].cells], n = cells.length;
  const ws = cells.map((c) => parseFloat(c.style.width));
  const known = ws.filter((x) => isFinite(x));
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 100 / n;
  const fixed = ws.map((x) => (isFinite(x) ? x : avg)), sum = fixed.reduce((a, b) => a + b, 0) || 100;
  cells.forEach((c, i) => { c.style.width = (fixed[i] / sum * 100).toFixed(2) + '%'; });
}
(window.MTRX = window.MTRX || {}).normCols = normCols;
// Swap a table for an edited copy with insertHTML so the browser records it as one undo step.
// mutate(clone) edits the copy; return false to delete the table, or a string to insert that markup instead.
function editTable(t, mutate) {
  const clone = t.cloneNode(true); MTRX.clearCellPad(clone);
  const res = mutate(clone);
  const s = getSelection(), r = document.createRange(); r.selectNode(t);
  ed.focus(); s.removeAllRanges(); s.addRange(r);
  const idx = [...ed.querySelectorAll('table')].indexOf(t);
  if (res === false) { document.execCommand('delete'); if (!ed.firstElementChild) ed.innerHTML = '<p><br></p>'; }
  else document.execCommand('insertHTML', false, typeof res === 'string' ? res : clone.outerHTML);
  const n = res === false ? null : ed.querySelectorAll('table')[idx] || null;
  if (gTable === t) gTable = n;
  placeGripSoon();
  return n;
}
// A live drag already changed the table; roll back to `orig` and re-apply the result as one undoable step.
function commitTable(t, orig) {
  if (!t.isConnected) return t;
  const box = document.createElement('div'); box.innerHTML = t.outerHTML; MTRX.clearCellPad(box);
  const final = box.innerHTML; if (final === orig) return t;
  const tmp = document.createElement('div'); tmp.innerHTML = orig; const o = tmp.firstElementChild; t.replaceWith(o);
  return editTable(o, () => final);
}
MTRX.editTable = editTable;
const cellEmpty = (c) => !c.textContent.trim() && !c.querySelector('img');
function setSize(t, rows, cols) {
  for (;;) { // rows
    const trs = [...t.rows];
    if (trs.length < rows) { const last = trs[trs.length - 1], tr = last.cloneNode(true); tr.querySelectorAll('th,td').forEach((c) => { const n = document.createElement('td'); n.innerHTML = '<br>'; if (c.getAttribute('style')) n.setAttribute('style', c.getAttribute('style')); c.replaceWith(n); }); last.after(tr); }
    else if (trs.length > rows && trs.length > 1 && [...trs[trs.length - 1].cells].every(cellEmpty)) trs[trs.length - 1].remove();
    else break;
  }
  for (;;) { // columns
    const n = t.rows[0].cells.length;
    if (n < cols) [...t.rows].forEach((tr, ri) => { const c = document.createElement(ri === 0 && tr.cells[0] && tr.cells[0].tagName === 'TH' ? 'th' : 'td'); c.innerHTML = '<br>'; tr.appendChild(c); });
    else if (n > cols && n > 1 && [...t.rows].every((tr) => tr.cells[n - 1] && cellEmpty(tr.cells[n - 1]))) [...t.rows].forEach((tr) => tr.cells[n - 1].remove());
    else break;
  }
  normCols(t);
}
function dragMove(e) {
  if (!drag) return;
  if (e.buttons === 0) { endDrag(); return; } // button released somewhere we did not see
  const cols = Math.max(1, drag.cols + Math.round((e.clientX - drag.x) / drag.cw)), rows = Math.max(1, drag.rows + Math.round((e.clientY - drag.y) / drag.rh));
  if (cols === drag.t.rows[0].cells.length && rows === drag.t.rows.length) return;
  setSize(drag.t, Math.min(rows, 200), Math.min(cols, 20));
  placeGrip();
}
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  commitTable(d.t, d.orig); document.body.classList.remove('tdrag');
  removeEventListener('pointermove', dragMove, true); removeEventListener('pointerup', endDrag, true); removeEventListener('pointercancel', endDrag, true); removeEventListener('blur', endDrag);
  ed.dispatchEvent(new Event('input', { bubbles: true })); placeGripSoon();
}
grip.addEventListener('pointerdown', (e) => {
  if (!gTable || drag) return;
  e.preventDefault();
  const r = gTable.getBoundingClientRect(), rows = gTable.rows.length, cols = gTable.rows[0].cells.length;
  drag = { x: e.clientX, y: e.clientY, rows, cols, cw: r.width / cols, rh: r.height / rows, t: gTable, orig: (MTRX.clearCellPad(ed), gTable.outerHTML) };
  document.body.classList.add('tdrag');
  addEventListener('pointermove', dragMove, true); addEventListener('pointerup', endDrag, true); addEventListener('pointercancel', endDrag, true); addEventListener('blur', endDrag);
});
// The desk moves/resizes when the ribbon grows (e.g. the table tools row appears): re-measure everything that floats over it.
new ResizeObserver(() => { layout(); placeGripSoon(); }).observe(desk);

// ---------- Drag a column border to resize columns ----------
let colHover = null, colDrag = null;
function borderAt(e) {
  const cell = e.target.closest && e.target.closest('td,th');
  if (!cell || !ed.contains(cell) || MTRX.tbl?.merged(cell.closest('table'))) return null;
  const r = cell.getBoundingClientRect();
  if (cell.nextElementSibling && Math.abs(e.clientX - r.right) <= 4) return { t: cell.closest('table'), i: cell.cellIndex };
  if (cell.previousElementSibling && Math.abs(e.clientX - r.left) <= 4) return { t: cell.closest('table'), i: cell.cellIndex - 1 };
  return null;
}
ed.addEventListener('mousemove', (e) => { if (colDrag) return; colHover = borderAt(e); ed.classList.toggle('colresize', !!colHover); });
ed.addEventListener('mouseleave', () => { if (!colDrag) { colHover = null; ed.classList.remove('colresize'); } });
ed.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  colHover = borderAt(e);
  if (!colHover) return;
  const { t, i } = colHover, row = [...t.rows[0].cells];
  if (!row[i + 1]) return;
  e.preventDefault();
  const orig = (MTRX.clearCellPad(ed), t.outerHTML);
  const px = row.map((c) => c.offsetWidth), sum = px.reduce((a, b) => a + b, 0);
  const w = px.map((x) => x / sum * 100);
  t.style.tableLayout = 'fixed';
  row.forEach((c, k) => { c.style.width = w[k].toFixed(2) + '%'; });
  colDrag = { orig, t, i, x: e.clientX, w, tw: t.getBoundingClientRect().width, row };
  document.body.classList.add('tdrag-col');
  addEventListener('mousemove', colMove, true); addEventListener('mouseup', colEnd, true);
});
function colMove(e) {
  if (!colDrag) return;
  if (e.buttons === 0) { colEnd(); return; }
  const { w, i, row } = colDrag, tot = w[i] + w[i + 1], min = 4;
  const left = Math.min(tot - min, Math.max(min, w[i] + (e.clientX - colDrag.x) / colDrag.tw * 100));
  row[i].style.width = left.toFixed(2) + '%'; row[i + 1].style.width = (tot - left).toFixed(2) + '%';
  placeGrip();
}
function colEnd() {
  if (!colDrag) return;
  const d = colDrag; colDrag = null; document.body.classList.remove('tdrag-col');
  commitTable(d.t, d.orig);
  removeEventListener('mousemove', colMove, true); removeEventListener('mouseup', colEnd, true);
  ed.dispatchEvent(new Event('input', { bubbles: true })); placeGripSoon();
}

// ---------- "+" buttons to add a row / column, and Tab to move between cells ----------
const addRowBtn = el('button', 'tplus', '+'), addColBtn = el('button', 'tplus', '+');
addRowBtn.type = addColBtn.type = 'button'; addRowBtn.title = 'Add a row'; addColBtn.title = 'Add a column';
addRowBtn.hidden = addColBtn.hidden = true;
document.body.append(addRowBtn, addColBtn);
[addRowBtn, addColBtn].forEach(keepFocus);
addRowBtn.onclick = () => { if (gTable && MTRX.tbl?.merged(gTable)) MTRX.w.msg('Split the merged cells first'); else if (gTable) { editTable(gTable, (c) => { setSize(c, c.rows.length + 1, c.rows[0].cells.length); }); ed.dispatchEvent(new Event('input', { bubbles: true })); placeGrip(); } };
addColBtn.onclick = () => { if (gTable && MTRX.tbl?.merged(gTable)) MTRX.w.msg('Split the merged cells first'); else if (gTable && gTable.rows[0].cells.length < 20) { editTable(gTable, (c) => { setSize(c, c.rows.length, c.rows[0].cells.length + 1); }); ed.dispatchEvent(new Event('input', { bubbles: true })); placeGrip(); } };
const baseGrip = placeGrip;
placeGrip = function () {
  baseGrip();
  const show = !grip.hidden && gTable && gTable.isConnected;
  addRowBtn.hidden = addColBtn.hidden = !show;
  if (!show) return;
  const r = gTable.getBoundingClientRect();
  addRowBtn.style.left = r.left + r.width / 2 - 10 + 'px'; addRowBtn.style.top = r.bottom + 4 + 'px';
  addColBtn.style.left = r.right + 4 + 'px'; addColBtn.style.top = r.top + r.height / 2 - 10 + 'px';
};
ed.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
  const s = getSelection(), n = s.rangeCount ? s.anchorNode : null;
  const host = n && (n.nodeType === 1 ? n : n.parentElement);
  const cell = host && host.closest('td,th');
  if (!cell || !ed.contains(cell)) {
    if (!host || !ed.contains(host)) return;
    e.preventDefault();
    if (host.closest('li')) document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    else if (!e.shiftKey) document.execCommand('insertText', false, '    ');
    return;
  }
  e.preventDefault();
  const t = cell.closest('table'), cells = [...t.querySelectorAll('td,th')];
  let k = cells.indexOf(cell) + (e.shiftKey ? -1 : 1), tt = t;
  if (k >= cells.length) { const w = t.rows[0].cells.length; tt = editTable(t, (c) => { setSize(c, c.rows.length + 1, w); }) || t; ed.dispatchEvent(new Event('input', { bubbles: true })); k = tt.querySelectorAll('td,th').length - w; }
  const tgt = [...tt.querySelectorAll('td,th')][Math.max(0, k)];
  if (!tgt) return;
  const r = document.createRange(); r.selectNodeContents(tgt); r.collapse(false); s.removeAllRanges(); s.addRange(r);
});
// ---------- Pictures: select, stretch freely, wrap around text / behind / in front, move ----------
const imgBox = el('div', 'imgbox'); imgBox.hidden = true;
['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((c) => { const h = el('div', 'hdl hdl-' + c); h.dataset.c = c; imgBox.appendChild(h); });
const imgBar = el('div', 'imgbar'); imgBar.hidden = true;
const WRAPS = [['inline', 'In line', 'Sits in the text like a letter'], ['left', 'Left', 'Float left, text wraps on the right'], ['right', 'Right', 'Float right, text wraps on the left'], ['behind', 'Behind text', 'Free position, text runs over it'], ['front', 'In front', 'Free position, covers the text']];
const wrapBtns = WRAPS.map(([k, label, tip]) => { const b = el('button', '', label); b.type = 'button'; b.title = tip; b.dataset.k = k; imgBar.appendChild(b); return b; });
document.body.append(imgBox, imgBar);
let gImg = null, imgDrag = null, imgTimer;
const sheetPos = (img) => { const r = img.getBoundingClientRect(), s = sheet.getBoundingClientRect(), k = s.width / sheet.offsetWidth || 1; return [Math.round((r.left - s.left) / k), Math.round((r.top - s.top) / k)]; };
const isFloat = (i) => i.dataset.wrap === 'behind' || i.dataset.wrap === 'front';
// Floating pictures are positioned from data-x / data-y (page px); keep the inline style in step.
MTRX.fixImgs = () => ed.querySelectorAll('img[data-wrap]').forEach((i) => {
  if (isFloat(i)) { const x = (parseFloat(i.dataset.x) || 0) + 'px', y = (parseFloat(i.dataset.y) || 0) + 'px'; if (i.style.left !== x) i.style.left = x; if (i.style.top !== y) i.style.top = y; }
  else if (i.style.left || i.style.top) { i.style.removeProperty('left'); i.style.removeProperty('top'); }
});
function placeImg() {
  if (!gImg || !gImg.isConnected || !ed.contains(gImg) || !inWriter()) { imgBox.hidden = imgBar.hidden = true; return; }
  const r = gImg.getBoundingClientRect();
  Object.assign(imgBox.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  const bw = imgBar.offsetWidth || 330;
  Object.assign(imgBar.style, { left: Math.max(4, Math.min(innerWidth - bw - 4, r.left)) + 'px', top: Math.max(4, r.top - 40) + 'px' });
  imgBox.hidden = imgBar.hidden = false;
  const cur = gImg.dataset.wrap || 'inline'; wrapBtns.forEach((b) => b.classList.toggle('on', b.dataset.k === cur));
}
const placeImgSoon = () => { clearTimeout(imgTimer); imgTimer = setTimeout(placeImg, 30); };
// Swap a picture for an edited copy with insertHTML so Ctrl+Z undoes it as one step.
function swapImg(img, mutate) {
  const idx = [...ed.querySelectorAll('img')].indexOf(img), clone = img.cloneNode(true); mutate(clone);
  const s = getSelection(), r = document.createRange(); r.selectNode(img); ed.focus(); s.removeAllRanges(); s.addRange(r);
  document.execCommand('insertHTML', false, clone.outerHTML);
  gImg = ed.querySelectorAll('img')[idx] || null; placeImg(); MTRX.fixImgs();
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}
const setWrap = (img, k) => { const [x, y] = sheetPos(img); swapImg(img, (c) => { if (k === 'inline') { c.removeAttribute('data-wrap'); } else c.dataset.wrap = k; if (k === 'behind' || k === 'front') { c.dataset.x = x; c.dataset.y = y; } else { c.removeAttribute('data-x'); c.removeAttribute('data-y'); c.style.removeProperty('left'); c.style.removeProperty('top'); } }); };
imgBar.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
imgBar.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && gImg) setWrap(gImg, b.dataset.k); });
// Is there real text under this point? (a picture behind text is only picked where the text is not)
function textAt(x, y) {
  const rg = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
  if (!rg || rg.startContainer.nodeType !== 3) return false;
  const t = document.createRange(); t.selectNodeContents(rg.startContainer);
  return [...t.getClientRects()].some((q) => x >= q.left && x <= q.right && y >= q.top && y <= q.bottom);
}
function imgAtPoint(e) {
  if (e.target.tagName === 'IMG') return e.target;
  if (textAt(e.clientX, e.clientY)) return null;
  return [...ed.querySelectorAll('img[data-wrap=behind]')].reverse().find((i) => { const r = i.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; }) || null;
}
ed.addEventListener('click', (e) => {
  const i = e.altKey ? MTRX.pickImg(e) : imgAtPoint(e); gImg = i;
  ed.querySelectorAll('img.sel').forEach((x) => x.classList.remove('sel')); if (i) i.classList.add('sel');
  placeImg();
});
function delImg(img) {
  const s = getSelection(), r = document.createRange(); r.selectNode(img); ed.focus(); s.removeAllRanges(); s.addRange(r);
  document.execCommand('delete'); gImg = null; placeImg(); ed.dispatchEvent(new Event('input', { bubbles: true }));
}
ed.addEventListener('keydown', (e) => {
  if (!gImg || imgDrag) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delImg(gImg); return; }
  if (e.key === 'Escape') { gImg.classList.remove('sel'); gImg = null; placeImg(); return; }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) { gImg = null; placeImg(); } // typing leaves the picture
});
// Right-click / Alt+click pick a picture even when text covers it; the menu then offers picture actions.
MTRX.pickImg = (e) => {
  let i = imgAtPoint(e);
  if (!i) i = [...ed.querySelectorAll('img')].reverse().find((x) => { const r = x.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; }) || null;
  if (!i) return null;
  ed.querySelectorAll('img.sel').forEach((x) => x.classList.remove('sel')); i.classList.add('sel'); gImg = i; placeImg();
  return i;
};
MTRX.imgItems = (img) => [
  ['Delete picture', 'Del', () => delImg(img)],
  ...WRAPS.map(([k, label]) => ['Wrap: ' + label, '', () => setWrap(img, k)]),
];
desk.addEventListener('scroll', placeImgSoon, { passive: true });
addEventListener('resize', placeImgSoon);
ed.addEventListener('input', placeImgSoon);
new ResizeObserver(placeImgSoon).observe(sheet);
new MutationObserver(placeImgSoon).observe(sheet, { attributes: true, attributeFilter: ['style'] });

// stretch from a handle, or move a floating picture by dragging it
function startImgDrag(e, mode, c) {
  const i = gImg; if (!i) return;
  const r = i.getBoundingClientRect(), scale = r.width / (i.offsetWidth || r.width) || 1;
  imgDrag = { img: i, mode, c, orig: i.outerHTML, x: e.clientX, y: e.clientY, w: i.offsetWidth, h: i.offsetHeight, ix: parseFloat(i.dataset.x) || 0, iy: parseFloat(i.dataset.y) || 0, scale };
  addEventListener('pointermove', imgMove, true); addEventListener('pointerup', imgEnd, true);
}
imgBox.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !gImg) return;
  const h = e.target.closest('.hdl');
  if (h) { e.preventDefault(); startImgDrag(e, 'size', h.dataset.c); }
  else if (isFloat(gImg)) { e.preventDefault(); startImgDrag(e, 'move'); }
});
ed.addEventListener('pointerdown', (e) => { // floating pictures move with a plain drag; the browser's own drag handles the rest
  const i = e.button === 0 ? imgAtPoint(e) : null;
  if (i && i === gImg && isFloat(i)) { e.preventDefault(); startImgDrag(e, 'move'); }
});
function imgMove(e) {
  if (!imgDrag) return;
  if (e.buttons === 0) return imgEnd();
  const d = imgDrag, i = d.img, dx = (e.clientX - d.x) / d.scale, dy = (e.clientY - d.y) / d.scale;
  if (d.mode === 'move') { i.dataset.x = Math.round(d.ix + dx); i.dataset.y = Math.round(d.iy + dy); MTRX.fixImgs(); placeImg(); return; }
  const c = d.c; let w = d.w, h = d.h;
  if (c.includes('e')) w = d.w + dx; if (c.includes('w')) w = d.w - dx;
  if (c.includes('s')) h = d.h + dy; if (c.includes('n')) h = d.h - dy;
  if (e.shiftKey && c.length === 2) { const k = Math.max(w / d.w, h / d.h); w = d.w * k; h = d.h * k; } // Shift = keep proportions
  w = Math.max(16, Math.min(ed.clientWidth || 800, Math.round(w))); h = Math.max(16, Math.round(h));
  i.setAttribute('width', w); i.setAttribute('height', h); i.style.removeProperty('width'); i.style.removeProperty('height');
  if (isFloat(i)) { // growing from the left / top edge moves the picture
    if (c.includes('w')) i.dataset.x = Math.round(d.ix + d.w - w);
    if (c.includes('n')) i.dataset.y = Math.round(d.iy + d.h - h);
    MTRX.fixImgs();
  }
  placeImg();
}
function imgEnd() {
  if (!imgDrag) return;
  const d = imgDrag; imgDrag = null;
  removeEventListener('pointermove', imgMove, true); removeEventListener('pointerup', imgEnd, true);
  const i = d.img, final = i.outerHTML; if (!i.isConnected || final === d.orig) return;
  const idx = [...ed.querySelectorAll('img')].indexOf(i);
  const tmp = document.createElement('div'); tmp.innerHTML = d.orig; const o = tmp.firstElementChild; i.replaceWith(o);
  const s = getSelection(), r = document.createRange(); r.selectNode(o); ed.focus(); s.removeAllRanges(); s.addRange(r);
  document.execCommand('insertHTML', false, final); // one undoable step
  gImg = ed.querySelectorAll('img')[idx] || null; MTRX.fixImgs(); placeImg();
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}
})();
