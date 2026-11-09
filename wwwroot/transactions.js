'use strict';

/* Transactions tab (the monthly ledger) and the shared transaction editor dialog. */

const KIND_LABELS = { Purchase: 'Purchase', Refund: 'Refund', Payback: 'Payback' };
// The ledger draws 200 rows at first and more on request, so a long time frame stays quick. A new time frame starts
// over at 200.
const LEDGER_PAGE = 200;
let ledgerLimit = LEDGER_PAGE;
let ledgerSearch = null;

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
  const monthRows = timeFrameTransactions();
  // Newest first: the highest ID on top, as in TaskList. A search keeps only the entries it matches.
  const query = state.ledgerQuery;
  renderLedgerFilters();
  const visible = tx => (!query || matchesSearch(tx, query)) && matchesLedgerFilters(tx);
  const narrowed = Boolean(query || state.ledgerFilters.length);
  const rows = timeFrameTransactions({ listed: true }).filter(visible).sort((a, b) => b.id - a.id);
  // The Collections column appears once you have created a collection.
  const showCollections = state.snapshot.collections.length > 0;
  // The Linked To column appears when a listed entry is linked to another: a refund or payback to its purchase.
  const showLinked = rows.some(tx => linkedEntries(tx).length > 0);
  const usedMethodIds = new Set(rows.map(tx => tx.paymentMethodId));
  // Only the methods used in the time frame get a column; with nothing listed, the active ones stand in.
  const methods = state.snapshot.paymentMethods.filter(method => (rows.length ? usedMethodIds.has(method.id) : !method.archived));

  const columns = [
    { label: 'ID', title: 'The permanent ID of each entry. Search #12 to find entry #12.', sortValue: tx => tx.id },
    { label: 'When', sortValue: tx => Number(tx.date.replace(/-/g, '')) },
    { label: 'For Who', sortValue: tx => whoLabel(tx).toLowerCase() || null },
    { label: 'What', sortValue: tx => describeTransaction(tx).toLowerCase() || null },
    ...(showLinked ? [{ label: 'Linked To', title: 'For a refund or payback, the purchase it is for; for a purchase, its refunds and paybacks. Double-click one to open it.', sortValue: tx => tx.linkedId ?? (linkedEntries(tx)[0]?.id ?? null) }] : []),
    { label: 'Tags', sortValue: tx => tagIdsOf(tx).map(tagName).join(TAG_SEPARATOR).toLowerCase() || null },
    ...(showCollections ? [{ label: 'Collections', sortValue: tx => collectionIdsOf(tx).map(collectionName).join(', ').toLowerCase() || null }] : []),
    ...methods.map(method => ({ label: method.name, num: true, sortValue: tx => (tx.paymentMethodId === method.id ? netEffect(tx) ?? tx.amountCents : null) })),
    { label: 'Net Spent', num: true, title: 'What each entry adds to net spent: purchases add, refunds subtract, and paybacks do not change it.', sortValue: netEffect }
  ];

  // The ledger sorts every listed entry before drawing the first 200, so a sorted column is sorted all the way down.
  const sort = tableSorts.get('transactionsTable');
  const ordered = sort && columns[sort.index]?.sortValue ? sortByValue(rows, columns[sort.index].sortValue, sort.direction) : rows;
  const shown = ordered.slice(0, ledgerLimit);
  visibleLedgerIds = shown.map(tx => tx.id);
  pruneSelection();

  const tableRows = shown.map(tx => {
    const what = document.createElement('span');
    if (tx.kind !== 'Purchase') {
      const badge = document.createElement('span');
      badge.className = 'kind-badge money-in';
      badge.textContent = `${KIND_LABELS[tx.kind]}:`;
      what.append(badge);
    }
    what.append(describeTransaction(tx) || '(no description)');
    if (tx.archived) {
      const badge = document.createElement('span');
      badge.className = 'archived-badge';
      badge.textContent = '(archived)';
      what.append(' ', badge);
    }
    if (tx.note) {
      const note = document.createElement('span');
      note.className = 'cell-sub';
      note.textContent = tx.note;
      what.append(note);
    }
    const direction = tx.kind === 'Purchase' ? 'out' : tx.kind === 'Refund' ? 'refund' : 'in';
    const selected = selectionMode && selectedIds.has(tx.id);
    return {
      id: tx.id,
      className: [tx.archived ? 'archived-row' : '', selected ? 'tx-selected' : ''].filter(Boolean).join(' '),
      selected: selectionMode ? selected : undefined,
      // A double click opens the editor, so a stray click does not; in selection mode a single click selects.
      onClick: selectionMode ? event => toggleSelection(tx.id, event.shiftKey) : null,
      onDoubleClick: selectionMode ? null : () => openTransactionEditor(tx),
      cells: [
        selectionMode ? selectionCell(tx) : `#${tx.id}`,
        formatDate(tx.date),
        whoLabel(tx),
        what,
        ...(showLinked ? [linkedCell(tx)] : []),
        tagList(tagIdsOf(tx)),
        ...(showCollections ? [collectionIdsOf(tx).map(collectionName).join(', ')] : []),
        ...methods.map(method => method.id === tx.paymentMethodId ? moneyCell(tx.amountCents, { direction }) : { text: '', num: true }),
        tx.kind === 'Payback' ? { text: '—', num: true } : moneyCell(tx.amountCents, { direction })
      ]
    };
  });

  const footer = rows.length === 0 ? null : {
    cells: [
      { text: 'Totals', title: 'Net spent (purchases minus refunds) of every listed entry in the time frame, including rows not shown yet, per payment method and in all. Paybacks are listed but not included.' },
      '',
      '',
      '',
      '',
      ...(showLinked ? [''] : []),
      ...(showCollections ? [''] : []),
      ...methods.map(method => ({ text: formatMoney(netOf(rows.filter(tx => tx.paymentMethodId === method.id))), num: true })),
      { text: formatMoney(netOf(rows)), num: true }
    ]
  };

  const matching = narrowed ? monthRows.filter(visible) : monthRows;
  const hidden = matching.length - rows.length;
  const empty = monthRows.length === 0
    ? `No entries in ${timeFrameLabel()}. Use New Transaction... to add one.`
    : matching.length === 0 ? `No entry in ${timeFrameLabel()} matches ${query ? `"${query}"` : ''}${query && state.ledgerFilters.length ? ' and ' : ''}${state.ledgerFilters.length ? 'the filters' : ''}.`
      : rows.length === 0 ? `Every ${narrowed ? 'match' : 'entry'} in ${timeFrameLabel()} is archived. Turn on View > Show Archived to list them.` : '';
  renderTable($('#transactionsTable'), columns, tableRows, { empty, footer, onSort: () => renderTransactions() });
  const more = rows.length - shown.length;
  $('#ledgerMore').hidden = more === 0;
  $('#ledgerMoreText').textContent = `Showing ${numberFormat.format(shown.length)} of ${plural(rows.length, 'entry', 'entries')}.`;
  $('#ledgerMoreButton').textContent = `Show ${numberFormat.format(Math.min(LEDGER_PAGE, more))} More`;
  $('#ledgerMoreButton').onclick = () => {
    ledgerLimit += LEDGER_PAGE;
    renderTransactions();
  };
  $('#ledgerAllButton').onclick = () => {
    ledgerLimit = Infinity;
    renderTransactions();
  };
  $('#archivedNote').hidden = hidden === 0 || rows.length === 0;
  $('#archivedNote').textContent = `${plural(hidden, 'archived entry', 'archived entries')} hidden in this time frame; they still count in Stats. View > Show Archived lists them.`;
  updateBulkControls();
}

