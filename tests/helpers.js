'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ulutan-test-')); }

/** Start a full app on a random port with a fresh JSON database. */
async function startApp({ dataDir = tempDir() } = {}) {
  const ctx = createApp({ dataDir, backupIntervalMs: 0 });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  ctx.port = ctx.server.address().port;
  ctx.url = `http://127.0.0.1:${ctx.port}`;
  ctx.dataDir = dataDir;
  ctx.stop = () => new Promise((r) => { ctx.io.close(); ctx.server.close(() => { ctx.store.close(); r(); }); });
  return ctx;
}

const tokenFrom = (html) => {
  const m = /name="csrf-token" content="([^"]+)"/.exec(html) || /name="_csrf" value="([^"]+)"/.exec(html);
  return m && m[1];
};

/** Log in and return a supertest agent plus the CSRF token for API calls. */
async function login(ctx, username, password) {
  const agent = request.agent(ctx.url);
  const page = await agent.get('/login');
  const t1 = tokenFrom(page.text);
  const res = await agent.post('/login').type('form').send({ _csrf: t1, username, password, next: '/' });
  if (res.status !== 302) throw new Error(`login failed for ${username}: ${res.status}`);
  const home = await agent.get('/login'); // any page renders a fresh token for the new session
  const token = tokenFrom(home.text);
  const api = {
    agent, token,
    get: (url) => agent.get(url).set('Accept', 'application/json'),
    post: (url, body) => agent.post(url).set('X-CSRF-Token', token).set('Accept', 'application/json').send(body || {}),
    patch: (url, body) => agent.patch(url).set('X-CSRF-Token', token).set('Accept', 'application/json').send(body || {}),
  };
  return api;
}

/** Fresh app + admin + operator + an event open for matching. */
async function setup({ status = 'MATCHING_OPEN', maxLegbands = 500, fightNumberMode = 'AUTO' } = {}) {
  const ctx = await startApp();
  const admin = ctx.services.users.create({ username: 'admin', password: 'admin123', role: 'ADMIN' });
  ctx.services.users.create({ username: 'op', password: 'op1234', role: 'OPERATOR' });
  ctx.services.users.create({ username: 'tv', password: 'tv1234', role: 'DISPLAY' });
  const ev = ctx.services.events.create({ name: 'Test Derby', date: '2026-10-17', venue: 'Pit', startingFightNumber: 1, maxLegbands, fightNumberMode }, admin.id);
  const path = ['DRAFT', 'REGISTRATION_OPEN', 'MATCHING_OPEN', 'ACTIVE'];
  for (const s of path.slice(1, path.indexOf(status) + 1)) ctx.services.events.setStatus(ev.id, s, admin.id);
  ctx.eventId = ev.id;
  ctx.adminUser = admin;
  return ctx;
}

module.exports = { startApp, login, setup, tempDir, tokenFrom };
