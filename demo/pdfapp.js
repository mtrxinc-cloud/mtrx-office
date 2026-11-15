// MTRX PDF: read a PDF (pdf.js), annotate it, and write the result back (pdf-lib).
// Annotations are stored in PDF user-space points so they survive zoom and page rotation.
(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const MTRX = (window.MTRX = window.MTRX || {});
const invoke = window.__TAURI__?.core?.invoke;
const pdfjs = window.pdfjsLib, PL = window.PDFLib;
if (!pdfjs || !PL) return;
pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const host = $('#pdf-pages');
let bytes = null, doc = null, name = '';
let pages = [];              // { idx, pg, extra, deleted, el, canvas, layer, svg, vp, token }
let notes = [];              // annotations (see add*)
let history = [];            // undo stack
let tool = 'select', zoom = 1, sel = null, curPage = 0, nextId = 1;
let dirty = false;

const msg = (t) => { $('#pdf-msg').textContent = t; setTimeout(() => { if ($('#pdf-msg').textContent === t) $('#pdf-msg').textContent = ''; }, 5000); };
const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const bytesToB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rotOf = (P) => (((P.pg.rotate + P.extra) % 360) + 360) % 360;
const vpOf = (P, scale) => P.pg.getViewport({ scale, rotation: rotOf(P) });
const toView = (P, p) => P.vp.convertToViewportPoint(p[0], p[1]);
const toPdf = (P, x, y) => P.vp.convertToPdfPoint(x, y);
const live = () => pages.filter((P) => !P.deleted);

// ---- show / open -------------------------------------------------------
function showPdf() { document.body.classList.remove('home'); document.body.classList.add('pdf'); }
MTRX.showPdf = showPdf;

async function openPdf(fileName, b64) {
  showPdf();
  let data;
  try { data = b64ToBytes(b64); } catch { return msg('That file could not be read'); }
  try {
    const d = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false }).promise;
    if (doc) doc.destroy();
    doc = d; bytes = data; name = fileName || 'Document'; notes = []; history = []; sel = null; dirty = false; curPage = 0; lastSig = ''; MTRX.session.saved('pdf');
    $('#pdf-name').textContent = name + '.pdf';
    await buildPages();
    zoom = 1; relayout(); // opens at 100%
  } catch (e) {
    msg(e?.name === 'PasswordException' ? 'Password-protected PDFs are not supported yet' : 'Could not open this PDF: ' + (e?.message || e));
  }
}
MTRX.openPdf = openPdf;

// Shared recovery (session.js): the PDF, its annotations and page rotations/removals are kept as you work.
let bytesB64 = null, bytesFor = null, lastSig = '';
MTRX.session.register('pdf', {
  label: 'PDF',
  msg,
  isDirty: () => dirty,
  snapshot: () => {
    if (!bytes) return null;
    const st = pages.map((P) => ({ extra: P.extra, deleted: !!P.deleted }));
    const sig = JSON.stringify([notes, st, nextId]);
    if (sig === lastSig) return undefined;
    lastSig = sig;
    if (bytesFor !== bytes) { bytesB64 = bytesToB64(bytes); bytesFor = bytes; } // the original never changes, encode it once
    return { name, data: bytesB64, notes, pages: st, nextId };
  },
  restore: async (d) => {
    await openPdf(d.name, d.data);
    notes = d.notes || []; nextId = d.nextId || 1;
    pages.forEach((P, i) => { const s = d.pages?.[i]; if (!s) return; P.extra = s.extra; P.deleted = s.deleted; P.el.style.opacity = P.deleted ? '.3' : ''; });
    relayout(); pages.forEach((P) => drawNotes(P)); dirty = true; status(); MTRX.session.changed('pdf');
  },
  title: (d) => d.name + '.pdf',
});

$('#pdf-open').onclick = async () => {
  if (!invoke) return;
  if (!MTRX.session.confirmLose('pdf')) return;
  try { const f = await invoke('open_pdf'); if (f) openPdf(f.name, f.data); } catch (e) { msg('Open failed: ' + e); }
};
$('#pdf-home').onclick = () => MTRX.goHome?.();

// ---- pages -------------------------------------------------------------
const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) render(en.target._P); }), { root: host, rootMargin: '700px 0px' });

async function buildPages() {
  io.disconnect(); host.replaceChildren(); pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const el = document.createElement('div'); el.className = 'pdf-page';
    const canvas = document.createElement('canvas');
    const layer = document.createElement('div'); layer.className = 'pdf-layer t-' + tool;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const tl = document.createElement('div'); tl.className = 'pdf-text';
    layer.appendChild(svg); el.append(canvas, tl, layer);
    const P = { idx: i - 1, pg, extra: 0, deleted: false, el, canvas, tl, layer, svg, vp: null, token: 0 };
    el._P = P; layer._P = P;
    wireLayer(P);
    pages.push(P); host.appendChild(el);
  }
  pages.forEach(sizePage);
  pages.forEach((P) => io.observe(P.el));
  status();
}

function sizePage(P) {
  P.vp = vpOf(P, zoom);
  P.el.style.width = P.vp.width + 'px'; P.el.style.height = P.vp.height + 'px';
  P.rendered = false;
  drawNotes(P);
}

