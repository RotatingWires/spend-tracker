'use strict';

/*
 * Stats tab. Every number is computed only from recorded entries; nothing is estimated or categorized
 * automatically. Refunds count on their own date and under the person, tags, and merchant of their purchase.
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
  for (const event of [...state.model.events].reverse())
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
    const event = state.model.events.find(e => String(e.id) === period.slice(2));
    if (event) return { start: event.startDate, end: event.endDate, label: event.name };
  }
  const transactions = state.model.transactions;
  const first = transactions[0]?.date ?? today;
  const last = transactions.at(-1)?.date ?? today;
  return { start: first < today ? first : today, end: last > today ? last : today, label: 'All time' };
}

function computeStats(range) {
  const today = todayKey();
  const transactions = transactionsInRange(range.start, range.end);
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
    forOthers: sum(purchases.filter(isForOthers)),
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
  result.byPerson = groupBy(transactions, tx => personIdOf(tx));
  result.byTag = new Map();
  result.untagged = { purchases: 0, spent: 0, refunded: 0 };
  for (const tx of [...purchases, ...refunds]) {
    const tagIds = tagIdsOf(tx);
    const buckets = tagIds.length ? tagIds.map(id => {
      if (!result.byTag.has(id)) result.byTag.set(id, { purchases: 0, spent: 0, refunded: 0 });
      return result.byTag.get(id);
    }) : [result.untagged];
    for (const bucket of buckets) addToBucket(bucket, tx);
  }

  result.merchants = new Map();
  for (const tx of [...purchases, ...refunds]) {
    const source = tx.kind === 'Refund' ? state.model.byId.get(tx.linkedId) ?? tx : tx;
    const name = source.merchant.trim() || '(no merchant)';
    const key = name.toLowerCase();
    const entry = result.merchants.get(key) ?? { name, purchases: 0, spent: 0, refunded: 0, last: null };
    if (tx.kind === 'Purchase') {
      entry.name = name;
      entry.last = tx.date;
    }
    addToBucket(entry, tx);
    result.merchants.set(key, entry);
  }

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

function groupBy(transactions, keyOf) {
  const groups = new Map();
  for (const tx of transactions) {
    const key = keyOf(tx);
    if (!groups.has(key)) groups.set(key, { purchases: 0, spent: 0, refunded: 0, paidBack: 0 });
    addToBucket(groups.get(key), tx);
  }
  return groups;
}

function addToBucket(bucket, tx) {
  if (tx.kind === 'Purchase') {
    bucket.purchases++;
    bucket.spent += tx.amountCents;
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
    statCard('Spent for others', formatMoney(stats.forOthers), { sub: share(stats.forOthers, stats.spent) + ' of spent', title: 'Purchases whose For Who is someone other than you.' }),
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

function renderStatsChart(stats) {
  let bars;
  if (stats.countedDays <= 62) {
    $('#statsChartLegend').textContent = 'Net Spent per Day';
    bars = [];
    for (let number = dayNumber(stats.range.start); number <= dayNumber(stats.countedEnd); number++) {
      const key = keyFromDayNumber(number);
      const net = stats.days.get(key)?.net ?? 0;
      bars.push({ label: key.slice(8), value: net, tooltip: `${formatDate(key)}\n${formatMoney(net)} net spent` });
    }
  } else {
    $('#statsChartLegend').textContent = 'Net Spent per Month';
    bars = stats.months.map(month => ({
      label: `${MONTH_NAMES[Number(month.month.slice(5)) - 1].slice(0, 3)} ${month.month.slice(2, 4)}`,
      value: month.net,
      tooltip: `${formatMonth(month.month)}\n${formatMoney(month.net)} net spent\n${plural(month.purchases, 'purchase')}`
    }));
  }
  Charts.bar($('#statsChart'), bars);
}

function renderStatsTables(stats) {
  const moneyColumns = [{ label: 'Purchases', num: true }, { label: 'Spent', num: true }, { label: 'Refunds', num: true }, { label: 'Net', num: true }];

  renderTable($('#statsMethodsTable'), [{ label: 'Method' }, ...moneyColumns, { label: 'Share', num: true, title: 'Share of spent.' }],
    [...stats.byMethod]
      .filter(([, g]) => g.purchases || g.refunded)
      .sort((a, b) => b[1].spent - a[1].spent)
      .map(([id, g]) => ({ cells: [methodName(id), numberFormat.format(g.purchases), formatMoney(g.spent), formatMoney(g.refunded), formatMoney(g.spent - g.refunded), share(g.spent, stats.spent)] })),
    { empty: 'No purchases or refunds.' });

  renderTable($('#statsPeopleTable'), [{ label: 'For Who' }, ...moneyColumns, { label: 'Paid Back', num: true }],
    [...stats.byPerson]
      .filter(([id]) => id != null)
      .sort((a, b) => b[1].spent - a[1].spent)
      .map(([id, g]) => ({ cells: [personName(id), numberFormat.format(g.purchases), formatMoney(g.spent), formatMoney(g.refunded), formatMoney(g.spent - g.refunded), formatMoney(g.paidBack)] })));

  const tagRows = [...stats.byTag]
    .sort((a, b) => (b[1].spent - b[1].refunded) - (a[1].spent - a[1].refunded))
    .map(([id, g]) => ({ cells: [tagName(id), numberFormat.format(g.purchases), formatMoney(g.spent), formatMoney(g.refunded), formatMoney(g.spent - g.refunded)] }));
  if (stats.untagged.purchases || stats.untagged.refunded)
    tagRows.push({ cells: ['Untagged', numberFormat.format(stats.untagged.purchases), formatMoney(stats.untagged.spent), formatMoney(stats.untagged.refunded), formatMoney(stats.untagged.spent - stats.untagged.refunded)] });
  renderTable($('#statsTagsTable'), [{ label: 'Tag' }, ...moneyColumns], tagRows);

  renderTable($('#statsWeekdayTable'),
    [{ label: 'Day' }, { label: 'Purchases', num: true }, { label: 'Net', num: true }, { label: 'Avg per Day', num: true, title: 'Net spent on this weekday divided by how many of this weekday are in the counted days.' }],
    WEEKDAY_NAMES.map((name, index) => {
      const weekday = stats.weekdays[index];
      return { cells: [name, numberFormat.format(weekday.purchases), formatMoney(weekday.net), averageMoney(weekday.net, weekday.occurrences)] };
    }));

  const merchants = [...stats.merchants.values()].sort((a, b) => (b.spent - b.refunded) - (a.spent - a.refunded));
  renderTable($('#statsMerchantsTable'),
    [{ label: 'Merchant' }, { label: 'Visits', num: true, title: 'Number of purchases.' }, { label: 'Spent', num: true }, { label: 'Refunds', num: true }, { label: 'Net', num: true }, { label: 'Avg Purchase', num: true }, { label: 'Last Purchase' }],
    merchants.map(m => ({ cells: [m.name, numberFormat.format(m.purchases), formatMoney(m.spent), formatMoney(m.refunded), formatMoney(m.spent - m.refunded), averageMoney(m.spent, m.purchases), m.last ? formatDate(m.last) : '—'] })));

  renderTable($('#statsMonthsTable'),
    [{ label: 'Month' }, { label: 'Purchases', num: true }, { label: 'Spent', num: true }, { label: 'Refunds', num: true }, { label: 'Net', num: true }, { label: 'Change', num: true, title: 'Net compared with the month before.' }, { label: 'Paid Back', num: true }],
    [...stats.months].reverse().map((month, index, list) => {
      const previous = list[index + 1];
      const change = previous ? month.net - previous.net : null;
      const changeText = change == null ? '—' : `${change > 0 ? '+' : change < 0 ? '−' : ''}${formatMoney(Math.abs(change))}`;
      return {
        onClick: () => {
          state.month = month.month;
          switchTab('transactions');
        },
        cells: [formatMonth(month.month) + (month.complete ? '' : ' (partial)'), numberFormat.format(month.purchases), formatMoney(month.spent), formatMoney(month.refunded), formatMoney(month.net), changeText, formatMoney(month.paidBack)]
      };
    }));
}

function initializeStats() {
  statsPeriodSelect = createSingleSelect($('#statsPeriodSelect'), {
    onChange: value => {
      state.statsPeriod = value;
      renderStats();
    }
  });
}
