// Day views, untracked-gap detection, billing lines and CSV export.
// Pure functions; no browser or Node APIs.
import * as T from './time.js';

const entryEnd = (e, now) => (e.end == null ? now : e.end);

// Entries that start within [from, to), oldest first.
export function entriesBetween(entries, from, to) {
  return entries.filter((e) => e.start >= from && e.start < to).sort((a, b) => a.start - b.start);
}

// Remove every `cut` interval from every `interval`.
export function subtract(intervals, cuts) {
  let pieces = intervals.map((i) => ({ start: i.start, end: i.end }));
  for (const c of cuts) {
    const next = [];
    for (const p of pieces) {
      if (c.end <= p.start || c.start >= p.end) {
        next.push(p);
        continue;
      }
      if (c.start > p.start) next.push({ start: p.start, end: c.start });
      if (c.end < p.end) next.push({ start: c.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

// Stretches where the computer was in use but no timer covered it.
export function findGaps(activity, entries, from, to, now, minGapMs = 5 * T.MINUTE) {
  const active = activity
    .map((a) => ({ start: Math.max(a.start, from), end: Math.min(a.end, to) }))
    .filter((a) => a.end > a.start);
  const cuts = entries.map((e) => ({ start: e.start, end: entryEnd(e, now) }));
  return subtract(active, cuts)
    .filter((g) => g.end - g.start >= minGapMs)
    .sort((a, b) => a.start - b.start);
}

export function matterLabel(m) {
  if (!m) return '(deleted matter)';
  return m.client ? `${m.client} — ${m.name}` : m.name;
}

// One line per entry, or (combine) one line per matter per day with the
// raw time summed *before* rounding, so interruptions don't inflate a bill.
export function billingLines(state, entries, { combine = true, now = Date.now() } = {}) {
  const increment = state.settings.increment;
  const matters = new Map(state.matters.map((m) => [m.id, m]));
  const lines = [];
  const byKey = new Map();
  for (const e of [...entries].sort((a, b) => a.start - b.start)) {
    const ms = entryEnd(e, now) - e.start;
    const key = combine ? `${T.dateKey(e.start)}|${e.matterId}` : e.id;
    let line = byKey.get(key);
    if (!line) {
      line = {
        date: T.dateKey(e.start), matterId: e.matterId, matter: matters.get(e.matterId) || null,
        start: e.start, end: entryEnd(e, now), ms: 0, descriptions: [], entryIds: [],
      };
      byKey.set(key, line);
      lines.push(line);
    }
    line.ms += ms;
    line.end = Math.max(line.end, entryEnd(e, now));
    line.entryIds.push(e.id);
    const d = (e.description || '').trim();
    if (d && !line.descriptions.includes(d)) line.descriptions.push(d);
  }
  for (const line of lines) {
    line.hours = T.billableHours(line.ms, increment);
    line.billable = line.matter ? !!line.matter.billable : false;
    line.description = line.descriptions.join('; ');
  }
  return lines;
}

export function totals(lines) {
  let billable = 0, nonBillable = 0;
  for (const l of lines) {
    if (l.billable) billable += l.hours;
    else nonBillable += l.hours;
  }
  return { billable: Number(billable.toFixed(4)), nonBillable: Number(nonBillable.toFixed(4)) };
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV of completed entries between two day keys (inclusive).
export function toCsv(state, fromKey, toKey, { combine = true } = {}) {
  const entries = entriesBetween(state.entries, T.dayStart(fromKey), T.dayEnd(toKey))
    .filter((e) => e.end != null);
  const lines = billingLines(state, entries, { combine });
  const inc = state.settings.increment;
  const header = combine
    ? ['Date', 'Client', 'Matter', 'Matter Number', 'Billable', 'Hours', 'Minutes', 'Description']
    : ['Date', 'Start', 'End', 'Client', 'Matter', 'Matter Number', 'Billable', 'Hours', 'Minutes', 'Description'];
  const rows = [header];
  for (const l of lines) {
    const m = l.matter || {};
    const common = [m.client || '', m.name || '(deleted matter)', m.number || '', l.billable ? 'Yes' : 'No',
      T.formatHours(l.hours, inc), Math.round(l.ms / T.MINUTE), l.description];
    rows.push(combine
      ? [l.date, ...common]
      : [l.date, T.timeInputValue(l.start), T.timeInputValue(l.end), ...common]);
  }
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}


// Completed time between two day keys, shaped for the iTimeKeep helper.
// Lines whose matter has no matter number can't be entered automatically and
// are returned separately so the user can fix them.
export function itkExport(state, fromKey, toKey, { combine = true } = {}) {
  const entries = entriesBetween(state.entries, T.dayStart(fromKey), T.dayEnd(toKey)).filter((e) => e.end != null);
  const lines = billingLines(state, entries, { combine });
  const inc = state.settings.increment;
  const out = [];
  const missing = new Set();
  for (const l of lines) {
    const m = l.matter;
    if (!m || !m.number) {
      missing.add(matterLabel(m));
      continue;
    }
    out.push({
      date: l.date,
      client: m.client,
      matter: m.name,
      matterNumber: m.number,
      hours: T.formatHours(l.hours, inc),
      narrative: l.description,
      billable: l.billable,
    });
  }
  return { payload: { format: 'time-logger-itk', version: 1, entries: out }, missing: [...missing] };
}
