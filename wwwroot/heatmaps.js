/*
 * Stats > Heatmaps, drawn like TaskList Stats' heatmaps: a year of days, months by year, tags or merchants by month,
 * and weekdays by week of the month. The year grid shows each year checked in its dropdown, newest first. Show is a
 * list of check boxes that applies to all four: each heatmap is drawn once per checked measure, under its name. Darker cells hold more; the darkest shade
 * starts at the 90th percentile of the heatmap's cells, so one huge purchase does not wash out every other day. A net
 * of zero or less (refunds only) is the lightest.
 */
import { $, MONTH_NAMES, SCOPE_NAMES, WEEKDAY_NAMES, WEEKDAYS, addDays, compareNames, dayNumber, el, formatDate, formatMoney, formatMonth, keyFromDayNumber, monthOf, numberFormat, pad2, plural, shortMonth, state, tagIdsOf, todayKey, transactionsInRange, weekdayOf } from './app.js';
import { createMultiSelect, createSingleSelect } from './widgets.js';
import { dailyNet, openDayDialog } from './calendar.js';
import { merchantIdsOf } from './summaries.js';
import { openScopeList } from './scopes.js';
import { switchTab } from './ui.js';
import { renderStats } from './stats.js';

const HEAT_MEASURES = [
  { value: 'net', label: 'Net spent', of: bucket => bucket.net },
  { value: 'spent', label: 'Spent', of: bucket => bucket.spent },
  { value: 'refunded', label: 'Refunds', of: bucket => bucket.refunded },
  { value: 'purchases', label: 'Purchases', count: true, of: bucket => bucket.purchases }
];
const HEAT_ROWS = [{ value: 'tags', label: 'Tags' }, { value: 'merchants', label: 'Merchants' }];
const compactMoney = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 });
let heatMeasureSelect = null;
let heatYearSelect = null;
let heatRowsSelect = null;

function heatMeasures() {
  const checked = HEAT_MEASURES.filter(measure => state.heat.measures.includes(measure.value));
  return checked.length ? checked : [HEAT_MEASURES[0]];
}

/** A heatmap per checked measure, each under a title naming it (and the prefix, such as its year) when needed. */
function perMeasure(build, prefix = '') {
  const measures = heatMeasures();
  return measures.flatMap(measure => {
    const title = [prefix, measures.length > 1 ? measure.label : ''].filter(Boolean).join(' · ');
    return [...(title ? [el('div', 'heatmap-title', title)] : []), build(measure)];
  });
}

/** The value that earns the darkest shade: the 90th percentile of the cells holding anything. */
function heatScale(values) {
  const positive = values.filter(value => value > 0).sort((a, b) => a - b);
  return positive.length ? positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.9))] : 0;
}

/** As in TaskList Stats: quarters of the scale, and the lightest shade for nothing. */
function heatClass(value, max) {
  if (!(value > 0)) return 'h0';
  const ratio = value / Math.max(1, max);
  if (ratio <= 0.25) return 'h1';
  if (ratio <= 0.5) return 'h2';
  if (ratio <= 0.75) return 'h3';
  return 'h4';
}

/** A cell's full value for its tooltip, and a short one that fits inside it. */
function heatText(value, measure, { averaged = false } = {}) {
  if (measure.count) return averaged ? value.toFixed(1) : numberFormat.format(value);
  return formatMoney(Math.round(value));
}

function heatShort(value, measure, { averaged = false } = {}) {
  if (!value) return '';
  if (measure.count) return averaged ? value.toFixed(1) : String(value);
  // Whole dollars up to $999, then $1.2K.
  return value < 99950 ? `$${numberFormat.format(Math.round(value / 100))}` : compactMoney.format(value / 100);
}

/** A heatmap square; with onClick it is a button, otherwise a plain cell that cannot be selected. */
function heatCell(className, title, text, onClick) {
  const cell = document.createElement(onClick ? 'button' : 'span');
  if (onClick) {
    cell.type = 'button';
    cell.addEventListener('click', onClick);
  }
  cell.className = `heat ${className}`;
  cell.title = title;
  cell.textContent = text;
  return cell;
}

