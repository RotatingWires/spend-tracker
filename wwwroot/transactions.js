'use strict';

/* Transactions tab (the monthly ledger) and the shared transaction editor dialog. */

const KIND_LABELS = { Purchase: 'Purchase', Refund: 'Refund', Payback: 'Payback' };

function monthTotals(transactions) {
  const totals = { spent: 0, refunded: 0, paidBack: 0, purchases: 0 };
  for (const tx of transactions) {
    if (tx.kind === 'Purchase') {
      totals.spent += tx.amountCents;
      totals.purchases++;
    } else if (tx.kind === 'Refund') {
      totals.refunded += tx.amountCents;
    } else {
      totals.paidBack += tx.amountCents;
    }
  }
  totals.net = totals.spent - totals.refunded;
  return totals;
}

function renderTransactions() {
  const monthRows = transactionsInRange(monthStart(state.month), monthEnd(state.month));
  const totals = monthTotals(monthRows);
  $('#monthCards').replaceChildren(
    statCard('Spent', formatMoney(totals.spent), { sub: plural(totals.purchases, 'purchase'), title: 'Total of every purchase dated in this month.' }),
    statCard('Refunds', formatMoney(totals.refunded), { title: 'Total of every refund dated in this month.' }),
    statCard('Net spent', formatMoney(totals.net), { title: 'Spent minus refunds.' }),
    statCard('Paid back to you', formatMoney(totals.paidBack), { title: 'Paybacks from other people dated in this month. These do not change net spent.' }),
    statCard('Entries', numberFormat.format(monthRows.length))
  );

  const rows = monthRows.filter(tx => matchesSearch(tx, state.search));
  const usedMethodIds = new Set(rows.map(tx => tx.paymentMethodId));
  const methods = state.snapshot.paymentMethods.filter(method => !method.archived || usedMethodIds.has(method.id));

  const columns = [
    { label: 'When' },
    { label: 'For Who' },
    { label: 'What' },
    { label: 'Tags' },
    ...methods.map(method => ({ label: method.name, num: true }))
  ];

  const tableRows = rows.map(tx => {
    const what = document.createElement('span');
    if (tx.kind !== 'Purchase') {
      const badge = document.createElement('span');
      badge.className = 'kind-badge money-in';
      badge.textContent = `${KIND_LABELS[tx.kind]}:`;
      what.append(badge);
    }
    what.append(describeTransaction(tx) || '(no description)');
    if (tx.note) {
      const note = document.createElement('span');
      note.className = 'cell-sub';
      note.textContent = tx.note;
      what.append(note);
    }
    const direction = tx.kind === 'Purchase' ? 'out' : tx.kind === 'Refund' ? 'refund' : 'in';
    return {
      onClick: () => openTransactionEditor(tx),
      cells: [
        formatDate(tx.date),
        whoLabel(tx),
        what,
        tagIdsOf(tx).map(tagName).join(', '),
        ...methods.map(method => method.id === tx.paymentMethodId ? moneyCell(tx.amountCents, { direction }) : { text: '', num: true })
      ]
    };
  });

  const footer = rows.length === 0 ? null : {
    cells: [
      '',
      '',
      { text: 'Net spent (purchases − refunds)', title: 'Paybacks are listed in the table but not included in these totals.' },
      '',
      ...methods.map(method => {
        const net = rows
          .filter(tx => tx.paymentMethodId === method.id && tx.kind !== 'Payback')
          .reduce((sum, tx) => sum + (tx.kind === 'Purchase' ? tx.amountCents : -tx.amountCents), 0);
        return { text: formatMoney(net), num: true };
      })
    ]
  };

  const empty = monthRows.length === 0
    ? `No entries in ${formatMonth(state.month)}. Use New Transaction to add one.`
    : 'No entries match the search.';
  renderTable($('#transactionsTable'), columns, tableRows, { empty, footer });
}

