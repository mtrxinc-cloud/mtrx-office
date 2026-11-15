// MTRX Sheets: the screen. The spreadsheet itself (cells, formulas, recalculation, undo) lives in Rust
// (crates/mtrx-sheet). This file only draws the cells you can see on a canvas and sends edits to the engine,
// so a sheet with a million rows costs the same to scroll as an empty one.
(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const MTRX = (window.MTRX = window.MTRX || {});
// Browser testing only: `cargo run -p mtrx-sheet --example devserver --release` serves the real Rust engine and these
// screens on port 8124; open http://localhost:8124/ . The installed app always talks to the engine through Tauri.
const DEV = location.port === '8124' ? '/' : null;
const invoke = DEV ? null : window.__TAURI__?.core?.invoke;
const MAXR = 1048576, MAXC = 16384;
const HDR_W = 54, HDR_H = 26, ROW_H = 24, COL_W = 104;
const FONT = '13px "Segoe UI", system-ui, sans-serif';
const INK = '#1c2230', MAROON = '#32000c';

const cv = $('#sh-canvas'), ctx = cv.getContext('2d');
const scroll = $('#sh-scroll'), spacer = $('#sh-spacer'), wrap = $('#sh-wrap');
const chartLayer = document.createElement('div'); chartLayer.className = 'sh-charts'; document.querySelector('div.sh-wrap').appendChild(chartLayer); // not `wrap`: that id is shared with the Wrap text button
let charts = [], selChart = 0, cdrag = null;
const chartEls = new Map(); // id -> { el, sig, c }
const ed = $('#sh-editor'), keys = $('#sh-keys'), fbar = $('#sh-formula'), nbox = $('#sh-namebox');
if (!cv || !scroll) return;

// ---- talking to the engine: one request at a time, in order -------------------------------------------------------
let chain = Promise.resolve();
function call(op, args) {
  const p = chain.then(async () => {
    if (invoke) {
      const v = await invoke('sheet', { op, args: args || {} });
      if (v === null || v === undefined) throw 'this copy of the app has no spreadsheet engine; close it and start it again';
      return v;
    }
    const r = await fetch(DEV, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args: args || {} }) });
    const j = await r.json();
    if (j.err) throw j.err;
    return j.ok;
  });
  chain = p.catch(() => {});
  return p;
}

// ---- state ---------------------------------------------------------------------------------------------------------
let W = 0, H = 0, dpr = 1;
let act = { r: 0, c: 0 }, tail = { r: 0, c: 0 };       // active cell, and the corner that moves when you extend
const widths = new Map(); let custom = [];              // custom column widths (the engine keeps them per sheet), kept sorted: [[col, width]]
const rheights = new Map(); let rcust = [], rcum = [], rextra = 0; // custom row heights; the showing ones sorted [[row, height]]; running extra height; its total
let cache = new Map(), loaded = null;                   // visible cells: r*MAXC+c -> [text, kind, style id]
const styles = new Map();                               // style id -> { b, i, u, s, a, z, c, f, bd, nf } (as the engine sends it)
let colSt = new Map(), rowSt = new Map();               // column / row styles that cover the visible area
let cur = {};                                           // the active cell's style, for the toolbar
let canUndo = false, canRedo = false;
let editing = null, point = null;                       // the cell being edited; a reference being pointed at in a formula
let clip = null;                                        // last copy: { text, inputs, origin, rect, cut }
let engineOk = true;

const colName = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const colNum = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const cellName = (r, c) => colName(c) + (r + 1);
const msg = (t) => { const m = $('#sh-msg'); m.textContent = t; setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 4000); };
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

// ---- geometry ------------------------------------------------------------------------------------------------------
const colW = (c) => widths.get(c) || COL_W;
function colX(c) { let x = c * COL_W; for (const [k, w] of custom) { if (k >= c) break; x += w - COL_W; } return x; }
function colAt(x) { let lo = 0, hi = MAXC - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (colX(m) <= x) lo = m; else hi = m - 1; } return lo; }
const setWidth = (c, w) => { w = clamp(Math.round(w), 24, 600); if (w === COL_W) widths.delete(c); else widths.set(c, w); custom = [...widths].sort((a, b) => a[0] - b[0]); sizeSpacer(); };
const setHeight = (r, h) => { h = clamp(Math.round(h), 12, 600); if (h === ROW_H) rheights.delete(r); else rheights.set(r, h); rebuildRows(); sizeSpacer(); };
function sizeSpacer() { spacer.style.width = HDR_W + colX(MAXC) + 'px'; spacer.style.height = Math.min(30e6, HDR_H + (MAXR - hidTotal) * ROW_H + rextra) + 'px'; }
// Rows with a custom height: a row's top is its place among the showing rows times the default height, plus the extra of the custom rows above it.
function rebuildRows() {
  rcust = [...rheights].filter(([r]) => !isHid(r)).sort((a, b) => a[0] - b[0]); rcum = []; let n = 0;
  for (const [, h] of rcust) { n += h - ROW_H; rcum.push(n); }
  rextra = n;
}
function extraBefore(r) { const i = lower(rcust, 0, r); return i ? rcum[i - 1] : 0; }
const rowH = (r) => (isHid(r) ? 0 : rheights.get(r) || ROW_H);

// Rows the filter hides take no room: a row's place on screen is its number among the rows that are showing.
let hid = [], hidCum = [], hidTotal = 0;                // hidden rows as sorted [first, last] ranges; hidden rows before each range; all of them
let frz = [0, 0];                                       // frozen rows and columns of this sheet
let merges = [];                                        // merged blocks [r0, c0, r1, c1]
let filt = null;                                        // { rect: [r0, c0, r1, c1], cols: [columns with a condition] } while a filter is on
function setLayout(res) {
  hid = res.hidden || []; hidCum = []; let n = 0;
  for (const [a, b] of hid) { hidCum.push(n); n += b - a + 1; }
  hidTotal = n; frz = res.freeze || [0, 0]; merges = res.merges || []; filt = res.filter || null;
  if (res.colw) { widths.clear(); for (const [c, w] of res.colw) widths.set(c, w); custom = [...widths].sort((a, b) => a[0] - b[0]); }
  if (res.rowh) { rheights.clear(); for (const [r, h] of res.rowh) rheights.set(r, h); }
  rebuildRows(); sizeSpacer();
}
const layoutSig = () => JSON.stringify([hid, frz, filt && filt.rect, custom, rcust]);
function hidBefore(r) { // hidden rows above row r
  let lo = 0, hi = hid.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (hid[m][0] < r) lo = m + 1; else hi = m; }
  if (!lo) return 0;
  const [a, b] = hid[lo - 1]; return hidCum[lo - 1] + Math.min(b + 1, r) - a;
}
function isHid(r) {
  let lo = 0, hi = hid.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (hid[m][1] < r) lo = m + 1; else hi = m; }
  return lo < hid.length && hid[lo][0] <= r;
}
const vis = (r) => r - hidBefore(r);                    // place among the showing rows
function rowOfVis(v) {                                  // the row at that place
  let lo = 0, hi = hid.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (hid[m][0] - hidCum[m] <= v) lo = m + 1; else hi = m; }
  return lo ? v + hidCum[lo - 1] + (hid[lo - 1][1] - hid[lo - 1][0] + 1) : v;
}
const rowY = (r) => vis(r) * ROW_H + extraBefore(r);    // top of a row in the scrolling sheet
const frozenH = () => rowY(frz[0]), frozenW = () => colX(frz[1]);
const lastVis = () => MAXR - hidTotal - 1;
function rowAtY(dy) {                                   // the row that covers this height of the scrolling sheet
  let lo = 0, hi = lastVis();
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rowY(rowOfVis(m)) <= dy) lo = m; else hi = m - 1; }
  return rowOfVis(lo);
}
const stepRow = (r, d) => rowOfVis(clamp(vis(r) + d, 0, lastVis()));  // d rows further, skipping hidden ones
// where a cell is on screen: frozen rows and columns stay put, the rest scrolls
const pxs = (c) => HDR_W + colX(c) - (c >= frz[1] ? scroll.scrollLeft : 0);
const pys = (r) => HDR_H + rowY(r) - (r >= frz[0] ? scroll.scrollTop : 0);
const mergeAt = (r, c) => merges.find((m) => r >= m[0] && r <= m[2] && c >= m[1] && c <= m[3]) || null;
// which cell is under a point of the grid body (x, y in canvas pixels)
function cellAtXY(x, y) {
  const FW = frozenW(), FH = frozenH();
  const dx = x < HDR_W + FW ? x - HDR_W : x - HDR_W + scroll.scrollLeft, dy = y < HDR_H + FH ? y - HDR_H : y - HDR_H + scroll.scrollTop;
  return { r: rowAtY(Math.max(0, dy)), c: colAt(Math.max(0, dx)) };
}
// the selection grows to take in any merged block it touches (like Excel)
function selRect() {
  const s = { r0: Math.min(act.r, tail.r), c0: Math.min(act.c, tail.c), r1: Math.max(act.r, tail.r), c1: Math.max(act.c, tail.c) };
  if (!merges.length) return s;
  for (let grew = true; grew;) {
    grew = false;
    for (const m of merges) {
      if (m[0] <= s.r1 && s.r0 <= m[2] && m[1] <= s.c1 && s.c0 <= m[3] && (m[0] < s.r0 || m[1] < s.c0 || m[2] > s.r1 || m[3] > s.c1)) {
        s.r0 = Math.min(s.r0, m[0]); s.c0 = Math.min(s.c0, m[1]); s.r1 = Math.max(s.r1, m[2]); s.c1 = Math.max(s.c1, m[3]); grew = true;
      }
    }
  }
  return s;
}
const single = () => { const s = selRect(); return (s.r0 === s.r1 && s.c0 === s.c1) || merges.some((m) => m[0] === s.r0 && m[1] === s.c0 && m[2] === s.r1 && m[3] === s.c1); };

// the cells to load: what scrolls, plus the frozen rows and columns (the engine takes a list of rectangles)
function visRect(margin) {
  const st = scroll.scrollTop, sl = scroll.scrollLeft, FH = frozenH(), FW = frozenW();
  const r0 = rowAtY(st + FH), r1 = Math.min(MAXR - 1, stepRow(rowAtY(st + H - HDR_H), 1));
  const c0 = colAt(sl + FW); let c1 = c0, x = HDR_W + colX(c0) - sl;
  while (x < W && c1 < MAXC - 1) { x += colW(c1); c1++; }
  const mr = margin ? 40 : 0, mc = margin ? 8 : 0;
  const main = [Math.max(0, r0 - mr), Math.max(0, c0 - mc), Math.min(MAXR - 1, r1 + mr), Math.min(MAXC - 1, c1 + mc)];
  const out = [main], [fr, fc] = frz;
  if (fr) out.push([0, main[1], fr - 1, main[3]]);
  if (fc) out.push([main[0], 0, main[2], fc - 1]);
  if (fr && fc) out.push([0, 0, fr - 1, fc - 1]);
  return out;
}

// ---- data: only what is on screen ------------------------------------------------------------------------------
function apply(res, rects) {
  cache = new Map();
  for (const [r, c, t, k, s] of res.cells) cache.set(r * MAXC + c, [t, k, s]);
  for (const id in res.styles) styles.set(+id, res.styles[id]);
  colSt = new Map(res.cols); rowSt = new Map(res.rows);
  if (res.tabs) setTabs(res.tabs);
  setLayout(res);
  loaded = rects[0]; canUndo = res.undo; canRedo = res.redo;
  $('#sh-undo').disabled = !canUndo; $('#sh-redo').disabled = !canRedo;
  charts = res.charts || []; drawCharts();
  rules = res.valid || [];
  syncBar(); redraw(); placeEditor();
}
let rules = [];
const ruleAt = (r, c) => rules.find((x) => r >= x.rect[0] && r <= x.rect[2] && c >= x.rect[1] && c <= x.rect[3]) || null;
const listRuleAt = (r, c) => { const x = ruleAt(r, c); return x && x.kind === 'list' ? x : null; };
async function refresh() {
  const rects = visRect(true);
  try { apply(await call('view', { view: rects }), rects); setOffline(false); } catch (e) { setOffline(true, e); }
}
function ensureLoaded() {
  const v = visRect(false)[0];
  if (loaded && v[0] >= loaded[0] && v[1] >= loaded[1] && v[2] <= loaded[2] && v[3] <= loaded[3]) return;
  refresh();
}
async function mutate(op, args) {
  const rects = visRect(true), before = layoutSig();
  try {
    const res = await call(op, { ...args, view: rects }); apply(res, rects);
    if (op !== 'import' && op !== 'new') { dirty = true; showTitle(); MTRX.session.changed('sheets'); }
    if (layoutSig() !== before) await refresh(); // rows were hidden or panes frozen: the window of cells to load changed
    return res;
  } catch (e) { msg(String(e)); return null; }
}
function setOffline(off, e) {
  engineOk = !off;
  $('#sh-offline').hidden = !off;
  if (off && invoke && e) $('#sh-offline').textContent = 'The spreadsheet engine did not respond: ' + e;
}

// ---- drawing -------------------------------------------------------------------------------------------------------
// A cell's style id: its own (the engine already resolved column/row styles for the cells it sent), else its column's or row's.
const sidAt = (r, c) => { const v = cache.get(r * MAXC + c); return v ? v[2] : (colSt.get(c) ?? rowSt.get(r) ?? 0); };
const styleAt = (r, c) => { const id = sidAt(r, c); return id ? styles.get(id) : undefined; };
const hasText = (r, c) => { const v = cache.get(r * MAXC + c); return !!v && v[0] !== ''; };
// points to screen pixels: the default 11 pt is drawn at 13 px
const px_ = (pt) => Math.round(pt * 13 / 11 * 2) / 2;
const fontFor = (st) => (st && (st.b || st.i || st.z) ? `${st.i ? 'italic ' : ''}${st.b ? '600 ' : ''}${st.z ? px_(st.z) : 13}px "Segoe UI", system-ui, sans-serif` : FONT);
const LW = { 1: 1, 2: 2, 3: 3, 4: 1, 5: 1, 6: 1 }, DASH = { 4: [5, 3], 5: [1.5, 2.5] };
// One border edge between (x0,y0) and (x1,y1); bd is [line, '#rrggbb']. Edges sit on the grid lines, so a border covers its grid line.
function edgeLine(x0, y0, x1, y1, bd) {
  const ln = bd[0], lw = LW[ln] || 1, horiz = y0 === y1;
  ctx.strokeStyle = bd[1]; ctx.lineWidth = lw; ctx.setLineDash(DASH[ln] || []);
  const snap = (v) => (lw % 2 ? Math.round(v) - .5 : Math.round(v)), ext = Math.floor(lw / 2);
  const one = (off) => { ctx.beginPath(); if (horiz) { const y = snap(y0) + off; ctx.moveTo(x0 - ext, y); ctx.lineTo(x1 + ext, y); } else { const x = snap(x0) + off; ctx.moveTo(x, y0 - ext); ctx.lineTo(x, y1 + ext); } ctx.stroke(); };
  if (ln === 6) { one(-1); one(1); } else one(0);
}
let raf = 0;
const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };

// The grid is drawn in up to four parts: the scrolling part, the frozen rows, the frozen columns and the frozen corner.
// Each part scrolls (or not) as a whole, so a merged block or a selection that crosses a frozen edge is cut off at the edge.
function paint() {
  if (!W || !engineOk && !loaded) return;
  const FW = frozenW(), FH = frozenH();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const bx = HDR_W + FW, by = HDR_H + FH;
  for (const q of [
    { sx: true, sy: true, x0: bx, y0: by, x1: W, y1: H },
    { sx: true, sy: false, x0: bx, y0: HDR_H, x1: W, y1: by },
    { sx: false, sy: true, x0: HDR_W, y0: by, x1: bx, y1: H },
    { sx: false, sy: false, x0: HDR_W, y0: HDR_H, x1: bx, y1: by },
  ]) if (q.x1 > q.x0 && q.y1 > q.y0) paintBody(q);
  ctx.strokeStyle = '#9a6a76'; ctx.lineWidth = 2; ctx.beginPath();
  if (frz[1]) { ctx.moveTo(bx - 1, HDR_H); ctx.lineTo(bx - 1, H); }
  if (frz[0]) { ctx.moveTo(HDR_W, by - 1); ctx.lineTo(W, by - 1); }
  ctx.stroke(); ctx.lineWidth = 1;
  paintHeaders(bx, by);
  placeCharts();
}

// first index in a list sorted by `k` whose value is >= v
function lower(list, k, v) { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m][k] < v) lo = m + 1; else hi = m; } return lo; }

