'use strict';
const {
  badRequest, notFound, conflict, forbidden, CAN_REGISTER,
  now, pad, nameKey, cleanText, normalizeLegband,
} = require('../lib/common');
const { addAudit, bumpVersion } = require('./audit');

const fightLabel = (n) => (n == null ? '' : `Fight #${pad(n)}`);

/** Build a lookup-friendly description of a legband from a data snapshot. */
function describeLegband(data, lb) {
  const entry = data.entries.find((e) => e.id === lb.entryId);
  const participant = entry && data.participants.find((p) => p.id === entry.participantId);
  const match = lb.matchId ? data.matches.find((m) => m.id === lb.matchId) : null;
  let available = lb.status === 'AVAILABLE' && entry && entry.status === 'ACTIVE';
  let reason = null;
  if (match && match.status !== 'CANCELLED') reason = `Legband ${lb.number} is already matched in ${fightLabel(match.fightNumber)}.`;
  else if (match && match.status === 'CANCELLED') reason = `Legband ${lb.number} was in cancelled ${fightLabel(match.fightNumber)} and can no longer be used.`;
  else if (lb.status === 'WITHDRAWN' || (entry && entry.status === 'WITHDRAWN')) reason = `Legband ${lb.number} is withdrawn.`;
  else if (lb.status !== 'AVAILABLE') reason = `Legband ${lb.number} is ${lb.status.toLowerCase()}.`;
  if (reason) available = false;
  return {
    number: lb.number,
    slot: lb.slot,
    status: lb.status,
    available,
    unavailableReason: reason,
    entry: entry ? { id: entry.id, entryNumber: entry.entryNumber, entryName: entry.entryName, address: entry.address || '', status: entry.status } : null,
    participant: participant ? { id: participant.id, name: participant.name } : null,
    match: match ? { id: match.id, fightNumber: match.fightNumber, status: match.status } : null,
  };
}

