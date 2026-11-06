'use strict';

/*
 * Events tab. Events work like tags: you create them under Manage (a trip, a move, a wedding) and put them on
 * purchases in the editor. This tab totals each event's purchases and the refunds on them.
 */

function renderEvents() {
  const rows = state.snapshot.events.map(event => {
    const entries = state.model.transactions.filter(tx => eventIdsOf(tx).includes(event.id));
    const totals = monthTotals(entries);
    return {
      onClick: () => openScopeList('event', event.id),
      cells: [
        archivedLabel(event),
        { text: numberFormat.format(totals.purchases), num: true },
        { text: formatMoney(totals.spent), num: true },
        { text: formatMoney(totals.refunded), num: true },
        { text: formatMoney(totals.net), num: true },
        entries.length ? formatDateRange(entries[0].date, entries.at(-1).date) : '—',
        rowActionButtons([['Stats', () => showEventStats(event), `Show stats for ${event.name}`]])
      ]
    };
  });
  renderTable($('#eventsTable'), [
    { label: 'Event' },
    { label: 'Purchases', num: true },
    { label: 'Spent', num: true },
    { label: 'Refunds', num: true, title: 'Refunds on purchases in this event, whenever they were refunded.' },
    { label: 'Net Spent', num: true, title: 'Spent minus refunds.' },
    { label: 'Dates', title: 'From the first to the last entry in the event.' },
    { label: '' }
  ], rows, { empty: 'No events yet. Add one under Manage → Events, then choose it on purchases in the editor.' });
}

function showEventStats(event) {
  state.statsPeriod = `e:${event.id}`;
  switchTab('stats');
}
