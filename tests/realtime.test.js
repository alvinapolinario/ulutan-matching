'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { setup, login } = require('./helpers');

function cookieOf(api) {
  const cookies = api.agent.jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
function connect(ctx, api) {
  return io(ctx.url, { extraHeaders: { Cookie: cookieOf(api) }, transports: ['websocket'], reconnection: true, reconnectionDelay: 100, reconnectionDelayMax: 200, forceNew: true });
}
const once = (socket, ev, pred = () => true, ms = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { socket.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
  function h(msg) { if (pred(msg)) { clearTimeout(t); socket.off(ev, h); resolve(msg); } }
  socket.on(ev, h);
});
const join = (s, id) => new Promise((r) => s.emit('join', id, r));
let k = 0;
const key = () => `rt-key-${Date.now()}-${(k += 1)}`;

test('realtime: unauthenticated sockets are refused', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const s = io(ctx.url, { transports: ['websocket'], reconnection: false, forceNew: true });
  const err = await new Promise((r) => s.on('connect_error', r));
  assert.equal(err.message, 'unauthenticated');
  s.close();
});

test('realtime: confirmed match is broadcast after commit with a higher version; rooms isolate events', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const tv = await login(ctx, 'tv', 'tv1234');
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await op.post(`${base}/entries`, { participantName: 'A' });
  await op.post(`${base}/entries`, { participantName: 'B' });
  const other = (await admin.post('/api/events', { name: 'Other', date: '2026-10-18' })).body;

  const display = connect(ctx, tv);
  const otherDisplay = connect(ctx, tv);
  t.after(() => { display.close(); otherDisplay.close(); });
  await once(display, 'connect'); await once(otherDisplay, 'connect');
  const ack = await join(display, ctx.eventId);
  assert.equal(ack.ok, true);
  const v0 = ack.state.version;
  await join(otherDisplay, other.id);
  let leaked = false;
  otherDisplay.on('match:confirmed', () => { leaked = true; });

  const got = once(display, 'display:refresh', (m) => m.version > v0);
  const gotConfirm = once(display, 'match:confirmed');
  const res = await op.post(`${base}/matches`, { red: '001', blue: '003', idempotencyKey: key() });
  assert.equal(res.status, 201);
  const msg = await got;
  const conf = await gotConfirm;
  assert.equal(conf.match.fightNumber, 1);
  assert.equal(msg.state.next.fightNumber, 1);
  // The message is only sent after the data is on disk
  const onDisk = JSON.parse(require('fs').readFileSync(`${ctx.dataDir}/db.json`, 'utf8'));
  assert.equal(onDisk.matches.length, 1);
  // A rejected match produces no broadcast
  let extra = false;
  display.on('match:confirmed', () => { extra = true; });
  const bad = await op.post(`${base}/matches`, { red: '001', blue: '004', idempotencyKey: key() });
  assert.equal(bad.status, 400);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(extra, false);
  assert.equal(leaked, false, 'other event room received nothing');
  // Confirming a match does not change the current fight
  assert.equal(msg.state.current, null);
});

test('realtime: display recovers authoritative state after reconnect', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const op = await login(ctx, 'op', 'op1234');
  const tv = await login(ctx, 'tv', 'tv1234');
  const base = `/api/events/${ctx.eventId}`;
  for (const p of ['A', 'B', 'C', 'D']) await op.post(`${base}/entries`, { participantName: p });
  const display = connect(ctx, tv);
  t.after(() => display.close());
  await once(display, 'connect');
  await join(display, ctx.eventId);
  // Drop the connection, change data while offline, then reconnect
  const dropped = once(display, 'disconnect');
  const back = once(display, 'connect', () => true, 8000);
  display.io.engine.close();
  await dropped;
  await op.post(`${base}/matches`, { red: '001', blue: '003', idempotencyKey: key() });
  await op.post(`${base}/matches`, { red: '005', blue: '007', idempotencyKey: key() });
  await op.post(`${base}/display/advance`, { direction: 'next' });
  await back;
  const ack = await join(display, ctx.eventId);
  assert.equal(ack.state.current.fightNumber, 1);
  assert.equal(ack.state.next.fightNumber, 2);
  const http = (await tv.get(`${base}/display-state`)).body;
  assert.equal(http.version, ack.state.version);
});
