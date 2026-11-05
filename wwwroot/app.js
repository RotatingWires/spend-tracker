'use strict';

/* Shared state, money/date helpers, the API client, and the derived model every view reads from. */

const state = {
  snapshot: null,
  model: null,
  activeTab: 'transactions',
  month: null,
  search: '',
  statsPeriod: 'all',
  loading: null
};

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
  return `/login.html?returnUrl=${encodeURIComponent(returnUrl || '/')}`;
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
  const byId = new Map(snapshot.transactions.map(tx => [tx.id, tx]));
  const self = snapshot.people.find(person => person.isSelf);
  const linked = new Map();
  for (const tx of snapshot.transactions) {
    if (tx.linkedId == null) continue;
    if (!linked.has(tx.linkedId)) linked.set(tx.linkedId, []);
    linked.get(tx.linkedId).push(tx);
  }
  return { methods, people, tags, byId, self, linked, transactions: snapshot.transactions, events: snapshot.events };
}

/** Everyone a purchase was for (its shares), or the one person a refund or payback is about. */
function peopleOf(tx) {
  return tx.kind === 'Purchase' ? tx.shares.map(share => share.personId) : [tx.personId];
}

function shareOf(purchase, personId) {
  return purchase.shares.find(share => share.personId === personId)?.amountCents ?? 0;
}

function tagIdsOf(tx) {
  return tx.kind === 'Refund' ? state.model.byId.get(tx.linkedId)?.tagIds ?? [] : tx.tagIds;
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
  return tx.shares.map(share => personName(share.personId)).join(', ');
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

/**
 * Searches only what the user typed or tagged: merchant, description, note, tags, and the amount (as 12.17 or
 * $12.17). Each searched word can appear anywhere, as in TaskList and NewsReview. The type, payment method, and
 * people are left out so a search like "h" does not match every "Purchase" or "Cash" row.
 */
function matchesSearch(tx, query) {
  const wanted = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (wanted.length === 0) return true;
  const text = [
    tx.merchant, tx.description, tx.note, centsToInput(tx.amountCents), formatMoney(tx.amountCents),
    ...tagIdsOf(tx).map(tagName)
  ].join(' ').toLowerCase();
  return wanted.every(part => text.includes(part));
}

function eventsOn(key) {
  return state.model.events.filter(event => event.startDate <= key && event.endDate >= key);
}
