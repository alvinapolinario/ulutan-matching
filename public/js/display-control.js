(function () {
  'use strict';
  const { api, ev, esc, toast, pad, pts } = App;
  const $ = (id) => document.getElementById(id);
  let state = null;   // display state (active fight etc.)
  let list = [];      // all matches
  let busy = false;
  let advanceAfter = false; // keep the winner on the TV until "Next fight" unless the operator wants auto-advance

  const RESULT_TEXT = { RED: 'MERON wins', BLUE: 'WALA wins', DRAW: 'Draw' };
  const statusBadge = (m) => {
    if (m.status === 'CANCELLED') return '<span class="badge text-bg-secondary">CANCELLED</span>';
    if (m.status === 'COMPLETED') return `<span class="badge text-bg-success">DONE</span> <span class="fw-bold ms-1">${pts(m.redPoints)} – ${pts(m.bluePoints)}</span> <span class="small text-muted d-block">${RESULT_TEXT[m.result]}</span>`;
    return '<span class="badge text-bg-primary">PENDING</span>';
  };
  const sideCell = (s, cls) => `<div class="fw-semibold ${cls}">${esc(s.entryName)} <span class="lb">${esc(s.legband)}</span></div><div class="small text-muted">#${s.entryNumber} · ${esc(s.participantName)}${s.address ? ' · ' + esc(s.address) : ''}</div>`;

  // ---------- Active fight panel ----------
  function corner(label, cls, s, outcome) {
    const tag = outcome === 'WIN' ? '<span class="win-tag">WINNER</span>' : outcome === 'DRAW' ? '<span class="win-tag draw">DRAW</span>' : '';
    return `<div class="af-corner ${cls} ${outcome ? 'is-' + outcome.toLowerCase() : ''}">
      <div class="af-label">${label} ${tag}</div>
      <div class="af-entry">${esc(s.entryName)}</div>
      ${s.address ? `<div class="af-addr">${esc(s.address)}</div>` : ''}
      <div class="af-lb lb">${esc(s.legband)}</div>
      <div class="small">#${s.entryNumber} · ${esc(s.participantName)}</div>
    </div>`;
  }

  function renderActive() {
    const c = state && state.current;
    $('activeBadge').innerHTML = c ? `<span class="badge text-bg-${c.status === 'COMPLETED' ? 'success' : 'warning'}">${c.status === 'COMPLETED' ? 'RESULT DECLARED' : 'NOW FIGHTING'}</span>` : '';
    if (!c) {
      $('activeBox').innerHTML = `<div class="text-muted py-3">No active fight. Press <b>Next fight →</b> to start with the first fight, or click <b>Set active</b> on any match below.${state && state.next ? ` First in line: <b>Fight #${pad(state.next.fightNumber)}</b>.` : ''}</div>`;
      return;
    }
    const sides = state.sides || {};
    const out = (k) => (sides[k] ? sides[k].outcome : null);
    const pending = c.status === 'CONFIRMED';
    $('activeBox').innerHTML = `
      <div class="af-grid">
        <div class="af-no">#${pad(c.fightNumber)}</div>
        ${corner('MERON', 'meron', c.red, out('meron'))}
        <div class="af-mid">
          <span class="af-vs">VS</span>
          ${pending ? `<button class="btn btn-sm btn-outline-dark" data-swap="${c.id}" title="Swap Meron and Wala">⇄ Swap</button>` : ''}
        </div>
        ${corner('WALA', 'wala', c.blue, out('wala'))}
      </div>
      ${pending ? `
      <div class="d-flex flex-wrap align-items-center gap-3 mt-3">
        <div>
          <div class="small fw-semibold mb-1">Who is MERON?</div>
          <div class="btn-group" role="radiogroup" aria-label="Who is Meron">
            <input type="radio" class="btn-check" name="meronPick" id="pickA" value="keep" checked>
            <label class="btn btn-outline-danger" for="pickA">${esc(c.red.entryName)} <span class="lb">${esc(c.red.legband)}</span></label>
            <input type="radio" class="btn-check" name="meronPick" id="pickB" value="swap">
            <label class="btn btn-outline-danger" for="pickB">${esc(c.blue.entryName)} <span class="lb">${esc(c.blue.legband)}</span></label>
          </div>
        </div>
        <div class="ms-lg-auto">
          <div class="small fw-semibold mb-1">Declare result</div>
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <button class="btn btn-danger btn-lg fw-bold" data-result="RED">MERON wins · 1–0</button>
            <button class="btn btn-secondary btn-lg fw-bold" data-result="DRAW">Draw · ½–½</button>
            <button class="btn btn-primary btn-lg fw-bold" data-result="BLUE">WALA wins · 0–1</button>
          </div>
          <div class="form-check mt-2"><input class="form-check-input" type="checkbox" id="advanceAfter" ${advanceAfter ? 'checked' : ''}>
            <label class="form-check-label small" for="advanceAfter">Go to the next fight right after the result (otherwise the WINNER stays on the TV until you press Next)</label></div>
        </div>
      </div>` : `
      <div class="alert alert-success d-flex align-items-center mt-3 mb-0">
        <div><b>${RESULT_TEXT[c.result]}</b> · ${pts(c.redPoints)} – ${pts(c.bluePoints)}. The WINNER is showing on the TV screens.</div>
        <button class="btn btn-success ms-auto" data-next>Next fight →</button>
      </div>`}`;
  }

  // ---------- All matches table ----------
  function options(m) {
    if (m.status === 'CANCELLED') return `<span class="small text-muted">${esc(m.cancelReason || '')}</span>`;
    const isActive = state && state.current && state.current.id === m.id;
    const b = [];
    b.push(isActive ? '<span class="badge text-bg-warning align-middle me-1">ACTIVE</span>'
      : `<button class="btn btn-sm btn-warning fw-semibold" data-active="${m.id}">Set active</button>`);
    if (m.status === 'CONFIRMED') b.push(`<button class="btn btn-sm btn-outline-dark" data-swap="${m.id}" title="Swap Meron and Wala">⇄ Meron/Wala</button>`);
    const menu = [];
    if (m.status === 'CONFIRMED') {
      menu.push(`<li><button class="dropdown-item" data-row-result="RED" data-id="${m.id}">MERON wins (1–0)</button></li>`,
        `<li><button class="dropdown-item" data-row-result="DRAW" data-id="${m.id}">Draw (½–½)</button></li>`,
        `<li><button class="dropdown-item" data-row-result="BLUE" data-id="${m.id}">WALA wins (0–1)</button></li>`);
      if (App.isAdmin) menu.push('<li><hr class="dropdown-divider"></li>', `<li><button class="dropdown-item text-danger" data-cancel="${m.id}">Cancel match…</button></li>`);
    } else if (App.isAdmin) {
      menu.push(`<li><button class="dropdown-item" data-change="${m.id}">Change result…</button></li>`);
    }
    if (menu.length) b.push(`<div class="btn-group"><button class="btn btn-sm btn-outline-secondary dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">More</button><ul class="dropdown-menu dropdown-menu-end">${menu.join('')}</ul></div>`);
    return b.join(' ');
  }

  const matchesQuery = (m, q) => {
    if (!q) return true;
    if (/^\d+$/.test(q) && m.fightNumber === parseInt(q, 10)) return true;
    return [m.red.legband, m.blue.legband, m.red.entryName, m.blue.entryName, m.red.participantName, m.blue.participantName].join(' ').toLowerCase().includes(q);
  };
  const rowCells = (m) => `<td class="fw-bold fs-5">#${pad(m.fightNumber)}</td>
      <td class="${m.result === 'RED' ? 'won' : ''}">${sideCell(m.red, 'row-red')}</td>
      <td class="text-muted small text-center">vs</td>
      <td class="${m.result === 'BLUE' ? 'won' : ''}">${sideCell(m.blue, 'row-blue')}</td>`;

  function renderTable() {
    const q = $('search').value.trim().toLowerCase().replace(/^#/, '');
    const activeId = state && state.current ? state.current.id : null;
    const remaining = list.filter((m) => m.status === 'CONFIRMED');
    const done = list.filter((m) => m.status === 'COMPLETED').sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
    const cancelled = list.filter((m) => m.status === 'CANCELLED');
    const rem = remaining.filter((m) => matchesQuery(m, q));
    $('remRows').innerHTML = rem.length ? rem.map((m) => `<tr class="${m.id === activeId ? 'is-current' : ''}">${rowCells(m)}
      <td class="text-end text-nowrap actions">${options(m)}</td></tr>`).join('')
      : `<tr><td colspan="5" class="text-muted">${remaining.length ? 'No match found.' : 'All matches are finished.'}</td></tr>`;
    const dn = done.filter((m) => matchesQuery(m, q));
    $('doneRows').innerHTML = dn.length ? dn.map((m) => `<tr class="is-done ${m.id === activeId ? 'is-current' : ''}">${rowCells(m)}
      <td>${statusBadge(m)}</td><td class="text-end text-nowrap actions">${options(m)}</td></tr>`).join('')
      : '<tr><td colspan="6" class="text-muted">No finished matches yet.</td></tr>';
    const cn = cancelled.filter((m) => matchesQuery(m, q));
    $('cancelRows').innerHTML = cn.length ? cn.map((m) => `<tr class="is-cancelled">${rowCells(m)}<td class="small">${esc(m.cancelReason || '')}</td></tr>`).join('')
      : '<tr><td colspan="5" class="text-muted">No cancelled matches.</td></tr>';
    $('remCount').textContent = remaining.length;
    $('doneCount').textContent = done.length;
    $('cancelCount').textContent = cancelled.length;
    $('counts').textContent = `${list.length} matches · ${done.length} finished`;
  }

  // ---------- Entry scores ----------
  let scores = [];
  const scoreCell = (sc) => {
    if (sc.points == null) return `<td class="sc"><span class="${sc.fighting ? 'now' : ''}">&nbsp;</span></td>`;
    const cls = sc.points === 1 ? 'w' : sc.points === 0 ? 'l' : 'd';
    return `<td class="sc"><span class="${cls}" title="Fight #${pad(sc.fightNumber)}">${pts(sc.points)}</span></td>`;
  };
  function renderScores() {
    const q = $('scoreSearch').value.trim().toLowerCase();
    const rows = scores.filter((e) => !q || `${e.entryNumber} ${e.entryName} ${e.participantName}`.toLowerCase().includes(q));
    $('scoreRows').innerHTML = rows.length ? rows.map((e) => `<tr class="${e.scores.some((x) => x.fighting) ? 'is-fighting' : ''}">
      <td><div class="fw-semibold">${esc(e.entryName)}</div><div class="small text-muted">#${e.entryNumber} · ${esc(e.participantName)}${e.address ? ' · ' + esc(e.address) : ''}</div></td>
      ${scoreCell(e.scores[0])}${scoreCell(e.scores[1])}</tr>`).join('')
      : '<tr><td colspan="3" class="text-muted">No entries.</td></tr>';
  }

  function renderSettings() {
    $('publishedSwitch').checked = state.published;
    if (document.activeElement !== $('upcomingCount')) $('upcomingCount').value = state.upcomingCount;
  }

  async function load() {
    const [s, l, sc] = await Promise.all([api('GET', ev('/display-state')), api('GET', ev('/matches')), api('GET', ev('/entry-scores'))]);
    state = s; list = l; scores = sc;
    renderActive(); renderTable(); renderScores(); renderSettings();
  }
  const reload = () => load().catch((e) => toast(e.message, 'danger'));

  async function act(fn, okMsg) {
    if (busy) return;
    busy = true;
    try { await fn(); if (okMsg) toast(okMsg); await load(); } catch (e) { toast(e.message, 'danger', 6000); } finally { busy = false; }
  }
  const label = (m) => `Fight #${pad(m.fightNumber)}`;
  const byId = (id) => list.find((m) => m.id === Number(id)) || (state.current && state.current.id === Number(id) ? state.current : null);
  const declare = (id, result, advance) => act(() => api('POST', ev(`/matches/${id}/result`), { result, advance }), `Result saved: ${RESULT_TEXT[result]}.`);
  const swap = (id) => act(() => api('POST', ev(`/matches/${id}/swap`)), 'Meron and Wala swapped.');

  $('nextBtn').onclick = () => act(() => api('POST', ev('/display/advance'), { direction: 'next' }));
  $('backBtn').onclick = () => act(() => api('POST', ev('/display/advance'), { direction: 'back' }));
  $('publishedSwitch').onchange = (e) => act(() => api('PATCH', ev('/display'), { published: e.target.checked }), e.target.checked ? 'TV now shows the fights.' : 'TV shows “Please stand by”.');
  $('saveUpcoming').onclick = () => act(() => api('PATCH', ev('/display'), { upcomingCount: Number($('upcomingCount').value) }), 'Saved.');
  $('refreshBtn').onclick = () => act(() => api('POST', ev('/display/refresh')), 'All TV screens told to reload.');

  $('activeBox').addEventListener('change', (e) => {
    if (e.target.id === 'advanceAfter') advanceAfter = e.target.checked;
    if (e.target.name === 'meronPick' && e.target.value === 'swap' && state.current) swap(state.current.id);
  });
  $('activeBox').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !state.current) return;
    if (b.dataset.result) declare(state.current.id, b.dataset.result, advanceAfter);
    else if (b.dataset.swap) swap(b.dataset.swap);
    else if ('next' in b.dataset) $('nextBtn').click();
  });

  const onRowClick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.active) {
      const m = byId(b.dataset.active);
      return act(() => api('POST', ev('/display/current'), { matchId: m.id }), `${label(m)} is now the active fight.`);
    }
    if (b.dataset.swap) return swap(b.dataset.swap);
    if (b.dataset.rowResult) return declare(b.dataset.id, b.dataset.rowResult, false);
    if (b.dataset.cancel) {
      const m = byId(b.dataset.cancel);
      const r = await App.prompt({ title: `Cancel ${label(m)}?`, label: 'Reason (required)', confirmText: 'Cancel match', danger: true,
        extraHtml: '<div class="alert alert-warning py-2">Both legbands become <b>unusable</b>. The fight number is not reused.</div>' });
      if (r) act(() => api('POST', ev(`/matches/${m.id}/cancel`), { reason: r.value }), `${label(m)} cancelled.`);
      return;
    }
    if (b.dataset.change) {
      const m = byId(b.dataset.change);
      const r = await App.prompt({ title: `Change result — ${label(m)}`, label: 'Reason (required)', confirmText: 'Save result',
        extraHtml: '<label class="form-label">New result</label><select class="form-select mb-3" name="result"><option value="RED">MERON wins (1 – 0)</option><option value="DRAW">Draw (½ – ½)</option><option value="BLUE">WALA wins (0 – 1)</option></select>' });
      if (r) act(() => api('POST', ev(`/matches/${m.id}/result`), { result: r.form.result.value, reason: r.value }), 'Result changed.');
    }
  };
  $('remRows').addEventListener('click', onRowClick);
  $('doneRows').addEventListener('click', onRowClick);
  $('search').addEventListener('input', App.debounce(renderTable, 120));
  $('scoreSearch').addEventListener('input', App.debounce(renderScores, 120));

  App.live({ onChange: reload, onResync: reload });
  reload();
})();
