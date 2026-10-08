// Owns the app state: runs actions, saves, and once every 15 seconds checks for
// idle time, away periods, and reminders. The UI subscribes to changes.
import * as S from '../core/store.js';
import * as T from '../core/time.js';
import { processTick } from '../core/activity.js';
import * as storage from './storage.js';

const TICK_MS = 15 * 1000;
// Edge slows background tabs to about one timer per minute, so continuity
// checks assume a 1-minute heartbeat.
const HEARTBEAT_MS = 60 * 1000;

export const engine = {
  state: null,
  listeners: new Set(),
  lastSaved: 0,
  timer: null,
  idle: {
    supported: typeof window !== 'undefined' && 'IdleDetector' in window,
    permission: 'unknown', // unknown | granted | denied
    running: false,
    userState: 'active',
    screenState: 'unlocked',
    idleSince: null,
    abort: null,
  },
};

export function subscribe(fn) {
  engine.listeners.add(fn);
  return () => engine.listeners.delete(fn);
}

function emit(events = {}) {
  for (const fn of engine.listeners) fn(events);
}

// --- Actions -------------------------------------------------------------------

const actions = {
  start: (p, now) => S.startTimer(engine.state, p.matterId, now, { interrupt: !!p.interrupt }),
  stop: (p, now) => S.stopTimer(engine.state, now),
  resume: (p, now) => S.resumePrevious(engine.state, now),
  dismissResume: () => S.dismissResume(engine.state),
  setRunningStart: (p, now) => S.setRunningStart(engine.state, p.start, now),
  addEntry: (p, now) => S.addEntry(engine.state, p, now),
  updateEntry: (p, now) => S.updateEntry(engine.state, p.id, p.patch || {}, now),
  deleteEntry: (p) => S.deleteEntry(engine.state, p.id),
  addMatter: (p) => S.addMatter(engine.state, p),
  updateMatter: (p) => S.updateMatter(engine.state, p.id, p.patch || {}),
  resolveAway: (p, now) => S.resolveAway(engine.state, p.action, now, p),
  updateSettings: (p) => {
    const before = engine.state.settings.idleMinutes;
    const s = S.updateSettings(engine.state, p);
    if (s.idleMinutes !== before && engine.idle.running) startIdleDetection();
    return s;
  },
  replaceState: (p) => {
    engine.state = S.normalizeState(p.state);
    engine.state.lastTick = Date.now();
    engine.state.awayStart = null;
    return null;
  },
};

// Throws on invalid input; the UI shows the message.
export function dispatch(type, payload) {
  const fn = actions[type];
  if (!fn) throw new Error(`Unknown action: ${type}`);
  const result = fn(payload || {}, Date.now());
  commit();
  return result;
}

function commit(events) {
  storage.saveState(engine.state);
  engine.lastSaved = Date.now();
  emit(events);
}

// --- Idle detection ------------------------------------------------------------

// Uses Edge's Idle Detection API, which reports keyboard/mouse inactivity and
// screen lock across the whole PC (with the user's permission).
export async function requestIdlePermission() {
  if (!engine.idle.supported) return 'unsupported';
  const result = await window.IdleDetector.requestPermission();
  engine.idle.permission = result;
  if (result === 'granted') await startIdleDetection();
  emit();
  return result;
}

async function checkIdlePermission() {
  if (!engine.idle.supported || !navigator.permissions) return;
  try {
    const status = await navigator.permissions.query({ name: 'idle-detection' });
    engine.idle.permission = status.state === 'prompt' ? 'unknown' : status.state;
    status.onchange = () => {
      engine.idle.permission = status.state === 'prompt' ? 'unknown' : status.state;
      if (status.state === 'granted') startIdleDetection();
      emit();
    };
  } catch { /* permission name unsupported */ }
}

async function startIdleDetection() {
  const idle = engine.idle;
  if (idle.abort) idle.abort.abort();
  idle.abort = new AbortController();
  const threshold = Math.max(60, engine.state.settings.idleMinutes * 60) * 1000;
  const detector = new window.IdleDetector();
  detector.addEventListener('change', () => {
    const wasIdle = idle.userState === 'idle';
    idle.userState = detector.userState;
    idle.screenState = detector.screenState;
    if (detector.userState === 'idle' && !wasIdle) idle.idleSince = Date.now() - threshold;
    if (detector.userState === 'active') idle.idleSince = null;
    tick();
  });
  try {
    await detector.start({ threshold, signal: idle.abort.signal });
    idle.running = true;
  } catch {
    idle.running = false;
  }
}