// Invisible, selectable copy of the page's text (sits over the picture) so Ctrl+A, drag-select and Ctrl+C work.
const measure = document.createElement('canvas').getContext('2d');
async function buildText(P, token) {
  try {
    const tc = await P.pg.getTextContent(), vp = vpOf(P, zoom), frag = document.createDocumentFragment();
    if (token !== P.token) return;
    for (const it of tc.items) {
      if (!it.str) continue;
      const t = pdfjsLib.Util.transform(vp.transform, it.transform), h = Math.hypot(t[2], t[3]);
      if (!h || Math.abs(t[1]) > 0.01 * h) continue; // rotated text is skipped
      const s = document.createElement('span');
      s.textContent = it.str;
      s.style.cssText = `left:${t[4]}px;top:${t[5] - h}px;font-size:${h}px`;
      measure.font = h + 'px sans-serif';
      const w = measure.measureText(it.str).width, want = it.width * vp.scale;
      if (it.str.trim() && w > 0 && want > 0) s.style.transform = `scaleX(${Math.min(3, Math.max(0.3, want / w))})`;
      s.dataset.eol = it.hasEOL ? '1' : '';
      frag.appendChild(s);
    }
    P.tl.replaceChildren(frag);
  } catch (e) { console.warn('text layer failed', e); }
}
MTRX.pdfSelectAll = () => { const r = document.createRange(); r.selectNodeContents(host); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
// Turn the selected text into highlights (one box per line), for the floating selection bar and the right-click menu.
MTRX.pdfHighlightSelection = () => {
  const s = getSelection(); if (!s.rangeCount || s.isCollapsed) return 0;
  const r = s.getRangeAt(0), boxes = new Map();
  host.querySelectorAll('.pdf-text span').forEach((sp) => {
    const tn = sp.firstChild; if (!tn || !r.intersectsNode(sp) || r.comparePoint(tn, 0) > 0) return;
    const q = document.createRange(); q.selectNodeContents(sp);
    if (tn === r.startContainer) q.setStart(tn, r.startOffset);
    if (tn === r.endContainer) q.setEnd(tn, r.endOffset);
    const b = q.getBoundingClientRect(); if (b.width < 1 || b.height < 1) return;
    const P = sp.closest('.pdf-page')._P, lr = P.layer.getBoundingClientRect(), list = boxes.get(P) || [];
    const x0 = b.left - lr.left, x1 = b.right - lr.left, y0 = b.top - lr.top, y1 = b.bottom - lr.top;
    const hit = list.find((m) => Math.abs(m.y0 - y0) < 3 && Math.abs(m.y1 - y1) < 3 && x0 - m.x1 < 12 && m.x0 - x1 < 12);
    if (hit) { hit.x0 = Math.min(hit.x0, x0); hit.x1 = Math.max(hit.x1, x1); } else list.push({ x0, x1, y0, y1 });
    boxes.set(P, list);
  });
  let n = 0;
  boxes.forEach((list, P) => list.forEach((m) => { addNote({ type: 'hl', page: P.idx, p1: toPdf(P, m.x0, m.y0), p2: toPdf(P, m.x1, m.y1), color: '#ffe600' }); n++; }));
  s.removeAllRanges(); select(null);
  return n;
};
// Copy the selected document text as lines (each run is its own box, so the browser's own copy would put every run on a new line).
document.addEventListener('copy', (e) => {
  const s = getSelection();
  if (!document.body.classList.contains('pdf') || !s.rangeCount || s.isCollapsed) return;
  const r = s.getRangeAt(0), spans = [...host.querySelectorAll('.pdf-text span')].filter((x) => r.intersectsNode(x));
  if (!spans.length) return;
  const NL = String.fromCharCode(10); let out = '', lastTop = null;
  spans.forEach((x) => {
    const tn = x.firstChild; let t = x.textContent;
    if (tn && r.comparePoint(tn, 0) > 0) return; // this run starts after the selection ends
    if (tn === r.endContainer) t = t.slice(0, r.endOffset);
    if (tn === r.startContainer) t = t.slice(r.startOffset);
    if (!t) return; // the selection only touches the edge of this run
    const top = Math.round(parseFloat(x.style.top));
    const p = x.parentElement;
    if (lastTop !== null && (p !== spans[spans.indexOf(x) - 1]?.parentElement || Math.abs(top - lastTop) > 2)) out += NL;
    out += t; lastTop = top;
    if (x.dataset.eol) lastTop = null, out += NL;
  });
  e.clipboardData.setData('text/plain', out.replace(new RegExp(NL + '{3,}', 'g'), NL + NL).trim());
  e.preventDefault();
});

async function render(P) {
  if (P.rendered) return;
  P.rendered = true;
  const token = ++P.token;
  const vp = vpOf(P, zoom * Math.min(2, window.devicePixelRatio || 1));
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  try {
    await P.pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    if (token !== P.token) return;
    P.canvas.width = c.width; P.canvas.height = c.height;
    P.canvas.getContext('2d').drawImage(c, 0, 0);
    buildText(P, token);
  } catch (e) { P.rendered = false; console.warn('page render failed', e); msg('Could not draw page ' + (P.idx + 1)); }
}

function relayout() { const ae = document.activeElement; if (ae && ae.isContentEditable && host.contains(ae)) ae.blur(); /* commit a note being typed before it is redrawn */ pages.forEach((P) => { P.token++; sizePage(P); io.unobserve(P.el); io.observe(P.el); }); $('#pdf-zoom').textContent = Math.round(zoom * 100) + '%'; }
function setZoom(z) { zoom = Math.max(0.25, Math.min(4, z)); relayout(); }
function fit(whole = false) { // whole = the entire first page on screen; otherwise fill the width
  if (!pages.length) return;
  const v = vpOf(pages[0], 1);
  let z = (host.clientWidth - 48) / v.width;
  if (whole) z = Math.min(z, (host.clientHeight - 56) / v.height);
  zoom = Math.max(0.25, Math.min(4, z)); relayout();
}
// Ctrl + mouse wheel (and pinch) zooms about the pointer.
let wheelF = 1, wheelY = 0, wheelRaf = 0;
host.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !pages.length) return;
  e.preventDefault();
  wheelF *= e.deltaY < 0 ? 1.1 : 1 / 1.1; wheelY = e.clientY - host.getBoundingClientRect().top;
  if (wheelRaf) return;
  wheelRaf = requestAnimationFrame(() => {
    wheelRaf = 0;
    const f = wheelF; wheelF = 1;
    const before = zoom, next = Math.max(0.25, Math.min(4, zoom * f)); if (next === before) return;
    const ratio = (host.scrollTop + wheelY) / Math.max(1, host.scrollHeight);
    setZoom(next);
    host.scrollTop = ratio * host.scrollHeight - wheelY;
  });
}, { passive: false });
$('#pdf-zoomin').onclick = () => setZoom(zoom * 1.25);
$('#pdf-zoomout').onclick = () => setZoom(zoom / 1.25);
$('#pdf-fit').onclick = fit;

