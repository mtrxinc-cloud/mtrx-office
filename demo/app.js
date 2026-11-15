(() => {
const $ = (s) => document.querySelector(s);
const ed = $('#editor');
const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
let saved = null;
const MTRX = (window.MTRX = window.MTRX || {});

document.execCommand('styleWithCSS', false, true);
document.execCommand('defaultParagraphSeparator', false, 'p');

const msg = (t) => { $('#msg').textContent = t; setTimeout(() => { if ($('#msg').textContent === t) $('#msg').textContent = ''; }, 4000); };

// ---- selection preservation -------------------------------------------
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (s.rangeCount && ed.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
  updateTableTools();
});
function restore() {
  ed.focus();
  if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); }
}
function exec(cmd, val) { restore(); document.execCommand(cmd, false, val ?? null); countWords(); }

document.querySelectorAll('.ribbon button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => exec(b.dataset.cmd)));

$('#sel-block').onchange = (e) => { exec('formatBlock', e.target.value); };
$('#sel-font').onchange = (e) => exec('fontName', e.target.value);
// execCommand('fontSize') only knows seven coarse sizes, so we ask for the largest (marker) and rewrite it to real points.
// With no text selected the marker element appears only once you type, so keep the chosen size and convert on input too.
let pendingPt = null;
function fixSizes() {
  if (pendingPt == null) return;
  ed.querySelectorAll('[style*="xxx-large"],font[size="7"]').forEach((el) => {
    el.style.fontSize = pendingPt + 'pt'; el.removeAttribute('size');
  });
}
function setSize(pt) {
  pendingPt = +pt;
  exec('fontSize', '7');
  fixSizes();
}
ed.addEventListener('input', fixSizes);
// Show the size at the cursor in the size box (it used to keep showing whatever was picked last).
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (!s.rangeCount || !ed.contains(s.anchorNode) || document.activeElement === $('#sel-size')) return;
  let el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
  if (!el || el === ed) return;
  const pt = Math.round(parseFloat(getComputedStyle(el).fontSize) * 0.75);
  const sel = $('#sel-size');
  if (pt && [...sel.options].some((o) => +o.value === pt)) sel.value = String(pt);
});
$('#sel-size').onchange = (e) => setSize(e.target.value);
function stepSize(dir) {
  const sel = $('#sel-size'), i = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + dir));
  sel.selectedIndex = i; setSize(sel.value);
}
$('#col-text').oninput = (e) => exec('foreColor', e.target.value);
$('#col-hl').oninput = (e) => exec('hiliteColor', e.target.value);

// ---- word count --------------------------------------------------------
// innerText forces a layout pass, so keep it off the keystroke path.
let countTimer;
function countWords() {
  clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    const t = ed.innerText.trim();
    $('#count').textContent = (t ? t.split(/\s+/).length : 0) + ' words';
  }, 300);
}
ed.addEventListener('input', countWords);

// ---- modal helper ------------------------------------------------------
function modal(title, html, onOk, okLabel = 'Insert') {
  const bg = $('#modal-bg'), m = $('#modal');
  m.innerHTML = `<h3>${title}</h3>${html}<div class="actions"><button id="m-cancel">Cancel</button><button class="ok" id="m-ok">${okLabel}</button></div>`;
  bg.hidden = false;
  const close = () => { bg.hidden = true; m.innerHTML = ''; };
  $('#m-cancel').onclick = close;
  $('#m-ok').onclick = () => { onOk(m); close(); };
}

// Click outside the dialog (on the dimmed backdrop) closes it like Cancel.
$('#modal-bg').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) { const c = $('#m-cancel'); if (c) c.click(); } });

// ---- tables ------------------------------------------------------------
$('#ins-table').onclick = () => modal('Insert table',
  `<div class="row"><div><label>Rows</label><input id="m-r" type="number" min="1" max="50" value="3"></div>
   <div><label>Columns</label><input id="m-c" type="number" min="1" max="20" value="3"></div></div>
   <label><input type="checkbox" id="m-h" checked style="width:auto"> Header row</label>`,
  (m) => {
    const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v) || lo));
    const r = clampN(m.querySelector('#m-r').value, 1, 50), c = clampN(m.querySelector('#m-c').value, 1, 20), h = m.querySelector('#m-h').checked;
    let html = '<table>';
    for (let i = 0; i < r; i++) {
      html += '<tr>' + Array.from({ length: c }, () => (h && i === 0 ? '<th><br></th>' : '<td><br></td>')).join('') + '</tr>';
    }
    exec('insertHTML', html + '</table><p><br></p>');
  });

const curCell = () => { const n = saved?.startContainer; const el = n?.nodeType === 3 ? n.parentElement : n; return el?.closest?.('td,th'); };
function updateTableTools() { $('#table-tools').hidden = !curCell(); }
// Table edits work on a detached copy and swap it in with insertHTML, so the browser's own Ctrl+Z undoes them.
const hdrRow = (tr) => tr.cells[0]?.tagName === 'TH';
const retag = (x, tag) => { const k = document.createElement(tag); k.innerHTML = x.innerHTML || '<br>'; if (x.getAttribute('style')) k.setAttribute('style', x.getAttribute('style')); x.replaceWith(k); return k; };
const TOPS = {
  row: (after) => (c) => {
    const tr = c.parentElement, first = tr.rowIndex === 0, hdr = !after && first && hdrRow(tr); // a row added above the header becomes the header
    const n = tr.cloneNode(true);
    [...n.cells].forEach((x) => { const k = retag(x, hdr ? 'th' : 'td'); k.innerHTML = '<br>'; });
    if (hdr) [...tr.cells].forEach((x) => retag(x, 'td'));
    if (first && !after) [...tr.cells].forEach((x) => { x.removeAttribute('style'); }); // column widths live on the first row
    after ? tr.after(n) : tr.before(n);
  },
  col: (after) => (c, t) => {
    const i = c.cellIndex;
    [...t.rows].forEach((tr) => {
      const n = document.createElement(tr.rowIndex === 0 && hdrRow(tr) ? 'th' : 'td'); n.innerHTML = '<br>';
      const ref = tr.cells[i]; if (!ref) tr.appendChild(n); else after ? ref.after(n) : ref.before(n);
    });
    MTRX.normCols?.(t);
  },
  delRow: (c, t) => { c.parentElement.remove(); return t.rows.length > 0; },
  delCol: (c, t) => { const i = c.cellIndex; [...t.rows].forEach((tr) => tr.cells[i]?.remove()); if (!t.rows[0]?.cells.length) return false; MTRX.normCols?.(t); },
  delTable: () => false,
};
function tableOp(cell, fn) {
  const t = cell.closest('table'), ri = cell.parentElement.rowIndex, ci = cell.cellIndex;
  MTRX.editTable(t, (cl) => fn(cl.rows[ri].cells[ci], cl));
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}
const onCell = (fn) => () => { const c = curCell(); if (c) tableOp(c, fn); };
$('#t-addrow').onclick = onCell(TOPS.row(true));
$('#t-delrow').onclick = onCell(TOPS.delRow);
$('#t-addcol').onclick = onCell(TOPS.col(true));
$('#t-delcol').onclick = onCell(TOPS.delCol);
$('#t-deltable').onclick = onCell(TOPS.delTable);

