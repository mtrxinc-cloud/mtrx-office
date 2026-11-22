// Shared menu system for every MTRX OFFICE app: menu bar, right-click menu, floating selection bar, Ctrl+K command
// search and a customizable toolbar (drag to reorder, resize, hide). Preferences are saved per user.
// New apps and features register actions with MTRX.menu.app(id, {...}); see CLAUDE.md.
(() => {
'use strict';
const MTRX = (window.MTRX = window.MTRX || {});
const $ = (s, r = document) => r.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- per-user preferences (accounts later: only MTRX.user changes) ------------------------------------------
MTRX.user = MTRX.user || 'local';
MTRX.prefs = {
  get(k, d) { try { const v = localStorage.getItem('mtrx.prefs.' + MTRX.user + '.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mtrx.prefs.' + MTRX.user + '.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const apps = {};
const current = () => (document.body.classList.contains('home') ? null : document.body.classList.contains('pdf') ? apps.pdf : document.body.classList.contains('sheets') ? apps.sheets : document.body.classList.contains('solve') ? apps.solve : apps.writer);
const act = (app, id) => app && app.actions.find((a) => a.id === id);
const enabled = (a) => { try { return !a.when || a.when(); } catch { return false; } };
function run(a) { if (!a || !enabled(a)) return; closeAll(); if (a.run) a.run(); else if (a.click) $(a.click)?.click(); }
const modalOpen = () => { const m = $('#modal-bg'); return m && !m.hidden; };

// ---- popup menus -----------------------------------------------------------------------------------------
let pop = null;
function closeAll() { pop?.remove(); pop = null; bar.hidden = true; document.querySelectorAll('.menubar .mb.open').forEach((b) => b.classList.remove('open')); }
function showList(app, ids, x, y, anchor) {
  pop?.remove();
  const box = (pop = el('div', 'mdrop')); box.setAttribute('role', 'menu');
  ids.forEach((id) => {
    if (id === '-') { box.appendChild(el('div', 'msep')); return; }
    const a = typeof id === 'object' ? id : act(app, id); if (!a) return; // an id, or a ready-made action object
    const b = el('button', 'mi', `<span>${esc(a.label)}</span><kbd>${esc(a.keys || '')}</kbd>`);
    b.setAttribute('role', 'menuitem'); if (!enabled(a)) b.disabled = true;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = () => run(a);
    box.appendChild(b);
  });
  document.body.appendChild(box);
  const r = box.getBoundingClientRect();
  box.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  box.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  return box;
}

// ---- floating selection bar ------------------------------------------------------------------------------
const bar = el('div', 'selbar'); bar.hidden = true; document.body.appendChild(bar);
function updateSelBar() {
  const app = current(), s = getSelection();
  if (!app || !app.selbar || modalOpen() || !s.rangeCount || s.isCollapsed || !s.toString().trim()) { bar.hidden = true; return; }
  const root = $(app.selRoot), n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
  if (!root || !n || !root.contains(n) || n.closest('input,textarea,select,.menubar,.ribbon')) { bar.hidden = true; return; }
  const ids = app.selbar(); if (!ids || !ids.length) { bar.hidden = true; return; }
  bar.replaceChildren();
  ids.forEach((id) => {
    const a = act(app, id); if (!a || !enabled(a)) return;
    const b = el('button', '', esc(a.short || a.label)); b.title = a.label + (a.keys ? ' (' + a.keys + ')' : '');
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = () => { run(a); bar.hidden = true; };
    bar.appendChild(b);
  });
  if (!bar.children.length) { bar.hidden = true; return; }
  const r = s.getRangeAt(0).getBoundingClientRect();
  bar.hidden = false;
  const w = bar.offsetWidth, h = bar.offsetHeight;
  bar.style.left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6)) + 'px';
  bar.style.top = (r.top - h - 8 < 4 ? r.bottom + 8 : r.top - h - 8) + 'px';
}
let selT = 0;
document.addEventListener('mouseup', () => { clearTimeout(selT); selT = setTimeout(updateSelBar, 10); });
document.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Shift' || e.code === 'KeyA') { clearTimeout(selT); selT = setTimeout(updateSelBar, 10); } });
document.addEventListener('mousedown', (e) => { if (!bar.contains(e.target)) bar.hidden = true; }, true);
document.addEventListener('scroll', () => { bar.hidden = true; }, true);

// ---- right-click menu ------------------------------------------------------------------------------------
document.addEventListener('contextmenu', (e) => {
  const app = current(); if (!app || !app.context || modalOpen() || e.target.closest('input,textarea,select,.mdrop')) return;
  if (e.target.closest('.menubar,.ribbon')) { e.preventDefault(); return; } // no browser menu on the app's own chrome
  const ids = app.context(e);
  if (ids === false) { e.preventDefault(); closeAll(); return; } // the app says: no menu here, and no browser menu either
  if (!ids || !ids.length) return;
  e.preventDefault(); closeAll(); showList(app, ids, e.clientX, e.clientY);
});
document.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target) && !e.target.closest('.menubar .mb')) closeAll(); }, true);
addEventListener('blur', closeAll);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); }, true);

// ---- Ctrl+K command search -------------------------------------------------------------------------------
let cmdk = null;
function openCmdk() {
  const app = current(); if (!app || cmdk || modalOpen()) return;
  closeAll();
  const bg = (cmdk = el('div', 'cmdk-bg')), box = el('div', 'cmdk', '<input class="cmdk-in" placeholder="Type a command (e.g. highlight, merge, zoom)..." spellcheck="false"><div class="cmdk-list"></div>');
  bg.appendChild(box); document.body.appendChild(bg);
  const inp = $('.cmdk-in', box), list = $('.cmdk-list', box); let items = [], at = 0;
  const close = () => { bg.remove(); cmdk = null; };
  const score = (a, q) => { const t = (a.label + ' ' + (a.menu || '')).toLowerCase(); if (!q) return 1; let i = 0; for (const c of q) { i = t.indexOf(c, i); if (i < 0) return 0; i++; } return t.includes(q) ? 3 : 1; };
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    items = app.actions.map((a) => ({ a, s: score(a, q) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).map((x) => x.a);
    at = Math.min(at, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((a, i) => { const r = el('div', 'cmdk-row' + (i === at ? ' on' : '') + (enabled(a) ? '' : ' off'), `<span>${esc(a.label)}<small>${esc(a.menu || '')}</small></span><kbd>${esc(a.keys || '')}</kbd>`); r.onmousedown = (e) => { e.preventDefault(); close(); run(a); }; return r; }));
    if (!items.length) list.appendChild(el('div', 'cmdk-none', 'No matching command'));
    list.children[at]?.scrollIntoView({ block: 'nearest' });
  };
  inp.oninput = () => { at = 0; draw(); };
  inp.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(items.length - 1, at + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); const a = items[at]; close(); run(a); }
  };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  draw(); inp.focus();
}
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK' && !e.shiftKey) { e.preventDefault(); openCmdk(); } }, true);

