'use strict';

const T = window.TimeCore;
const R = window.ReportCore;
const ipc = window.api;

const FAILED = Symbol('failed');
const GAP_MIN_MS = 5 * T.MINUTE;

let state = null;
let info = {};
const view = {
  tab: 'day',
  day: T.dateKey(Date.now()),
  sel: 0,
  dayForm: null, // { mode: 'edit'|'gap'|'new', id?, start?, end? }
  matterEditId: null,
};

const $ = (id) => document.getElementById(id);
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// --- Helpers ------------------------------------------------------------------

const inc = () => state.settings.increment;
const fmtH = (hours) => T.formatHours(hours, inc());
const clock = (ms) => T.formatClock(ms);
const running = () => state.entries.find((e) => e.end == null) || null;
const matterById = (id) => state.matters.find((m) => m.id === id) || null;
const label = (id) => R.matterLabel(matterById(id));

function clockWithDay(ms) {
  if (T.dateKey(ms) === T.dateKey(Date.now())) return clock(ms);
  return `${new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${clock(ms)}`;
}

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

async function act(type, payload) {
  try {
    return await ipc.action(type, payload);
  } catch (err) {
    toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    return FAILED;
  }
}

function sortedMatters(list) {
  return [...list].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || R.matterLabel(a).localeCompare(R.matterLabel(b)));
}

function filteredMatters(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.matters.filter((m) => {
    if (m.archived) return false;
    const hay = `${m.client} ${m.name} ${m.number}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  return sortedMatters(list);
}

function matterSelect(selectedId) {
  const list = [...state.matters.filter((m) => !m.archived || m.id === selectedId)]
    .sort((a, b) => R.matterLabel(a).localeCompare(R.matterLabel(b)));
  return h('select', { required: true },
    h('option', { value: '' }, 'Choose a matter…'),
    list.map((m) => {
      const opt = h('option', { value: m.id }, R.matterLabel(m) + (m.number ? ` (${m.number})` : ''));
      if (m.id === selectedId) opt.selected = true;
      return opt;
    }));
}

function todayGaps(now) {
  const key = T.dateKey(now);
  return R.findGaps(state.activity, state.entries, T.dayStart(key), now, now, GAP_MIN_MS);
}

// --- Now / running timer --------------------------------------------------------

let nowKey = '';

function backdateHint(r, now) {
  if (!r || now - r.start > 15 * T.MINUTE) return null;
  const gap = R.findGaps(state.activity, state.entries.filter((e) => e.id !== r.id), r.start - 12 * T.HOUR, r.start + 1, now, GAP_MIN_MS)
    .find((g) => Math.abs(g.end - (r.start + 1)) < T.MINUTE);
  return gap && r.start - gap.start >= GAP_MIN_MS ? gap : null;
}

function renderNow(force = false) {
  const el = $('now');
  const now = Date.now();
  const r = running();
  const hint = backdateHint(r, now);
  const untracked = !r ? todayGaps(now).find((g) => g.end >= now - 2 * T.MINUTE) : null;
  const key = JSON.stringify([r && [r.id, r.start, r.matterId, r.description], state.interruptStack, hint && hint.start, untracked && untracked.start]);
  const typing = el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (!force && (key === nowKey || typing)) return updateElapsed();
  nowKey = key;

  const top = state.interruptStack[state.interruptStack.length - 1];
  const resumeRow = top && h('div', { class: 'resume' },
    h('span', { class: 'what' }, 'Interrupted: ', h('strong', {}, label(top.matterId)), top.description ? ` (${top.description})` : ''),
    h('button', { onclick: () => act('resume') }, 'Back to it'),
    h('button', { class: 'secondary small', title: 'Forget this', onclick: () => act('dismissResume') }, '✕'));

  if (!r) {
    fill(el,
      h('div', { class: 'now-top' },
        h('div', { class: 'now-label' }, h('span', { class: 'dot' }), 'Not timing'),
        h('div', { class: 'now-matter idle' },
          untracked
            ? `You've been at your computer since ${clock(untracked.start)} without a timer. Pick a matter below.`
            : 'Pick a matter below to start timing.')),
      resumeRow);
    document.title = 'Time Logger';
    return;
  }

  const m = matterById(r.matterId);
  fill(el,
    h('div', { class: 'now-top' },
      h('div', { class: 'now-label' }, h('span', { class: 'dot running' }), 'Timing'),
      h('div', { class: 'now-matter' }, label(r.matterId), m && !m.billable ? h('span', { class: 'badge' }, 'Non-billable') : null),
      h('div', { class: 'now-clock' }, h('span', { id: 'elapsed' }), h('span', { id: 'elapsedHours', class: 'hours' }))),
    h('div', { class: 'now-fields' },
      h('input', {
        class: 'desc', type: 'text', value: r.description, placeholder: 'What are you working on? (becomes the bill narrative)',
        onchange: (e) => act('updateEntry', { id: r.id, patch: { description: e.target.value } }),
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      }),
      h('label', { class: 'check muted' }, 'Started',
        h('input', {
          type: 'time', value: T.timeInputValue(r.start),
          onchange: (e) => act('setRunningStart', { start: T.parseClockOnDay(T.dateKey(r.start), e.target.value) })
            .then(() => renderNow(true)),
        })),
      h('button', { class: 'danger', onclick: () => act('stop') }, 'Stop')),
    hint && h('div', { class: 'notice' },
      `You were at your computer from ${clock(hint.start)} before starting this timer.`,
      h('button', { class: 'small', onclick: () => act('setRunningStart', { start: hint.start }) }, `Count it from ${clock(hint.start)}`)),
    resumeRow);
  updateElapsed();
}

