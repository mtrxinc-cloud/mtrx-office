// Citations and bibliography for Writer: keep a list of sources, insert (Author, Year) citations and a formatted
// reference list in APA, Harvard or MLA. Everything is inserted as ordinary text, so it saves to .docx as is.
(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const ed = $('#editor'), btn = $('#ins-cite'), bg = $('#modal-bg'), box = $('#modal');
if (!ed || !btn || !bg || !box) return;
const KEY = 'mtrx.writer.sources', SKEY = 'mtrx.writer.citestyle';
const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let sources = load(KEY, []), style = load(SKEY, 'APA'), range = null, adding = false;

// "Smith, John; Doe, Jane" -> [{last, first}]
const people = (s) => String(s || '').split(/;|\n/).map((x) => x.trim()).filter(Boolean).map((p) => {
  const i = p.indexOf(',');
  return i < 0 ? { last: p, first: '' } : { last: p.slice(0, i).trim(), first: p.slice(i + 1).trim() };
});
const initials = (f) => f.split(/[\s.]+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join(' ');
const join = (a, last) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ((a.length > 2 && style !== 'Harvard') || (a.length === 2 && style === 'APA') ? ',' : '') + ' ' + last + ' ' + a[a.length - 1]);

function inText(src, pages) {
  const a = people(src.authors), who = a.length === 0 ? (src.title || 'Anon.') : a.length === 1 ? a[0].last : a.length === 2 ? (style === 'APA' ? a[0].last + ' & ' + a[1].last : a[0].last + ' and ' + a[1].last) : a[0].last + ' et al.';
  const yr = src.year || 'n.d.', pg = pages ? pages.trim() : '';
  if (style === 'MLA') return '(' + who + (pg ? ' ' + pg : '') + ')';
  return '(' + who + ', ' + yr + (pg ? ', ' + (/[-–,]/.test(pg) ? 'pp. ' : 'p. ') + pg : '') + ')';
}

function entry(src) {
  const a = people(src.authors).map((p) => ({ last: esc(p.last), first: esc(p.first) })), t = esc(src.title), c = esc(src.container), y = esc(src.year || 'n.d.'), u = esc(src.url), vol = esc(src.volume), pg = esc(src.pages), acc = esc(src.accessed);
  const ital = (x) => (x ? '<i>' + x + '</i>' : '');
  if (style === 'APA') {
    const who = join(a.map((p) => p.last + (p.first ? ', ' + initials(p.first) : '')), '&amp;');
    let s = (who ? who + ' ' : '') + '(' + y + '). ';
    if (src.type === 'journal') s += t + '. ' + ital(c) + (vol ? ', ' + ital(vol) : '') + (pg ? ', ' + pg : '') + '.';
    else if (src.type === 'web') s += ital(t) + '. ' + (c ? c + '. ' : '') + (u || '');
    else s += ital(t) + '. ' + (c ? c + '.' : '');
    return s.trim() + (src.type === 'journal' && u ? ' ' + u : '');
  }
  if (style === 'Harvard') {
    const who = join(a.map((p) => p.last + (p.first ? ', ' + initials(p.first) : '')), 'and');
    let s = (who ? who + ' ' : '') + '(' + y + ') ';
    if (src.type === 'journal') s += "'" + t + "', " + ital(c) + (vol ? ', ' + vol : '') + (pg ? ', pp. ' + pg : '') + '.';
    else if (src.type === 'web') s += ital(t) + '. ' + (c ? c + '. ' : '') + 'Available at: ' + u + (acc ? ' (Accessed: ' + acc + ').' : '.');
    else s += ital(t) + '. ' + (c ? c + '.' : '');
    return s.trim();
  }
  // MLA
  const names = a.map((p, i) => (i === 0 ? p.last + (p.first ? ', ' + p.first : '') : (p.first ? p.first + ' ' : '') + p.last));
  const who = a.length > 2 ? names[0] + ', et al' : names.length === 2 ? names[0] + ', and ' + names[1] : names[0] || '';
  let s = (who ? who + '. ' : '');
  if (src.type === 'journal') s += '"' + t + '." ' + ital(c) + (vol ? ', vol. ' + vol : '') + ', ' + y + (pg ? ', pp. ' + pg : '') + '.';
  else if (src.type === 'web') s += '"' + t + '." ' + ital(c) + ', ' + y + ', ' + u + '.' + (acc ? ' Accessed ' + acc + '.' : '');
  else s += ital(t) + '. ' + (c ? c + ', ' : '') + y + '.';
  return s.trim();
}
const sortKey = (s) => (people(s.authors)[0]?.last || s.title || '').toLowerCase();

function restore() { if (!range) return; const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
function put(html) { ed.focus(); restore(); document.execCommand('insertHTML', false, html); }
const close = () => { bg.hidden = true; box.innerHTML = ''; };

function render() {
  const rows = sources.map((s, i) => `<label class="src"><input type="radio" name="cs" value="${i}"${i === (render.sel ?? 0) ? ' checked' : ''}> <span><b>${esc(people(s.authors).map((p) => p.last).join(', ') || 'No author')}</b> (${esc(s.year || 'n.d.')}) ${esc(s.title)}</span><button class="x" data-del="${i}" title="Remove this source">&times;</button></label>`).join('');
  box.innerHTML = `<h3>Citations</h3>
  <div class="row"><div><label>Style</label><select id="c-style">${['APA', 'Harvard', 'MLA'].map((x) => `<option${x === style ? ' selected' : ''}>${x}</option>`).join('')}</select></div>
  <div><label>Page(s), optional</label><input id="c-pages" placeholder="e.g. 45"></div></div>
  <div class="srcs">${rows || '<p class="none">No sources yet. Add one below.</p>'}</div>
  <details id="c-add"${adding || !sources.length ? ' open' : ''}><summary>Add a source</summary>
   <div class="row"><div><label>Type</label><select id="f-type"><option value="book">Book</option><option value="web">Website</option><option value="journal">Journal article</option></select></div>
   <div><label>Year</label><input id="f-year" placeholder="2024"></div></div>
   <label>Author(s): Last, First; Last, First</label><input id="f-authors" placeholder="Banda, Jane; Phiri, Joseph">
   <label>Title</label><input id="f-title">
   <label id="f-cl">Publisher</label><input id="f-container">
   <div class="row"><div><label>Volume / issue</label><input id="f-volume"></div><div><label>Pages</label><input id="f-pages"></div></div>
   <label>URL</label><input id="f-url" placeholder="https://"><label>Date accessed (websites)</label><input id="f-accessed" placeholder="14 Nov 2026">
   <button id="f-save" class="ok" type="button">Save source</button></details>
  <div class="actions"><button id="m-cancel">Close</button><button id="c-bib"${sources.length ? '' : ' disabled'}>Insert bibliography</button><button class="ok" id="c-cite"${sources.length ? '' : ' disabled'}>Insert citation</button></div>`;
  const q = (s) => box.querySelector(s);
  q('#c-style').onchange = (e) => { style = e.target.value; save(SKEY, style); };
  q("#m-cancel").onclick = close;
  const typeSel = q('#f-type'), cl = q('#f-cl');
  typeSel.onchange = () => { cl.textContent = typeSel.value === 'journal' ? 'Journal' : typeSel.value === 'web' ? 'Website name' : 'Publisher'; };
  box.querySelectorAll('input[name=cs]').forEach((r) => (r.onchange = () => { render.sel = +r.value; }));
  box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); sources.splice(+b.dataset.del, 1); save(KEY, sources); render.sel = 0; adding = false; render(); }));
  q('#f-save').onclick = () => {
    const v = (id) => q(id).value.trim(), s = { id: Date.now(), type: typeSel.value, authors: v('#f-authors'), year: v('#f-year'), title: v('#f-title'), container: v('#f-container'), volume: v('#f-volume'), pages: v('#f-pages'), url: v('#f-url'), accessed: v('#f-accessed') };
    if (!s.title && !s.authors) { q('#f-title').focus(); return; }
    sources.push(s); save(KEY, sources); render.sel = sources.length - 1; adding = false; render();
  };
  q('#c-cite').onclick = () => { const s = sources[render.sel ?? 0]; if (!s) return; const pg = q('#c-pages').value; close(); put(esc(inText(s, pg))); };
  q('#c-bib').onclick = () => {
    close();
    const list = [...sources].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    put('<h2>' + (style === 'MLA' ? 'Works Cited' : style === 'Harvard' ? 'Reference List' : 'References') + '</h2>' + list.map((s) => '<p>' + entry(s) + '</p>').join(''));
  };
}
btn.onclick = () => { const s = getSelection(); range = s.rangeCount && ed.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null; adding = false; render.sel = 0; render(); bg.hidden = false; };
btn.addEventListener('mousedown', (e) => e.preventDefault());
})();