// ---- images ------------------------------------------------------------
// Put an <img> at the cursor. If the saved cursor is gone or stale (the file picker steals focus), add it at the end instead,
// so an insert never silently does nothing.
function insertImg(url, width, extra = '') {
  const n = ed.querySelectorAll('img').length;
  exec('insertHTML', `<img src="${url}" width="${width}" ${extra}>`);
  if (ed.querySelectorAll('img').length === n) {
    ed.insertAdjacentHTML('beforeend', `<p><img src="${url}" width="${width}" ${extra}></p>`);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
function insertCanvasImage(canvas, extra = '') {
  insertImg(canvas.toDataURL('image/png'), Math.min(canvas.width, 560), extra);
}
$('#ins-image').onclick = () => $('#file-img').click();
$('#file-img').onchange = (e) => {
  const inp = e.target, f = inp.files && inp.files[0]; if (!f) return;
  const fail = (why) => { msg('Could not add that picture: ' + why); inp.value = ''; };
  const r = new FileReader();
  r.onerror = () => fail('the file could not be read');
  r.onload = () => {
    const img = new Image();
    img.onerror = () => fail('this picture type is not supported (try PNG or JPG)');
    img.onload = () => {
      try {
        // big photos are scaled down (and saved as JPEG) so the document stays small and fast
        const MAX = 1600, k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        const x = c.getContext('2d'); const photo = /jpe?g/i.test(f.type);
        if (photo) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
        x.drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL(photo ? 'image/jpeg' : 'image/png', 0.9);
        if (!url || url.length < 32) return fail('the picture is too large to open');
        insertImg(url, Math.min(c.width, 560));
        msg('Picture added'); inp.value = '';
      } catch (err) { fail(err && err.message ? err.message : 'unknown error'); }
    };
    img.src = r.result;
  };
  r.readAsDataURL(f);
};
ed.addEventListener('click', (e) => {
  ed.querySelectorAll('img.sel').forEach((i) => i.classList.remove('sel'));
  if (e.target.tagName === 'IMG') e.target.classList.add('sel');
});

// ---- charts ------------------------------------------------------------
const PALETTE = ['#32000c', '#800020', '#c27a8a', '#e0a96d', '#6fae9a', '#d46a7e', '#8fa3d6', '#d4b84a'];
function drawChart(type, title, data) {
  const W = 720, H = 420, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#32000c'; g.font = 'bold 20px Calibri, sans-serif'; g.textAlign = 'center';
  g.fillText(title, W / 2, 30);
  const max = Math.max(...data.map((d) => d.v), 1);
  const L = 60, R = W - 30, T = 55, B = H - 50;
  g.font = '13px Calibri, sans-serif';
  if (type === 'pie') {
    const total = data.reduce((a, d) => a + Math.max(d.v, 0), 0) || 1;
    let a0 = -Math.PI / 2; const cx = 260, cy = 235, r = 150;
    data.forEach((d, i) => {
      const a1 = a0 + (Math.max(d.v, 0) / total) * Math.PI * 2;
      g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, a0, a1); g.closePath();
      g.fillStyle = PALETTE[i % PALETTE.length]; g.fill(); a0 = a1;
      g.fillRect(500, 110 + i * 26, 14, 14); g.fillStyle = '#222'; g.textAlign = 'left';
      g.fillText(`${d.l} (${Math.round((d.v / total) * 100)}%)`, 522, 122 + i * 26);
    });
  } else {
    g.strokeStyle = '#ccc'; g.fillStyle = '#555'; g.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const y = B - ((B - T) * i) / 5;
      g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke();
      g.fillText(+(max * i / 5).toFixed(2), L - 6, y + 4);
    }
    const step = (R - L) / data.length;
    g.textAlign = 'center';
    if (type === 'bar') {
      data.forEach((d, i) => {
        const h = ((B - T) * d.v) / max;
        g.fillStyle = PALETTE[i % PALETTE.length]; g.fillRect(L + i * step + step * 0.15, B - h, step * 0.7, h);
        g.fillStyle = '#222'; g.fillText(d.l, L + i * step + step / 2, B + 18);
      });
    } else {
      g.strokeStyle = PALETTE[0]; g.lineWidth = 3; g.beginPath();
      const pts = data.map((d, i) => [L + i * step + step / 2, B - ((B - T) * d.v) / max]);
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      pts.forEach(([x, y], i) => {
        g.fillStyle = PALETTE[0]; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
        g.fillStyle = '#222'; g.fillText(data[i].l, x, B + 18);
      });
    }
  }
  return c;
}
$('#ins-chart').onclick = () => modal('Insert chart',
  `<label>Type</label><select id="m-type"><option value="bar">Bar</option><option value="line">Line</option><option value="pie">Pie</option></select>
   <label>Title</label><input id="m-title" value="Quarterly results">
   <label>Data (one "label, value" per line)</label>
   <textarea id="m-data">Q1, 120\nQ2, 180\nQ3, 150\nQ4, 220</textarea>`,
  (m) => {
    const data = m.querySelector('#m-data').value.split('\n').map((l) => { const k = l.lastIndexOf(','); return k < 0 ? null : [l.slice(0, k), l.slice(k + 1)]; }).filter(Boolean)
      .map((p) => ({ l: p[0].trim(), v: parseFloat(p[1]) || 0 }));
    if (!data.length) return msg('Chart needs data');
    insertCanvasImage(drawChart(m.querySelector('#m-type').value, m.querySelector('#m-title').value, data));
  });

