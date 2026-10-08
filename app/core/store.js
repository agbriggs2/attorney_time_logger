// The app state and every operation that changes it. Pure functions over a
// plain object so they are easy to test; the app persists the result.
import * as T from './time.js';
import { matterLabel } from './report.js';

export const MIN_ENTRY_MS = T.MINUTE; // stopped entries shorter than this (with no description) are dropped
const MAX_INTERRUPTS = 5;

export const DEFAULT_SETTINGS = {
  increment: 0.1,
  idleMinutes: 5,
  nudgeEnabled: true,
  nudgeMinutes: 15,
  reviewEnabled: true,
  workStart: '08:30',
  workEnd: '18:00',
  workDays: [1, 2, 3, 4, 5],
  combineOnExport: true,
};

const DEFAULT_NON_CLIENT = ['Administrative', 'Business Development', 'CLE & Training', 'Pro Bono'];

const newId = () => globalThis.crypto.randomUUID();

export function createState() {
  return {
    version: 1,
    matters: DEFAULT_NON_CLIENT.map((name) => ({
      id: newId(), client: 'Non-client', name, number: '', billable: false, archived: false, lastUsed: 0,
    })),
    entries: [],
    interruptStack: [],
    activity: [],
    pendingAway: null,
    awayStart: null,
    lastTick: null,
    lastNudge: 0,
    lastReviewPrompt: null,
    settings: { ...DEFAULT_SETTINGS },
  };
}

// Fill in anything missing from a state loaded off disk.
export function normalizeState(raw) {
  const fresh = createState();
  if (!raw || typeof raw !== 'object') return fresh;
  return {
    ...fresh,
    ...raw,
    matters: Array.isArray(raw.matters) ? raw.matters : fresh.matters,
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    interruptStack: Array.isArray(raw.interruptStack) ? raw.interruptStack : [],
    activity: Array.isArray(raw.activity) ? raw.activity : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
  };
}

export const running = (state) => state.entries.find((e) => e.end == null) || null;
export const getMatter = (state, id) => state.matters.find((m) => m.id === id) || null;

function requireMatter(state, id) {
  const m = getMatter(state, id);
  if (!m) throw new Error('That matter no longer exists.');
  return m;
}

function requireEntry(state, id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) throw new Error('That entry no longer exists.');
  return e;
}

function removeEntry(state, id) {
  state.entries = state.entries.filter((e) => e.id !== id);
}

function findOverlap(state, start, end, exceptId, now) {
  const stop = end == null ? now : end;
  return state.entries.find((e) => e.id !== exceptId && start < (e.end == null ? now : e.end) && e.start < stop) || null;
}

function validateTimes(state, entry, now) {
  if (!Number.isFinite(entry.start)) throw new Error('Enter a valid start time.');
  if (entry.start > now) throw new Error('Start time is in the future.');
  if (entry.end != null) {
    if (!Number.isFinite(entry.end)) throw new Error('Enter a valid end time.');
    if (entry.end <= entry.start) throw new Error('End time must be after the start time.');
    if (entry.end > now) throw new Error('End time is in the future.');
  }
  const clash = findOverlap(state, entry.start, entry.end, entry.id, now);
  if (clash) {
    const end = clash.end == null ? 'now' : T.formatClock(clash.end);
    throw new Error(`Overlaps another entry: ${matterLabel(getMatter(state, clash.matterId))}, ${T.formatClock(clash.start)}–${end}.`);
  }
}

// Close an entry; throw away accidental blips (e.g. a mis-click while switching).
function finish(state, entry, end) {
  entry.end = Math.max(end, entry.start);
  if (entry.end - entry.start < MIN_ENTRY_MS && !entry.description) removeEntry(state, entry.id);
}

// --- Matters -----------------------------------------------------------------

function cleanMatterFields(p) {
  const out = {};
  if ('client' in p) out.client = String(p.client || '').trim();
  if ('name' in p) out.name = String(p.name || '').trim();
  if ('number' in p) out.number = String(p.number || '').trim();
  if ('billable' in p) out.billable = !!p.billable;
  if ('archived' in p) out.archived = !!p.archived;
  return out;
}

export function addMatter(state, fields) {
  const m = { id: newId(), client: '', name: '', number: '', billable: true, archived: false, lastUsed: 0, ...cleanMatterFields(fields) };
  if (!m.name) throw new Error('Give the matter a name.');
  state.matters.push(m);
  return m;
}

export function updateMatter(state, id, patch) {
  const m = requireMatter(state, id);
  const next = { ...m, ...cleanMatterFields(patch) };
  if (!next.name) throw new Error('Give the matter a name.');
  Object.assign(m, next);
  return m;
}

// --- Timer -------------------------------------------------------------------

// Start timing a matter. Any running timer stops. With `interrupt`, the
// running matter is remembered so "Back to it" can resume it afterwards.
export function startTimer(state, matterId, now, { interrupt = false, description = '', start } = {}) {
  const m = requireMatter(state, matterId);
  const r = running(state);
  if (r && r.matterId === matterId) return r;
  if (r) {
    if (interrupt) {
      state.interruptStack.push({ matterId: r.matterId, description: r.description || '' });
      if (state.interruptStack.length > MAX_INTERRUPTS) state.interruptStack.shift();
    }
    finish(state, r, now);
  }
  const entry = { id: newId(), matterId, start: r || start == null ? now : start, end: null, description };
  validateTimes(state, entry, now);
  state.entries.push(entry);
  m.lastUsed = now;
  return entry;
}

