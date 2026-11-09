/* MERON / WALA side screen. Shows the current fight's entry for one corner and the
 * scores (1, 0, ½) of that entry's chickens (one box per cock, 2-5 per the event setting). Same live-update rules as /display:
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

  /**
   * An entry name too long for one line wraps onto a second line; the owner line is hidden to make room.
   * If it would still need a third line, the font shrinks until the whole name fits on two lines.
   */
  const MIN_NAME_PX = 56;
  function fitName() {
    const el = $('entryName');
    el.classList.remove('two-line');
    el.style.fontSize = '';
    const tooLong = !el.classList.contains('idle') && el.scrollWidth > el.clientWidth + 1;
    el.classList.toggle('two-line', tooLong);
    $('entryOwner').classList.toggle('hidden', tooLong);
    if (!tooLong) return;
    // Count lines with the 2-line clamp lifted (offsetHeight ignores the stage's scale transform).
    el.classList.add('measure');
    const lines = () => Math.round(el.offsetHeight / parseFloat(getComputedStyle(el).lineHeight));
    let px = parseFloat(getComputedStyle(el).fontSize);
    while (px > MIN_NAME_PX && (lines() > 2 || el.scrollWidth > el.clientWidth + 1)) {
      px = Math.max(MIN_NAME_PX, px - 4);
      el.style.fontSize = `${px}px`;
    }
    el.classList.remove('measure');
  }
  window.addEventListener('resize', fitName);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitName);

  /** One score box per cock (the event's "cocks per entry", 2-5). Rebuilt if the setting changes live. */
  function ensureBoxes(n) {
    const wrap = $('scores');
    if (!n || wrap.children.length === n) return;
    wrap.innerHTML = Array.from({ length: n }, (_, i) => `<div class="score-box" id="box${i + 1}"><span class="score" id="score${i + 1}"></span></div>`).join('');
    const st = $('stage');
    st.className = st.className.replace(/\bboxes-\d+\b/g, '').trim();
    st.classList.add(`boxes-${n}`);
  }

  function idle(text) {
    setOutcome(null);
    $('entryName').textContent = text;
    $('entryAddr').textContent = '';
    $('entryOwner').textContent = '';
    $('sideBody').classList.add('hidden');
    $('entryName').classList.add('idle');
    $('scores').classList.add('hidden');
    fitName();
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
    fitName();
    setOutcome(b.outcome);
    ensureBoxes(b.scores.length);
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
