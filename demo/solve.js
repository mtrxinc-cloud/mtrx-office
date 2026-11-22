// MTRX Solve: the screen. The maths itself (parsing, exact fractions, solving, step recording, practice questions and
// marking) lives in Rust (crates/mtrx-solve). This file draws the topic tree, the forms, the steps and the practice flow.
// Progress is saved per user through MTRX.prefs ('solve.progress'); nothing else is stored.
(() => {
'use strict';
const MTRX = (window.MTRX = window.MTRX || {});
const $ = (s, r = document) => r.querySelector(s);
const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Browser testing only: `cargo run -p mtrx-sheet --example devserver --release` serves the real Rust engine and these
// screens on port 8124 (open http://localhost:8124/). The installed app always talks to the engine through Tauri.
const DEV = location.port === '8124' ? '/' : null;
const invoke = DEV ? null : window.__TAURI__?.core?.invoke;
const work = $('#sv-work'), tree = $('#sv-tree');
if (!work || !tree) return;

async function call(op, args) {
  if (invoke) {
    const v = await invoke('solve', { op, args: args || {} });
    if (v === null || v === undefined) throw 'This copy of the app has no maths engine. Close it and start it again.';
    return v;
  }
  if (!DEV) throw 'The maths engine only runs inside the MTRX Office app.';
  const r = await fetch(DEV, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'solve.' + op, args: args || {} }) });
  const j = await r.json();
  if (j.err) throw j.err;
  return j.ok;
}

let data = null, topics = [], cur = null, mode = 'solve', filter = '';
let out = null;            // what is on screen as a worked solution: { title, text, r }
let P = null;              // the practice question on screen
const vals = {}, methods = {};

// ---- progress (per user, per topic) ------------------------------------------------------------------------------------
const progress = () => MTRX.prefs.get('solve.progress', {});
const prog = (id) => Object.assign({ n: 0, right: 0, streak: 0 }, progress()[id]);
const levelOf = (p) => Math.min(3, 1 + Math.floor(p.streak / 3));
const status = (p) => (!p.n ? '' : p.right >= 5 && p.right / p.n >= 0.7 ? 'm' : 'l');
function record(id, ok) {
  const all = progress(), p = Object.assign({ n: 0, right: 0, streak: 0 }, all[id]);
  p.n++; if (ok) { p.right++; p.streak++; } else p.streak = 0;
  all[id] = p; MTRX.prefs.set('solve.progress', all);
  drawTree(); drawScore();
}
function drawScore() {
  const all = progress(); let n = 0, r = 0, m = 0;
  for (const k in all) { n += all[k].n; r += all[k].right; if (status(all[k]) === 'm') m++; }
  $('#sv-score').textContent = n ? `${r} of ${n} right · ${m} topic${m === 1 ? '' : 's'} mastered` : '';
}

// ---- topic tree ---------------------------------------------------------------------------------------------------------
function drawTree() {
  if (!data) return;
  const q = filter.trim().toLowerCase();
  let html = `<div class="sv-level">${esc(data.subject)}</div>`, any = false;
  for (const u of data.units) {
    const ts = u.topics.filter((t) => !q || (t.title + ' ' + u.title).toLowerCase().includes(q));
    if (!ts.length) continue;
    any = true;
    html += `<div class="sv-unit">${esc(u.title)}</div>`;
    for (const t of ts) {
      const p = prog(t.id), s = status(p);
      html += `<button class="sv-topic${cur && cur.id === t.id ? ' on' : ''}" data-t="${t.id}"><span class="dot ${s}"></span>${esc(t.title)}${p.n ? `<small>${p.right}/${p.n}</small>` : ''}</button>`;
    }
  }
  tree.innerHTML = any ? html : '<div class="sv-none">No topic matches that.</div>';
}
tree.addEventListener('click', (e) => { const b = e.target.closest('.sv-topic'); if (b) select(b.dataset.t); });
$('#sv-find').addEventListener('input', (e) => { filter = e.target.value; drawTree(); });

