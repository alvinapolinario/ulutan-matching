'use strict';
const {
  badRequest, notFound, conflict, forbidden, CAN_REGISTER,
  now, pad, nameKey, cleanText, normalizeLegband, MAX_PER_ENTRY, perEntry,
  BIRD_TYPES, BIRD_LABEL, birdType, needsWingband, bandLabel, parseBand, parseWeight, eventType,
  allowedTypes, weightRules,
} = require('../lib/common');
const { addAudit, bumpVersion } = require('./audit');

/**
 * Per-slot inputs from a request body, one per slot: either an array (`legbands`, `types`, `wingbands`, `weights`)
 * or numbered fields (legband1 … legband5, type1 …, wingband1 …, weight1 …). Blank / missing slots are ''.
 */
function slotInputs(body, list, field) {
  const src = Array.isArray(body[list]) ? body[list] : Array.from({ length: MAX_PER_ENTRY }, (_, i) => body[`${field}${i + 1}`]);
  return src.map((v) => (v == null ? '' : String(v).trim()));
}
const birdInputs = (body) => ({
  legbands: slotInputs(body, 'legbands', 'legband'),
  types: slotInputs(body, 'types', 'type'),
  wingbands: slotInputs(body, 'wingbands', 'wingband'),
  weights: slotInputs(body, 'weights', 'weight'),
});

const fightLabel = (n) => (n == null ? '' : `Fight #${pad(n)}`);
/** How a bird is named in messages: "Legband 012", or "Wingband 005" / "Bird 2" before its legband is on. */
const birdWord = (lb) => (lb.number ? `Legband ${lb.number}` : lb.wingband ? `Wingband ${lb.wingband}` : `Bird ${lb.slot}`);

/** Build a lookup-friendly description of a bird from a data snapshot. */
function describeLegband(data, lb) {
  const entry = data.entries.find((e) => e.id === lb.entryId);
  const participant = entry && data.participants.find((p) => p.id === entry.participantId);
  const match = lb.matchId ? data.matches.find((m) => m.id === lb.matchId) : null;
  let available = lb.status === 'AVAILABLE' && entry && entry.status === 'ACTIVE' && !!lb.number;
  let reason = null;
  if (match && match.status !== 'CANCELLED') reason = `${birdWord(lb)} is already matched in ${fightLabel(match.fightNumber)}.`;
  else if (match && match.status === 'CANCELLED') reason = `${birdWord(lb)} was in cancelled ${fightLabel(match.fightNumber)} and can no longer be used.`;
  else if (lb.status === 'WITHDRAWN' || (entry && entry.status === 'WITHDRAWN')) reason = `${birdWord(lb)} is withdrawn.`;
  else if (lb.status !== 'AVAILABLE') reason = `${birdWord(lb)} is ${lb.status.toLowerCase()}.`;
  else if (!lb.number) reason = `${birdWord(lb)} has no legband yet. Add the legband in Registration first.`;
  // Derby: an entry fights only once all of its birds are registered with their legbands.
  let incomplete = false;
  const ev = data.events.find((e) => e.id === lb.eventId);
  if (!reason && entry && eventType(ev) === 'DERBY') {
    const need = perEntry(ev);
    const ready = data.legbands.filter((l) => l.entryId === entry.id && l.number).length;
    if (ready < need) {
      incomplete = true;
      reason = `Entry #${entry.entryNumber} (${entry.entryName}) has ${ready} of ${need} birds with legbands. In a derby, all birds of an entry must be registered before it can fight.`;
    }
  }
  if (reason) available = false;
  return {
    number: lb.number || null,
    type: birdType(lb),
    typeLabel: BIRD_LABEL[birdType(lb)],
    wingband: lb.wingband || null,
    weight: lb.weight == null ? null : lb.weight,
    slot: lb.slot,
    status: lb.status,
    available,
    unavailableReason: reason,
    entryIncomplete: incomplete,
    entry: entry ? { id: entry.id, entryNumber: entry.entryNumber, entryName: entry.entryName, address: entry.address || '', status: entry.status } : null,
    participant: participant ? { id: participant.id, name: participant.name } : null,
    match: match ? { id: match.id, fightNumber: match.fightNumber, status: match.status } : null,
  };
}

