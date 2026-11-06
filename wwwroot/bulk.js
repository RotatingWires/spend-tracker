'use strict';

/*
 * Selection mode and bulk actions for the ledger, as in TaskList: File → Select... adds a checkbox to every row,
 * Shift-click selects a range, and Escape (or File → Select... again) leaves selection mode. Each action runs one ordinary API call per entry,
 * so the server applies the same rules as a single edit. Entries a rule refuses are skipped and listed afterwards.
 */

let selectionMode = readSetting('spend-tracker-selection-mode') === 'true';
const selectedIds = new Set();
let selectionAnchorId = null;
let visibleLedgerIds = [];
let bulkBusy = false;

function pruneSelection() {
  const visible = new Set(visibleLedgerIds);
  for (const id of selectedIds) if (!visible.has(id)) selectedIds.delete(id);
  if (!visible.has(selectionAnchorId)) selectionAnchorId = null;
}

function setSelectionMode(enabled) {
  if (bulkBusy) return;
  selectionMode = enabled;
  writeSetting('spend-tracker-selection-mode', String(enabled));
  if (!enabled) {
    selectedIds.clear();
    selectionAnchorId = null;
  }
  $('#selectModeButton').setAttribute('aria-checked', String(enabled));
  closeMenus();
  if (state.activeTab !== 'transactions' && enabled) switchTab('transactions');
  else renderTransactions();
}

function selectionCell(tx) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'selection-check';
  checkbox.checked = selectedIds.has(tx.id);
  checkbox.setAttribute('aria-label', `Select #${tx.id}: ${describeTransaction(tx) || KIND_LABELS[tx.kind]}`);
  const wrap = document.createElement('span');
  wrap.className = 'selection-id';
  wrap.append(checkbox, `#${tx.id}`);
  return wrap;
}

/** Toggles one row, or with Shift sets every row between the last clicked row and this one. */
function toggleSelection(id, extendRange = false) {
  if (bulkBusy) return;
  let range = null;
  if (extendRange && selectionAnchorId !== null) {
    const start = visibleLedgerIds.indexOf(selectionAnchorId);
    const end = visibleLedgerIds.indexOf(id);
    if (start >= 0 && end >= 0) range = visibleLedgerIds.slice(Math.min(start, end), Math.max(start, end) + 1);
  }
  if (!range) selectionAnchorId = id;
  const selecting = Boolean(range) || !selectedIds.has(id);
  for (const target of range ?? [id]) {
    if (selecting) selectedIds.add(target);
    else selectedIds.delete(target);
  }
  renderTransactions();
  $(`#transactionsTable tr[data-id="${id}"]`)?.focus();
}

function selectedTransactions() {
  return visibleLedgerIds.filter(id => selectedIds.has(id)).map(id => state.model.byId.get(id));
}

// ---------------------------------------------------------------- actions

/**
 * Each action returns, for one entry, either the request to send or { skip: reason }. Names and wording follow the
 * single-entry editor so a skipped reason reads the same as the error the editor would show.
 */
