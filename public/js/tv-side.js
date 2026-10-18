/* MERON / WALA side screen. Shows the current fight's entry for one corner and the
 * scores (1, 0, ½) of that entry's two chickens. Same live-update rules as /display:
 * full state on every (re)connect, versioned pushes, and a 30 s safety poll. */
(function () {
  'use strict';
  const eventId = Number(document.body.dataset.eventId) || null;
  const side = document.body.dataset.side; // 'meron' | 'wala'
  const $ = (id) => document.getElementById(id);
  const fmt = (p) => (p == null ? '' : p === 0.5 ? '½' : String(p));
  let version = -1;

  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    const stage = $('stage');
    stage.style.transform = `scale(${s})`;
    stage.style.left = `${(window.innerWidth - 1920 * s) / 2}px`;
    stage.style.top = `${(window.innerHeight - 1080 * s) / 2}px`;
  }
  window.addEventListener('resize', fit); fit();

  function setOutcome(outcome) {
    const st = $('stage');
    st.classList.remove('out-win', 'out-lose', 'out-draw');
    const stamp = $('stamp');
    if (outcome === 'WIN') { st.classList.add('out-win'); stamp.textContent = 'WINNER'; }
    else if (outcome === 'DRAW') { st.classList.add('out-draw'); stamp.textContent = 'DRAW'; }
    else if (outcome === 'LOSE') { st.classList.add('out-lose'); stamp.textContent = ''; }
    else stamp.textContent = '';
  }

  function idle(text) {
    setOutcome(null);
    $('entryName').textContent = text;
    $('entryAddr').textContent = '';
    $('entryOwner').textContent = '';
    $('sideBody').classList.add('hidden');
    $('entryName').classList.add('idle');
    $('scores').classList.add('hidden');
  }

  function render(s) {
    if (!s || (typeof s.version === 'number' && s.version < version)) return;
    version = s.version;
    const b = s.published && s.sides ? s.sides[side] : null;
    if (!b) return idle('NO ACTIVE FIGHT');
    $('entryName').textContent = b.entryName;
    $('entryAddr').textContent = b.address || '';
    $('entryOwner').textContent = b.participantName && b.participantName !== b.entryName ? b.participantName : '';
    $('sideBody').classList.remove('hidden');
    $('entryName').classList.remove('idle');
    $('scores').classList.remove('hidden');
    setOutcome(b.outcome);
    b.scores.forEach((sc, i) => {
      $(`score${i + 1}`).textContent = fmt(sc.points);
      $(`box${i + 1}`).classList.toggle('fighting', sc.fighting);
    });
  }

  async function fetchState() {
    if (!eventId) return;
    try {
      const res = await fetch(`/api/events/${eventId}/display-state`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
      if (res.ok) { version = -1; render(await res.json()); }
    } catch (_) { /* offline: keep the last good state */ }
  }

  if (!eventId) { idle('NO EVENT'); return; }
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