// ---- drag to reorder -----------------------------------------------------------------------------------
// items: elements in one container; handle(item, target) says whether a press starts a drag; done(items) saves.
function sortable(container, items, handle, done) {
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !container.classList.contains('customizing')) return;
    const item = items().find((i) => i.contains(e.target)); if (!item || !handle(item, e.target)) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY; let on = false, gx = 0, gy = 0, lx = sx, ly = sy;
    // hit-test against each sibling's real layout slot (offset* ignores the slide animation), and only swap once the cursor is past its middle
    const hit = (m) => {
      // slot of every sibling; pick the row nearest the cursor's height (so a little up or down never loses the drag), then the sibling by x
      const slots = items().filter((i) => i !== item && i.offsetWidth && i.offsetParent).map((i) => {
        const pr = i.offsetParent.getBoundingClientRect(), l = pr.left + i.offsetLeft, t = pr.top + i.offsetTop;
        return { i, l, r: l + i.offsetWidth, t, b: t + i.offsetHeight };
      });
      if (!slots.length) return null;
      const dy = (q) => (m.clientY < q.t ? q.t - m.clientY : m.clientY > q.b ? m.clientY - q.b : 0);
      const ref = slots.reduce((x, y) => (dy(y) < dy(x) ? y : x)), row = slots.filter((q) => q.t < ref.b && q.b > ref.t); // same visual row = vertical overlap (groups differ in height)
      const first = row.reduce((x, y) => (y.l < x.l ? y : x)), last = row.reduce((x, y) => (y.r > x.r ? y : x));
      const q = row.find((z) => m.clientX >= z.l && m.clientX <= z.r) || (m.clientX < first.l ? first : m.clientX > last.r ? last : null);
      if (!q) return null;
      const after = !!(item.compareDocumentPosition(q.i) & Node.DOCUMENT_POSITION_FOLLOWING), c = (q.l + q.r) / 2;
      return (after ? m.clientX > c : m.clientX < c) ? q.i : null;
    };
    // slide the other items smoothly from where they were to where they now are
    const flip = (mutate) => {
      const others = items().filter((i) => i !== item), old = new Map(others.map((i) => [i, i.getBoundingClientRect()]));
      mutate();
      others.forEach((i) => {
        const n = i.getBoundingClientRect(), o = old.get(i), dx = o.left - n.left, dy = o.top - n.top;
        if (!dx && !dy) return;
        i.style.transition = 'none'; i.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        i.getBoundingClientRect();
        i.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)'; i.style.transform = '';
        setTimeout(() => { i.style.transition = ''; }, 230);
      });
    };
    const follow = () => {
      item.style.transform = ''; const r = item.getBoundingClientRect();
      item.style.transform = 'translate(' + (lx - gx - r.left) + 'px,' + (ly - gy - r.top) + 'px)';
    };
    const move = (m) => {
      lx = m.clientX; ly = m.clientY;
      if (!on) {
        if (Math.hypot(lx - sx, ly - sy) < 3) return; on = true;
        const r = item.getBoundingClientRect(); gx = sx - r.left; gy = sy - r.top;
        item.classList.add('dragging'); document.body.classList.add('is-dragging');
      }
      const over = hit(m);
      if (over) {
        const after = !!(item.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING);
        flip(() => over.parentNode.insertBefore(item, after ? over.nextSibling : over));
      }
      follow();
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      document.body.classList.remove('is-dragging');
      if (on) {
        item.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)'; item.style.transform = '';
        setTimeout(() => { item.style.transition = ''; item.classList.remove('dragging'); }, 200);
        done(items());
        const stop = (c) => { c.stopPropagation(); c.preventDefault(); };
        item.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => item.removeEventListener('click', stop, true), 0);
      }
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}