function paintBody(q) {
  const sl = scroll.scrollLeft, st = scroll.scrollTop, fr = frz[0], fc = frz[1];
  const px = (c) => HDR_W + colX(c) - (q.sx ? sl : 0), py = (r) => HDR_H + rowY(r) - (q.sy ? st : 0);
  const cols = [], rows = [];
  if (q.sx) { for (let c = colAt(sl + frozenW()), x = px(c); x < W && c < MAXC; c++) { const w = colW(c); cols.push({ c, x, w }); x += w; } }
  else for (let c = 0; c < fc; c++) cols.push({ c, x: px(c), w: colW(c) });
  if (q.sy) { const r0 = rowAtY(st + frozenH()); for (let v = vis(r0), y = HDR_H + rowY(r0) - st; y < H && v <= lastVis(); v++) { const r = rowOfVis(v), h = rowH(r); rows.push({ r, y, h }); y += h; } }
  else for (let v = 0, n = vis(fr), y = HDR_H; v < n; v++) { const r = rowOfVis(v), h = rowH(r); rows.push({ r, y, h }); y += h; }
  if (!rows.length || !cols.length) return;
  const S = selRect();
  const sx0 = px(S.c0), sx1 = px(S.c1) + colW(S.c1), sy0 = py(S.r0), sy1 = py(S.r1) + rowH(S.r1);

  // merged blocks that show in this part; every cell inside one is drawn by the block, not by itself
  const rLo = rows[0].r, rHi = rows[rows.length - 1].r, cLo = cols[0].c, cHi = cols[cols.length - 1].c;
  const blocks = merges.filter((m) => m[0] <= rHi && m[2] >= rLo && m[1] <= cHi && m[3] >= cLo).map((m) => {
    const x = px(m[1]), y = py(m[0]);
    return { m, x, y, w: px(m[3]) + colW(m[3]) - x, h: py(m[2]) + rowH(m[2]) - y };
  });
  const inBlock = new Set();
  for (const { m } of blocks) {
    for (let i = lower(rows, 'r', m[0]); i < rows.length && rows[i].r <= m[2]; i++) for (let j = lower(cols, 'c', m[1]); j < cols.length && cols[j].c <= m[3]; j++) inBlock.add(rows[i].r * MAXC + cols[j].c);
  }

  ctx.save(); ctx.beginPath(); ctx.rect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0); ctx.clip();
  // grid lines
  ctx.strokeStyle = '#e3e6eb'; ctx.lineWidth = 1; ctx.beginPath();
  for (const { y, h } of rows) { const yy = Math.round(y + h) - .5; ctx.moveTo(HDR_W, yy); ctx.lineTo(W, yy); }
  for (const { x, w } of cols) { const xx = Math.round(x + w) - .5; ctx.moveTo(xx, HDR_H); ctx.lineTo(xx, H); }
  ctx.stroke();
  // fills (they cover the grid lines, as in Excel)
  for (const { r, y, h } of rows) for (const { c, x, w } of cols) { if (inBlock.has(r * MAXC + c)) continue; const s = styleAt(r, c); if (s && s.f) { ctx.fillStyle = s.f; ctx.fillRect(x, y, w, h); } }
  // a merged block hides the grid lines inside it and takes the look of its top-left cell
  for (const { m, x, y, w, h } of blocks) {
    const s = styleAt(m[0], m[1]);
    ctx.fillStyle = (s && s.f) || '#fff'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#e3e6eb'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(x, Math.round(y + h) - .5); ctx.lineTo(x + w, Math.round(y + h) - .5); ctx.moveTo(Math.round(x + w) - .5, y); ctx.lineTo(Math.round(x + w) - .5, y + h); ctx.stroke();
  }
  // selection tint; the active cell keeps its own fill (or white)
  if (!single()) {
    ctx.fillStyle = 'rgba(50,0,12,.085)'; ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    const as = styleAt(act.r, act.c), ab = mergeAt(act.r, act.c);
    ctx.fillStyle = (as && as.f) || '#fff';
    if (ab) ctx.fillRect(px(ab[1]), py(ab[0]), px(ab[3]) + colW(ab[3]) - px(ab[1]), py(ab[2]) + rowH(ab[2]) - py(ab[0])); else ctx.fillRect(px(act.c), py(act.r), colW(act.c), rowH(act.r));
  }
  // borders
  const borders = (s, x, y, w, h) => {
    if (!s || !s.bd) return;
    const [t, rt, b, l] = s.bd;
    if (t) edgeLine(x, y, x + w, y, t);
    if (b) edgeLine(x, y + h, x + w, y + h, b);
    if (l) edgeLine(x, y, x, y + h, l);
    if (rt) edgeLine(x + w, y, x + w, y + h, rt);
  };
  for (const { r, y, h } of rows) for (const { c, x, w } of cols) if (!inBlock.has(r * MAXC + c)) borders(styleAt(r, c), x, y, w, h);
  for (const { m, x, y, w, h } of blocks) borders(styleAt(m[0], m[1]), x, y, w, h);
  ctx.setLineDash([]); ctx.lineWidth = 1;

  // cell text
  ctx.textBaseline = 'middle';
  const drawText = (v, x, y, w, h, i, r) => {
    const st2 = v[2] ? styles.get(v[2]) : undefined;
    let t = v[0]; const k = v[1], pad = 6;
    const al = st2 && st2.a ? st2.a : k === 2 ? 3 : k === 1 ? 1 : 2; // 1 left, 2 centre, 3 right
    ctx.font = fontFor(st2);
    if (st2 && st2.w && k === 1) { // wrapped text: as many lines as it needs inside the cell
      const lines = wrapLines(t, w - pad * 2), lh = lineH(st2), top = y + Math.max(3, (h - lines.length * lh) / 2), fs = st2.z ? px_(st2.z) : 13;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w - 1, h); ctx.clip();
      ctx.fillStyle = (st2 && st2.c) || INK; ctx.textAlign = al === 3 ? 'right' : al === 1 ? 'left' : 'center';
      const tx = al === 3 ? x + w - pad : al === 1 ? x + pad : x + w / 2;
      lines.forEach((ln, n) => {
        const ty = top + n * lh + lh / 2 + 1; ctx.fillText(ln, tx, ty);
        if (st2.u || st2.s) {
          const tw = ctx.measureText(ln).width, x0 = al === 3 ? tx - tw : al === 1 ? tx : tx - tw / 2;
          ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1; ctx.beginPath();
          if (st2.u) { const uy = Math.round(ty + fs * .46) + .5; ctx.moveTo(x0, uy); ctx.lineTo(x0 + tw, uy); }
          if (st2.s) { const sy = Math.round(ty) + .5; ctx.moveTo(x0, sy); ctx.lineTo(x0 + tw, sy); }
          ctx.stroke();
        }
      });
      ctx.restore(); return;
    }
    let clipW = 0, tw = -1;
    if (t.length * 8 > w - pad * 2) { // might not fit: measure
      tw = ctx.measureText(t).width;
      if (tw > w - pad * 2) {
        if (k === 2) { t = '#'.repeat(Math.max(1, Math.floor((w - pad * 2) / 8))); tw = -1; }  // numbers never spill: Excel shows ####
        else if (k === 1 && al === 1 && i >= 0) { let extra = 0, j = i + 1; while (j < cols.length && tw > w + extra - pad * 2 && !hasText(r, cols[j].c)) { extra += cols[j].w; j++; } clipW = w + extra; }
        else clipW = w;
        if (!clipW) clipW = w;
      }
    }
    if (clipW) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, clipW - 1, h); ctx.clip(); }
    ctx.fillStyle = (st2 && st2.c) || (k === 4 ? '#b00020' : INK);
    const tx = al === 3 ? x + w - pad : al === 1 ? x + pad : x + w / 2, ty = y + h / 2 + 1;
    ctx.textAlign = al === 3 ? 'right' : al === 1 ? 'left' : 'center';
    ctx.fillText(t, tx, ty);
    if (st2 && (st2.u || st2.s)) { // underline / strikethrough
      if (tw < 0) tw = ctx.measureText(t).width;
      const x0 = al === 3 ? tx - tw : al === 1 ? tx : tx - tw / 2, fs = st2.z ? px_(st2.z) : 13;
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1; ctx.beginPath();
      if (st2.u) { const uy = Math.round(ty + fs * .46) + .5; ctx.moveTo(x0, uy); ctx.lineTo(x0 + tw, uy); }
      if (st2.s) { const sy = Math.round(ty) + .5; ctx.moveTo(x0, sy); ctx.lineTo(x0 + tw, sy); }
      ctx.stroke();
    }
    if (clipW) ctx.restore();
  };
  for (const { r, y, h } of rows) {
    for (let i = 0; i < cols.length; i++) {
      const { c, x, w } = cols[i];
      const v = cache.get(r * MAXC + c); if (!v || v[0] === '' || inBlock.has(r * MAXC + c)) continue;
      drawText(v, x, y, w, h, i, r);
    }
  }
  for (const { m, x, y, w, h } of blocks) { const v = cache.get(m[0] * MAXC + m[1]); if (v && v[0] !== '') drawText(v, x, y, w, h, -1, m[0]); }
  ctx.textAlign = 'left';

  // filter buttons on the header row of the filtered table
  if (filt) {
    const [fr0, fc0, , fc1] = filt.rect, row = rows.find((o) => o.r === fr0);
    if (row) for (const { c, x, w } of cols) {
      if (c < fc0 || c > fc1 || w < 34) continue;
      const on = filt.cols.includes(c), bx = x + w - 20, by = row.y + 4;
      ctx.fillStyle = on ? MAROON : '#fff'; ctx.strokeStyle = on ? MAROON : '#a98a93'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(bx + .5, by + .5, 15, 15); ctx.fill(); ctx.stroke();
      ctx.fillStyle = on ? '#fff' : MAROON; ctx.beginPath(); ctx.moveTo(bx + 4, by + 6); ctx.lineTo(bx + 12, by + 6); ctx.lineTo(bx + 8, by + 11); ctx.closePath(); ctx.fill();
    }
  }

  // copy outline (dashed) and selection border
  if (clip && clip.rect && clip.tab === tabs.active) {
    const o = clip.rect; ctx.strokeStyle = MAROON; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.strokeRect(px(o.c0) + .5, py(o.r0) + .5, px(o.c1) + colW(o.c1) - px(o.c0) - 1, py(o.r1) + rowH(o.r1) - py(o.r0) - 1); ctx.setLineDash([]);
  }
  ctx.strokeStyle = MAROON; ctx.lineWidth = single() ? 2 : 1.5;
  ctx.strokeRect(sx0 + .5, sy0 + .5, sx1 - sx0 - 1, sy1 - sy0 - 1);
  if (!single()) { const ab = mergeAt(act.r, act.c) || [act.r, act.c, act.r, act.c]; ctx.lineWidth = 2; ctx.strokeRect(px(ab[1]) + 1, py(ab[0]) + 1, px(ab[3]) + colW(ab[3]) - px(ab[1]) - 2, py(ab[2]) + rowH(ab[2]) - py(ab[0]) - 2); }
  if (fillExt) { // the area a fill-handle drag is about to fill
    const s = selRect(); ctx.strokeStyle = MAROON; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.strokeRect(px(s.c0) + .5, py(s.r0) + .5, px(fillExt.c1) + colW(fillExt.c1) - px(s.c0) - 1, py(fillExt.r1) + rowH(fillExt.r1) - py(s.r0) - 1); ctx.setLineDash([]);
  } else if (single() && !editing && listRuleAt(act.r, act.c)) { // the drop-down arrow of a cell that only takes entries from a list
    const ax = px(act.c) + colW(act.c) - 18, ay = py(act.r) + 2, ah = Math.min(rowH(act.r) - 4, 18);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#a98a93'; ctx.lineWidth = 1; ctx.beginPath(); ctx.rect(ax + .5, ay + .5, 15, ah); ctx.fill(); ctx.stroke();
    ctx.fillStyle = MAROON; ctx.beginPath(); ctx.moveTo(ax + 4, ay + ah / 2 - 1); ctx.lineTo(ax + 12, ay + ah / 2 - 1); ctx.lineTo(ax + 8, ay + ah / 2 + 4); ctx.closePath(); ctx.fill();
  } else if (fillHandleOk()) { ctx.fillStyle = MAROON; ctx.fillRect(sx1 - 4, sy1 - 4, 7, 7); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(sx1 - 3.5, sy1 - 3.5, 6, 6); }
  ctx.restore();
}
let fillExt = null;
function fillHandleOk() { const s = selRect(); return !editing && !(s.r0 === 0 && s.r1 === MAXR - 1) && !(s.c0 === 0 && s.c1 === MAXC - 1); }

function paintHeaders(bx, by) {
  const sl = scroll.scrollLeft, st = scroll.scrollTop, fr = frz[0], fc = frz[1], S = selRect();
  ctx.fillStyle = '#f4eef0'; ctx.fillRect(0, 0, W, HDR_H); ctx.fillRect(0, 0, HDR_W, H);
  ctx.textAlign = 'center'; ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'; ctx.textBaseline = 'middle';
  // column letters: the frozen ones stay, the others scroll under them
  const colParts = [[0, fc, false, HDR_W, bx], [colAt(sl + frozenW()), MAXC, true, bx, W]];
  for (const [a, b, scrolls, x0, x1] of colParts) {
    if (x1 <= x0) continue;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, HDR_H); ctx.clip();
    for (let c = a, x = HDR_W + colX(a) - (scrolls ? sl : 0); c < b && x < x1; c++) {
      const w = colW(c), on = c >= S.c0 && c <= S.c1;
      if (on) { ctx.fillStyle = '#e6cbd4'; ctx.fillRect(x, 0, w, HDR_H); ctx.fillStyle = MAROON; ctx.fillRect(x, HDR_H - 2, w, 2); }
      ctx.fillStyle = on ? MAROON : '#6b4a52'; ctx.fillText(colName(c), x + w / 2, HDR_H / 2 + 1);
      ctx.fillStyle = '#d9c4ca'; ctx.fillRect(Math.round(x + w) - 1, 0, 1, HDR_H);
      x += w;
    }
    ctx.restore();
  }
  // row numbers
  const rowParts = [[0, vis(fr), HDR_H, by, false], [vis(rowAtY(st + frozenH())), lastVis() + 1, by, H, true]];
  for (const [v0, v1, y0, y1, scrolls] of rowParts) {
    if (y1 <= y0) continue;
    ctx.save(); ctx.beginPath(); ctx.rect(0, y0, HDR_W, y1 - y0); ctx.clip();
    for (let v = v0, y = HDR_H + rowY(rowOfVis(v0)) - (scrolls ? st : 0); v < v1 && y < y1; v++) {
      const r = rowOfVis(v), h = rowH(r), on = r >= S.r0 && r <= S.r1;
      if (on) { ctx.fillStyle = '#e6cbd4'; ctx.fillRect(0, y, HDR_W, h); ctx.fillStyle = MAROON; ctx.fillRect(HDR_W - 2, y, 2, h); }
      ctx.fillStyle = on ? MAROON : '#6b4a52'; ctx.fillText(String(r + 1), HDR_W / 2, y + h / 2 + 1);
      ctx.fillStyle = '#d9c4ca'; ctx.fillRect(0, Math.round(y + h) - 1, HDR_W, 1);
      y += h;
    }
    ctx.restore();
  }
  ctx.textAlign = 'left';
  ctx.strokeStyle = '#d9c4ca'; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(0, HDR_H - .5); ctx.lineTo(W, HDR_H - .5); ctx.moveTo(HDR_W - .5, 0); ctx.lineTo(HDR_W - .5, H); ctx.stroke();
}

function resize() {
  const w = scroll.clientWidth, h = scroll.clientHeight; if (!w || !h) return;
  dpr = window.devicePixelRatio || 1; W = w; H = h;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ensureLoaded(); redraw(); placeEditor();
}
new ResizeObserver(resize).observe(scroll);
scroll.addEventListener('scroll', () => { redraw(); ensureLoaded(); placeEditor(); });

// ---- selection ---------------------------------------------------------------------------------------------------
function ensureVisible(r, c) {
  const st = scroll.scrollTop, sl = scroll.scrollLeft, vh = H - HDR_H, vw = W - HDR_W, FH = frozenH(), FW = frozenW();
  if (r >= frz[0]) { // a frozen row or column is always in view, so only the others can need scrolling
    const top = rowY(r);
    if (top < st + FH) scroll.scrollTop = Math.max(0, top - FH); else if (top + rowH(r) > st + vh) scroll.scrollTop = top + rowH(r) - vh;
  }
  if (c >= frz[1]) {
    const cx = colX(c);
    if (cx < sl + FW) scroll.scrollLeft = Math.max(0, cx - FW); else if (cx + colW(c) > sl + vw) scroll.scrollLeft = cx + colW(c) - vw;
  }
}
let inputTok = 0, statTimer = 0;
function selectionChanged(keepBar) {
  const s = selRect();
  nbox.value = single() ? cellName(act.r, act.c) : (s.c0 === s.c1 && s.r0 === 0 && s.r1 === MAXR - 1 ? colName(s.c0) + ':' + colName(s.c1) : cellName(s.r0, s.c0) + ':' + cellName(s.r1, s.c1));
  if (!keepBar && !editing) {
    const tok = ++inputTok;
    call('input', { at: [act.r, act.c] }).then((t) => { if (tok === inputTok && !editing) fbar.value = t; }).catch(() => {});
  }
  clearTimeout(statTimer);
  statTimer = setTimeout(updateStats, 60);
  syncBar(); redraw();
}
async function updateStats() {
  const el = $('#sh-stats');
  if (single()) { el.innerHTML = '&nbsp;'; return; }
  try {
    const s = await call('stats', { rect: rectArr(selRect()) });
    el.textContent = s.nums ? `Sum: ${s.sum}    Average: ${s.avg}    Count: ${s.count}    Min: ${s.min}    Max: ${s.max}` : `Count: ${s.count}`;
  } catch { /* the engine is not there */ }
}
const rectArr = (s) => [s.r0, s.c0, s.r1, s.c1];
function moveTo(r, c, extend) {
  r = clamp(r, 0, MAXR - 1); c = clamp(c, 0, MAXC - 1);
  if (isHid(r)) r = rowOfVis(clamp(vis(r), 0, lastVis()));
  if (extend) tail = { r, c };
  else { const b = mergeAt(r, c); if (b) { r = b[0]; c = b[1]; } act = { r, c }; tail = { r, c }; } // a merged block is one cell: its top-left
  ensureVisible(r, c); selectionChanged();
}
// where an arrow key goes from a cell: past the whole merged block it is in, over hidden rows
function stepFrom(r, c, dr, dc) {
  const b = mergeAt(r, c);
  if (b) { if (dr > 0) r = b[2]; else if (dr < 0) r = b[0]; if (dc > 0) c = b[3]; else if (dc < 0) c = b[1]; }
  return [dr ? stepRow(r, dr) : r, c + dc];
}
const cursor = () => tail; // the corner you are moving

