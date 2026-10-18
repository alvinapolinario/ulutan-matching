'use strict';
// Regression tests for the production-readiness review.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { Store } = require('../src/db/store');
const { safeLocalPath } = require('../src/routes/pages');
const { setup, login, tempDir, tokenFrom } = require('./helpers');

test('redirect targets after login stay on this server', () => {
  assert.equal(safeLocalPath('/fights'), '/fights');
  assert.equal(safeLocalPath('/reports/scores?format=csv'), '/reports/scores?format=csv');
  for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', 'https://evil.example', '', null, '/a\nb']) {
    assert.equal(safeLocalPath(bad), '/', JSON.stringify(bad));
  }
});

test('login: backslash redirect refused; successful logins do not count toward the lockout', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const agent = request.agent(ctx.url);
  const tok = tokenFrom((await agent.get('/login')).text);
  const res = await agent.post('/login').type('form').send({ _csrf: tok, username: 'op', password: 'op1234', next: '/\\evil.example' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  for (let i = 0; i < 22; i += 1) await login(ctx, 'op', 'op1234'); // would hit the 20-attempt limit before
});

test('reports: CSV cells that look like formulas are neutralised', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  await op.post(`/api/events/${ctx.eventId}/entries`, { participantName: '=HYPERLINK("http://x")', entryName: '+cmd' });
  const csv = (await op.agent.get('/reports/registration?format=csv')).text;
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(csv, /'\+cmd/);
  assert.doesNotMatch(csv, /,=HYPERLINK/);
});

test('admins are warned about accounts that still use demo passwords', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  assert.deepEqual(ctx.services.users.weakAccounts().sort(), ['admin', 'op', 'tv']);
  assert.match((await admin.agent.get('/fights')).text, /demo or easy password/);
  const op = await login(ctx, 'op', 'op1234');
  assert.doesNotMatch((await op.agent.get('/fights')).text, /demo or easy password/, 'only admins see it');
  const opUser = ctx.store.data.users.find((u) => u.username === 'op');
  await admin.patch(`/api/users/${opUser.id}`, { password: 'Str0ng-pass!' });
  assert.deepEqual(ctx.services.users.weakAccounts().sort(), ['admin', 'tv']);
  // scan of stored hashes finds the same accounts after a restart
  assert.deepEqual((await ctx.services.users.scanWeakPasswords()).sort(), ['admin', 'tv']);
});

test('event settings: max legbands cannot go below typed (manual) legbands already registered', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN', legbandMode: 'MANUAL' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  await admin.post(`/api/events/${ctx.eventId}/entries`, { participantName: 'A', legband1: '100', legband2: '101' });
  await admin.post(`/api/events/${ctx.eventId}/entries`, { participantName: 'B', legband1: '102' });
  const r = await admin.patch(`/api/events/${ctx.eventId}`, { maxLegbands: 2 });
  assert.equal(r.status, 400);
  assert.equal((await admin.patch(`/api/events/${ctx.eventId}`, { maxLegbands: 3 })).status, 200);
});

test('store: manual backups survive rotation; stale lock from before a reboot is cleared', () => {
  const dir = tempDir();
  const file = path.join(dir, 'db.json');
  const s = new Store(file, { backupIntervalMs: 0, keepBackups: 2 });
  s.backupNow('manual');
  for (let i = 0; i < 4; i += 1) { s.transaction((d) => { d.counters.x = i; }); s.backupNow(); }
  const files = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(files.filter((f) => f.includes('-manual')).length, 1, 'manual backup kept');
  assert.equal(files.filter((f) => !f.includes('-manual')).length, 2, 'automatic backups rotated');
  s.close();

  // A lock left by a process that died before this machine booted, whose PID is now reused (here: ours' parent).
  fs.writeFileSync(file + '.lock', String(process.ppid));
  const old = new Date(Date.now() - require('os').uptime() * 1000 - 60 * 1000);
  fs.utimesSync(file + '.lock', old, old);
  const s2 = new Store(file, { backupIntervalMs: 0 });
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), String(process.pid));
  s2.close();

  // A live lock is still respected.
  fs.writeFileSync(file + '.lock', String(process.ppid));
  assert.throws(() => new Store(file, { backupIntervalMs: 0 }), /already in use/);
  fs.unlinkSync(file + '.lock');
});

test('socket: a bad join message is answered, not a crash', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const { io } = require('socket.io-client');
  const cookie = op.agent.jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false }).map((c) => `${c.name}=${c.value}`).join('; ');
  const sock = io(ctx.url, { extraHeaders: { Cookie: cookie }, transports: ['websocket'], forceNew: true });
  t.after(() => sock.close());
  await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
  const bad = await new Promise((res) => sock.emit('join', { toString: 'x' }, res));
  assert.equal(bad.ok, false);
  const good = await new Promise((res) => sock.emit('join', ctx.eventId, res));
  assert.equal(good.ok, true);
});
