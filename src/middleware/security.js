'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const { AppError, forbidden } = require('../lib/common');

/** Small file-backed session store so logins survive a server restart. */
class FileSessionStore extends session.Store {
  constructor(file) {
    super();
    this.file = file;
    this.sessions = {};
    try { this.sessions = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { this.sessions = {}; }
    this._pending = null;
    const t = setInterval(() => this._prune(), 10 * 60 * 1000); t.unref();
  }
  _flush() {
    if (this._pending) return;
    this._pending = setTimeout(() => {
      this._pending = null;
      const tmp = `${this.file}.tmp`;
      try { fs.writeFileSync(tmp, JSON.stringify(this.sessions), { mode: 0o600 }); fs.renameSync(tmp, this.file); try { fs.chmodSync(this.file, 0o600); } catch (_) { /* Windows */ } } catch (e) { console.error('[session] save failed', e.message); }
    }, 200);
    this._pending.unref();
  }
  _prune() {
    const t = Date.now();
    for (const [sid, s] of Object.entries(this.sessions)) if (s.cookie && s.cookie.expires && new Date(s.cookie.expires).getTime() < t) delete this.sessions[sid];
    this._flush();
  }
  get(sid, cb) {
    const s = this.sessions[sid];
    if (s && s.cookie && s.cookie.expires && new Date(s.cookie.expires).getTime() < Date.now()) { delete this.sessions[sid]; return cb(null, null); }
    cb(null, s ? structuredClone(s) : null);
  }
  set(sid, sess, cb) { this.sessions[sid] = JSON.parse(JSON.stringify(sess)); this._flush(); cb && cb(null); }
  destroy(sid, cb) { delete this.sessions[sid]; this._flush(); cb && cb(null); }
  touch(sid, sess, cb) { if (this.sessions[sid]) this.sessions[sid].cookie = JSON.parse(JSON.stringify(sess.cookie)); this._flush(); cb && cb(null); }
}

function loadSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(dataDir, 'session-secret.txt');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}

function sessionMiddleware({ dataDir, secure = false }) {
  return session({
    name: 'ulutan.sid',
    secret: loadSecret(dataDir),
    store: new FileSessionStore(path.join(dataDir, 'sessions.json')),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure, maxAge: 12 * 60 * 60 * 1000 },
  });
}

/** Synchronizer-token CSRF protection. Token lives in the session; sent as header or _csrf field. */
function csrf(req, res, next) {
  if (req.session && !req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session ? req.session.csrfToken : '';
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf);
  const expected = req.session && req.session.csrfToken;
  if (!sent || !expected || sent.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
    return next(new AppError(403, 'Your session form token expired. Reload the page and try again.', 'CSRF'));
  }
  next();
}

const isApi = (req) => req.originalUrl.startsWith('/api/');

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (isApi(req)) return next(new AppError(401, 'Please log in again.', 'UNAUTHENTICATED'));
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session && req.session.user;
    if (!u) return requireLogin(req, res, next);
    if (!roles.includes(u.role)) return next(forbidden());
    next();
  };
}

module.exports = { sessionMiddleware, csrf, requireLogin, requireRole, FileSessionStore };