// ---- mouse ---------------------------------------------------------------------------------------------------------
function hit(e) {
  const b = cv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
  if (x < HDR_W && y < HDR_H) return { t: 'corner' };
  if (y < HDR_H) {
    const c = cellAtXY(Math.max(x, HDR_W), HDR_H).c, left = pxs(c), right = left + colW(c);
    if (Math.abs(x - right) <= 4) return { t: 'resize', c };
    if (c > 0 && x - left <= 4) return { t: 'resize', c: c - 1 };
    return { t: 'col', c };
  }
  if (x < HDR_W) {
    const r = cellAtXY(HDR_W, y).r, top = pys(r), bottom = top + rowH(r);
    if (Math.abs(y - bottom) <= 3) return { t: 'rresize', r };
    if (vis(r) > 0 && y - top <= 3) return { t: 'rresize', r: stepRow(r, -1) };
    return { t: 'row', r };
  }
  if (single() && !editing && listRuleAt(act.r, act.c)) { const ax = pxs(act.c) + colW(act.c) - 18, ay = pys(act.r) + 2; if (x >= ax && x <= ax + 16 && y >= ay && y <= ay + 18) return { t: 'ddarrow' }; }
  if (fillHandleOk()) { const s = selRect(), hx = pxs(s.c1) + colW(s.c1), hy = pys(s.r1) + rowH(s.r1); if (Math.abs(x - hx) <= 5 && Math.abs(y - hy) <= 5) return { t: 'fillh' }; }
  const { r, c } = cellAtXY(x, y);
  if (filt && r === filt.rect[0] && c >= filt.rect[1] && c <= filt.rect[3]) { // the little arrow on a filter heading
    const bx = pxs(c) + colW(c) - 20, by = pys(r) + 4;
    if (colW(c) >= 34 && x >= bx && x <= bx + 16 && y >= by && y <= by + 16) return { t: 'filter', c, r, x, y };
  }
  return { t: 'cell', r, c, x, y };
}
const refText = (a, b) => { const x0 = Math.min(a.r, b.r), x1 = Math.max(a.r, b.r), y0 = Math.min(a.c, b.c), y1 = Math.max(a.c, b.c); return x0 === x1 && y0 === y1 ? cellName(x0, y0) : cellName(x0, y0) + ':' + cellName(x1, y1); };
function pointOk() {
  if (!editing || !ed.value.startsWith('=')) return false;
  if (point) return true;
  const i = ed.selectionStart, before = ed.value.slice(0, i).trimEnd();
  return i > 0 && before.length > 0 && '=+-*/^&(,<>;:'.includes(before.slice(-1));
}
function pointAt(ref) {
  const s = point ? point.start : ed.selectionStart, e = point ? point.end : ed.selectionEnd;
  ed.value = ed.value.slice(0, s) + ref + ed.value.slice(e);
  point = { start: s, end: s + ref.length, anchor: point ? point.anchor : null };
  ed.setSelectionRange(point.end, point.end); fbar.value = ed.value; sizeEditor();
}

let drag = null, autoTimer = 0, lastMouse = null;
cv.addEventListener('mousedown', async (e) => {
  if (e.button === 1) return;
  const h = hit(e);
  closeFilter();
  if (selChart) { selChart = 0; placeCharts(); }
  if (editing) {
    if (h.t === 'cell' && pointOk()) { // clicking a cell while writing a formula inserts its address
      e.preventDefault();
      pointAt(refText({ r: h.r, c: h.c }, { r: h.r, c: h.c }));
      point.anchor = { r: h.r, c: h.c }; drag = { kind: 'point' }; lastMouse = e; ed.focus(); return;
    }
    await commit(0, 0);
  }
  keys.focus(); e.preventDefault();
  if (h.t === 'resize') { // dragging a column border; if that column is one of several selected whole columns they all follow
    if (e.detail >= 2) { fitCols(sizeTargets('c', h.c)); return; }
    const t = sizeTargets('c', h.c); drag = { kind: 'resize', c: h.c, t, x0: e.clientX, w0: colW(h.c), old: t.map((c) => [c, widths.get(c) || null]) }; return;
  }
  if (h.t === 'rresize') {
    if (e.detail >= 2) { fitRows(sizeTargets('r', h.r)); return; }
    const t = sizeTargets('r', h.r); drag = { kind: 'rresize', r: h.r, t, y0: e.clientY, h0: rowH(h.r), old: t.map((r) => [r, rheights.get(r) || null]) }; return;
  }
  if (h.t === 'filter') { if (e.button === 0) openFilter(h.c); return; }
  if (h.t === 'ddarrow' && e.button === 0) { openDropdown(); return; }
  if (h.t === 'fillh' && e.button === 0) { drag = { kind: 'fillh', s: selRect() }; lastMouse = e; return; }
  if (e.button === 2 && h.t === 'col') { const s = selRect(); if (!(s.r0 === 0 && s.r1 === MAXR - 1 && h.c >= s.c0 && h.c <= s.c1)) { act = { r: 0, c: h.c }; tail = { r: MAXR - 1, c: h.c }; selectionChanged(); } return; }
  if (e.button === 2 && h.t === 'row') { const s = selRect(); if (!(s.c0 === 0 && s.c1 === MAXC - 1 && h.r >= s.r0 && h.r <= s.r1)) { act = { r: h.r, c: 0 }; tail = { r: h.r, c: MAXC - 1 }; selectionChanged(); } return; }
  if (e.button === 2 && h.t === 'cell') { const s = selRect(); if (!(h.r >= s.r0 && h.r <= s.r1 && h.c >= s.c0 && h.c <= s.c1)) moveTo(h.r, h.c); return; }
  if (e.button !== 0) return;
  if (h.t === 'corner') { act = { r: 0, c: 0 }; tail = { r: MAXR - 1, c: MAXC - 1 }; selectionChanged(); return; }
  if (h.t === 'col') { if (e.shiftKey) tail = { r: MAXR - 1, c: h.c }; else { act = { r: 0, c: h.c }; tail = { r: MAXR - 1, c: h.c }; } drag = { kind: 'col' }; selectionChanged(); return; }
  if (h.t === 'row') { if (e.shiftKey) tail = { r: h.r, c: MAXC - 1 }; else { act = { r: h.r, c: 0 }; tail = { r: h.r, c: MAXC - 1 }; } drag = { kind: 'row' }; selectionChanged(); return; }
  if (h.t === 'cell') {
    if (e.shiftKey) { tail = { r: h.r, c: h.c }; selectionChanged(); } else moveTo(h.r, h.c);
    drag = { kind: 'cell' };
  }
  lastMouse = e;
});
window.addEventListener('mousemove', (e) => {
  if (!drag) {
    if (e.target === cv) { const h = hit(e); cv.style.cursor = h.t === 'resize' ? 'col-resize' : h.t === 'rresize' ? 'row-resize' : h.t === 'fillh' ? 'crosshair' : h.t === 'col' || h.t === 'row' || h.t === 'filter' ? 'pointer' : 'cell'; }
    return;
  }
  lastMouse = e;
  if (drag.kind === 'resize') { for (const c of drag.t) setWidth(c, drag.w0 + e.clientX - drag.x0); redraw(); placeEditor(); return; }
  if (drag.kind === 'rresize') { for (const r of drag.t) setHeight(r, drag.h0 + e.clientY - drag.y0); redraw(); placeEditor(); return; }
  dragSelect(e);
  clearInterval(autoTimer); autoTimer = setInterval(() => { if (drag && lastMouse) { autoScroll(lastMouse); dragSelect(lastMouse); } }, 50);
});
function autoScroll(e) {
  const b = cv.getBoundingClientRect();
  if (drag.kind !== 'col') { if (e.clientY > b.bottom - 4) scroll.scrollTop += ROW_H * 1.5; else if (e.clientY < b.top + HDR_H + 4) scroll.scrollTop -= ROW_H * 1.5; }
  if (drag.kind !== 'row') { if (e.clientX > b.right - 4) scroll.scrollLeft += COL_W * .6; else if (e.clientX < b.left + HDR_W + 4) scroll.scrollLeft -= COL_W * .6; }
}
function dragSelect(e) {
  const b = cv.getBoundingClientRect();
  const x = clamp(e.clientX - b.left, HDR_W, W - 1), y = clamp(e.clientY - b.top, HDR_H, H - 1);
  const { r, c } = cellAtXY(x, y);
  if (drag.kind === 'cell') { if (tail.r !== r || tail.c !== c) { tail = { r, c }; selectionChanged(); } }
  else if (drag.kind === 'col') { tail = { r: MAXR - 1, c }; selectionChanged(); }
  else if (drag.kind === 'row') { tail = { r, c: MAXC - 1 }; selectionChanged(); }
  else if (drag.kind === 'point' && point && point.anchor) pointAt(refText(point.anchor, { r, c }));
  else if (drag.kind === 'fillh') { // pull the handle down or right, whichever way you went further
    const s = drag.s, down = Math.max(0, r - s.r1), right = Math.max(0, c - s.c1);
    const ext = down === 0 && right === 0 ? null : down >= right ? { r1: r, c1: s.c1, dir: 'down' } : { r1: s.r1, c1: c, dir: 'right' };
    if (JSON.stringify(ext) !== JSON.stringify(fillExt)) { fillExt = ext; redraw(); }
  }
}
window.addEventListener('mouseup', () => {
  clearInterval(autoTimer); if (drag && drag.kind === 'point') ed.focus();
  const d = drag; drag = null;
  if (d && (d.kind === 'resize' || d.kind === 'rresize')) { commitSize(d); return; }
  if (d && d.kind === 'fillh') { const ext = fillExt; fillExt = null; if (ext) fillSeries(d.s, ext); else redraw(); return; }
  if (d && painter && d.kind !== 'point') applyPaint();
});
cv.addEventListener('dblclick', (e) => { const h = hit(e); if (h.t === 'cell') startEdit('edit'); });
cv.addEventListener('wheel', (e) => { // wheel scrolls rows in whole cells and keeps shift+wheel for columns
  if (e.ctrlKey) return;
  e.preventDefault();
  if (e.shiftKey) scroll.scrollLeft += e.deltaY; else { scroll.scrollTop += e.deltaY; scroll.scrollLeft += e.deltaX; }
}, { passive: false });

// ---- column widths and row heights --------------------------------------------------------------------------------
// The columns (or rows) a resize applies to: the ones you grabbed, or every selected whole column (row) when the grabbed one is among them.
function sizeTargets(kind, i) {
  const s = selRect();
  if (kind === 'c' && s.r0 === 0 && s.r1 === MAXR - 1 && i >= s.c0 && i <= s.c1 && s.c1 - s.c0 < 2000) return Array.from({ length: s.c1 - s.c0 + 1 }, (_, k) => s.c0 + k);
  if (kind === 'r' && s.c0 === 0 && s.c1 === MAXC - 1 && i >= s.r0 && i <= s.r1 && s.r1 - s.r0 < 2000) return Array.from({ length: s.r1 - s.r0 + 1 }, (_, k) => s.r0 + k);
  return [i];
}
// let go of the border: send the new sizes to the engine (one undo step); nothing is sent when nothing moved
async function commitSize(d) {
  const col = d.kind === 'resize', map = col ? widths : rheights, def = col ? COL_W : ROW_H;
  if (d.old.every(([k, v]) => (map.get(k) || null) === v)) return;
  const list = d.t.map((k) => [k, map.get(k) || def]);
  await mutate('size', col ? { cols: list } : { rows: list });
  if (col) await refitWrappedIn(d.t);
  else for (const r of d.t) autoRows.delete(r);
  placeEditor();
}
// Double-click a border: make the column as wide as its longest text / the row as tall as its tallest cell.
const PADX = 14;
async function fitCols(list) {
  const out = [];
  for (const c of list) {
    let n = 0; try { n = (await call('view', { view: [[0, c, 0, c]] })).used[0]; } catch { return; }
    const last = Math.min(n, 50000) - 1; let w = 0;
    if (last >= 0) {
      let res; try { res = await call('view', { view: [[0, c, last, c]] }); } catch { return; }
      for (const id in res.styles) styles.set(+id, res.styles[id]);
      ctx.save();
      for (const [, , t, k, sid] of res.cells) { if (t === '' ) continue; ctx.font = fontFor(sid ? styles.get(sid) : undefined); for (const line of String(t).split('\n')) w = Math.max(w, ctx.measureText(line).width); }
      ctx.restore();
    }
    out.push([c, w ? Math.ceil(w) + PADX : null]);
  }
  await mutate('size', { cols: out }); placeEditor();
}
const lineH = (st) => Math.round((st && st.z ? px_(st.z) : 13) * 1.3);
async function fitRows(list) {
  const out = [];
  for (const r of list) {
    let res; try { res = await call('view', { view: [[r, 0, r, 255]] }); } catch { return; }
    for (const id in res.styles) styles.set(+id, res.styles[id]);
    let h = ROW_H - 7;
    for (const [, c, t, , sid] of res.cells) {
      if (t === '') continue;
      const st = sid ? styles.get(sid) : undefined; ctx.save(); ctx.font = fontFor(st);
      const lines = st && st.w ? wrapLines(String(t), colW(c) - 12).length : String(t).split('\n').length;
      ctx.restore(); h = Math.max(h, lines * lineH(st));
    }
    out.push([r, h + 7 > ROW_H ? h + 7 : null]);
  }
  await mutate('size', { rows: out }); placeEditor();
}
// Rows whose height the program set itself (wrapped text) follow their text; a height you dragged by hand is never touched.
const autoRows = new Set();
async function refitRows(list) {
  const out = [];
  for (const r of list) {
    if (rheights.has(r) && !autoRows.has(r)) continue;
    let res; try { res = await call('view', { view: [[r, 0, r, 255]] }); } catch { return; }
    for (const id in res.styles) styles.set(+id, res.styles[id]);
    let h = ROW_H - 7;
    for (const [, c, t, , sid] of res.cells) {
      const st = sid ? styles.get(sid) : undefined;
      if (t === '' || !st || !st.w) continue;
      ctx.save(); ctx.font = fontFor(st); const lines = wrapLines(String(t), colW(c) - 12).length; ctx.restore(); h = Math.max(h, lines * lineH(st));
    }
    const target = h + 7 > ROW_H ? h + 7 : null, cur = rheights.get(r) || null;
    if (target) autoRows.add(r); else autoRows.delete(r);
    if (target !== cur) out.push([r, target]);
  }
  if (out.length) { await mutate('size', { rows: out }); placeEditor(); }
}
async function refitWrappedIn(cols) { const rs = new Set(); for (const k of cache.keys()) { const c = k % MAXC; if (cols.includes(c) && wrappedAt(Math.floor(k / MAXC), c)) rs.add(Math.floor(k / MAXC)); } if (rs.size) await refitRows([...rs].slice(0, 300)); }
const wrappedAt = (r, c) => { const e = cache.get(r * MAXC + c); const st = e && e[2] ? styles.get(e[2]) : null; return !!(st && st.w); };
// break text into lines that fit a width (the context font must already be set); newlines always break
function wrapLines(t, width) {
  const lines = [];
  for (const para of t.split('\n')) {
    let cur = '';
    for (const word of para.split(' ')) {
      const tryLine = cur ? cur + ' ' + word : word;
      if (!cur || ctx.measureText(tryLine).width <= width) { cur = tryLine; continue; }
      lines.push(cur); cur = word;
    }
    // a single word wider than the column breaks inside the word
    while (ctx.measureText(cur).width > width && cur.length > 1) {
      let n = cur.length - 1; while (n > 1 && ctx.measureText(cur.slice(0, n)).width > width) n--;
      lines.push(cur.slice(0, n)); cur = cur.slice(n);
    }
    lines.push(cur);
  }
  return lines;
}

