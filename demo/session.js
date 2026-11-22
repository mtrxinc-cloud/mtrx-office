// Shared "never lose work" logic for every MTRX Office app (Writer, PDF, Sheets, and any future app).
// An app registers once; the rest (autosave, recovery on the next launch, the unsaved-changes warning) is common.
//
//   MTRX.session.register('sheets', {
//     label: 'sheet',                   // noun used in messages: "This sheet has changes that are not saved"
//     isDirty: () => boolean,           // true while there are changes not yet saved to a real file
//     snapshot: async () => object|null|undefined,   // JSON-able copy of the work; null = nothing worth keeping; undefined = unchanged since last call
//     restore: async (object) => void,  // put the snapshot back on screen (and show the app)
//     title: (object) => string,        // shown in the Home screen's "Resume unsaved ..." chip
//     msg: (text) => void,              // the app's own status-line message function
//   });
//   MTRX.session.changed('sheets')      // call after any edit: a copy is kept a moment later
//   MTRX.session.saved('sheets')        // call after the real file was saved: the copy is dropped
//   MTRX.session.confirmLose('sheets')  // true if it is safe to replace the open work (asks first when it is dirty)
//
// Copies are kept per user in the browser database (IndexedDB), which holds large files; they never touch real files.
(() => {
'use strict';
const MTRX = (window.MTRX = window.MTRX || {});
const apps = {};
const timers = {};
const running = {}, again = {};
const mem = {}; // used only when the browser database is unavailable

// ---- storage ----------------------------------------------------------------------------------------------------
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((ok) => {
      try {
        const rq = indexedDB.open('mtrx-session', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('drafts');
        rq.onsuccess = () => ok(rq.result);
        rq.onerror = () => ok(null);
      } catch { ok(null); }
    });
  }
  return dbp;
}
const key = (id) => (MTRX.user || 'local') + '.' + id;
async function put(id, val) {
  const d = await db();
  if (!d) { mem[key(id)] = val; return true; }
  return new Promise((ok) => {
    try {
      const tx = d.transaction('drafts', 'readwrite');
      if (val == null) tx.objectStore('drafts').delete(key(id)); else tx.objectStore('drafts').put(val, key(id));
      tx.oncomplete = () => ok(true); tx.onerror = () => ok(false); tx.onabort = () => ok(false);
    } catch { ok(false); }
  });
}
async function get(id) {
  const d = await db();
  if (!d) return mem[key(id)] ?? null;
  return new Promise((ok) => {
    try {
      const rq = d.transaction('drafts').objectStore('drafts').get(key(id));
      rq.onsuccess = () => ok(rq.result ?? null); rq.onerror = () => ok(null);
    } catch { ok(null); }
  });
}

// ---- autosave ---------------------------------------------------------------------------------------------------
async function flush(id) {
  const a = apps[id]; if (!a) return;
  clearTimeout(timers[id]); timers[id] = 0;
  let snap;
  try { snap = await a.snapshot(); } catch { return; }
  if (snap === undefined) return;                 // unchanged
  if (snap === null || !a.isDirty()) return put(id, null); // blank, or saved in the meantime
  const ok = await put(id, { t: Date.now(), data: snap });
  if (!ok && !a.warned) { a.warned = true; a.msg?.('Could not keep an automatic copy of your ' + a.label + '. Save it yourself to be safe.'); }
}
const S = (MTRX.session = {
  register(id, def) { apps[id] = { warned: false, ...def }; },
  // Saved straight away (no waiting period). Edits that arrive while a save is running are folded into one follow-up save.
  changed(id) {
    if (!apps[id]) return;
    if (running[id]) { again[id] = true; return; }
    running[id] = true;
    (async () => { do { again[id] = false; await flush(id); } while (again[id]); running[id] = false; })();
  },
  saved(id) { clearTimeout(timers[id]); timers[id] = 0; put(id, null); },
  isDirty(id) { try { return !!apps[id]?.isDirty(); } catch { return false; } },
  unsaved() { return Object.keys(apps).some((id) => S.isDirty(id)); },
  confirmLose(id) {
    const a = apps[id];
    return !S.isDirty(id) || confirm('This ' + (a?.label || 'file') + ' has changes that are not saved. Continue and lose them?');
  },
  flushAll() { return Promise.all(Object.keys(apps).filter((id) => running[id] || again[id]).map(flush)); },

  // Home screen: one quiet chip per app that has a recoverable copy (click to resume, x to discard)
  async offer() {
    const host = document.querySelector('#home .apps'); if (!host) return;
    document.querySelectorAll('.draft-chip').forEach((c) => c.remove());
    let after = host;
    for (const id of Object.keys(apps)) {
      const a = apps[id], d = await get(id);
      if (!d || d.data == null) continue;
      let name = ''; try { name = a.title?.(d.data) || ''; } catch { /* untitled */ }
      const chip = document.createElement('div'); chip.className = 'draft-chip';
      const go = document.createElement('button'); go.type = 'button'; go.className = 'go';
      go.textContent = 'Resume unsaved “' + (name || 'Untitled ' + a.label) + '”';
      go.onclick = async () => { chip.remove(); try { await a.restore(d.data); } catch (e) { (a.msg || alert)('Could not restore: ' + e); } };
      const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.title = 'Discard'; x.setAttribute('aria-label', 'Discard'); x.textContent = '×';
      x.onclick = () => { put(id, null); chip.remove(); };
      chip.append(go, x); after.after(chip); after = chip;
    }
  },
});

// Last chance when the window is hidden or closing.
addEventListener('pagehide', () => S.flushAll());
document.addEventListener('visibilitychange', () => { if (document.hidden) S.flushAll(); });
})();