// ---- shapes ------------------------------------------------------------
$('#ins-shape').onclick = () => modal('Insert shape',
  `<label>Shape</label><select id="m-shape"><option>Rectangle</option><option>Rounded rectangle</option><option>Ellipse</option><option>Triangle</option><option>Arrow</option><option>Line</option></select>
   <div class="row"><div><label>Fill</label><input id="m-fill" type="color" value="#32000c"></div>
   <div><label>Size (px)</label><input id="m-size" type="number" value="160" min="20" max="560"></div></div>`,
  (m) => {
    const s = Math.max(20, Math.min(560, +m.querySelector('#m-size').value || 160)), kind = m.querySelector('#m-shape').value, fill = m.querySelector('#m-fill').value;
    const w = kind === 'Line' ? s * 2 : s, h = kind === 'Line' ? 12 : kind === 'Arrow' ? s * 0.6 : s * 0.7;
    const c = document.createElement('canvas'); c.width = w + 8; c.height = h + 8;
    const g = c.getContext('2d'); g.translate(4, 4); g.fillStyle = fill; g.strokeStyle = '#32000c'; g.lineWidth = 3;
    g.beginPath();
    if (kind === 'Rectangle') g.rect(0, 0, w, h);
    else if (kind === 'Rounded rectangle') g.roundRect(0, 0, w, h, 18);
    else if (kind === 'Ellipse') g.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, 7);
    else if (kind === 'Triangle') { g.moveTo(w / 2, 0); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); }
    else if (kind === 'Arrow') { g.moveTo(0, h * 0.3); g.lineTo(w * 0.6, h * 0.3); g.lineTo(w * 0.6, 0); g.lineTo(w, h / 2); g.lineTo(w * 0.6, h); g.lineTo(w * 0.6, h * 0.7); g.lineTo(0, h * 0.7); g.closePath(); }
    else { g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); insertCanvasImage(c); return; }
    g.fill(); g.stroke(); insertCanvasImage(c);
  });

// ---- DOM -> document model --------------------------------------------
const hex = (rgb) => { const m = rgb.match(/\d+/g); return m && m.length >= 3 ? m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('').toUpperCase() : null; };
const BLOCK_TAGS = /^(P|DIV|LI|H[1-6]|TR|BLOCKQUOTE|PRE)$/;
const LIST_TAGS = /^(UL|OL)$/;

// Background colour of the nearest highlighted ancestor, stopping at table cells (cell shading is not a highlight).
function highlightOf(el) {
  for (; el && el !== ed && !/^(TD|TH|TABLE)$/.test(el.tagName); el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg.match(/[\d.]+/g);
    if (m && m.length >= 3 && (m.length < 4 || +m[3] > 0)) return hex(bg);
  }
  return null;
}

// Computed styles are expensive; many text nodes share a parent, so cache per element for one export.
let styleCache = new WeakMap();
function runFor(text, parent) {
  let base = styleCache.get(parent);
  if (!base) {
    const cs = getComputedStyle(parent);
    const col = hex(cs.color);
    base = {
      bold: +cs.fontWeight >= 600, italic: cs.fontStyle === 'italic',
      underline: cs.textDecorationLine.includes('underline'), strike: cs.textDecorationLine.includes('line-through'),
      color: col && col !== '000000' ? col : null,
      highlight: highlightOf(parent),
      size: Math.round(parseFloat(cs.fontSize) * 0.75),
      font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
    };
    styleCache.set(parent, base);
  }
  return { text, ...base };
}

// Flatten nodes into an ordered list of items: text runs ('\n' = line break), images and tables.
function walk(nodes, items, { skipLists = false } = {}) {
  const needBreak = () => { const l = items[items.length - 1]; if (l?.run && !l.run.text.endsWith('\n')) items.push({ run: { text: '\n' } }); };
  nodes.forEach((n) => {
    if (n.nodeType === 3) {
      if (n.nodeValue) items.push({ run: runFor(n.nodeValue.replace(/ /g, ' '), n.parentElement) });
    } else if (n.nodeType === 1) {
      const tag = n.tagName;
      if (tag === 'BR') items.push({ run: runFor('\n', n.parentElement) });
      else if (tag === 'IMG') items.push({ image: n });
      else if (tag === 'SUP' && n.classList.contains('fn')) items.push({ run: { text: '', footnote: n.dataset.note || '' } });
      else if (tag === 'TABLE') items.push({ table: n });
      else if (skipLists && LIST_TAGS.test(tag)) return;
      else { if (BLOCK_TAGS.test(tag)) needBreak(); walk(n.childNodes, items, { skipLists }); }
    }
  });
  return items;
}

const alignOf = (el) => { const a = getComputedStyle(el).textAlign; return ['center', 'right', 'justify'].includes(a) ? a : 'left'; };

function imageBlock(img, align) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null; // broken / not yet loaded image
  const shownW = Math.round(img.width || w), shownH = Math.round(img.height || h);
  // Never ship more pixels than needed: 2x the displayed size is plenty for print.
  const scale = Math.min(1, (shownW * 2) / w);
  const png = /^data:image\/png;base64,/.test(img.src);
  let data;
  if (png && scale === 1) data = img.src.split(',')[1]; // already a PNG at a sensible size: skip re-encoding
  else {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    data = c.toDataURL('image/png').split(',')[1];
  }
  const wrap = ['left', 'right', 'behind', 'front'].includes(img.dataset.wrap) ? img.dataset.wrap : 'inline';
  const out = { type: 'image', data, width: shownW, height: shownH, align, wrap };
  if (wrap === 'behind' || wrap === 'front') { // page-relative, on the page the picture sits on
    const ph = parseFloat(sheet.style.getPropertyValue('--ph')) || 1056, pitch = ph + GAP, y = parseFloat(img.dataset.y) || 0;
    out.x = Math.round(parseFloat(img.dataset.x) || 0); out.y = Math.round(y - Math.floor(y / pitch) * pitch);
  }
  return out;
}

// Turn a list of nodes into paragraph / image / table blocks.
function paragraphBlocks(nodes, alignEl, blocks, extra = {}) {
  const align = alignOf(alignEl);
  let runs = [];
  let sawObject = false;
  const flush = () => {
    while (runs.length && runs[runs.length - 1].text === '\n') runs.pop(); // trailing line breaks / placeholder <br>
    blocks.push({ type: 'paragraph', align, runs, ...extra });
    runs = [];
  };
  walk(nodes, [], { skipLists: true }).forEach((it) => {
    if (it.run) runs.push(it.run);
    else {
      sawObject = true;
      if (runs.length) flush();
      if (it.image) { const b = imageBlock(it.image, align); if (b) blocks.push(b); }
      else tableBlock(it.table, blocks);
    }
  });
  // keep empty paragraphs (blank lines) but not the empty remainder after an image/table
  if (runs.length || !sawObject) flush();
}

function tableBlock(t, blocks) {
  const rows = [...t.rows].map((tr) => [...tr.cells].map((c) => {
    const runs = walk(c.childNodes, []).filter((i) => i.run).map((i) => i.run);
    while (runs.length && runs[runs.length - 1].text === '\n') runs.pop();
    return runs;
  }));
  // Column widths (parts per thousand) only when the user/file set uneven widths; otherwise columns are equal.
  let col_widths = [];
  if (t.style.tableLayout === 'fixed' && t.rows[0] && t.offsetWidth) {
    const w = [...t.rows[0].cells].map((c) => c.offsetWidth);
    const sum = w.reduce((a, b) => a + b, 0);
    if (sum) col_widths = w.map((x) => Math.max(1, Math.round((x / sum) * 1000)));
  }
  blocks.push({ type: 'table', rows, header: t.rows[0]?.cells[0]?.tagName === 'TH', col_widths });
}