/**
 * Find a bird from what was typed: "7" / "L7" = legband 007, "W7" = wingband 007.
 * Returns { error, message } or { lb }.
 */
function findBand(d, ev, input) {
  const p = parseBand(input, ev.legbandWidth);
  if (!p) return { error: 'INVALID', message: 'Enter a legband number (digits), or W and the wingband number (e.g. W7).' };
  const key = p.by === 'WING' ? 'wingband' : 'number';
  const lb = d.legbands.find((l) => l.eventId === ev.id && l[key] === p.number);
  if (!lb) return { error: 'NOT_FOUND', message: `${p.by === 'WING' ? 'Wingband' : 'Legband'} ${p.number} is not registered.` };
  return { lb };
}
/** A typed reference that finds this exact bird again. */
const bandRef = (lb) => (lb.number ? lb.number : `W${lb.wingband}`);

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
  const slotField = (field, slot) => `${field}${slot || ''}`;
  const weightRequired = (ev) => !!weightRules(ev);

  /** Type of bird: one the event allows; blank = the event's first allowed type (Cock when allowed). */
  function resolveType(ev, input, slot) {
    const allowed = allowedTypes(ev);
    let t = String(input || '').trim().toUpperCase().replace(/[\s-]/g, '');
    if (!t) return allowed[0];
    if (t === 'BULL') t = 'BULLSTAG';
    if (!BIRD_TYPES.includes(t)) throw badRequest('Type of bird must be Stag, Cock or Bullstag.', 'VALIDATION', { field: slotField('type', slot) });
    if (!allowed.includes(t)) throw badRequest(`${BIRD_LABEL[t]}s are not allowed in this event (allowed: ${allowed.map((x) => BIRD_LABEL[x]).join(', ')}).`, 'TYPE_NOT_ALLOWED', { field: slotField('type', slot) });
    return t;
  }
  /** Weight in grams (null when blank). With weight rules on, a cock must be inside the min / max when set. */
  function resolveWeight(ev, input, type, slot) {
    const g = parseWeight(input);
    if (Number.isNaN(g)) throw badRequest('Weight must be grams (e.g. 2105) or kilograms (e.g. 2.105).', 'VALIDATION', { field: slotField('weight', slot) });
    const rules = weightRules(ev);
    if (g != null && type === 'COCK' && rules) {
      if (rules.min != null && g < rules.min) throw badRequest(`${g} g is below this event's minimum of ${rules.min} g.`, 'WEIGHT_RANGE', { field: slotField('weight', slot) });
      if (rules.max != null && g > rules.max) throw badRequest(`${g} g is above this event's maximum of ${rules.max} g.`, 'WEIGHT_RANGE', { field: slotField('weight', slot) });
    }
    return g;
  }
  /** Wingband: required for a stag or bullstag, not used for a cock. Unique in the event. */
  function resolveWingband(d, ev, input, type, slot, exceptId = null) {
    const field = slotField('wingband', slot);
    if (!needsWingband(type)) {
      if (input) throw badRequest('A cock has no wingband; enter only its weight.', 'VALIDATION', { field });
      return null;
    }
    if (!input) throw badRequest(`Enter the wingband number of the ${BIRD_LABEL[type].toLowerCase()}.`, 'WINGBAND_REQUIRED', { field });
    const number = normalizeLegband(String(input).replace(/^\s*WB?[\s-]*/i, ''), ev.legbandWidth);
    if (!number) throw badRequest('Enter the wingband number (digits only).', 'INVALID_WINGBAND', { field });
    const clash = d.legbands.find((l) => l.eventId === ev.id && l.wingband === number && l.id !== exceptId);
    if (clash) {
      const owner = d.entries.find((e) => e.id === clash.entryId);
      throw conflict(`Wingband ${number} is already registered${owner ? ` to Entry #${owner.entryNumber} (${owner.entryName})` : ''}.`, 'WINGBAND_TAKEN', { field });
    }
    return number;
  }
  /** Validate a typed legband number: digits, not already registered in this event. */
  function checkTypedLegband(d, ev, input, field, exceptId = null) {
    const number = normalizeLegband(String(input).replace(/^\s*LB?[\s-]*/i, ''), ev.legbandWidth);
    if (!number) throw badRequest('Enter the legband number (digits only).', 'INVALID_LEGBAND', { field });
    const clash = d.legbands.find((l) => l.eventId === ev.id && l.number === number && l.id !== exceptId);
    if (clash) {
      const owner = d.entries.find((e) => e.id === clash.entryId);
      throw conflict(`Legband ${number} is already registered${owner ? ` to Entry #${owner.entryNumber} (${owner.entryName})` : ''}.`, 'LEGBAND_TAKEN', { field });
    }
    return number;
  }
  const numberedCount = (d, ev) => d.legbands.filter((l) => l.eventId === ev.id && l.number).length;
  /** The next automatic legband number (AUTO mode). */
  function autoNumber(d, ev) {
    if (ev.nextLegbandNumber > ev.maxLegbands) throw conflict(`All ${ev.maxLegbands} legbands for this event have been issued.`, 'LEGBANDS_EXHAUSTED');
    let number = pad(ev.nextLegbandNumber, ev.legbandWidth);
    while (d.legbands.some((l) => l.eventId === ev.id && l.number === number)) { ev.nextLegbandNumber += 1; number = pad(ev.nextLegbandNumber, ev.legbandWidth); }
    ev.nextLegbandNumber += 1;
    return number;
  }
  /** Give a bird its legband: typed (MANUAL) or the next automatic number (AUTO). */
  function legbandFor(d, ev, typed, field, exceptId = null) {
    if (numberedCount(d, ev) >= ev.maxLegbands) throw conflict(`All ${ev.maxLegbands} legbands for this event have been registered.`, 'LEGBANDS_EXHAUSTED');
    return typed != null ? checkTypedLegband(d, ev, typed, field, exceptId) : autoNumber(d, ev);
  }
  function addBird(d, ev, entryId, slot, { number, type, wingband, weight }) {
    const lb = { id: store.nextId(d, 'legband'), eventId: ev.id, entryId, slot, type, number: number || null, wingband: wingband || null, weight, status: 'AVAILABLE', matchId: null, statusReason: null, createdAt: now(), updatedAt: now() };
    d.legbands.push(lb);
    return lb;
  }
  const birdText = (lb) => [BIRD_LABEL[birdType(lb)], lb.number ? `LB ${lb.number}` : 'no LB yet', lb.wingband ? `WB ${lb.wingband}` : '', lb.weight != null ? `${lb.weight} g` : ''].filter(Boolean).join(' ');

  function entryRow(data, entry) {
    const p = data.participants.find((x) => x.id === entry.participantId);
    const ev = data.events.find((e) => e.id === entry.eventId);
    const lbs = data.legbands.filter((l) => l.entryId === entry.id);
    const slot = (n) => {
      const lb = lbs.find((l) => l.slot === n);
      if (!lb) return null;
      const m = lb.matchId ? data.matches.find((x) => x.id === lb.matchId) : null;
      return {
        number: lb.number || null, band: bandLabel(lb), type: birdType(lb), typeLabel: BIRD_LABEL[birdType(lb)],
        wingband: lb.wingband || null, weight: lb.weight == null ? null : lb.weight,
        status: lb.status, fightNumber: m ? m.fightNumber : null, matchStatus: m ? m.status : null,
      };
    };
    const n = Math.max(perEntry(ev), ...lbs.map((l) => l.slot));
    const slots = Array.from({ length: n }, (_, i) => slot(i + 1));
    // Complete = every slot has a bird and every bird has its legband.
    const displayStatus = entry.status === 'WITHDRAWN' ? 'WITHDRAWN' : (slots.every((s) => s && s.number) ? 'COMPLETE' : 'INCOMPLETE');
    // legband1 … legbandN kept alongside the `legbands` list for older screens and reports.
    const named = Object.fromEntries(slots.map((s, i) => [`legband${i + 1}`, s]));
    return {
      id: entry.id, eventId: entry.eventId, entryNumber: entry.entryNumber, entryName: entry.entryName, address: entry.address || '',
      participantId: p ? p.id : null, participantName: p ? p.name : '',
      cocksPerEntry: n, legbands: slots, ...named, status: entry.status, displayStatus,
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
      const r = findBand(store.data, ev, input);
      if (r.error === 'INVALID') throw badRequest(r.message, 'INVALID_LEGBAND');
      if (r.error) throw notFound(r.message, 'LEGBAND_NOT_FOUND');
      return describeLegband(store.data, r.lb);
    },

    /** Is a wingband number free in this event? (for the live check while typing) */
    lookupWingband(eventId, input) {
      return svc.lookupLegband(eventId, `W${String(input || '').replace(/^\s*WB?[\s-]*/i, '')}`);
    },

    /**
     * Possible opponents for a bird: available birds of the same type from other active entries.
     * Cocks: only weighed ones within the event's weight tolerance, closest weight first.
     */
    opponents(eventId, input, { limit = 30 } = {}) {
      const d = store.data;
      const ev = requireEvent(d, eventId);
      const r = findBand(d, ev, input);
      if (r.error === 'INVALID') throw badRequest(r.message, 'INVALID_LEGBAND');
      if (r.error) throw notFound(r.message, 'LEGBAND_NOT_FOUND');
      const me = describeLegband(d, r.lb);
      const type = birdType(r.lb);
      const rules = weightRules(ev);
      const tol = rules ? rules.tolerance : null;
      const byWeight = type === 'COCK' && tol != null;
      let list = d.legbands
        .filter((l) => l.eventId === ev.id && l.id !== r.lb.id && l.entryId !== r.lb.entryId && birdType(l) === type)
        .map((l) => describeLegband(d, l))
        .filter((x) => x.available)
        .map((x) => ({ ...x, diff: me.weight != null && x.weight != null ? Math.abs(x.weight - me.weight) : null }));
      if (byWeight) list = me.weight == null ? [] : list.filter((x) => x.diff != null && x.diff <= tol);
      list.sort((a, b) => (a.diff ?? Infinity) - (b.diff ?? Infinity) || a.number.localeCompare(b.number));
      return { bird: me, weightTolerance: tol, matchByWeight: byWeight, needsWeight: byWeight && me.weight == null, candidates: list.slice(0, Math.max(1, Math.min(Number(limit) || 30, 200))) };
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
            || r.legbands.some((l) => l && ((l.number && l.number.includes(key)) || (l.wingband && `w${l.wingband}`.includes(key.replace(/^wb?\s*/, 'w')))));
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
        .sort((a, b) => (a.number === null) - (b.number === null) || String(a.number || '').localeCompare(String(b.number || '')));
    },

    searchParticipants(q) {
      const key = nameKey(q);
      return store.data.participants
        .filter((p) => !key || p.nameKey.includes(key))
        .slice(0, 20)
        .map((p) => ({ id: p.id, name: p.name }));
    },

    /**
     * Register an entry with its birds. Per bird: type (Stag / Cock / Bullstag, default Cock), wingband
     * (stag and bullstag only, required), weight (cocks: required when the event matches by weight),
     * legband (MANUAL: typed now or added later; AUTO: issued now).
     */
    register(eventId, body, userId) {
      const { participantName, entryName, address, legbandCount } = body || {};
      const pName = cleanText(participantName, 100);
      if (!pName) throw badRequest('Participant name is required.', 'VALIDATION', { field: 'participantName' });
      const eName = cleanText(entryName, 100) || pName;
      const addr = cleanText(address, 120);
      const inp = birdInputs(body || {});
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        requireRegistrationOpen(ev);
        const manual = isManual(ev);
        const max = perEntry(ev);
        let birds;
        if (manual) {
          // A bird is registered when anything of it was filled in (legband, wingband or weight).
          const filled = (i) => inp.legbands[i] || inp.wingbands[i] || inp.weights[i];
          const extra = Array.from({ length: MAX_PER_ENTRY }, (_, i) => i).find((i) => i >= max && filled(i));
          if (extra !== undefined) throw badRequest(`This event has ${max} birds per entry.`, 'VALIDATION', { field: `legband${extra + 1}` });
          birds = Array.from({ length: max }, (_, i) => i + 1).filter((s) => filled(s - 1)).map((s) => ({ slot: s }));
        } else {
          const count = Number(legbandCount ?? max);
          if (!(Number.isInteger(count) && count >= 1 && count <= max)) throw badRequest(`An entry has 1 to ${max} birds.`, 'VALIDATION', { field: 'legbandCount' });
          birds = Array.from({ length: count }, (_, i) => ({ slot: i + 1 }));
        }
        const seenLeg = new Map(); const seenWing = new Map();
        for (const b of birds) {
          const i = b.slot - 1;
          b.type = resolveType(ev, inp.types[i], b.slot);
          b.weight = resolveWeight(ev, inp.weights[i], b.type, b.slot);
          if (b.type === 'COCK' && b.weight == null && weightRequired(ev)) throw badRequest(`Enter the weight of cock ${b.slot}: cocks are matched by weight.`, 'WEIGHT_REQUIRED', { field: `weight${b.slot}` });
          b.wingband = resolveWingband(d, ev, inp.wingbands[i], b.type, b.slot);
          b.typed = manual && inp.legbands[i] ? inp.legbands[i] : null;
          if (b.typed) {
            const key = normalizeLegband(b.typed.replace(/^\s*LB?[\s-]*/i, ''), ev.legbandWidth);
            if (key && seenLeg.has(key)) throw badRequest(`Bird ${seenLeg.get(key)} and bird ${b.slot} cannot have the same legband.`, 'VALIDATION', { field: `legband${b.slot}` });
            if (key) seenLeg.set(key, b.slot);
          }
          if (b.wingband) {
            if (seenWing.has(b.wingband)) throw badRequest(`Bird ${seenWing.get(b.wingband)} and bird ${b.slot} cannot have the same wingband.`, 'VALIDATION', { field: `wingband${b.slot}` });
            seenWing.set(b.wingband, b.slot);
          }
        }
        const needNumbers = manual ? birds.filter((b) => b.typed).length : birds.length;
        const used = numberedCount(d, ev);
        const left = manual ? ev.maxLegbands - used : Math.min(ev.maxLegbands - used, ev.maxLegbands - ev.nextLegbandNumber + 1);
        if (needNumbers > left) throw conflict(`Only ${Math.max(0, left)} legband(s) left out of ${ev.maxLegbands}.`, 'LEGBANDS_EXHAUSTED');
        if (manual) for (const b of birds) if (b.typed) checkTypedLegband(d, ev, b.typed, `legband${b.slot}`);
        const p = findOrCreateParticipant(d, pName);
        const entryNumber = ev.nextEntryNumber;
        if (d.entries.some((e) => e.eventId === ev.id && e.entryNumber === entryNumber)) throw conflict(`Entry number ${entryNumber} already exists.`);
        ev.nextEntryNumber += 1;
        const entry = { id: store.nextId(d, 'entry'), eventId: ev.id, participantId: p.id, entryNumber, entryName: eName, address: addr, status: 'ACTIVE', createdAt: now(), updatedAt: now() };
        d.entries.push(entry);
        // Birds fill slots 1, 2, … in the order they were entered (empty rows are skipped).
        const issued = birds.map((b, i) => {
          const number = manual ? (b.typed ? legbandFor(d, ev, b.typed, `legband${b.slot}`) : null) : legbandFor(d, ev, null, `legband${b.slot}`);
          return birdText(addBird(d, ev, entry.id, i + 1, { number, type: b.type, wingband: b.wingband, weight: b.weight }));
        });
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'entry', entityId: entry.id, action: 'ENTRY_REGISTERED', newValues: { entryNumber, entryName: eName, address: addr, participant: p.name, legbands: issued }, userId });
        return entryRow(d, entry);
      });
      publish(eventId, 'registration:created', { entry: row });
      return row;
    },

    /**
     * "+ Legband": puts the legband on the first bird that has none yet; when every bird has one,
     * adds a new bird (type / wingband / weight from the request) to the next free slot.
     */
    addLegband(eventId, entryId, userId, typedNumber, { type: typeIn, wingband: wingIn, weight: weightIn } = {}) {
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        requireRegistrationOpen(ev);
        const entry = d.entries.find((e) => e.id === Number(entryId) && e.eventId === ev.id);
        if (!entry) throw notFound('Entry not found.');
        if (entry.status !== 'ACTIVE') throw badRequest('This entry is withdrawn.');
        const own = d.legbands.filter((l) => l.entryId === entry.id).sort((a, b) => a.slot - b.slot);
        const manual = isManual(ev);
        if (manual && !String(typedNumber || '').trim()) throw badRequest('Type the legband number.', 'VALIDATION', { field: 'legband' });
        const typed = manual ? String(typedNumber).trim() : null;
        const waiting = own.find((l) => !l.number && l.status === 'AVAILABLE');
        let lb;
        if (waiting) {
          waiting.number = legbandFor(d, ev, typed, 'legband', waiting.id);
          waiting.updatedAt = now();
          lb = waiting;
        } else {
          const max = perEntry(ev);
          const slot = Array.from({ length: max }, (_, i) => i + 1).find((s) => !own.some((l) => l.slot === s));
          if (!slot) throw conflict(`This entry already has ${max} birds with legbands.`);
          const type = resolveType(ev, typeIn, null);
          const weight = resolveWeight(ev, weightIn, type, null);
          if (type === 'COCK' && weight == null && weightRequired(ev)) throw badRequest('Enter the weight: cocks are matched by weight.', 'WEIGHT_REQUIRED', { field: 'weight' });
          const wingband = resolveWingband(d, ev, wingIn ? String(wingIn).trim() : '', type, null);
          lb = addBird(d, ev, entry.id, slot, { number: legbandFor(d, ev, typed, 'legband'), type, wingband, weight });
        }
        entry.updatedAt = now();
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'entry', entityId: entry.id, action: 'LEGBAND_ADDED', newValues: { slot: lb.slot, bird: birdText(lb) }, userId });
        return entryRow(d, entry);
      });
      publish(eventId, 'registration:updated', { entry: row });
      return row;
    },

    updateEntry(eventId, entryId, body, user) {
      const { participantName, entryName, address, reason } = body || {};
      const inp = birdInputs(body || {});
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
        // Correct a bird (type, legband, wingband, weight) while it has never been in a match.
        // A blank value leaves that field as it is.
        const changes = [];
        for (const lb of lbs) {
          const i = lb.slot - 1;
          const numIn = inp.legbands[i]; const typeIn = inp.types[i]; const wingIn = inp.wingbands[i]; const weightIn = inp.weights[i];
          if (!numIn && !typeIn && !wingIn && !weightIn) continue;
          // An unchanged type is kept even if the event no longer lists it; a changed one must be allowed.
          const type = typeIn && typeIn.toUpperCase() !== birdType(lb) ? resolveType(ev, typeIn, lb.slot) : birdType(lb);
          const number = numIn ? normalizeLegband(numIn.replace(/^\s*LB?[\s-]*/i, ''), ev.legbandWidth) || numIn : (lb.number || null);
          const weight = weightIn ? resolveWeight(ev, weightIn, type, lb.slot) : (lb.weight == null ? null : lb.weight);
          const wingRaw = needsWingband(type) ? (wingIn || lb.wingband || '') : '';
          const sameWing = needsWingband(type) ? (wingIn ? normalizeLegband(wingIn.replace(/^\s*WB?[\s-]*/i, ''), ev.legbandWidth) : lb.wingband) === (lb.wingband || null) : !lb.wingband;
          if (type === birdType(lb) && number === (lb.number || null) && weight === (lb.weight == null ? null : lb.weight) && sameWing) continue;
          if (lb.matchId != null || lb.status !== 'AVAILABLE') throw conflict(`${birdWord(lb)} is already in a match and cannot be changed.`, 'LEGBAND_LOCKED', { field: `legband${lb.slot}` });
          const from = birdText(lb);
          if (number !== (lb.number || null)) lb.number = checkTypedLegband(d, ev, number, `legband${lb.slot}`, lb.id);
          lb.wingband = resolveWingband(d, ev, wingRaw, type, lb.slot, lb.id);
          if (type === 'COCK' && weight == null && weightRequired(ev)) throw badRequest(`Enter the weight of cock ${lb.slot}: cocks are matched by weight.`, 'WEIGHT_REQUIRED', { field: `weight${lb.slot}` });
          lb.type = type;
          lb.weight = weight;
          lb.updatedAt = now();
          changes.push({ slot: lb.slot, from, to: birdText(lb) });
        }
        if (changes.length) old.legbands = changes.map((c) => `${c.slot}: ${c.from}`).join('; ');
        entry.updatedAt = now();
        const newP = d.participants.find((p) => p.id === entry.participantId);
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'entry', entityId: entry.id, action: locked ? 'ENTRY_CORRECTED' : 'ENTRY_UPDATED', oldValues: old, newValues: { participant: newP.name, entryName: entry.entryName, address: entry.address || '', ...(changes.length ? { legbands: changes.map((c) => `${c.slot}: ${c.to}`).join('; ') } : {}) }, reason: why, userId: user.id });
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
        addAudit(store, d, { eventId: ev.id, entity: 'entry', entityId: entry.id, action: 'ENTRY_WITHDRAWN', newValues: { legbands: lbs.map((l) => birdText(l)) }, reason: why, userId });
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
        const r = findBand(d, ev, input);
        if (r.error) throw notFound(r.message);
        const lb = r.lb;
        if (lb.status !== 'AVAILABLE') throw conflict(`Only an available legband can be withdrawn (${birdWord(lb)} is ${lb.status}).`);
        lb.status = 'WITHDRAWN';
        lb.statusReason = why;
        lb.updatedAt = now();
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'legband', entityId: lb.id, action: 'LEGBAND_WITHDRAWN', oldValues: { status: 'AVAILABLE' }, newValues: { number: birdText(lb), status: 'WITHDRAWN' }, reason: why, userId });
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
      const live = lbs.filter((l) => l.status !== 'WITHDRAWN');
      const numbered = lbs.filter((l) => l.number);
      const matches = data.matches.filter((m) => m.eventId === id);
      const unmatchedEntries = entries.filter((e) => lbs.some((l) => l.entryId === e.id && l.status === 'AVAILABLE')).length;
      return {
        participants: new Set(entries.map((e) => e.participantId)).size,
        entries: entries.length,
        incompleteEntries: entries.filter((e) => lbs.filter((l) => l.entryId === e.id && l.number).length < perEntry(ev)).length,
        cocksPerEntry: perEntry(ev),
        eventType: ev.eventType === 'DERBY' ? 'DERBY' : 'HACKFIGHT',
        weightTolerance: weightRules(ev) ? weightRules(ev).tolerance : null,
        allowedTypes: allowedTypes(ev),
        weightRules: weightRules(ev),
        legbands: live.length,
        cocks: live.filter((l) => birdType(l) === 'COCK').length,
        stags: live.filter((l) => birdType(l) === 'STAG').length,
        bullstags: live.filter((l) => birdType(l) === 'BULLSTAG').length,
        unweighedCocks: lbs.filter((l) => birdType(l) === 'COCK' && l.status === 'AVAILABLE' && l.weight == null).length,
        waitingForLegband: lbs.filter((l) => !l.number && l.status === 'AVAILABLE').length,
        legbandsIssued: numbered.length,
        legbandsLeft: Math.max(0, (ev.legbandMode || 'MANUAL') === 'MANUAL' ? ev.maxLegbands - numbered.length : ev.maxLegbands - ev.nextLegbandNumber + 1),
        legbandMode: ev.legbandMode || 'MANUAL',
        available: lbs.filter((l) => l.status === 'AVAILABLE' && l.number).length,
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

module.exports = { createRegistrationService, describeLegband, findBand, bandRef, fightLabel };