function heatYears() {
  const today = todayKey();
  const transactions = state.model.transactions;
  const first = Number((transactions[0]?.date ?? today).slice(0, 4));
  const last = Number((transactions.at(-1)?.date ?? today).slice(0, 4));
  const end = Math.max(last, Number(today.slice(0, 4)));
  return Array.from({ length: end - first + 1 }, (_, index) => end - index);
}

/** This year, unless nothing is recorded in it yet; then the latest year with entries. */
function defaultHeatYear() {
  const latest = Number((state.model.transactions.at(-1)?.date ?? todayKey()).slice(0, 4));
  return Math.min(Number(todayKey().slice(0, 4)), latest);
}

export function renderHeatmaps(stats) {
  heatMeasureSelect.setOptions(HEAT_MEASURES, heatMeasures().map(measure => measure.value));
  heatRowsSelect.setOptions(HEAT_ROWS, state.heat.rows);
  const years = heatYears();
  state.heat.years = state.heat.years.filter(year => years.includes(year));
  if (!state.heat.years.length) state.heat.years = [defaultHeatYear()];
  heatYearSelect.setOptions(years.map(year => ({ value: year, label: String(year) })), state.heat.years);

  renderYearHeatmap();
  renderMonthYearHeatmap();
  renderLabelMonthHeatmap(stats);
  renderWeekHeatmap(stats);
}

/** Each checked year, newest first, under its own heading when there are several. */
function renderYearHeatmap() {
  const years = [...state.heat.years].sort((a, b) => b - a);
  $('#yearHeatmap').replaceChildren(...years.flatMap(year => perMeasure(measure => yearGrid(year, measure), years.length > 1 ? String(year) : '')));
}

/** One square per day of a year, a column per week (Sunday first), as on TaskList Stats. */
function yearGrid(year, measure) {
  const days = dailyNet(transactionsInRange(`${year}-01-01`, `${year}-12-31`));
  const max = heatScale([...days.values()].map(measure.of));
  const first = `${year}-01-01`;
  const start = addDays(first, -weekdayOf(first));
  const weeks = Math.ceil((dayNumber(`${year}-12-31`) - dayNumber(start) + 1) / 7);

  const grid = el('div', 'heatmap-grid');
  grid.style.gridTemplateColumns = `42px repeat(${weeks}, 24px)`;
  grid.append(document.createElement('div'));
  for (let week = 0; week < weeks; week++) {
    const key = addDays(start, week * 7);
    const label = el('div', 'heat-month');
    // A month's name sits over the week holding its 1st (or the first week, for January).
    const firstOfMonth = Array.from({ length: 7 }, (_, offset) => addDays(key, offset)).find(day => day.endsWith('-01') && day.startsWith(`${year}-`));
    label.textContent = firstOfMonth ? MONTH_NAMES[Number(firstOfMonth.slice(5, 7)) - 1].slice(0, 3) : '';
    grid.append(label);
  }
  for (let weekday = 0; weekday < 7; weekday++) {
    const label = el('div', 'heat-label');
    label.textContent = WEEKDAYS[weekday];
    grid.append(label);
    for (let week = 0; week < weeks; week++) {
      const key = addDays(start, week * 7 + weekday);
      if (!key.startsWith(`${year}-`)) {
        const blank = el('span', 'heat h0 heat-outside');
        grid.append(blank);
        continue;
      }
      const day = days.get(key);
      const value = day ? measure.of(day) : 0;
      const title = `${WEEKDAY_NAMES[weekdayOf(key)]}, ${formatDate(key)}: ${day ? `${heatText(value, measure)}, ${plural(day.entries, 'entry', 'entries')}` : 'no entries'}`;
      const cell = heatCell(heatClass(value, max), title, measure.count && value ? String(value) : '', day ? () => openDayDialog(key) : null);
      cell.dataset.date = key;
      grid.append(cell);
    }
  }
  return grid;
}

function renderMonthYearHeatmap() {
  $('#monthYearHeatmap').replaceChildren(...perMeasure(monthYearGrid));
}