function status() {
  const n = live().length;
  $('#pdf-status').textContent = pages.length ? `Page ${curPage + 1} of ${pages.length}${n < pages.length ? ` (${pages.length - n} removed)` : ''} · ${notes.length} annotation${notes.length === 1 ? '' : 's'}` : ' ';
  pages.forEach((P) => P.el.classList.toggle('cur', P.idx === curPage));
  if (dirty) MTRX.session.changed('pdf'); // status() runs after every edit; the snapshot skips itself when nothing changed
}
host.addEventListener('scroll', () => {
  const mid = host.getBoundingClientRect().top + host.clientHeight / 2;
  let best = 0, bd = Infinity;
  pages.forEach((P) => { const r = P.el.getBoundingClientRect(); const d = Math.abs((r.top + r.bottom) / 2 - mid); if (d < bd) { bd = d; best = P.idx; } });
  if (best !== curPage) { curPage = best; status(); }
}, { passive: true });

$('#pdf-rotate').onclick = () => {
  const P = pages[curPage]; if (!P) return;
  P.extra = (P.extra + 90) % 360; dirty = true; MTRX.session.changed('pdf'); P.token++; sizePage(P); io.unobserve(P.el); io.observe(P.el);
};
$('#pdf-delpage').onclick = () => {
  const P = pages[curPage]; if (!P) return;
  if (!P.deleted && live().length <= 1) return msg('A PDF needs at least one page');
  P.deleted = !P.deleted; dirty = true;
  P.el.style.opacity = P.deleted ? '.3' : ''; P.el.title = P.deleted ? 'Removed from the saved PDF. Press Delete page again to restore.' : '';
  status();
};