// On a phone the topic list folds away behind one button that shows the current topic.
const body = $('.sv-body'), tg = document.createElement('button');
tg.type = 'button'; tg.id = 'sv-tg'; tg.className = 'sv-tg'; tg.setAttribute('aria-expanded', 'false');
body.insertBefore(tg, body.firstChild);
tg.onclick = () => { const o = body.classList.toggle('tp'); tg.setAttribute('aria-expanded', o); };
function select(id, m) {
  const t = topics.find((x) => x.id === id); if (!t) return;
  if (cur && cur.id !== id) { out = null; P = null; }
  cur = t; MTRX.prefs.set('solve.last', id);
  tg.textContent = '☰  Topics: ' + t.title; body.classList.remove('tp'); tg.setAttribute('aria-expanded', 'false');
  setMode(m || mode);
}

// ---- modes ---------------------------------------------------------------------------------------------------------------
function setMode(m) {
  mode = m; if (out && out.view !== m) out = null;
  drawTree(); render(); sync();
}
function sync() {
  for (const k of ['solve', 'learn', 'practice']) $('#sv-m-' + k).classList.toggle('on', mode === k);
  const pr = mode === 'practice';
  $('#sv-next').disabled = !pr; $('#sv-hint').disabled = !pr || !P; $('#sv-showsol').disabled = !pr || !P;
  $('#sv-copy').disabled = !out; $('#sv-print').disabled = !out && mode === 'learn';
}
function render() {
  if (!cur) return;
  const head = `<div class="sv-crumb">${esc(data.subject)} · ${esc(cur.unit)}</div><h2 class="sv-h">${esc(cur.title)}</h2>`;
  work.innerHTML = `<div class="sv-wrap">${head}<div id="sv-body"></div></div>`;
  if (mode === 'learn') drawLearn(); else if (mode === 'practice') drawPractice(); else drawSolve();
  work.scrollTop = 0;
}

