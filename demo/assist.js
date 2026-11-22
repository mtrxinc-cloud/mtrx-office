// Writing assistance for Writer: word suggestions (Tab to accept), capital letters (sentences, names, places, "I"),
// punctuation and quotes, apostrophes in short forms, and a full stop when Enter ends a sentence.
// Everything runs on this PC. Words you type and names you capitalise are remembered per user (MTRX.prefs).
// Ctrl+Z straight after an automatic change puts back what you typed and stops that word being changed again.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const D = MTRX.assistData;
  const $ = (s) => document.querySelector(s);
  const { ed, msg, modal } = MTRX.w;
  if (!D) return;

  // ---------------- settings and memory ----------------
  const DEFAULTS = { complete: true, caps: true, punct: true, period: true };
  const on = (k) => { const o = MTRX.prefs.get('assist.on', {}) || {}; return o[k] ?? DEFAULTS[k]; };
  const load = (k, d) => { const v = MTRX.prefs.get('assist.' + k, d); return v == null ? d : v; };
  let learnedWords = load('words', {}), learnedNames = new Set(load('names', [])), skip = new Set(load('skip', []));
  const wordsSet = new Set(D.WORDS), builtinNames = new Set(D.NAMES), places = new Set(D.PLACES), abbr = new Set(D.ABBR);
  const isName = (k) => builtinNames.has(k) || learnedNames.has(k) || places.has(k);
  let saveT;
  const saveSoon = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      const keys = Object.keys(learnedWords);
      if (keys.length > 4000) { keys.sort((a, b) => learnedWords[b] - learnedWords[a]).slice(3000).forEach((k) => delete learnedWords[k]); }
      MTRX.prefs.set('assist.words', learnedWords); MTRX.prefs.set('assist.names', [...learnedNames]); MTRX.prefs.set('assist.skip', [...skip]);
    }, 1500);
  };

  // ---------------- text helpers ----------------
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  let busy = false, composing = false, lastFix = null, noticed = false;
  const run = (fn) => { busy = true; try { return fn(); } finally { busy = false; } };

  const blockOf = (n) => { let e = n.parentElement; while (e && e !== ed && !/^(P|H1|H2|H3|LI|TD|TH|DIV)$/.test(e.tagName)) e = e.parentElement; return e && e !== ed ? e : ed; };
  function caret() {
    const s = getSelection(); if (!s.rangeCount || !s.isCollapsed) return null;
    const n = s.anchorNode; if (!n || n.nodeType !== 3 || !ed.contains(n)) return null;
    if (n.parentElement.closest('.toc,[contenteditable=false],sup.fn')) return null;
    return { node: n, off: s.anchorOffset, block: blockOf(n) };
  }
  const textBefore = (block, node, off) => { const r = document.createRange(); r.setStart(block, 0); r.setEnd(node, off); return r.toString(); };
  const posAt = (block, n, preferEnd) => {
    const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let acc = 0, t, last = null;
    while ((t = w.nextNode())) {
      const l = t.data.length;
      if (preferEnd ? n <= acc + l : n < acc + l) return { node: t, off: n - acc };
      acc += l; last = t;
    }
    return last ? { node: last, off: last.data.length } : { node: block, off: 0 };
  };
  const setCaret = (block, n) => { const p = posAt(block, n, true); const r = document.createRange(); r.setStart(p.node, p.off); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
  const replaceAt = (block, start, end, text) => {
    const a = posAt(block, start, false), b = posAt(block, end, true);
    const r = document.createRange(); r.setStart(a.node, a.off); r.setEnd(b.node, b.off);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    run(() => document.execCommand('insertText', false, text));
  };
  const insert = (text) => run(() => document.execCommand('insertText', false, text));

  // Is the next letter the first of a sentence? (`t` is the text before it)
  function sentStart(t) {
    if (/^\s*$/.test(t)) return true;
    const m = /(\S+)\s+$/.exec(t); if (!m) return false;
    const tok = m[1];
    if (!/[.!?]["”’')\]]*$/.test(tok)) return false;
    if (/^\p{L}\.$/u.test(tok) || abbr.has(tok.toLowerCase())) return false;
    return true;
  }

  // ---------------- fixing the word before a boundary ----------------
  // Returns {from,to,text} for a change to the word, or null.
  function wordChange(w, before, learn) {
    const key = w.toLowerCase().replace(/’/g, "'");
    if (skip.has(key) || /\d/.test(w)) return null;
    const keep = (rep) => (w[0] !== w[0].toLowerCase() && rep[0] === rep[0].toLowerCase() ? cap(rep) : rep);
    if (on('punct')) {
      if (D.SLIPS[key]) return keep(D.SLIPS[key]);
      if (!w.includes("'") && D.FIX[key]) return keep(D.FIX[key]);
    }
    if (on('caps')) {
      if (w === 'i') return 'I';
      if (/^i['’](m|ll|ve|d)$/.test(w)) return 'I' + w.slice(1);
      if (w === key && isName(key) && w.length > 1) return cap(w);
    }
    if (learn) {
      if (key.length >= 3 && !key.includes("'")) {
        const capitalised = w[0] !== w[0].toLowerCase() && w.slice(1) === w.slice(1).toLowerCase();
        if (capitalised && !sentStart(before) && !wordsSet.has(key) && !learnedWords[key] && !isName(key)) { learnedNames.add(key); saveSoon(); }
        else if (w === key && !wordsSet.has(key) && !isName(key)) { learnedWords[key] = (learnedWords[key] || 0) + 1; saveSoon(); }
      }
    }
    return null;
  }

  // Look at the word that ends `endOff` characters into `block` and fix it. Returns the change in length (0 if none).
  function fixWord(block, endOff, text) {
    const m = /([\p{L}][\p{L}'’]*)$/u.exec(text.slice(0, endOff)); if (!m) return 0;
    const w = m[1], start = endOff - w.length;
    const prev = text.charAt(start - 1);
    if (/[./@_#:\\\-\d]/.test(prev) && prev !== '-') return 0; // part of an address or file name
    if (/https?:|@|\.\w{2,4}\b/.test(text.slice(Math.max(0, start - 12), endOff))) { /* looks like a web address */ if (/[/@]/.test(text.slice(Math.max(0, start - 12), endOff))) return 0; }
    const rep = wordChange(w, text.slice(0, start), true);
    if (!rep || rep === w) return 0;
    replaceAt(block, start, endOff, rep);
    lastFix = { block, start, original: w, text: rep, key: w.toLowerCase().replace(/’/g, "'"), caret: null };
    return rep.length - w.length;
  }

  // ---------------- typing hooks ----------------
  ed.addEventListener('compositionstart', () => { composing = true; });
  ed.addEventListener('compositionend', () => { composing = false; });

  ed.addEventListener('beforeinput', (e) => {
    if (busy || composing || e.isComposing || e.inputType !== 'insertText' || !e.data || e.data.length !== 1) return;
    let c = caret(), t;
    if (!c) { // empty paragraph: no text node yet
      const s = getSelection(); const n = s.rangeCount && s.isCollapsed ? s.anchorNode : null;
      if (!n || n.nodeType !== 1 || !ed.contains(n) || n.textContent) return;
      t = '';
    } else t = textBefore(c.block, c.node, c.off);
    const ch = e.data;
    if (c && /[ .,;:!?)\]]/.test(ch) && (on('caps') || on('punct'))) { // fix the word just finished, in one insert with the typed character
      const m = /([\p{L}][\p{L}'’]*)$/u.exec(t);
      if (m) {
        const w = m[1], start = t.length - w.length, prev = t.charAt(start - 1);
        const web = /[/@:\\_#]/.test(prev) || /[/@]/.test(t.slice(Math.max(0, start - 12)));
        const rep = web ? null : wordChange(w, t.slice(0, start), true);
        if (rep && rep !== w) {
          e.preventDefault();
          replaceAt(c.block, start, t.length, rep + ch);
          lastFix = { block: c.block, start, original: w, text: rep, key: w.toLowerCase().replace(/’/g, "'"), caret: start + rep.length + 1 };
          return;
        }
      }
    }
    if (!c) { if (on('caps') && /[a-z]/.test(ch)) { e.preventDefault(); insert(ch.toUpperCase()); } return; }
    if (on('punct') && (ch === "'" || ch === '"')) {
      e.preventDefault();
      const closing = /[\p{L}\d.,!?;:)’”]$/u.test(t);
      insert(ch === '"' ? (closing ? '”' : '“') : (closing ? '’' : '‘'));
      return;
    }
    if (on('punct') && /\p{L}/u.test(ch) && /\p{L}[,;!]$/u.test(t) && !/@|:\/\//.test(t.slice(-30))) { // a space after a comma
      e.preventDefault(); insert(' ' + ch); return;
    }
    if (on('caps') && /[a-z]/.test(ch) && sentStart(t)) { e.preventDefault(); insert(ch.toUpperCase()); }
  });

  ed.addEventListener('input', (e) => {
    if (busy) return;
    if (e.inputType !== 'insertText') { lastFix = null; hideGhost(); if (e.inputType === 'deleteContentBackward') ghost(); return; }
    lastFix = null;
    if (composing || e.isComposing || !e.data || e.data.length !== 1) { hideGhost(); return; }
    if (!noticed && !MTRX.prefs.get('assist.notice', false)) { noticed = true; MTRX.prefs.set('assist.notice', true); msg('Writing assistance is on. Change it under Edit, Writing assistance'); }
    const c = caret(); if (!c) { hideGhost(); return; }
    const ch = e.data;
    if (/\p{L}/u.test(ch)) { ghost(); return; }
    hideGhost();
    let { block } = c;
    let end = textBefore(block, c.node, c.off).length; // caret, after the typed character
    let text = block.textContent;
    const boundary = /[ .,;:!?)\]"”’]/.test(ch);
    if (!boundary && ch !== '-') return;
    text = text.replace(/ /g, ' ');
    if (!on('punct')) { saveSoon(); return; }
    const before1 = text.charAt(end - 2), before2 = text.charAt(end - 3);
    const keepFix = lastFix;
    if (ch === '-' && before1 === '-' && before2 && before2 !== '-') { replaceAt(block, end - 2, end, '—'); setCaret(block, end - 1); }
    else if (ch === '.' && before1 === '.' && before2 === '.' && text.charAt(end - 4) !== '.') { replaceAt(block, end - 3, end, '…'); setCaret(block, end - 2); }
    else if (ch === ' ' && before1 === ' ' && /[\p{L}\d)]/u.test(before2) && block.tagName !== 'PRE') { replaceAt(block, end - 2, end, '. '); setCaret(block, end); }
    else if (/[,;!?.]/.test(ch) && before1 === ' ' && /[\p{L}\d)”"']/u.test(before2 || '') && !(ch === '.' && /\.\.|…/.test(text.slice(end - 4, end - 1)))) { replaceAt(block, end - 2, end - 1, ''); setCaret(block, end - 1); }
    lastFix = keepFix;
    saveSoon();
  });

  // Enter: fix the last word, and finish the sentence with a full stop when it clearly is one.
  ed.addEventListener('keydown', (e) => {
    if (composing || e.isComposing) return;
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && lastFix) {
      const c = caret();
      if (c && lastFix.caret != null && textBefore(c.block, c.node, c.off).length === lastFix.caret && lastFix.block === c.block) {
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        const f = lastFix; lastFix = null;
        replaceAt(f.block, f.start, f.start + f.text.length, f.original); setCaret(f.block, f.caret - f.text.length + f.original.length);
        skip.add(f.key); saveSoon(); msg('Put back. That word will not be changed again');
        return;
      }
    }
    if (e.key === 'Tab' && !e.shiftKey && ghostOn()) { e.preventDefault(); e.stopImmediatePropagation(); acceptGhost(); return; }
    if (e.key === 'Escape' && ghostOn()) { hideGhost(); return; }
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const c = caret(); if (!c) return;
    const block = c.block, end = textBefore(block, c.node, c.off).length, text = block.textContent;
    if (end !== text.length || !text.trim()) return;
    if (/\S/.test(text) && (on('caps') || on('punct'))) { const d = fixWord(block, end, text); if (d) setCaret(block, end + d); }
    if (!on('period') || block.parentNode !== ed || block.tagName !== 'P' || block.dataset.st === 'title' || block.dataset.st === 'subtitle' || block.dataset.st === 'caption') return;
    const t = block.textContent.trimEnd();
    if (t.split(/\s+/).length < 4 || !/[\p{L}\d)\]]$/u.test(t) || /^\s*[\d\p{L}]{1,3}[.)]\s/u.test(t)) return;
    setCaret(block, block.textContent.length);
    insert('.'); lastFix = null;
  }, true);

  // ---------------- word suggestions ----------------
  let docCache = { t: 0, m: new Map() };
  const docWords = () => {
    if (Date.now() - docCache.t < 3000) return docCache.m;
    const m = new Map(); (ed.textContent.toLowerCase().match(/\p{L}{4,}/gu) || []).forEach((w) => m.set(w, (m.get(w) || 0) + 1));
    docCache = { t: Date.now(), m }; return m;
  };
  function suggest(prefix) {
    const p = prefix.toLowerCase(), upper = prefix[0] !== p[0];
    let best = null, score = 0;
    const consider = (w, s, display) => { if (w.length > p.length && w.startsWith(p) && s > score) { best = display || w; score = s; } };
    for (const [w, n] of Object.entries(learnedWords)) if (n >= 2) consider(w, 3 + Math.min(n, 20) / 10);
    for (const [w, n] of docWords()) consider(w, 2 + Math.min(n, 10) / 10);
    D.WORDS.forEach((w, i) => consider(w, 1 - i / (D.WORDS.length * 2)));
    if (upper) { const names = [...D.NAMES, ...D.PLACES, ...learnedNames]; names.forEach((w) => consider(w, 2.5, cap(w))); }
    return best && upper && best === best.toLowerCase() ? cap(best) : best;
  }

  const gh = document.createElement('div');
  gh.id = 'as-ghost'; gh.hidden = true; document.body.appendChild(gh);
  let pending = '';
  const ghostOn = () => !gh.hidden && pending;
  function hideGhost() { gh.hidden = true; pending = ''; }
  function ghost() {
    if (!on('complete') || composing) return hideGhost();
    const c = caret(); if (!c) return hideGhost();
    const t = c.node.data, next = t.charAt(c.off);
    if (next && /[\p{L}\d]/u.test(next)) return hideGhost();
    const m = /([\p{L}]+)$/u.exec(t.slice(0, c.off)); if (!m || m[1].length < 3) return hideGhost();
    if (/[@/.\d]/.test(t.charAt(c.off - m[1].length - 1))) return hideGhost();
    const full = suggest(m[1]); if (!full) return hideGhost();
    pending = full.slice(m[1].length);
    const r = document.createRange(); r.setStart(c.node, c.off - 1); r.setEnd(c.node, c.off);
    const box = r.getBoundingClientRect(); if (!box.height) return hideGhost();
    const cs = getComputedStyle(c.node.parentElement);
    Object.assign(gh.style, { left: box.right + 'px', top: box.top + 'px', fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: box.height + 'px', fontWeight: cs.fontWeight, fontStyle: cs.fontStyle });
    gh.innerHTML = ''; gh.append(document.createTextNode(pending)); const k = document.createElement('i'); k.textContent = 'Tab'; gh.append(k);
    gh.hidden = false;
  }
  function acceptGhost() {
    const s = pending; hideGhost(); if (!s) return;
    insert(s); lastFix = null;
    const c = caret(); if (c) { const m = /([\p{L}]+)$/u.exec(c.node.data.slice(0, c.off)); if (m) { const k = m[1].toLowerCase(); if (learnedWords[k]) learnedWords[k] += 1; saveSoon(); } }
  }
  document.addEventListener('selectionchange', () => { if (!gh.hidden) { const c = caret(); if (!c) hideGhost(); } });
  ed.addEventListener('blur', hideGhost);
  ed.addEventListener('scroll', hideGhost, true);
  document.addEventListener('scroll', hideGhost, true);
  ed.addEventListener('mousedown', hideGhost);

  // ---------------- settings dialog ----------------
  const lines = (s) => s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  function dialog() {
    const o = { ...DEFAULTS, ...(MTRX.prefs.get('assist.on', {}) || {}) };
    const ck = (id, k, label) => `<label><input type="checkbox" id="${id}" style="width:auto"${o[k] ? ' checked' : ''}> ${label}</label>`;
    const topWords = Object.keys(learnedWords).sort((a, b) => learnedWords[b] - learnedWords[a]).slice(0, 400);
    modal('Writing assistance',
      `${ck('m-ac', 'complete', 'Suggest words as I type (press Tab to accept)')}
       ${ck('m-aa', 'caps', 'Capital letters: sentences, names, places and "I"')}
       ${ck('m-ap', 'punct', 'Punctuation: quotes, apostrophes (dont to don’t), spacing, dashes')}
       ${ck('m-ae', 'period', 'Add a full stop when I press Enter after a sentence')}
       <label>My names (one per line, any language)</label><textarea id="m-an" rows="4" spellcheck="false">${[...learnedNames].sort().map((n) => cap(n)).join('\n')}</textarea>
       <label>My words</label><textarea id="m-aw" rows="3" spellcheck="false">${topWords.join('\n')}</textarea>
       <label>Never change these</label><textarea id="m-as" rows="2" spellcheck="false">${[...skip].sort().join('\n')}</textarea>
       <label>Add words from a text file</label><input type="file" id="m-af" accept=".txt,.csv,text/plain" style="font-size:12px">
       <p style="font-size:12px;color:#7b5d66;margin:6px 0 0">Everything stays on this PC. Ctrl+Z right after a change puts back what you typed.</p>`,
      (m) => {
        MTRX.prefs.set('assist.on', { complete: m.querySelector('#m-ac').checked, caps: m.querySelector('#m-aa').checked, punct: m.querySelector('#m-ap').checked, period: m.querySelector('#m-ae').checked });
        learnedNames = new Set(lines(m.querySelector('#m-an').value).map((n) => n.toLowerCase()));
        const keep = {}; lines(m.querySelector('#m-aw').value).map((w) => w.toLowerCase()).forEach((w) => { keep[w] = learnedWords[w] || 3; });
        learnedWords = keep;
        skip = new Set(lines(m.querySelector('#m-as').value).map((w) => w.toLowerCase()));
        MTRX.prefs.set('assist.words', learnedWords); MTRX.prefs.set('assist.names', [...learnedNames]); MTRX.prefs.set('assist.skip', [...skip]);
        hideGhost(); msg('Writing assistance saved');
      }, 'Save');
    const f = $('#m-af');
    if (f) f.onchange = () => {
      const file = f.files && f.files[0]; if (!file || file.size > 2e6) return msg('Choose a text file under 2 MB');
      const rd = new FileReader();
      rd.onload = () => {
        const words = String(rd.result).split(/[\s,;]+/).filter((w) => /^\p{L}[\p{L}'’-]{1,40}$/u.test(w)).slice(0, 20000);
        let nn = 0, nw = 0;
        words.forEach((w) => { const k = w.toLowerCase(); if (w[0] !== k[0]) { if (!learnedNames.has(k)) { learnedNames.add(k); nn++; } } else if (!wordsSet.has(k)) { learnedWords[k] = Math.max(learnedWords[k] || 0, 3); nw++; } });
        $('#m-an').value = [...learnedNames].sort().map(cap).join('\n');
        $('#m-aw').value = Object.keys(learnedWords).sort((a, b) => learnedWords[b] - learnedWords[a]).slice(0, 400).join('\n');
        saveSoon(); msg(`Added ${nn} names and ${nw} words`);
      };
      rd.readAsText(file);
    };
  }

  $('#btn-assist').onclick = dialog;
  MTRX.assist = { dialog, suggest, sentStart };
})();
