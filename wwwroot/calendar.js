/* Calendar tab: a month grid of daily net spending for each month in the time frame, and a per-day detail dialog. */
import { $, $$, WEEKDAYS, WEEKDAY_NAMES, collectionIdsOf, collectionName, collectionsOf, compareNames, daysInMonth, describeTransaction, el, formatDate, formatMoney, formatMonth, listedTransactions, methodName, monthEnd, monthOf, monthStart, pad2, plural, shiftMonth, state, timeFrameMonths, todayKey, weekdayOf, whoLabel } from './app.js';
import { moneyCell, renderTable, setStatus } from './widgets.js';
import { KIND_LABELS, monthTotals, openTransactionEditor } from './transactions.js';
import { collectionLink, switchTab } from './ui.js';

let calendarDialogDay = null;
// A collection opened from a day's dialog: its days are outlined until the time frame or tab changes.
export let calendarCollectionId = null;
/** Other modules change calendarCollectionId through this; an imported binding is read-only. */
export function setCalendarCollectionId(value) { return (calendarCollectionId = value); }

export function dailyNet(transactions) {
  const days = new Map();
  for (const tx of transactions) {
    const day = days.get(tx.date) ?? { net: 0, entries: 0, purchases: 0, spent: 0, refunded: 0, paidBack: 0 };
    if (tx.kind === 'Purchase') {
      day.net += tx.amountCents;
      day.spent += tx.amountCents;
      day.purchases++;
    } else if (tx.kind === 'Refund') {
      day.net -= tx.amountCents;
      day.refunded += tx.amountCents;
    } else {
      day.paidBack += tx.amountCents;
    }
    day.entries++;
    days.set(tx.date, day);
  }
  return days;
}

function heatLevel(net, max) {
  if (net <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((net / max) * 4)));
}

/** One month grid per month in the time frame, newest first. */
export function renderCalendar() {
  const months = timeFrameMonths().reverse();
  $('#calendarMonths').replaceChildren(...months.map(renderMonthGrid));
}

function renderMonthGrid(month) {
  const listed = listedTransactions(monthStart(month), monthEnd(month));
  const days = dailyNet(listed);
  const max = Math.max(0, ...[...days.values()].map(day => day.net));
  const today = todayKey();

  const box = el('fieldset', 'groupbox');
  const legend = el('legend');
  legend.textContent = formatMonth(month);
  const wrap = el('div', 'calendar-wrap');
  const grid = el('div', 'month-calendar');
  grid.dataset.month = month;
  wrap.append(grid);
  box.append(legend, wrap);

  for (const name of WEEKDAYS) {
    const head = el('div', 'calendar-head');
    head.textContent = name;
    grid.append(head);
  }
  for (let blank = 0; blank < weekdayOf(monthStart(month)); blank++) {
    const empty = el('div', 'calendar-day empty');
    empty.setAttribute('aria-hidden', 'true');
    grid.append(empty);
  }

  for (let dayOfMonth = 1; dayOfMonth <= daysInMonth(month); dayOfMonth++) {
    const key = `${month}-${pad2(dayOfMonth)}`;
    const day = days.get(key);
    // Collections are not dated; a day shows the collections of the entries recorded on it.
    const collections = collectionsOf(listed.filter(tx => tx.date === key));
    // Only days with entries open a dialog; empty days are plain cells, like Stats' rows that have nothing to list.
    const cell = document.createElement(day ? 'button' : 'div');
    if (day) cell.type = 'button';
    cell.dataset.date = key;
    cell.className = `calendar-day heat-${heatLevel(day?.net ?? 0, max)}`;
    if (key === today) cell.classList.add('today');
    if (calendarCollectionId != null && listed.some(tx => tx.date === key && collectionIdsOf(tx).includes(calendarCollectionId))) {
      cell.classList.add('collection-focus');
    }

    const date = el('span', 'calendar-date');
    date.textContent = String(dayOfMonth);
    cell.append(date);

    const summary = [`${WEEKDAY_NAMES[weekdayOf(key)]}, ${formatDate(key)}`];
    if (day) {
      const amount = el('span', 'calendar-amount');
      amount.textContent = formatMoney(day.net);
      const meta = el('span', 'calendar-meta');
      meta.textContent = plural(day.entries, 'entry', 'entries');
      cell.append(amount, meta);
      summary.push(`net spent ${formatMoney(day.net)}`, plural(day.entries, 'entry', 'entries'));
    } else {
      summary.push('no entries');
    }
    for (const name of collections) {
      const label = el('span', 'calendar-collection');
      label.textContent = name;
      cell.append(label);
      summary.push(`collection ${name}`);
    }
    cell.setAttribute('aria-label', summary.join(', '));
    if (day) cell.addEventListener('click', () => openDayDialog(key));
    grid.append(cell);
  }
  return box;
}