function updateElapsed() {
  const r = running();
  if (!r) return;
  const ms = Date.now() - r.start;
  const el = $('elapsed');
  if (el) el.textContent = T.formatDuration(ms, true);
  const hrs = $('elapsedHours');
  if (hrs) hrs.textContent = `${fmtH(T.billableHours(ms, inc()))} hr`;
  document.title = `${T.formatDuration(ms)} · ${label(r.matterId)}`;
}

// --- Matter switcher ----------------------------------------------------------

function renderMatterList() {
  const q = $('search').value.trim();
  const list = filteredMatters(q).slice(0, q ? 20 : 8);
  view.sel = Math.min(view.sel, Math.max(0, list.length - 1));
  const r = running();
  const items = list.map((m, i) => {
    const isRunning = r && r.matterId === m.id;
    return h('li', { class: i === view.sel ? 'sel' : '', onclick: () => startMatter(m.id, false) },
      h('div', { class: 'ml-main' },
        m.client ? h('span', { class: 'ml-client' }, m.client) : null,
        h('span', { class: 'ml-name' }, m.name),
        m.number ? h('span', { class: 'ml-num' }, m.number) : null,
        !m.billable ? h('span', { class: 'badge' }, 'Non-billable') : null),
      h('div', { class: 'ml-actions' },
        isRunning
          ? h('span', { class: 'badge live' }, 'running')
          : [
            h('button', { class: 'small', onclick: (e) => { e.stopPropagation(); startMatter(m.id, false); } }, r ? 'Switch' : 'Start'),
            r ? h('button', {
              class: 'secondary small',
              title: 'Pause the current matter, time this one, then go back with one click',
              onclick: (e) => { e.stopPropagation(); startMatter(m.id, true); },
            }, 'Interrupt') : null,
          ]));
  });
  if (q && !list.length) {
    items.push(h('li', { onclick: () => newMatterFromSearch(q) },
      h('div', { class: 'ml-main muted' }, `No matter matches “${q}”.`),
      h('button', { class: 'small' }, 'Add it as a new matter')));
  }
  $('matterList').replaceChildren(...items);
}

async function startMatter(id, interrupt) {
  const r = running();
  if (r && r.matterId === id) return;
  if ((await act('start', { matterId: id, interrupt })) === FAILED) return;
  $('search').value = '';
  view.sel = 0;
  renderMatterList();
}

function newMatterFromSearch(q) {
  switchTab('matters');
  const form = $('matterForm');
  form.elements.name.value = q;
  form.elements.client.focus();
  $('search').value = '';
  renderMatterList();
}

