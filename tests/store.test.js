'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/db/store');
const { tempDir } = require('./helpers');

test('store: commit persists atomically, failed transaction rolls back', () => {
  const dir = tempDir();
  const file = path.join(dir, 'db.json');
  const s = new Store(file, { backupIntervalMs: 0 });
  s.transaction((d) => { d.users.push({ id: s.nextId(d, 'user'), username: 'a' }); });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users.length, 1);
  assert.throws(() => s.transaction((d) => { d.users.push({ id: 99 }); throw new Error('boom'); }), /boom/);
  assert.equal(s.data.users.length, 1, 'in-memory state unchanged after rollback');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users.length, 1, 'disk unchanged after rollback');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
  s.close();
  const s2 = new Store(file, { backupIntervalMs: 0 });
  assert.equal(s2.data.users[0].username, 'a', 'data survives restart');
  assert.equal(s2.data.counters.user, 1);
  s2.close();
});

test('store: async transaction functions are rejected', () => {
  const s = new Store(path.join(tempDir(), 'db.json'), { backupIntervalMs: 0 });
  assert.throws(() => s.transaction(async () => {}), /synchronous/);
  s.close();
});

test('store: lock file blocks a second live process but not a stale lock', () => {
  const dir = tempDir();
  const file = path.join(dir, 'db.json');
  // A stale lock from a dead process is taken over.
  fs.writeFileSync(file + '.lock', '999999');
  const s = new Store(file, { backupIntervalMs: 0 });
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), String(process.pid));
  s.close();
  assert.ok(!fs.existsSync(file + '.lock'), 'lock released on close');
  // A live foreign process (pid 1) blocks opening.
  fs.writeFileSync(file + '.lock', '1');
  assert.throws(() => new Store(file, { backupIntervalMs: 0 }), /already in use/);
  fs.unlinkSync(file + '.lock');
});

test('store: corrupt file gives a clear error, backups are created and pruned', () => {
  const dir = tempDir();
  const file = path.join(dir, 'db.json');
  const s = new Store(file, { backupIntervalMs: 0, keepBackups: 2 });
  for (let i = 0; i < 4; i += 1) { s.transaction((d) => { d.counters.audit += 1; }); s.backupNow(String(i)); }
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 2);
  s.close();
  fs.writeFileSync(file, '{not json');
  assert.throws(() => new Store(file, { backupIntervalMs: 0 }), /not valid JSON/);
});
