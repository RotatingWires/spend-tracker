/*
 * Stats > Counts: how many entries rather than how much money. Purchases, refunds, and paybacks over time and by
 * weekday, purchases by size, and the merchants and tags used most. Like the rest of Stats, archived entries count.
 */
import { $, SCOPE_NAMES, WEEKDAY_NAMES, WEEKDAYS, dayNumber, el, formatDate, formatMonth, keyFromDayNumber, monthOf, numberFormat, shortMonth, tagIdsOf, tagName, weekdayOf } from './app.js';
import { renderMetrics } from './widgets.js';
import { merchantIdsOf } from './summaries.js';
import { openScopeList } from './scopes.js';
import { Charts } from './charts.js';
import { drawTimeChart, openPeriodKey } from './stats.js';
import { SIZE_BUCKETS } from './insights.js';

const COUNT_KINDS = [
  { kind: 'Purchase', label: 'Purchases', color: 5 },
  { kind: 'Refund', label: 'Refunds', color: 3 },
  { kind: 'Payback', label: 'Paybacks', color: 4 }
];
const countFormat = value => numberFormat.format(Math.round(value));

function emptyCounts() {
  return { Purchase: 0, Refund: 0, Payback: 0 };
}

/** A key above a chart: one colored square and label per series. */
function renderChartKey(container, series) {
  container.replaceChildren(...series.map(s => {
    const item = el('span', 'chart-key-item');
    const swatch = el('span', `chart-swatch series-${s.color}`);
    item.append(swatch, s.label);
    return item;
  }));
}

/** One series per entry type, as counts. */
function kindSeries(buckets) {
  return COUNT_KINDS.map(entry => ({ label: entry.label, color: entry.color, count: true, format: countFormat, values: buckets.map(bucket => bucket[entry.kind]) }));
}

/** Long names are cut short under a bar; the tooltip has the whole name. */
function shortLabel(name) {
  return name.length > 12 ? `${name.slice(0, 11)}...` : name;
}

export function renderCounts(stats) {
  const byKind = emptyCounts();
  for (const tx of stats.transactions) byKind[tx.kind]++;

  renderMetrics($('#countSummary'), [
    ['Entries', numberFormat.format(stats.transactions.length), 'Every entry dated in this period.'],
    ['Purchases', numberFormat.format(byKind.Purchase), 'Number of purchases.'],
    ['Refunds', numberFormat.format(byKind.Refund), 'Number of refunds, on their own dates.'],
    ['Paybacks', numberFormat.format(byKind.Payback), 'Number of paybacks other people made to you.'],
    ['Purchases per day', stats.countedDays ? (byKind.Purchase / stats.countedDays).toFixed(2) : '—', 'Purchases divided by every counted day.'],
    ['Purchases per spending day', stats.spendingDays ? (byKind.Purchase / stats.spendingDays).toFixed(2) : '—', 'Purchases divided by days with at least one purchase.']
  ]);

  // Busiest day and month by number of purchases; ties go to the earliest.
  let busiestDay = null;
  for (const [key, day] of stats.days) if (day.purchases && (!busiestDay || day.purchases > busiestDay.purchases)) busiestDay = { key, purchases: day.purchases };
  const busiestMonth = stats.months.reduce((best, month) => (month.purchases && (!best || month.purchases > best.purchases) ? month : best), null);
  const weekdayTotals = stats.weekdays.map((weekday, index) => ({ index, purchases: weekday.purchases }));
  const busiestWeekday = weekdayTotals.reduce((best, entry) => (entry.purchases > (best?.purchases ?? 0) ? entry : best), null);
  const [topMerchant] = topCounts(stats.purchases, merchantIdsOf);
  renderMetrics($('#countBusiest'), [
    ['Most purchases in a day', busiestDay ? `${numberFormat.format(busiestDay.purchases)} on ${formatDate(busiestDay.key)}` : '—', 'The day with the most purchases.'],
    ['Most purchases in a month', busiestMonth ? `${numberFormat.format(busiestMonth.purchases)} in ${formatMonth(busiestMonth.month)}` : '—', 'The month with the most purchases.'],
    ['Busiest weekday', busiestWeekday ? `${WEEKDAY_NAMES[busiestWeekday.index]} (${numberFormat.format(busiestWeekday.purchases)})` : '—', 'The weekday with the most purchases in the period.'],
    ['Most visited merchant', topMerchant ? `${SCOPE_NAMES.merchant(topMerchant.id)} (${numberFormat.format(topMerchant.count)})` : '—', 'The merchant with the most purchases in the period.']
  ]);

  renderCountsOverTime(stats);
  renderCountsByWeekday(stats);
  renderCountsBySize(stats);

  const merchants = topCounts(stats.purchases, merchantIdsOf).slice(0, 12);
  Charts.bars($('#countMerchantChart'), {
    labels: merchants.map(entry => shortLabel(SCOPE_NAMES.merchant(entry.id))),
    titles: merchants.map(entry => SCOPE_NAMES.merchant(entry.id)),
    onSelect: index => openScopeList('merchant', merchants[index].id),
    series: [{ label: 'Visits', color: 5, count: true, format: countFormat, values: merchants.map(entry => entry.count) }]
  });
  const tags = topCounts(stats.purchases, tagIdsOf).slice(0, 12);
  Charts.bars($('#countTagChart'), {
    labels: tags.map(entry => shortLabel(tagName(entry.id))),
    titles: tags.map(entry => tagName(entry.id)),
    onSelect: index => openScopeList('tag', tags[index].id),
    series: [{ label: 'Purchases', color: 5, count: true, format: countFormat, values: tags.map(entry => entry.count) }]
  });
}

