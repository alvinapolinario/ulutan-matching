(function () {
  'use strict';
  const { api, ev, esc, toast, pad, pts } = App;
  const rows = document.getElementById('fightRows');
  const search = document.getElementById('search');
  const statusFilter = document.getElementById('statusFilter');
  let list = [];

  const statusBadge = (s) => `<span class="badge status-badge text-bg-${{ CONFIRMED: 'primary', COMPLETED: 'success', CANCELLED: 'secondary' }[s]}">${s}</span>`;
  const resultText = (m) => (m.result ? `<span class="fw-bold">${pts(m.redPoints)} – ${pts(m.bluePoints)}</span> <span class="small text-muted">${{ RED: 'Red wins', BLUE: 'Blue wins', DRAW: 'Draw' }[m.result]}</span>` : '');

  function actions(m) {
    if (m.status === 'CANCELLED') return `<span class="small text-muted" title="${esc(m.cancelReason)}">by ${esc(m.cancelledBy)}: ${esc(m.cancelReason)}</span>`;
    const b = [];
    if (!m.isCurrent) b.push(`<button class="btn btn-sm btn-outline-warning" data-act="current">Set active</button>`);
    if (m.status === 'CONFIRMED') {
      b.push(`<div class="btn-group btn-group-sm" role="group" aria-label="Result"><button class="btn btn-outline-danger" data-act="result" data-r="RED" title="Red wins 1-0">R 1-0</button><button class="btn btn-outline-secondary" data-act="result" data-r="DRAW" title="Draw ½-½">½</button><button class="btn btn-outline-primary" data-act="result" data-r="BLUE" title="Blue wins 0-1">B 0-1</button></div>`);
    }
    if (App.isAdmin) {
      if (m.status === 'CONFIRMED') {
        b.push(`<button class="btn btn-sm btn-light" data-act="up" title="Move up">↑</button><button class="btn btn-sm btn-light" data-act="down" title="Move down">↓</button>`);
        b.push(`<div class="btn-group btn-group-sm"><button class="btn btn-outline-dark dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">More</button><ul class="dropdown-menu dropdown-menu-end">
          <li><button class="dropdown-item" data-act="correct">Correct legband…</button></li>
          <li><button class="dropdown-item" data-act="number">Change fight number…</button></li>
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item text-danger" data-act="cancel">Cancel match…</button></li></ul></div>`);
      } else {
        b.push(`<div class="btn-group btn-group-sm"><button class="btn btn-outline-dark dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">More</button><ul class="dropdown-menu dropdown-menu-end">
          <li><button class="dropdown-item" data-act="changeResult">Change result…</button></li>
          <li><button class="dropdown-item" data-act="number">Change fight number…</button></li></ul></div>`);
      }
    }
    return b.join(' ');
  }

  function render() {
    const q = search.value.trim().toLowerCase().replace(/^#/, '');
    const shown = list.filter((m) => {
      if (statusFilter.value && m.status !== statusFilter.value) return false;
      if (!q) return true;
      return [m.red.legband, m.blue.legband, m.red.entryName, m.blue.entryName, m.red.participantName, m.blue.participantName].join(' ').toLowerCase().includes(q)
        || pad(m.fightNumber) === App.pad(parseInt(q, 10)) ;
    });
    rows.innerHTML = shown.length ? shown.map((m) => `<tr data-id="${m.id}" class="${m.isCurrent ? 'is-current' : ''} ${m.status === 'CANCELLED' ? 'is-cancelled' : ''}">
      <td class="text-muted">${m.status === 'CANCELLED' ? '' : (list.filter((x) => x.status !== 'CANCELLED').indexOf(m) + 1)}</td>
      <td class="fw-bold">#${pad(m.fightNumber)}${m.isCurrent ? ' <span class="badge text-bg-warning">NOW</span>' : ''}</td>
      <td class="row-red">${esc(m.red.entryName)}<div class="small text-muted fw-normal">#${m.red.entryNumber} · ${esc(m.red.participantName)}</div></td><td class="lb row-red">${esc(m.red.legband)}</td>
      <td class="row-blue">${esc(m.blue.entryName)}<div class="small text-muted fw-normal">#${m.blue.entryNumber} · ${esc(m.blue.participantName)}</div></td><td class="lb row-blue">${esc(m.blue.legband)}</td>
      <td>${statusBadge(m.status)}</td><td>${resultText(m)}</td>
      <td class="text-end text-nowrap actions">${actions(m)}</td></tr>`).join('')
      : '<tr><td colspan="9" class="text-muted">No fights found.</td></tr>';
    const c = (s) => list.filter((m) => m.status === s).length;
    document.getElementById('counts').textContent = `${c('CONFIRMED')} pending · ${c('COMPLETED')} done · ${c('CANCELLED')} cancelled`;
  }

  async function load() { list = await api('GET', ev('/matches')); render(); }
  const reload = () => load().catch((e) => toast(e.message, 'danger'));

  rows.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const m = list.find((x) => x.id === Number(b.closest('tr').dataset.id));
    const label = `Fight #${pad(m.fightNumber)} (${m.red.legband} vs ${m.blue.legband})`;
    try {
      switch (b.dataset.act) {
        case 'current':
          await api('POST', ev('/display/current'), { matchId: m.id }); toast(`${label} is now the active fight.`); break;
        case 'result': {
          await api('POST', ev(`/matches/${m.id}/result`), { result: b.dataset.r, advance: m.isCurrent });
          toast(`Result saved for ${label}.`); break;
        }
        case 'changeResult': {
          const r = await App.prompt({ title: `Change result — ${label}`, label: 'Reason', confirmText: 'Save result',
            extraHtml: `<label class="form-label">New result</label><select class="form-select mb-3" name="result"><option value="RED">Red wins (1 – 0)</option><option value="DRAW">Draw (½ – ½)</option><option value="BLUE">Blue wins (0 – 1)</option></select>` });
          if (!r) return;
          await api('POST', ev(`/matches/${m.id}/result`), { result: r.form.result.value, reason: r.value }); toast('Result changed.'); break;
        }
        case 'up': case 'down':
          await api('POST', ev(`/matches/${m.id}/move`), { direction: b.dataset.act }); break;
        case 'cancel': {
          const r = await App.prompt({ title: `Cancel ${label}?`, label: 'Reason (required)', confirmText: 'Cancel match', danger: true,
            extraHtml: '<div class="alert alert-warning py-2">Both legbands become <b>unusable</b>. The fight number is not reused.</div>' });
          if (!r) return;
          await api('POST', ev(`/matches/${m.id}/cancel`), { reason: r.value }); toast(`${label} cancelled.`, 'warning'); break;
        }
        case 'correct': {
          const r = await App.prompt({ title: `Correct legband — ${label}`, label: 'Reason (required)', confirmText: 'Save correction',
            extraHtml: `<div class="row g-2 mb-3"><div class="col-5"><label class="form-label">Corner</label><select class="form-select" name="corner"><option value="red">Red (${esc(m.red.legband)})</option><option value="blue">Blue (${esc(m.blue.legband)})</option></select></div>
              <div class="col-7"><label class="form-label">Correct legband number</label><input class="form-control lb" name="legband" inputmode="numeric" required></div></div>
              <p class="small text-muted">The replaced legband becomes available again (it never fought).</p>` });
          if (!r) return;
          await api('POST', ev(`/matches/${m.id}/correct`), { corner: r.form.corner.value, legband: r.form.legband.value, reason: r.value }); toast('Match corrected.'); break;
        }
        case 'number': {
          const r = await App.prompt({ title: `Change fight number — ${label}`, label: 'Reason (required)', confirmText: 'Save',
            extraHtml: `<label class="form-label">New fight number</label><input class="form-control mb-3" name="fightNumber" type="number" min="1" max="9999" value="${m.fightNumber}" required>` });
          if (!r) return;
          await api('POST', ev(`/matches/${m.id}/fight-number`), { fightNumber: Number(r.form.fightNumber.value), reason: r.value }); toast('Fight number changed.'); break;
        }
        default: return;
      }
      reload();
    } catch (err) { toast(err.message, 'danger', 6000); }
  });
  search.addEventListener('input', App.debounce(render, 120));
  statusFilter.addEventListener('change', render);
  App.live({ onChange: reload, onResync: reload });
  reload();
})();
