// Writer: paragraph spacing and indents (line spacing, space before/after, left and first-line indent).
// Stored as inline style on the paragraph, so it saves with drafts; saved to .docx as real paragraph spacing and indents.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const $ = (s) => document.querySelector(s);
  const { ed, msg, modal, exec, saveDraftSoon, markPages } = MTRX.w;
  const STEP = 36; // one indent step = 0.5 inch, in pt
  const PT = { pt: 1, px: 0.75, in: 72, cm: 28.3465, mm: 2.83465 };

  // "12pt", "16px", "0.5in" -> points (0 when empty or not a length)
  const pt = (v) => { const m = /^(-?[\d.]+)(pt|px|in|cm|mm)$/.exec((v || '').trim()); return m ? parseFloat(m[1]) * PT[m[2]] : 0; };
  const round1 = (n) => Math.round(n * 10) / 10;

  // The model for export: only what the paragraph itself sets.
  MTRX.paraFmt = (el) => {
    const s = el.style; if (!s) return null;
    const f = {};
    const lh = parseFloat(s.lineHeight); if (lh > 0 && /^[\d.]+$/.test(s.lineHeight.trim())) f.line = Math.round(lh * 100);
    const b = pt(s.marginTop), a = pt(s.marginBottom); if (b > 0) f.before = Math.round(b * 20); if (a > 0) f.after = Math.round(a * 20);
    const l = pt(s.marginLeft); if (l) f.left = Math.round(l * 20);
    const t = pt(s.textIndent); if (t) f.first = Math.round(t * 20);
    return Object.keys(f).length ? f : null;
  };

  // Paragraphs, headings and list items the selection touches (direct children of the page, or list items).
  function targets(live) {
    const sel = getSelection();
    const r = live && sel.rangeCount && ed.contains(sel.anchorNode) ? sel.getRangeAt(0) : MTRX.w.saved() || (sel.rangeCount ? sel.getRangeAt(0) : null);
    if (!r || !ed.contains(r.commonAncestorContainer)) return [];
    return [...ed.querySelectorAll('p,h1,h2,h3,li')].filter((e) => !e.closest('.toc') && (e.parentNode === ed || e.tagName === 'LI') && r.intersectsNode(e));
  }
  const done = () => { markPages(); saveDraftSoon(); };

  function shift(dir) {
    const t = targets(); if (!t.length) return msg('Click in a paragraph first');
    if (t.every((e) => e.tagName === 'LI')) { exec(dir > 0 ? 'indent' : 'outdent'); return done(); }
    t.forEach((e) => {
      if (e.tagName === 'LI') return;
      const next = Math.max(0, Math.min(360, pt(e.style.marginLeft) + dir * STEP));
      if (next) e.style.marginLeft = next + 'pt'; else e.style.removeProperty('margin-left');
      if (!e.getAttribute('style')) e.removeAttribute('style');
    });
    done();
  }

  function dialog() {
    const t = targets(); if (!t.length) return msg('Click in a paragraph first');
    const e = t[0], s = e.style;
    const lh = parseFloat(s.lineHeight) || 0;
    const num = (id) => parseFloat($(id).value) || 0;
    modal('Paragraph',
      `<div class="row"><div><label>Line spacing</label><select id="m-ls">${[['', 'Default'], ['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', 'Double'], ['2.5', '2.5'], ['3', 'Triple']].map(([v, n]) => `<option value="${v}"${(lh ? String(Math.round(lh * 100) / 100) : '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></div></div>
       <div class="row"><div><label>Space before (pt)</label><input id="m-sb" type="number" min="0" max="200" value="${round1(pt(s.marginTop))}"></div>
       <div><label>Space after (pt)</label><input id="m-sa" type="number" min="0" max="200" value="${round1(pt(s.marginBottom))}"></div></div>
       <div class="row"><div><label>Left indent (pt)</label><input id="m-il" type="number" min="0" max="360" value="${round1(pt(s.marginLeft))}"></div>
       <div><label>First line (pt, negative = hanging)</label><input id="m-if" type="number" min="-360" max="360" value="${round1(pt(s.textIndent))}"></div></div>`,
      () => {
        const set = (el, prop, v) => { if (v) el.style.setProperty(prop, v); else el.style.removeProperty(prop); };
        const ls = $('#m-ls').value, sb = num('#m-sb'), sa = num('#m-sa'), il = num('#m-il'), fi = num('#m-if');
        t.forEach((el) => {
          set(el, 'line-height', ls);
          set(el, 'margin-top', sb > 0 ? Math.min(200, sb) + 'pt' : '');
          set(el, 'margin-bottom', sa > 0 ? Math.min(200, sa) + 'pt' : '');
          if (el.tagName !== 'LI') { set(el, 'margin-left', il > 0 ? Math.min(360, il) + 'pt' : ''); set(el, 'text-indent', fi ? Math.max(-360, Math.min(360, fi)) + 'pt' : ''); }
          if (!el.getAttribute('style')) el.removeAttribute('style');
        });
        done();
      }, 'Apply');
  }

  // ---- styles gallery: quick styles applied as direct formatting, so they export to .docx exactly as they look ----
  const STYLES = {
    title: { 'font-size': '26pt', 'font-weight': '700', color: '#32000c', 'margin-bottom': '6pt' },
    subtitle: { 'font-size': '14pt', color: '#5a5a5a', 'margin-bottom': '10pt' },
    quote: { 'font-style': 'italic', color: '#444444', 'margin-left': '36pt', 'margin-right': '36pt', 'margin-top': '6pt', 'margin-bottom': '10pt' },
    caption: { 'font-size': '9pt', 'font-style': 'italic', color: '#5a5a5a' },
    nospace: { 'margin-top': '0pt', 'margin-bottom': '0pt', 'line-height': '1' },
  };
  const CLEAR = ['font-size', 'font-weight', 'font-style', 'color', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'line-height', 'text-indent'];
  function applyStyle(v) {
    if (!targets().length) return msg('Click in a paragraph first');
    const kind = v.startsWith('st:') ? v.slice(3) : '';
    exec('formatBlock', kind ? 'p' : v);
    targets(true).forEach((e) => {
      if (e.tagName === 'LI') return;
      CLEAR.forEach((p) => e.style.removeProperty(p)); delete e.dataset.st;
      if (kind) { Object.entries(STYLES[kind]).forEach(([p, val]) => e.style.setProperty(p, val)); e.dataset.st = kind; }
      if (!e.getAttribute('style')) e.removeAttribute('style');
    });
    done();
  }
  const selBlock = $('#sel-block');
  selBlock.onchange = (e) => applyStyle(e.target.value);
  document.addEventListener('selectionchange', () => {
    const s = getSelection(); if (!s.rangeCount || !ed.contains(s.anchorNode) || document.activeElement === selBlock) return;
    let el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
    while (el && el !== ed && !/^(P|H1|H2|H3|LI)$/.test(el.tagName)) el = el.parentElement;
    if (!el || el === ed) return;
    const v = /^H[1-3]$/.test(el.tagName) ? el.tagName.toLowerCase() : el.dataset.st ? 'st:' + el.dataset.st : 'p';
    if (selBlock.value !== v) selBlock.value = v;
  });

  $('#para-indent').onclick = () => shift(1);
  $('#para-outdent').onclick = () => shift(-1);
  $('#para-fmt').onclick = dialog;
  MTRX.para = { shift, dialog };
})();
