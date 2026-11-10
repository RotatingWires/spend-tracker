/* People tab: what each other person owes you, and their purchase/payback detail. */
import { $, compareNames, describeTransaction, formatDate, formatMoney, isGiftShare, numberFormat, numberIn, peopleOf, personName, shareOf, shareRemaining, state, writeSetting } from './app.js';
import { moneyCell, renderMetrics, renderTable } from './widgets.js';
import { KIND_LABELS, archivedLabel, openTransactionEditor } from './transactions.js';
import { searchEmpty, searchedItems } from './summaries.js';
import { manageButtons } from './manage.js';
import { renderAll } from './ui.js';

let personDialogId = null;

/**
 * A person's balance: their shares of purchases, minus refunds on their shares, minus what they paid back. Gift
 * shares, and refunds on them, are left out unless People > Include gifts is checked.
 */
export function personLedger(personId, { through = null } = {}) {
  const ledger = { fronted: 0, gifted: 0, refunded: 0, giftRefunded: 0, paidBack: 0, purchases: 0, lastPayback: null, entries: [] };
  for (const tx of state.model.transactions) {
    // With through, the balance as it stood at the end of that day (Stats > People Over Time).
    if (through && tx.date > through) break;
    if (!peopleOf(tx).includes(personId)) continue;
    ledger.entries.push(tx);
    if (tx.kind === 'Purchase') {
      ledger.fronted += shareOf(tx, personId);
      if (isGiftShare(tx, personId)) ledger.gifted += shareOf(tx, personId);
      ledger.purchases++;
    } else if (tx.kind === 'Refund') {
      ledger.refunded += tx.amountCents;
      if (isGiftShare(state.model.byId.get(tx.linkedId), personId)) ledger.giftRefunded += tx.amountCents;
    } else {
      ledger.paidBack += tx.amountCents;
      ledger.lastPayback = tx.date;
    }
  }
  ledger.outstanding = state.includeGifts
    ? ledger.fronted - ledger.refunded - ledger.paidBack
    : (ledger.fronted - ledger.gifted) - (ledger.refunded - ledger.giftRefunded) - ledger.paidBack;
  return ledger;
}

export function outstandingText(cents) {
  if (cents > 0) return `${formatMoney(cents)} owed to you`;
  if (cents < 0) return `${formatMoney(-cents)} overpaid`;
  return 'Settled';
}

/** Everyone, you first: balances for other people. A row opens the person's dialog, which holds Rename/Archive/Delete. */
export function renderPeople() {
  const rows = searchedItems('people', state.snapshot.people)
    .map(person => ({ person, ledger: personLedger(person.id) }))
    // Me first, then A–Z, like the dropdowns; the Balance heading sorts by balance.
    .sort((a, b) => b.person.isSelf - a.person.isSelf || compareNames(a.person.name, b.person.name))
    .map(({ person, ledger }) => ({
      onClick: () => openPersonDialog(person.id),
      cells: [
        `#${person.id}`,
        person.isSelf ? `${person.name} (you)` : archivedLabel(person),
        numberFormat.format(ledger.purchases),
        formatMoney(ledger.fronted),
        formatMoney(ledger.gifted),
        formatMoney(ledger.refunded),
        formatMoney(ledger.paidBack),
        person.isSelf ? { text: '—', num: true } : { text: outstandingText(ledger.outstanding), sort: ledger.outstanding, num: true, className: ledger.outstanding > 0 ? '' : 'money-in' },
        ledger.lastPayback ? formatDate(ledger.lastPayback) : '—'
      ]
    }));

  renderTable($('#peopleTable'), [
    { label: 'ID', title: 'Permanent ID, never reused.' },
    { label: 'Person' },
    { label: 'Purchases', num: true },
    { label: 'Their Shares', num: true, title: 'Their shares of purchases, gifts included. For you, your own shares.' },
    { label: 'Gifts', num: true, title: 'Shares marked as gifts: not owed back.' },
    { label: 'Refunded', num: true, title: 'Refunds on purchases made for this person.' },
    { label: 'Paid Back', num: true },
    { label: 'Balance', num: true, title: 'Their shares, minus refunds on those purchases, minus everything they paid back. Gifts and refunds on them are left out unless Include gifts is checked.' },
    { label: 'Last Payback' }
  ], rows, { empty: searchEmpty('people', 'person', 'No people yet.') });
}

export function openPersonDialog(personId) {
  personDialogId = personId;
  renderPersonDialog();
  $('#personDialog').showModal();
}

export function renderPersonDialog() {
  const personId = personDialogId;
  // Deleting the person from their own dialog closes it.
  if (personId == null || !state.model.people.has(personId)) {
    personDialogId = null;
    $('#personDialog').close();
    return;
  }
  const ledger = personLedger(personId);
  $('#personActions').replaceChildren(manageButtons('people', state.model.people.get(personId), ledger.entries.length));
  $('#personDialogTitle').textContent = personName(personId);
  renderMetrics($('#personSummary'), [
    ['Their shares', formatMoney(ledger.fronted)],
    ['Gifts', formatMoney(ledger.gifted)],
    ['Refunded', formatMoney(ledger.refunded)],
    ['Paid back', formatMoney(ledger.paidBack)],
    ['Balance', outstandingText(ledger.outstanding)]
  ]);

  const rows = [...ledger.entries].reverse().map(tx => {
    let status = '';
    let amount = tx.amountCents;
    if (tx.kind === 'Purchase') {
      amount = shareOf(tx, personId);
      const remaining = shareRemaining(tx, personId);
      status = isGiftShare(tx, personId) ? 'Gift' : remaining > 0 ? `${formatMoney(remaining)} unpaid` : 'Covered';
      if (tx.shares.length > 1) status += ` · share of ${formatMoney(tx.amountCents)}`;
    } else if (tx.kind === 'Payback') {
      status = tx.linkedId == null ? 'Not linked' : `For #${tx.linkedId}`;
    } else {
      status = `Refund of #${tx.linkedId}`;
    }
    const direction = tx.kind === 'Purchase' ? 'out' : tx.kind === 'Refund' ? 'refund' : 'in';
    return {
      onClick: () => {
        $('#personDialog').close();
        openTransactionEditor(tx);
      },
      cells: [formatDate(tx.date), `#${numberIn(tx, 'person', personId)}`, `#${tx.id} ${KIND_LABELS[tx.kind]}`, describeTransaction(tx) || '(no description)', moneyCell(amount, { direction }), status]
    };
  });
  renderTable($('#personTable'), [{ label: 'When' }, { label: 'No.', title: 'This person\'s own numbering: their 1st, 2nd, 3rd entry, and so on. Numbers are never reused.' }, { label: 'Entry' }, { label: 'What' }, { label: 'Amount', num: true }, { label: 'Status', title: 'For a purchase, Amount is this person\'s share. Unpaid amounts count refunds and paybacks linked to their share. Unlinked paybacks reduce the overall balance only.' }], rows, { empty: 'No purchases or paybacks for this person yet.' });
  $('#personPaybackButton').disabled = state.model.people.get(personId).archived;
}

export function initializePeople() {
  $('#includeGifts').checked = state.includeGifts;
  $('#includeGifts').addEventListener('change', event => {
    state.includeGifts = event.target.checked;
    writeSetting('spend-tracker-include-gifts', String(state.includeGifts));
    renderAll();
  });
  $('#personPaybackButton').addEventListener('click', () => {
    const personId = personDialogId;
    $('#personDialog').close();
    openTransactionEditor(null, { kind: 'Payback', personId });
  });
}
