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

$('#sel-block').onchange = (e) => { exec('formatBlock', e.target.value); }; // replaced by paragraph.js (styles gallery)
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
// Show the font at the cursor. A font that is not in the list (from an opened document) is added so it is never blank.
document.addEventListener('selectionchange', () => {
  const s = getSelection(), box = $('#sel-font');
  if (!s.rangeCount || !ed.contains(s.anchorNode) || document.activeElement === box) return;
  const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
  if (!el) return;
  const name = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();
  if (!name) return;
  let o = [...box.options].find((x) => x.value.toLowerCase() === name.toLowerCase());
  if (!o) { o = new Option(name, name); box.add(o); }
  box.value = o.value;
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
  const t = cell.closest('table');
  if (fn !== TOPS.delTable && MTRX.tbl?.merged(t)) return msg('This table has merged cells. Split them first to add or remove rows and columns');
  const ri = cell.parentElement.rowIndex, ci = cell.cellIndex;
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
    const lk = parent.closest && parent.closest('a[href]');
    if (lk && /^https?:\/\//.test(lk.getAttribute('href'))) base.link = lk.getAttribute('href');
    const cm = parent.closest && parent.closest('span.cm');
    if (cm && MTRX.commentOf) base.comment = MTRX.commentOf(cm);
    const tc = parent.closest && parent.closest('span.tc');
    if (tc) { // a tracked change: its green / red look is only markup, not the author's formatting
      base.tracked = { del: tc.dataset.k === 'del', author: tc.dataset.a || '', date: tc.dataset.d || '' };
      base.color = null; if (base.tracked.del) base.strike = false; else base.underline = false;
    }
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
    const fmt = MTRX.paraFmt ? MTRX.paraFmt(alignEl) : null;
    blocks.push({ type: 'paragraph', align, runs, ...extra, ...(fmt ? { fmt } : {}) });
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

function rgbHex(v) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v || ''); if (!m) return '';
  return [m[1], m[2], m[3]].map((x) => Math.min(255, +x).toString(16).padStart(2, '0')).join('');
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
  const cell_fmt = [...t.rows].map((tr) => [...tr.cells].map((c) => {
    const hex = rgbHex(c.style.backgroundColor);
    return { colspan: Math.min(64, Math.max(1, parseInt(c.getAttribute('colspan')) || 1)), rowspan: Math.min(500, Math.max(1, parseInt(c.getAttribute('rowspan')) || 1)), fill: hex };
  }));
  if (col_widths.length && t.querySelector('[colspan]')) col_widths = [];
  const bd = t.getAttribute('data-bd');
  blocks.push({ type: 'table', rows, header: t.rows[0]?.cells[0]?.tagName === 'TH', col_widths, cell_fmt, borders: bd === 'none' || bd === 'thick' ? bd : '' });
}

function listBlocks(list, blocks, level = 0) {
  const kind = list.tagName === 'UL' ? 'bullet' : 'number';
  let i = 0;
  [...list.children].forEach((li) => {
    if (LIST_TAGS.test(li.tagName)) return listBlocks(li, blocks, level + 1); // the browser nests a sub-list directly inside the list
    if (li.tagName !== 'LI') return;
    paragraphBlocks(li.childNodes, li, blocks, { list: kind, list_index: ++i, list_level: level });
    [...li.children].filter((c) => LIST_TAGS.test(c.tagName)).forEach((sub) => listBlocks(sub, blocks, level + 1));
  });
}

const colsOf = (m) => Math.max(1, Math.min(4, parseInt(m.dataset.cols, 10) || 1)); // columns marker: "from here on, N columns"
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
    else if (tag === 'DIV' && n.classList.contains('cs')) blocks.push({ type: 'columns', cols: colsOf(n), line: n.dataset.line === '1' });
    else if (tag === 'DIV' && n.classList.contains('toc')) { const t = MTRX.tocModel && MTRX.tocModel(); if (t) blocks.push(t); }
    else if (tag === 'TABLE') tableBlock(n, blocks);
    else if (LIST_TAGS.test(tag)) listBlocks(n, blocks);
    else if (/^H[1-3]$/.test(tag)) paragraphBlocks(n.childNodes, n, blocks, { heading: +tag[1] });
    else paragraphBlocks(n.childNodes, n, blocks);
  });
  flushInline();
  return { title: $('#title').value.trim() || 'Document', blocks, page: { ...page }, header: '', footer: '', page_numbers: false, hf: hfOut() };
}