// ---- Solve ---------------------------------------------------------------------------------------------------------------
const KEYS = { algebra: ['x', 'y', '^', '(', ')', '/', '=', '<', '>', '≤', '≥', '+', '−', '×'], number: ['/', '^', '(', ')', '×', '÷', ':'] };
function fieldVal(f) { const v = vals[cur.id] || {}; return v[f.name] != null ? v[f.name] : (f.choices ? f.example : ''); }
function drawSolve() {
  const t = cur, body = $('#sv-body');
  const fields = t.fields.map((f) => f.choices
    ? `<label>${esc(f.label)}<select data-f="${f.name}">${f.choices.map(([k, l]) => `<option value="${esc(k)}"${k === fieldVal(f) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`
    : `<label>${esc(f.label)}<input data-f="${f.name}" value="${esc(fieldVal(f))}" placeholder="${esc(f.placeholder || '')}" spellcheck="false" autocomplete="off"></label>`).join('');
  const cm = methods[t.id] || (t.methods ? t.methods[0][0] : '');
  const meth = t.methods ? `<div class="sv-methods"><span>Method</span>${t.methods.map(([k, l]) => `<button type="button" data-m="${k}" class="${k === cm ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>` : '';
  const keys = t.fields.some((f) => !f.choices) ? `<div class="sv-keys sv-chk" aria-label="Symbols">${KEYS[t.unitId === 'number' ? 'number' : 'algebra'].map((k) => `<button type="button" data-k="${esc(k)}" title="Insert ${esc(k)}">${esc(k)}</button>`).join('')}</div>` : '';
  body.innerHTML = `<div class="sv-card"><div class="sv-fields">${fields}</div>${keys}${meth}<div class="sv-row"><button class="sv-btn pri" id="sv-go" type="button">Solve</button><button class="sv-btn" id="sv-ex" type="button">Try an example</button><button class="sv-btn" id="sv-lesson" type="button">Read the lesson</button></div></div><div id="sv-res"></div>`;
  let last = null;
  body.querySelectorAll('[data-f]').forEach((i) => {
    i.addEventListener('input', () => { (vals[t.id] = vals[t.id] || {})[i.dataset.f] = i.value; });
    i.addEventListener('change', () => { (vals[t.id] = vals[t.id] || {})[i.dataset.f] = i.value; });
    i.addEventListener('focus', () => { last = i; });
  });
  body.querySelectorAll('[data-k]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = () => {
      const i = last && last.tagName === 'INPUT' ? last : body.querySelector('input[data-f]'); if (!i) return;
      const s = i.selectionStart ?? i.value.length, e = i.selectionEnd ?? s;
      i.value = i.value.slice(0, s) + b.dataset.k + i.value.slice(e); i.focus();
      i.selectionStart = i.selectionEnd = s + b.dataset.k.length; i.dispatchEvent(new Event('input'));
    };
  });
  body.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { methods[t.id] = b.dataset.m; body.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b)); if (out) solveNow(); }; });
  $('#sv-go').onclick = solveNow; $('#sv-ex').onclick = example; $('#sv-lesson').onclick = () => setMode('learn');
  if (out && out.view === 'solve') showResult(out.r, out.err);
  const first = body.querySelector('input[data-f]'); if (first && !out) first.focus();
}
function example() {
  if (mode !== 'solve') { select(cur.id, 'solve'); }
  const v = (vals[cur.id] = {});
  cur.fields.forEach((f) => { v[f.name] = f.example; });
  drawSolve(); solveNow();
}
async function solveNow() {
  if (mode !== 'solve' || !cur) return;
  const t = cur, args = { topic: t.id, method: methods[t.id] || 'auto' }, v = (vals[t.id] = vals[t.id] || {});
  document.querySelectorAll('#sv-body [data-f]').forEach((i) => { v[i.dataset.f] = i.value; });
  t.fields.forEach((f) => { args[f.name] = v[f.name] != null ? v[f.name] : (f.choices ? f.example : ''); });
  try { const r = await call('solve', args); out = { view: 'solve', r, text: textOf(t.title, args.input || `${args.a || ''} ${args.op || ''} ${args.b || ''}`.trim(), r) }; showResult(r); }
  catch (e) { out = null; showResult(null, String(e)); }
  sync();
}
function stepsHtml(r) {
  return `<div class="sv-answer"><small>Answer</small><b>${esc(r.answer)}</b></div><div id="sv-anim"></div><details class="sv-card sv-full" open><summary>Full working</summary><ol class="sv-steps">${r.steps.map((s, i) => `<li><span class="n">${i + 1}</span><span class="rule">${esc(s.rule)}</span><span class="txt">${esc(s.text)}</span><div class="math">${esc(s.math)}</div></li>`).join('')}</ol></details>`;
}
let player = null;
function showResult(r, err) {
  const box = $('#sv-res'); if (!box) return;
  if (player) { player.destroy(); player = null; }
  box.innerHTML = err ? `<div class="sv-err">${esc(err)}</div>` : stepsHtml(r);
  if (!err && MTRX.solveAnim) player = MTRX.solveAnim.mount($('#sv-anim'), r.steps, { autoplay: true, viz: r.viz });
  if (!err) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function textOf(title, problem, r) {
  return `${title}\n${problem}\n\nAnswer: ${r.answer}\n\n` + r.steps.map((s, i) => `${i + 1}. ${s.rule}: ${s.text}${s.math ? '\n   ' + s.math.replace(/\n/g, '\n   ') : ''}`).join('\n');
}

// ---- Learn ---------------------------------------------------------------------------------------------------------------
function drawLearn() {
  const l = cur.lesson;
  $('#sv-body').innerHTML = `<div class="sv-card sv-lesson"><p>${esc(l.text)}</p><h4>Key formulas</h4><div class="sv-formulas">${l.formulas.map((f) => `<div>${esc(f)}</div>`).join('')}</div><div class="sv-row"><button class="sv-btn pri" id="sv-l-ex" type="button">See a worked example</button><button class="sv-btn" id="sv-l-pr" type="button">Practise this topic</button></div></div>`;
  $('#sv-l-ex').onclick = () => { setMode('solve'); example(); };
  $('#sv-l-pr').onclick = () => setMode('practice');
}

// ---- Practice ------------------------------------------------------------------------------------------------------------
function drawPractice() {
  if (!P || P.topic !== cur.id) { newQuestion(); return; }
  const p = prog(cur.id), q = P.q;
  $('#sv-body').innerHTML = `<div class="sv-chips"><span class="sv-chip">Level ${levelOf(p)} of 3</span><span class="sv-chip">Streak ${p.streak}</span><span class="sv-chip">Right ${p.right} of ${p.n}</span></div>
  <div class="sv-card"><div class="sv-q">${esc(q.text)}</div><div class="sv-prompt">${esc(q.prompt)}</div><input class="sv-ans" id="sv-ans" spellcheck="false" autocomplete="off" aria-label="Your answer"${P.done ? ' disabled' : ''} value="${esc(P.given || '')}">
  <div class="sv-row"><button class="sv-btn pri" id="sv-check" type="button"${P.done ? ' hidden' : ''}>Check answer</button><button class="sv-btn" id="sv-p-next" type="button"${P.done ? '' : ' hidden'}>Next question</button><button class="sv-btn" id="sv-p-hint" type="button">Hint</button><button class="sv-btn" id="sv-p-sol" type="button">Show solution</button></div>
  <div id="sv-fb">${P.hint ? `<div class="sv-hintbox"><b>Hint:</b> ${esc(q.hint)}</div>` : ''}${P.verdict ? `<div class="sv-verdict ${P.verdict.correct ? 'ok' : 'no'}">${esc(P.verdict.message)}</div>` : ''}</div></div><div id="sv-res"></div>`;
  $('#sv-check').onclick = check; $('#sv-p-next').onclick = newQuestion; $('#sv-p-hint').onclick = hint; $('#sv-p-sol').onclick = showSolution;
  const a = $('#sv-ans'); a.addEventListener('input', () => { P.given = a.value; });
  if (!P.done) a.focus();
  if (P.shown) { showResult(P.shown); if (!out) out = { view: 'practice', r: P.shown, text: textOf(cur.title, q.text, P.shown) }; }
  sync();
}
async function newQuestion() {
  if (!cur) return;
  const p = prog(cur.id);
  try {
    const q = await call('practice', { topic: cur.id, level: levelOf(p), seed: Math.floor(Math.random() * 2147483647) });
    P = { topic: cur.id, q, tries: 0, done: false, hint: false, shown: null, verdict: null, given: '' };
    out = null;
  } catch (e) { P = null; $('#sv-body').innerHTML = `<div class="sv-err">${esc(String(e))}</div>`; sync(); return; }
  if (mode === 'practice') drawPractice();
}
async function check() {
  if (!P || P.done) return;
  const a = $('#sv-ans'); P.given = a.value;
  if (!P.given.trim()) { P.verdict = { correct: false, message: 'Type an answer first.' }; drawPractice(); return; }
  let v;
  try { v = await call('check', { question: P.q, given: P.given }); } catch (e) { v = { correct: false, message: String(e) }; }
  P.tries++; P.verdict = v;
  if (P.tries === 1 && !P.shown) record(cur.id, v.correct);
  if (v.correct) P.done = true;
  drawPractice();
}
function hint() { if (!P) return; P.hint = true; drawPractice(); }
async function showSolution() {
  if (!P) return;
  if (P.tries === 0 && !P.done && !P.shown) record(cur.id, false); // looking before trying counts as an attempt without credit
  try { P.shown = await call('solve', P.q.solve); out = { view: 'practice', r: P.shown, text: textOf(cur.title, P.q.text, P.shown) }; }
  catch (e) { P.shown = null; showResult(null, String(e)); return; }
  P.done = true; if (!P.verdict) P.verdict = { correct: false, message: 'Here is the worked solution. Try the next question when you are ready.' };
  drawPractice();
}

// ---- go / actions --------------------------------------------------------------------------------------------------------
const go = () => { if (mode === 'practice') { if (P && P.done) newQuestion(); else check(); } else if (mode === 'solve') solveNow(); else setMode('solve'); };
function copy() {
  if (!out) return;
  const t = out.text;
  const done = () => { const b = $('#sv-copy span'); if (b) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy steps'; }, 1400); } };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done, () => {}); else { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); done(); }
}
function print() { if (document.body.classList.contains('solve')) window.print(); }
function reset() {
  const run = () => { MTRX.prefs.set('solve.progress', {}); P = null; drawTree(); drawScore(); if (mode === 'practice') render(); };
  const m = MTRX.w && MTRX.w.modal;
  if (m) m('Reset progress', '<p style="margin:6px 0 14px;line-height:1.5">This clears your practice scores and levels for every Solve topic on this PC. It cannot be undone.</p>', run, 'Reset');
  else run();
}

$('#sv-m-solve').onclick = () => setMode('solve');
$('#sv-m-learn').onclick = () => setMode('learn');
$('#sv-m-practice').onclick = () => setMode('practice');
$('#sv-next').onclick = () => newQuestion();
$('#sv-hint').onclick = hint;
$('#sv-showsol').onclick = showSolution;
$('#sv-copy').onclick = copy;
$('#sv-print').onclick = print;
$('#sv-home').onclick = () => MTRX.goHome?.();

// Keys: Ctrl+1/2/3 switch mode, Ctrl+Enter solves or checks, Enter in a field does the same, Ctrl+Shift+N is a new question.
document.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('solve') || e.altKey) return;
  const m = $('#modal-bg'); if (m && !m.hidden) return;
  if (document.querySelector('.cmdk-bg,.tour')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.shiftKey && e.key >= '1' && e.key <= '3') { e.preventDefault(); setMode(['solve', 'learn', 'practice'][+e.key - 1]); }
  else if (ctrl && e.key === 'Enter') { e.preventDefault(); go(); }
  else if (ctrl && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); if (out) print(); }
  else if (ctrl && e.shiftKey && (e.key === 'N' || e.key === 'n')) { e.preventDefault(); if (mode === 'practice') newQuestion(); }
  else if (e.key === 'Enter' && !ctrl && e.target.closest && e.target.closest('#sv-work') && e.target.tagName === 'INPUT') { e.preventDefault(); go(); }
}, true);

