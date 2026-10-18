'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, login, tempDir } = require('./helpers');
const { Store } = require('../src/db/store');

let k = 0;
const key = () => `draw-key-${Date.now()}-${(k += 1)}`;

test('draw mode: the drawn fight number is typed in, must be unique, and sets the running order', async (t) => {
  const ctx = await setup({ fightNumberMode: 'DRAW' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  for (const p of ['A', 'B', 'C', 'D', 'E', 'F']) await op.post(`${base}/entries`, { participantName: p });
  // A 001/002 B 003/004 C 005/006 D 007/008 E 009/010 F 011/012

  // check without a number: pair is validated, number still needed
  let r = await op.post(`${base}/matches/check`, { red: '1', blue: '3' });
  assert.equal(r.status, 200);
  assert.equal(r.body.fightNumberMode, 'DRAW');
  assert.equal(r.body.fightNumber, null);
  r = await op.post(`${base}/matches/check`, { red: '1', blue: '3', fightNumber: '17' });
  assert.equal(r.body.fightNumber, 17);

  // confirm requires the number
  r = await op.post(`${base}/matches`, { red: '1', blue: '3', idempotencyKey: key() });
  assert.equal(r.status, 400);
  assert.equal(r.body.details.field, 'fight');
  r = await op.post(`${base}/matches`, { red: '1', blue: '3', fightNumber: 'x1', idempotencyKey: key() });
  assert.equal(r.body.code, 'FIGHT_NUMBER_INVALID');

  const f17 = (await op.post(`${base}/matches`, { red: '1', blue: '3', fightNumber: 17, idempotencyKey: key() })).body.match;
  assert.equal(f17.fightNumber, 17);
  const f4 = (await op.post(`${base}/matches`, { red: '5', blue: '7', fightNumber: '4', idempotencyKey: key() })).body.match;
  const f9 = (await op.post(`${base}/matches`, { red: '9', blue: '11', fightNumber: '009', idempotencyKey: key() })).body.match;
  assert.equal(f9.fightNumber, 9);

  // duplicate drawn number is refused with a clear message
  r = await op.post(`${base}/matches/check`, { red: '2', blue: '4', fightNumber: '17' });
  assert.equal(r.body.code, 'FIGHT_NUMBER_TAKEN');
  assert.match(r.body.error, /Fight #017 is already used \(001 vs 003\)/);
  r = await op.post(`${base}/matches`, { red: '2', blue: '4', fightNumber: '4', idempotencyKey: key() });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'FIGHT_NUMBER_TAKEN');

  // TV queue follows fight number, not matching order
  let ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.next.fightNumber, 4);
  assert.deepEqual(ds.upcoming.map((m) => m.fightNumber), [9, 17]);
  assert.deepEqual((await op.get(`${base}/matches`)).body.map((m) => m.fightNumber), [4, 9, 17]);

  // Run #4 and #9, then a lower number (2) is drawn late: it still gets fought (queue wraps)
  await op.post(`${base}/display/advance`, { direction: 'next' });
  await op.post(`${base}/matches/${f4.id}/result`, { result: 'RED', advance: true });
  await op.post(`${base}/matches/${f9.id}/result`, { result: 'BLUE', advance: true });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.current.fightNumber, 17);
  const f2 = (await op.post(`${base}/matches`, { red: '2', blue: '6', fightNumber: '2', idempotencyKey: key() })).body.match;
  ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.next.fightNumber, 2, 'late low number comes next after the current fight');
  await op.post(`${base}/matches/${f17.id}/result`, { result: 'DRAW', advance: true });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.current.id, f2.id);

  // Cancelled numbers cannot be drawn again
  const f30 = (await op.post(`${base}/matches`, { red: '4', blue: '8', fightNumber: '30', idempotencyKey: key() })).body.match;
  await admin.post(`${base}/matches/${f30.id}/cancel`, { reason: 'mistake' });
  r = await op.post(`${base}/matches/check`, { red: '10', blue: '12', fightNumber: '30' });
  assert.match(r.body.error, /already used by a cancelled match/);

  // Admin renumbering in draw mode moves the fight in the running order
  const f50 = (await op.post(`${base}/matches`, { red: '10', blue: '12', fightNumber: '50', idempotencyKey: key() })).body.match;
  const f40 = (await op.post(`${base}/matches`, { red: '12', blue: '10', fightNumber: '40', idempotencyKey: key() }));
  assert.equal(f40.status, 400, '010/012 already matched');
  await admin.post(`${base}/matches/${f50.id}/fight-number`, { fightNumber: 1, reason: 'wrong draw typed' });
  const order = (await op.get(`${base}/matches?status=CONFIRMED`)).body.map((m) => m.fightNumber);
  assert.deepEqual(order, [1, 2]);
});

test('draw mode: event setting can switch to AUTO; old databases migrate to DRAW', async (t) => {
  const ctx = await setup({ fightNumberMode: 'DRAW' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  assert.equal((await admin.patch(base, { fightNumberMode: 'nope' })).status, 400);
  const upd = await admin.patch(base, { fightNumberMode: 'AUTO' });
  assert.equal(upd.body.fightNumberMode, 'AUTO');
  await admin.post(`${base}/entries`, { participantName: 'A' });
  await admin.post(`${base}/entries`, { participantName: 'B' });
  const m = await admin.post(`${base}/matches`, { red: '1', blue: '3', idempotencyKey: key() });
  assert.equal(m.body.match.fightNumber, 1);
  const page = await admin.agent.get('/matching');
  assert.doesNotMatch(page.text, /id="fightInput"/);

  // v1 database file (no fightNumberMode) is upgraded with a backup first
  const dir = tempDir();
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, counters: {}, users: [], events: [{ id: 1, name: 'Old' }], participants: [], entries: [], legbands: [], matches: [], auditLogs: [] }));
  const s = new Store(file, { backupIntervalMs: 0 });
  assert.equal(s.data.schemaVersion, 2);
  assert.equal(s.data.events[0].fightNumberMode, 'DRAW');
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.includes('pre-migration-v1')));
  s.close();
});
