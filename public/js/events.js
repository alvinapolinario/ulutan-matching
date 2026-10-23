(function () {
  'use strict';
  const { api, esc, toast } = App;
  const TRANSITIONS = {
    DRAFT: ['REGISTRATION_OPEN'], REGISTRATION_OPEN: ['DRAFT', 'MATCHING_OPEN'], MATCHING_OPEN: ['REGISTRATION_OPEN', 'ACTIVE'],
    ACTIVE: ['MATCHING_OPEN', 'COMPLETED'], COMPLETED: ['ACTIVE', 'ARCHIVED'], ARCHIVED: ['COMPLETED'],
  };
  const ORDER = Object.keys(TRANSITIONS);
  const rows = document.getElementById('eventRows');
  const modalEl = document.getElementById('eventModal');
  const modal = new bootstrap.Modal(modalEl);
  const form = document.getElementById('eventForm');
  const errBox = document.getElementById('eventError');
  let events = [];

  async function load() {
    events = await api('GET', '/api/events');
    events.sort((a, b) => (a.status === 'ARCHIVED') - (b.status === 'ARCHIVED') || b.id - a.id);
    if (!events.length) { rows.innerHTML = '<tr><td colspan="10" class="text-muted">No events yet. Click “New event”.</td></tr>'; return; }
    rows.innerHTML = events.map((e) => `<tr class="${e.status === 'ARCHIVED' ? 'text-muted' : ''}">
      <td class="fw-semibold">${esc(e.name)}</td><td>${esc(e.date)}</td><td>${esc(e.venue)}</td>
      <td><span class="badge text-bg-secondary">${esc(e.status.replace('_', ' '))}</span></td>
      <td>${(e.legbandMode || 'MANUAL') === 'MANUAL' ? 'Typed' : 'Auto'}</td>
      <td>${(e.fightNumberMode || 'DRAW') === 'DRAW' ? 'Bunot' : 'Auto from ' + e.startingFightNumber}</td><td>${e.maxLegbands}</td><td>${e.legbandsIssued}</td>
      <td class="text-end">${TRANSITIONS[e.status].filter((s) => s !== 'ARCHIVED').map((s) => {
        const fwd = ORDER.indexOf(s) > ORDER.indexOf(e.status);
        return `<button class="btn btn-sm ${fwd ? 'btn-success' : 'btn-outline-secondary'} ms-1" data-status="${s}" data-id="${e.id}">${fwd ? '→' : '←'} ${esc(s.replace('_', ' '))}</button>`;
      }).join('')}${e.status === 'COMPLETED' ? `<button class="btn btn-sm btn-dark ms-1" data-archive="${e.id}">Archive</button>` : ''}${e.archiveFile ? `<div class="small text-muted mt-1">Saved copy: ${esc(e.archiveFile)}</div>` : ''}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-dark" data-edit="${e.id}">Edit</button></td></tr>`).join('');
  }

  function openForm(ev) {
    form.reset(); errBox.classList.add('d-none');
    document.getElementById('eventModalTitle').textContent = ev ? 'Edit event' : 'New event';
    form.id.value = ev ? ev.id : '';
    if (ev) {
      form.name.value = ev.name; form.date.value = ev.date; form.venue.value = ev.venue || '';
      form.startingFightNumber.value = ev.startingFightNumber; form.maxLegbands.value = ev.maxLegbands; form.upcomingCount.value = ev.display.upcomingCount; form.fightNumberMode.value = ev.fightNumberMode || 'DRAW'; form.legbandMode.value = ev.legbandMode || 'MANUAL';
    } else {
      form.date.value = new Date().toLocaleDateString('en-CA');
    }
    modal.show();
  }
  modalEl.addEventListener('shown.bs.modal', () => form.name.focus());
  document.getElementById('newEventBtn').onclick = () => openForm(null);
  document.getElementById('backupBtn').onclick = async () => {
    try { const r = await api('POST', '/api/backup'); toast(`Backup saved: ${r.file}`); } catch (e) { toast(e.message, 'danger'); }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      name: form.name.value, date: form.date.value, venue: form.venue.value,
      fightNumberMode: form.fightNumberMode.value,
      legbandMode: form.legbandMode.value,
      startingFightNumber: Number(form.startingFightNumber.value), maxLegbands: Number(form.maxLegbands.value), upcomingCount: Number(form.upcomingCount.value),
    };
    try {
      if (form.id.value) await api('PATCH', `/api/events/${form.id.value}`, data);
      else {
        const ev = await api('POST', '/api/events', data);
        // Switch the session to the new event so the rest of the app uses it.
        const f = document.createElement('form'); f.method = 'post'; f.action = '/select-event';
        f.innerHTML = `<input name="_csrf" value="${esc(document.querySelector('meta[name=csrf-token]').content)}"><input name="eventId" value="${ev.id}"><input name="back" value="/events">`;
        document.body.appendChild(f); f.submit(); return;
      }
      modal.hide(); toast('Event saved.'); load();
    } catch (err) { errBox.textContent = err.message; errBox.classList.remove('d-none'); }
  });

  rows.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) return openForm(events.find((x) => x.id === Number(b.dataset.edit)));
    if (b.dataset.archive) {
      const named = events.find((x) => x.id === Number(b.dataset.archive));
      const r = await App.prompt({
        title: `Archive ${named ? named.name : 'this event'}?`,
        label: 'Optional note',
        required: false,
        confirmText: 'Archive',
        extraHtml: '<p class="small mb-2">Entries, legbands and fights stay available in reports, and a copy is saved. Registration and matching close. Next you can create the new event. Restore to Completed if this was a mistake.</p>',
      });
      if (!r) return;
      b.disabled = true;
      try {
        const ev = await api('POST', `/api/events/${b.dataset.archive}/status`, { status: 'ARCHIVED', note: r.value });
        toast(`Archived. Copy saved: ${ev.archiveFile}`, 'success', 6000);
        await load();
        openForm(null);
      } catch (err) { toast(err.message, 'danger'); b.disabled = false; }
      return;
    }
    if (b.dataset.status) {
      try { await api('POST', `/api/events/${b.dataset.id}/status`, { status: b.dataset.status }); toast(`Status changed to ${b.dataset.status.replace('_', ' ')}.`); location.reload(); } catch (err) { toast(err.message, 'danger'); }
    }
  });
  load().catch((e) => toast(e.message, 'danger'));
})();
