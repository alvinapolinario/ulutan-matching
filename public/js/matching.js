(function () {
  'use strict';
  const { api, ev, esc, toast, pad } = App;
  const $ = (id) => document.getElementById(id);
  const inputs = { red: $('redInput'), blue: $('blueInput') };
  const infos = { red: $('redInfo'), blue: $('blueInfo') };
  // DRAW mode: the fight number is drawn in a raffle and typed in by the operator.
  const DRAW = document.body.dataset.fightMode === 'DRAW' && !!$('fightInput');
  const fightInput = $('fightInput');
  const fightInfo = $('fightInfo');
  const FIGHT_HINT = '<span class="text-muted">After Blue, type the drawn fight number and press Enter.</span>';
  function fightError(msg, focus = true) {
    if (!fightInfo) return;
    fightInfo.className = 'corner-info bad';
    fightInfo.innerHTML = esc(msg);
    if (focus && !pending) { fightInput.focus(); fightInput.select(); }
  }
  function fightValue() {
    const v = (fightInput.value || '').trim();
    return /^\d{1,4}$/.test(v) && Number(v) >= 1 ? String(Number(v)) : null;
  }
  const modalEl = $('confirmModal');
  const modal = new bootstrap.Modal(modalEl, { backdrop: 'static', keyboard: true });
  const confirmBtn = $('confirmBtn');
  const confirmError = $('confirmError');

  const valid = { red: null, blue: null };   // last successful lookup per corner
  let pending = null;                         // { red, blue, key } while the dialog is open
  let busy = false;
  let enterHeld = false;
  let armTimer = null;
  let confirmed = false;

  // ---------- Corner lookup ----------
  function setInfo(corner, kind, html) {
    infos[corner].className = 'corner-info' + (kind ? ' ' + kind : '');
    infos[corner].innerHTML = html;
  }
  function infoHtml(lb) {
    return `<div class="entry">#${lb.entry.entryNumber} · ${esc(lb.entry.entryName)}</div>
      <div>${esc(lb.participant ? lb.participant.name : '')}${lb.entry.address ? ' · ' + esc(lb.entry.address) : ''} · Slot ${lb.slot} · <span class="badge text-bg-success">AVAILABLE</span></div>`;
  }
  function showError(corner, msg, focus = true) {
    setInfo(corner, 'bad', esc(msg));
    valid[corner] = null;
    if (focus && !pending) { inputs[corner].focus(); inputs[corner].select(); }
  }

  const inflight = { red: null, blue: null };
  /** Look up a corner's legband. Re-uses a lookup that is already running for the same number. */
  function lookup(corner, { focusOnError = true } = {}) {
    const number = App.normLegband(inputs[corner].value);
    if (!number) { showError(corner, 'Enter a legband number (digits only).'); return Promise.resolve(false); }
    inputs[corner].value = number;
    if (valid[corner] && valid[corner].number === number) return Promise.resolve(true);
    if (inflight[corner] && inflight[corner].number === number) return inflight[corner].promise;
    const promise = doLookup(corner, number, focusOnError).finally(() => { if (inflight[corner] && inflight[corner].promise === promise) inflight[corner] = null; });
    inflight[corner] = { number, promise };
    return promise;
  }
  async function doLookup(corner, number, focusOnError) {
    setInfo(corner, '', '<span class="text-muted">Checking…</span>');
    try {
      const lb = await api('GET', ev(`/legbands/${number}`));
      if (inputs[corner].value !== number) return false; // operator changed the number meanwhile
      if (!lb.available) { showError(corner, lb.unavailableReason || `${corner === 'red' ? 'Red' : 'Blue'} Corner legband is unavailable.`, focusOnError); return false; }
      valid[corner] = lb;
      setInfo(corner, 'ok', infoHtml(lb));
      return true;
    } catch (e) { showError(corner, e.message, focusOnError); return false; }
  }

  let reviewAgain = false;
  async function review() {
    if (busy) { reviewAgain = true; return; } // run once more when the current check finishes
    busy = true;
    reviewAgain = false;
    try {
      if (!(await lookup('red'))) return;
      if (!inputs.blue.value.trim()) { inputs.blue.focus(); return; }
      if (!(await lookup('blue'))) return;
      // Server checks the pair rules (same legband, same entry, same owner, event open)
      // and, in DRAW mode, that the drawn fight number is still free.
      const body = { red: inputs.red.value, blue: inputs.blue.value };
      if (DRAW && fightInput.value.trim()) body.fightNumber = fightInput.value.trim();
      let res;
      try {
        res = await api('POST', ev('/matches/check'), body);
      } catch (e) {
        const f = e.details && e.details.field;
        if (f === 'fight') { fightError(e.message); return; }
        showError(f === 'red' ? 'red' : 'blue', e.message);
        return;
      }
      if (DRAW && res.fightNumber == null) {
        // Pair is fine; now ask for the drawn number.
        if (reviewAgain) return; // a fight number was typed meanwhile; the queued check handles it
        if (fightInput.value.trim()) fightError('Type the drawn fight number (digits only).');
        else { fightInfo.className = 'corner-info'; fightInfo.innerHTML = '<span class="text-muted">Pair OK. Type the drawn fight number and press Enter.</span>'; fightInput.focus(); }
        return;
      }
      if (DRAW) { fightInfo.className = 'corner-info ok'; fightInfo.innerHTML = `<div class="entry">Fight #${pad(res.fightNumber)}</div><div>Available</div>`; }
      openDialog(res);
    } finally {
      busy = false;
      if (reviewAgain && !pending) { reviewAgain = false; review(); }
    }
  }

  // Red Enter: move to Blue at once so fast typing is never lost, check Red in the background,
  // and bring the cursor back to Red if it turns out to be invalid.
  inputs.red.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.repeat) return;
    if (!App.normLegband(inputs.red.value)) { showError('red', 'Enter a legband number (digits only).'); return; }
    const check = lookup('red', { focusOnError: false });
    inputs.blue.focus(); inputs.blue.select();
    check.then((ok) => { if (!ok && !pending) { inputs.red.focus(); inputs.red.select(); } });
  });
  inputs.blue.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.repeat) return;
    enterHeld = true;
    // DRAW mode: jump to the fight-number field at once so fast typing lands there;
    // the pair is checked in the background and the cursor returns to Blue if it fails.
    if (DRAW && !fightInput.value.trim() && App.normLegband(inputs.blue.value)) { fightInput.focus(); }
    review();
  });
  if (DRAW) {
    fightInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (e.repeat) return;
      if (!fightValue()) { fightError('Type the drawn fight number (digits only).'); return; }
      enterHeld = true;
      review();
    });
    fightInput.addEventListener('input', () => {
      fightInput.value = fightInput.value.replace(/\D/g, '').slice(0, 4);
      fightInfo.className = 'corner-info'; fightInfo.innerHTML = '<span class="text-muted">Press Enter to check.</span>';
    });
  }
  document.addEventListener('keyup', (e) => { if (e.key === 'Enter') { enterHeld = false; tryArm(); } });
  for (const corner of ['red', 'blue']) {
    inputs[corner].addEventListener('input', () => {
      inputs[corner].value = inputs[corner].value.replace(/\D/g, '');
      if (valid[corner] && valid[corner].number !== inputs[corner].value) { valid[corner] = null; setInfo(corner, '', '<span class="text-muted">Press Enter to check.</span>'); }
    });
  }
  $('reviewBtn').addEventListener('click', review);
  $('clearBtn').addEventListener('click', () => resetForm());

  function resetForm() {
    for (const c of ['red', 'blue']) { inputs[c].value = ''; valid[c] = null; }
    if (DRAW) { fightInput.value = ''; fightInfo.className = 'corner-info'; fightInfo.innerHTML = FIGHT_HINT; }
    setInfo('red', '', '<span class="text-muted">Type the Red legband and press Enter.</span>');
    setInfo('blue', '', '<span class="text-muted">Then type the Blue legband and press Enter.</span>');
    inputs.red.focus();
  }

  // ---------- Confirmation dialog ----------
  function side(lb, label) {
    return `<div class="corner-label">${label}</div>
      <div class="big-lb">${esc(lb.number)}</div>
      <dl>
        <dt>Entry name</dt><dd>${esc(lb.entry.entryName)}</dd>
        <dt>Address</dt><dd>${esc(lb.entry.address || '—')}</dd>
        <dt>Entry no.</dt><dd>${lb.entry.entryNumber}</dd>
        <dt>Participant</dt><dd>${esc(lb.participant ? lb.participant.name : '')}</dd>
        <dt>Slot</dt><dd>${lb.slot}</dd>
        <dt>Status</dt><dd><span class="badge text-bg-success">${lb.available ? 'AVAILABLE' : esc(lb.status)}</span></dd>
      </dl>`;
  }
  function openDialog(res) {
    pending = { red: res.red.number, blue: res.blue.number, fightNumber: DRAW ? res.fightNumber : undefined, key: App.uuid() };
    confirmed = false;
    $('confirmRed').innerHTML = side(res.red, 'RED CORNER');
    $('confirmBlue').innerHTML = side(res.blue, 'BLUE CORNER');
    $('confirmFightNo').textContent = `FIGHT #${pad(DRAW ? res.fightNumber : res.nextFightNumber)}`;
    $('confirmFightNote').textContent = DRAW ? '(nabunot)' : '(final number assigned on confirm)';
    confirmError.classList.add('d-none');
    confirmBtn.disabled = true;
    confirmBtn.dataset.armed = '';
    confirmBtn.textContent = 'CONFIRM MATCH';
    modal.show();
  }
  // Confirm is only enabled after a short delay AND once the Enter that opened the dialog is released,
  // so a held or double-pressed Enter can never confirm by accident.
  function tryArm() {
    if (!pending || confirmBtn.dataset.armed !== 'time' || enterHeld) return;
    confirmBtn.dataset.armed = 'yes';
    confirmBtn.disabled = false;
    confirmBtn.focus();
  }
  modalEl.addEventListener('shown.bs.modal', () => {
    $('editBtn').focus();
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { confirmBtn.dataset.armed = 'time'; tryArm(); }, 450);
  });
  modalEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.repeat) e.preventDefault(); }, true);
  modalEl.addEventListener('hidden.bs.modal', () => {
    clearTimeout(armTimer);
    pending = null;
    if (confirmed) resetForm();
    else if (DRAW) { fightInput.focus(); fightInput.select(); }
    else { inputs.blue.focus(); inputs.blue.select(); }
  });

  confirmBtn.addEventListener('click', async () => {
    if (!pending || confirmBtn.dataset.armed !== 'yes' || confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>SAVING…';
    confirmError.classList.add('d-none');
    try {
      const out = await api('POST', ev('/matches'), { red: pending.red, blue: pending.blue, fightNumber: pending.fightNumber, idempotencyKey: pending.key });
      confirmed = true;
      modal.hide();
      toast(`Fight #${pad(out.match.fightNumber)} confirmed: ${out.match.red.legband} vs ${out.match.blue.legband}`, 'success', 5000);
      loadRecent();
    } catch (e) {
      confirmError.textContent = e.network ? `${e.message} You can press Confirm again safely — it will not create a duplicate.` : e.message;
      confirmError.classList.remove('d-none');
      confirmBtn.textContent = 'CONFIRM MATCH';
      // Network problems can be retried with the same key; rule violations need an edit.
      if (e.network || (e.status && e.status >= 500)) { confirmBtn.disabled = false; confirmBtn.focus(); } else { $('editBtn').focus(); valid.red = null; valid.blue = null; }
    }
  });

  // ---------- Recent list + live updates ----------
  const statusBadge = (s) => `<span class="badge status-badge text-bg-${{ CONFIRMED: 'primary', COMPLETED: 'success', CANCELLED: 'secondary' }[s]}">${s}</span>`;
  async function loadRecent() {
    try {
      const [list, summary] = await Promise.all([api('GET', ev('/matches')), api('GET', ev('/summary'))]);
      if ($('nextFightNo')) $('nextFightNo').textContent = `#${pad(summary.nextFightNumber)}`;
      const recent = list.slice().sort((a, b) => b.id - a.id).slice(0, 12);
      $('recentRows').innerHTML = recent.length ? recent.map((m) => `<tr class="${m.status === 'CANCELLED' ? 'is-cancelled' : ''}">
        <td class="fw-bold">#${pad(m.fightNumber)}</td>
        <td class="row-red">${esc(m.red.entryName)}</td><td class="lb row-red">${esc(m.red.legband)}</td>
        <td class="row-blue">${esc(m.blue.entryName)}</td><td class="lb row-blue">${esc(m.blue.legband)}</td>
        <td>${statusBadge(m.status)}</td><td class="small text-muted">${esc(m.confirmedBy || '')}</td>
        <td class="text-end">${m.status === 'CONFIRMED' ? `<button type="button" class="btn btn-sm btn-outline-danger" data-unmatch="${m.id}" data-label="Fight #${pad(m.fightNumber)} (${esc(m.red.legband)} vs ${esc(m.blue.legband)})">Unmatch</button>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="8" class="text-muted">No matches yet.</td></tr>';
    } catch (e) { toast(e.message, 'danger'); }
  }
  $('recentRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-unmatch]');
    if (!btn || btn.disabled) return;
    const r = await App.prompt({
      title: `Unmatch ${btn.dataset.label}?`,
      label: 'Reason — this pairing was entered by mistake',
      confirmText: 'Unmatch',
      danger: true,
    });
    if (!r) return;
    btn.disabled = true;
    try {
      await api('POST', ev(`/matches/${btn.dataset.unmatch}/unmatch`), { reason: r.value });
      toast(`${btn.dataset.label} unmatched. Both legbands can be matched again.`, 'warning', 5000);
      loadRecent();
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
  });
  async function loadEvent() {
    try {
      const e = await api('GET', ev(''));
      const open = ['MATCHING_OPEN', 'ACTIVE'].includes(e.status);
      $('closedNotice').classList.toggle('d-none', open);
      $('closedNotice').textContent = open ? '' : `Matching is not open for this event (status: ${e.status.replace('_', ' ')}). An administrator can open it in Event Settings.`;
    } catch (_) { /* ignore */ }
  }
  App.live({
    onChange: () => { loadRecent(); loadEvent(); for (const c of ['red', 'blue']) if (valid[c] && !pending) { valid[c] = null; if (inputs[c].value) setInfo(c, '', '<span class="text-muted">List changed — press Enter to re-check.</span>'); } },
    onResync: () => { loadRecent(); loadEvent(); },
  });
  loadRecent(); loadEvent();
  inputs.red.focus();
})();
