// Saves the state as a single JSON file in the app's data folder, with atomic
// writes and a rolling set of daily backups. Nothing leaves the machine.
const fs = require('fs');
const path = require('path');
const T = require('./time');
const { normalizeState } = require('./store');

const KEEP_BACKUPS = 30;

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'timelog.json');
    this.backupDir = path.join(dir, 'backups');
    this.lastBackupDay = null;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw = null;
    if (fs.existsSync(this.file)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        // Keep the damaged file for inspection and fall back to the newest backup.
        fs.renameSync(this.file, path.join(this.dir, `timelog.corrupt-${Date.now()}.json`));
        raw = this.newestBackup();
      }
    }
    return normalizeState(raw);
  }

  save(state) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.file);
    this.backupDaily();
  }

  backupDaily() {
    const day = T.dateKey(Date.now());
    if (this.lastBackupDay === day) return;
    this.lastBackupDay = day;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const target = path.join(this.backupDir, `timelog-${day}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
    const old = this.backups().slice(KEEP_BACKUPS);
    for (const f of old) fs.unlinkSync(path.join(this.backupDir, f));
  }

  backups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir).filter((f) => /^timelog-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  }

  newestBackup() {
    for (const f of this.backups()) {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.backupDir, f), 'utf8'));
      } catch { /* try the next one */ }
    }
    return null;
  }
}

module.exports = { JsonStore };
