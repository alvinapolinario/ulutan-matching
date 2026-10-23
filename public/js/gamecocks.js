(function () {
  'use strict';
  const { api, ev, esc, pad } = App;
  const $ = (id) => document.getElementById(id);
  const STATUS = {
    NOT_MATCHED: { label: 'Not Match' },
    MATCHED: { label: 'Matched' },
    FOUGHT: { label: 'Fought' },
    CANCELLED: { label: 'Cancelled' },
    WITHDRAWN: { label: 'Withdrawn' },
    NO_LEGBAND: { label: 'No legband' },
  };
  const OUTCOME = { WIN: 'Win', LOSE: 'Lose', DRAW: 'Draw' };
  let rows = [];
  let filter = '';

  function statusText(g) {
    if (g.status === 'FOUGHT' && g.fight && g.fight.outcome) return OUTCOME[g.fight.outcome];
    return STATUS[g.status].label;
  }
  function fightCell(f) {
    if (!f) return '-';
    const now = f.isCurrent ? ' <span class="badge text-bg-warning">NOW</span>' : '';
    return `<b>${pad(f.fightNumber)}</b> <span class="gc-corner ${f.corner === 'MERON' ? 'gc-meron' : 'gc-wala'}">${f.corner}</span>${now}`;
  }
  function opponentCell(f) {
    if (!f || !f.opponent) return '-';
    const o = f.opponent;
    return `<div class="fw-semibold">${esc(o.entryName)}</div><div class="small text-muted">${esc(o.legband)} · ${esc(o.owner)}</div>`;
  }

  function groupsOf(list) {
    const map = new Map();
    for (const g of list) {
      if (!map.has(g.entryId)) map.set(g.entryId, []);
      map.get(g.entryId).push(g);
    }
    const groups = [...map.values()];
    for (const g of groups) g.sort((a, b) => (a.slot || 99) - (b.slot || 99));
    const head = (g) => g[0];
    const minLb = (g) => g.map((x) => x.legband).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] || '\uffff';
    const minFight = (g) => Math.min(...g.map((x) => (x.fight ? x.fight.fightNumber : Infinity)));
    const by = $('sortBy').value;
    const cmp = {
      entry: (a, b) => head(a).entryNumber - head(b).entryNumber,
      legband: (a, b) => minLb(a).localeCompare(minLb(b), undefined, { numeric: true }) || head(a).entryNumber - head(b).entryNumber,
      owner: (a, b) => head(a).owner.localeCompare(head(b).owner) || head(a).entryNumber - head(b).entryNumber,
      fight: (a, b) => minFight(a) - minFight(b) || head(a).entryNumber - head(b).entryNumber,
    }[by];
    return groups.sort(cmp);
  }

  function render() {
    const q = $('search').value.trim().toLowerCase();
    const qNum = q.replace(/^#?0*/, '');
    const shown = rows.filter((g) => {
      if (filter && g.status !== filter) return false;
      if (!q) return true;
      const o = g.fight && g.fight.opponent;
      const hay = [g.legband, g.entryName, g.owner, g.address, String(g.entryNumber), o && o.legband, o && o.entryName, o && o.owner].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q) || (qNum && g.fight && String(g.fight.fightNumber) === qNum);
    });
    $('counts').textContent = `${shown.length} of ${rows.length} shown`;
    const groups = groupsOf(shown);
    $('gcRows').innerHTML = groups.length ? groups.map((chickens) => chickens.map((g, i) => {
      const name = [`<div class="fw-semibold">${esc(g.entryName)}</div>`];
      if (g.owner && g.owner !== g.entryName) name.push(`<div>${esc(g.owner)}</div>`);
      if (g.address) name.push(`<div>${esc(g.address)}</div>`);
      const entryCells = i === 0
        ? `<td class="gc-entry" rowspan="${chickens.length}">Entry #${g.entryNumber}</td><td class="gc-entry gc-name" rowspan="${chickens.length}">${name.join('')}</td>`
        : '';
      const dim = g.status === 'CANCELLED' || g.status === 'WITHDRAWN' ? 'gc-dim' : '';
      const current = g.fight && g.fight.isCurrent ? 'is-current' : '';
      return `<tr class="${i === 0 ? 'gc-entry-start' : ''} ${dim} ${current}">${entryCells}
        <td class="gc-center">${g.legband ? `<i class="bi bi-check-lg gc-check" aria-hidden="true"></i><span class="lb">${esc(g.legband)}</span>` : '-'}</td>
        <td class="gc-center">${esc(statusText(g))}</td>
        <td class="gc-center">${fightCell(g.fight)}</td>
        <td class="gc-center">${opponentCell(g.fight)}</td></tr>`;
    }).join('')).join('')
      : '<tr><td colspan="6" class="text-muted">No gamecocks found.</td></tr>';
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
      $('gcRows').innerHTML = `<tr><td colspan="6" class="text-danger">${esc(e.message)}</td></tr>`;
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
