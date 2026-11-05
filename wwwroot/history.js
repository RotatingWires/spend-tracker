'use strict';

/* History tab: the server's audit log of every change, rendered as readable before/after summaries. */

const HISTORY_PAGE_SIZE = 100;
const historyState = { entries: [], hasMore: false, loading: false };

const ENTITY_LABELS = { Transaction: 'Transaction', PaymentMethod: 'Payment method', Person: 'Person', Tag: 'Tag', Event: 'Event', Backup: 'Backup' };

const TRANSACTION_FIELDS = [
  ['kind', 'Type', value => value],
  ['date', 'Date', value => formatDate(value)],
  ['amountCents', 'Amount', value => formatMoney(value)],
  ['paymentMethodId', 'Method', value => methodName(value)],
  ['personId', 'Person', value => (value == null ? '—' : personName(value))],
  ['shares', 'For who', value => (value?.length ? value.map(share => `${personName(share.personId)} ${formatMoney(share.amountCents)}`).join(', ') : '—')],
  ['linkedId', 'Linked to', value => (value == null ? '—' : `#${value}`)],
  ['merchant', 'Merchant', value => value || '—'],
  ['description', 'What', value => value || '—'],
  ['note', 'Note', value => value || '—'],
  ['tagIds', 'Tags', value => (value.length ? value.map(tagName).join(', ') : '—')]
];

const SIMPLE_FIELDS = [
  ['name', 'Name', value => value],
  ['archived', 'Archived', value => (value ? 'Yes' : 'No')],
  ['startDate', 'Start', value => formatDate(value)],
  ['endDate', 'End', value => formatDate(value)],
  ['note', 'Note', value => value || '—']
];

async function loadHistory({ older = false } = {}) {
  if (historyState.loading) return;
  historyState.loading = true;
  try {
    const beforeId = older && historyState.entries.length ? historyState.entries.at(-1).id : null;
    const query = `?limit=${HISTORY_PAGE_SIZE}${beforeId ? `&beforeId=${beforeId}` : ''}`;
    const page = await api(`/history${query}`);
    historyState.entries = older ? [...historyState.entries, ...page.entries] : page.entries;
    historyState.hasMore = page.hasMore;
    renderHistory();
  } catch (error) {
    showError(`Could not load history: ${error.message}`);
  } finally {
    historyState.loading = false;
  }
}

function historySubject(entry) {
  const value = entry.after ?? entry.before ?? {};
  switch (entry.entity) {
    case 'Transaction':
      return `#${entry.entityId} ${value.kind} ${formatMoney(value.amountCents)} · ${formatDate(value.date)} · ${describeTransaction(value) || '(no description)'}`;
    case 'Event':
      return `${value.name} (${formatDateRange(value.startDate, value.endDate)})`;
    case 'Backup':
      return `Backup from ${formatDateTime(value.exportedAt)} (${plural(value.transactions, 'transaction')})`;
    default:
      return value.name ?? `#${entry.entityId}`;
  }
}

function historyDetails(entry) {
  if (entry.action === 'Restored')
    return `Previous data saved on the server as data/backups/${entry.after.recoveryFile}.`;
  if (entry.action === 'Deleted' && entry.entity === 'Tag' && entry.before.removedFromTransactions)
    return `Removed from ${plural(entry.before.removedFromTransactions, 'transaction')}.`;
  if (entry.action !== 'Edited') return '';

  const fields = entry.entity === 'Transaction' ? TRANSACTION_FIELDS : SIMPLE_FIELDS;
  const changes = [];
  for (const [key, label, format] of fields) {
    if (!(key in entry.before) && !(key in entry.after)) continue;
    if (JSON.stringify(entry.before[key]) === JSON.stringify(entry.after[key])) continue;
    changes.push(`${label}: ${format(entry.before[key])} → ${format(entry.after[key])}`);
  }
  return changes.join('; ');
}

function renderHistory() {
  renderTable($('#historyTable'), [{ label: 'When' }, { label: 'Action' }, { label: 'Type' }, { label: 'Item' }, { label: 'Changes' }],
    historyState.entries.map(entry => ({
      cells: [formatDateTime(entry.at), entry.action, ENTITY_LABELS[entry.entity] ?? entry.entity, historySubject(entry), historyDetails(entry)]
    })),
    { empty: 'No changes recorded yet.' });
  $('#historyMoreButton').hidden = !historyState.hasMore;
}

function initializeHistory() {
  $('#historyMoreButton').addEventListener('click', () => loadHistory({ older: true }));
}
