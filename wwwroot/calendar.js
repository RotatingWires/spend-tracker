'use strict';

/* Calendar tab: a month grid of daily net spending for each month in the time frame, and a per-day detail dialog. */

let calendarDialogDay = null;

function dailyNet(transactions) {
  const days = new Map();
  for (const tx of transactions) {
    const day = days.get(tx.date) ?? { net: 0, entries: 0, purchases: 0 };
    if (tx.kind === 'Purchase') {
      day.net += tx.amountCents;
      day.purchases++;
    } else if (tx.kind === 'Refund') {
      day.net -= tx.amountCents;
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
function renderCalendar() {
  const months = timeFrameMonths().reverse();
  $('#calendarMonths').replaceChildren(...months.map(renderMonthGrid));
}

function renderMonthGrid(month) {
  const listed = listedTransactions(monthStart(month), monthEnd(month));
  const days = dailyNet(listed);
  const max = Math.max(0, ...[...days.values()].map(day => day.net));
  const today = todayKey();

  const box = document.createElement('fieldset');
  box.className = 'groupbox';
  const legend = document.createElement('legend');
  legend.textContent = formatMonth(month);
  const wrap = document.createElement('div');
  wrap.className = 'calendar-wrap';
  const grid = document.createElement('div');
  grid.className = 'month-calendar';
  grid.dataset.month = month;
  wrap.append(grid);
  box.append(legend, wrap);

  for (const name of WEEKDAYS) {
    const head = document.createElement('div');
    head.className = 'calendar-head';
    head.textContent = name;
    grid.append(head);
  }
  for (let blank = 0; blank < weekdayOf(monthStart(month)); blank++) {
    const empty = document.createElement('div');
    empty.className = 'calendar-day empty';
    empty.setAttribute('aria-hidden', 'true');
    grid.append(empty);
  }

  for (let dayOfMonth = 1; dayOfMonth <= daysInMonth(month); dayOfMonth++) {
    const key = `${month}-${pad2(dayOfMonth)}`;
    const day = days.get(key);
    // Events are not dated; a day shows the events of the entries recorded on it.
    const events = eventsOf(listed.filter(tx => tx.date === key));
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `calendar-day heat-${heatLevel(day?.net ?? 0, max)}`;
    if (key === today) cell.classList.add('today');

    const date = document.createElement('span');
    date.className = 'calendar-date';
    date.textContent = String(dayOfMonth);
    cell.append(date);

    const summary = [`${WEEKDAY_NAMES[weekdayOf(key)]}, ${formatDate(key)}`];
    if (day) {
      const amount = document.createElement('span');
      amount.className = 'calendar-amount';
      amount.textContent = formatMoney(day.net);
      const meta = document.createElement('span');
      meta.className = 'calendar-meta';
      meta.textContent = plural(day.entries, 'entry', 'entries');
      cell.append(amount, meta);
      summary.push(`net spent ${formatMoney(day.net)}`, plural(day.entries, 'entry', 'entries'));
    } else {
      summary.push('no entries');
    }
    for (const name of events) {
      const label = document.createElement('span');
      label.className = 'calendar-event';
      label.textContent = name;
      cell.append(label);
      summary.push(`event ${name}`);
    }
    cell.setAttribute('aria-label', summary.join(', '));
    cell.addEventListener('click', () => openDayDialog(key));
    grid.append(cell);
  }
  return box;
}

function openDayDialog(key) {
  calendarDialogDay = key;
  renderDayDialog();
  $('#dayDialog').showModal();
}

function renderDayDialog() {
  const key = calendarDialogDay;
  if (!key) return;
  const rows = listedTransactions(key, key);
  const totals = monthTotals(rows);
  $('#dayDialogTitle').textContent = `${WEEKDAY_NAMES[weekdayOf(key)]}, ${formatDate(key)}`;
  const events = eventsOf(rows);
  $('#dayDialogEvents').textContent = events.length ? `Events: ${events.join(', ')}` : '';
  $('#dayDialogEvents').hidden = events.length === 0;

  renderTable($('#dayTable'), [{ label: 'ID' }, { label: 'Type' }, { label: 'What' }, { label: 'For Who' }, { label: 'Method' }, { label: 'Amount', num: true }],
    rows.map(tx => {
      const direction = tx.kind === 'Purchase' ? 'out' : tx.kind === 'Refund' ? 'refund' : 'in';
      return {
        onClick: () => {
          $('#dayDialog').close();
          openTransactionEditor(tx);
        },
        cells: [`#${tx.id}`, KIND_LABELS[tx.kind], describeTransaction(tx) || '(no description)', whoLabel(tx), methodName(tx.paymentMethodId), moneyCell(tx.amountCents, { direction })]
      };
    }),
    {
      empty: 'No entries on this day.',
      footer: rows.length ? { cells: ['', '', 'Net spent', '', '', { text: formatMoney(totals.net), num: true }] } : null
    });
}

function initializeCalendar() {
  $('#dayAddButton').addEventListener('click', () => {
    const key = calendarDialogDay;
    $('#dayDialog').close();
    openTransactionEditor(null, { date: key });
  });
}