const BULK_ACTIONS = {
  archive: {
    label: 'Archive',
    applies: tx => !tx.archived,
    alreadyDone: 'already archived',
    request: tx => ({ body: transactionRequest(tx, { archived: true }) })
  },
  restore: {
    label: 'Restore',
    applies: tx => tx.archived,
    alreadyDone: 'not archived',
    request: tx => ({ body: transactionRequest(tx, { archived: false }) })
  },
  addTag: {
    label: 'Add Tag',
    choose: () => chooseFrom('Add Tag', 'Tag to add', state.snapshot.tags.filter(tag => !tag.archived), 'Add'),
    request: (tx, tagId) => tx.kind !== 'Purchase' ? { skip: 'only purchases have tags' }
      : tx.tagIds.includes(tagId) ? { skip: 'already has that tag' }
      : { body: transactionRequest(tx, { tagIds: [...tx.tagIds, tagId] }) }
  },
  removeTag: {
    label: 'Remove Tag',
    choose: items => chooseFrom('Remove Tag', 'Tag to remove', state.snapshot.tags.filter(tag => items.some(tx => tx.tagIds.includes(tag.id))), 'Remove'),
    request: (tx, tagId) => !tx.tagIds.includes(tagId) ? { skip: 'does not have that tag' }
      : { body: transactionRequest(tx, { tagIds: tx.tagIds.filter(id => id !== tagId) }) }
  },
  addPerson: {
    label: 'Add Person',
    detail: 'Each changed purchase is split evenly again between everyone on it.',
    choose: () => chooseFrom('Add Person', 'Person to add', state.snapshot.people.filter(person => !person.archived), 'Add'),
    request: (tx, personId) => tx.kind !== 'Purchase' ? { skip: 'only purchases are split between people' }
      : tx.shares.some(share => share.personId === personId) ? { skip: `${personName(personId)} is already on it` }
      : { body: transactionRequest(tx, { shares: evenShares(tx.amountCents, [...tx.shares.map(share => share.personId), personId]) }) }
  },
  removePerson: {
    label: 'Remove Person',
    detail: 'Each changed purchase is split evenly again between the people left on it.',
    choose: items => chooseFrom('Remove Person', 'Person to remove',
      state.snapshot.people.filter(person => items.some(tx => tx.kind === 'Purchase' && tx.shares.some(share => share.personId === person.id))), 'Remove'),
    request: (tx, personId) => {
      if (tx.kind !== 'Purchase' || !tx.shares.some(share => share.personId === personId)) return { skip: `${personName(personId)} is not on it` };
      const remaining = tx.shares.map(share => share.personId).filter(id => id !== personId);
      if (remaining.length === 0) return { skip: `${personName(personId)} is the only person on it` };
      return { body: transactionRequest(tx, { shares: evenShares(tx.amountCents, remaining) }) };
    }
  },
  setMerchant: {
    label: 'Set Merchant',
    // Like tags and people, merchants are chosen from a list; new ones come from the editor or Manage.
    choose: () => chooseFrom('Set Merchant', 'Merchant', [...state.snapshot.merchants.filter(merchant => !merchant.archived), { id: 0, name: 'No merchant' }], 'Set')
      .then(choice => choice && { value: choice.value === 0 ? '' : choice.label, label: choice.label }),
    request: (tx, name) => tx.merchant.toLowerCase() === name.toLowerCase() ? { skip: 'already has that merchant' }
      : { body: transactionRequest(tx, { merchant: name }) }
  },
  delete: {
    label: 'Delete',
    detail: 'The History tab keeps a record of every deleted entry. A purchase with refunds or paybacks that are not also selected is skipped.',
    // Refunds and paybacks go first, so a purchase selected with its own refunds can then be deleted too.
    order: items => [...items].sort((a, b) => (a.kind === 'Purchase') - (b.kind === 'Purchase')),
    request: () => ({ method: 'DELETE' })
  }
};

async function chooseFrom(title, label, items, okLabel) {
  if (items.length === 0) {
    await confirmAction(title, `There is nothing to ${okLabel.toLowerCase()} for the selected entries.`, 'OK', { notice: true });
    return null;
  }
  const value = await chooseOption(title, label, items.map(item => ({ value: item.id, label: item.name })), okLabel);
  return value == null ? null : { value: Number(value), label: items.find(item => item.id === Number(value)).name };
}

function selectionSummary(items) {
  const lines = items.slice(0, 12).map(tx => `#${tx.id} — ${formatDate(tx.date)} — ${describeTransaction(tx) || KIND_LABELS[tx.kind]} — ${formatMoney(tx.amountCents)}`);
  if (items.length > 12) lines.push(`And ${plural(items.length - 12, 'more selected entry', 'more selected entries')}.`);
  return lines.join('\n');
}

