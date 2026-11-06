'use strict';

/*
 * Tags, Events, and Merchants tabs: totals per tag, event, or merchant, each from the purchases that have it and the
 * refunds on those purchases. They are added under Manage and chosen on purchases in the editor. Selecting a row
 * lists that scope's entries; an event can also be opened as a Stats period.
 */

function merchantIdsOf(tx) {
  const source = tx.kind === 'Refund' ? state.model.byId.get(tx.linkedId) ?? tx : tx;
  return source.merchantId == null ? [] : [source.merchantId];
}

function renderLabelSummary(table, scope, items, idsOf, { label, empty, stats = false }) {
  const rows = items.map(item => {
    const entries = state.model.transactions.filter(tx => tx.kind !== 'Payback' && idsOf(tx).includes(item.id));
    const totals = monthTotals(entries);
    const cells = [
      archivedLabel(item),
      { text: numberFormat.format(totals.purchases), num: true },
      { text: formatMoney(totals.spent), num: true },
      { text: formatMoney(totals.refunded), num: true },
      { text: formatMoney(totals.net), num: true },
      entries.length ? formatDateRange(entries[0].date, entries.at(-1).date) : '—'
    ];
    if (stats) cells.push(rowActionButtons([['Stats', () => showEventStats(item), `Show stats for ${item.name}`]]));
    return { onClick: () => openScopeList(scope, item.id), cells };
  });
  renderTable(table, [
    { label },
    { label: 'Purchases', num: true },
    { label: 'Spent', num: true },
    { label: 'Refunds', num: true, title: 'Refunds on these purchases, whenever they were refunded.' },
    { label: 'Net Spent', num: true, title: 'Spent minus refunds.' },
    { label: 'Dates', title: 'From the first to the last entry.' },
    ...(stats ? [{ label: '' }] : [])
  ], rows, { empty });
}

function renderTagsTab() {
  renderLabelSummary($('#tagsSummaryTable'), 'tag', state.snapshot.tags, tagIdsOf,
    { label: 'Tag', empty: 'No tags yet. Add one under Manage → Tags, then choose it on purchases in the editor.' });
}

function renderEvents() {
  renderLabelSummary($('#eventsTable'), 'event', state.snapshot.events, eventIdsOf,
    { label: 'Event', empty: 'No events yet. Add one under Manage → Events, then choose it on purchases in the editor.', stats: true });
}

function renderMerchantsTab() {
  renderLabelSummary($('#merchantsSummaryTable'), 'merchant', state.snapshot.merchants, merchantIdsOf,
    { label: 'Merchant', empty: 'No merchants yet. Add one under Manage → Merchants, then choose it in the editor.' });
}

function showEventStats(event) {
  state.statsPeriod = `e:${event.id}`;
  switchTab('stats');
}