function onSearchKey(e) {
  const list = filteredMatters($('search').value.trim()).slice(0, 20);
  if (e.key === 'ArrowDown') { view.sel = Math.min(view.sel + 1, list.length - 1); renderMatterList(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { view.sel = Math.max(view.sel - 1, 0); renderMatterList(); e.preventDefault(); }
  else if (e.key === 'Enter') {
    const m = list[view.sel];
    if (m) startMatter(m.id, e.shiftKey && !!running());
    else if ($('search').value.trim()) newMatterFromSearch($('search').value.trim());
  } else if (e.key === 'Escape') { $('search').value = ''; view.sel = 0; renderMatterList(); $('search').blur(); }
}

// --- Day view -------------------------------------------------------------------

function renderDay(force = false) {
  if (!force && view.dayForm) return;
  const key = view.day;
  const now = Date.now();
  const from = T.dayStart(key);
  const to = T.dayEnd(key);
  const entries = R.entriesBetween(state.entries, from, to);
  const gaps = R.findGaps(state.activity, state.entries, from, Math.min(to, now), now, GAP_MIN_MS);
  const lines = R.billingLines(state, entries, { combine: state.settings.combineOnExport, now });
  const tot = R.totals(lines);
  const untrackedMs = gaps.reduce((s, g) => s + g.end - g.start, 0);

  const isToday = key === T.dateKey(now);
  $('dayLabel').textContent = (isToday ? 'Today, ' : '') +
    new Date(from).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: isToday ? undefined : 'numeric' });
  $('nextDay').disabled = isToday;
  $('todayBtn').hidden = isToday;

  const stat = (k, v, cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
  $('dayTotals').replaceChildren(
    stat('Billable', `${fmtH(tot.billable)} hr`),
    stat('Non-billable', `${fmtH(tot.nonBillable)} hr`),
    stat('Untracked', T.formatDuration(untrackedMs), untrackedMs ? 'gap' : ''));

  renderTimeline(entries, gaps, from, now, isToday);

  const rows = [
    ...entries.map((e) => ({ kind: 'entry', start: e.start, e })),
    ...gaps.map((g) => ({ kind: 'gap', start: g.start, g })),
  ].sort((a, b) => a.start - b.start);

  const out = [];
  const f = view.dayForm;
  for (const row of rows) {
    if (row.kind === 'entry') {
      out.push(f && f.mode === 'edit' && f.id === row.e.id ? editForm(row.e) : entryRow(row.e, now));
    } else {
      const open = f && f.mode === 'gap' && f.start === row.g.start;
      out.push(open ? gapForm(row.g) : gapRow(row.g));
    }
  }
  if (f && f.mode === 'new') out.push(newForm());
  if (!out.length) {
    out.push(h('div', { class: 'empty' }, isToday
      ? 'Nothing logged yet today. Start a timer above, or add time manually.'
      : 'Nothing was logged on this day.'));
  }
  $('dayList').replaceChildren(...out);
  $('addManual').hidden = !!(f && f.mode === 'new');
  const first = $('dayList').querySelector('.entry-form select, .entry-form input');
  if (force && first && f) first.focus();
}

function renderTimeline(entries, gaps, from, now, isToday) {
  let startH = 8, endH = 18;
  const hourOf = (ms) => (ms - from) / T.HOUR;
  for (const x of [...entries, ...gaps]) {
    startH = Math.min(startH, Math.floor(hourOf(x.start)));
    endH = Math.max(endH, Math.ceil(hourOf(x.end == null ? now : x.end)));
  }
  startH = Math.max(0, startH);
  endH = Math.min(24, endH);
  const t0 = from + startH * T.HOUR;
  const span = (endH - startH) * T.HOUR;
  const pct = (ms) => `${Math.max(0, Math.min(100, ((ms - t0) / span) * 100))}%`;
  const block = (start, end, cls, title) => {
    const el = h('div', { class: `blk ${cls}`, title });
    el.style.left = pct(start);
    el.style.width = `calc(${pct(end)} - ${pct(start)})`;
    return el;
  };
  const kids = [];
  const step = endH - startH > 12 ? 2 : 1;
  for (let hr = startH + step; hr < endH; hr += step) {
    const t = h('div', { class: 'tick' }, new Date(from + hr * T.HOUR).toLocaleTimeString([], { hour: 'numeric' }));
    t.style.left = pct(from + hr * T.HOUR);
    kids.push(t);
  }
  for (const g of gaps) kids.push(block(g.start, g.end, 'gap', `Untracked ${clock(g.start)}–${clock(g.end)}`));
  for (const e of entries) {
    const m = matterById(e.matterId);
    const end = e.end == null ? now : e.end;
    kids.push(block(e.start, end, `${m && m.billable ? 'billable' : 'nonbillable'}${e.end == null ? ' running' : ''}`,
      `${label(e.matterId)}  ${clock(e.start)}–${e.end == null ? 'now' : clock(end)}`));
  }
  if (isToday) {
    const line = h('div', { class: 'now-line', title: 'Now' });
    line.style.left = pct(now);
    kids.push(line);
  }
  $('timeline').replaceChildren(...kids);
}

function entryRow(e, now) {
  const m = matterById(e.matterId);
  const end = e.end == null ? now : e.end;
  return h('div', { class: `item ${m && m.billable ? '' : 'nonbillable'}` },
    h('div', { class: 'when' }, `${clock(e.start)} – ${e.end == null ? 'now' : clock(end)}`),
    h('div', { class: 'what' },
      h('div', { class: 'm' }, label(e.matterId), e.end == null ? h('span', { class: 'badge live' }, 'running') : null),
      h('div', { class: 'd' }, e.description || h('em', {}, 'No description'))),
    h('div', { class: 'hrs', title: T.formatDuration(end - e.start) }, fmtH(T.billableHours(end - e.start, inc()))),
    h('div', { class: 'acts' },
      h('button', { class: 'link', onclick: () => openDayForm({ mode: 'edit', id: e.id }) }, 'Edit'),
      h('button', {
        class: 'link',
        onclick: async () => {
          if (!confirm(`Delete this entry?\n\n${label(e.matterId)}, ${clock(e.start)}–${e.end == null ? 'now' : clock(end)}`)) return;
          await act('deleteEntry', { id: e.id });
        },
      }, 'Delete')));
}

function gapRow(g) {
  return h('div', { class: 'item gap' },
    h('div', { class: 'when' }, `${clock(g.start)} – ${clock(g.end)}`),
    h('div', { class: 'what' },
      h('div', { class: 'm' }, 'Untracked time'),
      h('div', { class: 'd' }, `You were using your computer for ${T.formatMinutes(g.end - g.start)} with no timer running.`)),
    h('div', { class: 'hrs' }, ''),
    h('div', { class: 'acts' },
      h('button', { class: 'small', onclick: () => openDayForm({ mode: 'gap', start: g.start, end: g.end }) }, 'Log this time')));
}

function openDayForm(f) {
  view.dayForm = f;
  renderDay(true);
}

function closeDayForm() {
  view.dayForm = null;
  renderDay(true);
}

// Shared form for editing, logging a gap, or adding time by hand.
function entryForm({ matterId, start, end, description, isRunning }, onSave) {
  const key = view.day;
  const sel = matterSelect(matterId);
  const s = h('input', { type: 'time', required: true, value: start != null ? T.timeInputValue(start) : '' });
  const e = isRunning ? null : h('input', { type: 'time', required: true, value: end != null ? T.timeInputValue(end) : '' });
  const d = h('input', { class: 'desc', type: 'text', value: description || '', placeholder: 'Description for the bill' });
  return h('form', {
    class: 'entry-form',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const payload = { matterId: sel.value, start: T.parseClockOnDay(key, s.value), description: d.value };
      if (e) payload.end = T.parseClockOnDay(key, e.value);
      if ((await onSave(payload)) !== FAILED) closeDayForm();
    },
    onkeydown: (ev) => { if (ev.key === 'Escape') closeDayForm(); },
  },
  sel, s, isRunning ? h('span', { class: 'muted' }, '– now') : ['–', e], d,
  h('button', { type: 'submit' }, 'Save'),
  h('button', { type: 'button', class: 'secondary', onclick: closeDayForm }, 'Cancel'));
}