// ---- editing -----------------------------------------------------------------------------------------------------
function placeEditor() {
  if (!editing || ed.hidden) return;
  const x = pxs(editing.c), y = pys(editing.r), b = mergeAt(editing.r, editing.c);
  ed.style.left = x + 'px'; ed.style.top = y + 'px'; ed.style.height = (b ? pys(b[2]) + rowH(b[2]) - y : rowH(editing.r)) + 'px'; sizeEditor();
}
function sizeEditor() {
  if (!editing) return;
  const b = mergeAt(editing.r, editing.c), cw = b ? pxs(b[3]) + colW(b[3]) - pxs(b[1]) : colW(editing.c);
  ctx.font = FONT; const tw = ctx.measureText(ed.value).width + 24;
  ed.style.minWidth = cw + 'px'; ed.style.width = Math.min(Math.max(cw, tw), Math.max(160, W - pxs(editing.c) - 6)) + 'px';
}
async function startEdit(mode, initial) {
  if (editing) return;
  const { r, c } = act;
  ensureVisible(r, c);
  let text = initial;
  if (text === undefined) { try { text = await call('input', { at: [r, c] }); } catch { text = ''; } }
  editing = { mode, r, c, orig: initial === undefined ? text : null };
  point = null;
  ed.hidden = false; ed.value = text; fbar.value = text; placeEditor();
  ed.focus(); ed.setSelectionRange(text.length, text.length);
}
// Saving a cell takes a round trip to the engine. Keys typed meanwhile (a fast typist, or a paste of keystrokes) wait in a
// queue and are replayed in order once the cell is saved and the selection has moved, so none are lost.
let pending = null, draining = false;
const keyQ = [];
async function commit(dr, dc) {
  if (!editing) return;
  const { r, c, orig } = editing, v = ed.value;
  editing = null; point = null; ed.hidden = true; keys.focus();
  const run = (async () => {
    if (orig === null || orig === undefined || v !== orig) { await mutate('set', { edits: [[r, c, v]] }); if (wrappedAt(r, c)) await refitRows([r]); }
    if (dr || dc) moveTo(...stepFrom(r, c, dr, dc)); else selectionChanged();
  })();
  pending = run;
  try { await run; } finally { if (pending === run) pending = null; }
  await drainKeys();
}
async function drainKeys() {
  if (draining) return;
  draining = true;
  try {
    while (keyQ.length && !pending) {
      const k = keyQ.shift();
      if (!editing) { await onKey(k); continue; }
      if (k.key === 'Enter') await commit(k.shiftKey ? -1 : 1, 0);
      else if (k.key === 'Tab') await commit(0, k.shiftKey ? -1 : 1);
      else if (k.key === 'Escape') cancelEdit();
      else if (k.key === 'Backspace') { ed.value = ed.value.slice(0, -1); point = null; fbar.value = ed.value; sizeEditor(); }
      else if (printable(k)) { ed.value += k.key; point = null; fbar.value = ed.value; sizeEditor(); }
    }
  } finally { draining = false; }
}
function cancelEdit() { if (!editing) return; editing = null; point = null; ed.hidden = true; keys.focus(); selectionChanged(); }

ed.addEventListener('input', () => { point = null; fbar.value = ed.value; sizeEditor(); });
ed.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commit(e.shiftKey ? -1 : 1, 0); }
  else if (e.key === 'Tab') { e.preventDefault(); commit(0, e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  else if (e.key === 'F2') { e.preventDefault(); editing.mode = editing.mode === 'edit' ? 'type' : 'edit'; }
  else if (editing && editing.mode === 'type' && !ed.value.startsWith('=') && e.key.startsWith('Arrow') && !e.ctrlKey && !e.altKey) { // typing a plain value: arrows finish it, like Excel
    e.preventDefault();
    commit(e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0, e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
  }
});
// the formula bar is a second view of the same edit
fbar.addEventListener('focus', () => { if (!editing) { editing = { mode: 'edit', r: act.r, c: act.c, orig: fbar.value }; ed.hidden = false; ed.value = fbar.value; placeEditor(); } });
fbar.addEventListener('input', () => { if (editing) { ed.value = fbar.value; sizeEditor(); } });
fbar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); ed.value = fbar.value; commit(1, 0); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
});
const leaving = () => setTimeout(() => { const a = document.activeElement; if (editing && a !== ed && a !== fbar && !drag) { if (fbar.value !== ed.value && a !== keys) ed.value = fbar.value; commit(0, 0); } }, 0);
ed.addEventListener('blur', leaving); fbar.addEventListener('blur', leaving);

nbox.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); selectionChanged(); keys.focus(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/.exec(nbox.value.trim());
  if (!m) { msg('Type a cell like D5 or a range like A1:C9'); return; }
  const r0 = +m[2] - 1, c0 = colNum(m[1]), r1 = m[4] ? +m[4] - 1 : r0, c1 = m[3] ? colNum(m[3]) : c0;
  if ([r0, r1].some((r) => r < 0 || r >= MAXR) || [c0, c1].some((c) => c < 0 || c >= MAXC)) { msg('That cell is outside the sheet'); return; }
  act = { r: r0, c: c0 }; tail = { r: r1, c: c1 }; ensureVisible(r0, c0); selectionChanged(); keys.focus();
});
nbox.addEventListener('focus', () => nbox.select());

// ---- keyboard (when you are not editing a cell) ------------------------------------------------------------------------
const printable = (e) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
keys.addEventListener('keydown', (e) => {
  if (pending || keyQ.length) { // still saving the last cell: keep this key for later
    e.preventDefault();
    if (keyQ.length < 500) keyQ.push({ key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, preventDefault() {} });
    return;
  }
  onKey(e);
});
async function onKey(e) {
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  if (k === 'F11' && e.shiftKey) { e.preventDefault(); return addTab(); }
  if (mod && !e.altKey) {
    const l = k.toLowerCase();
    if (l === 'pagedown') { e.preventDefault(); return switchTab(tabs.active + 1); }
    if (l === 'pageup') { e.preventDefault(); return switchTab(tabs.active - 1); }
    if (l === 's') { e.preventDefault(); return e.shiftKey ? saveFile('xlsx', true) : save(); }
    if (l === 'o') { e.preventDefault(); return openFile(); }
    if (l === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (l === 'y') { e.preventDefault(); return redo(); }
    if (l === 'c') { e.preventDefault(); return copySel(false); }
    if (l === 'x') { e.preventDefault(); return copySel(true); }
    if (l === 'd') { e.preventDefault(); return fill('down'); }
    if (l === 'r') { e.preventDefault(); return fill('right'); }
    if (l === 'a') { e.preventDefault(); return selectAll(); }
    if (l === 'g') { e.preventDefault(); return gotoBox(); }
    if (l === 'p') { e.preventDefault(); return printSheet(); }
    if (l === 'f' || l === 'h') { e.preventDefault(); return findReplace(l === 'h'); }
    if (l === 'b' && !e.shiftKey) { e.preventDefault(); return toggle('b'); }
    if (l === 'i' && !e.shiftKey) { e.preventDefault(); return toggle('i'); }
    if (l === 'u' && !e.shiftKey) { e.preventDefault(); return toggle('u'); }
    if (k === '5' && !e.shiftKey) { e.preventDefault(); return toggle('s'); }
    if (k === '+' || (k === '=' && e.shiftKey)) { e.preventDefault(); return insDelKey(true); }
    if (k === '-' && !e.shiftKey) { e.preventDefault(); return insDelKey(false); }
    if (e.shiftKey) { // Ctrl+Shift+digit: match the produced character or the physical key, whichever the keyboard layout gives
      const d = { '$': 'Digit4', '%': 'Digit5', '!': 'Digit1', '#': 'Digit3', '&': 'Digit7', '_': 'Minus', '4': 'Digit4', '5': 'Digit5', '1': 'Digit1', '3': 'Digit3', '7': 'Digit7', '-': 'Minus' }[k] || e.code;
      const act2 = { Digit4: () => nfSet(3, 2), Digit5: () => nfSet(4, 0), Digit1: () => nfSet(2, 2), Digit3: () => nfSet(5, 0), Digit7: () => borders('outer'), Minus: () => borders('none') }[d];
      if (act2) { e.preventDefault(); return act2(); }
    }
    if (l === 'home') { e.preventDefault(); return moveTo(0, 0, e.shiftKey); }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[k];
      const from = e.shiftKey ? cursor() : act;
      try { const [r, c] = await call('edge', { at: [from.r, from.c], dir }); moveTo(r, c, e.shiftKey); } catch { /* engine away */ }
      return;
    }
    if (l === 'v') return; // the browser fires a paste event, handled below
    return;
  }
  if (e.altKey && k === '=') { e.preventDefault(); return autoSum(); }
  if (e.altKey) return;
  const from = e.shiftKey ? cursor() : act, ext = e.shiftKey;
  switch (k) {
    case 'ArrowUp': e.preventDefault(); return moveTo(...stepFrom(from.r, from.c, -1, 0), ext);
    case 'ArrowDown': e.preventDefault(); return moveTo(...stepFrom(from.r, from.c, 1, 0), ext);
    case 'ArrowLeft': e.preventDefault(); return moveTo(...stepFrom(from.r, from.c, 0, -1), ext);
    case 'ArrowRight': e.preventDefault(); return moveTo(...stepFrom(from.r, from.c, 0, 1), ext);
    case 'Enter': e.preventDefault(); return moveTo(...stepFrom(act.r, act.c, e.shiftKey ? -1 : 1, 0));
    case 'Tab': e.preventDefault(); return moveTo(...stepFrom(act.r, act.c, 0, e.shiftKey ? -1 : 1));
    case 'Home': e.preventDefault(); return moveTo(from.r, 0, ext);
    case 'PageDown': e.preventDefault(); return moveTo(stepRow(from.r, Math.floor((H - HDR_H) / ROW_H) - 1), from.c, ext);
    case 'PageUp': e.preventDefault(); return moveTo(stepRow(from.r, 1 - Math.floor((H - HDR_H) / ROW_H)), from.c, ext);
    case 'F2': e.preventDefault(); return startEdit('edit');
    case 'Delete': case 'Backspace': e.preventDefault(); return selChart ? delChart() : clearSel();
    case 'Escape': if (selChart) { selectChart(0); return; } if (painter) { painter = null; syncBar(); } if (clip) { clip = null; redraw(); } return;
    default:
      if (printable(e)) { e.preventDefault(); await startEdit('type', k); }
  }
}
keys.addEventListener('paste', (e) => { e.preventDefault(); const t = e.clipboardData && e.clipboardData.getData('text/plain'); if (t) pasteText(t); });
// Text that arrives without key events (voice typing, on-screen keyboards, some input methods) starts the editor too.
keys.addEventListener('input', (e) => {
  if (e.isComposing) return;
  const t = keys.value; keys.value = '';
  if (!t) return;
  if (pending || keyQ.length) { // text that arrives while the last cell is still being saved waits its turn, like keys
    for (const ch of t) keyQ.push({ key: ch, code: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
    return;
  }
  if (!editing) startEdit('type', t);
});
keys.addEventListener('compositionstart', () => { if (!editing) startEdit('type', ''); }); // IME users: start the editor, the editor takes the text
keys.addEventListener('blur', () => redraw());

// ---- actions ---------------------------------------------------------------------------------------------------------
async function undo() { if (editing) return; const r = await mutate('undo'); if (r) selectionChanged(); }
async function redo() { if (editing) return; const r = await mutate('redo'); if (r) selectionChanged(); }
async function clearSel() { if (editing) return; await mutate('clear', { rect: rectArr(selRect()) }); selectionChanged(); }
// drag the fill handle: the selected cells are the pattern, the engine works out how it continues
async function fillSeries(s, ext) {
  const down = ext.dir === 'down';
  await mutate('fill', { rect: [s.r0, s.c0, ext.r1, ext.c1], dir: ext.dir, series: true, n: down ? s.r1 - s.r0 + 1 : s.c1 - s.c0 + 1 });
  act = { r: s.r0, c: s.c0 }; tail = { r: ext.r1, c: ext.c1 }; selectionChanged();
}
async function fill(dir) { if (editing) return; const s = selRect(); if (single()) { msg('Select the cells to fill, starting with the one to copy'); return; } await mutate('fill', { rect: rectArr(s), dir }); selectionChanged(); }
async function selectAll() { try { const v = await call('view', { view: [0, 0, 0, 0] }); const [rows, cols] = v.used; act = { r: 0, c: 0 }; tail = { r: Math.max(0, rows - 1), c: Math.max(0, cols - 1) }; selectionChanged(); } catch { /* engine away */ } }
function gotoBox() { nbox.focus(); nbox.select(); }
async function writeClip(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  keys.value = text; keys.select(); let ok = false; try { ok = document.execCommand('copy'); } catch { /* blocked */ } keys.value = ''; return ok;
}
async function copySel(cut) {
  if (editing) return;
  const rect = selRect();
  try {
    const r = await call('copy', { rect: rectArr(rect) });
    clip = { text: r.text, inputs: r.inputs, origin: r.origin, rect, cut: !!cut, tab: tabs.active };
    await writeClip(r.text); msg(cut ? 'Cut: pick where to paste' : 'Copied'); redraw();
  } catch (e) { msg(String(e)); }
}
async function pasteText(text) {
  if (editing) return;
  const same = clip && text === clip.text, s = selRect();
  const cutting = same && clip.cut && clip.tab === tabs.active; // on another sheet a cut pastes like a copy and never clears the wrong sheet
  const res = await mutate('paste', { at: [s.r0, s.c0], text: same ? clip.inputs : text, from: same ? clip.origin : null, cut: cutting ? rectArr(clip.rect) : null });
  if (!res) return;
  if (cutting) clip = null;
  if (res.pasted) { act = { r: res.pasted[0], c: res.pasted[1] }; tail = { r: res.pasted[2], c: res.pasted[3] }; }
  selectionChanged();
}
async function pasteMenu() {
  try { const t = await navigator.clipboard.readText(); if (t) return pasteText(t); } catch { /* the system clipboard is not readable from here */ }
  if (clip) pasteText(clip.text); else msg('Press Ctrl+V to paste');
}
async function autoSum() {
  if (editing) return;
  const num = (r, c) => { const v = cache.get(r * MAXC + c); return !!v && v[1] === 2; };
  const { r, c } = act; let f = '';
  if (r > 0 && num(r - 1, c)) { let t = r - 1; while (t > 0 && num(t - 1, c)) t--; f = `=SUM(${cellName(t, c)}:${cellName(r - 1, c)})`; }
  else if (c > 0 && num(r, c - 1)) { let t = c - 1; while (t > 0 && num(r, t - 1)) t--; f = `=SUM(${cellName(r, t)}:${cellName(r, c - 1)})`; }
  else f = '=SUM()';
  await mutate('set', { edits: [[r, c, f]] });
  if (f === '=SUM()') { await startEdit('edit', f); ed.setSelectionRange(5, 5); } else selectionChanged();
}
// ---- files: open / save .xlsx and .csv ---------------------------------------------------------------------------------
let fileName = '', dirty = false;
function showTitle() { $('#sh-title').textContent = (fileName || 'Untitled sheet') + (dirty ? ' *' : ''); }
function freshView() {
  tabUi = [];
  setLayout({}); closeFilter();
  widths.clear(); custom = []; rheights.clear(); rebuildRows(); sizeSpacer(); clip = null; painter = null; styles.clear();
  act = { r: 0, c: 0 }; tail = { r: 0, c: 0 }; scroll.scrollTop = 0; scroll.scrollLeft = 0;
}
const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const baseName = (n) => String(n).replace(/\.[^.]*$/, '') || 'Sheet';
// Shared recovery (session.js): a copy of the sheet is kept as you work and offered back after a crash.
MTRX.session.register('sheets', {
  label: 'sheet',
  msg,
  isDirty: () => dirty,
  snapshot: async () => ({ name: fileName, data: (await call('export', { kind: 'xlsx' })).data }),
  restore: async (d) => {
    showSheets(); freshView();
    const res = await mutate('import', { kind: 'xlsx', data: d.data });
    fileName = d.name || ''; dirty = true; showTitle(); selectionChanged();
    if (res) MTRX.session.changed('sheets');
  },
  title: (d) => d.name,
});
async function confirmLose() { return MTRX.session.confirmLose('sheets'); }
async function newSheet() {
  if (!(await confirmLose())) return;
  freshView(); fileName = ''; dirty = false; MTRX.session.saved('sheets'); showTitle();
  await mutate('new'); dirty = false; showTitle(); selectionChanged();
}
function opened(name, sheets) {
  fileName = name; dirty = false; MTRX.session.saved('sheets'); showTitle(); selectionChanged();
  msg(sheets > 1 ? `Opened ${name} (${sheets} sheets)` : `Opened ${name}`);
}

// ---- sheet tabs ---------------------------------------------------------------------------------------------------------
// The workbook (every sheet's cells, formats and undo) lives in Rust. The page only remembers, per tab, where you were
// looking: the selected cell and the scroll position (column widths and row heights are in the engine, per sheet).
let tabs = { names: [], active: 0 }, tabUi = [];
const tabBar = $('#sh-tablist');
let tabDrag = null;
function saveUi() { tabUi[tabs.active] = { act: { ...act }, tail: { ...tail }, sl: scroll.scrollLeft, st: scroll.scrollTop }; }
function loadUi(i) {
  const u = tabUi[i];
  act = u ? { ...u.act } : { r: 0, c: 0 }; tail = u ? { ...u.tail } : { r: 0, c: 0 };
  scroll.scrollLeft = u ? u.sl : 0; scroll.scrollTop = u ? u.st : 0;
}
function setTabs(t) {
  const same = tabs.names.length === t.names.length && tabs.names.every((n, i) => n === t.names[i]) && tabs.active === t.active;
  tabs = t; while (tabUi.length < t.names.length) tabUi.push(undefined); tabUi.length = t.names.length;
  if (!same) drawTabs();
}
function drawTabs() {
  // same tabs, different one selected: keep the buttons (replacing them would swallow the second click of a double-click)
  const kids = [...tabBar.children];
  if (kids.length === tabs.names.length && kids.every((k, i) => k.classList.contains('sh-tab') && k.textContent === tabs.names[i])) {
    kids.forEach((k, i) => { k.classList.toggle('on', i === tabs.active); k.setAttribute('aria-selected', i === tabs.active ? 'true' : 'false'); });
    tabBar.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('#sh-tabprev').disabled = tabs.active === 0; $('#sh-tabnext').disabled = tabs.active >= tabs.names.length - 1;
    return;
  }
  tabBar.replaceChildren();
  tabs.names.forEach((n, i) => {
    const b = document.createElement('button'); b.className = 'sh-tab' + (i === tabs.active ? ' on' : ''); b.textContent = n; b.dataset.i = i; b.title = n;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', i === tabs.active ? 'true' : 'false');
    b.addEventListener('mousedown', (e) => { e.preventDefault(); if (e.button === 0) tabDown(e, i); });
    b.ondblclick = () => renameTab(i);
    tabBar.appendChild(b);
  });
  tabBar.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#sh-tabprev').disabled = tabs.active === 0; $('#sh-tabnext').disabled = tabs.active >= tabs.names.length - 1;
}
// one tab operation: remember where you were, ask the engine, then show the sheet it says is now active
let tabBusy = Promise.resolve();
function tabOp(op, args, ui) { const p = tabBusy.then(() => tabOp1(op, args, ui)); tabBusy = p.catch(() => {}); return p; }
async function tabOp1(op, args, ui) {
  if (editing) await commit(0, 0);
  if (painter) { painter = null; syncBar(); }
  saveUi();
  if (clip && op !== 'tab_switch' && op !== 'tab_rename') clip = { ...clip, tab: -1, cut: false }; // tab numbers are about to change: a pending cut becomes a plain copy
  try {
    const res = await call(op, { ...args, view: visRect(true) });
    ui?.(res.tabs);                    // keep the per-tab view state in step with the new order
    setTabs(res.tabs); drawTabs(); setLayout(res); // the new sheet's frozen panes and hidden rows decide how far it can scroll
    closeFilter();
    loadUi(res.tabs.active);
    if (op !== 'tab_switch') { dirty = true; showTitle(); MTRX.session.changed('sheets'); }
    await refresh(); selectionChanged(); keys.focus();
  } catch (e) { msg(String(e)); drawTabs(); loadUi(tabs.active); keys.focus(); } // a refused change (bad name...) leaves everything as it was
}
const switchTab = (i) => (i === tabs.active || i < 0 || i >= tabs.names.length ? undefined : tabOp('tab_switch', { tab: i }));
const addTab = () => tabOp('tab_add', {}, () => tabUi.push(undefined));
async function deleteTab(i) {
  if (tabs.names.length < 2) { msg('A workbook needs at least one sheet'); return; }
  if (!confirm(`Delete the sheet "${tabs.names[i]}"? This cannot be undone.`)) return;
  await tabOp('tab_delete', { tab: i }, () => tabUi.splice(i, 1));
}
const dupTab = (i) => tabOp('tab_dup', { tab: i }, () => tabUi.splice(i + 1, 0, i === tabs.active ? { ...tabUi[i] } : tabUi[i] && { ...tabUi[i] }));
function moveTab(from, to) {
  to = clamp(to, 0, tabs.names.length - 1);
  if (from === to) return;
  return tabOp('tab_move', { tab: from, to }, () => { const [u] = tabUi.splice(from, 1); tabUi.splice(to, 0, u); });
}
async function renameTab(i) {
  await tabBusy; // a tab switch started by the first click of a double-click must finish first, or it would steal the focus back
  if (editing) return;
  const b = tabBar.children[i]; if (!b || !b.classList.contains('sh-tab')) return;
  const inp = document.createElement('input'); inp.className = 'sh-tabedit'; inp.value = tabs.names[i]; inp.maxLength = 31; inp.spellcheck = false;
  inp.style.width = Math.max(60, b.offsetWidth) + 'px';
  b.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (ok && v && v !== tabs.names[i]) await tabOp('tab_rename', { tab: i, name: v });
    else { drawTabs(); keys.focus(); }
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
  inp.addEventListener('blur', () => finish(true));
}
// drag a tab sideways to reorder; a plain click switches to it
function tabDown(e, i) {
  tabDrag = { i, x: e.clientX, moved: false, to: i };
  const move = (ev) => {
    if (!tabDrag) return;
    if (!tabDrag.moved && Math.abs(ev.clientX - tabDrag.x) < 6) return;
    tabDrag.moved = true; tabBar.classList.add('dragging');
    let to = tabs.names.length - 1;
    for (const [k, t] of [...tabBar.children].entries()) { const r = t.getBoundingClientRect(); if (ev.clientX < r.left + r.width / 2) { to = k; break; } }
    tabDrag.to = to;
    [...tabBar.children].forEach((t, k) => t.classList.toggle('drop', k === to && to !== tabDrag.i));
  };
  const up = () => {
    removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    const d = tabDrag; tabDrag = null; tabBar.classList.remove('dragging');
    [...tabBar.children].forEach((t) => t.classList.remove('drop'));
    if (!d) return;
    if (d.moved) moveTab(d.i, d.to); else switchTab(d.i);
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}
// the right-click menu of a tab: ready-made actions bound to that tab
const tabMenu = (i) => [
  { id: 'tab-ins', label: 'Insert sheet', run: addTab },
  { id: 'tab-ren', label: 'Rename', run: () => renameTab(i) },
  { id: 'tab-dup', label: 'Duplicate', run: () => dupTab(i) },
  { id: 'tab-del', label: 'Delete', run: () => deleteTab(i), when: () => tabs.names.length > 1 },
  '-',
  { id: 'tab-l', label: 'Move left', run: () => moveTab(i, i - 1), when: () => i > 0 },
  { id: 'tab-r', label: 'Move right', run: () => moveTab(i, i + 1), when: () => i < tabs.names.length - 1 },
];
tabBar.addEventListener('wheel', (e) => { tabBar.scrollLeft += e.deltaY || e.deltaX; e.preventDefault(); }, { passive: false });
async function openFile() {
  if (editing || !(await confirmLose())) return;
  if (invoke) {
    try {
      const r = await invoke('open_sheet');
      if (!r) return;
      freshView(); await refresh(); opened(r.name, r.sheets);
    } catch (e) { msg(String(e)); }
    return;
  }
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.csv';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const kind = /\.csv$/i.test(f.name) ? 'csv' : 'xlsx';
    freshView();
    const res = await mutate('import', { kind, data: b64(await f.arrayBuffer()) });
    if (res) opened(f.name, res.sheets ? res.sheets.length : 1);
  };
  inp.click();
}
async function saveFile(kind, ask) {
  if (editing) return;
  const ext = kind === 'csv' ? '.csv' : '.xlsx';
  const base = fileName ? baseName(fileName) : 'Sheet';
  try {
    if (invoke) {
      const r = await invoke('save_sheet', { kind, ask: !!ask, name: base + ext });
      if (!r) return;
      if (kind === 'xlsx' || /\.csv$/i.test(fileName)) { fileName = r.name; dirty = false; MTRX.session.saved('sheets'); }
      showTitle(); msg('Saved ' + r.name + (kind === 'csv' ? ' (CSV keeps values only, not formatting)' : ''));
    } else {
      const r = await call('export', { kind });
      const bin = atob(r.data), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u])); a.download = base + ext; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      if (kind === 'xlsx') { fileName = base + ext; dirty = false; MTRX.session.saved('sheets'); showTitle(); }
      msg('Saved ' + base + ext + (kind === 'csv' ? ' (CSV keeps values only, not formatting)' : ''));
    }
  } catch (e) { msg(String(e)); }
}
const save = () => saveFile(/\.csv$/i.test(fileName) ? 'csv' : 'xlsx', false);

