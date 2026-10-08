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

// Must be called from a click.
export async function openPip(actFn) {
  act = actFn;
  if (pip.win) {
    pip.win.focus();
    return;
  }
  const win = await window.documentPictureInPicture.requestWindow({ width: 360, height: 150 });
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

export function renderPip() {
  const win = pip.win;
  if (!win) return;
  const state = engine.state;
  const r = running(state);
  const top = state.interruptStack[state.interruptStack.length - 1];
  const key = JSON.stringify([r && [r.id, r.matterId], top && top.matterId, !!state.pendingAway,
    state.matters.map((m) => [m.id, m.lastUsed, m.archived])]);
  const doc = win.document;
  if (key !== lastKey) {
    lastKey = key;
    const recent = state.matters.filter((m) => !m.archived)
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 12);
    const picker = document.createElement('select');
    picker.append(new Option(r ? 'Switch to…' : 'Start timing…', ''));
    for (const m of recent) if (!r || m.id !== r.matterId) picker.append(new Option(R.matterLabel(m), m.id));
    picker.addEventListener('change', () => { if (picker.value) act('start', { matterId: picker.value }); });

    const m = r && state.matters.find((x) => x.id === r.matterId);
    fill(doc.body,
      h('div', { class: `pip-card ${r ? 'on' : 'off'}` },
        h('div', { class: 'pip-top' },
          h('span', { class: `dot ${r ? 'running' : 'stopped'}` }),
          h('span', { class: 'pip-matter', title: r ? R.matterLabel(m) : '' }, r ? R.matterLabel(m) : 'No timer running'),
          h('span', { class: 'pip-clock', id: 'pipClock' })),
        state.pendingAway
          ? h('div', { class: 'pip-note' }, 'Welcome back. Open Time Logger to record your away time.')
          : null,
        h('div', { class: 'pip-actions' },
          picker,
          r ? h('button', { class: 'danger small', onclick: () => act('stop') }, 'Stop') : null,
          top ? h('button', { class: 'small', title: R.matterLabel(state.matters.find((x) => x.id === top.matterId)), onclick: () => act('resume') }, 'Back to it') : null)));
  }
  const clock = doc.getElementById('pipClock');
  if (clock) clock.textContent = r ? T.formatDuration(Date.now() - r.start, true) : '';
}

export function closePip() {
  if (pip.win) pip.win.close();
}
