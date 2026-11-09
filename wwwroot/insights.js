'use strict';

/*
 * Stats > Trends (running total, average by month of year, purchase sizes, months), Compare (two periods side by side),
 * and People & Places (breakdowns, balances over time, merchant loyalty, recurring purchases). Like the rest of
 * Stats, everything comes from recorded entries; recurring purchases are found from exact repeats only.
 */

// ---------------------------------------------------------------- Trends

/** The period just before a single month or year, for the running total's comparison line; none otherwise. */
function previousPeriod(periods) {
  if (periods.length !== 1) return null;
  const [period] = periods;
  if (period.startsWith('m:')) return `m:${shiftMonth(period.slice(2), -1)}`;
  if (period.startsWith('y:')) return `y:${Number(period.slice(2)) - 1}`;
  return null;
}

/** Day keys from start to end that the period includes. */
function periodDays(start, end, included = () => true) {
  const keys = [];
  for (let number = dayNumber(start); number <= dayNumber(end); number++) {
    const key = keyFromDayNumber(number);
    if (included(key)) keys.push(key);
  }
  return keys;
}

function runningTotals(keys, days, stopAfter = null) {
  let total = 0;
  return keys.map(key => {
    if (stopAfter && key > stopAfter) return null;
    total += days.get(key)?.net ?? 0;
    return total;
  });
}

function renderTrends(stats) {
  renderStatsChart(stats);
  renderRunningTotal(stats);
  renderSeasonChart(stats);
  renderSizes(stats);
  renderMonthsTable(stats);
}

function renderRunningTotal(stats) {
  const keys = periodDays(stats.range.start, stats.range.end, stats.included);
  const span = keys.length;
  const spansYears = keys.length && keys[0].slice(0, 4) !== keys.at(-1).slice(0, 4);
  // Day numbers for a month, "Mar 5" within a year, and month names on the 1st across years.
  const label = key => (span <= 62 ? String(Number(key.slice(8)))
    : spansYears ? (key.endsWith('-01') ? `${MONTH_NAMES[Number(key.slice(5, 7)) - 1].slice(0, 3)} ${key.slice(2, 4)}` : '')
      : `${MONTH_NAMES[Number(key.slice(5, 7)) - 1].slice(0, 3)} ${Number(key.slice(8))}`);
  const money = value => formatMoney(Math.round(value));
  const series = [{ label: stats.range.label, color: 1, format: money, values: runningTotals(keys, stats.days, stats.countedEnd) }];

  const previous = previousPeriod(state.statsPeriod);
  let previousKeys = [];
  if (previous) {
    const range = periodRange(previous);
    previousKeys = periodDays(range.start, range.end);
    const values = runningTotals(previousKeys, dailyNet(transactionsInRange(range.start, range.end)));
    series.push({ label: range.label, color: 3, dashed: true, format: money, values: keys.map((_, index) => values[index] ?? null) });
  }
  const titles = keys.map((key, index) => formatDate(key) + (previousKeys[index] ? ` · ${formatDate(previousKeys[index])}` : ''));
  $('#runningKey').replaceChildren(...series.map(s => {
    const item = el('span', 'chart-key-item');
    const swatch = el('span', `chart-swatch series-${s.color}${s.dashed ? ' dashed' : ''}`);
    item.append(swatch, s.label);
    return item;
  }));
  Charts.lines($('#runningChart'), { labels: keys.map(label), titles, series });

  let note = 'Net spent added up day by day through the period.';
  if (previous) {
    // Compare at the last day counted so far, so a month in progress is measured against the same point last time.
    const index = series[0].values.findLastIndex(value => value != null);
    const now = series[0].values[index];
    // A shorter period before (February before March) had already ended by then, so its final total stands.
    const then = series[1].values[index] ?? series[1].values.findLast(value => value != null);
    if (now != null && then != null) {
      const difference = now - then;
      note = `By ${span <= 62 ? `day ${index + 1}` : formatDate(keys[index])}: ${money(now)}, ${difference === 0 ? 'the same as' : `${money(Math.abs(difference))} ${difference > 0 ? 'more than' : 'less than'}`} ${series[1].label} at the same point (${money(then)}). The dashed line is ${series[1].label}.`;
    }
  } else {
    note += ' Choose a single month or year as the period to compare it with the one before.';
  }
  $('#runningNote').textContent = note;
}

