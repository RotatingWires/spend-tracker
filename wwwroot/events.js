'use strict';

/* Events tab: user-named date ranges (trips, moves, holidays) and their spending. */

let editingEvent = null;

function renderEvents() {
  const rows = [...state.model.events].reverse().map(event => {
    const totals = monthTotals(transactionsInRange(event.startDate, event.endDate));
    const days = dayNumber(event.endDate) - dayNumber(event.startDate) + 1;
    return {
      onClick: () => openEventDialog(event),
      cells: [
        { content: eventNameCell(event) },
        formatDateRange(event.startDate, event.endDate),
        { text: numberFormat.format(days), num: true },
        { text: numberFormat.format(totals.purchases), num: true },
        { text: formatMoney(totals.net), num: true },
        { text: averageMoney(totals.net, days), num: true },
        rowActionButtons([['Stats', () => showEventStats(event), `Show stats for ${event.name}`]])
      ]
    };
  });
  renderTable($('#eventsTable'), [
    { label: 'Event' },
    { label: 'Dates' },
    { label: 'Days', num: true },
    { label: 'Purchases', num: true },
    { label: 'Net Spent', num: true, title: 'Purchases minus refunds dated inside the event.' },
    { label: 'Per Day', num: true },
    { label: '' }
  ], rows, { empty: 'No events yet. Use New Event to name a date range, like a trip.' });
}

function eventNameCell(event) {
  const wrap = document.createElement('span');
  wrap.append(event.name);
  if (event.note) {
    const note = document.createElement('span');
    note.className = 'cell-sub';
    note.textContent = event.note;
    wrap.append(note);
  }
  return wrap;
}

function showEventStats(event) {
  state.statsPeriod = `e:${event.id}`;
  switchTab('stats');
}

function openEventDialog(event = null) {
  editingEvent = event;
  $('#eventDialogTitle').textContent = event ? 'Edit Event' : 'New Event';
  $('#eventName').value = event?.name ?? '';
  $('#eventStart').value = event?.startDate ?? todayKey();
  $('#eventEnd').value = event?.endDate ?? todayKey();
  $('#eventNote').value = event?.note ?? '';
  $('#eventError').textContent = '';
  $('#eventDeleteButton').hidden = !event;
  $('#eventDialog').showModal();
  $('#eventName').focus();
}

async function saveEvent() {
  const body = {
    name: $('#eventName').value,
    startDate: $('#eventStart').value,
    endDate: $('#eventEnd').value,
    note: $('#eventNote').value
  };
  try {
    if (editingEvent) await api(`/events/${editingEvent.id}`, { method: 'PUT', body });
    else await api('/events', { method: 'POST', body });
    $('#eventDialog').close();
    await loadSnapshot();
    setStatus(`Saved event ${body.name.trim()}.`);
  } catch (error) {
    $('#eventError').textContent = error.message;
  }
}

async function deleteEvent() {
  const event = editingEvent;
  if (!event) return;
  if (!await confirmAction('Delete Event', `Delete the event "${event.name}"? Its transactions are not affected.`, 'Delete')) return;
  try {
    await api(`/events/${event.id}`, { method: 'DELETE' });
    $('#eventDialog').close();
    if (state.statsPeriod === `e:${event.id}`) state.statsPeriod = 'all';
    await loadSnapshot();
    setStatus(`Deleted event ${event.name}.`);
  } catch (error) {
    $('#eventError').textContent = error.message;
  }
}

function initializeEvents() {
  $('#newEventButton').addEventListener('click', () => openEventDialog());
  $('#eventForm').addEventListener('submit', event => {
    event.preventDefault();
    saveEvent();
  });
  $('#eventCancelButton').addEventListener('click', () => $('#eventDialog').close());
  $('#eventDeleteButton').addEventListener('click', () => deleteEvent());
}
