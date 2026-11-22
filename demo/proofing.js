// Writer: spelling on/off and spelling language. Saved per user (MTRX.prefs). The check itself is Windows' own spell checker
// inside the app window, so a language needs its dictionary installed in Windows (Settings > Time & language).
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const $ = (s) => document.querySelector(s);
  const { ed, modal, msg } = MTRX.w;
  const LANGS = [['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['en-ZA', 'English (South Africa)'], ['en-AU', 'English (Australia)'], ['en-CA', 'English (Canada)'],
    ['af', 'Afrikaans'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['pt-PT', 'Portuguese (Portugal)'], ['pt-BR', 'Portuguese (Brazil)'], ['it', 'Italian'], ['nl', 'Dutch'], ['sw', 'Swahili']];

  const apply = () => {
    ed.spellcheck = MTRX.prefs.get('spell', true) !== false;
    ed.lang = MTRX.prefs.get('proofLang', 'en-US');
    // nudge the checker to re-read the page
    if (document.activeElement === ed) { ed.blur(); ed.focus(); }
  };

  function dialog() {
    const on = MTRX.prefs.get('spell', true) !== false, cur = MTRX.prefs.get('proofLang', 'en-US');
    modal('Spelling and language',
      `<label><input type="checkbox" id="m-sp" style="width:auto"${on ? ' checked' : ''}> Check spelling as I type</label>
       <label>Language</label><select id="m-pl">${LANGS.map(([c, n]) => `<option value="${c}"${c === cur ? ' selected' : ''}>${n}</option>`).join('')}</select>
       <p style="font-size:12px;color:#7b5d66;margin:8px 0 0">Misspelled words get a red underline; right-click one for suggestions. A language only works if Windows has its dictionary installed (Settings, Time &amp; language, Language &amp; region).</p>`,
      (m) => {
        MTRX.prefs.set('spell', m.querySelector('#m-sp').checked);
        MTRX.prefs.set('proofLang', m.querySelector('#m-pl').value);
        apply();
        msg(m.querySelector('#m-sp').checked ? 'Spelling language set' : 'Spell check off');
      }, 'Apply');
  }

  apply();
  $('#btn-proof').onclick = dialog;
  MTRX.proofing = { dialog, apply };
})();
