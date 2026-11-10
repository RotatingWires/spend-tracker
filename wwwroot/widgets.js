/* Reusable Win95-style widgets: menus, single-select dropdowns, tables, stat cards, and modal prompts. */
import { $, $$, el, formatMoney } from './app.js';
import { addListItem } from './manage.js';
import { menuSeparator } from './ui.js';

/*
 * Every dialog puts Cancel first and the confirming button last, on the right, as in TaskList and NewsReview. Cancel
 * is a plain button marked data-close="dialogId", so the confirming button stays the form's default and Enter confirms.
 */
// Buttons marked data-close="dialogId" close that dialog; the same code in every app.
document.addEventListener('click', event => {
  const button = event.target.closest('[data-close]');
  if (button && !button.disabled) document.getElementById(button.dataset.close)?.close(button.value || 'cancel');
});

export function closeMenus() {
  $$('.menu-dropdown').forEach(menu => { menu.hidden = true; });
  $$('[aria-haspopup="menu"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}

export function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) placeMenu(button, menu);
}

export function menuButton(label, { role = 'menuitem', checked = false, onClick }) {
  const button = el('button');
  button.setAttribute('role', role);
  if (role !== 'menuitem') button.setAttribute('aria-checked', checked ? 'true' : 'false');
  const check = el('span', 'menu-check');
  check.setAttribute('aria-hidden', 'true');
  const text = el('span', 'menu-label');
  text.textContent = label;
  button.append(check, text);
  button.addEventListener('click', onClick);
  return button;
}

/**
 * A Win95 dropdown built from a button and a menu, used instead of native <select> to match the theme.
 * Options are [{ value, label }]. Values are compared as strings.
 */
/**
 * Appends "Add New..." to a dropdown menu when onAdd is given. onAdd asks for and creates the item; the caller then
 * refreshes the options with it chosen.
 */
function addNewItem(menu, onAdd) {
  if (!onAdd) return;
  const item = menuButton('Add New...', {
    onClick: event => {
      event.stopPropagation();
      closeMenus();
      onAdd();
    }
  });
  item.classList.add('menu-add-new');
  // The separator only divides it from existing items; an empty list shows just "Add New...".
  if (menu.children.length) menu.append(menuSeparator());
  menu.append(item);
}

/*
 * A dropdown with more than ten choices (merchants, tags, people, months, ...) starts with a filter box, as does one
 * created with searchOver: 0 (Paid with, which people search by card name however few there are): typing
 * narrows the list as you go, ignoring case. It clears each time the dropdown opens and takes focus there, except on
 * touch screens, where focusing would open the keyboard over the list.
 */
const MENU_SEARCH_OVER = 10;

function menuSearch(menu, render, searchOver = MENU_SEARCH_OVER) {
  const box = el('div', 'menu-search');
  const input = el('input');
  input.type = 'search';
  input.className = 'retro-input';
  input.placeholder = 'Search';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Search this list');
  box.append(input);
  const list = el('div', 'menu-list');
  menu.replaceChildren(box, list);
  box.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('input', () => render());
  const query = () => input.value.trim().toLowerCase();
  return {
    list,
    input,
    query,
    matches: text => !query() || text.toLowerCase().includes(query()),
    show(count) {
      box.hidden = count <= searchOver;
      if (box.hidden) input.value = '';
    },
    opened() {
      if (box.hidden) return;
      input.value = '';
      render();
      if (!window.matchMedia('(pointer: coarse)').matches) input.focus();
    }
  };
}

/**
 * With showFirst, only that many options are drawn (the first ones, so a list ordered newest first shows the newest),
 * plus the chosen one; the search box still looks through all of them, and a note says how many more there are.
 */