/** The ledger's Tags cell: wraps between tags, never inside one, so a long list does not widen the column. */
function tagList(tagIds) {
  const list = document.createElement('span');
  list.className = 'tag-list';
  tagIds.forEach((id, index) => {
    if (index) list.append(TAG_SEPARATOR);
    const tag = document.createElement('span');
    tag.className = 'tag-name';
    tag.textContent = tagName(id);
    list.append(tag);
  });
  return list;
}

// ---------------------------------------------------------------- ledger filters
/*
 * The Filters dropdown after Time frame: check any number of types, payment methods, people, merchants, tags, and
 * collections, grouped by kind. Within a group an entry needs any of the checked ones; across groups, all of them.
 * Refunds count under their purchase's merchant, tags, and collections, as elsewhere.
 */
const LEDGER_FILTER_GROUPS = { kind: 'Type', method: 'Payment method', person: 'For who', merchant: 'Merchant', tag: 'Tags', collection: 'Collections' };
let ledgerFilterSelect = null;

function ledgerFilterOptions() {
  const list = (prefix, items) => items.map(item => ({ value: `${prefix}:${item.id}`, label: archivedLabel(item) }));
  return [
    ...Object.entries(KIND_LABELS).map(([kind, label]) => ({ value: `kind:${kind}`, label })),
    ...list('method', state.snapshot.paymentMethods),
    ...list('person', state.snapshot.people),
    ...list('merchant', state.snapshot.merchants),
    ...list('tag', state.snapshot.tags),
    ...list('collection', state.snapshot.collections)
  ];
}