function renderSeasonChart(stats) {
  const totals = Array(12).fill(0);
  const counts = Array(12).fill(0);
  for (const month of stats.months) {
    const index = Number(month.month.slice(5)) - 1;
    totals[index] += month.net;
    counts[index]++;
  }
  drawTimeChart($('#seasonChart'), {
    labels: MONTH_NAMES.map(name => name.slice(0, 3)),
    titles: MONTH_NAMES.map((name, index) => `${name} (${counts[index] ? plural(counts[index], 'year') : 'not in the period'})`),
    series: [{ label: 'Average net spent', color: 1, format: value => formatMoney(Math.round(value)), values: totals.map((total, index) => (counts[index] ? total / counts[index] : 0)) }]
  });
}

const SIZE_BUCKETS = [
  { label: 'Under $10', below: 1000 },
  { label: '$10 – $25', below: 2500 },
  { label: '$25 – $50', below: 5000 },
  { label: '$50 – $100', below: 10000 },
  { label: '$100 – $250', below: 25000 },
  { label: '$250 and up', below: Infinity }
];

/** The value at a fraction through a sorted list, halfway between neighbors when it falls between two. */
function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (position - low));
}

function renderSizes(stats) {
  const amounts = stats.purchases.map(tx => tx.amountCents).sort((a, b) => a - b);
  const buckets = SIZE_BUCKETS.map(bucket => ({ ...bucket, count: 0, spent: 0 }));
  for (const amount of amounts) {
    const bucket = buckets.find(entry => amount < entry.below);
    bucket.count++;
    bucket.spent += amount;
  }
  renderTable($('#sizeTable'),
    [{ label: 'Size' }, { label: 'Purchases', num: true }, { label: 'Share', num: true, title: 'Share of purchases.' }, { label: 'Spent', num: true }, { label: 'Share of Spent', num: true }],
    buckets.map(bucket => ({ cells: [bucket.label, numberFormat.format(bucket.count), share(bucket.count, amounts.length), formatMoney(bucket.spent), share(bucket.spent, stats.spent)] })));
  const money = cents => (cents == null ? '—' : formatMoney(cents));
  renderMetrics($('#sizeSummary'), [
    ['Smallest purchase', money(amounts[0]), 'The single smallest purchase in this period.'],
    ['Median purchase', money(percentile(amounts, 0.5)), 'Half of purchases cost less than this and half cost more. Unlike the average, a few big purchases do not pull it up.'],
    ['Average purchase', averageMoney(stats.spent, amounts.length), 'Spent divided by the number of purchases.'],
    ['Middle half', amounts.length ? `${money(percentile(amounts, 0.25))} – ${money(percentile(amounts, 0.75))}` : '—', 'The middle 50% of purchases cost between these amounts.'],
    ['Largest purchase', money(amounts.at(-1)), 'The single biggest purchase in this period.']
  ]);
}

// ---------------------------------------------------------------- Compare

let compareASelect = null;
let compareBSelect = null;

function signedMoney(cents) {
  return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatMoney(Math.abs(cents))}`;
}

function signedNumber(value) {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${numberFormat.format(Math.abs(value))}`;
}

function changeText(a, b) {
  if (a == null || b == null || b === 0) return '—';
  const change = (a - b) / Math.abs(b);
  return `${change > 0 ? '+' : change < 0 ? '−' : ''}${percentFormat.format(Math.abs(change))}`;
}

