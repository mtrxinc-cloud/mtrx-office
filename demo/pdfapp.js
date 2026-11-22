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
let fv = {}, touched = new Set(); // form field values typed by the user (by field name) and which of them changed

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
    doc = d; bytes = data; name = fileName || 'Document'; notes = []; history = []; sel = null; dirty = false; curPage = 0; lastSig = ''; fv = {}; touched = new Set(); MTRX.session.saved('pdf');
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
    const sig = JSON.stringify([notes, st, nextId, fv]);
    if (sig === lastSig) return undefined;
    lastSig = sig;
    if (bytesFor !== bytes) { bytesB64 = bytesToB64(bytes); bytesFor = bytes; } // the original never changes, encode it once
    return { name, data: bytesB64, notes, pages: st, nextId, fv, touched: [...touched] };
  },
  restore: async (d) => {
    await openPdf(d.name, d.data);
    notes = d.notes || []; nextId = d.nextId || 1; fv = d.fv || {}; touched = new Set(d.touched || []);
    pages.forEach((P, i) => { const s = d.pages?.[i]; if (!s) return; P.extra = s.extra; P.deleted = s.deleted; P.el.style.opacity = P.deleted ? '.3' : ''; });
    relayout(); pages.forEach((P) => { drawNotes(P); }); dirty = true; status(); MTRX.session.changed('pdf');
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

// Reads what is drawn on a page (ruling lines, boxes, pictures) so check boxes can be snapped to, and so
// PDF -> Writer can rebuild tables and pictures. Everything is in PDF points. Cached per page.
function gfx(P) {
  return (P.gfx ||= (async () => {
    const g = { boxes: [], H: [], V: [], imgs: [] };
    try {
      const O = pdfjs.OPS, ol = await P.pg.getOperatorList();
      let m = [1, 0, 0, 1, 0, 0]; const stack = [];
      const T = (px, py) => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]];
      const sq = (w, h) => w >= 5 && h >= 5 && w <= 40 && h <= 40 && w / h > 0.6 && w / h < 1.67;
      const seg = (p, q) => {
        if (Math.abs(p[1] - q[1]) < 0.4) g.H.push({ y: p[1], x1: Math.min(p[0], q[0]), x2: Math.max(p[0], q[0]) });
        else if (Math.abs(p[0] - q[0]) < 0.4) g.V.push({ x: p[0], y1: Math.min(p[1], q[1]), y2: Math.max(p[1], q[1]) });
      };
      const rect = (pts) => {
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
        if (w < 2.5 || h < 2.5) { seg([x, y + h / 2], [x + w, y + h / 2]); seg([x + w / 2, y], [x + w / 2, y + h]); } // thin filled bar = a line
        else if (sq(w, h)) g.boxes.push({ x, y, w, h });
        else { seg([x, y], [x + w, y]); seg([x, y + h], [x + w, y + h]); seg([x, y], [x, y + h]); seg([x + w, y], [x + w, y + h]); }
      };
      const segsOnly = []; // lone lines: boxes drawn as four separate lines are joined afterwards
      ol.fnArray.forEach((fn, i) => {
        const a = ol.argsArray[i];
        if (fn === O.save) stack.push(m);
        else if (fn === O.restore) m = stack.pop() || m;
        else if (fn === O.transform) m = pdfjs.Util.transform(m, a);
        else if (fn === O.paintFormXObjectBegin) { stack.push(m); if (a && a[0]) m = pdfjs.Util.transform(m, a[0]); }
        else if (fn === O.paintFormXObjectEnd) m = stack.pop() || m;
        else if (fn === O.paintImageXObject || fn === O.paintJpegXObject) {
          const w = Math.hypot(m[0], m[1]), h = Math.hypot(m[2], m[3]);
          if (w > 4 && h > 4) g.imgs.push({ name: a[0], x: m[4] + Math.min(0, m[2]), y: m[5] + Math.min(0, m[3]), w, h });
        } else if (fn === O.constructPath) {
          const ops = a[0], c = a[1]; let k = 0, sub = [];
          const end = () => {
            if (sub.length === 2) { segsOnly.push([sub[0], sub[1]]); seg(sub[0], sub[1]); }
            else if (sub.length >= 3 && sub.length <= 5) {
              const q = sub.slice(0, 4);
              if (q.length === 4 && q.every((p, j) => { const n = q[(j + 1) % 4]; return Math.abs(p[0] - n[0]) < 0.5 || Math.abs(p[1] - n[1]) < 0.5; })) rect(q);
              else for (let j = 1; j < sub.length; j++) seg(sub[j - 1], sub[j]);
            } else for (let j = 1; j < sub.length; j++) seg(sub[j - 1], sub[j]);
            sub = [];
          };
          for (const op of ops) {
            if (op === O.rectangle) { const [x, y, w, h] = [c[k], c[k + 1], c[k + 2], c[k + 3]]; k += 4; rect([T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)]); }
            else if (op === O.moveTo) { end(); sub = [T(c[k], c[k + 1])]; k += 2; }
            else if (op === O.lineTo) { sub.push(T(c[k], c[k + 1])); k += 2; }
            else if (op === O.closePath) { /* closing edge is implied by the corner test */ }
            else if (op === O.curveTo) k += 6;
            else if (op === O.curveTo2 || op === O.curveTo3) k += 4;
          }
          end();
        }
      });
      // four separate lines that close into a small square are a box, not table lines
      const Hs = g.H.filter((l) => l.x2 - l.x1 >= 5 && l.x2 - l.x1 <= 40), Vs = g.V;
      const used = new Set();
      for (const a of Hs) for (const b of Hs) {
        const w = a.x2 - a.x1, h = b.y - a.y;
        if (h < 5 || Math.abs(a.x1 - b.x1) > 0.8 || Math.abs(a.x2 - b.x2) > 0.8 || !sq(w, h)) continue;
        const side = (x) => Vs.find((v) => Math.abs(v.x - x) < 0.8 && v.y1 <= a.y + 0.8 && v.y2 >= b.y - 0.8);
        const l = side(a.x1), r = side(a.x2);
        if (l && r) { g.boxes.push({ x: a.x1, y: a.y, w, h }); used.add(a).add(b).add(l).add(r); }
      }
      if (used.size) { g.H = g.H.filter((l) => !used.has(l)); g.V = g.V.filter((l) => !used.has(l)); }
      // pictures are decoded to data URLs only when a conversion asks for them (g.load)
      g.load = async () => { if (g.loaded) return; g.loaded = true;
      for (const im of g.imgs) {
        try {
          const o = await new Promise((res, rej) => { const t = setTimeout(() => rej(0), 2500); P.pg.objs.get(im.name, (v) => { clearTimeout(t); res(v); }); });
          const cv = document.createElement('canvas'), W = o.width, Hh = o.height; cv.width = W; cv.height = Hh;
          const cx = cv.getContext('2d');
          if (o.bitmap) cx.drawImage(o.bitmap, 0, 0);
          else {
            const px = cx.createImageData(W, Hh), d = o.data, out = px.data;
            if (o.kind === 3) out.set(d.subarray(0, out.length));
            else if (o.kind === 2) for (let p = 0, q = 0; p < out.length; p += 4, q += 3) { out[p] = d[q]; out[p + 1] = d[q + 1]; out[p + 2] = d[q + 2]; out[p + 3] = 255; }
            else { const rb = (W + 7) >> 3; for (let yy = 0; yy < Hh; yy++) for (let xx = 0; xx < W; xx++) { const v = (d[yy * rb + (xx >> 3)] >> (7 - (xx & 7))) & 1 ? 255 : 0, p = (yy * W + xx) * 4; out[p] = out[p + 1] = out[p + 2] = v; out[p + 3] = 255; } }
            cx.putImageData(px, 0, 0);
          }
          im.src = cv.toDataURL(o.kind === 3 ? 'image/png' : 'image/jpeg', 0.88);
        } catch (e) { im.src = ''; }
      }
      g.imgs = g.imgs.filter((im) => im.src); };
    } catch (e) { /* nothing found: stamps go where you click, conversion keeps text only */ }
    return g;
  })());
}
const findBox = (P) => gfx(P).then((g) => g.boxes);

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
    const P = { idx: i - 1, pg, extra: 0, deleted: false, el, canvas, tl, layer, svg, vp: null, token: 0, widgets: [] };
    // fillable form fields (text, check boxes, radio buttons, drop-downs)
    try { P.widgets = (await pg.getAnnotations()).filter((a) => a.subtype === 'Widget' && a.fieldName && !a.readOnly && !a.hidden && (a.fieldType === 'Tx' || a.fieldType === 'Ch' || (a.fieldType === 'Btn' && !a.pushButton))); } catch { /* no form */ }
    P.widgets.forEach((a) => {
      const k = a.fieldName; if (k in fv) return;
      if (a.fieldType === 'Btn') fv[k] = a.radioButton ? (a.fieldValue === a.buttonValue ? a.buttonValue : (fv[k] ?? '')) : !!a.fieldValue && a.fieldValue !== 'Off';
      else fv[k] = Array.isArray(a.fieldValue) ? a.fieldValue[0] ?? '' : a.fieldValue ?? '';
    });
    el._P = P; layer._P = P;
    wireLayer(P);
    pages.push(P); host.appendChild(el);
  }
  pages.forEach(sizePage);
  pages.forEach((P) => io.observe(P.el));
  status();
  const nf = new Set(pages.flatMap((P) => P.widgets.map((a) => a.fieldName))).size;
  if (nf) msg(`This PDF has ${nf} fillable field${nf === 1 ? '' : 's'}. Click a shaded box and type.`);
}