export function createSingleSelect(host, { onChange = () => {}, onAdd = null, canAdd = () => true, searchOver = MENU_SEARCH_OVER, showFirst = Infinity } = {}) {
  host.classList.add('menu-wrap', 'inline-select-menu');
  const button = el('button', 'retro-select');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const labelledBy = host.getAttribute('aria-labelledby');
  if (labelledBy) button.setAttribute('aria-labelledby', labelledBy);
  const label = el('span');
  const arrow = el('span', 'select-arrow');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '▼';
  button.append(label, arrow);
  const menu = el('div', 'menu-dropdown single-select-dropdown');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  host.replaceChildren(button, menu);

  let options = [];
  let current = '';
  const search = menuSearch(menu, () => render(), searchOver);
  // Enter in the filter box picks the first match.
  search.input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    search.list.querySelector('[role="menuitemradio"]')?.click();
  });

  function render() {
    const selected = options.find(option => option.value === current);
    label.textContent = selected?.label ?? '—';
    button.disabled = options.length === 0 && !(onAdd && canAdd());
    search.show(options.length);
    const matches = options.filter(option => search.matches(option.label));
    const drawn = matches.slice(0, showFirst);
    if (selected && matches.includes(selected) && !drawn.includes(selected)) drawn.push(selected);
    search.list.replaceChildren(...drawn.map(option => menuButton(option.label, {
      role: 'menuitemradio',
      checked: option.value === current,
      onClick: event => {
        event.stopPropagation();
        closeMenus();
        button.focus();
        if (option.value === current) return;
        current = option.value;
        render();
        onChange(current);
      }
    })));
    if (matches.length > drawn.length) {
      const more = matches.length - drawn.length;
      search.list.append(el('div', 'menu-note', search.query()
        ? `${more} more ${more === 1 ? 'match' : 'matches'}. Keep typing to narrow the list.`
        : `Showing the newest ${showFirst} of ${options.length}. Search to find older ones.`));
    }
    if (canAdd()) addNewItem(search.list, onAdd);
  }

  button.addEventListener('click', event => {
    event.stopPropagation();
    toggleMenu(button, menu);
    if (!menu.hidden) search.opened();
  });

  return {
    get value() { return current; },
    set value(value) { current = String(value ?? ''); render(); },
    setOptions(nextOptions, value = current) {
      options = nextOptions.map(option => ({ value: String(option.value), label: String(option.label) }));
      const wanted = String(value ?? '');
      current = options.some(option => option.value === wanted) ? wanted : options[0]?.value ?? '';
      render();
    }
  };
}

/**
 * A Win95 dropdown of check items, like the TaskList Stats list filter. The menu stays open while items are
 * toggled. Options are [{ value, label }]; the button summarizes the selection, by default as a list of labels.
 * With deferChange, onChange runs once when the menu closes instead of on every toggle, so a dialog that rebuilds
 * itself from the choice does not change size under the pointer. With groupOf (value → group name, or null for an
 * ungrouped option), options are nested under group headings that expand and collapse in place, like the years of the
 * Time frame dropdown; a group holding a checked option starts expanded and shows how many are checked.
 */
