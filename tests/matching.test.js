'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, login } = require('./helpers');

let keyN = 0;
const key = () => `test-key-${Date.now()}-${(keyN += 1)}`;

/** Owners: A(entries 1,2) B(3) C(4) D(5) E(6). Legbands 001..012. */
async function seed(ctx, op) {
  const base = `/api/events/${ctx.eventId}`;
  const rows = [];
  for (const [p, n] of [['Alvin', 'Alvin 1'], ['Alvin', 'Alvin 2'], ['Joel', 'Joel'], ['Robin', 'Robin'], ['Bong', 'Bong'], ['Cayetano', 'Cayetano']]) {
    rows.push((await op.post(`${base}/entries`, { participantName: p, entryName: n })).body);
  }
  return rows;
}

test('matching: validation rules with clear messages', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  await seed(ctx, op);
  const check = (red, blue) => op.post(`${base}/matches/check`, { red, blue });

  let r = await check('001', '005');
  assert.equal(r.status, 200);
  assert.equal(r.body.red.entry.entryName, 'Alvin 1');
  assert.equal(r.body.blue.participant.name, 'Joel');
  assert.equal(r.body.nextFightNumber, 1);

  r = await check('099', '005'); assert.equal(r.status, 400); assert.equal(r.body.details.field, 'red'); assert.match(r.body.error, /Legband 099 is not registered/);
  r = await check('001', '099'); assert.equal(r.body.details.field, 'blue'); assert.equal(r.body.code, 'LEGBAND_NOT_FOUND');
  r = await check('001', '1'); assert.equal(r.body.code, 'SAME_LEGBAND');
  r = await check('001', '002'); assert.equal(r.body.code, 'SAME_ENTRY'); assert.match(r.body.error, /same entry is not allowed/);
  r = await check('001', '003'); assert.equal(r.body.code, 'SAME_OWNER', 'Alvin 1 vs Alvin 2 is the same owner');
  r = await check('abc', '003'); assert.equal(r.body.details.field, 'red');

  const ok = await op.post(`${base}/matches`, { red: '1', blue: '5', idempotencyKey: key() });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.match.fightNumber, 1);
  assert.equal(ok.body.match.red.legband, '001');
  r = await check('001', '007');
  assert.equal(r.body.details.field, 'red');
  assert.match(r.body.error, /Legband 001 is already matched in Fight #001/);
  r = await check('007', '005');
  assert.match(r.body.error, /Legband 005 is already matched/);

  // Server re-validates on confirm too (frontend checks are not trusted)
  const again = await op.post(`${base}/matches`, { red: '001', blue: '007', idempotencyKey: key() });
  assert.equal(again.status, 400);
  assert.equal(ctx.store.data.matches.length, 1);
  const lb = await op.get(`${base}/legbands/001`);
  assert.equal(lb.body.status, 'MATCHED');
  assert.equal(lb.body.match.fightNumber, 1);
});

test('matching: event must allow matching; permissions; CSRF; login', async (t) => {
  const ctx = await setup({ status: 'MATCHING_OPEN' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const tv = await login(ctx, 'tv', 'tv1234');
  const base = `/api/events/${ctx.eventId}`;
  await seed(ctx, op);
  assert.equal((await tv.post(`${base}/matches`, { red: '001', blue: '005', idempotencyKey: key() })).status, 403, 'display role cannot match');
  assert.equal((await tv.get(`${base}/display-state`)).status, 200, 'display role can read the display');
  assert.equal((await tv.get(`${base}/entries`)).status, 403);
  const noCsrf = await op.agent.post(`${base}/matches`).set('Accept', 'application/json').send({ red: '001', blue: '005', idempotencyKey: key() });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.code, 'CSRF');
  const anon = await request(ctx.url).get(`${base}/legbands/001`).set('Accept', 'application/json');
  assert.equal(anon.status, 401);
  ctx.services.events.setStatus(ctx.eventId, 'REGISTRATION_OPEN', ctx.adminUser.id);
  const closed = await op.post(`${base}/matches`, { red: '001', blue: '005', idempotencyKey: key() });
  assert.equal(closed.status, 400);
  assert.equal(closed.body.code, 'EVENT_CLOSED');
  assert.equal(ctx.store.data.matches.length, 0);
});

test('matching: repeated confirmation with the same key creates one match', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  await seed(ctx, op);
  const k = key();
  const first = await op.post(`${base}/matches`, { red: '001', blue: '005', idempotencyKey: k });
  const second = await op.post(`${base}/matches`, { red: '001', blue: '005', idempotencyKey: k });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.replay, true);
  assert.equal(second.body.match.id, first.body.match.id);
  const misuse = await op.post(`${base}/matches`, { red: '007', blue: '009', idempotencyKey: k });
  assert.equal(misuse.status, 409);
  assert.equal(ctx.store.data.matches.length, 1);
  assert.equal((await op.post(`${base}/matches`, { red: '007', blue: '009' })).status, 400, 'key is required');
});

