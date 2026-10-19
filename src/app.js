'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const { Store } = require('./db/store');
const { sessionMiddleware, csrf } = require('./middleware/security');
const { createBus, attachRealtime } = require('./realtime');
const { createUserService } = require('./services/users');
const { createEventService } = require('./services/events');
const { createRegistrationService } = require('./services/registration');
const { createMatchService } = require('./services/matches');
const { createReportService } = require('./services/reports');
const { AppError } = require('./lib/common');

/**
 * Build the whole application. Returns { app, server, io, store, services }.
 * Used by server.js and by the automated tests.
 */
function createApp({ dataDir = path.join(__dirname, '..', 'data'), dbFile, backupIntervalMs, secureCookies = false, trustProxy = false, lock = true } = {}) {
  const store = new Store(dbFile || path.join(dataDir, 'db.json'), { backupDir: path.join(dataDir, 'backups'), backupIntervalMs, lock });
  const bus = createBus();
  const services = { store };
  services.users = createUserService(store);
  services.events = createEventService(store, bus);
  services.registration = createRegistrationService(store, bus);
  services.matches = createMatchService(store, bus);
  services.reports = createReportService(store, services);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  // One hop only (the local nginx). A boolean `true` would trust every forwarded address.
  app.set('trust proxy', trustProxy ? 1 : false);
  app.set('view cache', true); // templates are compiled once (restart the server after updating views)
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'ws:', 'wss:'], fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"], frameAncestors: ["'self'"], baseUri: ["'self'"], formAction: ["'self'"],
      },
    },
    strictTransportSecurity: false, // plain HTTP on a LAN
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  }));

  const root = path.join(__dirname, '..');
  // Page scripts/styles: browsers must re-check them on every load (cheap 304 on a LAN), and every
  // link carries ?v=<server start time>, so an update is never mixed with an old cached file.
  const assetVersion = Date.now().toString(36);
  app.locals.v = assetVersion;
  app.use('/static', express.static(path.join(root, 'public'), { maxAge: 0 }));
  app.use('/vendor/bootstrap', express.static(path.join(root, 'node_modules', 'bootstrap', 'dist'), { maxAge: '7d' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  const sessionMw = sessionMiddleware({ dataDir, secure: secureCookies });
  app.use(sessionMw);

  // Keep the session user in sync with the database (role change / disabled account).
  app.use((req, res, next) => {
    if (req.session && req.session.user) {
      const fresh = services.users.get(req.session.user.id);
      if (!fresh || fresh.status !== 'ACTIVE') { delete req.session.user; } else { req.session.user = fresh; }
    }
    next();
  });
  app.use(csrf);

  app.use('/api', require('./routes/api')(services));
  app.use('/', require('./routes/pages')(services));

  app.use((req, res, next) => next(new AppError(404, 'Page not found.', 'NOT_FOUND')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[error]', err);
    const body = { error: status >= 500 ? 'Server error. The action was not saved.' : err.message, code: err.code || 'ERROR', details: err.details };
    if (req.originalUrl.startsWith('/api/') || req.xhr || (req.get('accept') || '').includes('application/json')) return res.status(status).json(body);
    res.status(status).render('error', { status, message: body.error, user: req.session && req.session.user });
  });

  const server = http.createServer(app);
  const io = attachRealtime(server, { sessionMw, bus, services });
  return { app, server, io, store, services, bus };
}

module.exports = { createApp };