function listBlocks(list, blocks, level = 0) {
  const kind = list.tagName === 'UL' ? 'bullet' : 'number';
  let i = 0;
  [...list.children].forEach((li) => {
    if (li.tagName !== 'LI') return;
    paragraphBlocks(li.childNodes, li, blocks, { list: kind, list_index: ++i, list_level: level });
    [...li.children].filter((c) => LIST_TAGS.test(c.tagName)).forEach((sub) => listBlocks(sub, blocks, level + 1));
  });
}

function buildModel() {
  styleCache = new WeakMap();
  const blocks = [];
  let inline = []; // consecutive loose inline nodes at the editor root form one paragraph
  const flushInline = () => { if (inline.length) { paragraphBlocks(inline, ed, blocks); inline = []; } };
  ed.childNodes.forEach((n) => {
    const tag = n.nodeType === 1 ? n.tagName : '';
    const isBlock = tag && (BLOCK_TAGS.test(tag) || LIST_TAGS.test(tag) || tag === 'TABLE');
    if (!isBlock) { if (n.nodeType === 3 ? n.nodeValue.trim() || inline.length : true) inline.push(n); return; }
    flushInline();
    if (tag === 'DIV' && n.classList.contains('pb')) blocks.push({ type: 'pagebreak' });
    else if (tag === 'TABLE') tableBlock(n, blocks);
    else if (LIST_TAGS.test(tag)) listBlocks(n, blocks);
    else if (/^H[1-3]$/.test(tag)) paragraphBlocks(n.childNodes, n, blocks, { heading: +tag[1] });
    else paragraphBlocks(n.childNodes, n, blocks);
  });
  flushInline();
  return { title: $('#title').value.trim() || 'Document', blocks, page: { ...page }, header: hdr, footer: ftr, page_numbers: pageNums };
}

// ---- untrusted HTML (opened .mtrx files) -------------------------------
const ALLOWED_TAGS = new Set('P DIV SPAN BR B STRONG I EM U S STRIKE FONT SUP H1 H2 H3 UL OL LI TABLE TBODY THEAD TR TD TH IMG'.split(' '));
const ALLOWED_ATTRS = new Set(['style', 'src', 'width', 'height', 'data-wrap', 'data-x', 'data-y', 'colspan', 'rowspan', 'size', 'color', 'face', 'class', 'data-note']);
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html'); // inert: scripts/handlers do not run
  const clean = (node) => {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === 8) return n.remove();
      if (n.nodeType !== 1) return;
      if (!ALLOWED_TAGS.has(n.tagName)) {
        if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|SVG|MATH|FORM)$/.test(n.tagName)) return n.remove();
        clean(n); n.replaceWith(...n.childNodes); return; // unknown wrapper: keep its text
      }
      [...n.attributes].forEach((a) => {
        const v = a.value.toLowerCase();
        const bad = !ALLOWED_ATTRS.has(a.name) || (a.name === 'src' && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(v))
          || (a.name === 'style' && /url\(|expression|javascript:|@import/.test(v))
          || (a.name === 'data-note' && n.tagName !== 'SUP')
          || (a.name === 'class' && !((n.tagName === 'SUP' && a.value === 'fn') || (n.tagName === 'DIV' && a.value === 'pb')));
        if (bad) n.removeAttribute(a.name);
      });
      if (n.tagName === 'TABLE') { n.removeAttribute('width'); n.style.removeProperty('width'); }
      if (n.tagName === 'TD' || n.tagName === 'TH') { n.removeAttribute('width'); n.removeAttribute('height'); n.style.removeProperty('height'); if (!/%$/.test(n.style.width)) n.style.removeProperty('width'); }
      if ((n.tagName === 'TABLE' || n.tagName === 'TD' || n.tagName === 'TH') && !n.getAttribute('style')) n.removeAttribute('style');
      if (n.tagName === 'DIV' && n.className === 'pb') n.setAttribute('contenteditable', 'false');
      clean(n);
    });
  };
  clean(doc.body);
  return doc.body.innerHTML || '<p><br></p>';
}

ed.addEventListener('paste', (e) => {
  const h = e.clipboardData.getData('text/html');
  if (!h) return; // plain text: browser default is safe
  e.preventDefault();
  exec('insertHTML', sanitizeHtml(h));
});

