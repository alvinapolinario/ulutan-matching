/* Read-only TV display. The server's committed state is always the truth:
 * - on every (re)connect the full state is fetched,
 * - each pushed state carries a version; older versions are ignored,
 * - a quiet poll every 30 s repairs anything missed. */
(function () {
  'use strict';
  const eventId = Number(document.body.dataset.eventId) || null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(3, '0');
  const pts = (p) => (p === 0.5 ? '½' : String(p));
  let version = -1;

  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    const stage = $('stage');
    stage.style.transform = `scale(${s})`;
    stage.style.left = `${(window.innerWidth - 1920 * s) / 2}px`;
    stage.style.top = `${(window.innerHeight - 1080 * s) / 2}px`;
  }
  window.addEventListener('resize', fit); fit();
  const tick = () => { $('clock').textContent = new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }); };
  setInterval(tick, 5000); tick();

  function standby(title, sub) {
    $('live').classList.add('hidden');
    $('standby').classList.remove('hidden');
    $('standbyTitle').textContent = title;
    $('standbySub').textContent = sub || '';
  }

  function render(s) {
    if (!s || (typeof s.version === 'number' && s.version < version)) return;
    version = s.version;
    $('evName').textContent = s.event.name;
    $('evSub').textContent = [s.event.venue, s.event.date].filter(Boolean).join(' · ');
    if (!s.published) return standby('PLEASE STAND BY', 'Fights will appear here shortly');
    const main = s.current || s.next;
    if (!main) return standby('NO FIGHTS YET', 'Matched fights will appear here');
    $('standby').classList.add('hidden');
    $('live').classList.remove('hidden');
    $('nowLabel').textContent = s.current ? 'NOW FIGHTING' : 'FIRST FIGHT';
    $('nowNo').textContent = `FIGHT #${pad(main.fightNumber)}`;
    $('nowRedName').textContent = main.red.entryName;
    $('nowRedLb').textContent = main.red.legband;
    $('nowRedAddr').textContent = main.red.address || '';
    $('nowBlueAddr').textContent = main.blue.address || '';
    $('nowBlueName').textContent = main.blue.entryName;
    $('nowBlueLb').textContent = main.blue.legband;
    const redBox = document.querySelector('.tv-corner.red');
    const blueBox = document.querySelector('.tv-corner.blue');
    const done = main.status === 'COMPLETED';
    redBox.classList.toggle('is-win', done && main.result === 'RED');
    redBox.classList.toggle('is-lose', done && main.result === 'BLUE');
    blueBox.classList.toggle('is-win', done && main.result === 'BLUE');
    blueBox.classList.toggle('is-lose', done && main.result === 'RED');
    const res = $('nowResult');
    if (main.status === 'COMPLETED') {
      res.textContent = main.result === 'DRAW' ? `DRAW  ½ – ½` : `${main.result === 'RED' ? 'MERON' : 'WALA'} WINS  ${pts(main.redPoints)} – ${pts(main.bluePoints)}`;
      res.classList.remove('hidden');
    } else res.classList.add('hidden');

    const next = s.current ? s.next : (s.upcoming[0] || null);
    const upcoming = s.current ? s.upcoming : s.upcoming.slice(1);
    $('nextBody').innerHTML = next ? `
      <div class="tv-next-no">FIGHT #${pad(next.fightNumber)}</div>
      <div class="tv-next-row red"><span class="tv-name">${esc(next.red.entryName)}</span><span class="lb">${esc(next.red.legband)}</span></div>
      <div class="tv-next-row blue"><span class="tv-name">${esc(next.blue.entryName)}</span><span class="lb">${esc(next.blue.legband)}</span></div>`
      : '<div class="tv-empty">No more fights in the queue</div>';
    $('upWrap').classList.toggle('hidden', s.upcomingCount === 0);
    $('upRows').innerHTML = upcoming.length ? upcoming.map((m) => `<tr>
      <td class="no">#${pad(m.fightNumber)}</td><td class="r">${esc(m.red.entryName)}</td><td class="lb r">${esc(m.red.legband)}</td>
      <td class="vs">vs</td><td class="b">${esc(m.blue.entryName)}</td><td class="lb b">${esc(m.blue.legband)}</td></tr>`).join('')
      : '<tr><td class="tv-empty">—</td></tr>';
    // Hide rows that do not fully fit in the box (no half-cut rows on the TV).
    const box = $('upWrap').getBoundingClientRect();
    [...$('upRows').rows].forEach((tr) => { if (tr.getBoundingClientRect().bottom > box.bottom - 8) tr.style.visibility = 'hidden'; });
  }

  async function fetchState() {
    if (!eventId) return;
    try {
      const res = await fetch(`/api/events/${eventId}/display-state`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
      if (res.ok) { const s = await res.json(); version = -1; render(s); }
    } catch (_) { /* offline: keep showing the last good state */ }
  }

  if (!eventId) { standby('NO EVENT', 'Create an event in Event Settings'); return; }

  const socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 5000 });
  socket.on('connect', () => {
    $('conn').classList.add('hidden');
    socket.emit('join', eventId, (ack) => { if (ack && ack.ok) { version = -1; render(ack.state); } else fetchState(); });
  });
  socket.on('disconnect', () => $('conn').classList.remove('hidden'));
  socket.on('connect_error', (err) => {
    $('conn').classList.remove('hidden');
    if (err && err.message === 'unauthenticated') location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  });
  socket.on('display:refresh', (msg) => {
    if (msg.eventId !== eventId) return;
    if (msg.forceReload) { location.reload(); return; }
    if (msg.state) render(msg.state); else fetchState();
  });
  setInterval(fetchState, 30000);
  fetchState();
})();
