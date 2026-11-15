// In the installed app this must behave like a program, not a web page: no reload, no developer tools, no browser-only keys.
// Skipped in a plain browser (the dev server on localhost) so testing there still works.
(() => {
  if (!window.__TAURI__) return;
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const reload = k === 'f5' || (mod && k === 'r' && !e.altKey && !e.defaultPrevented);
    const tools = k === 'f12' || (mod && e.shiftKey && (k === 'i' || k === 'j' || k === 'c'));
    const other = mod && !e.shiftKey && (k === 'u' && false); // Ctrl+U is Underline in the editors, so it is left alone
    if (reload || tools || other) e.preventDefault();
  }, false); // bubble phase: Sheets' own Ctrl+R (Fill right) runs first and keeps working
  // the web right-click menu (Reload, Inspect) never shows; the apps draw their own
  addEventListener('contextmenu', (e) => { if (!e.defaultPrevented) e.preventDefault(); });
})();
