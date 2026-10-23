'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, login } = require('./helpers');

test('events: archive keeps the records, writes a copy, and the next event starts clean', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const op = await login(ctx, 'op', 'op1234');
  const base = `/api/events/${ctx.eventId}`;
  await op.post(`${base}/entries`, { participantName: 'Alvin', entryName: 'Alvin' });
  await op.post(`${base}/entries`, { participantName: 'Joel', entryName: 'Joel' });
  assert.equal((await op.post(`${base}/matches`, { red: '001', blue: '003', idempotencyKey: 'archive-key-01' })).status, 201);

  assert.equal((await admin.post(`${base}/status`, { status: 'ARCHIVED' })).status, 400, 'a live event must be completed first');
  await admin.post(`${base}/status`, { status: 'ACTIVE' });
  await admin.post(`${base}/status`, { status: 'COMPLETED' });
  assert.equal((await op.post(`${base}/status`, { status: 'ARCHIVED', note: 'no' })).status, 403);

  const archived = await admin.post(`${base}/status`, { status: 'ARCHIVED', note: 'derby finished' });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.status, 'ARCHIVED');
  assert.ok(archived.body.archiveFile);
  const copy = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'archives', archived.body.archiveFile), 'utf8'));
  assert.equal(copy.entries.length, 2);
  assert.equal(copy.matches.length, 1);
  assert.equal(copy.legbands.length, 4);
  assert.ok(copy.participants.some((p) => p.name === 'Alvin'));
  assert.equal(JSON.stringify(copy).includes('passwordHash'), false);
  assert.equal(ctx.services.events.defaultEvent(), null);

  assert.equal((await admin.post(`${base}/entries`, { participantName: 'Late' })).status, 400);
  assert.equal((await admin.patch(base, { name: 'Renamed' })).status, 400);
  assert.equal((await admin.get(`${base}/matches`)).body.length, 1, 'archived fights stay available in reports');

  const created = await admin.post('/api/events', { name: 'Next Derby', date: '2026-10-24', venue: 'Pit' });
  assert.equal(created.status, 201);
  await admin.post(`/api/events/${created.body.id}/status`, { status: 'REGISTRATION_OPEN' });
  const fresh = await admin.post(`/api/events/${created.body.id}/entries`, { participantName: 'Alvin', legband1: '001', legband2: '002' });
  assert.equal(fresh.status, 201);
  assert.equal(fresh.body.legband1.number, '001', 'legband numbers start again on the new event');
  assert.equal(ctx.services.events.defaultEvent().id, created.body.id);
  const audit = ctx.store.data.auditLogs.find((a) => a.action === 'EVENT_STATUS_CHANGED' && a.newValues && a.newValues.status === 'ARCHIVED');
  assert.equal(audit.reason, 'derby finished');
});
