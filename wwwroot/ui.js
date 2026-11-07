'use strict';

/* Startup, data loading, tab navigation, toolbar, menus, backup/restore, and session handling. */

const TAB_RENDERERS = {
  transactions: renderTransactions,
  calendar: renderCalendar,
  stats: () => showStats(),
  people: renderPeople,
  methods: renderMethodsTab,
  tags: renderTagsTab,
  collections: renderCollectionsTab,
  merchants: renderMerchantsTab,
  history: () => loadHistory()
};
const MONTH_TABS = new Set(['transactions', 'calendar']);
// Stats and its charts load the first time the Stats tab opens, so starting up reads only what the ledger needs.
const STATS_SCRIPTS = ['/charts.js', '/stats.js', '/heatmaps.js', '/insights.js', '/counts.js'];
let statsLoading = null;
let statsLoaded = false;

function loadStatsScripts() {
  statsLoading ??= Promise.all(STATS_SCRIPTS.map(src => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false; // Run in the listed order, while downloading together.
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}.`));
    document.body.append(script);
  }))).then(() => {
    initializeStats();
    statsLoaded = true;
  }).catch(error => {
    statsLoading = null; // Try again next time the tab opens.
    throw error;
  });
  return statsLoading;
}

function showStats() {
  if (statsLoaded) {
    renderStats();
    return;
  }
  setStatus('Loading Stats...');
  loadStatsScripts()
    .then(() => {
      setStatus('Ready');
      if (state.activeTab === 'stats') renderStats();
    })
    .catch(error => showError(error.message));
}
let timeFrameSelect = null;

async function loadSnapshot() {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const snapshot = await api('/snapshot');
      state.snapshot = snapshot;
      state.model = buildModel(snapshot);
      applyReleaseLabel(await frontendReleaseVersion(snapshot.version));
      showError('');
      $('#loadingPanel').hidden = true;
      renderAll();
    } catch (error) {
      $('#loadingPanel').hidden = true;
      showError(`Could not load data: ${error.message}`);
      setStatus('Data unavailable');
    }
  })();
  try {
    await state.loading;
  } finally {
    state.loading = null;
  }
}

function renderAll() {
  if (!state.model) return;
  renderTimeFrameSelect();
  $('#monthControls').hidden = !MONTH_TABS.has(state.activeTab);
  $('#titleScope').textContent = MONTH_TABS.has(state.activeTab)
    ? timeFrameLabel()
    : $(`.tabs [data-tab="${state.activeTab}"]`).textContent;
  TAB_RENDERERS[state.activeTab]();
  updateBulkControls();
  if ($('#personDialog').open) renderPersonDialog();
  if ($('#dayDialog').open) renderDayDialog();
  if ($('#scopeDialog').open) renderScopeList();

  const count = state.model.transactions.length;
  // Messages go on the left and totals on the right, as in TaskList.
  $('#statusRight').textContent = `${plural(count, 'entry', 'entries')} • ${plural(state.snapshot.people.length - 1, 'other person', 'other people')} • ${plural(state.snapshot.tags.length, 'tag')} • ${plural(state.snapshot.collections.length, 'collection')}`;
  if ($('#statusLeft').textContent === 'Loading...') setStatus('Ready');
}

function switchTab(name) {
  state.activeTab = name;
  calendarCollectionId = null;
  $$('.tabs [role="tab"]').forEach(tab => tab.setAttribute('aria-selected', tab.dataset.tab === name ? 'true' : 'false'));
  $$('.tab-panel').forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
  closeMenus();
  if (statsLoaded) Charts.hideTooltip();
  $('#workspace').scrollTop = 0;
  renderAll();
}

/** All time, then every month newest first, including chosen months outside the data (reached with ◀ / ▶). */
function renderTimeFrameSelect() {
  const months = [...new Set([...allMonths(), ...state.timeFrame.months])].sort().reverse();
  timeFrameSelect.setOptions([{ value: 'all', label: 'All time' }, ...months.map(month => ({ value: month, label: formatMonth(month) }))],
    state.timeFrame.all ? ['all'] : state.timeFrame.months);
  // ◀ / ▶ move the whole selection by a month, so they are off for All time.
  $('#previousMonthButton').disabled = state.timeFrame.all;
  $('#nextMonthButton').disabled = state.timeFrame.all;
}

/**
 * Applies a new dropdown selection. All time and months exclude each other: checking All time clears the months,
 * and checking a month leaves All time. Unchecking the last choice is ignored, so something is always shown.
 */
function changeTimeFrame(values) {
  const months = values.filter(value => value !== 'all');
  if (values.includes('all') && !state.timeFrame.all) state.timeFrame = { all: true, months: [] };
  else if (months.length) state.timeFrame = { all: false, months };
  calendarCollectionId = null;
  ledgerLimit = LEDGER_PAGE;
  renderAll();
}

function shiftTimeFrame(delta) {
  if (state.timeFrame.all) return;
  state.timeFrame = { all: false, months: state.timeFrame.months.map(month => shiftMonth(month, delta)) };
  calendarCollectionId = null;
  ledgerLimit = LEDGER_PAGE;
  renderAll();
}

function populateViewMenu() {
  const menu = $('#viewMenu');
  menu.replaceChildren();
  for (const tab of $$('.tabs [role="tab"]')) {
    menu.append(menuButton(tab.textContent, {
      role: 'menuitemradio',
      checked: tab.dataset.tab === state.activeTab,
      onClick: () => switchTab(tab.dataset.tab)
    }));
  }
  menu.append(menuSeparator(), menuButton('Show Archived', {
    role: 'menuitemcheckbox',
    checked: state.showArchived,
    onClick: () => {
      state.showArchived = !state.showArchived;
      writeSetting('spend-tracker-show-archived', String(state.showArchived));
      closeMenus();
      renderAll();
      setStatus(state.showArchived ? 'Showing archived entries in the ledger and calendar.' : 'Archived entries are hidden from the ledger and calendar.');
    }
  }));
  const heading = document.createElement('div');
  heading.className = 'menu-heading';
  heading.textContent = 'Theme';
  menu.append(menuSeparator(), heading);
  const preference = window.SpendTheme.getPreference();
  for (const [value, label] of [['light', 'Light'], ['dark', 'Dark']]) {
    menu.append(menuButton(label, {
      role: 'menuitemradio',
      checked: value === preference,
      onClick: () => {
        window.SpendTheme.setPreference(value);
        closeMenus();
      }
    }));
  }
}

function menuSeparator() {
  const separator = document.createElement('div');
  separator.className = 'menu-separator';
  separator.setAttribute('role', 'separator');
  return separator;
}

function applyReleaseLabel(version) {
  if (!version) return;
  document.title = `SpendTracker v${version}`;
  $('.title-left').textContent = `SpendTracker v${version}`;
  $('#aboutVersion').textContent = `SpendTracker v${version}`;
}

async function frontendReleaseVersion(fallback = '') {
  try {
    const response = await fetch('/version.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return fallback;
    const body = await response.json();
    return body.version || fallback;
  } catch {
    return fallback;
  }
}

async function logout() {
  closeMenus();
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } finally {
    window.location.replace('/login.html');
  }
}

async function downloadBackup() {
  closeMenus();
  try {
    const response = await fetch('/api/backup', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      window.location.replace(loginUrl());
      return;
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const name = /filename="?([^";]+)"?/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? `spend-tracker-${todayKey()}.zip`;
    downloadFile(name, 'application/zip', await response.blob());
    setStatus('Backup downloaded. Keep it private; it contains all your spending data.');
  } catch (error) {
    showError(`Could not download a backup: ${error.message}`);
  }
}

async function restoreBackup(file) {
  const confirmed = await confirmAction('Restore Backup',
    `Replace ALL current SpendTracker data with ${file.name}? The current data is saved on the server in data/backups first. Your password is not changed.`,
    'Restore');
  if (!confirmed) return;
  try {
    setStatus(`Restoring ${file.name}...`);
    const response = await fetch('/api/restore', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/zip' },
      body: file
    });
    if (response.status === 401) {
      window.location.replace(loginUrl());
      return;
    }
    const result = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` }));
    if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
    await loadSnapshot();
    setStatus(`Restored ${plural(result.transactions, 'transaction')}. Previous data saved as ${result.recoveryFile}.`);
  } catch (error) {
    showError(`Restore failed; nothing was changed. ${error.message}`);
  }
}