function editForm(entry) {
  return entryForm({ ...entry, isRunning: entry.end == null }, (p) => {
    const patch = { matterId: p.matterId, start: p.start, description: p.description };
    if (entry.end != null) patch.end = p.end;
    return act('updateEntry', { id: entry.id, patch });
  });
}

function gapForm(g) {
  return entryForm({ start: g.start, end: g.end }, (p) => act('addEntry', p));
}

function newForm() {
  return entryForm({}, (p) => act('addEntry', p));
}

// --- Matters tab ------------------------------------------------------------------

function renderMatters(force = false) {
  if (!force && view.matterEditId) return;
  const q = $('matterFilter').value.trim().toLowerCase();
  const showArchived = $('showArchived').checked;
  const list = state.matters
    .filter((m) => showArchived || !m.archived)
    .filter((m) => !q || `${m.client} ${m.name} ${m.number}`.toLowerCase().includes(q))
    .sort((a, b) => R.matterLabel(a).localeCompare(R.matterLabel(b)));

  const rows = list.map((m) => {
    if (view.matterEditId === m.id) {
      const client = h('input', { value: m.client });
      const name = h('input', { value: m.name });
      const number = h('input', { value: m.number });
      const billable = h('input', { type: 'checkbox', checked: m.billable });
      const save = async () => {
        const res = await act('updateMatter', { id: m.id, patch: { client: client.value, name: name.value, number: number.value, billable: billable.checked } });
        if (res === FAILED) return;
        view.matterEditId = null;
        renderMatters(true);
      };
      return h('tr', { onkeydown: (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { view.matterEditId = null; renderMatters(true); } } },
        h('td', {}, client), h('td', {}, name), h('td', {}, number), h('td', {}, billable),
        h('td', { class: 'num' },
          h('button', { class: 'small', onclick: save }, 'Save'), ' ',
          h('button', { class: 'secondary small', onclick: () => { view.matterEditId = null; renderMatters(true); } }, 'Cancel')));
    }
    return h('tr', { class: m.archived ? 'archived' : '' },
      h('td', {}, m.client), h('td', {}, m.name), h('td', {}, m.number), h('td', {}, m.billable ? 'Billable' : 'Non-billable'),
      h('td', { class: 'num' },
        h('button', { class: 'link', onclick: () => { view.matterEditId = m.id; renderMatters(true); } }, 'Edit'),
        h('button', { class: 'link', onclick: () => act('updateMatter', { id: m.id, patch: { archived: !m.archived } }) },
          m.archived ? 'Unarchive' : 'Archive')));
  });

  $('matterTable').replaceChildren(list.length
    ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Client'), h('th', {}, 'Matter'), h('th', {}, 'Number'), h('th', {}, 'Type'), h('th', {}, ''))),
      h('tbody', {}, rows))
    : h('div', { class: 'empty' }, 'No matters match.'));
}

