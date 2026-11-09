(function () {
  'use strict';
  const { api, ev, esc, toast } = App;
  const $ = (id) => document.getElementById(id);
  const form = $('regForm');
  const pName = $('participantName');
  const eName = $('entryName');
  const addr = $('address');
  const count = $('legbandCount');                                      // AUTO legband mode only
  const MANUAL = document.body.dataset.legbandMode === 'MANUAL';
  const PER_ENTRY = Number(document.body.dataset.cocksPerEntry) || 2;  // birds per entry, 2-5
  const BY_WEIGHT = App.weightRulesOn;                                  // weight rules on: cocks need a weight
  // One row per bird: type, legband (MANUAL), wingband (stag / bullstag), weight.
  const birdRows = Array.from({ length: PER_ENTRY }, (_, i) => ({
    type: $(`type${i + 1}`), leg: $(`legband${i + 1}`), wing: $(`wingband${i + 1}`), weight: $(`weight${i + 1}`), info: $(`lb${i + 1}Info`),
  }));
  const errBox = $('regError');
  const submitBtn = $('regSubmit');
  const rows = $('entryRows');
  const search = $('search');
  const statusFilter = $('statusFilter');
  const lastSaved = $('lastSaved');
  const editModalEl = $('editModal');
  const editModal = new bootstrap.Modal(editModalEl);
  const editForm = $('editForm');
  let entries = [];
  let summary = null;
  let saving = false;

  // ---------- Table ----------
  const birdCell = (lb) => {
    if (!lb) return '<span class="text-muted">—</span>';
    const cls = { AVAILABLE: 'text-success', MATCHED: 'text-primary', INACTIVE: 'text-danger', WITHDRAWN: 'text-muted' }[lb.status] || '';
    const fight = lb.fightNumber ? ` <span class="small text-muted">F#${App.pad(lb.fightNumber)}</span>` : '';
    const leg = lb.number ? `<span class="lb ${cls}" title="Legband · ${lb.status}">${esc(lb.number)}</span>${fight}` : '<span class="small text-warning-emphasis">no legband yet</span>';
    const extra = [lb.wingband ? `WB ${esc(lb.wingband)}` : '', lb.weight != null ? App.grams(lb.weight) : (lb.type === 'COCK' && BY_WEIGHT && lb.status === 'AVAILABLE' ? '<span class="text-warning-emphasis">not weighed</span>' : '')].filter(Boolean).join(' · ');
    return `<div>${App.typeBadge(lb.type)} ${leg}</div>${extra ? `<div class="small text-muted">${extra}</div>` : ''}`;
  };
  const statusBadge = (s) => `<span class="badge status-badge text-bg-${{ COMPLETE: 'success', INCOMPLETE: 'warning', WITHDRAWN: 'secondary' }[s]}">${s}</span>`;
  /** Birds of an entry row, one per slot (null = not added yet). */
  const slotsOf = (e) => e.legbands || [e.legband1, e.legband2];
  const COLS = 5 + PER_ENTRY;

  function render() {
    if (!entries.length) { rows.innerHTML = `<tr><td colspan="${COLS}" class="text-muted">No entries found.</td></tr>`; return; }
    rows.innerHTML = entries.map((e) => `<tr>
      <td class="fw-bold">${e.entryNumber}</td><td>${esc(e.entryName)}${e.address ? `<div class="small text-muted">${esc(e.address)}</div>` : ''}</td><td>${esc(e.participantName)}</td>
      ${Array.from({ length: PER_ENTRY }, (_, i) => `<td>${birdCell(slotsOf(e)[i])}</td>`).join('')}<td>${statusBadge(e.displayStatus)}</td>
      <td class="text-end text-nowrap">
        ${e.displayStatus === 'INCOMPLETE' ? `<button class="btn btn-sm btn-warning" data-add="${e.id}"><i class="bi bi-plus-lg" aria-hidden="true"></i> Legband</button>` : ''}
        ${e.status === 'ACTIVE' && (!e.locked || App.isAdmin) ? `<button class="btn btn-sm btn-outline-dark" data-edit="${e.id}"><i class="bi bi-pencil" aria-hidden="true"></i> Edit</button>` : ''}
        ${App.isAdmin && e.status === 'ACTIVE' && !e.locked ? `<button class="btn btn-sm btn-outline-danger" data-withdraw="${e.id}"><i class="bi bi-box-arrow-left" aria-hidden="true"></i> Withdraw</button>` : ''}
      </td></tr>`).join('');
  }

  function birdsInUse() { return MANUAL || !count ? PER_ENTRY : Number(count.value); }
  function renderSummary() {
    if (!summary) return;
    $('totals').innerHTML =
      `<span><b class="text-dark">${summary.participants}</b> owners</span><span><b class="text-dark">${summary.entries}</b> entries</span>` +
      `<span><b class="text-dark">${summary.cocks}</b> cocks · <b class="text-dark">${summary.stags}</b> stags · <b class="text-dark">${summary.bullstags}</b> bullstags</span>` +
      `<span><b class="text-dark">${summary.incompleteEntries}</b> incomplete</span><span><b class="text-dark">${summary.legbandsLeft}</b> legbands left</span>` +
      (summary.waitingForLegband ? `<span class="text-warning-emphasis"><b>${summary.waitingForLegband}</b> waiting for legband</span>` : '') +
      (summary.unweighedCocks ? `<span class="text-warning-emphasis"><b>${summary.unweighedCocks}</b> cocks not weighed</span>` : '');
    if (MANUAL || !count) return;
    const n = Number(count.value);
    const first = summary.nextLegband ? parseInt(summary.nextLegband, 10) : null;
    $('nextLb').textContent = first == null ? 'none left' : Array.from({ length: Math.max(1, Math.min(n, summary.legbandsLeft)) }, (_, i) => App.pad(first + i)).join(', ');
    syncRows();
  }

  // ---------- Bird rows ----------
  /** Wingband only for a stag / bullstag; weight required for a cock when the event matches by weight. */
  function syncRow(r, i) {
    const off = i >= birdsInUse();
    const t = r.type.value;
    r.type.disabled = off;
    if (r.wing) {
      r.wing.disabled = off || !App.needsWingband(t);
      if (!App.needsWingband(t)) r.wing.value = '';
      r.wing.placeholder = App.needsWingband(t) ? 'required' : '—';
    }
    r.weight.disabled = off;
    const range = App.minWeight != null || App.maxWeight != null ? `${App.minWeight ?? '…'}–${App.maxWeight ?? '…'}` : 'required';
    r.weight.placeholder = t === 'COCK' ? (BY_WEIGHT ? range : 'grams') : 'optional';
    if (r.leg) r.leg.disabled = off;
  }
  const syncRows = () => birdRows.forEach(syncRow);
  birdRows.forEach((r, i) => r.type.addEventListener('change', () => { syncRow(r, i); checkWing(r)(); }));

  /** The boxes of bird i in keyboard order: type -> wingband (stag / bullstag) -> weight -> legband (typed mode). */
  const fieldsOf = (r) => [r.type, r.wing, r.weight, r.leg].filter((el) => el && !el.disabled);
  const rowEmpty = (r) => ![r.leg, r.wing, r.weight].some((el) => el && el.value.trim());
  function nextField(el) {
    const order = birdRows.slice(0, birdsInUse()).flatMap(fieldsOf);
    const i = order.indexOf(el);
    return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  }
  birdRows.forEach((r) => [r.type, r.wing, r.weight, r.leg].filter(Boolean).forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (e.repeat) return;
      // Enter on the first box of a bird nothing was entered for (type -> Enter -> Enter) = done with this
      // entry: the rest of the birds can be added later.
      if (el !== r.type && el === fieldsOf(r)[1] && rowEmpty(r) && r !== birdRows[0]) { form.requestSubmit(); return; }
      const nx = nextField(el);
      if (nx) { nx.focus(); if (nx.select) nx.select(); } else form.requestSubmit();
    });
  }));
  // Ctrl+Enter saves from anywhere in the form.
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.repeat) { e.preventDefault(); form.requestSubmit(); } });

  // Live checks: is the typed legband / wingband free?
  const setInfo = (r, cls, text) => { r.info.className = `col-12 small lb-info ${cls}`; r.info.textContent = text; };
  function freeCheck(r, el, word, url, others) {
    return App.debounce(async () => {
      const n = App.normLegband(el.value);
      if (!el.value.trim()) { setInfo(r, '', ''); return; }
      if (!n) { setInfo(r, 'text-danger', `${word}: digits only`); return; }
      const same = others().findIndex((o) => o !== el && n === App.normLegband(o.value));
      if (same >= 0) { setInfo(r, 'text-danger', `${word} ${n} is typed twice`); return; }
      try {
        const lb = await api('GET', ev(url(n)));
        setInfo(r, 'text-danger fw-semibold', `${word} ${n} taken: Entry #${lb.entry.entryNumber} ${lb.entry.entryName}`);
      } catch (e) {
        if (e.status === 404) setInfo(r, 'text-success', `✓ ${word} ${n} is free`);
      }
    }, 200);
  }
  const checks = new Map();
  const checkWing = (r) => checks.get(r.wing) || (() => {});
  birdRows.forEach((r) => {
    const digits = (el) => el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, ''); });
    if (r.leg) {
      digits(r.leg);
      const c = freeCheck(r, r.leg, 'Legband', (n) => `/legbands/${n}`, () => birdRows.map((x) => x.leg));
      checks.set(r.leg, c); r.leg.addEventListener('input', c);
    }
    if (r.wing) {
      digits(r.wing);
      const c = freeCheck(r, r.wing, 'Wingband', (n) => `/wingbands/${n}`, () => birdRows.map((x) => x.wing).filter(Boolean));
      checks.set(r.wing, c); r.wing.addEventListener('input', c);
    }
    // Weight boxes take grams (2105) or kilograms (2.105); with weight rules on, a cock's weight is
    // checked against the event's min / max as it is typed.
    r.weight.addEventListener('input', () => {
      r.weight.value = r.weight.value.replace(/[^\d.,]/g, '');
      const g = App.parseWeight(r.weight.value);
      if (g == null) { setInfo(r, '', ''); return; }
      if (Number.isNaN(g)) { setInfo(r, 'text-danger', 'Weight: grams (2105) or kilograms (2.105)'); return; }
      if (r.type.value !== 'COCK' || !BY_WEIGHT) { setInfo(r, '', ''); return; }
      if (App.minWeight != null && g < App.minWeight) setInfo(r, 'text-danger fw-semibold', `${g} g is below the minimum of ${App.minWeight} g`);
      else if (App.maxWeight != null && g > App.maxWeight) setInfo(r, 'text-danger fw-semibold', `${g} g is above the maximum of ${App.maxWeight} g`);
      else setInfo(r, 'text-success', `✓ ${g.toLocaleString('en-US')} g`);
    });
  });

  // ---------- Keyboard flow before the birds ----------
  const loadParticipants = App.debounce(async () => {
    try {
      const list = await api('GET', `/api/participants?q=${encodeURIComponent(pName.value)}`);
      $('participantList').innerHTML = list.map((p) => `<option value="${esc(p.name)}">`).join('');
    } catch (_) { /* ignore */ }
  }, 150);
  pName.addEventListener('input', loadParticipants);
  pName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); if (!pName.value.trim()) { showError('Participant name is required.'); return; } eName.focus(); }
  });
  eName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); addr.focus(); } });
  // Address Enter: into the bird rows; with automatic legbands and nothing required per bird it saves at once.
  addr.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.repeat) return;
    e.preventDefault();
    if (!MANUAL && !BY_WEIGHT) form.requestSubmit(); else birdRows[0].type.focus();
  });
  if (count) {
    count.addEventListener('change', renderSummary);
    count.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); form.requestSubmit(); } });
  }

  async function loadEntries() {
    const qs = new URLSearchParams({ q: search.value.trim(), status: statusFilter.value });
    entries = await api('GET', ev(`/entries?${qs}`));
    render();
    refreshAddressList();
  }
  async function loadSummary() { summary = await api('GET', ev('/summary')); renderSummary(); }
  const reloadAll = () => Promise.all([loadEntries(), loadSummary()]).catch((e) => toast(e.message, 'danger'));
  // Suggest addresses already used (same barangay/town is common).
  function refreshAddressList() {
    const seen = [...new Set(entries.map((x) => x.address).filter(Boolean))].slice(0, 50);
    $('addressList').innerHTML = seen.map((a) => `<option value="${esc(a)}">`).join('');
  }
  function showError(msg) { errBox.textContent = msg; errBox.classList.remove('d-none'); }

  // ---------- Save ----------
  const birdSummary = (l) => `<div>${App.typeBadge(l.type)} <span class="lb fs-4">${l.number ? esc(l.number) : '<span class="fs-6 text-warning-emphasis">no LB</span>'}</span>`
    + `<span class="small text-muted ms-1">${[l.wingband ? `WB ${esc(l.wingband)}` : '', l.weight != null ? App.grams(l.weight) : ''].filter(Boolean).join(' · ')}</span></div>`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    errBox.classList.add('d-none');
    if (!pName.value.trim()) { showError('Participant name is required.'); pName.focus(); return; }
    saving = true; submitBtn.disabled = true;
    try {
      const use = birdsInUse();
      const val = (el, i) => (!el || i >= use || el.disabled ? '' : el.value);
      const body = {
        participantName: pName.value, entryName: eName.value, address: addr.value,
        types: birdRows.map((r, i) => (i >= use ? '' : r.type.value)),
        wingbands: birdRows.map((r, i) => val(r.wing, i)),
        weights: birdRows.map((r, i) => val(r.weight, i)),
      };
      if (MANUAL) body.legbands = birdRows.map((r, i) => val(r.leg, i)); else body.legbandCount = use;
      const row = await api('POST', ev('/entries'), body);
      const have = slotsOf(row).filter(Boolean);
      const waiting = have.filter((l) => !l.number).length;
      const missing = slotsOf(row).length - have.length;
      lastSaved.innerHTML = `<div class="small text-muted">Saved</div><div class="fw-bold fs-5">Entry #${row.entryNumber} · ${esc(row.entryName)}</div>
        <div class="small">${esc(row.participantName)}${row.address ? ' · ' + esc(row.address) : ''}</div>
        <div class="mt-1 d-flex flex-column gap-1">${have.map(birdSummary).join('') || '<span class="text-muted">No birds yet</span>'}</div>
        ${waiting ? `<div class="small text-warning-emphasis mt-1">${waiting} bird${waiting === 1 ? '' : 's'} still need${waiting === 1 ? 's' : ''} a legband — add it with “+ Legband”.</div>` : ''}
        ${missing ? `<div class="small text-warning-emphasis mt-1">${missing} more bird${missing === 1 ? '' : 's'} can be added later with “+ Legband”.</div>` : ''}`;
      lastSaved.classList.remove('d-none');
      toast(`Entry #${row.entryNumber} saved — ${have.length} bird${have.length === 1 ? '' : 's'}`);
      form.reset();
      syncRows();
      document.querySelectorAll('.lb-info').forEach((x) => { x.textContent = ''; });
      pName.focus();
      reloadAll();
    } catch (err) {
      showError(err.message);
      const f = err.details && err.details.field;
      if (f === 'participantName') pName.focus();
      else {
        const el = f && form.querySelector(`[name="${f}"]`);
        if (el && !el.disabled) { el.focus(); if (el.select) el.select(); }
      }
    } finally { saving = false; submitBtn.disabled = false; }
  });

  search.addEventListener('input', App.debounce(() => loadEntries().catch((e) => toast(e.message, 'danger')), 150));
  statusFilter.addEventListener('change', () => loadEntries());

  // ---------- Table actions ----------
  // Only the types this event allows.
  const typeOptions = App.allowedTypes.map((t) => `<option value="${t}">${App.BIRD_LABEL[t]}</option>`).join('');
  const WITH_WING = App.allowedTypes.some(App.needsWingband);
  rows.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.add) {
        const ent = entries.find((x) => x.id === Number(b.dataset.add));
        const birds = ent ? slotsOf(ent) : [];
        const waiting = birds.findIndex((l) => l && !l.number && l.status === 'AVAILABLE');
        let payload;
        if (waiting >= 0) {
          // A registered bird that has no legband yet: just its legband.
          const w = birds[waiting];
          const r = await App.prompt({
            title: `Legband for bird ${waiting + 1} of Entry #${ent.entryNumber}`,
            label: 'Legband number (from the band)', confirmText: 'Save legband',
            extraHtml: `<p class="small mb-2">${App.typeBadge(w.type)} ${w.wingband ? `WB ${esc(w.wingband)}` : ''} ${w.weight != null ? App.grams(w.weight) : ''}</p>`,
          });
          if (!r) return;
          payload = { legband: r.value };
        } else {
          // A new bird: type, wingband (stag / bullstag), weight, and the legband in typed mode.
          const next = birds.findIndex((l) => !l);
          const r = await App.prompt({
            title: `Add bird ${next >= 0 ? next + 1 : ''} to Entry #${ent ? ent.entryNumber : ''}`.trim(),
            label: MANUAL ? 'Legband number (from the band)' : 'Weight in grams',
            required: MANUAL, confirmText: 'Add bird',
            extraHtml: `<label class="form-label">Type of bird</label><select class="form-select mb-2" name="ptype">${typeOptions}</select>
              ${WITH_WING ? '<label class="form-label">Wingband <span class="small text-muted">(stag / bullstag only)</span></label><input class="form-control mb-2" name="pwing" inputmode="numeric" maxlength="6" autocomplete="off">' : ''}
              ${MANUAL ? `<label class="form-label">Weight in grams <span class="small text-muted">(cock${BY_WEIGHT ? ', required' : ''})</span></label><input class="form-control mb-2" name="pweight" inputmode="decimal" maxlength="8" autocomplete="off">` : ''}`,
          });
          if (!r) return;
          payload = { type: r.form.ptype.value, wingband: WITH_WING ? r.form.pwing.value.trim() : '', weight: MANUAL ? r.form.pweight.value.trim() : r.value };
          if (MANUAL) payload.legband = r.value;
        }
        b.disabled = true;
        const row = await api('POST', ev(`/entries/${b.dataset.add}/legbands`), payload);
        toast(row.displayStatus === 'COMPLETE' ? `Entry #${row.entryNumber} is complete` : `Entry #${row.entryNumber} updated`);
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

  // ---------- Edit ----------
  const editField = (name, i) => editForm[`${name}${i + 1}`];
  function syncEditRow(i) {
    const ty = editField('type', i); const wing = editField('wingband', i);
    if (!ty || !wing) return;
    const needs = App.needsWingband(ty.value);
    wing.disabled = ty.disabled || !needs;
    if (!needs) wing.value = '';
  }
  for (let i = 0; i < PER_ENTRY; i += 1) { const ty = editField('type', i); if (ty) ty.addEventListener('change', () => syncEditRow(i)); }

  function openEdit(ent) {
    editForm.reset();
    $('editError').classList.add('d-none');
    $('editTitle').textContent = `Edit entry #${ent.entryNumber}`;
    editForm.entryId.value = ent.id;
    editForm.participantName.value = ent.participantName;
    editForm.entryName.value = ent.entryName;
    editForm.address.value = ent.address || '';
    $('editLocked').classList.toggle('d-none', !ent.locked);
    $('reasonWrap').classList.toggle('d-none', !ent.locked);
    for (let i = 0; i < PER_ENTRY; i += 1) {
      const lb = slotsOf(ent)[i];
      const off = !lb || lb.status !== 'AVAILABLE';
      const title = !lb ? 'Use “+ Legband” in the table to add this bird' : (lb.status !== 'AVAILABLE' ? 'Already in a match — cannot be changed' : '');
      const set = (name, value) => { const el = editField(name, i); if (el) { el.value = value; el.disabled = off; el.title = title; } };
      set('type', lb ? lb.type : 'COCK');
      set('legband', lb && lb.number ? lb.number : '');
      set('wingband', lb && lb.wingband ? lb.wingband : '');
      set('weight', lb && lb.weight != null ? lb.weight : '');
      syncEditRow(i);
    }
    editModal.show();
  }
  editModalEl.addEventListener('shown.bs.modal', () => editForm.participantName.focus());
  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      // One value per slot; a disabled box (in a match, not added yet, or not used by the type) is sent as null.
      const per = (name) => Array.from({ length: PER_ENTRY }, (_, i) => {
        const el = editField(name, i);
        return !el || el.disabled ? null : el.value;
      });
      const body = {
        participantName: editForm.participantName.value, entryName: editForm.entryName.value, address: editForm.address.value,
        types: per('type'), legbands: per('legband'), wingbands: per('wingband'), weights: per('weight'), reason: editForm.reason.value,
      };
      await api('PATCH', ev(`/entries/${editForm.entryId.value}`), body);
      editModal.hide(); toast('Entry updated.'); reloadAll();
    } catch (err) { const b = $('editError'); b.textContent = err.message; b.classList.remove('d-none'); }
  });

  syncRows();
  App.live({ onChange: reloadAll, onResync: reloadAll });
  pName.focus();
  reloadAll();
})();
