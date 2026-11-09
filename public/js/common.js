/* Shared helpers for operator pages. No framework, no external network. */
(function () {
  'use strict';
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const body = document.body;
  const App = (window.App = {});
  App.eventId = Number(body.dataset.eventId) || null;
  App.role = body.dataset.role || '';
  App.isAdmin = App.role === 'ADMIN';
  App.width = Number(body.dataset.legbandWidth) || 3;

  App.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  App.pad = (n, w = 3) => (n == null ? '' : String(n).padStart(w, '0'));
  App.pts = (p) => (p === 0.5 ? '½' : p == null ? '' : String(p));
  App.normLegband = (v) => {
    const s = String(v || '').trim();
    if (!/^\d{1,6}$/.test(s) || parseInt(s, 10) <= 0) return null;
    return String(parseInt(s, 10)).padStart(App.width, '0');
  };
  /**
   * What an operator typed to find a bird: "7" -> "007" (legband), "w7" / "WB 7" -> "W007" (wingband),
   * "l7" / "LB7" -> "L007" (legband). Returns null if it is not a band number.
   */
  App.normBand = (v) => {
    const m = /^(LB|L|WB|W)?[\s-]*(\d{1,6})$/.exec(String(v || '').trim().toUpperCase());
    if (!m || parseInt(m[2], 10) <= 0) return null;
    const n = String(parseInt(m[2], 10)).padStart(App.width, '0');
    return m[1] ? m[1][0] + n : n;
  };
  /** Keep only what a band can contain while typing: an optional L/W prefix and digits. */
  App.cleanBandInput = (v) => {
    const s = String(v || '').toUpperCase().replace(/[^LWB0-9]/g, '');
    const m = /^([LW]B?)?(\d*)/.exec(s);
    return (m[1] || '') + m[2];
  };
  App.eventType = (body.dataset.eventType || 'HACKFIGHT').toUpperCase();      // DERBY | HACKFIGHT
  const num = (v) => (v === '' || v == null ? null : Number(v));
  // Weight rules for cocks (on / off) and the event's allowed types of bird.
  App.weightRulesOn = body.dataset.weightRules === 'on';
  App.weightTolerance = App.weightRulesOn ? num(body.dataset.weightTolerance) : null;
  App.minWeight = App.weightRulesOn ? num(body.dataset.minWeight) : null;
  App.maxWeight = App.weightRulesOn ? num(body.dataset.maxWeight) : null;
  App.allowedTypes = (body.dataset.allowedTypes || 'COCK,STAG,BULLSTAG').split(',');
  /** Same parsing as the server: grams ("2105", "2,105") or kilograms ("2.105"). null = blank, NaN = invalid. */
  App.parseWeight = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    const m = /^(\d{1,2}(?:\.\d{1,3})?)kg$|^(\d{1,2}\.\d{1,3})$|^(\d{1,3}(?:,\d{3})|\d{1,5})g?$/.exec(s);
    if (!m) return NaN;
    const g = m[1] || m[2] ? Math.round(parseFloat(m[1] || m[2]) * 1000) : parseInt(m[3].replace(',', ''), 10);
    return g >= 1 && g <= 20000 ? g : NaN;
  };
  App.grams = (g) => (g == null ? '' : `${Number(g).toLocaleString('en-US')} g`);
  App.BIRD_LABEL = { COCK: 'Cock', STAG: 'Stag', BULLSTAG: 'Bullstag' };
  App.needsWingband = (type) => type === 'STAG' || type === 'BULLSTAG';
  /** Legband number of a bird ('' until its legband is put on). */
  App.bandLabel = (lb) => (!lb ? '' : lb.number || '');
  /** Small coloured label for a bird type. */
  App.typeBadge = (type) => `<span class="badge bird-${String(type || 'COCK').toLowerCase()}">${App.BIRD_LABEL[type] || 'Cock'}</span>`;
  App.uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

  App.api = async function (method, url, data) {
    const opts = { method, headers: { Accept: 'application/json', 'X-CSRF-Token': csrf }, credentials: 'same-origin' };
    if (data !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(data); }
    let res;
    try { res = await fetch(url, opts); } catch (e) {
      const err = new Error('Cannot reach the server. Check the network connection. Nothing was saved.');
      err.network = true; throw err;
    }
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); }
    if (!res.ok) {
      const err = new Error((json && json.error) || `Request failed (${res.status})`);
      err.status = res.status; err.code = json && json.code; err.details = json && json.details; throw err;
    }
    return json;
  };
  App.ev = (p) => `/api/events/${App.eventId}${p}`;

  App.toast = function (msg, type = 'success', ms = 3500) {
    const box = document.getElementById('toasts');
    if (!box) return alert(msg);
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${type} border-0 show`;
    el.setAttribute('role', type === 'danger' ? 'alert' : 'status');
    el.innerHTML = `<div class="d-flex"><div class="toast-body fw-semibold">${App.esc(msg)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" aria-label="Close"></button></div>`;
    el.querySelector('button').onclick = () => el.remove();
    box.appendChild(el);
    setTimeout(() => el.remove(), ms);
  };

  /** Ask for a reason with a Bootstrap modal. Resolves to the text, or null if cancelled. */
  App.prompt = function ({ title, label = 'Reason', confirmText = 'Save', danger = false, value = '', required = true, inputType = 'text', extraHtml = '' }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="modal fade" tabindex="-1" aria-modal="true" role="dialog"><div class="modal-dialog"><form class="modal-content">
        <div class="modal-header"><h5 class="modal-title">${App.esc(title)}</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
        <div class="modal-body">${extraHtml}<label class="form-label">${App.esc(label)}</label>
          <input class="form-control prompt-main" type="${inputType}" value="${App.esc(value)}" ${required ? 'required' : ''} autocomplete="off"><div class="invalid-feedback">This is required.</div></div>
        <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${App.esc(confirmText)}</button></div></form></div></div>`;
      const el = wrap.firstElementChild; document.body.appendChild(el);
      const modal = new bootstrap.Modal(el); let result = null;
      const input = el.querySelector('.prompt-main');
      el.addEventListener('shown.bs.modal', () => { const first = el.querySelector('.modal-body input, .modal-body select'); first.focus(); if (first.select) first.select(); });
      el.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        if (required && !input.value.trim()) { input.classList.add('is-invalid'); input.focus(); return; }
        const bad = [...el.querySelectorAll('.modal-body [required]')].find((x) => !x.value.trim());
        if (bad) { bad.classList.add('is-invalid'); bad.focus(); return; }
        result = { value: input.value.trim(), form: el.querySelector('form') }; modal.hide();
      });
      el.addEventListener('hidden.bs.modal', () => { el.remove(); resolve(result); });
      modal.show();
    });
  };

  /**
   * Live updates for the current event. `onChange(msg)` is called for every change;
   * `onResync()` after every (re)connect so the page reloads authoritative data.
   */
  App.live = function ({ onChange, onResync } = {}) {
    if (!App.eventId || typeof io === 'undefined') return null;
    const socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000 });
    const dot = document.getElementById('liveDot');
    const setDot = (ok) => { if (dot) { dot.className = 'live-dot ' + (ok ? 'on' : 'off'); dot.title = ok ? 'Live' : 'Reconnecting…'; } };
    let lastVersion = 0;
    socket.on('connect', () => {
      socket.emit('join', App.eventId, (ack) => { setDot(!!(ack && ack.ok)); if (ack && ack.state) lastVersion = ack.state.version; onResync && onResync(); });
    });
    socket.on('disconnect', () => setDot(false));
    socket.on('connect_error', () => setDot(false));
    socket.on('display:refresh', (msg) => {
      if (msg.eventId !== App.eventId) return;
      if (msg.version <= lastVersion) return;
      lastVersion = msg.version;
      onChange && onChange(msg);
    });
    return socket;
  };

  App.debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  document.querySelectorAll('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));
  document.querySelectorAll('[data-print]').forEach((el) => el.addEventListener('click', () => window.print()));
})();