async function onAddMatter(e) {
  e.preventDefault();
  const f = e.target.elements;
  const res = await act('addMatter', { client: f.client.value, name: f.name.value, number: f.number.value, billable: f.billable.checked });
  if (res === FAILED) return;
  toast(`Added ${R.matterLabel(res)}`);
  e.target.reset();
  f.client.focus();
}

// --- Export tab -------------------------------------------------------------------

function setRange(kind) {
  const today = T.dateKey(Date.now());
  const d = new Date();
  const mondayOffset = (d.getDay() + 6) % 7;
  const monday = T.addDays(today, -mondayOffset);
  const firstOfMonth = `${today.slice(0, 8)}01`;
  let from = today, to = today;
  if (kind === 'week') from = monday;
  if (kind === 'lastweek') { from = T.addDays(monday, -7); to = T.addDays(monday, -1); }
  if (kind === 'month') from = firstOfMonth;
  if (kind === 'lastmonth') { to = T.addDays(firstOfMonth, -1); from = `${to.slice(0, 8)}01`; }
  $('expFrom').value = from;
  $('expTo').value = to;
  renderExport();
}

function renderExport() {
  const from = $('expFrom').value;
  const to = $('expTo').value;
  if (!from || !to) return;
  const entries = R.entriesBetween(state.entries, T.dayStart(from), T.dayEnd(to)).filter((e) => e.end != null);
  const lines = R.billingLines(state, entries, { combine: $('expCombine').checked });
  const tot = R.totals(lines);
  const runningNote = running() && R.entriesBetween([running()], T.dayStart(from), T.dayEnd(to)).length
    ? ' The running timer is not included until you stop it.' : '';
  $('exportStatus').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'} · ${fmtH(tot.billable)} billable hr · ${fmtH(tot.nonBillable)} non-billable hr.${runningNote}`;
  $('exportPreview').replaceChildren(lines.length
    ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Client'), h('th', {}, 'Matter'), h('th', {}, 'Description'), h('th', { class: 'num' }, 'Hours'))),
      h('tbody', {}, lines.map((l) => h('tr', { class: l.billable ? '' : 'archived' },
        h('td', {}, l.date), h('td', {}, l.matter ? l.matter.client : ''), h('td', {}, l.matter ? l.matter.name : '(deleted matter)'),
        h('td', {}, l.description), h('td', { class: 'num' }, fmtH(l.hours))))))
    : h('div', { class: 'empty' }, 'No completed time in this range.'));
}