function renderLedgerFilters() {
  ledgerFilterSelect ??= createMultiSelect($('#ledgerFilterSelect'), {
    empty: 'None',
    groupOf: value => LEDGER_FILTER_GROUPS[value.split(':')[0]],
    summary: names => (names.length > 1 ? `${names.length} filters` : names[0]),
    onChange: values => {
      state.ledgerFilters = values;
      ledgerLimit = LEDGER_PAGE;
      renderTransactions();
    }
  });
  ledgerFilterSelect.setOptions(ledgerFilterOptions(), state.ledgerFilters);
  // A filter whose item was deleted drops out.
  state.ledgerFilters = ledgerFilterSelect.values;
  $('#clearFiltersButton').hidden = state.ledgerFilters.length === 0;
}

function matchesLedgerFilters(tx) {
  const wanted = new Map();
  for (const value of state.ledgerFilters) {
    const [group, id] = value.split(':');
    if (!wanted.has(group)) wanted.set(group, new Set());
    wanted.get(group).add(group === 'kind' ? id : Number(id));
  }
  const valuesOf = {
    kind: () => [tx.kind],
    method: () => [tx.paymentMethodId],
    person: () => peopleOf(tx),
    merchant: () => merchantIdsOf(tx),
    tag: () => tagIdsOf(tx),
    collection: () => collectionIdsOf(tx)
  };
  for (const [group, ids] of wanted) if (!valuesOf[group]().some(value => ids.has(value))) return false;
  return true;
}

/** The entries linked to this one: a refund's or payback's purchase, or a purchase's refunds and paybacks. */
function linkedEntries(tx) {
  if (tx.linkedId != null) return [state.model.byId.get(tx.linkedId)].filter(Boolean);
  return state.model.linked.get(tx.id) ?? [];
}

/**
 * The Linked To cell: "Purchase #12 · Amazon — cable" on a refund or payback, "Refund #14, Payback #15" on a purchase.
 * Double-clicking one opens that entry, not the row's own.
 */
function linkedCell(tx) {
  const entries = linkedEntries(tx);
  if (!entries.length) return '';
  const cell = document.createElement('span');
  entries.forEach((entry, index) => {
    if (index) cell.append(', ');
    const link = document.createElement('span');
    link.className = 'linked-entry';
    const what = tx.linkedId != null ? ` · ${describeTransaction(entry) || formatMoney(entry.amountCents)}` : '';
    link.textContent = `${KIND_LABELS[entry.kind]} #${entry.id}${what}`;
    link.title = `Double-click to open ${KIND_LABELS[entry.kind].toLowerCase()} #${entry.id} (${formatDate(entry.date)}, ${formatMoney(entry.amountCents)})`;
    link.addEventListener('dblclick', event => {
      if (selectionMode) return;
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      openTransactionEditor(entry);
    });
    cell.append(link);
  });
  return cell;
}

