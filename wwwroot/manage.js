/*
 * Adding, renaming, archiving, and deleting payment methods, people, tags, collections, and merchants, and a merchant's
 * aliases. Each has its own tab with an Add form at the top; these actions sit in the dialog a row opens.
 */
import { $, $$, api, applyListItem, plural, state } from './app.js';
import { bindSearchForm, confirmAction, promptText, rowActionButtons, setStatus, showError } from './widgets.js';
import { renderPeople } from './people.js';
import { renderCollectionsTab, renderMerchantsTab, renderMethodsTab, renderTagsTab } from './summaries.js';
import { loadSnapshot } from './ui.js';

const MANAGED = {
  'payment-methods': { singular: 'payment method', archivable: () => true },
  people: { singular: 'person', archivable: item => !item.isSelf },
  tags: { singular: 'tag', archivable: () => true, removesFromEntries: true },
  collections: { singular: 'collection', archivable: () => true, removesFromEntries: true },
  merchants: { singular: 'merchant', maxLength: 120, archivable: () => true }
};

/** Rename, Archive or Restore, and Delete buttons (and a merchant's Aliases) for one item's dialog, after any leading ones; you can only rename yourself. */
export function manageButtons(path, item, uses, leading = []) {
  const config = MANAGED[path];
  const actions = [...leading, ['Rename', () => renameManaged(path, item), `Rename ${item.name}`]];
  if (path === 'merchants') actions.push(['Aliases...', () => editAliases(item), `Edit the aliases of ${item.name}`]);
  if (config.archivable(item))
    actions.push([item.archived ? 'Restore' : 'Archive', () => setArchived(path, item, !item.archived), `${item.archived ? 'Restore' : 'Archive'} ${item.name}`]);
  if (!item.isSelf) actions.push(['Delete', () => deleteManaged(path, config, item, uses), `Delete ${item.name}`]);
  return rowActionButtons(actions);
}

async function addManaged(path, form) {
  const input = form.elements.name;
  const name = input.value.trim();
  if (!name) return;
  try {
    const created = await api(`/${path}`, { method: 'POST', body: { name } });
    input.value = '';
    applyListItem(path, created);
    setStatus(`Added ${MANAGED[path].singular} ${name}.`);
  } catch (error) {
    showError(error.message);
  }
}

/** Asks for a name and adds a payment method, person, tag, merchant, or collection; resolves to it, or null. */
export async function addListItem(path) {
  const config = MANAGED[path];
  const name = await promptText(`New ${config.singular}`, 'Name', '', { maxLength: config.maxLength ?? 60 });
  if (!name) return null;
  try {
    const created = await api(`/${path}`, { method: 'POST', body: { name } });
    applyListItem(path, created);
    setStatus(`Added ${config.singular} ${created.name}.`);
    return created;
  } catch (error) {
    await confirmAction(`New ${config.singular}`, error.message, 'OK', { notice: true });
    return null;
  }
}

async function renameManaged(path, item) {
  const name = await promptText(`Rename ${MANAGED[path].singular}`, 'New name', item.name, { maxLength: MANAGED[path].maxLength ?? 60 });
  if (name == null || name === item.name) return;
  try {
    applyListItem(path, await api(`/${path}/${item.id}`, { method: 'PATCH', body: { name } }));
    setStatus(`Renamed ${item.name} to ${name}.`);
  } catch (error) {
    showError(error.message);
  }
}

let aliasesMerchant = null;

function editAliases(merchant) {
  aliasesMerchant = merchant;
  $('#aliasesTitle').textContent = `Aliases of ${merchant.name}`;
  $('#aliasesInput').value = merchant.aliases.join('\n');
  $('#aliasesError').textContent = '';
  $('#aliasesDialog').showModal();
  $('#aliasesInput').focus();
}

// The dialog stays open when the server refuses a list, so the message shows beside what was typed.
async function saveAliases() {
  const merchant = aliasesMerchant;
  const aliases = $('#aliasesInput').value.split('\n').map(alias => alias.trim()).filter(Boolean);
  $('#aliasesSaveButton').disabled = true;
  $('#aliasesError').textContent = '';
  try {
    const saved = await api(`/merchants/${merchant.id}/aliases`, { method: 'PUT', body: { aliases } });
    $('#aliasesDialog').close();
    applyListItem('merchants', saved);
    setStatus(saved.aliases.length ? `${merchant.name} has ${plural(saved.aliases.length, 'alias', 'aliases')}.` : `${merchant.name} has no aliases.`);
  } catch (error) {
    $('#aliasesError').textContent = error.message;
  } finally {
    $('#aliasesSaveButton').disabled = false;
  }
}

async function setArchived(path, item, archived) {
  try {
    applyListItem(path, await api(`/${path}/${item.id}`, { method: 'PATCH', body: { archived } }));
    setStatus(`${archived ? 'Archived' : 'Restored'} ${item.name}.`);
  } catch (error) {
    showError(error.message);
  }
}

async function deleteManaged(path, config, item, uses) {
  const consequence = config.removesFromEntries && uses > 0
    ? ` It will be removed from ${plural(uses, 'transaction')}; the transactions themselves are kept.`
    : '';
  if (!await confirmAction(`Delete ${config.singular}`, `Delete ${item.name}?${consequence}`, 'Delete')) return;
  try {
    await api(`/${path}/${item.id}`, { method: 'DELETE' });
    // Deleting a tag or collection takes it off every entry, so everything is loaded again.
    await loadSnapshot();
    setStatus(`Deleted ${item.name}.`);
  } catch (error) {
    showError(error.message);
  }
}

export function initializeManage() {
  $('#aliasesForm').addEventListener('submit', event => {
    event.preventDefault();
    saveAliases();
  });
  $$('form[data-add]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    addManaged(form.dataset.add, form);
  }));
  const renderers = { people: renderPeople, methods: renderMethodsTab, tags: renderTagsTab, collections: renderCollectionsTab, merchants: renderMerchantsTab };
  $$('form[data-search]').forEach(form => bindSearchForm(form, query => {
    state.listQueries[form.dataset.search] = query;
    renderers[form.dataset.search]();
  }));
}
