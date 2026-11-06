'use strict';

/*
 * Stats tab. Every number is computed only from recorded entries; nothing is estimated or categorized
 * automatically. Refunds count on their own date and under the person, tags, events, and merchant of their purchase.
 */

let statsPeriodSelect = null;

function statsPeriodOptions() {
  const transactions = state.model.transactions;
  const today = todayKey();
  const first = transactions[0]?.date ?? today;
  const last = transactions.at(-1)?.date ?? today;
  const latest = last > today ? last : today;

  const options = [{ value: 'all', label: 'All time' }];
  for (let year = Number(latest.slice(0, 4)); year >= Number(first.slice(0, 4)); year--)
    options.push({ value: `y:${year}`, label: String(year) });
  for (let month = monthOf(latest); month >= monthOf(first); month = shiftMonth(month, -1))
    options.push({ value: `m:${month}`, label: formatMonth(month) });
  for (const event of state.snapshot.events)
    options.push({ value: `e:${event.id}`, label: `Event: ${event.name}` });
  return options;
}

function statsRange(period) {
  const today = todayKey();
  if (period.startsWith('y:')) {
    const year = period.slice(2);
    return { start: `${year}-01-01`, end: `${year}-12-31`, label: year };
  }
  if (period.startsWith('m:')) {
    const month = period.slice(2);
    return { start: monthStart(month), end: monthEnd(month), label: formatMonth(month) };
  }
  if (period.startsWith('e:')) {
    // An event covers the purchases you put on it and their refunds, from its first entry to its last.
    const event = state.model.events.get(Number(period.slice(2)));
    if (event) {
      const filter = tx => eventIdsOf(tx).includes(event.id);
      const dates = state.model.transactions.filter(filter).map(tx => tx.date);
      return { start: dates[0] ?? today, end: dates.at(-1) ?? today, label: event.name, filter };
    }
  }
  const transactions = state.model.transactions;
  const first = transactions[0]?.date ?? today;
  const last = transactions.at(-1)?.date ?? today;
  return { start: first < today ? first : today, end: last > today ? last : today, label: 'All time' };
}

