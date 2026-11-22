// Equation editor (Writer). You type a LaTeX-style line (or click the palette) and see the equation live.
// It is placed in the text as a small picture (so it also shows up in Word and PDF) that remembers its source
// in data-eq: double-click it to edit. Rendering uses the browser's own MathML.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω' };
  const SYM = { times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftrightarrow: '⇔',
    partial: '∂', nabla: '∇', degree: '°', deg: '°', in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', forall: '∀', exists: '∃', ldots: '…', dots: '…', therefore: '∴', propto: '∝', angle: '∠', perp: '⊥', parallel: '∥', circ: '∘', prime: '′' };
  const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'exp', 'lim', 'min', 'max', 'det', 'mod', 'gcd']);
  const BIG = { sum: '∑', prod: '∏', int: '∫', oint: '∮' };
  const ACCENT = { vec: '→', bar: '¯', hat: '^', dot: '˙', tilde: '~', overline: '¯' };

  // ---- LaTeX subset -> MathML ------------------------------------------
  function toMathml(src) {
    const s = String(src || '').slice(0, 2000);
    let i = 0;
    const peek = () => s[i];
    const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    function cmdName() { let n = ''; while (i < s.length && /[A-Za-z]/.test(s[i])) n += s[i++]; if (!n && i < s.length) n = s[i++]; return n; }
    function group() { // one {...} argument, or a single atom
      skipWs();
      if (peek() === '{') { i++; const r = seq('}'); if (peek() === '}') i++; return `<mrow>${r}</mrow>`; }
      return atom() || '<mrow></mrow>';
    }
    function bracketArg() { if (peek() !== '[') return null; i++; const r = seq(']'); if (peek() === ']') i++; return `<mrow>${r}</mrow>`; }
    function atom() {
      skipWs();
      const c = peek();
      if (c === undefined) return '';
      if (c === '{') { i++; const r = seq('}'); if (peek() === '}') i++; return `<mrow>${r}</mrow>`; }
      if (c === '\\') {
        i++;
        const n = cmdName();
        if (n === 'frac' || n === 'dfrac') { const a = group(), b = group(); return `<mfrac>${a}${b}</mfrac>`; }
        if (n === 'sqrt') { const idx = bracketArg(); const a = group(); return idx ? `<mroot>${a}${idx}</mroot>` : `<msqrt>${a}</msqrt>`; }
        if (n === 'text' || n === 'mathrm' || n === 'textrm') { skipWs(); let t = ''; if (peek() === '{') { i++; while (i < s.length && s[i] !== '}') t += s[i++]; i++; } return `<mtext>${esc(t)}</mtext>`; }
        if (ACCENT[n]) { const a = group(); return `<mover accent="true">${a}<mo>${ACCENT[n]}</mo></mover>`; }
        if (n === 'left' || n === 'right') return atom();
        if (n === 'quad') return '<mspace width="1em"/>';
        if (n === 'qquad') return '<mspace width="2em"/>';
        if (n === ',' || n === ';' || n === ' ' || n === '!') return '<mspace width="0.3em"/>';
        if (n === '\\') return '';
        if (GREEK[n]) return `<mi>${GREEK[n]}</mi>`;
        if (SYM[n]) return `<mo>${SYM[n]}</mo>`;
        if (BIG[n]) return `<mo largeop="true">${BIG[n]}</mo>`;
        if (FUNCS.has(n)) return `<mi>${n}</mi><mo>&#x2061;</mo>`;
        if (n === '{' || n === '}' || n === '%' || n === '&' || n === '_' || n === '#') return `<mo>${esc(n)}</mo>`;
        return `<mi>${esc(n)}</mi>`; // unknown command: show its name rather than fail
      }
      if (/[0-9.]/.test(c)) { let n = ''; while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++]; return `<mn>${n}</mn>`; }
      if (/[A-Za-z]/.test(c)) { i++; return `<mi>${c}</mi>`; }
      i++;
      if (c === '-') return '<mo>−</mo>';
      if (c === '*') return '<mo>·</mo>';
      if (c === "'") return '<mo>′</mo>';
      return `<mo>${esc(c)}</mo>`;
    }
    function seq(stop) {
      let out = '';
      while (i < s.length) {
        skipWs();
        if (i >= s.length || s[i] === stop || (stop && s[i] === stop)) break;
        if (s[i] === '}' && !stop) { i++; continue; }
        let base = atom();
        if (!base) continue;
        let sub = null, sup = null;
        for (;;) {
          skipWs();
          if (peek() === '_' && sub === null) { i++; sub = group(); } else if (peek() === '^' && sup === null) { i++; sup = group(); } else break;
        }
        if (sub !== null || sup !== null) {
          const big = /^<mo largeop="true">(.)<\/mo>$/.exec(base), lim = /^<mi>(lim|max|min)<\/mi><mo>&#x2061;<\/mo>$/.exec(base);
          if (lim) { base = `<mi>${lim[1]}</mi>`; out += sub !== null ? `<munder>${base}${sub}</munder>` : base; if (sup !== null) out += ''; continue; }
          if (big && big[1] !== '∫' && big[1] !== '∮') { // sums and products: limits above and below
            out += sub !== null && sup !== null ? `<munderover>${base}${sub}${sup}</munderover>` : sub !== null ? `<munder>${base}${sub}</munder>` : `<mover>${base}${sup}</mover>`;
            continue;
          }
          out += sub !== null && sup !== null ? `<msubsup>${base}${sub}${sup}</msubsup>` : sub !== null ? `<msub>${base}${sub}</msub>` : `<msup>${base}${sup}</msup>`;
        } else out += base;
      }
      return out;
    }
    const body = seq('');
    return `<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow>${body}</mrow></math>`;
  }

  // ---- MathML -> PNG ----------------------------------------------------
  const FONT = "'Cambria Math','STIX Two Math','Latin Modern Math',serif"; // single quotes: it is placed inside a double-quoted attribute
  async function render(src, px) {
    const ml = toMathml(src), S = 3;
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-9999px;top:0;font:${px}px ${FONT};color:#000;white-space:nowrap;padding:2px 3px;line-height:normal`;
    host.innerHTML = ml; document.body.appendChild(host);
    const r = host.getBoundingClientRect(), w = Math.max(8, Math.ceil(r.width)), h = Math.max(8, Math.ceil(r.height));
    host.remove();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * S}" height="${h * S}"><foreignObject x="0" y="0" width="${w}" height="${h}" transform="scale(${S})">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="font:${px}px ${FONT};color:#000;white-space:nowrap;padding:2px 3px;line-height:normal">${ml}</div></foreignObject></svg>`;
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('render')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
    const c = document.createElement('canvas'); c.width = w * S; c.height = h * S;
    c.getContext('2d').drawImage(img, 0, 0);
    return { url: c.toDataURL('image/png'), w, h };
  }

  // ---- dialog -------------------------------------------------------------
  const PALETTE = [
    ['a⁄b', '\\frac{|}{}', 'Fraction'], ['x²', '^{|}', 'Power'], ['xₙ', '_{|}', 'Subscript'], ['√', '\\sqrt{|}', 'Square root'], ['ⁿ√', '\\sqrt[|]{}', 'Root of any order'],
    ['∑', '\\sum_{i=1}^{n} |', 'Sum'], ['∫', '\\int_{a}^{b} | dx', 'Integral'], ['lim', '\\lim_{x \\to |}', 'Limit'],
    ['±', '\\pm ', 'Plus or minus'], ['×', '\\times ', 'Times'], ['÷', '\\div ', 'Divide'], ['≤', '\\leq ', 'Less or equal'], ['≥', '\\geq ', 'Greater or equal'], ['≠', '\\neq ', 'Not equal'], ['≈', '\\approx ', 'Approximately'], ['∞', '\\infty ', 'Infinity'], ['→', '\\to ', 'Arrow'], ['°', '^{\\circ}', 'Degrees'],
    ['π', '\\pi ', 'pi'], ['θ', '\\theta ', 'theta'], ['α', '\\alpha ', 'alpha'], ['β', '\\beta ', 'beta'], ['λ', '\\lambda ', 'lambda'], ['μ', '\\mu ', 'mu'], ['σ', '\\sigma ', 'sigma'], ['Δ', '\\Delta ', 'Delta'], ['Ω', '\\Omega ', 'Omega'],
  ];
  const SAMPLES = ['x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', 'E = mc^2', 'A = \\pi r^2'];

  function dialog(img) {
    const w = MTRX.w; if (!w) return;
    const ed = w.ed, sel = getSelection();
    const saved = !img && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const base = parseFloat(getComputedStyle(img || (sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)) || ed).fontSize) || 14.7;
    w.modal(img ? 'Edit equation' : 'Equation',
      `<label>Type the equation (LaTeX style), or use the buttons</label>
       <div class="eq-pal">${PALETTE.map(([t, , tip], k) => `<button type="button" class="mini" data-k="${k}" title="${esc(tip)}">${esc(t)}</button>`).join('')}</div>
       <textarea id="eq-src" rows="3" spellcheck="false" style="width:100%;font-family:Consolas,monospace" placeholder="x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"></textarea>
       <div class="eq-prev" id="eq-prev" aria-label="Preview"></div>
       <p style="font-size:12px;color:#7b5d66;margin:6px 0 0">Examples: <a href="#" class="eq-ex" data-i="0">quadratic formula</a> · <a href="#" class="eq-ex" data-i="1">E = mc²</a> · <a href="#" class="eq-ex" data-i="2">area of a circle</a>. Use ^ for powers, _ for subscripts, {} to group. Double-click an equation in the text to change it.</p>`,
      async (m) => {
        const src = m.querySelector('#eq-src').value.trim();
        if (!src) return;
        let r;
        // a little larger than the text so fractions stay readable
        try { r = await render(src, Math.round(base * 1.25 * 10) / 10); } catch { return w.msg('Could not draw this equation'); }
        if (img) { img.src = r.url; img.dataset.eq = src; img.width = r.w; img.height = r.h; img.setAttribute('alt', src); }
        else {
          ed.focus();
          if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); }
          document.execCommand('insertHTML', false, `<img src="${r.url}" data-eq="${esc(src)}" width="${r.w}" height="${r.h}" alt="${esc(src)}" style="vertical-align:middle">`);
        }
        w.markPages(); w.saveDraftSoon();
      }, img ? 'Save' : 'Insert');
    const m = $('#modal'), ta = $('#eq-src', m), pv = $('#eq-prev', m);
    const upd = () => { pv.innerHTML = ta.value.trim() ? toMathml(ta.value) : '<span class="eq-hint">Preview appears here</span>'; };
    ta.addEventListener('input', upd);
    ta.value = img ? img.dataset.eq || '' : ''; upd(); ta.focus();
    m.querySelectorAll('.eq-pal .mini').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        const [, snip] = PALETTE[+b.dataset.k], at = snip.indexOf('|'), t = snip.replace('|', '');
        const a = ta.selectionStart, z = ta.selectionEnd;
        ta.value = ta.value.slice(0, a) + t + ta.value.slice(z);
        const p = a + (at < 0 ? t.length : at); ta.focus(); ta.setSelectionRange(p, p); upd();
      });
    });
    m.querySelectorAll('.eq-ex').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); ta.value = SAMPLES[+a.dataset.i]; upd(); ta.focus(); }));
  }

  document.addEventListener('dblclick', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.dataset && t.dataset.eq && t.closest('#editor')) { e.preventDefault(); dialog(t); }
  });
  const btn = $('#ins-eq'); if (btn) btn.onclick = () => dialog();
  MTRX.equation = { toMathml, dialog, render };
})();
