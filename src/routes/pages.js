'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireLogin, requireRole } = require('../middleware/security');
const { AppError, EVENT_STATUSES, EVENT_TRANSITIONS } = require('../lib/common');

const STAFF = ['ADMIN', 'OPERATOR'];

/** Only allow redirects to a path on this server: "/x", never "//host", "/\\host" or control characters. */
function safeLocalPath(v, fallback = '/') {
  if (typeof v !== 'string' || v.length > 500) return fallback;
  if (!/^\/(?![\/\\])/.test(v) || /[\\\u0000-\u001f\u007f]/.test(v)) return fallback;
  return v;
}

module.exports = function pageRoutes(services) {
  const r = express.Router();
  const { users, events, reports } = services;

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).render('login', { error: 'Too many login attempts. Wait 15 minutes and try again.', next: '/', username: '' }) });

  // Which event the user is working on (stored per session).
  r.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.path = req.path;
    res.locals.EVENT_STATUSES = EVENT_STATUSES;
    res.locals.EVENT_TRANSITIONS = EVENT_TRANSITIONS;
    res.locals.weakAccounts = req.session.user && req.session.user.role === 'ADMIN' ? users.weakAccounts() : [];
    let ev = req.session.eventId ? events.find(req.session.eventId) : null;
    if (!ev) ev = events.defaultEvent();
    req.currentEvent = ev;
    res.locals.event = ev;
    res.locals.events = events.list();
    next();
  });

  r.get('/setup', (req, res) => {
    if (users.hasUsers()) return res.redirect('/login');
    res.render('setup', { error: null, username: 'admin' });
  });
  r.post('/setup', (req, res) => {
    if (users.hasUsers()) return res.redirect('/login');
    try {
      if (req.body.password !== req.body.confirm) throw new AppError(400, 'Passwords do not match.');
      const u = users.create({ username: req.body.username, password: req.body.password, role: 'ADMIN' });
      req.session.regenerate(() => { req.session.user = u; res.redirect('/events'); });
    } catch (e) {
      res.status(400).render('setup', { error: e.message, username: req.body.username || '' });
    }
  });

  r.get('/login', (req, res) => {
    if (!users.hasUsers()) return res.redirect('/setup');
    const cur = req.session.user;
    const notice = req.query.switch && cur ? `This browser is logged in as "${cur.username}" (TV display account). Log in with an admin or operator account to open this page.` : null;
    res.render('login', { error: null, notice, next: safeLocalPath(req.query.next), username: '' });
  });
  r.post('/login', loginLimiter, (req, res) => {
    const u = users.authenticate(req.body.username, req.body.password);
    const nextUrl = safeLocalPath(req.body.next);
    if (!u) return res.status(401).render('login', { error: 'Wrong username or password.', next: nextUrl, username: req.body.username || '' });
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Session error');
      req.session.user = u;
      if (u.role === 'DISPLAY') req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // TVs stay logged in
      res.redirect(u.role === 'DISPLAY' && nextUrl === '/' ? '/display' : nextUrl);
    });
  });
  r.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

  r.use(requireLogin);

  r.post('/select-event', (req, res) => {
    const ev = events.find(req.body.eventId);
    if (ev) req.session.eventId = ev.id;
    const back = safeLocalPath(req.body.back);
    res.redirect(back);
  });

  // TV display: any logged-in role, read-only.
  r.get('/display', (req, res) => {
    const ev = req.query.event ? events.find(req.query.event) : req.currentEvent;
    res.render('display', { displayEvent: ev });
  });

  // Side screens: /tv/meron (Red corner) and /tv/wala (Blue corner).
  r.get('/tv/:side(meron|wala)', (req, res) => {
    const ev = req.query.event ? events.find(req.query.event) : req.currentEvent;
    res.render('tv-side', { displayEvent: ev, side: req.params.side });
  });

  r.get('/', (req, res, next) => (req.session.user.role === 'DISPLAY' ? res.redirect('/display') : next()));
  // A browser logged in with the TV (Display) account opening an admin page: send it to the
  // login page so the operator can sign in with an admin/operator account instead of a 403.
  r.use((req, res, next) => {
    if (req.session.user.role === 'DISPLAY') return res.redirect('/login?switch=1&next=' + encodeURIComponent(req.originalUrl));
    next();
  });
  r.use(requireRole(...STAFF));
  const needEvent = (view, title) => (req, res) => {
    if (!req.currentEvent) return res.render('no-event', { title });
    res.render(view, { title });
  };

  r.get('/', needEvent('dashboard', 'Dashboard'));
  r.get('/registration', needEvent('registration', 'Registration'));
  r.get('/matching', needEvent('matching', 'Matching'));
  r.get('/fights', needEvent('fights', 'Official Fight List'));
  r.get('/gamecocks', needEvent('gamecocks', 'Gamecocks'));
  r.get('/display-control', needEvent('display-control', 'TV Display Control'));
  r.get('/reports', needEvent('reports', 'Reports'));
  r.get('/reports/:key', (req, res) => {
    if (!req.currentEvent) return res.render('no-event', { title: 'Reports' });
    if (req.params.key === 'audit' && req.session.user.role !== 'ADMIN') throw new AppError(403, 'Only administrators can view the audit report.');
    const report = reports.build(req.params.key, req.currentEvent.id);
    if (req.query.format === 'csv') {
      const safe = `${req.currentEvent.name}-${report.title}`.replace(/[^A-Za-z0-9-]+/g, '_');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`);
      return res.send(reports.toCsv(report));
    }
    res.render('report-print', { report, printedAt: new Date() });
  });
  r.get('/events', requireRole('ADMIN'), (req, res) => res.render('events', { title: 'Event Settings' }));
  r.get('/users', requireRole('ADMIN'), (req, res) => res.render('users', { title: 'User Management' }));

  return r;
};
module.exports.safeLocalPath = safeLocalPath;
