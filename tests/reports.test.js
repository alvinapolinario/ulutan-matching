'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login } = require('./helpers');

test('reports: all reports render; CSV keeps leading zeros; audit is admin-only', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await op.post(`${base}/entries`, { participantName: 'Alvin, "The Boss"' });
  await op.post(`${base}/entries`, { participantName: 'Joel' });
  const m = (await op.post(`${base}/matches`, { red: '001', blue: '003', idempotencyKey: 'report-key-1' })).body.match;
  await op.post(`${base}/matches`, { red: '002', blue: '004', idempotencyKey: 'report-key-2' });
  await admin.post(`${base}/matches/${m.id}/cancel`, { reason: 'test' });

  for (const key of ['registration', 'legbands', 'available', 'fights', 'cancelled', 'sequence', 'standings', 'summary']) {
    const html = await op.agent.get(`/reports/${key}`);
    assert.equal(html.status, 200, key);
    assert.match(html.text, /Test Derby/);
  }
  const csv = await op.agent.get('/reports/registration?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.text.startsWith('﻿'), 'UTF-8 BOM for Excel');
  assert.match(csv.text, /"=""001"""/);
  assert.match(csv.text, /"Alvin, ""The Boss"""/);
  const cancelled = await op.agent.get('/reports/cancelled?format=csv');
  assert.match(cancelled.text, /test/);
  assert.equal((await op.agent.get('/reports/audit')).status, 403);
  const audit = await admin.agent.get('/reports/audit');
  assert.equal(audit.status, 200);
  assert.match(audit.text, /MATCH_CANCELLED/);
  assert.equal((await op.agent.get('/reports/nope')).status, 404);
});

test('pages: every operator page renders; display user is sent to /display', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  for (const p of ['/', '/registration', '/matching', '/fights', '/display-control', '/reports', '/events', '/users', '/display']) {
    const r = await admin.agent.get(p);
    assert.equal(r.status, 200, p);
  }
  const op = await login(ctx, 'op', 'op1234');
  assert.equal((await op.agent.get('/users')).status, 403);
  const tv = await login(ctx, 'tv', 'tv1234');
  const r = await tv.agent.get('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/display');
  const sw = await tv.agent.get('/registration');
  assert.equal(sw.status, 302, 'display account is sent to log in with a staff account');
  assert.match(sw.headers.location, /\/login\?switch=1&next=%2Fregistration/);
  const lp = await tv.agent.get(sw.headers.location);
  assert.match(lp.text, /logged in as &#34;tv&#34;/);
  assert.equal((await tv.post('/api/events/1/entries', { participantName: 'x' })).status, 403, 'API still refuses the display role');
});
