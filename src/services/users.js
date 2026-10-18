'use strict';
const bcrypt = require('bcryptjs');
const { badRequest, conflict, notFound, ROLES, now, cleanText } = require('../lib/common');
const { addAudit } = require('./audit');

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, role: u.role, status: u.status, createdAt: u.createdAt };
}

// Passwords used by the demo/seed scripts and other obvious ones. Accounts still using one are flagged to admins.
const WEAK_PASSWORDS = ['admin123', 'operator123', 'tv1234', 'op1234', 'password', '123456', 'admin', 'changeme'];

function createUserService(store) {
  const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
  const weak = new Set(); // user ids whose password is in WEAK_PASSWORDS
  function validatePassword(pw) {
    if (typeof pw !== 'string' || pw.length < 6) throw badRequest('Password must be at least 6 characters.');
  }
  const markWeak = (id, pw) => { if (WEAK_PASSWORDS.includes(pw)) weak.add(id); else weak.delete(id); };

  const svc = {
    hasUsers: () => store.data.users.length > 0,
    list: () => store.data.users.map(publicUser),
    get: (id) => publicUser(store.data.users.find((u) => u.id === Number(id))),

    create({ username, password, role }, actorId = null) {
      const uname = cleanText(username, 40).toLowerCase();
      if (!/^[a-z0-9._-]{2,40}$/.test(uname)) throw badRequest('Username must be 2-40 characters: letters, numbers, dot, dash or underscore.');
      if (!ROLES.includes(role)) throw badRequest('Invalid role.');
      validatePassword(password);
      const hash = bcrypt.hashSync(password, 10);
      const created = store.transaction((d) => {
        if (d.users.some((u) => u.username === uname)) throw conflict(`Username "${uname}" is already taken.`);
        const user = { id: store.nextId(d, 'user'), username: uname, passwordHash: hash, role, status: 'ACTIVE', createdAt: now() };
        d.users.push(user);
        addAudit(store, d, { entity: 'user', entityId: user.id, action: 'USER_CREATED', newValues: { username: uname, role }, userId: actorId || user.id });
        return publicUser(user);
      });
      markWeak(created.id, password);
      return created;
    },

    update(id, { role, status, password }, actorId) {
      const hash = password ? (validatePassword(password), bcrypt.hashSync(password, 10)) : null;
      const updated = store.transaction((d) => {
        const u = d.users.find((x) => x.id === Number(id));
        if (!u) throw notFound('User not found.');
        const old = { role: u.role, status: u.status };
        if (role !== undefined) { if (!ROLES.includes(role)) throw badRequest('Invalid role.'); u.role = role; }
        if (status !== undefined) { if (!['ACTIVE', 'DISABLED'].includes(status)) throw badRequest('Invalid status.'); u.status = status; }
        if (hash) u.passwordHash = hash;
        const activeAdmins = d.users.filter((x) => x.role === 'ADMIN' && x.status === 'ACTIVE');
        if (activeAdmins.length === 0) throw badRequest('At least one active administrator is required.');
        addAudit(store, d, { entity: 'user', entityId: u.id, action: 'USER_UPDATED', oldValues: old, newValues: { role: u.role, status: u.status, passwordChanged: !!hash }, userId: actorId });
        return publicUser(u);
      });
      if (hash) markWeak(updated.id, password);
      return updated;
    },

    /** Check stored hashes against WEAK_PASSWORDS in the background (bcrypt is slow on purpose). */
    async scanWeakPasswords() {
      for (const u of store.data.users) {
        for (const pw of WEAK_PASSWORDS) {
          // eslint-disable-next-line no-await-in-loop
          if (await bcrypt.compare(pw, u.passwordHash)) { weak.add(u.id); break; }
        }
      }
      return svc.weakAccounts();
    },
    /** Active accounts that still use a demo/obvious password. */
    weakAccounts: () => store.data.users.filter((u) => weak.has(u.id) && u.status === 'ACTIVE').map((u) => u.username),

    authenticate(username, password) {
      const u = store.data.users.find((x) => x.username === cleanText(username, 40).toLowerCase());
      // Always run bcrypt to keep timing similar for unknown users.
      const ok = bcrypt.compareSync(String(password || ''), u ? u.passwordHash : DUMMY_HASH);
      if (!u || !ok || u.status !== 'ACTIVE') return null;
      return publicUser(u);
    },
  };
  return svc;
}

module.exports = { createUserService, publicUser };
