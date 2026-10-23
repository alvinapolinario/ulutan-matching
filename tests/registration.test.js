'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login } = require('./helpers');

test('registration: auto-numbered entries and legbands with leading zeros', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  const a = await op.post(`${base}/entries`, { participantName: 'Alvin Apolinario', entryName: 'Alvin A', address: '  Brgy. Tambo,   Iligan City ', legbandCount: 2 });
  assert.equal(a.status, 201);
  assert.equal(a.body.address, 'Brgy. Tambo, Iligan City');
  assert.equal(a.body.entryNumber, 1);
  assert.equal(a.body.legband1.number, '001');
  assert.equal(a.body.legband2.number, '002');
  const b = await op.post(`${base}/entries`, { participantName: 'Joel Villanueva', legbandCount: 2 });
  assert.equal(b.body.entryNumber, 2);
  assert.equal(b.body.entryName, 'Joel Villanueva', 'entry name defaults to owner name');
  assert.deepEqual([b.body.legband1.number, b.body.legband2.number], ['003', '004']);
  // Same owner, second entry -> same participant id
  const c = await op.post(`${base}/entries`, { participantName: '  alvin   apolinario ', entryName: 'Alvin B' });
  assert.equal(c.body.participantId, a.body.participantId);
  // Lookup keeps the string form and accepts short input
  const ed = await op.patch(`${base}/entries/${a.body.id}`, { address: 'Brgy. Tibanga, Iligan City' });
  assert.equal(ed.body.address, 'Brgy. Tibanga, Iligan City');
  assert.equal((await op.get(`${base}/legbands/1`)).body.entry.address, 'Brgy. Tibanga, Iligan City');
  assert.equal((await op.get(`${base}/entries?q=tibanga`)).body.length, 1);
  const lk = await op.get(`${base}/legbands/5`);
  assert.equal(lk.status, 200);
  assert.equal(lk.body.number, '005');
  assert.equal(lk.body.entry.entryName, 'Alvin B');
  assert.equal(lk.body.available, true);
  const missing = await op.get(`${base}/legbands/0099`);
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Legband 099 is not registered/);
  const sum = await op.get(`${base}/summary`);
  assert.equal(sum.body.entries, 3);
  assert.equal(sum.body.legbands, 6);
  assert.equal(sum.body.participants, 2);
  assert.equal(sum.body.nextLegband, '007');
});

test('registration: incomplete entry can be completed later; validation', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  const a = await op.post(`${base}/entries`, { participantName: 'Robin', legbandCount: 1 });
  assert.equal(a.body.displayStatus, 'INCOMPLETE');
  assert.equal(a.body.legband2, null);
  await op.post(`${base}/entries`, { participantName: 'Bong', legbandCount: 2 }); // 002, 003
  const done = await op.post(`${base}/entries/${a.body.id}/legbands`);
  assert.equal(done.status, 201);
  assert.equal(done.body.legband2.number, '004', 'next free number, never reused');
  assert.equal(done.body.displayStatus, 'COMPLETE');
  const third = await op.post(`${base}/entries/${a.body.id}/legbands`);
  assert.equal(third.status, 409);
  const bad = await op.post(`${base}/entries`, { participantName: '   ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.details.field, 'participantName');
  const badCount = await op.post(`${base}/entries`, { participantName: 'X', legbandCount: 3 });
  assert.equal(badCount.status, 400);
});

test('registration: maximum legbands enforced', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN', maxLegbands: 5 });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  assert.equal((await op.post(`${base}/entries`, { participantName: 'A' })).status, 201);
  assert.equal((await op.post(`${base}/entries`, { participantName: 'B' })).status, 201);
  const over = await op.post(`${base}/entries`, { participantName: 'C', legbandCount: 2 });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /Only 1 legband/);
  assert.equal((await op.post(`${base}/entries`, { participantName: 'C', legbandCount: 1 })).status, 201);
  const none = await op.post(`${base}/entries`, { participantName: 'D', legbandCount: 1 });
  assert.equal(none.status, 409);
  assert.equal(ctx.store.data.entries.length, 3, 'rejected entries were not saved');
});

