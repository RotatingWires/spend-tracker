'use strict';

/* Shared state, money/date helpers, the API client, and the derived model every view reads from. */

const state = {
  snapshot: null,
  model: null,
  activeTab: 'transactions',
  // What the ledger and calendar show: every month (all), or the chosen months ("YYYY-MM").
  timeFrame: { all: false, months: [] },
  statsPeriod: ['all'],
  statsChart: savedChartMeasures(),
  // The Stats sub-tab, and the choices on the Heatmaps and Compare sub-tabs.
  statsTab: readSetting('spend-tracker-stats-tab') || 'overview',
  // Bars or lines for charts over time, remembered in this browser.
  chartStyle: readSetting('spend-tracker-chart-style') === 'lines' ? 'lines' : 'bars',
  heat: { measure: 'net', year: null, rows: 'tags' },
  // Searches applied with a Search button (or Enter), not while typing; empty means none.
  ledgerQuery: '',
  // Ledger filters checked in the Filters dropdown, such as "method:2" or "tag:5".
  ledgerFilters: [],
  merchantQuery: '',
  compare: { a: null, b: null },
  showArchived: readSetting('spend-tracker-show-archived') === 'true',
  includeGifts: readSetting('spend-tracker-include-gifts') === 'true',
  loading: null
};

