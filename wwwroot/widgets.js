'use strict';

/* Reusable Win95-style widgets: menus, single-select dropdowns, tables, stat cards, and modal prompts. */

function closeMenus() {
  $$('.menu-dropdown').forEach(menu => { menu.hidden = true; });
  $$('[aria-haspopup="menu"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function menuButton(label, { role = 'menuitem', checked = false, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', role);
  if (role !== 'menuitem') button.setAttribute('aria-checked', checked ? 'true' : 'false');
  const check = document.createElement('span');
  check.className = 'menu-check';
  check.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'menu-label';
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

function createSingleSelect(host, { onChange = () => {}, onAdd = null } = {}) {
  host.classList.add('menu-wrap', 'inline-select-menu');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'retro-select';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const labelledBy = host.getAttribute('aria-labelledby');
  if (labelledBy) button.setAttribute('aria-labelledby', labelledBy);
  const label = document.createElement('span');
  const arrow = document.createElement('span');
  arrow.className = 'select-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '▼';
  button.append(label, arrow);
  const menu = document.createElement('div');
  menu.className = 'menu-dropdown single-select-dropdown';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  host.replaceChildren(button, menu);

  let options = [];
  let current = '';

  function render() {
    const selected = options.find(option => option.value === current);
    label.textContent = selected?.label ?? '—';
    button.disabled = options.length === 0 && !onAdd;
    menu.replaceChildren(...options.map(option => menuButton(option.label, {
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
    addNewItem(menu, onAdd);
  }

  button.addEventListener('click', event => {
    event.stopPropagation();
    toggleMenu(button, menu);
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
function createMultiSelect(host, { empty = 'None', onChange = () => {}, summary = names => names.join(', '), onAdd = null, deferChange = false, groupOf = null } = {}) {
  host.classList.add('menu-wrap', 'inline-select-menu');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'retro-select';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const labelledBy = host.getAttribute('aria-labelledby');
  if (labelledBy) button.setAttribute('aria-labelledby', labelledBy);
  const label = document.createElement('span');
  const arrow = document.createElement('span');
  arrow.className = 'select-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '▼';
  button.append(label, arrow);
  const menu = document.createElement('div');
  menu.className = 'menu-dropdown single-select-dropdown multi-select-dropdown';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  host.replaceChildren(button, menu);

  let options = [];
  let selected = new Set();
  let changed = false;
  const expanded = new Set();

  function groupHeading(group) {
    const inGroup = options.filter(option => groupOf(option.value) === group);
    const checked = inGroup.filter(option => selected.has(option.value)).length;
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'menu-group';
    heading.setAttribute('role', 'menuitem');
    heading.setAttribute('aria-expanded', String(expanded.has(group)));
    heading.dataset.group = group;
    const arrow = document.createElement('span');
    arrow.className = 'menu-group-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'menu-label';
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
    button.disabled = options.length === 0 && !onAdd;
    const items = [];
    let lastGroup = null;
    for (const option of options) {
      const group = groupOf ? groupOf(option.value) : null;
      if (group != null && group !== lastGroup) items.push(groupHeading(group));
      lastGroup = group;
      if (group != null && !expanded.has(group)) continue;
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
    menu.replaceChildren(...items);
    addNewItem(menu, onAdd);
  }

  const values = () => options.filter(option => selected.has(option.value)).map(option => option.value);

  button.addEventListener('click', event => {
    event.stopPropagation();
    toggleMenu(button, menu);
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

/**
 * Renders a table. columns: [{ label, num, title }].
 * rows: [{ cells: [string | Node | { text, num, className, title }], onClick(event), onDoubleClick(event), className, id, selected }].
 * onDoubleClick opens on a double click (or Enter) instead, for rows a stray click should not open.
 */
function renderTable(table, columns, rows, { empty = 'Nothing here yet.', footer = null } = {}) {
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column.label;
    if (column.num) th.className = 'num';
    if (column.title) {
      th.title = column.title;
      th.classList.add('has-tooltip');
    }
    headRow.append(th);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = columns.length;
    td.textContent = empty;
    tr.append(td);
    body.append(tr);
  }
  for (const row of rows) body.append(tableRow(columns, row));

  table.replaceChildren(head, body);
  if (footer) {
    const foot = document.createElement('tfoot');
    foot.append(tableRow(columns, footer));
    table.append(foot);
  }
}

function tableRow(columns, row) {
  const tr = document.createElement('tr');
  if (row.className) tr.className = row.className;
  if (row.id != null) tr.dataset.id = String(row.id);
  if (row.selected !== undefined) tr.setAttribute('aria-selected', String(row.selected));
  row.cells.forEach((cell, index) => {
    const td = document.createElement('td');
    const spec = cell instanceof Node || typeof cell !== 'object' || cell === null ? { content: cell } : cell;
    if (columns[index]?.num || spec.num) td.classList.add('num');
    if (spec.className) td.classList.add(...spec.className.split(' '));
    if (spec.title) td.title = spec.title;
    const content = spec.content ?? spec.text ?? '';
    if (content instanceof Node) td.append(content);
    else td.textContent = String(content);
    tr.append(td);
  });
  if (row.onClick || row.onDoubleClick) {
    tr.classList.add('clickable');
    tr.tabIndex = 0;
    if (row.onClick) {
      tr.addEventListener('click', event => {
        if (!event.target.closest('button')) row.onClick(event);
      });
    }
    if (row.onDoubleClick) {
      tr.addEventListener('dblclick', event => {
        if (event.target.closest('button, input')) return;
        window.getSelection()?.removeAllRanges(); // a double click selects a word; opening the editor should not
        row.onDoubleClick(event);
      });
    }
    tr.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === tr && !event.repeat) {
        event.preventDefault();
        (row.onClick ?? row.onDoubleClick)(event);
      }
    });
  }
  return tr;
}

/** A search box and its Search button: the search runs on the button or Enter, never while typing. */
function bindSearchForm(form, run) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(form.querySelector('input').value.trim());
  });
}

function statCard(label, value, { sub = '', title = '' } = {}) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  const labelElement = document.createElement('div');
  labelElement.className = 'label';
  labelElement.textContent = label;
  if (title) {
    labelElement.title = title;
    labelElement.classList.add('has-tooltip');
    labelElement.tabIndex = 0;
  }
  const valueElement = document.createElement('div');
  valueElement.className = 'value';
  valueElement.textContent = value;
  card.append(labelElement, valueElement);
  if (sub) {
    const subElement = document.createElement('div');
    subElement.className = 'sub';
    subElement.textContent = sub;
    card.append(subElement);
  }
  return card;
}

/** Fills a .metric-list with [label, value, tooltip?] rows. */
function renderMetrics(container, metrics) {
  container.replaceChildren();
  for (const [label, value, title] of metrics) {
    const labelElement = document.createElement('div');
    labelElement.className = 'metric-label';
    labelElement.textContent = label;
    if (title) {
      labelElement.title = title;
      labelElement.classList.add('has-tooltip');
      labelElement.tabIndex = 0;
    }
    const valueElement = document.createElement('div');
    valueElement.className = 'metric-value';
    valueElement.textContent = value;
    container.append(labelElement, valueElement);
  }
}

function moneyCell(cents, { direction = 'out', className = '' } = {}) {
  const text = direction === 'in' ? `+${formatMoney(cents)}` : direction === 'refund' ? `−${formatMoney(cents)}` : formatMoney(cents);
  return { text, num: true, className: [direction === 'out' ? '' : 'money-in', className].filter(Boolean).join(' ') };
}

function rowActionButtons(actions) {
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';
  for (const [label, onClick, ariaLabel] of actions) {
    const button = document.createElement('button');
    button.type = 'button';
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
function confirmAction(title, message, okLabel = 'OK', { detail = '', notice = false } = {}) {
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
function promptText(title, label, value = '', { maxLength = 60 } = {}) {
  const dialog = $('#promptDialog');
  const input = $('#promptInput');
  $('#promptTitle').textContent = title;
  $('#promptLabel').textContent = label;
  input.maxLength = maxLength;
  input.value = value;
  dialog.returnValue = '';
  // Enter saves: Cancel comes first in the button row, so the form's default submit would cancel.
  input.onkeydown = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    dialog.close('ok');
  };
  dialog.showModal();
  input.select();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null), { once: true });
  });
}

/**
 * Asks the user to pick from a Win95 dropdown: one option, or with multiple: true any number of check items. With
 * modes (such as Add / Remove), a "Change" dropdown comes first. Resolves to the chosen value (an array of values
 * when multiple), or { value, mode } when modes are given; null if cancelled or nothing was checked.
 */
let choiceSelect = null;
let choiceChecks = null;
let modeSelect = null;
function chooseOption(title, label, options, okLabel = 'OK', { modes = null, multiple = false } = {}) {
  const dialog = $('#chooseDialog');
  choiceSelect ??= createSingleSelect($('#chooseSelect'));
  choiceChecks ??= createMultiSelect($('#chooseMulti'), { empty: 'Choose one or more' });
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
      if (dialog.returnValue !== 'ok' || value.length === 0) resolve(null);
      else resolve(modes ? { value, mode: modeSelect.value } : value);
    }, { once: true });
  });
}

function showError(message) {
  const panel = $('#errorPanel');
  panel.textContent = message;
  panel.hidden = !message;
}

function setStatus(message) {
  $('#statusLeft').textContent = message;
}