/** How many purchases have each ID (merchant or tag), most first. */
function topCounts(purchases, idsOf) {
  const counts = new Map();
  for (const tx of purchases) for (const id of idsOf(tx)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
}

/** Per day for periods of 62 counted days or fewer, otherwise per month, like the chart on Trends. */
function renderCountsOverTime(stats) {
  const byDay = stats.countedDays <= 62;
  const buckets = new Map();
  for (const tx of stats.transactions) {
    const key = byDay ? tx.date : monthOf(tx.date);
    if (!buckets.has(key)) buckets.set(key, emptyCounts());
    buckets.get(key)[tx.kind]++;
  }
  const points = byDay
    ? Array.from({ length: Math.max(0, dayNumber(stats.countedEnd) - dayNumber(stats.range.start) + 1) }, (_, index) => keyFromDayNumber(dayNumber(stats.range.start) + index))
      .filter(stats.included)
      .map(key => ({ label: key.slice(8), title: formatDate(key), key }))
    : stats.months.map(month => ({
      label: shortMonth(month.month),
      title: formatMonth(month.month),
      key: month.month
    }));
  $('#countTimeLegend').textContent = `Entries per ${byDay ? 'Day' : 'Month'}`;
  const series = kindSeries(points.map(point => buckets.get(point.key) ?? emptyCounts()));
  renderChartKey($('#countTimeKey'), series);
  drawTimeChart($('#countTimeChart'), { labels: points.map(point => point.label), titles: points.map(point => point.title), series, onSelect: index => openPeriodKey(points[index].key) });
}

function renderCountsByWeekday(stats) {
  const buckets = WEEKDAYS.map(() => emptyCounts());
  for (const tx of stats.transactions) buckets[weekdayOf(tx.date)][tx.kind]++;
  const series = kindSeries(buckets);
  renderChartKey($('#countWeekdayKey'), series);
  Charts.bars($('#countWeekdayChart'), { labels: WEEKDAYS, titles: WEEKDAY_NAMES, series });
}

function renderCountsBySize(stats) {
  const counts = SIZE_BUCKETS.map(() => 0);
  for (const tx of stats.purchases) counts[SIZE_BUCKETS.findIndex(bucket => tx.amountCents < bucket.below)]++;
  Charts.bars($('#countSizeChart'), {
    labels: SIZE_BUCKETS.map(bucket => bucket.label),
    titles: SIZE_BUCKETS.map(bucket => bucket.label),
    series: [{ label: 'Purchases', color: 5, count: true, format: countFormat, values: counts }]
  });
}