// ---- annotations -------------------------------------------------------
const sizeVal = () => +$('#pdf-size').value;
const colorVal = () => $('#pdf-color').value;
function push(action) { history.push(action); if (history.length > 200) history.shift(); dirty = true; }
function addNote(n) { n.id = nextId++; notes.push(n); push({ kind: 'add', id: n.id }); const P = pages[n.page]; drawNotes(P); select(n.id); status(); return n; }
function removeNote(id) {
  const i = notes.findIndex((n) => n.id === id); if (i < 0) return;
  push({ kind: 'del', note: notes[i], at: i }); const [n] = notes.splice(i, 1);
  if (sel === id) sel = null; drawNotes(pages[n.page]); status();
}
function undo() {
  const a = history.pop(); if (!a) return;
  let pageIdx;
  if (a.kind === 'add') { const i = notes.findIndex((n) => n.id === a.id); if (i >= 0) { pageIdx = notes[i].page; notes.splice(i, 1); } }
  else if (a.kind === 'del') { notes.splice(a.at, 0, a.note); pageIdx = a.note.page; }
  else if (a.kind === 'mod') { const i = notes.findIndex((n) => n.id === a.note.id); if (i >= 0) { pageIdx = a.note.page; notes[i] = a.note; } }
  if (pageIdx != null) drawNotes(pages[pageIdx]);
  sel = null; status();
}
function select(id) {
  sel = id;
  pages.forEach((P) => P.layer.querySelectorAll('.an').forEach((e) => e.classList.toggle('sel', +e.dataset.id === id)));
  const n = notes.find((x) => x.id === id);
  if (n?.type === 'text') syncControls(n);
}
// Show the selected text's real size and colour in the toolbar, so what you see is what a change will start from.
function syncControls(n) {
  const sz = $('#pdf-size');
  if (![...sz.options].some((o) => +o.value === n.size)) {
    const o = new Option(String(n.size), String(n.size));
    const after = [...sz.options].find((x) => +x.value > n.size);
    sz.add(o, after || null);
  }
  sz.value = String(n.size);
  if (/^#[0-9a-f]{6}$/i.test(n.color)) $('#pdf-color').value = n.color;
}
// Restyle a note in place; a text box that is being typed in must not be rebuilt or the typing is lost.
function restyle(n) {
  const P = pages[n.page], el = P.layer.querySelector(`.an[data-id="${n.id}"]`);
  if (n.type === 'text' && el?.isContentEditable) { el.style.fontSize = n.size * zoom + 'px'; el.style.color = n.color; }
  else drawNotes(P);
}

function drawNotes(P) {
  if (!P || !P.vp) return;
  P.layer.querySelectorAll('.an').forEach((e) => e.remove());
  P.svg.replaceChildren();
  const z = zoom;
  notes.filter((n) => n.page === P.idx).forEach((n) => {
    if (n.type === 'draw') {
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      pl.setAttribute('points', n.pts.map((p) => toView(P, p).join(',')).join(' '));
      pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', n.color); pl.setAttribute('stroke-width', n.width * z);
      pl.setAttribute('stroke-linecap', 'round'); pl.setAttribute('stroke-linejoin', 'round');
      P.svg.appendChild(pl);
      // an invisible, wider copy that can be clicked
      const hit = pl.cloneNode(); hit.setAttribute('stroke', 'transparent'); hit.setAttribute('stroke-width', Math.max(10, n.width * z + 8));
      hit.style.pointerEvents = 'stroke'; hit.classList.add('an'); hit.dataset.id = n.id;
      hit.addEventListener('pointerdown', (e) => noteDown(e, P, n));
      P.svg.appendChild(hit);
      return;
    }
    if (n.cover) { // the original text this note replaces is whited out
      const a = toView(P, [n.cover[0], n.cover[1]]), b = toView(P, [n.cover[2], n.cover[3]]), cv = document.createElement('div'); cv.className = 'an an-cover';
      cv.style.cssText = `background:${n.coverColor || '#fff'};left:${Math.min(a[0], b[0])}px;top:${Math.min(a[1], b[1])}px;width:${Math.abs(a[0] - b[0])}px;height:${Math.abs(a[1] - b[1])}px`;
      P.layer.appendChild(cv);
    }
    const el = document.createElement('div'); el.className = 'an an-' + n.type; el.dataset.id = n.id;
    if (n.type === 'text') {
      const [x, y] = toView(P, n.p);
      el.style.cssText = `left:${x}px;top:${y}px;font-size:${n.size * z}px;color:${n.color};transform:translateY(-0.945em)`;
      el.textContent = n.text;
      el.addEventListener('dblclick', () => { if (!el.isContentEditable) editText(el, n, false); });
    } else {
      const a = toView(P, n.p1), b = toView(P, n.p2);
      el.style.cssText = `left:${Math.min(a[0], b[0])}px;top:${Math.min(a[1], b[1])}px;width:${Math.abs(a[0] - b[0])}px;height:${Math.abs(a[1] - b[1])}px`;
      if (n.type === 'hl') { el.style.background = n.color; el.style.opacity = '.4'; }
      else {
        const im = document.createElement('img'); im.src = n.url; el.appendChild(im);
        for (const c of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) { const h = document.createElement('div'); h.className = 'hdl hdl-' + c; h.addEventListener('pointerdown', (e) => handleDown(e, P, n, c)); el.appendChild(h); }
      }
    }
    el.addEventListener('pointerdown', (e) => noteDown(e, P, n, el));
    P.layer.appendChild(el);
  });
  select(sel);
}

function editText(el, n, selectAll = true) {
  el.contentEditable = 'plaintext-only'; el.focus();
  getSelection().selectAllChildren(el);
  if (!selectAll) getSelection().collapseToEnd();
  msg('Type your text. Press Esc or click elsewhere to finish.');
  const done = () => {
    el.contentEditable = 'false';
    const t = el.innerText.replace(/\n$/, '');
    if (!t.trim() && !n.cover) return removeNote(n.id);
    if (t !== n.text) { push({ kind: 'mod', note: structuredClone(n) }); n.text = t; }
  };
  el.addEventListener('blur', done, { once: true });
}

// Drag a handle to stretch an image freely (corners: both sides, edges: one side). Shift keeps the proportions.
function handleDown(e, P, n, c) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault(); select(n.id);
  const before = structuredClone(n), a = toView(P, n.p1), b = toView(P, n.p2);
  const box = { l: Math.min(a[0], b[0]), t: Math.min(a[1], b[1]), r: Math.max(a[0], b[0]), b: Math.max(a[1], b[1]) };
  const ratio = (box.r - box.l) / (box.b - box.t) || 1;
  let moved = false;
  const move = (ev) => {
    const rc = P.layer.getBoundingClientRect(), x = ev.clientX - rc.left, y = ev.clientY - rc.top, q = { ...box };
    if (c.includes('e')) q.r = Math.max(q.l + 12, x);
    if (c.includes('w')) q.l = Math.min(q.r - 12, x);
    if (c.includes('s')) q.b = Math.max(q.t + 12, y);
    if (c.includes('n')) q.t = Math.min(q.b - 12, y);
    if (ev.shiftKey && c.length === 2) { // keep proportions, following the pointer outward
      const w = Math.max(q.r - q.l, (q.b - q.t) * ratio), h = w / ratio;
      if (c.includes('w')) q.l = q.r - w; else q.r = q.l + w;
      if (c.includes('n')) q.t = q.b - h; else q.b = q.t + h;
    }
    n.p1 = toPdf(P, q.l, q.t); n.p2 = toPdf(P, q.r, q.b); moved = true; drawNotes(P);
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) push({ kind: 'mod', note: before }); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

// Move a selected annotation by dragging it (select tool).
function noteDown(e, P, n, el) {
  if (e.button !== 0) return;
  if (el?.isContentEditable) return;
  if ((tool === 'text' || tool === 'edit') && n.type === 'text') { // clicking an existing text with the Text tool edits it
    e.stopPropagation(); e.preventDefault(); select(n.id); if (tool === 'text') setTool('select');
    setTimeout(() => editText(el, n, false), 0); return;
  }
  if (tool !== 'select') return;
  const wasSel = sel === n.id;
  e.stopPropagation(); select(n.id);
  const r = P.layer.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY, before = structuredClone(n);
  let moved = false;
  const base = n.type === 'text' ? [n.p] : n.type === 'draw' ? n.pts : [n.p1, n.p2];
  const baseView = base.map((p) => toView(P, p));
  const move = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    const np = baseView.map(([x, y]) => toPdf(P, x + dx, y + dy));
    if (n.type === 'text') n.p = np[0]; else if (n.type === 'draw') n.pts = np; else { n.p1 = np[0]; n.p2 = np[1]; }
    drawNotes(P);
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (moved) push({ kind: 'mod', note: before });
    else if (wasSel && n.type === 'text') { // a second plain click on the selected text edits it
      const cur = P.layer.querySelector(`.an[data-id="${n.id}"]`);
      if (cur) editText(cur, n, false);
    }
  };
  void r;
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

// ---- tools -------------------------------------------------------------
document.querySelectorAll('#pdf-tools [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
function setTool(t) {
  tool = t;
  document.querySelectorAll('#pdf-tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  pages.forEach((P) => { P.layer.className = 'pdf-layer t-' + t; });
  getSelection().removeAllRanges();
}
document.querySelectorAll('#pdf-tools button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

// Find the PDF's own lines of text (pdf.js text runs joined along each baseline) so they can be edited in place.
async function linesOf(P) {
  if (P.lines) return P.lines;
  const tc = await P.pg.getTextContent(), runs = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, , d, e, f] = it.transform, size = Math.hypot(a, b) || Math.abs(d);
    if (Math.abs(b) > 0.01 * size) continue; // rotated text is left alone
    runs.push({ str: it.str, x: e, y: f, w: it.width, size });
  }
  const out = [];
  runs.forEach((r) => {
    const l = out[out.length - 1];
    if (l && Math.abs(l.y - r.y) < 1 && Math.abs(l.size - r.size) < 0.5 && r.x - (l.x + l.w) < r.size * 1.2 && r.x >= l.x) { l.str += (r.x - (l.x + l.w) > r.size * 0.15 && !/\s$/.test(l.str) && !/^\s/.test(r.str) ? ' ' : '') + r.str; l.w = r.x + r.w - l.x; }
    else out.push({ ...r });
  });
  return (P.lines = out.filter((l) => l.str.trim()));
}
const lineBox = (l) => [l.x - 1, l.y - l.size * 0.25, l.x + l.w + 1, l.y + l.size * 0.92];
function lineAt(P, lines, x, y) { // x, y in view pixels
  const [px, py] = toPdf(P, x, y);
  return lines.find((l) => { const q = lineBox(l); return px >= q[0] && px <= q[2] && py >= q[1] && py <= q[3]; });
}
// Sample the page itself: the background just left of the line, and the colour that stands out most inside it.
function sampleColors(P, l) {
  try {
    const c = P.canvas, ctx = c.getContext('2d'), k = c.width / P.vp.width, q = lineBox(l);
    const A = toView(P, [q[0], q[1]]), B = toView(P, [q[2], q[3]]);
    const x0 = Math.min(A[0], B[0]) * k, x1 = Math.max(A[0], B[0]) * k, y0 = Math.min(A[1], B[1]) * k, y1 = Math.max(A[1], B[1]) * k;
    const px = (x, y) => ctx.getImageData(Math.max(0, Math.min(c.width - 1, Math.round(x))), Math.max(0, Math.min(c.height - 1, Math.round(y))), 1, 1).data;
    const bg = px(x0 - 3 * k, (y0 + y1) / 2);
    if (!c.width || bg[3] === 0) return { bg: '#ffffff', fg: '#000000' }; // page not painted yet
    const d = ctx.getImageData(Math.round(x0), Math.round(y0), Math.max(1, Math.round(x1 - x0)), Math.max(1, Math.round(y1 - y0))).data;
    let best = bg, bd = -1;
    for (let i = 0; i < d.length; i += 4) { const e = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]); if (e > bd) { bd = e; best = [d[i], d[i + 1], d[i + 2]]; } }
    const hex = (a) => '#' + [a[0], a[1], a[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    return { bg: hex(bg), fg: bd > 60 ? hex(best) : '#000000' };
  } catch { return { bg: '#ffffff', fg: '#000000' }; }
}
async function startEdit(P, l) {
  const prior = notes.find((n) => n.page === P.idx && n.cover && n.src === l.str + '|' + l.x + '|' + l.y);
  if (prior) { select(prior.id); const el = P.layer.querySelector(`.an[data-id="${prior.id}"]`); if (el) setTimeout(() => editText(el, prior, false), 0); return; }
  const n = addNote({ type: 'text', page: P.idx, p: [l.x, l.y], text: l.str, size: Math.round(l.size * 10) / 10, color: sampleColors(P, l).fg, coverColor: sampleColors(P, l).bg, cover: lineBox(l), src: l.str + '|' + l.x + '|' + l.y });
  const el = P.layer.querySelector(`.an[data-id="${n.id}"]`);
  if (el) setTimeout(() => editText(el, n, false), 0);
}
function wireLayer(P) {
  const hint = document.createElement('div'); hint.className = 'edithint'; P.layer.appendChild(hint);
  P.layer.addEventListener('pointermove', async (e) => {
    if (tool !== 'edit') { hint.style.display = 'none'; return; }
    const r = P.layer.getBoundingClientRect(), lines = await linesOf(P), l = lineAt(P, lines, e.clientX - r.left, e.clientY - r.top);
    if (!l) { hint.style.display = 'none'; return; }
    const q = lineBox(l), a = toView(P, [q[0], q[1]]), b = toView(P, [q[2], q[3]]);
    hint.style.cssText = `display:block;left:${Math.min(a[0], b[0])}px;top:${Math.min(a[1], b[1])}px;width:${Math.abs(a[0] - b[0])}px;height:${Math.abs(a[1] - b[1])}px`;
  });
  P.layer.addEventListener('pointerleave', () => { hint.style.display = 'none'; });
  // With the Select tool the text underneath takes the mouse (so it can be selected); blank clicks still deselect.
  P.el.addEventListener('pointerdown', (e) => { if (tool === 'select' && e.button === 0 && !e.target.closest?.('.an')) { curPage = P.idx; status(); select(null); } });
  P.layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest?.('.an')) return;
    curPage = P.idx; status();
    const r = P.layer.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (tool === 'select') { select(null); return; }
    if (tool === 'edit') {
      e.preventDefault();
      linesOf(P).then((lines) => { const l = lineAt(P, lines, x, y); if (l) startEdit(P, l); else msg('No text here. Click on a line of text to edit it.'); });
      return;
    }
    if (tool === 'text') {
      const size = sizeVal();
      const n = addNote({ type: 'text', page: P.idx, p: toPdf(P, x, y + size * zoom * 0.945), text: 'Text', size, color: colorVal() });
      const el = P.layer.querySelector(`.an[data-id="${n.id}"]`);
      if (el) { setTool('select'); setTimeout(() => editText(el, n), 0); }
      e.preventDefault();
      return;
    }
    if (tool === 'highlight') {
      e.preventDefault(); // dragging must not select text
      const box = document.createElement('div'); box.className = 'an an-hl'; box.style.cssText = `left:${x}px;top:${y}px;width:0;height:0;background:#ffe600;opacity:.4`;
      P.layer.appendChild(box);
      const move = (ev) => { const cx = ev.clientX - r.left, cy = ev.clientY - r.top; box.style.left = Math.min(x, cx) + 'px'; box.style.top = Math.min(y, cy) + 'px'; box.style.width = Math.abs(cx - x) + 'px'; box.style.height = Math.abs(cy - y) + 'px'; };
      const up = (ev) => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); box.remove();
        const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
        if (Math.abs(cx - x) > 4 && Math.abs(cy - y) > 4) addNote({ type: 'hl', page: P.idx, p1: toPdf(P, x, y), p2: toPdf(P, cx, cy), color: '#ffe600' });
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    if (tool === 'draw') {
      e.preventDefault();
      const pts = [[x, y]];
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      const wpt = Math.max(1, Math.round(sizeVal() / 7));
      pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', colorVal()); pl.setAttribute('stroke-width', wpt * zoom); pl.setAttribute('stroke-linecap', 'round'); pl.setAttribute('stroke-linejoin', 'round');
      P.svg.appendChild(pl);
      const move = (ev) => {
        const cx = ev.clientX - r.left, cy = ev.clientY - r.top, l = pts[pts.length - 1];
        if (Math.hypot(cx - l[0], cy - l[1]) < 1.5) return;
        pts.push([cx, cy]); pl.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); pl.remove();
        if (pts.length > 1) addNote({ type: 'draw', page: P.idx, pts: pts.map((p) => toPdf(P, p[0], p[1])), color: colorVal(), width: wpt });
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }
  });
}