/** What one entry adds to net spent: a purchase its amount, a refund minus its amount, a payback nothing (null). */
function netEffect(tx) {
  return tx.kind === 'Purchase' ? tx.amountCents : tx.kind === 'Refund' ? -tx.amountCents : null;
}

/** Purchases minus refunds; paybacks do not change net spent. */
function netOf(transactions) {
  return transactions.reduce((sum, tx) => sum + (tx.kind === 'Purchase' ? tx.amountCents : tx.kind === 'Refund' ? -tx.amountCents : 0), 0);
}

function exportTransactionsCsv() {
  const header = ['ID', 'Date', 'Type', 'For Who', 'Merchant', 'Description', 'Tags', 'Collections', 'Payment Method', 'Amount', 'Linked To', 'Note', 'Archived'];
  const lines = [header];
  for (const tx of state.model.transactions) {
    const forWho = tx.kind === 'Purchase' && tx.shares.length > 1
      ? tx.shares.map(share => `${personName(share.personId)} ${centsToInput(share.amountCents)}`).join('; ')
      : whoLabel(tx);
    lines.push([
      `#${tx.id}`,
      tx.date,
      tx.kind,
      forWho,
      tx.merchant,
      tx.description,
      tagIdsOf(tx).map(tagName).join('; '),
      collectionIdsOf(tx).map(collectionName).join('; '),
      methodName(tx.paymentMethodId),
      centsToInput(tx.amountCents),
      tx.linkedId == null ? '' : `#${tx.linkedId}`,
      tx.note,
      tx.archived ? 'Yes' : ''
    ]);
  }
  const csv = lines.map(line => line.map(csvField).join(',')).join('\r\n');
  downloadFile(`spendtracker-transactions-${fileStamp()}.csv`, 'text/csv', csv);
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
  merchant: null,
  people: null,
  person: null,
  linked: null,
  tags: null,
  collections: null,
  shareInputs: new Map(),
  // People whose share of the purchase is a gift (person IDs as strings, like the dropdown values).
  gifts: new Set()
};

function initializeTransactionEditor() {
  editor.kind = createSingleSelect($('#txKind'), { onChange: () => applyEditorKind() });
  editor.kind.setOptions(KIND_OPTIONS, 'Purchase');
  // Each list's "Add New..." adds an item as its tab's Add form would, then chooses it here.
  editor.method = createSingleSelect($('#txMethod'), {
    onAdd: () => addFromEditor('payment-methods', id => editor.method.setOptions(methodOptions(id), id))
  });
  editor.merchant = createSingleSelect($('#txMerchant'), {
    onAdd: () => addFromEditor('merchants', id => editor.merchant.setOptions(merchantOptions(id), id))
  });
  editor.people = createMultiSelect($('#txPeople'), {
    empty: 'Choose people',
    deferChange: true,
    onChange: () => renderShareRows(),
    onAdd: () => addFromEditor('people', id => {
      editor.people.setOptions(peopleOptions(editor.transaction), [...editor.people.values, id]);
      renderShareRows();
    })
  });
  editor.person = createSingleSelect($('#txPerson'), {
    onChange: () => onEditorPersonChange(),
    onAdd: () => addFromEditor('people', id => {
      editor.person.setOptions(payerOptions(id), id);
      onEditorPersonChange();
    })
  });
  editor.linked = createSingleSelect($('#txLinked'), { onChange: () => onLinkedPurchaseChange() });
  editor.tags = createMultiSelect($('#txTags'), {
    empty: 'No tags',
    summary: names => names.join(TAG_SEPARATOR),
    onAdd: () => addFromEditor('tags', id => {
      const chosen = [...editor.tags.values.map(Number), id];
      editor.tags.setOptions(labelOptions(state.snapshot.tags, chosen), chosen);
    })
  });
  editor.collections = createMultiSelect($('#txCollections'), {
    empty: 'No collections',
    onAdd: () => addFromEditor('collections', id => {
      const chosen = [...editor.collections.values.map(Number), id];
      editor.collections.setOptions(labelOptions(state.snapshot.collections, chosen), chosen);
    })
  });

  $('#transactionForm').addEventListener('submit', event => {
    event.preventDefault();
    saveTransaction();
  });
  $('#txDeleteButton').addEventListener('click', () => deleteTransaction());
  $('#txArchiveButton').addEventListener('click', () => saveTransaction({ archived: !editor.transaction.archived }));
  $('#txAmount').addEventListener('input', () => updateShareTotal());
  $('#txAmount').addEventListener('change', () => formatAmountInput($('#txAmount')));
  ledgerSearch = bindSearchForm($('#ledgerSearchForm'), query => {
    state.ledgerQuery = query;
    ledgerLimit = LEDGER_PAGE;
    renderTransactions();
  });
  $('#txViewButton').addEventListener('click', () => viewEntryInTime(editor.transaction));
  $('#clearFiltersButton').addEventListener('click', () => {
    state.ledgerFilters = [];
    ledgerLimit = LEDGER_PAGE;
    renderTransactions();
    setStatus('Filters cleared.');
  });
}

