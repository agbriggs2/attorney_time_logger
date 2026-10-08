import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../app/core/time.js';
import * as R from '../app/core/report.js';
import * as S from '../app/core/store.js';
import { processTick } from '../app/core/activity.js';

const MIN = T.MINUTE;
const at = (hhmm, key = '2026-10-07') => T.parseClockOnDay(key, hhmm); // a Wednesday

function setup() {
  const state = S.createState();
  const a = S.addMatter(state, { client: 'Acme Corp', name: 'Supply dispute', number: '1001' });
  const b = S.addMatter(state, { client: 'Baker', name: 'Estate plan', number: '1002' });
  const admin = state.matters.find((m) => m.name === 'Administrative');
  return { state, a, b, admin };
}

test('billableHours rounds up to the increment', () => {
  assert.equal(T.billableHours(0), 0);
  assert.equal(T.billableHours(1), 0.1);
  assert.equal(T.billableHours(6 * MIN), 0.1);
  assert.equal(T.billableHours(6 * MIN + 1000), 0.2);
  assert.equal(T.billableHours(18 * MIN), 0.3);
  assert.equal(T.billableHours(61 * MIN), 1.1);
  assert.equal(T.billableHours(16 * MIN, 0.25), 0.5);
});

test('starting a matter stops the running one', () => {
  const { state, a, b } = setup();
  S.startTimer(state, a.id, at('09:00'));
  S.startTimer(state, b.id, at('09:30'));
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0].end, at('09:30'));
  assert.equal(S.running(state).matterId, b.id);
});

test('accidental sub-minute entries are discarded on switch', () => {
  const { state, a, b } = setup();
  S.startTimer(state, a.id, at('09:00'));
  S.startTimer(state, b.id, at('09:00') + 20 * 1000);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].matterId, b.id);
});

test('interrupt then resume returns to the original matter and description', () => {
  const { state, a, b } = setup();
  const first = S.startTimer(state, a.id, at('09:00'));
  S.updateEntry(state, first.id, { description: 'Draft answer' }, at('09:05'));
  S.startTimer(state, b.id, at('09:40'), { interrupt: true });
  assert.equal(state.interruptStack.length, 1);
  const resumed = S.resumePrevious(state, at('09:52'));
  assert.equal(resumed.matterId, a.id);
  assert.equal(resumed.description, 'Draft answer');
  assert.equal(state.interruptStack.length, 0);
  assert.equal(state.entries.length, 3);
});

test('backdating a running timer cannot overlap earlier entries', () => {
  const { state, a, b } = setup();
  S.addEntry(state, { matterId: a.id, start: at('09:00'), end: at('10:00') }, at('11:00'));
  S.startTimer(state, b.id, at('10:30'));
  assert.throws(() => S.setRunningStart(state, at('09:50'), at('10:31')), /Overlaps/);
  S.setRunningStart(state, at('10:00'), at('10:31'));
  assert.equal(S.running(state).start, at('10:00'));
});

test('manual entries are validated', () => {
  const { state, a } = setup();
  assert.throws(() => S.addEntry(state, { matterId: a.id, start: at('10:00'), end: at('09:00') }, at('12:00')), /after the start/);
  assert.throws(() => S.addEntry(state, { matterId: a.id, start: at('10:00'), end: at('13:00') }, at('12:00')), /future/);
});

test('away time: discard, assign, discardStop', () => {
  for (const action of ['discard', 'assign', 'discardStop']) {
    const { state, a, admin } = setup();
    const r = S.startTimer(state, a.id, at('09:00'));
    state.pendingAway = { entryId: r.id, start: at('10:00'), end: at('10:30') };
    S.resolveAway(state, action, at('10:31'), { matterId: admin.id });
    const sorted = [...state.entries].sort((x, y) => x.start - y.start);
    assert.equal(sorted[0].end, at('10:00'), action);
    if (action === 'discard') {
      assert.equal(sorted.length, 2);
      assert.deepEqual([sorted[1].start, sorted[1].end, sorted[1].matterId], [at('10:30'), null, a.id]);
    } else if (action === 'assign') {
      assert.equal(sorted.length, 3);
      assert.deepEqual([sorted[1].matterId, sorted[1].start, sorted[1].end], [admin.id, at('10:00'), at('10:30')]);
      assert.equal(sorted[2].end, null);
    } else {
      assert.equal(sorted.length, 1);
      assert.equal(S.running(state), null);
    }
    assert.equal(state.pendingAway, null);
  }
});

