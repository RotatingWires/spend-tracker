'use strict';

/* Manage tab: payment methods, people, tags, and merchants. */

const MANAGED = {
  'payment-methods': {
    table: '#methodsTable',
    singular: 'payment method',
    items: () => state.snapshot.paymentMethods,
    uses: id => state.model.transactions.filter(tx => tx.paymentMethodId === id).length,
    archivable: () => true
  },
  people: {
    table: '#peopleManageTable',
    singular: 'person',
    scope: 'person',
    items: () => state.snapshot.people,
    uses: id => state.model.transactions.filter(tx => peopleOf(tx).includes(id)).length,
    archivable: item => !item.isSelf
  },
  tags: {
    table: '#tagsTable',
    singular: 'tag',
    scope: 'tag',
    items: () => state.snapshot.tags,
    uses: id => state.model.transactions.filter(tx => tx.tagIds.includes(id)).length,
    archivable: () => true
  },
  merchants: {
    table: '#merchantsTable',
    singular: 'merchant',
    scope: 'merchant',
    maxLength: 120,
    items: () => state.snapshot.merchants,
    uses: id => state.model.transactions.filter(tx => tx.merchantId === id).length,
    archivable: () => true
  }
};

function renderManage() {
  for (const [path, config] of Object.entries(MANAGED)) {
    const rows = config.items().map(item => {
      const uses = config.uses(item.id);
      const actions = [['Rename', () => renameManaged(path, item), `Rename ${item.name}`]];
      if (config.archivable(item))
        actions.push([item.archived ? 'Restore' : 'Archive', () => setArchived(path, item, !item.archived), `${item.archived ? 'Restore' : 'Archive'} ${item.name}`]);
      if (!item.isSelf) actions.push(['Delete', () => deleteManaged(path, config, item, uses), `Delete ${item.name}`]);

      const name = item.isSelf ? `${item.name} (you)` : item.name;
      // People, tags, and merchants number their entries; selecting the row lists them.
      const onClick = config.scope ? () => openScopeList(config.scope, item.id) : undefined;
      return { onClick, cells: [`#${item.id}`, name, { text: numberFormat.format(uses), num: true }, item.archived ? 'Archived' : 'Active', rowActionButtons(actions)] };
    });
    renderTable($(config.table), [
      { label: 'ID', title: 'Permanent ID, never reused. Entries are also numbered within each person, tag, and merchant.' },
      { label: 'Name' },
      { label: 'Used By', num: true, title: 'Number of transactions that use it.' },
      { label: 'Status', title: 'Archived items stay on old transactions and in search and stats, but are not offered for new ones.' },
      { label: '' }
    ], rows);
  }
}

async function addManaged(path, form) {
  const input = form.elements.name;
  const name = input.value.trim();
  if (!name) return;
  try {
    await api(`/${path}`, { method: 'POST', body: { name } });
    input.value = '';
    await loadSnapshot();
    setStatus(`Added ${MANAGED[path].singular} ${name}.`);
  } catch (error) {
    showError(error.message);
  }
}

async function renameManaged(path, item) {
  const name = await promptText(`Rename ${MANAGED[path].singular}`, 'New name', item.name, { maxLength: MANAGED[path].maxLength ?? 60 });
  if (name == null || name === item.name) return;
  try {
    await api(`/${path}/${item.id}`, { method: 'PATCH', body: { name } });
    await loadSnapshot();
    setStatus(`Renamed ${item.name} to ${name}.`);
  } catch (error) {
    showError(error.message);
  }
}

async function setArchived(path, item, archived) {
  try {
    await api(`/${path}/${item.id}`, { method: 'PATCH', body: { archived } });
    await loadSnapshot();
    setStatus(`${archived ? 'Archived' : 'Restored'} ${item.name}.`);
  } catch (error) {
    showError(error.message);
  }
}

async function deleteManaged(path, config, item, uses) {
  const consequence = path === 'tags' && uses > 0
    ? ` It will be removed from ${plural(uses, 'transaction')}; the transactions themselves are kept.`
    : '';
  if (!await confirmAction(`Delete ${config.singular}`, `Delete ${item.name}?${consequence}`, 'Delete')) return;
  try {
    await api(`/${path}/${item.id}`, { method: 'DELETE' });
    await loadSnapshot();
    setStatus(`Deleted ${item.name}.`);
  } catch (error) {
    showError(error.message);
  }
}

function initializeManage() {
  $$('form[data-add]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    addManaged(form.dataset.add, form);
  }));
}