export function createMultiSelect(host, { empty = 'None', onChange = () => {}, summary = names => names.join(', '), onAdd = null, deferChange = false, groupOf = null, canAdd = () => true, selectAll = false } = {}) {
  host.classList.add('menu-wrap', 'inline-select-menu');
  const button = el('button', 'retro-select');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const labelledBy = host.getAttribute('aria-labelledby');
  if (labelledBy) button.setAttribute('aria-labelledby', labelledBy);
  const label = el('span');
  const arrow = el('span', 'select-arrow');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '▼';
  button.append(label, arrow);
  const menu = el('div', 'menu-dropdown single-select-dropdown multi-select-dropdown');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  host.replaceChildren(button, menu);

  let options = [];
  let selected = new Set();
  let changed = false;
  const expanded = new Set();
  const search = menuSearch(menu, () => render());
  search.input.addEventListener('keydown', event => {
    if (event.key === 'Enter') event.preventDefault();
  });

  function groupHeading(group) {
    const inGroup = options.filter(option => groupOf(option.value) === group);
    const checked = inGroup.filter(option => selected.has(option.value)).length;
    const heading = el('button', 'menu-group');
    heading.setAttribute('role', 'menuitem');
    heading.setAttribute('aria-expanded', String(expanded.has(group) || Boolean(search.query())));
    heading.dataset.group = group;
    const arrow = el('span', 'menu-group-arrow');
    arrow.setAttribute('aria-hidden', 'true');
    const text = el('span', 'menu-label');
    text.textContent = checked ? `${group} (${checked})` : group;
    heading.append(arrow, text);
    heading.addEventListener('click', event => {
      event.stopPropagation();
      if (expanded.has(group)) expanded.delete(group);
      else expanded.add(group);
      render();
      menu.querySelector(`[data-group="${CSS.escape(group)}"]`)?.focus();
    });
    return heading;
  }

  function render() {
    const names = options.filter(option => selected.has(option.value)).map(option => option.label);
    label.textContent = names.length ? summary(names) : empty;
    button.title = label.textContent;
    button.disabled = options.length === 0 && !(onAdd && canAdd());
    search.show(options.length);
    // While filtering, every group with a match shows its matches, open or not.
    const shown = options.filter(option => search.matches(option.label));
    const items = [];
    let lastGroup = null;
    for (const option of shown) {
      const group = groupOf ? groupOf(option.value) : null;
      if (group != null && group !== lastGroup) items.push(groupHeading(group));
      lastGroup = group;
      if (group != null && !expanded.has(group) && !search.query()) continue;
      const item = menuButton(option.label, {
        role: 'menuitemcheckbox',
        checked: selected.has(option.value),
        onClick: event => {
          event.stopPropagation();
          if (selected.has(option.value)) selected.delete(option.value);
          else selected.add(option.value);
          render();
          menu.querySelector(`[data-value="${CSS.escape(option.value)}"]`)?.focus();
          if (deferChange) changed = true;
          else onChange(values());
        }
      });
      item.dataset.value = option.value;
      if (group != null) item.classList.add('menu-grouped');
      items.push(item);
    }
    // With selectAll, "Select All" checks every item the search shows (all of them, with no search).
    if (selectAll && shown.length > 1) {
      const all = menuButton('Select All', {
        onClick: event => {
          event.stopPropagation();
          for (const option of shown) selected.add(option.value);
          render();
          menu.querySelector('.select-all')?.focus();
          if (deferChange) changed = true;
          else onChange(values());
        }
      });
      all.classList.add('select-all');
      items.unshift(all, menuSeparator());
    }
    search.list.replaceChildren(...items);
    if (canAdd()) addNewItem(search.list, onAdd);
  }

  const values = () => options.filter(option => selected.has(option.value)).map(option => option.value);

  button.addEventListener('click', event => {
    event.stopPropagation();
    toggleMenu(button, menu);
    if (!menu.hidden) search.opened();
  });
  menu.addEventListener('click', event => event.stopPropagation());
  // Menus close from many places (closeMenus, Escape, clicks elsewhere), so watch the menu itself.
  if (deferChange) {
    new MutationObserver(() => {
      if (!menu.hidden || !changed) return;
      changed = false;
      onChange(values());
    }).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
  }

  return {
    get values() { return values(); },
    setOptions(nextOptions, chosen = values()) {
      changed = false;
      options = nextOptions.map(option => ({ value: String(option.value), label: String(option.label) }));
      selected = new Set(chosen.map(String).filter(value => options.some(option => option.value === value)));
      // Groups holding a checked option open, so ◀ / ▶ into a new year shows where the choice went.
      if (groupOf) for (const value of selected) if (groupOf(value) != null) expanded.add(groupOf(value));
      render();
    }
  };
}

// ---------------------------------------------------------------- sortable tables
/*
 * Every table sorts by a column when its heading is selected: ascending, then descending, then back to its own order.
 * Money, numbers, dates, and IDs sort by value, other text alphabetically, and empty cells or "—" go last either way.
 * A table keeps its choice until the page reloads. A cell can give its own value as { sort } (a balance whose text says
 * "overpaid", say). A caller that draws only part of its rows (the ledger) sorts them itself: it passes onSort and
 * gives its columns sortValue.
 */