function exportTransactionsCsv() {
  const header = ['Date', 'Type', 'For Who', 'Merchant', 'Description', 'Tags', 'Payment Method', 'Amount', 'Linked To', 'Note'];
  const lines = [header];
  for (const tx of state.model.transactions) {
    const forWho = tx.kind === 'Purchase' && tx.shares.length > 1
      ? tx.shares.map(share => `${personName(share.personId)} ${centsToInput(share.amountCents)}`).join('; ')
      : whoLabel(tx);
    lines.push([
      tx.date,
      tx.kind,
      forWho,
      tx.merchant,
      tx.description,
      tagIdsOf(tx).map(tagName).join('; '),
      methodName(tx.paymentMethodId),
      centsToInput(tx.amountCents),
      tx.linkedId == null ? '' : `#${tx.linkedId}`,
      tx.note
    ]);
  }
  const csv = lines.map(line => line.map(csvField).join(',')).join('\r\n');
  downloadFile(`spend-tracker-transactions-${todayKey()}.csv`, 'text/csv', csv);
}

function csvField(value) {
  const text = String(value ?? '');
  // A leading =, +, -, or @ would be run as a formula by spreadsheet apps.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function downloadFile(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- editor dialog

const KIND_OPTIONS = [
  { value: 'Purchase', label: 'Purchase' },
  { value: 'Refund', label: 'Refund / return' },
  { value: 'Payback', label: 'Payback to me' }
];

const editor = {
  transaction: null,
  kind: null,
  method: null,
  people: null,
  person: null,
  linked: null,
  tags: null,
  shareInputs: new Map()
};

function initializeTransactionEditor() {
  editor.kind = createSingleSelect($('#txKind'), { onChange: () => applyEditorKind() });
  editor.kind.setOptions(KIND_OPTIONS, 'Purchase');
  editor.method = createSingleSelect($('#txMethod'));
  editor.people = createMultiSelect($('#txPeople'), { empty: 'Choose people', onChange: () => renderShareRows() });
  editor.person = createSingleSelect($('#txPerson'), { onChange: () => onEditorPersonChange() });
  editor.linked = createSingleSelect($('#txLinked'), { onChange: () => onLinkedPurchaseChange() });
  editor.tags = createMultiSelect($('#txTags'), { empty: 'No tags' });

  $('#transactionForm').addEventListener('submit', event => {
    event.preventDefault();
    saveTransaction();
  });
  $('#txCancelButton').addEventListener('click', () => $('#transactionDialog').close());
  $('#txDeleteButton').addEventListener('click', () => deleteTransaction());
  $('#txAmount').addEventListener('input', () => updateShareTotal());
}

function editorKind() {
  return editor.kind.value;
}

function openTransactionEditor(tx = null, defaults = {}) {
  editor.transaction = tx;
  editor.kind.value = tx?.kind ?? defaults.kind ?? 'Purchase';
  $('#transactionDialogTitle').textContent = tx ? `Edit ${KIND_LABELS[tx.kind]} #${tx.id}` : 'New Transaction';
  $('#txDate').value = tx?.date ?? defaults.date ?? todayKey();
  $('#txAmount').value = tx ? centsToInput(tx.amountCents) : '';
  $('#txMerchant').value = tx?.merchant ?? '';
  $('#txDescription').value = tx?.description ?? '';
  $('#txNote').value = tx?.note ?? '';
  $('#txError').textContent = '';
  $('#txDeleteButton').hidden = !tx;

  // New entries start on the method of the latest purchase; the user sees and can change it before saving.
  const lastPurchase = state.model.transactions.findLast(entry => entry.kind === 'Purchase');
  editor.method.setOptions(methodOptions(tx?.paymentMethodId), tx?.paymentMethodId ?? lastPurchase?.paymentMethodId);
  editor.tags.setOptions(tagOptions(tx?.tagIds ?? []), tx?.tagIds ?? []);
  editor.shareInputs = new Map((tx?.shares ?? []).map(share => [String(share.personId), centsToInput(share.amountCents)]));
  editor.people.setOptions(peopleOptions(tx), tx?.shares?.length ? tx.shares.map(share => share.personId) : [state.model.self.id]);
  editor.person.setOptions([], null);
  editor.linked.setOptions([], null);
  applyEditorKind({ personId: tx?.personId ?? defaults.personId, linkedId: tx?.linkedId ?? defaults.linkedId });
  renderMerchantSuggestions();

  $('#transactionDialog').showModal();
  $('#txAmount').focus();
}

function showEditorRow(id, visible) {
  $(`#${id}Label`).hidden = !visible;
  $(`#${id}`).hidden = !visible;
}

function applyEditorKind(preferred = {}) {
  const kind = editorKind();
  const isPurchase = kind === 'Purchase';
  const isRefund = kind === 'Refund';

  $('#txPeopleLabel').hidden = !isPurchase;
  $('#txPeopleRow').hidden = !isPurchase;
  $('#txLinkedLabel').textContent = isRefund ? 'Refund of' : 'For purchase';
  $('#txLinkedLabel').hidden = isPurchase;
  $('#txLinkedRow').hidden = isPurchase;
  $('#txMethodLabel').textContent = isPurchase ? 'Paid with' : isRefund ? 'Refunded to' : 'Received as';
  showEditorRow('txTags', isPurchase);

  if (isPurchase) {
    showEditorRow('txPerson', false);
    renderShareRows();
  } else if (isRefund) {
    refreshLinkedOptions(preferred.linkedId ?? null, preferred.personId ?? null);
  } else {
    $('#txPersonLabel').textContent = 'Paid back by';
    showEditorRow('txPerson', true);
    const current = preferred.personId ?? (editor.person.value ? Number(editor.person.value) : null);
    editor.person.setOptions(payerOptions(current), current);
    refreshLinkedOptions(preferred.linkedId ?? null);
  }
}

function methodOptions(currentId) {
  return state.snapshot.paymentMethods
    .filter(method => !method.archived || method.id === currentId)
    .map(method => ({ value: method.id, label: method.archived ? `${method.name} (archived)` : method.name }));
}

/** Archived choices are offered only when the transaction already uses them. */
function archivedLabel(item) {
  return item.archived ? `${item.name} (archived)` : item.name;
}

function tagOptions(currentIds) {
  return state.snapshot.tags
    .filter(tag => !tag.archived || currentIds.includes(tag.id))
    .map(tag => ({ value: tag.id, label: archivedLabel(tag) }));
}

function peopleOptions(tx) {
  const current = (tx?.shares ?? []).map(share => share.personId);
  return state.snapshot.people
    .filter(person => !person.archived || current.includes(person.id))
    .map(person => ({ value: person.id, label: archivedLabel(person) }));
}

function payerOptions(currentId) {
  return state.snapshot.people
    .filter(person => !person.isSelf && (!person.archived || person.id === currentId))
    .map(person => ({ value: person.id, label: archivedLabel(person) }));
}

// ---- who a purchase was for

function selectedPeople() {
  return editor.people.values.map(Number);
}

/** One person takes the whole amount; several people each get an amount box that must add up to the total. */
function renderShareRows() {
  const container = $('#txShares');
  for (const input of container.querySelectorAll('input[data-person]')) editor.shareInputs.set(input.dataset.person, input.value);
  const people = selectedPeople();
  container.replaceChildren();
  container.hidden = people.length < 2;
  if (people.length < 2) return;

  for (const personId of people) {
    const name = document.createElement('label');
    name.className = 'share-name';
    name.htmlFor = `txShare${personId}`;
    name.textContent = personName(personId);
    const input = document.createElement('input');
    input.id = `txShare${personId}`;
    input.className = 'retro-input';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.placeholder = '0.00';
    input.dataset.person = String(personId);
    input.value = editor.shareInputs.get(String(personId)) ?? '';
    input.addEventListener('input', () => updateShareTotal());
    container.append(name, input);
  }

  const footer = document.createElement('div');
  footer.className = 'share-footer';
  const split = document.createElement('button');
  split.type = 'button';
  split.textContent = 'Split Evenly';
  split.addEventListener('click', () => splitEvenly());
  const total = document.createElement('span');
  total.id = 'txShareTotal';
  total.className = 'form-hint';
  footer.append(split, total);
  container.append(footer);
  updateShareTotal();
}

function shareInputs() {
  return [...$('#txShares').querySelectorAll('input[data-person]')];
}

function updateShareTotal() {
  const total = $('#txShareTotal');
  if (!total) return;
  const assigned = shareInputs().reduce((sum, input) => sum + (parseMoney(input.value) ?? 0), 0);
  const amount = parseMoney($('#txAmount').value);
  total.textContent = amount == null
    ? `Assigned ${formatMoney(assigned)}`
    : `Assigned ${formatMoney(assigned)} of ${formatMoney(amount)}${assigned === amount ? '' : ` (${formatMoney(Math.abs(amount - assigned))} ${assigned < amount ? 'left' : 'over'})`}`;
}

/** Divides the amount into equal cents; the first people listed get any leftover cent. */
function splitEvenly() {
  const amount = parseMoney($('#txAmount').value);
  if (amount == null) {
    $('#txError').textContent = 'Enter the amount first, then split it.';
    $('#txAmount').focus();
    return;
  }
  const inputs = shareInputs();
  const base = Math.floor(amount / inputs.length);
  let leftover = amount - base * inputs.length;
  for (const input of inputs) {
    input.value = centsToInput(base + (leftover > 0 ? 1 : 0));
    leftover--;
  }
  $('#txError').textContent = '';
  updateShareTotal();
}

function collectShares(amountCents) {
  const people = selectedPeople();
  if (people.length === 0) throw new Error('Choose who this purchase was for.');
  if (people.length === 1) return [{ personId: people[0], amountCents }];
  return shareInputs().map(input => {
    const cents = parseMoney(input.value);
    if (cents == null) throw new Error(`Enter ${personName(Number(input.dataset.person))}'s share, or use Split Evenly.`);
    return { personId: Number(input.dataset.person), amountCents: cents };
  });
}

// ---- refunds and paybacks

function purchaseLabel(purchase) {
  const forWho = othersShare(purchase) > 0 ? ` · for ${whoLabel(purchase)}` : '';
  return `${formatDate(purchase.date)} · ${describeTransaction(purchase) || '(no description)'} · ${formatMoney(purchase.amountCents)}${forWho}`;
}

function refreshLinkedOptions(preferredId = null, preferredPersonId = null) {
  const kind = editorKind();
  const selfId = editor.transaction?.id ?? null;
  const payer = editor.person.value ? Number(editor.person.value) : null;
  const wanted = preferredId ?? (editor.linked.value ? Number(editor.linked.value) : null);
  const candidates = state.model.transactions
    .filter(tx => tx.kind === 'Purchase')
    .filter(tx => kind === 'Refund'
      ? purchaseRemaining(tx, selfId) > 0 || tx.id === wanted
      : shareOf(tx, payer) > 0 && (shareRemaining(tx, payer, selfId) > 0 || tx.id === wanted))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .map(tx => ({ value: tx.id, label: purchaseLabel(tx) }));

  const options = kind === 'Payback' ? [{ value: '', label: 'Not linked to a purchase' }, ...candidates] : candidates;
  if (kind === 'Refund' && candidates.length === 0) options.push({ value: '', label: 'No purchases left to refund' });
  editor.linked.setOptions(options, wanted ?? '');
  if (kind === 'Refund') refreshRefundPerson(preferredPersonId);
  updateLinkedHint();
  prefillFromLinkedPurchase();
}

/** A refund is for one person's share; the choice only appears when the purchase was split. */
function refreshRefundPerson(preferredPersonId = null) {
  const purchase = linkedPurchase();
  const selfId = editor.transaction?.id ?? null;
  const wanted = preferredPersonId ?? (editor.person.value ? Number(editor.person.value) : null);
  const options = (purchase?.shares ?? [])
    .filter(share => shareRemaining(purchase, share.personId, selfId) > 0 || share.personId === wanted)
    .map(share => ({ value: share.personId, label: `${personName(share.personId)} (${formatMoney(share.amountCents)})` }));
  editor.person.setOptions(options, wanted);
  $('#txPersonLabel').textContent = 'Whose share';
  showEditorRow('txPerson', (purchase?.shares.length ?? 0) > 1);
}

function onEditorPersonChange() {
  if (editorKind() === 'Payback') refreshLinkedOptions();
  else updateLinkedHint();
}

function linkedPurchase() {
  const id = editor.linked.value ? Number(editor.linked.value) : null;
  return id == null ? null : state.model.byId.get(id) ?? null;
}

function updateLinkedHint() {
  const purchase = linkedPurchase();
  const kind = editorKind();
  const hint = $('#txLinkedHint');
  const personId = editor.person.value ? Number(editor.person.value) : null;
  if (!purchase || personId == null) {
    hint.textContent = kind === 'Payback' ? 'Unlinked paybacks still reduce what this person owes overall.' : '';
    return;
  }
  const remaining = shareRemaining(purchase, personId, editor.transaction?.id ?? null);
  const whose = purchase.shares.length > 1 ? `${personName(personId)}'s share` : 'this purchase';
  hint.textContent = kind === 'Refund'
    ? `Up to ${formatMoney(remaining)} of ${whose} can still be refunded. Refunds use the purchase's tags.`
    : `${formatMoney(remaining)} of ${whose} is still unpaid.`;
}

function onLinkedPurchaseChange() {
  if (editorKind() === 'Refund') refreshRefundPerson();
  updateLinkedHint();
  prefillFromLinkedPurchase();
}

/**
 * Fills empty fields of a new refund or payback from the chosen purchase, whether the user picked it or it was the
 * only choice. Only copies values the user already entered on that purchase.
 */
function prefillFromLinkedPurchase() {
  const purchase = linkedPurchase();
  const personId = editor.person.value ? Number(editor.person.value) : null;
  if (!purchase || editor.transaction) return;
  if (!$('#txAmount').value.trim() && personId != null) $('#txAmount').value = centsToInput(shareRemaining(purchase, personId));
  if (editorKind() === 'Refund') {
    if (!$('#txMerchant').value.trim() && !$('#txDescription').value.trim()) {
      $('#txMerchant').value = purchase.merchant;
      $('#txDescription').value = purchase.description;
    }
    editor.method.setOptions(methodOptions(purchase.paymentMethodId), purchase.paymentMethodId);
  }
}

function renderMerchantSuggestions() {
  const counts = new Map();
  for (const tx of state.model.transactions) {
    const name = tx.merchant.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = counts.get(key) ?? { name, count: 0 };
    entry.name = name; // Transactions are date-ordered, so the latest spelling wins.
    entry.count++;
    counts.set(key, entry);
  }
  const options = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map(entry => {
      const option = document.createElement('option');
      option.value = entry.name;
      return option;
    });
  $('#merchantList').replaceChildren(...options);
}

async function saveTransaction() {
  const kind = editorKind();
  const error = $('#txError');
  error.textContent = '';
  const amountCents = parseMoney($('#txAmount').value);
  if (amountCents == null) {
    error.textContent = 'Enter an amount greater than zero, like 12.34.';
    $('#txAmount').focus();
    return;
  }

  let shares = [];
  try {
    if (kind === 'Purchase') shares = collectShares(amountCents);
  } catch (shareError) {
    error.textContent = shareError.message;
    return;
  }

  const body = {
    kind,
    date: $('#txDate').value,
    amountCents,
    paymentMethodId: editor.method.value ? Number(editor.method.value) : null,
    personId: kind === 'Purchase' || !editor.person.value ? null : Number(editor.person.value),
    linkedId: kind === 'Purchase' || !editor.linked.value ? null : Number(editor.linked.value),
    merchant: $('#txMerchant').value,
    description: $('#txDescription').value,
    note: $('#txNote').value,
    tagIds: kind === 'Purchase' ? editor.tags.values.map(Number) : [],
    shares
  };

  $('#txSaveButton').disabled = true;
  try {
    const existing = editor.transaction;
    const saved = existing
      ? await api(`/transactions/${existing.id}`, { method: 'PUT', body })
      : await api('/transactions', { method: 'POST', body });
    $('#transactionDialog').close();
    await loadSnapshot();
    setStatus(`${existing ? 'Saved' : 'Added'} ${KIND_LABELS[saved.kind].toLowerCase()} ${formatMoney(saved.amountCents)} on ${formatDate(saved.date)}.`);
  } catch (saveError) {
    error.textContent = saveError.message;
  } finally {
    $('#txSaveButton').disabled = false;
  }
}

async function deleteTransaction() {
  const tx = editor.transaction;
  if (!tx) return;
  const confirmed = await confirmAction('Delete Transaction',
    `Delete this ${KIND_LABELS[tx.kind].toLowerCase()} of ${formatMoney(tx.amountCents)} on ${formatDate(tx.date)}? The History tab keeps a record of it.`, 'Delete');
  if (!confirmed) return;
  try {
    await api(`/transactions/${tx.id}`, { method: 'DELETE' });
    $('#transactionDialog').close();
    await loadSnapshot();
    setStatus(`Deleted ${KIND_LABELS[tx.kind].toLowerCase()} ${formatMoney(tx.amountCents)}.`);
  } catch (error) {
    $('#txError').textContent = error.message;
  }
}
