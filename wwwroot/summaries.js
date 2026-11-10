/*
 * Payment Methods, Tags, Collections, and Merchants tabs: totals per item from the purchases that have it and the refunds
 * on those purchases, with an Add form. Double-clicking a row lists that scope's entries in a dialog that also holds the
 * item's Rename/Archive/Delete buttons (scopes.js); a collection's has Stats too, to open it as a Stats period.
 */
import { $, collectionIdsOf, formatDateRange, formatMoney, numberFormat, state, tagIdsOf } from './app.js';
import { renderTable } from './widgets.js';
import { archivedLabel, monthTotals } from './transactions.js';
import { openScopeList } from './scopes.js';
import { switchTab } from './ui.js';

export function merchantIdsOf(tx) {
  const source = tx.kind === 'Refund' ? state.model.byId.get(tx.linkedId) ?? tx : tx;
  return source.merchantId == null ? [] : [source.merchantId];
}

function renderLabelSummary(table, scope, items, idsOf, { label, empty }) {
  const rows = items.map(item => {
    const entries = state.model.transactions.filter(tx => tx.kind !== 'Payback' && idsOf(tx).includes(item.id));
    const totals = monthTotals(entries);
    return {
      // Double-click (or Enter) opens it, like the ledger, so a stray click does not.
      onDoubleClick: () => openScopeList(scope, item.id),
      cells: [
        `#${item.id}`,
        archivedLabel(item),
        { text: numberFormat.format(totals.purchases), num: true },
        { text: formatMoney(totals.spent), num: true },
        { text: formatMoney(totals.refunded), num: true },
        { text: formatMoney(totals.net), num: true },
        entries.length ? formatDateRange(entries[0].date, entries.at(-1).date) : '—'
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
    { label: 'Dates', title: 'From the first to the last entry.' }
  ], rows, { empty });
}

/** The tab's search (applied with its Search button) narrows its list by name, ignoring case. */
export function searchedItems(tab, items) {
  const query = state.listQueries[tab].toLowerCase();
  return query ? items.filter(item => item.name.toLowerCase().includes(query)) : items;
}

/** The empty-table message: what the search missed, or how to add the first one. */
export function searchEmpty(tab, singular, emptyText) {
  return state.listQueries[tab] ? `No ${singular} matches "${state.listQueries[tab]}".` : emptyText;
}

export function renderMethodsTab() {
  renderLabelSummary($('#methodsTable'), 'method', searchedItems('methods', state.snapshot.paymentMethods), tx => [tx.paymentMethodId],
    { label: 'Payment Method', empty: searchEmpty('methods', 'payment method', 'No payment methods yet. Add one above.') });
}

export function renderTagsTab() {
  renderLabelSummary($('#tagsTable'), 'tag', searchedItems('tags', state.snapshot.tags), tagIdsOf,
    { label: 'Tag', empty: searchEmpty('tags', 'tag', 'No tags yet. Add one above, then choose it on purchases in the editor.') });
}

export function renderCollectionsTab() {
  renderLabelSummary($('#collectionsTable'), 'collection', searchedItems('collections', state.snapshot.collections), collectionIdsOf,
    { label: 'Collection', empty: searchEmpty('collections', 'collection', 'No collections yet. Add one above, then choose it on purchases in the editor.') });
}

export function renderMerchantsTab() {
  renderLabelSummary($('#merchantsTable'), 'merchant', searchedItems('merchants', state.snapshot.merchants), merchantIdsOf, {
    label: 'Merchant',
    empty: searchEmpty('merchants', 'merchant', 'No merchants yet. Add one above, then choose it in the editor.')
  });
}

export function showCollectionStats(collection) {
  state.statsPeriod = [`c:${collection.id}`];
  switchTab('stats');
}