test('matching: concurrent confirmations of the same legband -> exactly one wins', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await seed(ctx, op);
  // 30 simultaneous HTTP requests from two operators all want legband 001.
  const blues = ['005', '007', '009', '011', '006'];
  const reqs = Array.from({ length: 30 }, (_, i) => (i % 2 ? op : admin).post(`${base}/matches`, { red: '001', blue: blues[i % blues.length], idempotencyKey: key() }));
  const res = await Promise.all(reqs);
  const wins = res.filter((r) => r.status === 201);
  assert.equal(wins.length, 1, 'only one match may use legband 001');
  assert.ok(res.every((r) => r.status === 201 || r.status === 400 || r.status === 409));
  const using001 = ctx.store.data.matches.filter((m) => m.status !== 'CANCELLED' && [m.redLegbandId, m.blueLegbandId].includes(ctx.store.data.legbands.find((l) => l.number === '001').id));
  assert.equal(using001.length, 1);
});

test('matching: concurrent different pairs get unique, gap-free fight numbers', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  // 40 owners with one entry each = 80 legbands
  for (let i = 0; i < 40; i += 1) await op.post(`${base}/entries`, { participantName: `Owner ${i}` });
  const pairs = [];
  for (let i = 0; i < 20; i += 1) pairs.push([2 * i * 2 + 1, 2 * i * 2 + 3]); // slot-1 legband of owner 2i vs owner 2i+1
  const res = await Promise.all(pairs.map(([r, b]) => op.post(`${base}/matches`, { red: String(r), blue: String(b), idempotencyKey: key() })));
  assert.ok(res.every((r) => r.status === 201), res.map((r) => r.body.error).filter(Boolean).join('; '));
  const nums = res.map((r) => r.body.match.fightNumber).sort((a, b) => a - b);
  assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => i + 1));
});

test('matching: cancel makes legbands unusable and never reuses the fight number', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await seed(ctx, op);
  const m1 = (await op.post(`${base}/matches`, { red: '001', blue: '005', idempotencyKey: key() })).body.match;
  assert.equal((await op.post(`${base}/matches/${m1.id}/cancel`, { reason: 'x' })).status, 403, 'operator cannot cancel');
  assert.equal((await admin.post(`${base}/matches/${m1.id}/cancel`, {})).status, 400, 'reason required');
  const c = await admin.post(`${base}/matches/${m1.id}/cancel`, { reason: 'wrong pairing' });
  assert.equal(c.body.status, 'CANCELLED');
  const lb = await op.get(`${base}/legbands/001`);
  assert.equal(lb.body.status, 'INACTIVE');
  assert.equal(lb.body.available, false);
  assert.match(lb.body.unavailableReason, /cancelled Fight #001 and can no longer be used/);
  const reuse = await op.post(`${base}/matches`, { red: '001', blue: '007', idempotencyKey: key() });
  assert.equal(reuse.status, 400);
  const m2 = (await op.post(`${base}/matches`, { red: '007', blue: '009', idempotencyKey: key() })).body.match;
  assert.equal(m2.fightNumber, 2, 'cancelled #1 is not reused');
  assert.equal((await admin.post(`${base}/matches/${m1.id}/cancel`, { reason: 'again' })).status, 409);
  const audit = ctx.store.data.auditLogs.find((a) => a.action === 'MATCH_CANCELLED');
  assert.equal(audit.reason, 'wrong pairing');
  assert.equal(ctx.store.data.matches.length, 2, 'cancelled match is kept, never deleted');
});

