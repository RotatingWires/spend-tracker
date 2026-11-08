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

/** With actionsInDialog, the row has no Rename/Archive/Delete buttons; they sit in the dialog the row opens. */
function renderLabelSummary(table, scope, path, items, idsOf, { label, empty, stats = false, actionsInDialog = false }) {
  const rows = items.map(item => {
    const entries = state.model.transactions.filter(tx => tx.kind !== 'Payback' && idsOf(tx).includes(item.id));
    const uses = state.model.transactions.filter(tx => idsOf(tx).includes(item.id)).length;
    const totals = monthTotals(entries);
    const actions = actionsInDialog ? null : manageButtons(path, item, uses, stats ? [['Stats', () => showCollectionStats(item), `Show stats for ${item.name}`]] : []);
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
        ...(actions ? [actions] : [])
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
    ...(actionsInDialog ? [] : [{ label: '' }])
  ], rows, { empty });
}

/** The tab's search (applied with its Search button) narrows its list by name, ignoring case. */
function searchedItems(tab, items) {
  const query = state.listQueries[tab].toLowerCase();
  return query ? items.filter(item => item.name.toLowerCase().includes(query)) : items;
}

/** The empty-table message: what the search missed, or how to add the first one. */
function searchEmpty(tab, singular, emptyText) {
  return state.listQueries[tab] ? `No ${singular} matches "${state.listQueries[tab]}".` : emptyText;
}

function renderMethodsTab() {
  renderLabelSummary($('#methodsTable'), 'method', 'payment-methods', searchedItems('methods', state.snapshot.paymentMethods), tx => [tx.paymentMethodId],
    { label: 'Payment Method', empty: searchEmpty('methods', 'payment method', 'No payment methods yet. Add one above.') });
}

function renderTagsTab() {
  renderLabelSummary($('#tagsTable'), 'tag', 'tags', searchedItems('tags', state.snapshot.tags), tagIdsOf,
    { label: 'Tag', empty: searchEmpty('tags', 'tag', 'No tags yet. Add one above, then choose it on purchases in the editor.') });
}

function renderCollectionsTab() {
  renderLabelSummary($('#collectionsTable'), 'collection', 'collections', searchedItems('collections', state.snapshot.collections), collectionIdsOf,
    { label: 'Collection', empty: searchEmpty('collections', 'collection', 'No collections yet. Add one above, then choose it on purchases in the editor.'), stats: true });
}

function renderMerchantsTab() {
  renderLabelSummary($('#merchantsTable'), 'merchant', 'merchants', searchedItems('merchants', state.snapshot.merchants), merchantIdsOf, {
    label: 'Merchant',
    actionsInDialog: true,
    empty: searchEmpty('merchants', 'merchant', 'No merchants yet. Add one above, then choose it in the editor.')
  });
}

function showCollectionStats(collection) {
  state.statsPeriod = [`c:${collection.id}`];
  switchTab('stats');
}
