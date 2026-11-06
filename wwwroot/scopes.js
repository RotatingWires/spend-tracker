'use strict';

/*
 * Numbered lists: every entry in one scope (a person, tag, event, merchant, or payment method) with its number there, such as Alex #1, #2,
 * #3. Opened from rows on the People, Payment Methods, Tags, Events, and Merchants tabs and from the numbers at the
 * top of the transaction editor.
 */

const SCOPE_TITLES = { person: 'Person', tag: 'Tag', event: 'Event', merchant: 'Merchant', method: 'Payment method' };
let scopeListTarget = null;

function openScopeList(scope, scopeId) {
  scopeListTarget = { scope, scopeId };
  renderScopeList();
  $('#scopeDialog').showModal();
}

function renderScopeList() {
  if (!scopeListTarget) return;
  const { scope, scopeId } = scopeListTarget;
  const entries = state.model.transactions
    .map(tx => ({ tx, number: numberIn(tx, scope, scopeId) }))
    .filter(entry => entry.number != null)
    .sort((a, b) => b.number - a.number);
  const name = SCOPE_NAMES[scope](scopeId);
  $('#scopeDialogTitle').textContent = `${SCOPE_TITLES[scope]}: ${name}`;
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