/**
 * View Entry in Time: closes the editor and shows the entry in the ledger, like TaskList's visit: its month, with
 * filters and search cleared (and archived entries listed when it is archived), scrolled to and highlighted briefly.
 */
function viewEntryInTime(tx) {
  if (!tx) return;
  $('#transactionDialog').close();
  state.ledgerFilters = [];
  state.ledgerQuery = '';
  ledgerSearch?.clear();
  if (tx.archived && !state.showArchived) {
    state.showArchived = true;
    writeSetting('spend-tracker-show-archived', 'true');
  }
  state.timeFrame = { all: false, months: [monthOf(tx.date)] };
  calendarCollectionId = null;
  ledgerLimit = LEDGER_PAGE;
  switchTab('transactions');
  let row = $(`#transactionsTable tbody tr[data-id="${tx.id}"]`);
  if (!row) {
    // Past the first 200 rows of a sorted month: draw them all.
    ledgerLimit = Infinity;
    renderTransactions();
    row = $(`#transactionsTable tbody tr[data-id="${tx.id}"]`);
  }
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('visit-highlight');
  setTimeout(() => row.classList.remove('visit-highlight'), 3200);
  setStatus(`Showing ${KIND_LABELS[tx.kind].toLowerCase()} #${tx.id} in ${formatMonth(monthOf(tx.date))}.`);
}

/** Rewrites a valid amount box as "1,234.50" once the user leaves it; anything unparseable is left for Save to report. */
function formatAmountInput(input) {
  const cents = parseMoney(input.value);
  if (cents != null) input.value = formatAmount(cents);
}

/** "Add New..." in an editor dropdown: asks for a name, adds the item, reloads the data, and lets choose() pick it. */
async function addFromEditor(path, choose) {
  const created = await addListItem(path);
  if (!created) return;
  choose(created.id);
  $('#txError').textContent = '';
}

function editorKind() {
  return editor.kind.value;
}

