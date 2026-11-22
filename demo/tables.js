// Table tools for Writer: merge and split cells, cell shading, table borders and ready-made table styles.
// Merged cells use real colspan / rowspan, so they save to .docx and open again. Every change goes through MTRX.editTable
// (one undo step). Adding or removing rows and columns in a table that has merged cells is not supported yet: split first.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const { ed, msg } = MTRX.w;
  const $ = (s) => document.querySelector(s);

  const cellOf = (n) => { const el = n && (n.nodeType === 3 ? n.parentElement : n); const c = el && el.closest ? el.closest('td,th') : null; return c && ed.contains(c) ? c : null; };
  const merged = (t) => !!t.querySelector('[colspan]:not([colspan="1"]),[rowspan]:not([rowspan="1"])');

  // Grid of cells: g[row][col] is the cell covering that spot (a merged cell appears in every spot it covers).
  function gridOf(t) {
    const g = [];
    [...t.rows].forEach((tr, r) => {
      g[r] = g[r] || [];
      let c = 0;
      [...tr.cells].forEach((cell) => {
        while (g[r][c]) c++;
        const cs = Math.max(1, parseInt(cell.getAttribute('colspan')) || 1), rs = Math.max(1, parseInt(cell.getAttribute('rowspan')) || 1);
        for (let i = 0; i < rs; i++) { g[r + i] = g[r + i] || []; for (let j = 0; j < cs; j++) g[r + i][c + j] = cell; }
        c += cs;
      });
    });
    return g;
  }
  const posOf = (g, cell) => { for (let r = 0; r < g.length; r++) { const c = g[r].indexOf(cell); if (c >= 0) return { r, c }; } return null; };
  const extent = (cell) => ({ cs: Math.max(1, parseInt(cell.getAttribute('colspan')) || 1), rs: Math.max(1, parseInt(cell.getAttribute('rowspan')) || 1) });

  // The selected rectangle of cells, in grid coordinates (or just the cell the caret is in).
  function selection() {
    const s = getSelection();
    const rg = s.rangeCount && ed.contains(s.anchorNode) ? s.getRangeAt(0) : MTRX.w.saved();
    if (!rg) return null;
    const a = cellOf(rg.startContainer), b = cellOf(rg.endContainer) || a;
    if (!a) return null;
    const t = a.closest('table'); if (!b || b.closest('table') !== t) return { t, r0: posOf(gridOf(t), a).r, c0: posOf(gridOf(t), a).c, r1: posOf(gridOf(t), a).r, c1: posOf(gridOf(t), a).c };
    const g = gridOf(t), pa = posOf(g, a), pb = posOf(g, b), ea = extent(a), eb = extent(b);
    let r0 = Math.min(pa.r, pb.r), c0 = Math.min(pa.c, pb.c), r1 = Math.max(pa.r + ea.rs - 1, pb.r + eb.rs - 1), c1 = Math.max(pa.c + ea.cs - 1, pb.c + eb.cs - 1);
    for (let again = true; again;) { // grow until no merged cell sticks out of the rectangle
      again = false;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const x = g[r] && g[r][c]; if (!x) continue;
        const p = posOf(g, x), e = extent(x);
        if (p.r < r0) { r0 = p.r; again = true; } if (p.c < c0) { c0 = p.c; again = true; }
        if (p.r + e.rs - 1 > r1) { r1 = p.r + e.rs - 1; again = true; } if (p.c + e.cs - 1 > c1) { c1 = p.c + e.cs - 1; again = true; }
      }
    }
    return { t, r0, c0, r1, c1 };
  }
  const cellsIn = (g, q) => { const set = new Set(); for (let r = q.r0; r <= q.r1; r++) for (let c = q.c0; c <= q.c1; c++) if (g[r] && g[r][c]) set.add(g[r][c]); return [...set]; };

  // Run an edit on a copy of the table, located again inside the copy by grid position, and swap it in as one undo step.
  function edit(q, fn) {
    MTRX.editTable(q.t, (clone) => { fn(clone, gridOf(clone)); });
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const empty = (c) => !c.textContent.trim() && !c.querySelector('img');

  function merge() {
    const q = selection(); if (!q) return msg('Click in a table first');
    if (q.r0 === q.r1 && q.c0 === q.c1) return msg('Select two or more cells to merge');
    edit(q, (clone, g) => {
      const cells = cellsIn(g, q), main = g[q.r0][q.c0];
      cells.forEach((c) => {
        if (c === main) return;
        if (!empty(c)) { if (empty(main)) main.innerHTML = c.innerHTML; else main.insertAdjacentHTML('beforeend', '<br>' + c.innerHTML); }
        c.remove();
      });
      const cs = q.c1 - q.c0 + 1, rs = q.r1 - q.r0 + 1;
      cs > 1 ? main.setAttribute('colspan', cs) : main.removeAttribute('colspan');
      rs > 1 ? main.setAttribute('rowspan', rs) : main.removeAttribute('rowspan');
      if (!main.innerHTML.trim()) main.innerHTML = '<br>';
      clone.style.tableLayout && MTRX.normCols?.(clone);
    });
  }

  function split() {
    const q = selection(); if (!q) return msg('Click in a table first');
    const g0 = gridOf(q.t);
    if (!cellsIn(g0, q).some((c) => extent(c).cs > 1 || extent(c).rs > 1)) return msg('Click a merged cell to split it');
    const keys = cellsIn(g0, q).map((c) => posOf(g0, c));
    edit(q, (clone, g) => {
      keys.forEach((p) => {
        const cell = g[p.r][p.c], e = extent(cell); if (e.cs === 1 && e.rs === 1) return;
        cell.removeAttribute('colspan'); cell.removeAttribute('rowspan');
        for (let r = p.r; r < p.r + e.rs; r++) for (let c = p.c; c < p.c + e.cs; c++) {
          if (r === p.r && c === p.c) continue;
          const n = document.createElement(cell.tagName === 'TH' && r === 0 ? 'th' : 'td'); n.innerHTML = '<br>';
          if (cell.style.backgroundColor) n.style.backgroundColor = cell.style.backgroundColor;
          const tr = clone.rows[r]; let ref = null;
          for (let k = c - 1; k >= 0; k--) { const x = g[r][k]; if (x && x.parentElement === tr && x !== n) { ref = x; break; } }
          ref ? ref.after(n) : tr.prepend(n);
          g[r][c] = n;
        }
      });
      MTRX.normCols?.(clone);
    });
  }

  const HEX = /^#[0-9a-f]{6}$/i;
  function shade(hex) {
    const q = selection(); if (!q) return msg('Click in a table first');
    if (hex && !HEX.test(hex)) return;
    edit(q, (clone, g) => cellsIn(g, q).forEach((c) => { hex ? (c.style.backgroundColor = hex) : c.style.removeProperty('background-color'); if (!c.getAttribute('style')) c.removeAttribute('style'); }));
  }

  function borders(kind) {
    const q = selection(); if (!q) return msg('Click in a table first');
    edit(q, (clone) => (kind ? clone.setAttribute('data-bd', kind) : clone.removeAttribute('data-bd')));
  }

  const TINT = '#f3dde1', BAND = '#f7eef0';
  const STYLES = {
    grid: { name: 'Plain grid', b: '', head: false, band: false },
    header: { name: 'Header row', b: '', head: true, band: false },
    banded: { name: 'Banded rows', b: '', head: true, band: true },
    light: { name: 'No borders, banded', b: 'none', head: true, band: true },
    bold: { name: 'Bold lines', b: 'thick', head: true, band: false },
  };
  function style(key) {
    const st = STYLES[key], q = selection(); if (!st || !q) return msg('Click in a table first');
    edit(q, (clone) => {
      [...clone.rows].forEach((tr, ri) => [...tr.cells].forEach((c) => {
        c.style.removeProperty('background-color');
        if (st.head && ri === 0) c.style.backgroundColor = TINT;
        else if (st.band && ri > 0 && ri % 2 === 0) c.style.backgroundColor = BAND;
        if (!c.getAttribute('style')) c.removeAttribute('style');
      }));
      st.b ? clone.setAttribute('data-bd', st.b) : clone.removeAttribute('data-bd');
    });
  }

  MTRX.tbl = { merged, merge, split, shade, borders, style, selection, STYLES };

  // Toolbar (the table group appears when the caret is in a table). Buttons keep the text selection.
  const keep = (el) => el && el.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'SELECT' && e.target.type !== 'color') e.preventDefault(); });
  ['#t-merge', '#t-split', '#t-nofill'].forEach((s) => keep($(s)));
  $('#t-merge').onclick = merge;
  $('#t-split').onclick = split;
  $('#t-nofill').onclick = () => shade('');
  const sh = $('#t-shade'); sh.oninput = () => {}; sh.onchange = () => shade(sh.value);
  const bsel = $('#t-borders'); bsel.onchange = () => { borders(bsel.value); bsel.value = '-'; };
  const ssel = $('#t-style'); ssel.onchange = () => { if (ssel.value !== '-') style(ssel.value); ssel.value = '-'; };
  Object.entries(STYLES).forEach(([k, v]) => { const o = document.createElement('option'); o.value = k; o.textContent = v.name; ssel.appendChild(o); });
})();