function computeStats(range) {
  const today = todayKey();
  const transactions = transactionsInRange(range.start, range.end).filter(range.filter ?? (() => true));
  const purchases = transactions.filter(tx => tx.kind === 'Purchase');
  const refunds = transactions.filter(tx => tx.kind === 'Refund');
  const paybacks = transactions.filter(tx => tx.kind === 'Payback');
  const sum = list => list.reduce((total, tx) => total + tx.amountCents, 0);

  // Days are counted up to today, or up to the latest entry when something is dated in the future.
  const latest = transactions.at(-1)?.date ?? null;
  const countedEnd = range.end <= today ? range.end : latest && latest > today ? latest : today;
  const countedDays = countedEnd >= range.start ? dayNumber(countedEnd) - dayNumber(range.start) + 1 : 0;

  const spent = sum(purchases);
  const refunded = sum(refunds);
  const paidBack = sum(paybacks);
  const days = dailyNet(transactions);
  const result = {
    range,
    countedEnd,
    countedDays,
    transactions,
    purchases,
    spent,
    refunded,
    net: spent - refunded,
    paidBack,
    forOthers: purchases.reduce((total, tx) => total + othersShare(tx), 0),
    largest: largestOf(purchases),
    largestRefund: largestOf(refunds),
    days
  };

  // Spending days and no-spend streaks.
  let spendingDays = 0;
  let run = 0;
  let longestRun = 0;
  let longestRunEnd = null;
  for (let number = dayNumber(range.start); countedDays > 0 && number <= dayNumber(countedEnd); number++) {
    const key = keyFromDayNumber(number);
    if ((days.get(key)?.purchases ?? 0) > 0) {
      spendingDays++;
      run = 0;
    } else {
      run++;
      if (run > longestRun) {
        longestRun = run;
        longestRunEnd = key;
      }
    }
  }
  result.spendingDays = spendingDays;
  result.noSpendDays = countedDays - spendingDays;
  result.longestNoSpend = longestRun;
  result.longestNoSpendRange = longestRun ? [addDays(longestRunEnd, 1 - longestRun), longestRunEnd] : null;
  result.currentNoSpend = countedEnd === today ? run : null;

  // Records by day, week (Monday start), and month.
  let highestDay = null;
  const weeks = new Map();
  for (const [key, day] of days) {
    if (day.purchases > 0 && (!highestDay || day.net > highestDay.net)) highestDay = { key, net: day.net };
    const weekStart = addDays(key, -((weekdayOf(key) + 6) % 7));
    weeks.set(weekStart, (weeks.get(weekStart) ?? 0) + day.net);
  }
  result.highestDay = highestDay;
  const highestWeek = [...weeks].reduce((best, [key, net]) => (!best || net > best.net ? { key, net } : best), null);
  // Weeks at the edges of the period are clipped to the days actually inside it.
  result.highestWeek = highestWeek && {
    net: highestWeek.net,
    start: highestWeek.key < range.start ? range.start : highestWeek.key,
    end: addDays(highestWeek.key, 6) > countedEnd ? countedEnd : addDays(highestWeek.key, 6)
  };

  const months = [];
  if (countedDays > 0) {
    for (let month = monthOf(range.start); month <= monthOf(countedEnd); month = shiftMonth(month, 1)) {
      const rows = transactions.filter(tx => monthOf(tx.date) === month);
      const totals = monthTotals(rows);
      const complete = monthStart(month) >= range.start && monthEnd(month) <= countedEnd && monthEnd(month) < today;
      months.push({ month, ...totals, entries: rows.length, complete });
    }
  }
  result.months = months;
  result.highestMonth = months.filter(m => m.purchases > 0).reduce((best, m) => (!best || m.net > best.net ? m : best), null);
  result.lowestMonth = months.filter(m => m.complete).reduce((best, m) => (!best || m.net < best.net ? m : best), null);

  result.byMethod = groupBy(transactions, tx => tx.paymentMethodId);
  result.byPerson = groupByPerson(transactions);
  // Refunds count under the tags, events, and merchant of the purchase they refund.
  const spending = transactions.filter(tx => tx.kind !== 'Payback');
  result.byTag = groupByIds(spending, tagIdsOf);
  result.byEvent = groupByIds(spending, eventIdsOf);
  // Grouped by merchant ID, so a renamed merchant keeps its whole history under its current name.
  result.byMerchant = groupByIds(spending, merchantIdsOf);

  result.weekdays = WEEKDAYS.map(() => ({ purchases: 0, net: 0, occurrences: 0 }));
  for (let number = dayNumber(range.start); countedDays > 0 && number <= dayNumber(countedEnd); number++)
    result.weekdays[weekdayOf(keyFromDayNumber(number))].occurrences++;
  for (const [key, day] of days) {
    const weekday = result.weekdays[weekdayOf(key)];
    weekday.purchases += day.purchases;
    weekday.net += day.net;
  }
  return result;
}

function largestOf(transactions) {
  return transactions.reduce((best, tx) => (!best || tx.amountCents > best.amountCents ? tx : best), null);
}

/** Each purchase counts once for every person with a share, with that share as their spent amount. */
function newBucket() {
  return { purchases: 0, spent: 0, refunded: 0, paidBack: 0, last: null };
}

/** Purchases and refunds per tag, event, or merchant, plus a bucket (key null) for entries with none. */
function groupByIds(transactions, idsOf) {
  const groups = new Map();
  for (const tx of transactions) {
    const ids = idsOf(tx);
    for (const id of ids.length ? ids : [null]) {
      if (!groups.has(id)) groups.set(id, newBucket());
      addToBucket(groups.get(id), tx);
    }
  }
  return groups;
}

function groupByPerson(transactions) {
  const groups = new Map();
  const bucket = personId => {
    if (!groups.has(personId)) groups.set(personId, newBucket());
    return groups.get(personId);
  };
  for (const tx of transactions) {
    if (tx.kind === 'Purchase') {
      for (const share of tx.shares) {
        bucket(share.personId).purchases++;
        bucket(share.personId).spent += share.amountCents;
        bucket(share.personId).last = tx.date;
      }
    } else if (tx.kind === 'Refund') {
      bucket(tx.personId).refunded += tx.amountCents;
    } else {
      bucket(tx.personId).paidBack += tx.amountCents;
    }
  }
  return groups;
}