function renderCompare() {
  const options = statsPeriodOptions();
  const has = value => options.some(option => option.value === value);
  const thisMonth = monthOf(todayKey());
  // This month against last month, until other periods are chosen.
  if (!has(state.compare.a)) state.compare.a = has(`m:${thisMonth}`) ? `m:${thisMonth}` : options[1]?.value ?? 'all';
  if (!has(state.compare.b)) state.compare.b = has(`m:${shiftMonth(thisMonth, -1)}`) ? `m:${shiftMonth(thisMonth, -1)}` : options[2]?.value ?? 'all';
  compareASelect.setOptions(options, state.compare.a);
  compareBSelect.setOptions(options, state.compare.b);
  const a = computeStats(periodRange(state.compare.a));
  const b = computeStats(periodRange(state.compare.b));

  const rows = [
    ['Spent', stats => stats.spent],
    ['Refunds', stats => stats.refunded],
    ['Net spent', stats => stats.net],
    ['Purchases', stats => stats.purchases.length, true],
    ['Average purchase', stats => (stats.purchases.length ? Math.round(stats.spent / stats.purchases.length) : null)],
    ['Average per day', stats => (stats.countedDays ? Math.round(stats.net / stats.countedDays) : null)],
    ['Days counted', stats => stats.countedDays, true],
    ['Spending days', stats => stats.spendingDays, true],
    ['No-spend days', stats => stats.noSpendDays, true],
    ['Paid back to you', stats => stats.paidBack],
    ['Spent for others', stats => stats.forOthers],
    ['Largest purchase', stats => stats.largest?.amountCents ?? null]
  ];
  renderTable($('#compareTable'),
    [{ label: 'Measure' }, { label: `A: ${a.range.label}`, num: true }, { label: `B: ${b.range.label}`, num: true }, { label: 'A − B', num: true }, { label: 'Change', num: true, title: 'A − B as a share of B.' }],
    rows.map(([label, of, count]) => {
      const valueA = of(a);
      const valueB = of(b);
      const format = value => (value == null ? '—' : count ? numberFormat.format(value) : formatMoney(value));
      const difference = valueA == null || valueB == null ? '—' : count ? signedNumber(valueA - valueB) : signedMoney(valueA - valueB);
      return { cells: [label, format(valueA), format(valueB), difference, changeText(valueA, valueB)] };
    }));
  renderCompareGroups($('#compareTagsTable'), 'Tag', 'tag', a.byTag, b.byTag, 'Untagged');
  renderCompareGroups($('#compareMerchantsTable'), 'Merchant', 'merchant', a.byMerchant, b.byMerchant, '(no merchant)');
}

/** Net spent per tag or merchant in both periods, the biggest change first. */
function renderCompareGroups(table, label, scope, groupsA, groupsB, none) {
  const net = group => (group ? group.spent - group.refunded : 0);
  const ids = [...new Set([...groupsA.keys(), ...groupsB.keys()])];
  const rows = ids
    .map(id => ({ id, a: net(groupsA.get(id)), b: net(groupsB.get(id)) }))
    .filter(row => row.a || row.b)
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b))
    .map(row => ({
      onClick: row.id == null ? undefined : () => openScopeList(scope, row.id),
      cells: [row.id == null ? none : SCOPE_NAMES[scope](row.id), formatMoney(row.a), formatMoney(row.b), signedMoney(row.a - row.b), changeText(row.a, row.b)]
    }));
  renderTable(table, [{ label }, { label: 'A Net', num: true }, { label: 'B Net', num: true }, { label: 'A − B', num: true }, { label: 'Change', num: true }], rows,
    { empty: 'No purchases or refunds in either period.' });
}

function initializeCompare() {
  compareASelect = createSingleSelect($('#compareA'), {
    onChange: value => {
      state.compare.a = value;
      renderCompare();
    }
  });
  compareBSelect = createSingleSelect($('#compareB'), {
    onChange: value => {
      state.compare.b = value;
      renderCompare();
    }
  });
}

// ---------------------------------------------------------------- People & Places

function renderPlaces(stats) {
  renderBreakdowns(stats);
  renderBalancesOverTime(stats);
  renderLoyalty(stats);
  renderRecurring();
}