export const tableSorts = new Map();

/** A comparable value for a cell's text: a number (money, counts, #IDs, dates as YYYYMMDD), text, or null. */
function sortValueOf(raw) {
  if (raw == null || typeof raw === 'number') return raw ?? null;
  const text = String(raw).trim();
  if (!text || text === '—') return null;
  const date = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (date) return Number(`${date[3]}${date[1]}${date[2]}`);
  const number = /^([+−-])?\$?(\d[\d,]*(?:\.\d+)?)/.exec(text.replace(/^#/, ''));
  if (number) return (number[1] === '−' || number[1] === '-' ? -1 : 1) * Number(number[2].replace(/,/g, ''));
  return text.toLowerCase();
}

function cellSortValue(cell) {
  if (cell instanceof Node) return sortValueOf(cell.textContent);
  if (cell && typeof cell === 'object') {
    if ('sort' in cell) return cell.sort;
    const content = cell.content ?? cell.text;
    return sortValueOf(content instanceof Node ? content.textContent : content);
  }
  return sortValueOf(cell);
}

/** A sorted copy (stable, so ties keep their order); numbers come before text, and nulls last in both directions. */
export function sortByValue(items, valueOf, direction) {
  const keyed = items.map((item, index) => ({ item, index, value: valueOf(item) }));
  keyed.sort((a, b) => {
    if (a.value == null || b.value == null) return (a.value == null) - (b.value == null) || a.index - b.index;
    const kindA = typeof a.value === 'number' ? 0 : 1;
    const kindB = typeof b.value === 'number' ? 0 : 1;
    const order = kindA - kindB || (kindA === 0 ? a.value - b.value : String(a.value).localeCompare(String(b.value), undefined, { numeric: true }));
    return order * direction || a.index - b.index;
  });
  return keyed.map(entry => entry.item);
}

/** Ascending, then descending, then none, for a heading that was selected. */
function cycleTableSort(key, index) {
  const current = tableSorts.get(key);
  if (!current || current.index !== index) tableSorts.set(key, { index, direction: 1 });
  else if (current.direction === 1) tableSorts.set(key, { index, direction: -1 });
  else tableSorts.delete(key);
}

/**
 * Renders a table. columns: [{ label, num, className, title, sortValue, unsortable }].
 * rows: [{ cells: [string | Node | { text, num, className, title }], onClick(event), className, id, selected }].
 * A click (or Enter) on a row runs onClick, except on a button in it, or at the end of a drag.
 */
export function renderTable(table, columns, rows, options = {}) {
  const { empty = 'Nothing here yet.', footer = null, onSort = null } = options;
  const sortKey = table.id;
  const sort = tableSorts.get(sortKey);
  if (sort && !columns[sort.index]) tableSorts.delete(sortKey);
  const drawn = sort && columns[sort.index] && !onSort ? sortByValue(rows, row => cellSortValue(row.cells[sort.index]), sort.direction) : rows;

  const head = el('thead');
  const headRow = el('tr');
  columns.forEach((column, index) => {
    const th = el('th');
    th.scope = 'col';
    th.textContent = column.label;
    if (column.num) th.className = 'num';
    if (column.className) th.classList.add(column.className);
    if (column.title) th.title = column.title;
    if (column.label && !column.unsortable && rows.length > 1) {
      th.classList.add('sortable');
      th.tabIndex = 0;
      th.setAttribute('aria-sort', sort?.index === index ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none');
      const resort = () => {
        cycleTableSort(sortKey, index);
        if (onSort) onSort();
        else renderTable(table, columns, rows, options);
        table.querySelectorAll('th')[index]?.focus();
      };
      th.addEventListener('click', resort);
      th.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          resort();
        }
      });
    } else if (column.title) {
      th.classList.add('has-tooltip');
    }
    headRow.append(th);
  });
  head.append(headRow);

  const body = el('tbody');
  if (rows.length === 0) {
    const tr = el('tr', 'empty-row');
    const td = el('td');
    td.colSpan = columns.length;
    td.append(Object.assign(document.createElement('span'), { textContent: empty }));
    tr.append(td);
    body.append(tr);
  }
  for (const row of drawn) body.append(tableRow(columns, row));

  table.replaceChildren(head, body);
  if (footer) {
    const foot = el('tfoot');
    foot.append(tableRow(columns, footer));
    table.append(foot);
  }
}