async function runBulkAction(name) {
  const action = BULK_ACTIONS[name];
  const selected = selectedTransactions();
  if (bulkBusy || selected.length === 0) return;

  const choice = action.choose ? await action.choose(selected) : { value: null, label: '' };
  if (choice == null) return;
  const what = choice.label ? `${action.label} "${choice.label}"` : action.label;
  const detail = [selectionSummary(selected), action.detail ?? ''].filter(Boolean).join('\n\n');
  const confirmed = await confirmAction(`${action.label} Selected`, `${what} for ${plural(selected.length, 'selected entry', 'selected entries')}?`, action.label, { detail });
  if (!confirmed) return;

  bulkBusy = true;
  $('#appWindow').inert = true;
  const skipped = [];
  let changed = 0;
  try {
    const items = action.order ? action.order(selected) : selected;
    for (const [index, tx] of items.entries()) {
      setStatus(`${action.label}: ${index + 1} of ${items.length}...`);
      const plan = action.applies && !action.applies(tx) ? { skip: action.alreadyDone } : action.request(tx, choice.value);
      if (plan.skip) {
        skipped.push(`#${tx.id}: ${plan.skip}.`);
        continue;
      }
      try {
        if (plan.method === 'DELETE') await api(`/transactions/${tx.id}`, { method: 'DELETE' });
        else await api(`/transactions/${tx.id}`, { method: 'PUT', body: plan.body });
        changed++;
        selectedIds.delete(tx.id);
      } catch (error) {
        skipped.push(`#${tx.id}: ${error.message}`);
      }
    }
  } finally {
    bulkBusy = false;
    $('#appWindow').inert = false;
    await loadSnapshot();
  }
  const summary = `${action.label}: ${plural(changed, 'entry', 'entries')} changed${skipped.length ? `, ${skipped.length} skipped` : ''}.`;
  setStatus(summary);
  if (skipped.length)
    await confirmAction(`${action.label} Selected`, `${summary} Skipped entries stay selected.`, 'OK', { detail: skipped.join('\n'), notice: true });
}

// ---------------------------------------------------------------- toolbar

function bulkMenuButton(label, onClick, disabled) {
  const button = menuButton(label, { onClick: event => {
    event.stopPropagation();
    closeMenus();
    onClick();
  } });
  button.disabled = disabled;
  return button;
}

/** "Selected: N" and a split button: the primary action plus a menu of the rest, as in TaskList. */
function updateBulkControls() {
  // Selection belongs to the ledger, so the controls only show on the Transactions tab.
  const shown = selectionMode && state.activeTab === 'transactions';
  $('#bulkControls').hidden = !shown;
  $('#selectModeButton').setAttribute('aria-checked', String(selectionMode));
  if (!shown) {
    $('#bulkActions').replaceChildren();
    return;
  }
  const selected = selectedTransactions();
  $('#selectedCount').textContent = `Selected: ${selected.length}`;
  const none = bulkBusy || selected.length === 0;
  const primary = selected.length > 0 && selected.every(tx => tx.archived) ? 'restore' : 'archive';

  const group = document.createElement('div');
  group.className = 'split-group';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'split-primary';
  main.textContent = BULK_ACTIONS[primary].label;
  main.disabled = none;
  main.addEventListener('click', () => runBulkAction(primary));

  const arrow = document.createElement('button');
  arrow.type = 'button';
  arrow.className = 'split-arrow';
  arrow.textContent = '▼';
  arrow.setAttribute('aria-label', 'More actions for selected entries');
  arrow.setAttribute('aria-haspopup', 'menu');
  arrow.setAttribute('aria-expanded', 'false');
  arrow.disabled = none;
  const menu = document.createElement('div');
  menu.className = 'menu-dropdown split-dropdown';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const items = ['archive', 'restore', null, 'addTag', 'removeTag', 'addPerson', 'removePerson', 'setMerchant', null, 'delete'];
  menu.append(...items.map(name => {
    if (name == null) return menuSeparator();
    const action = BULK_ACTIONS[name];
    const label = action.choose ? `${action.label}...` : action.label;
    return bulkMenuButton(label, () => runBulkAction(name), action.applies ? !selected.some(action.applies) : false);
  }));
  arrow.addEventListener('click', event => {
    event.stopPropagation();
    toggleMenu(arrow, menu);
  });

  group.append(main, arrow, menu);
  $('#bulkActions').replaceChildren(group);
}

function initializeBulk() {
  $('#selectModeButton').addEventListener('click', () => setSelectionMode(!selectionMode));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !selectionMode || bulkBusy || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    setSelectionMode(false);
  });
}