/** Per-browser view preferences. Storage can be unavailable (private windows), so they fall back to defaults. */
function readSetting(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** The chart measures chosen last time in this browser, or net spent. */
function savedChartMeasures() {
  try {
    const saved = JSON.parse(readSetting('spend-tracker-stats-chart') ?? '[]');
    return Array.isArray(saved) && saved.length && saved.every(value => typeof value === 'string') ? saved : ['net'];
  } catch {
    return ['net'];
  }
}

function writeSetting(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- money

const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const numberFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

function formatMoney(cents) {
  return moneyFormat.format(cents / 100);
}

/** Parses "12", "12.5", "$1,234.56" into whole cents without floating-point rounding. Returns null when invalid. */
function parseMoney(text) {
  const clean = String(text ?? '').trim().replace(/^\$/, '').replace(/,/g, '').trim();
  const match = /^(\d*)(?:\.(\d{0,2}))?$/.exec(clean);
  if (!match || clean === '' || clean === '.') return null;
  const cents = Number(match[1] || '0') * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function centsToInput(cents) {
  return (cents / 100).toFixed(2);
}

const amountFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "1,234.50": an amount box's value, without the dollar sign. parseMoney reads it back. */
function formatAmount(cents) {
  return amountFormat.format(cents / 100);
}

/** Tags are listed as "food · gifts" in the editor and the ledger. */
const TAG_SEPARATOR = ' · ';

// ---------------------------------------------------------------- dates
// Dates are "YYYY-MM-DD" keys. Day arithmetic uses UTC day numbers so daylight-saving changes never shift a day.

function pad2(value) {
  return String(value).padStart(2, '0');
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function dayNumber(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function keyFromDayNumber(number) {
  const date = new Date(number * DAY_MS);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addDays(key, days) {
  return keyFromDayNumber(dayNumber(key) + days);
}

function weekdayOf(key) {
  return new Date(dayNumber(key) * DAY_MS).getUTCDay();
}

function monthOf(key) {
  return key.slice(0, 7);
}

function shiftMonth(monthKey, delta) {
  const [year, month] = monthKey.split('-').map(Number);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

function daysInMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthStart(monthKey) {
  return `${monthKey}-01`;
}

function monthEnd(monthKey) {
  return `${monthKey}-${pad2(daysInMonth(monthKey))}`;
}

function formatDate(key) {
  const [year, month, day] = key.split('-');
  return `${month}/${day}/${year}`;
}

function formatMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function formatDateRange(start, end) {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}/${date.getFullYear()}`;
  return `${day} ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${numberFormat.format(count)} ${count === 1 ? singular : pluralForm}`;
}

// ---------------------------------------------------------------- API

function loginUrl() {
  const returnUrl = `${location.pathname}${location.search}${location.hash}`;
  // The home page needs no return address: plain /login.html, like NewsReview.
  return !returnUrl || returnUrl === '/' ? '/login.html' : `/login.html?returnUrl=${encodeURIComponent(returnUrl)}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, options);
  if (response.status === 401) {
    window.location.replace(loginUrl());
    throw new Error('Your session ended. Log in again.');
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const error = await response.json();
      message = error.error || error.detail || error.title || message;
    } catch {}
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

// ---------------------------------------------------------------- model

/**
 * Indexes the snapshot. Refunds have no person of their own; they belong to the person and tags of the
 * purchase they refund, so every view asks the model instead of reading those fields directly.
 */
function buildModel(snapshot) {
  const methods = new Map(snapshot.paymentMethods.map(method => [method.id, method]));
  const people = new Map(snapshot.people.map(person => [person.id, person]));
  const tags = new Map(snapshot.tags.map(tag => [tag.id, tag]));
  const merchants = new Map(snapshot.merchants.map(merchant => [merchant.id, merchant]));
  const collections = new Map(snapshot.collections.map(collection => [collection.id, collection]));
  const byId = new Map(snapshot.transactions.map(tx => [tx.id, tx]));
  const self = snapshot.people.find(person => person.isSelf);
  const linked = new Map();
  for (const tx of snapshot.transactions) {
    if (tx.linkedId == null) continue;
    if (!linked.has(tx.linkedId)) linked.set(tx.linkedId, []);
    linked.get(tx.linkedId).push(tx);
  }
  return { methods, people, tags, merchants, collections, byId, self, linked, transactions: snapshot.transactions };
}

// ---------------------------------------------------------------- local updates
/*
 * After a save, the server's answer is merged into the snapshot already in the browser instead of downloading every
 * entry again: a saved entry comes back whole (with its numbers), and saving one entry never changes another. Changes
 * that can touch many entries at once (deleting a list item, Fresh Start, Restore) and File → Refresh still load the
 * whole snapshot.
 */
const SNAPSHOT_LISTS = { 'payment-methods': 'paymentMethods', people: 'people', tags: 'tags', merchants: 'merchants', collections: 'collections' };

/** The server's order: by date, then ID. */
function compareTransactions(a, b) {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id;
}

/** Replaces saved entries (or adds new ones) in date order and drops deleted ones, then redraws. */
function applyTransactionChanges({ saved = [], deleted = [] }) {
  const replaced = new Set([...deleted, ...saved.map(tx => tx.id)]);
  const list = state.snapshot.transactions.filter(tx => !replaced.has(tx.id));
  for (const tx of saved) {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareTransactions(list[middle], tx) < 0) low = middle + 1;
      else high = middle;
    }
    list.splice(low, 0, tx);
  }
  state.snapshot.transactions = list;
  refreshModel();
}

/** Adds or replaces one payment method, person, tag, merchant, or collection, in the server's order. */
function applyListItem(path, item) {
  const key = SNAPSHOT_LISTS[path];
  const list = state.snapshot[key].filter(entry => entry.id !== item.id);
  list.push(item);
  const byName = (a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    return left < right ? -1 : left > right ? 1 : a.id - b.id;
  };
  // Me first, then everyone by name, like tags and merchants; payment methods keep their order.
  list.sort(path === 'people' ? (a, b) => b.isSelf - a.isSelf || byName(a, b) : path === 'payment-methods' ? (a, b) => a.id - b.id : byName);
  state.snapshot[key] = list;
  // Entries carry their merchant's name too.
  if (path === 'merchants') for (const tx of state.snapshot.transactions) if (tx.merchantId === item.id) tx.merchant = item.name;
  refreshModel();
}

function refreshModel() {
  state.model = buildModel(state.snapshot);
  renderAll();
}

/** Everyone a purchase was for (its shares), or the one person a refund or payback is about. */
function peopleOf(tx) {
  return tx.kind === 'Purchase' ? tx.shares.map(share => share.personId) : [tx.personId];
}

function shareOf(purchase, personId) {
  return purchase.shares.find(share => share.personId === personId)?.amountCents ?? 0;
}

/** A gift share is bought for that person but not owed back. */
function isGiftShare(purchase, personId) {
  return purchase?.shares.some(share => share.personId === personId && share.gift) ?? false;
}

function tagIdsOf(tx) {
  return tx.kind === 'Refund' ? state.model.byId.get(tx.linkedId)?.tagIds ?? [] : tx.tagIds;
}

/** Collections work like tags: a refund counts under its purchase's collections. */
function collectionIdsOf(tx) {
  return tx.kind === 'Refund' ? state.model.byId.get(tx.linkedId)?.collectionIds ?? [] : tx.collectionIds;
}

function personName(id) {
  return state.model.people.get(id)?.name ?? `Person #${id}`;
}

function methodName(id) {
  return state.model.methods.get(id)?.name ?? `Method #${id}`;
}

function tagName(id) {
  return state.model.tags.get(id)?.name ?? `Tag #${id}`;
}

function collectionName(id) {
  return state.model.collections.get(id)?.name ?? `Collection #${id}`;
}

/** The part of a purchase bought for people other than you. */
function othersShare(purchase) {
  return purchase.shares.filter(share => share.personId !== state.model.self.id).reduce((sum, share) => sum + share.amountCents, 0);
}

/** "Me", "Me, Alex", "From Alex", or "Alex's share" — who a row is about, as shown in tables. */
function whoLabel(tx) {
  if (tx.kind === 'Payback') return `From ${personName(tx.personId)}`;
  if (tx.kind === 'Refund') {
    const purchase = state.model.byId.get(tx.linkedId);
    return purchase && purchase.shares.length > 1 ? `${personName(tx.personId)}'s share` : personName(tx.personId);
  }
  return tx.shares.map(share => (share.gift ? `${personName(share.personId)} (gift)` : personName(share.personId))).join(', ');
}

/** Short human label: "Merchant — description", whichever parts exist. */
function describeTransaction(tx) {
  return [tx.merchant, tx.description].filter(Boolean).join(' — ');
}

/** A person's share of a purchase not yet covered by refunds or paybacks linked to that share. */
function shareRemaining(purchase, personId, excludingId = null) {
  let covered = 0;
  for (const tx of state.model.linked.get(purchase.id) ?? []) {
    if (tx.id !== excludingId && tx.personId === personId) covered += tx.amountCents;
  }
  return shareOf(purchase, personId) - covered;
}

function purchaseRemaining(purchase, excludingId = null) {
  return purchase.shares.reduce((sum, share) => sum + shareRemaining(purchase, share.personId, excludingId), 0);
}

function transactionsInRange(start, end) {
  return state.model.transactions.filter(tx => tx.date >= start && tx.date <= end);
}

/** What the ledger and calendar list: archived entries stay hidden unless View → Show Archived is on. */
function listedTransactions(start, end) {
  return transactionsInRange(start, end).filter(tx => state.showArchived || !tx.archived);
}

// ---------------------------------------------------------------- time frame

/** Every month from the first entry to the last one, including the current month, oldest first. */
function allMonths() {
  const transactions = state.model.transactions;
  const today = monthOf(todayKey());
  const first = transactions.length && monthOf(transactions[0].date) < today ? monthOf(transactions[0].date) : today;
  const last = transactions.length && monthOf(transactions.at(-1).date) > today ? monthOf(transactions.at(-1).date) : today;
  const months = [];
  for (let month = first; month <= last; month = shiftMonth(month, 1)) months.push(month);
  return months;
}

function timeFrameMonths() {
  return state.timeFrame.all ? allMonths() : [...state.timeFrame.months].sort();
}

function inTimeFrame(date) {
  return state.timeFrame.all || state.timeFrame.months.includes(monthOf(date));
}

/** Entries in the time frame; listed: true leaves out archived ones unless View → Show Archived is on. */
function timeFrameTransactions({ listed = false } = {}) {
  return state.model.transactions.filter(tx => inTimeFrame(tx.date) && (!listed || state.showArchived || !tx.archived));
}

/** The one month chosen, or null for All time or several months. */
function singleTimeFrameMonth() {
  return !state.timeFrame.all && state.timeFrame.months.length === 1 ? state.timeFrame.months[0] : null;
}

/** "All time", "November 2026", "Oct 2026, Nov 2026", or "5 months". */
function timeFrameLabel() {
  if (state.timeFrame.all) return 'All time';
  const months = timeFrameMonths();
  if (months.length === 1) return formatMonth(months[0]);
  if (months.length <= 3) return months.map(month => `${MONTH_NAMES[Number(month.slice(5)) - 1].slice(0, 3)} ${month.slice(0, 4)}`).join(', ');
  return `${months.length} months`;
}

/** A transaction's number inside a scope ("person", "tag", "collection", "merchant", "method"), such as 3 for Alex's third entry. */
function numberIn(tx, scope, scopeId) {
  return tx.numbers.find(entry => entry.scope === scope && entry.scopeId === scopeId)?.number ?? null;
}

const SCOPE_NAMES = { person: personName, tag: tagName, collection: collectionName, merchant: id => state.model.merchants.get(id)?.name ?? `Merchant #${id}`, method: methodName };

/** Every per-scope number of a transaction, people first, each labelled like "Alex #3". */
function scopeNumbers(tx) {
  return Object.keys(SCOPE_NAMES).flatMap(scope => tx.numbers
    .filter(entry => entry.scope === scope)
    .map(entry => ({ ...entry, label: `${SCOPE_NAMES[scope](entry.scopeId)} #${entry.number}` })));
}

/** A saved transaction as a request body, with any fields replaced by changes. */
function transactionRequest(tx, changes = {}) {
  return {
    kind: tx.kind, date: tx.date, amountCents: tx.amountCents, paymentMethodId: tx.paymentMethodId, personId: tx.personId,
    linkedId: tx.linkedId, merchantId: tx.merchantId, description: tx.description, note: tx.note, tagIds: tx.tagIds, collectionIds: tx.collectionIds,
    shares: tx.shares.map(share => ({ personId: share.personId, amountCents: share.amountCents, gift: share.gift })), archived: tx.archived,
    ...changes
  };
}

/** Divides an amount into equal cents for each person; the first people listed get any leftover cent. */
function evenShares(amountCents, personIds) {
  const base = Math.floor(amountCents / personIds.length);
  const leftover = amountCents - base * personIds.length;
  return personIds.map((personId, index) => ({ personId, amountCents: base + (index < leftover ? 1 : 0) }));
}

/**
 * Searches only what the user typed or tagged: merchant, description, note, tags, collections, and the amount (as 12.17 or
 * $12.17). Each searched word can appear anywhere, as in TaskList and NewsReview. The type, payment method, and
 * people are left out so a search like "h" does not match every "Purchase" or "Cash" row. A word like "#12" finds
 * transaction #12 exactly.
 */
function matchesSearch(tx, query) {
  const wanted = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (wanted.length === 0) return true;
  const text = [
    tx.merchant, tx.description, tx.note, centsToInput(tx.amountCents), formatMoney(tx.amountCents),
    ...tagIdsOf(tx).map(tagName), ...collectionIdsOf(tx).map(collectionName)
  ].join(' ').toLowerCase();
  return wanted.every(part => /^#\d+$/.test(part) ? tx.id === Number(part.slice(1)) : text.includes(part));
}

/** The collections of the given entries, each once, by name. */
function collectionsOf(transactions) {
  const ids = new Set(transactions.flatMap(collectionIdsOf));
  return [...ids].map(collectionName).sort((a, b) => a.localeCompare(b));
}