test('registration: closed event, withdraw rules, editing permissions', async (t) => {
  const ctx = await setup({ status: 'MATCHING_OPEN' });
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  const a = (await op.post(`${base}/entries`, { participantName: 'A' })).body;
  const b = (await op.post(`${base}/entries`, { participantName: 'B' })).body;
  const c = (await op.post(`${base}/entries`, { participantName: 'C' })).body;
  // Operator can edit an entry with no match
  const ed = await op.patch(`${base}/entries/${a.id}`, { entryName: 'A Prime' });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.entryName, 'A Prime');
  // Match A vs B, then the entry is locked for operators
  const m = await op.post(`${base}/matches`, { red: '001', blue: '003', idempotencyKey: 'key-lock-0001' });
  assert.equal(m.status, 201);
  assert.equal((await op.patch(`${base}/entries/${a.id}`, { entryName: 'Nope' })).status, 403);
  assert.equal((await admin.patch(`${base}/entries/${a.id}`, { entryName: 'Fixed' })).status, 400, 'admin needs a reason');
  const fix = await admin.patch(`${base}/entries/${a.id}`, { entryName: 'Fixed', reason: 'typo' });
  assert.equal(fix.status, 200);
  // Changing owner of A to B's owner makes Fight #1 a same-owner fight; that is allowed (owner may be a placeholder like "-")
  const sameOwner = await admin.patch(`${base}/entries/${a.id}`, { participantName: 'B', reason: 'owner fix' });
  assert.equal(sameOwner.status, 200);
  assert.equal(sameOwner.body.participantName, 'B');
  // Withdraw: only admin, needs reason, not when matched
  assert.equal((await op.post(`${base}/entries/${c.id}/withdraw`, { reason: 'x' })).status, 403);
  assert.equal((await admin.post(`${base}/entries/${c.id}/withdraw`, {})).status, 400);
  assert.equal((await admin.post(`${base}/entries/${b.id}/withdraw`, { reason: 'sick' })).status, 409);
  const w = await admin.post(`${base}/entries/${c.id}/withdraw`, { reason: 'sick' });
  assert.equal(w.body.displayStatus, 'WITHDRAWN');
  const lk = await op.get(`${base}/legbands/005`);
  assert.equal(lk.body.available, false);
  assert.match(lk.body.unavailableReason, /withdrawn/);
  // Event closed for registration
  ctx.services.events.setStatus(ctx.eventId, 'ACTIVE', ctx.adminUser.id);
  ctx.services.events.setStatus(ctx.eventId, 'COMPLETED', ctx.adminUser.id);
  const closed = await op.post(`${base}/entries`, { participantName: 'Late' });
  assert.equal(closed.status, 400);
  assert.equal(closed.body.code, 'EVENT_CLOSED');
  // Audit entries exist
  assert.ok(ctx.store.data.auditLogs.some((x) => x.action === 'ENTRY_CORRECTED' && x.reason === 'typo'));
});

test('registration: legband numbers are scoped to the event', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const ev2 = (await admin.post('/api/events', { name: 'Second', date: '2026-10-18' })).body;
  await admin.post(`/api/events/${ev2.id}/status`, { status: 'REGISTRATION_OPEN' });
  const a = await admin.post(`/api/events/${ctx.eventId}/entries`, { participantName: 'A' });
  const b = await admin.post(`/api/events/${ev2.id}/entries`, { participantName: 'B' });
  assert.equal(a.body.legband1.number, '001');
  assert.equal(b.body.legband1.number, '001');
  const lk = await admin.get(`/api/events/${ev2.id}/legbands/001`);
  assert.equal(lk.body.entry.entryName, 'B');
  const list1 = await admin.get(`/api/events/${ctx.eventId}/entries`);
  assert.equal(list1.body.length, 1);
});
