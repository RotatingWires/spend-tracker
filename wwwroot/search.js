'use strict';

/*
 * File → Search..., as in TaskList: a dialog with Keyword and Date tabs that searches every transaction (any time
 * frame, archived or not) and lists the matches. Searching runs on the Search button or Enter, not on every
 * keystroke. Select a match to edit it.
 */

let searchMode = 'keyword';

function openSearch() {
  closeMenus();
  $('#searchDialog').showModal();
  setSearchTab(searchMode);
  renderSearchResults();
}

function setSearchTab(mode) {
  searchMode = mode;
  const keyword = mode === 'keyword';
  $('#keywordSearchTab').setAttribute('aria-selected', String(keyword));
  $('#dateSearchTab').setAttribute('aria-selected', String(!keyword));
  $('#keywordSearchPanel').hidden = !keyword;
  $('#dateSearchPanel').hidden = keyword;
  (keyword ? $('#searchKeyword') : $('#searchDates')).select();
}

/** "9/14", "9/14/26", or "9/14/2026" as YYYY-MM-DD; no year means this year. Null when it is not a real date. */
function parseSearchDate(text) {
  const match = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\s*$/.exec(text);
  if (!match) return null;
  const year = match[3] ? Number(match[3]) + (match[3].length === 2 ? 2000 : 0) : new Date().getFullYear();
  const key = `${year}-${pad2(match[1])}-${pad2(match[2])}`;
  return keyFromDayNumber(dayNumber(key)) === key ? key : null;
}

/** One date, or two joined by a dash, as in TaskList: "9/1/26 - 10/1/26". Returns [start, end] or null. */
function readSearchDates(text) {
  const parts = /^(.+?)\s*[-–—]\s*(.+)$/.exec(text.trim());
  const [start, end] = parts ? [parseSearchDate(parts[1]), parseSearchDate(parts[2])] : [parseSearchDate(text), parseSearchDate(text)];
  if (!start || !end) return null;
  return start <= end ? [start, end] : [end, start];
}

function renderSearchResults() {
  const query = (searchMode === 'keyword' ? $('#searchKeyword') : $('#searchDates')).value.trim();
  if (!query) {
    $('#searchSummary').textContent = 'Searches every transaction, in any time frame, archived or not.';
    renderTable($('#searchResults'), [{ label: 'Results' }], [], { empty: searchMode === 'keyword' ? 'Enter a keyword, amount, or #ID to search.' : 'Enter a date or a date range to search.' });
    return;
  }
  let matches;
  if (searchMode === 'keyword') {
    matches = state.model.transactions.filter(tx => matchesSearch(tx, query)).reverse();
    $('#searchSummary').textContent = `${plural(matches.length, 'match', 'matches')} for “${query}”, newest first.`;
  } else {
    const range = readSearchDates(query);
    if (!range) {
      $('#searchSummary').textContent = 'Enter dates as month/day or month/day/year, like 9/14 or 9/1/26 - 10/1/26.';
      renderTable($('#searchResults'), [{ label: 'Results' }], [], { empty: 'That is not a date or date range.' });
      return;
    }
    matches = transactionsInRange(range[0], range[1]).reverse();
    $('#searchSummary').textContent = `${plural(matches.length, 'entry', 'entries')} dated ${formatDateRange(range[0], range[1])}, newest first.`;
  }
  renderTable($('#searchResults'), [{ label: 'ID' }, { label: 'When' }, { label: 'Type' }, { label: 'What' }, { label: 'For Who' }, { label: 'Amount', num: true }],
    matches.map(tx => ({
      className: tx.archived ? 'archived-row' : '',
      onClick: () => {
        $('#searchDialog').close();
        openTransactionEditor(tx);
      },
      cells: [`#${tx.id}`, formatDate(tx.date), KIND_LABELS[tx.kind], [describeTransaction(tx) || '(no description)', tx.archived ? '(archived)' : ''].filter(Boolean).join(' '),
        whoLabel(tx), moneyCell(tx.amountCents, { direction: tx.kind === 'Purchase' ? 'out' : tx.kind === 'Refund' ? 'refund' : 'in' })]
    })),
    { empty: 'No transactions match.' });
}

function initializeSearch() {
  $('#searchMenuItem').addEventListener('click', openSearch);
  $('#keywordSearchTab').addEventListener('click', () => { setSearchTab('keyword'); renderSearchResults(); });
  $('#dateSearchTab').addEventListener('click', () => { setSearchTab('date'); renderSearchResults(); });
  for (const [input, button] of [['#searchKeyword', '#searchRunButton'], ['#searchDates', '#searchDatesButton']]) {
    $(button).addEventListener('click', renderSearchResults);
    $(input).addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault(); // Enter searches instead of submitting (closing) the dialog.
      renderSearchResults();
    });
  }
}
