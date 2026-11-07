'use strict';

/*
 * Payment Methods, Tags, Collections, and Merchants tabs: totals per item from the purchases that have it and the refunds
 * on those purchases, with an Add form and Rename/Archive/Delete on each row. Selecting a row lists that scope's
 * entries; a collection can also be opened as a Stats period.
 */

function merchantIdsOf(tx) {
  const source = tx.kind === 'Refund' ? state.model.byId.get(tx.linkedId) ?? tx : tx;
  return source.merchantId == null ? [] : [source.merchantId];
}

function renderLabelSummary(table, scope, path, items, idsOf, { label, empty, stats = false }) {
  const rows = items.map(item => {
    const entries = state.model.transactions.filter(tx => tx.kind !== 'Payback' && idsOf(tx).includes(item.id));
    const uses = state.model.transactions.filter(tx => idsOf(tx).includes(item.id)).length;
    const totals = monthTotals(entries);
    const actions = manageButtons(path, item, uses, stats ? [['Stats', () => showCollectionStats(item), `Show stats for ${item.name}`]] : []);
    return {
      onClick: () => openScopeList(scope, item.id),
      cells: [
        `#${item.id}`,
        archivedLabel(item),
        { text: numberFormat.format(totals.purchases), num: true },
        { text: formatMoney(totals.spent), num: true },
        { text: formatMoney(totals.refunded), num: true },
        { text: formatMoney(totals.net), num: true },
        entries.length ? formatDateRange(entries[0].date, entries.at(-1).date) : '—',
        actions
      ]
    };
  });
  renderTable(table, [
    { label: 'ID', title: 'Permanent ID, never reused.' },
    { label },
    { label: 'Purchases', num: true },
    { label: 'Spent', num: true },
    { label: 'Refunds', num: true, title: 'Refunds on these purchases, whenever they were refunded.' },
    { label: 'Net Spent', num: true, title: 'Spent minus refunds.' },
    { label: 'Dates', title: 'From the first to the last entry.' },
    { label: '' }
  ], rows, { empty });
}

function renderMethodsTab() {
  renderLabelSummary($('#methodsTable'), 'method', 'payment-methods', state.snapshot.paymentMethods, tx => [tx.paymentMethodId],
    { label: 'Payment Method', empty: 'No payment methods yet. Add one above.' });
}

function renderTagsTab() {
  renderLabelSummary($('#tagsTable'), 'tag', 'tags', state.snapshot.tags, tagIdsOf,
    { label: 'Tag', empty: 'No tags yet. Add one above, then choose it on purchases in the editor.' });
}

function renderCollectionsTab() {
  renderLabelSummary($('#collectionsTable'), 'collection', 'collections', state.snapshot.collections, collectionIdsOf,
    { label: 'Collection', empty: 'No collections yet. Add one above, then choose it on purchases in the editor.', stats: true });
}

function renderMerchantsTab() {
  // The search box narrows the list by name, ignoring case.
  const query = $('#merchantSearch').value.trim().toLowerCase();
  const merchants = query ? state.snapshot.merchants.filter(merchant => merchant.name.toLowerCase().includes(query)) : state.snapshot.merchants;
  renderLabelSummary($('#merchantsTable'), 'merchant', 'merchants', merchants, merchantIdsOf, {
    label: 'Merchant',
    empty: query ? `No merchant matches “${$('#merchantSearch').value.trim()}”.` : 'No merchants yet. Add one above, then choose it in the editor.'
  });
}

function showCollectionStats(collection) {
  state.statsPeriod = [`c:${collection.id}`];
  switchTab('stats');
}
