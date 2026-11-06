'use strict';

/*
 * File → Search..., as in TaskList: a dialog that searches every transaction (any time frame, archived or not) and
 * lists the matches. Searching runs on the Search button or Enter, not on every keystroke. Select a match to edit it.
 */

function openSearch() {
  closeMenus();
  $('#searchDialog').showModal();
  $('#searchKeyword').select();
  renderSearchResults();
}

function renderSearchResults() {
  const query = $('#searchKeyword').value.trim();
  if (!query) {
    $('#searchSummary').textContent = 'Searches every transaction, in any time frame, archived or not.';
    renderTable($('#searchResults'), [{ label: 'Results' }], [], { empty: 'Enter a keyword, amount, or #ID to search.' });
    return;
  }
  const matches = state.model.transactions.filter(tx => matchesSearch(tx, query)).reverse();
  $('#searchSummary').textContent = `${plural(matches.length, 'match', 'matches')} for “${query}”, newest first.`;
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
  $('#searchRunButton').addEventListener('click', renderSearchResults);
  $('#searchKeyword').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // Enter searches instead of submitting (closing) the dialog.
    renderSearchResults();
  });
}
