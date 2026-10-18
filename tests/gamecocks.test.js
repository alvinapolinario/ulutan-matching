'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login } = require('./helpers');

test('gamecock list: one row per legband with owner, status and opponent', async (t) => {
  const ctx = await setup({ fightNumberMode: 'DRAW', legbandMode: 'MANUAL' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await op.post(`${base}/entries`, { participantName: 'Alvin', entryName: 'Red Thunder', legband1: '101', legband2: '102' });
  await op.post(`${base}/entries`, { participantName: 'Joel', entryName: 'Blue Storm', legband1: '201', legband2: '202' });
  await op.post(`${base}/entries`, { participantName: 'Robin', legband1: '301' });
  await op.post(`${base}/entries`, { participantName: 'Bong' }); // no legband yet
  const m1 = (await op.post(`${base}/matches`, { red: '101', blue: '201', fightNumber: 7, idempotencyKey: 'gc-key-0001' })).body.match;
  const m2 = (await op.post(`${base}/matches`, { red: '102', blue: '301', fightNumber: 3, idempotencyKey: 'gc-key-0002' })).body.match;
  await op.post(`${base}/matches/${m1.id}/result`, { result: 'BLUE' });
  await admin.post(`${base}/matches/${m2.id}/cancel`, { reason: 'wrong chicken' });

  const res = await op.get(`${base}/gamecocks`);
  assert.equal(res.status, 200);
  const by = Object.fromEntries(res.body.map((g) => [g.legband || `none-${g.owner}`, g]));
  assert.deepEqual(res.body.map((g) => g.legband), ['101', '102', '201', '202', '301', null], 'legband order, no-legband last');

  const a = by['101'];
  assert.equal(a.owner, 'Alvin');
  assert.equal(a.entryName, 'Red Thunder');
  assert.equal(a.entryNumber, 1);
  assert.equal(a.status, 'FOUGHT');
  assert.equal(a.fight.fightNumber, 7);
  assert.equal(a.fight.corner, 'MERON');
  assert.equal(a.fight.outcome, 'LOSE');
  assert.deepEqual(a.fight.opponent, { legband: '201', slot: 1, entryNumber: 2, entryName: 'Blue Storm', owner: 'Joel' });
  assert.deepEqual([by['101'].slot, by['102'].slot], [1, 2], 'a two-chicken entry shows Entry #1 and Entry #2');
  assert.equal(by['201'].fight.outcome, 'WIN');
  assert.equal(by['201'].fight.corner, 'WALA');
  assert.equal(by['201'].fight.opponent.owner, 'Alvin');

  assert.equal(by['102'].status, 'CANCELLED');
  assert.equal(by['102'].fight.opponent.legband, '301');
  assert.equal(by['202'].status, 'NOT_MATCHED');
  assert.equal(by['202'].fight, null);
  assert.equal(by['none-Bong'].status, 'NO_LEGBAND');

  // A fresh match shows MATCHED with the opponent (301 was in a cancelled fight, so it can't be used)
  assert.equal((await op.post(`${base}/matches`, { red: '202', blue: '301', fightNumber: 9, idempotencyKey: 'gc-key-0003' })).status, 400);
  await op.post(`${base}/entries`, { participantName: 'Bong', entryName: 'Bong 2', legband1: '401' });
  await op.post(`${base}/matches`, { red: '401', blue: '202', fightNumber: 9, idempotencyKey: 'gc-key-0004' });
  const list = (await op.get(`${base}/gamecocks`)).body;
  const g202 = list.find((g) => g.legband === '202');
  assert.equal(g202.status, 'MATCHED');
  assert.equal(g202.fight.corner, 'WALA');
  assert.equal(g202.fight.outcome, null);
  assert.equal(g202.fight.opponent.entryName, 'Bong 2');

  const tv = await login(ctx, 'tv', 'tv1234');
  assert.equal((await tv.get(`${base}/gamecocks`)).status, 403);
  assert.equal((await op.agent.get('/gamecocks')).status, 200);
  const csv = (await op.agent.get('/reports/gamecocks?format=csv')).text;
  assert.match(csv, /"=""101""",Red Thunder,Entry #1,Alvin,Fought - LOSE,007 MERON,Blue Storm Entry #1 \(Joel\),"=""201"""/);
  assert.match(csv, /"=""102""",Red Thunder,Entry #2,Alvin,Cancelled/);
});