// ---- show ----------------------------------------------------------------------------------------------------------------
async function load() {
  if (data) return;
  try { data = await call('topics'); }
  catch (e) { work.innerHTML = `<div class="sv-err">${esc(String(e))}</div>`; return; }
  topics = [];
  for (const u of data.units) for (const t of u.topics) topics.push(Object.assign(t, { unit: u.title, unitId: u.id }));
  const app = MTRX.menu?.get?.('solve');
  if (app) for (const t of topics) app.actions.push({ id: 'go_' + t.id, label: 'Go to: ' + t.title, menu: 'Topics', run: () => select(t.id, 'solve') });
  $('#sv-title').textContent = `${data.subject} · ${data.level}`;
  drawScore();
  const last = MTRX.prefs.get('solve.last', null);
  select(topics.some((t) => t.id === last) ? last : topics[0].id, 'solve');
}
function show() {
  document.body.classList.remove('home', 'pdf', 'sheets'); document.body.classList.add('solve');
  load().then(() => { sync(); const i = work.querySelector('input'); if (i && mode === 'solve') i.focus(); });
}
MTRX.showSolve = show;
MTRX.solve = {
  show, mode: setMode, go, example, next: () => { if (mode !== 'practice') setMode('practice'); else newQuestion(); },
  hint: () => { if (mode !== 'practice') setMode('practice'); else hint(); },
  showSol: () => { if (mode === 'practice') showSolution(); }, copy, print, reset,
  hasOut: () => !!out, inPractice: () => mode === 'practice' && !!P,
};
$('#app-solve').onclick = show;
})();
