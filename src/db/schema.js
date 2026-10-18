'use strict';
/**
 * Shape of the JSON database and its migrations.
 *
 * users        { id, username, passwordHash, role: ADMIN|OPERATOR|DISPLAY, status: ACTIVE|DISABLED, createdAt }
 * events       { id, name, date, venue, status, fightNumberMode: DRAW|AUTO, legbandMode: MANUAL|AUTO, startingFightNumber, nextFightNumber, nextEntryNumber,
 *                nextLegbandNumber, maxLegbands, legbandWidth, stateVersion,
 *                display: { currentMatchId, published, upcomingCount }, createdBy, createdAt, updatedAt }
 * participants { id, name, nameKey, createdAt, updatedAt }            (owners; shared across events)
 * entries      { id, eventId, participantId, entryNumber, entryName, address, status: ACTIVE|WITHDRAWN, createdAt, updatedAt }
 * legbands     { id, eventId, entryId, slot: 1|2, number: '001', status, matchId, statusReason, createdAt, updatedAt }
 * matches      { id, eventId, fightNumber, sequence, redLegbandId, blueLegbandId, status, result, redPoints,
 *                bluePoints, idempotencyKey, confirmedBy, confirmedAt, cancelledBy, cancelledAt, cancelReason,
 *                completedBy, completedAt, createdAt, updatedAt }
 * auditLogs    { id, eventId, entity, entityId, matchId, action, oldValues, newValues, reason, performedBy, createdAt }
 */
const SCHEMA_VERSION = 3;

function emptyDatabase() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    counters: { user: 0, event: 0, participant: 0, entry: 0, legband: 0, match: 0, audit: 0 },
    users: [],
    events: [],
    participants: [],
    entries: [],
    legbands: [],
    matches: [],
    auditLogs: [],
  };
}

// Each migration upgrades data from version N-1 to N. Add new ones at the end.
const MIGRATIONS = {
  // v2: fight numbers are drawn (raffle) and typed in by the operator unless the event says AUTO.
  2: (data) => { for (const e of data.events) if (!e.fightNumberMode) e.fightNumberMode = 'DRAW'; return data; },
  // v3: legband numbers are typed from the pre-numbered bands (MANUAL). Existing events keep AUTO, as they were created.
  3: (data) => { for (const e of data.events) if (!e.legbandMode) e.legbandMode = 'AUTO'; return data; },
};

function migrate(data) {
  if (typeof data.schemaVersion !== 'number') throw new Error('Database file has no schemaVersion');
  if (data.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Database schema v${data.schemaVersion} is newer than this app (v${SCHEMA_VERSION}). Update the app.`);
  }
  while (data.schemaVersion < SCHEMA_VERSION) {
    const next = data.schemaVersion + 1;
    const step = MIGRATIONS[next];
    if (!step) throw new Error(`Missing migration to schema v${next}`);
    data = step(data);
    data.schemaVersion = next;
  }
  return data;
}

module.exports = { SCHEMA_VERSION, emptyDatabase, migrate };