// images / signatures
$('#pdf-image').onclick = () => { if (doc) $('#pdf-file-img').click(); };
$('#pdf-file-img').onchange = (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !doc) return;
  const mime = f.type === 'image/png' ? 'image/png' : f.type === 'image/jpeg' ? 'image/jpeg' : null;
  if (!mime) return msg('Choose a PNG or JPEG image');
  const rd = new FileReader();
  rd.onload = () => {
    const url = rd.result, im = new Image();
    im.onload = () => {
      const P = pages[curPage]; if (!P) return;
      const vp1 = vpOf(P, 1), w = Math.min(200, vp1.width * 0.5), h = w * (im.naturalHeight / im.naturalWidth);
      const cx = vp1.width / 2, cy = vp1.height / 2, v1 = vpOf(P, 1);
      setTool('select'); // so the image can be dragged and resized right away
      addNote({ type: 'img', page: P.idx, mime, url, p1: v1.convertToPdfPoint(cx - w / 2, cy - h / 2), p2: v1.convertToPdfPoint(cx + w / 2, cy + h / 2) });
    };
    im.src = url;
  };
  rd.readAsDataURL(f);
};

// bigger / smaller / delete / undo
const SIZES = () => [...$('#pdf-size').options].map((o) => +o.value);
function resize(f) {
  const n = notes.find((x) => x.id === sel); if (!n) return;
  const P = pages[n.page]; push({ kind: 'mod', note: structuredClone(n) });
  if (n.type === 'text') {
    const L = SIZES(), up = f > 1;
    const next = up ? L.find((v) => v > n.size) : [...L].reverse().find((v) => v < n.size);
    n.size = next ?? n.size;
    syncControls(n);
  }
  else if (n.type === 'draw') n.width = Math.max(0.5, Math.min(30, n.width * f));
  else { // scale about the top-left corner (in view space)
    const a = toView(P, n.p1), b = toView(P, n.p2);
    n.p2 = toPdf(P, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
  }
  restyle(n);
}
// Changing the size or colour box changes the selected text (or drawing) too, not only the next one you add.
$('#pdf-size').addEventListener('change', () => {
  const n = notes.find((x) => x.id === sel); if (n?.type !== 'text') return;
  push({ kind: 'mod', note: structuredClone(n) }); n.size = sizeVal(); restyle(n);
});
$('#pdf-color').addEventListener('change', () => {
  const n = notes.find((x) => x.id === sel); if (!n || (n.type !== 'text' && n.type !== 'draw')) return;
  push({ kind: 'mod', note: structuredClone(n) }); n.color = colorVal(); restyle(n);
});
$('#pdf-bigger').onclick = () => resize(1.15);
$('#pdf-smaller').onclick = () => resize(1 / 1.15);
$('#pdf-delete').onclick = () => { if (sel) removeNote(sel); };
$('#pdf-undo').onclick = undo;

// ---- save --------------------------------------------------------------
async function save() {
  if (!doc) return msg('Open a PDF first');
  if (!invoke) return msg('Run inside the desktop app to save');
  try {
    const out = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });
    const font = await out.embedFont(PL.StandardFonts.Helvetica);
    const known = new Set(font.getCharacterSet());
    const safe = (t) => [...t].map((c) => (known.has(c.codePointAt(0)) ? c : '?')).join('');
    const target = out.getPages();
    for (const P of pages) {
      const pg = target[P.idx]; if (!pg) continue;
      const R = rotOf(P), v1 = vpOf(P, 1), rot = PL.degrees(R);
      if (P.extra) pg.setRotation(PL.degrees(R));
      for (const n of notes.filter((x) => x.page === P.idx && x.cover)) {
        const c = n.cover; pg.drawRectangle({ x: Math.min(c[0], c[2]), y: Math.min(c[1], c[3]), width: Math.abs(c[2] - c[0]), height: Math.abs(c[3] - c[1]), color: PL.rgb(...hexRgb(n.coverColor || '#ffffff').map((v) => v / 255)) });
      }
      for (const n of notes.filter((x) => x.page === P.idx)) {
        const [r, g, b] = n.color ? hexRgb(n.color) : [0, 0, 0], color = PL.rgb(r / 255, g / 255, b / 255);
        if (n.type === 'text') {
          const base = v1.convertToViewportPoint(n.p[0], n.p[1]);
          n.text.split('\n').forEach((line, k) => {
            const [x, y] = v1.convertToPdfPoint(base[0], base[1] + k * n.size * 1.2);
            if (line) pg.drawText(safe(line), { x, y, size: n.size, font, color, rotate: rot });
          });
        } else if (n.type === 'hl') {
          const a = n.p1, c = n.p2;
          pg.drawRectangle({ x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), width: Math.abs(a[0] - c[0]), height: Math.abs(a[1] - c[1]), color, opacity: 0.4, blendMode: PL.BlendMode.Multiply });
        } else if (n.type === 'draw') {
          for (let i = 1; i < n.pts.length; i++) {
            pg.drawLine({ start: { x: n.pts[i - 1][0], y: n.pts[i - 1][1] }, end: { x: n.pts[i][0], y: n.pts[i][1] }, thickness: n.width, color, lineCap: PL.LineCapStyle.Round });
          }
        } else if (n.type === 'img') {
          const a = v1.convertToViewportPoint(n.p1[0], n.p1[1]), c = v1.convertToViewportPoint(n.p2[0], n.p2[1]);
          const left = Math.min(a[0], c[0]), top = Math.min(a[1], c[1]), w = Math.abs(a[0] - c[0]), h = Math.abs(a[1] - c[1]);
          const [x, y] = v1.convertToPdfPoint(left, top + h);
          const raw = b64ToBytes(n.url.split(',')[1]);
          const img = n.mime === 'image/png' ? await out.embedPng(raw) : await out.embedJpg(raw);
          pg.drawImage(img, { x, y, width: w, height: h, rotate: rot });
        }
      }
    }
    pages.filter((P) => P.deleted).sort((a, b) => b.idx - a.idx).forEach((P) => out.removePage(P.idx));
    const data = bytesToB64(await out.save());
    const p = await invoke('save_pdf', { name, data });
    if (p) { dirty = false; MTRX.session.saved('pdf'); msg('Saved: ' + p); }
  } catch (e) { msg('Save failed: ' + (e?.message || e)); }
}
$('#pdf-save').onclick = save;

