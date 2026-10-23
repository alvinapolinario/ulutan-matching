'use strict';
const {
  badRequest, notFound, conflict, forbidden, CAN_MATCH, CAN_RUN_FIGHTS, RESULTS,
  now, pad, cleanText, normalizeLegband,
} = require('../lib/common');
const { addAudit, bumpVersion } = require('./audit');
const { describeLegband, fightLabel } = require('./registration');

function createMatchService(store, bus) {
  const userName = (data, id) => { const u = data.users.find((x) => x.id === id); return u ? u.username : null; };

  function side(data, legbandId) {
    const lb = data.legbands.find((l) => l.id === legbandId);
    if (!lb) return null;
    const entry = data.entries.find((e) => e.id === lb.entryId);
    const p = entry && data.participants.find((x) => x.id === entry.participantId);
    return {
      legband: lb.number, slot: lb.slot,
      entryNumber: entry ? entry.entryNumber : null,
      entryName: entry ? entry.entryName : '',
      address: entry ? (entry.address || '') : '',
      participantName: p ? p.name : '',
    };
  }

  function matchRow(data, m) {
    const ev = data.events.find((e) => e.id === m.eventId);
    return {
      id: m.id, eventId: m.eventId, fightNumber: m.fightNumber, sequence: m.sequence, status: m.status,
      result: m.result, redPoints: m.redPoints, bluePoints: m.bluePoints,
      red: side(data, m.redLegbandId), blue: side(data, m.blueLegbandId),
      confirmedBy: userName(data, m.confirmedBy), confirmedAt: m.confirmedAt,
      cancelledBy: userName(data, m.cancelledBy), cancelledAt: m.cancelledAt, cancelReason: m.cancelReason,
      completedBy: userName(data, m.completedBy), completedAt: m.completedAt,
      isCurrent: !!ev && ev.display.currentMatchId === m.id,
    };
  }

  function requireEvent(d, eventId) {
    const ev = d.events.find((e) => e.id === Number(eventId));
    if (!ev) throw notFound('Event not found.');
    return ev;
  }
  function requireMatch(d, ev, matchId) {
    const m = d.matches.find((x) => x.id === Number(matchId) && x.eventId === ev.id);
    if (!m) throw notFound('Match not found.');
    return m;
  }
  const fieldError = (field, message, code) => badRequest(message, code || 'MATCH_INVALID', { field });

  /** Rules 1-7: both legbands exist in this event, differ, are available, and are not same entry / same owner. */
  function validatePair(d, ev, redInput, blueInput) {
    const redNo = normalizeLegband(redInput, ev.legbandWidth);
    const blueNo = normalizeLegband(blueInput, ev.legbandWidth);
    if (!redNo) throw fieldError('red', 'Enter the Red Corner legband number.');
    if (!blueNo) throw fieldError('blue', 'Enter the Blue Corner legband number.');
    const redLb = d.legbands.find((l) => l.eventId === ev.id && l.number === redNo);
    if (!redLb) throw fieldError('red', `Legband ${redNo} is not registered.`, 'LEGBAND_NOT_FOUND');
    const blueLb = d.legbands.find((l) => l.eventId === ev.id && l.number === blueNo);
    if (!blueLb) throw fieldError('blue', `Legband ${blueNo} is not registered.`, 'LEGBAND_NOT_FOUND');
    if (redLb.id === blueLb.id) throw fieldError('blue', 'Red and Blue cannot be the same legband.', 'SAME_LEGBAND');
    const red = describeLegband(d, redLb);
    const blue = describeLegband(d, blueLb);
    if (!red.available) throw fieldError('red', red.unavailableReason || 'Red Corner legband is unavailable.', 'UNAVAILABLE');
    if (!blue.available) throw fieldError('blue', blue.unavailableReason || 'Blue Corner legband is unavailable.', 'UNAVAILABLE');
    if (redLb.entryId === blueLb.entryId) throw fieldError('blue', 'Matching two chickens from the same entry is not allowed.', 'SAME_ENTRY');
    if (red.participant && blue.participant && red.participant.id === blue.participant.id) {
      throw fieldError('blue', `Both legbands belong to the same owner (${red.participant.name}). Matching the same owner is not allowed.`, 'SAME_OWNER');
    }
    return { redLb, blueLb, red, blue };
  }

  const isDraw = (ev) => (ev.fightNumberMode || 'DRAW') === 'DRAW';
  /** Validate a drawn (raffle) fight number: whole number, not used by any match of the event (cancelled included). */
  function checkDrawnNumber(d, ev, input, exceptMatchId = null) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) throw fieldError('fight', 'Type the drawn fight number (nabunot na numero).', 'FIGHT_NUMBER_REQUIRED');
    if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1) throw fieldError('fight', 'Fight number must be a whole number from 1 to 9999.', 'FIGHT_NUMBER_INVALID');
    const n = Number(raw);
    const clash = d.matches.find((m) => m.eventId === ev.id && m.fightNumber === n && m.id !== exceptMatchId);
    if (clash) {
      const s = matchRow(d, clash);
      throw fieldError('fight', `Fight #${pad(n)} is already used${clash.status === 'CANCELLED' ? ' by a cancelled match' : ''} (${s.red.legband} vs ${s.blue.legband}).`, 'FIGHT_NUMBER_TAKEN');
    }
    return n;
  }

  function queue(d, ev) {
    return d.matches.filter((m) => m.eventId === ev.id && m.status !== 'CANCELLED').sort((a, b) => a.sequence - b.sequence);
  }
  function nextPending(d, ev, afterMatch) {
    const pending = queue(d, ev).filter((m) => m.status === 'CONFIRMED' && (!afterMatch || m.id !== afterMatch.id));
    if (!afterMatch) return pending[0] || null;
    // After the current fight; if none are left after it, wrap to the lowest pending fight
    // (a low number may have been drawn after higher ones were already fought).
    return pending.find((m) => m.sequence > afterMatch.sequence) || pending[0] || null;
  }

  function publish(eventId, type, payload) { bus.publish(Number(eventId), type, payload); }

  /**
   * The two score boxes of an entry. Boxes fill in the order its fights were decided
   * (first result -> box 1, second -> box 2), whichever chicken fought.
   */
  function entryBoxes(d, entry, current) {
    const own = d.legbands.filter((l) => l.entryId === entry.id).map((l) => l.id);
    const fights = d.matches.filter((m) => m.status !== 'CANCELLED' && (own.includes(m.redLegbandId) || own.includes(m.blueLegbandId)));
    const decided = fights.filter((m) => m.status === 'COMPLETED')
      .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)) || a.id - b.id);
    const pointsOf = (m) => (own.includes(m.redLegbandId) ? m.redPoints : m.bluePoints);
    const fightingNow = !!(current && current.status === 'CONFIRMED' && fights.some((m) => m.id === current.id));
    return [0, 1].map((i) => ({
      box: i + 1,
      points: decided[i] ? pointsOf(decided[i]) : null,
      fightNumber: decided[i] ? decided[i].fightNumber : null,
      fighting: fightingNow && i === decided.length,
    }));
  }

  const svc = {
    matchRow,

    list(eventId, { status = '', q = '' } = {}) {
      const data = store.data;
      const key = String(q || '').trim().toLowerCase();
      return data.matches
        .filter((m) => m.eventId === Number(eventId) && (!status || m.status === status))
        .map((m) => matchRow(data, m))
        .filter((r) => {
          if (!key) return true;
          const hay = [r.red, r.blue].filter(Boolean).flatMap((s) => [s.legband, s.entryName, s.participantName]).join(' ').toLowerCase();
          return hay.includes(key) || String(r.fightNumber) === key.replace(/^#?0*/, '');
        })
        .sort((a, b) => (a.status === 'CANCELLED') - (b.status === 'CANCELLED') || a.sequence - b.sequence);
    },

    get(eventId, matchId) {
      const ev = requireEvent(store.data, eventId);
      return matchRow(store.data, requireMatch(store.data, ev, matchId));
    },

    /** Validate a pair without saving (used to open the confirmation dialog). */
    check(eventId, { red, blue, fightNumber }) {
      const d = store.data;
      const ev = requireEvent(d, eventId);
      if (!CAN_MATCH.includes(ev.status)) throw badRequest(`Matching is not open for this event (status: ${ev.status}).`, 'EVENT_CLOSED');
      const r = validatePair(d, ev, red, blue);
      const draw = isDraw(ev);
      // In DRAW mode the fight number is checked only once the operator has typed it.
      const drawn = draw && fightNumber !== undefined && fightNumber !== null && fightNumber !== '' ? checkDrawnNumber(d, ev, fightNumber) : null;
      return { red: r.red, blue: r.blue, fightNumberMode: draw ? 'DRAW' : 'AUTO', fightNumber: draw ? drawn : ev.nextFightNumber, nextFightNumber: ev.nextFightNumber };
    },

    /** Create an official match. Everything is re-validated inside the transaction. */
    confirm(eventId, { red, blue, idempotencyKey, fightNumber: drawnInput }, user) {
      const key = String(idempotencyKey || '');
      if (!/^[A-Za-z0-9-]{8,80}$/.test(key)) throw badRequest('Missing or invalid request key. Reload the page and try again.', 'IDEMPOTENCY_KEY');
      let replay = false;
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const existing = d.matches.find((m) => m.eventId === ev.id && m.idempotencyKey === key);
        if (existing) {
          const rNo = normalizeLegband(red, ev.legbandWidth);
          const bNo = normalizeLegband(blue, ev.legbandWidth);
          const s = matchRow(d, existing);
          if (s.red.legband !== rNo || s.blue.legband !== bNo) throw conflict('This request key was already used for a different match.', 'IDEMPOTENCY_MISMATCH');
          replay = true;
          return s;
        }
        if (!CAN_MATCH.includes(ev.status)) throw badRequest(`Matching is not open for this event (status: ${ev.status}).`, 'EVENT_CLOSED');
        const { redLb, blueLb } = validatePair(d, ev, red, blue);

        let fightNumber;
        let sequence;
        if (isDraw(ev)) {
          // Raffle: the operator types the drawn number. Fights run in fight-number order.
          fightNumber = checkDrawnNumber(d, ev, drawnInput);
          sequence = fightNumber;
          if (d.matches.some((m) => m.eventId === ev.id && m.sequence === sequence)) {
            sequence = d.matches.filter((m) => m.eventId === ev.id).reduce((mx, m) => Math.max(mx, m.sequence), 0) + 1;
          }
        } else {
          fightNumber = ev.nextFightNumber;
          while (d.matches.some((m) => m.eventId === ev.id && m.fightNumber === fightNumber)) fightNumber += 1;
          ev.nextFightNumber = fightNumber + 1;
          sequence = d.matches.filter((m) => m.eventId === ev.id).reduce((mx, m) => Math.max(mx, m.sequence), 0) + 1;
        }

        const ts = now();
        const match = {
          id: store.nextId(d, 'match'), eventId: ev.id, fightNumber, sequence,
          redLegbandId: redLb.id, blueLegbandId: blueLb.id,
          status: 'CONFIRMED', result: null, redPoints: null, bluePoints: null,
          idempotencyKey: key, confirmedBy: user.id, confirmedAt: ts,
          cancelledBy: null, cancelledAt: null, cancelReason: null, completedBy: null, completedAt: null,
          createdAt: ts, updatedAt: ts,
        };
        // Guarded status change: fails if either legband is no longer free.
        for (const lb of [redLb, blueLb]) {
          if (lb.status !== 'AVAILABLE' || lb.matchId != null) throw conflict(`Legband ${lb.number} was just taken by another operator.`, 'UNAVAILABLE');
          lb.status = 'MATCHED';
          lb.matchId = match.id;
          lb.updatedAt = ts;
        }
        d.matches.push(match);
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'match', entityId: match.id, matchId: match.id, action: 'MATCH_CONFIRMED', newValues: { fightNumber, red: redLb.number, blue: blueLb.number }, userId: user.id });
        return matchRow(d, match);
      });
      if (!replay) publish(eventId, 'match:confirmed', { match: row });
      return { match: row, replay };
    },

    cancel(eventId, matchId, reason, user) {
      const why = cleanText(reason, 300);
      if (!why) throw badRequest('A reason is required to cancel a match.', 'VALIDATION', { field: 'reason' });
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const m = requireMatch(d, ev, matchId);
        if (m.status !== 'CONFIRMED') throw conflict(`Only a confirmed (not yet fought) match can be cancelled. ${fightLabel(m.fightNumber)} is ${m.status}.`);
        const ts = now();
        m.status = 'CANCELLED';
        m.cancelledBy = user.id; m.cancelledAt = ts; m.cancelReason = why; m.updatedAt = ts;
        for (const id of [m.redLegbandId, m.blueLegbandId]) {
          const lb = d.legbands.find((l) => l.id === id);
          lb.status = 'INACTIVE';
          lb.statusReason = `Cancelled ${fightLabel(m.fightNumber)}`;
          lb.updatedAt = ts;
        }
        if (ev.display.currentMatchId === m.id) {
          const nxt = nextPending(d, ev, m);
          ev.display.currentMatchId = nxt ? nxt.id : null;
        }
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'match', entityId: m.id, matchId: m.id, action: 'MATCH_CANCELLED', oldValues: { status: 'CONFIRMED' }, newValues: { status: 'CANCELLED', legbandsInactive: true }, reason: why, userId: user.id });
        return matchRow(d, m);
      });
      publish(eventId, 'match:cancelled', { match: row });
      return row;
    },

    /**
     * Undo a confirmed match that was entered by mistake and has not been fought.
     * Both legbands become available again and the fight number is released.
     * Unlike cancel, the match is removed; the audit log keeps the record.
     */
    unmatch(eventId, matchId, reason, user) {
      const why = cleanText(reason, 300);
      if (!why) throw badRequest('A reason is required to unmatch.', 'VALIDATION', { field: 'reason' });
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        if (!CAN_MATCH.includes(ev.status)) throw badRequest(`Matching is not open for this event (status: ${ev.status}).`, 'EVENT_CLOSED');
        const m = requireMatch(d, ev, matchId);
        if (m.status !== 'CONFIRMED') throw conflict(`Only a confirmed match that has not been fought can be unmatched. ${fightLabel(m.fightNumber)} is ${m.status}.`);
        const snapshot = matchRow(d, m);
        const ts = now();
        for (const id of [m.redLegbandId, m.blueLegbandId]) {
          const lb = d.legbands.find((l) => l.id === id);
          if (!lb || lb.status !== 'MATCHED' || lb.matchId !== m.id) throw conflict(`Legband ${lb ? lb.number : id} is not in this match.`);
          lb.status = 'AVAILABLE';
          lb.matchId = null;
          lb.statusReason = null;
          lb.updatedAt = ts;
        }
        if (ev.display.currentMatchId === m.id) {
          const nxt = nextPending(d, ev, m);
          ev.display.currentMatchId = nxt ? nxt.id : null;
        }
        const fightNumber = m.fightNumber;
        const idx = d.matches.findIndex((x) => x.id === m.id);
        d.matches.splice(idx, 1);
        if (!isDraw(ev)) {
          const rest = d.matches.filter((x) => x.eventId === ev.id);
          const floor = (ev.startingFightNumber || 1) - 1;
          const maxN = rest.reduce((mx, x) => Math.max(mx, x.fightNumber), floor);
          if (fightNumber > maxN) ev.nextFightNumber = maxN + 1;
        }
        bumpVersion(d, ev.id);
        addAudit(store, d, {
          eventId: ev.id, entity: 'match', entityId: m.id, matchId: m.id, action: 'MATCH_UNMATCHED',
          oldValues: { fightNumber, red: snapshot.red.legband, blue: snapshot.blue.legband, status: 'CONFIRMED' },
          newValues: { removed: true, legbandsAvailable: true },
          reason: why, userId: user.id,
        });
        return snapshot;
      });
      publish(eventId, 'match:unmatched', { match: row });
      return row;
    },

    /** Replace one corner's legband (e.g. operator typed the wrong number). The removed legband becomes available again. */
    correctLegband(eventId, matchId, { corner, legband, reason }, user) {
      const why = cleanText(reason, 300);
      if (!why) throw badRequest('A reason is required.', 'VALIDATION', { field: 'reason' });
      if (!['red', 'blue'].includes(corner)) throw badRequest('Corner must be red or blue.');
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const m = requireMatch(d, ev, matchId);
        if (m.status !== 'CONFIRMED') throw conflict('Only a confirmed (not yet fought) match can be corrected.');
        const oldId = corner === 'red' ? m.redLegbandId : m.blueLegbandId;
        const oldLb = d.legbands.find((l) => l.id === oldId);
        // Temporarily free the old legband so validation treats the pair as new.
        oldLb.status = 'AVAILABLE'; oldLb.matchId = null;
        const otherLb = d.legbands.find((l) => l.id === (corner === 'red' ? m.blueLegbandId : m.redLegbandId));
        otherLb.status = 'AVAILABLE'; otherLb.matchId = null;
        const pair = corner === 'red' ? validatePair(d, ev, legband, otherLb.number) : validatePair(d, ev, otherLb.number, legband);
        const newLb = corner === 'red' ? pair.redLb : pair.blueLb;
        const ts = now();
        otherLb.status = 'MATCHED'; otherLb.matchId = m.id;
        newLb.status = 'MATCHED'; newLb.matchId = m.id; newLb.updatedAt = ts;
        oldLb.updatedAt = ts; oldLb.statusReason = `Corrected out of ${fightLabel(m.fightNumber)}`;
        if (corner === 'red') m.redLegbandId = newLb.id; else m.blueLegbandId = newLb.id;
        m.updatedAt = ts;
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'match', entityId: m.id, matchId: m.id, action: 'MATCH_LEGBAND_CORRECTED', oldValues: { corner, legband: oldLb.number }, newValues: { corner, legband: newLb.number }, reason: why, userId: user.id });
        return matchRow(d, m);
      });
      publish(eventId, 'match:updated', { match: row });
      return row;
    },

    setFightNumber(eventId, matchId, { fightNumber, reason }, user) {
      const why = cleanText(reason, 300);
      if (!why) throw badRequest('A reason is required.', 'VALIDATION', { field: 'reason' });
      const n = Number(fightNumber);
      if (!Number.isInteger(n) || n < 1 || n > 9999) throw badRequest('Fight number must be a whole number from 1 to 9999.');
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const m = requireMatch(d, ev, matchId);
        if (m.status === 'CANCELLED') throw conflict('A cancelled match keeps its original fight number.');
        if (m.fightNumber === n) return matchRow(d, m);
        const clash = d.matches.find((x) => x.eventId === ev.id && x.fightNumber === n);
        if (clash) throw conflict(`${fightLabel(n)} is already used${clash.status === 'CANCELLED' ? ' by a cancelled match' : ''}.`);
        const old = m.fightNumber;
        m.fightNumber = n;
        m.updatedAt = now();
        if (isDraw(ev)) {
          if (!d.matches.some((x) => x.eventId === ev.id && x.id !== m.id && x.sequence === n)) m.sequence = n;
        } else if (n >= ev.nextFightNumber) ev.nextFightNumber = n + 1;
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'match', entityId: m.id, matchId: m.id, action: 'FIGHT_NUMBER_CHANGED', oldValues: { fightNumber: old }, newValues: { fightNumber: n }, reason: why, userId: user.id });
        return matchRow(d, m);
      });
      publish(eventId, 'fight:sequence-updated', { match: row });
      return row;
    },

    /** Move a pending fight up or down in the running order (swaps with its neighbour). */
    move(eventId, matchId, direction, reason, user) {
      if (!['up', 'down'].includes(direction)) throw badRequest('Direction must be up or down.');
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const m = requireMatch(d, ev, matchId);
        if (m.status !== 'CONFIRMED') throw conflict('Only fights that have not been fought can be moved.');
        const pending = queue(d, ev).filter((x) => x.status === 'CONFIRMED');
        const i = pending.findIndex((x) => x.id === m.id);
        const j = direction === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= pending.length) throw conflict(`This fight is already at the ${direction === 'up' ? 'top' : 'bottom'} of the queue.`);
        const other = pending[j];
        [m.sequence, other.sequence] = [other.sequence, m.sequence];
        m.updatedAt = now(); other.updatedAt = now();
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'match', entityId: m.id, matchId: m.id, action: 'FIGHT_REORDERED', oldValues: { before: other.fightNumber }, newValues: { direction, swappedWith: other.fightNumber }, reason: cleanText(reason, 300) || null, userId: user.id });
        return matchRow(d, m);
      });
      publish(eventId, 'fight:sequence-updated', { match: row });
      return row;
    },

    /** Swap which entry is MERON (red) and which is WALA (blue) for a fight that has not been decided. */
    swapCorners(eventId, matchId, user) {
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const m = requireMatch(d, ev, matchId);
        if (m.status !== 'CONFIRMED') throw conflict('Meron/Wala can only be changed before the result is declared.');
        const before = { meron: d.legbands.find((l) => l.id === m.redLegbandId).number, wala: d.legbands.find((l) => l.id === m.blueLegbandId).number };
        [m.redLegbandId, m.blueLegbandId] = [m.blueLegbandId, m.redLegbandId];
        m.updatedAt = now();
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'match', entityId: m.id, matchId: m.id, action: 'MERON_WALA_SWAPPED', oldValues: before, newValues: { meron: before.wala, wala: before.meron }, userId: user.id });
        return matchRow(d, m);
      });
      publish(eventId, 'match:updated', { match: row });
      return row;
    },

    /** Record 1-0, 0-1 or 1/2-1/2. Changing an existing result needs an admin and a reason. */
    recordResult(eventId, matchId, { result, advance = false, reason }, user) {
      if (!RESULTS[result]) throw badRequest('Result must be RED, BLUE or DRAW.');
      const why = cleanText(reason, 300);
      const row = store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        if (!CAN_RUN_FIGHTS.includes(ev.status) && user.role !== 'ADMIN') throw badRequest(`Fights are not running for this event (status: ${ev.status}).`, 'EVENT_CLOSED');
        const m = requireMatch(d, ev, matchId);
        if (m.status === 'CANCELLED') throw conflict('This match was cancelled.');
        const isChange = m.status === 'COMPLETED';
        if (isChange) {
          if (user.role !== 'ADMIN') throw forbidden('Only an administrator can change a recorded result.');
          if (!why) throw badRequest('A reason is required to change a result.', 'VALIDATION', { field: 'reason' });
        }
        const old = { status: m.status, result: m.result };
        const ts = now();
        m.status = 'COMPLETED';
        m.result = result;
        m.redPoints = RESULTS[result].red;
        m.bluePoints = RESULTS[result].blue;
        m.completedBy = user.id; m.completedAt = isChange && m.completedAt ? m.completedAt : ts; m.updatedAt = ts;
        if (advance && ev.display.currentMatchId === m.id) {
          const nxt = nextPending(d, ev, m);
          if (nxt) ev.display.currentMatchId = nxt.id;
        }
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'match', entityId: m.id, matchId: m.id, action: isChange ? 'RESULT_CHANGED' : 'RESULT_RECORDED', oldValues: old, newValues: { result, redPoints: m.redPoints, bluePoints: m.bluePoints }, reason: why || null, userId: user.id });
        return matchRow(d, m);
      });
      publish(eventId, 'match:updated', { match: row });
      return row;
    },

    // ---------- Display / current fight ----------

    displayState(eventId) {
      const d = store.data;
      const ev = requireEvent(d, eventId);
      const q = queue(d, ev);
      const current = ev.display.currentMatchId ? d.matches.find((m) => m.id === ev.display.currentMatchId) : null;
      const pending = q.filter((m) => m.status === 'CONFIRMED' && (!current || m.id !== current.id));
      const afterCurrent = current ? [...pending.filter((m) => m.sequence > current.sequence), ...pending.filter((m) => m.sequence < current.sequence)] : pending;
      const next = afterCurrent[0] || null;
      const upcoming = afterCurrent.slice(1, 1 + ev.display.upcomingCount);
      const slim = (m) => {
        if (!m) return null;
        const r = matchRow(d, m);
        return { id: r.id, fightNumber: r.fightNumber, status: r.status, result: r.result, redPoints: r.redPoints, bluePoints: r.bluePoints, red: r.red, blue: r.blue };
      };
      // Per-side score boards for /tv/meron and /tv/wala. Boxes fill in the order the entry's
      // fights were decided (first result -> box 1, second -> box 2), whichever chicken fought.
      const board = (legbandId, corner) => {
        const lb = d.legbands.find((l) => l.id === legbandId);
        const entry = lb && d.entries.find((e) => e.id === lb.entryId);
        if (!entry) return null;
        const scores = entryBoxes(d, entry, current);
        // Outcome of the active fight once its result is declared (drives the WINNER design).
        let outcome = null;
        if (current && current.status === 'COMPLETED') {
          outcome = current.result === 'DRAW' ? 'DRAW' : (current.result === corner ? 'WIN' : 'LOSE');
        }
        const owner = d.participants.find((x) => x.id === entry.participantId);
        return { entryName: entry.entryName, participantName: owner ? owner.name : '', address: entry.address || '', entryNumber: entry.entryNumber, scores, outcome };
      };
      const sides = current ? { meron: board(current.redLegbandId, 'RED'), wala: board(current.blueLegbandId, 'BLUE') } : null;
      return {
        eventId: ev.id,
        version: ev.stateVersion,
        event: { name: ev.name, date: ev.date, venue: ev.venue, status: ev.status },
        published: ev.display.published,
        upcomingCount: ev.display.upcomingCount,
        current: slim(current),
        next: slim(next),
        upcoming: upcoming.map(slim),
        remaining: afterCurrent.length,
        sides,
        generatedAt: now(),
      };
    },

    setCurrent(eventId, matchId, user) {
      store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        let m = null;
        if (matchId != null && matchId !== '') {
          m = requireMatch(d, ev, matchId);
          if (m.status === 'CANCELLED') throw conflict('A cancelled match cannot be the current fight.');
        }
        const old = ev.display.currentMatchId;
        ev.display.currentMatchId = m ? m.id : null;
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'display', action: 'CURRENT_FIGHT_SET', oldValues: { matchId: old }, newValues: { matchId: m ? m.id : null, fightNumber: m ? m.fightNumber : null }, userId: user.id });
      });
      publish(eventId, 'fight:current-changed', {});
      return svc.displayState(eventId);
    },

    advance(eventId, user, direction = 'next') {
      store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const current = ev.display.currentMatchId ? d.matches.find((m) => m.id === ev.display.currentMatchId) : null;
        let target;
        if (direction === 'next') {
          target = nextPending(d, ev, current);
          if (!target) throw conflict('There is no next fight in the queue.');
        } else {
          const q = queue(d, ev);
          target = current ? [...q].reverse().find((m) => m.sequence < current.sequence) : null;
          if (!target) throw conflict('There is no previous fight.');
        }
        ev.display.currentMatchId = target.id;
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'display', action: direction === 'next' ? 'FIGHT_ADVANCED' : 'FIGHT_BACK', oldValues: { matchId: current ? current.id : null }, newValues: { matchId: target.id, fightNumber: target.fightNumber }, userId: user.id });
      });
      publish(eventId, 'fight:current-changed', {});
      return svc.displayState(eventId);
    },

    updateDisplay(eventId, { published, upcomingCount }, user) {
      store.transaction((d) => {
        const ev = requireEvent(d, eventId);
        const old = { ...ev.display };
        if (published !== undefined) ev.display.published = !!published;
        if (upcomingCount !== undefined) {
          const n = Number(upcomingCount);
          if (!Number.isInteger(n) || n < 0 || n > 20) throw badRequest('Upcoming fights must be between 0 and 20.');
          ev.display.upcomingCount = n;
        }
        bumpVersion(d, ev.id);
        addAudit(store, d, { eventId: ev.id, entity: 'display', action: 'DISPLAY_SETTINGS', oldValues: old, newValues: { ...ev.display }, userId: user.id });
      });
      publish(eventId, 'display:refresh', {});
      return svc.displayState(eventId);
    },

    refreshDisplays(eventId) {
      store.transaction((d) => { const ev = requireEvent(d, eventId); bumpVersion(d, ev.id); });
      publish(eventId, 'display:refresh', { forceReload: true });
      return svc.displayState(eventId);
    },

    /** Score list of every entry: Entry | box 1 | box 2 (in the order results were declared). */
    /**
     * Gamecock list: one row per legband (plus one row for an entry that has no legband yet),
     * with owner, entry, status and - when matched - the opponent.
     * status: NOT_MATCHED | MATCHED | FOUGHT | CANCELLED | WITHDRAWN | NO_LEGBAND
     */
    gamecocks(eventId) {
      const data = store.data;
      const ev = requireEvent(data, eventId);
      const rows = [];
      const entries = data.entries.filter((e) => e.eventId === ev.id);
      for (const e of entries) {
        const owner = data.participants.find((p) => p.id === e.participantId);
        const base = { entryId: e.id, entryNumber: e.entryNumber, entryName: e.entryName, address: e.address || '', owner: owner ? owner.name : '' };
        const lbs = data.legbands.filter((l) => l.entryId === e.id).sort((a, b) => a.slot - b.slot);
        if (!lbs.length) {
          rows.push({ ...base, legband: null, slot: null, status: e.status === 'WITHDRAWN' ? 'WITHDRAWN' : 'NO_LEGBAND', fight: null });
          continue;
        }
        for (const lb of lbs) {
          const m = lb.matchId ? data.matches.find((x) => x.id === lb.matchId) : null;
          let status = 'NOT_MATCHED';
          if (lb.status === 'WITHDRAWN' || e.status === 'WITHDRAWN') status = 'WITHDRAWN';
          if (m) status = m.status === 'CANCELLED' ? 'CANCELLED' : m.status === 'COMPLETED' ? 'FOUGHT' : 'MATCHED';
          else if (lb.status === 'INACTIVE') status = 'CANCELLED';
          let fight = null;
          if (m) {
            const isRed = m.redLegbandId === lb.id;
            const opp = side(data, isRed ? m.blueLegbandId : m.redLegbandId);
            const myPts = isRed ? m.redPoints : m.bluePoints;
            fight = {
              matchId: m.id, fightNumber: m.fightNumber, status: m.status,
              corner: isRed ? 'MERON' : 'WALA',
              points: m.status === 'COMPLETED' ? myPts : null,
              outcome: m.status !== 'COMPLETED' ? null : myPts === 1 ? 'WIN' : myPts === 0 ? 'LOSE' : 'DRAW',
              isCurrent: ev.display.currentMatchId === m.id,
              opponent: opp && { legband: opp.legband, slot: opp.slot, entryNumber: opp.entryNumber, entryName: opp.entryName, owner: opp.participantName },
            };
          }
          rows.push({ ...base, legband: lb.number, slot: lb.slot, status, fight });
        }
      }
      return rows.sort((a, b) => (a.legband === null) - (b.legband === null)
        || (a.legband && b.legband ? a.legband.localeCompare(b.legband, undefined, { numeric: true }) : 0)
        || a.owner.localeCompare(b.owner) || a.entryNumber - b.entryNumber);
    },

    entryScores(eventId) {
      const d = store.data;
      const ev = requireEvent(d, eventId);
      const current = ev.display.currentMatchId ? d.matches.find((m) => m.id === ev.display.currentMatchId) : null;
      return d.entries
        .filter((e) => e.eventId === ev.id && e.status === 'ACTIVE')
        .sort((a, b) => a.entryNumber - b.entryNumber)
        .map((e) => {
          const p = d.participants.find((x) => x.id === e.participantId);
          const scores = entryBoxes(d, e, current);
          const decided = scores.filter((x) => x.points != null);
          return {
            entryId: e.id, entryNumber: e.entryNumber, entryName: e.entryName, address: e.address || '', participantName: p ? p.name : '',
            scores, total: decided.reduce((t, x) => t + x.points, 0), decided: decided.length,
          };
        });
    },

    standings(eventId) {
      const d = store.data;
      const ev = requireEvent(d, eventId);
      const byEntry = new Map();
      for (const e of d.entries.filter((x) => x.eventId === ev.id)) {
        const p = d.participants.find((x) => x.id === e.participantId);
        byEntry.set(e.id, { entryNumber: e.entryNumber, entryName: e.entryName, participantName: p ? p.name : '', fights: 0, wins: 0, losses: 0, draws: 0, points: 0, pending: 0, status: e.status });
      }
      for (const m of d.matches.filter((x) => x.eventId === ev.id && x.status !== 'CANCELLED')) {
        for (const [lbId, pts] of [[m.redLegbandId, m.redPoints], [m.blueLegbandId, m.bluePoints]]) {
          const lb = d.legbands.find((l) => l.id === lbId);
          const s = lb && byEntry.get(lb.entryId);
          if (!s) continue;
          if (m.status === 'CONFIRMED') { s.pending += 1; continue; }
          s.fights += 1;
          s.points += pts;
          if (pts === 1) s.wins += 1; else if (pts === 0) s.losses += 1; else s.draws += 1;
        }
      }
      return [...byEntry.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.entryNumber - b.entryNumber);
    },
  };
  return svc;
}

module.exports = { createMatchService };
