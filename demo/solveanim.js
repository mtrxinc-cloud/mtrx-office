// MTRX Solve: animation player. Shows the working one line at a time and morphs each line into the next:
// symbols that stay slide to their new place, symbols that go are struck out and fade, new ones glow in.
// It only needs the steps (rule, text, math), so every topic gets it. Controls: Back, Play/Pause, Next, Rewind, speed.
// Later features (build from answer, check by substitution, work backwards) feed it extra steps, no change needed here.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SPEEDS = [0.5, 1, 2];
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Split a line of working into symbols; spaces stay plain text so they never animate.
  function tokens(s) {
    return (String(s).match(/\d+(?:\.\d+)?|[A-Za-z][²³⁴⁵⁶⁷⁸⁹⁰¹]*|\s+|[\s\S]/g) || []).map((t) => ({ t, sp: /^\s+$/.test(t) }));
  }
  // Longest common subsequence of the visible symbols decides which ones "stay".
  function match(a, b) {
    const A = a.filter((x) => !x.sp), B = b.filter((x) => !x.sp), n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i].t === B[j].t ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const map = new Map(); let i = 0, j = 0;
    while (i < n && j < m) { if (A[i].t === B[j].t) { map.set(j, i); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
    return map; // index in B (visible) -> index in A (visible)
  }
  const lineHtml = (tk) => { let k = 0; return tk.map((x) => (x.sp ? esc(x.t) : `<span class="a-t" data-k="${k++}">${esc(x.t)}</span>`)).join(''); };

  function mount(host, steps, opts) {
    opts = opts || {};
    // A step with no maths of its own (explanation only) keeps showing the previous line.
    let prev = '';
    steps = (steps || []).filter((s) => s && (s.math || s.text)).map((s) => { prev = s.math || prev; return { ...s, math: prev }; });
    if (!steps.length) { host.innerHTML = ''; return { destroy() {} }; }
    let i = 0, playing = false, dir = 1, timer = 0, speed = MTRX.prefs ? MTRX.prefs.get('solve.speed', 1) : 1, gen = 0, alive = true;
    if (!SPEEDS.includes(speed)) speed = 1;
    host.innerHTML = `<div class="sv-stage" tabindex="0" aria-label="Animated working">
      <div class="a-top"><span class="a-count"></span><span class="a-rule"></span></div>
      <div class="a-pic" hidden></div>
      <div class="a-viz" hidden></div>
      <div class="a-opbar"><span class="a-op" hidden></span><span class="a-calc" hidden></span></div>
      <div class="a-line" aria-live="polite"></div>
      <div class="a-text"></div>
      <div class="a-dots"></div>
      <div class="a-ctl">
        <button type="button" class="a-b" data-a="rew" title="Rewind: play the working backwards">⏪ Rewind</button>
        <button type="button" class="a-b" data-a="back" title="Previous step (Left arrow)">◀ Back</button>
        <button type="button" class="a-b pri" data-a="play" title="Play or pause (Space)">▶ Play</button>
        <button type="button" class="a-b" data-a="next" title="Next step (Right arrow)">Next ▶</button>
        <button type="button" class="a-b" data-a="speed" title="Animation speed"></button>
      </div></div>`;
    const $ = (s) => host.querySelector(s), stage = $('.sv-stage'), line = $('.a-line');
    const dots = $('.a-dots'); dots.innerHTML = steps.map((_, k) => `<button type="button" data-k="${k}" aria-label="Step ${k + 1}"></button>`).join('');
    let cur = tokens(steps[0].math || '');
    line.innerHTML = lineHtml(cur);

    // Balance scale: only for equations (a step does something "to both sides" and the line has one "=").
    const isEq = (m) => (m.match(/=/g) || []).length === 1 && !/[<>≤≥]/.test(m);
    const scale = steps.some((s) => s.op) && steps.filter((s) => s.op).every((s) => isEq(s.math));
    const pic = $('.a-pic'), opEl = $('.a-op'), calcEl = $('.a-calc');
    const sides = (m) => { if (!isEq(m)) return null; const [l, r] = m.split('='); return [l.trim(), r.trim()]; };
    const fit = (t) => Math.max(14, Math.min(26, 200 / Math.max(4, t.length)));
    function drawPic(k, animate) {
      if (!scale) return;
      const sd = sides(steps[k].math); if (!sd) { pic.hidden = true; return; }
      pic.hidden = false;
      if (!pic.firstChild) {
        pic.innerHTML = `<svg viewBox="0 0 440 190" role="img" aria-label="Balance scale: both sides stay equal">
          <path d="M220 52 L194 172 L246 172 Z" fill="#c9a3ad"/><rect x="164" y="170" width="112" height="8" rx="4" fill="#8a5a67"/>
          <g class="a-beam"><rect x="20" y="46" width="400" height="8" rx="4" fill="#32000c"/><circle cx="220" cy="50" r="9" fill="#32000c"/>
            <g class="a-pan"><path d="M95 54 L30 110 M95 54 L160 110" stroke="#32000c" stroke-width="2" fill="none"/><path d="M20 110 H170 Q160 152 95 152 Q30 152 20 110Z" fill="#e8ccd3" stroke="#32000c" stroke-width="2"/><text x="95" y="139" text-anchor="middle" class="a-pt"></text></g>
            <g class="a-pan"><path d="M345 54 L280 110 M345 54 L410 110" stroke="#32000c" stroke-width="2" fill="none"/><path d="M270 110 H420 Q410 152 345 152 Q280 152 270 110Z" fill="#e8ccd3" stroke="#32000c" stroke-width="2"/><text x="345" y="139" text-anchor="middle" class="a-pt"></text></g>
          </g></svg>`;
      }
      const ts = pic.querySelectorAll('.a-pt');
      ts.forEach((t, n) => { t.textContent = sd[n]; t.style.fontSize = fit(sd[n]) + 'px'; });
      if (animate && !reduce() && steps[k].op) {
        // The same amount drops onto both pans, the scale rocks a little, then settles level again.
        const D = 700 / speed;
        pic.querySelector('.a-beam').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-2.5deg)', offset: .3 }, { transform: 'rotate(1.5deg)', offset: .6 }, { transform: 'rotate(0)' }], { duration: D * 1.6, easing: 'ease-in-out' });
        ts.forEach((t) => t.animate([{ opacity: 0, transform: 'translateY(-14px)' }, { opacity: 1, transform: 'none' }], { duration: D, easing: 'ease-out' }));
      }
    }
    // Area boxes (expand and factorise): sides first, then each box fills with its product, then like boxes join up.
    const viz = opts.viz && opts.viz.kind === 'area' ? opts.viz : null, vz = $('.a-viz');
    let vzK = -1;
    // Bars (fractions, percent, ratio): rows appear at their step, parts colour in and change their text at theirs.
    const bv = opts.viz && opts.viz.kind === 'bars' ? opts.viz : null;
    function drawBars(k, animate) {
      vz.hidden = false;
      if (!vz.firstChild) {
        vz.innerHTML = bv.rows.map((r, ri) => `<div class="a-row" data-r="${ri}"><div class="a-rl">${esc(r.label || '')}</div><div class="a-bar${r.tick ? ' tick' : ''}"${r.tick ? ` style="--tick:${100 / (100 / r.tick)}%"` : ''}>${r.parts.map((p, pi) => `<span class="a-part${p.br ? ' br' : ''}" data-p="${pi}" style="flex:${p.w} 1 0"></span>`).join('')}</div><div class="a-note"></div></div>`).join('');
      }
      const was = vzK; vzK = k; const anim = animate && !reduce();
      bv.rows.forEach((r, ri) => {
        const row = vz.children[ri], show = k >= (r.at || 0), wasShown = was >= (r.at || 0);
        row.style.display = show ? '' : 'none';
        if (show && !wasShown && anim) row.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 500 / speed, easing: 'ease-out' });
        r.parts.forEach((p, pi) => {
          const el = row.querySelectorAll('.a-part')[pi], to = p.at != null && k >= p.at;
          const tone = to ? p.to : p.tone, txt = p.at2 != null && k >= p.at2 ? p.text2 : p.text;
          const changed = el.dataset.tone !== String(tone);
          el.dataset.tone = tone; el.textContent = txt != null ? txt : '';
          if (changed && anim && was >= 0 && show) el.animate([{ transform: 'scaleY(.6)', filter: 'brightness(1.4)' }, { transform: 'none', filter: 'none' }], { duration: 520 / speed, delay: pi * 90 / speed, easing: 'ease-out' });
        });
        const note = row.querySelector('.a-note'), shown = r.note && k >= (r.note_at || 0);
        note.textContent = shown ? '= ' + r.note : '';
        if (shown && !(was >= (r.note_at || 0)) && anim) note.animate([{ opacity: 0, transform: 'scale(.7)' }, { opacity: 1, transform: 'scale(1.15)', offset: .7 }, { opacity: 1, transform: 'none' }], { duration: 600 / speed, delay: 300 / speed, fill: 'backwards' });
      });
    }
    // Number line (inequalities): the line is there from the start; the circle and shading arrive at their step, then a test point.
    const nv = opts.viz && opts.viz.kind === 'line' ? opts.viz : null;
    function drawLine(k, animate) {
      vz.hidden = false;
      const anim = animate && !reduce(), was = vzK; vzK = k;
      const W = 520, L = 30, R = 490, ay = 62;
      const two = nv.x2 != null;
      const mag = Math.max(Math.abs(nv.x), two ? Math.abs(nv.x2) : 0), unit = mag >= 10 ? Math.pow(10, Math.floor(Math.log10(mag))) : 1;
      const lo = Math.floor(Math.min(nv.x, two ? nv.x2 : nv.x) / unit) - 4, hi = Math.ceil(Math.max(nv.x, two ? nv.x2 : nv.x) / unit) + 4;
      const px = (v) => L + ((v / unit - lo) / (hi - lo)) * (R - L);
      if (!vz.firstChild) {
        let t = '';
        for (let n = lo; n <= hi; n++) t += `<line x1="${px(n * unit)}" y1="${ay - 7}" x2="${px(n * unit)}" y2="${ay + 7}" stroke="#32000c" stroke-width="2"/><text x="${px(n * unit)}" y="${ay + 28}" text-anchor="middle" class="a-nl">${n * unit}</text>`;
        const x = px(nv.x), end = two ? px(nv.x2) : nv.right ? R : L, tx = px(nv.test);
        const arrow = two ? '' : `<path d="${nv.right ? `M${R + 6} ${ay} l-12 -9 v18z` : `M${L - 6} ${ay} l12 -9 v18z`}" fill="#b3263e"/>`;
        const circ2 = two ? `<circle cx="${end}" cy="${ay}" r="10" fill="${nv.closed2 ? '#b3263e' : '#fff'}" stroke="#b3263e" stroke-width="4"/><text x="${end}" y="${ay - 22}" text-anchor="middle" class="a-nx">${esc(nv.label2)}</text>` : '';
        const cap = two ? esc(nv.label) : `${esc(nv.letter)} ${nv.right ? (nv.closed ? '≥' : '>') : (nv.closed ? '≤' : '<')} ${esc(nv.label)}`;
        vz.innerHTML = `<svg viewBox="0 0 ${W} 120" role="img" aria-label="Number line for the answer">
          <g class="a-nshade"><rect x="${Math.min(x, end)}" y="${ay - 9}" width="${Math.abs(end - x)}" height="18" rx="9" fill="rgba(179,38,62,.28)"/>${arrow}</g>
          <line x1="${L - 10}" y1="${ay}" x2="${R + 10}" y2="${ay}" stroke="#32000c" stroke-width="3"/>${t}
          <g class="a-ncirc"><circle cx="${x}" cy="${ay}" r="10" fill="${nv.closed ? '#b3263e' : '#fff'}" stroke="#b3263e" stroke-width="4"/>
            <text x="${x}" y="${ay - 22}" text-anchor="middle" class="a-nx">${cap}</text>${circ2}</g>
          <g class="a-ntest"><circle cx="${tx}" cy="${ay}" r="7" fill="#3b8a4f"/><text x="${tx}" y="${ay + 52}" text-anchor="middle" class="a-nt">test ${nv.test}</text></g></svg>`;
        vz._o = { x, end, tx };
      }
      const sh = vz.querySelector('.a-nshade'), ci = vz.querySelector('.a-ncirc'), te = vz.querySelector('.a-ntest');
      const on1 = k >= nv.at, on2 = k >= nv.test_at;
      sh.style.display = ci.style.display = on1 ? '' : 'none'; te.style.display = on2 ? '' : 'none';
      sh.style.transformOrigin = `${vz._o.x}px 62px`; ci.style.transformOrigin = `${vz._o.x}px 62px`; te.style.transformOrigin = `${vz._o.tx}px 62px`;
      if (anim && on1 && was < nv.at) {
        ci.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1.35)', offset: .6 }, { opacity: 1, transform: 'none' }], { duration: 600 / speed, easing: 'ease-out' });
        sh.animate([{ transform: 'scaleX(0)', opacity: .2 }, { transform: 'scaleX(1)', opacity: 1 }], { duration: 1100 / speed, delay: 350 / speed, easing: 'ease-in-out', fill: 'backwards' });
      }
      if (anim && on2 && was < nv.test_at) te.animate([{ opacity: 0, transform: 'translateY(-26px)' }, { opacity: 1, transform: 'translateY(4px)', offset: .7 }, { opacity: 1, transform: 'none' }], { duration: 700 / speed, easing: 'ease-out' });
    }
    // Graph (quadratics, simultaneous equations): the curve or lines draw themselves at their step, then the answer points pop on.
    const gv = opts.viz && opts.viz.kind === 'graph' ? opts.viz : null;
    const nice = (r) => { const raw = r / 8, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
    function drawGraph(k, animate) {
      vz.hidden = false;
      const anim = animate && !reduce(), was = vzK; vzK = k;
      if (!vz.firstChild) {
        const W = 520, H = 330, m = { l: 44, r: 16, t: 14, b: 30 };
        const keyX = gv.points.map((p) => p.x), keyY = gv.points.map((p) => p.y);
        let c0 = gv.curves[0];
        if (c0.type === 'quad' && c0.a) { keyX.push(-c0.b / (2 * c0.a)); }
        let x0 = Math.min(0, ...keyX), x1 = Math.max(0, ...keyX);
        let pad = Math.max(1, (x1 - x0) * 0.3); x0 -= pad; x1 += pad;
        const fy = (c, x) => c.type === 'quad' ? c.a * x * x + c.b * x + c.c : (c.b ? (c.c - c.a * x) / c.b : NaN);
        const ys = [0, ...keyY];
        for (let i = 0; i <= 40; i++) gv.curves.forEach((c) => { const v = fy(c, x0 + (x1 - x0) * i / 40); if (isFinite(v)) ys.push(v); });
        let y0 = Math.min(...ys), y1 = Math.max(...ys), py = Math.max(1, (y1 - y0) * 0.12); y0 -= py; y1 += py;
        const X = (v) => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r), Y = (v) => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
        const sx = nice(x1 - x0), sy = nice(y1 - y0);
        let g = '';
        for (let v = Math.ceil(x0 / sx) * sx; v <= x1; v += sx) { const r = +v.toFixed(6); g += `<line x1="${X(r)}" y1="${m.t}" x2="${X(r)}" y2="${H - m.b}" class="a-gl"/><text x="${X(r)}" y="${H - m.b + 18}" text-anchor="middle" class="a-nl">${r}</text>`; }
        for (let v = Math.ceil(y0 / sy) * sy; v <= y1; v += sy) { const r = +v.toFixed(6); g += `<line x1="${m.l}" y1="${Y(r)}" x2="${W - m.r}" y2="${Y(r)}" class="a-gl"/><text x="${m.l - 6}" y="${Y(r) + 5}" text-anchor="end" class="a-nl">${r}</text>`; }
        g += `<line x1="${m.l}" y1="${Y(0)}" x2="${W - m.r}" y2="${Y(0)}" class="a-ax"/><line x1="${X(0)}" y1="${m.t}" x2="${X(0)}" y2="${H - m.b}" class="a-ax"/>`;
        g += `<text x="${W - m.r - 4}" y="${Y(0) - 6}" text-anchor="end" class="a-nx" style="font-size:16px">${esc(gv.xl)}</text><text x="${X(0) + 8}" y="${m.t + 12}" class="a-nx" style="font-size:16px">${esc(gv.yl)}</text>`;
        const cols = ['#b3263e', '#2f6fb5'];
        gv.curves.forEach((c, i) => {
          if (c.shade) {
            let poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            const fv = (q) => c.shade * (c.a * q[0] + c.b * q[1] - c.c), out = [];
            poly.forEach((q, n) => { const r = poly[(n + 1) % poly.length], fq = fv(q), fr = fv(r); if (fq >= 0) out.push(q); if ((fq >= 0) !== (fr >= 0)) { const t = fq / (fq - fr); out.push([q[0] + t * (r[0] - q[0]), q[1] + t * (r[1] - q[1])]); } });
            if (out.length > 2) g += `<polygon class="a-gs" data-i="${i}" points="${out.map((q) => X(q[0]).toFixed(1) + ',' + Y(q[1]).toFixed(1)).join(' ')}" fill="${cols[i % 2]}" fill-opacity=".14" clip-path="url(#gclip)"/>`;
          }
          let d = '';
          if (c.type === 'quad') { for (let n = 0; n <= 80; n++) { const x = x0 + (x1 - x0) * n / 80; d += (n ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(fy(c, x)).toFixed(1); } }
          else if (c.b) { d = `M${X(x0)} ${Y(fy(c, x0))}L${X(x1)} ${Y(fy(c, x1))}`; }
          else { const x = c.c / c.a; d = `M${X(x)} ${H - m.b}L${X(x)} ${m.t}`; }
          g += `<path class="a-gc" data-i="${i}" d="${d}" pathLength="1" fill="none" stroke="${cols[i % 2]}" stroke-width="4" stroke-linecap="round" clip-path="url(#gclip)"${c.dashed ? ' data-dash="1"' : ''}/>`;
          const lx = c.type === 'quad' ? W - m.r - 4 : X(x1) - 4;
          g += `<text class="a-gl2" data-i="${i}" x="${Math.min(lx, W - m.r - 4)}" y="${Math.max(m.t + 14, Math.min(H - m.b - 6, c.type === 'quad' ? m.t + 14 : (c.b ? Y(fy(c, x1)) - 8 : m.t + 14 + i * 16)))}" text-anchor="end" fill="${cols[i % 2]}" class="a-nt" style="font-size:14px">${esc(c.label || '')}</text>`;
        });
        gv.points.forEach((p, i) => { if (p.hidden) return; g += `<g class="a-gp" data-i="${i}"><circle cx="${X(p.x)}" cy="${Y(p.y)}" r="9" fill="#3b8a4f" stroke="#fff" stroke-width="3"/><text x="${X(p.x)}" y="${Y(p.y) + (i % 2 ? 28 : -16)}" text-anchor="middle" class="a-nx" style="fill:#2a6a3a;font-size:17px">${esc(p.label)}</text></g>`; });
        vz.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Graph of the working"><defs><clipPath id="gclip"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></clipPath></defs>${g}</svg>`;
      }
      vz.querySelectorAll('.a-gc').forEach((e) => {
        const c = gv.curves[+e.dataset.i], on = k >= c.at, lab = vz.querySelector(`.a-gl2[data-i="${e.dataset.i}"]`);
        e.style.display = lab.style.display = on ? '' : 'none';
        const dsh = !!e.dataset.dash; e.style.strokeDasharray = dsh ? '10 8' : '1'; e.style.strokeDashoffset = '0';
        const sh = vz.querySelector(`.a-gs[data-i="${e.dataset.i}"]`); if (sh) sh.style.display = on ? '' : 'none';
        if (anim && on && dsh && was < c.at) { e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900 / speed, fill: 'backwards' }); lab.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900 / speed }); if (sh) sh.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200 / speed, delay: 500 / speed, fill: 'backwards' }); }
        else if (anim && on && was < c.at) { e.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 1300 / speed, delay: (+e.dataset.i) * 500 / speed, easing: 'ease-in-out', fill: 'backwards' }); lab.animate([{ opacity: 0 }, { opacity: 0, offset: .7 }, { opacity: 1 }], { duration: 1500 / speed, delay: (+e.dataset.i) * 500 / speed }); }
      });
      vz.querySelectorAll('.a-gp').forEach((e) => {
        const p = gv.points[+e.dataset.i], on = k >= p.at;
        e.style.display = on ? '' : 'none';
        e.style.transformOrigin = 'center'; e.style.transformBox = 'fill-box';
        if (anim && on && was < p.at) e.animate([{ opacity: 0, transform: 'translateY(-30px) scale(.4)' }, { opacity: 1, transform: 'translateY(4px) scale(1.2)', offset: .65 }, { opacity: 1, transform: 'none' }], { duration: 750 / speed, delay: (+e.dataset.i) * 250 / speed, easing: 'ease-out', fill: 'backwards' });
      });
    }
    // Triangle (Pythagoras, trigonometry): sides are labelled from the start; squares, side names and the answer arrive at their steps.
    const tv = opts.viz && opts.viz.kind === 'tri' ? opts.viz : null;
    function drawTri(k, animate) {
      vz.hidden = false;
      const anim = animate && !reduce(), was = vzK; vzK = k;
      if (!vz.firstChild) {
        const A = tv.a, B = tv.b, C = Math.hypot(A, B), sq = tv.squares;
        const O = [0, 0], P1 = [B, 0], P2 = [0, -A];
        const sa = [O, P2, [-A, -A], [-A, 0]], sb = [O, P1, [B, B], [0, B]], sc = [P1, P2, [A, -A - B], [A + B, -B]];
        const all = [O, P1, P2].concat(sq ? sa.concat(sb, sc) : []);
        const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const W = 520, H = 340, pad = 30, s = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
        const ox = pad + ((W - 2 * pad) - (x1 - x0) * s) / 2 - x0 * s, oy = pad + ((H - 2 * pad) - (y1 - y0) * s) / 2 - y0 * s;
        const T = (p) => [ox + p[0] * s, oy + p[1] * s], f = (p) => T(p).map((v) => v.toFixed(1)).join(',');
        const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        let g = '';
        if (sq) {
          [['a', sa], ['b', sb], ['c', sc]].forEach(([key, pts]) => {
            const info = sq[key]; if (!info) return;
            const cx = (pts[0][0] + pts[2][0]) / 2, cy = (pts[0][1] + pts[2][1]) / 2, c = T([cx, cy]);
            g += `<g class="a-sq" data-k="${key}"><polygon points="${pts.map(f).join(' ')}" fill="${info[2] ? 'rgba(59,138,79,.22)' : 'rgba(179,38,62,.16)'}" stroke="${info[2] ? '#3b8a4f' : '#b3263e'}" stroke-width="2"/>
              <text x="${c[0]}" y="${c[1] + 20}" text-anchor="middle" class="a-nx a-sqt" data-n="${esc(info[0])}" data-v="${esc(info[0] + ' = ' + info[1])}" style="font-size:15px">${esc(info[0])}</text></g>`;
          });
        }
        g += `<polygon points="${[O, P1, P2].map(f).join(' ')}" fill="rgba(50,0,12,.06)" stroke="#32000c" stroke-width="3.5" stroke-linejoin="round"/>`;
        const o = T(O); g += `<path d="M${o[0] + 14} ${o[1]} v-14 h-14" fill="none" stroke="#32000c" stroke-width="2"/>`;
        const lab = (key, p, dx, dy) => {
          const q = T(p), t = tv.labels[key] || '', af = tv.after && tv.after[key];
          return `<g class="a-tl" data-k="${key}"><text x="${q[0] + dx}" y="${q[1] + dy}" text-anchor="middle" class="a-nx a-tlt" data-b="${esc(t)}" data-a="${esc(af || '')}" style="font-size:19px;paint-order:stroke;stroke:#fff;stroke-width:5px">${esc(t)}</text>` +
            (tv.names ? `<text x="${q[0] + dx}" y="${q[1] + dy + 16}" text-anchor="middle" class="a-nt a-tln" style="font-size:12px;fill:#6b4a53;paint-order:stroke;stroke:#fff;stroke-width:4px">${esc(tv.names[key] || '')}</text>` : '') + `</g>`;
        };
        const nx = A / C, ny = B / C;
        g += sq ? lab('a', [-A / 2, -A / 2], 0, -2) + lab('b', [B / 2, B / 2], 0, -2) + lab('c', [(B + A) / 2, -(A + B) / 2], 0, -2)
          : lab('a', mid(O, P2), 36, 4) + lab('b', mid(O, P1), 0, -30) + lab('c', mid(P1, P2), -34 * nx, 34 * ny - 2);
        if (tv.angle) {
          const p = T(P1), r = 34, ph = Math.atan2(A, B), ex = p[0] - r * Math.cos(ph), ey = p[1] - r * Math.sin(ph);
          const bx = p[0] - 52, by = p[1] + 26;
          g += `<path d="M${p[0] - r} ${p[1]} A${r} ${r} 0 0 1 ${ex} ${ey}" fill="none" stroke="#b3263e" stroke-width="3"/><text x="${bx}" y="${by + 5}" text-anchor="middle" class="a-nx a-ang" data-b="${esc(tv.angle.label)}" data-a="${esc(tv.angle.after || '')}" style="font-size:17px;fill:#b3263e;paint-order:stroke;stroke:#fff;stroke-width:4px">${esc(tv.angle.label)}</text>`;
        }
        vz.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Right-angled triangle">${g}</svg>`;
      }
      vz.querySelectorAll('.a-sq').forEach((e) => {
        const on = k >= (tv.sq_at || 0), t = e.querySelector('.a-sqt'), num = k >= (tv.sqn_at || 0);
        e.style.display = on ? '' : 'none'; t.textContent = num ? t.dataset.v : t.dataset.n;
        e.style.transformBox = 'fill-box'; e.style.transformOrigin = 'center';
        if (anim && on && was < (tv.sq_at || 0)) e.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'none' }], { duration: 700 / speed, easing: 'ease-out', fill: 'backwards' });
        if (anim && num && was < (tv.sqn_at || 0)) t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600 / speed });
      });
      vz.querySelectorAll('.a-tln').forEach((e) => { e.style.display = k >= (tv.names_at || 0) ? '' : 'none'; });
      const after = k >= (tv.after_at || 0);
      vz.querySelectorAll('.a-tlt').forEach((e) => {
        const swap = after && e.dataset.a; e.textContent = swap ? e.dataset.a : e.dataset.b;
        e.style.fill = swap ? '#2a6a3a' : '';
        if (anim && swap && was < (tv.after_at || 0)) { e.style.transformBox = 'fill-box'; e.style.transformOrigin = 'center'; e.animate([{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1.35)', offset: .6 }, { opacity: 1, transform: 'none' }], { duration: 700 / speed }); }
      });
      const an = vz.querySelector('.a-ang');
      if (an) { const swap = after && an.dataset.a; an.textContent = swap ? an.dataset.a : an.dataset.b; if (anim && swap && was < (tv.after_at || 0)) an.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 700 / speed }); }
    }
    // Circle: a plain circle with its radius; the circumference, area, arc or sector lights up at its step, then the answer appears.
    const cv = opts.viz && opts.viz.kind === 'circle' ? opts.viz : null;
    const sc = opts.viz && opts.viz.kind === 'scalene' ? opts.viz : null;
    function drawCircle(k, animate) {
      vz.hidden = false;
      const anim = animate && !reduce(), was = vzK; vzK = k;
      const W = 520, H = 280, cx = 190, cy = 140, R = 100;
      if (!vz.firstChild) {
        const th = cv.angle, rad = th ? th * Math.PI / 180 : 0, ex = cx + R * Math.cos(rad), ey = cy - R * Math.sin(rad), big = th > 180 ? 1 : 0;
        let hi = '';
        if (cv.mode === 'circ') hi = `<circle class="a-hi" cx="${cx}" cy="${cy}" r="${R}" pathLength="1" fill="none" stroke="#b3263e" stroke-width="7" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`;
        else if (cv.mode === 'area') hi = `<circle class="a-hi" cx="${cx}" cy="${cy}" r="${R}" fill="rgba(179,38,62,.28)"/>`;
        else if (cv.mode === 'arc') hi = `<path class="a-hi" d="M${cx + R} ${cy} A${R} ${R} 0 ${big} 0 ${ex} ${ey}" pathLength="1" fill="none" stroke="#b3263e" stroke-width="8" stroke-linecap="round"/><line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" stroke="#b3263e" stroke-width="2" stroke-dasharray="5 4" class="a-hi2"/>`;
        else hi = `<path class="a-hi" d="M${cx} ${cy} L${cx + R} ${cy} A${R} ${R} 0 ${big} 0 ${ex} ${ey} Z" fill="rgba(179,38,62,.32)" stroke="#b3263e" stroke-width="2"/>`;
        const name = { circ: 'C', area: 'A', arc: 'l', sector: 'A' }[cv.mode];
        const mx = cx + 34 * Math.cos(rad / 2), my = cy - 34 * Math.sin(rad / 2);
        vz.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Circle diagram"><circle cx="${cx}" cy="${cy}" r="${R}" fill="rgba(50,0,12,.04)" stroke="#32000c" stroke-width="3"/>${hi}
          <line x1="${cx}" y1="${cy}" x2="${cx + R}" y2="${cy}" stroke="#32000c" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="4.5" fill="#32000c"/>
          <text x="${cx + R / 2}" y="${cy + 22}" text-anchor="middle" class="a-nx" style="font-size:17px;paint-order:stroke;stroke:#fff;stroke-width:4px">r = ${esc(cv.r)}</text>
          ${th ? `<text x="${mx}" y="${my + 5}" text-anchor="middle" class="a-nx" style="font-size:15px;fill:#b3263e;paint-order:stroke;stroke:#fff;stroke-width:4px">${th}°</text>` : ''}
          <g class="a-cres"><text x="372" y="${cy - 6}" text-anchor="middle" class="a-nx" style="font-size:20px">${name} ≈</text><text x="372" y="${cy + 26}" text-anchor="middle" class="a-nx" style="font-size:28px;fill:#2a6a3a">${esc(cv.result)}</text></g></svg>`;
      }
      const hi = vz.querySelector('.a-hi'), hi2 = vz.querySelector('.a-hi2'), res = vz.querySelector('.a-cres'), on = k >= cv.at;
      hi.style.display = on ? '' : 'none'; if (hi2) hi2.style.display = on ? '' : 'none';
      res.style.display = k >= cv.after_at ? '' : 'none';
      if (cv.mode === 'circ' || cv.mode === 'arc') { hi.style.strokeDasharray = '1'; hi.style.strokeDashoffset = '0'; }
      if (anim && on && was < cv.at) {
        if (cv.mode === 'circ' || cv.mode === 'arc') hi.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 1400 / speed, easing: 'ease-in-out', fill: 'backwards' });
        else hi.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900 / speed, fill: 'backwards' });
      }
      if (anim && k >= cv.after_at && was < cv.after_at) res.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 700 / speed });
    }
    function drawScalene(k, animate) {
      vz.hidden = false;
      const anim = animate && !reduce(), was = vzK; vzK = k;
      if (!vz.firstChild) {
        const P = sc.pts, xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const W = 520, H = 320, pad = 50, s = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
        const ox = pad + ((W - 2 * pad) - (x1 - x0) * s) / 2 - x0 * s, oy = pad + ((H - 2 * pad) - (y1 - y0) * s) / 2 - y0 * s;
        const T = (p) => [ox + p[0] * s, oy + p[1] * s];
        const Q = P.map(T), cen = [(Q[0][0] + Q[1][0] + Q[2][0]) / 3, (Q[0][1] + Q[1][1] + Q[2][1]) / 3];
        let g = `<polygon points="${Q.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="rgba(50,0,12,.06)" stroke="#32000c" stroke-width="3.5" stroke-linejoin="round"/>`;
        ['A', 'B', 'C'].forEach((n, i) => { const q = Q[i], dx = q[0] - cen[0], dy = q[1] - cen[1], L = Math.hypot(dx, dy) || 1; g += `<text x="${q[0] + dx / L * 16}" y="${q[1] + dy / L * 16 + 5}" text-anchor="middle" style="font-size:17px;font-weight:700;fill:#32000c">${n}</text>`; });
        sc.labels.forEach((l, n) => {
          let x, y;
          if (l.kind === 'side') { const [p, q] = [[1, 2], [0, 2], [0, 1]][l.i]; const m = [(Q[p][0] + Q[q][0]) / 2, (Q[p][1] + Q[q][1]) / 2]; const dx = m[0] - cen[0], dy = m[1] - cen[1], L = Math.hypot(dx, dy) || 1; x = m[0] + dx / L * 26; y = m[1] + dy / L * 26 + 5; }
          else { const q = Q[l.i], dx = cen[0] - q[0], dy = cen[1] - q[1], L = Math.hypot(dx, dy) || 1; x = q[0] + dx / L * 48; y = q[1] + dy / L * 48 + 5; }
          g += `<text class="a-sl" data-n="${n}" x="${x}" y="${y}" text-anchor="middle" style="font-size:16px;fill:${l.kind === 'angle' ? '#b3263e' : '#32000c'};paint-order:stroke;stroke:#fff;stroke-width:4px">${esc(l.before)}</text>`;
        });
        vz.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Triangle diagram">${g}</svg>`;
      }
      const done = k >= sc.after_at;
      vz.querySelectorAll('.a-sl').forEach((e) => {
        const l = sc.labels[+e.dataset.n], txt = done ? l.after : l.before;
        e.textContent = txt;
        if (l.target && done) { e.style.fill = '#2a6a3a'; e.style.fontWeight = '700'; if (anim && was < sc.after_at) e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700 / speed }); } else if (l.target) { e.style.fill = '#b3263e'; }
      });
    }
    function drawViz(k, animate) {
      if (tv) return drawTri(k, animate);
      if (sc) return drawScalene(k, animate);
      if (cv) return drawCircle(k, animate);
      if (gv) return drawGraph(k, animate);
      if (nv) return drawLine(k, animate);
      if (bv) return drawBars(k, animate);
      if (!viz) return;
      vz.hidden = false;
      if (!vz.firstChild) {
        const nc = viz.cols.length;
        vz.innerHTML = `<div class="a-grid" style="grid-template-columns:auto repeat(${nc},minmax(70px,1fr))"><span class="a-corner">×</span>${viz.cols.map((c) => `<span class="a-hd">${esc(c)}</span>`).join('')}${viz.rows.map((r, ri) => `<span class="a-hd">${esc(r)}</span>` + viz.cols.map((_, ci) => `<span class="a-cell" data-i="${ri * nc + ci}">${esc(viz.cells[ri * nc + ci])}</span>`).join('')).join('')}</div><div class="a-total" hidden>${esc(viz.total)}</div>`;
      }
      const cells = [...vz.querySelectorAll('.a-cell')], tot = vz.querySelector('.a-total');
      const filled = k >= viz.fill, merged = k >= viz.merge;
      const was = vzK; vzK = k;
      cells.forEach((c, n) => {
        const show = filled, newly = show && (was < viz.fill) && animate && !reduce();
        c.classList.toggle('on', show);
        c.style.transitionDelay = newly ? (n * 220 / speed) + 'ms' : '0ms';
        c.style.opacity = show ? '' : '0';
        const g = viz.like.findIndex((grp) => grp.includes(n));
        c.classList.toggle('like', merged && g >= 0); c.dataset.g = merged && g >= 0 ? g : '';
        if (newly) c.animate([{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1.12)', offset: .7 }, { opacity: 1, transform: 'none' }], { duration: 520 / speed, delay: n * 220 / speed, fill: 'backwards', easing: 'ease-out' });
      });
      tot.hidden = !merged;
      if (merged && animate && !reduce() && was < viz.merge) tot.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 600 / speed, delay: 500 / speed, fill: 'backwards' });
    }
    const fill = (k) => {
      const s = steps[k];
      if (s.op) { opEl.hidden = false; opEl.textContent = 'Both sides: ' + s.op; } else opEl.hidden = true;
      if (s.calc) { calcEl.hidden = false; calcEl.textContent = s.calc; } else calcEl.hidden = true;
      $('.a-count').textContent = `Step ${k + 1} of ${steps.length}`;
      $('.a-rule').textContent = s.rule || '';
      $('.a-text').textContent = s.text || '';
      dots.querySelectorAll('button').forEach((d, n) => { d.classList.toggle('on', n === k); d.classList.toggle('past', n < k); });
      $('[data-a=back]').disabled = k === 0; $('[data-a=next]').disabled = k === steps.length - 1;
      $('[data-a=rew]').disabled = k === 0;
      $('[data-a=play]').textContent = playing ? '⏸ Pause' : (k === steps.length - 1 ? '↻ Replay' : '▶ Play');
      $('[data-a=speed]').textContent = speed + '×';
    };
    // Morph the line from the current step to step n. Returns when the motion has finished.
    async function show(n) {
      const my = ++gen, next = tokens(steps[n].math || ''), D = 650 / speed;
      const oldEls = [...line.querySelectorAll('.a-t')], lr = line.getBoundingClientRect();
      const oldPos = oldEls.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left - lr.left, y: r.top - lr.top, w: r.width, h: r.height, t: e.textContent }; });
      const m = match(cur, next);
      line.innerHTML = lineHtml(next);
      cur = next; i = n; fill(n);
      drawPic(n, true); drawViz(n, true);
      if (reduce()) return;
      [opEl, calcEl].forEach((e) => { if (!e.hidden) e.animate([{ opacity: 0, transform: 'translateY(6px) scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: D, easing: 'ease-out' }); });
      const used = new Set(), anims = [], ln = line.getBoundingClientRect();
      line.querySelectorAll('.a-t').forEach((e, j) => {
        const r = e.getBoundingClientRect();
        if (m.has(j)) {
          const o = oldPos[m.get(j)]; used.add(m.get(j));
          const dx = o.x - (r.left - ln.left), dy = o.y - (r.top - ln.top);
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) anims.push(e.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: D, easing: 'cubic-bezier(.4,0,.2,1)' }).finished);
        } else {
          e.classList.add('a-new');
          anims.push(e.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 0, transform: 'scale(.6)', offset: .45 }, { opacity: 1, transform: 'scale(1.18)', offset: .8 }, { opacity: 1, transform: 'none' }], { duration: D * 1.5 }).finished);
        }
      });
      // Symbols that leave: a ghost at the old place, struck out, then faded.
      oldPos.forEach((o, k) => {
        if (used.has(k)) return;
        const g = document.createElement('span'); g.className = 'a-t a-gone'; g.textContent = o.t;
        g.style.cssText = `position:absolute;left:${o.x}px;top:${o.y}px;pointer-events:none`;
        line.appendChild(g);
        anims.push(g.animate([{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0, transform: 'translateY(-8px)' }], { duration: D * 1.3, fill: 'forwards' }).finished.then(() => g.remove()));
      });
      try { await Promise.all(anims); } catch { /* a newer step took over */ }
      if (my !== gen) return;
    }
    const hold = (k) => Math.min(4200, Math.max(1100, 700 + (steps[k].text || "").length * 30)) / speed;
    const stop = () => { playing = false; clearTimeout(timer); fill(i); };
    async function tick() {
      if (!alive || !playing) return;
      const n = i + dir;
      if (n < 0 || n >= steps.length) { stop(); return; }
      await show(n);
      if (!alive || !playing) return;
      if (i === 0 || i === steps.length - 1) { stop(); return; }
      timer = setTimeout(tick, hold(i));
    }
    const play = (d) => {
      clearTimeout(timer); dir = d;
      if (d > 0 && i === steps.length - 1) { playing = true; show(0).then(() => { timer = setTimeout(tick, hold(0)); }); fill(i); return; }
      playing = true; fill(i); timer = setTimeout(tick, 150);
    };
    const manual = (n) => { clearTimeout(timer); playing = false; if (n >= 0 && n < steps.length) show(n); };
    host.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.k != null) return manual(+b.dataset.k);
      const a = b.dataset.a;
      if (a === 'play') { playing ? stop() : play(1); }
      else if (a === 'rew') { playing && dir < 0 ? stop() : play(-1); }
      else if (a === 'back') manual(i - 1);
      else if (a === 'next') manual(i + 1);
      else if (a === 'speed') { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; if (MTRX.prefs) MTRX.prefs.set('solve.speed', speed); fill(i); }
    });
    stage.addEventListener('keydown', (e) => {
      if (e.target.closest('button') && e.key === ' ') return; // let a focused button handle its own Space
      if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); manual(i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); manual(i - 1); }
    });
    fill(0); drawPic(0, false); drawViz(0, false);
    if (opts.autoplay && steps.length > 1 && !reduce()) setTimeout(() => alive && play(1), 500);
    return { destroy() { alive = false; clearTimeout(timer); }, go: manual, play: () => play(1), state: () => ({ i, playing }) };
  }
  MTRX.solveAnim = { mount };
})();