async function onExport() {
  const from = $('expFrom').value;
  const to = $('expTo').value;
  if (!from || !to || from > to) return toast('Choose a valid date range.', true);
  try {
    const file = await ipc.exportCsv({ from, to, combine: $('expCombine').checked });
    if (file) toast(`Saved ${file}`);
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

// --- Settings tab -----------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fillSettings() {
  const s = state.settings;
  const f = $('settingsForm').elements;
  f.idleMinutes.value = s.idleMinutes;
  f.nudgeEnabled.checked = s.nudgeEnabled;
  f.nudgeMinutes.value = s.nudgeMinutes;
  f.reviewEnabled.checked = s.reviewEnabled;
  f.workStart.value = s.workStart;
  f.workEnd.value = s.workEnd;
  f.increment.value = String(s.increment);
  f.combineOnExport.checked = s.combineOnExport;
  f.hotkey.value = s.hotkey;
  $('workDays').replaceChildren(...DAY_NAMES.map((name, i) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'workDay', value: String(i), checked: s.workDays.includes(i) }), name)));
  $('dataDir').textContent = info.dataDir || '';
  $('hotkeyStatus').textContent = s.hotkey && !info.hotkeyOk
    ? `“${s.hotkey}” could not be registered. Another app may be using it, so try a different combination.`
    : 'Use names like Alt+Shift+T, CommandOrControl+Shift+K, or F19.';
}

async function onSaveSettings(e) {
  e.preventDefault();
  const f = e.target.elements;
  const res = await act('updateSettings', {
    idleMinutes: f.idleMinutes.value,
    nudgeEnabled: f.nudgeEnabled.checked,
    nudgeMinutes: f.nudgeMinutes.value,
    reviewEnabled: f.reviewEnabled.checked,
    workStart: f.workStart.value,
    workEnd: f.workEnd.value,
    workDays: [...e.target.querySelectorAll('input[name="workDay"]:checked')].map((x) => Number(x.value)),
    increment: f.increment.value,
    combineOnExport: f.combineOnExport.checked,
    hotkey: f.hotkey.value,
  });
  if (res === FAILED) return;
  info = await ipc.info();
  renderHotkeyHint();
  fillSettings();
  toast('Settings saved');
}

function renderHotkeyHint() {
  const hk = state.settings.hotkey;
  fill($('hotkeyHint'), hk && info.hotkeyOk ? [h('kbd', {}, hk), ' opens this from any app'] : 'Set a global hotkey in Settings');
}

// --- Away modal ---------------------------------------------------------------------

let awayKey = null;

