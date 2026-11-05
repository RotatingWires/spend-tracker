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
    const personId = personIdOf(tx);
    const who = tx.kind === 'Payback' ? `From ${personName(personId)}` : personId == null ? '' : personName(personId);
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
        who,
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
    const personId = personIdOf(tx);
    lines.push([
      tx.date,
      tx.kind,
      personId == null ? '' : personName(personId),
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

const editor = {
  transaction: null,
  selectedTags: new Set(),
  method: null,
  person: null,
  linked: null
};

function initializeTransactionEditor() {
  editor.method = createSingleSelect($('#txMethod'));
  editor.person = createSingleSelect($('#txPerson'), { onChange: () => refreshLinkedOptions() });
  editor.linked = createSingleSelect($('#txLinked'), { onChange: () => onLinkedPurchaseChange() });

  $$('input[name="txKind"]').forEach(radio => radio.addEventListener('change', () => applyEditorKind()));
  $('#transactionForm').addEventListener('submit', event => {
    event.preventDefault();
    saveTransaction();
  });
  $('#txCancelButton').addEventListener('click', () => $('#transactionDialog').close());
  $('#txDeleteButton').addEventListener('click', () => deleteTransaction());
  $('#txAddTagButton').addEventListener('click', () => addTagFromEditor());
  $('#txNewTag').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addTagFromEditor();
    }
  });
}

function editorKind() {
  return $('input[name="txKind"]:checked').value;
}

function openTransactionEditor(tx = null, defaults = {}) {
  editor.transaction = tx;
  const kind = tx?.kind ?? defaults.kind ?? 'Purchase';
  $$('input[name="txKind"]').forEach(radio => { radio.checked = radio.value === kind; });
  $('#transactionDialogTitle').textContent = tx ? `Edit ${KIND_LABELS[tx.kind]} #${tx.id}` : 'New Transaction';
  $('#txDate').value = tx?.date ?? defaults.date ?? todayKey();
  $('#txAmount').value = tx ? centsToInput(tx.amountCents) : '';
  $('#txMerchant').value = tx?.merchant ?? '';
  $('#txDescription').value = tx?.description ?? '';
  $('#txNote').value = tx?.note ?? '';
  $('#txNewTag').value = '';
  $('#txError').textContent = '';
  $('#txDeleteButton').hidden = !tx;
  editor.selectedTags = new Set(tx?.tagIds ?? []);

  // New entries start on the method of the latest purchase; the user sees and can change it before saving.
  const lastPurchase = state.model.transactions.findLast(entry => entry.kind === 'Purchase');
  const methodId = tx?.paymentMethodId ?? lastPurchase?.paymentMethodId;
  editor.method.setOptions(methodOptions(tx?.paymentMethodId), methodId);
  editor.person.setOptions([], null);
  editor.linked.setOptions([], null);
  applyEditorKind({ personId: tx?.personId ?? defaults.personId, linkedId: tx?.linkedId ?? defaults.linkedId });
  renderMerchantSuggestions();
  renderTagChoices();

  $('#transactionDialog').showModal();
  $('#txAmount').focus();
}

function applyEditorKind(preferred = {}) {
  const kind = editorKind();
  const isPurchase = kind === 'Purchase';
  const isRefund = kind === 'Refund';

  $('#txPersonLabel').textContent = kind === 'Payback' ? 'Paid back by' : 'For who';
  $('#txPersonLabel').hidden = isRefund;
  $('#txPerson').hidden = isRefund;
  $('#txLinkedLabel').textContent = isRefund ? 'Refund of' : 'For purchase';
  $('#txLinkedLabel').hidden = isPurchase;
  $('#txLinkedRow').hidden = isPurchase;
  $('#txMethodLabel').textContent = isPurchase ? 'Paid with' : isRefund ? 'Refunded to' : 'Received as';
  $('#txTagsLabel').hidden = !isPurchase;
  $('#txTags').parentElement.hidden = !isPurchase;

  const currentPerson = preferred.personId ?? (editor.person.value ? Number(editor.person.value) : null);
  editor.person.setOptions(personOptions(kind, currentPerson), currentPerson);
  refreshLinkedOptions(preferred.linkedId ?? (editor.linked.value ? Number(editor.linked.value) : null));
}

function methodOptions(currentId) {
  return state.snapshot.paymentMethods
    .filter(method => !method.archived || method.id === currentId)
    .map(method => ({ value: method.id, label: method.archived ? `${method.name} (archived)` : method.name }));
}

