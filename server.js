'use strict';
const os = require('os');
const path = require('path');
const { createApp } = require('./src/app');

const net = require('net');
const PORT = Number(process.env.PORT || 3080);
const HOST = process.env.HOST || undefined; // undefined = all IPv4 + IPv6 addresses
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

let ctx;
try {
  ctx = createApp({
    dataDir: DATA_DIR,
    secureCookies: process.env.SECURE_COOKIES === 'true',
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
} catch (e) {
  console.error('\nCould not start:', e.message, '\n');
  process.exit(1);
}

ctx.server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already used by another program.`);
    console.error(`Stop that program, or start Ulutan on another port:  PORT=3090 npm start   (Windows: set PORT=3090 && npm start)\n`);
  } else console.error('\nCould not start:', e.message, '\n');
  ctx.store.close();
  process.exit(1);
});

/** Resolve true if some other program already answers on this port (IPv4 or IPv6 localhost). */
function portTaken(port) {
  const probe = (host) => new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(500);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((r) => r.some(Boolean));
}

portTaken(PORT).then((taken) => {
  if (taken) {
    console.error(`\nPort ${PORT} is already used by another program, so Ulutan was not started.`);
    console.error(`Start it on another port instead:  PORT=3090 npm start   (Windows: set PORT=3090 && npm start)\n`);
    ctx.store.close();
    process.exit(1);
  }
  ctx.server.listen(PORT, HOST, () => {
  const addrs = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\nTapad-Tapad / Ulutan system is running.');
  console.log(`  This computer:  http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  LAN:            http://${a}:${PORT}   (TV: http://${a}:${PORT}/display)`);
  console.log(`  Data folder:    ${DATA_DIR}\n`);
  ctx.services.users.scanWeakPasswords().then((weak) => {
    if (weak.length) console.warn(`WARNING: accounts still using a demo/easy password: ${weak.join(', ')} - change them in Users.\n`);
  }).catch(() => {});
  });
});

function shutdown(sig) {
  console.log(`\n${sig} received, shutting down...`);
  try { ctx.store.backupIfDirty(); } catch (_) { /* ignore */ }
  ctx.io.close();
  ctx.server.close(() => { ctx.store.close(); process.exit(0); });
  setTimeout(() => { ctx.store.close(); process.exit(0); }, 3000).unref();
}
// Every change is saved by an all-or-nothing transaction, so the data stays consistent even if
// some unexpected error escapes (for example from a network socket). Log it and keep serving
// rather than taking the fight display down in the middle of an event.
process.on('uncaughtException', (e) => console.error(`[${new Date().toISOString()}] Unexpected error (server keeps running):`, e));
process.on('unhandledRejection', (e) => console.error(`[${new Date().toISOString()}] Unhandled promise rejection (server keeps running):`, e));

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