// Fill in forms: each field is a real input laid over the page (select tool); values go into the PDF's own form when you save.
function setField(name, v) { fv[name] = v; touched.add(name); dirty = true; status(); }
function drawFields(P) {
  P.layer.querySelectorAll('.ff').forEach((e) => e.remove());
  for (const a of P.widgets || []) {
    const p = toView(P, [a.rect[0], a.rect[1]]), q = toView(P, [a.rect[2], a.rect[3]]);
    const l = Math.min(p[0], q[0]), t = Math.min(p[1], q[1]), w = Math.abs(p[0] - q[0]), h = Math.abs(p[1] - q[1]), name = a.fieldName;
    let el;
    if (a.fieldType === 'Tx') {
      el = document.createElement(a.multiLine ? 'textarea' : 'input');
      if (!a.multiLine && a.password) el.type = 'password';
      if (a.maxLen) el.maxLength = a.maxLen;
      el.value = fv[name] ?? '';
      el.style.fontSize = (a.multiLine ? 12 * zoom : Math.max(8, Math.min(h * 0.7, 18 * zoom))) + 'px';
      el.addEventListener('input', () => setField(name, el.value));
    } else if (a.fieldType === 'Ch') {
      el = document.createElement('select');
      el.appendChild(new Option('', ''));
      (a.options || []).forEach((o) => el.appendChild(new Option(o.displayValue ?? o.exportValue, o.exportValue)));
      el.value = fv[name] ?? ''; el.style.fontSize = Math.max(8, Math.min(h * 0.7, 18 * zoom)) + 'px';
      el.addEventListener('change', () => setField(name, el.value));
    } else {
      el = document.createElement('input'); el.type = a.radioButton ? 'radio' : 'checkbox';
      el.checked = a.radioButton ? fv[name] === a.buttonValue : !!fv[name];
      el.addEventListener('change', () => { if (a.radioButton) { setField(name, a.buttonValue); pages.forEach(drawFields); } else setField(name, el.checked); });
    }
    el.className = 'ff'; el.title = a.alternativeText || name; el.dataset.field = name;
    el.style.cssText += `;left:${l}px;top:${t}px;width:${w}px;height:${h}px`;
    P.layer.appendChild(el);
  }
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
  drawFields(P);
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
// Mark shapes in a box of 1 x 1 around the click. The cross is one unbroken stroke that retraces half a diagonal.
const STAMPS = {
  tick: [[-0.5, 0.05], [-0.15, 0.45], [0.5, -0.5]],
  cross: [[-0.5, -0.5], [0.5, 0.5], [0, 0], [0.5, -0.5], [-0.5, 0.5]],
  dot: [[0, 0], [0.001, 0]],
};
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
    if (tool === 'tick' || tool === 'cross' || tool === 'dot') { // a mark is a short drawing, so it moves, undoes, deletes and saves like one
      e.preventDefault();
      let size = sizeVal(), cx = x, cy = y;
      const shape = STAMPS[tool], mk = tool;
      // Clicked on (or right next to) an empty box drawn on the page: centre the mark in it and fit its size.
      const [px, py] = toPdf(P, x, y);
      findBox(P).then((boxes) => {
        const b = boxes.find((q) => px >= q.x - 3 && px <= q.x + q.w + 3 && py >= q.y - 3 && py <= q.y + q.h + 3);
        if (b) { size = Math.max(4, Math.min(b.w, b.h) * 0.85); [cx, cy] = P.vp.convertToViewportPoint(b.x + b.w / 2, b.y + b.h / 2); }
        const s = size * zoom;
        const pts = shape.map(([dx, dy]) => toPdf(P, cx + dx * s, cy + dy * s));
        addNote({ type: 'draw', page: P.idx, pts, color: colorVal(), width: Math.max(1, Math.round(size * (mk === 'dot' ? 0.6 : 0.14) * 10) / 10), mark: mk });
      });
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

// Signature: draw it with the mouse or type it in a handwriting font; saved per user so it can be reused on any PDF.
function placeSignature(url) {
  const P = pages[curPage]; if (!P) return;
  const im = new Image();
  im.onload = () => {
    const v1 = vpOf(P, 1), w = Math.min(160, v1.width * 0.4), h = w * (im.naturalHeight / im.naturalWidth), cx = v1.width / 2, cy = v1.height / 2;
    setTool('select');
    addNote({ type: 'img', page: P.idx, mime: 'image/png', url, p1: v1.convertToPdfPoint(cx - w / 2, cy - h / 2), p2: v1.convertToPdfPoint(cx + w / 2, cy + h / 2) });
    msg('Signature added. Drag it into place and use the corner handles to resize.');
  };
  im.src = url;
}
function trimCanvas(c) { // crop to the ink so the signature has no empty border
  const ctx = c.getContext('2d'), d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const m = 6, o = document.createElement('canvas'); o.width = x1 - x0 + 1 + m * 2; o.height = y1 - y0 + 1 + m * 2;
  o.getContext('2d').drawImage(c, x0 - m, y0 - m, o.width, o.height, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}
async function signatureDialog() {
  if (!doc) return msg('Open a PDF first');
  const bgEl = $('#modal-bg'), box = $('#modal'), KEY = 'pdf.signatures';
  let mode = 'draw', color = '#111111', inked = false, saved = MTRX.prefs.get(KEY, []);
  const close = () => { bgEl.hidden = true; box.innerHTML = ''; };
  box.innerHTML = `<h3>Signature</h3>
    <div class="sg-tabs"><button type="button" data-m="draw" class="on">Draw</button><button type="button" data-m="type">Type</button></div>
    <div id="sg-type" hidden><input id="sg-name" placeholder="Type your name" maxlength="40"> <select id="sg-font"><option>Dancing Script</option><option>Caveat</option></select></div>
    <canvas id="sg-pad" width="440" height="150"></canvas>
    <div class="sg-row"><span>Colour</span>${['#111111', '#1f4e79', '#32000c'].map((c) => `<button type="button" class="sg-c${c === color ? ' on' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}<button type="button" id="sg-clear" class="mini">Clear</button></div>
    <label style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="sg-keep" checked style="width:auto"> Remember it on this computer</label>
    <div id="sg-saved"></div>
    <div class="actions"><button id="m-cancel">Cancel</button><button class="ok" id="sg-use" type="button">Place on page</button></div>`;
  bgEl.hidden = false;
  const pad = box.querySelector('#sg-pad'), ctx = pad.getContext('2d');
  const style = () => { ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.lineCap = ctx.lineJoin = 'round'; };
  const clear = () => { ctx.clearRect(0, 0, pad.width, pad.height); inked = false; };
  const typed = async () => {
    clear(); const t = box.querySelector('#sg-name').value.trim(); if (!t) return;
    const f = box.querySelector('#sg-font').value; await document.fonts.load(`60px "${f}"`);
    ctx.fillStyle = color; ctx.font = `64px "${f}"`; ctx.textBaseline = 'middle';
    const w = ctx.measureText(t).width; if (w > pad.width - 20) ctx.font = `${Math.floor(64 * (pad.width - 20) / w)}px "${f}"`;
    ctx.fillText(t, 10, pad.height / 2); inked = true;
  };
  const list = () => {
    const s = box.querySelector('#sg-saved'); s.replaceChildren();
    if (!saved.length) return;
    const h = document.createElement('div'); h.className = 'none'; h.textContent = 'Your saved signatures (click to place)'; s.append(h);
    const row = document.createElement('div'); row.className = 'sg-list';
    saved.forEach((u, i) => {
      const it = document.createElement('span'); it.className = 'sg-item';
      const im = document.createElement('img'); im.src = u; im.title = 'Place this signature'; im.onclick = () => { close(); placeSignature(u); };
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Forget this signature'; x.onclick = () => { saved.splice(i, 1); MTRX.prefs.set(KEY, saved); list(); };
      it.append(im, x); row.append(it);
    });
    s.append(row);
  };
  list();
  box.querySelectorAll('.sg-tabs button').forEach((b) => (b.onclick = () => {
    mode = b.dataset.m; box.querySelectorAll('.sg-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    box.querySelector('#sg-type').hidden = mode !== 'type'; clear(); pad.style.cursor = mode === 'draw' ? 'crosshair' : 'default';
    if (mode === 'type') box.querySelector('#sg-name').focus();
  }));
  box.querySelectorAll('.sg-c').forEach((b) => (b.onclick = () => { color = b.dataset.c; box.querySelectorAll('.sg-c').forEach((x) => x.classList.toggle('on', x === b)); if (mode === 'type') typed(); }));
  box.querySelector('#sg-name').oninput = typed; box.querySelector('#sg-font').onchange = typed;
  box.querySelector('#sg-clear').onclick = () => { clear(); if (mode === 'type') box.querySelector('#sg-name').value = ''; };
  let down = false;
  const at = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.addEventListener('pointerdown', (e) => { if (mode !== 'draw') return; down = true; pad.setPointerCapture(e.pointerId); style(); const [x, y] = at(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y); ctx.stroke(); inked = true; });
  pad.addEventListener('pointermove', (e) => { if (!down) return; const [x, y] = at(e); ctx.lineTo(x, y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y); });
  pad.addEventListener('pointerup', () => { down = false; });
  $('#m-cancel').onclick = close;
  $('#sg-use').onclick = () => {
    const url = inked ? trimCanvas(pad) : null;
    if (!url) return msg(mode === 'draw' ? 'Draw your signature first' : 'Type your name first');
    if (box.querySelector('#sg-keep').checked) { saved = [url, ...saved.filter((u) => u !== url)].slice(0, 4); MTRX.prefs.set(KEY, saved); }
    close(); placeSignature(url);
  };
}
$('#pdf-sign').onclick = signatureDialog;

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
  else if (n.type === 'draw' && n.mark) { // a tick, cross or dot grows about its centre
    const xs = n.pts.map((p) => p[0]), ys = n.pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    n.pts = n.pts.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]);
    n.width = Math.max(0.5, Math.min(60, n.width * f));
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
// Tick / cross / box symbols are not in the built-in PDF font, so they are drawn as vector shapes
// (works offline, no font file needed). Everything else goes through the normal text path.
const SYMBOLS = {
  '✓': 'tick', '✔': 'tick', '✗': 'cross', '✘': 'cross', '✕': 'cross', '✖': 'cross', '×': null,
  '☐': 'box', '☑': 'boxtick', '☒': 'boxcross', '□': 'box', '■': 'solid', '●': 'dot', '○': 'ring',
};
function drawRuns(pg, line, x, y, size, font, color, R, safe) {
  const a = (R * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
  let adv = 0, run = '';
  const P = (lx, ly) => ({ x: x + (adv + lx) * ux - ly * uy, y: y + (adv + lx) * uy + ly * ux });
  const seg = (p, q, w) => pg.drawLine({ start: P(...p), end: P(...q), thickness: w, color, lineCap: PL.LineCapStyle.Round });
  const flush = () => {
    if (!run) return;
    const t = safe(run);
    pg.drawText(t, { x: x + adv * ux, y: y + adv * uy, size, font, color, rotate: PL.degrees(R) });
    adv += font.widthOfTextAtSize(t, size); run = '';
  };
  const w = Math.max(0.6, size * 0.09), s = size;
  for (const c of [...line]) {
    const kind = SYMBOLS[c];
    if (!kind) { run += c; continue; }
    flush();
    const box = () => { const l = s * 0.08, r = s * 0.88, b = -s * 0.12, t = s * 0.78;
      seg([l, b], [r, b], w); seg([r, b], [r, t], w); seg([r, t], [l, t], w); seg([l, t], [l, b], w); };
    const tick = (o = 0, k = 1) => { seg([s * (0.2 + o), s * 0.32], [s * (0.4 + o), s * 0.08], w * 1.2); seg([s * (0.4 + o), s * 0.08], [s * (0.78 + o * 0.2) , s * (0.78 * k)], w * 1.2); };
    const cross = (l = 0.15, r = 0.75, b = 0, t = 0.65) => { seg([s * l, s * b], [s * r, s * t], w * 1.2); seg([s * l, s * t], [s * r, s * b], w * 1.2); };
    if (kind === 'tick') tick();
    else if (kind === 'cross') cross();
    else if (kind === 'box') box();
    else if (kind === 'boxtick') { box(); tick(0.05, 0.7); }
    else if (kind === 'boxcross') { box(); cross(0.25, 0.7, 0.05, 0.6); }
    else if (kind === 'solid') { for (let i = 0; i <= 8; i++) seg([s * 0.1, s * (-0.1 + i * 0.1)], [s * 0.85, s * (-0.1 + i * 0.1)], s * 0.1); }
    else if (kind === 'dot') seg([s * 0.45, s * 0.3], [s * 0.451, s * 0.3], s * 0.6);
    else if (kind === 'ring') { const n = 16; for (let i = 0; i < n; i++) { const t1 = (i / n) * 2 * Math.PI, t2 = ((i + 1) / n) * 2 * Math.PI; seg([s * (0.45 + 0.32 * Math.cos(t1)), s * (0.3 + 0.32 * Math.sin(t1))], [s * (0.45 + 0.32 * Math.cos(t2)), s * (0.3 + 0.32 * Math.sin(t2))], w); } }
    adv += s * 0.95;
  }
  flush();
}

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
            if (line) drawRuns(pg, line, x, y, n.size, font, color, R, safe);
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
    if (touched.size) { // typed form values go into the PDF's own fields
      const form = out.getForm();
      for (const k of touched) {
        try {
          const f = form.getField(k), v = fv[k];
          if (f instanceof PL.PDFTextField) f.setText(safe(String(v ?? '')));
          else if (f instanceof PL.PDFCheckBox) { if (v) f.check(); else f.uncheck(); }
          else if (f instanceof PL.PDFRadioGroup) { if (v) f.select(v); }
          else if (f instanceof PL.PDFDropdown || f instanceof PL.PDFOptionList) { if (v) f.select(v); else f.clear(); }
        } catch (e) { console.warn('form field not saved', k, e); }
      }
      form.updateFieldAppearances(font);
    }
    pages.filter((P) => P.deleted).sort((a, b) => b.idx - a.idx).forEach((P) => out.removePage(P.idx));
    const data = bytesToB64(await out.save());
    const p = await invoke('save_pdf', { name, data });
    if (p) { dirty = false; MTRX.session.saved('pdf'); msg('Saved: ' + p); }
  } catch (e) { msg('Save failed: ' + (e?.message || e)); }
}
$('#pdf-save').onclick = save;

// ---- PDF -> Writer -----------------------------------------------------
// Rebuilds an editable document from what the PDF draws: headings, bold/italic, lists, centred lines,
// two columns, pictures, tables (from ruling lines) and check boxes. A PDF stores positioned glyphs, not
// paragraphs, so this is a best effort and complex layouts will not match exactly.
const fontFlags = (P, n) => {
  try { const f = P.pg.commonObjs.get(n), nm = f.name || ''; return { b: !!f.bold || /bold|black|heavy|semibold|demi/i.test(nm), i: !!f.italic || /italic|oblique/i.test(nm) }; } catch (e) { return { b: false, i: false }; }
};
// The PDF's font name (e.g. "ABCDEF+Arial-BoldMT") -> the closest font a PC has, so Writer and Word can show it.
const FAMILIES = [[/arialnarrow/i, 'Arial Narrow'], [/arial|helvet|liberationsans|nimbussans|swiss/i, 'Arial'], [/times|liberationserif|nimbusroman|tinos/i, 'Times New Roman'],
  [/courier|liberationmono|nimbusmono|cousine/i, 'Courier New'], [/calibri|carlito/i, 'Calibri'], [/cambria|caladea/i, 'Cambria'], [/consolas/i, 'Consolas'],
  [/georgia/i, 'Georgia'], [/verdana/i, 'Verdana'], [/tahoma/i, 'Tahoma'], [/trebuchet/i, 'Trebuchet MS'], [/segoe/i, 'Segoe UI'], [/palatino|bookantiqua/i, 'Palatino Linotype'],
  [/garamond/i, 'Garamond'], [/centurygothic/i, 'Century Gothic'], [/candara/i, 'Candara'], [/corbel/i, 'Corbel'], [/constantia/i, 'Constantia']];
const familyOf = (P, n) => {
  try {
    const f = P.pg.commonObjs.get(n), nm = (f.name || '').replace(/^[A-Z]{6}\+/, '').replace(/[\s_-]/g, '');
    if (/symbol|wingding|dingbat|zapf/i.test(nm)) return null;
    for (const [re, fam] of FAMILIES) if (re.test(nm)) return fam;
    return f.fallbackName === 'monospace' ? 'Courier New' : f.fallbackName === 'serif' ? 'Times New Roman' : 'Arial';
  } catch (e) { return null; }
};
// Draw a page onto a private canvas. 'print' intent renders without waiting on the screen, so it also works while the
// window is hidden; if it still stalls we give up after a few seconds instead of hanging the conversion.
async function renderCanvas(P, scale) {
  const vp = P.pg.getViewport({ scale }), c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const task = P.pg.render({ canvasContext: ctx, viewport: vp, background: '#ffffff', intent: 'print' });
  let timer;
  const ok = await Promise.race([task.promise.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), 8000); })]);
  clearTimeout(timer);
  if (!ok) { try { task.cancel(); } catch (e) { /* already done */ } return null; }
  return { c, ctx, vp };
}
// Render the page once, privately, so each piece of text can be given the colour it really has on the page.
async function pageColours(P, items) {
  try {
    const R = await renderCanvas(P, 1.5); if (!R) return;
    const { c, ctx, vp } = R;
    for (const it of items) {
      if (!it.fam || !it.s.trim()) continue;
      const A = vp.convertToViewportPoint(it.x, it.y + it.size * 0.8), B = vp.convertToViewportPoint(it.x + it.w, it.y - it.size * 0.2);
      const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0]))), y0 = Math.max(0, Math.floor(Math.min(A[1], B[1])));
      const w = Math.min(c.width - x0, Math.ceil(Math.abs(B[0] - A[0]))), h = Math.min(c.height - y0, Math.ceil(Math.abs(B[1] - A[1])));
      if (w < 1 || h < 1) continue;
      const d = ctx.getImageData(x0, y0, w, h).data, seen = new Map();
      for (let i = 0; i < d.length; i += 4) { const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); seen.set(k, (seen.get(k) || 0) + 1); }
      let bgK = 0, bgN = -1; seen.forEach((n, k) => { if (n > bgN) { bgN = n; bgK = k; } });
      let bg = [((bgK >> 8) & 15) * 17, ((bgK >> 4) & 15) * 17, (bgK & 15) * 17];
      for (let i = 0; i < d.length; i += 4) if ((((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)) === bgK) { bg = [d[i], d[i + 1], d[i + 2]]; break; } // the page's real background colour here
      it.bg = '#' + bg.map((v) => v.toString(16).padStart(2, '0')).join('');
      let best = null, bd = 90;
      for (let i = 0; i < d.length; i += 4) { const e = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]); if (e > bd) { bd = e; best = [d[i], d[i + 1], d[i + 2]]; } }
      // plain black / near-black text needs no colour; anything else is kept
      if (best && Math.max(...best) > 70) it.col = '#' + best.map((v) => v.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* colours are a bonus; text still converts */ }
}
// one run of text -> html, with the font, size and colour it had in the PDF
const runHtml = (r) => {
  let st = '';
  if (r.fam) st += `font-family:${r.fam};`;
  if (r.size) st += `font-size:${r.size}pt;`;
  if (r.col) st += `color:${r.col};`;
  const t = (r.b ? '<b>' : '') + (r.i ? '<i>' : '') + escH(r.t) + (r.i ? '</i>' : '') + (r.b ? '</b>' : '');
  return st ? `<span style="${st}">${t}</span>` : t;
};
// text items -> lines (top to bottom, items left to right)
function lineize(items) {
  const its = items.slice().sort((a, b) => b.y - a.y || a.x - b.x), lines = [];
  for (const it of its) {
    const L = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(it.size, l.size) * 0.4);
    if (L) { L.items.push(it); L.size = Math.max(L.size, it.size); } else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  lines.forEach((l) => {
    l.items.sort((a, b) => a.x - b.x);
    l.x0 = l.items[0].x; l.x1 = Math.max(...l.items.map((i) => i.x + i.w));
    const runs = []; let prev = null, plain = '';
    for (const it of l.items) {
      let s = it.s;
      if (prev) { const gap = it.x - (prev.x + prev.w); if (gap > it.size * 2.5) s = '    ' + s.trimStart(); else if (gap > it.size * 0.12 && !/\s$/.test(prev.s) && !/^\s/.test(s)) s = ' ' + s; }
      plain += s;
      const last = runs[runs.length - 1];
      const size = it.fam ? Math.round(it.size * 2) / 2 : 0;
      if (last && last.b === it.b && last.i === it.i && last.fam === it.fam && last.col === it.col && last.size === size) last.t += s;
      else runs.push({ b: it.b, i: it.i, fam: it.fam, col: it.col, size, t: s });
      prev = it;
    }
    const h = runs.map(runHtml).join('');
    l.plain = plain.replace(/[ \t\r\n]+/g, ' ').trim(); l.html = h.replace(/[ \t\r\n]+/g, ' ').trim();
    l.bold = l.items.every((i) => i.b || !i.s.trim());
  });
  return lines;
}
const BULLET = /^[•●▪◦‣·\-–—*]\s+/, NUMBER = /^(\d{1,3}[.)]|[a-z]\))\s+/;
const stripMarker = (html, re) => html.replace(/^(<[bi]>)*/, (t) => t).replace(re, '');

// Scanned pages have no text, only a picture. Windows' own offline text recognition reads the words and where they sit.
async function ocrPng(b64) {
  try {
    if (invoke) { const v = await invoke('ocr_page', { png: b64 }); if (Array.isArray(v)) return v; }
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { // dev server in a plain browser
      const r = await fetch('http://localhost:8124/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'ocr.page', args: { png: b64 } }) });
      const j = await r.json(); if (Array.isArray(j.ok)) return j.ok;
    }
  } catch (e) { /* no recognition available */ }
  return null;
}
async function ocrItems(P) {
  const R = await renderCanvas(P, 2.5); if (!R) return [];
  const lines = await ocrPng(R.c.toDataURL('image/png').split(',')[1]); if (!lines) return [];
  const out = [], med = (a) => a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)];
  for (const ln of lines) {
    const hs = ln.words.map((w) => w.h), size = Math.max(5, med(hs) * 0.88 / R.vp.scale);
    const bottom = med(ln.words.map((w) => w.y + w.h));
    for (const w of ln.words) {
      const [x, y] = R.vp.convertToPdfPoint(w.x, bottom), [x2] = R.vp.convertToPdfPoint(w.x + w.w, bottom);
      out.push({ s: w.text, x, y: y + size * 0.2, w: x2 - x, size, b: false, i: false, fam: 'Arial', col: null });
    }
  }
  return out;
}

async function pageData(P) {
  const tc = await P.pg.getTextContent(), g = await gfx(P);
  const items = tc.items.filter((it) => 'str' in it && it.str !== '').map((it) => {
    const f = fontFlags(P, it.fontName);
    return { s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, size: Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.height) || 10, b: f.b, i: f.i, fam: familyOf(P, it.fontName), col: null };
  });
  let ocr = false;
  if (items.reduce((n, i) => n + i.s.trim().length, 0) < 3) { const o = await ocrItems(P); if (o.length) { items.push(...o); ocr = true; } }
  await pageColours(P, items);
  // drawn boxes carry over as ☐, or ☑ / ☒ where a tick / cross was stamped in them
  const marks = notes.filter((n) => n.page === P.idx && n.mark);
  for (const b of g.boxes) {
    const m = marks.find((n) => { const xs = n.pts.map((p) => p[0]), ys = n.pts.map((p) => p[1]), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2; return cx >= b.x - 2 && cx <= b.x + b.w + 2 && cy >= b.y - 2 && cy <= b.y + b.h + 2; });
    items.push({ s: ' ' + (m ? (m.mark === 'cross' ? '☒' : '☑') : '☐') + ' ', x: b.x, y: b.y + b.h * 0.2, w: b.w, size: Math.max(8, b.h * 0.85), b: false, i: false });
  }
  return { P, items, g, ocr, W: P.pg.view[2] - P.pg.view[0] };
}

// ruling lines -> tables
function findTables(g) {
  const L = [...g.H.filter((l) => l.x2 - l.x1 >= 8).map((l) => ({ h: 1, ...l })), ...g.V.filter((l) => l.y2 - l.y1 >= 8).map((l) => ({ h: 0, ...l }))];
  const par = L.map((_, i) => i), find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
  const tol = 1.6;
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = L[i], b = L[j]; if (a.h === b.h) continue;
    const H = a.h ? a : b, V = a.h ? b : a;
    if (V.x >= H.x1 - tol && V.x <= H.x2 + tol && H.y >= V.y1 - tol && H.y <= V.y2 + tol) par[find(i)] = find(j);
  }
  const comps = new Map(); L.forEach((l, i) => { const r = find(i); (comps.get(r) || comps.set(r, []).get(r)).push(l); });
  const clus = (vals) => { const s = [...vals].sort((a, b) => a - b), out = []; s.forEach((v) => { if (!out.length || v - out[out.length - 1] > tol * 1.2) out.push(v); }); return out; };
  const tables = [];
  for (const c of comps.values()) {
    const ys = clus(c.filter((l) => l.h).map((l) => l.y)).reverse(), xs = clus(c.filter((l) => !l.h).map((l) => l.x));
    if (ys.length < 2 || xs.length < 2 || (ys.length - 1) * (xs.length - 1) < 2) continue;
    tables.push({ ys, xs, top: ys[0], x0: xs[0], x1: xs[xs.length - 1], y0: ys[ys.length - 1], hs: c.filter((l) => l.h), vs: c.filter((l) => !l.h) });
  }
  return tables;
}

async function pageBlocks(D, body, withImages) {
  const { items, g, W } = D, blocks = [];
  const tables = findTables(g);
  let rest = items;
  for (const t of tables) {
    const inside = (it) => { const cx = it.x + it.w / 2; return cx >= t.x0 - 2 && cx <= t.x1 + 2 && it.y >= t.y0 - 2 && it.y <= t.top + 2; };
    const mine = rest.filter(inside); rest = rest.filter((it) => !inside(it));
    // merged cells: a cell runs on past a grid line when no drawn line closes it there
    const R = t.ys.length - 1, C = t.xs.length - 1, tol = 1.8, done = Array.from({ length: R }, () => Array(C).fill(false));
    const vClosed = (x, yMid) => t.vs.some((l) => Math.abs(l.x - x) <= tol && yMid >= l.y1 - tol && yMid <= l.y2 + tol);
    const hClosed = (y, xMid) => t.hs.some((l) => Math.abs(l.y - y) <= tol && xMid >= l.x1 - tol && xMid <= l.x2 + tol);
    let html = '<table><tbody>';
    for (let r = 0; r < R; r++) {
      html += '<tr>';
      for (let c = 0; c < C; c++) {
        if (done[r][c]) continue;
        let cs = 1, rs = 1;
        const yMid = (t.ys[r] + t.ys[r + 1]) / 2;
        while (c + cs < C && !vClosed(t.xs[c + cs], yMid)) cs++;
        const xMid = (t.xs[c] + t.xs[c + 1]) / 2;
        while (r + rs < R && !hClosed(t.ys[r + rs], xMid)) rs++;
        for (let a = r; a < r + rs; a++) for (let b = c; b < c + cs; b++) done[a][b] = true;
        const cell = mine.filter((it) => { const cx = it.x + it.w / 2; return cx >= t.xs[c] - 1 && cx < t.xs[c + cs] && it.y <= t.ys[r] + 1 && it.y > t.ys[r + rs] - 1; });
        html += `<td${cs > 1 ? ` colspan="${cs}"` : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}>` + (cell.length ? lineize(cell).map((l) => l.html).join('<br>') : '<br>') + '</td>';
      }
      html += '</tr>';
    }
    blocks.push({ k: 'table', html: html + '</tbody></table>', y: t.top, x0: t.x0, x1: t.x1 });
  }
  if (withImages) {
    await g.load?.();
    for (const im of g.imgs) if (!(D.ocr && im.w * im.h > 0.6 * (D.W * (D.P.pg.view[3] - D.P.pg.view[1])))) blocks.push({ k: 'img', html: `<p><img src="${im.src}" width="${Math.round(Math.min(im.w * 1.333, 620))}"></p>`, y: im.y + im.h, x0: im.x, x1: im.x + im.w });
  }
  // tables with no drawn lines: three or more rows whose pieces of text line up in the same columns
  {
    const ls = lineize(rest.filter((it) => it.s.trim())), used = new Set();
    const segs = ls.map((l) => { const out = []; let cur = null; for (const it of l.items) { if (cur && it.x - cur.x1 <= l.size * 1.8) { cur.items.push(it); cur.x1 = Math.max(cur.x1, it.x + it.w); } else out.push(cur = { x0: it.x, x1: it.x + it.w, items: [it] }); } return out; });
    let i = 0;
    while (i < ls.length) {
      if (segs[i].length < 2) { i++; continue; }
      let j = i + 1; while (j < ls.length && segs[j].length >= 2 && ls[j - 1].y - ls[j].y <= Math.max(ls[j].size, ls[j - 1].size) * 2.4) j++;
      if (j - i >= 3) {
        const all = segs.slice(i, j).flat().sort((a, b) => a.x0 - b.x0), size = Math.max(...ls.slice(i, j).map((l) => l.size)), cols = [];
        for (const s of all) { const last = cols[cols.length - 1]; if (last && s.x0 <= last.x1 + size * 0.8) last.x1 = Math.max(last.x1, s.x1); else cols.push({ x0: s.x0, x1: s.x1 }); }
        const colOf = (s) => cols.findIndex((c) => (s.x0 + s.x1) / 2 >= c.x0 - 0.5 && (s.x0 + s.x1) / 2 <= c.x1 + 0.5);
        const rows = ls.slice(i, j).map((_, k) => segs[i + k]), valid = rows.filter((r) => new Set(r.map(colOf)).size >= 2).length;
        const chars = all.reduce((n, s) => n + s.items.reduce((m, it) => m + it.s.length, 0), 0) / all.length;
        if (cols.length >= 2 && cols.length <= 12 && valid >= Math.ceil(rows.length * 0.8) && chars <= 28) {
          let html = '<table data-bd="none"><tbody>';
          rows.forEach((r) => {
            html += '<tr>';
            cols.forEach((c, ci) => { const mine = r.filter((s) => colOf(s) === ci).flatMap((s) => s.items); html += '<td>' + (mine.length ? lineize(mine).map((l) => l.html).join('<br>') : '<br>') + '</td>'; });
            html += '</tr>';
          });
          blocks.push({ k: 'table', html: html + '</tbody></table>', y: ls[i].y + ls[i].size, x0: cols[0].x0, x1: cols[cols.length - 1].x1 });
          rows.forEach((r) => r.forEach((s) => s.items.forEach((it) => used.add(it))));
        }
      }
      i = j;
    }
    if (used.size) rest = rest.filter((it) => !used.has(it));
  }
  // two columns: a clear vertical gutter in the middle of the page with text on both sides
  let gut = 0;
  const narrow = rest.filter((it) => it.w < W * 0.6 && it.size < body * 1.15);
  if (narrow.length >= 8) {
    const cover = new Uint8Array(Math.ceil(W) + 2);
    narrow.forEach((it) => { for (let x = Math.max(0, Math.floor(it.x)); x <= Math.min(cover.length - 1, Math.ceil(it.x + it.w)); x++) cover[x] = 1; });
    let best = 0, run = 0, start = 0;
    for (let x = Math.floor(W * 0.3); x <= Math.floor(W * 0.7); x++) { if (!cover[x]) { if (!run) start = x; run++; if (run > best) { best = run; gut = start + run / 2; } } else run = 0; }
    if (best < 12) gut = 0;
    else {
      const rows = (side) => new Set(narrow.filter((it) => (side ? it.x > gut : it.x + it.w < gut)).map((it) => Math.round(it.y / 4))).size;
      if (rows(0) < 4 || rows(1) < 4) gut = 0;
    }
  }
  const groups = new Map();
  rest.forEach((it) => { const full = gut && (it.w > W * 0.6 || it.size >= body * 1.15) ? -1 : gut ? (it.x + it.w / 2 < gut ? 0 : 1) : 0; (groups.get(full) || groups.set(full, []).get(full)).push(it); });
  for (const [col, its] of groups) {
    const lines = lineize(its), cl = Math.min(...lines.map((l) => l.x0)), cr = Math.max(...lines.map((l) => l.x1)), cw = Math.max(1, cr - cl);
    // paragraph breaks are judged against the page's own rhythm: its usual line pitch and where its right edge really is
    const gapsAll = []; for (let i = 1; i < lines.length; i++) { const gp = lines[i - 1].y - lines[i].y; if (gp > 0 && gp < lines[i].size * 2.2 && Math.abs(lines[i].size - lines[i - 1].size) < 0.6) gapsAll.push(gp); }
    gapsAll.sort((a, b) => a - b);
    const pitch = gapsAll.length ? gapsAll[Math.floor(gapsAll.length / 2)] : body * 1.25;
    const x1s = lines.filter((l) => l.plain).map((l) => l.x1).sort((a, b) => a - b), rr = x1s[Math.floor(x1s.length * 0.9)] ?? cr;
    let para = null, prev = null;
    const flush = () => { if (para) { blocks.push(para); para = null; } };
    for (const l of lines) {
      if (!l.plain) continue;
      const ratio = l.size / body;
      let kind = 'p', html = l.html, ordered = false;
      if (ratio >= 1.15 && l.plain.length <= 140) kind = ratio >= 1.6 ? 'h1' : ratio >= 1.3 ? 'h2' : 'h3';
      else if (BULLET.test(l.plain)) { kind = 'li'; html = html.replace(/^((?:<[bi]>|<span[^>]*>)*)\s*[•●▪◦‣·\-–—*]\s+/, '$1'); }
      else if (NUMBER.test(l.plain)) { kind = 'li'; ordered = true; html = html.replace(/^((?:<[bi]>|<span[^>]*>)*)\s*(\d{1,3}[.)]|[a-z]\))\s+/, '$1'); }
      const centred = kind !== 'li' && l.plain.length < 90 && l.x0 - cl > cw * 0.1 && Math.abs((l.x0 + l.x1) / 2 - (gut ? (cl + cr) / 2 : D.P.pg.view[0] + W / 2)) < Math.max(cw, W * 0.5) * 0.03;
      const gap = prev ? prev.y - l.y : 0;
      const cont = para && kind === 'p' && para.k === 'p' && !centred === !para.centred && gap <= Math.max(pitch * 1.3, prev.size * 1.45)
        && prev.x1 >= cl + cw * 0.55                                                                  // a short line ends its paragraph
        && !(l.x0 - cl > l.size * 1.2 && prev.x0 - cl < l.size * 0.6)                                 // first-line indent starts a new one
        && !(/[.!?:]["'”’)]?$/.test(prev.plain) && prev.x1 < rr - cw * 0.12 && /^["“‘(]?[A-Z0-9]/.test(l.plain)); // a finished sentence on a short line
      const sameHead = para && kind[0] === 'h' && para.k === kind && gap <= prev.size * 1.7;
      if (cont) para.html += ' ' + html;
      else if (sameHead) para.html += ' ' + html;
      else { flush(); para = { k: kind, html, y: l.y + l.size, x0: l.x0, x1: l.x1, centred, ordered, col }; }
      prev = l;
    }
    flush();
  }
  // order: top to bottom; with two columns, left then right inside each band between full-width lines
  const fulls = blocks.filter((b) => b.col === -1 || b.k === 'table' && gut && b.x1 - b.x0 > W * 0.6).map((b) => b.y).sort((a, b) => b - a);
  const colOf = (b) => (b.col === -1 ? -1 : gut ? ((b.x0 + b.x1) / 2 < gut ? 0 : 1) : 0);
  const band = (b) => fulls.filter((y) => y > b.y + 0.01).length;
  if (gut) blocks.sort((a, b) => band(a) - band(b) || colOf(a) - colOf(b) || b.y - a.y);
  else blocks.sort((a, b) => b.y - a.y);
  // emit html, grouping list items
  let out = '', open = '';
  const close = () => { if (open) out += `</${open}>`; open = ''; };
  for (const b of blocks) {
    if (b.k === 'li') { const t = b.ordered ? 'ol' : 'ul'; if (open !== t) { close(); out += `<${t}>`; open = t; } out += `<li>${b.html}</li>`; continue; }
    close();
    if (b.k === 'table' || b.k === 'img') out += b.html;
    else if (b.k[0] === 'h') out += `<${b.k}${b.centred ? ' style="text-align:center"' : ''}>${b.html}</${b.k}>`;
    else out += `<p${b.centred ? ' style="text-align:center"' : ''}>${b.html}</p>`;
  }
  close();
  return out;
}

// Page size (snapped to a standard paper when close), margins (from where the text sits) and, when several
// pages repeat the same lines at the top or bottom, a real header / footer with page-number fields.
const PAPER_PT = { Letter: [612, 792], A4: [595.3, 841.9], Legal: [612, 1008], A5: [419.5, 595.3] };
function pageSetup(data) {
  const v = data[0].P.pg.view, w = v[2] - v[0], h = v[3] - v[1], land = w > h, [a, b] = land ? [h, w] : [w, h];
  let tw = Math.round(a * 20), th = Math.round(b * 20);
  for (const [, [pw, ph]] of Object.entries(PAPER_PT)) if (Math.abs(pw - a) < 4 && Math.abs(ph - b) < 4) { tw = Math.round(pw * 20); th = Math.round(ph * 20); }
  const pg = { width: tw, height: th, landscape: land, top: 1440, bottom: 1440, left: 1440, right: 1440 };
  const all = data.flatMap((d) => d.items.filter((it) => it.s.trim()));
  if (all.length >= 3) {
    const med = (xs) => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)];
    const per = data.filter((d) => d.items.length).map((d) => {
      const it = d.items.filter((i) => i.s.trim());
      return { l: Math.min(...it.map((i) => i.x - v[0])), r: w - Math.max(...it.map((i) => i.x + i.w - v[0])), t: v[3] - Math.max(...it.map((i) => i.y + i.size * 0.9)), b: Math.min(...it.map((i) => i.y - v[1])) };
    });
    const tw20 = (pt, lo = 18, hi = 108) => Math.round(Math.max(lo, Math.min(hi, pt)) * 20);
    pg.left = tw20(med(per.map((p) => p.l))); pg.right = tw20(med(per.map((p) => p.r))); pg.top = tw20(med(per.map((p) => p.t))); pg.bottom = tw20(med(per.map((p) => p.b)));
  }
  return pg;
}
function headersFooters(data) {
  const hf = { header: { left: '', center: '', right: '' }, footer: { left: '', center: '', right: '' }, firstDifferent: false, firstHeader: { left: '', center: '', right: '' }, firstFooter: { left: '', center: '', right: '' } };
  const n = data.length; if (n < 2) return hf;
  const found = new Map(); // key -> { zone, pages:Set, hits:[{d, items}] }
  data.forEach((d, di) => {
    const H = d.P.pg.view[3] - d.P.pg.view[1], band = H * 0.11;
    for (const l of lineize(d.items.filter((i) => i.s.trim()))) {
      const top = l.y > H - band, bottom = l.y < band; if (!top && !bottom) continue;
      const txt = l.plain.replace(/\s+/g, ' ').trim(), tot = String(n), me = String(di + 1);
      const norm = txt.replace(/\d+/g, (m) => (m === me ? '{page}' : m === tot && /\bof\b|\/|von/.test(txt) ? '{pages}' : m));
      const key = (top ? 'H' : 'F') + '|' + Math.round(l.y / 4) + '|' + norm;
      const e = found.get(key) || found.set(key, { top, norm, zone: (l.x0 + l.x1) / 2 / (d.P.pg.view[2] - d.P.pg.view[0]), pages: new Set(), lines: [] }).get(key);
      e.pages.add(di); e.lines.push({ d, l });
    }
  });
  const need = Math.max(2, Math.ceil(n * 0.6));
  let firstSkip = false;
  for (const e of found.values()) {
    const cnt = e.pages.size, cover = cnt >= need || (cnt >= n - 1 && !e.pages.has(0) && n >= 3);
    if (!cover) continue;
    if (!e.pages.has(0) && n >= 3) firstSkip = true;
    const side = e.zone < 0.33 ? 'left' : e.zone > 0.67 ? 'right' : 'center', z = hf[e.top ? 'header' : 'footer'];
    z[side] = (z[side] ? z[side] + ' ' : '') + e.norm;
    for (const { d, l } of e.lines) { const set = new Set(l.items); d.items = d.items.filter((i) => !set.has(i)); }
  }
  if (firstSkip) hf.firstDifferent = true;
  return hf;
}
async function extractDoc() {
  const data = [];
  for (const P of live()) data.push(await pageData(P));
  const hf = headersFooters(data), page = pageSetup(data);
  // body text size = the size most characters are set in
  const tally = new Map();
  data.forEach((d) => d.items.forEach((it) => { const k = Math.round(it.size * 2) / 2; tally.set(k, (tally.get(k) || 0) + it.s.length); }));
  const body = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 12;
  const parts = [];
  for (const d of data) parts.push(await pageBlocks(d, body, true));
  const html = parts.filter(Boolean).join('<div class="pb"></div>');
  return { html: html || '<p><br></p>', page, hf };
}
async function extractHtml() { return (await extractDoc()).html; }
MTRX.pdfExtract = extractDoc; // used by tests

// "Same look, still editable": each page's lines, shapes and pictures go behind the text as one picture (with the
// original text wiped out of it), and the text is laid back on top as real paragraphs at the same spots, in the same
// font, size and colour. Click and type to edit; each line keeps its place, it does not reflow the page.
const L_ASC = 0.92, L_LINE = 1.15; // where the baseline sits in a line box, and the line height, as multiples of the font size
async function extractLayout() {
  const data = [];
  for (const P of live()) data.push(await pageData(P));
  const page = pageSetup(data), v0 = data[0].P.pg.view, Hpt = v0[3] - v0[1];
  const px = (pt) => Math.round(pt * 100) / 100;
  // text and page boxes: boxes without a tick are already in the picture, so only ticked ones stay as characters
  const perPage = data.map((d) => lineize(d.items.filter((it) => it.s.trim() && (it.fam || /[☑☒]/.test(it.s)))));
  const topOf = (d, l) => (d.P.pg.view[3] - l.y) - L_ASC * l.size;
  const firsts = perPage.map((ls, i) => (ls.length ? topOf(data[i], ls[0]) : Infinity)).filter(Number.isFinite);
  const left = Math.max(0, Math.min(...perPage.flatMap((ls) => ls.map((l) => l.x0)), Infinity) - v0[0]);
  const mTop = firsts.length ? Math.max(0, Math.min(...firsts)) : 36;
  Object.assign(page, { top: Math.round(mTop * 20), left: Math.round((Number.isFinite(left) ? left : 36) * 20), right: 0, bottom: 0 });
  const phPx = (page.landscape ? page.width : page.height) / 15, wPx = (page.landscape ? page.height : page.width) / 15;
  const parts = [];
  for (let k = 0; k < data.length; k++) {
    const d = data[k], R = await renderCanvas(d.P, 2);
    let img = '';
    if (R) {
      const { c, ctx, vp } = R;
      for (const it of d.items) { // wipe the original text out of the picture so the editable copy is not doubled
        if (!it.fam || !it.s.trim()) continue;
        const A = vp.convertToViewportPoint(it.x, it.y + it.size * 0.95), B = vp.convertToViewportPoint(it.x + it.w, it.y - it.size * 0.28);
        ctx.fillStyle = it.bg || '#ffffff';
        ctx.fillRect(Math.floor(Math.min(A[0], B[0])) - 1, Math.floor(Math.min(A[1], B[1])), Math.ceil(Math.abs(B[0] - A[0])) + 2, Math.ceil(Math.abs(B[1] - A[1])) + 1);
      }
      const photo = d.g.imgs?.length;
      img = `<img data-wrap="behind" data-x="0" data-y="${Math.round(k * (phPx + 24))}" width="${Math.round(wPx)}" height="${Math.round(phPx)}" src="${c.toDataURL(photo ? 'image/jpeg' : 'image/png', 0.88)}">`;
    }
    const lines = perPage[k]; let cursor = mTop, html = '';
    lines.forEach((l, i) => {
      const top = topOf(d, l), before = Math.max(0, top - cursor), runs = []; let prev = null;
      for (const it of l.items) {
        let lead = '';
        if (prev) { const gap = it.x - (prev.x + prev.w); if (gap > l.size * 1.0) lead = ' '.repeat(Math.max(2, Math.round(gap / (l.size * 0.27)))); else if (gap > l.size * 0.12 && !/\s$/.test(prev.s) && !/^\s/.test(it.s)) lead = ' '; }
        const size = it.fam ? Math.round(it.size * 2) / 2 : 0, last = runs[runs.length - 1];
        if (last && last.b === it.b && last.i === it.i && last.fam === it.fam && last.col === it.col && last.size === size) last.t += lead + it.s;
        else runs.push({ b: it.b, i: it.i, fam: it.fam, col: it.col, size, t: lead + it.s });
        prev = it;
      }
      cursor += before + L_LINE * l.size;
      const st = `margin:${px(before)}pt 0 0 ${px(Math.max(0, l.x0 - v0[0] - left))}pt;line-height:${L_LINE}`;
      html += `<p style="${st}">${i === 0 ? img : ''}${runs.map(runHtml).join('')}</p>`;
    });
    if (!lines.length) html = `<p>${img}<br></p>`;
    parts.push(html);
  }
  return { html: parts.join('<div class="pb"></div>'), page, hf: null };
}
MTRX.pdfToWriterLayout = async () => {
  if (!doc) return msg('Open a PDF first');
  msg('Laying out pages…');
  try { const d = await extractLayout(); MTRX.openInWriter?.(name, d.html, { page: d.page }); } catch (e) { msg('Could not convert: ' + (e?.message || e)); }
};
MTRX.pdfLayout = extractLayout; // used by tests

// "Exact look": every page becomes a picture. Looks the same, but is not editable text.
async function extractPictures() {
  const parts = [];
  for (const P of live()) {
    const vp = P.pg.getViewport({ scale: 2, rotation: rotOf(P) }), cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    await P.pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    parts.push(`<p><img src="${cv.toDataURL('image/jpeg', 0.9)}" width="620"></p>`);
  }
  return parts.join('<div class="pb"></div>') || '<p><br></p>';
}
MTRX.pdfToWriterPictures = async () => {
  if (!doc) return msg('Open a PDF first');
  msg('Making page pictures…');
  try { MTRX.openInWriter?.(name, await extractPictures()); } catch (e) { msg('Could not convert: ' + (e?.message || e)); }
};
$('#pdf-towriter').onclick = async () => {
  if (!doc) return msg('Open a PDF first');
  msg('Reading text…');
  try { const d = await extractDoc(); MTRX.openInWriter?.(name, d.html, { page: d.page, hf: d.hf }); } catch (e) { msg('Could not read the text: ' + (e?.message || e)); }
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
    const t = { KeyV: 'select', KeyT: 'text', KeyE: 'edit', KeyH: 'highlight', KeyD: 'draw', KeyK: 'tick', KeyX: 'cross', KeyO: 'dot' }[e.code];
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

// ---- reorder pages --------------------------------------------------------
// Drag the thumbnails (or use the arrows); the PDF itself is rewritten in the new order and your edits follow their pages.
async function reorderTo(order) {
  if (order.every((v, i) => v === i)) return;
  const out = await PL.PDFDocument.load(bytes, { ignoreEncryption: true }), refs = out.getPages();
  for (let i = refs.length - 1; i >= 0; i--) out.removePage(i);
  order.forEach((o) => out.addPage(refs[o]));
  const nb = await out.save(), old = pages.map((P) => ({ extra: P.extra, deleted: P.deleted })), at = new Map(order.map((o, i) => [o, i]));
  const d = await pdfjs.getDocument({ data: nb.slice(), isEvalSupported: false }).promise;
  notes.forEach((n) => { n.page = at.get(n.page); });
  doc.destroy(); doc = d; bytes = nb; history = []; sel = null; dirty = true; curPage = 0;
  await buildPages();
  pages.forEach((P, i) => { const s = old[order[i]]; P.extra = s.extra; P.deleted = s.deleted; P.el.style.opacity = P.deleted ? '.3' : ''; });
  relayout(); status(); host.scrollTop = 0;
}
async function reorderDialog() {
  if (!doc) return msg('Open a PDF first');
  if (pages.length < 2) return msg('This PDF has only one page');
  const bgEl = $('#modal-bg'), box = $('#modal'), order = pages.map((P) => P.idx), thumbs = new Map();
  const close = () => { bgEl.hidden = true; box.innerHTML = ''; };
  for (const P of pages) { // small picture of every page, drawn once
    const c = document.createElement('canvas'), vp = P.pg.getViewport({ scale: 96 / P.pg.getViewport({ scale: 1 }).width, rotation: rotOf(P) });
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); thumbs.set(P.idx, c);
    P.pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.catch(() => {});
  }
  const move = (from, to) => { if (to < 0 || to >= order.length || from === to) return; const [x] = order.splice(from, 1); order.splice(to, 0, x); draw(); };
  const draw = () => {
    const list = box.querySelector('#rp-list'); list.replaceChildren();
    order.forEach((o, k) => {
      const it = document.createElement('div'); it.className = 'rp'; it.draggable = true; it.dataset.k = k;
      it.append(thumbs.get(o));
      const lab = document.createElement('span'); lab.textContent = `${k + 1}` + (o === k ? '' : ` (was ${o + 1})`); it.append(lab);
      const bar = document.createElement('div');
      [['◀', -1, 'Move earlier'], ['▶', 1, 'Move later']].forEach(([t, dlt, ttl]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.title = ttl; b.onclick = () => move(k, k + dlt); bar.append(b); });
      it.append(bar);
      it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(k)); e.dataTransfer.effectAllowed = 'move'; });
      it.addEventListener('dragover', (e) => e.preventDefault());
      it.addEventListener('drop', (e) => { e.preventDefault(); move(+e.dataTransfer.getData('text/plain'), k); });
      list.append(it);
    });
  };
  box.innerHTML = `<h3>Reorder pages</h3><p class="none">Drag a page to a new place, or use the arrows. Your highlights, text and images move with their pages.</p>
    <div id="rp-list" class="rps"></div>
    <div class="actions"><button id="m-cancel">Cancel</button><button class="ok" id="rp-ok" type="button">Apply order</button></div>`;
  bgEl.hidden = false; draw();
  $('#m-cancel').onclick = close;
  $('#rp-ok').onclick = async () => { close(); try { await reorderTo(order); msg('Pages reordered. Save to keep it.'); } catch (e) { msg('Could not reorder: ' + (e?.message || e)); } };
}
$('#pdf-reorder').onclick = reorderDialog;

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