function personOptions(kind, currentId) {
  return state.snapshot.people
    .filter(person => (!person.archived || person.id === currentId) && (kind !== 'Payback' || !person.isSelf))
    .map(person => ({ value: person.id, label: person.archived ? `${person.name} (archived)` : person.name }));
}

function purchaseLabel(purchase) {
  const forWho = isForOthers(purchase) ? ` · for ${personName(purchase.personId)}` : '';
  return `${formatDate(purchase.date)} · ${describeTransaction(purchase) || '(no description)'} · ${formatMoney(purchase.amountCents)}${forWho}`;
}

function refreshLinkedOptions(preferredId = null) {
  const kind = editorKind();
  const selfId = editor.transaction?.id ?? null;
  const personId = editor.person.value ? Number(editor.person.value) : null;
  const candidates = state.model.transactions
    .filter(tx => tx.kind === 'Purchase')
    .filter(tx => kind === 'Refund' || tx.personId === personId)
    .filter(tx => purchaseRemaining(tx, selfId) > 0 || tx.id === preferredId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .map(tx => ({ value: tx.id, label: purchaseLabel(tx) }));

  const options = kind === 'Payback' ? [{ value: '', label: 'Not linked to a purchase' }, ...candidates] : candidates;
  if (kind === 'Refund' && candidates.length === 0) options.push({ value: '', label: 'No purchases left to refund' });
  editor.linked.setOptions(options, preferredId ?? '');
  updateLinkedHint();
}

function linkedPurchase() {
  const id = editor.linked.value ? Number(editor.linked.value) : null;
  return id == null ? null : state.model.byId.get(id) ?? null;
}

function updateLinkedHint() {
  const purchase = linkedPurchase();
  const kind = editorKind();
  const hint = $('#txLinkedHint');
  if (!purchase) {
    hint.textContent = kind === 'Payback' ? 'Unlinked paybacks still reduce what this person owes overall.' : '';
    return;
  }
  const remaining = purchaseRemaining(purchase, editor.transaction?.id ?? null);
  hint.textContent = kind === 'Refund'
    ? `Up to ${formatMoney(remaining)} can still be refunded. Refunds use this purchase's person and tags.`
    : `${formatMoney(remaining)} of this purchase is still unpaid.`;
}

/** Fills empty fields from the chosen purchase. Only copies values the user already entered on that purchase. */
function onLinkedPurchaseChange() {
  updateLinkedHint();
  const purchase = linkedPurchase();
  if (!purchase || editor.transaction) return;
  if (!$('#txAmount').value.trim()) $('#txAmount').value = centsToInput(purchaseRemaining(purchase));
  if (editorKind() === 'Refund') {
    if (!$('#txMerchant').value.trim() && !$('#txDescription').value.trim()) {
      $('#txMerchant').value = purchase.merchant;
      $('#txDescription').value = purchase.description;
    }
    editor.method.setOptions(methodOptions(purchase.paymentMethodId), purchase.paymentMethodId);
  }
}

function renderTagChoices() {
  const container = $('#txTags');
  container.replaceChildren();
  if (state.snapshot.tags.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'form-hint';
    empty.textContent = 'No tags yet. Tags are optional; add one below if you want it.';
    container.append(empty);
    return;
  }
  for (const tag of state.snapshot.tags) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = editor.selectedTags.has(tag.id);
    box.addEventListener('change', () => {
      if (box.checked) editor.selectedTags.add(tag.id);
      else editor.selectedTags.delete(tag.id);
    });
    label.append(box, tag.name);
    container.append(label);
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

async function addTagFromEditor() {
  const input = $('#txNewTag');
  const name = input.value.trim();
  if (!name) return;
  $('#txError').textContent = '';
  try {
    const tag = await api('/tags', { method: 'POST', body: { name } });
    state.snapshot.tags.push(tag);
    state.snapshot.tags.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    state.model = buildModel(state.snapshot);
    editor.selectedTags.add(tag.id);
    input.value = '';
    renderTagChoices();
  } catch (error) {
    $('#txError').textContent = error.message;
  }
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

  const body = {
    kind,
    date: $('#txDate').value,
    amountCents,
    paymentMethodId: editor.method.value ? Number(editor.method.value) : null,
    personId: kind === 'Refund' || !editor.person.value ? null : Number(editor.person.value),
    linkedId: kind === 'Purchase' || !editor.linked.value ? null : Number(editor.linked.value),
    merchant: $('#txMerchant').value,
    description: $('#txDescription').value,
    note: $('#txNote').value,
    tagIds: kind === 'Purchase' ? [...editor.selectedTags].filter(id => state.model.tags.has(id)) : []
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