// ---- formatting --------------------------------------------------------------------------------------------------------
const pref = (k, d) => (MTRX.prefs ? MTRX.prefs.get('sheets.' + k, d) : d);
const setPref = (k, v) => { if (MTRX.prefs) MTRX.prefs.set('sheets.' + k, v); };
// Ribbon tabs (Home / Data): show only the groups of the chosen tab; the choice is remembered
{
  const bar = document.getElementById('sh-ribtabs'), tools = document.getElementById('sh-tools');
  const showTab = (t) => {
    if (!bar || !tools) return;
    tools.dataset.stab = t;
    bar.querySelectorAll('button').forEach((b) => { const on = b.dataset.stab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  };
  if (bar) {
    bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-stab]'); if (b) { showTab(b.dataset.stab); setPref('ribtab', b.dataset.stab); } });
    const saved = pref('ribtab', 'home');
    showTab(saved === 'data' || saved === 'insert' ? saved : 'home');
  }
}
async function fmt(patch) {
  if (editing) return;
  await mutate('format', { rect: rectArr(selRect()), patch });
  selectionChanged(true);
}
const toggle = (flag) => fmt({ [flag]: !cur[flag] });
// Wrap text: turning it on also makes the rows tall enough for the wrapped lines (never shorter than they are), in the same undo step.
async function wrapToggle() {
  if (editing) return;
  const on = !cur.w, S = selRect(); let rows = [];
  if (on) {
    try {
      const used = (await call('view', { view: [[0, 0, 0, 0]] })).used;
      const r1 = Math.min(S.r1, used[0] - 1), area = (r1 - S.r0 + 1) * (S.c1 - S.c0 + 1);
      if (r1 >= S.r0 && area <= 50000) {
        const res = await call('view', { view: [[S.r0, S.c0, r1, S.c1]] });
        for (const id in res.styles) styles.set(+id, res.styles[id]);
        const need = new Map();
        for (const [r, c, t, k, sid] of res.cells) {
          if (k !== 1 || t === '') continue;
          const st = sid ? styles.get(sid) : undefined; ctx.save(); ctx.font = fontFor(st);
          const n = wrapLines(String(t), colW(c) - 12).length * lineH(st) + 7; ctx.restore();
          if (n > Math.max(need.get(r) || 0, rowH(r))) need.set(r, Math.min(n, 600));
        }
        rows = [...need];
      }
    } catch { /* heights are a nicety: wrap still goes on */ }
  }
  const fresh = rows.filter(([r]) => !rheights.has(r));
  await mutate('format', { rect: rectArr(S), patch: { w: on }, rows });
  for (const [r] of fresh) autoRows.add(r);
  selectionChanged(true);
}
// AutoFit for the selected columns / rows (from the menu; double-clicking a heading border does one)
function fitSelCols() { const s = selRect(); if (s.c1 - s.c0 > 500) return msg('Select fewer columns to fit them'); fitCols(Array.from({ length: s.c1 - s.c0 + 1 }, (_, k) => s.c0 + k)); }
async function fitSelRows() {
  const s = selRect(); let r1 = s.r1;
  try { r1 = Math.min(r1, (await call('view', { view: [[0, 0, 0, 0]] })).used[0] - 1); } catch { return; }
  if (r1 < s.r0) return; if (r1 - s.r0 > 500) return msg('Select fewer rows to fit them');
  fitRows(Array.from({ length: r1 - s.r0 + 1 }, (_, k) => s.r0 + k));
}
const setAlign = (a) => fmt({ a: cur.a === a ? null : a });
function nfSet(kind, dec) { return fmt({ nf: kind ? [kind, dec] : null }); }
function decimals(d) {
  const nf = cur.nf || [0, 0];
  const kind = nf[0] || 1, dec = nf[0] ? nf[1] : 0;
  const nd = clamp(dec + d, 0, 15);
  return nfSet(kind, nd);
}
function syncBar() {
  cur = styleAt(act.r, act.c) || {};
  const on = (id, v) => { const b = $(id); if (b) b.setAttribute('aria-pressed', v ? 'true' : 'false'); };
  on('#sh-b', cur.b); on('#sh-i', cur.i); on('#sh-u', cur.u); on('#sh-s', cur.s);
  on('#sh-wrap', cur.w); on('#sh-al', cur.a === 1); on('#sh-ac', cur.a === 2); on('#sh-ar', cur.a === 3);
  $('#sh-nf').value = String(cur.nf ? cur.nf[0] : 0);
  $('#sh-size').value = cur.z ? String(cur.z) : '';
  $('#sh-paint').classList.toggle('on', !!painter);
}

// colour palette
const PALETTE = [
  ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'],
  ['#c00000', '#ff0000', '#ff9900', '#ffff00', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0', '#32000c'],
  ['#e6b8b7', '#f8cbad', '#ffe699', '#fff2cc', '#c6e0b4', '#bdd7ee', '#b4c6e7', '#d9d2e9', '#e4dfec', '#f4cccc'],
  ['#d99694', '#f4b183', '#ffd966', '#ffe599', '#a9d08e', '#9dc3e6', '#8ea9db', '#b4a7d6', '#c9a0dc', '#ea9999'],
];
let pop = null;
function closePop() { if (pop) { pop.remove(); pop = null; } }
function openPop(anchor, build) {
  const was = pop && pop.dataset.for === anchor.id; closePop(); if (was) return;
  pop = document.createElement('div'); pop.className = 'sh-pop'; pop.dataset.for = anchor.id;
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  build(pop);
  document.body.appendChild(pop);
  const b = anchor.getBoundingClientRect();
  pop.style.left = Math.max(6, Math.min(b.left, innerWidth - pop.offsetWidth - 6)) + 'px'; pop.style.top = b.bottom + 4 + 'px';
  pop.style.maxHeight = Math.max(160, innerHeight - b.bottom - 14) + 'px'; pop.style.overflowY = 'auto';
}
document.addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target) && !e.target.closest('#sh-tools')) closePop(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) closePop(); }, true);

function colourPop(anchor, key, label) {
  openPop(anchor, (p) => {
    const none = document.createElement('button'); none.className = 'none'; none.textContent = label; none.onclick = () => { closePop(); fmt({ [key]: null }); }; p.appendChild(none);
    const g = document.createElement('div'); g.className = 'pal';
    for (const row of PALETTE) for (const c of row) {
      const s = document.createElement('button'); s.className = 'sw'; s.style.background = c; s.title = c; s.setAttribute('aria-label', c);
      s.onclick = () => { closePop(); useColour(key, c); }; g.appendChild(s);
    }
    p.appendChild(g);
    const cu = document.createElement('label'); cu.className = 'custom'; cu.textContent = 'More colours ';
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = pref('c.' + key, '#c00000');
    inp.onchange = () => { closePop(); useColour(key, inp.value); }; cu.appendChild(inp); p.appendChild(cu);
  });
}
function useColour(key, c) {
  setPref('c.' + key, c);
  $(key === 'c' ? '#sh-tcolor .bar' : '#sh-fill .bar').style.background = c;
  return fmt({ [key]: c });
}

// borders
let bLine = pref('bline', 1), bColor = pref('bcolor', '#000000');
const BMODES = [['all', 'All borders'], ['outer', 'Outside borders'], ['inner', 'Inside borders'], ['top', 'Top border'], ['bottom', 'Bottom border'], ['left', 'Left border'], ['right', 'Right border'], ['inner_h', 'Inside horizontal'], ['inner_v', 'Inside vertical'], ['none', 'No border']];
const BLINES = [[1, 'Thin'], [2, 'Medium'], [3, 'Thick'], [4, 'Dashed'], [5, 'Dotted'], [6, 'Double']];
function borderPop(anchor) {
  openPop(anchor, (p) => {
    for (const [m, t] of BMODES) { const b = document.createElement('button'); b.className = 'row'; b.textContent = t; b.onclick = () => { closePop(); borders(m); }; p.appendChild(b); }
    const hr = document.createElement('hr'); p.appendChild(hr);
    const ls = document.createElement('div'); ls.className = 'lines';
    for (const [n, t] of BLINES) { const b = document.createElement('button'); b.className = 'row' + (n === bLine ? ' sel' : ''); b.textContent = t; b.onclick = () => { bLine = n; setPref('bline', n); for (const x of ls.children) x.classList.remove('sel'); b.classList.add('sel'); }; ls.appendChild(b); }
    p.appendChild(ls);
    const cu = document.createElement('label'); cu.className = 'custom'; cu.textContent = 'Line colour ';
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = bColor;
    inp.onchange = () => { bColor = inp.value; setPref('bcolor', bColor); }; cu.appendChild(inp); p.appendChild(cu);
  });
}
async function borders(mode) {
  if (editing) return;
  await mutate('borders', { rect: rectArr(selRect()), mode, line: bLine, color: bColor });
  selectionChanged(true);
}

