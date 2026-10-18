(function () {
  'use strict';
  const { api, ev, esc, pad, pts } = App;
  const $ = (id) => document.getElementById(id);
  const STATUS = {
    NOT_MATCHED: { label: 'Not matched', cls: 'text-bg-light border' },
    MATCHED: { label: 'Matched', cls: 'text-bg-primary' },
    FOUGHT: { label: 'Fought', cls: 'text-bg-success' },
    CANCELLED: { label: 'Cancelled', cls: 'text-bg-secondary' },
    WITHDRAWN: { label: 'Withdrawn', cls: 'text-bg-dark' },
    NO_LEGBAND: { label: 'No legband yet', cls: 'text-bg-warning' },
  };
  const OUTCOME = { WIN: ['WIN', 'gc-win'], LOSE: ['LOSE', 'gc-lose'], DRAW: ['DRAW', 'gc-draw'] };
  let rows = [];
  let filter = '';

  function statusCell(g) {
    const s = STATUS[g.status];
    let html = `<span class="badge ${s.cls}">${s.label}</span>`;
    if (g.fight && g.fight.isCurrent) html += ' <span class="badge text-bg-warning">NOW</span>';
    if (g.fight && g.fight.outcome) {
      const [t, c] = OUTCOME[g.fight.outcome];
      html += ` <span class="gc-outcome ${c}">${t} ${pts(g.fight.points)}</span>`;
    }
    return html;
  }
  function fightCell(f) {
    if (!f) return '<span class="text-muted">—</span>';
    return `<b>#${pad(f.fightNumber)}</b> <span class="gc-corner ${f.corner === 'MERON' ? 'gc-meron' : 'gc-wala'}">${f.corner}</span>`;
  }
  function opponentCell(f) {
    if (!f || !f.opponent) return '<span class="text-muted">—</span>';
    const o = f.opponent;
    return `<span class="lb">${esc(o.legband)}</span> · <span class="fw-semibold">${esc(o.entryName)}</span> <span class="badge text-bg-light border">Entry #${o.slot}</span>
      <div class="small text-muted">${esc(o.owner)}</div>`;
  }

  function sorted(list) {
    const by = $('sortBy').value;
    const fightNo = (g) => (g.fight ? g.fight.fightNumber : Infinity);
    const cmp = {
      legband: () => 0, // server order
      entry: (a, b) => a.entryName.localeCompare(b.entryName) || a.entryNumber - b.entryNumber || (a.slot || 0) - (b.slot || 0),
      owner: (a, b) => a.owner.localeCompare(b.owner) || a.entryNumber - b.entryNumber || (a.slot || 0) - (b.slot || 0),
      fight: (a, b) => fightNo(a) - fightNo(b) || a.entryNumber - b.entryNumber,
    }[by];
    return by === 'legband' ? list : [...list].sort(cmp);
  }

  function render() {
    const q = $('search').value.trim().toLowerCase();
    const qNum = q.replace(/^#?0*/, '');
    const shown = sorted(rows.filter((g) => {
      if (filter && g.status !== filter) return false;
      if (!q) return true;
      const o = g.fight && g.fight.opponent;
      const hay = [g.legband, g.entryName, g.owner, g.address, o && o.legband, o && o.entryName, o && o.owner].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q) || (qNum && g.fight && String(g.fight.fightNumber) === qNum);
    }));
    $('counts').textContent = `${shown.length} of ${rows.length} shown`;
    $('gcRows').innerHTML = shown.length ? shown.map((g) => `<tr class="${g.status === 'CANCELLED' || g.status === 'WITHDRAWN' ? 'gc-dim' : ''} ${g.fight && g.fight.isCurrent ? 'is-current' : ''}">
        <td>${g.legband ? `<span class="lb fs-6">${esc(g.legband)}</span>` : '<span class="text-muted">—</span>'}</td>
        <td><div class="fw-semibold">${esc(g.entryName)}</div>${g.address ? `<div class="small text-muted">${esc(g.address)}</div>` : ''}</td>
        <td>${g.slot ? `<span class="badge text-bg-light border fs-6">Entry #${g.slot}</span>` : '<span class="text-muted">—</span>'}</td>
        <td>${esc(g.owner)}</td>
        <td>${statusCell(g)}</td>
        <td>${fightCell(g.fight)}</td>
        <td>${opponentCell(g.fight)}</td>
      </tr>`).join('')
      : '<tr><td colspan="7" class="text-muted">No gamecocks found.</td></tr>';
  }

  function renderChips() {
    const count = (s) => rows.filter((g) => !s || g.status === s).length;
    const chips = [['', 'All'], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])]
      .filter(([k]) => !k || count(k) > 0 || k === filter);
    $('chips').innerHTML = chips.map(([k, label]) => `<button type="button" class="btn btn-sm ${filter === k ? 'btn-dark' : 'btn-outline-dark'}" data-filter="${k}" aria-pressed="${filter === k}">${label} <span class="badge ${filter === k ? 'text-bg-light' : 'text-bg-secondary'}">${count(k)}</span></button>`).join('');
  }

  async function load() {
    try {
      rows = await api('GET', ev('/gamecocks'));
      renderChips();
      render();
    } catch (e) {
      $('gcRows').innerHTML = `<tr><td colspan="7" class="text-danger">${esc(e.message)}</td></tr>`;
    }
  }

  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    renderChips();
    render();
  });
  $('search').addEventListener('input', App.debounce(render, 120));
  $('sortBy').addEventListener('change', render);
  const reload = App.debounce(load, 250);
  App.live({ onChange: reload, onResync: reload });
  load();
})();
