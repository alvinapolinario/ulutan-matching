'use strict';
/**
 * JSON file database.
 *
 * Guarantees
 * - All reads/writes go through one in-memory state object owned by this process.
 * - `transaction(fn)` runs `fn` synchronously on a deep copy ("draft"). Node runs
 *   synchronous code without interleaving, so two transactions can never overlap:
 *   every transaction sees the fully committed result of the previous one. This is
 *   what prevents double-matching and duplicate fight numbers.
 * - If `fn` throws, the draft is discarded (rollback). Nothing is written.
 * - On success the draft is written to disk atomically (write temp file -> fsync ->
 *   rename) BEFORE it becomes the live state, so a crash can never leave a
 *   half-written database and nothing is reported as saved before it is on disk.
 * - A lock file stops a second server process from opening the same database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrate, emptyDatabase, SCHEMA_VERSION } = require('./schema');

class Store {
  constructor(file, { backupDir, backupIntervalMs = 5 * 60 * 1000, keepBackups = 50, lock = true } = {}) {
    this.file = path.resolve(file);
    this.backupDir = backupDir ? path.resolve(backupDir) : path.join(path.dirname(this.file), 'backups');
    this.keepBackups = keepBackups;
    this.lockFile = this.file + '.lock';
    this.dirtySinceBackup = false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (lock) this._acquireLock();
    this.state = this._load();
    if (backupIntervalMs > 0) {
      this._timer = setInterval(() => this.backupIfDirty(), backupIntervalMs);
      this._timer.unref();
    }
  }

  _acquireLock() {
    if (fs.existsSync(this.lockFile)) {
      const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
      // A lock written before this computer last started is always stale: after a power cut or
      // crash the old process id may now belong to an unrelated program.
      let staleByBoot = false;
      try { staleByBoot = fs.statSync(this.lockFile).mtimeMs < Date.now() - os.uptime() * 1000 - 5000; } catch (_) { /* ignore */ }
      let alive = false;
      if (!staleByBoot) {
        try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch (e) { alive = e.code === 'EPERM'; }
      }
      if (alive) throw new Error(`Database ${this.file} is already in use by process ${pid}. Stop the other server first.`);
      try { fs.unlinkSync(this.lockFile); } catch (_) { /* ignore */ }
    }
    try {
      fs.writeFileSync(this.lockFile, String(process.pid), { flag: 'wx' }); // fails if another process won the race
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error(`Database ${this.file} was just opened by another server. Stop the other server first.`);
      throw e;
    }
    this._ownsLock = true;
    const release = () => this.close();
    process.once('exit', release);
  }

  _load() {
    if (!fs.existsSync(this.file)) {
      const fresh = emptyDatabase();
      this._writeAtomic(fresh);
      return fresh;
    }
    const raw = fs.readFileSync(this.file, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Database file ${this.file} is not valid JSON (${e.message}). Restore the newest file from ${this.backupDir}.`);
    }
    const before = data.schemaVersion;
    data = migrate(data);
    if (before !== SCHEMA_VERSION) {
      this._backupCopy(`pre-migration-v${before}`);
      this._writeAtomic(data);
    }
    return data;
  }

  _writeAtomic(data) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    this._fsyncDir();
  }

  /** Make the rename itself survive a power cut (Linux/macOS; not supported on Windows). */
  _fsyncDir() {
    if (process.platform === 'win32') return;
    let fd;
    try { fd = fs.openSync(path.dirname(this.file), 'r'); fs.fsyncSync(fd); } catch (_) { /* best effort */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }

  /** Read-only access. Never mutate the returned object. */
  get data() { return this.state; }

  /**
   * Run `fn(draft)` as an all-or-nothing transaction. `fn` must be synchronous.
   * Returns whatever `fn` returns.
   */
  transaction(fn) {
    if (this._inTx) throw new Error('Nested transactions are not supported');
    this._inTx = true;
    try {
      const draft = structuredClone(this.state);
      const result = fn(draft);
      if (result && typeof result.then === 'function') throw new Error('Transaction function must be synchronous');
      this._writeAtomic(draft);
      this.state = draft;
      this.dirtySinceBackup = true;
      return result;
    } finally {
      this._inTx = false;
    }
  }

  nextId(draft, name) {
    draft.counters[name] = (draft.counters[name] || 0) + 1;
    return draft.counters[name];
  }

  _backupCopy(label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.backupDir, `db-${stamp}${label ? '-' + label : ''}.json`);
    fs.copyFileSync(this.file, target);
    this._pruneBackups();
    return target;
  }

  backupNow(label) {
    const target = this._backupCopy(label);
    this.dirtySinceBackup = false;
    return target;
  }

  backupIfDirty() {
    if (!this.dirtySinceBackup) return null;
    try { return this.backupNow(); } catch (e) { console.error('[backup] failed:', e.message); return null; }
  }

  _pruneBackups() {
    const files = fs.readdirSync(this.backupDir).filter((f) => f.startsWith('db-') && f.endsWith('.json')).sort();
    // Only automatic backups rotate; manual ("Back up now") and pre-migration copies are kept.
    const auto = files.filter((f) => !f.includes('pre-migration') && !f.includes('-manual'));
    while (auto.length > this.keepBackups) fs.unlinkSync(path.join(this.backupDir, auto.shift()));
  }

  /** Write an event archive that is never rotated away. Returns the file name, not the full path. */
  saveArchive(label, data) {
    const dir = path.join(path.dirname(this.file), 'archives');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = String(label || 'event').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'event';
    const name = `${stamp}-${safe}.json`;
    const target = path.join(dir, name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
    return name;
  }

  close() {
    if (this._timer) clearInterval(this._timer);
    if (this._ownsLock) {
      try {
        if (fs.existsSync(this.lockFile) && fs.readFileSync(this.lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(this.lockFile);
      } catch (_) { /* ignore */ }
      this._ownsLock = false;
    }
  }
}

module.exports = { Store };
