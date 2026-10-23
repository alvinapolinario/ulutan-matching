'use strict';
const { badRequest, notFound, EVENT_STATUSES, EVENT_TRANSITIONS, now, cleanText } = require('../lib/common');
const { addAudit, bumpVersion } = require('./audit');

function createEventService(store, bus) {
  function parseSettings(input, isCreate) {
    const out = {};
    if (isCreate || input.name !== undefined) {
      out.name = cleanText(input.name, 120);
      if (!out.name) throw badRequest('Event name is required.');
    }
    if (isCreate || input.date !== undefined) {
      out.date = cleanText(input.date, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw badRequest('Event date must be YYYY-MM-DD.');
    }
    if (isCreate || input.venue !== undefined) out.venue = cleanText(input.venue, 160);
    if (isCreate || input.startingFightNumber !== undefined) {
      const n = Number(input.startingFightNumber ?? 1);
      if (!Number.isInteger(n) || n < 1 || n > 9999) throw badRequest('Starting fight number must be between 1 and 9999.');
      out.startingFightNumber = n;
    }
    if (isCreate || input.maxLegbands !== undefined) {
      const n = Number(input.maxLegbands ?? 500);
      if (!Number.isInteger(n) || n < 2 || n > 999) throw badRequest('Maximum legbands must be between 2 and 999.');
      out.maxLegbands = n;
    }
    if (isCreate || input.legbandMode !== undefined) {
      out.legbandMode = input.legbandMode === undefined ? 'MANUAL' : String(input.legbandMode).toUpperCase();
      if (!['MANUAL', 'AUTO'].includes(out.legbandMode)) throw badRequest('Legband numbering must be MANUAL or AUTO.');
    }
    if (isCreate || input.fightNumberMode !== undefined) {
      out.fightNumberMode = input.fightNumberMode === undefined ? 'DRAW' : String(input.fightNumberMode).toUpperCase();
      if (!['DRAW', 'AUTO'].includes(out.fightNumberMode)) throw badRequest('Fight number mode must be DRAW (bunot) or AUTO.');
    }
    if (input.upcomingCount !== undefined) {
      const n = Number(input.upcomingCount);
      if (!Number.isInteger(n) || n < 0 || n > 20) throw badRequest('Upcoming fights on TV must be between 0 and 20.');
      out.upcomingCount = n;
    }
    return out;
  }

  const svc = {
    list: () => [...store.data.events].sort((a, b) => b.id - a.id),
    get(id) {
      const ev = store.data.events.find((e) => e.id === Number(id));
      if (!ev) throw notFound('Event not found.');
      return ev;
    },
    find: (id) => store.data.events.find((e) => e.id === Number(id)) || null,
    defaultEvent() {
      return svc.list().find((e) => e.status !== 'ARCHIVED') || null;
    },

    create(input, userId) {
      const s = parseSettings(input, true);
      return store.transaction((d) => {
        const ev = {
          id: store.nextId(d, 'event'),
          name: s.name, date: s.date, venue: s.venue,
          status: 'DRAFT',
          fightNumberMode: s.fightNumberMode,
          legbandMode: s.legbandMode,
          startingFightNumber: s.startingFightNumber,
          nextFightNumber: s.startingFightNumber,
          nextEntryNumber: 1,
          nextLegbandNumber: 1,
          maxLegbands: s.maxLegbands,
          legbandWidth: 3,
          stateVersion: 1,
          display: { currentMatchId: null, published: true, upcomingCount: s.upcomingCount ?? 8 },
          createdBy: userId, createdAt: now(), updatedAt: now(),
        };
        d.events.push(ev);
        addAudit(store, d, { eventId: ev.id, entity: 'event', entityId: ev.id, action: 'EVENT_CREATED', newValues: s, userId });
        return ev;
      });
    },

    update(id, input, userId) {
      const s = parseSettings(input, false);
      const ev = store.transaction((d) => {
        const e = d.events.find((x) => x.id === Number(id));
        if (!e) throw notFound('Event not found.');
        if (e.status === 'ARCHIVED') throw badRequest('This event is archived. Restore it to COMPLETED before editing it.');
        const usedFights = d.matches.some((m) => m.eventId === e.id);
        const old = {};
        for (const k of Object.keys(s)) {
          if (k === 'upcomingCount') { old[k] = e.display.upcomingCount; e.display.upcomingCount = s[k]; continue; }
          old[k] = e[k];
          if (k === 'startingFightNumber') {
            if (usedFights && s[k] !== e[k]) throw badRequest('Starting fight number cannot change after matches exist.');
            e.nextFightNumber = s[k];
          }
          if (k === 'maxLegbands') {
            const issued = Math.max(d.legbands.filter((l) => l.eventId === e.id).length, e.nextLegbandNumber - 1);
            if (s[k] < issued) throw badRequest(`Maximum legbands cannot be below the ${issued} already registered.`);
          }
          e[k] = s[k];
        }
        e.updatedAt = now();
        bumpVersion(d, e.id);
        addAudit(store, d, { eventId: e.id, entity: 'event', entityId: e.id, action: 'EVENT_UPDATED', oldValues: old, newValues: s, userId });
        return e;
      });
      bus.publish(ev.id, 'event:updated', { eventId: ev.id });
      return ev;
    },

    setStatus(id, status, userId, reason) {
      if (!EVENT_STATUSES.includes(status)) throw badRequest('Invalid event status.');
      const note = cleanText(reason, 300);
      const before = store.data.events.find((x) => x.id === Number(id));
      const ev = store.transaction((d) => {
        const e = d.events.find((x) => x.id === Number(id));
        if (!e) throw notFound('Event not found.');
        if (e.status === status) return e;
        if (!EVENT_TRANSITIONS[e.status].includes(status)) {
          throw badRequest(`Cannot change event from ${e.status} to ${status}. Allowed: ${EVENT_TRANSITIONS[e.status].join(', ')}.`);
        }
        const old = e.status;
        e.status = status;
        e.updatedAt = now();
        if (status === 'ARCHIVED') e.archivedAt = e.updatedAt;
        bumpVersion(d, e.id);
        addAudit(store, d, { eventId: e.id, entity: 'event', entityId: e.id, action: 'EVENT_STATUS_CHANGED', oldValues: { status: old }, newValues: { status }, reason: note || null, userId });
        return e;
      });
      if (before && before.status !== 'ARCHIVED' && ev.status === 'ARCHIVED') {
        const file = svc._writeArchive(ev);
        store.transaction((d) => {
          const e = d.events.find((x) => x.id === ev.id);
          e.archiveFile = file;
          return e;
        });
        ev.archiveFile = file;
      }
      bus.publish(ev.id, 'event:updated', { eventId: ev.id });
      return ev;
    },

    /** Copy one event's records into data/archives. The live database keeps them so reports still open. */
    _writeArchive(ev) {
      const d = store.data;
      const entries = d.entries.filter((e) => e.eventId === ev.id);
      const owners = new Set(entries.map((e) => e.participantId));
      return store.saveArchive(`event-${ev.id}-${ev.name}`, {
        archivedAt: ev.archivedAt,
        event: ev,
        participants: d.participants.filter((p) => owners.has(p.id)).map((p) => ({ id: p.id, name: p.name })),
        entries,
        legbands: d.legbands.filter((l) => l.eventId === ev.id),
        matches: d.matches.filter((m) => m.eventId === ev.id),
        auditLogs: d.auditLogs.filter((a) => a.eventId === ev.id),
      });
    },
  };
  return svc;
}

module.exports = { createEventService };