/** Each other person's balance at the end of every month in the period, counting all earlier history too. */
function renderBalancesOverTime(stats) {
  const months = stats.months.map(month => month.month);
  const today = todayKey();
  const people = state.snapshot.people.filter(person => !person.isSelf);
  const before = months.length ? monthEnd(shiftMonth(months[0], -1)) : null;
  const rows = people.map(person => {
    const balances = months.map(month => personLedger(person.id, { through: monthEnd(month) < today ? monthEnd(month) : today }).outstanding);
    return { person, start: before ? personLedger(person.id, { through: before }).outstanding : 0, balances };
  }).filter(row => row.start || row.balances.some(Boolean));

  const money = value => formatMoney(Math.round(value));
  // At most eight lines (the chart's colors); the table lists everyone.
  const charted = [...rows].sort((x, y) => Math.max(...y.balances.map(Math.abs)) - Math.max(...x.balances.map(Math.abs))).slice(0, 8);
  const series = charted.map((row, index) => ({ label: row.person.name, color: index + 1, format: money, values: row.balances }));
  $('#balanceKey').replaceChildren(...series.map(s => {
    const item = el('span', 'chart-key-item');
    const swatch = el('span', `chart-swatch series-${s.color}`);
    item.append(swatch, s.label);
    return item;
  }));
  $('#balanceChart').closest('.chart-frame').hidden = rows.length === 0;
  if (rows.length) {
    Charts.lines($('#balanceChart'), {
      labels: months.map(month => `${MONTH_NAMES[Number(month.slice(5)) - 1].slice(0, 3)} ${month.slice(2, 4)}`),
      titles: months.map(month => `End of ${formatMonth(month)}`),
      series
    });
  }
  renderTable($('#balanceTable'),
    [{ label: 'Person' }, { label: 'Before the Period', num: true }, { label: 'End of the Period', num: true }, { label: 'Change', num: true }, { label: 'Highest', num: true, title: 'The most they owed you at the end of a month in the period.' }],
    rows.map(row => {
      const end = row.balances.at(-1) ?? row.start;
      const highest = row.balances.reduce((best, value, index) => (!best || value > best.value ? { value, month: months[index] } : best), null);
      return {
        onClick: () => openPersonDialog(row.person.id),
        cells: [row.person.name, { text: outstandingText(row.start), sort: row.start }, { text: outstandingText(end), sort: end }, signedMoney(end - row.start), highest && highest.value > 0 ? `${formatMoney(highest.value)} (${formatMonth(highest.month)})` : '—']
      };
    }),
    { empty: 'Nobody else owed you anything in this period.' });
}

function renderLoyalty(stats) {
  const today = todayKey();
  const lastEver = new Map();
  for (const tx of state.model.transactions) if (tx.kind === 'Purchase' && tx.merchantId != null) lastEver.set(tx.merchantId, tx.date);
  const merchants = new Map();
  for (const tx of stats.purchases) {
    if (tx.merchantId == null) continue;
    const entry = merchants.get(tx.merchantId) ?? { visits: 0, spent: 0, dates: [] };
    entry.visits++;
    entry.spent += tx.amountCents;
    entry.dates.push(tx.date);
    merchants.set(tx.merchantId, entry);
  }
  const monthCount = stats.months.length;
  const rows = [...merchants]
    .sort((x, y) => y[1].visits - x[1].visits || y[1].spent - x[1].spent)
    .map(([id, entry]) => {
      const days = [...new Set(entry.dates)];
      const gaps = days.slice(1).map((day, index) => dayNumber(day) - dayNumber(days[index]));
      const months = new Set(days.map(monthOf)).size;
      const since = dayNumber(today) - dayNumber(lastEver.get(id));
      return {
        onClick: () => openScopeList('merchant', id),
        cells: [
          SCOPE_NAMES.merchant(id),
          numberFormat.format(entry.visits),
          formatDate(days[0]),
          formatDate(days.at(-1)),
          `${numberFormat.format(months)} of ${numberFormat.format(monthCount)}`,
          gaps.length ? plural(Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length), 'day') : '—',
          since < 0 ? '—' : since === 0 ? 'Today' : plural(since, 'day'),
          formatMoney(entry.spent),
          averageMoney(entry.spent, entry.visits)
        ]
      };
    });
  renderTable($('#loyaltyTable'), [
    { label: 'Merchant' },
    { label: 'Visits', num: true, title: 'Purchases at this merchant in the period.' },
    { label: 'First Visit' },
    { label: 'Last Visit' },
    { label: 'Months Visited', num: true, title: 'Months of the period with at least one visit.' },
    { label: 'Avg Gap', num: true, title: 'Average days between visits on different days.' },
    { label: 'Since Last', num: true, title: 'Days since your latest purchase there, ever.' },
    { label: 'Spent', num: true },
    { label: 'Avg Visit', num: true }
  ], rows, { empty: 'No purchases at a merchant in this period.' });
}

