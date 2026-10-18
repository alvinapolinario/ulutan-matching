'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login } = require('./helpers');

test('tv meron/wala: score boxes fill in the order fights are decided, not by legband slot', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  for (const p of ['Alvin', 'Joel', 'Robin']) await op.post(`${base}/entries`, { participantName: p, address: `${p} St., Iligan` });
  // Alvin = 001/002, Joel = 003/004, Robin = 005/006
  const f1 = (await op.post(`${base}/matches`, { red: '002', blue: '003', idempotencyKey: 'side-key-0001' })).body.match; // Alvin's 2nd chicken first
  const f2 = (await op.post(`${base}/matches`, { red: '001', blue: '005', idempotencyKey: 'side-key-0002' })).body.match;

  let ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.sides, null, 'no current fight -> NO ACTIVE FIGHT');

  ds = (await op.post(`${base}/display/advance`, { direction: 'next' })).body;
  assert.equal(ds.sides.meron.entryName, 'Alvin');
  assert.equal(ds.sides.meron.address, 'Alvin St., Iligan');
  assert.equal(ds.sides.wala.entryName, 'Joel');
  assert.equal(ds.current.blue.address, 'Joel St., Iligan');
  assert.deepEqual(ds.sides.meron.scores.map((s) => [s.points, s.fighting]), [[null, true], [null, false]]);

  await op.post(`${base}/matches/${f1.id}/result`, { result: 'RED', advance: false });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.sides.meron.scores[0].points, 1, "Alvin's first decided fight (legband 002) goes in box 1");
  assert.equal(ds.sides.meron.scores[1].points, null);
  assert.equal(ds.sides.wala.scores[0].points, 0);

  await op.post(`${base}/display/advance`, { direction: 'next' });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.current.id, f2.id);
  assert.deepEqual(ds.sides.meron.scores.map((s) => [s.points, s.fighting]), [[1, false], [null, true]]);
  assert.equal(ds.sides.wala.entryName, 'Robin');

  await op.post(`${base}/matches/${f2.id}/result`, { result: 'DRAW' });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.deepEqual(ds.sides.meron.scores.map((s) => s.points), [1, 0.5]);
  assert.deepEqual(ds.sides.wala.scores.map((s) => s.points), [0.5, null]);

  // An admin changing the first result keeps it in box 1
  const admin = await login(ctx, 'admin', 'admin123');
  await admin.post(`${base}/matches/${f1.id}/result`, { result: 'BLUE', reason: 'correction' });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.deepEqual(ds.sides.meron.scores.map((s) => s.points), [0, 0.5]);

  const page = await op.agent.get('/tv/meron');
  assert.equal(page.status, 200);
  assert.match(page.text, /MERON/);
  assert.equal((await op.agent.get('/tv/wala')).status, 200);
  assert.equal((await op.agent.get('/tv/other')).status, 404);
});

test('tv control: swap Meron/Wala before the result, WIN/LOSE/DRAW outcome for the side screens', async (t) => {
  const ctx = await setup({ fightNumberMode: 'DRAW' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const tv = await login(ctx, 'tv', 'tv1234');
  const base = `/api/events/${ctx.eventId}`;
  for (const p of ['Alvin', 'Joel', 'Robin', 'Bong']) await op.post(`${base}/entries`, { participantName: p });
  const f1 = (await op.post(`${base}/matches`, { red: '001', blue: '003', fightNumber: 1, idempotencyKey: 'swap-key-0001' })).body.match;
  await op.post(`${base}/matches`, { red: '005', blue: '007', fightNumber: 2, idempotencyKey: 'swap-key-0002' });
  await op.post(`${base}/display/current`, { matchId: f1.id });

  assert.equal((await tv.post(`${base}/matches/${f1.id}/swap`)).status, 403, 'display account cannot swap');
  const sw = await op.post(`${base}/matches/${f1.id}/swap`);
  assert.equal(sw.status, 200);
  assert.equal(sw.body.red.entryName, 'Joel');
  assert.equal(sw.body.blue.entryName, 'Alvin');
  let ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.sides.meron.entryName, 'Joel');
  assert.equal(ds.sides.meron.outcome, null);
  assert.ok(ctx.store.data.auditLogs.some((a) => a.action === 'MERON_WALA_SWAPPED'));

  await op.post(`${base}/matches/${f1.id}/result`, { result: 'BLUE', advance: false });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.current.id, f1.id, 'result without advance keeps the fight active so the WINNER shows');
  assert.equal(ds.sides.wala.outcome, 'WIN');
  assert.equal(ds.sides.meron.outcome, 'LOSE');
  assert.equal(ds.sides.wala.entryName, 'Alvin');
  assert.equal((await op.post(`${base}/matches/${f1.id}/swap`)).status, 409, 'no swap after the result');

  ds = (await op.post(`${base}/display/advance`, { direction: 'next' })).body;
  assert.equal(ds.current.fightNumber, 2);
  assert.equal(ds.sides.meron.outcome, null);
  const f2 = ds.current.id;
  await op.post(`${base}/matches/${f2}/result`, { result: 'DRAW' });
  ds = (await op.get(`${base}/display-state`)).body;
  assert.equal(ds.sides.meron.outcome, 'DRAW');
  assert.equal(ds.sides.wala.outcome, 'DRAW');
});

test('entry scores: every entry with two boxes in the order results were declared', async (t) => {
  const ctx = await setup({ fightNumberMode: 'DRAW' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  for (const p of ['Alvin Apolinario', 'Robin Padilla', 'Joel', 'Bong']) await op.post(`${base}/entries`, { participantName: p });
  // Alvin 001/002, Robin 003/004, Joel 005/006, Bong 007/008
  const m1 = (await op.post(`${base}/matches`, { red: '002', blue: '003', fightNumber: 5, idempotencyKey: 'es-key-0001' })).body.match;
  const m2 = (await op.post(`${base}/matches`, { red: '001', blue: '005', fightNumber: 2, idempotencyKey: 'es-key-0002' })).body.match;
  const m3 = (await op.post(`${base}/matches`, { red: '004', blue: '007', fightNumber: 9, idempotencyKey: 'es-key-0003' })).body.match;
  await op.post(`${base}/matches/${m1.id}/result`, { result: 'RED' });   // Alvin 1, Robin 0
  await op.post(`${base}/matches/${m2.id}/result`, { result: 'BLUE' });  // Alvin 0, Joel 1
  await op.post(`${base}/display/current`, { matchId: m3.id });
  let list = (await op.get(`${base}/entry-scores`)).body;
  const by = Object.fromEntries(list.map((e) => [e.entryName, e]));
  assert.deepEqual(by['Alvin Apolinario'].scores.map((s) => s.points), [1, 0]);
  assert.deepEqual(by['Robin Padilla'].scores.map((s) => [s.points, s.fighting]), [[0, false], [null, true]]);
  assert.deepEqual(by.Bong.scores.map((s) => [s.points, s.fighting]), [[null, true], [null, false]]);
  await op.post(`${base}/matches/${m3.id}/result`, { result: 'DRAW' });
  list = (await op.get(`${base}/entry-scores`)).body;
  assert.deepEqual(list.find((e) => e.entryName === 'Robin Padilla').scores.map((s) => s.points), [0, 0.5]);
  assert.equal(list.length, 4);
  const csv = await op.agent.get('/reports/scores?format=csv');
  assert.match(csv.text, /#1 Alvin Apolinario,Alvin Apolinario,1,0/);
});
