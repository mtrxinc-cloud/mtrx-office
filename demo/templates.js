// Document templates for Writer: pick one (File, New from template... or Home) and a ready-made document opens with the
// right headings, layout, header/footer and an A4 page. Replace the [bracketed text] with your own. Everything is plain
// editable content, so a template is just a starting point and saves as a normal .docx.
(() => {
  const MTRX = (window.MTRX = window.MTRX || {});
  const { modal, msg } = MTRX.w;
  const $ = (s) => document.querySelector(s);

  const A4 = { width: 11906, height: 16838, landscape: false, top: 1440, bottom: 1440, left: 1440, right: 1440 };
  const Z = (left = '', center = '', right = '') => ({ left, center, right });
  const HF = (o) => ({ header: Z(), footer: Z(), firstDifferent: false, firstHeader: Z(), firstFooter: Z(), ...o });
  const PB = '<div class="pb" contenteditable="false"></div>';
  const c = (t, size, bold) => `<p style="text-align:center">${bold ? '<b>' : ''}${size ? `<span style="font-size:${size}pt">${t}</span>` : t}${bold ? '</b>' : ''}</p>`;
  const sp = (n = 1) => '<p><br></p>'.repeat(n);
  const p = (t) => `<p>${t}</p>`;
  const li = (a) => `<ul>${a.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  const tbl = (head, rows) => `<table><tbody><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((x) => `<td>${x || '<br>'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

  const T = [
    {
      key: 'blank', name: 'Blank document', note: 'A4 page, nothing else', title: 'Untitled document', page: A4, hf: HF({}),
      html: '<p><br></p>',
    },
    {
      key: 'cover', name: 'Assignment with cover page', note: 'Cover page, then your work. Page numbers start after it', title: 'Assignment',
      page: A4, hf: HF({ footer: Z('', '{page}', ''), firstDifferent: true }),
      html: sp(3) + c('[UNIVERSITY OR COLLEGE NAME]', 16, true) + c('[School / Department]', 12) + sp(3) +
        c('[ASSIGNMENT TITLE]', 24, true) + sp(2) + c('[Course name and code]', 13) + sp(4) +
        tbl(['Student', ''], [['Name', '[Your full name]'], ['Student number', '[Number]'], ['Programme', '[Programme and year]'], ['Lecturer', '[Lecturer name]'], ['Due date', '[Date]']]) + PB +
        '<h1>Introduction</h1>' + p('[Say what the assignment is about and what you will show.]') +
        '<h1>Main discussion</h1>' + p('[Your work goes here.]') +
        '<h1>Conclusion</h1>' + p('[Sum up your main points.]') +
        '<h1>References</h1>' + p('[List the sources you used.]'),
    },
    {
      key: 'essay', name: 'Essay', note: 'Introduction, body, conclusion and references. Your name and page number on every page', title: 'Essay',
      page: A4, hf: HF({ header: Z('[Surname]', '', 'Page {page}') }),
      html: c('[ESSAY TITLE]', 18, true) + c('[Your name] · [Course] · [Date]', 11) + sp() +
        '<h2>Introduction</h2>' + p('[Introduce the topic, give some background and state your argument in one clear sentence.]') +
        '<h2>Body</h2>' + p('[One main idea per paragraph. Start with the point, support it with evidence, then explain why it matters.]') +
        p('[Next paragraph.]') +
        '<h2>Conclusion</h2>' + p('[Return to your argument and say what it shows. Do not add new evidence here.]') +
        '<h2>References</h2>' + p('[List every source you cited, in the style your lecturer asked for.]'),
    },
    {
      key: 'lab', name: 'Lab report', note: 'Aim, apparatus, method, results table, discussion and conclusion', title: 'Lab report',
      page: A4, hf: HF({ header: Z('[Course code]', '', '[Your name]'), footer: Z('', 'Page {page} of {pages}', '') }),
      html: c('[EXPERIMENT TITLE]', 18, true) + c('[Name] · [Student number] · [Date performed]', 11) + sp() +
        '<h2>Aim</h2>' + p('[What you set out to find out.]') +
        '<h2>Apparatus</h2>' + li(['[Item]', '[Item]', '[Item]']) +
        '<h2>Method</h2><ol><li>[Step one]</li><li>[Step two]</li><li>[Step three]</li></ol>' +
        '<h2>Results</h2>' + tbl(['Trial', 'Measurement', 'Unit'], [['1', '', ''], ['2', '', ''], ['3', '', '']]) + sp() +
        '<h2>Discussion</h2>' + p('[Explain your results, compare them with the theory and name sources of error.]') +
        '<h2>Conclusion</h2>' + p('[Was the aim met? Answer in one or two sentences.]') +
        '<h2>References</h2>' + p('[Sources.]'),
    },
    {
      key: 'report', name: 'Project report', note: 'Cover page, contents, numbered chapters and appendix', title: 'Project report',
      page: A4, hf: HF({ header: Z('[Project title]', '', ''), footer: Z('', '{page}', ''), firstDifferent: true }),
      html: sp(3) + c('[PROJECT TITLE]', 26, true) + sp(2) + c('[Course / Programme]', 13) + c('[Your name] · [Student number]', 12) +
        c('[Supervisor]', 12) + c('[Month and year]', 12) + PB +
        '<h1>Contents</h1>' + p('[Use Insert, Table of contents to build this list from your headings.]') + PB +
        '<h1>1. Introduction</h1>' + p('[Background, problem and objectives.]') +
        '<h1>2. Literature review</h1>' + p('[What others have written on the topic.]') +
        '<h1>3. Methodology</h1>' + p('[What you did and why.]') +
        '<h1>4. Results and analysis</h1>' + p('[Findings, tables and figures.]') +
        '<h1>5. Conclusion and recommendations</h1>' + p('[What you found and what should happen next.]') +
        '<h1>References</h1>' + p('[Sources.]') + '<h1>Appendix</h1>' + p('[Extra material.]'),
    },
    {
      key: 'cv', name: 'CV (résumé)', note: 'One clean page: profile, education, experience, skills, referees', title: 'CV',
      page: { ...A4, top: 1000, bottom: 1000, left: 1200, right: 1200 }, hf: HF({}),
      html: c('[YOUR FULL NAME]', 24, true) + c('[Phone] · [Email] · [Town, Country]', 11) + sp() +
        '<h2>Profile</h2>' + p('[Two or three sentences: who you are, what you study or do, and the work you want.]') +
        '<h2>Education</h2>' + p('<b>[Qualification]</b> — [School or university], [Year – Year]') + p('[Key subjects, grades or achievements.]') +
        '<h2>Work experience</h2>' + p('<b>[Job title]</b> — [Employer], [Dates]') + li(['[What you did and what it achieved]', '[Another responsibility]']) +
        '<h2>Skills</h2>' + li(['[Skill]', '[Skill]', '[Skill]']) +
        '<h2>Languages</h2>' + p('[English, Bemba, Nyanja...]') +
        '<h2>Referees</h2>' + p('[Name, position, organisation, phone, email]'),
    },
    {
      key: 'apply', name: 'Job application letter', note: 'Cover letter to go with your CV', title: 'Application letter',
      page: A4, hf: HF({}),
      html: p('[Your name]<br>[Address]<br>[Phone] · [Email]') + p('[Date]') + p('[Recipient name]<br>[Position]<br>[Company]<br>[Address]') +
        p('Dear [Mr / Ms Surname],') + p('<b>Application for the position of [job title]</b>') +
        p('[First paragraph: the job you are applying for and where you saw it.]') +
        p('[Second paragraph: why you suit the job. Mention your studies, skills and experience that match.]') +
        p('[Third paragraph: why you want to work for this organisation.]') +
        p('I have attached my CV and would welcome the chance to meet you. Thank you for your time.') +
        p('Yours sincerely,') + sp() + p('[Your name]'),
    },
    {
      key: 'letter', name: 'Formal letter', note: 'Addresses, date, subject line and closing', title: 'Letter',
      page: A4, hf: HF({}),
      html: p('[Your name]<br>[Address]<br>[Phone] · [Email]') + p('[Date]') + p('[Recipient name]<br>[Position]<br>[Organisation]<br>[Address]') +
        p('Dear [Sir / Madam / Name],') + p('<b>[SUBJECT OF THE LETTER]</b>') +
        p('[Say why you are writing in the first sentence.]') + p('[Give the details.]') + p('[Say what you want to happen next.]') +
        p('Yours faithfully,') + sp() + p('[Your name]'),
    },
    {
      key: 'minutes', name: 'Meeting minutes', note: 'Attendance, agenda items and an action table', title: 'Minutes',
      page: A4, hf: HF({ footer: Z('', 'Page {page} of {pages}', '') }),
      html: c('MINUTES OF THE [NAME] MEETING', 16, true) + p('<b>Date:</b> [Date] &nbsp; <b>Time:</b> [Time] &nbsp; <b>Venue:</b> [Place]') +
        '<h2>Present</h2>' + li(['[Name]', '[Name]']) + '<h2>Apologies</h2>' + p('[Names or none]') +
        '<h2>1. Opening and previous minutes</h2>' + p('[Notes.]') + '<h2>2. [Agenda item]</h2>' + p('[Discussion and decisions.]') +
        '<h2>3. Any other business</h2>' + p('[Notes.]') +
        '<h2>Action points</h2>' + tbl(['Action', 'Who', 'Due'], [['[Task]', '', ''], ['[Task]', '', '']]) + sp() +
        p('The meeting closed at [time].') + p('Minutes taken by: [Name] &nbsp; Approved by: [Name]'),
    },
  ];

  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  function use(t) {
    if (!MTRX.session.confirmLose('writer')) return;
    MTRX.openInWriter(t.title, t.html, { page: { ...t.page }, hf: JSON.parse(JSON.stringify(t.hf)) });
    msg(t.key === 'blank' ? 'New blank document' : `${t.name}: replace the [bracketed text] with your own`);
    const ed = MTRX.w.ed; ed.focus();
  }

  function dialog() {
    let pick = T[1];
    modal('New from template',
      `<div class="tpl-grid">${T.map((t) => `<button type="button" class="tpl${t === pick ? ' on' : ''}" data-k="${t.key}"><b>${esc(t.name)}</b><small>${esc(t.note)}</small></button>`).join('')}</div>`,
      () => use(pick), 'Use template');
    const grid = document.querySelector('#modal .tpl-grid');
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.tpl'); if (!b) return;
      grid.querySelectorAll('.tpl').forEach((x) => x.classList.toggle('on', x === b));
      pick = T.find((t) => t.key === b.dataset.k);
    });
    grid.addEventListener('dblclick', (e) => { if (e.target.closest('.tpl')) document.querySelector('#m-ok').click(); });
  }

  MTRX.templates = { list: T, dialog, use };
  const homeBtn = $('#home-tpl'); if (homeBtn) homeBtn.onclick = dialog;
})();