/** Regular intervals a repeat can follow, with how far each gap may stray from the usual one. */
const RECURRENCES = [
  { label: 'Weekly', days: 7, low: 6, high: 8 },
  { label: 'Every 2 weeks', days: 14, low: 12, high: 16 },
  { label: 'Monthly', days: 30.44, low: 26, high: 35 },
  { label: 'Every 3 months', days: 91.31, low: 84, high: 98 },
  { label: 'Every 6 months', days: 182.62, low: 174, high: 192 },
  { label: 'Yearly', days: 365.25, low: 355, high: 376 }
];

/**
 * Three or more purchases at the same merchant (or, without one, with the same description) for exactly the same
 * amount, where every gap between them fits one interval. All history counts, whatever the period.
 */
function findRecurring() {
  const groups = new Map();
  for (const tx of state.model.transactions) {
    if (tx.kind !== 'Purchase') continue;
    const what = tx.merchantId != null ? `m${tx.merchantId}` : tx.description.trim() ? `d${tx.description.trim().toLowerCase()}` : null;
    if (!what) continue;
    const key = `${what}|${tx.amountCents}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  }
  const today = todayKey();
  const found = [];
  for (const purchases of groups.values()) {
    if (purchases.length < 3) continue;
    const gaps = purchases.slice(1).map((tx, index) => dayNumber(tx.date) - dayNumber(purchases[index].date));
    const recurrence = RECURRENCES.find(entry => gaps.every(gap => gap >= entry.low && gap <= entry.high));
    if (!recurrence) continue;
    const last = purchases.at(-1);
    const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const next = recurrence.label === 'Monthly' ? sameDayNextMonth(last.date, purchases[0].date)
      : addDays(last.date, Math.round(average));
    // Still going unless the next one is overdue by more than the interval's slack.
    const active = dayNumber(today) <= dayNumber(next) + (recurrence.high - recurrence.low);
    found.push({ purchases, last, recurrence, next, active, perYear: Math.round(last.amountCents * 365.25 / recurrence.days) });
  }
  return found.sort((a, b) => b.active - a.active || b.perYear - a.perYear);
}

/** The next month's charge on the same day as the first one, clamped to the month's last day (Jan 31 → Feb 28). */
function sameDayNextMonth(lastDate, firstDate) {
  const month = shiftMonth(monthOf(lastDate), 1);
  return `${month}-${pad2(Math.min(Number(firstDate.slice(8)), daysInMonth(month)))}`;
}

function renderRecurring() {
  const found = findRecurring();
  const activeTotal = found.filter(entry => entry.active).reduce((sum, entry) => sum + entry.perYear, 0);
  renderTable($('#recurringTable'), [
    { label: 'What' },
    { label: 'Amount', num: true },
    { label: 'Every' },
    { label: 'Times', num: true },
    { label: 'Since' },
    { label: 'Last' },
    { label: 'Next Expected' },
    { label: 'Per Year', num: true, title: 'The amount times how often it repeats in a year.' },
    { label: 'Status' }
  ], found.map(entry => ({
    className: entry.active ? '' : 'archived-row',
    onClick: () => openTransactionEditor(entry.last),
    cells: [
      entry.last.merchantId != null ? SCOPE_NAMES.merchant(entry.last.merchantId) : entry.last.description,
      formatMoney(entry.last.amountCents),
      entry.recurrence.label,
      numberFormat.format(entry.purchases.length),
      formatDate(entry.purchases[0].date),
      formatDate(entry.last.date),
      entry.active ? formatDate(entry.next) : '—',
      formatMoney(entry.perYear),
      entry.active ? 'Active' : 'Stopped?'
    ]
  })), {
    empty: 'No repeating purchases found yet.',
    footer: found.length ? { cells: ['Active per year', '', '', '', '', '', '', { text: formatMoney(activeTotal), num: true }, ''] } : null
  });
}