test('processTick: idle while timing creates a pending away prompt', () => {
  const { state, a } = setup();
  S.startTimer(state, a.id, at('09:00'));
  // active until 09:10, then idle; the OS idle counter grows with each tick
  let t = at('09:00');
  for (; t <= at('09:10'); t += 15000) processTick(state, { idleSeconds: 0 }, t);
  for (; t < at('09:45'); t += 15000) processTick(state, { idleSeconds: (t - at('09:10')) / 1000 }, t);
  assert.equal(state.awayStart, at('09:10'));
  const ev = processTick(state, { idleSeconds: 2 }, at('09:45'));
  assert.equal(ev.away, true);
  assert.equal(state.pendingAway.start, at('09:10'));
  assert.equal(state.pendingAway.end, at('09:45') - 2000);
});

test('processTick: a long gap between ticks (sleep / app closed) counts as away', () => {
  const { state, a } = setup();
  S.startTimer(state, a.id, at('09:00'));
  processTick(state, { idleSeconds: 0 }, at('11:00'));
  const ev = processTick(state, { idleSeconds: 5 }, at('13:00'));
  assert.equal(ev.away, true);
  assert.equal(state.pendingAway.start, at('11:00'));
});

test('processTick nudges when active with no timer during work hours', () => {
  const { state } = setup();
  let ev;
  for (let t = at('09:00'); t <= at('09:05'); t += 15000) ev = processTick(state, { idleSeconds: 0 }, t);
  assert.ok(state.lastNudge > 0);
  ev = processTick(state, { idleSeconds: 0 }, at('09:06'));
  assert.equal(ev.nudge, false, 'does not nudge again until the interval passes');
});

test('processTick prompts a review once after the workday ends', () => {
  const { state } = setup();
  processTick(state, { idleSeconds: 0 }, at('17:59'));
  processTick(state, { idleSeconds: 0 }, at('17:59') + 15000);
  const ev = processTick(state, { idleSeconds: 0 }, at('18:00') + 1000);
  assert.ok(ev.review);
  assert.equal(processTick(state, { idleSeconds: 0 }, at('18:01')).review, null);
});

test('findGaps returns active time not covered by entries', () => {
  const { state, a } = setup();
  state.activity = [{ start: at('09:00'), end: at('12:00') }];
  S.addEntry(state, { matterId: a.id, start: at('09:30'), end: at('11:00') }, at('12:00'));
  const gaps = R.findGaps(state.activity, state.entries, T.dayStart('2026-10-07'), at('12:00'), at('12:00'));
  assert.deepEqual(gaps, [{ start: at('09:00'), end: at('09:30') }, { start: at('11:00'), end: at('12:00') }]);
});

test('combined billing lines sum fragments before rounding', () => {
  const { state, a } = setup();
  // three 4-minute fragments: 0.3 if rounded separately, 0.2 combined (12 min)
  S.addEntry(state, { matterId: a.id, start: at('09:00'), end: at('09:04'), description: 'Call' }, at('12:00'));
  S.addEntry(state, { matterId: a.id, start: at('10:00'), end: at('10:04'), description: 'Email' }, at('12:00'));
  S.addEntry(state, { matterId: a.id, start: at('11:00'), end: at('11:04'), description: 'Call' }, at('12:00'));
  const combined = R.billingLines(state, state.entries, { combine: true });
  assert.equal(combined.length, 1);
  assert.equal(combined[0].hours, 0.2);
  assert.equal(combined[0].description, 'Call; Email');
  const separate = R.billingLines(state, state.entries, { combine: false });
  assert.equal(R.totals(separate).billable, 0.3);
});

test('CSV export escapes fields and skips running timers', () => {
  const { state, a, b } = setup();
  S.addEntry(state, { matterId: a.id, start: at('09:00'), end: at('09:30'), description: 'Review "draft", revise' }, at('12:00'));
  S.startTimer(state, b.id, at('11:00'));
  const csv = R.toCsv(state, '2026-10-07', '2026-10-07', { combine: true });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Date,Client,Matter,Matter Number,Billable,Hours,Minutes,Description');
  assert.equal(lines[1], '2026-10-07,Acme Corp,Supply dispute,1001,Yes,0.5,30,"Review ""draft"", revise"');
});

test('settings are validated', () => {
  const { state } = setup();
  assert.throws(() => S.updateSettings(state, { increment: 0.5 }), /increment/);
  assert.throws(() => S.updateSettings(state, { workStart: '19:00' }), /end after/);
  S.updateSettings(state, { idleMinutes: '10', workDays: [1, 2, 3] });
  assert.equal(state.settings.idleMinutes, 10);
  assert.deepEqual(state.settings.workDays, [1, 2, 3]);
});