function tableRow(columns, row) {
  const tr = el('tr');
  if (row.className) tr.className = row.className;
  if (row.id != null) tr.dataset.id = String(row.id);
  if (row.selected !== undefined) tr.setAttribute('aria-selected', String(row.selected));
  row.cells.forEach((cell, index) => {
    const td = el('td');
    const spec = cell instanceof Node || typeof cell !== 'object' || cell === null ? { content: cell } : cell;
    if (columns[index]?.num || spec.num) td.classList.add('num');
    if (spec.className) td.classList.add(...spec.className.split(' '));
    if (spec.title) td.title = spec.title;
    const content = spec.content ?? spec.text ?? '';
    if (content instanceof Node) td.append(content);
    else td.textContent = String(content);
    tr.append(td);
  });
  if (row.onClick) {
    tr.classList.add('clickable');
    tr.tabIndex = 0;
    // A drag (to select text and copy it) is not a click on the row.
    let pressedAt = null;
    tr.addEventListener('pointerdown', event => { pressedAt = [event.clientX, event.clientY]; });
    tr.addEventListener('click', event => {
      const dragged = pressedAt && Math.hypot(event.clientX - pressedAt[0], event.clientY - pressedAt[1]) > 5;
      // A row's own check box (selection mode) toggles through this click; buttons in it do their own thing.
      if (event.target.closest('button') || dragged) return;
      row.onClick(event);
    });
    tr.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === tr && !event.repeat) {
        event.preventDefault();
        row.onClick(event);
      }
    });
  }
  return tr;
}

/**
 * A search box and its Search button. As in NewsReview, the search runs on the button, Enter, or leaving the box after
 * changing it, never while typing; running the same search again is skipped.
 */
export function bindSearchForm(form, run) {
  const input = form.querySelector('input');
  let applied = input.value.trim();
  const apply = () => {
    const query = input.value.trim();
    if (query === applied) return;
    applied = query;
    run(query);
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    apply();
  });
  input.addEventListener('change', apply);
  return {
    /** Empties the box without running a search (the caller resets what it searched for). */
    clear() {
      input.value = '';
      applied = '';
    }
  };
}

export function statCard(label, value, { sub = '', title = '' } = {}) {
  const card = el('div', 'stat-card');
  const labelElement = el('div', 'label');
  labelElement.textContent = label;
  if (title) {
    labelElement.title = title;
    labelElement.classList.add('has-tooltip');
    labelElement.tabIndex = 0;
  }
  const valueElement = el('div', 'value');
  valueElement.textContent = value;
  card.append(labelElement, valueElement);
  if (sub) {
    const subElement = el('div', 'sub');
    subElement.textContent = sub;
    card.append(subElement);
  }
  return card;
}

/** Fills a .metric-list with [label, value, tooltip?] rows. */
export function renderMetrics(container, metrics) {
  container.replaceChildren();
  for (const [label, value, title] of metrics) {
    const labelElement = el('div', 'metric-label');
    labelElement.textContent = label;
    if (title) {
      labelElement.title = title;
      labelElement.classList.add('has-tooltip');
      labelElement.tabIndex = 0;
    }
    const valueElement = el('div', 'metric-value');
    valueElement.textContent = value;
    container.append(labelElement, valueElement);
  }
}

export function moneyCell(cents, { direction = 'out', className = '' } = {}) {
  const text = direction === 'in' ? `+${formatMoney(cents)}` : direction === 'refund' ? `−${formatMoney(cents)}` : formatMoney(cents);
  return { text, num: true, className: [direction === 'out' ? '' : 'money-in', className].filter(Boolean).join(' ') };
}