// ---- file actions ------------------------------------------------------
$('#btn-export').onclick = async () => {
  if (!invoke) return msg('Run inside the desktop app to export');
  try { const p = await invoke('export_docx', { doc: buildModel() }); if (p) { msg('Saved: ' + p); MTRX.clearDraft(); } }
  catch (e) { msg('Export failed: ' + e); }
};
// ---- page setup, header / footer ---------------------------------------
const PAPERS = { Letter: [12240, 15840], A4: [11906, 16838], Legal: [12240, 20160], A5: [8391, 11906] };
const defaultPage = () => ({ width: 12240, height: 15840, landscape: false, top: 1440, bottom: 1440, left: 1440, right: 1440 });
var page = defaultPage(), hdr = '', ftr = '', pageNums = false; // `var`: buildModel (above) reads these
const sheet = $('#sheet');
const tw = (t) => t / 15 + 'px'; // 1440 twips per inch = 96 css px per inch
// Pagination: pages are drawn as separate sheets with a gap; any block that would cross a page
// bottom is pushed (extra top margin) onto the next page. Header/footer/number repeat per page.
const GAP = 24;
// A table taller than a page breaks between rows: a row that would cross the page bottom gets extra top padding.
function splitTable(tb, pitch, ph, mt, mb, room) {
  for (const tr of [...tb.rows]) {
    const top = tb.offsetTop + tr.offsetTop, hh = tr.offsetHeight, k = Math.floor(top / pitch);
    if (hh > room || top + hh <= k * pitch + ph - mb) continue;
    const gap = (k + 1) * pitch + mt - top;
    for (const c of tr.cells) { c.dataset.pgp = c.style.paddingTop; c.style.paddingTop = (parseFloat(getComputedStyle(c).paddingTop) || 0) + gap + 'px'; }
  }
}
function clearCellPad(root) {
  root.querySelectorAll('[data-pgp]').forEach((c) => { c.style.paddingTop = c.dataset.pgp; c.removeAttribute('data-pgp'); if (!c.getAttribute('style')) c.removeAttribute('style'); });
}
MTRX.clearCellPad = clearCellPad;
function unpaginate() {
  clearCellPad(ed);
  ed.querySelectorAll(':scope > [data-pg]').forEach((b) => { b.style.marginTop = ''; delete b.dataset.pg; });
}
let paginating = false;
function markPages() {
  if (paginating) return;
  MTRX.fixImgs?.();
  paginating = true;
  try {
    const cs = (v) => parseFloat(sheet.style.getPropertyValue(v)) || 0;
    const ph = cs('--ph') || 1056, mt = cs('--mt'), mb = cs('--mb');
    const pitch = ph + GAP, room = ph - mt - mb;
    unpaginate();
    for (const b of ed.children) {
      const top = b.offsetTop, h = b.offsetHeight;
      const after = b.previousElementSibling;
      if (after?.classList.contains('pb')) { // a page break: this block starts the next page
        const next = (Math.floor(after.offsetTop / pitch) + 1) * pitch;
        if (top < next) { b.dataset.pg = '1'; b.style.marginTop = next + mt - after.offsetTop - after.offsetHeight + 'px'; continue; }
      } // offsetParent is the sheet, so already includes the top margin
      if (b.tagName === 'TABLE' && h > room) { splitTable(b, pitch, ph, mt, mb, room); continue; }
      if (h <= 0 || h > room) continue;
      const k = Math.floor(top / pitch);
      if (top + h > k * pitch + ph - mb) {
        // Sibling margins collapse, so set the gap from the previous block's bottom edge to the next page's top margin.
        const prev = b.previousElementSibling;
        const from = prev ? prev.offsetTop + prev.offsetHeight : mt;
        b.dataset.pg = '1';
        b.style.marginTop = (k + 1) * pitch + mt - from + 'px';
      }
    }
    const fl = $('#fn-list');
    const end = mt + ed.offsetHeight + (fl.hidden ? 0 : fl.offsetHeight) + mb;
    const pages = Math.max(1, Math.ceil((end - 1) / pitch));
    sheet.style.minHeight = pages * pitch - GAP + 'px';
    sheet.querySelectorAll('.pgbox').forEach((n) => n.remove());
    for (let i = 0; i < pages; i++) {
      const box = document.createElement('div');
      box.className = 'pgbox'; box.style.top = i * pitch + 'px'; box.style.height = ph + 'px';
      const mk = (cls, txt) => { const d = document.createElement('div'); d.className = 'hf ' + cls; d.textContent = txt; box.appendChild(d); };
      mk('hdr', hdr);
      mk('ftr', [ftr, pageNums ? String(i + 1) : ''].filter(Boolean).join('\n'));
      sheet.appendChild(box);
    }
    MTRX.pageCount = pages;
    const c = $('#count'); if (c && !c.dataset.pg) c.dataset.pg = '1';
  } finally { paginating = false; }
}
let pgTimer;
const markPagesSoon = () => { clearTimeout(pgTimer); pgTimer = setTimeout(markPages, 60); };
function applyPage() {
  const [w, h] = page.landscape ? [page.height, page.width] : [page.width, page.height];
  const st = sheet.style;
  st.setProperty('--pw', tw(w)); st.setProperty('--ph', tw(h));
  st.setProperty('--mt', tw(page.top)); st.setProperty('--mb', tw(page.bottom));
  st.setProperty('--ml', tw(page.left)); st.setProperty('--mr', tw(page.right));
  markPages();
}
const escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const clampTw = (inches) => Math.max(0, Math.min(4320, Math.round((parseFloat(inches) || 0) * 1440)));

$('#page-setup').onclick = () => {
  const cur = Object.keys(PAPERS).find((k) => PAPERS[k][0] === page.width && PAPERS[k][1] === page.height) || 'Custom';
  const papers = (cur === 'Custom' ? [...Object.keys(PAPERS), 'Custom'] : Object.keys(PAPERS))
    .map((k) => `<option${k === cur ? ' selected' : ''}>${k}</option>`).join('');
  const inch = (t) => (t / 1440).toFixed(2);
  modal('Page setup',
    `<div class="row"><div><label>Paper</label><select id="m-paper">${papers}</select></div>
     <div><label>Orientation</label><select id="m-orient"><option${page.landscape ? '' : ' selected'}>Portrait</option><option${page.landscape ? ' selected' : ''}>Landscape</option></select></div></div>
     <div class="row"><div><label>Top (in)</label><input id="m-mt" type="number" step="0.05" min="0" max="3" value="${inch(page.top)}"></div>
     <div><label>Bottom (in)</label><input id="m-mb" type="number" step="0.05" min="0" max="3" value="${inch(page.bottom)}"></div>
     <div><label>Left (in)</label><input id="m-ml" type="number" step="0.05" min="0" max="3" value="${inch(page.left)}"></div>
     <div><label>Right (in)</label><input id="m-mr" type="number" step="0.05" min="0" max="3" value="${inch(page.right)}"></div></div>
     <label>Header (top of every page)</label><input id="m-hdr" value="${escAttr(hdr)}">
     <label>Footer (bottom of every page)</label><input id="m-ftr" value="${escAttr(ftr)}">
     <label><input type="checkbox" id="m-pn" ${pageNums ? 'checked' : ''} style="width:auto"> Page numbers</label>`,
    (m) => {
      const q = (id) => m.querySelector(id);
      const paper = q('#m-paper').value;
      if (PAPERS[paper]) [page.width, page.height] = PAPERS[paper];
      page.landscape = q('#m-orient').value === 'Landscape';
      page.top = clampTw(q('#m-mt').value); page.bottom = clampTw(q('#m-mb').value);
      page.left = clampTw(q('#m-ml').value); page.right = clampTw(q('#m-mr').value);
      { // keep at least one inch of text area in each direction
        const [pw, ph] = page.landscape ? [page.height, page.width] : [page.width, page.height];
        let cut = false;
        if (page.left + page.right > pw - 1440) { const k = (pw - 1440) / (page.left + page.right); page.left = Math.floor(page.left * k); page.right = Math.floor(page.right * k); cut = true; }
        if (page.top + page.bottom > ph - 1440) { const k = (ph - 1440) / (page.top + page.bottom); page.top = Math.floor(page.top * k); page.bottom = Math.floor(page.bottom * k); cut = true; }
        if (cut) msg('Margins reduced to leave room for text');
      }
      hdr = q('#m-hdr').value.slice(0, 200); ftr = q('#m-ftr').value.slice(0, 200); pageNums = q('#m-pn').checked;
      applyPage();
      saveDraftSoon();
    }, 'Apply');
};