test('matching: correction, fight number change, reorder, results and standings', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await seed(ctx, op);
  const m1 = (await op.post(`${base}/matches`, { red: '001', blue: '005', idempotencyKey: key() })).body.match;
  const m2 = (await op.post(`${base}/matches`, { red: '007', blue: '009', idempotencyKey: key() })).body.match;
  const m3 = (await op.post(`${base}/matches`, { red: '011', blue: '003', idempotencyKey: key() })).body.match;

  // Correct blue of fight 1 from 005 to 006 (same entry as 005 is fine: Joel's other chicken)
  assert.equal((await admin.post(`${base}/matches/${m1.id}/correct`, { corner: 'blue', legband: '006', reason: 'typo' })).body.blue.legband, '006');
  assert.equal((await op.get(`${base}/legbands/005`)).body.available, true, 'replaced legband is free again');
  const badFix = await admin.post(`${base}/matches/${m1.id}/correct`, { corner: 'blue', legband: '002', reason: 'x' });
  assert.equal(badFix.body.code, 'SAME_ENTRY');
  assert.equal(ctx.store.data.matches.find((m) => m.id === m1.id).blueLegbandId, ctx.store.data.legbands.find((l) => l.number === '006').id, 'failed correction rolled back');

  // Fight number change: cannot collide; counter moves past manual numbers
  assert.equal((await admin.post(`${base}/matches/${m3.id}/fight-number`, { fightNumber: 2, reason: 'x' })).status, 409);
  assert.equal((await admin.post(`${base}/matches/${m3.id}/fight-number`, { fightNumber: 10, reason: 'renumber' })).body.fightNumber, 10);
  const m4 = (await op.post(`${base}/matches`, { red: '005', blue: '010', idempotencyKey: key() })).body.match;
  assert.equal(m4.fightNumber, 11);

  // Reorder: move fight #2 up above #1
  await admin.post(`${base}/matches/${m2.id}/move`, { direction: 'up' });
  let order = (await op.get(`${base}/matches`)).body.map((m) => m.fightNumber);
  assert.deepEqual(order, [2, 1, 10, 11]);
  assert.equal((await admin.post(`${base}/matches/${m2.id}/move`, { direction: 'up' })).status, 409);

  // Display flow: first Next -> fight #2 (top of queue)
  let ds = (await op.post(`${base}/display/advance`, { direction: 'next' })).body;
  assert.equal(ds.current.fightNumber, 2);
  assert.equal(ds.next.fightNumber, 1);
  assert.deepEqual(ds.upcoming.map((m) => m.fightNumber), [10, 11]);
  // Result with advance
  await op.post(`${base}/matches/${m2.id}/result`, { result: 'RED', advance: true });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.current.fightNumber, 1);
  await op.post(`${base}/matches/${m1.id}/result`, { result: 'DRAW', advance: true });
  // Operator cannot change an existing result; admin can with a reason
  assert.equal((await op.post(`${base}/matches/${m1.id}/result`, { result: 'BLUE' })).status, 403);
  assert.equal((await admin.post(`${base}/matches/${m1.id}/result`, { result: 'BLUE' })).status, 400);
  assert.equal((await admin.post(`${base}/matches/${m1.id}/result`, { result: 'DRAW', reason: 'confirm' })).status, 200);
  assert.equal((await admin.post(`${base}/matches/${m1.id}/cancel`, { reason: 'x' })).status, 409, 'completed fights cannot be cancelled');

  const standings = (await op.get(`${base}/standings`)).body;
  const byName = Object.fromEntries(standings.map((s) => [s.entryName, s]));
  assert.equal(byName.Robin.points, 1);      // 007 Robin beat 009 Bong
  assert.equal(byName.Bong.points, 0);
  assert.equal(byName['Alvin 1'].points, 0.5);
  assert.equal(byName.Joel.points, 0.5);
  assert.equal(byName.Joel.pending, 1);       // 005 still pending in fight 11
  assert.equal(standings[0].entryName, 'Robin');

  // Display set current to a cancelled match is rejected
  const m5 = (await op.post(`${base}/matches`, { red: '012', blue: '004', idempotencyKey: key() })).body.match;
  await admin.post(`${base}/matches/${m5.id}/cancel`, { reason: 'x' });
  assert.equal((await op.post(`${base}/display/current`, { matchId: m5.id })).status, 409);
});