// ---- PDF text -> Writer ------------------------------------------------
async function extractHtml() {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = [];
  for (const P of live()) {
    const tc = await P.pg.getTextContent();
    const lines = []; let cur = null;
    const flush = () => { if (cur && cur.text.trim()) lines.push(cur); cur = null; };
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform[5], h = Math.abs(it.height || it.transform[3]) || 10;
      if (cur && Math.abs(y - cur.y) > h * 0.5) flush();
      if (!cur) cur = { y, h, text: '' };
      cur.text += it.str;
      if (it.hasEOL) flush();
    }
    flush();
    let para = '', prev = null;
    const end = () => { if (para.trim()) paras.push(para.trim()); para = ''; };
    for (const l of lines) {
      if (prev && Math.abs(prev.y - l.y) > prev.h * 1.7) end();
      const t = l.text.replace(/\s+/g, ' ').trim();
      para = para.endsWith('-') && /^[a-z]/.test(t) ? para.slice(0, -1) + t : para ? para + ' ' + t : t;
      prev = l;
    }
    end();
  }
  return paras.length ? paras.map((p) => `<p>${esc(p)}</p>`).join('') : '<p><br></p>';
}
$('#pdf-towriter').onclick = async () => {
  if (!doc) return msg('Open a PDF first');
  msg('Reading text…');
  try { MTRX.openInWriter?.(name, await extractHtml()); } catch (e) { msg('Could not read the text: ' + (e?.message || e)); }
};

