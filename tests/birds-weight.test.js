'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, login } = require('./helpers');
const { parseBand, parseWeight } = require('../src/lib/common');

let k = 0;
const key = () => `bird-key-${Date.now()}-${(k += 1)}`;

test('parse helpers: legband / wingband lookups and weights in grams or kilograms', () => {
  assert.deepEqual(parseBand('7'), { by: 'LEG', number: '007' });
  assert.deepEqual(parseBand('LB 12'), { by: 'LEG', number: '012' });
  assert.deepEqual(parseBand('w7'), { by: 'WING', number: '007' });
  assert.deepEqual(parseBand('WB-012'), { by: 'WING', number: '012' });
  assert.equal(parseBand('X7'), null);
  assert.equal(parseWeight(''), null);
  assert.equal(parseWeight('2105'), 2105);
  assert.equal(parseWeight('2,130'), 2130);
  assert.equal(parseWeight('2.105'), 2105);
  assert.equal(parseWeight('2.1kg'), 2100);
  assert.ok(Number.isNaN(parseWeight('heavy')));
  assert.ok(Number.isNaN(parseWeight('0')));
});

test('event type: derby needs at least 3 birds per entry; hackfight keeps the original rules', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  const ev = (await admin.get(base)).body;
  assert.equal(ev.eventType, 'HACKFIGHT', 'events default to the original rules');
  assert.equal(ev.cocksPerEntry, 2);
  assert.equal(ev.weightTolerance, null);

  const derby = await admin.post('/api/events', { name: 'Derby', date: '2026-11-20', eventType: 'DERBY' });
  assert.equal(derby.status, 201);
  assert.equal(derby.body.cocksPerEntry, 3, 'a derby starts at 3 birds per entry');
  assert.equal((await admin.post('/api/events', { name: 'Bad', date: '2026-11-20', eventType: 'DERBY', cocksPerEntry: 2 })).status, 400);
  assert.equal((await admin.post('/api/events', { name: 'Bad', date: '2026-11-20', eventType: 'TOURNAMENT' })).status, 400);
  const five = await admin.post('/api/events', { name: 'Five', date: '2026-11-20', eventType: 'DERBY', cocksPerEntry: 5 });
  assert.equal(five.body.cocksPerEntry, 5);
  assert.equal((await admin.patch(`/api/events/${derby.body.id}`, { cocksPerEntry: 2 })).status, 400, 'derby cannot go below 3');

  // Turning a hackfight (2 per entry) into a derby raises it to 3.
  const switched = await admin.patch(base, { eventType: 'DERBY' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.eventType, 'DERBY');
  assert.equal(switched.body.cocksPerEntry, 3);
  // A derby entry has 3 slots; registering 3 birds completes it.
  const e = await admin.post(`${base}/entries`, { participantName: 'Derby Entry' });
  assert.equal(e.body.legbands.length, 3);
  assert.equal(e.body.displayStatus, 'COMPLETE');
  // Back to hackfight: original rules (2-5) allowed again, but never below what entries have.
  assert.equal((await admin.patch(base, { eventType: 'HACKFIGHT' })).body.cocksPerEntry, 3);
  assert.equal((await admin.patch(base, { cocksPerEntry: 2 })).status, 400);
});

