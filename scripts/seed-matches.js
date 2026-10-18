'use strict';
/**
 * Adds a sample event with 30 entries (60 legbands, 001-060) and 30 confirmed matches
 * with drawn (raffle) fight numbers. Existing events and data are kept.
 *
 * Usage (STOP the server first):   npm run seed
 * Options:  npm run seed -- 20     -> 20 entries / 20 matches
 */
const path = require('path');
const { createApp } = require('../src/app');

const COUNT = Math.max(2, Math.min(200, Number(process.argv[2]) || 30));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

// Small deterministic random generator so the sample is the same every run.
let seed = 20261017;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const OWNERS = [
  'Mang Ramon', 'Kuya Jun', 'Tata Berto', 'Aling Nena', 'Kap. Dado', 'Boy Santos', 'Doc Mike', 'Ka Lito',
  'Pareng Eddie', 'Manong Sid', 'Ate Liza', 'Tito Rudy', 'Mang Caloy', 'Kuya Bert', 'Lolo Pido',
  'Engr. Dante', 'Atty. Ben', 'Mang Tonyo', 'Kap. Nestor', 'Manang Lourdes', 'Mang Isko', 'Kuya Paeng',
  'Tatay Celso', 'Boss Arnel', 'Mang Fred', 'Kuya Romy', 'Ka Andoy', 'Mang Pepe', 'Doc Jojo', 'Mang Gener',
];
const PLACES = ['Brgy. Tambo, Iligan City', 'Brgy. Tibanga, Iligan City', 'Brgy. Pala-o, Iligan City', 'Poblacion, Linamon', 'Brgy. Suarez, Iligan City', 'Kauswagan, Lanao del Norte', 'Brgy. Hinaplanon, Iligan City', 'Tubod, Lanao del Norte', 'Brgy. Santiago, Iligan City', 'Bacolod, Lanao del Norte'];
const FARMS = ['Gamefarm', 'Roosters', 'Fighters', 'Lines', 'Breeders', 'Native', 'Bloodline', 'Kennel', 'Farm', 'Game Fowl'];

let ctx;
try {
  ctx = createApp({ dataDir, backupIntervalMs: 0 });
} catch (e) {
  console.error(`\n${e.message}\nStop the server (Ctrl+C) and run this again.\n`);
  process.exit(1);
}
const { users, events, registration, matches } = ctx.services;

try {
  ctx.store.backupNow('before-seed');
  let admin = ctx.store.data.users.find((u) => u.role === 'ADMIN' && u.status === 'ACTIVE');
  if (!admin) {
    admin = users.create({ username: 'admin', password: 'admin123', role: 'ADMIN' });
    console.log('Created user admin / admin123 (change this password).');
  }
  const n = ctx.store.data.events.length + 1;
  const ev = events.create({
    name: `Sample Derby ${n}`, date: new Date().toLocaleDateString('en-CA'), venue: 'Barangay Cockpit Arena',
    fightNumberMode: 'DRAW', maxLegbands: 500,
  }, admin.id);
  events.setStatus(ev.id, 'REGISTRATION_OPEN', admin.id);
  events.setStatus(ev.id, 'MATCHING_OPEN', admin.id);

  // Entries: the first 5 owners have a second entry (placed far apart so they never meet).
  const entries = [];
  for (let i = 0; i < COUNT; i += 1) {
    const second = i >= COUNT / 2 && i - Math.floor(COUNT / 2) < 5;
    const owner = second ? OWNERS[(i - Math.floor(COUNT / 2)) % OWNERS.length] : OWNERS[i % OWNERS.length] + (i >= OWNERS.length ? ` ${Math.floor(i / OWNERS.length) + 1}` : '');
    const name = `${owner.split(' ').pop()} ${FARMS[i % FARMS.length]}${second ? ' 2' : ''}`;
    entries.push(registration.register(ev.id, { participantName: owner, entryName: name, address: PLACES[i % PLACES.length], legband1: String(i * 2 + 1).padStart(3, '0'), legband2: String(i * 2 + 2).padStart(3, '0') }, admin.id));
  }

  // Pairs: chicken 1 of entry i vs chicken 2 of entry i+1, so every legband fights once.
  const pairs = entries.map((e, i) => {
    const other = entries[(i + 1) % entries.length];
    return rand() < 0.5 ? [e.legband1.number, other.legband2.number] : [other.legband2.number, e.legband1.number];
  });
  // Drawn fight numbers: a shuffled 1..COUNT, matched in random order.
  const drawn = shuffle(Array.from({ length: COUNT }, (_, i) => i + 1));
  let made = 0;
  for (const [i, [red, blue]] of shuffle(pairs.map((p, i) => [i, p]))) {
    matches.confirm(ev.id, { red, blue, fightNumber: drawn[i], idempotencyKey: `seed-${ev.id}-${i}-${Date.now()}` }, admin);
    made += 1;
  }

  console.log(`\nCreated "${ev.name}" (event #${ev.id}): ${entries.length} entries, legbands 001-${String(entries.length * 2).padStart(3, '0')}, ${made} matches (fight #1-#${COUNT}, drawn).`);
  console.log('Start the server (npm start) and pick this event in the top bar.\n');
} catch (e) {
  console.error('\nSeeding failed:', e.message, '\n');
  process.exitCode = 1;
} finally {
  ctx.store.close();
  ctx.io.close();
  ctx.server.close();
}
