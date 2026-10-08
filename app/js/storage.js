// Everything is stored in this browser's IndexedDB on this PC. Optionally, a
// copy is also written once a day to a folder the user picks (e.g. Documents
// or OneDrive) so the data survives a browser reset.
import * as T from '../core/time.js';
import { normalizeState } from '../core/store.js';

const DB_NAME = 'time-logger';
const STORE = 'kv';
const KEEP_BACKUPS = 30;
const BACKUP_EVERY_MS = 10 * T.MINUTE;

let dbPromise = null;
let writeChain = Promise.resolve();

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idb(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const get = (key) => idb('readonly', (s) => s.get(key));
const put = (key, value) => idb('readwrite', (s) => s.put(value, key));
const del = (key) => idb('readwrite', (s) => s.delete(key));

export async function loadState() {
  return normalizeState(await get('state'));
}

// Writes are queued so they land in order. IndexedDB copies the object when
// put() is called, so later changes to `state` don't affect a queued write.
export function saveState(state) {
  const snapshot = JSON.parse(JSON.stringify(state));
  writeChain = writeChain.then(() => put('state', snapshot)).catch((err) => console.error('Save failed', err));
  maybeBackup(snapshot);
  return writeChain;
}

export function flush() {
  return writeChain;
}

// Ask the browser not to evict our data under storage pressure.
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function isPersisted() {
  return !!(navigator.storage && navigator.storage.persisted && (await navigator.storage.persisted()));
}

// --- Backups to a folder ------------------------------------------------------

export const backup = {
  supported: typeof window !== 'undefined' && 'showDirectoryPicker' in window,
  handle: null,
  status: 'off', // off | ok | needs-permission | error
  folderName: '',
  lastWritten: 0,
  lastError: '',
  listeners: new Set(),
};

function setBackupStatus(status, error = '') {
  backup.status = status;
  backup.lastError = error;
  for (const fn of backup.listeners) fn();
}

export async function initBackup() {
  if (!backup.supported) return;
  backup.handle = (await get('backupDir')) || null;
  backup.lastWritten = (await get('backupLastWritten')) || 0;
  if (!backup.handle) return setBackupStatus('off');
  backup.folderName = backup.handle.name;
  const perm = await backup.handle.queryPermission({ mode: 'readwrite' });
  setBackupStatus(perm === 'granted' ? 'ok' : 'needs-permission');
}

// Must be called from a click.
export async function chooseBackupFolder(state) {
  const handle = await window.showDirectoryPicker({ id: 'time-logger-backups', mode: 'readwrite', startIn: 'documents' });
  backup.handle = handle;
  backup.folderName = handle.name;
  await put('backupDir', handle);
  setBackupStatus('ok');
  await writeBackup(JSON.parse(JSON.stringify(state)));
}

// Must be called from a click. Edge asks again after a restart unless the user
// picks "Allow on every visit".
export async function reconnectBackupFolder(state) {
  if (!backup.handle) return;
  const perm = await backup.handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return setBackupStatus('needs-permission');
  setBackupStatus('ok');
  await writeBackup(JSON.parse(JSON.stringify(state)));
}

export async function stopBackups() {
  backup.handle = null;
  backup.folderName = '';
  await del('backupDir');
  setBackupStatus('off');
}

function maybeBackup(snapshot) {
  if (backup.status !== 'ok' || Date.now() - backup.lastWritten < BACKUP_EVERY_MS) return;
  writeBackup(snapshot);
}

async function writeBackup(snapshot) {
  if (!backup.handle) return;
  try {
    const name = `timelog-${T.dateKey(Date.now())}.json`;
    const file = await backup.handle.getFileHandle(name, { create: true });
    const w = await file.createWritable();
    await w.write(JSON.stringify(snapshot));
    await w.close();
    backup.lastWritten = Date.now();
    await put('backupLastWritten', backup.lastWritten);
    await pruneBackups();
    setBackupStatus('ok');
  } catch (err) {
    if (err && err.name === 'NotAllowedError') setBackupStatus('needs-permission');
    else setBackupStatus('error', String((err && err.message) || err));
  }
}

async function pruneBackups() {
  const names = [];
  for await (const [name] of backup.handle.entries()) {
    if (/^timelog-\d{4}-\d{2}-\d{2}\.json$/.test(name)) names.push(name);
  }
  names.sort().reverse();
  for (const name of names.slice(KEEP_BACKUPS)) await backup.handle.removeEntry(name);
}

// --- Manual backup / restore -----------------------------------------------------

export function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not a Time Logger backup.');
  }
  if (!raw || !Array.isArray(raw.entries) || !Array.isArray(raw.matters)) {
    throw new Error('That file is not a Time Logger backup.');
  }
  return normalizeState(raw);
}