export function openDayDialog(key) {
  calendarDialogDay = key;
  renderDayDialog();
  $('#dayDialog').showModal();
}

export function renderDayDialog() {
  const key = calendarDialogDay;
  if (!key) return;
  const rows = listedTransactions(key, key);
  const totals = monthTotals(rows);
  $('#dayDialogTitle').textContent = `${WEEKDAY_NAMES[weekdayOf(key)]}, ${formatDate(key)}`;
  // Each collection name opens that collection in the calendar.
  const collectionIds = [...new Set(rows.flatMap(collectionIdsOf))]
    .sort((a, b) => compareNames(collectionName(a), collectionName(b)));
  const line = $('#dayDialogCollections');
  line.replaceChildren();
  line.hidden = collectionIds.length === 0;
  if (collectionIds.length) line.append('Collections: ');
  collectionIds.forEach((id, index) => {
    if (index) line.append(', ');
    // A plain click shows the collection here in the calendar; opened in a new tab, the link goes to its Collections entry.
    const link = el('a', 'collection-link');
    link.href = collectionLink(id);
    link.textContent = collectionName(id);
    link.title = `Show every day of ${collectionName(id)} in the calendar. Open in a new tab for its entries on the Collections tab.`;
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      $('#dayDialog').close();
      showCollectionCalendar(id);
    });
    line.append(link);
  });

  renderTable($('#dayTable'), [
    { label: 'ID' }, { label: 'Type' }, { label: 'What' }, { label: 'For Who' }, { label: 'Method' }, { label: 'Amount', num: true },
    { label: 'Net Spent', num: true, title: 'What each entry adds to net spent: purchases add, refunds subtract, and paybacks do not change it.' }
  ],
    rows.map(tx => {
      const direction = tx.kind === 'Purchase' ? 'out' : tx.kind === 'Refund' ? 'refund' : 'in';
      return {
        onClick: () => {
          $('#dayDialog').close();
          openTransactionEditor(tx);
        },
        cells: [
          `#${tx.id}`, KIND_LABELS[tx.kind], describeTransaction(tx) || '(no description)', whoLabel(tx), methodName(tx.paymentMethodId),
          moneyCell(tx.amountCents, { direction }),
          tx.kind === 'Payback' ? { text: '—', num: true } : moneyCell(tx.amountCents, { direction })
        ]
      };
    }),
    {
      empty: 'No entries on this day.',
      footer: rows.length ? { cells: ['Totals', '', '', '', '', '', { text: formatMoney(totals.net), num: true }] } : null
    });
}

/** Sets the time frame to the months a collection's entries span, outlines its days, and scrolls to the first one. */
function showCollectionCalendar(collectionId) {
  const dates = state.model.transactions.filter(tx => collectionIdsOf(tx).includes(collectionId)).map(tx => tx.date).sort();
  if (!dates.length) return;
  const months = [];
  for (let month = monthOf(dates[0]); month <= monthOf(dates.at(-1)); month = shiftMonth(month, 1)) months.push(month);
  state.timeFrame = { all: false, months };
  switchTab('calendar');
  calendarCollectionId = collectionId;
  renderCalendar();
  const days = $$('#calendarMonths .collection-focus');
  // Months are listed newest first, so the collection's first day is the last outlined one.
  days.at(-1)?.scrollIntoView({ block: 'center' });
  setStatus(`Showing ${collectionName(collectionId)} in the calendar: ${plural(days.length, 'day')} outlined.`);
}

export function initializeCalendar() {
  $('#dayAddButton').addEventListener('click', () => {
    const key = calendarDialogDay;
    $('#dayDialog').close();
    openTransactionEditor(null, { date: key });
  });
}