function renderAway() {
  const a = state.pendingAway;
  const el = $('awayModal');
  if (!a) {
    el.hidden = true;
    el.replaceChildren();
    awayKey = null;
    return;
  }
  const key = `${a.entryId}:${a.start}:${a.end}`;
  if (key === awayKey) return;
  awayKey = key;
  const entry = state.entries.find((e) => e.id === a.entryId);
  const matterName = entry ? label(entry.matterId) : 'your matter';
  const choose = (action) => act('resolveAway', { action });
  const sel = matterSelect('');
  const desc = h('input', { type: 'text', placeholder: 'Description (optional)' });
  el.replaceChildren(h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' },
    h('h2', {}, 'Welcome back'),
    h('p', {}, `You were away from ${clockWithDay(a.start)} to ${clockWithDay(a.end)} (${T.formatMinutes(a.end - a.start)}) while timing `,
      h('strong', {}, matterName), '.'),
    h('p', { class: 'muted' }, 'How should that time be recorded?'),
    h('div', { class: 'modal-actions' },
      h('button', { onclick: () => choose('discard') }, 'Remove the away time and keep timing'),
      h('button', { class: 'secondary', onclick: () => choose('discardStop') }, `Remove the away time and stop the timer at ${clock(a.start)}`),
      h('button', { class: 'secondary', onclick: () => choose('keep') }, 'Keep it. I was still working on this (call, meeting, reading)')),
    h('form', {
      class: 'assign',
      onsubmit: (e) => { e.preventDefault(); act('resolveAway', { action: 'assign', matterId: sel.value, description: desc.value }); },
    }, h('span', {}, 'Or log the away time to:'), sel, desc, h('button', { type: 'submit' }, 'Log it'))));
  el.hidden = false;
}

// --- Wiring -------------------------------------------------------------------------

function switchTab(tab) {
  view.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${tab}`;
  if (tab === 'settings') fillSettings();
  renderTab(true);
}

function renderTab(force = false) {
  if (view.tab === 'day') renderDay(force);
  if (view.tab === 'matters') renderMatters(force);
  if (view.tab === 'export') renderExport();
}

function renderAll() {
  renderNow();
  renderMatterList();
  renderAway();
  renderHotkeyHint();
  renderTab();
}

function changeDay(delta) {
  view.day = delta === 0 ? T.dateKey(Date.now()) : T.addDays(view.day, delta);
  view.dayForm = null;
  renderDay(true);
}

async function init() {
  [state, info] = await Promise.all([ipc.getState(), ipc.info()]);
  ipc.onState((s) => { state = s; renderAll(); });
  ipc.onFocusSearch(() => { $('search').focus(); $('search').select(); });
  ipc.onShowDay(() => { view.day = T.dateKey(Date.now()); switchTab('day'); });

  $('search').addEventListener('input', () => { view.sel = 0; renderMatterList(); });
  $('search').addEventListener('keydown', onSearchKey);
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => switchTab(b.dataset.tab));
  $('prevDay').addEventListener('click', () => changeDay(-1));
  $('nextDay').addEventListener('click', () => changeDay(1));
  $('todayBtn').addEventListener('click', () => changeDay(0));
  $('addManual').addEventListener('click', () => openDayForm({ mode: 'new' }));
  $('matterForm').addEventListener('submit', onAddMatter);
  $('matterFilter').addEventListener('input', () => renderMatters(true));
  $('showArchived').addEventListener('change', () => renderMatters(true));
  for (const b of document.querySelectorAll('[data-range]')) b.addEventListener('click', () => setRange(b.dataset.range));
  $('expFrom').addEventListener('change', renderExport);
  $('expTo').addEventListener('change', renderExport);
  $('expCombine').addEventListener('change', renderExport);
  $('expSave').addEventListener('click', onExport);
  $('settingsForm').addEventListener('submit', onSaveSettings);
  $('openData').addEventListener('click', () => ipc.openDataFolder());

  $('expCombine').checked = state.settings.combineOnExport;
  setRange('week');
  renderAll();
  renderNow(true);
  renderDay(true);

  setInterval(updateElapsed, 1000);
  setInterval(() => {
    // Roll the day view over at midnight if it was showing "today".
    const today = T.dateKey(Date.now());
    if (renderAll.lastToday && renderAll.lastToday !== today && view.day === renderAll.lastToday) view.day = today;
    renderAll.lastToday = today;
    renderNow();
    if (view.tab === 'day') renderDay();
  }, 30 * 1000);
}

init();
