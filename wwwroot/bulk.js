/*
 * Selection mode and bulk actions for the ledger, as in TaskList: File > Select... adds a checkbox to every row,
 * Shift-click selects a range, and Escape (or File > Select... again) leaves selection mode. Each action runs one ordinary API call per entry,
 * so the server applies the same rules as a single edit. Entries a rule refuses are skipped and listed afterwards.
 */
import { $, SNAPSHOT_LISTS, api, applyTransactionChanges, describeTransaction, el, evenShares, formatDate, formatMoney, personName, plural, readSetting, state, transactionRequest, writeSetting } from './app.js';
import { chooseOption, closeMenus, confirmAction, menuButton, setStatus, toggleMenu } from './widgets.js';
import { KIND_LABELS, archivedLabel, renderTransactions } from './transactions.js';
import { menuSeparator, switchTab } from './ui.js';

export let selectionMode = readSetting('spend-tracker-selection-mode') === 'true';
export const selectedIds = new Set();
let selectionAnchorId = null;
export let visibleLedgerIds = [];
/** Other modules change visibleLedgerIds through this; an imported binding is read-only. */
export function setVisibleLedgerIds(value) { return (visibleLedgerIds = value); }
let bulkBusy = false;

export function pruneSelection() {
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

export function selectionCell(tx) {
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'selection-check retro-check';
  checkbox.checked = selectedIds.has(tx.id);
  checkbox.setAttribute('aria-label', `Select #${tx.id}: ${describeTransaction(tx) || KIND_LABELS[tx.kind]}`);
  const wrap = el('span', 'selection-id');
  wrap.append(checkbox, `#${tx.id}`);
  return wrap;
}

/** Toggles one row, or with Shift sets every row between the last clicked row and this one. */
export function toggleSelection(id, extendRange = false) {
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
  tags: labelAction('tag', 'tags', 'tagIds'),
  collections: labelAction('collection', 'collections', 'collectionIds'),
  people: {
    label: 'People',
    detail: 'Each changed purchase is split evenly again between everyone on it.',
    choose: items => chooseWithMode('People', 'People', 'people',
      state.snapshot.people.filter(person => !person.archived || items.some(tx => tx.shares.some(share => share.personId === person.id)))),
    request: (tx, choice) => {
      if (tx.kind !== 'Purchase') return { skip: 'only purchases are split between people' };
      const names = choice.ids.map(personName).join(', ');
      const people = changedIds(tx.shares.map(share => share.personId), choice);
      if (!people) return { skip: choice.mode === 'add' ? `${names} ${choice.ids.length === 1 ? 'is' : 'are'} already on it` : `${names} ${choice.ids.length === 1 ? 'is' : 'are'} not on it` };
      if (people.length === 0) return { skip: 'it would leave nobody on it' };
      // People who stay keep whether their share is a gift.
      const gifts = new Set(tx.shares.filter(share => share.gift).map(share => share.personId));
      const shares = evenShares(tx.amountCents, people).map(share => ({ ...share, gift: gifts.has(share.personId) }));
      return { body: transactionRequest(tx, { shares }) };
    }
  },
  merchant: {
    label: 'Merchant',
    // Like tags and people, merchants are chosen from a list, which can add a new one.
    choose: () => chooseFrom('Merchant', 'Set merchant to', [...state.snapshot.merchants.filter(merchant => !merchant.archived), { id: 0, name: 'No merchant' }], 'Set', 'merchants')
      .then(choice => choice && { value: choice.value === 0 ? null : choice.value, label: `Set merchant to "${choice.label}"` }),
    request: (tx, merchantId) => tx.merchantId === merchantId ? { skip: 'already has that merchant' }
      : { body: transactionRequest(tx, { merchantId }) }
  },
  delete: {
    label: 'Delete',
    detail: 'The History tab keeps a record of every deleted entry. A purchase with refunds or paybacks that are not also selected is skipped.',
    // Refunds and paybacks go first, so a purchase selected with its own refunds can then be deleted too.
    order: items => [...items].sort((a, b) => (a.kind === 'Purchase') - (b.kind === 'Purchase')),
    request: () => ({ method: 'DELETE' })
  }
};

const ADD_REMOVE = [{ value: 'add', label: 'Add to the selected entries' }, { value: 'remove', label: 'Remove from the selected entries' }];

/**
 * One action per kind: the dialog asks whether to add or remove, then which ones, as check items. Its list can add
 * a new one ("Add New..."), so an empty list still opens.
 */
async function chooseWithMode(title, label, path, items) {
  const choice = await chooseOption(title, label, items.map(item => ({ value: item.id, label: archivedLabel(item) })), 'OK', { modes: ADD_REMOVE, multiple: true, addPath: path });
  if (choice == null) return null;
  const chosen = state.snapshot[SNAPSHOT_LISTS[path]].filter(item => choice.value.includes(String(item.id)));
  return { value: { ids: chosen.map(item => item.id), mode: choice.mode }, label: `${choice.mode === 'add' ? 'Add' : 'Remove'} ${chosen.map(item => `"${item.name}"`).join(', ')}` };
}

/** The IDs after adding or removing the chosen ones, or null when nothing would change. */
function changedIds(current, { ids, mode }) {
  const next = mode === 'add' ? [...current, ...ids.filter(id => !current.includes(id))] : current.filter(id => !ids.includes(id));
  return next.length === current.length && next.every(id => current.includes(id)) ? null : next;
}

/** Add or remove tags or collections. Tags and collections work the same way: only purchases have them. */
function labelAction(noun, list, field) {
  const title = `${noun[0].toUpperCase()}${noun.slice(1)}s`;
  return {
    label: title,
    choose: items => chooseWithMode(title, title, list,
      state.snapshot[list].filter(item => !item.archived || items.some(tx => tx[field].includes(item.id)))),
    request: (tx, choice) => {
      if (choice.mode === 'add' && tx.kind !== 'Purchase') return { skip: `only purchases have ${noun}s` };
      const next = changedIds(tx[field], choice);
      if (!next) return { skip: choice.mode === 'add' ? `already has ${choice.ids.length === 1 ? `that ${noun}` : `those ${noun}s`}` : `has none of those ${noun}s` };
      return { body: transactionRequest(tx, { [field]: next }) };
    }
  };
}

async function chooseFrom(title, label, items, okLabel, addPath = null) {
  if (items.length === 0 && !addPath) {
    await confirmAction(title, `There is nothing to ${okLabel.toLowerCase()} for the selected entries.`, 'OK', { notice: true });
    return null;
  }
  const value = await chooseOption(title, label, items.map(item => ({ value: item.id, label: item.name })), okLabel, { addPath });
  if (value == null) return null;
  const known = [...items, ...(addPath ? state.snapshot[SNAPSHOT_LISTS[addPath]] : [])];
  return { value: Number(value), label: known.find(item => item.id === Number(value)).name };
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
  const what = choice.label || action.label;
  const detail = [selectionSummary(selected), action.detail ?? ''].filter(Boolean).join('\n\n');
  const confirmed = await confirmAction(`${action.label} Selected`, `${what} for ${plural(selected.length, 'selected entry', 'selected entries')}?`, action.choose ? 'OK' : action.label, { detail });
  if (!confirmed) return;

  bulkBusy = true;
  $('#appWindow').inert = true;
  const skipped = [];
  let changed = 0;
  const saved = [];
  const deleted = [];
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
        // Changed entries stay selected, so another action can follow; deleted ones are gone.
        if (plan.method === 'DELETE') {
          await api(`/transactions/${tx.id}`, { method: 'DELETE' });
          deleted.push(tx.id);
          selectedIds.delete(tx.id);
        } else {
          saved.push(await api(`/transactions/${tx.id}`, { method: 'PUT', body: plan.body }));
        }
        changed++;
      } catch (error) {
        skipped.push(`#${tx.id}: ${error.message}`);
      }
    }
  } finally {
    bulkBusy = false;
    $('#appWindow').inert = false;
    // Only the entries that changed are replaced; nothing else is downloaded again.
    applyTransactionChanges({ saved, deleted });
  }
  const summary = `${action.label}: ${plural(changed, 'entry', 'entries')} changed${skipped.length ? `, ${skipped.length} skipped` : ''}.`;
  setStatus(summary);
  if (skipped.length)
    await confirmAction(`${action.label} Selected`, `${summary} The entries stay selected.`, 'OK', { detail: skipped.join('\n'), notice: true });
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
export function updateBulkControls() {
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

  const group = el('div', 'split-group');
  const main = el('button', 'split-primary');
  main.textContent = BULK_ACTIONS[primary].label;
  main.disabled = none;
  main.addEventListener('click', () => runBulkAction(primary));

  const arrow = el('button', 'split-arrow', '▼');
  arrow.setAttribute('aria-label', 'More actions for selected entries');
  arrow.setAttribute('aria-haspopup', 'menu');
  arrow.setAttribute('aria-expanded', 'false');
  arrow.disabled = none;
  const menu = el('div', 'menu-dropdown split-dropdown');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const items = ['archive', 'restore', null, 'tags', 'collections', 'people', 'merchant', null, 'delete'];
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

export function initializeBulk() {
  $('#selectModeButton').addEventListener('click', () => setSelectionMode(!selectionMode));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !selectionMode || bulkBusy || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    setSelectionMode(false);
  });
}