/** Every month of every year with entries, all time. */
function monthYearGrid(measure) {
  const months = new Map();
  for (const [key, day] of dailyNet(state.model.transactions)) {
    const month = monthOf(key);
    const bucket = months.get(month) ?? { net: 0, spent: 0, refunded: 0, purchases: 0, entries: 0 };
    for (const field of Object.keys(bucket)) bucket[field] += day[field];
    months.set(month, bucket);
  }
  const years = [...new Set([...months.keys()].map(month => month.slice(0, 4)))].sort();
  const max = heatScale([...months.values()].map(measure.of));

  const grid = el('div', 'month-year-grid');
  grid.style.gridTemplateColumns = '58px repeat(12, 56px)';
  grid.append(document.createElement('div'));
  for (const name of MONTH_NAMES) {
    const head = el('div', 'month-year-head');
    head.textContent = name.slice(0, 3);
    grid.append(head);
  }
  for (const year of years) {
    const label = el('div', 'month-year-year');
    label.textContent = year;
    grid.append(label);
    for (let index = 1; index <= 12; index++) {
      const month = `${year}-${pad2(index)}`;
      const bucket = months.get(month);
      const value = bucket ? measure.of(bucket) : 0;
      const open = bucket ? () => {
        state.timeFrame = { all: false, months: [month] };
        switchTab('transactions');
      } : null;
      const title = `${formatMonth(month)}: ${bucket ? `${heatText(value, measure)}, ${plural(bucket.entries, 'entry', 'entries')}` : 'no entries'}`;
      const cell = heatCell(`month-year-cell ${heatClass(value, max)}`, title, heatShort(value, measure), open);
      cell.dataset.month = month;
      grid.append(cell);
    }
  }
  return grid;
}

/** Tags (or merchants) by month, over the months in the period. Refunds count under their purchase's tags and merchant. */
function renderLabelMonthHeatmap(stats) {
  const byMerchant = state.heat.rows === 'merchants';
  $('#labelMonthLegend').textContent = `${byMerchant ? 'Merchants' : 'Tags'} × Month`;
  const idsOf = byMerchant ? merchantIdsOf : tagIdsOf;
  const scope = byMerchant ? 'merchant' : 'tag';
  const months = stats.months.map(month => month.month);
  const cells = new Map();
  for (const tx of stats.transactions) {
    if (tx.kind === 'Payback') continue;
    for (const id of idsOf(tx)) {
      const key = `${id}|${monthOf(tx.date)}`;
      const bucket = cells.get(key) ?? { net: 0, spent: 0, refunded: 0, purchases: 0 };
      if (tx.kind === 'Purchase') {
        bucket.net += tx.amountCents;
        bucket.spent += tx.amountCents;
        bucket.purchases++;
      } else {
        bucket.net -= tx.amountCents;
        bucket.refunded += tx.amountCents;
      }
      cells.set(key, bucket);
    }
  }
  if (!cells.size || !months.length) {
    const empty = el('div', 'note');
    empty.textContent = byMerchant ? 'No purchases at a merchant in this period.' : 'No tagged purchases in this period.';
    $('#labelMonthHeatmap').replaceChildren(empty);
    return;
  }
  $('#labelMonthHeatmap').replaceChildren(...perMeasure(measure => labelMonthGrid(cells, months, scope, measure)));
}

/** Rows ordered by the measure's total, highest first. */
function labelMonthGrid(cells, months, scope, measure) {
  const totals = new Map();
  for (const [key, bucket] of cells) {
    const id = Number(key.split('|')[0]);
    totals.set(id, (totals.get(id) ?? 0) + measure.of(bucket));
  }
  const ids = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a) || compareNames(SCOPE_NAMES[scope](a), SCOPE_NAMES[scope](b)));
  const max = heatScale([...cells.values()].map(measure.of));

  const grid = el('div', 'month-year-grid label-month-grid');
  grid.style.gridTemplateColumns = `minmax(90px, max-content) repeat(${months.length}, 56px)`;
  grid.append(document.createElement('div'));
  for (const month of months) {
    const head = el('div', 'month-year-head', shortMonth(month));
    grid.append(head);
  }
  for (const id of ids) {
    const name = SCOPE_NAMES[scope](id);
    const label = el('div', 'month-year-year label-month-name');
    label.textContent = name;
    label.title = name;
    grid.append(label);
    for (const month of months) {
      const bucket = cells.get(`${id}|${month}`);
      const value = bucket ? measure.of(bucket) : 0;
      const title = `${name}, ${formatMonth(month)}: ${bucket ? heatText(value, measure) : 'nothing'}`;
      grid.append(heatCell(`month-year-cell ${heatClass(value, max)}`, title, heatShort(value, measure), bucket ? () => openScopeList(scope, id, { month }) : null));
    }
  }
  return grid;
}