test('registration: type of bird, wingband for stag / bullstag, weight for cock', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN', legbandMode: 'MANUAL' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await admin.patch(base, { eventType: 'DERBY', weightTolerance: 35, minWeight: 1500, maxWeight: 3000 });

  // Cock: weight required (event matches by weight), no wingband. Stag / bullstag: wingband required.
  const a = await admin.post(`${base}/entries`, {
    participantName: 'Ann',
    types: ['COCK', 'STAG', 'BULLSTAG'], legbands: ['1', '2', ''], wingbands: ['', '10', '11'], weights: ['2100', '', '2.25'],
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(a.body.legbands.map((l) => [l.type, l.number, l.wingband, l.weight]), [
    ['COCK', '001', null, 2100], ['STAG', '002', '010', null], ['BULLSTAG', null, '011', 2250],
  ]);
  assert.equal(a.body.displayStatus, 'INCOMPLETE', 'the bullstag still needs its legband');

  const post = (b) => admin.post(`${base}/entries`, { participantName: 'X', ...b });
  let r = await post({ types: ['COCK'], legbands: ['5'] });
  assert.equal(r.body.code, 'WEIGHT_REQUIRED');
  assert.equal(r.body.details.field, 'weight1');
  r = await post({ types: ['STAG'], legbands: ['5'] });
  assert.equal(r.body.code, 'WINGBAND_REQUIRED');
  assert.equal(r.body.details.field, 'wingband1');
  r = await post({ types: ['COCK'], wingbands: ['20'], weights: ['2100'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cock has no wingband/);
  r = await post({ types: ['STAG'], wingbands: ['10'] });
  assert.equal(r.body.code, 'WINGBAND_TAKEN');
  r = await post({ types: ['STAG', 'STAG'], wingbands: ['30', '30'] });
  assert.equal(r.body.details.field, 'wingband2');
  r = await post({ types: ['HEN'], weights: ['2000'] });
  assert.equal(r.status, 400);
  r = await post({ types: ['COCK'], weights: ['1400'] });
  assert.equal(r.body.code, 'WEIGHT_RANGE');

  // The bullstag gets its legband later with "+ Legband".
  const later = await admin.post(`${base}/entries/${a.body.id}/legbands`, { legband: '3' });
  assert.equal(later.status, 201, JSON.stringify(later.body));
  assert.equal(later.body.legbands[2].number, '003');
  assert.equal(later.body.displayStatus, 'COMPLETE');

  // Lookup by legband or by wingband (W + number).
  assert.equal((await admin.get(`${base}/legbands/2`)).body.type, 'STAG');
  assert.equal((await admin.get(`${base}/legbands/W11`)).body.number, '003');
  assert.equal((await admin.get(`${base}/wingbands/10`)).body.number, '002');
  assert.equal((await admin.get(`${base}/wingbands/99`)).status, 404);

  // Edit: change a stag's wingband; turning it into a cock needs a weight.
  const ed = await admin.patch(`${base}/entries/${a.body.id}`, { wingbands: [null, '15', null] });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.legbands[1].wingband, '015');
  const toCock = await admin.patch(`${base}/entries/${a.body.id}`, { types: [null, 'COCK', null] });
  assert.equal(toCock.body.code, 'WEIGHT_REQUIRED');
  const toCock2 = await admin.patch(`${base}/entries/${a.body.id}`, { types: [null, 'COCK', null], weights: [null, '2200', null] });
  assert.equal(toCock2.status, 200, JSON.stringify(toCock2.body));
  assert.deepEqual([toCock2.body.legbands[1].type, toCock2.body.legbands[1].wingband], ['COCK', null], 'a cock drops its wingband');

  const sum = (await admin.get(`${base}/summary`)).body;
  assert.equal(sum.eventType, 'DERBY');
  assert.deepEqual([sum.cocks, sum.stags, sum.bullstags], [2, 0, 1]);
});

test('matching: same type only; cocks by weight; stags by wingband lookup; opponents', async (t) => {
  const ctx = await setup({ status: 'MATCHING_OPEN', legbandMode: 'MANUAL' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await admin.patch(base, { weightTolerance: 35 });
  const reg = (name, birds) => admin.post(`${base}/entries`, {
    participantName: name,
    types: birds.map((b) => b[0]), legbands: birds.map((b) => b[1]), wingbands: birds.map((b) => b[2] || ''), weights: birds.map((b) => b[3] || ''),
  });
  assert.equal((await reg('A', [['COCK', '1', '', '2100'], ['STAG', '2', '20']])).status, 201);
  assert.equal((await reg('B', [['COCK', '3', '', '2130'], ['STAG', '4', '21']])).status, 201);
  assert.equal((await reg('C', [['COCK', '5', '', '2160'], ['BULLSTAG', '6', '22']])).status, 201);
  assert.equal((await reg('D', [['STAG', '', '23']])).status, 201, 'a stag registered without legband yet');

  let r = await admin.post(`${base}/matches/check`, { red: '1', blue: '4' });
  assert.equal(r.body.code, 'TYPE_MISMATCH');
  assert.match(r.body.error, /cock vs cock, stag vs stag, bullstag vs bullstag/);
  r = await admin.post(`${base}/matches/check`, { red: '2', blue: '6' });
  assert.equal(r.body.code, 'TYPE_MISMATCH', 'stag vs bullstag is refused');
  r = await admin.post(`${base}/matches/check`, { red: '1', blue: '5' });
  assert.equal(r.body.code, 'WEIGHT_GAP');
  r = await admin.post(`${base}/matches/check`, { red: '1', blue: '3' });
  assert.equal(r.status, 200);
  assert.equal(r.body.weightDiff, 30);
  // Stag vs stag found by wingband; no weight needed.
  r = await admin.post(`${base}/matches/check`, { red: 'W20', blue: 'W21' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.red.number, '002');
  // A bird without a legband cannot be matched yet.
  r = await admin.post(`${base}/matches/check`, { red: 'W23', blue: 'W20' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no legband yet/);

  const opp = (await admin.get(`${base}/legbands/1/opponents`)).body;
  assert.deepEqual(opp.candidates.map((c) => [c.number, c.diff]), [['003', 30]]);
  const stagOpp = (await admin.get(`${base}/legbands/2/opponents`)).body;
  assert.deepEqual(stagOpp.candidates.map((c) => c.number), ['004'], 'only stags with a legband, not the bullstag');

  const m = await admin.post(`${base}/matches`, { red: '1', blue: '3', idempotencyKey: key() });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal(m.body.match.red.weight, 2100);
  const s = await admin.post(`${base}/matches`, { red: '002', blue: '004', idempotencyKey: key() });
  assert.equal(s.body.match.blue.wingband, '021');

  // Reports carry the birds.
  const fights = ctx.services.reports.build('fights', ctx.eventId);
  assert.equal(fights.rows.find((x) => x.redLb === '001').redWt, '2100 g');
  const reg2 = ctx.services.reports.build('registration', ctx.eventId);
  assert.equal(reg2.rows[0].birds, 'Cock 2100 g / Stag WB 020');
  const lbRep = ctx.services.reports.build('legbands', ctx.eventId);
  assert.ok(lbRep.rows.some((x) => x.type === 'Bullstag' && x.wingband === '022'));
  const gc = ctx.services.reports.build('gamecocks', ctx.eventId);
  assert.ok(gc.rows.some((x) => x.status === 'No legband yet' && x.wingband === '023'));
});

test('derby: an entry fights only once all its birds are registered with legbands', async (t) => {
  const ctx = await setup({ status: 'MATCHING_OPEN', legbandMode: 'MANUAL' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  await admin.patch(base, { eventType: 'DERBY' }); // 3 birds per entry
  const full = await admin.post(`${base}/entries`, { participantName: 'Full', legbands: ['1', '2', '3'] });
  assert.equal(full.body.displayStatus, 'COMPLETE');
  const two = await admin.post(`${base}/entries`, { participantName: 'Two', legbands: ['4', '5'] });
  const third = await admin.post(`${base}/entries`, { participantName: 'Waiting', types: ['COCK', 'COCK', 'STAG'], legbands: ['6', '7', ''], wingbands: ['', '', '9'] });
  assert.equal(third.status, 201, JSON.stringify(third.body));

  // Entry with only 2 of 3 birds: refused on either corner.
  let r = await admin.post(`${base}/matches/check`, { red: '1', blue: '4' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'ENTRY_INCOMPLETE');
  assert.equal(r.body.details.field, 'blue');
  assert.match(r.body.error, /has 2 of 3 birds with legbands/);
  r = await admin.post(`${base}/matches/check`, { red: '6', blue: '1' });
  assert.equal(r.body.code, 'ENTRY_INCOMPLETE', 'a registered bird still waiting for its legband also blocks the entry');
  assert.equal(r.body.details.field, 'red');
  assert.equal((await admin.get(`${base}/legbands/4`)).body.available, false);
  assert.deepEqual((await admin.get(`${base}/legbands/1/opponents`)).body.candidates, [], 'incomplete entries are not offered');

  // Completing the entries opens them for matching.
  await admin.post(`${base}/entries/${two.body.id}/legbands`, { legband: '8' });
  await admin.post(`${base}/entries/${third.body.id}/legbands`, { legband: '10' });
  r = await admin.post(`${base}/matches/check`, { red: '1', blue: '4' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await admin.get(`${base}/legbands/1/opponents`)).body.candidates.map((c) => c.number), ['004', '005', '006', '007', '008']);
  const m = await admin.post(`${base}/matches`, { red: '1', blue: '6', idempotencyKey: key() });
  assert.equal(m.status, 201, JSON.stringify(m.body));

  // A hackfight keeps the original rule: incomplete entries may fight.
  await admin.patch(base, { eventType: 'HACKFIGHT' });
  const h = await admin.post(`${base}/entries`, { participantName: 'Hack', legbands: ['11'] });
  assert.equal(h.status, 201);
  r = await admin.post(`${base}/matches/check`, { red: '11', blue: '2' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('event settings: types of bird allowed and weight rules on / off', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN', legbandMode: 'MANUAL' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');

  // Defaults: all three types, no weight rules (API callers without the settings).
  const plain = (await admin.get(`/api/events/${ctx.eventId}`)).body;
  assert.deepEqual(plain.allowedTypes, ['COCK', 'STAG', 'BULLSTAG']);
  assert.equal(plain.weightEnabled, false);

  // Validation
  const mk = (extra) => admin.post('/api/events', { name: 'E', date: '2026-11-20', eventType: 'DERBY', ...extra });
  assert.equal((await mk({ allowedTypes: [] })).status, 400, 'at least one type');
  assert.equal((await mk({ allowedTypes: ['HEN'] })).status, 400);
  assert.equal((await mk({ weightEnabled: true })).status, 400, 'weight rules on need a tolerance');
  assert.equal((await mk({ weightEnabled: true, weightTolerance: 30, minWeight: 2500, maxWeight: 2000 })).status, 400);

  // A stag derby: only stags and bullstags, weight rules off.
  const stagDerby = await mk({ allowedTypes: ['STAG', 'BULLSTAG'], weightEnabled: false, weightTolerance: 35 });
  assert.equal(stagDerby.status, 201, JSON.stringify(stagDerby.body));
  assert.deepEqual(stagDerby.body.allowedTypes, ['STAG', 'BULLSTAG']);
  const sb = `/api/events/${stagDerby.body.id}`;
  await admin.post(`${sb}/status`, { status: 'REGISTRATION_OPEN' });
  let r = await admin.post(`${sb}/entries`, { participantName: 'S', types: ['COCK'], weights: ['2000'] });
  assert.equal(r.body.code, 'TYPE_NOT_ALLOWED');
  // Blank type = the first allowed type (stag), which needs a wingband.
  r = await admin.post(`${sb}/entries`, { participantName: 'S', legbands: ['1'] });
  assert.equal(r.body.code, 'WINGBAND_REQUIRED');
  r = await admin.post(`${sb}/entries`, { participantName: 'S', legbands: ['1', '2', '3'], wingbands: ['11', '12', '13'], types: ['', 'BULLSTAG', 'STAG'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.legbands.map((l) => l.type), ['STAG', 'BULLSTAG', 'STAG']);
  // Stag cannot be removed now that stags are registered.
  assert.equal((await admin.patch(sb, { allowedTypes: ['BULLSTAG'] })).status, 400);
  assert.equal((await admin.patch(sb, { allowedTypes: ['COCK', 'STAG', 'BULLSTAG'] })).status, 200);

  // Cock derby with weight rules on: weight required, min / max applied. Switching off keeps the
  // numbers but stops the checks.
  const cockDerby = await mk({ allowedTypes: ['COCK'], weightEnabled: true, weightTolerance: 40, minWeight: 1800, maxWeight: 2400 });
  const cb = `/api/events/${cockDerby.body.id}`;
  await admin.post(`${cb}/status`, { status: 'REGISTRATION_OPEN' });
  r = await admin.post(`${cb}/entries`, { participantName: 'C', legbands: ['1'] });
  assert.equal(r.body.code, 'WEIGHT_REQUIRED');
  r = await admin.post(`${cb}/entries`, { participantName: 'C', legbands: ['1'], weights: ['2500'] });
  assert.equal(r.body.code, 'WEIGHT_RANGE');
  r = await admin.post(`${cb}/entries`, { participantName: 'C', types: ['STAG'], legbands: ['1'], wingbands: ['5'] });
  assert.equal(r.body.code, 'TYPE_NOT_ALLOWED');
  const off = await admin.patch(cb, { weightEnabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.weightTolerance, 40, 'the numbers are kept for when the rules are switched on again');
  r = await admin.post(`${cb}/entries`, { participantName: 'C', legbands: ['1'], weights: ['2500'] });
  assert.equal(r.status, 201, 'no weight rules: any weight, or none');
  r = await admin.post(`${cb}/entries`, { participantName: 'D', legbands: ['2'] });
  assert.equal(r.status, 201);
  const sum = ctx.services.reports.build('summary', cockDerby.body.id);
  assert.equal(sum.rows.find((x) => x.item === 'Types of bird allowed').value, 'Cock');
  assert.equal(sum.rows.find((x) => x.item === 'Weight rules (cocks)').value, 'Off');
  await admin.patch(cb, { weightEnabled: true });
  assert.match(ctx.services.reports.build('summary', cockDerby.body.id).rows.find((x) => x.item === 'Weight rules (cocks)').value, /On — ±40 g, 1800–2400 g/);
});

test('automatic legbands: every bird gets the next legband; wingbands are typed', async (t) => {
  const ctx = await setup({ status: 'REGISTRATION_OPEN' });
  t.after(ctx.stop);
  const admin = await login(ctx, 'admin', 'admin123');
  const base = `/api/events/${ctx.eventId}`;
  const a = await admin.post(`${base}/entries`, { participantName: 'Auto', types: ['COCK', 'STAG'], wingbands: ['', '7'] });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(a.body.legbands.map((l) => [l.type, l.number, l.wingband]), [['COCK', '001', null], ['STAG', '002', '007']]);
  const b = await admin.post(`${base}/entries`, { participantName: 'Auto2', legbandCount: 1, types: ['BULLSTAG'], wingbands: ['8'] });
  assert.deepEqual(b.body.legbands.map((l) => (l ? [l.type, l.number] : null)), [['BULLSTAG', '003'], null]);
  // "+ Legband" adds the second bird with its own type / wingband.
  const add = await admin.post(`${base}/entries/${b.body.id}/legbands`, { type: 'STAG', wingband: '9' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.deepEqual([add.body.legbands[1].type, add.body.legbands[1].number, add.body.legbands[1].wingband], ['STAG', '004', '009']);
});