function groupBy(transactions, keyOf) {
  const groups = new Map();
  for (const tx of transactions) {
    const key = keyOf(tx);
    if (!groups.has(key)) groups.set(key, newBucket());
    addToBucket(groups.get(key), tx);
  }
  return groups;
}

/** Transactions arrive in date order, so the last purchase seen is the latest one. */
function addToBucket(bucket, tx) {
  if (tx.kind === 'Purchase') {
    bucket.purchases++;
    bucket.spent += tx.amountCents;
    bucket.last = tx.date;
  } else if (tx.kind === 'Refund') {
    bucket.refunded += tx.amountCents;
  } else if ('paidBack' in bucket) {
    bucket.paidBack += tx.amountCents;
  }
}

function share(part, whole) {
  return whole > 0 ? percentFormat.format(part / whole) : '—';
}

function averageMoney(total, count) {
  return count > 0 ? formatMoney(Math.round(total / count)) : '—';
}

function renderStats() {
  const options = statsPeriodOptions();
  statsPeriodSelect.setOptions(options, state.statsPeriod);
  state.statsPeriod = statsPeriodSelect.value;
  const stats = computeStats(statsRange(state.statsPeriod));
  $('#titleScope').textContent = `Stats · ${stats.range.label}`;

  const empty = stats.transactions.length === 0;
  $('#statsEmpty').hidden = !empty;
  $('#statsContent').hidden = empty;
  if (empty) return;

  $('#statsTotals').replaceChildren(
    statCard('Spent', formatMoney(stats.spent), { sub: plural(stats.purchases.length, 'purchase'), title: 'Total of every purchase dated in this period.' }),
    statCard('Refunds', formatMoney(stats.refunded), { title: 'Total of every refund dated in this period, counted on the refund date.' }),
    statCard('Net spent', formatMoney(stats.net), { title: 'Spent minus refunds.' }),
    statCard('Paid back to you', formatMoney(stats.paidBack), { title: 'Paybacks other people made to you in this period.' }),
    statCard('Net after paybacks', formatMoney(stats.net - stats.paidBack), { title: 'Net spent minus paybacks received in this period.' }),
    statCard('Spent for others', formatMoney(stats.forOthers), { sub: share(stats.forOthers, stats.spent) + ' of spent', title: 'The shares of purchases that belong to people other than you.' }),
    statCard('Average purchase', averageMoney(stats.spent, stats.purchases.length), { title: 'Spent divided by the number of purchases.' }),
    statCard('Largest purchase', stats.largest ? formatMoney(stats.largest.amountCents) : '—', {
      sub: stats.largest ? `${describeTransaction(stats.largest)} · ${formatDate(stats.largest.date)}` : '',
      title: 'The single biggest purchase in this period.'
    })
  );

  const countedNote = `${formatDateRange(stats.range.start, stats.countedEnd)}`;
  renderMetrics($('#statsDaily'), [
    ['Days counted', plural(stats.countedDays, 'day'), `Calendar days from ${countedNote}. Days after today are only counted when an entry is dated in the future.`],
    ['Average per day', averageMoney(stats.net, stats.countedDays), 'Net spent divided by every counted day, including days with no purchases.'],
    ['Average per spending day', averageMoney(stats.net, stats.spendingDays), 'Net spent divided only by days with at least one purchase.'],
    ['Spending days', `${numberFormat.format(stats.spendingDays)} (${share(stats.spendingDays, stats.countedDays)})`, 'Days with at least one purchase.'],
    ['No-spend days', numberFormat.format(stats.noSpendDays), 'Counted days with no purchases. Refunds and paybacks do not count as spending.'],
    ['Longest no-spend streak', stats.longestNoSpend ? `${plural(stats.longestNoSpend, 'day')} (${formatDateRange(...stats.longestNoSpendRange)})` : '0 days', 'Most consecutive counted days without a purchase.'],
    ...(stats.currentNoSpend == null ? [] : [['Current no-spend streak', plural(stats.currentNoSpend, 'day'), 'Consecutive days up to today without a purchase.']])
  ]);

  renderMetrics($('#statsRecords'), [
    ['Highest day', stats.highestDay ? `${formatMoney(stats.highestDay.net)} on ${formatDate(stats.highestDay.key)}` : '—', 'The day with the most net spent.'],
    ['Highest week', stats.highestWeek ? `${formatMoney(stats.highestWeek.net)} (${formatDateRange(stats.highestWeek.start, stats.highestWeek.end)})` : '—', 'The Monday–Sunday week with the most net spent. Weeks at the edges of the period only include days inside it.'],
    ['Highest month', stats.highestMonth ? `${formatMoney(stats.highestMonth.net)} in ${formatMonth(stats.highestMonth.month)}` : '—', 'The month with the most net spent.'],
    ['Lowest full month', stats.lowestMonth ? `${formatMoney(stats.lowestMonth.net)} in ${formatMonth(stats.lowestMonth.month)}` : '—', 'The completed month (fully inside the period and already over) with the least net spent.'],
    ['Largest refund', stats.largestRefund ? `${formatMoney(stats.largestRefund.amountCents)} on ${formatDate(stats.largestRefund.date)}` : '—', 'The single biggest refund in this period.']
  ]);

  renderStatsChart(stats);
  renderStatsTables(stats);
}