function idleSample(now) {
  const idle = engine.idle;
  if (!idle.running) return { idleSeconds: 0, idleState: 'active' };
  const idleSeconds = idle.userState === 'idle' && idle.idleSince ? (now - idle.idleSince) / 1000 : 0;
  const idleState = idle.screenState === 'locked' ? 'locked' : idle.userState === 'idle' ? 'idle' : 'active';
  return { idleSeconds, idleState };
}

// --- Notifications ---------------------------------------------------------------

export const notifications = {
  get supported() { return typeof Notification !== 'undefined'; },
  get permission() { return this.supported ? Notification.permission : 'unsupported'; },
};

export async function requestNotificationPermission() {
  if (!notifications.supported) return 'unsupported';
  const result = await Notification.requestPermission();
  emit();
  return result;
}

export function notify(title, body, { onClick, tag, sticky = false } = {}) {
  if (notifications.permission !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag, requireInteraction: sticky, icon: 'icons/icon-192.png' });
    n.onclick = () => {
      window.focus();
      n.close();
      if (onClick) onClick();
    };
    return true;
  } catch {
    return false;
  }
}

// --- Heartbeat -------------------------------------------------------------------

export function tick() {
  if (!engine.state || !engine.timer) return;
  const now = Date.now();
  const ev = processTick(engine.state, { ...idleSample(now), intervalMs: HEARTBEAT_MS }, now);
  if (ev.away || ev.nudge || ev.review || now - engine.lastSaved > 60 * 1000) commit(ev);
  else emit(ev);

  if (ev.away) {
    notify('Welcome back', 'A timer was running while you were away. Choose how to record that time.', { tag: 'away', sticky: true });
  }
  if (ev.nudge) {
    notify('No timer running', "You're working, but no time is being tracked. Click to pick a matter.", {
      tag: 'nudge', onClick: () => emit({ focusSearch: true }),
    });
  }
  if (ev.review) {
    const untracked = ev.review.untrackedMs >= 5 * T.MINUTE ? `${T.formatMinutes(ev.review.untrackedMs)} of today is untracked. ` : '';
    const running = ev.review.timerRunning ? 'A timer is still running. ' : '';
    notify('Review your day', `${untracked}${running}Click to review today's time.`, {
      tag: 'review', sticky: true, onClick: () => emit({ showDay: true }),
    });
  }
}

// --- Startup and single-window ownership --------------------------------------------

// Only one tab or window may run the timer at a time; otherwise two copies
// would overwrite each other's changes. A Web Lock decides which one.
const LOCK = 'time-logger-owner';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('time-logger') : null;

export function start({ onBlocked, onReleased }) {
  if (!navigator.locks) return boot();
  return new Promise((resolve) => {
    navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
      if (!lock) {
        onBlocked();
        resolve(false);
        return undefined;
      }
      return holdLock(resolve, onReleased);
    });
  });
}

// Called from the "use this window instead" button in a blocked window.
export function takeOver({ onReleased }) {
  if (channel) channel.postMessage('takeover');
  return new Promise((resolve) => {
    navigator.locks.request(LOCK, () => holdLock(resolve, onReleased));
  });
}

function holdLock(resolve, onReleased) {
  return new Promise((release) => {
    if (channel) {
      channel.onmessage = async (e) => {
        if (e.data !== 'takeover') return;
        stopTicking();
        await storage.flush();
        onReleased();
        release();
      };
    }
    boot().then(resolve);
  });
}

async function boot() {
  engine.state = await storage.loadState();
  await storage.initBackup();
  await checkIdlePermission();
  if (engine.idle.permission === 'granted') await startIdleDetection();
  storage.requestPersistence();
  engine.timer = setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('pagehide', () => storage.saveState(engine.state));
  tick();
  emit();
  return true;
}

function stopTicking() {
  clearInterval(engine.timer);
  engine.timer = null;
  if (engine.idle.abort) engine.idle.abort.abort();
  document.removeEventListener('visibilitychange', tick);
}
