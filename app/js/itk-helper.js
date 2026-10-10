// Time Logger → iTimeKeep helper.
//
// Runs as a bookmarklet on the iTimeKeep web portal. It shows a small panel
// where you paste entries copied from Time Logger (Export → Copy for
// iTimeKeep), then fills one iTK time entry at a time the way you would by
// hand. It never clicks Save; you review each entry and save it yourself.
//
// It does not know iTK's layout in advance. The first time, teach mode
// watches you do one entry's steps (open the entry window, look up a matter,
// click the fields) and remembers what you clicked. Your clicks still reach
// iTK normally while it watches.
//
// The entry form can be on the page, in a frame, or in a separate window that
// iTK opens; the helper looks in all of them.
//
// Stored in this browser for the iTK site:
//   localStorage   timeLoggerItkHelper  how to find iTK's controls, date format
//   localStorage   timeLoggerItkDone    one-way hashes of entries marked saved
//   sessionStorage timeLoggerItkQueue   the pasted entries (gone when the tab closes)
(function () {
  'use strict';

  // Bump when the helper changes, so a newer favorite replaces an older copy
  // still running in this tab instead of just showing it again.
  const HELPER_VERSION = 4;

  const existing = window.__timeLoggerItk;
  if (existing && existing.version === HELPER_VERSION) {
    existing.toggle();
    return;
  }
  if (existing) {
    try {
      if (existing.destroy) existing.destroy();
      else {
        // Versions before 3: hiding the panel also ends its teach mode.
        const old = document.querySelector('[data-time-logger-helper]');
        if (old && old.style.display !== 'none') existing.toggle();
      }
    } catch { /* ignore */ }
    for (const el of document.querySelectorAll('[data-time-logger-helper]')) el.remove();
  }

  const CONFIG_KEY = 'timeLoggerItkHelper';
  const QUEUE_KEY = 'timeLoggerItkQueue';
  const DONE_KEY = 'timeLoggerItkDone';
  const CONFIG_VERSION = 2;

  // The steps teach mode walks through, in the order an entry is filled.
  //   button: something to click   field: something to type into
  //   result: one row of the matter search results
  const STEPS = [
    { key: 'newEntry', kind: 'button', optional: true, name: 'New entry button',
      prompt: "Click iTimeKeep's button for a new time entry.",
      hint: 'Click it for real so the entry window opens.', skip: "Skip: I'll open entries myself" },
    { key: 'date', kind: 'field', optional: true, name: 'Date field',
      prompt: 'Click the Date field.', skip: 'Skip: iTK fills the date' },
    { key: 'matterOpen', kind: 'button', optional: true, name: 'Open matter list',
      prompt: 'Click whatever opens the matter list (the Matter field or its button).',
      skip: 'Skip: the search box is already showing' },
    { key: 'matterSearch', kind: 'field', name: 'Matter search box',
      prompt: 'Click the matter search box, then type a matter number.',
      hint: 'Use any matter number, such as your Admin matter.' },
    { key: 'matterGo', kind: 'button', optional: true, name: 'Search button',
      prompt: 'Click the Search button.', skip: 'Results appear as I type', alt: { label: 'I press Enter to search', mode: 'enter' } },
    { key: 'matterResult', kind: 'result', name: 'Matter in the results',
      prompt: 'Click the matter in the search results.' },
    { key: 'hours', kind: 'field', name: 'Hours field', prompt: 'Click the Hours field.' },
    { key: 'narrative', kind: 'field', name: 'Narrative field', prompt: 'Click the Narrative field.' },
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Visible-ish text with a space between separate pieces, so table cells
  // like <td>2025-210</td><td>Baker</td> read "2025-210 Baker", not "2025-210Baker".
  function textOf(el) {
    const parts = [];
    const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.nodeValue);
    return parts.join(' ');
  }
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const low = (s) => norm(s).toLowerCase();

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

  const freshConfig = () => ({ version: CONFIG_VERSION, fields: {}, matterGoMode: 'button', dateFormat: 'MM/DD/YYYY' });
  let config = load(localStorage, CONFIG_KEY, null);
  if (!config || config.version !== CONFIG_VERSION) config = { ...freshConfig(), dateFormat: (config && config.dateFormat) || 'MM/DD/YYYY' };
  let queue = load(sessionStorage, QUEUE_KEY, null) || { entries: [], index: 0 };
  let done = new Set(load(localStorage, DONE_KEY, []));
  let view = 'main'; // main | teach | settings
  let teachStep = 0;
  let status = null; // { kind: 'info'|'ok'|'warn'|'error', text, checks? }
  let busy = false;

  const saveConfig = () => save(localStorage, CONFIG_KEY, config);

  // A short one-way fingerprint, so "already saved" can be remembered without
  // keeping client narratives in storage.
  function fingerprint(e) {
    const s = [e.date, e.matterNumber, e.hours, e.narrative].join('|');
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 16777619);
    }
    return (x >>> 0).toString(36);
  }

  // --- Windows and frames -----------------------------------------------------------

  // If iTK opens the entry form in its own window, keep a handle to it so the
  // helper can work there too. (Only windows opened after the helper starts.)
  const popups = [];
  const realOpen = window.open;
  const watchOpen = function (...args) {
    const w = realOpen.apply(this, args);
    if (w) popups.unshift(w);
    return w;
  };
  window.open = watchOpen;

  // Every document to search, newest window first, then frames, then this page.
  function docs() {
    const out = [];
    const add = (d) => {
      if (!d || out.includes(d)) return;
      out.push(d);
      for (const f of d.querySelectorAll('iframe, frame')) {
        try { add(f.contentDocument); } catch { /* other site */ }
      }
    };
    for (const w of popups) {
      try { if (!w.closed) add(w.document); } catch { /* other site */ }
    }
    add(document);
    return out;
  }

  const viewOf = (el) => el.ownerDocument.defaultView;

  // --- Finding iTK's controls -------------------------------------------------------

  const CONTROL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=""], [contenteditable=true], [role=combobox], [role=textbox], [role=searchbox]';
  const BUTTON = 'button, [role=button], a, input[type=button], input[type=submit], input[type=image]';
  const ROW = '[role=option], [role=row], [role=listitem], [role=menuitem], tr, li, mat-option, a, button';
  const ATTRS = ['name', 'aria-label', 'placeholder', 'formcontrolname', 'data-testid', 'data-test', 'data-automation-id', 'data-field', 'title', 'type'];

  function isVisible(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const cs = viewOf(el).getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  const inPanel = (el) => !!el && (el === host || host.contains(el));

  // Framework-generated ids and classes (mat-input-3, input_1234, css-1x2y3z)
  // change between visits, so they're not used to find things.
  const stableName = (s) => (s && !/\d{2,}|[-_]\d+$|^[a-f0-9-]{16,}$|^(css|sc|jsx|ng|ember)-/i.test(s) ? s : null);
  const STATE_CLASS = /^(is-|has-)?(active|selected|hover(ed)?|focus(ed)?|highlight(ed)?|current|open|even|odd|first|last)$/i;

  function controlFor(el, kind) {
    if (kind === 'button') return el.closest(BUTTON) || el;
    if (kind === 'result') return el.closest(ROW) || el.closest('[class*="item" i], [class*="row" i], [class*="result" i], [class*="option" i]') || el;
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
    const d = el.ownerDocument;
    if (el.id) {
      const l = d.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return norm(l.textContent);
    }
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => d.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ');
      if (norm(t)) return norm(t);
    }
    const wrap = el.closest('label');
    if (wrap) return norm(wrap.textContent);
    // A nearby label counts only if its container holds no other control.
    for (let p = el.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth++) {
      if ([...p.querySelectorAll(CONTROL)].some((c) => c !== el)) break;
      const l = p.querySelector('label, [class*="label" i]');
      if (l && !l.contains(el) && norm(l.textContent).length < 40) return norm(l.textContent);
    }
    return null;
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== n.ownerDocument.body; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      const id = stableName(n.id);
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

  // Button text is kept only when it looks like a label ("Search", "New
  // Entry"), never when it could be client data such as a matter name.
  const safeText = (t) => (t.length <= 30 && !/\d/.test(t) ? t : null);

  function describe(el, kind) {
    const attrs = {};
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && (a !== 'title' || safeText(v))) attrs[a] = v;
    }
    const icon = el.querySelector('[class*="icon" i], [class*="fa-" i], svg[data-icon], i[class]');
    return {
      tag: el.tagName.toLowerCase(),
      id: stableName(el.id),
      attrs,
      label: kind === 'button' ? null : labelFor(el),
      text: kind === 'button' ? safeText(norm(el.textContent)) : null,
      icon: kind === 'button' && icon ? (icon.getAttribute('data-icon') || [...icon.classList].filter((c) => /fa-|icon-/.test(c)).join(' ')) || null : null,
      path: cssPath(el),
    };
  }

  // What a result row looks like (element type, role, stable classes), so the
  // same kind of row can be recognized for other matters. No row text is kept.
  function rowSignature(el) {
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      classes: [...el.classList].filter((c) => stableName(c) && !STATE_CLASS.test(c) && c.length < 40),
    };
  }
  function rowSelector(sig) {
    return sig.tag + (sig.role ? `[role="${sig.role}"]` : '') + sig.classes.map((c) => `.${CSS.escape(c)}`).join('');
  }

  function uniqueVisible(list) {
    const v = [...list].filter((el) => isVisible(el) && !inPanel(el));
    return v.length === 1 ? v[0] : null;
  }

  function findIn(d, desc) {
    if (desc.id) {
      const el = d.getElementById(desc.id);
      if (isVisible(el)) return el;
    }
    for (const [a, v] of Object.entries(desc.attrs || {})) {
      if (a === 'type') continue;
      const el = uniqueVisible(d.querySelectorAll(`${desc.tag}[${a}="${CSS.escape(v)}"]`));
      if (el) return el;
    }
    if (desc.label) {
      const labels = [...d.querySelectorAll('label, [class*="label" i]')].filter((l) => norm(l.textContent) === desc.label && isVisible(l));
      for (const l of labels) {
        const el = l.control || (l.htmlFor && d.getElementById(l.htmlFor));
        if (isVisible(el)) return el;
        for (let p = l.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth++) {
          const c = uniqueVisible(p.querySelectorAll(desc.tag));
          if (c) return c;
        }
      }
    }
    if (desc.text) {
      const el = uniqueVisible([...d.querySelectorAll(`${desc.tag}, [role=button]`)].filter((b) => norm(b.textContent) === desc.text));
      if (el) return el;
    }
    if (desc.icon) {
      const el = uniqueVisible([...d.querySelectorAll(desc.tag)].filter((b) => {
        const i = b.querySelector('[class*="icon" i], [class*="fa-" i], svg[data-icon], i[class]');
        return i && ((i.getAttribute('data-icon') || [...i.classList].filter((c) => /fa-|icon-/.test(c)).join(' ')) === desc.icon);
      }));
      if (el) return el;
    }
    try {
      const el = d.querySelector(desc.path);
      if (isVisible(el)) return el;
    } catch { /* bad selector */ }
    return null;
  }

  function find(desc) {
    if (!desc) return null;
    for (const d of docs()) {
      const el = findIn(d, desc);
      if (el) return el;
    }
    return null;
  }

  async function waitFor(desc, ms = 4000) {
    for (let t = 0; t <= ms; t += 100) {
      const el = find(desc);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  // --- Typing and clicking like a person -----------------------------------------------

  const valueOf = (el) => (el.isContentEditable ? el.textContent : el.value);

  function nativeSet(el, value) {
    const W = viewOf(el);
    const proto = el instanceof W.HTMLTextAreaElement ? W.HTMLTextAreaElement.prototype
      : el instanceof W.HTMLSelectElement ? W.HTMLSelectElement.prototype : W.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  function fire(el, Type, type, init) {
    const W = viewOf(el);
    el.dispatchEvent(new W[Type](type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  function keyEvent(el, type, k) {
    const code = k === 'Enter' ? 13 : k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
    const W = viewOf(el);
    const ev = new W.KeyboardEvent(type, { key: k, code: k === 'Enter' ? 'Enter' : undefined, bubbles: true, cancelable: true, composed: true });
    // Older widgets look at keyCode/which, which the constructor can't set.
    Object.defineProperty(ev, 'keyCode', { get: () => code });
    Object.defineProperty(ev, 'which', { get: () => code });
    el.dispatchEvent(ev);
  }

  function clearField(el) {
    const d = el.ownerDocument;
    el.focus();
    if (el.isContentEditable) {
      d.execCommand('selectAll');
      d.execCommand('delete');
    } else if (typeof el.select === 'function') {
      el.select();
      if (!d.execCommand('delete') || el.value) {
        nativeSet(el, '');
        fire(el, 'InputEvent', 'input', { inputType: 'deleteContentBackward' });
      }
    }
  }

  // Types text with key events, one character at a time for search boxes, or
  // all at once for long text like the narrative.
  async function typeInto(el, text, { perChar = false } = {}) {
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => low(o.textContent).includes(low(text)) || o.value === text);
      if (!opt) return false;
      nativeSet(el, opt.value);
      fire(el, 'Event', 'change');
      return true;
    }
    if (el.readOnly || el.disabled) return false;
    const d = el.ownerDocument;
    clearField(el);
    for (const chunk of perChar ? [...text] : [text]) {
      keyEvent(el, 'keydown', chunk);
      const before = valueOf(el);
      if (!d.execCommand('insertText', false, chunk) || valueOf(el) === before) {
        nativeSet(el, before + chunk);
        fire(el, 'InputEvent', 'input', { data: chunk, inputType: 'insertText' });
      }
      keyEvent(el, 'keyup', chunk);
      if (perChar) await sleep(35);
    }
    fire(el, 'Event', 'change');
    return true;
  }

  function pressEnter(el) {
    keyEvent(el, 'keydown', 'Enter');
    keyEvent(el, 'keypress', 'Enter');
    keyEvent(el, 'keyup', 'Enter');
  }

  function blur(el) {
    fire(el, 'FocusEvent', 'focusout', {});
    el.dispatchEvent(new (viewOf(el).FocusEvent)('blur'));
    if (el.ownerDocument.activeElement === el) el.blur();
  }

  function click(el) {
    const init = { view: viewOf(el), button: 0 };
    fire(el, 'PointerEvent', 'pointerdown', init);
    fire(el, 'MouseEvent', 'mousedown', init);
    fire(el, 'PointerEvent', 'pointerup', init);
    fire(el, 'MouseEvent', 'mouseup', init);
    el.click();
  }

  // --- Picking the matter from the search results -----------------------------------------

  const GENERIC_ROW = `${ROW}, [class*="option" i], [class*="result" i], [class*="item" i], [class*="row" i]`;

  function rowCandidates() {
    const sig = config.fields.matterResult;
    const learned = sig ? rowSelector(sig) : null;
    const out = [];
    for (const d of docs()) {
      if (learned) for (const el of d.querySelectorAll(learned)) out.push({ el, learned: true });
      for (const el of d.querySelectorAll(GENERIC_ROW)) out.push({ el, learned: false });
    }
    return out.filter((c) => isVisible(c.el) && !inPanel(c.el));
  }

  // Waits for search results and clicks the row showing this matter number.
  // Rows that were on screen before the search (e.g. a recent-entries list)
  // are ignored unless nothing new turns up.
  async function pickResult(number, before) {
    const needle = low(number);
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The number must appear on its own: "2026-014" must not match "2026-0140".
    const whole = new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`);
    const choose = (allowOld) => {
      const hits = rowCandidates().filter((c) => (allowOld || !before.has(c.el)) && whole.test(low(textOf(c.el))));
      const learned = hits.filter((c) => c.learned).map((c) => c.el);
      let pool = learned.length ? learned : hits.map((c) => c.el);
      pool = [...new Set(pool)];
      pool = pool.filter((el) => !pool.some((o) => o !== el && el.contains(o)));
      if (!pool.length) return null;
      if (pool.length === 1) return pool[0];
      const starts = pool.filter((el) => low(textOf(el)).startsWith(needle));
      return starts.length === 1 ? starts[0] : 'ambiguous';
    };
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      const pick = choose(false);
      if (pick === 'ambiguous') return 'ambiguous';
      if (pick) {
        click(pick);
        return 'picked';
      }
    }
    const old = choose(true);
    if (old && old !== 'ambiguous') {
      click(old);
      return 'picked';
    }
    return old === 'ambiguous' ? 'ambiguous' : 'none';
  }

  function formatDate(iso, fmt, el) {
    if (el && el.type === 'date') return iso;
    const [y, m, d] = iso.split('-');
    const map = { 'MM/DD/YYYY': `${m}/${d}/${y}`, 'M/D/YYYY': `${+m}/${+d}/${y}`, 'DD/MM/YYYY': `${d}/${m}/${y}`, 'YYYY-MM-DD': iso };
    return map[fmt] || map['MM/DD/YYYY'];
  }

  // --- Filling one entry ----------------------------------------------------------------

  async function fillEntry(entry) {
    const f = config.fields;
    const checks = [];
    const note = (ok, text) => checks.push({ ok, text });

    if (f.newEntry) {
      const btn = find(f.newEntry);
      if (btn) click(btn);
      else note(null, "Couldn't find the new-entry button, so I'm using the entry that's open.");
    }
    // Wait for the entry form (it may be opening in a new window).
    const first = f.date || f.matterOpen || f.matterSearch;
    if (!(await waitFor(first, 8000))) {
      throw new Error("Couldn't find the time entry form. Open a new time entry in iTK and try again, or re-teach under ⚙.");
    }

    // Date
    let dateEl = f.date ? find(f.date) : null;
    let wantedDate = null;
    const fillDate = async () => {
      dateEl = (f.date && find(f.date)) || dateEl;
      if (!dateEl) return false;
      wantedDate = formatDate(entry.date, config.dateFormat, dateEl);
      if (!(await typeInto(dateEl, wantedDate))) return false;
      blur(dateEl);
      return true;
    };
    const dateTyped = f.date ? await fillDate() : false;

    // Matter: open the list, search for the number, click the result.
    const before = new Set(rowCandidates().map((c) => c.el));
    let matterOk = false;
    if (f.matterOpen) {
      const opener = await waitFor(f.matterOpen);
      if (opener) click(opener);
    }
    const search = await waitFor(f.matterSearch);
    if (!search) {
      note(false, `Matter: couldn't find the search box. Look up ${entry.matterNumber} yourself.`);
    } else {
      await typeInto(search, entry.matterNumber, { perChar: true });
      if (config.matterGoMode === 'enter') pressEnter(search);
      else if (config.matterGoMode === 'button' && f.matterGo) {
        const go = await waitFor(f.matterGo, 2000);
        if (go) click(go);
        else note(false, "Matter: couldn't find the Search button.");
      }
      const result = await pickResult(entry.matterNumber, before);
      matterOk = result === 'picked';
      if (matterOk) note(true, `Matter: picked ${entry.matterNumber}`);
      else if (result === 'ambiguous') note(false, `Matter: more than one result shows ${entry.matterNumber}. Click the right one.`);
      else note(false, `Matter: ${entry.matterNumber} didn't appear in the results. Look it up yourself.`);
    }
    await sleep(700); // iTK may reload defaults after a matter is chosen

    // Hours and narrative
    const hours = await waitFor(f.hours, 2000);
    if (hours && (await typeInto(hours, entry.hours))) {
      blur(hours);
      const v = valueOf(hours);
      note(norm(v) === entry.hours || parseFloat(v) === parseFloat(entry.hours), `Hours: ${entry.hours}`);
    } else {
      note(false, 'Hours: field not found or locked. Enter it yourself.');
    }

    const narrative = await waitFor(f.narrative, 2000);
    if (narrative && (await typeInto(narrative, entry.narrative))) {
      blur(narrative);
      note(norm(valueOf(narrative)) === norm(entry.narrative), 'Narrative filled');
    } else if (entry.narrative) {
      note(false, 'Narrative: field not found or locked. Paste it yourself.');
    }

    // Choosing a matter can reset the date; put it back once if so.
    if (f.date) {
      if (!dateTyped) {
        note(false, `Date: couldn't type into the date field. Set it to ${formatDate(entry.date, config.dateFormat)} yourself.`);
      } else {
        const el = find(f.date) || dateEl;
        if (low(valueOf(el)) !== low(wantedDate)) await fillDate();
        note(low(valueOf(find(f.date) || el)) === low(wantedDate), `Date: ${wantedDate}`);
      }
    }
    return checks;
  }

  // --- Panel UI -----------------------------------------------------------------------------

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
    button.danger { background: #c02626; }
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
    .prompt { font-size: 14px; font-weight: 700; }
    .steps { margin: 0; padding-left: 18px; }
    .steps li.now { font-weight: 700; color: #2563eb; }
    .steps li.set { color: #16a34a; }
    .steps li.skipped { color: #677084; }
    .nav { display: flex; align-items: center; gap: 6px; }
    .nav .count { flex: 1; text-align: center; }
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
  root.append(panel);
  document.body.append(host);

  function setQueue(q) {
    queue = q;
    save(sessionStorage, QUEUE_KEY, q.entries.length ? q : null);
  }

  const NOT_OURS = 'That isn\'t Time Logger data. In Time Logger, use Export → "Copy for iTimeKeep", then paste here.';
  function parsePaste(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(NOT_OURS);
    }
    if (!data || data.format !== 'time-logger-itk' || !Array.isArray(data.entries)) throw new Error(NOT_OURS);
    return data.entries.filter((e) => e && e.date && e.matterNumber && e.hours);
  }

  const taught = () => STEPS.every((s) => s.optional || config.fields[s.key]);

  function render() {
    const head = h('div', { class: 'head' }, h('b', {}, 'Time Logger → iTimeKeep'),
      view === 'main' ? h('button', { title: 'Settings', onclick: () => { view = 'settings'; render(); } }, '⚙') : null,
      h('button', { title: 'Hide (click the favorite again to reopen)', onclick: () => toggle(false) }, '✕'));
    makeDraggable(head);
    let body;
    if (view === 'teach') body = renderTeach();
    else if (view === 'settings') body = renderSettings();
    else if (!taught()) body = renderIntro();
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
      h('div', { class: 'prompt' }, 'First, show me how you enter time in iTimeKeep.'),
      h('div', {}, 'I\'ll watch while you start one entry: open the entry window, look up a matter, and click the Hours and Narrative fields. Your clicks work normally while I watch. You only do this once.'),
      h('div', { class: 'muted' }, 'At the end, close that practice entry without saving.'),
      h('div', { class: 'row' }, h('button', { onclick: startTeach }, 'Start')),
      statusBox(),
    ];
  }

  function renderPaste() {
    const ta = h('textarea', { placeholder: 'Paste here (Ctrl+V)' });
    const loadEntries = () => {
      try {
        const entries = parsePaste(ta.value);
        if (!entries.length) throw new Error('There were no entries in what you pasted.');
        const first = entries.findIndex((e) => !done.has(fingerprint(e)));
        setQueue({ entries, index: first < 0 ? 0 : first });
        status = { kind: 'info', text: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} ready. Click "Fill in iTimeKeep" to start.` };
      } catch (err) {
        status = { kind: 'error', text: err.message };
      }
      render();
    };
    ta.addEventListener('paste', () => setTimeout(loadEntries, 0));
    setTimeout(() => ta.focus(), 0);
    return [
      h('div', {}, 'In Time Logger, go to ', h('b', {}, 'Export'), ', choose the dates, and click ', h('b', {}, 'Copy for iTimeKeep'), '. Then paste here.'),
      ta,
      h('div', { class: 'row' }, h('button', { onclick: loadEntries }, 'Load entries')),
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

  function stepState(s) {
    if (s.key === 'matterGo' && config.matterGoMode !== 'button') return config.matterGoMode === 'enter' ? 'press Enter' : 'automatic';
    return config.fields[s.key] ? 'set' : s.optional ? 'skipped' : 'not set';
  }

  let confirmingForget = false;

  // Clears what was learned and which entries were marked saved, and any
  // teaching in progress, so the next Start begins from scratch.
  function forgetEverything() {
    if (view === 'teach' || watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
      for (const d of docs()) d.removeEventListener('pointerdown', onTeachPointer, true);
      watched = new WeakSet();
    }
    config = freshConfig();
    configBeforeTeach = null;
    done = new Set();
    save(localStorage, CONFIG_KEY, null);
    save(localStorage, DONE_KEY, null);
    confirmingForget = false;
    view = 'main';
    status = { kind: 'info', text: 'Everything was forgotten. Click Start to teach the helper again.' };
    render();
  }

  function renderSettings() {
    const fmt = h('select', { onchange: (ev) => { config.dateFormat = ev.target.value; saveConfig(); } },
      ['MM/DD/YYYY', 'M/D/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].map((f) => {
        const o = h('option', { value: f }, f);
        if (f === config.dateFormat) o.selected = true;
        return o;
      }));
    return [
      h('div', { class: 'row' }, h('span', {}, 'Date format iTK expects:'), fmt),
      h('div', {}, h('b', {}, 'What I learned'), h('ul', { class: 'steps' },
        STEPS.map((s) => h('li', { class: stepState(s) === 'not set' ? '' : stepState(s) === 'skipped' ? 'skipped' : 'set' }, `${s.name}: ${stepState(s)}`)))),
      h('div', { class: 'row' },
        h('button', { onclick: startTeach }, 'Re-teach'),
        confirmingForget
          ? [h('span', {}, 'Forget everything?'),
            h('button', { class: 'danger', onclick: forgetEverything }, 'Yes, forget'),
            h('button', { class: 'secondary', onclick: () => { confirmingForget = false; render(); } }, 'No')]
          : h('button', { class: 'secondary', onclick: () => { confirmingForget = true; render(); } }, 'Forget everything')),
      h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: () => { view = 'main'; render(); } }, 'Done')),
      h('div', { class: 'muted' }, `Helper version ${HELPER_VERSION}`),
    ];
  }

  // --- Teach mode: watch the user's real clicks ------------------------------------------

  // Documents currently being watched. Reset whenever teaching ends, so a
  // restarted teach attaches its listener again.
  let watched = new WeakSet();
  let watchTimer = null;

  // Attach to every document, including an entry window that opens mid-way.
  function watchDocs() {
    for (const d of docs()) {
      if (watched.has(d)) continue;
      watched.add(d);
      d.addEventListener('pointerdown', onTeachPointer, true);
    }
  }

  let configBeforeTeach = null;

  function startTeach() {
    view = 'teach';
    teachStep = 0;
    status = null;
    configBeforeTeach = config;
    config = { ...freshConfig(), dateFormat: config.dateFormat };
    watchDocs();
    clearInterval(watchTimer);
    watchTimer = setInterval(watchDocs, 300);
    render();
  }

  function endTeach(message) {
    clearInterval(watchTimer);
    for (const d of docs()) d.removeEventListener('pointerdown', onTeachPointer, true);
    watched = new WeakSet();
    view = 'main';
    saveConfig();
    status = message || null;
    render();
  }

  function onTeachPointer(e) {
    if (view !== 'teach' || e.composedPath().includes(host)) return;
    const step = STEPS[teachStep];
    const el = controlFor(e.target, step.kind);
    if (step.kind === 'result') config.fields[step.key] = rowSignature(el);
    else config.fields[step.key] = describe(el, step.kind);
    if (step.key === 'matterGo') config.matterGoMode = 'button';
    saveConfig();
    // Let iTK handle the click first, then move on.
    setTimeout(nextTeachStep, 0);
  }

  function nextTeachStep() {
    teachStep++;
    if (teachStep >= STEPS.length) {
      endTeach({ kind: 'ok', text: 'Got it. Now close that practice entry in iTimeKeep without saving it.' });
    } else {
      render();
    }
  }

  // Undo the last step after a misclick, without starting over.
  function backStep() {
    if (teachStep === 0) return;
    teachStep--;
    const step = STEPS[teachStep];
    delete config.fields[step.key];
    if (step.key === 'matterGo') config.matterGoMode = 'button';
    saveConfig();
    render();
  }

  function skipStep(mode) {
    const step = STEPS[teachStep];
    delete config.fields[step.key];
    if (step.key === 'matterGo') config.matterGoMode = mode || 'auto';
    saveConfig();
    nextTeachStep();
  }

  function renderTeach() {
    const step = STEPS[teachStep];
    return [
      h('div', { class: 'prompt' }, step.prompt),
      step.hint ? h('div', { class: 'muted' }, step.hint) : null,
      h('ol', { class: 'steps' }, STEPS.map((s, i) => h('li', {
        class: i === teachStep ? 'now' : i < teachStep ? (config.fields[s.key] || (s.key === 'matterGo' && config.matterGoMode !== 'button') ? 'set' : 'skipped') : '',
      }, s.name))),
      h('div', { class: 'row' },
        step.alt ? h('button', { class: 'secondary', onclick: () => skipStep(step.alt.mode) }, step.alt.label) : null,
        step.optional ? h('button', { class: 'secondary', onclick: () => skipStep() }, step.skip) : null,
        teachStep > 0 ? h('button', { class: 'secondary', title: 'Undo the last step and do it again', onclick: backStep }, '← Back') : null,
        h('button', { class: 'link', onclick: () => { config = configBeforeTeach || config; endTeach({ kind: 'info', text: 'Teaching cancelled. Nothing was changed.' }); } }, 'Cancel')),
      h('div', { class: 'muted' }, 'Misclicked? Use Back to redo the last step.'),
    ];
  }

  // --- Panel behavior --------------------------------------------------------------------------

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
    if (!visible && view === 'teach') {
      config = configBeforeTeach || config;
      endTeach();
    }
  }

  function destroy() {
    if (view === 'teach') {
      config = configBeforeTeach || config;
      endTeach();
    }
    if (window.open === watchOpen) window.open = realOpen;
    host.remove();
  }

  window.__timeLoggerItk = { version: HELPER_VERSION, toggle: () => toggle(), destroy };
  render();
})();