// format painter: click it, then select the cells to paint (double-click not needed: one use)
let painter = null;
function startPaint() { if (editing) return; painter = painter ? null : { r: act.r, c: act.c }; syncBar(); if (painter) msg('Now select the cells to give this look'); }
async function applyPaint() {
  const p = painter; painter = null;
  const s = selRect();
  await mutate('paint', { from: [p.r, p.c], rect: rectArr(s) });
  selectionChanged(true);
}
// ---- data: sort, filter, merge, freeze ----------------------------------------------------------------------------------
const frozen = () => frz[0] > 0 || frz[1] > 0;
// Sort the selected cells (one cell means the whole table around it) by the active cell's column
async function sortSel(asc) {
  if (editing) return;
  let rect = rectArr(selRect()), header, col = act.c;
  if (filt && single()) { rect = filt.rect; header = true; }
  else {
    try { const g = await call('region', { rect }); rect = g.rect; header = g.header; } catch (e) { msg(String(e)); return; }
  }
  col = clamp(col, rect[1], rect[3]);
  if (rect[0] === rect[2]) { msg('There is only one row, nothing to sort'); return; }
  const res = await mutate('sort', { rect, col, asc, header });
  if (res) { act = { r: rect[0], c: rect[1] }; tail = { r: rect[2], c: rect[3] }; selectionChanged(); msg(`Sorted by column ${colName(col)}, ${asc ? 'A to Z (smallest first)' : 'Z to A (largest first)'}${header ? '. The first row was kept as headings' : ''}`); }
}
async function mergeSel() {
  if (editing) return;
  const s = selRect(), b = mergeAt(act.r, act.c);
  if (single() && b) return unmergeSel();
  if (single()) { msg('Select two or more cells to merge'); return; }
  try { // only the top-left value survives: say so before clearing anything
    const st = await call('stats', { rect: rectArr(s) }), top = await call('input', { at: [s.r0, s.c0] });
    const lost = st.count - (top !== '' ? 1 : 0);
    if (lost > 0 && !confirm(`Merging keeps only the top-left value and clears ${lost} other ${lost === 1 ? 'cell' : 'cells'}. Continue?`)) return;
  } catch { /* the engine will answer the merge itself */ }
  const res = await mutate('merge', { rect: rectArr(s) });
  if (res && res.merged) { act = { r: res.merged[0], c: res.merged[1] }; tail = { r: res.merged[0], c: res.merged[1] }; selectionChanged(); }
}
async function unmergeSel() {
  if (editing) return;
  if (!merges.some((m) => { const s = selRect(); return m[0] <= s.r1 && s.r0 <= m[2] && m[1] <= s.c1 && s.c0 <= m[3]; })) { msg('There are no merged cells here'); return; }
  await mutate('unmerge', { rect: rectArr(selRect()) }); selectionChanged();
}
// Insert or delete whole rows / columns: as many as are selected (at least one). New ones go above / to the left of the selection.
async function insDel(rows, insert) {
  if (editing) return;
  // a whole row / column selection is taken as it is (merged cells do not widen it); a block of cells grows to cover merged cells it touches
  const raw = { r0: Math.min(act.r, tail.r), c0: Math.min(act.c, tail.c), r1: Math.max(act.r, tail.r), c1: Math.max(act.c, tail.c) };
  const s = (raw.c0 === 0 && raw.c1 === MAXC - 1) || (raw.r0 === 0 && raw.r1 === MAXR - 1) ? raw : selRect(), at = rows ? s.r0 : s.c0, n = rows ? s.r1 - s.r0 + 1 : s.c1 - s.c0 + 1, what = rows ? (n === 1 ? 'row' : 'rows') : (n === 1 ? 'column' : 'columns');
  if (insert && n > 1000) return msg(`Select fewer ${rows ? 'rows' : 'columns'} to insert, that is too many at once`);
  const res = await mutate((insert ? 'insert_' : 'delete_') + (rows ? 'rows' : 'cols'), { at, count: n });
  if (!res) return;
  selectionChanged();
  const where = rows ? 'row ' + (at + 1) : 'column ' + colName(at);
  msg(`${insert ? 'Inserted' : 'Deleted'} ${n} ${what}${insert ? (n === 1 ? ' at ' : ' from ') + where : ''}. Ctrl+Z undoes it`);
}
// Ctrl+Shift+= / Ctrl+-: whole columns selected means columns, otherwise rows
const insDelKey = (insert) => { const s = selRect(); return insDel(!(s.r0 === 0 && s.r1 === MAXR - 1 && !(s.c0 === 0 && s.c1 === MAXC - 1)), insert); };
async function freeze(rows, cols) {
  if (editing) return;
  if (!rows && !cols) { if (frozen()) { await mutate('freeze', { rows: 0, cols: 0 }); msg('Panes unfrozen'); } else msg('Nothing is frozen'); return; }
  const res = await mutate('freeze', { rows, cols });
  if (res) { scroll.scrollTop = 0; scroll.scrollLeft = 0; redraw(); msg(`Frozen: ${rows ? rows + (rows === 1 ? ' row' : ' rows') : ''}${rows && cols ? ' and ' : ''}${cols ? cols + (cols === 1 ? ' column' : ' columns') : ''}`); }
}
// freeze everything above and to the left of the active cell
const freezeHere = () => (act.r === 0 && act.c === 0 ? (frozen() ? freeze(0, 0) : msg('Click the cell below and to the right of what should stay in view, then freeze')) : freeze(act.r, act.c));
async function filterToggle() {
  if (editing) return;
  if (filt) { await mutate('filter_off'); msg('Filter off. Every row is showing'); return; }
  const res = await mutate('filter_on', { rect: rectArr(selRect()) });
  if (res && res.filter) msg('Filter on: use the arrows in the heading row');
}
let fpop = null;
function closeFilter() { if (fpop) { fpop.remove(); fpop = null; } }
async function openFilter(c) {
  closeFilter();
  let info;
  try { info = await call('filter_values', { col: c }); } catch (e) { msg(String(e)); return; }
  const list = info.values, allowed = info.allowed ? new Set(info.allowed) : null;
  const on = new Set(list.filter(([v]) => !allowed || allowed.has(v)).map(([v]) => v));
  const p = fpop = document.createElement('div'); p.className = 'sh-pop sh-filter'; p.dataset.for = 'filter';
  p.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
  const add = (el) => { p.appendChild(el); return el; };
  const btn = (txt, fn, cls) => { const b = document.createElement('button'); b.className = cls || 'row'; b.textContent = txt; b.onclick = fn; return add(b); };
  btn('Sort A to Z (smallest first)', () => { closeFilter(); sortByFilter(c, true); });
  btn('Sort Z to A (largest first)', () => { closeFilter(); sortByFilter(c, false); });
  if (allowed) btn(`Clear the filter on column ${colName(c)}`, async () => { closeFilter(); await mutate('filter_set', { col: c, allowed: null }); selectionChanged(); });
  add(document.createElement('hr'));
  const q = add(document.createElement('input')); q.className = 'fq'; q.placeholder = 'Search'; q.setAttribute('aria-label', 'Search values'); q.spellcheck = false;
  const box = add(document.createElement('div')); box.className = 'fl';
  const ok = document.createElement('button');
  const shown = () => list.filter(([v]) => !q.value || (v === '' ? '(blank)' : v).toLowerCase().includes(q.value.toLowerCase()));
  const draw = () => {
    box.replaceChildren();
    const s = shown(), all = s.length > 0 && s.every(([v]) => on.has(v));
    const mk = (label, checked, fn, extra) => {
      const l = document.createElement('label'); const i = document.createElement('input'); i.type = 'checkbox'; i.checked = checked; i.onchange = () => { fn(i.checked); draw(); };
      l.append(i, document.createTextNode(' ' + label)); if (extra) { const n = document.createElement('span'); n.textContent = extra; l.appendChild(n); } box.appendChild(l);
    };
    mk('(Select all)', all, (v) => s.forEach(([x]) => (v ? on.add(x) : on.delete(x))));
    for (const [v, n] of s) mk(v === '' ? '(blank)' : v, on.has(v), (chk) => (chk ? on.add(v) : on.delete(v)), String(n));
    ok.disabled = on.size === 0;
  };
  q.addEventListener('input', draw);
  const row = add(document.createElement('div')); row.className = 'fb';
  ok.className = 'ok'; ok.textContent = 'OK';
  ok.onclick = async () => {
    closeFilter();
    const all = list.every(([v]) => on.has(v));
    await mutate('filter_set', { col: c, allowed: all ? null : [...on] }); selectionChanged();
  };
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.onclick = closeFilter;
  row.append(cancel, ok);
  p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFilter(); keys.focus(); } else if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); ok.click(); } });
  draw();
  document.body.appendChild(p);
  const b = cv.getBoundingClientRect();
  p.style.left = Math.max(6, Math.min(b.left + pxs(c), innerWidth - p.offsetWidth - 6)) + 'px';
  p.style.top = Math.max(6, Math.min(b.top + pys(filt.rect[0]) + rowH(filt.rect[0]), innerHeight - p.offsetHeight - 6)) + 'px';
  q.focus();
}
document.addEventListener('mousedown', (e) => { if (fpop && !fpop.contains(e.target) && e.target !== cv) closeFilter(); }, true);
async function sortByFilter(c, asc) {
  const res = await mutate('sort', { rect: filt.rect, col: c, asc, header: true });
  if (res) { selectionChanged(); msg(`Sorted by column ${colName(c)}`); }
}
async function clearFormat() { if (editing) return; await mutate('clear_format', { rect: rectArr(selRect()) }); selectionChanged(true); }

// ---- show / wire up ----------------------------------------------------------------------------------------------------
function showSheets() {
  document.body.classList.remove('home', 'pdf'); document.body.classList.add('sheets');
  call('tz', { minutes: -new Date().getTimezoneOffset() }).catch(() => {}).then(() => refresh());
  sizeSpacer(); requestAnimationFrame(() => { resize(); refresh(); selectionChanged(); keys.focus(); });
}
MTRX.showSheets = showSheets;
// ---- charts: drawn as little pictures floating over the grid ------------------------------------------------------
// The engine owns the charts (kind, title, data block, corner cell, size) and sends them with every view, already
// read from the cells. Here they are drawn as SVG, moved and resized with the mouse, and edited with a small dialog.
const xe = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const CHART_KINDS = ['Column chart', 'Line chart', 'Pie chart', 'Bar chart (horizontal)', 'Stacked column chart', 'Area chart'];
const DEF_PAL = ['8C2F4A', '2F6F8F', 'D99A2B', '4F8A5B', '7A5BA6', 'C4572B', '5B7C99', '9A8F3C'];