// ---- footnotes ---------------------------------------------------------
function renderFootnotesNow() {
  const notes = [...ed.querySelectorAll('sup.fn')], ol = $('#fn-list');
  ol.hidden = !notes.length;
  ol.replaceChildren(...notes.map((n) => { const li = document.createElement('li'); li.textContent = n.dataset.note || ''; return li; }));
}
let fnTimer;
function renderFootnotes() { clearTimeout(fnTimer); fnTimer = setTimeout(renderFootnotesNow, 200); }
ed.addEventListener('input', renderFootnotes);
// The page break is invisible (like Word), so Backspace at the start of the next paragraph (or Delete at the end of the previous one) removes it.
ed.addEventListener('keydown', (e) => {
  if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.ctrlKey || e.metaKey || e.altKey) return;
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  let blk = sel.anchorNode;
  while (blk && blk.parentNode !== ed) blk = blk.parentNode;
  if (!blk) return;
  const back = e.key === 'Backspace';
  const pb = back ? blk.previousElementSibling : blk.nextElementSibling;
  if (!pb?.classList.contains('pb')) return;
  const edge = document.createRange();
  edge.selectNodeContents(blk);
  back ? edge.setEnd(sel.anchorNode, sel.anchorOffset) : edge.setStart(sel.anchorNode, sel.anchorOffset);
  if (edge.toString() !== '') return; // caret is not at the very start / end of the block
  e.preventDefault();
  pb.remove();
  markPages();
});
$('#ins-break').onclick = () => {
  // Split the paragraph at the caret, then put the break between the two halves.
  ed.focus();
  const s0 = getSelection();
  let b0 = s0.rangeCount ? s0.anchorNode : null;
  while (b0 && b0.parentNode !== ed) b0 = b0.parentNode;
  if (b0 && b0.nodeType === 1 && /^(TABLE|UL|OL)$/.test(b0.tagName)) { // a table / list cannot be split: break right after it
    const r0 = document.createRange(); r0.setStart(ed, [...ed.childNodes].indexOf(b0) + 1); r0.collapse(true);
    s0.removeAllRanges(); s0.addRange(r0);
    const nx = b0.nextElementSibling;
    document.execCommand('insertHTML', false, '<div class="pb" contenteditable="false"></div>' + (nx && nx.tagName === 'P' ? '' : '<p><br></p>'));
    markPages();
    return;
  }
  document.execCommand('insertParagraph');
  let blk = getSelection().anchorNode;
  while (blk && blk.parentNode !== ed) blk = blk.parentNode;
  if (blk) {
    // insertHTML (not DOM calls) so the browser records it in the same undo step as the split.
    const r = document.createRange(); r.setStart(ed, [...ed.childNodes].indexOf(blk)); r.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertHTML', false, '<div class="pb" contenteditable="false"></div>');
  }
  markPages();
};
$('#ins-footnote').onclick = () => modal('Insert footnote',
  '<label>Footnote text</label><textarea id="m-fn"></textarea>',
  (m) => {
    const t = m.querySelector('#m-fn').value.trim();
    if (!t) return;
    exec('insertHTML', `<sup class="fn" data-note="${escAttr(t)}"></sup>`);
    renderFootnotes();
  });
ed.addEventListener('click', (e) => {
  const sup = e.target.closest?.('sup.fn');
  if (!sup) return;
  modal('Edit footnote', '<label>Footnote text (leave empty to delete it)</label><textarea id="m-fn"></textarea>',
    (m) => {
      const t = m.querySelector('#m-fn').value.trim();
      if (t) sup.dataset.note = t; else sup.remove();
      renderFootnotes();
    }, 'Save');
  $('#m-fn').value = sup.dataset.note || '';
});

// ---- PDF export (printed by the WebView2 engine, so it matches the page you see) ----
function printStyle() {
  const q = (t) => '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
  const foot = [ftr ? q(ftr) : '', ftr && pageNums ? '"\\A "' : '', pageNums ? 'counter(page)' : ''].filter(Boolean).join(' ');
  const box = 'font:10pt Calibri,sans-serif;color:#555;white-space:pre-line;';
  const el = document.createElement('style');
  el.textContent = `@page{${hdr ? `@top-center{content:${q(hdr)};${box}}` : ''}${foot ? `@bottom-center{content:${foot};${box}}` : ''}}`;
  document.head.appendChild(el);
  return el;
}
const inchesOf = (t) => t / 1440;
async function exportPdf() {
  if (!invoke) return msg('Run inside the desktop app to export');
  renderFootnotesNow();
  const [w, h] = page.landscape ? [page.height, page.width] : [page.width, page.height];
  const el = printStyle();
  unpaginate();
  try {
    const p = await invoke('export_pdf', {
      name: $('#title').value || 'Document',
      page: { width: inchesOf(w), height: inchesOf(h), top: inchesOf(page.top), bottom: inchesOf(page.bottom), left: inchesOf(page.left), right: inchesOf(page.right) },
    });
    if (p) msg('PDF saved: ' + p);
  } catch (e) { msg('PDF export failed: ' + e); }
  finally { el.remove(); markPages(); }
}
$('#btn-pdf').onclick = exportPdf;

// ---- opening files -----------------------------------------------------
function showWriter() { document.body.classList.remove('home', 'pdf'); MTRX.fitWriter?.(); }
function loadLaunch(r, keepDraft = false) {
  if (!r) return;
  if (!keepDraft && r.kind !== 'pdf') MTRX.clearDraft?.(); // the file now on screen is the saved version
  if (r.kind === 'pdf') return MTRX.openPdf(r.name, r.data);
  showWriter();
  $('#title').value = r.title; ed.innerHTML = sanitizeHtml(r.html);
  page = { ...defaultPage(), ...r.page }; hdr = r.header || ''; ftr = r.footer || ''; pageNums = !!r.pageNumbers;
  applyPage(); renderFootnotesNow(); countWords();
}
MTRX.openInWriter = (title, html) => loadLaunch({ kind: 'doc', title, html, page: defaultPage(), header: '', footer: '', pageNumbers: false });
// Launched with a file (double-click or "Open with")? Open it straight away.

// ---- draft recovery ----------------------------------------------------
// Handled by the shared session module (session.js), the same for every app: a hidden copy is kept while you work,
// cleared when you save, offered back on the Home screen after a crash or an accidental close.
function draftHtml() {
  const c = ed.cloneNode(true); // drop the visual page-break spacing, it is recomputed on load
  clearCellPad(c);
  c.querySelectorAll('[data-pg]').forEach((b) => { b.style.marginTop = ''; b.removeAttribute('data-pg'); if (!b.getAttribute('style')) b.removeAttribute('style'); });
  return c.innerHTML;
}
let wDirty = false;
const saveDraftSoon = () => { wDirty = true; MTRX.session.changed('writer'); };
MTRX.session.register('writer', {
  label: 'document',
  msg,
  isDirty: () => wDirty,
  snapshot: () => {
    const blank = !ed.textContent.trim() && !ed.querySelector('img,table,.pb');
    return blank ? null : { title: $('#title').value, html: draftHtml(), page, header: hdr, footer: ftr, pageNumbers: pageNums };
  },
  restore: (d) => { loadLaunch({ kind: 'doc', title: d.title, html: d.html, page: d.page, header: d.header, footer: d.footer, pageNumbers: d.pageNumbers }, true); wDirty = true; },
  title: (d) => d.title,
});
ed.addEventListener('input', saveDraftSoon);
$('#title').addEventListener('input', saveDraftSoon);
MTRX.clearDraft = () => { wDirty = false; MTRX.session.saved('writer'); };

