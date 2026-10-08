// Time Logger → iTimeKeep helper.
//
// Runs as a bookmarklet on the iTimeKeep web portal. It shows a small panel
// where you paste entries copied from Time Logger (Export → Copy for
// iTimeKeep), then fills one iTK time entry at a time the way you would by
// hand: typing into the fields and picking the matter from iTK's suggestion
// list. It never clicks Save; you review each entry and save it yourself.
//
// It does not know iTK's page layout in advance. The first time, "teach mode"
// asks you to click each field once and remembers how to find it.
//
// Stored in this browser for the iTK site:
//   localStorage   timeLoggerItkHelper  which fields to use, date format
//   localStorage   timeLoggerItkDone    one-way hashes of entries marked saved
//   sessionStorage timeLoggerItkQueue   the pasted entries (gone when the tab closes)
(function () {
  'use strict';

  if (window.__timeLoggerItk) {
    window.__timeLoggerItk.toggle();
    return;
  }

  const CONFIG_KEY = 'timeLoggerItkHelper';
  const QUEUE_KEY = 'timeLoggerItkQueue';
  const DONE_KEY = 'timeLoggerItkDone';

  const FIELDS = [
    { key: 'newEntry', label: 'the button that starts a new time entry', kind: 'button', optional: true },
    { key: 'date', label: 'the Date field', kind: 'date', optional: true },
    { key: 'matter', label: 'the Client / Matter field', kind: 'matter' },
    { key: 'hours', label: 'the Hours field', kind: 'text' },
    { key: 'narrative', label: 'the Narrative field', kind: 'text' },
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const normNum = (s) => norm(s).toLowerCase().replace(/\s+/g, '');

  function load(store, key, fallback) {
    try {
      const v = store.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  }
  function save(store, key, value) {
    try {
      if (value == null) store.removeItem(key);
      else store.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable */ }
  }

  let config = load(localStorage, CONFIG_KEY, null) || { fields: {}, dateFormat: 'MM/DD/YYYY' };
  let queue = load(sessionStorage, QUEUE_KEY, null) || { entries: [], index: 0 };
  let done = new Set(load(localStorage, DONE_KEY, []));
  let view = 'main'; // main | teach | settings
  let teachStep = 0;
  let status = null; // { kind: 'info'|'ok'|'warn'|'error', text, checks? }
  let busy = false;

  // A short one-way fingerprint, so "already saved" can be remembered without
  // keeping client narratives in storage.
  function fingerprint(e) {
    const s = [e.date, e.matterNumber, e.hours, e.narrative].join('|');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  // --- Finding iTK's fields -------------------------------------------------------

  const CONTROL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=""], [contenteditable=true], [role=combobox], [role=textbox]';
  const ATTRS = ['name', 'aria-label', 'placeholder', 'formcontrolname', 'data-testid', 'data-test', 'data-automation-id', 'data-field', 'title'];

  const isVisible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const inPanel = (el) => !!el && (el === host || host.contains(el));

  // Framework-generated ids (mat-input-3, input_1234, a GUID) change between visits.
  const stableId = (id) => (id && !/\d{2,}|[-_]\d+$|^[a-f0-9-]{16,}$/i.test(id) ? id : null);

  function controlFor(el, kind) {
    if (kind === 'button') return el.closest('button, [role=button], a, input[type=button], input[type=submit]') || el;
    if (el.matches(CONTROL)) return el;
    const inside = [...el.querySelectorAll(CONTROL)].filter(isVisible);
    if (inside.length === 1) return inside[0];
    for (let p = el.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth++) {
      const near = [...p.querySelectorAll(CONTROL)].filter(isVisible);
      if (near.length === 1) return near[0];
    }
    return el;
  }

  function labelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return norm(l.textContent);
    }
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ');
      if (norm(t)) return norm(t);
    }
    const wrap = el.closest('label');
    if (wrap) return norm(wrap.textContent);
    for (let p = el.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth++) {
      const l = p.querySelector('label, [class*="label" i]');
      if (l && !l.contains(el) && norm(l.textContent).length < 40) return norm(l.textContent);
    }
    return null;
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      const id = stableId(n.id);
      if (id) {
        parts.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function describe(el, kind) {
    const attrs = {};
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) attrs[a] = v;
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: stableId(el.id),
      attrs,
      label: kind === 'button' ? null : labelFor(el),
      text: kind === 'button' ? norm(el.textContent).slice(0, 60) : null,
      path: cssPath(el),
    };
  }

  function uniqueVisible(list) {
    const v = [...list].filter((el) => isVisible(el) && !inPanel(el));
    return v.length === 1 ? v[0] : null;
  }

  function find(desc) {
    if (!desc) return null;
    if (desc.id) {
      const el = document.getElementById(desc.id);
      if (isVisible(el)) return el;
    }
    for (const [a, v] of Object.entries(desc.attrs || {})) {
      const el = uniqueVisible(document.querySelectorAll(`${desc.tag}[${a}="${CSS.escape(v)}"]`));
      if (el) return el;
    }
    if (desc.label) {
      const labels = [...document.querySelectorAll('label, [class*="label" i]')].filter((l) => norm(l.textContent) === desc.label && isVisible(l));
      for (const l of labels) {
        const el = (l.control) || (l.htmlFor && document.getElementById(l.htmlFor));
        if (isVisible(el)) return el;
        for (let p = l.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth++) {
          const c = uniqueVisible(p.querySelectorAll(desc.tag));
          if (c) return c;
        }
      }
    }
    if (desc.text) {
      const el = uniqueVisible([...document.querySelectorAll(`${desc.tag}, [role=button]`)].filter((b) => norm(b.textContent).slice(0, 60) === desc.text));
      if (el) return el;
    }
    try {
      const el = document.querySelector(desc.path);
      if (isVisible(el)) return el;
    } catch { /* bad selector */ }
    return null;
  }

  // --- Typing and clicking like a person ------------------------------------------

  const valueOf = (el) => (el.isContentEditable ? el.textContent : el.value);

  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
  }

  function key(el, type, ch) {
    el.dispatchEvent(new KeyboardEvent(type, { key: ch, bubbles: true, cancelable: true, composed: true }));
  }

  function clearField(el) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll');
      document.execCommand('delete');
    } else if (typeof el.select === 'function') {
      el.select();
      if (!document.execCommand('delete') || el.value) {
        nativeSet(el, '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
    }
  }

  // Types text one character at a time with key events, as iTK's search boxes
  // expect; or inserts it in one go for long text like the narrative.
  async function typeInto(el, text, { perChar = false } = {}) {
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => normNum(o.textContent).includes(normNum(text)) || o.value === text);
      if (!opt) return false;
      nativeSet(el, opt.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.readOnly || el.disabled) return false;
    clearField(el);
    const chunks = perChar ? [...text] : [text];
    for (const chunk of chunks) {
      key(el, 'keydown', chunk);
      const before = valueOf(el);
      if (!document.execCommand('insertText', false, chunk) || valueOf(el) === before) {
        nativeSet(el, before + chunk);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: chunk, inputType: 'insertText' }));
      }
      key(el, 'keyup', chunk);
      if (perChar) await sleep(35);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function blur(el) {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
    if (document.activeElement === el) el.blur();
  }

  function click(el) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  // Things that might be entries in a suggestion list.
  const OPTION = '[role=option], li, mat-option, tr, .dropdown-item, [class*="option" i], [class*="suggest" i], [class*="result" i], [class*="item" i]';

  function optionCandidates(except) {
    return [...document.querySelectorAll(OPTION)].filter((el) => isVisible(el) && !inPanel(el) && !el.contains(except) && el !== except);
  }

  // After typing the matter number, wait for iTK's list and click the one new
  // suggestion that contains that number. Anything already on the page before
  // typing (e.g. a list of recent entries) is ignored.
  async function pickMatter(input, number, before) {
    const low = (t) => norm(t).toLowerCase();
    const needle = low(number);
    // The number must appear on its own: "2026-014" must not match "2026-0140".
    const whole = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const hits = optionCandidates(input).filter((el) => !before.has(el) && whole.test(low(el.textContent)));
      const leaves = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
      if (!leaves.length) continue;
      const starts = leaves.filter((el) => low(el.textContent).startsWith(needle));
      const pick = leaves.length === 1 ? leaves[0] : starts.length === 1 ? starts[0] : null;
      if (!pick) return 'ambiguous';
      const target = pick.closest('[role=option], li, mat-option, tr') || pick;
      click(target);
      return 'picked';
    }
    return 'none';
  }

  function formatDate(iso, fmt, el) {
    if (el && el.type === 'date') return iso;
    const [y, m, d] = iso.split('-');
    const map = { 'MM/DD/YYYY': `${m}/${d}/${y}`, 'M/D/YYYY': `${+m}/${+d}/${y}`, 'DD/MM/YYYY': `${d}/${m}/${y}`, 'YYYY-MM-DD': iso };
    return map[fmt] || map['MM/DD/YYYY'];
  }

  // --- Filling one entry ----------------------------------------------------------

  async function waitFor(desc, ms = 3000) {
    for (let t = 0; t < ms; t += 100) {
      const el = find(desc);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  async function fillEntry(entry) {
    const f = config.fields;
    const checks = [];
    const note = (ok, text) => checks.push({ ok, text });

    if (f.newEntry) {
      const btn = find(f.newEntry);
      if (btn) {
        click(btn);
        await sleep(400);
      } else {
        note(null, "Couldn't find the new-entry button. Open a new entry in iTK first if one isn't open.");
      }
    }

    const matter = await waitFor(f.matter);
    if (!matter) throw new Error("Couldn't find the matter field. Open a new time entry in iTK, or re-teach the fields under Settings.");

    let dateEl = null;
    if (f.date) {
      dateEl = find(f.date);
      if (!dateEl) note(false, 'Date: field not found. Set it yourself.');
    }
    const fillDate = async () => {
      if (!dateEl) return;
      const value = formatDate(entry.date, config.dateFormat, dateEl);
      if (await typeInto(dateEl, value)) blur(dateEl);
      return value;
    };
    const wantedDate = await fillDate();

    // Matter: type the number, then pick it from the suggestions.
    const before = new Set(optionCandidates(matter));
    await typeInto(matter, entry.matterNumber, { perChar: true });
    if (matter.tagName === 'SELECT') {
      note(true, `Matter: ${entry.matterNumber} selected`);
    } else {
      const result = await pickMatter(matter, entry.matterNumber, before);
      if (result === 'picked') note(true, `Matter: picked ${entry.matterNumber} from iTK's list`);
      else if (result === 'ambiguous') note(false, `Matter: several matches for ${entry.matterNumber}. Pick the right one in iTK's list.`);
      else note(false, `Matter: no suggestion for ${entry.matterNumber} appeared. Choose the matter yourself.`);
      blur(matter);
    }
    await sleep(600); // iTK may reload defaults after a matter is chosen

    const hours = find(f.hours);
    if (hours && (await typeInto(hours, entry.hours))) {
      blur(hours);
      note(norm(valueOf(hours)) === entry.hours || parseFloat(valueOf(hours)) === parseFloat(entry.hours), `Hours: ${entry.hours}`);
    } else {
      note(false, 'Hours: field not found or locked. Enter it yourself.');
    }

    const narrative = find(f.narrative);
    if (narrative && (await typeInto(narrative, entry.narrative))) {
      blur(narrative);
      note(norm(valueOf(narrative)) === norm(entry.narrative), 'Narrative filled');
    } else if (entry.narrative) {
      note(false, 'Narrative: field not found or locked. Paste it yourself.');
    }

    // Choosing a matter can reset the date; put it back once if so.
    if (dateEl && wantedDate) {
      const el = find(f.date) || dateEl;
      if (normNum(valueOf(el)) !== normNum(wantedDate)) {
        dateEl = el;
        await fillDate();
      }
      note(normNum(valueOf(el)) === normNum(wantedDate), `Date: ${wantedDate}`);
    } else if (dateEl && !wantedDate) {
      note(false, 'Date: the field is locked. Set it yourself.');
    }
    return checks;
  }

  // --- Panel UI -----------------------------------------------------------------------

  const host = document.createElement('div');
  host.setAttribute('data-time-logger-helper', '');
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
    .panel { position: fixed; right: 16px; bottom: 16px; width: 380px; max-height: 80vh; overflow: auto;
      background: #fff; color: #1c2330; border: 1px solid #d5d9e0; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.25); font-size: 13px; line-height: 1.45; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #2563eb; color: #fff;
      border-radius: 12px 12px 0 0; cursor: move; user-select: none; }
    .head b { flex: 1; font-size: 14px; }
    .head button { background: transparent; color: #fff; border: 0; font-size: 16px; padding: 0 4px; }
    .body { padding: 12px; display: grid; gap: 10px; }
    button { font: inherit; border-radius: 7px; border: 1px solid transparent; background: #2563eb; color: #fff;
      padding: 6px 12px; cursor: pointer; }
    button.secondary { background: #fff; color: #1c2330; border-color: #d5d9e0; }
    button.link { background: none; color: #2563eb; padding: 2px 0; border: 0; }
    button:disabled { opacity: .5; cursor: default; }
    textarea { width: 100%; min-height: 70px; font: 12px/1.4 Consolas, monospace; border: 1px solid #d5d9e0;
      border-radius: 7px; padding: 6px; }
    select { font: inherit; border: 1px solid #d5d9e0; border-radius: 7px; padding: 4px 6px; }
    .muted { color: #677084; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .entry { border: 1px solid #d5d9e0; border-radius: 9px; padding: 10px; display: grid; gap: 4px; }
    .entry .top { display: flex; gap: 8px; align-items: baseline; }
    .entry .m { font-weight: 600; flex: 1; }
    .entry .h { font-weight: 700; font-size: 15px; }
    .entry .n { white-space: pre-wrap; }
    .done-tag { background: #16a34a; color: #fff; border-radius: 999px; padding: 0 8px; font-size: 11px; }
    .status { border-radius: 8px; padding: 8px 10px; background: #eef2ff; }
    .status.ok { background: #e8f7ee; }
    .status.warn { background: #fdf3e2; }
    .status.error { background: #fde8e8; }
    .status ul { margin: 6px 0 0; padding-left: 18px; }
    .status li.bad { color: #b45309; }
    .steps { margin: 0; padding-left: 18px; }
    .steps li.now { font-weight: 700; }
    .steps li.set { color: #16a34a; }
    .nav { display: flex; align-items: center; gap: 6px; }
    .nav .count { flex: 1; text-align: center; }
    .hl { position: fixed; pointer-events: none; border: 2px solid #2563eb; background: rgba(37,99,235,.12);
      border-radius: 4px; display: none; }
  `;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    root.append(style);
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  const panel = h('div', { class: 'panel' });
  const highlight = h('div', { class: 'hl' });
  root.append(panel, highlight);
  document.body.append(host);

  function setQueue(q) {
    queue = q;
    save(sessionStorage, QUEUE_KEY, q.entries.length ? q : null);
  }

  function parsePaste(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('That isn\'t Time Logger data. In Time Logger, use Export → "Copy for iTimeKeep", then paste here.');
    }
    if (!data || data.format !== 'time-logger-itk' || !Array.isArray(data.entries)) {
      throw new Error('That isn\'t Time Logger data. In Time Logger, use Export → "Copy for iTimeKeep", then paste here.');
    }
    return data.entries.filter((e) => e && e.date && e.matterNumber && e.hours);
  }

  const fieldsTaught = () => FIELDS.every((f) => f.optional || config.fields[f.key]);

  function render() {
    const close = h('button', { title: 'Hide (click the bookmark again to reopen)', onclick: () => toggle(false) }, '✕');
    const head = h('div', { class: 'head' }, h('b', {}, 'Time Logger → iTimeKeep'),
      view === 'main' ? h('button', { title: 'Settings', onclick: () => { view = 'settings'; render(); } }, '⚙') : null, close);
    makeDraggable(head);
    let body;
    if (view === 'teach') body = renderTeach();
    else if (view === 'settings') body = renderSettings();
    else if (!fieldsTaught()) body = renderIntro();
    else if (!queue.entries.length) body = renderPaste();
    else body = renderEntry();
    panel.replaceChildren(head, h('div', { class: 'body' }, body));
  }

  function statusBox() {
    if (!status) return null;
    return h('div', { class: `status ${status.kind}` }, status.text,
      status.checks && status.checks.length
        ? h('ul', {}, status.checks.map((c) => h('li', { class: c.ok === false ? 'bad' : '' }, `${c.ok === false ? '⚠ ' : c.ok ? '✓ ' : ''}${c.text}`)))
        : null);
  }

  function renderIntro() {
    return [
      h('div', {}, h('b', {}, 'First, show me where iTimeKeep\'s fields are.')),
      h('div', { class: 'muted' }, 'Open a new, empty time entry in iTimeKeep. Then click Start and click each field when asked. You only do this once.'),
      h('div', { class: 'row' }, h('button', { onclick: startTeach }, 'Start')),
    ];
  }

  function renderPaste() {
    const ta = h('textarea', { placeholder: 'Paste here (Ctrl+V)' });
    const load = () => {
      try {
        const entries = parsePaste(ta.value);
        if (!entries.length) throw new Error('There were no entries in what you pasted.');
        const first = entries.findIndex((e) => !done.has(fingerprint(e)));
        setQueue({ entries, index: first < 0 ? 0 : first });
        status = { kind: 'info', text: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} ready. Open a new time entry in iTimeKeep if needed, then click "Fill in iTimeKeep".` };
      } catch (err) {
        status = { kind: 'error', text: err.message };
      }
      render();
    };
    ta.addEventListener('paste', () => setTimeout(load, 0));
    setTimeout(() => ta.focus(), 0);
    return [
      h('div', {}, 'In Time Logger, go to ', h('b', {}, 'Export'), ', choose the dates, and click ', h('b', {}, 'Copy for iTimeKeep'), '. Then paste here.'),
      ta,
      h('div', { class: 'row' }, h('button', { onclick: load }, 'Load entries')),
      statusBox(),
    ];
  }

  function renderEntry() {
    const e = queue.entries[queue.index];
    const isDone = done.has(fingerprint(e));
    const remaining = queue.entries.filter((x) => !done.has(fingerprint(x))).length;
    const go = (i) => {
      setQueue({ ...queue, index: Math.max(0, Math.min(queue.entries.length - 1, i)) });
      status = null;
      render();
    };
    const fill = async () => {
      if (busy) return;
      busy = true;
      status = { kind: 'info', text: 'Filling…' };
      render();
      try {
        const checks = await fillEntry(e);
        const problems = checks.some((c) => c.ok === false);
        status = {
          kind: problems ? 'warn' : 'ok',
          text: problems ? 'Filled, but some items need your attention in iTK:' : 'Filled. Check the entry in iTimeKeep and click iTK\'s Save button.',
          checks,
        };
      } catch (err) {
        status = { kind: 'error', text: err.message };
      }
      busy = false;
      render();
    };
    const markSaved = () => {
      done.add(fingerprint(e));
      save(localStorage, DONE_KEY, [...done].slice(-2000));
      const next = queue.entries.findIndex((x, i) => i > queue.index && !done.has(fingerprint(x)));
      const any = queue.entries.findIndex((x) => !done.has(fingerprint(x)));
      status = next >= 0 || any >= 0 ? null : { kind: 'ok', text: 'All entries are marked as saved. Nice work.' };
      setQueue({ ...queue, index: next >= 0 ? next : any >= 0 ? any : queue.index });
      render();
    };
    return [
      h('div', { class: 'nav' },
        h('button', { class: 'secondary', disabled: queue.index === 0, onclick: () => go(queue.index - 1) }, '‹'),
        h('span', { class: 'count' }, `Entry ${queue.index + 1} of ${queue.entries.length} · ${remaining} left`),
        h('button', { class: 'secondary', disabled: queue.index >= queue.entries.length - 1, onclick: () => go(queue.index + 1) }, '›')),
      h('div', { class: 'entry' },
        h('div', { class: 'top' }, h('span', { class: 'm' }, `${e.matterNumber} · ${e.client ? `${e.client} — ` : ''}${e.matter}`),
          isDone ? h('span', { class: 'done-tag' }, 'saved') : null, h('span', { class: 'h' }, e.hours)),
        h('div', { class: 'muted' }, new Date(`${e.date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })),
        h('div', { class: 'n' }, e.narrative || h('i', { class: 'muted' }, 'No narrative'))),
      h('div', { class: 'row' },
        h('button', { onclick: fill, disabled: busy }, isDone ? 'Fill again' : 'Fill in iTimeKeep'),
        h('button', { class: 'secondary', onclick: markSaved, disabled: busy || isDone }, 'I saved it → next')),
      statusBox(),
      h('div', { class: 'row' },
        h('button', { class: 'link', onclick: () => { setQueue({ entries: [], index: 0 }); status = null; render(); } }, 'Paste a different set')),
    ];
  }

  function renderSettings() {
    const fmt = h('select', { onchange: (ev) => { config.dateFormat = ev.target.value; save(localStorage, CONFIG_KEY, config); } },
      ['MM/DD/YYYY', 'M/D/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].map((f) => {
        const o = h('option', { value: f }, f);
        if (f === config.dateFormat) o.selected = true;
        return o;
      }));
    return [
      h('div', { class: 'row' }, h('span', {}, 'Date format iTK expects:'), fmt),
      h('div', {}, h('b', {}, 'Fields'), h('ul', { class: 'steps' },
        FIELDS.map((f) => h('li', { class: config.fields[f.key] ? 'set' : '' }, `${f.label}: ${config.fields[f.key] ? 'set' : f.optional ? 'skipped' : 'not set'}`)))),
      h('div', { class: 'row' },
        h('button', { onclick: startTeach }, 'Re-teach fields'),
        h('button', {
          class: 'secondary',
          onclick: () => {
            if (!confirm('Forget the taught fields and which entries were marked as saved?')) return;
            config = { fields: {}, dateFormat: 'MM/DD/YYYY' };
            done = new Set();
            save(localStorage, CONFIG_KEY, null);
            save(localStorage, DONE_KEY, null);
            view = 'main';
            render();
          },
        }, 'Forget everything')),
      h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: () => { view = 'main'; render(); } }, 'Done')),
    ];
  }

  // --- Teach mode ------------------------------------------------------------------

  function startTeach() {
    view = 'teach';
    teachStep = 0;
    status = null;
    document.addEventListener('mouseover', onTeachHover, true);
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) document.addEventListener(t, onTeachClick, true);
    render();
  }

  function endTeach() {
    document.removeEventListener('mouseover', onTeachHover, true);
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) document.removeEventListener(t, onTeachClick, true);
    highlight.style.display = 'none';
    view = 'main';
    render();
  }

  function onTeachHover(e) {
    if (e.composedPath().includes(host)) return;
    const el = controlFor(e.target, FIELDS[teachStep].kind);
    const r = el.getBoundingClientRect();
    Object.assign(highlight.style, { display: 'block', left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  }

  function onTeachClick(e) {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const field = FIELDS[teachStep];
    const el = controlFor(e.target, field.kind);
    config.fields[field.key] = describe(el, field.kind);
    save(localStorage, CONFIG_KEY, config);
    nextTeachStep();
  }

  function nextTeachStep() {
    teachStep++;
    if (teachStep >= FIELDS.length) {
      endTeach();
      status = { kind: 'ok', text: 'Got it. The helper now knows where iTimeKeep\'s fields are.' };
      render();
    } else {
      render();
    }
  }

  function renderTeach() {
    const field = FIELDS[teachStep];
    return [
      h('div', {}, h('b', {}, `Click ${field.label} in iTimeKeep.`)),
      field.key === 'newEntry'
        ? h('div', { class: 'muted' }, 'This lets the helper open a fresh entry each time. It won\'t click anything else for you, and never Save.')
        : h('div', { class: 'muted' }, 'Clicks are captured, not passed to iTK, while you teach.'),
      h('ol', { class: 'steps' }, FIELDS.map((f, i) => h('li', { class: i === teachStep ? 'now' : i < teachStep && config.fields[f.key] ? 'set' : '' }, f.label))),
      h('div', { class: 'row' },
        field.optional ? h('button', { class: 'secondary', onclick: () => { delete config.fields[field.key]; save(localStorage, CONFIG_KEY, config); nextTeachStep(); } },
          field.key === 'newEntry' ? 'Skip (I\'ll open entries myself)' : 'Skip (iTK fills it in)') : null,
        h('button', { class: 'secondary', onclick: endTeach }, 'Cancel')),
    ];
  }

  // --- Panel behavior ----------------------------------------------------------------

  function makeDraggable(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev) => {
        panel.style.left = `${Math.max(0, ev.clientX - dx)}px`;
        panel.style.top = `${Math.max(0, ev.clientY - dy)}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function toggle(show) {
    const visible = show == null ? host.style.display === 'none' : show;
    host.style.display = visible ? '' : 'none';
    if (!visible && view === 'teach') endTeach();
  }

  window.__timeLoggerItk = { toggle: () => toggle() };
  render();
})();