export function stopTimer(state, now) {
  const r = running(state);
  if (r) finish(state, r, now);
  return r;
}

export function resumePrevious(state, now) {
  while (state.interruptStack.length) {
    const prev = state.interruptStack.pop();
    if (getMatter(state, prev.matterId)) return startTimer(state, prev.matterId, now, { description: prev.description });
  }
  return null;
}

export function dismissResume(state) {
  state.interruptStack.pop();
}

export function setRunningStart(state, start, now) {
  const r = running(state);
  if (!r) throw new Error('No timer is running.');
  return updateEntry(state, r.id, { start }, now);
}

// --- Entries -----------------------------------------------------------------

export function addEntry(state, { matterId, start, end, description = '' }, now) {
  requireMatter(state, matterId);
  const entry = { id: newId(), matterId, start: Number(start), end: Number(end), description: String(description || '').trim() };
  if (!Number.isFinite(entry.end)) throw new Error('Enter a valid end time.');
  validateTimes(state, entry, now);
  state.entries.push(entry);
  return entry;
}

export function updateEntry(state, id, patch, now) {
  const e = requireEntry(state, id);
  const next = { ...e };
  if ('matterId' in patch) next.matterId = requireMatter(state, patch.matterId).id;
  if ('description' in patch) next.description = String(patch.description || '').trim();
  if ('start' in patch) next.start = Number(patch.start);
  if ('end' in patch && e.end != null) next.end = Number(patch.end);
  validateTimes(state, next, now);
  Object.assign(e, next);
  return e;
}

export function deleteEntry(state, id) {
  requireEntry(state, id);
  removeEntry(state, id);
}

// --- Coming back from being away ----------------------------------------------

// pendingAway = { entryId, start, end } is set when the user returns after
// being idle/locked/asleep while a timer ran. Actions:
//   keep        – count the away time
//   discard     – cut the away time out, keep timing
//   discardStop – stop the timer as of when they left
//   assign      – log the away time to another matter, keep timing
export function resolveAway(state, action, now, { matterId, description = '' } = {}) {
  const away = state.pendingAway;
  if (!away) return null;
  if (!['keep', 'discard', 'discardStop', 'assign'].includes(action)) throw new Error('Unknown choice.');
  if (action === 'assign') requireMatter(state, matterId);
  state.pendingAway = null;

  const r = running(state);
  if (!r || r.id !== away.entryId || action === 'keep') return null;

  const awayStart = Math.max(away.start, r.start);
  const awayEnd = Math.min(away.end, now);
  const original = { matterId: r.matterId, description: r.description };
  r.end = awayStart;
  if (r.end - r.start < MIN_ENTRY_MS && !r.description) removeEntry(state, r.id);

  if (action === 'assign' && awayEnd > awayStart) {
    state.entries.push({ id: newId(), matterId, start: awayStart, end: awayEnd, description: String(description).trim() });
  }
  if (action !== 'discardStop') {
    state.entries.push({ id: newId(), matterId: original.matterId, start: awayEnd, end: null, description: original.description });
  }
  return null;
}

// --- Settings ----------------------------------------------------------------

export function updateSettings(state, patch) {
  const s = { ...state.settings };
  const int = (v, lo, hi, label) => {
    const n = Math.round(Number(v));
    if (!(n >= lo && n <= hi)) throw new Error(`${label} must be between ${lo} and ${hi}.`);
    return n;
  };
  const clock = (v, label) => {
    if (!/^\d{2}:\d{2}$/.test(v)) throw new Error(`${label} must be a time like 09:00.`);
    return v;
  };
  if ('idleMinutes' in patch) s.idleMinutes = int(patch.idleMinutes, 1, 120, 'Away threshold');
  if ('nudgeMinutes' in patch) s.nudgeMinutes = int(patch.nudgeMinutes, 5, 240, 'Reminder interval');
  if ('nudgeEnabled' in patch) s.nudgeEnabled = !!patch.nudgeEnabled;
  if ('reviewEnabled' in patch) s.reviewEnabled = !!patch.reviewEnabled;
  if ('combineOnExport' in patch) s.combineOnExport = !!patch.combineOnExport;
  if ('increment' in patch) {
    const inc = Number(patch.increment);
    if (![0.1, 0.25].includes(inc)) throw new Error('Billing increment must be 0.1 or 0.25.');
    s.increment = inc;
  }
  if ('workStart' in patch) s.workStart = clock(patch.workStart, 'Workday start');
  if ('workEnd' in patch) s.workEnd = clock(patch.workEnd, 'Workday end');
  if (T.minutesOfDay(s.workEnd) <= T.minutesOfDay(s.workStart)) throw new Error('Workday must end after it starts.');
  if ('workDays' in patch) {
    if (!Array.isArray(patch.workDays)) throw new Error('Pick your workdays.');
    s.workDays = [...new Set(patch.workDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  }
  state.settings = s;
  return s;
}