function openTransactionEditor(tx = null, defaults = {}) {
  editor.transaction = tx;
  editor.kind.value = tx?.kind ?? defaults.kind ?? 'Purchase';
  $('#transactionDialogTitle').textContent = tx ? `Edit ${KIND_LABELS[tx.kind]} #${tx.id}` : 'New Transaction';
  $('#txDate').value = tx?.date ?? defaults.date ?? todayKey();
  $('#txAmount').value = tx ? formatAmount(tx.amountCents) : '';
  editor.merchant.setOptions(merchantOptions(tx?.merchantId ?? null), tx?.merchantId ?? '');
  $('#txDescription').value = tx?.description ?? '';
  $('#txNote').value = tx?.note ?? '';
  $('#txError').textContent = '';
  $('#txDeleteButton').hidden = !tx;
  $('#txArchiveButton').hidden = !tx;
  $('#txViewButton').hidden = !tx;
  $('#txArchiveButton').textContent = tx?.archived ? 'Restore' : 'Archive';
  $('#txArchiveButton').title = tx?.archived
    ? 'Save and list this entry in the ledger and calendar again.'
    : 'Save and hide this entry from the ledger and calendar. It still counts in Stats and balances.';
  renderEditorNumbers(tx);

  // New entries start on the method of the latest purchase; the user sees and can change it before saving.
  const lastPurchase = state.model.transactions.findLast(entry => entry.kind === 'Purchase');
  editor.method.setOptions(methodOptions(tx?.paymentMethodId), tx?.paymentMethodId ?? lastPurchase?.paymentMethodId);
  editor.tags.setOptions(labelOptions(state.snapshot.tags, tx?.tagIds ?? []), tx?.tagIds ?? []);
  editor.collections.setOptions(labelOptions(state.snapshot.collections, tx?.collectionIds ?? []), tx?.collectionIds ?? []);
  editor.shareInputs = new Map((tx?.shares ?? []).map(share => [String(share.personId), formatAmount(share.amountCents)]));
  editor.gifts = new Set((tx?.shares ?? []).filter(share => share.gift).map(share => String(share.personId)));
  editor.people.setOptions(peopleOptions(tx), tx?.shares?.length ? tx.shares.map(share => share.personId) : [state.model.self.id]);
  editor.person.setOptions([], null);
  editor.linked.setOptions([], null);
  applyEditorKind({ personId: tx?.personId ?? defaults.personId, linkedId: tx?.linkedId ?? defaults.linkedId });

  $('#transactionDialog').showModal();
  $('#txAmount').focus();
}

