'use strict';

// File > Fresh Start...: clear only the chosen data, then the server compacts the database to free disk space.

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

async function openFreshStart() {
  closeMenus();
  const dialog = $('#freshStartDialog');
  const options = [...dialog.querySelectorAll('[data-fresh-start]')];
  for (const option of options) option.checked = option.defaultChecked;
  for (const count of dialog.querySelectorAll('[data-fresh-count]')) count.textContent = '';
  $('#freshStartSize').textContent = 'Checking stored data...';
  $('#freshStartConfirmation').value = '';
  $('#freshStartError').textContent = '';
  dialog.showModal();
  try {
    const summary = await api('/fresh-start');
    const kept = summary.allArchivedEntries - summary.archivedEntries;
    const counts = {
      archivedEntries: plural(summary.archivedEntries, 'entry', 'entries') + (kept ? `; ${kept} kept because an active entry links to them` : ''),
      allEntries: plural(summary.entries, 'entry', 'entries'),
      unusedLabels: plural(summary.unusedLabels, 'label'),
      allLabels: plural(summary.allLabels, 'label'),
      history: plural(summary.historyEntries, 'change'),
      recoveryBackups: `${plural(summary.recoveryBackups, 'file')}, ${formatBytes(summary.recoveryBackupBytes)}`
    };
    for (const [key, text] of Object.entries(counts)) dialog.querySelector(`[data-fresh-count="${key}"]`).textContent = `(${text})`;
    $('#freshStartSize').textContent = `Database size: ${formatBytes(summary.databaseBytes)}.`;
  } catch (error) {
    $('#freshStartSize').textContent = `Could not read stored data: ${error.message}`;
  }
}

async function runFreshStart() {
  const dialog = $('#freshStartDialog');
  const button = $('#freshStartButton');
  const selections = Object.fromEntries([...dialog.querySelectorAll('[data-fresh-start]')].map(option => [option.dataset.freshStart, option.checked]));
  if (!Object.values(selections).some(Boolean)) {
    $('#freshStartError').textContent = 'Choose at least one item to clear.';
    return;
  }
  if ($('#freshStartConfirmation').value !== 'RESET SELECTED') {
    $('#freshStartError').textContent = 'Type RESET SELECTED to confirm.';
    $('#freshStartConfirmation').focus();
    return;
  }
  $('#freshStartError').textContent = '';
  button.disabled = true;
  setStatus('Clearing selected data and compacting the database...');
  try {
    const result = await api('/fresh-start', { method: 'POST', body: { confirmation: 'RESET SELECTED', selections } });
    dialog.close();
    await loadSnapshot();
    const removed = [
      result.removedEntries && plural(result.removedEntries, 'entry', 'entries'),
      result.removedLabels && plural(result.removedLabels, 'label'),
      result.removedHistory && plural(result.removedHistory, 'history change'),
      result.removedBackups && plural(result.removedBackups, 'recovery backup')
    ].filter(Boolean);
    setStatus(result.warning ?? `Fresh start: ${removed.length ? `removed ${removed.join(', ')}` : 'nothing to remove'}; freed ${formatBytes(result.freedBytes)}.`);
  } catch (error) {
    $('#freshStartError').textContent = error.message;
    setStatus(`Fresh start failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

// Clearing every label needs every entry gone too, since entries use labels; the two boxes keep each other in step.
$('[data-fresh-start="allLabels"]').addEventListener('change', event => {
  if (event.target.checked) $('[data-fresh-start="allEntries"]').checked = true;
});
$('[data-fresh-start="allEntries"]').addEventListener('change', event => {
  if (!event.target.checked) $('[data-fresh-start="allLabels"]').checked = false;
});

$('#freshStartMenuItem').addEventListener('click', openFreshStart);
$('#freshStartButton').addEventListener('click', runFreshStart);
