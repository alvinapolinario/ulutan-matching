(function () {
  'use strict';
  const { api, ev, esc, toast } = App;
  const form = document.getElementById('regForm');
  const pName = document.getElementById('participantName');
  const eName = document.getElementById('entryName');
  const addr = document.getElementById('address');
  const count = document.getElementById('legbandCount');           // AUTO mode only
  const MANUAL = document.body.dataset.legbandMode === 'MANUAL';
  const lb1 = document.getElementById('legband1');                  // MANUAL mode only
  const lb2 = document.getElementById('legband2');
  const errBox = document.getElementById('regError');
  const submitBtn = document.getElementById('regSubmit');
  const rows = document.getElementById('entryRows');
  const search = document.getElementById('search');
  const statusFilter = document.getElementById('statusFilter');
  const lastSaved = document.getElementById('lastSaved');
  const editModalEl = document.getElementById('editModal');
  const editModal = new bootstrap.Modal(editModalEl);
  const editForm = document.getElementById('editForm');
  let entries = [];
  let summary = null;
  let saving = false;

  const lbCell = (lb) => {
    if (!lb) return '<span class="text-muted">—</span>';
    const cls = { AVAILABLE: 'text-success', MATCHED: 'text-primary', INACTIVE: 'text-danger', WITHDRAWN: 'text-muted' }[lb.status] || '';
    const fight = lb.fightNumber ? ` <span class="small text-muted">F#${App.pad(lb.fightNumber)}</span>` : '';
    return `<span class="lb ${cls}" title="${lb.status}">${esc(lb.number)}</span>${fight}`;
  };
  const statusBadge = (s) => `<span class="badge status-badge text-bg-${{ COMPLETE: 'success', INCOMPLETE: 'warning', WITHDRAWN: 'secondary' }[s]}">${s}</span>`;

  function render() {
    if (!entries.length) { rows.innerHTML = '<tr><td colspan="7" class="text-muted">No entries found.</td></tr>'; return; }
    rows.innerHTML = entries.map((e) => `<tr>
      <td class="fw-bold">${e.entryNumber}</td><td>${esc(e.entryName)}${e.address ? `<div class="small text-muted">${esc(e.address)}</div>` : ''}</td><td>${esc(e.participantName)}</td>
      <td>${lbCell(e.legband1)}</td><td>${lbCell(e.legband2)}</td><td>${statusBadge(e.displayStatus)}</td>
      <td class="text-end text-nowrap">
        ${e.displayStatus === 'INCOMPLETE' ? `<button class="btn btn-sm btn-warning" data-add="${e.id}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Legband</button>` : ''}
        ${e.status === 'ACTIVE' && (!e.locked || App.isAdmin) ? `<button class="btn btn-sm btn-outline-dark" data-edit="${e.id}"><i class="bi bi-pencil" aria-hidden="true"></i> Edit</button>` : ''}
        ${App.isAdmin && e.status === 'ACTIVE' && !e.locked ? `<button class="btn btn-sm btn-outline-danger" data-withdraw="${e.id}"><i class="bi bi-box-arrow-left" aria-hidden="true"></i> Withdraw</button>` : ''}
      </td></tr>`).join('');
  }

  function renderSummary() {
    if (!summary) return;
    document.getElementById('totals').innerHTML =
      `<span><b class="text-dark">${summary.participants}</b> owners</span><span><b class="text-dark">${summary.entries}</b> entries</span>` +
      `<span><b class="text-dark">${summary.legbands}</b> chickens</span><span><b class="text-dark">${summary.incompleteEntries}</b> incomplete</span>` +
      `<span><b class="text-dark">${summary.legbandsLeft}</b> legbands left</span>`;
    if (MANUAL || !count) return;
    const n = Number(count.value);
    const nextLb = document.getElementById('nextLb');
    if (!summary.nextLegband) nextLb.textContent = 'none left';
    else {
      const first = parseInt(summary.nextLegband, 10);
      nextLb.textContent = n === 2 && summary.legbandsLeft >= 2 ? `${App.pad(first)} & ${App.pad(first + 1)}` : App.pad(first);
    }
  }

  async function loadEntries() {
    const qs = new URLSearchParams({ q: search.value.trim(), status: statusFilter.value });
    entries = await api('GET', ev(`/entries?${qs}`));
    render();
    refreshAddressList();
  }
  async function loadSummary() { summary = await api('GET', ev('/summary')); renderSummary(); }
  const reloadAll = () => Promise.all([loadEntries(), loadSummary()]).catch((e) => toast(e.message, 'danger'));

  const loadParticipants = App.debounce(async () => {
    try {
      const list = await api('GET', `/api/participants?q=${encodeURIComponent(pName.value)}`);
      document.getElementById('participantList').innerHTML = list.map((p) => `<option value="${esc(p.name)}">`).join('');
    } catch (_) { /* ignore */ }
  }, 150);
  pName.addEventListener('input', loadParticipants);

  // Keyboard flow: Enter on owner -> entry name -> address; Enter on address or legband count -> save.
  pName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!pName.value.trim()) { showError('Participant name is required.'); return; } eName.focus(); }
  });
  eName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addr.focus(); } });
  const submitOnEnter = (el) => el && el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); form.requestSubmit(); } });
  if (MANUAL) {
    // owner -> entry -> address -> Legband 1 -> Legband 2 (Enter saves)
    addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lb1.focus(); } });
    // Enter on an empty Legband 1 saves the entry without legbands (they can be added later).
    lb1.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (e.repeat) return; if (!lb1.value.trim()) form.requestSubmit(); else lb2.focus(); });
    submitOnEnter(lb2);
    // Live check: is the typed number free?
    const checkLb = App.debounce(async (input, info) => {
      const n = App.normLegband(input.value);
      if (!input.value.trim()) { info.textContent = ''; info.className = 'small lb-info'; return; }
      if (!n) { info.textContent = 'Digits only'; info.className = 'small lb-info text-danger'; return; }
      if (input === lb2 && n === App.normLegband(lb1.value)) { info.textContent = 'Same as Legband 1'; info.className = 'small lb-info text-danger'; return; }
      try {
        const lb = await api('GET', ev(`/legbands/${n}`));
        info.textContent = `Taken: Entry #${lb.entry.entryNumber} ${lb.entry.entryName}`;
        info.className = 'small lb-info text-danger fw-semibold';
      } catch (e) {
        if (e.status === 404) { info.textContent = `✓ ${n} is free`; info.className = 'small lb-info text-success'; }
      }
    }, 200);
    [[lb1, 'lb1Info'], [lb2, 'lb2Info']].forEach(([el, id]) => el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '');
      checkLb(el, document.getElementById(id));
    }));
  } else {
    submitOnEnter(addr);
    submitOnEnter(count);
  }
  // Suggest addresses already used (same barangay/town is common).
  function refreshAddressList() {
    const seen = [...new Set(entries.map((x) => x.address).filter(Boolean))].slice(0, 50);
    document.getElementById('addressList').innerHTML = seen.map((a) => `<option value="${esc(a)}">`).join('');
  }
  if (count) count.addEventListener('change', renderSummary);

  function showError(msg) { errBox.textContent = msg; errBox.classList.remove('d-none'); }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    errBox.classList.add('d-none');
    if (!pName.value.trim()) { showError('Participant name is required.'); pName.focus(); return; }
    saving = true; submitBtn.disabled = true;
    try {
      const body = { participantName: pName.value, entryName: eName.value, address: addr.value };
      if (MANUAL) { body.legband1 = lb1.value; body.legband2 = lb2.value; } else body.legbandCount = Number(count.value);
      const row = await api('POST', ev('/entries'), body);
      const lbs = [row.legband1, row.legband2].filter(Boolean).map((l) => `<span class="lb fs-3 me-2">${esc(l.number)}</span>`).join('') || '<span class="text-muted">none yet</span>';
      lastSaved.innerHTML = `<div class="small text-muted">Saved</div><div class="fw-bold fs-5">Entry #${row.entryNumber} · ${esc(row.entryName)}</div>
        <div class="small">${esc(row.participantName)}${row.address ? ' · ' + esc(row.address) : ''}</div><div class="mt-1">Legbands: ${lbs}</div>
        ${row.displayStatus === 'INCOMPLETE' ? `<div class="small text-warning-emphasis mt-1">Incomplete — add the ${row.legband1 ? 'second legband' : 'legbands'} later with “+ Legband” in the table.</div>` : ''}`;
      lastSaved.classList.remove('d-none');
      const nums = [row.legband1, row.legband2].filter(Boolean).map((l) => l.number);
      toast(`Entry #${row.entryNumber} saved${nums.length ? ' — legband ' + nums.join(' & ') : ' (no legband yet)'}`);
      form.reset();
      document.querySelectorAll('.lb-info').forEach((x) => { x.textContent = ''; });
      pName.focus();
      reloadAll();
    } catch (err) {
      showError(err.message);
      const f = err.details && err.details.field;
      if (f === 'participantName') pName.focus();
      else if (f === 'legband1' && lb1) { lb1.focus(); lb1.select(); }
      else if (f === 'legband2' && lb2) { lb2.focus(); lb2.select(); }
    } finally { saving = false; submitBtn.disabled = false; }
  });

  search.addEventListener('input', App.debounce(() => loadEntries().catch((e) => toast(e.message, 'danger')), 150));
  statusFilter.addEventListener('change', () => loadEntries());

  rows.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.add) {
        let payload = {};
        if (MANUAL) {
          const ent = entries.find((x) => x.id === Number(b.dataset.add));
          const r = await App.prompt({ title: ent && !ent.legband1 ? 'Add legband 1' : 'Add legband 2', label: 'Legband number (from the band)', inputType: 'text', confirmText: 'Add legband' });
          if (!r) return;
          payload = { legband: r.value };
        }
        b.disabled = true;
        const row = await api('POST', ev(`/entries/${b.dataset.add}/legbands`), payload);
        const added = row.legband2 ? row.legband2.number : row.legband1.number;
        toast(row.displayStatus === 'COMPLETE' ? `Entry #${row.entryNumber} is complete — legband ${added}` : `Legband ${added} added to Entry #${row.entryNumber}`);
        reloadAll();
      } else if (b.dataset.edit) {
        openEdit(entries.find((x) => x.id === Number(b.dataset.edit)));
      } else if (b.dataset.withdraw) {
        const ent = entries.find((x) => x.id === Number(b.dataset.withdraw));
        const r = await App.prompt({ title: `Withdraw entry #${ent.entryNumber} (${ent.entryName})`, label: 'Reason', confirmText: 'Withdraw', danger: true });
        if (!r) return;
        await api('POST', ev(`/entries/${ent.id}/withdraw`), { reason: r.value });
        toast(`Entry #${ent.entryNumber} withdrawn.`, 'warning');
        reloadAll();
      }
    } catch (err) { toast(err.message, 'danger'); b.disabled = false; }
  });

  function openEdit(ent) {
    editForm.reset();
    document.getElementById('editError').classList.add('d-none');
    document.getElementById('editTitle').textContent = `Edit entry #${ent.entryNumber}`;
    editForm.entryId.value = ent.id;
    editForm.participantName.value = ent.participantName;
    editForm.entryName.value = ent.entryName;
    editForm.address.value = ent.address || '';
    document.getElementById('editLocked').classList.toggle('d-none', !ent.locked);
    document.getElementById('reasonWrap').classList.toggle('d-none', !ent.locked);
    for (const [k, lb] of [['legband1', ent.legband1], ['legband2', ent.legband2]]) {
      editForm[k].value = lb ? lb.number : '';
      editForm[k].disabled = !lb || lb.status !== 'AVAILABLE';
      editForm[k].title = !lb ? 'Use “+ Legband” in the table to add it' : (lb.status !== 'AVAILABLE' ? 'Already in a match — cannot be renumbered' : '');
    }
    editModal.show();
  }
  editModalEl.addEventListener('shown.bs.modal', () => editForm.participantName.focus());
  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', ev(`/entries/${editForm.entryId.value}`), { participantName: editForm.participantName.value, entryName: editForm.entryName.value, address: editForm.address.value, legband1: editForm.legband1.disabled ? undefined : editForm.legband1.value, legband2: editForm.legband2.disabled ? undefined : editForm.legband2.value, reason: editForm.reason.value });
      editModal.hide(); toast('Entry updated.'); reloadAll();
    } catch (err) { const b = document.getElementById('editError'); b.textContent = err.message; b.classList.remove('d-none'); }
  });

  App.live({ onChange: reloadAll, onResync: reloadAll });
  pName.focus();
  reloadAll();
})();
