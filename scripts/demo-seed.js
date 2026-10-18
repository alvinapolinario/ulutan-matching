'use strict';
/**
 * Creates a demo event with 12 entries so you can try the system.
 * Usage: npm run demo   (server must be STOPPED while this runs)
 * Creates users admin/admin123, operator/operator123, tv/tv1234 if no users exist.
 */
const path = require('path');
const { createApp } = require('../src/app');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const ctx = createApp({ dataDir, backupIntervalMs: 0 });
const { users, events, registration } = ctx.services;
try {
  let admin = ctx.store.data.users.find((u) => u.role === 'ADMIN');
  if (!admin) {
    admin = users.create({ username: 'admin', password: 'admin123', role: 'ADMIN' });
    users.create({ username: 'operator', password: 'operator123', role: 'OPERATOR' });
    users.create({ username: 'tv', password: 'tv1234', role: 'DISPLAY' });
    console.log('Users created: admin/admin123, operator/operator123, tv/tv1234 (change these passwords!)');
  }
  const ev = events.create({ name: 'Demo Ulutan Derby', date: new Date().toLocaleDateString('en-CA'), venue: 'Barangay Cockpit Arena', startingFightNumber: 1, maxLegbands: 500 }, admin.id);
  events.setStatus(ev.id, 'REGISTRATION_OPEN', admin.id);
  events.setStatus(ev.id, 'MATCHING_OPEN', admin.id);
  const owners = [
    ['Mang Ramon', 'Ramon Gamefarm'], ['Mang Ramon', 'Ramon Gamefarm 2'], ['Kuya Jun', 'JR Farm'], ['Tata Berto', 'Berto Lines'],
    ['Aling Nena', 'Nena Roosters'], ['Kap. Dado', 'Dado Kennel'], ['Boy Santos', 'Santos Breeders'], ['Doc Mike', 'Doc Mike GF'],
    ['Ka Lito', 'Lito Fighters'], ['Pareng Eddie', 'Eddie Native'], ['Manong Sid', 'Sid Gamefowl'], ['Ate Liza', 'Liza Farm'],
  ];
  owners.forEach(([p, n], i) => registration.register(ev.id, { participantName: p, entryName: n, legband1: String(i * 2 + 1).padStart(3, '0'), legband2: String(i * 2 + 2).padStart(3, '0') }, admin.id));
  console.log(`Demo event #${ev.id} created with ${owners.length} entries (legbands 001-${String(owners.length * 2).padStart(3, '0')}).`);
} finally {
  ctx.store.close();
  ctx.server.close();
  ctx.io.close();
}
