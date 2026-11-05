> [!WARNING]
> This project is fully vibecoded, probably inefficient, but it does what I wanted lol

# SpendTracker v0.3.3 Manual

SpendTracker is a self-hosted, single-user spending tracker. It replaces a spreadsheet of purchases with a small web app: a monthly ledger, a calendar, a ledger of what other people owe you, user-defined events, an edit history, and statistics.

The guiding rule is **real data only**. SpendTracker never assigns categories, guesses merchants, fills in missing amounts, or estimates anything. Tags exist only when you add them; untagged spending is reported as *Untagged*. Every statistic is a defined calculation over recorded entries, and each one's definition is shown when you hover or tap its underlined label.

The interface uses the same Windows 95-style visual language as TaskList and TaskList Stats, with persistent **Light** and **Dark** themes. It works on desktop and phone screens and can be installed as a PWA.

- [What it does](#what-it-does)
- [Technology stack](#technology-stack)
- [Project layout](#project-layout)
- [Version handling](#version-handling)
- [Configuration and running](#configuration-and-running)
- [Concepts](#concepts)
- [Using the app](#using-the-app)
- [Statistics](#statistics)
- [Data and backups](#data-and-backups)
- [Authentication](#authentication)
- [HTTP API](#http-api)
- [Security and privacy](#security-and-privacy)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Development checks](#development-checks)
- [Release notes](#release-notes)

## What it does

- **Monthly ledger** laid out like a spending spreadsheet: date, for who, what, tags, and one column per payment method, with monthly totals.
- **Purchases, refunds, and paybacks.** Refunds link to the purchase they return. Paybacks record money other people gave you back, optionally settling a specific purchase.
- **People ledger** showing what each person owes you, purchase by purchase.
- **Calendar** with daily net spending, a per-day detail view, and your events.
- **Events**: named date ranges (a trip, a move) with their own totals and stats.
- **Stats** for any month, year, event, or all time: totals, daily averages, no-spend streaks, highest day/week/month, and breakdowns by payment method, person, tag, merchant, weekday, and month.
- **History** of every add, edit, delete, and restore with before/after values.
- **Backup and restore** as a ZIP holding a copy of the database (the same format as TaskList and NewsReview), plus CSV export.
- Light and dark themes, desktop and phone layouts, installable as a PWA.

## Technology stack

- C# / ASP.NET Core Minimal API on .NET 10 (Kestrel)
- SQLite through `Microsoft.Data.Sqlite` (no ORM)
- Plain HTML, CSS, and JavaScript; no frontend framework or build step
- Canvas API for the chart; no chart library
- Service worker and web manifest for PWA install

## Project layout

```text
SpendTracker.csproj     .NET project, dependency, and release version
src/
  Program.cs            hosting, authentication, error responses, and API routes
  Store.cs              SQLite schema, validation rules, history, and restoring rows
  Transfer.cs           backup ZIP creation and restore verification
  SingleFileLogger.cs   capped logs/console.log writer
README.md / MANUAL.md   documentation

wwwroot/
  index.html            app shell, tabs, and dialogs
  app.js                shared state, money and date helpers, API client, derived model
  widgets.js            menus, dropdowns, tables, stat cards, confirm/prompt dialogs
  charts.js             canvas bar chart and tooltips
  transactions.js       monthly ledger, CSV export, transaction editor
  calendar.js           month calendar and day detail
  stats.js              statistics calculations and Stats tab
  people.js             people balances and person detail
  events.js             events list and editor
  history.js            history log rendering
  manage.js             payment methods, people, and tags
  ui.js                 startup, tabs, toolbar, menus, backup/restore, session
  theme.js / theme.css  Light/Dark preference and color tokens
  style.css             Windows 95-style layout and components
  login.html / login.js / auth.css   login and first-run setup
  sw.js                 network-first service worker
  manifest.webmanifest, icons/spend.svg, version.json

tests/
  server.py             starts a real server on a temporary data folder
  test_api.py           API, validation, history, and backup/restore tests
  test_browser.py       optional Playwright browser tests
```

## Version handling

`SpendTracker.csproj` holds the single version number in `<Version>`. The build regenerates `wwwroot/version.json` from it for the browser title, rewriting the file only when the version changes. The service worker cache name is stable: it fetches from the network first with `cache: 'no-store'` and uses its cache only when offline, so new releases never need a cache-version bump.

## Configuration and running

```sh
dotnet run
```

| Setting | Default | How to change |
|---|---|---|
| Listen address | `http://127.0.0.1:8715` (TCP, loopback only) | `dotnet run --urls "http://0.0.0.0:8715"`, the `ASPNETCORE_URLS` environment variable, or a `urls` value in an `appsettings.json` |
| Data folder | `data/` inside the folder SpendTracker runs from (the project folder for `dotnet run`) | not configurable |

There are no other settings. To keep SpendTracker running in the background, start `dotnet run` (or a published build) from the service manager you already use, with the project folder as the working directory and write access to `data/` and `logs/`.

### Updating

Pull the new version and restart. Download a backup first. The database schema is upgraded automatically at startup when a release needs it.

## Concepts

### Transactions

Every entry is one of three types. All amounts are positive; the type decides which direction the money moved.

| Type | Meaning | Required links |
|---|---|---|
| **Purchase** | Money you spent. **For who** records who it was for: one or more people, each with their share. | none |
| **Refund / return** | Money a store gave back for a purchase. | the purchase it refunds |
| **Payback to me** | Money another person gave you for something you paid for. | optionally, the purchase it pays for |

Each transaction also has a date, an amount, a payment method, a merchant and/or a description (at least one is required), optional tags (purchases only), and an optional note.

**Shares.** A purchase for one person is entirely theirs. A purchase for several people (say, dinner for you and two friends) has an amount for each person, and the shares must add up exactly to the purchase. **Split Evenly** divides the amount into equal cents, giving any leftover cent to the first people listed; you can change any share before saving. Each friend's share counts toward what they owe you, and *Spent for others* adds up the shares that are not yours.

**Refunds** never have their own tags; they count under the tags and merchant of the purchase they refund, so a refund on a purchase tagged *food* reduces *food*. Each refund is for one person's share of the purchase: picked automatically when the purchase was for one person, and chosen by you when it was split, so a refund on a friend's share reduces what that friend owes. Refunds are dated on the day the money came back, so they reduce net spent in that day's period, not the purchase's.

**Paybacks** come from someone other than you. Linking a payback to a purchase marks that person's share as (partly) paid back; an unlinked payback still reduces the person's overall balance. Paybacks never change *net spent*, because the purchase still happened; Stats shows them separately as *Paid back to you* and *Net after paybacks*.

The server enforces these rules on every save:

- a refund or payback can only link to a purchase, and cannot be dated before it;
- a purchase's shares add up exactly to its amount, each person appears once, and each share is at least $0.01;
- a refund or linked payback is for someone with a share of that purchase, and refunds plus linked paybacks for one person's share can never exceed that share;
- a purchase with linked refunds/paybacks must stay a purchase, cannot move to a date after them, must keep everyone who has linked entries, and cannot give anyone a share smaller than what is linked to it;
- a purchase with linked entries cannot be deleted until those entries are deleted.

### People

You are the one person marked *(you)*, initially named "Me" (rename it under Manage). Add other people under **Manage → People** and choose them as **For who** on purchases you make for them, alone or together with yourself and others. You cannot archive or delete yourself.

### Payment methods

Payment methods become the amount columns of the ledger, like the Cash / card / bank columns of a spreadsheet. A new database starts with Cash, Credit Card, and Debit Card. When a refund or payback is recorded, its method is where the money arrived.

### Tags

Tags are optional labels you create and assign yourself. A purchase can have several tags. Nothing is ever tagged automatically.

### Events

Events are named date ranges, such as a trip, a move, or a holiday week. They never change transactions; they only group the purchases and refunds dated inside them. Events appear on the calendar and can be chosen as a Stats period.

### Archiving and deleting

Payment methods, people, and tags can be **archived** under Manage. An archived item is no longer offered when adding or editing transactions, but nothing else changes: it stays on every transaction that already has it, and it is still searchable and counted in Stats, People, History, CSV exports, and backups. Editing an old transaction keeps its archived choices. **Restore** makes it available again.

Payment methods and people that are used by transactions cannot be deleted; archive them instead. Unused items can be deleted. Deleting a tag removes it from every transaction that had it; the transactions themselves are kept and History records how many were affected.

## Using the app

### Transactions

The default tab is a monthly ledger. Use **◀ / ▶** or the month dropdown in the toolbar to change months. The cards above the table show the month's spent, refunds, net spent, paybacks, and entry count. The table has one amount column per payment method; refunds show as −$ and paybacks as +$ in green. The footer row shows net spent per payment method (purchases minus refunds; paybacks are excluded).

**Search** filters the month's rows by what you typed or tagged: merchant, description, note, tags, and amount (`12.17` or `$12.17`). Words can match anywhere, including the middle of a word (`inn` finds *dinner*), and every word must match. Searching runs when you press **Search** or Enter, as in TaskList and NewsReview; emptying the box shows every row again. The type, payment method, and people are not searched, so a search never matches a row only because it is a *Purchase* paid with *Cash*.

Select a row (click, or focus it and press Enter) to edit it. **New Transaction** (toolbar or File menu) opens an empty editor. New entries default to today, or to the first day of the viewed month when you are looking at another month, and to the payment method of your most recent purchase. Both defaults are visible and editable before saving.

In the editor, **Type**, **For who**, payment method, and **Tags** are Windows 95-style dropdowns like the ones in TaskList and TaskList Stats. Escape closes an open dropdown without closing the editor.

- **Refund / return** asks which purchase it refunds and shows how much can still be refunded. Choosing the purchase on a new refund selects its payment method, fills an empty amount with what is left to refund, and copies its merchant and description when both are empty.
- **For who** is a dropdown of check items. With one person checked, the whole amount is theirs. With several, an amount box appears for each person, with **Split Evenly** and a running total; Save refuses shares that do not add up to the amount.
- **Refund / return** on a split purchase also asks **Whose share** it refunds.
- **Payback to me** asks who paid you and, optionally, which purchase they had a share of, showing how much of their share is still unpaid.
- **Tags** is a dropdown of check items, so a purchase can have several. Tags are created, renamed, archived, and deleted only under **Manage**.
- Errors from the server are shown in the dialog exactly as returned; nothing is saved until the server accepts the entry.

### Calendar

A month grid for the toolbar's month. Each day shows net spent and the number of entries; the bar along the bottom of a day is relative to the month's biggest day. Event names appear on the days they cover. Select a day to list its entries, edit one, or add a new entry on that date.

### Stats

Choose a **Period**: all time, a year, a month, or an event. See [Statistics](#statistics) for every definition. Selecting a row in the **Months** table opens that month in the ledger.

### People

One row per other person: purchases made for them, refunds on those purchases, paybacks, and the **balance** (bought for them − refunded − paid back). A positive balance is owed to you; a negative one means they paid back more than they owe. Select a person for their purchases (showing their share of split ones) and paybacks, each share's unpaid amount, and **Record Payback**.

### Events

List, add, edit, and delete events. Each row shows days, purchases, net spent, and net spent per day. **Stats** opens the Stats tab for that event.

### History

Every create, edit, delete, and restore, newest first, with the item and the changed fields (old → new). **Load Older** fetches earlier entries. History is stored in the database and included in backups.

### Manage

Add, rename, archive/restore, and delete payment methods, people, and tags. **Used By** counts the transactions using each one.

### Menus

- **File:** New Transaction, Refresh, Export Transactions CSV, Download Backup, Restore Backup, Highlight rows on hover, Log Out.
- **View:** switch tabs and choose the Light or Dark theme. The theme is saved in this browser.

Every color is a token in `wwwroot/theme.css`, defined once for Light and once for Dark, with the same token names TaskList, TaskList Stats, and NewsReview use (`--face`, `--surface`, `--ink`, `--muted`, `--light-edge`, `--dark-edge`, `--title`, …). The other stylesheets and scripts contain no color values, apart from the two browser `theme-color` values `theme.js` writes to the page metadata.
- **Status bar:** messages such as "Added purchase …" appear at the bottom left; entry, people, and tag totals at the bottom right, as in TaskList.
- **Help:** a short explanation of the concepts above, ending with about.lehighradio.com above the version, as in TaskList, TaskList Stats, and NewsReview.

## Statistics

All statistics cover the selected period. A transaction is in a period when its date is inside it.

**Counted days** run from the start of the period to today. If the period ended before today, they run to its end; if an entry is dated after today, they run to that entry. For *All time*, the period starts at your earliest entry.

| Statistic | Definition |
|---|---|
| Spent | Sum of purchases. |
| Refunds | Sum of refunds, on the refund date. |
| Net spent | Spent − refunds. |
| Paid back to you | Sum of paybacks. |
| Net after paybacks | Net spent − paid back to you. |
| Spent for others | Sum of the shares of purchases that belong to people other than you, with its share of spent. |
| Average purchase | Spent ÷ number of purchases. |
| Largest purchase / refund | The single biggest one. |
| Days counted | See above. |
| Average per day | Net spent ÷ counted days, including days without purchases. |
| Average per spending day | Net spent ÷ days with at least one purchase. |
| Spending days | Counted days with at least one purchase. |
| No-spend days | Counted days with no purchase. Refunds and paybacks do not count as spending. |
| Longest no-spend streak | Most consecutive counted days without a purchase. |
| Current no-spend streak | Consecutive days up to today without a purchase; shown only when the period includes today. |
| Highest day | The day with the most net spent (among days with a purchase). |
| Highest week | The Monday–Sunday week with the most net spent, clipped to the days inside the period. |
| Highest month | The month with the most net spent. |
| Lowest full month | The month with the least net spent among months fully inside the period and already over. |

Breakdown tables:

- **By Payment Method:** purchases, spent, refunds, and net per method, and each method's share of spent.
- **By Person:** for each person, the purchases they had a share of and the total of their shares, refunds on their shares, net, and paybacks from them.
- **By Tag:** purchases, spent, refunds, and net per tag, plus **Untagged**. A purchase with two tags counts in both, so tag totals can add up to more than total spent.
- **Day of Week:** purchases and net per weekday, and the average per occurrence of that weekday in the counted days.
- **Merchants:** visits (purchases), spent, refunds, net, average purchase, and last purchase date. Merchant names are grouped ignoring capitalization and shown with their latest spelling. Refunds count under their purchase's merchant.
- **Months:** purchases, spent, refunds, net, change in net from the previous month, and paybacks. The current month is marked *(partial)*.

The chart shows net spent per day for periods of 62 counted days or fewer, otherwise net spent per month.

## Data and backups

All persistent data is in the `data/` folder of the folder SpendTracker runs from (the project folder when started with `dotnet run`):

```text
data/
  spend-tracker.db      SQLite database (WAL mode, so -wal/-shm sidecar files may exist)
  auth.json             salted password hash, created at first-run setup
  backups/              recovery copies written automatically before each restore
logs/
  console.log           runtime log, capped at about 10 MiB
```

### Download Backup

**File → Download Backup** downloads `spend-tracker-YYYYMMDD-HHMMSS.zip`, the same layout TaskList and NewsReview use. It contains exactly two files:

- `spend-tracker.db`: a consistent copy of the whole database (every payment method, person, tag, event, transaction, and history entry), taken with SQLite's online backup, so it is safe while SpendTracker is in use. It is a normal SQLite file you can open with any SQLite tool.
- `manifest.json`: format `spendtracker-backup` version 1, the app version, the database schema version, the export time, the database's SHA-256 checksum, and its row count per table.

It never contains `auth.json` or the password hash. Treat it like your bank statements.

### Restore Backup

**File → Restore Backup** uploads a backup ZIP and replaces **all** current data with it. The password is not changed.

The upload is verified before any live data changes. It is rejected when:

- it is not a ZIP with exactly `manifest.json` and `spend-tracker.db`, or a member is encrypted or too large;
- the manifest is not a SpendTracker backup, or came from a newer SpendTracker version or schema;
- the database does not match the manifest's checksum or row counts, or fails SQLite's integrity check;
- the database has different tables or columns than this version, or contains triggers, views, or virtual tables.

SpendTracker then saves the current data to `data/backups/before-restore-<time>-<id>.zip`, a normal backup ZIP that can itself be restored. It copies the rows (never the backup's schema) in one database transaction, keeping their original IDs so links survive. Before committing, it checks every rule the app enforces on normal saves: real dates, amounts, name and text limits, tags only on purchases, exactly one self person, at least one active payment method, readable history, and the refund and payback rules in [Transactions](#transactions). If anything fails, the transaction rolls back, the recovery copy is removed, and the current data is untouched.

Uploads are limited to 256 MiB and the database inside to 1 GiB. Backups from v0.1.0, which were JSON files, cannot be restored by this version.

### Export Transactions CSV

**File → Export Transactions CSV** downloads every transaction with date, type, for who (with each person's amount when a purchase was split), merchant, description, tags, payment method, amount, linked transaction, and note. Cells starting with `=`, `+`, `-`, or `@` are prefixed with `'` so spreadsheet apps do not run them as formulas. CSV is for viewing and analysis elsewhere; use a backup ZIP to restore.

### Copying the database directly

To back up the files instead, stop SpendTracker first, then copy the whole `data/` folder, including any `-wal` and `-shm` files.

### Schema and migrations

The database records its schema version in `PRAGMA user_version` (currently 2). SpendTracker refuses to open a database with a newer schema version, rather than risk damaging it. Databases and backups from SpendTracker 0.2 (schema 1) cannot be upgraded by this version: start with a new `data/spend-tracker.db`.

## Authentication

On first run, SpendTracker prints a setup token in the server console:

```text
============================================================
SPENDTRACKER FIRST-RUN SETUP TOKEN

  ABCD-1234-EF56-7890

Enter this token on the Create Password screen.
It changes each time SpendTracker restarts until setup is complete.
============================================================
```

Enter it on the **Create Password** screen with a password of at least 8 characters. The token is printed to the console only and is not written to `logs/console.log`.

- Passwords are stored as salted PBKDF2-HMAC-SHA256 hashes with 600,000 iterations. A hash saved with fewer iterations is upgraded at the next successful login.
- Sessions use an HttpOnly, SameSite=Strict cookie named `SpendTracker.Auth`, valid up to 30 days and sliding while active. It is marked Secure when the request uses HTTPS.
- `/api/auth/setup` and `/api/auth/login` allow 5 attempts per source IP per minute.
- Every other `/api` endpoint and the app page require a session; unauthenticated API calls get HTTP 401.

**Reset the password:** stop SpendTracker, delete `data/auth.json`, and start it again. A new setup token is printed. Your spending data is not affected.

## HTTP API

All endpoints are under `/api`, use JSON, and require a session except `auth/status`, `auth/setup`, and `auth/login`. Requests are strict: unknown fields, explicit `null` for non-nullable fields, and malformed JSON are rejected with HTTP 400. Refused requests return `{ "error": "message" }`.

| Method and path | Purpose |
|---|---|
| `GET /api/auth/status` | `version`, `configured`, `authenticated` |
| `POST /api/auth/setup` | `{ setupToken, password, confirmPassword }` |
| `POST /api/auth/login` | `{ password }` |
| `POST /api/auth/logout` | end the session |
| `GET /api/snapshot` | all payment methods, people, tags, events, and transactions |
| `POST /api/transactions` | create; returns the saved transaction |
| `PUT /api/transactions/{id}` | replace all fields |
| `DELETE /api/transactions/{id}` | delete |
| `POST /api/payment-methods`, `/api/people`, `/api/tags` | `{ name }` |
| `PATCH /api/payment-methods/{id}`, `/api/people/{id}`, `/api/tags/{id}` | `{ name?, archived? }` |
| `DELETE /api/payment-methods/{id}`, `/api/people/{id}`, `/api/tags/{id}` | delete when allowed |
| `POST /api/events`, `PUT /api/events/{id}` | `{ name, startDate, endDate, note }` |
| `DELETE /api/events/{id}` | delete |
| `GET /api/history?limit=&beforeId=` | newest-first history page (`limit` 1–500, default 200) and `hasMore` |
| `GET /api/backup` | download a backup ZIP |
| `POST /api/restore` | restore a backup ZIP (raw `application/zip` body, up to 256 MiB) |

A transaction body is:

```json
{
  "kind": "Purchase",
  "date": "2026-10-01",
  "amountCents": 1217,
  "paymentMethodId": 2,
  "personId": null,
  "linkedId": null,
  "merchant": "BK",
  "description": "food",
  "note": "",
  "tagIds": [3],
  "shares": [{ "personId": 1, "amountCents": 617 }, { "personId": 2, "amountCents": 600 }]
}
```

Amounts are integer cents. Dates are `YYYY-MM-DD` calendar dates with no time zone. Purchases send `personId: null` and their `shares`; refunds and paybacks send `shares: []`, a `personId` (whose share is refunded, or who paid you back), and for refunds a `linkedId`. Only purchases may have `tagIds`. Limits: names 60 characters, merchant 120, description 500, note 2000, amount $0.01–$10,000,000.00.

## Security and privacy

- **Network exposure:** loopback by default. Expose it to a LAN only deliberately with `--urls`, behind a firewall. Use HTTPS (for example a private reverse proxy) across untrusted networks; plain HTTP does not protect passwords, cookies, or data in transit.
- **At rest:** the database and backups are not encrypted. Protect the `data/` folder, downloaded backups, and CSV exports with filesystem permissions.
- **Least privilege:** the account running SpendTracker needs read access to the project files and write access to `data/` and `logs/` only.
- **No outbound traffic:** SpendTracker does not contact any external service. The service worker caches only the app's static files, never `/api` responses.
- **Logs:** `logs/console.log` contains startup, restore, and error messages, never passwords, the setup token, or request bodies.

## Known limitations

- One user per installation.
- Amounts are shown in US dollars; there is no currency setting.
- Transfers between your own accounts (paying off a card, withdrawing cash) are not tracked; record only real spending.
- No automatic import yet. Entries are added by hand.
- Stats are computed in the browser from the full snapshot, which is fine for years of personal data but not designed for very large datasets.

## Troubleshooting

### I only see Create Password

No password exists yet (or `data/auth.json` was removed). Enter the setup token from the server console. If no token is active, restart SpendTracker.

### Login says "Too many attempts"

Setup and login allow 5 attempts per IP per minute. Wait a minute.

### "spend-tracker.db uses schema version N"

The database was created by a newer SpendTracker. Update SpendTracker; it will not modify a newer database.

### "spend-tracker.db was created by SpendTracker 0.2"

This version stores split purchases differently and does not upgrade 0.2 databases. Stop SpendTracker, move or delete `data/spend-tracker.db`, and start it again to create a new database.

### A save is refused

The message explains which rule was broken (for example a refund larger than what is left of its purchase). Nothing was saved. See the rules under [Transactions](#transactions).

### Restore failed

Nothing was changed; the message names the problem. Only files downloaded from **File → Download Backup** (or the automatic `data/backups/` copies) can be restored.

### The page shows "Could not load data"

The server is unreachable or the database could not be read. Check that SpendTracker is running and see `logs/console.log`.

## Development checks

```sh
dotnet build
python3 -m unittest discover -s tests -p "test_api.py"
```

`test_api.py` builds the project and starts real servers on temporary data folders, covering authentication, strict request validation, refund/payback rules, split purchases and per-share refunds and paybacks, edits that would break links, tag archiving, archiving and deletion rules, tag deletion, events, history, and backup ZIP round trips plus 23 kinds of rejected restore (damaged ZIPs, wrong manifests, checksum or count mismatches, triggers, views, extra tables or columns, and rows that break app rules), each leaving data unchanged. It uses only the Python standard library.

Optional browser tests use Playwright with Firefox (`pip install playwright` and `playwright install firefox`):

```sh
python3 -m unittest discover -s tests -p "test_browser.py"
```

They run first-run setup, add purchases, refunds, and paybacks through the UI, download and restore a backup ZIP, visit every tab in both themes, check phone-width layout, verify every Stats number for a known month, and fail on any browser error. Set `SPEND_TRACKER_SCREENSHOTS=<folder>` to save screenshots. Python and Playwright are development tools only and are not needed to run SpendTracker.

GitHub Actions (`.github/workflows/tests.yml`) builds SpendTracker and runs `test_api.py` on every push and pull request. The Playwright browser tests stay a local, optional tool.

## Release notes

### v0.3.3

- Search the ledger with a **Search** button (or Enter) instead of on every keystroke, like TaskList, TaskList Stats, and NewsReview. Emptying the box shows every row again.

### v0.3.2

- Search matches anywhere in a word again, like TaskList and NewsReview, but only in merchant, description, note, tags, and amount. The type, payment method, and people are no longer searched, which is what made `h` match every *Purchase* and *Cash* row.

### v0.3.1

- Search matches the start of words instead of letters anywhere, so `h` no longer matches every purchase through the *h* in *Purchase* or *Cash*. Amounts are searchable too.

### v0.3.0

- Split a purchase between several people: **For who** takes one or more people, each with a share; **Split Evenly** fills equal shares. Refunds and paybacks apply to one person's share. This is database schema 2; databases and backups from 0.2 are not upgraded.
- Archive and restore tags under Manage, like payment methods and people. Archived items stay on existing transactions and in search and Stats, but are not offered for new entries.
- Choose tags from a dropdown of check items; tags are only created under Manage.
- Use Windows 95-style dropdowns for Type, For who, and Tags, like TaskList and TaskList Stats.
- Show status messages at the bottom left with totals at the bottom right, and draw the title-bar window icons the same way as the other apps.
- Fix Escape closing the whole editor when a dropdown inside it was open, and fill a new refund from its purchase when that purchase is the only choice.

### v0.2.2

- Move the C# sources into `src/`, matching TaskList, TaskList Stats, and NewsReview. The project file, `wwwroot/`, `tests/`, and every command stay where they were; behavior is unchanged.
- Follow the shared README/MANUAL layout: the README is the quickstart and security notes, and the feature list now opens the manual as **What it does**, followed by the technology, layout, version, and running sections in the same order as the other apps.
- End Help with about.lehighradio.com above the version, like the other apps.

### v0.2.1

- Rename the color tokens to the names shared with TaskList, TaskList Stats, and NewsReview (for example `--theme-text` → `--ink`, `--light` → `--light-edge`, `--teal` → `--desktop`), and make the dialog backdrop the `--backdrop` token. Nothing looks different.

### v0.2.0

- Backups are now ZIP files holding an online copy of the SQLite database and a manifest with a SHA-256 checksum and row counts, the same layout as TaskList and NewsReview. They scale with the database instead of being held in memory as one JSON document.
- Restores verify the ZIP, manifest, checksum, SQLite integrity, and exact table layout, reject triggers and views, and check every app rule before committing in one transaction. Recovery copies are ZIPs and are only kept when a restore succeeds.
- Upload limit raised from 64 MiB to 256 MiB (1 GiB uncompressed).
- Removed the JSON backup format; v0.1.0 JSON backups cannot be restored.
- The service worker now returns a normal network error when a file is neither reachable nor cached, instead of an empty response.

### v0.1.0

First release.

- Purchases, refunds, and paybacks with server-enforced link rules.
- Monthly ledger with one column per payment method, search, and totals.
- People balances, calendar, events, stats, and full change history.
- Payment methods, people, and tags management with archiving.
- JSON backup and atomic restore with automatic recovery copies; CSV export.
- First-run setup token and password login, Light and Dark themes, PWA.