export function rowActionButtons(actions) {
  const wrap = el('div', 'row-actions');
  for (const [label, onClick, ariaLabel] of actions) {
    const button = el('button');
    button.textContent = label;
    if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', event => {
      event.stopPropagation();
      onClick();
    });
    wrap.append(button);
  }
  return wrap;
}

/** Asks before an action. detail adds a scrollable list, such as the selected entries; notice: true shows only OK. */
export function confirmAction(title, message, okLabel = 'OK', { detail = '', notice = false } = {}) {
  const dialog = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmDetail').textContent = detail;
  $('#confirmDetail').hidden = !detail;
  $('#confirmCancelButton').hidden = notice;
  $('#confirmOkButton').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

/** Asks for a line of text. maxLength matches the server's limit for that field. */
export function promptText(title, label, value = '', { maxLength = 60 } = {}) {
  const dialog = $('#promptDialog');
  const input = $('#promptInput');
  $('#promptTitle').textContent = title;
  $('#promptLabel').textContent = label;
  input.maxLength = maxLength;
  input.value = value;
  dialog.returnValue = '';
  dialog.showModal();
  input.select();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null), { once: true });
  });
}

/**
 * Asks the user to pick from a Win95 dropdown: one option, or with multiple: true any number of check items. With
 * modes (such as Add / Remove), a "Change" dropdown comes first. Resolves to the chosen value (an array of values
 * when multiple), or { value, mode } when modes are given; null if cancelled or nothing was checked. With addPath
 * ("people", "tags", ...), the dropdown ends with "Add New...", which adds one and chooses it.
 */
let choiceSelect = null;
let choiceChecks = null;
let modeSelect = null;
let choiceAdd = null;
export function chooseOption(title, label, options, okLabel = 'OK', { modes = null, multiple = false, addPath = null } = {}) {
  const dialog = $('#chooseDialog');
  const addOptions = { onAdd: () => choiceAdd?.(), canAdd: () => Boolean(choiceAdd) };
  choiceSelect ??= createSingleSelect($('#chooseSelect'), addOptions);
  choiceChecks ??= createMultiSelect($('#chooseMulti'), { empty: 'Choose one or more', selectAll: true, ...addOptions });
  choiceAdd = addPath ? async () => {
    const created = await addListItem(addPath);
    if (!created) return;
    options = [...options, { value: created.id, label: created.name }];
    if (multiple) choiceChecks.setOptions(options, [...choiceChecks.values, created.id]);
    else choiceSelect.setOptions(options, created.id);
  } : null;
  modeSelect ??= createSingleSelect($('#chooseMode'));
  $('#chooseTitle').textContent = title;
  $('#chooseLabel').textContent = label;
  $('#chooseOkButton').textContent = okLabel;
  $('#chooseModeLabel').hidden = !modes;
  $('#chooseMode').hidden = !modes;
  $('#chooseSelect').hidden = multiple;
  $('#chooseMulti').hidden = !multiple;
  modeSelect.setOptions(modes ?? [], modes?.[0]?.value ?? null);
  if (multiple) choiceChecks.setOptions(options, []);
  else choiceSelect.setOptions(options, options[0]?.value ?? null);
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const value = multiple ? choiceChecks.values : choiceSelect.value;
      choiceAdd = null;
      if (dialog.returnValue !== 'ok' || value.length === 0) resolve(null);
      else resolve(modes ? { value, mode: modeSelect.value } : value);
    }, { once: true });
  });
}

/** Errors show in the status bar, like TaskList's; an empty message clears an error still showing there. */
export function showError(message) {
  const status = $('#statusLeft');
  if (message) {
    status.textContent = `Error: ${message}`;
    status.dataset.error = '';
  } else if ('error' in status.dataset) {
    setStatus('Ready');
  }
}

export function setStatus(message) {
  const status = $('#statusLeft');
  status.textContent = message;
  delete status.dataset.error;
}