// ---- keyboard ----------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('pdf')) return;
  const editing = e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.code === 'KeyA' && !editing) { e.preventDefault(); MTRX.pdfSelectAll(); }
  else if (ctrl && e.code === 'KeyS') { e.preventDefault(); save(); }
  else if (ctrl && e.code === 'KeyO') { e.preventDefault(); $('#pdf-open').click(); }
  else if (editing) { if (e.key === 'Escape') e.target.blur(); }
  else if (ctrl && e.code === 'KeyZ') { e.preventDefault(); undo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (sel) { e.preventDefault(); removeNote(sel); } }
  else if (!ctrl && !e.altKey) {
    const t = { KeyV: 'select', KeyT: 'text', KeyE: 'edit', KeyH: 'highlight', KeyD: 'draw' }[e.code];
    if (t) setTool(t); else if (e.code === 'KeyI') $('#pdf-image').click(); else if (e.key === 'Escape') select(null);
  }
});

// ---- merge / split / extract -------------------------------------------
function parseRanges(txt, max) {
  const out = [];
  for (const part of txt.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part); if (!m) return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || b > max) return null;
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  return out.length ? out : null;
}
function pdfToolsDialog() {
  const bgEl = $('#modal-bg'), box = $('#modal'), n = pages.length;
  let files = [];
  const close = () => { bgEl.hidden = true; box.innerHTML = ''; };
  const list = () => { box.querySelector('#t-list').innerHTML = files.length ? files.map((f, i) => `<div class="src"><span>${i + 1}. ${f.name.replace(/[<>&]/g, '')}</span><button class="x" data-rm="${i}" title="Remove">&times;</button></div>`).join('') : '<p class="none">No files chosen.</p>'; box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { files.splice(+b.dataset.rm, 1); list(); })); box.querySelector('#t-merge').disabled = files.length < 2; };
  box.innerHTML = `<h3>PDF tools</h3>
  <details open><summary>Merge PDFs into one</summary>
   <input type="file" id="t-files" accept="application/pdf" multiple>
   <div class="srcs" id="t-list"></div>
   <button class="ok" id="t-merge" type="button">Merge and save</button></details>
  <details${n ? ' open' : ''}><summary>Extract pages from the open PDF</summary>
   <label>${n ? `Pages to keep (this PDF has ${n}), e.g. 1-3, 5` : 'Open a PDF first'}</label><input id="t-range" placeholder="1-3, 5"${n ? '' : ' disabled'}>
   <p class="none">The new file is made from the original pages, without your annotations.</p>
   <button class="ok" id="t-extract" type="button"${n ? '' : ' disabled'}>Extract and save</button></details>
  <div class="actions"><button id="m-cancel">Close</button></div>`;
  bgEl.hidden = false; list();
  $('#m-cancel').onclick = close;
  box.querySelector('#t-files').onchange = (e) => { files = files.concat([...e.target.files]); e.target.value = ''; list(); };
  const finish = async (out, label) => {
    if (!invoke) return msg('Run inside the desktop app to save');
    try { const p = await invoke('save_pdf', { name: label, data: bytesToB64(await out.save()) }); if (p) { close(); msg('Saved: ' + p); } } catch (e) { msg('Save failed: ' + (e?.message || e)); }
  };
  box.querySelector('#t-merge').onclick = async () => {
    try {
      const out = await PL.PDFDocument.create();
      for (const f of files) {
        const src = await PL.PDFDocument.load(new Uint8Array(await f.arrayBuffer()), { ignoreEncryption: true });
        (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
      }
      await finish(out, 'merged');
    } catch (e) { msg('Could not merge: ' + (e?.message || e)); }
  };
  box.querySelector('#t-extract').onclick = async () => {
    const idx = parseRanges(box.querySelector('#t-range').value, n);
    if (!idx) return msg('Enter pages like 1-3, 5 (this PDF has ' + n + ')');
    try {
      const src = await PL.PDFDocument.load(bytes, { ignoreEncryption: true }), out = await PL.PDFDocument.create();
      (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
      await finish(out, (name || 'Document') + '-extract');
    } catch (e) { msg('Could not extract: ' + (e?.message || e)); }
  };
}
$('#pdf-merge').onclick = pdfToolsDialog;

// ---- flashcards from highlights -----------------------------------------
const CKEY = () => 'mtrx.pdf.cards.' + ((doc && doc.fingerprints && doc.fingerprints[0]) || name || 'doc'); // the file's own fingerprint, so same-named PDFs stay apart
const loadCards = () => { try { return JSON.parse(localStorage.getItem(CKEY()) || '[]'); } catch { return []; } };
const saveCards = (c) => { try { localStorage.setItem(CKEY(), JSON.stringify(c)); } catch { /* storage unavailable */ } };
const escH = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function textUnder(n) { // the words of the PDF that a highlight covers
  const P = pages[n.page]; if (!P) return '';
  const x0 = Math.min(n.p1[0], n.p2[0]), x1 = Math.max(n.p1[0], n.p2[0]), y0 = Math.min(n.p1[1], n.p2[1]), y1 = Math.max(n.p1[1], n.p2[1]);
  const tc = await P.pg.getTextContent(), hit = [];
  for (const it of tc.items) {
    if (!it.str || Math.abs(it.transform[1]) > 0.5) continue;
    const size = Math.hypot(it.transform[0], it.transform[1]) || 10, cx = it.transform[4] + it.width / 2, cy = it.transform[5] + size * 0.3;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) hit.push({ s: it.str, x: it.transform[4], y: it.transform[5], size });
  }
  hit.sort((a, b) => (Math.abs(a.y - b.y) > a.size * 0.5 ? b.y - a.y : a.x - b.x));
  return hit.map((h) => h.s).join(' ').replace(/\s+/g, ' ').trim();
}
async function flashcards() {
  if (!doc) return msg('Open a PDF first');
  const bgEl = $('#modal-bg'), box = $('#modal'), saved = loadCards(), cards = [];
  for (const n of notes.filter((x) => x.type === 'hl')) {
    const key = n.page + ':' + [n.p1[0], n.p1[1], n.p2[0], n.p2[1]].map((v) => Math.round(v)).join(',');
    const old = saved.find((c) => c.key === key), txt = await textUnder(n);
    if (!txt && !old) continue;
    cards.push(old || { key, page: n.page + 1, front: '', back: txt });
  }
  cards.sort((a, b) => a.page - b.page);
  const close = () => { bgEl.hidden = true; box.innerHTML = ''; }, keep = () => saveCards(cards);
  const edit = () => {
    box.innerHTML = `<h3>Flashcards</h3><p class="none">${cards.length ? 'One card per highlight. Type a question on the front; the highlighted passage is the answer.' : 'No cards yet. Use the Highlight tool on the text you want to remember, then open this again.'}</p>
    <div class="srcs" style="max-height:300px">${cards.map((c, i) => `<div class="card"><small>Page ${c.page}</small><input data-f="${i}" placeholder="Question (front)" value="${escH(c.front)}"><textarea data-b="${i}" rows="2">${escH(c.back)}</textarea></div>`).join('')}</div>
    <div class="actions"><button id="m-cancel">Close</button><button id="fc-csv"${cards.length ? '' : ' disabled'}>Copy as CSV</button><button class="ok" id="fc-study"${cards.length ? '' : ' disabled'}>Study</button></div>`;
    $('#m-cancel').onclick = close;
    box.querySelectorAll('[data-f]').forEach((e) => (e.oninput = () => { cards[+e.dataset.f].front = e.value; keep(); }));
    box.querySelectorAll('[data-b]').forEach((e) => (e.oninput = () => { cards[+e.dataset.b].back = e.value; keep(); }));
    $('#fc-csv').onclick = async () => { const q = (t) => '"' + String(t).replace(/"/g, '""') + '"'; try { await navigator.clipboard.writeText(cards.map((c) => q(c.front || 'Page ' + c.page) + ',' + q(c.back)).join('\n')); msg('Copied. Paste into Anki or a spreadsheet.'); } catch { msg('Could not copy'); } };
    $('#fc-study').onclick = study;
  };
  const study = () => {
    const queue = cards.map((c) => c); let shown = false, done = 0;
    const step = () => {
      if (!queue.length) { box.innerHTML = `<h3>Done</h3><p class="none">You got all ${done} card${done === 1 ? '' : 's'}.</p><div class="actions"><button id="m-cancel">Close</button><button class="ok" id="fc-back">Back to cards</button></div>`; $('#m-cancel').onclick = close; $('#fc-back').onclick = edit; return; }
      const c = queue[0];
      box.innerHTML = `<h3>Study <small>${cards.length - queue.length + 1} of ${cards.length}</small></h3>
      <div class="flash"><small>Page ${c.page}</small><div class="q">${escH(c.front || 'What does the highlighted passage say?')}</div>${shown ? `<div class="a">${escH(c.back)}</div>` : ''}</div>
      <div class="actions"><button id="m-cancel">Stop</button>${shown ? '<button id="fc-again">Again</button><button class="ok" id="fc-got">Got it</button>' : '<button class="ok" id="fc-show">Show answer</button>'}</div>`;
      $('#m-cancel').onclick = edit;
      if (!shown) $('#fc-show').onclick = () => { shown = true; step(); };
      else { $('#fc-got').onclick = () => { queue.shift(); done++; shown = false; step(); }; $('#fc-again').onclick = () => { queue.push(queue.shift()); shown = false; step(); }; }
    };
    step();
  };
  bgEl.hidden = false; edit();
}
$('#pdf-cards').onclick = flashcards;
window.addEventListener('resize', () => { if (doc && document.body.classList.contains('pdf')) status(); });
host.querySelector('.pdf-empty')?.addEventListener('click', () => $('#pdf-open').click());
})();