/** Weekdays by week of the month (days 1–7, 8–14, ...), averaged per day so the short fifth week compares fairly. */
function renderWeekHeatmap(stats) {
  $('#weekHeatmap').replaceChildren(...perMeasure(measure => weekGrid(stats, measure)));
}

function weekGrid(stats, measure) {
  const sums = Array.from({ length: 7 }, () => Array(5).fill(0));
  const occurrences = Array.from({ length: 7 }, () => Array(5).fill(0));
  for (let number = dayNumber(stats.range.start); stats.countedDays > 0 && number <= dayNumber(stats.countedEnd); number++) {
    const key = keyFromDayNumber(number);
    if (!stats.included(key)) continue;
    const week = Math.floor((Number(key.slice(8)) - 1) / 7);
    const weekday = weekdayOf(key);
    occurrences[weekday][week]++;
    const day = stats.days.get(key);
    if (day) sums[weekday][week] += measure.of(day);
  }
  const averages = sums.map((row, weekday) => row.map((sum, week) => (occurrences[weekday][week] ? sum / occurrences[weekday][week] : 0)));
  const max = heatScale(averages.flat());
  const weekLabels = ['1–7', '8–14', '15–21', '22–28', '29–31'];

  const grid = el('div', 'month-year-grid');
  grid.style.gridTemplateColumns = '58px repeat(5, 64px)';
  grid.append(document.createElement('div'));
  for (const label of weekLabels) {
    const head = el('div', 'month-year-head week-head');
    head.textContent = label;
    grid.append(head);
  }
  WEEKDAYS.forEach((name, weekday) => {
    const label = el('div', 'month-year-year');
    label.textContent = name;
    grid.append(label);
    averages[weekday].forEach((value, week) => {
      const count = occurrences[weekday][week];
      const title = `${WEEKDAY_NAMES[weekday]}s on days ${weekLabels[week]}: ${count ? `${heatText(value, measure, { averaged: true })} a day over ${plural(count, 'day')}` : 'none in this period'}`;
      grid.append(heatCell(`month-year-cell week-cell ${heatClass(value, max)}`, title, heatShort(measure.count ? value : Math.round(value), measure, { averaged: true }), null));
    });
  });
  return grid;
}

export function initializeHeatmaps() {
  // Check boxes like Years, applied when the dropdown closes; closing it with none checked goes back to Net spent.
  heatMeasureSelect = createMultiSelect($('#heatMeasure'), {
    deferChange: true,
    summary: names => (names.length > 2 ? `${names.length} measures` : names.join(', ')),
    onChange: values => {
      state.heat.measures = values;
      renderStats();
    }
  });
  // Check boxes, applied when the dropdown closes; closing it with none checked goes back to the usual year.
  heatYearSelect = createMultiSelect($('#heatYear'), {
    deferChange: true,
    summary: names => names.length > 2 ? `${names.length} years` : names.join(', '),
    onChange: values => {
      state.heat.years = values.length ? values.map(Number) : [defaultHeatYear()];
      if (!values.length) heatYearSelect.setOptions(heatYears().map(year => ({ value: year, label: String(year) })), state.heat.years);
      renderYearHeatmap();
    }
  });
  heatRowsSelect = createSingleSelect($('#heatRows'), {
    onChange: value => {
      state.heat.rows = value;
      renderStats();
    }
  });
}
