'use strict';

/* People tab: what each other person owes you, and their purchase/payback detail. */

let personDialogId = null;

function personLedger(personId) {
  const ledger = { fronted: 0, refunded: 0, paidBack: 0, purchases: 0, lastPayback: null, entries: [] };
  for (const tx of state.model.transactions) {
    if (personIdOf(tx) !== personId) continue;
    ledger.entries.push(tx);
    if (tx.kind === 'Purchase') {
      ledger.fronted += tx.amountCents;
      ledger.purchases++;
    } else if (tx.kind === 'Refund') {
      ledger.refunded += tx.amountCents;
    } else {
      ledger.paidBack += tx.amountCents;
      ledger.lastPayback = tx.date;
    }
  }
  ledger.outstanding = ledger.fronted - ledger.refunded - ledger.paidBack;
  return ledger;
}

function outstandingText(cents) {
  if (cents > 0) return `${formatMoney(cents)} owed to you`;
  if (cents < 0) return `${formatMoney(-cents)} overpaid`;
  return 'Settled';
}

function renderPeople() {
  const others = state.snapshot.people.filter(person => !person.isSelf);
  const rows = others
    .map(person => ({ person, ledger: personLedger(person.id) }))
    .filter(({ person, ledger }) => !person.archived || ledger.entries.length > 0)
    .sort((a, b) => b.ledger.outstanding - a.ledger.outstanding || a.person.name.localeCompare(b.person.name))
    .map(({ person, ledger }) => ({
      onClick: () => openPersonDialog(person.id),
      cells: [
        person.archived ? `${person.name} (archived)` : person.name,
        numberFormat.format(ledger.purchases),
        formatMoney(ledger.fronted),
        formatMoney(ledger.refunded),
        formatMoney(ledger.paidBack),
        { text: outstandingText(ledger.outstanding), num: true, className: ledger.outstanding > 0 ? '' : 'money-in' },
        ledger.lastPayback ? formatDate(ledger.lastPayback) : '—'
      ]
    }));

  renderTable($('#peopleTable'), [
    { label: 'Person' },
    { label: 'Purchases', num: true },
    { label: 'Bought for Them', num: true },
    { label: 'Refunded', num: true, title: 'Refunds on purchases made for this person.' },
    { label: 'Paid Back', num: true },
    { label: 'Balance', num: true, title: 'Bought for them, minus refunds on those purchases, minus everything they paid back.' },
    { label: 'Last Payback' }
  ], rows, { empty: 'No other people yet. Add people under Manage, then choose them as For Who on a purchase.' });
}

function openPersonDialog(personId) {
  personDialogId = personId;
  renderPersonDialog();
  $('#personDialog').showModal();
}

function renderPersonDialog() {
  const personId = personDialogId;
  if (personId == null || !state.model.people.has(personId)) return;
  const ledger = personLedger(personId);
  $('#personDialogTitle').textContent = personName(personId);
  renderMetrics($('#personSummary'), [
    ['Bought for them', formatMoney(ledger.fronted)],
    ['Refunded', formatMoney(ledger.refunded)],
    ['Paid back', formatMoney(ledger.paidBack)],
    ['Balance', outstandingText(ledger.outstanding)]
  ]);

  const rows = [...ledger.entries].reverse().map(tx => {
    let status = '';
    if (tx.kind === 'Purchase') {
      const remaining = purchaseRemaining(tx);
      status = remaining > 0 ? `${formatMoney(remaining)} unpaid` : 'Covered';
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
      cells: [formatDate(tx.date), `#${tx.id} ${KIND_LABELS[tx.kind]}`, describeTransaction(tx) || '(no description)', moneyCell(tx.amountCents, { direction }), status]
    };
  });
  renderTable($('#personTable'), [{ label: 'When' }, { label: 'Entry' }, { label: 'What' }, { label: 'Amount', num: true }, { label: 'Status', title: 'Unpaid amounts count refunds and paybacks linked to that purchase. Unlinked paybacks reduce the overall balance only.' }], rows, { empty: 'No purchases or paybacks for this person yet.' });
  $('#personPaybackButton').disabled = state.model.people.get(personId).archived;
}

function initializePeople() {
  $('#personPaybackButton').addEventListener('click', () => {
    const personId = personDialogId;
    $('#personDialog').close();
    openTransactionEditor(null, { kind: 'Payback', personId });
  });
}
