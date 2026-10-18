'use strict';
const { notFound, pad, points } = require('../lib/common');

const RESULT_LABEL = { RED: 'Red wins (1-0)', BLUE: 'Blue wins (0-1)', DRAW: 'Draw (½-½)' };

function createReportService(store, { registration, matches }) {
  const userName = (id) => { const u = store.data.users.find((x) => x.id === id); return u ? u.username : ''; };
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { hour12: true }) : '');
  const fight = (n) => (n == null ? '' : pad(n));
  const matchCols = [
    { key: 'fight', label: 'Fight' },
    { key: 'redEntry', label: 'Red Entry' }, { key: 'redLb', label: 'Red LB', legband: true },
    { key: 'blueEntry', label: 'Blue Entry' }, { key: 'blueLb', label: 'Blue LB', legband: true },
  ];
  const matchFlat = (m) => ({
    fight: fight(m.fightNumber),
    redEntry: m.red ? `#${m.red.entryNumber} ${m.red.entryName}` : '', redLb: m.red ? m.red.legband : '',
    blueEntry: m.blue ? `#${m.blue.entryNumber} ${m.blue.entryName}` : '', blueLb: m.blue ? m.blue.legband : '',
    status: m.status, result: m.result ? `${points(m.redPoints)} - ${points(m.bluePoints)}` : '',
    confirmedBy: m.confirmedBy || '', confirmedAt: fmtTime(m.confirmedAt),
    cancelledBy: m.cancelledBy || '', cancelledAt: fmtTime(m.cancelledAt), cancelReason: m.cancelReason || '',
  });

  const defs = {
    registration: {
      title: 'Registration Master List',
      build(id) {
        const rows = registration.listEntries(id).map((e) => ({
          entryNumber: e.entryNumber, entryName: e.entryName, address: e.address, participant: e.participantName,
          lb1: e.legband1 ? e.legband1.number : '', lb2: e.legband2 ? e.legband2.number : '', status: e.displayStatus,
        }));
        return { columns: [{ key: 'entryNumber', label: 'Entry No.' }, { key: 'entryName', label: 'Entry Name' }, { key: 'address', label: 'Address' }, { key: 'participant', label: 'Participant' }, { key: 'lb1', label: 'Legband 1', legband: true }, { key: 'lb2', label: 'Legband 2', legband: true }, { key: 'status', label: 'Status' }], rows };
      },
    },
    legbands: {
      title: 'Legband Master List',
      build(id, status) {
        const rows = registration.listLegbands(id, { status }).map((l) => ({
          number: l.number, slot: l.slot, entryNumber: l.entry ? l.entry.entryNumber : '', entryName: l.entry ? l.entry.entryName : '',
          participant: l.participant ? l.participant.name : '', status: l.status, fight: l.match ? fight(l.match.fightNumber) : '',
        }));
        return { columns: [{ key: 'number', label: 'Legband', legband: true }, { key: 'slot', label: 'Slot' }, { key: 'entryNumber', label: 'Entry No.' }, { key: 'entryName', label: 'Entry Name' }, { key: 'participant', label: 'Participant' }, { key: 'status', label: 'Status' }, { key: 'fight', label: 'Fight' }], rows };
      },
    },
    available: { title: 'Available Legbands', build: (id) => defs.legbands.build(id, 'AVAILABLE') },
    gamecocks: {
      title: 'Gamecock List',
      build(id) {
        const label = { NOT_MATCHED: 'Not matched', MATCHED: 'Matched', FOUGHT: 'Fought', CANCELLED: 'Cancelled', WITHDRAWN: 'Withdrawn', NO_LEGBAND: 'No legband yet' };
        const rows = matches.gamecocks(id).map((g) => {
          const f = g.fight; const o = f && f.opponent;
          return {
            legband: g.legband || '', slot: g.slot ? `Entry #${g.slot}` : '', entryName: g.entryName, owner: g.owner,
            status: label[g.status] + (f && f.outcome ? ` - ${f.outcome}` : ''),
            fight: f ? `${fight(f.fightNumber)} ${f.corner}` : '',
            opponent: o ? `${o.entryName} Entry #${o.slot} (${o.owner})` : '', oppLb: o ? o.legband : '',
          };
        });
        return { columns: [{ key: 'legband', label: 'Legband', legband: true }, { key: 'entryName', label: 'Entry Name' }, { key: 'slot', label: 'Entry No.' }, { key: 'owner', label: 'Owner' }, { key: 'status', label: 'Status' }, { key: 'fight', label: 'Fight' }, { key: 'opponent', label: 'Opponent' }, { key: 'oppLb', label: 'Opp. LB', legband: true }], rows };
      },
    },
    fights: {
      title: 'Official Matching List',
      build(id) {
        const rows = matches.list(id).filter((m) => m.status !== 'CANCELLED').sort((a, b) => a.fightNumber - b.fightNumber).map(matchFlat);
        return { columns: [...matchCols, { key: 'status', label: 'Status' }, { key: 'result', label: 'Result' }], rows };
      },
    },
    cancelled: {
      title: 'Cancelled Matches',
      build(id) {
        const rows = matches.list(id, { status: 'CANCELLED' }).map(matchFlat);
        return { columns: [...matchCols, { key: 'cancelledBy', label: 'Cancelled By' }, { key: 'cancelledAt', label: 'Cancelled At' }, { key: 'cancelReason', label: 'Reason' }], rows };
      },
    },
    sequence: {
      title: 'Fight Sequence',
      build(id) {
        const rows = matches.list(id).filter((m) => m.status !== 'CANCELLED').map((m, i) => ({ order: i + 1, ...matchFlat(m), resultLabel: m.result ? RESULT_LABEL[m.result] : (m.isCurrent ? 'NOW FIGHTING' : '') }));
        return { columns: [{ key: 'order', label: 'Order' }, ...matchCols, { key: 'resultLabel', label: 'Result' }], rows };
      },
    },
    scores: {
      title: 'Entry Scores',
      build(id) {
        const rows = matches.entryScores(id).map((e) => ({ entry: `#${e.entryNumber} ${e.entryName}`, participant: e.participantName, s1: points(e.scores[0].points), s2: points(e.scores[1].points) }));
        return { columns: [{ key: 'entry', label: 'Entry' }, { key: 'participant', label: 'Participant' }, { key: 's1', label: 'Score 1' }, { key: 's2', label: 'Score 2' }], rows };
      },
    },
    standings: {
      title: 'Standings (Points per Entry)',
      build(id) {
        const rows = matches.standings(id).map((s, i) => ({ rank: i + 1, ...s, points: points(s.points) || '0' }));
        return { columns: [{ key: 'rank', label: 'Rank' }, { key: 'entryNumber', label: 'Entry No.' }, { key: 'entryName', label: 'Entry Name' }, { key: 'participantName', label: 'Participant' }, { key: 'fights', label: 'Fought' }, { key: 'wins', label: 'W' }, { key: 'draws', label: 'D' }, { key: 'losses', label: 'L' }, { key: 'pending', label: 'Pending' }, { key: 'points', label: 'Points' }], rows };
      },
    },
    summary: {
      title: 'Event Summary',
      build(id) {
        const s = registration.summary(id);
        const ds = matches.displayState(id);
        const items = [
          ['Participants', s.participants], ['Entries', s.entries], ['Incomplete entries', s.incompleteEntries],
          ['Legbands issued', s.legbandsIssued], ['Legbands left', s.legbandsLeft], ['Available legbands', s.available],
          ['Matched legbands', s.matched], ['Inactive (cancelled) legbands', s.inactive], ['Withdrawn legbands', s.withdrawn],
          ['Pending fights', s.confirmedMatches], ['Completed fights', s.completedMatches], ['Cancelled fights', s.cancelledMatches],
          ['Entries with unmatched legbands', s.unmatchedEntries],
          ['Current fight', ds.current ? fight(ds.current.fightNumber) : '-'], ['Next fight', ds.next ? fight(ds.next.fightNumber) : '-'],
        ];
        return { columns: [{ key: 'item', label: 'Item' }, { key: 'value', label: 'Value' }], rows: items.map(([item, value]) => ({ item, value })) };
      },
    },
    audit: {
      title: 'Match Audit Report',
      build(id) {
        return { columns: [{ key: 'time', label: 'Time' }, { key: 'user', label: 'User' }, { key: 'action', label: 'Action' }, { key: 'details', label: 'Details' }, { key: 'reason', label: 'Reason' }], rows: svc.audit(id) };
      },
    },
  };

  const svc = {
    list: () => Object.entries(defs).map(([key, d]) => ({ key, title: d.title })),
    audit(eventId) {
      const fmt = (o) => (o ? Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ') : '');
      return store.data.auditLogs
        .filter((a) => a.eventId === Number(eventId))
        .sort((a, b) => b.id - a.id)
        .map((a) => ({ id: a.id, time: fmtTime(a.createdAt), user: userName(a.performedBy), action: a.action, details: [a.oldValues ? `from ${fmt(a.oldValues)}` : '', a.newValues ? `to ${fmt(a.newValues)}` : ''].filter(Boolean).join(' → '), reason: a.reason || '' }));
    },
    build(key, eventId) {
      const d = defs[key];
      if (!d) throw notFound('Report not found.');
      return { key, title: d.title, ...d.build(Number(eventId)) };
    },
    /** CSV with a UTF-8 BOM. Legband columns are written as ="001" so spreadsheets keep the leading zeros. */
    toCsv(report) {
      // Text that starts with = + - @ (or tab/CR) would run as a formula in Excel: prefix it with ' (CSV injection).
      const esc = (v) => {
        let s = String(v == null ? '' : v);
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [report.columns.map((c) => esc(c.label)).join(',')];
      for (const row of report.rows) {
        lines.push(report.columns.map((c) => {
          const v = row[c.key];
          if (c.legband && v) return `"=""${v}"""`;
          return esc(v);
        }).join(','));
      }
      return '﻿' + lines.join('\r\n') + '\r\n';
    },
  };
  return svc;
}

module.exports = { createReportService };
