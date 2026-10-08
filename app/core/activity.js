// Called every few seconds by the app with the latest idle reading.
// Records when the computer is in use, notices when the user was away while a
// timer ran, and decides when to nudge or prompt for an end-of-day review.
import * as T from './time.js';
import { running } from './store.js';
import { findGaps } from './report.js';

const KEEP_ACTIVITY_DAYS = 90;

export function inWorkHours(settings, now) {
  const d = new Date(now);
  if (!settings.workDays.includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= T.minutesOfDay(settings.workStart) && mins < T.minutesOfDay(settings.workEnd);
}

function recordActive(state, from, to, toleranceMs) {
  if (to < from) return;
  const last = state.activity[state.activity.length - 1];
  if (last && from <= last.end + toleranceMs) last.end = Math.max(last.end, to);
  else state.activity.push({ start: from, end: to });
}

function prune(state, now) {
  const cutoff = now - KEEP_ACTIVITY_DAYS * 24 * T.HOUR;
  if (state.activity.length && state.activity[0].end < cutoff) {
    state.activity = state.activity.filter((a) => a.end >= cutoff);
  }
}

// sample: { idleSeconds, idleState: 'active'|'idle'|'locked'|'unknown', intervalMs }
export function processTick(state, sample, now) {
  const { idleSeconds = 0, idleState = 'active', intervalMs = 15000 } = sample;
  const s = state.settings;
  const threshold = s.idleMinutes * T.MINUTE;
  const idleMs = idleSeconds * 1000;
  const events = { away: false, nudge: false, review: null };

  const last = state.lastTick;
  state.lastTick = now;
  // A long silence between ticks means the machine slept or the app was closed.
  const slept = last != null && now - last > Math.max(3 * intervalMs, T.MINUTE);
  if (slept && state.awayStart == null) state.awayStart = last;

  if (idleState === 'locked' || idleMs >= threshold) {
    if (state.awayStart == null) state.awayStart = idleMs >= threshold ? now - idleMs : now;
    return events;
  }

  let activeFrom = last != null && !slept ? last : now;
  if (state.awayStart != null) {
    const awayStart = state.awayStart;
    const awayEnd = Math.max(awayStart, now - idleMs);
    state.awayStart = null;
    activeFrom = awayEnd;
    const r = running(state);
    if (r && !state.pendingAway) {
      const start = Math.max(awayStart, r.start);
      if (awayEnd - start >= threshold) {
        state.pendingAway = { entryId: r.id, start, end: awayEnd };
        events.away = true;
      }
    }
  }
  recordActive(state, activeFrom, now, 2 * intervalMs);
  prune(state, now);

  const today = T.dateKey(now);
  const r = running(state);

  if (!r && s.nudgeEnabled && inWorkHours(s, now)) {
    const lastActive = state.activity[state.activity.length - 1];
    const lastEntryEnd = state.entries.reduce((max, e) => Math.max(max, e.end || 0), 0);
    const untrackedSince = Math.max(lastActive ? lastActive.start : now, lastEntryEnd);
    if (now - untrackedSince >= 3 * T.MINUTE && now - (state.lastNudge || 0) >= s.nudgeMinutes * T.MINUTE) {
      state.lastNudge = now;
      events.nudge = true;
    }
  }

  const pastEndOfDay = new Date(now).getHours() * 60 + new Date(now).getMinutes() >= T.minutesOfDay(s.workEnd);
  if (s.reviewEnabled && pastEndOfDay && s.workDays.includes(new Date(now).getDay()) && state.lastReviewPrompt !== today) {
    state.lastReviewPrompt = today;
    const gaps = findGaps(state.activity, state.entries, T.dayStart(today), now, now);
    const untrackedMs = gaps.reduce((sum, g) => sum + g.end - g.start, 0);
    events.review = { untrackedMs, timerRunning: !!r };
  }

  return events;
}