function niceTicks(lo, hi) {
  if (lo > 0) lo = 0; if (hi < 0) hi = 0; if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / 5, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p, step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step, t = [];
  for (let v = a; v <= b + step / 2; v += step) t.push(+v.toPrecision(12));
  return t;
}
const tickText = (v) => (Number.isInteger(v) ? v.toLocaleString('en-US') : String(+v.toPrecision(4)));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function chartSvg(c) {
  const W_ = c.w, H_ = c.h, pal = c.palette.map((h) => '#' + h), ser = c.series, pie = c.kind === 2;
  const n = Math.max(c.cats.length, ...ser.map((s) => s.vals.length), 0);
  const label = (i) => (c.cats[i] !== undefined && c.cats[i] !== '' ? c.cats[i] : String(i + 1));
  let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W_} ${H_}" width="${W_}" height="${H_}" font-family="Segoe UI, system-ui, sans-serif"><rect width="${W_}" height="${H_}" fill="#fff"/>`;
  if (c.title) o += `<text x="${W_ / 2}" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#32000c">${xe(cut(c.title, Math.max(8, Math.floor(W_ / 8.5))))}</text>`;
  if (!ser.length || !n) return o + `<text x="${W_ / 2}" y="${H_ / 2}" text-anchor="middle" font-size="13" fill="#7a6a6e">There is no data to draw</text></svg>`;
  // legend along the bottom, wrapping
  const items = pie ? Array.from({ length: n }, (_, i) => ({ name: label(i), color: pal[i % pal.length] })) : ser.map((s, i) => ({ name: s.name, color: pal[i % pal.length] }));
  let legend = '', lh = 0;
  if (pie || ser.length > 1) {
    let x = 12, y = H_ - 10, rows = [[]];
    for (const it of items) { const w = 22 + Math.min(it.name.length, 18) * 6.6 + 10; if (x + w > W_ - 8 && rows[rows.length - 1].length) { rows.push([]); x = 12; } rows[rows.length - 1].push({ it, x }); x += w; }
    rows = rows.slice(0, 3); lh = rows.length * 17 + 6;
    rows.forEach((r, ri) => r.forEach(({ it, x }) => { const yy = H_ - lh + 6 + ri * 17; legend += `<rect x="${x}" y="${yy}" width="11" height="11" rx="2" fill="${it.color}"/><text x="${x + 16}" y="${yy + 10}" font-size="11.5" fill="#4a2a32">${xe(cut(it.name, 18))}</text>`; }));
  }
  const top = c.title ? 40 : 16, bottom = H_ - lh - 8;
  if (pie) {
    const vals = (ser[0].vals).map((v) => (v !== null && v > 0 ? v : 0)), total = vals.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return o + `<text x="${W_ / 2}" y="${H_ / 2}" text-anchor="middle" font-size="13" fill="#7a6a6e">Nothing to show: the numbers must be above zero</text>${legend}</svg>`;
    const cx = W_ / 2, cy = (top + bottom) / 2, r = Math.max(10, Math.min(W_ - 40, bottom - top - 8) / 2);
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      if (!v) return;
      const frac = v / total, a1 = a0 + frac * Math.PI * 2, col = pal[i % pal.length], tip = `<title>${xe(label(i))}: ${tickText(v)} (${(frac * 100).toFixed(1)}%)</title>`;
      if (frac > 0.9999) o += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}" stroke="#fff" stroke-width="1.5">${tip}</circle>`;
      else { const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1); o += `<path d="M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${col}" stroke="#fff" stroke-width="1.5">${tip}</path>`; }
      if (frac >= 0.06) { const am = (a0 + a1) / 2; o += `<text x="${(cx + r * 0.62 * Math.cos(am)).toFixed(1)}" y="${(cy + r * 0.62 * Math.sin(am) + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="#fff" pointer-events="none">${Math.round(frac * 100)}%</text>`; }
      a0 = a1;
    });
    return o + legend + '</svg>';
  }
  // axes
  const all = ser.flatMap((s) => s.vals).filter((v) => v !== null);
  if (!all.length) return o + `<text x="${W_ / 2}" y="${H_ / 2}" text-anchor="middle" font-size="13" fill="#7a6a6e">There are no numbers to draw</text>${legend}</svg>`;
  const horiz = c.kind === 3, stack = c.kind === 4, area = c.kind === 5;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (stack) {
    lo = 0; hi = 0;
    for (let i = 0; i < n; i++) { let p = 0, q = 0; for (const s of ser) { const v = s.vals[i]; if (v > 0) p += v; else if (v < 0) q += v; } hi = Math.max(hi, p); lo = Math.min(lo, q); }
  }
  const ticks = niceTicks(lo, hi), t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const xT = c.xTitle || '', yT = c.yTitle || '', bt = horiz ? yT : xT, lt = horiz ? xT : yT;
  const lw = Math.max(...Array.from({ length: n }, (_, i) => Math.min(12, label(i).length))) * 6.4 + 8, vtw = Math.max(...ticks.map((t) => tickText(t).length)) * 6.6 + 6;
  const left = 12 + (lt ? 16 : 0) + (horiz ? lw : vtw), right = W_ - 14, catH = 22, ptop = top, pbot = bottom - catH - (bt ? 16 : 0);
  if (right - left < 20 || pbot - ptop < 20) return o + `<text x="${W_ / 2}" y="${H_ / 2}" text-anchor="middle" font-size="13" fill="#7a6a6e">Make the chart bigger</text></svg>`;
  if (bt) o += `<text x="${((left + right) / 2).toFixed(1)}" y="${bottom - 4}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#4a2a32">${xe(cut(bt, 40))}</text>`;
  if (lt) o += `<text transform="rotate(-90)" x="${(-(ptop + pbot) / 2).toFixed(1)}" y="17" text-anchor="middle" font-size="11.5" font-weight="600" fill="#4a2a32">${xe(cut(lt, 40))}</text>`;
  const tip = (s, i, v) => `<title>${xe(s.name)}, ${xe(label(i))}: ${tickText(v)}</title>`;
  if (horiz) {
    const X = (v) => left + ((v - t0) / (t1 - t0)) * (right - left), bh = (pbot - ptop) / n;
    for (const t of ticks) o += `<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${ptop}" y2="${pbot}" stroke="${t === 0 ? '#9a8a8e' : '#e8dde0'}"/><text x="${X(t).toFixed(1)}" y="${pbot + 15}" text-anchor="middle" font-size="11" fill="#6b5b5f">${tickText(t)}</text>`;
    const step = Math.max(1, Math.ceil(14 / bh));
    for (let i = 0; i < n; i += step) o += `<text x="${left - 6}" y="${(ptop + (i + 0.5) * bh + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b5b5f">${xe(cut(label(i), 12))}</text>`;
    const gh = bh * 0.72, per = gh / ser.length;
    ser.forEach((s, si) => s.vals.forEach((v, i) => {
      if (v === null) return;
      const y = ptop + i * bh + (bh - gh) / 2 + si * per, x = X(Math.min(v, 0)), w = Math.max(1, Math.abs(X(v) - X(0)));
      o += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, per - 1).toFixed(1)}" fill="${pal[si % pal.length]}">${tip(s, i, v)}</rect>`;
    }));
    return o + legend + '</svg>';
  }
  const Y = (v) => pbot - ((v - t0) / (t1 - t0)) * (pbot - ptop), bw = (right - left) / n;
  for (const t of ticks) o += `<line x1="${left}" x2="${right}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="${t === 0 ? '#9a8a8e' : '#e8dde0'}"/><text x="${left - 6}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b5b5f">${tickText(t)}</text>`;
  const step = Math.max(1, Math.ceil((Math.min(12, Math.max(...Array.from({ length: n }, (_, i) => label(i).length))) * 6.4) / bw));
  for (let i = 0; i < n; i += step) o += `<text x="${(left + (i + 0.5) * bw).toFixed(1)}" y="${pbot + 15}" text-anchor="middle" font-size="11" fill="#6b5b5f">${xe(cut(label(i), 12))}</text>`;
  if (c.kind === 0) {
    const gw = bw * 0.72, per = gw / ser.length;
    ser.forEach((s, si) => s.vals.forEach((v, i) => {
      if (v === null) return;
      const x = left + i * bw + (bw - gw) / 2 + si * per, y = Y(Math.max(v, 0)), h = Math.max(1, Math.abs(Y(v) - Y(0)));
      o += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, per - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${pal[si % pal.length]}">${tip(s, i, v)}</rect>`;
    }));
  } else if (stack) {
    const gw = bw * 0.72, pos = new Array(n).fill(0), neg = new Array(n).fill(0);
    ser.forEach((s, si) => s.vals.forEach((v, i) => {
      if (v === null || v === 0) return;
      const from = v > 0 ? pos[i] : neg[i], to = from + v;
      if (v > 0) pos[i] = to; else neg[i] = to;
      o += `<rect x="${(left + i * bw + (bw - gw) / 2).toFixed(1)}" y="${Math.min(Y(from), Y(to)).toFixed(1)}" width="${gw.toFixed(1)}" height="${Math.max(1, Math.abs(Y(to) - Y(from))).toFixed(1)}" fill="${pal[si % pal.length]}" stroke="#fff" stroke-width=".8">${tip(s, i, v)}</rect>`;
    }));
  } else if (area) {
    ser.forEach((s, si) => {
      const col = pal[si % pal.length]; let run = [], line = '', fill = '';
      const flush = () => { if (run.length) { const f = run[0][0], l = run[run.length - 1][0]; fill += 'M' + f + ',' + Y(0).toFixed(1) + run.map((p) => 'L' + p[0] + ',' + p[1]).join('') + 'L' + l + ',' + Y(0).toFixed(1) + 'Z'; line += 'M' + run.map((p) => p[0] + ',' + p[1]).join('L'); } run = []; };
      s.vals.forEach((v, i) => { if (v === null) return flush(); run.push([(left + (i + 0.5) * bw).toFixed(1), Y(v).toFixed(1)]); });
      flush();
      o += `<path d="${fill}" fill="${col}" fill-opacity=".55"/><path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
      s.vals.forEach((v, i) => { if (v !== null) o += `<circle cx="${(left + (i + 0.5) * bw).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="5" fill="${col}" fill-opacity="0">${tip(s, i, v)}</circle>`; });
    });
  } else {
    ser.forEach((s, si) => {
      const col = pal[si % pal.length]; let d = '', pen = false, dots = '';
      s.vals.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        const x = (left + (i + 0.5) * bw).toFixed(1), y = Y(v).toFixed(1);
        d += (pen ? 'L' : 'M') + x + ',' + y; pen = true;
        dots += `<circle cx="${x}" cy="${y}" r="3.5" fill="${col}" stroke="#fff" stroke-width="1">${tip(s, i, v)}</circle>`;
      });
      o += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>${dots}`;
    });
  }
  return o + legend + '</svg>';
}

function mkChartEl(id) {
  const el = document.createElement('div'); el.className = 'sh-chart'; el.dataset.id = id;
  el.innerHTML = '<div class="cv"></div>' + ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<i class="hd hd-${h}" data-h="${h}"></i>`).join('');
  el.addEventListener('mousedown', async (e) => {
    if (e.button === 1) return;
    e.preventDefault(); e.stopPropagation(); closeFilter(); closePop();
    if (editing) await commit(0, 0);
    selChart = id; placeCharts(); keys.focus();
    if (e.button !== 0) return;
    const o = chartEls.get(id); if (!o) return;
    cdrag = { id, mode: e.target.dataset.h || 'move', x0: e.clientX, y0: e.clientY, l: parseFloat(el.style.left), t: parseFloat(el.style.top), w: o.c.w, h: o.c.h, moved: false };
  });
  el.addEventListener('dblclick', (e) => { e.preventDefault(); editChart(id); });
  return el;
}
function drawCharts() {
  const live = new Set(charts.map((c) => c.id));
  for (const [id, o] of chartEls) if (!live.has(id)) { o.el.remove(); chartEls.delete(id); }
  if (!live.has(selChart)) selChart = 0;
  for (const c of charts) {
    let o = chartEls.get(c.id);
    if (!o) { o = { el: mkChartEl(c.id), sig: '', c }; chartEls.set(c.id, o); chartLayer.appendChild(o.el); }
    o.c = c;
    const sig = JSON.stringify([c.kind, c.title, c.cats, c.series, c.w, c.h, c.palette, c.xTitle, c.yTitle]);
    if (o.sig !== sig) { o.el.querySelector('.cv').innerHTML = chartSvg(c); o.sig = sig; }
  }
  placeCharts();
}
function placeCharts() {
  chartLayer.style.left = HDR_W + 'px'; chartLayer.style.top = HDR_H + 'px';
  for (const [id, o] of chartEls) {
    const c = o.c, el = o.el;
    el.classList.toggle('sel', id === selChart);
    if (cdrag && cdrag.id === id && cdrag.moved) continue; // being dragged: the mouse decides
    el.style.left = pxs(c.ac) - HDR_W + c.ox + 'px'; el.style.top = pys(c.ar) - HDR_H + c.oy + 'px'; el.style.width = c.w + 'px'; el.style.height = c.h + 'px';
  }
}
window.addEventListener('mousemove', (e) => {
  if (!cdrag) return;
  const o = chartEls.get(cdrag.id); if (!o) { cdrag = null; return; }
  const dx = e.clientX - cdrag.x0, dy = e.clientY - cdrag.y0;
  if (!cdrag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
  cdrag.moved = true;
  let { l, t, w, h } = cdrag; const m = cdrag.mode;
  if (m === 'move') { l += dx; t += dy; }
  else {
    if (m.includes('e')) w = cdrag.w + dx;
    if (m.includes('s')) h = cdrag.h + dy;
    if (m.includes('w')) { w = cdrag.w - dx; l = cdrag.l + dx; }
    if (m.includes('n')) { h = cdrag.h - dy; t = cdrag.t + dy; }
    if (w < 160) { if (m.includes('w')) l -= 160 - w; w = 160; }
    if (h < 120) { if (m.includes('n')) t -= 120 - h; h = 120; }
    w = Math.min(w, 4000); h = Math.min(h, 4000);
  }
  const el = o.el; el.style.left = l + 'px'; el.style.top = t + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
  cdrag.now = { l, t, w, h };
});
window.addEventListener('mouseup', async () => {
  const d = cdrag; if (!d) return; cdrag = null;
  if (!d.moved || !d.now) return;
  const { l, t, w, h } = d.now, X = Math.max(HDR_W, l + HDR_W), Y = Math.max(HDR_H, t + HDR_H), at = cellAtXY(X, Y);
  await mutate('chart_set', { id: d.id, ar: at.r, ac: at.c, ox: Math.max(0, Math.round(X - pxs(at.c))), oy: Math.max(0, Math.round(Y - pys(at.r))), w: Math.round(w), h: Math.round(h) });
  placeCharts();
});
function selectChart(id) { selChart = id; placeCharts(); }
async function delChart() {
  if (!selChart || editing) return;
  const id = selChart; selChart = 0;
  if (await mutate('chart_del', { id })) msg('Chart deleted. Ctrl+Z brings it back');
}
const a1 = (r, c) => colName(c) + (r + 1);
function parseA1(s) { const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(s.trim()); return m ? { r: +m[2] - 1, c: colNum(m[1]) } : null; }
async function insertChart(kind) {
  if (editing) return;
  const s = selRect(); let rect = [s.r0, s.c0, s.r1, s.c1];
  try {
    if (single()) rect = (await call('region', { rect: rectArr(s) })).rect;
    const used = (await call('view', { view: [0, 0, 0, 0] })).used; // never chart the empty rest of a whole-column selection
    rect = [rect[0], rect[1], Math.min(rect[2], Math.max(0, used[0] - 1)), Math.min(rect[3], Math.max(0, used[1] - 1))];
  } catch (e) { return msg(String(e)); }
  if ((rect[2] - rect[0] + 1) * (rect[3] - rect[1] + 1) < 2) return msg('Type some data first, then select it (numbers with their labels) and insert the chart');
  const ac = Math.min(MAXC - 1, rect[3] + 2), res = await mutate('chart_add', { kind, rect, ar: rect[0], ac });
  if (!res) return;
  selectChart(res.chart);
  ensureVisible(rect[0], colAt(colX(ac) + 420));
  msg('Chart added. Drag it to move, drag its corners to resize, press Delete to remove it, double-click to change it');
}
// ---- data validation: a rule on some cells says what may be typed there; list rules get a drop-down arrow ----------------------------
let ddPop = null;
function closeDropdown() { if (ddPop) { ddPop.remove(); ddPop = null; } }
function openDropdown() {
  closeDropdown();
  const rule = listRuleAt(act.r, act.c); if (!rule || editing) return;
  const b = cv.getBoundingClientRect(), p = ddPop = document.createElement('div'); p.className = 'sh-pop sh-dd'; p.setAttribute('role', 'listbox');
  p.style.cssText = `position:fixed;left:${b.left + pxs(act.c)}px;top:${b.top + pys(act.r) + rowH(act.r)}px;min-width:${Math.max(colW(act.c), 120)}px;max-height:240px;overflow:auto;z-index:70`;
  const [r, c] = [act.r, act.c];
  for (const it of rule.items) {
    const o = document.createElement('div'); o.className = 'dd-item'; o.setAttribute('role', 'option'); o.textContent = it;
    o.addEventListener('mousedown', async (e) => { e.preventDefault(); closeDropdown(); await mutate('set', { edits: [[r, c, it]] }); selectionChanged(); keys.focus(); });
    p.appendChild(o);
  }
  document.body.appendChild(p);
}
document.addEventListener('mousedown', (e) => { if (ddPop && !ddPop.contains(e.target)) closeDropdown(); }, true);

function validDlg() {
  if (editing) return;
  const s = selRect(), cur = ruleAt(act.r, act.c);
  const bg = document.createElement('div'); bg.className = 'sh-dlg-bg';
  const d = document.createElement('div'); d.className = 'sh-dlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Data validation');
  const kinds = [['', 'Anything'], ['list', 'A list of entries'], ['whole', 'Whole number'], ['decimal', 'Number (decimals allowed)']];
  d.innerHTML = `<h3>Data validation</h3>
    <p style="margin:0 0 10px">For ${cellName(s.r0, s.c0)}${single() ? '' : ':' + cellName(s.r1, s.c1)}. Entries that do not fit are refused.</p>
    <label>Allow<select id="dv-kind">${kinds.map(([v, t]) => `<option value="${v}"${cur && cur.kind === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="dv-list">Entries (one per line, or separated by commas)<textarea id="dv-items" rows="4" spellcheck="false" style="width:100%;box-sizing:border-box;margin-top:4px;border:1px solid #d9c4ca;border-radius:7px;padding:6px 8px;font:13px 'Segoe UI',system-ui,sans-serif">${xe(cur && cur.kind === 'list' ? cur.items.join('\n') : '')}</textarea></label>
    <label class="dv-num">Lowest value (optional)<input id="dv-min" spellcheck="false" value="${cur && cur.min != null ? cur.min : ''}"></label>
    <label class="dv-num">Highest value (optional)<input id="dv-max" spellcheck="false" value="${cur && cur.max != null ? cur.max : ''}"></label>
    <label>Message when refused (optional)<input id="dv-msg" maxlength="200" spellcheck="false" value="${xe(cur ? cur.msg : '')}"></label>
    <p class="err" id="dv-err" hidden></p>
    <div class="btns"><button class="btn" id="dv-cancel">Cancel</button><button class="btn primary" id="dv-ok">OK</button></div>`;
  bg.appendChild(d); document.body.appendChild(bg);
  const q = (x) => d.querySelector(x), close = () => { bg.remove(); keys.focus(); };
  const sync = () => { const k = q('#dv-kind').value; d.querySelectorAll('.dv-list').forEach((l) => { l.hidden = k !== 'list'; }); d.querySelectorAll('.dv-num').forEach((l) => { l.hidden = k !== 'whole' && k !== 'decimal'; }); q('#dv-msg').closest('label').hidden = !k; };
  q('#dv-kind').addEventListener('change', sync); sync();
  const ok = async () => {
    const kind = q('#dv-kind').value, num = (v) => (v.trim() === '' ? null : Number(v.trim().replace(',', '.')));
    const items = q('#dv-items').value.split(/[\n,;]/).map((x) => x.trim()).filter(Boolean), min = num(q('#dv-min').value), max = num(q('#dv-max').value);
    const bad = (t) => { const er = q('#dv-err'); er.hidden = false; er.textContent = t; };
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) return bad('Lowest and highest must be numbers');
    close();
    await mutate('valid_set', { rect: rectArr(s), kind, items, min, max, msg: q('#dv-msg').value });
    selectionChanged();
  };
  q('#dv-ok').onclick = ok; q('#dv-cancel').onclick = close;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  d.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); ok(); } });
  q('#dv-kind').focus();
}

// ---- print: the selected cells, or everything that has data, laid out as a plain table on paper ------------------------------------
async function printSheet() {
  if (editing) return;
  let r0 = 0, c0 = 0, r1, c1;
  try {
    if (single()) { const u = (await call('view', { view: [0, 0, 0, 0] })).used; r1 = u[0] - 1; c1 = u[1] - 1; }
    else { const s = selRect(); [r0, c0, r1, c1] = rectArr(s); const u = (await call('view', { view: [0, 0, 0, 0] })).used; r1 = Math.min(r1, u[0] - 1); c1 = Math.min(c1, u[1] - 1); }
  } catch (e) { return msg(String(e)); }
  if (r1 < r0 || c1 < c0) return msg('There is nothing to print yet');
  if (r1 - r0 > 5000 || c1 - c0 > 60) { r1 = Math.min(r1, r0 + 5000); c1 = Math.min(c1, c0 + 60); msg('That is a big sheet: printing the first ' + (r1 - r0 + 1) + ' rows and ' + (c1 - c0 + 1) + ' columns'); }
  let res; try { res = await call('view', { view: [r0, c0, r1, c1] }); } catch (e) { return msg(String(e)); }
  const grid = new Map(); for (const [r, c, t, k, s] of res.cells) grid.set(r * MAXC + c, [t, k, s]);
  const hid = new Set(); for (const [a, b] of res.hidden || []) for (let r = a; r <= b && r <= r1; r++) hid.add(r);
  let html = '<table>';
  for (let r = r0; r <= r1; r++) {
    if (hid.has(r)) continue;
    html += '<tr>';
    for (let c = c0; c <= c1; c++) {
      const g = grid.get(r * MAXC + c), t = g ? g[0] : '', st = g && res.styles[g[2]] || {};
      const num = g && /^-?[\d.,]+%?$/.test(String(t).trim());
      const al = st.a === 3 || (!st.a && num) ? 'right' : st.a === 2 ? 'center' : '';
      html += `<td style="${al ? 'text-align:' + al + ';' : ''}${st.b ? 'font-weight:700;' : ''}${st.i ? 'font-style:italic;' : ''}${st.c ? 'color:' + st.c + ';' : ''}${st.f ? 'background:' + st.f + ';-webkit-print-color-adjust:exact;print-color-adjust:exact;' : ''}">${xe(String(t))}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  let host = document.getElementById('sh-print'); if (!host) { host = document.createElement('div'); host.id = 'sh-print'; document.body.appendChild(host); }
  host.innerHTML = `<h4>${xe($('#doc-title') ? $('#doc-title').textContent : 'Sheet')}</h4>` + html;
  document.body.classList.add('printing-sheet');
  const done = () => { document.body.classList.remove('printing-sheet'); host.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

// ---- typed column width / row height, and insert / delete cells that shift their neighbours -----------------------------------------
function sizeDlg(cols) {
  if (editing) return;
  const s = selRect(), idx = cols ? Array.from({ length: Math.min(s.c1 - s.c0 + 1, 2000) }, (_, k) => s.c0 + k) : Array.from({ length: Math.min(s.r1 - s.r0 + 1, 2000) }, (_, k) => s.r0 + k);
  const now = cols ? colW(idx[0]) : rowH(idx[0]), unit = cols ? 7 : 1, shown = Math.round(now / unit * 10) / 10;
  const bg = document.createElement('div'); bg.className = 'sh-dlg-bg';
  const d = document.createElement('div'); d.className = 'sh-dlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', cols ? 'Column width' : 'Row height');
  d.innerHTML = `<h3>${cols ? 'Column width' : 'Row height'}</h3><label>${cols ? 'Width in characters (about 8.4 is normal)' : 'Height in pixels (about ' + ROW_H + ' is normal)'}<input id="sz-v" spellcheck="false" value="${shown}"></label><p class="err" id="sz-err" hidden></p><div class="btns"><button class="btn" id="sz-reset">Back to normal</button><button class="btn" id="sz-cancel">Cancel</button><button class="btn primary" id="sz-ok">OK</button></div>`;
  bg.appendChild(d); document.body.appendChild(bg);
  const q = (x) => d.querySelector(x), close = () => { bg.remove(); keys.focus(); };
  const apply = async (v) => { close(); const list = idx.map((i) => [i, v]); await mutate('size', cols ? { cols: list } : { rows: list }); if (cols) await refitWrappedIn(idx); else idx.forEach((r) => autoRows.delete(r)); placeEditor(); };
  const ok = () => {
    const n = Number(q('#sz-v').value.trim().replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n * unit > 2000) { const er = q('#sz-err'); er.hidden = false; er.textContent = 'Type a number above 0'; return; }
    apply(Math.round(n * unit));
  };
  q('#sz-ok').onclick = ok; q('#sz-cancel').onclick = close; q('#sz-reset').onclick = () => apply(null);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  d.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); ok(); } });
  q('#sz-v').focus(); q('#sz-v').select();
}
function shiftDlg(insert) {
  if (editing) return;
  const s = selRect(), name = cellName(s.r0, s.c0) + (single() ? '' : ':' + cellName(s.r1, s.c1));
  const bg = document.createElement('div'); bg.className = 'sh-dlg-bg';
  const d = document.createElement('div'); d.className = 'sh-dlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', insert ? 'Insert cells' : 'Delete cells');
  d.innerHTML = `<h3>${insert ? 'Insert cells' : 'Delete cells'}</h3><p style="margin:0 0 10px">${insert ? 'Make room at' : 'Remove'} ${name}. What happens to the cells next to it?</p>
    <label class="chk"><input type="radio" name="sd" value="down" checked> Shift cells ${insert ? 'down' : 'up'}</label>
    <label class="chk"><input type="radio" name="sd" value="right"> Shift cells ${insert ? 'right' : 'left'}</label>
    <div class="btns"><button class="btn" id="sd-cancel">Cancel</button><button class="btn primary" id="sd-ok">OK</button></div>`;
  bg.appendChild(d); document.body.appendChild(bg);
  const q = (x) => d.querySelector(x), close = () => { bg.remove(); keys.focus(); };
  const ok = async () => {
    const dir = d.querySelector('input[name=sd]:checked').value; close();
    const res = await mutate(insert ? 'cells_insert' : 'cells_delete', { rect: rectArr(s), dir });
    if (res) { selectionChanged(); msg((insert ? 'Cells inserted' : 'Cells deleted') + '. Ctrl+Z undoes it'); }
  };
  q('#sd-ok').onclick = ok; q('#sd-cancel').onclick = close;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  d.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Enter') { e.preventDefault(); ok(); } });
  q('#sd-ok').focus();
}