// animate a layout change: every group slides (and the resized one grows or shrinks) from its old box to its new one
function flipGroups(root, mutate) {
  const gs = [...root.querySelectorAll(':scope > .group')], old = new Map(gs.map((g) => [g, g.getBoundingClientRect()]));
  mutate();
  gs.forEach((g) => {
    const n = g.getBoundingClientRect(), o = old.get(g); if (!n.width || !o.width) return;
    const dx = o.left - n.left, dy = o.top - n.top, sx = o.width / n.width, sy = o.height / n.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) return;
    g.animate([{ transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
}

// ---- customizable toolbar --------------------------------------------------------------------------------
function setupToolbar(app) {
  const roots = [...document.querySelectorAll(app.toolbar)];
  const key = 'toolbar.' + app.id;
  const st = MTRX.prefs.get(key, { order: [], size: {}, hidden: [] });
  const groups = [];
  roots.forEach((root) => {
    const seen = {};
    root.querySelectorAll(':scope > .group').forEach((g) => {
      const p = g.dataset.p || 'g'; seen[p] = (seen[p] || 0) + 1;
      g.dataset.gid = g.dataset.gid || app.id + '-' + p + '-' + seen[p];
      g.querySelectorAll('button, select, label.color, .pdf-zoom').forEach((b, i) => { b.dataset.bid = b.id || b.dataset.tool || b.dataset.cmd || g.dataset.gid + '.' + i; });
      groups.push(g);
    });
  });
  const save = () => MTRX.prefs.set(key, st);
  const apply = () => {
    roots.forEach((root) => {
      const here = [...root.querySelectorAll(':scope > .group')];
      const rank = (g) => { const i = st.order.indexOf(g.dataset.gid); return i < 0 ? 1e6 + here.indexOf(g) : i; };
      [...here].sort((a, b) => rank(a) - rank(b)).forEach((g) => root.appendChild(g));
    });
    groups.forEach((g) => {
      g.classList.remove('gs-s', 'gs-l'); const z = st.size[g.dataset.gid]; if (z === 's' || z === 'l') g.classList.add('gs-' + z);
      g.querySelectorAll('[data-bid]').forEach((b) => b.toggleAttribute('data-hide', st.hidden.includes(b.dataset.bid)));
    });
  };
  apply();
  const sorted = (root) => () => [...root.querySelectorAll(':scope > .group')];
  roots.forEach((root) => sortable(root, sorted(root), (g, t) => !!t.closest('.grip'), (items) => { st.order = [...new Set([...st.order.filter((id) => !items.some((g) => g.dataset.gid === id)), ...items.map((g) => g.dataset.gid)])]; save(); }));
  // while customizing, a click on a button hides/shows it instead of using it
  roots.forEach((root) => root.addEventListener('click', (e) => {
    if (!root.classList.contains('customizing')) return;
    const sz = e.target.closest('.gsz'); if (sz) { e.preventDefault(); const g = sz.closest('.group'); if (sz.dataset.s === 'm') delete st.size[g.dataset.gid]; else st.size[g.dataset.gid] = sz.dataset.s; save(); flipGroups(root, apply); markSizes(root); return; }
    const b = e.target.closest('[data-bid]'); if (!b || e.target.closest('.grip')) return;
    e.preventDefault(); e.stopPropagation();
    const i = st.hidden.indexOf(b.dataset.bid); if (i < 0) st.hidden.push(b.dataset.bid); else st.hidden.splice(i, 1);
    save(); apply();
  }, true));
  const markSizes = (root) => root.querySelectorAll('.group').forEach((g) => g.querySelectorAll('.gsz').forEach((s) => s.classList.toggle('on', (st.size[g.dataset.gid] || 'm') === s.dataset.s)));
  let note = null;
  app.customize = (on) => {
    if (on === undefined) on = !roots[0].classList.contains('customizing');
    roots.forEach((root) => {
      root.classList.toggle('customizing', on);
      root.querySelectorAll(':scope > .group').forEach((g) => {
        g.querySelectorAll(':scope > .grip, :scope > .gszs').forEach((x) => x.remove());
        if (on) {
          const grip = el('span', 'grip', '&#8942;&#8942;'); grip.title = 'Drag to move this group';
          const sz = el('span', 'gszs', '<button class="gsz" data-s="s" title="Small">S</button><button class="gsz" data-s="m" title="Medium">M</button><button class="gsz" data-s="l" title="Large">L</button>');
          g.prepend(grip); g.appendChild(sz);
        }
      });
      markSizes(root);
    });
    app.bar.classList.toggle('customizing', on);
    app.tabsEl?.classList.toggle('customizing', on);
    note?.remove(); note = null;
    if (on) {
      note = el('div', 'custnote', '<span><b>Customize toolbar:</b> drag the &#8942;&#8942; handle to move a group, S / M / L to resize it, click a button to hide or show it. Drag the menu names and tabs to reorder them too.</span><button class="btn" data-a="reset">Reset</button><button class="btn primary" data-a="done">Done</button>');
      note.onclick = (e) => { const a = e.target.dataset.a; if (a === 'done') app.customize(false); else if (a === 'reset') { st.order = []; st.size = {}; st.hidden = []; MTRX.prefs.set('menubar.' + app.id, []); MTRX.prefs.set('tabs.' + app.id, []); save(); location.reload(); } };
      app.bar.after(note);
    }
  };
}

// ---- menu bar --------------------------------------------------------------------------------------------
function buildBar(app) {
  const bar2 = (app.bar = el('nav', 'menubar')); bar2.setAttribute('aria-label', 'Menu');
  const holder = el('div', 'mb-list'); bar2.appendChild(holder);
  const saved = MTRX.prefs.get('menubar.' + app.id, []);
  const menus = [...app.menus].sort((a, b) => { const i = saved.indexOf(a.label), j = saved.indexOf(b.label); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
  menus.forEach((m) => {
    const b = el('button', 'mb', esc(m.label)); b.dataset.label = m.label; b.type = 'button';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    const open = () => { if (bar2.classList.contains('customizing')) return; const r = b.getBoundingClientRect(); closeAll(); showList(app, m.items, r.left, r.bottom); b.classList.add('open'); };
    b.onclick = () => { if (b.classList.contains('open')) closeAll(); else open(); };
    b.onmouseenter = () => { if (pop && !b.classList.contains('open')) open(); };
    holder.appendChild(b);
  });
  const sp = el('span', 'spacer'); bar2.appendChild(sp);
  const s = el('button', 'mb mb-find', 'Search <kbd>Ctrl+K</kbd>'); s.type = 'button'; s.title = 'Find any command'; s.onclick = openCmdk; bar2.appendChild(s);
  sortable(bar2, () => [...holder.children], () => true, (items) => MTRX.prefs.set('menubar.' + app.id, items.map((i) => i.dataset.label)));
  return bar2;
}
function reorderTabs(app) {
  const t = $(app.tabs); if (!t) return;
  app.tabsEl = t;
  const saved = MTRX.prefs.get('tabs.' + app.id, []);
  if (saved.length) [...t.children].sort((a, b) => { const i = saved.indexOf(a.dataset.tab), j = saved.indexOf(b.dataset.tab); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); }).forEach((c) => t.appendChild(c));
  sortable(t, () => [...t.children], () => true, (items) => MTRX.prefs.set('tabs.' + app.id, items.map((i) => i.dataset.tab)));
}

// ---- Alt key tips (like Word): tap Alt, then press the letter shown on a menu or tab ----------------------------
let tips = null;
function hideTips() { if (tips) { tips.forEach((t) => t.remove()); tips = null; } }
function showTips() {
  const app = current(); if (!app || !app.bar || modalOpen() || cmdk) return;
  closeAll(); hideTips();
  const used = new Set(), list = [];
  const targets = [...app.bar.querySelectorAll('.mb-list .mb')].map((b) => ({ b, go: () => b.click() }));
  if (app.tabsEl) [...app.tabsEl.children].forEach((b) => targets.push({ b, go: () => b.click() }));
  targets.forEach((t) => {
    const name = (t.b.dataset.label || t.b.textContent).toUpperCase().replace(/[^A-Z]/g, '');
    const ch = [...name].find((c) => !used.has(c)); if (!ch) return;
    used.add(ch); const r = t.b.getBoundingClientRect();
    const tip = el('span', 'keytip', ch); tip.style.left = r.left + r.width / 2 - 10 + 'px'; tip.style.top = r.bottom - 8 + 'px';
    document.body.appendChild(tip); list.push(tip); tip._k = ch; tip._go = t.go; tip._tab = !!(app.tabsEl && app.tabsEl.contains(t.b));
  });
  tips = list; tbuf = '';
}
// Second level (like Word): after a tab letter, every button of that tab gets a one or two letter tip.
function showRibbonTips() {
  const app = current(); if (!app || modalOpen() || cmdk) return;
  hideTips();
  const vis = (b) => { const r = b.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.left < innerWidth && !b.closest('[hidden]') && getComputedStyle(b).visibility !== 'hidden'; };
  const items = [...document.querySelectorAll('.ribbon button, .ribbon select')].filter(vis).map((b) => {
    const raw = (b.querySelector('span')?.textContent || b.dataset.label || b.getAttribute('aria-label') || b.title || '').replace(/\(.*?\)/g, '');
    return { b, name: raw.toUpperCase().replace(/[^A-Z]/g, '') };
  }).filter((x) => x.name);
  const groups = {}; items.forEach((x) => (groups[x.name[0]] = groups[x.name[0]] || []).push(x));
  const used = new Set(), list = [];
  Object.values(groups).forEach((g) => g.forEach((x, n) => {
    let code = x.name[0];
    if (g.length > 1) { code += [...x.name.slice(1)].find((c) => !used.has(x.name[0] + c)) || String(n); }
    if (used.has(code)) return;
    used.add(code);
    const r = x.b.getBoundingClientRect();
    const tip = el('span', 'keytip', code); tip.style.left = r.left + r.width / 2 - 10 + 'px'; tip.style.top = r.bottom - 12 + 'px';
    document.body.appendChild(tip); list.push(tip); tip._k = code; tip._go = () => (x.b.tagName === 'SELECT' ? x.b.focus() : x.b.click());
  }));
  tips = list; tbuf = '';
}
let altSolo = false, tbuf = '';
document.addEventListener('keydown', (e) => {
  if (e.key === 'Alt') { altSolo = !e.repeat || altSolo; e.preventDefault(); return; }
  altSolo = false;
  if (!tips) return;
  const k = e.key.length === 1 ? e.key.toUpperCase() : '';
  if (!k || e.ctrlKey || e.metaKey) return hideTips();
  e.preventDefault(); e.stopPropagation();
  tbuf += k;
  const hit = tips.find((t) => t._k === tbuf), more = tips.some((t) => t._k.length > tbuf.length && t._k.startsWith(tbuf));
  if (hit && !more) { const go = hit._go, tab = hit._tab; hideTips(); go(); if (tab) setTimeout(showRibbonTips, 60); }
  else if (more) tips.forEach((t) => t.classList.toggle('dim', !t._k.startsWith(tbuf)));
  else hideTips();
}, true);
document.addEventListener('keyup', (e) => { if (e.key === 'Alt' && altSolo) { e.preventDefault(); if (tips) hideTips(); else showTips(); } altSolo = false; }, true);
document.addEventListener('mousedown', hideTips, true);
addEventListener('blur', hideTips);

// ---- arrow keys inside an open dropdown ------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (!pop || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
  const items = [...pop.querySelectorAll('.mi:not(.off)')]; if (!items.length) return;
  let i = items.findIndex((x) => x.classList.contains('kb'));
  if (e.key === 'Enter') { if (i >= 0) { e.preventDefault(); items[i].click(); } return; }
  e.preventDefault(); items.forEach((x) => x.classList.remove('kb'));
  i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
  items[i].classList.add('kb');
}, true);

// ---- Welcome tour: a short guided walk-through the first time each app opens (replay from Help > Take the tour) ----
let tourEl = null;
const TOUR = {
  writer: [
    { title: 'Welcome to MTRX Office', text: 'A quick 30-second tour of where things are. You can skip it any time and replay it from Help.' },
    { sel: '.menubar', title: 'Menus', text: 'File, Edit, Insert, View and Help. Click one to open it, and use the arrow keys and Enter inside.' },
    { sel: '#tabs', title: 'Tabs', text: 'Home, Insert, Layout and Help hold your tools. Switch tabs to find formatting, tables, pictures and page setup.' },
    { sel: '.mb-find', title: 'Find any command', text: 'Press Ctrl+K and type what you want. It is the fastest way to reach anything.' },
    { sel: '.menubar', title: 'Key tips', text: 'Press Alt to show a letter on every menu and tab, then press the letter to open it. No mouse needed.' },
    { sel: '.menubar .mb[data-label="View"]', title: 'Make it yours', text: 'View > Customize toolbar lets you drag menus and toolbar groups into your own order, resize them and hide buttons. It is saved for you.' },
    { sel: '.menubar .mb[data-label="Help"]', title: 'Help is always here', text: 'A guide, the keyboard shortcuts, the website, and support. You are ready to write.' },
  ],
  pdf: [
    { title: 'Welcome to MTRX Office: PDF', text: 'A quick tour of where things are. You can skip it any time and replay it from Help.' },
    { sel: '#pdfapp .menubar', title: 'Menus', text: 'File, Edit, View, Tools and Help. Click one to open it, and use the arrow keys and Enter inside.' },
    { sel: '#pdf-tools', title: 'Tools', text: "Select text, highlight, draw, add text or images, edit the PDF's own text, rotate and delete pages." },
    { sel: '#pdfapp .mb-find', title: 'Find any command', text: 'Press Ctrl+K and type what you want. It is the fastest way to reach anything.' },
    { sel: '#pdfapp .menubar', title: 'Key tips', text: 'Press Alt to show a letter on every menu, then press the letter to open it.' },
    { sel: '#pdfapp .menubar .mb[data-label="Help"]', title: 'Help is always here', text: 'A guide, the website, and support. Open a PDF to get started.' },
  ],
};
TOUR.sheets = [
  { title: 'Welcome to MTRX Office: Sheets', text: 'A quick tour of where things are. You can skip it any time and replay it from Help.' },
  { sel: '.sh-fbar', title: 'Name box and formula bar', text: 'The box on the left shows which cell you are on; type a cell like D5 there to jump to it. The wide bar shows what is inside the cell, including formulas such as =SUM(A1:A9).' },
  { sel: '#sh-tabbar', title: 'Sheets', text: 'Each tab is its own sheet. Click + to add one, double-click a name to rename it, drag a tab to reorder, right-click for more.' },
  { sel: '#sh-tools', title: 'Tools', text: 'Undo, copy and paste, fill a formula down a column, and AutoSum to add up the numbers above or beside you.' },
  { sel: '#sheetsapp .menubar', title: 'Menus', text: 'File, Edit, Format, Sheet, Formulas, Data, View and Help. Press Alt to show a letter on each, then press the letter.' },
  { sel: '#sheetsapp .mb-find', title: 'Find any command', text: 'Press Ctrl+K and type what you want. It is the fastest way to reach anything.' },
  { sel: '#sheetsapp .menubar .mb[data-label="Help"]', title: 'Help is always here', text: 'A guide, the website, and support. Click a cell and start typing.' },
];
TOUR.solve = [
  { title: 'Welcome to MTRX Office: Solve', text: 'Maths that shows its working. Pick a topic, solve it step by step, then practise until it sticks. Skip any time and replay it from Help.' },
  { sel: '.sv-side', title: 'Topics', text: 'Every topic is listed here. Type in the search box to find one. A dot shows your progress, and it fills when you master the topic.' },
  { sel: '#sv-tools', title: 'Solve, Learn, Practice', text: 'Solve works out your own question with every step. Learn explains the method and formulas. Practice gives you questions that get harder as you get them right.' },
  { sel: '#sv-work', title: 'Your workspace', text: 'Type a problem, or press Try an example. Use the symbol keys for powers and roots. The answer is always checked before it is shown.' },
  { sel: '#solveapp .menubar', title: 'Menus', text: 'File, Solve, Practice, View and Help. Press Alt to show a letter on each, then press the letter.' },
  { sel: '#solveapp .mb-find', title: 'Find any topic', text: 'Press Ctrl+K and type a topic or command, such as quadratic or percent. It takes you straight there.' },
  { sel: '#solveapp .menubar .mb[data-label="Help"]', title: 'Help is always here', text: 'A guide, the website, and support. Pick a topic and try an example.' },
];
function endTour(app, done) {
  if (tourEl) { tourEl.remove(); tourEl = null; }
  if (done && app) MTRX.prefs.set('tour.' + app.id, true);
}
function startTour(app, force) {
  app = app || current();
  if (!app || tourEl || modalOpen()) return;
  if (!force && (window.top !== window || MTRX.prefs.get('tour.' + app.id, false))) return;
  closeAll();
  const visible = (sel) => { const n = $(sel); return !!(n && n.offsetWidth); };
  const steps = (TOUR[app.id] || []).filter((s) => !s.sel || visible(s.sel));
  if (!steps.length) return;
  let i = 0;
  const root = (tourEl = el('div', 'tour'));
  const hole = el('div', 'tour-hole'), card = el('div', 'tour-card');
  root.append(hole, card); document.body.appendChild(root);
  const close = (done) => { document.removeEventListener('keydown', onKey, true); removeEventListener('resize', place); endTour(app, done); };
  // Put the spotlight on the current step's target and the card beside it, always fully on screen.
  const place = () => {
    const s = steps[i], t = s.sel ? $(s.sel) : null, pad = 6;
    if (t && t.offsetWidth) {
      const r = t.getBoundingClientRect();
      hole.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;opacity:1`;
      const cw = Math.min(340, innerWidth - 24), ch = card.offsetHeight || 190;
      card.style.width = cw + 'px';
      card.style.left = Math.max(12, Math.min(r.left, innerWidth - cw - 12)) + 'px';
      const below = r.bottom + pad + 14, above = r.top - pad - 14 - ch;
      card.style.top = Math.max(12, below + ch <= innerHeight - 12 ? below : above >= 12 ? above : innerHeight - ch - 12) + 'px';
      card.style.transform = '';
    } else {
      hole.style.cssText = 'left:50%;top:50%;width:0;height:0;opacity:1';
      card.style.width = Math.min(380, innerWidth - 24) + 'px';
      card.style.left = '50%'; card.style.top = '50%'; card.style.transform = 'translate(-50%,-50%)';
    }
  };
  const go = (n) => {
    if (n >= steps.length) { close(true); return; }
    if (n < 0) n = 0;
    i = n; const s = steps[i];
    const last = i === steps.length - 1;
    card.innerHTML = `<small>${i + 1} of ${steps.length}</small><h4>${esc(s.title)}</h4><p>${esc(s.text)}</p><div class="tour-btns"><button class="tour-skip">${last ? '' : 'Skip tour'}</button><span></span>${i ? '<button class="tour-back">Back</button>' : ''}<button class="tour-next">${last ? 'Finish' : i ? 'Next' : 'Start tour'}</button></div>`;
    $('.tour-skip', card).onclick = () => close(true);
    const nx = $('.tour-next', card); nx.onclick = () => go(i + 1); nx.focus();
    const bk = $('.tour-back', card); if (bk) bk.onclick = () => go(i - 1);
    place();
  };
  const onKey = (e) => {
    // Any way of closing it counts as seen; it is never forced on someone twice. Help > Take the welcome tour replays it.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') { // keep the keyboard inside the tour card
      const b = [...card.querySelectorAll('button')].filter((x) => x.offsetWidth);
      if (!b.length) return;
      const k = b.indexOf(document.activeElement), n = e.shiftKey ? (k <= 0 ? b.length - 1 : k - 1) : (k + 1) % b.length;
      e.preventDefault(); e.stopPropagation(); b[n].focus();
    }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { if (e.target.closest && e.target.closest('.tour-skip,.tour-back')) return; e.preventDefault(); e.stopPropagation(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(i - 1); }
  };
  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', place);
  go(0);
}
// First launch: offer the tour once per app per session, the first time its screen is showing and the user is idle
// (not mid-drag, not customizing, no dialog open).
const tourOffered = new Set();
const offerTour = () => {
  const a = current();
  if (!a || tourEl || tourOffered.has(a.id) || MTRX.prefs.get('tour.' + a.id, false)) return;
  if (document.querySelector('.customizing') || document.body.classList.contains('is-dragging') || modalOpen()) return;
  tourOffered.add(a.id); startTour(a);
  if (tourEl) MTRX.prefs.set('tour.' + a.id, true); // shown once is enough, even if the app is closed mid-tour
};
new MutationObserver(() => setTimeout(offerTour, 700)).observe(document.body, { attributes: true, attributeFilter: ['class'] });
setTimeout(offerTour, 900);

// ---- Help dialog -----------------------------------------------------------------------------------------------
function openHelp() {
  const app = current(), bg = $('#modal-bg'), box = $('#modal'); if (!app || !bg || !box) return;
  closeAll();
  const pdf = app.id === 'pdf', sheets = app.id === 'sheets', solve = app.id === 'solve';
  box.innerHTML = `<h3>Help: MTRX ${pdf ? 'PDF' : sheets ? 'Sheets' : solve ? 'Solve' : 'Writer'}</h3>
  <div class="helpdoc">
   <h4>Getting started</h4>
   <ul>${solve
     ? '<li><b>Pick a topic</b> on the left, or press Ctrl+K and type its name.</li><li><b>Solve</b>: type your problem, for example x^2 - x - 6, and press Enter or Ctrl+Enter. Every step is shown with the rule used. Try an example fills one in for you.</li><li><b>Learn</b> explains the method and the formulas. <b>Practice</b> gives questions that get harder as you get them right; Hint helps, Show solution gives the full working.</li><li><b>Powers and roots</b>: use ^ or the symbol keys. Write 2x as 2x and a fraction as 3/4.</li><li><b>Copy steps</b> or <b>Print</b> to keep your working. Your progress is saved on this computer.</li>'
     : sheets
     ? '<li><b>Click a cell and type.</b> Enter moves down, Tab moves right, F2 edits what is already in a cell.</li><li><b>Formulas</b> start with =, for example =SUM(A1:A9), =B2*C2 or =IF(A1>10,"big","small"). Click a cell while writing a formula to put its address in.</li><li><b>Fill</b>: select a cell and the cells below it, then press Ctrl+D to copy the formula down.</li><li><b>Select several cells</b> to see their sum and average at the bottom.</li>'
     : pdf
     ?'<li><b>Open</b> a PDF from the home screen or File &gt; Open. It opens at 100%.</li><li><b>Select text</b> with the Select tool; Ctrl+A selects the page text, Ctrl+C copies it.</li><li><b>Highlight, draw, add text or images</b> from the toolbar. Edit text changes the PDF\'s own text in place.</li><li><b>Save</b> writes a real PDF.</li>'
     : '<li><b>Type</b> on the page. Use the tabs (Home, Insert, Layout) for formatting, tables, pictures and page setup.</li><li><b>Save</b> writes a real Word .docx you can open anywhere.</li><li><b>Citations</b>: Insert &gt; Citations builds APA, Harvard or MLA references.</li><li><b>Export PDF</b> from the File menu.</li>'}</ul>
   <h4>Find your way around</h4>
   <ul><li><b>Alt</b>: tap Alt, then press the letter shown on a menu or tab.</li><li><b>Ctrl+K</b>: search every command by name.</li><li><b>Right-click</b> for the context menu; select text for the quick bar.</li><li><b>Make it yours</b>: View &gt; Customize toolbar. Drag groups to reorder, resize them, hide buttons. Saved for you.</li></ul>
   <h4>More</h4>
   <ul><li>Press <b>F1</b> or Help &gt; Keyboard shortcuts for the full shortcut list.</li><li>The app updates itself when a new version is released.</li></ul>
  </div>
  <div class="actions"><button id="m-keys">Keyboard shortcuts</button><button class="ok" id="m-cancel">Close</button></div>`;
  bg.hidden = false;
  const close = () => { bg.hidden = true; box.innerHTML = ''; };
  $('#m-cancel', box).onclick = close;
  $('#m-keys', box).onclick = () => { close(); const k = $('#btn-help'); if (k) k.click(); else { const a = act(app, 'shortcuts'); if (a) run(a); } };
}

// ---- Help links (site, support and feedback; support and feedback are placeholders until accounts exist) ------------
const SITE_URL = 'https://mtrxinc-cloud.github.io/mtrx-office/'; // temporary home; moves to the main MTRX website later
const openSite = () => { const inv = window.__TAURI__?.core?.invoke; if (inv) inv('open_url', { url: SITE_URL }).catch(() => {}); else window.open(SITE_URL, '_blank'); };
function soon(title, text) {
  const bg = $('#modal-bg'), box = $('#modal'); if (!bg || !box) return;
  box.innerHTML = `<h3>${title}</h3><p style="margin:6px 0 14px;line-height:1.5">${text}</p><div class="actions"><button class="ok" id="m-cancel">OK</button></div>`;
  bg.hidden = false; $('#m-cancel', box).onclick = () => { bg.hidden = true; box.innerHTML = ''; };
}
const openSupport = () => soon('Contact support', 'In-app support is coming soon. Until then, reach us at <b>info@mtrxco.com</b> or on <b>+260 769 865 602</b>.');
// Same for every app: the details a bug report needs (version, which app, system) in one click, plus where to send it.
function openFeedback() {
  const bg = $('#modal-bg'), box = $('#modal'); if (!bg || !box) return;
  const appName = document.body.classList.contains('pdf') ? 'PDF' : document.body.classList.contains('sheets') ? 'Sheets' : document.body.classList.contains('solve') ? 'Solve' : 'Writer';
  const info = `MTRX Office ${($('#ver') || {}).textContent || ''} | ${appName} | ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '')}`;
  box.innerHTML = `<h3>Report a problem or send feedback</h3><p style="margin:6px 0 10px;line-height:1.5">Email <b>info@mtrxco.com</b> and say what happened and what you expected. Copy the details below and paste them in, it helps us fix it faster. Never include passwords. Your documents are never sent anywhere.</p><textarea readonly rows="3" style="width:100%;font-size:12px;box-sizing:border-box">${esc(info)}</textarea><div class="actions"><button id="m-copy">Copy details</button><button class="ok" id="m-cancel">Close</button></div>`;
  bg.hidden = false;
  $('#m-copy', box).onclick = async () => { try { await navigator.clipboard.writeText(info); $('#m-copy', box).textContent = 'Copied'; } catch { $('textarea', box).select(); } };
  $('#m-cancel', box).onclick = () => { bg.hidden = true; box.innerHTML = ''; };
}
const helpActs = [
  { id: 'helponline', label: 'Help online (website)', run: openSite },
  { id: 'support', label: 'Contact support...', run: openSupport },
  { id: 'feedback', label: 'Report a problem / feedback...', run: openFeedback },
  { id: 'whatsnew', label: "What's new", run: () => MTRX.whatsNew?.show() },
];

// Enter or Esc finishes customizing (changes are already saved as you make them)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  const app = Object.values(apps).find((a) => a.bar && a.bar.classList.contains('customizing') && a === current());
  if (!app || modalOpen() || e.target.closest?.('input,textarea,select')) return;
  e.preventDefault(); e.stopPropagation(); app.customize(false);
}, true);

MTRX.menu = {
  // def: { name, after (selector the menu bar goes after), toolbar (selector of .ribbon), tabs?, selRoot, actions, menus, context(e), selbar() }
  app(id, def) {
    const app = (apps[id] = Object.assign({ id, actions: [], menus: [] }, def));
    app.menus.forEach((m) => m.items.forEach((i) => { const a = act(app, i); if (a && !a.menu) a.menu = m.label; }));
    const anchor = $(app.after); if (!anchor) return;
    anchor.after(buildBar(app));
    reorderTabs(app); setupToolbar(app);
    return app;
  },
  get: (id) => apps[id], closeAll, openSearch: openCmdk, openHelp, startTour, run: (appId, id) => run(act(apps[appId], id)),
};

// ---- the apps ----------------------------------------------------------------------------------------------
const noText = () => { const s = getSelection(); return s.rangeCount && !s.isCollapsed; };
MTRX.menu.app('pdf', {
  name: 'PDF', after: '#pdfapp > .top', toolbar: '#pdf-tools', selRoot: '#pdf-pages',
  actions: [
    { id: 'open', label: 'Open...', keys: 'Ctrl+O', click: '#pdf-open' },
    { id: 'save', label: 'Save PDF', keys: 'Ctrl+S', click: '#pdf-save' },
    { id: 'towriter', label: 'Convert to Writer', click: '#pdf-towriter' },
    { id: 'towriterlayout', label: 'Convert to Writer (same look, editable)', short: 'Same look', run: () => MTRX.pdfToWriterLayout?.() },
    { id: 'towriterpics', label: 'Convert to Writer (exact look, as pictures)', short: 'As pictures', run: () => MTRX.pdfToWriterPictures?.() },
    { id: 'merge', label: 'Merge / split PDFs...', click: '#pdf-merge' },
    { id: 'home', label: 'Home', click: '#pdf-home' },
    { id: 'undo', label: 'Undo', keys: 'Ctrl+Z', click: '#pdf-undo' },
    { id: 'delete', label: 'Delete selected item', keys: 'Del', click: '#pdf-delete' },
    { id: 'selectall', label: 'Select all text', keys: 'Ctrl+A', run: () => MTRX.pdfSelectAll() },
    { id: 'copy', label: 'Copy', short: 'Copy', keys: 'Ctrl+C', run: () => document.execCommand('copy'), when: noText },
    { id: 'zoomin', label: 'Zoom in', click: '#pdf-zoomin' },
    { id: 'zoomout', label: 'Zoom out', click: '#pdf-zoomout' },
    { id: 'fit', label: 'Fit page width', click: '#pdf-fit' },
    { id: 'help', label: 'Help and getting started...', run: () => openHelp() },
    { id: 'tour', label: 'Take the welcome tour', run: () => startTour(current(), true) },
    ...helpActs,
    { id: 'custom', label: 'Customize toolbar...', run: () => apps.pdf.customize(true) },
    { id: 'search', label: 'Find a command...', keys: 'Ctrl+K', run: openCmdk },
    { id: 'tselect', label: 'Select tool', keys: 'V', click: '[data-tool=select]' },
    { id: 'tedit', label: 'Edit text tool', keys: 'E', click: '[data-tool=edit]' },
    { id: 'ttext', label: 'Add text tool', keys: 'T', click: '[data-tool=text]' },
    { id: 'thl', label: 'Highlight tool', keys: 'H', click: '[data-tool=highlight]' },
    { id: 'tdraw', label: 'Draw tool', keys: 'D', click: '[data-tool=draw]' },
    { id: 'ttick', label: 'Tick mark tool', keys: 'K', click: '[data-tool=tick]' },
    { id: 'tcross', label: 'Cross mark tool', keys: 'X', click: '[data-tool=cross]' },
    { id: 'tdot', label: 'Dot mark tool', keys: 'O', click: '[data-tool=dot]' },
    { id: 'image', label: 'Add image or signature', keys: 'I', click: '#pdf-image' },
    { id: 'rotate', label: 'Rotate page', click: '#pdf-rotate' },
    { id: 'delpage', label: 'Delete page', click: '#pdf-delpage' },
    { id: 'reorder', label: 'Reorder pages...', click: '#pdf-reorder' },
    { id: 'sign', label: 'Signature...', click: '#pdf-sign' },
    { id: 'cards', label: 'Flashcards...', click: '#pdf-cards' },
    { id: 'hlsel', label: 'Highlight selected text', short: 'Highlight', run: () => MTRX.pdfHighlightSelection(), when: noText },
    { id: 'cardsel', label: 'Highlight and make flashcard', short: 'Flashcard', run: () => { if (MTRX.pdfHighlightSelection()) $('#pdf-cards')?.click(); }, when: noText },
  ],
  menus: [
    { label: 'File', items: ['open', 'save', '-', 'towriter', 'towriterlayout', 'towriterpics', 'merge', '-', 'home'] },
    { label: 'Edit', items: ['undo', 'delete', '-', 'selectall', 'copy'] },
    { label: 'View', items: ['zoomin', 'zoomout', 'fit', '-', 'custom'] },
    { label: 'Tools', items: ['tselect', 'tedit', 'ttext', 'thl', 'tdraw', 'ttick', 'tcross', 'tdot', 'image', 'sign', '-', 'rotate', 'delpage', 'reorder', 'cards'] },
    { label: 'Help', items: ['helponline', 'help', 'tour', 'whatsnew', '-', 'support', 'feedback', '-', 'search'] },
  ],
  context: (e) => (e.target.closest('#pdf-pages') ? [...(noText() ? ['copy', 'hlsel', 'cardsel', '-'] : []), 'selectall', '-', 'rotate', 'delpage', '-', 'zoomin', 'zoomout', 'fit', '-', 'search'] : null),
  selbar: () => ['copy', 'hlsel', 'cardsel'],
});

const S = () => MTRX.sheets;
MTRX.menu.app('sheets', {
  name: 'Sheets', after: '#sheetsapp > .top', toolbar: '#sh-tools',
  actions: [
    { id: 'new', label: 'New sheet', run: () => S().newSheet() },
    { id: 'open', label: 'Open...', keys: 'Ctrl+O', run: () => S().open() },
    { id: 'save', label: 'Save', keys: 'Ctrl+S', run: () => S().save() },
    { id: 'saveas', label: 'Save as Excel (.xlsx)...', keys: 'Ctrl+Shift+S', run: () => S().saveAs() },
    { id: 'exportcsv', label: 'Export as CSV...', run: () => S().exportCsv() },
    { id: 'home', label: 'Home', click: '#sh-home' },
    { id: 'undo', label: 'Undo', keys: 'Ctrl+Z', run: () => S().undo() },
    { id: 'redo', label: 'Redo', keys: 'Ctrl+Y', run: () => S().redo() },
    { id: 'cut', label: 'Cut', keys: 'Ctrl+X', run: () => S().cut() },
    { id: 'copy', label: 'Copy', keys: 'Ctrl+C', run: () => S().copy() },
    { id: 'paste', label: 'Paste', keys: 'Ctrl+V', run: () => S().paste() },
    { id: 'tabadd', label: 'Insert sheet', keys: 'Shift+F11', run: () => S().tabAdd() },
    { id: 'tabrename', label: 'Rename sheet', run: () => S().tabRename() },
    { id: 'tabdup', label: 'Duplicate sheet', run: () => S().tabDup() },
    { id: 'tabdel', label: 'Delete sheet', run: () => S().tabDel(), when: () => S().tabCount() > 1 },
    { id: 'tableft', label: 'Move sheet left', run: () => S().tabLeft(), when: () => S().tabIndex() > 0 },
    { id: 'tabright', label: 'Move sheet right', run: () => S().tabRight(), when: () => S().tabIndex() < S().tabCount() - 1 },
    { id: 'tabnext', label: 'Next sheet', keys: 'Ctrl+PageDown', run: () => S().tabNext() },
    { id: 'tabprev', label: 'Previous sheet', keys: 'Ctrl+PageUp', run: () => S().tabPrev() },
    { id: 'clear', label: 'Clear cells', keys: 'Del', run: () => S().clear() },
    { id: 'chartcol', label: 'Insert column chart', run: () => S().chartCol() },
    { id: 'chartline', label: 'Insert line chart', run: () => S().chartLine() },
    { id: 'chartpie', label: 'Insert pie chart', run: () => S().chartPie() },
    { id: 'chartbar', label: 'Insert bar chart (horizontal)', run: () => S().chartBar() },
    { id: 'chartstack', label: 'Insert stacked column chart', run: () => S().chartStack() },
    { id: 'chartarea', label: 'Insert area chart', run: () => S().chartArea() },
    { id: 'chartedit', label: 'Chart settings...', run: () => S().chartEdit(), when: () => S().hasChart() },
    { id: 'chartdel', label: 'Delete chart', keys: 'Del', run: () => S().chartDel(), when: () => S().hasChart() },
    { id: 'insrows', label: 'Insert rows above', keys: 'Ctrl+Shift+=', run: () => S().insRows() },
    { id: 'inscols', label: 'Insert columns left', run: () => S().insCols() },
    { id: 'delrows', label: 'Delete rows', keys: 'Ctrl+-', run: () => S().delRows() },
    { id: 'delcols', label: 'Delete columns', run: () => S().delCols() },
    { id: 'selectall', label: 'Select all', keys: 'Ctrl+A', run: () => S().selectAll() },
    { id: 'validate', label: 'Data validation...', run: () => S().valid(), when: () => true },
    { id: 'sprint', label: 'Print...', keys: 'Ctrl+P', run: () => S().print() },
    { id: 'colwidth', label: 'Column width...', run: () => S().colWidth() },
    { id: 'rowheight', label: 'Row height...', run: () => S().rowHeight() },
    { id: 'inscells', label: 'Insert cells...', run: () => S().insCells(), when: () => true },
    { id: 'delcells', label: 'Delete cells...', run: () => S().delCells(), when: () => true },
    { id: 'sfind', label: 'Find...', keys: 'Ctrl+F', run: () => S().find(false) },
    { id: 'sreplace', label: 'Replace...', keys: 'Ctrl+H', run: () => S().find(true) },
    { id: 'filldown', label: 'Fill down', keys: 'Ctrl+D', run: () => S().fillDown(), when: () => S().hasSel() },
    { id: 'fillright', label: 'Fill right', keys: 'Ctrl+R', run: () => S().fillRight(), when: () => S().hasSel() },
    { id: 'autosum', label: 'AutoSum', keys: 'Alt+=', run: () => S().autoSum() },
    { id: 'goto', label: 'Go to cell...', keys: 'Ctrl+G', run: () => S().goto() },
    { id: 'bold', label: 'Bold', short: 'B', keys: 'Ctrl+B', run: () => S().toggle('b') },
    { id: 'italic', label: 'Italic', short: 'I', keys: 'Ctrl+I', run: () => S().toggle('i') },
    { id: 'underline', label: 'Underline', short: 'U', keys: 'Ctrl+U', run: () => S().toggle('u') },
    { id: 'strike', label: 'Strikethrough', keys: 'Ctrl+5', run: () => S().toggle('s') },
    { id: 'alignl', label: 'Align left', run: () => S().align(1) },
    { id: 'alignc', label: 'Centre', run: () => S().align(2) },
    { id: 'alignr', label: 'Align right', run: () => S().align(3) },
    { id: 'wrap', label: 'Wrap text', run: () => S().wrap() },
    { id: 'fitcols', label: 'AutoFit column width', run: () => S().fitCols() },
    { id: 'fitrows', label: 'AutoFit row height', run: () => S().fitRows() },
    { id: 'textcolour', label: 'Text colour...', run: () => S().textColour() },
    { id: 'fillcolour', label: 'Fill colour...', run: () => S().fillColour() },
    { id: 'borderall', label: 'All borders', run: () => S().borders('all') },
    { id: 'borderout', label: 'Outside borders', keys: 'Ctrl+Shift+7', run: () => S().borders('outer') },
    { id: 'borderno', label: 'No borders', keys: 'Ctrl+Shift+-', run: () => S().borders('none') },
    { id: 'bordermenu', label: 'Borders...', run: () => S().borderMenu() },
    { id: 'nfgeneral', label: 'Number format: General', run: () => S().nf(0, 0) },
    { id: 'nfnumber', label: 'Number format: Number', run: () => S().nf(1, 2) },
    { id: 'nfcomma', label: 'Number format: Comma', keys: 'Ctrl+Shift+1', run: () => S().nf(2, 2) },
    { id: 'nfcurrency', label: 'Number format: Currency', keys: 'Ctrl+Shift+4', run: () => S().nf(3, 2) },
    { id: 'nfpercent', label: 'Number format: Percent', keys: 'Ctrl+Shift+5', run: () => S().nf(4, 0) },
    { id: 'nfdate', label: 'Number format: Date', keys: 'Ctrl+Shift+3', run: () => S().nf(5, 0) },
    { id: 'decmore', label: 'More decimals', run: () => S().decimals(1) },
    { id: 'decless', label: 'Fewer decimals', run: () => S().decimals(-1) },
    { id: 'painter', label: 'Format painter', run: () => S().paint() },
    { id: 'clearfmt', label: 'Clear formatting', run: () => S().clearFormat() },
    { id: 'sortaz', label: 'Sort A to Z (smallest first)', run: () => S().sort(true) },
    { id: 'sortza', label: 'Sort Z to A (largest first)', run: () => S().sort(false) },
    { id: 'filter', label: 'Filter on / off', run: () => S().filter() },
    { id: 'merge', label: 'Merge cells', run: () => S().merge() },
    { id: 'unmerge', label: 'Unmerge cells', run: () => S().unmerge(), when: () => S().canUnmerge() },
    { id: 'freezehere', label: 'Freeze panes at the active cell', run: () => S().freezeHere() },
    { id: 'freezerow', label: 'Freeze top row', run: () => S().freezeRow() },
    { id: 'freezecol', label: 'Freeze first column', run: () => S().freezeCol() },
    { id: 'unfreeze', label: 'Unfreeze panes', run: () => S().unfreeze(), when: () => S().isFrozen() },
    { id: 'help', label: 'Help and getting started...', run: () => openHelp() },
    { id: 'tour', label: 'Take the welcome tour', run: () => startTour(current(), true) },
    ...helpActs,
    { id: 'custom', label: 'Customize toolbar...', run: () => apps.sheets.customize(true) },
    { id: 'search', label: 'Find a command...', keys: 'Ctrl+K', run: openCmdk },
  ],
  menus: [
    { label: 'File', items: ['new', 'open', '-', 'save', 'saveas', 'exportcsv', '-', 'sprint', '-', 'home'] },
    { label: 'Edit', items: ['undo', 'redo', '-', 'cut', 'copy', 'paste', '-', 'clear', 'selectall', '-', 'insrows', 'inscols', 'delrows', 'delcols', 'inscells', 'delcells', '-', 'filldown', 'fillright', '-', 'sfind', 'sreplace', 'goto'] },
    { label: 'Format', items: ['bold', 'italic', 'underline', 'strike', '-', 'alignl', 'alignc', 'alignr', 'wrap', '-', 'colwidth', 'rowheight', 'fitcols', 'fitrows', '-', 'textcolour', 'fillcolour', 'bordermenu', 'borderall', 'borderout', 'borderno', '-', 'nfgeneral', 'nfnumber', 'nfcomma', 'nfcurrency', 'nfpercent', 'nfdate', 'decmore', 'decless', '-', 'merge', 'unmerge', '-', 'painter', 'clearfmt'] },
    { label: 'Insert', items: ['chartcol', 'chartline', 'chartpie', 'chartbar', 'chartstack', 'chartarea', '-', 'chartedit', 'chartdel', '-', 'insrows', 'inscols'] },
    { label: 'Sheet', items: ['tabadd', 'tabrename', 'tabdup', 'tabdel', '-', 'tableft', 'tabright', '-', 'tabprev', 'tabnext'] },
    { label: 'Formulas', items: ['autosum'] },
    { label: 'Data', items: ['sortaz', 'sortza', '-', 'filter', 'validate'] },
    { label: 'View', items: ['freezehere', 'freezerow', 'freezecol', 'unfreeze', '-', 'custom'] },
    { label: 'Help', items: ['helponline', 'help', 'tour', 'whatsnew', '-', 'support', 'feedback', '-', 'search'] },
  ],
  context: (e) => (e.target.closest('.sh-chart') ? ['chartedit', '-', 'chartdel'] : e.target.closest('.sh-tab') ? S().tabMenu(+e.target.closest('.sh-tab').dataset.i) : e.target.closest('#sh-tabbar') ? false : e.target.id === 'sh-canvas' ? (S().hitKind(e) === 'col' ? ['cut', 'copy', 'paste', '-', 'inscols', 'delcols', '-', 'clear', 'colwidth', 'fitcols', '-', 'bold', 'italic', 'wrap', 'fillcolour', 'clearfmt', '-', 'sortaz', 'sortza', 'freezecol'] : S().hitKind(e) === 'row' ? ['cut', 'copy', 'paste', '-', 'insrows', 'delrows', '-', 'clear', 'rowheight', 'fitrows', '-', 'bold', 'italic', 'wrap', 'fillcolour', 'clearfmt', '-', 'sortaz', 'sortza', 'freezerow'] : ['cut', 'copy', 'paste', '-', 'insrows', 'inscols', 'delrows', 'delcols', 'inscells', 'delcells', '-', 'clear', '-', 'bold', 'italic', 'wrap', 'fillcolour', 'bordermenu', 'clearfmt', '-', 'sortaz', 'sortza', 'merge', 'freezehere', '-', 'filldown', 'fillright', 'autosum', '-', 'selectall']) : false),
});

const V = () => MTRX.solve;
MTRX.menu.app('solve', {
  name: 'Solve', after: '#solveapp > .top', toolbar: '#sv-tools',
  actions: [
    { id: 'home', label: 'Home', click: '#sv-home' },
    { id: 'msolve', label: 'Solve a problem', keys: 'Ctrl+1', run: () => V().mode('solve') },
    { id: 'mlearn', label: 'Learn this topic', keys: 'Ctrl+2', run: () => V().mode('learn') },
    { id: 'mpractice', label: 'Practise this topic', keys: 'Ctrl+3', run: () => V().mode('practice') },
    { id: 'example', label: 'Try an example', run: () => V().example() },
    { id: 'run', label: 'Solve / check answer', keys: 'Ctrl+Enter', run: () => V().go() },
    { id: 'next', label: 'New practice question', keys: 'Ctrl+Shift+N', run: () => V().next() },
    { id: 'hint', label: 'Show hint', run: () => V().hint() },
    { id: 'showsol', label: 'Show worked solution', run: () => V().showSol(), when: () => V().inPractice() },
    { id: 'copy', label: 'Copy answer and steps', run: () => V().copy(), when: () => V().hasOut() },
    { id: 'print', label: 'Print...', keys: 'Ctrl+P', run: () => V().print(), when: () => V().hasOut() },
    { id: 'reset', label: 'Reset my progress...', run: () => V().reset() },
    { id: 'help', label: 'Help and getting started...', run: () => openHelp() },
    ...helpActs,
    { id: 'custom', label: 'Customize toolbar...', run: () => apps.solve.customize(true) },
    { id: 'search', label: 'Find a command...', keys: 'Ctrl+K', run: openCmdk },
  ],
  menus: [
    { label: 'File', items: ['print', 'copy', '-', 'home'] },
    { label: 'Solve', items: ['msolve', 'mlearn', 'mpractice', '-', 'example', 'run'] },
    { label: 'Practice', items: ['next', 'hint', 'showsol', '-', 'reset'] },
    { label: 'View', items: ['custom'] },
    { label: 'Help', items: ['helponline', 'help', 'whatsnew', '-', 'support', 'feedback', '-', 'search'] },
  ],
  context: (e) => (e.target.closest('input,select,textarea') ? false : e.target.closest('#sv-work') ? ['run', 'copy', 'print'] : false),
});

MTRX.menu.app('writer', {
  name: 'Writer', after: 'header.top', toolbar: '#ribbon', tabs: '#tabs', selRoot: '#editor',
  actions: [
    { id: 'open', label: 'Open...', click: '#btn-open' },
    { id: 'savedocx', label: 'Save as Word (.docx)', keys: 'Ctrl+S', click: '#btn-export' },
    { id: 'exportpdf', label: 'Export PDF', keys: 'Ctrl+Shift+P', click: '#btn-pdf' },
    { id: 'home', label: 'Home', click: '#btn-home' },
    { id: 'undo', label: 'Undo', keys: 'Ctrl+Z', click: '[data-cmd=undo]' },
    { id: 'redo', label: 'Redo', keys: 'Ctrl+Y', click: '[data-cmd=redo]' },
    { id: 'find', label: 'Find and replace...', keys: 'Ctrl+F', click: '#btn-find' },
    { id: 'selectall', label: 'Select all', keys: 'Ctrl+A', run: () => { $('#editor').focus(); document.execCommand('selectAll'); } },
    { id: 'cut', label: 'Cut', short: 'Cut', keys: 'Ctrl+X', run: () => document.execCommand('cut'), when: noText },
    { id: 'copy', label: 'Copy', short: 'Copy', keys: 'Ctrl+C', run: () => document.execCommand('copy'), when: noText },
    { id: 'paste', label: 'Paste', keys: 'Ctrl+V', run: () => MTRX.writerPaste() },
    { id: 'bold', label: 'Bold', short: 'B', keys: 'Ctrl+B', click: '[data-cmd=bold]' },
    { id: 'italic', label: 'Italic', short: 'I', keys: 'Ctrl+I', click: '[data-cmd=italic]' },
    { id: 'underline', label: 'Underline', short: 'U', keys: 'Ctrl+U', click: '[data-cmd=underline]' },
    { id: 'table', label: 'Insert table', click: '#ins-table' },
    { id: 'tmerge', label: 'Merge cells', click: '#t-merge' },
    { id: 'tsplit', label: 'Split cell', click: '#t-split' },
    { id: 'tnofill', label: 'Remove cell shading', click: '#t-nofill' },
    { id: 'tnoborder', label: 'Table: no borders', run: () => MTRX.tbl?.borders('none') },
    { id: 'tthin', label: 'Table: thin borders', run: () => MTRX.tbl?.borders('') },
    { id: 'tthick', label: 'Table: bold borders', run: () => MTRX.tbl?.borders('thick') },
    { id: 'chart', label: 'Insert chart', click: '#ins-chart' },
    { id: 'image', label: 'Insert image', click: '#ins-image' },
    { id: 'shape', label: 'Insert shape', click: '#ins-shape' },
    { id: 'pbreak', label: 'Page break', click: '#ins-break' },
    { id: 'footnote', label: 'Footnote', click: '#ins-footnote' },
    { id: 'cite', label: 'Citations and bibliography...', short: 'Cite', click: '#ins-cite' },
    { id: 'indent', label: 'Increase indent', keys: 'Ctrl+M', click: '#para-indent' },
    { id: 'outdent', label: 'Decrease indent', keys: 'Ctrl+Shift+M', click: '#para-outdent' },
    { id: 'parafmt', label: 'Paragraph spacing and indents...', short: 'Paragraph', click: '#para-fmt' },
    { id: 'proofing', label: 'Spelling and language...', click: '#btn-proof' },
    { id: 'assist', label: 'Writing assistance...', click: '#btn-assist' },
    { id: 'link', label: 'Link...', short: 'Link', keys: 'Ctrl+Alt+L', click: '#ins-link' },
    { id: 'toc', label: 'Table of contents', click: '#ins-toc' },
    { id: 'tocupdate', label: 'Update table of contents', run: () => MTRX.review?.updateToc() },
    { id: 'tocdel', label: 'Remove table of contents', run: () => MTRX.review?.deleteToc() },
    { id: 'comment', label: 'Comment on selection', short: 'Comment', keys: 'Ctrl+Alt+M', click: '#ins-comment' },
    { id: 'comments', label: 'Show or hide comments', click: '#btn-comments' },
    { id: 'symbol', label: 'Symbol', click: '#ins-sym' },
    { id: 'checkbox', label: 'Check box (click to tick)', short: 'Check box', keys: 'Ctrl+Alt+B', run: () => MTRX.checkbox?.insert() },
    { id: 'checklist', label: 'Checklist (box on each line)', short: 'Checklist', run: () => MTRX.checkbox?.checklist() },
    { id: 'date', label: 'Today\'s date', click: '#ins-date' },
    { id: 'templates', label: 'New from template...', short: 'Templates', run: () => MTRX.templates && MTRX.templates.dialog() },
    { id: 'pagesetup', label: 'Page setup...', click: '#page-setup' },
    { id: 'pgborder', label: 'Page borders...', short: 'Page borders', click: '#btn-pgborder' },
    { id: 'hf', label: 'Header and footer...', short: 'Header & footer', click: '#btn-hf' },
    { id: 'equation', label: 'Equation...', short: 'Equation', keys: 'Alt+=', click: '#ins-eq' },
    { id: 'trk', label: 'Track changes', keys: 'Ctrl+Shift+E', click: '#tc-toggle' },
    { id: 'trknext', label: 'Next change', click: '#tc-next' },
    { id: 'trkprev', label: 'Previous change', click: '#tc-prev' },
    { id: 'trkacc', label: 'Accept change', click: '#tc-accept' },
    { id: 'trkrej', label: 'Reject change', click: '#tc-reject' },
    { id: 'trkaccall', label: 'Accept all changes', click: '#tc-acceptall' },
    { id: 'trkrejall', label: 'Reject all changes', click: '#tc-rejectall' },
    { id: 'callout', label: 'Callout box', run: () => MTRX.callout && MTRX.callout() },
    { id: 'columns', label: 'Columns...', short: 'Columns', click: '#btn-cols' },
    { id: 'zoomin', label: 'Zoom in', click: '#z-in' },
    { id: 'zoomout', label: 'Zoom out', click: '#z-out' },
    { id: 'zoom100', label: 'Zoom 100%', click: '#z-val' },
    { id: 'fit', label: 'Fit page to screen', click: '#z-fit' },
    { id: 'help', label: 'Help and getting started...', run: () => openHelp() },
    { id: 'tour', label: 'Take the welcome tour', run: () => startTour(current(), true) },
    ...helpActs,
    { id: 'shortcuts', label: 'Keyboard shortcuts', click: '#btn-help' },
    { id: 'custom', label: 'Customize toolbar...', run: () => apps.writer.customize(true) },
    { id: 'search', label: 'Find a command...', keys: 'Ctrl+K', run: openCmdk },
  ],
  menus: [
    { label: 'File', items: ['templates', 'open', 'savedocx', 'exportpdf', '-', 'pagesetup', '-', 'home'] },
    { label: 'Edit', items: ['undo', 'redo', '-', 'cut', 'copy', 'paste', 'selectall', '-', 'find', 'proofing', 'assist', '-', 'indent', 'outdent', 'parafmt'] },
    { label: 'Insert', items: ['table', 'tmerge', 'tsplit', 'tnofill', 'tnoborder', 'tthin', 'tthick', '-', 'chart', 'image', 'shape', '-', 'callout', '-', 'pbreak', 'columns', 'hf', 'pgborder', 'footnote', 'cite', 'link', '-', 'toc', 'tocupdate', 'tocdel', 'comment', '-', 'symbol', 'checkbox', 'checklist', 'equation', 'date'] },
    { label: 'Review', items: ['trk', '-', 'trknext', 'trkprev', 'trkacc', 'trkrej', '-', 'trkaccall', 'trkrejall', '-', 'comment', 'comments'] },
    { label: 'View', items: ['comments', '-', 'zoomin', 'zoomout', 'zoom100', 'fit', '-', 'custom'] },
    { label: 'Help', items: ['helponline', 'help', 'tour', 'whatsnew', 'shortcuts', '-', 'support', 'feedback', '-', 'search'] },
  ],
  // Right-click: picture and table actions come from app.js as ready-made actions; the rest are shared ones above.
  context: (e) => {
    const x = MTRX.writerCtx && MTRX.writerCtx(e); if (!x) return false;
    return [...(x.pic ? [...x.pic, '-'] : []), 'cut', 'copy', 'paste', '-', 'bold', 'italic', 'underline', '-', 'selectall', 'pbreak', ...(x.table ? ['-', ...x.table] : [])];
  },
  selbar: () => ['bold', 'italic', 'underline', 'cut', 'copy', 'comment', 'link', 'cite'],
});
})();
