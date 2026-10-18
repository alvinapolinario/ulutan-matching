(function () {
  'use strict';
  const { api, ev, toast, pad } = App;
  async function load() {
    try {
      const s = await api('GET', ev('/summary'));
      const items = [
        ['Participants', s.participants], ['Entries', s.entries], ['Registered legbands', s.legbands], ['Legbands left', s.legbandsLeft],
        ['Available', s.available], ['Matched', s.matched], ['Pending fights', s.confirmedMatches], ['Completed fights', s.completedMatches],
        ['Cancelled', s.cancelledMatches], ['Current fight', s.currentFight ? '#' + pad(s.currentFight) : '—'], ['Next fight', s.nextFight ? '#' + pad(s.nextFight) : '—'],
        ['Entries not fully matched', s.unmatchedEntries],
      ];
      document.getElementById('stats').innerHTML = items.map(([l, v]) => `<div class="col-6 col-md-3 col-xl-2"><div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div></div>`).join('');
    } catch (e) { toast(e.message, 'danger'); }
  }
  App.live({ onChange: load, onResync: load });
  load();
})();