/** "Archived. Me #4 Alex #3 food #12": each number opens that person's, tag's, or merchant's numbered list. */
function renderEditorNumbers(tx) {
  const line = $('#txNumbers');
  line.hidden = !tx;
  line.replaceChildren();
  if (!tx) return;
  if (tx.archived) line.append('Archived. ');
  for (const entry of scopeNumbers(tx)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'number-chip';
    button.textContent = entry.label;
    button.title = `List every entry numbered in ${entry.label.replace(/ #\d+$/, '')}`;
    button.addEventListener('click', () => {
      $('#transactionDialog').close();
      openScopeList(entry.scope, entry.scopeId);
    });
    line.append(button);
  }
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
  showEditorRow('txCollections', isPurchase);

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

/** Tags or collections offered on a purchase: the active ones, plus archived ones it already has. */
function labelOptions(labels, currentIds) {
  return labels
    .filter(label => !label.archived || currentIds.includes(label.id))
    .map(label => ({ value: label.id, label: archivedLabel(label) }));
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

/**
 * One person takes the whole amount; several people each get an amount box that must add up to the total. Everyone
 * but you also gets a Gift box: a gift share is bought for them but not owed back.
 */
function renderShareRows() {
  const container = $('#txShares');
  for (const input of container.querySelectorAll('input[data-person]')) editor.shareInputs.set(input.dataset.person, input.value);
  for (const box of container.querySelectorAll('input[data-gift]')) {
    if (box.checked) editor.gifts.add(box.dataset.gift);
    else editor.gifts.delete(box.dataset.gift);
  }
  const people = selectedPeople();
  const split = people.length > 1;
  container.replaceChildren();
  container.hidden = !split && people.every(id => id === state.model.self.id);
  if (container.hidden) return;

  for (const personId of people) {
    const name = document.createElement('label');
    name.className = 'share-name';
    name.htmlFor = split ? `txShare${personId}` : `txGift${personId}`;
    name.textContent = personName(personId);
    const amount = document.createElement(split ? 'input' : 'span');
    if (split) {
      amount.id = `txShare${personId}`;
      amount.className = 'retro-input';
      amount.type = 'text';
      amount.inputMode = 'decimal';
      amount.autocomplete = 'off';
      amount.placeholder = '0.00';
      amount.dataset.person = String(personId);
      amount.value = editor.shareInputs.get(String(personId)) ?? '';
      amount.addEventListener('input', () => updateShareTotal());
      amount.addEventListener('change', () => formatAmountInput(amount));
    }
    const amountBox = split ? document.createElement('span') : amount;
    if (split) {
      amountBox.className = 'money-input';
      amountBox.append(amount);
    }
    const gift = document.createElement('label');
    gift.className = 'share-gift';
    if (personId !== state.model.self.id) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'retro-check';
      box.id = `txGift${personId}`;
      box.dataset.gift = String(personId);
      box.checked = editor.gifts.has(String(personId));
      gift.title = `A gift: ${personName(personId)} does not owe this back, so it stays off their balance.`;
      gift.append(box, 'Gift');
    }
    // Each person is a row with a divider under it, like TaskList's task rows.
    const row = document.createElement('div');
    row.className = 'share-row';
    row.append(name, amountBox, gift);
    container.append(row);
  }
  if (!split) return;

  const footer = document.createElement('div');
  footer.className = 'share-footer';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Split Evenly';
  button.addEventListener('click', () => splitEvenly());
  const total = document.createElement('span');
  total.id = 'txShareTotal';
  total.className = 'form-hint';
  footer.append(button, total);
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

function splitEvenly() {
  const amount = parseMoney($('#txAmount').value);
  if (amount == null) {
    $('#txError').textContent = 'Enter the amount first, then split it.';
    $('#txAmount').focus();
    return;
  }
  const inputs = shareInputs();
  evenShares(amount, inputs.map(input => input.dataset.person))
    .forEach((share, index) => { inputs[index].value = formatAmount(share.amountCents); });
  $('#txError').textContent = '';
  updateShareTotal();
}

function collectShares(amountCents) {
  const people = selectedPeople();
  if (people.length === 0) throw new Error('Choose who this purchase was for.');
  const gift = personId => $(`#txGift${personId}`)?.checked ?? false;
  if (people.length === 1) return [{ personId: people[0], amountCents, gift: gift(people[0]) }];
  return shareInputs().map(input => {
    const personId = Number(input.dataset.person);
    const cents = parseMoney(input.value);
    if (cents == null) throw new Error(`Enter ${personName(personId)}'s share, or use Split Evenly.`);
    return { personId, amountCents: cents, gift: gift(personId) };
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
    ? `Up to ${formatMoney(remaining)} of ${whose} can still be refunded. Refunds use the purchase's tags and collections.`
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
    if (!editor.merchant.value && !$('#txDescription').value.trim()) {
      editor.merchant.value = purchase.merchantId ?? '';
      $('#txDescription').value = purchase.description;
    }
    editor.method.setOptions(methodOptions(purchase.paymentMethodId), purchase.paymentMethodId);
  }
}

/** Merchants are chosen like payment methods: the active ones, plus an archived one the entry already has. */
function merchantOptions(currentId) {
  return [{ value: '', label: 'No merchant' }, ...labelOptions(state.snapshot.merchants, currentId == null ? [] : [currentId])];
}

/** Saves the editor. changes overrides fields, such as { archived: true } from the Archive button. */
async function saveTransaction(changes = {}) {
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
    merchantId: editor.merchant.value ? Number(editor.merchant.value) : null,
    description: $('#txDescription').value,
    note: $('#txNote').value,
    tagIds: kind === 'Purchase' ? editor.tags.values.map(Number) : [],
    collectionIds: kind === 'Purchase' ? editor.collections.values.map(Number) : [],
    shares,
    archived: editor.transaction?.archived ?? false,
    ...changes
  };

  $('#txSaveButton').disabled = true;
  try {
    const existing = editor.transaction;
    const saved = existing
      ? await api(`/transactions/${existing.id}`, { method: 'PUT', body })
      : await api('/transactions', { method: 'POST', body });
    $('#transactionDialog').close();
    applyTransactionChanges({ saved: [saved] });
    const verb = existing && saved.archived !== existing.archived ? (saved.archived ? 'Archived' : 'Restored') : existing ? 'Saved' : 'Added';
    setStatus(`${verb} ${KIND_LABELS[saved.kind].toLowerCase()} #${saved.id}, ${formatMoney(saved.amountCents)} on ${formatDate(saved.date)}.`);
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
    applyTransactionChanges({ deleted: [tx.id] });
    setStatus(`Deleted ${KIND_LABELS[tx.kind].toLowerCase()} ${formatMoney(tx.amountCents)}.`);
  } catch (error) {
    $('#txError').textContent = error.message;
  }
}