// ---- untrusted HTML (opened .mtrx files) -------------------------------
const ALLOWED_TAGS = new Set('P DIV SPAN BR B STRONG I EM U S STRIKE FONT SUP H1 H2 H3 UL OL LI TABLE TBODY THEAD TR TD TH IMG A'.split(' '));
const ALLOWED_ATTRS = new Set(['style', 'src', 'width', 'height', 'data-wrap', 'data-x', 'data-y', 'colspan', 'rowspan', 'size', 'color', 'face', 'class', 'data-note', 'href', 'data-bd', 'data-cols', 'data-line', 'data-eq', 'alt']);
const REVIEW_ATTRS = new Set(['data-cid', 'data-author', 'data-date', 'data-text', 'data-replies', 'data-done', 'data-l', 'data-k', 'data-a', 'data-d']);
// review = true when the html is a document being opened (keeps comments and the contents list); pasted html never carries them.
function sanitizeHtml(html, review) {
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
        const rv = review && (REVIEW_ATTRS.has(a.name) || (a.name === 'contenteditable' && n.className === 'toc'));
        const rvClass = review && a.name === 'class' && ((n.tagName === 'SPAN' && /^(cm|tx|pg|toc-t|tc)$/.test(a.value)) || (n.tagName === 'DIV' && /^(toc|toc-t|toc-i)$/.test(a.value)));
        const bad = rv || rvClass ? false : !ALLOWED_ATTRS.has(a.name) || (a.name === 'src' && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(v))
          || (a.name === 'style' && /url\(|expression|javascript:|@import/.test(v))
          || (a.name === 'data-note' && n.tagName !== 'SUP')
          || (a.name === 'href' && (n.tagName !== 'A' || !/^https?:\/\/[^\s"'<>]{1,2000}$/.test(a.value)))
          || (a.name === 'class' && !((n.tagName === 'SUP' && a.value === 'fn') || (n.tagName === 'DIV' && (a.value === 'pb' || a.value === 'cs'))))
          || (a.name === 'data-eq' && (n.tagName !== 'IMG' || a.value.length > 2000))
          || (a.name === 'alt' && n.tagName !== 'IMG')
          || (a.name === 'data-cols' && !(n.tagName === 'DIV' && n.className === 'cs' && /^[1-4]$/.test(a.value)))
          || (a.name === 'data-line' && !(n.tagName === 'DIV' && n.className === 'cs' && a.value === '1'));
        if (bad) n.removeAttribute(a.name);
      });
      if (n.tagName === 'TABLE') { n.removeAttribute('width'); n.style.removeProperty('width'); }
      if (n.tagName === 'TD' || n.tagName === 'TH') { n.removeAttribute('width'); n.removeAttribute('height'); n.style.removeProperty('height'); if (!/%$/.test(n.style.width)) n.style.removeProperty('width'); }
      if ((n.tagName === 'TABLE' || n.tagName === 'TD' || n.tagName === 'TH') && !n.getAttribute('style')) n.removeAttribute('style');
      if (n.tagName === 'DIV' && (n.className === 'pb' || n.className === 'cs')) n.setAttribute('contenteditable', 'false');
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
// Header and footer: left / centre / right text per line. {page} = page number, {pages} = number of pages.
const zone = (l = '', c = '', r = '') => ({ left: l, center: c, right: r });
const BORDER_STYLES = ['single', 'double', 'dashed', 'dotted'];
const borderIn = (b) => {
  const style = BORDER_STYLES.includes(b?.style) ? b.style : '';
  const color = /^[0-9a-fA-F]{6}$/.test(b?.color || '') ? b.color.toUpperCase() : '32000C';
  return { style, width: Math.max(1, Math.min(6, parseInt(b?.width, 10) || 1)), color };
};
const emptyHf = () => ({ header: zone(), footer: zone(), firstDifferent: false, firstHeader: zone(), firstFooter: zone(), border: borderIn(), rich: {} });
const zoneIn = (z) => zone(String(z?.left || '').slice(0, 200), String(z?.center || '').slice(0, 200), String(z?.right || '').slice(0, 200));
// Letterhead parts (logo, table, colours): html is shown; xml/rels/media are the original Word part, passed back untouched on save.
const RICH_KEYS = { h: 'rich_header', f: 'rich_footer', fh: 'rich_first_header', ff: 'rich_first_footer' };
function richIn(x) {
  const r = {}, src = x?.rich || {};
  for (const [k, key] of Object.entries(RICH_KEYS)) {
    const p = src[k] || x?.[key];
    if (p && typeof p.xml === 'string' && p.xml.trim()) r[k] = { html: sanitizeHtml(String(p.html || ''), false), xml: p.xml, rels: String(p.rels || ''), media: Array.isArray(p.media) ? p.media : [] };
  }
  return r;
}
const richOut = (r) => Object.fromEntries(Object.entries(RICH_KEYS).map(([k, key]) => [key, r[k] ? { html: r[k].html, xml: r[k].xml, rels: r[k].rels, media: r[k].media } : { html: '', xml: '', rels: '', media: [] }]));
const zoneEmpty = (z) => !(z.left.trim() || z.center.trim() || z.right.trim());
function normHf(x) { // accepts camelCase or snake_case
  x = x || {};
  return { header: zoneIn(x.header), footer: zoneIn(x.footer), firstDifferent: !!(x.firstDifferent ?? x.first_different), firstHeader: zoneIn(x.firstHeader ?? x.first_header), firstFooter: zoneIn(x.firstFooter ?? x.first_footer), border: borderIn(x.border), rich: richIn(x) };
}
function legacyHf(h, f, pn) { // files and drafts from before three-part headers
  const o = emptyHf(); o.header.center = String(h || '').slice(0, 200);
  if (f && pn) { o.footer.center = String(f).slice(0, 200); o.footer.right = '{page}'; } else if (pn) o.footer.center = '{page}'; else o.footer.center = String(f || '').slice(0, 200);
  return o;
}
const hfAny = (x) => { const o = normHf(x); return !zoneEmpty(o.header) || !zoneEmpty(o.footer) || o.firstDifferent || !!o.border.style || Object.keys(o.rich).length > 0; };
const hfOut = () => ({ header: hf.header, footer: hf.footer, first_different: hf.firstDifferent, first_header: hf.firstHeader, first_footer: hf.firstFooter, border: hf.border, ...richOut(hf.rich || {}) });
var page = defaultPage(), hf = emptyHf(); // `var`: buildModel (above) reads these
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
// Columns: blocks inside a columns section get a narrower width and are moved into place with margins (see layoutColumns).
function clearCol(root) {
  root.querySelectorAll(':scope > [data-col]').forEach((b) => {
    ['width', 'maxWidth', 'marginTop', 'marginBottom', 'marginLeft'].forEach((p) => { b.style[p] = ''; });
    b.removeAttribute('data-col'); b.removeAttribute('data-pg');
    if (!b.getAttribute('style')) b.removeAttribute('style');
  });
}
function unpaginate() {
  clearCellPad(ed);
  clearCol(ed);
  ed.querySelectorAll(':scope > [data-pg]').forEach((b) => { b.style.marginTop = ''; delete b.dataset.pg; });
}
// Put a block's top edge at `want` (px from the top of the sheet) by adjusting its top margin; margins of neighbours may collapse, so measure.
function placeAt(b, want) {
  let m = parseFloat(getComputedStyle(b).marginTop) || 0;
  for (let k = 0; k < 4; k++) {
    const d = want - b.offsetTop;
    if (Math.abs(d) < 0.5) break;
    m += d; b.style.marginTop = m + 'px';
  }
  b.dataset.pg = '1';
}
// Lay out the blocks of one columns section: fill column 1, then 2, ... then the next page. Returns the section's bottom edge.
// `balance`: the section is followed by another one, so even out the last page's columns like Word does.
function layoutColumns(els, n, line, balance, g, rules) {
  const { mt, mb, ml, pitch, ph, room, W } = g, gap = 48, cw = (W - gap * (n - 1)) / n;
  const y0 = els[0].offsetTop;
  els.forEach((b) => { b.dataset.col = '1'; if (!b.classList.contains('pb')) { b.style.width = cw + 'px'; b.style.maxWidth = cw + 'px'; } });
  const items = els.map((b) => {
    const pb = b.classList.contains('pb');
    return { b, pb, h: pb ? 0 : b.offsetHeight, g: pb ? 0 : parseFloat(getComputedStyle(b).marginBottom) || 0 };
  });
  items.forEach((it) => { it.b.style.marginBottom = '0px'; it.b.style.marginTop = '0px'; });
  const k0 = Math.floor(y0 / pitch);
  let p0 = k0, top0 = y0;
  if (k0 * pitch + ph - mb - y0 < 30) { p0 = k0 + 1; top0 = p0 * pitch + mt; }
  const a0 = p0 * pitch + ph - mb - top0;
  const slabTop = (s) => (s === 0 ? top0 : (p0 + s) * pitch + mt), avail = (s) => (s === 0 ? a0 : room);
  const slabs = [[]];
  let s = 0, c = 0, used = 0;
  for (const it of items) {
    if (it.pb) { if (slabs[s].length) { slabs.push([]); s++; } c = 0; used = 0; Object.assign(it, { s, c: 0, y: 0 }); slabs[s].push(it); continue; }
    if (used > 0 && used + it.h > avail(s)) { c++; used = 0; if (c >= n) { s++; c = 0; slabs.push([]); } }
    Object.assign(it, { s, c, y: used }); used += it.h + it.g; slabs[s].push(it);
  }
  const fit = (list, H) => {
    let cc = 0, u = 0; const out = [];
    for (const it of list) { if (u > 0 && u + it.h > H) { cc++; u = 0; if (cc >= n) return null; } out.push({ c: cc, y: u }); u += it.h + it.g; }
    return out;
  };
  if (balance) {
    const list = slabs[s].filter((it) => !it.pb);
    if (list.length > 1 && fit(list, avail(s))) {
      let lo = Math.max(...list.map((it) => it.h)), hi = avail(s);
      while (hi - lo > 1) { const mid = (lo + hi) / 2; if (fit(list, mid)) hi = mid; else lo = mid; }
      const out = fit(list, hi); list.forEach((it, i) => Object.assign(it, out[i]));
    }
  }
  let end = y0, prevBottom = 0;
  items.forEach((it, i) => {
    const Y = slabTop(it.s) + it.y;
    it.b.style.marginLeft = it.c * (cw + gap) + 'px';
    if (i > 0) it.b.style.marginTop = Y - prevBottom + 'px';
    if (!it.pb) placeAt(it.b, Y); else it.b.dataset.pg = '1'; // measured, so rounding never builds up down a column
    prevBottom = Y + it.h;
    if (!it.pb) end = Math.max(end, Y + it.h + it.g);
  });
  if (line && n > 1) slabs.forEach((list, si) => {
    const real = list.filter((it) => !it.pb); if (!real.length) return;
    const h = Math.max(...real.map((it) => it.y + it.h));
    for (let k = 1; k < n; k++) rules.push({ x: ml + k * (cw + gap) - gap / 2, y: slabTop(si), h });
  });
  return end;
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
    const kids = [...ed.children], rules = [];
    const geo = { mt, mb, ml: cs('--ml'), pitch, ph, room, W: ed.clientWidth };
    let ncols = 1, cline = false, runEnd = null, maxEnd = 0;
    for (let ki = 0; ki < kids.length; ki++) {
      const b = kids[ki];
      if (b.classList.contains('cs')) { ncols = colsOf(b); cline = b.dataset.line === '1'; continue; }
      if (ncols > 1) {
        let j = ki; while (j < kids.length && !kids[j].classList.contains('cs')) j++;
        runEnd = layoutColumns(kids.slice(ki, j), ncols, cline, j < kids.length, geo, rules);
        maxEnd = Math.max(maxEnd, runEnd);
        ki = j - 1; continue;
      }
      if (runEnd != null) { // first block below a columns section
        const nat = (b.style.marginTop = '', parseFloat(getComputedStyle(b).marginTop) || 0);
        placeAt(b, runEnd + nat); runEnd = null;
      }
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
    const end = Math.max(mt + ed.offsetHeight, maxEnd) + (fl.hidden ? 0 : fl.offsetHeight) + mb;
    const pages = Math.max(1, Math.ceil((end - 1) / pitch));
    sheet.style.minHeight = pages * pitch - GAP + 'px';
    sheet.querySelectorAll('.pgbox,.colrule').forEach((n) => n.remove());
    rules.forEach((r) => { const d = document.createElement('div'); d.className = 'colrule'; d.style.cssText = `left:${r.x}px;top:${r.y}px;height:${r.h}px`; sheet.appendChild(d); });
    for (let i = 0; i < pages; i++) {
      const box = document.createElement('div');
      box.className = 'pgbox'; box.style.top = i * pitch + 'px'; box.style.height = ph + 'px';
      if (hf.border.style) { const b = document.createElement('div'); b.className = 'pgb'; b.style.border = `${hf.border.width}pt ${hf.border.style} #${hf.border.color}`; if (hf.border.style === 'double') b.style.borderWidth = Math.max(3, hf.border.width * 2) + 'pt'; box.appendChild(b); }
      const first = hf.firstDifferent && i === 0;
      const mk = (cls, z, rk) => {
        const rp = hf.rich?.[rk];
        if (rp && rp.html) {
          const d = document.createElement('div'); d.className = 'hf rich ' + cls;
          d.innerHTML = rp.html.replace(/\{pages\}/g, pages).replace(/\{page\}/g, i + 1);
          return void box.appendChild(d);
        }
        if (zoneEmpty(z)) return;
        const d = document.createElement('div'); d.className = 'hf ' + cls;
        ['left', 'center', 'right'].forEach((k) => { const s = document.createElement('span'); s.textContent = z[k].replace(/\{pages\}/g, pages).replace(/\{page\}/g, i + 1); d.appendChild(s); });
        box.appendChild(d);
      };
      mk('hdr', first ? hf.firstHeader : hf.header, first ? 'fh' : 'h');
      mk('ftr', first ? hf.firstFooter : hf.footer, first ? 'ff' : 'f');
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
     <p style="font-size:12px;color:#7b5d66;margin:8px 0 0">Headers, footers and page numbers: Insert, Header and footer.</p>`,
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
      applyPage();
      saveDraftSoon();
    }, 'Apply');
};

// Header and footer dialog (Insert, Header and footer; also a double-click in the top or bottom margin of a page).
function hfDialog() {
  const box = (id, z, label) => `<div style="margin:6px 0 2px;font-weight:600;font-size:12px">${label}</div>
    <div class="row">${['left', 'center', 'right'].map((k) => `<div><label>${k[0].toUpperCase() + k.slice(1)}</label><input id="${id}-${k}" value="${escAttr(z[k])}" maxlength="200"></div>`).join('')}</div>`;
  const rk = Object.keys(hf.rich || {});
  const richNote = rk.length ? `<div style="background:#f6eef0;border-radius:6px;padding:8px;margin:0 0 8px;font-size:12px">This file has a designed ${rk.some((k) => k[0] === 'h' || k === 'fh') ? 'header' : ''}${rk.length > 1 || !rk.some((k) => k[0] === 'h') ? (rk.some((k) => k[0] === 'h') ? ' and ' : '') + 'footer' : ''} (logo, colours, lines). It stays as it is when you save. Type in a box below to replace it with plain text.
      <label style="display:block;margin-top:4px"><input type="checkbox" id="hf-rmrich" style="width:auto"> Remove the designed header and footer</label></div>` : '';
  modal('Header and footer',
    `${richNote}${box('h', hf.header, 'Header (top of every page)')}${box('f', hf.footer, 'Footer (bottom of every page)')}
     <div style="margin:8px 0 2px"><button type="button" id="hf-pg" class="mini">Insert page number</button> <button type="button" id="hf-pgs" class="mini">Insert page count</button>
     <button type="button" id="hf-num" class="mini">Page X of Y, bottom centre</button></div>
     <label><input type="checkbox" id="hf-first" ${hf.firstDifferent ? 'checked' : ''} style="width:auto"> Different first page (for a title page)</label>
     <div id="hf-firstbox" ${hf.firstDifferent ? '' : 'hidden'}>${box('fh', hf.firstHeader, 'First page header')}${box('ff', hf.firstFooter, 'First page footer')}</div>
     <p style="font-size:12px;color:#7b5d66;margin:6px 0 0">Click a box, then a button to add a field. Fields show the real number on each page.</p>`,
    (m) => {
      const v = (id) => m.querySelector('#' + id).value;
      const z = (id) => zoneIn({ left: v(id + '-left'), center: v(id + '-center'), right: v(id + '-right') });
      const nz = { h: z('h'), f: z('f'), fh: z('fh'), ff: z('ff') }, rm = m.querySelector('#hf-rmrich')?.checked;
      const rich = {}; // a designed part stays unless it is removed or plain text is typed over it
      for (const k of Object.keys(hf.rich || {})) if (!rm && zoneEmpty(nz[k])) rich[k] = hf.rich[k];
      hf = { header: nz.h, footer: nz.f, firstDifferent: m.querySelector('#hf-first').checked, firstHeader: nz.fh, firstFooter: nz.ff, border: hf.border, rich };
      markPages(); saveDraftSoon();
    }, 'Apply');
  const m = document.querySelector('#modal');
  let last = m.querySelector('#f-center');
  m.querySelectorAll('input[type=text],input:not([type])').forEach((i) => i.addEventListener('focus', () => { last = i; }));
  const add = (t) => { if (!last) return; const a = last.selectionStart ?? last.value.length, b = last.selectionEnd ?? a; last.value = last.value.slice(0, a) + t + last.value.slice(b); last.focus(); last.setSelectionRange(a + t.length, a + t.length); };
  m.querySelector('#hf-pg').onclick = () => add('{page}');
  m.querySelector('#hf-pgs').onclick = () => add('{pages}');
  m.querySelector('#hf-num').onclick = () => { ['f-left', 'f-right'].forEach((i) => (m.querySelector('#' + i).value = '')); m.querySelector('#f-center').value = 'Page {page} of {pages}'; };
  m.querySelector('#hf-first').onchange = (e) => { m.querySelector('#hf-firstbox').hidden = !e.target.checked; };
  m.querySelectorAll('.mini').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
}
$('#btn-hf').onclick = hfDialog;

// Page borders: a box around every page (Page setup group, Insert menu).
function borderDialog() {
  const b = hf.border, sw = ['32000C', '000000', '1F4E79', '2E7D32', 'B3261E', '7B5D66'];
  const opt = (v, t) => `<option value="${v}"${b.style === v ? ' selected' : ''}>${t}</option>`;
  modal('Page borders',
    `<div class="row"><div><label>Line</label><select id="m-bs">${opt('', 'None')}${opt('single', 'Single')}${opt('double', 'Double')}${opt('dashed', 'Dashed')}${opt('dotted', 'Dotted')}</select></div>
     <div><label>Width (pt)</label><select id="m-bw">${[1, 2, 3, 4, 5, 6].map((n) => `<option${n === b.width ? ' selected' : ''}>${n}</option>`).join('')}</select></div></div>
     <label>Colour</label><div id="m-bc" style="display:flex;gap:8px;margin:4px 0">${sw.map((c) => `<button type="button" data-c="${c}" title="#${c}" style="width:26px;height:26px;border-radius:50%;background:#${c};border:${c === b.color ? '3px solid #c9a227' : '1px solid #0004'};padding:0"></button>`).join('')}</div>
     <p style="font-size:12px;color:#7b5d66;margin:8px 0 0">Drawn on every page, just inside the edge. Shows in Word and in the exported PDF.</p>`,
    (m) => {
      hf = { ...hf, border: borderIn({ style: m.querySelector('#m-bs').value, width: m.querySelector('#m-bw').value, color: m.dataset.c || b.color }) };
      markPages(); saveDraftSoon();
    }, 'Apply');
  const m = document.querySelector('#modal');
  m.querySelectorAll('#m-bc button').forEach((x) => x.onclick = () => { m.dataset.c = x.dataset.c; m.querySelectorAll('#m-bc button').forEach((y) => (y.style.border = y === x ? '3px solid #c9a227' : '1px solid #0004')); });
}
$('#btn-pgborder').onclick = borderDialog;
sheet.addEventListener('dblclick', (e) => { // double-click in the top or bottom margin of a page
  if (e.target !== sheet) return;
  const r = sheet.getBoundingClientRect(), z = parseFloat(getComputedStyle(sheet).zoom) || 1, y = (e.clientY - r.top) / z;
  const cs = (v) => parseFloat(sheet.style.getPropertyValue(v)) || 0, ph = cs('--ph') || 1056, pos = y % (ph + GAP);
  if (pos < cs('--mt') || pos > ph - cs('--mb')) hfDialog();
});

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
  if (!pb?.classList.contains('pb') && !pb?.classList.contains('cs')) return;
  const edge = document.createRange();
  edge.selectNodeContents(blk);
  back ? edge.setEnd(sel.anchorNode, sel.anchorOffset) : edge.setStart(sel.anchorNode, sel.anchorOffset);
  if (edge.toString() !== '') return; // caret is not at the very start / end of the block
  e.preventDefault();
  pb.remove();
  markPages();
});
// Put a marker block (page break or columns) at the caret: the paragraph is split there and the marker goes between the halves.
function insertMarker(html) {
  ed.focus();
  const s0 = getSelection();
  let b0 = s0.rangeCount ? s0.anchorNode : null;
  while (b0 && b0.parentNode !== ed) b0 = b0.parentNode;
  if (b0 && b0.nodeType === 1 && /^(TABLE|UL|OL)$/.test(b0.tagName)) { // a table / list cannot be split: put it right after
    const r0 = document.createRange(); r0.setStart(ed, [...ed.childNodes].indexOf(b0) + 1); r0.collapse(true);
    s0.removeAllRanges(); s0.addRange(r0);
    const nx = b0.nextElementSibling;
    document.execCommand('insertHTML', false, html + (nx && nx.tagName === 'P' ? '' : '<p><br></p>'));
    return;
  }
  if (b0 && s0.isCollapsed) { // caret at the very start of a block: no split needed, the marker goes before it
    const edge = document.createRange(); edge.selectNodeContents(b0); edge.setEnd(s0.anchorNode, s0.anchorOffset);
    if (edge.toString() === '' && !b0.querySelector?.('img')) {
      const r1 = document.createRange(); r1.setStart(ed, [...ed.childNodes].indexOf(b0)); r1.collapse(true);
      s0.removeAllRanges(); s0.addRange(r1);
      document.execCommand('insertHTML', false, html);
      return;
    }
  }
  document.execCommand('insertParagraph');
  let blk = getSelection().anchorNode;
  while (blk && blk.parentNode !== ed) blk = blk.parentNode;
  if (blk) {
    // insertHTML (not DOM calls) so the browser records it in the same undo step as the split.
    const r = document.createRange(); r.setStart(ed, [...ed.childNodes].indexOf(blk)); r.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertHTML', false, html);
  }
}
$('#ins-break').onclick = () => { insertMarker('<div class="pb" contenteditable="false"></div>'); markPages(); };

// Callout box: a one-cell shaded table with a heavier border, so it saves into Word as a real table (no floating box).
MTRX.callout = () => {
  ed.focus();
  const sel = getSelection(), picked = sel.rangeCount && !sel.isCollapsed ? sel.toString().trim() : '';
  const body = picked ? escAttr(picked).replace(/>/g, '&gt;') : 'Type here';
  document.execCommand('insertHTML', false, `<table data-bd="thick"><tbody><tr><td style="background-color:#f7eef0"><b>Note</b><br>${body}</td></tr></tbody></table><p><br></p>`);
  markPages(); saveDraftSoon();
};
// Columns: the setting that applies at the caret is the last marker above it (none = one column).
function columnsAtCaret() {
  const sel = getSelection();
  let blk = sel.rangeCount ? sel.anchorNode : null;
  while (blk && blk.parentNode !== ed) blk = blk.parentNode;
  let cur = { cols: 1, line: false };
  for (const k of ed.children) { if (k === blk) break; if (k.classList.contains('cs')) cur = { cols: colsOf(k), line: k.dataset.line === '1' }; }
  return cur;
}
$('#btn-cols').onclick = () => {
  const cur = columnsAtCaret();
  const opt = (n, t) => `<option value="${n}"${n === cur.cols ? ' selected' : ''}>${t}</option>`;
  const saved = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null;
  modal('Columns',
    `<div class="row"><div><label>Text from the cursor on</label><select id="m-cols">${opt(1, 'One column')}${opt(2, 'Two columns')}${opt(3, 'Three columns')}</select></div></div>
     <label><input type="checkbox" id="m-colline" ${cur.line ? 'checked' : ''} style="width:auto"> Line between columns</label>
     <p style="font-size:12px;color:#7b5d66;margin:8px 0 0">Applies from the cursor to the next column change. To go back to one column, put the cursor below the columns and choose One column.</p>`,
    (m) => {
      const n = +m.querySelector('#m-cols').value, line = m.querySelector('#m-colline').checked;
      if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); }
      if (n === cur.cols && line === cur.line) return;
      if (n === 1 && cur.cols === 1) return;
      insertMarker(`<div class="cs" data-cols="${n}"${n > 1 && line ? ' data-line="1"' : ''} contenteditable="false"></div>`);
      markPages(); saveDraftSoon();
    }, 'Apply');
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
  const q = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
  const content = (t) => t.split(/(\{pages\}|\{page\})/).filter(Boolean).map((s) => (s === '{page}' ? 'counter(page)' : s === '{pages}' ? 'counter(pages)' : q(s))).join(' ');
  const box = 'font:10pt Calibri,sans-serif;color:#555;white-space:pre-line;';
  const rules = (pos, z, blank) => ['left', 'center', 'right'].map((k) => (z[k].trim() ? `@${pos}-${k}{content:${content(z[k])};${box}}` : blank ? `@${pos}-${k}{content:none}` : '')).join('');
  const el = document.createElement('style');
  el.textContent = `@page{${rules('top', hf.header)}${rules('bottom', hf.footer)}}` +
    (hf.firstDifferent ? `@page:first{${rules('top', hf.firstHeader, true)}${rules('bottom', hf.firstFooter, true)}}` : '') +
    // page border: a fixed box repeats on every printed page, 24pt (32px) in from the page edge like the screen view
    (hf.border.style ? `body::after{content:"";position:fixed;z-index:9999;pointer-events:none;top:${32 - page.top / 15}px;left:${32 - page.left / 15}px;right:${32 - page.right / 15}px;bottom:${32 - page.bottom / 15}px;border:${hf.border.style === 'double' ? Math.max(3, hf.border.width * 2) : hf.border.width}pt ${hf.border.style} #${hf.border.color}}` : '');
  document.head.appendChild(el);
  // designed (letterhead) headers and footers: a fixed box repeats on every printed page, in the margin
  const extra = [];
  const addRich = (k, top) => {
    const rp = hf.rich?.[k]; if (!rp?.html) return;
    const d = document.createElement('div'); d.className = 'hf rich hf-print'; d.innerHTML = rp.html.replace(/\{pages\}/g, MTRX.pageCount || 1).replace(/\{page\}/g, '');
    d.style.cssText = `display:block!important;position:fixed;z-index:9998;left:0;right:0;${top ? `top:${33 - page.top / 15}px` : `bottom:${33 - page.bottom / 15}px`}`;
    document.body.appendChild(d); extra.push(d);
  };
  addRich('h', true); addRich('f', false);
  const rm = el.remove.bind(el); el.remove = () => { extra.forEach((n) => n.remove()); rm(); };
  return el;
}
// For printing, let the browser flow each columns section itself; returns a function that puts the blocks back.
function wrapColumns() {
  const wraps = []; let n = 1, line = false, run = null;
  for (const k of [...ed.children]) {
    if (k.classList.contains('cs')) { n = colsOf(k); line = k.dataset.line === '1'; run = null; continue; }
    if (n < 2) continue;
    if (!run) {
      run = document.createElement('div'); run.className = 'colwrap';
      run.style.cssText = `column-count:${n};column-gap:48px;${line ? 'column-rule:1px solid #444;' : ''}`;
      ed.insertBefore(run, k); wraps.push(run);
    }
    run.appendChild(k);
  }
  return () => wraps.forEach((w) => { while (w.firstChild) ed.insertBefore(w.firstChild, w); w.remove(); });
}
const inchesOf = (t) => t / 1440;
async function exportPdf() {
  if (!invoke) return msg('Run inside the desktop app to export');
  renderFootnotesNow();
  const [w, h] = page.landscape ? [page.height, page.width] : [page.width, page.height];
  const el = printStyle();
  unpaginate();
  const unwrap = wrapColumns();
  try {
    const p = await invoke('export_pdf', {
      name: $('#title').value || 'Document',
      page: { width: inchesOf(w), height: inchesOf(h), top: inchesOf(page.top), bottom: inchesOf(page.bottom), left: inchesOf(page.left), right: inchesOf(page.right) },
    });
    if (p) msg('PDF saved: ' + p);
  } catch (e) { msg('PDF export failed: ' + e); }
  finally { unwrap(); el.remove(); markPages(); }
}
$('#btn-pdf').onclick = exportPdf;

// ---- opening files -----------------------------------------------------
function showWriter() { document.body.classList.remove('home', 'pdf'); MTRX.fitWriter?.(); }
function loadLaunch(r, keepDraft = false) {
  if (!r) return;
  if (!keepDraft && r.kind !== 'pdf') MTRX.clearDraft?.(); // the file now on screen is the saved version
  if (r.kind === 'pdf') return MTRX.openPdf(r.name, r.data);
  showWriter();
  $('#title').value = r.title; ed.innerHTML = sanitizeHtml(r.html, true);
  page = { ...defaultPage(), ...r.page };
  hf = hfAny(r.hf) ? normHf(r.hf) : legacyHf(r.header, r.footer, r.pageNumbers);
  applyPage(); renderFootnotesNow(); countWords(); MTRX.reviewLoaded && MTRX.reviewLoaded();
}
MTRX.openInWriter = (title, html, extra) => loadLaunch({ kind: 'doc', title, html, page: defaultPage(), header: '', footer: '', pageNumbers: false, ...extra });
// Launched with a file (double-click or "Open with")? Open it straight away.

// ---- draft recovery ----------------------------------------------------
// Handled by the shared session module (session.js), the same for every app: a hidden copy is kept while you work,
// cleared when you save, offered back on the Home screen after a crash or an accidental close.
function draftHtml() {
  const c = ed.cloneNode(true); // drop the visual page-break spacing, it is recomputed on load
  clearCellPad(c); clearCol(c);
  c.querySelectorAll('[data-pg]').forEach((b) => { b.style.marginTop = ''; b.removeAttribute('data-pg'); if (!b.getAttribute('style')) b.removeAttribute('style'); });
  return c.innerHTML;
}
let wDirty = false;
const saveDraftSoon = () => { wDirty = true; MTRX.session.changed('writer'); };
// handed to review.js (comments and contents), which is a separate script
MTRX.w = { buildModel, ed, sheet, GAP, msg, modal, exec, saveDraftSoon, markPages, countWords, saved: () => saved };
MTRX.session.register('writer', {
  label: 'document',
  msg,
  isDirty: () => wDirty,
  snapshot: () => {
    const blank = !ed.textContent.trim() && !ed.querySelector('img,table,.pb');
    return blank ? null : { title: $('#title').value, html: draftHtml(), page, hf };
  },
  restore: (d) => { loadLaunch({ kind: 'doc', title: d.title, html: d.html, page: d.page, hf: d.hf, header: d.header, footer: d.footer, pageNumbers: d.pageNumbers }, true); wDirty = true; },
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
  ['Ctrl+M', 'Increase indent', () => $('#para-indent').click(), 'text', '#para-indent'],
  ['Ctrl+Shift+M', 'Decrease indent', () => $('#para-outdent').click(), 'text', '#para-outdent'],
  ['Ctrl+Alt+L', 'Insert link', () => $('#ins-link').click(), 'text', '#ins-link'],
  ['Ctrl+Alt+B', 'Insert check box', () => MTRX.checkbox?.insert(), 'text', null],
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
  ['Ctrl+Alt+M', 'Comment on selection', () => $('#ins-comment').click(), 'text', '#ins-comment'],
  ['Ctrl+Alt+F', 'Insert footnote', () => $('#ins-footnote').click(), 'text', '#ins-footnote'],
  ['Ctrl+Shift+E', 'Track changes', () => $('#tc-toggle').click(), 'text', '#tc-toggle'],
  ['Alt+=', 'Insert equation', () => $('#ins-eq').click(), 'text', '#ins-eq'],
  ['Ctrl+Enter', 'Insert page break', () => $('#ins-break').click(), 'text', '#ins-break'],
  ['Ctrl+Alt+P', 'Page setup', () => $('#page-setup').click(), 'text', '#page-setup'],
  ['Ctrl+Alt+R', 'Table: add row', () => $('#t-addrow').click(), 'text', '#t-addrow'],
  ['Ctrl+Alt+K', 'Table: add column', () => $('#t-addcol').click(), 'text', '#t-addcol'],
];

const CODES = { ']': 'BracketRight', '[': 'BracketLeft', '/': 'Slash', '=': 'Equal', F1: 'F1' };
const parseCombo = (c) => {
  const parts = c.split('+'), key = parts.pop();
  return {
    ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt'),
    code: CODES[key] || (/^[A-Z]$/.test(key) ? 'Key' + key : /^\d$/.test(key) ? 'Digit' + key : key),
  };
};
const BOUND = SHORTCUTS.map((s) => ({ ...parseCombo(s[0]), run: s[2], scope: s[3] }));

document.addEventListener('keydown', (e) => {
  if (/(pdf|home|sheets|solve)/.test(document.body.className)) return; // the PDF app / home screen handle their own keys
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
MTRX.goHome = () => { document.body.classList.remove('pdf', 'sheets', 'solve'); document.body.classList.add('home'); };
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
      ['Merge cells', '', () => MTRX.tbl.merge()],
      ['Split cell', '', () => MTRX.tbl.split()],
      ['No borders', '', () => MTRX.tbl.borders('none')],
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
    if (!(e.ctrlKey || e.metaKey) || e.altKey || /(pdf|home|sheets|solve)/.test(document.body.className)) return;
    if (e.key === '='|| e.key === '+') { e.preventDefault(); setZoom(zoom + 0.1); }
    else if (e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
  });
})();
// Help tab buttons share the menu actions
(() => { const go = (id, a) => { const b = document.getElementById(id); if (b) b.onclick = () => MTRX.menu.run('writer', a); }; go('help-online', 'helponline'); go('help-support', 'support'); go('help-feedback', 'feedback'); })();