function initializeRowHover() {
  const root = document.documentElement;
  const button = $('#highlightRowsButton');
  const storageKey = 'spend-tracker-highlight-rows';
  let enabled = true;
  let hoveredRow = null;
  try { enabled = localStorage.getItem(storageKey) !== 'false'; } catch {}

  function highlightRow(row) {
    if (row === hoveredRow) return;
    hoveredRow?.classList.remove('row-hover');
    hoveredRow = row;
    hoveredRow?.classList.add('row-hover');
  }

  function applyPreference() {
    root.classList.toggle('row-hover-enabled', enabled);
    button.setAttribute('aria-checked', String(enabled));
    if (!enabled) highlightRow(null);
  }
  applyPreference();

  button.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem(storageKey, String(enabled)); } catch {}
    applyPreference();
    closeMenus();
  });

  // Track rows from mouse pointers only, so a tap on a phone does not leave a row highlighted.
  document.addEventListener('pointermove', event => {
    const row = enabled && event.pointerType === 'mouse' ? event.target.closest?.('tbody > tr') ?? null : null;
    highlightRow(row);
  }, { passive: true, capture: true });
  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) highlightRow(null);
  }, { passive: true, capture: true });
}

function initializeTooltips() {
  // Touch screens have no hover, so tapping an underlined label shows its definition.
  const popup = document.createElement('div');
  popup.className = 'help-tooltip';
  popup.hidden = true;
  document.body.append(popup);
  document.addEventListener('click', event => {
    const target = event.target.closest?.('.has-tooltip[title]');
    if (!target) {
      popup.hidden = true;
      return;
    }
    popup.textContent = target.getAttribute('title');
    popup.hidden = false;
    const rect = target.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - popup.offsetWidth - 8, rect.left))}px`;
    popup.style.top = `${rect.bottom + 8 + popup.offsetHeight > window.innerHeight ? rect.top - popup.offsetHeight - 8 : rect.bottom + 8}px`;
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') popup.hidden = true;
  });
  $('#workspace').addEventListener('scroll', () => { popup.hidden = true; }, { passive: true });
}

function startApp() {
  state.timeFrame = { all: false, months: [monthOf(todayKey())] };
  timeFrameSelect = createMultiSelect($('#timeFrameSelect'), {
    empty: 'Choose months',
    onChange: changeTimeFrame,
    // Months sit under their year, which expands and collapses; All time stays at the top on its own.
    groupOf: value => (value === 'all' ? null : value.slice(0, 4)),
    // One month by name; more than one as a count.
    summary: names => (names.length > 1 ? `${names.length} months` : names[0])
  });
  initializeTransactionEditor();
  initializeCalendar();
  initializePeople();
  initializeHistory();
  initializeManage();
  initializeBulk();
  initializeRowHover();
  initializeTooltips();

  $('#fileMenuButton').addEventListener('click', event => {
    event.stopPropagation();
    toggleMenu($('#fileMenuButton'), $('#fileMenu'));
  });
  $('#viewMenuButton').addEventListener('click', event => {
    event.stopPropagation();
    populateViewMenu();
    toggleMenu($('#viewMenuButton'), $('#viewMenu'));
  });
  $('#helpButton').addEventListener('click', () => {
    closeMenus();
    $('#aboutDialog').showModal();
  });
  $('#newTransactionMenuItem').addEventListener('click', () => {
    closeMenus();
    openTransactionEditor(null, { date: defaultEntryDate() });
  });
  $('#newTransactionButton').addEventListener('click', () => openTransactionEditor(null, { date: defaultEntryDate() }));
  $('#refreshButton').addEventListener('click', () => {
    closeMenus();
    loadSnapshot();
  });
  // Import/Export... gathers backup download, restore, and CSV export in one dialog, like TaskList's.
  $('#transferMenuItem').addEventListener('click', () => {
    closeMenus();
    $('#transferDialog').showModal();
  });
  $('#exportCsvButton').addEventListener('click', exportTransactionsCsv);
  $('#backupButton').addEventListener('click', downloadBackup);
  $('#restoreButton').addEventListener('click', () => {
    $('#transferDialog').close();
    $('#restoreFileInput').click();
  });
  $('#restoreFileInput').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) restoreBackup(file);
  });
  $('#logoutButton').addEventListener('click', logout);
  $('#previousMonthButton').addEventListener('click', () => shiftTimeFrame(-1));
  $('#nextMonthButton').addEventListener('click', () => shiftTimeFrame(1));
  $$('.tabs [role="tab"]').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  document.addEventListener('click', closeMenus);
  // Escape closes an open dropdown first, without also closing the dialog it sits in.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !$$('.menu-dropdown').some(menu => !menu.hidden)) return;
    event.preventDefault();
    closeMenus();
  }, true);
  window.addEventListener('spend-theme-change', () => {
    if (state.activeTab === 'stats' && statsLoaded) renderStats();
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.activeTab === 'stats' && state.model && statsLoaded) renderStats();
    }, 150);
  });

  loadSnapshot().then(openLinkedPage);
}

/** A collection's deep link, like TaskList's /task/{id}: the server answers it with the app, which opens it. */
function collectionLink(collectionId) {
  return `/collection/${collectionId}`;
}

/** /collection/3 (a collection link opened in a new tab) shows that collection's entries on the Collections tab. */
function openLinkedPage() {
  const match = /^\/collection\/(\d+)\/?$/.exec(location.pathname);
  if (!match) return;
  history.replaceState(null, '', '/');
  if (!state.model) return;
  const id = Number(match[1]);
  switchTab('collections');
  if (state.model.collections.has(id)) openScopeList('collection', id);
  else setStatus(`Collection #${id} no longer exists.`);
}

/** New entries default to today, unless one other month is being viewed, then its first day. */
function defaultEntryDate() {
  const today = todayKey();
  const month = singleTimeFrameMonth();
  return MONTH_TABS.has(state.activeTab) && month && monthOf(today) !== month ? monthStart(month) : today;
}

startApp();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
