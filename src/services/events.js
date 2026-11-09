'use strict';
const {
  badRequest, notFound, EVENT_STATUSES, EVENT_TRANSITIONS, now, cleanText,
  MIN_PER_ENTRY, MAX_PER_ENTRY, DERBY_MIN_PER_ENTRY, perEntry, EVENT_TYPES, eventType,
  BIRD_TYPES, BIRD_LABEL, birdType,
} = require('../lib/common');
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
    // DERBY: every entry has at least 3 birds. HACKFIGHT: the original rules (2 per entry unless changed).
    if (isCreate || input.eventType !== undefined) {
      out.eventType = input.eventType === undefined || input.eventType === null || input.eventType === '' ? 'HACKFIGHT' : String(input.eventType).toUpperCase();
      if (!EVENT_TYPES.includes(out.eventType)) throw badRequest('Event type must be DERBY or HACKFIGHT.');
    }
    if (isCreate || input.cocksPerEntry !== undefined) {
      const fallback = out.eventType === 'DERBY' ? DERBY_MIN_PER_ENTRY : 2;
      const n = Number(input.cocksPerEntry === undefined || input.cocksPerEntry === null || input.cocksPerEntry === '' ? fallback : input.cocksPerEntry);
      if (!Number.isInteger(n) || n < MIN_PER_ENTRY || n > MAX_PER_ENTRY) throw badRequest(`Birds per entry must be between ${MIN_PER_ENTRY} and ${MAX_PER_ENTRY}.`);
      out.cocksPerEntry = n;
    }
    // Types of bird allowed in the event (at least one). Default: all three.
    if (isCreate || input.allowedTypes !== undefined) {
      const raw = input.allowedTypes === undefined || input.allowedTypes === null || input.allowedTypes === '' ? BIRD_TYPES
        : (Array.isArray(input.allowedTypes) ? input.allowedTypes : String(input.allowedTypes).split(','));
      const list = raw.map((t) => String(t).trim().toUpperCase()).filter(Boolean);
      const bad = list.find((t) => !BIRD_TYPES.includes(t));
      if (bad) throw badRequest(`Unknown type of bird "${bad}". Choose from Cock, Stag and Bullstag.`);
      if (!list.length) throw badRequest('Choose at least one type of bird for the event.');
      out.allowedTypes = BIRD_TYPES.filter((t) => list.includes(t));
    }
    // Weight rules for cocks, switched on or off. When on, the tolerance is the largest allowed
    // difference in grams; min / max weight are optional.
    if (input.weightEnabled !== undefined) out.weightEnabled = input.weightEnabled === true || input.weightEnabled === 'true' || input.weightEnabled === 'on' || input.weightEnabled === 1;
    const grams = (key, label, max) => {
      if (!isCreate && input[key] === undefined) return;
      const v = input[key];
      if (v === undefined || v === null || v === '') { out[key] = null; return; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${label} must be a whole number of grams from 0 to ${max}, or blank.`);
      out[key] = n;
    };
    grams('weightTolerance', 'Weight tolerance', 2000);
    grams('minWeight', 'Minimum weight', 20000);
    grams('maxWeight', 'Maximum weight', 20000);
    // Made through the API without the switch: on when a tolerance is given (as before the switch existed).
    if (isCreate && out.weightEnabled === undefined) out.weightEnabled = out.weightTolerance != null;
    if (input.upcomingCount !== undefined) {
      const n = Number(input.upcomingCount);
      if (!Number.isInteger(n) || n < 0 || n > 20) throw badRequest('Upcoming fights on TV must be between 0 and 20.');
      out.upcomingCount = n;
    }
    return out;
  }
  /** Check the weight settings an event will have after a create / update. */
  function checkWeightSettings(after) {
    const on = after.weightEnabled === undefined ? after.weightTolerance != null : after.weightEnabled;
    if (on && after.weightTolerance == null) throw badRequest('Enter the weight tolerance (± grams), or switch the weight rules off.');
    if (after.minWeight != null && after.maxWeight != null && after.minWeight > after.maxWeight) throw badRequest('Minimum weight cannot be above the maximum weight.');
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
      if (s.eventType === 'DERBY' && s.cocksPerEntry < DERBY_MIN_PER_ENTRY) throw badRequest(`A derby needs at least ${DERBY_MIN_PER_ENTRY} birds per entry.`);
      checkWeightSettings(s);
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
          eventType: s.eventType,
          cocksPerEntry: s.cocksPerEntry,
          allowedTypes: s.allowedTypes,
          weightEnabled: s.weightEnabled,
          weightTolerance: s.weightTolerance,
          minWeight: s.minWeight,
          maxWeight: s.maxWeight,
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
        // Turning an event into a derby raises birds per entry to the derby minimum (raising is always allowed).
        const typeAfter = s.eventType || eventType(e);
        if (typeAfter === 'DERBY') {
          if (s.cocksPerEntry !== undefined && s.cocksPerEntry < DERBY_MIN_PER_ENTRY) throw badRequest(`A derby needs at least ${DERBY_MIN_PER_ENTRY} birds per entry.`);
          if (s.cocksPerEntry === undefined && perEntry(e) < DERBY_MIN_PER_ENTRY) s.cocksPerEntry = DERBY_MIN_PER_ENTRY;
        }
        // API callers without the switch: setting a tolerance turns the rules on, clearing it turns them off.
        if (s.weightEnabled === undefined && s.weightTolerance !== undefined) s.weightEnabled = s.weightTolerance != null;
        const pick = (k) => (s[k] !== undefined ? s[k] : e[k]);
        checkWeightSettings({ weightEnabled: s.weightEnabled !== undefined ? s.weightEnabled : (e.weightEnabled === undefined ? e.weightTolerance != null : e.weightEnabled), weightTolerance: pick('weightTolerance'), minWeight: pick('minWeight'), maxWeight: pick('maxWeight') });
        if (s.allowedTypes) {
          // A type cannot be removed while birds of that type are registered.
          const used = new Set(d.legbands.filter((l) => l.eventId === e.id && l.status !== 'WITHDRAWN').map((l) => birdType(l)));
          const lost = [...used].find((t) => !s.allowedTypes.includes(t));
          if (lost) throw badRequest(`${BIRD_LABEL[lost]}s are already registered in this event, so ${BIRD_LABEL[lost]} must stay allowed.`);
        }
        const old = {};
        for (const k of Object.keys(s)) {
          if (k === 'upcomingCount') { old[k] = e.display.upcomingCount; e.display.upcomingCount = s[k]; continue; }
          if (k === 'cocksPerEntry') {
            old[k] = perEntry(e);
            // Never fewer slots than an entry already uses.
            const own = d.legbands.filter((l) => l.eventId === e.id);
            const most = own.reduce((m, l) => Math.max(m, l.slot || 0), 0);
            if (s[k] < most) throw badRequest(`Birds per entry cannot be below ${most}: an entry already has ${most} birds.`);
            e[k] = s[k];
            continue;
          }
          old[k] = e[k];
          if (k === 'startingFightNumber') {
            if (usedFights && s[k] !== e[k]) throw badRequest('Starting fight number cannot change after matches exist.');
            e.nextFightNumber = s[k];
          }
          if (k === 'maxLegbands') {
            const issued = Math.max(d.legbands.filter((l) => l.eventId === e.id && l.number).length, e.nextLegbandNumber - 1);
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
