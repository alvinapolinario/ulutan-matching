'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login } = require('./helpers');

test('cocks per entry: default 2, settable 2-5, validated', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const ev = await admin.get(`/api/events/${ctx.eventId}`);
  assert.equal(ev.body.cocksPerEntry, 2, 'new events default to 2');
  for (const bad of [1, 6, 2.5, 'x']) {
    const r = await admin.patch(`/api/events/${ctx.eventId}`, { cocksPerEntry: bad });
    assert.equal(r.status, 400, `cocksPerEntry=${bad} is refused`);
  }
  const ok = await admin.patch(`/api/events/${ctx.eventId}`, { cocksPerEntry: 4 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cocksPerEntry, 4);
  const created = await admin.post('/api/events', { name: 'Five-cock', date: '2026-11-20', cocksPerEntry: 5 });
  assert.equal(created.body.cocksPerEntry, 5);
});

test('cocks per entry: AUTO legbands, incomplete entries, score boxes and reports follow the setting', async (t) => {
  const ctx = await setup({ status: 'ACTIVE' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await admin.patch(base, { cocksPerEntry: 3 });

  const a = await admin.post(`${base}/entries`, { participantName: 'Alpha' }); // default: full entry
  assert.equal(a.status, 201);
  assert.deepEqual(a.body.legbands.map((l) => l.number), ['001', '002', '003']);
  assert.equal(a.body.legband3.number, '003');
  assert.equal(a.body.displayStatus, 'COMPLETE');

  const b = await admin.post(`${base}/entries`, { participantName: 'Bravo', legbandCount: 2 });
  assert.equal(b.body.displayStatus, 'INCOMPLETE');
  assert.equal(b.body.legbands.length, 3);
  assert.equal(b.body.legbands[2], null);
  const done = await admin.post(`${base}/entries/${b.body.id}/legbands`);
  assert.equal(done.body.legbands[2].number, '006');
  assert.equal(done.body.displayStatus, 'COMPLETE');
  assert.equal((await admin.post(`${base}/entries/${b.body.id}/legbands`)).status, 409, 'no 4th legband');
  assert.equal((await admin.post(`${base}/entries`, { participantName: 'X', legbandCount: 4 })).status, 400);

  // Cannot go back below what an entry already has.
  const lower = await admin.patch(base, { cocksPerEntry: 2 });
  assert.equal(lower.status, 400);
  assert.match(lower.body.error, /cannot be below 3/);

  // Three fights for Alpha fill three score boxes in result order.
  for (const [red, blue, result] of [['001', '004', 'RED'], ['002', '005', 'DRAW'], ['003', '006', 'BLUE']]) {
    const m = await admin.post(`${base}/matches`, { red, blue, idempotencyKey: `cocks-test-${red}` });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const r = await admin.post(`${base}/matches/${m.body.match.id}/result`, { result });
    assert.ok(r.status < 300, JSON.stringify(r.body));
  }
  const scores = (await admin.get(`${base}/entry-scores`)).body;
  const alpha = scores.find((e) => e.entryName === 'Alpha');
  assert.deepEqual(alpha.scores.map((s) => s.points), [1, 0.5, 0]);
  assert.equal(alpha.total, 1.5);

  const sr = ctx.services.reports.build('scores', ctx.eventId);
  assert.deepEqual(sr.columns.map((c) => c.label).slice(-3), ['Score 1', 'Score 2', 'Score 3']);
  const reg = ctx.services.reports.build('registration', ctx.eventId);
  assert.ok(reg.columns.some((c) => c.label === 'Legband 3'));
  assert.equal(ctx.services.registration.summary(ctx.eventId).incompleteEntries, 0);
});

test('cocks per entry: MANUAL typed legbands for 5 cocks', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN', legbandMode: 'MANUAL' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await admin.patch(base, { cocksPerEntry: 5 });

  const a = await op.post(`${base}/entries`, { participantName: 'Five', legbands: ['11', '12', '13', '14', '15'] });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(a.body.legbands.map((l) => l.number), ['011', '012', '013', '014', '015']);
  assert.equal(a.body.displayStatus, 'COMPLETE');

  // Old field names still work, blanks are skipped and added later.
  const b = await op.post(`${base}/entries`, { participantName: 'Partial', legband1: '21', legband3: '23' });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.deepEqual(b.body.legbands.map((l) => (l ? l.number : null)), ['021', '023', null, null, null]);

  const dup = await op.post(`${base}/entries`, { participantName: 'Dup', legbands: ['31', '32', '31'] });
  assert.equal(dup.status, 400);
  assert.equal(dup.body.details.field, 'legband3');

  const taken = await op.post(`${base}/entries`, { participantName: 'Taken', legbands: ['41', '13'] });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.details.field, 'legband2');

  // Correct legband 4 of the first entry.
  const ed = await op.patch(`${base}/entries/${a.body.id}`, { legbands: [null, null, null, '44', null] });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.legbands[3].number, '044');
});

test('cocks per entry: old events without the setting behave as 2', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN' });
  t.after(ctx.stop);
  ctx.store.transaction((d) => { delete d.events.find((e) => e.id === ctx.eventId).cocksPerEntry; });
  const op = await login(ctx, 'op', 'op1234');
  const a = await op.post(`/api/events/${ctx.eventId}/entries`, { participantName: 'Legacy' });
  assert.equal(a.body.legbands.length, 2);
  assert.equal(a.body.displayStatus, 'COMPLETE');
});
