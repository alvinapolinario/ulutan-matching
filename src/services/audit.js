'use strict';
const { now } = require('../lib/common');

/** Append an audit record inside a transaction draft. */
function addAudit(store, draft, { eventId = null, entity, entityId = null, matchId = null, action, oldValues = null, newValues = null, reason = null, userId = null }) {
  draft.auditLogs.push({
    id: store.nextId(draft, 'audit'),
    eventId, entity, entityId, matchId, action,
    oldValues, newValues, reason: reason || null,
    performedBy: userId, createdAt: now(),
  });
}

/** Bump the per-event version used by clients to detect stale state. */
function bumpVersion(draft, eventId) {
  const ev = draft.events.find((e) => e.id === eventId);
  if (ev) ev.stateVersion = (ev.stateVersion || 0) + 1;
  return ev ? ev.stateVersion : 0;
}

module.exports = { addAudit, bumpVersion };
