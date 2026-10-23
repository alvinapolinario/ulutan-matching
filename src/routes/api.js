'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireLogin, requireRole } = require('../middleware/security');
const { notFound } = require('../lib/common');

const STAFF = ['ADMIN', 'OPERATOR'];

module.exports = function apiRoutes(services) {
  const r = express.Router();
  const { events, registration, matches, users } = services;
  const me = (req) => req.session.user;

  // Fast lookups during matching are allowed, but stop runaway scripts.
  r.use(rateLimit({ windowMs: 60 * 1000, limit: 1200, standardHeaders: true, legacyHeaders: false }));
  r.use(requireLogin);

  r.param('eventId', (req, res, next, id) => {
    const ev = events.find(id);
    if (!ev) return next(notFound('Event not found.'));
    req.event = ev;
    next();
  });

  // ----- Events -----
  r.get('/events', requireRole(...STAFF), (req, res) => res.json(events.list().map((e) => ({ ...e, legbandsIssued: services.store.data.legbands.filter((l) => l.eventId === e.id).length }))));
  r.post('/events', requireRole('ADMIN'), (req, res) => res.status(201).json(events.create(req.body, me(req).id)));
  r.get('/events/:eventId', (req, res) => res.json(req.event));
  r.patch('/events/:eventId', requireRole('ADMIN'), (req, res) => res.json(events.update(req.event.id, req.body, me(req).id)));
  r.post('/events/:eventId/status', requireRole('ADMIN'), (req, res) => res.json(events.setStatus(req.event.id, req.body.status, me(req).id)));
  r.get('/events/:eventId/summary', requireRole(...STAFF), (req, res) => {
    const ds = matches.displayState(req.event.id);
    res.json({ ...registration.summary(req.event.id), currentFight: ds.current ? ds.current.fightNumber : null, nextFight: ds.next ? ds.next.fightNumber : null, nextFightNumber: req.event.nextFightNumber, version: req.event.stateVersion });
  });

  // ----- Registration -----
  r.get('/participants', requireRole(...STAFF), (req, res) => res.json(registration.searchParticipants(req.query.q)));
  r.get('/events/:eventId/entries', requireRole(...STAFF), (req, res) => res.json(registration.listEntries(req.event.id, req.query)));
  r.get('/events/:eventId/entries/:entryId', requireRole(...STAFF), (req, res) => res.json(registration.getEntry(req.event.id, req.params.entryId)));
  r.post('/events/:eventId/entries', requireRole(...STAFF), (req, res) => res.status(201).json(registration.register(req.event.id, req.body, me(req).id)));
  r.patch('/events/:eventId/entries/:entryId', requireRole(...STAFF), (req, res) => res.json(registration.updateEntry(req.event.id, req.params.entryId, req.body, me(req))));
  r.post('/events/:eventId/entries/:entryId/legbands', requireRole(...STAFF), (req, res) => res.status(201).json(registration.addLegband(req.event.id, req.params.entryId, me(req).id, req.body && req.body.legband)));
  r.post('/events/:eventId/entries/:entryId/withdraw', requireRole('ADMIN'), (req, res) => res.json(registration.withdrawEntry(req.event.id, req.params.entryId, req.body.reason, me(req).id)));
  r.get('/events/:eventId/legbands', requireRole(...STAFF), (req, res) => res.json(registration.listLegbands(req.event.id, req.query)));
  r.get('/events/:eventId/legbands/:number', requireRole(...STAFF), (req, res) => res.json(registration.lookupLegband(req.event.id, req.params.number)));
  r.post('/events/:eventId/legbands/:number/withdraw', requireRole('ADMIN'), (req, res) => res.json(registration.withdrawLegband(req.event.id, req.params.number, req.body.reason, me(req).id)));

  // ----- Matching -----
  r.post('/events/:eventId/matches/check', requireRole(...STAFF), (req, res) => res.json(matches.check(req.event.id, req.body)));
  r.post('/events/:eventId/matches', requireRole(...STAFF), (req, res) => {
    const out = matches.confirm(req.event.id, req.body, me(req));
    res.status(out.replay ? 200 : 201).json(out);
  });
  r.get('/events/:eventId/matches', requireRole(...STAFF), (req, res) => res.json(matches.list(req.event.id, req.query)));
  r.get('/events/:eventId/matches/:matchId', requireRole(...STAFF), (req, res) => res.json(matches.get(req.event.id, req.params.matchId)));
  r.post('/events/:eventId/matches/:matchId/cancel', requireRole('ADMIN'), (req, res) => res.json(matches.cancel(req.event.id, req.params.matchId, req.body.reason, me(req))));
  r.post('/events/:eventId/matches/:matchId/unmatch', requireRole(...STAFF), (req, res) => res.json(matches.unmatch(req.event.id, req.params.matchId, req.body.reason, me(req))));
  r.post('/events/:eventId/matches/:matchId/correct', requireRole('ADMIN'), (req, res) => res.json(matches.correctLegband(req.event.id, req.params.matchId, req.body, me(req))));
  r.post('/events/:eventId/matches/:matchId/fight-number', requireRole('ADMIN'), (req, res) => res.json(matches.setFightNumber(req.event.id, req.params.matchId, req.body, me(req))));
  r.post('/events/:eventId/matches/:matchId/move', requireRole('ADMIN'), (req, res) => res.json(matches.move(req.event.id, req.params.matchId, req.body.direction, req.body.reason, me(req))));
  r.post('/events/:eventId/matches/:matchId/swap', requireRole(...STAFF), (req, res) => res.json(matches.swapCorners(req.event.id, req.params.matchId, me(req))));
  r.post('/events/:eventId/matches/:matchId/result', requireRole(...STAFF), (req, res) => res.json(matches.recordResult(req.event.id, req.params.matchId, req.body, me(req))));
  r.get('/events/:eventId/gamecocks', requireRole(...STAFF), (req, res) => res.json(matches.gamecocks(req.event.id)));
  r.get('/events/:eventId/entry-scores', requireRole(...STAFF), (req, res) => res.json(matches.entryScores(req.event.id)));
  r.get('/events/:eventId/standings', requireRole(...STAFF), (req, res) => res.json(matches.standings(req.event.id)));

  // ----- Display -----
  r.get('/events/:eventId/display-state', (req, res) => res.json(matches.displayState(req.event.id)));
  r.post('/events/:eventId/display/current', requireRole(...STAFF), (req, res) => res.json(matches.setCurrent(req.event.id, req.body.matchId, me(req))));
  r.post('/events/:eventId/display/advance', requireRole(...STAFF), (req, res) => res.json(matches.advance(req.event.id, me(req), req.body.direction === 'back' ? 'back' : 'next')));
  r.patch('/events/:eventId/display', requireRole(...STAFF), (req, res) => res.json(matches.updateDisplay(req.event.id, req.body, me(req))));
  r.post('/events/:eventId/display/refresh', requireRole(...STAFF), (req, res) => res.json(matches.refreshDisplays(req.event.id)));

  // ----- Audit -----
  r.get('/events/:eventId/audit', requireRole('ADMIN'), (req, res) => res.json(services.reports.audit(req.event.id)));

  // ----- Users -----
  r.get('/users', requireRole('ADMIN'), (req, res) => res.json(users.list()));
  r.post('/users', requireRole('ADMIN'), (req, res) => res.status(201).json(users.create(req.body, me(req).id)));
  r.patch('/users/:id', requireRole('ADMIN'), (req, res) => res.json(users.update(req.params.id, req.body, me(req).id)));

  // ----- Backup -----
  r.post('/backup', requireRole('ADMIN'), (req, res) => res.json({ file: require('path').basename(services.store.backupNow('manual')) }));

  return r;
};