// ---- find and replace (Ctrl+F / Ctrl+H): a small box that stays open beside the grid ----------------------------------------------
let findBox = null;
function findReplace(replaceMode) {
  if (editing) return;
  if (findBox) { findBox.q('#fr-find').focus(); findBox.q('#fr-find').select(); if (replaceMode) findBox.q('#fr-with').closest('label').hidden = false; return; }
  const bg = document.createElement('div'); bg.className = 'sh-dlg-bg find';
  const d = document.createElement('div'); d.className = 'sh-dlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Find and replace');
  const inSel = !single();
  d.innerHTML = `<h3>Find and replace</h3>
    <label>Find<input id="fr-find" spellcheck="false" maxlength="200"></label>
    <label>Replace with<input id="fr-with" spellcheck="false" maxlength="200"></label>
    <label class="chk"><input id="fr-case" type="checkbox"> Match case</label>
    <label class="chk"><input id="fr-whole" type="checkbox"> Match the whole cell</label>
    <label class="chk"><input id="fr-form" type="checkbox"> Look inside formulas</label>
    <label class="chk"><input id="fr-sel" type="checkbox"${inSel ? ' checked' : ''}${inSel ? '' : ' disabled'}> Only the selected cells</label>
    <p class="err" id="fr-msg" aria-live="polite" style="color:#7a4a56;min-height:16px"></p>
    <div class="btns"><button class="btn" id="fr-next">Find next</button><button class="btn" id="fr-rep">Replace</button><button class="btn" id="fr-all">Replace all</button><button class="btn primary" id="fr-close">Close</button></div>`;
  bg.appendChild(d); document.body.appendChild(bg);
  const q = (s) => d.querySelector(s), say = (t) => { q('#fr-msg').textContent = t; };
  const close = () => { bg.remove(); findBox = null; keys.focus(); };
  const base = () => {
    const o = { query: q('#fr-find').value, matchCase: q('#fr-case').checked, wholeCell: q('#fr-whole').checked, formulas: q('#fr-form').checked };
    if (q('#fr-sel').checked && !q('#fr-sel').disabled && area) o.rect = area;
    return o;
  };
  let area = inSel ? rectArr(selRect()) : null;
  const find = async () => { try { return await call('find', base()); } catch (e) { say(String(e)); return null; } };
  const next = async () => {
    const r = await find(); if (!r) return null;
    if (!r.total) { say('Nothing found'); return null; }
    const here = act.r * 1e7 + act.c, m = r.matches.find(([a, b]) => a * 1e7 + b > here) || r.matches[0];
    moveTo(m[0], m[1]); ensureVisible(m[0], m[1]);
    say(r.total === 1 ? '1 match' : r.total + ' matches');
    return m;
  };
  q('#fr-next').onclick = next;
  q('#fr-rep').onclick = async () => {
    const r = await find(); if (!r) return;
    if (r.matches.some(([a, b]) => a === act.r && b === act.c)) {
      await mutate('replace', { ...base(), with: q('#fr-with').value, at: [act.r, act.c] });
      const m = await next(); if (!m) say('Replaced. No more matches');
    } else await next();
  };
  q('#fr-all').onclick = async () => {
    if (!q('#fr-find').value) return say('Type something to find');
    const res = await mutate('replace', { ...base(), with: q('#fr-with').value });
    if (res) say(res.replaced ? 'Replaced ' + res.replaced + (res.replaced === 1 ? ' cell' : ' cells') + '. Ctrl+Z undoes it all' : 'Nothing found');
  };
  q('#fr-close').onclick = close;
  q('#fr-sel').addEventListener('change', () => { area = q('#fr-sel').checked ? rectArr(selRect()) : null; });
  d.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); next(); }
  });
  findBox = { q, close };
  q('#fr-find').focus();
}
function editChart(id) {
  const c = charts.find((x) => x.id === id); if (!c || editing) return;
  const bg = document.createElement('div'); bg.className = 'sh-dlg-bg';
  const d = document.createElement('div'); d.className = 'sh-dlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Chart settings');
  d.innerHTML = `<h3>Chart settings</h3>
    <label>Type<select id="ch-kind">${CHART_KINDS.map((k, i) => `<option value="${i}"${i === c.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    <label>Title<input id="ch-title" maxlength="120" spellcheck="false" value="${xe(c.title)}"></label>
    <label class="ax">Category axis title (the labels)<input id="ch-xt" maxlength="120" spellcheck="false" value="${xe(c.xTitle || '')}"></label>
    <label class="ax">Value axis title (the numbers)<input id="ch-yt" maxlength="120" spellcheck="false" value="${xe(c.yTitle || '')}"></label>
    <label>Data cells<input id="ch-range" spellcheck="false" value="${a1(c.rect[0], c.rect[1])}:${a1(c.rect[2], c.rect[3])}"></label>
    <label class="chk"><input id="ch-rows" type="checkbox"${c.byRows ? ' checked' : ''}> Each row is a series (instead of each column)</label>
    <div class="ch-colh"><b>Colours</b> <button type="button" class="btn sm" id="ch-reset">Reset colours</button></div>
    <div class="ch-cols" id="ch-cols"></div>
    <p class="err" id="ch-err" hidden></p>
    <div class="btns"><button class="btn" id="ch-cancel">Cancel</button><button class="btn primary" id="ch-ok">OK</button></div>`;
  bg.appendChild(d); document.body.appendChild(bg);
  const q = (s) => d.querySelector(s), close = () => { bg.remove(); keys.focus(); };
  const names = c.kind === 2 ? c.cats.map((x, i) => x || String(i + 1)) : c.series.map((s) => s.name), pick = c.palette.map((h) => h.toUpperCase()), touched = new Set();
  let resetCols = false;
  q('#ch-cols').innerHTML = names.slice(0, 12).map((nm, i) => `<label class="sw"><input type="color" data-i="${i}" value="#${(pick[i] || '8C2F4A').toLowerCase()}"><span>${xe(cut(String(nm), 16))}</span></label>`).join('') + (names.length > 12 ? `<span class="more">+ ${names.length - 12} more use the default colours</span>` : '');
  q('#ch-cols').addEventListener('input', (e) => { const i = +e.target.dataset.i; pick[i] = e.target.value.slice(1).toUpperCase(); touched.add(i); resetCols = false; });
  q('#ch-reset').onclick = () => { resetCols = true; touched.clear(); q('#ch-cols').querySelectorAll('input').forEach((inp) => { inp.value = '#' + DEF_PAL[+inp.dataset.i % 8].toLowerCase(); pick[+inp.dataset.i] = DEF_PAL[+inp.dataset.i % 8]; }); };
  const axRows = () => d.querySelectorAll('label.ax').forEach((l) => { l.hidden = +q('#ch-kind').value === 2; });
  q('#ch-kind').addEventListener('change', axRows); axRows();
  const ok = async () => {
    const parts = q('#ch-range').value.split(':'), a = parseA1(parts[0] || ''), b = parseA1(parts.length > 1 ? parts[1] : parts[0] || '');
    if (!a || !b || parts.length > 2) { const er = q('#ch-err'); er.hidden = false; er.textContent = 'Write the cells like A1:C5'; return; }
    close();
    const colors = resetCols ? [] : pick.map((h, i) => (touched.has(i) || h !== DEF_PAL[i % 8] ? h : ''));
    while (colors.length && colors[colors.length - 1] === '') colors.pop();
    await mutate('chart_set', { id, colors, xTitle: q('#ch-xt').value, yTitle: q('#ch-yt').value, kind: +q('#ch-kind').value, title: q('#ch-title').value, rect: [Math.min(a.r, b.r), Math.min(a.c, b.c), Math.max(a.r, b.r), Math.max(a.c, b.c)], byRows: q('#ch-rows').checked });
  };
  q('#ch-ok').onclick = ok; q('#ch-cancel').onclick = close;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  d.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); ok(); } });
  q('#ch-title').focus(); q('#ch-title').select();
}

MTRX.sheets = { chartCol: () => insertChart(0), chartLine: () => insertChart(1), chartPie: () => insertChart(2), chartBar: () => insertChart(3), chartStack: () => insertChart(4), chartArea: () => insertChart(5), chartEdit: () => selChart && editChart(selChart), chartDel: delChart, hasChart: () => !!selChart, insRows: () => insDel(true, true), insCols: () => insDel(false, true), delRows: () => insDel(true, false), delCols: () => insDel(false, false), insKey: insDelKey, hitKind: (e) => hit(e).t, wrap: wrapToggle, fitCols: fitSelCols, fitRows: fitSelRows, undo, redo, cut: () => copySel(true), copy: () => copySel(false), paste: pasteMenu, clear: clearSel, fillDown: () => fill('down'), fillRight: () => fill('right'), selectAll, autoSum, tabAdd: addTab, tabRename: () => renameTab(tabs.active), tabDup: () => dupTab(tabs.active), tabDel: () => deleteTab(tabs.active), tabLeft: () => moveTab(tabs.active, tabs.active - 1), tabRight: () => moveTab(tabs.active, tabs.active + 1), tabNext: () => switchTab(tabs.active + 1), tabPrev: () => switchTab(tabs.active - 1), tabMenu, tabCount: () => tabs.names.length, tabIndex: () => tabs.active,
  colWidth: () => sizeDlg(true), rowHeight: () => sizeDlg(false), insCells: () => shiftDlg(true), delCells: () => shiftDlg(false), find: findReplace, valid: validDlg, print: printSheet, goto: gotoBox, newSheet, open: openFile, save, saveAs: () => saveFile('xlsx', true), exportCsv: () => saveFile('csv', true), toggle, align: setAlign, nf: nfSet, decimals, borders, paint: startPaint, clearFormat, textColour: (a) => colourPop(a || $('#sh-tcolor-a'), 'c', 'Automatic'), fillColour: (a) => colourPop(a || $('#sh-fill-a'), 'f', 'No fill'), borderMenu: () => borderPop($('#sh-borders')), hasSel: () => !single(), focus: () => keys.focus(),
  sort: sortSel, merge: mergeSel, unmerge: unmergeSel, freezeHere, freezeRow: () => freeze(1, 0), freezeCol: () => freeze(0, 1), unfreeze: () => freeze(0, 0), filter: filterToggle,
  isFrozen: frozen, isFiltered: () => !!filt, canUnmerge: () => merges.length > 0 };
$('#app-sheets').onclick = showSheets;
$('#sh-home').onclick = () => MTRX.goHome?.();
$('#sh-new').onclick = newSheet;
$('#sh-open').onclick = openFile;
$('#sh-tabadd').onclick = addTab;
$('#sh-tabprev').onclick = () => switchTab(tabs.active - 1);
$('#sh-tabnext').onclick = () => switchTab(tabs.active + 1);
$('#sh-save').onclick = save;
for (const [id, fn] of [['#sh-undo', undo], ['#sh-redo', redo], ['#sh-cut', () => copySel(true)], ['#sh-copy', () => copySel(false)], ['#sh-paste', pasteMenu], ['#sh-filldown', () => fill('down')], ['#sh-fillright', () => fill('right')], ['#sh-clear', clearSel], ['#sh-sum', autoSum]]) {
  const b = $(id); b.addEventListener('mousedown', (e) => e.preventDefault()); b.onclick = fn;
}
for (const [id, fn] of [['#sh-b', () => toggle('b')], ['#sh-i', () => toggle('i')], ['#sh-u', () => toggle('u')], ['#sh-s', () => toggle('s')],
  ['#sh-wrap', wrapToggle], ['#sh-al', () => setAlign(1)], ['#sh-ac', () => setAlign(2)], ['#sh-ar', () => setAlign(3)],
  ['#sh-cur', () => nfSet(3, 2)], ['#sh-pct', () => nfSet(4, 0)], ['#sh-comma', () => nfSet(2, 2)], ['#sh-decmore', () => decimals(1)], ['#sh-decless', () => decimals(-1)],
  ['#sh-tcolor', () => useColour('c', pref('c.c', '#c00000'))], ['#sh-fill', () => useColour('f', pref('c.f', '#ffee00'))],
  ['#sh-tcolor-a', () => colourPop($('#sh-tcolor-a'), 'c', 'Automatic')], ['#sh-fill-a', () => colourPop($('#sh-fill-a'), 'f', 'No fill')],
  ['#sh-borders', () => borderPop($('#sh-borders'))], ['#sh-paint', startPaint], ['#sh-clearfmt', clearFormat],
  ['#sh-sortaz', () => sortSel(true)], ['#sh-sortza', () => sortSel(false)], ['#sh-filter', filterToggle], ['#sh-valid', validDlg], ['#sh-merge', mergeSel], ['#sh-freeze', () => (frozen() ? freeze(0, 0) : freezeHere())],
  ['#sh-chcol', () => insertChart(0)], ['#sh-chline', () => insertChart(1)], ['#sh-chpie', () => insertChart(2)], ['#sh-chbar', () => insertChart(3)], ['#sh-chstack', () => insertChart(4)], ['#sh-charea', () => insertChart(5)],
  ['#sh-insrow', () => insDel(true, true)], ['#sh-inscol', () => insDel(false, true)], ['#sh-delrow', () => insDel(true, false)], ['#sh-delcol', () => insDel(false, false)]]) {
  const b = $(id); b.addEventListener('mousedown', (e) => e.preventDefault()); b.onclick = fn;
}
$('#sh-tcolor .bar').style.background = pref('c.c', '#c00000'); $('#sh-fill .bar').style.background = pref('c.f', '#ffee00');
$('#sh-nf').addEventListener('change', (e) => { const k = +e.target.value; nfSet(k, k === 3 || k === 1 || k === 2 || k === 6 ? 2 : 0); keys.focus(); });
$('#sh-size').addEventListener('change', (e) => { fmt({ z: e.target.value ? +e.target.value : null }); keys.focus(); });
$('#sh-undo').disabled = true; $('#sh-redo').disabled = true;
})();