function createRegistrationService(store, bus) {
  function requireEvent(d, eventId) {
    const ev = d.events.find((e) => e.id === Number(eventId));
    if (!ev) throw notFound('Event not found.');
    return ev;
  }
  function requireRegistrationOpen(ev) {
    if (!CAN_REGISTER.includes(ev.status)) throw badRequest(`Registration is not open for this event (status: ${ev.status}).`, 'EVENT_CLOSED');
  }
  function findOrCreateParticipant(d, name) {
    const key = nameKey(name);
    let p = d.participants.find((x) => x.nameKey === key);
    if (!p) {
      p = { id: store.nextId(d, 'participant'), name, nameKey: key, createdAt: now(), updatedAt: now() };
      d.participants.push(p);
    }
    return p;
  }
  const isManual = (ev) => (ev.legbandMode || 'MANUAL') === 'MANUAL';
  /** Validate a typed legband number: digits, not already registered in this event. */
  function checkTypedLegband(d, ev, input, field, exceptId = null) {
    const number = normalizeLegband(input, ev.legbandWidth);
    if (!number) throw badRequest('Enter the legband number (digits only).', 'INVALID_LEGBAND', { field });
    const clash = d.legbands.find((l) => l.eventId === ev.id && l.number === number && l.id !== exceptId);
    if (clash) {
      const owner = d.entries.find((e) => e.id === clash.entryId);
      throw conflict(`Legband ${number} is already registered${owner ? ` to Entry #${owner.entryNumber} (${owner.entryName})` : ''}.`, 'LEGBAND_TAKEN', { field });
    }
    return number;
  }
  function issueLegband(d, ev, entryId, slot, typed = null, field = 'legband') {
    const issuedCount = d.legbands.filter((l) => l.eventId === ev.id).length;
    if (issuedCount >= ev.maxLegbands) throw conflict(`All ${ev.maxLegbands} legbands for this event have been registered.`, 'LEGBANDS_EXHAUSTED');
    let number;
    if (typed != null) {
      number = checkTypedLegband(d, ev, typed, field);
    } else {
      if (ev.nextLegbandNumber > ev.maxLegbands) throw conflict(`All ${ev.maxLegbands} legbands for this event have been issued.`, 'LEGBANDS_EXHAUSTED');
      number = pad(ev.nextLegbandNumber, ev.legbandWidth);
      while (d.legbands.some((l) => l.eventId === ev.id && l.number === number)) { ev.nextLegbandNumber += 1; number = pad(ev.nextLegbandNumber, ev.legbandWidth); }
      ev.nextLegbandNumber += 1;
    }
    const lb = { id: store.nextId(d, 'legband'), eventId: ev.id, entryId, slot, number, status: 'AVAILABLE', matchId: null, statusReason: null, createdAt: now(), updatedAt: now() };
    d.legbands.push(lb);
    return lb;
  }
  function entryRow(data, entry) {
    const p = data.participants.find((x) => x.id === entry.participantId);
    const lbs = data.legbands.filter((l) => l.entryId === entry.id);
    const slot = (n) => {
      const lb = lbs.find((l) => l.slot === n);
      if (!lb) return null;
      const m = lb.matchId ? data.matches.find((x) => x.id === lb.matchId) : null;
      return { number: lb.number, status: lb.status, fightNumber: m ? m.fightNumber : null, matchStatus: m ? m.status : null };
    };
    const s1 = slot(1); const s2 = slot(2);
    const displayStatus = entry.status === 'WITHDRAWN' ? 'WITHDRAWN' : (s1 && s2 ? 'COMPLETE' : 'INCOMPLETE');
    return {
      id: entry.id, eventId: entry.eventId, entryNumber: entry.entryNumber, entryName: entry.entryName, address: entry.address || '',
      participantId: p ? p.id : null, participantName: p ? p.name : '',
      legband1: s1, legband2: s2, status: entry.status, displayStatus,
      locked: lbs.some((l) => l.matchId != null),
      createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    };
  }
  function publish(eventId, type, payload) {
    bus.publish(Number(eventId), type, payload);
  }

  const svc = {
    describeLegband,

    lookupLegband(eventId, input) {
      const ev = store.data.events.find((e) => e.id === Number(eventId));
      if (!ev) throw notFound('Event not found.');
      const number = normalizeLegband(input, ev.legbandWidth);
      if (!number) throw badRequest('Enter a legband number (digits only).', 'INVALID_LEGBAND');
      const lb = store.data.legbands.find((l) => l.eventId === ev.id && l.number === number);
      if (!lb) throw notFound(`Legband ${number} is not registered.`, 'LEGBAND_NOT_FOUND');
      return describeLegband(store.data, lb);
    },

    listEntries(eventId, { q = '', status = '' } = {}) {
      const data = store.data;
      const key = nameKey(q);
      return data.entries
        .filter((e) => e.eventId === Number(eventId))
        .map((e) => entryRow(data, e))
        .filter((r) => !status || r.displayStatus === status)
        .filter((r) => {
          if (!key) return true;
          return String(r.entryNumber) === key
            || r.entryName.toLowerCase().includes(key)
            || r.address.toLowerCase().includes(key)
            || r.participantName.toLowerCase().includes(key)
            || (r.legband1 && r.legband1.number.includes(key))
            || (r.legband2 && r.legband2.number.includes(key));
        })
        .sort((a, b) => a.entryNumber - b.entryNumber);
    },

    getEntry(eventId, entryId) {
      const e = store.data.entries.find((x) => x.id === Number(entryId) && x.eventId === Number(eventId));
      if (!e) throw notFound('Entry not found.');
      return entryRow(store.data, e);
    },

    listLegbands(eventId, { status = '' } = {}) {
      const data = store.data;
      return data.legbands
        .filter((l) => l.eventId === Number(eventId) && (!status || l.status === status))
        .map((l) => describeLegband(data, l))
        .sort((a, b) => a.number.localeCompare(b.number));
    },

    searchParticipants(q) {
      const key = nameKey(q);
      return store.data.participants
        .filter((p) => !key || p.nameKey.includes(key))
        .slice(0, 20)
        .map((p) => ({ id: p.id, name: p.name }));
    },

    register(eventId, { participantName, entryName, address, legbandCount = 2, legband1, legband2 }, userId) {
      const pName = cleanText(participantName, 100);
      if (!pName) throw badRequest('Participant name is required.', 'VALIDATION', { field: 'participantName' });
      const eName = cleanText(entryName, 100) || pName;
      const addr = cleanText(address, 120);
      const lb1 = legband1 == null ? '' : String(legband1).trim();
      const lb2 = legband2 == null ? '' : String(legband2).trim();
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        requireRegistrationOpen(ev);
        const manual = isManual(ev);
        // MANUAL: legband numbers are the pre-numbered bands from management, typed by the operator.
        const typed = manual ? [lb1, lb2].filter(Boolean) : null;
        // Legbands may be left blank and added later with "+ Legband".
        if (manual && lb1 && lb2 && normalizeLegband(lb1, ev.legbandWidth) === normalizeLegband(lb2, ev.legbandWidth)) {
          throw badRequest('Legband 1 and Legband 2 cannot be the same number.', 'VALIDATION', { field: 'legband2' });
        }
        const count = manual ? typed.length : Number(legbandCount);
        if (manual ? count > 2 : ![1, 2].includes(count)) throw badRequest('An entry has 1 or 2 legbands.', 'VALIDATION', { field: 'legbandCount' });
        const used = d.legbands.filter((l) => l.eventId === ev.id).length;
        const left = manual ? ev.maxLegbands - used : Math.min(ev.maxLegbands - used, ev.maxLegbands - ev.nextLegbandNumber + 1);
        if (count > left) throw conflict(`Only ${Math.max(0, left)} legband(s) left out of ${ev.maxLegbands}.`, 'LEGBANDS_EXHAUSTED');
        if (manual) { if (lb1) checkTypedLegband(d, ev, lb1, 'legband1'); if (lb2) checkTypedLegband(d, ev, lb2, lb1 ? 'legband2' : 'legband1'); }
        const p = findOrCreateParticipant(d, pName);
        const entryNumber = ev.nextEntryNumber;
        if (d.entries.some((e) => e.eventId === ev.id && e.entryNumber === entryNumber)) throw conflict(`Entry number ${entryNumber} already exists.`);
        ev.nextEntryNumber += 1;
        const entry = { id: store.nextId(d, 'entry'), eventId: ev.id, participantId: p.id, entryNumber, entryName: eName, address: addr, status: 'ACTIVE', createdAt: now(), updatedAt: now() };
        d.entries.push(entry);
        const issued = [];
        for (let slot = 1; slot <= count; slot += 1) {
          issued.push(issueLegband(d, ev, entry.id, slot, manual ? typed[slot - 1] : null, `legband${slot}`).number);
        }
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'entry', entityId: entry.id, action: 'ENTRY_REGISTERED', newValues: { entryNumber, entryName: eName, address: addr, participant: p.name, legbands: issued }, userId });
        return entryRow(d, entry);
      });
      publish(eventId, 'registration:created', { entry: row });
      return row;
    },

    addLegband(eventId, entryId, userId, typedNumber) {
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        requireRegistrationOpen(ev);
        const entry = d.entries.find((e) => e.id === Number(entryId) && e.eventId === ev.id);
        if (!entry) throw notFound('Entry not found.');
        if (entry.status !== 'ACTIVE') throw badRequest('This entry is withdrawn.');
        const have = d.legbands.filter((l) => l.entryId === entry.id).map((l) => l.slot);
        const slot = [1, 2].find((s) => !have.includes(s));
        if (!slot) throw conflict('This entry already has two legbands.');
        if (isManual(ev) && !String(typedNumber || '').trim()) throw badRequest('Type the legband number.', 'VALIDATION', { field: 'legband' });
        const lb = issueLegband(d, ev, entry.id, slot, isManual(ev) ? typedNumber : null, 'legband');
        entry.updatedAt = now();
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'entry', entityId: entry.id, action: 'LEGBAND_ADDED', newValues: { slot, legband: lb.number }, userId });
        return entryRow(d, entry);
      });
      publish(eventId, 'registration:updated', { entry: row });
      return row;
    },

    updateEntry(eventId, entryId, { participantName, entryName, address, legband1, legband2, reason }, user) {
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        if (['COMPLETED', 'ARCHIVED'].includes(ev.status) && user.role !== 'ADMIN') throw forbidden('This event is closed.');
        const entry = d.entries.find((e) => e.id === Number(entryId) && e.eventId === ev.id);
        if (!entry) throw notFound('Entry not found.');
        const lbs = d.legbands.filter((l) => l.entryId === entry.id);
        const locked = lbs.some((l) => l.matchId != null);
        if (locked && user.role !== 'ADMIN') throw forbidden('This entry already has an official match. Only an administrator can correct it.');
        const why = cleanText(reason, 300);
        if (locked && !why) throw badRequest('A reason is required to correct an entry with an official match.', 'VALIDATION', { field: 'reason' });
        const oldP = d.participants.find((p) => p.id === entry.participantId);
        const old = { participant: oldP && oldP.name, entryName: entry.entryName, address: entry.address || '' };
        if (participantName !== undefined) {
          const pName = cleanText(participantName, 100);
          if (!pName) throw badRequest('Participant name is required.', 'VALIDATION', { field: 'participantName' });
          const p = findOrCreateParticipant(d, pName);
          if (p.id !== entry.participantId) entry.participantId = p.id;
        }
        if (entryName !== undefined) {
          const eName = cleanText(entryName, 100);
          if (!eName) throw badRequest('Entry name is required.', 'VALIDATION', { field: 'entryName' });
          entry.entryName = eName;
        }
        if (address !== undefined) entry.address = cleanText(address, 120);
        // Correct a mistyped legband number (only while that legband has never been in a match).
        const lbChanges = [];
        for (const [slot, val] of [[1, legband1], [2, legband2]]) {
          if (val === undefined || val === null || String(val).trim() === '') continue;
          const lb = lbs.find((l) => l.slot === slot);
          if (!lb) continue;
          const number = normalizeLegband(val, ev.legbandWidth);
          if (number === lb.number) continue;
          if (lb.matchId != null || lb.status !== 'AVAILABLE') throw conflict(`Legband ${lb.number} is already in a match and cannot be renumbered.`, 'LEGBAND_LOCKED', { field: `legband${slot}` });
          const nn = checkTypedLegband(d, ev, val, `legband${slot}`, lb.id);
          lbChanges.push({ slot, from: lb.number, to: nn });
          lb.number = nn; lb.updatedAt = now();
        }
        const l1 = lbs.find((l) => l.slot === 1); const l2 = lbs.find((l) => l.slot === 2);
        if (l1 && l2 && l1.number === l2.number) throw badRequest('Legband 1 and Legband 2 cannot be the same number.', 'VALIDATION', { field: 'legband2' });
        if (lbChanges.length) old.legbands = lbChanges.map((c) => `${c.slot}:${c.from}`).join(', ');
        entry.updatedAt = now();
        const newP = d.participants.find((p) => p.id === entry.participantId);
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'entry', entityId: entry.id, action: locked ? 'ENTRY_CORRECTED' : 'ENTRY_UPDATED', oldValues: old, newValues: { participant: newP.name, entryName: entry.entryName, address: entry.address || '', ...(lbChanges.length ? { legbands: lbChanges.map((c) => `${c.slot}:${c.to}`).join(', ') } : {}) }, reason: why, userId: user.id });
        return entryRow(d, entry);
      });
      publish(eventId, 'registration:updated', { entry: row });
      return row;
    },

    withdrawEntry(eventId, entryId, reason, userId) {
      const why = cleanText(reason, 300);
      if (!why) throw badRequest('A reason is required.', 'VALIDATION', { field: 'reason' });
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const entry = d.entries.find((e) => e.id === Number(entryId) && e.eventId === ev.id);
        if (!entry) throw notFound('Entry not found.');
        if (entry.status === 'WITHDRAWN') throw conflict('Entry is already withdrawn.');
        const lbs = d.legbands.filter((l) => l.entryId === entry.id);
        if (lbs.some((l) => l.matchId != null)) throw conflict('This entry has a legband in an official match and cannot be withdrawn. Cancel the match first.');
        entry.status = 'WITHDRAWN';
        entry.updatedAt = now();
        for (const lb of lbs) { lb.status = 'WITHDRAWN'; lb.statusReason = why; lb.updatedAt = now(); }
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'entry', entityId: entry.id, action: 'ENTRY_WITHDRAWN', newValues: { legbands: lbs.map((l) => l.number) }, reason: why, userId });
        return entryRow(d, entry);
      });
      publish(eventId, 'registration:updated', { entry: row });
      return row;
    },

    withdrawLegband(eventId, input, reason, userId) {
      const why = cleanText(reason, 300);
      if (!why) throw badRequest('A reason is required.', 'VALIDATION', { field: 'reason' });
      const res = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const number = normalizeLegband(input, ev.legbandWidth);
        const lb = number && d.legbands.find((l) => l.eventId === ev.id && l.number === number);
        if (!lb) throw notFound(`Legband ${number || input} is not registered.`);
        if (lb.status !== 'AVAILABLE') throw conflict(`Only an available legband can be withdrawn (${lb.number} is ${lb.status}).`);
        lb.status = 'WITHDRAWN';
        lb.statusReason = why;
        lb.updatedAt = now();
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'legband', entityId: lb.id, action: 'LEGBAND_WITHDRAWN', oldValues: { status: 'AVAILABLE' }, newValues: { number: lb.number, status: 'WITHDRAWN' }, reason: why, userId });
        return { legband: describeLegband(d, lb), entry: entryRow(d, d.entries.find((e) => e.id === lb.entryId)) };
      });
      publish(eventId, 'legband:updated', res);
      return res;
    },

    summary(eventId) {
      const data = store.data;
      const id = Number(eventId);
      const ev = data.events.find((e) => e.id === id);
      if (!ev) throw notFound('Event not found.');
      const entries = data.entries.filter((e) => e.eventId === id && e.status === 'ACTIVE');
      const lbs = data.legbands.filter((l) => l.eventId === id);
      const matches = data.matches.filter((m) => m.eventId === id);
      const unmatchedEntries = entries.filter((e) => lbs.some((l) => l.entryId === e.id && l.status === 'AVAILABLE')).length;
      return {
        participants: new Set(entries.map((e) => e.participantId)).size,
        entries: entries.length,
        incompleteEntries: entries.filter((e) => lbs.filter((l) => l.entryId === e.id).length < 2).length,
        legbands: lbs.filter((l) => l.status !== 'WITHDRAWN').length,
        legbandsIssued: lbs.length,
        legbandsLeft: Math.max(0, (ev.legbandMode || 'MANUAL') === 'MANUAL' ? ev.maxLegbands - lbs.length : ev.maxLegbands - ev.nextLegbandNumber + 1),
        legbandMode: ev.legbandMode || 'MANUAL',
        available: lbs.filter((l) => l.status === 'AVAILABLE').length,
        matched: lbs.filter((l) => l.status === 'MATCHED').length,
        inactive: lbs.filter((l) => l.status === 'INACTIVE').length,
        withdrawn: lbs.filter((l) => l.status === 'WITHDRAWN').length,
        confirmedMatches: matches.filter((m) => m.status === 'CONFIRMED').length,
        completedMatches: matches.filter((m) => m.status === 'COMPLETED').length,
        cancelledMatches: matches.filter((m) => m.status === 'CANCELLED').length,
        unmatchedEntries,
        nextLegband: ev.nextLegbandNumber <= ev.maxLegbands ? pad(ev.nextLegbandNumber, ev.legbandWidth) : null,
        nextEntryNumber: ev.nextEntryNumber,
      };
    },
  };
  return svc;
}

module.exports = { createRegistrationService, describeLegband, fightLabel };
