/*
 * Numbered lists: every entry in one scope (a person, tag, collection, merchant, or payment method) with its number there, such as Alex #1, #2,
 * #3. Opened from rows on the People, Payment Methods, Tags, Collections, and Merchants tabs and from the numbers at the
 * top of the transaction editor.
 */
import { $, SCOPE_NAMES, collectionIdsOf, describeTransaction, formatDate, formatMonth, monthOf, numberIn, plural, shareOf, state, tagIdsOf, whoLabel } from './app.js';
import { moneyCell, renderTable } from './widgets.js';
import { KIND_LABELS, openTransactionEditor } from './transactions.js';
import { merchantIdsOf, showCollectionStats } from './summaries.js';
import { manageButtons } from './manage.js';

const SCOPE_TITLES = { person: 'Person', tag: 'Tag', collection: 'Collection', merchant: 'Merchant', method: 'Payment method' };
// The lists whose dialog holds the item's Rename, Archive, and Delete buttons: [API path, model map, the item's IDs on an entry].
const MANAGED_SCOPES = {
  method: ['payment-methods', 'methods', tx => [tx.paymentMethodId]],
  tag: ['tags', 'tags', tagIdsOf],
  collection: ['collections', 'collections', collectionIdsOf],
  merchant: ['merchants', 'merchants', merchantIdsOf]
};
let scopeListTarget = null;

/** With month ("YYYY-MM"), only that month's entries are listed (Stats > Heatmaps > Tags × Month). */
export function openScopeList(scope, scopeId, { month = null } = {}) {
  scopeListTarget = { scope, scopeId, month };
  renderScopeList();
  $('#scopeDialog').showModal();
}

export function renderScopeList() {
  if (!scopeListTarget) return;
  const { scope, scopeId, month } = scopeListTarget;
  // A payment method's, tag's, collection's, or merchant's dialog holds its Rename, Archive, and Delete buttons (and a
  // collection's Stats); deleting it closes the dialog.
  const managed = MANAGED_SCOPES[scope];
  const item = managed ? state.model[managed[1]].get(scopeId) : null;
  if (managed && !item) {
    scopeListTarget = null;
    $('#scopeDialog').close();
    return;
  }
  const leading = scope === 'collection' ? [['Stats', () => {
    $('#scopeDialog').close();
    showCollectionStats(item);
  }, `Show stats for ${item.name}`]] : [];
  $('#scopeActions').replaceChildren(...(item
    ? [manageButtons(managed[0], item, state.model.transactions.filter(tx => managed[2](tx).includes(scopeId)).length, leading)]
    : []));
  const entries = state.model.transactions
    .filter(tx => !month || monthOf(tx.date) === month)
    .map(tx => ({ tx, number: numberIn(tx, scope, scopeId) }))
    .filter(entry => entry.number != null)
    .sort((a, b) => b.number - a.number);
  const name = SCOPE_NAMES[scope](scopeId);
  $('#scopeDialogTitle').textContent = `${SCOPE_TITLES[scope]}: ${name}${month ? ` · ${formatMonth(month)}` : ''}`;
  const archived = entries.filter(entry => entry.tx.archived).length;
  $('#scopeSummary').textContent = entries.length === 0
    ? ''
    : `${plural(entries.length, 'entry', 'entries')}${archived ? `, ${archived} archived` : ''}. Numbers count up as entries join ${name} and are never reused, so gaps mean an entry was deleted or left.`;

  const rows = entries.map(({ tx, number }) => {
    const direction = tx.kind === 'Purchase' ? 'out' : tx.kind === 'Refund' ? 'refund' : 'in';
    // For a person, a split purchase counts only their share.
    const amount = scope === 'person' && tx.kind === 'Purchase' ? shareOf(tx, scopeId) : tx.amountCents;
    const what = [describeTransaction(tx) || '(no description)', tx.archived ? '(archived)' : ''].filter(Boolean).join(' ');
    return {
      className: tx.archived ? 'archived-row' : '',
      onClick: () => {
        $('#scopeDialog').close();
        openTransactionEditor(tx);
      },
      cells: [`#${number}`, `#${tx.id}`, formatDate(tx.date), KIND_LABELS[tx.kind], what, whoLabel(tx), moneyCell(amount, { direction })]
    };
  });
  renderTable($('#scopeTable'), [
    { label: 'No.', title: `Number within ${name}.` },
    { label: 'ID', title: 'Permanent ID of the entry.' },
    { label: 'When' },
    { label: 'Type' },
    { label: 'What' },
    { label: 'For Who' },
    { label: 'Amount', num: true, title: scope === 'person' ? "For a split purchase, this person's share." : '' }
  ], rows, { empty: `No entries in ${name} yet.` });
}
