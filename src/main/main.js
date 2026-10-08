const {
  app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, globalShortcut, Notification, nativeImage, dialog, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('../core/store');
const report = require('../core/report');
const T = require('../core/time');
const { processTick } = require('../core/activity');
const { JsonStore } = require('../core/persistence');

const TICK_MS = 15 * 1000;
const ASSETS = path.join(__dirname, '..', '..', 'assets');

let win = null;
let tray = null;
let db = null;
let state = null;
let lastSaved = 0;
let quitting = false;
let hotkeyOk = false;
const notifications = new Set(); // keep references so click handlers survive GC

const label = (matterId) => report.matterLabel(store.getMatter(state, matterId));

// --- Actions (the only way the state changes) ---------------------------------

const actions = {
  start: (p, now) => store.startTimer(state, p.matterId, now, { interrupt: !!p.interrupt }),
  stop: (p, now) => store.stopTimer(state, now),
  resume: (p, now) => store.resumePrevious(state, now),
  dismissResume: () => store.dismissResume(state),
  setRunningStart: (p, now) => store.setRunningStart(state, p.start, now),
  addEntry: (p, now) => store.addEntry(state, p, now),
  updateEntry: (p, now) => store.updateEntry(state, p.id, p.patch || {}, now),
  deleteEntry: (p) => store.deleteEntry(state, p.id),
  addMatter: (p) => store.addMatter(state, p),
  updateMatter: (p) => store.updateMatter(state, p.id, p.patch || {}),
  resolveAway: (p, now) => store.resolveAway(state, p.action, now, p),
  updateSettings: (p) => {
    const s = store.updateSettings(state, p);
    registerHotkey();
    return s;
  },
};

function runAction(type, payload) {
  const fn = actions[type];
  if (!fn) throw new Error(`Unknown action: ${type}`);
  const result = fn(payload || {}, Date.now());
  commit();
  return result == null ? null : result;
}

function commit() {
  db.save(state);
  lastSaved = Date.now();
  broadcast();
  updateTray();
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
}

// --- Window -------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Time Logger',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  // Closing the window keeps the app (and the timer) running in the tray.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // Links in the UI open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function focusSearch() {
  showWindow();
  win.webContents.send('focusSearch');
}

// --- Tray / menu bar ----------------------------------------------------------

function createTray() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, file)));
  tray.on('click', () => {
    if (process.platform !== 'darwin') showWindow();
  });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const now = Date.now();
  const r = store.running(state);
  const elapsed = r ? T.formatDuration(now - r.start) : '';
  if (process.platform === 'darwin') {
    const m = r && store.getMatter(state, r.matterId);
    const short = m ? (m.client && m.client !== 'Non-client' ? m.client : m.name).slice(0, 18) : '';
    tray.setTitle(r ? ` ${short} ${elapsed}` : '');
  }
  tray.setToolTip(r ? `Timing ${label(r.matterId)} (${elapsed})` : 'Time Logger: no timer running');

  const items = [];
  if (r) {
    items.push({ label: `● ${label(r.matterId)}: ${elapsed}`, enabled: false });
    items.push({ label: 'Stop timer', click: () => safeRun('stop') });
  } else {
    items.push({ label: 'No timer running', enabled: false });
  }
  const top = state.interruptStack[state.interruptStack.length - 1];
  if (top) items.push({ label: `Back to ${label(top.matterId)}`, click: () => safeRun('resume') });
  const recent = state.matters
    .filter((m) => !m.archived)
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
    .slice(0, 10);
  items.push(
    { type: 'separator' },
    {
      label: r ? 'Switch to' : 'Start',
      submenu: recent.map((m) => ({
        label: report.matterLabel(m),
        type: 'checkbox',
        checked: !!r && r.matterId === m.id,
        click: () => safeRun('start', { matterId: m.id }),
      })),
    },
    { label: 'Find a matter…', click: focusSearch },
    { label: 'Open Time Logger', click: showWindow },
    { type: 'separator' },
    { label: 'Quit Time Logger', click: () => { quitting = true; app.quit(); } },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function safeRun(type, payload) {
  try {
    runAction(type, payload);
  } catch (e) {
    notify('Time Logger', e.message, showWindow);
  }
}

// --- Notifications, hotkey, idle polling --------------------------------------

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  notifications.add(n);
  n.on('click', () => { notifications.delete(n); if (onClick) onClick(); });
  n.on('close', () => notifications.delete(n));
  n.show();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  hotkeyOk = false;
  if (!state.settings.hotkey) return;
  try {
    hotkeyOk = globalShortcut.register(state.settings.hotkey, focusSearch);
  } catch {
    hotkeyOk = false;
  }
}

function tick() {
  const now = Date.now();
  let idleSeconds = 0;
  let idleState = 'active';
  try {
    idleSeconds = powerMonitor.getSystemIdleTime();
    idleState = powerMonitor.getSystemIdleState(state.settings.idleMinutes * 60);
  } catch { /* treat as active */ }

  const ev = processTick(state, { idleSeconds, idleState, intervalMs: TICK_MS }, now);
  if (ev.away || ev.nudge || ev.review || now - lastSaved > 60 * 1000) {
    db.save(state);
    lastSaved = now;
  }
  broadcast();
  updateTray();

  if (ev.away) {
    showWindow();
    notify('Welcome back', 'A timer was running while you were away. Choose how to record that time.', showWindow);
  }
  if (ev.nudge) {
    notify('No timer running', "You're at your computer, but no time is being tracked. Click to pick a matter.", focusSearch);
  }
  if (ev.review) {
    const untracked = ev.review.untrackedMs >= 5 * T.MINUTE
      ? `${T.formatMinutes(ev.review.untrackedMs)} of today is untracked. `
      : '';
    const running = ev.review.timerRunning ? 'A timer is still running. ' : '';
    notify('Review your day', `${untracked}${running}Click to review today's time.`, () => {
      showWindow();
      win.webContents.send('showDay');
    });
  }
}

// --- IPC ----------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('getState', () => state);
  ipcMain.handle('info', () => ({ dataDir: db.dir, hotkey: state.settings.hotkey, hotkeyOk, version: app.getVersion() }));
  ipcMain.handle('action', (_e, type, payload) => runAction(type, payload));
  ipcMain.handle('openDataFolder', () => shell.openPath(db.dir));
  ipcMain.handle('exportCsv', async (_e, { from, to, combine }) => {
    const csv = report.toCsv(state, from, to, { combine });
    const name = from === to ? `time-${from}.csv` : `time-${from}-to-${to}.csv`;
    const res = await dialog.showSaveDialog(win, {
      title: 'Export time entries',
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, `﻿${csv}`); // BOM so Excel reads UTF-8 correctly
    return res.filePath;
  });
}

// --- Startup ------------------------------------------------------------------

function init() {
  db = new JsonStore(process.env.TIME_LOGGER_DATA_DIR || app.getPath('userData'));
  state = db.load();
  registerIpc();
  createWindow();
  createTray();
  registerHotkey();
  tick();
  setInterval(tick, TICK_MS);
  for (const evt of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) powerMonitor.on(evt, tick);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(init);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('before-quit', () => {
    quitting = true;
    if (db && state) db.save(state);
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
