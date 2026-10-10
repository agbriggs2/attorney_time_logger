// A small always-on-top timer window (Document Picture-in-Picture), so the
// timer stays visible while working in Word, Outlook, etc.
import * as T from '../core/time.js';
import * as R from '../core/report.js';
import { running } from '../core/store.js';
import { engine } from './engine.js';
import { h, fill } from './dom.js';

export const pip = {
  supported: typeof window !== 'undefined' && 'documentPictureInPicture' in window,
  win: null,
};

let act = null;
let lastKey = '';

// Compact mode shows only the status dot, matter and clock. Remembered
// between sessions (a per-browser convenience, so localStorage is fine).
const SIZES = { full: { width: 380, height: 170 }, compact: { width: 320, height: 64 } };
let compact = false;
try { compact = localStorage.getItem('pipCompact') === '1'; } catch { /* storage unavailable */ }

// Must be called from a click.
export async function openPip(actFn) {
  act = actFn;
  if (pip.win) {
    pip.win.focus();
    return;
  }
  const win = await window.documentPictureInPicture.requestWindow(SIZES[compact ? 'compact' : 'full']);
  const link = win.document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('styles.css', location.href).href;
  win.document.head.append(link);
  win.document.title = 'Timer';
  win.document.body.className = 'pip';
  win.addEventListener('pagehide', () => { pip.win = null; });
  pip.win = win;
  lastKey = '';
  renderPip();
}

function setCompact(value) {
  compact = value;
  try { localStorage.setItem('pipCompact', value ? '1' : '0'); } catch { /* ignore */ }
  lastKey = '';
  renderPip();
  // Shrink or grow the window to fit (Edge allows this after a click).
  const win = pip.win;
  if (!win) return;
  try {
    const chrome = Math.max(0, win.outerHeight - win.innerHeight);
    const size = SIZES[value ? 'compact' : 'full'];
    const contentHeight = value ? win.document.body.scrollHeight : size.height;
    win.resizeTo(size.width, contentHeight + chrome);
  } catch { /* resizing not allowed; the layout still adapts */ }
}

// Narrative edits save shortly after typing pauses, and when leaving the box.
let narrativeTimer = null;
function saveNarrative(id, text, delay) {
  clearTimeout(narrativeTimer);
  const save = () => {
    const e = engine.state.entries.find((x) => x.id === id);
    if (e && e.description !== text.trim()) act('updateEntry', { id, patch: { description: text } });
  };
  if (delay) narrativeTimer = setTimeout(save, delay);
  else save();
}

export function renderPip() {
  const win = pip.win;
  if (!win) return;
  const state = engine.state;
  const r = running(state);
  const top = state.interruptStack[state.interruptStack.length - 1];
  // The narrative isn't part of the key: re-rendering while typing would
  // lose the cursor. It is synced into the box below instead.
  const key = JSON.stringify([compact, r && [r.id, r.matterId], top && top.matterId, !!state.pendingAway,
    state.matters.map((m) => [m.id, m.lastUsed, m.archived])]);
  const doc = win.document;
  if (key !== lastKey) {
    lastKey = key;
    const m = r && state.matters.find((x) => x.id === r.matterId);
    const sizeBtn = h('button', {
      class: 'pip-size', title: compact ? 'Show narrative and controls' : 'Minimize to just the timer',
      onclick: () => setCompact(!compact),
    }, compact ? '⤢' : '–');
    const header = h('div', { class: 'pip-top' },
      h('span', { class: `dot ${r ? 'running' : 'stopped'}` }),
      h('span', { class: 'pip-matter', title: r ? R.matterLabel(m) : '' }, r ? R.matterLabel(m) : 'No timer running'),
      h('span', { class: 'pip-clock', id: 'pipClock' }),
      sizeBtn);

    let body = null;
    if (!compact) {
      const recent = state.matters.filter((x) => !x.archived)
        .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 12);
      const picker = document.createElement('select');
      picker.append(new Option(r ? 'Switch to…' : 'Start timing…', ''));
      for (const x of recent) if (!r || x.id !== r.matterId) picker.append(new Option(R.matterLabel(x), x.id));
      picker.addEventListener('change', () => { if (picker.value) act('start', { matterId: picker.value }); });

      const narrative = r ? h('textarea', {
        id: 'pipNarrative', class: 'pip-narrative', rows: '2', placeholder: 'What are you working on?',
        oninput: (e) => saveNarrative(r.id, e.target.value, 700),
        onblur: (e) => saveNarrative(r.id, e.target.value, 0),
        onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); } },
      }) : null;

      body = [
        narrative,
        state.pendingAway ? h('div', { class: 'pip-note' }, 'Welcome back. Open Time Logger to record your away time.') : null,
        h('div', { class: 'pip-actions' },
          picker,
          r ? h('button', { class: 'danger small', onclick: () => act('stop') }, 'Stop') : null,
          top ? h('button', { class: 'small', title: R.matterLabel(state.matters.find((x) => x.id === top.matterId)), onclick: () => act('resume') }, 'Back to it') : null),
      ];
    }
    doc.body.classList.toggle('compact', compact);
    fill(doc.body, h('div', { class: `pip-card ${r ? 'on' : 'off'}` }, header, body));
  }
  const box = doc.getElementById('pipNarrative');
  if (box && r && doc.activeElement !== box && box.value !== r.description) box.value = r.description;
  const clock = doc.getElementById('pipClock');
  if (clock) clock.textContent = r ? T.formatDuration(Date.now() - r.start, true) : '';
}

export function closePip() {
  if (pip.win) pip.win.close();
}
