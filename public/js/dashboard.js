(function () {
  'use strict';
  const { api, ev, toast, pad } = App;
  async function load() {
    try {
      const s = await api('GET', ev('/summary'));
      const items = [
        ['bi-people', 'Participants', s.participants], ['bi-collection', 'Entries', s.entries], ['bi-tag', 'Registered legbands', s.legbands], ['bi-tag', 'Legbands left', s.legbandsLeft],
        ['bi-check2-circle', 'Available', s.available], ['bi-arrow-left-right', 'Matched', s.matched], ['bi-hourglass-split', 'Pending fights', s.confirmedMatches], ['bi-flag', 'Completed fights', s.completedMatches],
        ['bi-x-circle', 'Cancelled', s.cancelledMatches], ['bi-broadcast', 'Current fight', s.currentFight ? '#' + pad(s.currentFight) : '—'], ['bi-skip-forward', 'Next fight', s.nextFight ? '#' + pad(s.nextFight) : '—'],
        ['bi-exclamation-circle', 'Entries not fully matched', s.unmatchedEntries],
      ];
      document.getElementById('stats').innerHTML = items.map(([icon, l, v]) => `<div class="col-6 col-md-4 col-xl-2"><div class="stat"><i class="bi ${icon}" aria-hidden="true"></i><div class="v">${v}</div><div class="l">${l}</div></div></div>`).join('');
    } catch (e) { toast(e.message, 'danger'); }
  }
  App.live({ onChange: load, onResync: load });
  load();
})();