// Recovery chips wait until every app's script has loaded and registered itself.
function offerWhenReady() { if (document.readyState === 'complete') MTRX.session.offer(); else addEventListener('load', () => MTRX.session.offer()); }
// Launched with a file (double-click)? Open it. Otherwise offer the draft, if there is one.
(invoke ? invoke('startup_file') : Promise.resolve(null))
  .then((r) => { if (r) loadLaunch(r); else offerWhenReady(); })
  .catch(offerWhenReady);
// A second launch with a file hands it to this window.
tauri?.event?.listen('open-launch', (e) => {
  if (!MTRX.session.confirmLose(e.payload?.kind === 'pdf' ? 'pdf' : 'writer')) return; // only the app the file opens in can lose work
  loadLaunch(e.payload);
});
tauri?.event?.listen('open-error', (e) => msg('Open failed: ' + e.payload));
$('#btn-open').onclick = async () => {
  if (!invoke) return;
  if (!MTRX.session.confirmLose('writer')) return;
  try { loadLaunch(await invoke('open_project')); }
  catch (e) { msg('Open failed: ' + e); }
};
applyPage();
new ResizeObserver(markPagesSoon).observe(ed);
ed.addEventListener('input', markPagesSoon);
window.addEventListener('load', markPagesSoon);
// ---- keyboard shortcuts ------------------------------------------------
// [combo, description, action, group, button selector to label with a tooltip]
// 'app' shortcuts work everywhere; 'text' ones only while editing (not in the title box or dialogs).
const SHORTCUTS = [
  ['Ctrl+S', 'Save as Word (.docx)', () => $('#btn-export').click(), 'app', '#btn-export'],
  ['Ctrl+O', 'Open document', () => $('#btn-open').click(), 'app', '#btn-open'],
  ['Ctrl+Shift+P', 'Export PDF', () => $('#btn-pdf').click(), 'app', '#btn-pdf'],
  ['F1', 'Show shortcuts', () => showShortcuts(), 'app', '#btn-help'],
  ['Ctrl+B', 'Bold', () => exec('bold'), 'text', '[data-cmd="bold"]'],
  ['Ctrl+I', 'Italic', () => exec('italic'), 'text', '[data-cmd="italic"]'],
  ['Ctrl+U', 'Underline', () => exec('underline'), 'text', '[data-cmd="underline"]'],
  ['Ctrl+Shift+X', 'Strikethrough', () => exec('strikeThrough'), 'text', '[data-cmd="strikeThrough"]'],
  ['Ctrl+Z', 'Undo', () => exec('undo'), 'text', '[data-cmd="undo"]'],
  ['Ctrl+Y', 'Redo', () => exec('redo'), 'text', '[data-cmd="redo"]'],
  ['Ctrl+Shift+Z', 'Redo', () => exec('redo'), 'text'],
  ['Ctrl+L', 'Align left', () => exec('justifyLeft'), 'text', '[data-cmd="justifyLeft"]'],
  ['Ctrl+E', 'Center', () => exec('justifyCenter'), 'text', '[data-cmd="justifyCenter"]'],
  ['Ctrl+R', 'Align right', () => exec('justifyRight'), 'text', '[data-cmd="justifyRight"]'],
  ['Ctrl+J', 'Justify', () => exec('justifyFull'), 'text', '[data-cmd="justifyFull"]'],
  ['Ctrl+Shift+8', 'Bullet list', () => exec('insertUnorderedList'), 'text', '[data-cmd="insertUnorderedList"]'],
  ['Ctrl+Shift+7', 'Numbered list', () => exec('insertOrderedList'), 'text', '[data-cmd="insertOrderedList"]'],
  ['Ctrl+Alt+0', 'Normal text', () => exec('formatBlock', 'p'), 'text'],
  ['Ctrl+Alt+1', 'Heading 1', () => exec('formatBlock', 'h1'), 'text'],
  ['Ctrl+Alt+2', 'Heading 2', () => exec('formatBlock', 'h2'), 'text'],
  ['Ctrl+Alt+3', 'Heading 3', () => exec('formatBlock', 'h3'), 'text'],
  ['Ctrl+]', 'Increase font size', () => stepSize(1), 'text', '#sel-size'],
  ['Ctrl+[', 'Decrease font size', () => stepSize(-1), 'text'],
  ['Ctrl+Alt+T', 'Insert table', () => $('#ins-table').click(), 'text', '#ins-table'],
  ['Ctrl+Alt+C', 'Insert chart', () => $('#ins-chart').click(), 'text', '#ins-chart'],
  ['Ctrl+Alt+I', 'Insert image', () => $('#ins-image').click(), 'text', '#ins-image'],
  ['Ctrl+Alt+H', 'Insert shape', () => $('#ins-shape').click(), 'text', '#ins-shape'],
  ['Ctrl+Alt+F', 'Insert footnote', () => $('#ins-footnote').click(), 'text', '#ins-footnote'],
  ['Ctrl+Enter', 'Insert page break', () => $('#ins-break').click(), 'text', '#ins-break'],
  ['Ctrl+Alt+P', 'Page setup', () => $('#page-setup').click(), 'text', '#page-setup'],
  ['Ctrl+Alt+R', 'Table: add row', () => $('#t-addrow').click(), 'text', '#t-addrow'],
  ['Ctrl+Alt+K', 'Table: add column', () => $('#t-addcol').click(), 'text', '#t-addcol'],
];

const CODES = { ']': 'BracketRight', '[': 'BracketLeft', '/': 'Slash', F1: 'F1' };
const parseCombo = (c) => {
  const parts = c.split('+'), key = parts.pop();
  return {
    ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt'),
    code: CODES[key] || (/^[A-Z]$/.test(key) ? 'Key' + key : /^\d$/.test(key) ? 'Digit' + key : key),
  };
};
const BOUND = SHORTCUTS.map((s) => ({ ...parseCombo(s[0]), run: s[2], scope: s[3] }));