/** What the chart can show for each day (or month). Money is in cents; counts are plain numbers. */
const CHART_METRICS = [
  { value: 'net', label: 'Net spent', of: bucket => bucket.net },
  { value: 'spent', label: 'Spent', of: bucket => bucket.spent },
  { value: 'refunded', label: 'Refunds', of: bucket => bucket.refunded },
  { value: 'paidBack', label: 'Paid back to you', of: bucket => bucket.paidBack },
  { value: 'purchases', label: 'Purchases', count: true, of: bucket => bucket.purchases },
  { value: 'entries', label: 'Entries', count: true, of: bucket => bucket.entries },
  { value: 'average', label: 'Average purchase', of: bucket => (bucket.purchases ? Math.round(bucket.spent / bucket.purchases) : 0) },
  { value: 'running', label: 'Running net spent', running: true, of: bucket => bucket.net }
];
let statsChartSelect = null;

function renderStatsChart(stats) {
  const metric = CHART_METRICS.find(option => option.value === state.statsChart) ?? CHART_METRICS[0];
  const format = metric.count ? value => numberFormat.format(Math.round(value)) : value => formatMoney(Math.round(value));
  const empty = { net: 0, spent: 0, refunded: 0, paidBack: 0, purchases: 0, entries: 0 };
  const byDay = stats.countedDays <= 62;
  const points = byDay
    ? Array.from({ length: Math.max(0, dayNumber(stats.countedEnd) - dayNumber(stats.range.start) + 1) }, (_, index) => {
      const key = keyFromDayNumber(dayNumber(stats.range.start) + index);
      return { label: key.slice(8), title: formatDate(key), bucket: stats.days.get(key) ?? empty };
    })
    : stats.months.map(month => ({
      label: `${MONTH_NAMES[Number(month.month.slice(5)) - 1].slice(0, 3)} ${month.month.slice(2, 4)}`,
      title: formatMonth(month.month),
      bucket: month
    }));
  $('#statsChartLegend').textContent = `${metric.label} per ${byDay ? 'Day' : 'Month'}`;
  let total = 0;
  const bars = points.map(point => {
    const own = metric.of(point.bucket);
    total += own;
    const value = metric.running ? total : own;
    const detail = metric.running ? `${format(value)} running net spent (${format(own)} that ${byDay ? 'day' : 'month'})` : `${format(value)} ${metric.label.toLowerCase()}`;
    return { label: point.label, value, tooltip: `${point.title}\n${detail}\n${plural(point.bucket.purchases, 'purchase')}` };
  });
  Charts.bar($('#statsChart'), bars, { format });
}