document.addEventListener('keydown', (e) => {
  if (/(pdf|home|sheets)/.test(document.body.className)) return; // the PDF app / home screen handle their own keys
  if (e.key === 'Escape' && !$('#modal-bg').hidden) return $('#m-cancel').click();
  if (e.key === 'Enter' && !$('#modal-bg').hidden && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); return $('#m-ok').click(); }
  if (!$('#modal-bg').hidden) return; // dialog open: only Esc/Enter
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
  const hit = BOUND.find((b) => b.code === e.code && b.ctrl === (e.ctrlKey || e.metaKey) && b.shift === e.shiftKey && b.alt === e.altKey);
  if (!hit || (hit.scope === 'text' && typing)) return;
  e.preventDefault();
  hit.run();
});

// Show the shortcut in each button's tooltip.
SHORTCUTS.forEach(([combo, desc, , , sel]) => {
  const el = sel && $(sel);
  if (el) el.title = `${el.title || desc} (${combo})`;
});

function showShortcuts() {
  const seen = new Set();
  const rows = SHORTCUTS.filter(([c, d]) => !seen.has(d) && seen.add(d))
    .map(([c, d]) => `<tr><td>${d}</td><td><kbd>${c.replace(/\+/g, '</kbd> <kbd>')}</kbd></td></tr>`).join('');
  modal('Keyboard shortcuts', `<table class="keys">${rows}</table>`, () => {}, 'Close');
  $('#m-cancel').hidden = true;
}
$('#btn-help').onclick = showShortcuts;

// ---- auto-update (silent check on launch, one click to install) --------
async function checkUpdates() {
  const up = tauri?.updater, proc = tauri?.process;
  if (!up) return;
  try {
    const update = await up.check();
    $('#ver').textContent = 'v' + (update?.currentVersion ?? '');
    if (!update) return;
    const el = document.createElement('span');
    el.className = 'upd'; el.textContent = `Update ${update.version} available — click to install`;
    el.onclick = async () => {
      el.textContent = 'Downloading update…';
      await update.downloadAndInstall();
      await proc.relaunch();
    };
    $('#upd').replaceChildren(el); $('#upd').hidden = false;
  } catch (e) { console.warn('update check failed', e); }
}
countWords();
checkUpdates();
$('#app-writer').onclick = () => { showWriter(); ed.focus(); };
$('#app-pdf').onclick = () => MTRX.showPdf?.();
MTRX.goHome = () => { document.body.classList.remove('pdf', 'sheets'); document.body.classList.add('home'); };
$('#btn-home').onclick = MTRX.goHome;
// ribbon tabs (Home / Insert / Layout)
document.querySelectorAll('#tabs button').forEach((t) => {
  t.onclick = () => {
    const rb = $('#ribbon'); if (rb.dataset.tab === t.dataset.tab) return;
    document.querySelectorAll('#tabs button').forEach((o) => { const on = o === t; o.classList.toggle('on', on); o.setAttribute('aria-selected', String(on)); });
    const h0 = rb.offsetHeight, old = rb.dataset.tab; rb.dataset.tab = t.dataset.tab;
    // same soft motion as the home screen: the toolbar height eases to its new size while the new groups fade and rise in
    rb.style.minHeight = h0 + 'px'; const h1 = rb.scrollHeight; rb.style.minHeight = '';
    if (h1 !== h0) rb.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    rb.querySelectorAll(':scope > .group').forEach((g, i) => { if (g.offsetWidth) g.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: i * 40, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }); });
  };
});
  // Right-click menu: the shared menu system (menu.js) shows it. This hands it the Writer-specific extras
  // (picture actions, table row/column actions) as ready-made actions.
  function tableItems(cell) {
    return [
      ['Insert row above', '', () => tableOp(cell, TOPS.row(false))],
      ['Insert row below', '', () => tableOp(cell, TOPS.row(true))],
      ['Insert column left', '', () => tableOp(cell, TOPS.col(false))],
      ['Insert column right', '', () => tableOp(cell, TOPS.col(true))],
      ['Delete row', '', () => tableOp(cell, TOPS.delRow)],
      ['Delete column', '', () => tableOp(cell, TOPS.delCol)],
      ['Delete table', '', () => tableOp(cell, TOPS.delTable)],
    ];
  }
  MTRX.writerCtx = (e) => {
    const t = e.target;
    if (!(t.closest && ed.contains(t))) return null; // outside the page: no menu (and no browser menu either)
    const mk = ([label, keys, fn]) => ({ label, keys, run: () => { ed.focus(); fn(); countWords(); } });
    const cell = t.closest('td,th');
    const pic = MTRX.pickImg?.(e); // right-clicking a picture selects it and offers picture actions
    return { pic: pic ? MTRX.imgItems(pic).map(mk) : null, table: cell ? tableItems(cell).map(mk) : null };
  };
  MTRX.writerPaste = async () => {
    ed.focus();
    try { const t = await navigator.clipboard.readText(); if (t) { document.execCommand('insertText', false, t); countWords(); } }
    catch (_) { /* clipboard permission denied: use Ctrl+V */ }
  };
  // Zoom: scale the sheet with a transform (layout measurements stay in unscaled px) inside a wrapper sized to the scaled page.
  const desk = $('#desk'), zwrap = $('#zoomwrap'), sheetEl = $('#sheet');
  let zoom = 1;
  function applyZoom() {
    sheetEl.style.transform = zoom === 1 ? '' : 'scale(' + zoom + ')';
    zwrap.style.width = sheetEl.offsetWidth * zoom + 'px';
    zwrap.style.height = sheetEl.offsetHeight * zoom + 'px';
    $('#z-val').textContent = Math.round(zoom * 100) + '%';
  }
  function setZoom(z) {
    zoom = Math.min(3, Math.max(0.25, Math.round(z * 100) / 100));
    applyZoom();
  }
  let zraf = 0; new ResizeObserver(() => { if (!zraf) zraf = requestAnimationFrame(() => { zraf = 0; applyZoom(); }); }).observe(sheetEl);
  $('#z-in').onclick = () => setZoom(zoom + 0.1);
  $('#z-out').onclick = () => setZoom(zoom - 0.1);
  $('#z-val').onclick = () => setZoom(1);
  const fitPage = () => { if (desk.clientWidth > 80 && sheetEl.offsetWidth > 0) setZoom(Math.min(1.5, (desk.clientWidth - 72) / sheetEl.offsetWidth)); };
  $('#z-fit').onclick = fitPage;
  MTRX.fitWriter = () => requestAnimationFrame(fitPage); // so a freshly opened page fits the screen
  desk.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || /(pdf|home|sheets)/.test(document.body.className)) return;
    if (e.key === '='|| e.key === '+') { e.preventDefault(); setZoom(zoom + 0.1); }
    else if (e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
  });
})();
// Help tab buttons share the menu actions
(() => { const go = (id, a) => { const b = document.getElementById(id); if (b) b.onclick = () => MTRX.menu.run('writer', a); }; go('help-online', 'helponline'); go('help-support', 'support'); go('help-feedback', 'feedback'); })();