function renderStatsTables(stats) {
  const moneyColumns = [{ label: 'Purchases', num: true }, { label: 'Spent', num: true }, { label: 'Refunds', num: true }, { label: 'Net', num: true }];

  renderTable($('#statsMethodsTable'), [{ label: 'Method' }, ...moneyColumns, { label: 'Share', num: true, title: 'Share of spent.' }],
    [...stats.byMethod]
      .filter(([, g]) => g.purchases || g.refunded)
      .sort((a, b) => b[1].spent - a[1].spent)
      .map(([id, g]) => ({ cells: [methodName(id), numberFormat.format(g.purchases), formatMoney(g.spent), formatMoney(g.refunded), formatMoney(g.spent - g.refunded), share(g.spent, stats.spent)] })),
    { empty: 'No purchases or refunds.' });

  renderTable($('#statsWeekdayTable'),
    [{ label: 'Day' }, { label: 'Purchases', num: true }, { label: 'Net', num: true }, { label: 'Avg per Day', num: true, title: 'Net spent on this weekday divided by how many of this weekday are in the counted days.' }],
    WEEKDAY_NAMES.map((name, index) => {
      const weekday = stats.weekdays[index];
      return { cells: [name, numberFormat.format(weekday.purchases), formatMoney(weekday.net), averageMoney(weekday.net, weekday.occurrences)] };
    }));

  renderBreakdown($('#statsPeopleTable'), 'Person', 'person', stats.byPerson, { paidBack: true });
  renderBreakdown($('#statsTagsTable'), 'Tag', 'tag', stats.byTag, { none: 'Untagged' });
  renderBreakdown($('#statsEventsTable'), 'Event', 'event', stats.byEvent, { none: 'No event' });
  renderBreakdown($('#statsMerchantsTable'), 'Merchant', 'merchant', stats.byMerchant, { none: '(no merchant)', countLabel: 'Visits' });

  renderTable($('#statsMonthsTable'),
    [{ label: 'Month' }, { label: 'Purchases', num: true }, { label: 'Spent', num: true }, { label: 'Refunds', num: true }, { label: 'Net', num: true }, { label: 'Change', num: true, title: 'Net compared with the month before.' }, { label: 'Paid Back', num: true }],
    [...stats.months].reverse().map((month, index, list) => {
      const previous = list[index + 1];
      const change = previous ? month.net - previous.net : null;
      const changeText = change == null ? '—' : `${change > 0 ? '+' : change < 0 ? '−' : ''}${formatMoney(Math.abs(change))}`;
      return {
        onClick: () => {
          state.timeFrame = { all: false, months: [month.month] };
          switchTab('transactions');
        },
        cells: [formatMonth(month.month) + (month.complete ? '' : ' (partial)'), numberFormat.format(month.purchases), formatMoney(month.spent), formatMoney(month.refunded), formatMoney(month.net), changeText, formatMoney(month.paidBack)]
      };
    }));
}

/**
 * People, tags, events, and merchants share one table layout, highest net first. Selecting a row lists that scope's
 * entries; the "none" row (untagged, no event, no merchant) is listed last and is not selectable.
 */
function renderBreakdown(table, label, scope, groups, { none = null, countLabel = 'Purchases', paidBack = false } = {}) {
  const net = group => group.spent - group.refunded;
  const rows = [...groups]
    .filter(([id, group]) => (id != null || none) && (group.purchases || group.refunded || group.paidBack))
    .sort((a, b) => (a[0] == null) - (b[0] == null) || net(b[1]) - net(a[1]))
    .map(([id, group]) => ({
      onClick: id == null ? undefined : () => openScopeList(scope, id),
      cells: [
        id == null ? none : SCOPE_NAMES[scope](id),
        numberFormat.format(group.purchases), formatMoney(group.spent), formatMoney(group.refunded), formatMoney(net(group)),
        averageMoney(group.spent, group.purchases), group.last ? formatDate(group.last) : '—',
        ...(paidBack ? [formatMoney(group.paidBack)] : [])
      ]
    }));
  renderTable(table, [
    { label }, { label: countLabel, num: true, title: 'Number of purchases.' }, { label: 'Spent', num: true }, { label: 'Refunds', num: true },
    { label: 'Net', num: true }, { label: 'Avg Purchase', num: true }, { label: 'Last Purchase' },
    ...(paidBack ? [{ label: 'Paid Back', num: true, title: 'Paybacks this person made to you in the period.' }] : [])
  ], rows, { empty: 'No purchases or refunds.' });
}

function initializeStats() {
  statsChartSelect = createSingleSelect($('#statsChartMetric'), {
    onChange: value => {
      state.statsChart = value;
      writeSetting('spend-tracker-stats-chart', value);
      renderStats();
    }
  });
  statsChartSelect.setOptions(CHART_METRICS, state.statsChart);
  statsPeriodSelect = createSingleSelect($('#statsPeriodSelect'), {
    onChange: value => {
      state.statsPeriod = value;
      renderStats();
    }
  });
}
