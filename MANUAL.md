> [!WARNING]
> This project is fully vibecoded, probably inefficient, but it does what I wanted lol

# SpendTracker v1.2.40

SpendTracker is a self-hosted, single-user spending tracker. It replaces a spreadsheet of purchases with a small web app: a ledger for any time frame, a calendar, a ledger of what other people owe you, collections you put on purchases, an edit history, and statistics.

The guiding rule is **real data only**. SpendTracker never assigns categories, guesses merchants, fills in missing amounts, or estimates anything. Tags exist only when you add them; untagged spending is reported as *Untagged*. Every statistic is a defined calculation over recorded entries, and each one's definition is shown when you hover or tap its underlined label.

The interface uses the same Windows 95-style visual language as TaskList and TaskList Stats, with persistent **Light** and **Dark** themes. It works on desktop and phone screens and can be installed as a PWA.

- [What it does](#what-it-does)
- [Technology stack](#technology-stack)
- [Project layout](#project-layout)
- [Version handling](#version-handling)
- [Configuration and running](#configuration-and-running)
- [Authentication](#authentication)
- [First-run backup reminder](#first-run-backup-reminder)
- [Concepts](#concepts)
- [Using the app](#using-the-app)
- [Statistics](#statistics)
- [Import and export](#import-and-export)
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
- **Calendar** with daily net spending for each month in the time frame, a per-day detail view, and the collections of each day's entries.
- **Collections**: labels like tags (a trip, a move) that you put on purchases, with their own totals and stats.
- **Stats** for any month, year, collection, or all time, on six sub-tabs: totals, daily averages, streaks, and records (**Overview**); TaskList Stats-style **Heatmaps** of days, months, tags or merchants by month, and weekdays by week of the month; the net spent chart, running total against the period before, average by month of year, and purchase sizes (**Trends**); how many entries, by time, weekday, size, merchant, and tag (**Counts**); two periods side by side (**Compare**); and people, balances over time, tags, collections, merchants, merchant loyalty, and recurring purchases (**People & Places**).
- **History** of every add, edit, delete, and restore with before/after values.
- **Backup and restore** as a ZIP holding a copy of the database (the same format as TaskList and NewsReview), plus CSV export.
- Light and dark themes, desktop and phone layouts, installable as a PWA.

## Technology stack

- C# / ASP.NET Core Minimal API on .NET 10 (Kestrel)
- SQLite through `Microsoft.Data.Sqlite` (no ORM)
- Plain HTML, CSS, and JavaScript; no frontend framework or build step
- Canvas API for the chart; no chart library
- Web manifest for adding to a phone's home screen (no offline copy, like NewsReview)

## Project layout

```text
SpendTracker.csproj     .NET project, dependency, and release version
src/
  Program.cs            hosting, authentication, error responses, and API routes
  Store.cs              SQLite schema, validation rules, history, and restoring rows
  FreshStart.cs         File > Fresh Start...: counts, clearing chosen data, and compaction (like TaskList's and NewsReview's)
  Transfer.cs           backup ZIP creation and restore verification
  SingleFileLogger.cs   capped logs/console.log writer
  PasswordAuth.cs       setup token, password file, and sign-in cookie (the same file in all four apps)
appsettings.json        listen address and log level
deploy/spendtracker.service
                        example systemd unit
README.md / MANUAL.md   documentation

wwwroot/
  index.html            app shell, tabs, and dialogs
  app.js                shared state, money and date helpers, API client, derived model
  widgets.js            menus, dropdowns, tables, stat cards, confirm/prompt dialogs
  charts.js             canvas bar and line charts and tooltips
  transactions.js       monthly ledger, CSV export, transaction editor
  calendar.js           month calendar and day detail
  stats.js              statistics calculations, Stats sub-tabs, and Overview
  heatmaps.js           Stats > Heatmaps
  insights.js           Stats > Trends, Compare, and People & Places
  counts.js             Stats > Counts
  people.js             people balances and person detail
  summaries.js          Payment Methods, Tags, Collections, and Merchants tabs: totals and actions per item
  fresh-start.js        File > Fresh Start... dialog
  history.js            history log rendering
  manage.js             add, rename, archive, and delete payment methods, people, tags, collections, and merchants
  bulk.js               selection mode and bulk actions in the ledger
  scopes.js             numbered list of one person, tag, merchant, or payment method
  ui.js                 startup, tabs, toolbar, menus, backup/restore, session
  theme.js / theme.css  Light/Dark preference and color tokens
  style.css             Windows 95-style layout and components
  login.html / login.js / auth.css   login and first-run setup
  sw.js                 removes the offline cache earlier releases installed
  manifest.webmanifest, version.json
  icons/                favicon.svg, favicon.ico, and touch-180/192/512.png, the same names in every app

tests/
  server.py             starts a real server on a temporary data folder
  test_api.py           API, validation, history, backup/restore, and Fresh start tests
  test_sign_in.py       setup, login, logout, and the password file (the same file in TaskList and TaskList Stats)
  test_browser.py       optional Playwright browser tests
```

## Version handling

`SpendTracker.csproj` holds the single version number in `<Version>`. The build regenerates `wwwroot/version.json` from it for the browser title, rewriting the file only when the version changes. The server marks pages and scripts `Cache-Control: no-cache`, so the browser checks each with the server on every load and always runs the current release.

## Configuration and running

```sh
dotnet run
```

| Setting | Default | How to change |
|---|---|---|
| Listen address | `http://127.0.0.1:8715` (TCP, loopback only) | `dotnet run --urls "http://0.0.0.0:8715"`, the `ASPNETCORE_URLS` environment variable, or a `urls` value in an `appsettings.json` |
| Data folder | `data/` inside the folder SpendTracker runs from (the project folder for `dotnet run`) | `--data-dir PATH`, a `SpendTracker:DataDirectory` value in an `appsettings.json`, or the `SPENDTRACKER_DATA_DIR` environment variable |

| Environment variable | Purpose |
| --- | --- |
| `SPENDTRACKER_DATA_DIR` | Data folder, overridden by `--data-dir` |
| `ASPNETCORE_URLS` | Listening address, like `--urls`; default `http://127.0.0.1:8715` |

| Command-line option | Purpose |
| --- | --- |
| `--urls URL` | Listening address, for example `http://0.0.0.0:8715` for LAN access |
| `--data-dir PATH` | Data folder (database, password, sign-in keys, recovery backups) |
| `--version` | Print the version and exit |
| `backup --output FILE [--database FILE]` | Consistent SQLite copy of `data/spendtracker.db` (or `--database`), checked with `PRAGMA integrity_check`; refuses to overwrite an existing file |

Releases before v1.2.18 named the database `spend-tracker.db`; SpendTracker renames it on its first start, and backups made before v1.2.18 still restore.

There are no other settings. To keep SpendTracker running in the background, start `dotnet run` (or a published build) from the service manager you already use, with the project folder as the working directory and write access to `data/` and `logs/`.

### Run as a Linux service

`deploy/spendtracker.service` is a systemd template, not an installer, like NewsReview's: build with `dotnet publish -c Release -o /opt/spendtracker`, create the service account, `/var/lib/spendtracker` (the data folder) and `/opt/spendtracker/logs`, adjust `User`, `WorkingDirectory`, `ExecStart`, and `ReadWritePaths` to match, then install and enable it. It listens on loopback at port 8715; change its `--urls` for LAN access, and find the first-run setup token in the journal.

`appsettings.json` holds the default listen address (`Urls`) and log level, the same keys in every app. `--urls` and `ASPNETCORE_URLS` override it.

### Updating

Pull the new version and restart. Download a backup first. The database schema is upgraded automatically at startup when a release needs it.

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

## First-run backup reminder

When SpendTracker creates a fresh database, it records a pending reminder outside SQLite, like TaskList. After password setup/login, the main application shows **Restore a Backup Before Starting**, the same box as TaskList's:

> If you have a SpendTracker backup ZIP, restore it before adding entries. Use File > Import/Export... to restore it. Restoring a backup replaces all current data, so anything you add first would be replaced by a later restore. If you don't have a backup, choose Start Fresh.

**Import/Export...** acknowledges the reminder and opens the Import/Export dialog. **Start Fresh** acknowledges it and continues; it does not reset or delete data. Escape follows Start Fresh. Acknowledgement is saved for the server, so the reminder stays dismissed across browsers and restarts. Existing installations do not acquire the reminder just by updating. A successful restore also acknowledges it, including restores made directly through the API. The reminder marker (`data/import-reminder.pending`) is outside the database and is not part of backups.

## Concepts

### Transactions

Every entry is one of three types. All amounts are positive; the type decides which direction the money moved.

| Type | Meaning | Required links |
|---|---|---|
| **Purchase** | Money you spent. **For who** records who it was for: one or more people, each with their share. | none |
| **Refund / return** | Money a store gave back for a purchase. | the purchase it refunds |
| **Payback to me** | Money another person gave you for something you paid for. | optionally, the purchase it pays for |

Each transaction also has a date, an amount, a payment method, a merchant and/or a description (at least one is required), optional tags (purchases only), and an optional note.

**IDs and numbers.** Every transaction has a permanent **ID** (#12) that is never reused, shown in the ledger's ID column; search `#12` to find it. Every person, payment method, tag, collection, and merchant has its own permanent ID too, shown in the ID column of its tab. Each transaction is also numbered inside every **scope** it belongs to: each person on it (or who paid it back), each of its tags and collections, its merchant, and its payment method. *Alex #3* is the third entry involving Alex, *food #12* the twelfth purchase tagged food, *Diner #5* the fifth visit to Diner, *Cash #40* the fortieth cash entry. Numbers follow the order entries join a scope and are never reused: deleting Alex #2 does not renumber Alex #3, and an entry that leaves a scope (a tag removed) loses that number and gets a new one if it rejoins. The editor shows an entry's numbers at the top; select one (say *Alex #3*) to open Alex's whole numbered list. Selecting a row on the Payment Methods, Tags, Collections, or Merchants tab opens the same list, and the person dialog on the People tab also shows each entry's number for that person. The scopes are one list in `src/Store.cs` (`NumberedScopes`), so a future kind of grouping can be numbered by adding one line. When one is added, SpendTracker numbers existing entries in it at the next start (in date order), and restoring an older backup does the same.

**Archived transactions.** Archiving a transaction (the editor's **Archive** button, or a bulk action) hides it from the ledger and calendar unless **View > Show Archived** is on. It still counts everywhere else: Stats, People balances, refund and payback limits, collections, CSV exports, and backups. **Restore** lists it again.

**Shares.** A purchase for one person is entirely theirs. A purchase for several people (say, dinner for you and two friends) has an amount for each person, and the shares must add up exactly to the purchase. **Split Evenly** divides the amount into equal cents, giving any leftover cent to the first people listed; you can change any share before saving. Each friend's share counts toward what they owe you, and *Spent for others* adds up the shares that are not yours.

**Gifts.** Check **Gift** next to a person in **For who** when you bought their share as a gift: it still counts in their shares (and in *Spent for others*), but they do not owe it back, so it stays off their **Balance** on the People tab unless **Include gifts in Balance** is checked there. Refunds on a gift share are left out the same way. Your own share cannot be a gift, a payback cannot be linked to a gift share, and a share someone has already paid back toward cannot become a gift.

**Refunds** never have their own tags; they count under the tags and merchant of the purchase they refund, so a refund on a purchase tagged *food* reduces *food*. Each refund is for one person's share of the purchase: picked automatically when the purchase was for one person, and chosen by you when it was split, so a refund on a friend's share reduces what that friend owes. Refunds are dated on the day the money came back, so they reduce net spent in that day's period, not the purchase's.

**Paybacks** come from someone other than you. Linking a payback to a purchase marks that person's share as (partly) paid back; an unlinked payback still reduces the person's overall balance. Paybacks never change *net spent*, because the purchase still happened; Stats shows them separately as *Paid back to you* and *Net after paybacks*.

The server enforces these rules on every save:

- a refund or payback can only link to a purchase, and cannot be dated before it;
- a purchase's shares add up exactly to its amount, each person appears once, and each share is at least $0.01;
- a refund or linked payback is for someone with a share of that purchase, and refunds plus linked paybacks for one person's share can never exceed that share;
- a purchase with linked refunds/paybacks must stay a purchase, cannot move to a date after them, must keep everyone who has linked entries, and cannot give anyone a share smaller than what is linked to it;
- a purchase with linked entries cannot be deleted until those entries are deleted.

### People

You are the one person marked *(you)*, initially named "Me" (rename it on the **People** tab). Add other people on the **People** tab and choose them as **For who** on purchases you make for them, alone or together with yourself and others. You cannot archive or delete yourself.

### Payment methods

Payment methods become the amount columns of the ledger, like the Cash / card / bank columns of a spreadsheet. A new database starts with Cash, Credit Card, and Debit Card. When a refund or payback is recorded, its method is where the money arrived. Payment methods are added, renamed, archived, and deleted on the **Payment Methods** tab.

### Tags

Tags are optional labels you create and assign yourself. A purchase can have several tags. Nothing is ever tagged automatically.

### Merchants

Merchants are managed like tags and people (the People, Payment Methods, Tags, Collections, and Merchants tabs each have a search box at the right of their Add row that narrows the list by name when you press **Search**): add them on the **Merchants** tab (names are unique ignoring case), then choose one from the **Merchant** dropdown in the editor, or **No merchant**. There you can also rename them (every entry follows, since entries store the merchant's ID), archive them, and delete unused ones. Stats groups merchants by ID, so a renamed merchant keeps its whole history.

### Collections

Collections work like tags: named labels such as a trip, a move, or a wedding, created on the **Collections** tab and chosen on purchases in the editor (several per purchase if needed). They have no dates of their own; a collection covers exactly the purchases you put on it, wherever they are dated, plus the refunds on those purchases. Like tags, collections can be renamed, archived (kept on existing purchases but no longer offered), and deleted (removed from every purchase). The calendar shows each day's collections from its entries, and a collection can be chosen as a Stats period.

### Archiving and deleting

Payment methods, people, tags, collections, and merchants can be **archived** on their tabs. An archived item is no longer offered when adding or editing transactions, but nothing else changes: it stays on every transaction that already has it, and it is still searchable and counted in Stats, People, History, CSV exports, and backups. Editing an old transaction keeps its archived choices. **Restore** makes it available again.

Payment methods, people, and merchants that are used by transactions cannot be deleted; archive them instead. Unused items can be deleted. Deleting a tag removes it from every transaction that had it; the transactions themselves are kept and History records how many were affected.

## Using the app

**Sorting tables.** Select any column heading to sort its table by that column: once for ascending, again for descending, and a third time for the table's own order (▲ or ▼ marks the sorted column). Money, counts, IDs, and dates sort by value and text alphabetically; empty cells and — go last either way. The ledger sorts every entry in the time frame before drawing its first 200 rows, so a sorted column is sorted all the way down. A table keeps its sort until the page reloads. A heading's definition shows when you hover over it, or on a touch screen when you touch and hold it.

### Transactions

The default tab is the ledger for the **Time frame** chosen in the toolbar: **All time**, one month, or several months checked together in the dropdown (it starts on the current month). In the dropdown, months are listed under their year: select a year to expand or collapse its months without closing the dropdown. A year holding checked months opens on its own and shows how many are checked, such as *2026 (2)*. The dropdown names a single month and shows several as a count, such as *3 months*. All time and months exclude each other: checking All time clears the months, and checking a month leaves All time; the last choice cannot be unchecked, so something is always shown. **◀ / ▶** move every chosen month back or forward by one (off for All time). The title bar names the time frame. The time frame's totals (spent, refunds, net spent, paybacks) are on the Stats tab; the ledger itself starts with the table. Entries are listed newest first, the highest ID on top, as in TaskList. The ledger fills the window and scrolls inside its frame, so the column headers and the **Totals** row stay in view. It draws the newest 200 rows first; below it, **Show 200 More** and **Show All** draw the rest, and the **Totals** row always covers every listed entry in the time frame. Changing the time frame starts again at 200. The table has one amount column per payment method used in the time frame (methods with no entries there get no column), and an **Collections** column once you have created a collection; refunds show as −$ and paybacks as +$ in green. The last column, **Net Spent**, shows what each row adds to net spent: a purchase adds its amount, a refund subtracts it, and a payback shows — because it does not change net spent. The **Totals** footer row shows net spent per payment method and, under Net Spent, for all the listed rows. Archived entries are left out of the table unless **View > Show Archived** is on; a note under the table says how many are hidden; Stats still includes them. With Show Archived on, archived rows are grey and marked *(archived)*.

**Today**, after ◀ / ▶, appears whenever the time frame is anything but this month and goes back to it.

**Filters**, after Time frame on the Transactions tab, is a dropdown of check items grouped by **Type**, **Payment method**, **For who**, **Merchant**, **Tags**, and **Collections**; each group expands and collapses like the Time frame years. The ledger keeps entries matching any checked item in a group and every group with something checked (Cash and Credit Card with the tag *food* lists food bought with either). Refunds count under their purchase's merchant, tags, and collections. One filter shows its name and several show as a count. **Clear Filters** appears beside it while a filter is checked.

The **search box** at the right above the ledger, like the other tabs', with its **Search** button (or Enter, or leaving the box after changing it, as in NewsReview), keeps only the entries in the time frame that match; searching with an empty box lists them all again. It runs only on Search or Enter, not while you type, and looks in what you typed or tagged: merchant, description, note, tags, collections, and amount (`12.17` or `$12.17`). Words can match anywhere, including the middle of a word (`inn` finds *dinner*), and every word must match. A word like `#12` finds transaction #12 exactly. The type, payment method, and people are not searched, so a search never matches a row only because it is a *Purchase* paid with *Cash*. The **Totals** row adds up the matches. To search everything, choose **All time** (and **View > Show Archived** for archived entries).

Double-click a row (or focus it and press Enter) to edit it; a single click does nothing, so a stray click never opens an entry. When an entry in the list is linked to another, a **Linked To** column shows it: a refund's or payback's purchase, or a purchase's refunds and paybacks. Double-click one there to open that entry instead. In the editor, **View Entry in Time** closes it and shows the entry in the ledger: its month, with filters and search cleared (and View > Show Archived turned on for an archived entry), scrolled to and briefly highlighted, as TaskList does for a visited task. The editor's title shows the entry's ID, and the line under it its per-scope numbers. **Archive** / **Restore** saves the editor and changes whether the entry is listed. **New Transaction...** (the bold button at the left of the toolbar, framed like a Windows 95 default button, or the File menu, both on every tab) opens an empty editor. The button is the toolbar's first item, so it stays in the same place on every tab; the Time frame controls follow it on the Transactions and Calendar tabs. New entries default to today, or to the first day of the viewed month when the time frame is one other month, and to the payment method of your most recent purchase. Both defaults are visible and editable before saving.

In the editor, **Type**, **For who**, payment method, and **Tags** are Windows 95-style dropdowns like the ones in TaskList and TaskList Stats. Escape closes an open dropdown without closing the editor. A dropdown with more than ten choices (merchants, tags, people, months, filters) starts with a search box that narrows the list as you type; Enter picks the first match in a one-choice list. A dropdown in a dialog floats over the page, below its box or above it when there is more room there, so a long list is not squeezed into the dialog; scrolling the dialog closes it.

- **Refund / return** asks which purchase it refunds and shows how much can still be refunded. Choosing the purchase on a new refund selects its payment method, fills an empty amount with what is left to refund, and copies its merchant and description when both are empty.
- **For who** is a dropdown of check items. With one person checked, the whole amount is theirs. With several, an amount box appears for each person, with **Split Evenly** and a running total; Save refuses shares that do not add up to the amount.
- **Refund / return** on a split purchase also asks **Whose share** it refunds.
- **Payback to me** asks who paid you and, optionally, which purchase they had a share of, showing how much of their share is still unpaid.
- Every dropdown that lists your own items (**For who**, **Paid back by**, **Paid with**, **Merchant**, **Tags**, and **Collections**) ends with **Add New...**: it asks for a name, adds the item exactly as the Add form on its tab would, and chooses it in the editor.
- **For who** shows a **Gift** box for everyone but you (see *Gifts* above); with several people it sits next to each amount box.
- **Tags** is a dropdown of check items, so a purchase can have several. Tags are created, renamed, archived, and deleted only on the **Tags** tab.
- **Collections** works the same way as Tags, for collections created on the **Collections** tab.
- **Merchant** is a dropdown of your active merchants, like payment methods, plus **No merchant**. Merchants are added on the **Merchants** tab. An archived merchant can stay on entries that already have it but is not offered for others.
- Errors from the server are shown in the dialog exactly as returned; nothing is saved until the server accepts the entry.

### Selecting several entries

**File > Select...** turns on selection mode, as in TaskList. Each ledger row gets a checkbox; click a row or its checkbox to select it, and Shift-click to select every row between the last one clicked and this one. The middle of the menu bar shows **Selected: N** and a split button, with the same sizes and spacing as TaskList. Escape, or **File > Select...** again, leaves selection mode; the choice is remembered in this browser. Selection only covers rows listed in the current time frame. The **Tags**, **Collections**, **People**, and **Merchant** actions' dropdowns end with **Add New...**, which adds one and checks or chooses it.

The split button's main action is **Archive** (or **Restore** when every selected entry is archived). Its ▼ menu has:

| Action | What it does | Skipped when |
|---|---|---|
| **Archive** / **Restore** | hides or lists the entries | already archived / not archived |
| **Tags...** / **Collections...** | **Change** chooses *Add to the selected entries* or *Remove from the selected entries*, then check any number of tags or collections | adding to a refund or payback, or the entry already has / lacks it |
| **People...** | the same Add / Remove choice for any number of people, then **splits the purchase evenly** between everyone on it (the first people listed get any leftover cent) | not a purchase, already on / not on it, or the only person on it |
| **Merchant...** | sets one merchant, chosen from a dropdown of your active merchants (**No merchant** clears it; merchants are added on the Merchants tab) | already has that merchant |
| **Delete** | deletes the entries; refunds and paybacks go first, so a purchase selected with its own refunds is deleted too | the purchase has refunds or paybacks that are not selected |

Every action first asks for confirmation, listing up to 12 selected entries and how many more. Each entry is then saved with an ordinary API call, so the server checks the same rules as a single edit. When it refuses one, for example removing a person with linked paybacks on that purchase, the entry is skipped and the others continue. Afterwards the status bar shows how many changed, and a dialog lists each skipped entry with the reason. Skipped entries stay selected.

### Calendar

One month grid for each month in the toolbar's time frame, newest first (All time shows every month from your first entry). Each day shows net spent and the number of entries (archived entries are left out unless **View > Show Archived** is on); the bar along the bottom of a day is relative to that month's biggest day. A day lists the collections of the entries recorded on it. Days with no entries cannot be selected. Select a day to list its entries with their **Amount** and **Net Spent** (as in the ledger, a payback shows — there), edit one, or add a new entry with **Add to This Day**. Select a collection's name there to show that collection in the calendar: the time frame becomes the months it spans and its days are outlined until you change the time frame or tab. Open the name in a new tab instead (middle-click, or Ctrl/Cmd-click) for its deep link, `/collection/{id}`, like TaskList's `/task/{id}`: it opens the Collections tab with that collection's numbered entries, and survives signing in.

### Stats

**Period** is a dropdown of check items: all time, or any mix of years, months, and collections. All time and the others exclude each other, and the last choice cannot be unchecked. With several periods checked, an entry counts when it falls in any of them, and day-based numbers (counted days, averages, streaks, day of week, months, and the chart's days) use only the days inside the checked periods; a no-spend streak does not carry across the gap between two of them. A collection's period runs from its first to its last entry and counts only its own purchases and the refunds on them (paybacks are not part of collections). See [Statistics](#statistics) for every definition. Selecting a row in the **Months** table opens that month in the ledger.

Stats has six sub-tabs, like TaskList Stats' tabs; the one you were last on is remembered in this browser:

- **Overview:** ten totals (including **Average per day** and **Entries**, which counts purchases, refunds, and paybacks) in two rows of five, then Daily, Records, Streaks, By Payment Method, and Day of Week.
- **Heatmaps:** a year of days, months by year, tags or merchants by month, and weekdays by week of the month. See [Heatmaps](#heatmaps).
- **Trends:** the chart (net spent or other measures per day or month), the running total (against the month or year before), average by month of year, purchase sizes, and the Months table.
- **Counts:** how many entries rather than how much money: entries, purchases, refunds, and paybacks with purchases per day and per spending day; the busiest day, month, weekday, and merchant; entries per day or month and by weekday (by type); purchases by size; and the twelve merchants with the most visits and tags on the most purchases.
- **Compare:** two periods of your choice side by side. It has its own **A** and **B** dropdowns (this month and last month to start), and the Period dropdown does not apply.
- **People & Places:** People, People Over Time, Tags, Collections, Merchants, Merchant Loyalty, and Recurring Purchases.

**Charts** (beside Period) switches charts over time between **Bars** and **Lines**: the Trends chart, Average by Month of Year, and Entries per Day/Month on Counts. Charts of categories (weekdays, sizes, merchants, tags) stay bars, and the running total and People Over Time are always lines. The choice is saved in this browser. In a line chart, counts shown together with money get their own axis on the right, as in the bar chart.

### People

An **Add** form, then one row per person, you first (*(you)*, with no balance) and then everyone by name, as in every list of people: purchases made for them, **Their Shares** (their part of those purchases), **Gifts** (their shares marked as gifts), refunds on those purchases, paybacks, and the **balance** (their shares − refunded − paid back; gifts and refunds on them are left out unless **Include gifts in Balance** is checked, a choice saved in this browser). A positive balance is owed to you; a negative one means they paid back more than they owe. Select a person for their purchases (showing their share of split ones) and paybacks, each entry's number for that person (**No.**), each share's unpaid amount, and **Record Payback**. Balances include archived entries. Each row has **Rename**, **Archive** / **Restore**, and **Delete** (you can only rename yourself); people on transactions cannot be deleted, so archive them instead.

### Payment Methods, Tags, Collections, and Merchants

Four tabs with the same layout: an **Add** form, then one row per payment method, tag, collection, or merchant with its permanent **ID**, purchases, spent, refunds on those purchases, net spent, the dates from its first to its last entry, and **Rename**, **Archive** / **Restore**, and **Delete** (on the Merchants tab these sit in the dialog a merchant's row opens, not on the row) buttons. **Rename** asks for the new name with **Cancel** and **Save** (Enter saves). Each Add box is exactly as tall as its **Add** button. Refunds count under their purchase's tags, collections, and merchant; a purchase with two tags (or collections) counts toward both. Select a row for its numbered list of entries. On the Collections tab, **Stats** opens the Stats tab with that collection as the period. There is no separate Manage tab: each kind is managed on its own tab. Select a row (not its buttons) for its numbered list: every entry in it, newest number first, with each entry's ID, date, type, description, who it was for, and amount (a person's own share for split purchases). Archived entries are included and marked. Gaps in the numbers mean an entry was deleted or left that scope. Select an entry to edit it.

### History

Every create, edit, delete, and restore, newest first, with the item and the changed fields (old → new). **Load Older** fetches earlier entries. The search box at the top, with its **Search** button (or Enter), finds changes anywhere in history whose action, type, ID, or before and after values contain the text (ignoring case), such as a merchant name, description, or amount in cents; searching with an empty box lists everything again. History is stored in the database and included in backups. **File > Fresh Start...** can clear it; see [Fresh Start](#fresh-start).

### Menus

- **File:** New Transaction..., Refresh (loads everything from the server again, for changes made on another device), Select..., Import/Export..., Highlight rows on hover, Log Out, and Fresh Start... at the bottom.
- **View:** switch tabs, **Show Archived**, choose the Light or Dark theme, and **Use Retro Font**. These are saved in this browser.

**View > Use Retro Font** switches the whole app, including the login page and chart labels, to W95FA, an open-source recreation of the Windows 95 MS Sans Serif font bundled in `wwwroot/fonts`, so the interface looks the same on Windows, Linux, macOS, Android, and iOS without installing fonts. It is off by default and saved per browser, separately for each app.
- **Menu bar:** File, View, and Help highlight in the title color on mouse hover and while their menu is open, like the top bar in NewsReview.

Every color is a token in `wwwroot/theme.css`, defined once for Light and once for Dark, with the same token names TaskList, TaskList Stats, and NewsReview use (`--face`, `--surface`, `--ink`, `--muted`, `--light-edge`, `--dark-edge`, `--title`, ...). The other stylesheets and scripts contain no color values, apart from the two browser `theme-color` values `theme.js` writes to the page metadata.
- **Status bar:** messages such as "Added purchase ..." appear at the bottom left; entry, people, and tag totals at the bottom right, as in TaskList.
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
| Longest / current spending streak | The same, for consecutive days with at least one purchase each. |
| Longest streak at or under average | Most consecutive counted days whose net spent was at or under the period's average per day. |
| Highest day | The day with the most net spent (among days with a purchase). |
| Highest week | The Monday–Sunday week with the most net spent, clipped to the days inside the period. |
| Highest month | The month with the most net spent. |
| Lowest full month | The month with the least net spent among months fully inside the period and already over. |

Breakdown tables:

- **By Payment Method:** purchases, spent, refunds, and net per method, and each method's share of spent.
- **Day of Week:** purchases and net per weekday, and the average per occurrence of that weekday in the counted days.

**People**, **Tags**, **Collections**, and **Merchants** share one layout, highest net first: purchases (*visits* for merchants), spent, refunds, net, average purchase, and last purchase date. Select a row for that person's, tag's, collection's, or merchant's numbered list of entries.

- **People:** each person's purchases and the total of their shares (a split purchase counts each person's own share), refunds on their shares, and **Paid Back** (paybacks from them).
- **Tags:** plus **Untagged**. A purchase with two tags counts in both, so tag totals can add up to more than total spent.
- **Collections:** plus **No collection**, the same way as tags.
- **Merchants:** grouped by merchant ID, so a renamed merchant keeps its whole history under its current name, plus *(no merchant)*.

Refunds count under the tags, collections, and merchant of their purchase.

- **People Over Time:** each other person's balance (as on the People tab, following **Include gifts in Balance**) at the end of every month in the period, counting all earlier history too, as a line chart (up to eight people) and a table: the balance just before the period, at its end, the change, and the highest month-end balance. Select a row for the person's dialog.
- **Merchant Loyalty:** for merchants with purchases in the period: visits, first and last visit, months of the period with a visit, the average days between visits on different days, days since your latest purchase there ever, spent, and average visit.
- **Recurring Purchases:** from all history, whatever the period. Three or more purchases at the same merchant (or, without a merchant, with the same description, ignoring case) for exactly the same amount, where every gap between them fits one interval: weekly (6–8 days), every 2 weeks (12–16), monthly (26–35), every 3 months (84–98), every 6 months (174–192), or yearly (355–376). A price change starts a new series. **Next Expected** is the last date plus the average gap (monthly ones keep the first charge's day of the month); one overdue by more than the interval's slack is marked *Stopped?* and left out of the **Active per year** total. **Per Year** is the amount times the repeats in a year. Select a row to edit its latest purchase.
- **Purchase Sizes:** purchases in six size bands (under $10, $10–25, $25–50, $50–100, $100–250, $250 and up), with each band's share of purchases and of spent; and the smallest, median, average, middle half (25th to 75th percentile), and largest purchase.
- **Running Total:** net spent added up day by day through the period, as a line. With a single month or year as the period, a dashed line shows the month or year before, day for day, and the note compares the two at the latest day counted so far (a shorter period before, like February before March, counts at its final total).
- **Average by Month of Year:** net spent in each calendar month, averaged over the years that month appears in the period.
- **Compare:** spent, refunds, net spent, purchases, average purchase, average per day, days counted, spending and no-spend days, paid back, spent for others, and largest purchase for A and B, with A − B and the change as a share of B; then net spent per tag and per merchant in each, the biggest change first.
- **Months:** purchases, spent, refunds, net, change in net from the previous month, and paybacks. The current month is marked *(partial)*.

The chart shows one bar per day for periods of 62 counted days or fewer, otherwise one per month. **Show** is a dropdown of check items, so the chart can show several measures at once, stacked as colored sections of one bar per day or month (negative values stack below the zero line): net spent (the default), spent, refunds, paid back to you, number of purchases, number of entries, average purchase, and running net spent (the total so far through the period). Each measure has its own color, listed in the key above the chart; hover or tap a key entry for its definition. Counts cannot share the money scale, so when both are shown, counts stack in a second, narrower bar right against the money bar, on an axis at the right. Hovering a bar shows every chosen measure for it, with the hovered section in bold. The last measure cannot be unchecked, and the choice is saved in this browser. Hovering (or tapping) a bar shows its tooltip below the pointer in TaskList Stats' chart tooltip style: dark in the Light theme, light in the Dark theme.

### Heatmaps

Drawn like TaskList Stats' heatmaps, with the same colors in both themes. **Show** picks what every heatmap measures: net spent (the default), spent, refunds, or number of purchases. Darker cells hold more. The darkest shade starts at the 90th percentile of the heatmap's cells, so one very large purchase does not wash out everything else; a cell with nothing (or a net of zero or less, from refunds only) is the lightest. Hover a cell for its exact value.

- **Year Heatmap:** every day of the chosen **Year** (this year to start), a column per week, Sunday first, whatever the Period. Purchase counts show inside the squares. Select a day with entries to open its day dialog, as on the Calendar; empty days cannot be selected.
- **Month × Year:** every month of every year with entries, all time. Select a month to open it on the Transactions tab.
- **Tags × Month** (or **Merchants × Month**, from **Rows**): one row per tag or merchant with anything in the period, biggest first, and one column per month of the period. A purchase with two tags counts in both rows, and refunds count under their purchase's tags and merchant. Select a cell for that tag's or merchant's entries in that month.
- **Weekday × Week of Month:** each weekday in each week of the month (days 1–7, 8–14, 15–21, 22–28, and 29–31), as an average per day: the total on those days divided by how many of them the period has, so the short fifth week compares fairly.

### Speed

- The app downloads all of your data once, when it opens. After that, saving, deleting, archiving, bulk actions, and adding, renaming, or archiving a payment method, person, tag, merchant, or collection merge the server's answer into the data already in the browser instead of downloading everything again. Deleting one of those items, Fresh Start, Restore, and **File > Refresh** load everything again, since they can change many entries at once. With 5,000 entries, a save redraws in about 5 ms instead of about 55 ms.
- Stats and its charts (`charts.js`, `stats.js`, `heatmaps.js`, `insights.js`, `counts.js`) load the first time the Stats tab opens, so starting up reads only what the ledger needs.
- The ledger draws 200 rows at a time (about 4 ms instead of about 75 ms for 5,000 rows).
- The server compresses its responses with Brotli or gzip. With 2,000 entries the data download is 139 KB instead of 938 KB, and scripts and styles shrink about threefold. (Only plain HTTP is compressed, ASP.NET's default; behind an HTTPS reverse proxy, let the proxy compress.)

## Import and export

All persistent data is in the `data/` folder of the folder SpendTracker runs from (the project folder when started with `dotnet run`):

```text
data/
  spendtracker.db      SQLite database (WAL mode, so -wal/-shm sidecar files may exist)
  auth.json             salted password hash, created at first-run setup
  keys/                 sign-in cookie keys when there is no Windows profile key ring (Linux, Task Scheduler)
  backups/              recovery copies written automatically before each restore (File > Fresh Start can remove them)
logs/
  console.log           runtime log, capped at about 10 MiB
```

**File > Import/Export...** opens one dialog for backups and CSV, like TaskList's Import/Export: an explanation above each of **Download Backup**, **Choose File to Restore...**, and **Export Transactions CSV**, and an OK button to close it.

### Download Backup

**Download Backup** downloads `spendtracker-backup-YYYYMMDD-HHMMSS.zip` (local time), the same layout TaskList and NewsReview use. It contains exactly two files:

- `spendtracker.db`: a consistent copy of the whole database (every payment method, person, tag, merchant, collection, transaction, per-scope number, and history entry), taken with SQLite's online backup, so it is safe while SpendTracker is in use. It is a normal SQLite file you can open with any SQLite tool.
- `manifest.json`: format `spendtracker-backup` version 1, the app version, the database schema version, the export time, the database's SHA-256 checksum, and its row count per table.

It never contains `auth.json` or the password hash. Treat it like your bank statements.

### Restore Backup

**Choose File to Restore...** closes the dialog, asks for a backup ZIP, and after confirmation uploads it and replaces **all** current data with it. The password is not changed.

The upload is verified before any live data changes. It is rejected when:

- it is not a ZIP with exactly `manifest.json` and `spendtracker.db`, or a member is encrypted or too large;
- the manifest is not a SpendTracker backup, or came from a newer SpendTracker version or schema;
- the database does not match the manifest's checksum or row counts, fails SQLite's integrity check, or has links to missing rows (`PRAGMA foreign_key_check`);
- the database has different tables or columns than this version, or contains triggers, views, or virtual tables.

SpendTracker then saves the current data to `data/backups/before-restore-<time>-<id>.zip`, a normal backup ZIP that can itself be restored. It copies the rows (never the backup's schema) in one database transaction, keeping their original IDs so links survive. Before committing, it checks every rule the app enforces on normal saves: real dates, amounts, name and text limits, merchant names, tags only on purchases, per-scope numbers that belong to the entry's own people, tags, merchant, and payment method and stay within their counters (numbers a backup lacks, say from before a scope existed, are given out after the checks), exactly one self person, at least one active payment method, readable history, and the refund and payback rules in [Transactions](#transactions). If anything fails, the transaction rolls back, the recovery copy is removed, and the current data is untouched.

Uploads are limited to 256 MiB and the database inside to 1 GiB. Backups from v0.1.0, which were JSON files, cannot be restored by this version.

### Fresh Start

**File > Fresh Start...**, at the bottom of the File menu below Log Out so it is kept apart from everyday commands, clears only what you choose and then compacts the database so the space goes back to the disk, like Fresh start in NewsReview and TaskList. Its dialog uses NewsReview's Fresh start size, frame, title bar with a close button, and footer. Tick the items to clear, type `RESET SELECTED`, and choose **Reset Selected Data**. Each choice shows how much it holds, and the dialog shows the current database size. Change history and pre-restore recovery backups are ticked to start with; nothing that removes an entry is.

| Choice | What is cleared |
| --- | --- |
| Archived entries | Archived purchases, refunds, and paybacks. Archived entries still count in totals and balances, so those change. An archived purchase stays while an active (unarchived) refund or payback still links to it; the dialog says how many stay for that reason. |
| Every entry | All purchases, refunds, and paybacks. People, payment methods, merchants, tags, and collections stay. |
| Unused labels | Merchants, tags, collections, people, and payment methods that no remaining entry uses. Me always stays, and so does one active payment method (the oldest one) when no active method is in use. |
| Every label, used ones too | Only together with **Every entry** (ticking it ticks that too). All merchants, tags, collections, people but Me, and payment methods. IDs and per-scope entry numbers then start again at 1, and the payment methods are back to a new database's Cash, Credit Card, and Debit Card. |
| Change history | Every entry on the History tab. |
| Pre-restore recovery backups | The `before-restore-*.zip` files in `data/backups/`. |

Removed entries and labels get Deleted history entries with their old values, exactly like a normal delete, unless the same Fresh start also clears history. Per-person, tag, merchant, payment-method, and collection counters stay, so entry numbers are never reused; numbers of a removed label go with it, as when it is deleted normally.

The database part runs in one SQLite transaction, so a failure changes nothing. Compaction (SQLite `VACUUM`, then a WAL checkpoint) runs afterwards; if it fails, the data is still cleared and the freed space is reused for new data. The status bar reports what was removed and how much space was freed. Your password and browser preferences are kept. Fresh start cannot be undone in SpendTracker, so download a backup first if you might want the data back. It is not a secure disk wipe.

### Export Transactions CSV

**Export Transactions CSV** downloads `spendtracker-transactions-YYYYMMDD-HHMMSS.csv` with every transaction, archived or not, with its ID, date, type, for who (with each person's amount when a purchase was split), merchant, description, tags, payment method, amount, linked transaction, note, and whether it is archived. Cells starting with `=`, `+`, `-`, or `@` are prefixed with `'` so spreadsheet apps do not run them as formulas. CSV is for viewing and analysis elsewhere; use a backup ZIP to restore.

### Copying the database directly

To back up the files instead, stop SpendTracker first, then copy the whole `data/` folder, including any `-wal` and `-shm` files.

### Schema and migrations

The database records its schema version in `PRAGMA user_version` (currently 6). SpendTracker refuses to open a database with a newer schema version, rather than risk damaging it. Databases and backups from SpendTracker 0.2 (schema 1), 0.3 (schema 2), 0.4 (schema 3), 0.5–0.8 (schema 4), and 0.9 (schema 5) cannot be upgraded by this version: start with a new `data/spendtracker.db`.

Schema 6 tables: `payment_methods`, `people`, `tags`, `merchants`, `collections` (named like tags, no dates), `transactions` (with `merchant_id` and `archived`), `transaction_shares` (with `gift`), `transaction_tags`, `transaction_collections`, `scope_numbers` (scope, scope ID, transaction ID, number), `scope_counters` (the last number given out in each scope), and `history`.

## HTTP API

All endpoints are under `/api`, use JSON, and require a session except `auth/status`, `auth/setup`, and `auth/login`. Requests are strict: unknown fields, explicit `null` for non-nullable fields, and malformed JSON are rejected with HTTP 400. Refused requests return `{ "error": "message" }`.

| Method and path | Purpose |
|---|---|
| `GET /api/auth/status` | `version`, `configured`, `authenticated` |
| `POST /api/auth/setup` | `{ setupToken, password, confirmPassword }` |
| `POST /api/auth/login` | `{ password }` |
| `POST /api/auth/logout` | end the session |
| `GET /api/snapshot` | all payment methods, people, tags, merchants, collections, and transactions |
| `POST /api/transactions` | create; returns the saved transaction |
| `PUT /api/transactions/{id}` | replace all fields |
| `DELETE /api/transactions/{id}` | delete |
| `POST /api/payment-methods`, `/api/people`, `/api/tags`, `/api/collections`, `/api/merchants` | `{ name }` |
| `PATCH /api/payment-methods/{id}`, `/api/people/{id}`, `/api/tags/{id}`, `/api/collections/{id}`, `/api/merchants/{id}` | `{ name?, archived? }` |
| `DELETE /api/payment-methods/{id}`, `/api/people/{id}`, `/api/tags/{id}`, `/api/collections/{id}`, `/api/merchants/{id}` | delete when allowed (deleting a tag or collection removes it from its purchases) |
| `GET /api/history?limit=&beforeId=` | newest-first history page (`limit` 1–500, default 200) and `hasMore` |
| `GET /api/backup` | download a backup ZIP |
| `POST /api/restore` | restore a backup ZIP (raw body with `Content-Type: application/zip`, up to 256 MiB) |
| `GET /api/fresh-start` | what Fresh start could clear: `archivedEntries` (removable), `allArchivedEntries`, `entries`, `unusedLabels`, `historyEntries`, `recoveryBackups`, `recoveryBackupBytes`, `databaseBytes` |
| `POST /api/fresh-start` | `{ confirmation: "RESET SELECTED", selections }`, where `selections` maps any of `archivedEntries`, `allEntries`, `unusedLabels`, `history`, `recoveryBackups` to true or false, at least one true; clears them, compacts the database, and returns `removedEntries`, `keptArchivedEntries`, `removedLabels`, `removedHistory`, `removedBackups`, `freedBytes`, `compacted`, and `warning` (null unless compaction or a backup deletion failed) |

A transaction body is:

```json
{
  "kind": "Purchase",
  "date": "2026-10-01",
  "amountCents": 1217,
  "paymentMethodId": 2,
  "personId": null,
  "linkedId": null,
  "merchantId": 4,
  "description": "food",
  "note": "",
  "tagIds": [3],
  "collectionIds": [1],
  "shares": [{ "personId": 1, "amountCents": 617 }, { "personId": 2, "amountCents": 600, "gift": false }],
  "archived": false
}
```

`merchantId` is a merchant from `/api/merchants`, or `null` for none, like `paymentMethodId`; merchant names are not accepted here. `archived` is optional; leaving it out keeps the current value (new entries start unarchived). Saved transactions also include `id`, `merchant` (the merchant's current name, or `""`), `numbers` (`[{ "scope": "person", "scopeId": 2, "number": 3 }, ...]`), `createdAt`, and `updatedAt`. There is no bulk endpoint; the app's bulk actions call `PUT` or `DELETE` once per entry.

Amounts are integer cents. Dates are `YYYY-MM-DD` calendar dates with no time zone. Purchases send `personId: null` and their `shares` (each share may set `"gift": true` for anyone but you; leaving it out means false); refunds and paybacks send `shares: []`, a `personId` (whose share is refunded, or who paid you back), and for refunds a `linkedId`. Only purchases may have `tagIds` and `collectionIds`; leaving either out means none. Limits: names 60 characters, merchant 120 (also for merchant names under Manage), description 500, note 2000, amount $0.01–$10,000,000.00.

## Security and privacy

- **Network exposure:** loopback by default. Expose it to a LAN only deliberately with `--urls`, behind a firewall. Use HTTPS (for example a private reverse proxy) across untrusted networks; plain HTTP does not protect passwords, cookies, or data in transit.
- **At rest:** the database and backups are not encrypted. Protect the `data/` folder, downloaded backups, and CSV exports with filesystem permissions.
- **Least privilege:** the account running SpendTracker needs read access to the project files and write access to `data/` and `logs/` only.
- **No outbound traffic:** SpendTracker does not contact any external service. It keeps no offline copy of its pages; without a connection the browser shows its own offline page, which makes a connection problem obvious instead of opening a stale app that cannot reach its data. It can still be added to a phone's home screen from the web manifest. `sw.js` only removes the service worker and cache that releases before v1.2.23 installed.
- **Logs:** `logs/console.log` contains startup, restore, and error messages, never passwords, the setup token, or request bodies.

## Known limitations

- One user per installation.
- Amounts are shown in US dollars; there is no currency setting.
- Transfers between your own accounts (paying off a card, withdrawing cash) are not tracked; record only real spending.
- No automatic import yet. Entries are added by hand.
- Stats are computed in the browser from the full snapshot, which is fine for years of personal data but not designed for very large datasets.
- After a save, only the saved entries are updated in the browser; changes made on another device or in another tab show up after **File > Refresh** or reloading the page.

## Troubleshooting

### I only see Create Password

No password exists yet (or `data/auth.json` was removed). Enter the setup token from the server console. If no token is active, restart SpendTracker.

### Login says "Too many attempts"

Setup and login allow 5 attempts per IP per minute. Wait a minute.

### "spendtracker.db uses schema version N"

The database was created by a newer SpendTracker. Update SpendTracker; it will not modify a newer database.

### "spendtracker.db was created by an earlier SpendTracker"

This version stores merchants, numbers, and split purchases differently and does not upgrade databases from 0.2, 0.3, or 0.4. Stop SpendTracker, move or delete `data/spendtracker.db`, and start it again to create a new database.

### A save is refused

The message explains which rule was broken (for example a refund larger than what is left of its purchase). Nothing was saved. See the rules under [Transactions](#transactions).

### Restore failed

Nothing was changed; the message names the problem. Only files saved with **File > Import/Export... > Download Backup** (or the automatic `data/backups/` copies) can be restored.

### The page shows "Could not load data"

The server is unreachable or the database could not be read. Check that SpendTracker is running and see `logs/console.log`.

## Development checks

```sh
dotnet build
python3 -m unittest discover -s tests
```

`tests/server.py` (the same file in TaskList, TaskList Stats, and SpendTracker) builds the app and starts the real server on a temporary data folder; `tests/test_sign_in.py` (also the same in all three) checks first-run setup, login, logout, and the saved password file. `test_api.py` builds the project and starts real servers on temporary data folders, covering authentication, strict request validation, refund/payback rules, split purchases and per-share refunds and paybacks, edits that would break links, tag archiving, archiving and deletion rules, tag deletion, merchants, per-person/tag/merchant numbering, archived transactions, restores that fill in missing numbers, collections as labels, history, Fresh start (confirmation, archived entries kept while an active entry links to them, every entry and unused labels keeping Me and one payment method, history and recovery-backup removal, and compaction), and backup ZIP round trips plus 35 kinds of rejected restore (damaged ZIPs, the wrong content type, wrong manifests, older or newer schemas, checksum or count mismatches, triggers, views, extra tables or columns, and rows that break app rules, including numbers for scopes an entry is not in), each leaving data unchanged. It uses only the Python standard library.

Optional browser tests use Playwright with Firefox (`pip install playwright` and `playwright install firefox`):

```sh
python3 -m unittest discover -s tests -p "test_browser.py"
```

They run first-run setup, add purchases, refunds, and paybacks through the UI, download and restore a backup ZIP, visit every tab in both themes, check phone-width layout, choose several months and All time, total collections, select entries and run bulk actions (including a skipped entry and archiving), verify every Stats number for a known month, check the Fresh Start dialog's choices, confirmation, and phone-width fit while clearing only history, and fail on any browser error. Set `SPEND_TRACKER_SCREENSHOTS=<folder>` to save screenshots. Python and Playwright are development tools only and are not needed to run SpendTracker.

GitHub Actions (`.github/workflows/tests.yml`) builds SpendTracker and runs every test file on every push and pull request; the Playwright browser tests skip there (no Playwright), so they stay a local, optional tool.

## Release notes

Current release: **v1.2.40**.

### v1.2.40

- Code: Fresh Start moved out of `Store.cs` into its own `FreshStart.cs`, like TaskList's and NewsReview's.

### v1.2.39

- Code: every script starts with a short comment saying what it holds (and `'use strict';` where it is not a module), like SpendTracker's; `SingleFileLogger.cs` is now the same file in all four apps.

### v1.2.38

- Code: elements are built with the `el(tag, className, text)` helper, the same one in every app. Strings are joined with template strings everywhere.

### v1.2.37

- Dates show in the browser's own format, like the other apps (they were always MM/DD/YYYY).
- An entry's date is typed as m/d/yy (or m/d/yyyy), like the date ranges in every app, instead of using the browser's date picker; a date that isn't real is caught before saving.

### v1.2.36

- MANUAL.md uses the same section names and order as the other apps, with a contents list at the top and a **Current release** line under Release notes; no text was removed, only moved or retitled.
- README.md has a **Sibling apps** section linking all four apps.
- `.gitignore` has the same rules in every app.

### v1.2.35

- Tests start the real server on a temporary data folder with `tests/server.py`, and `tests/test_sign_in.py` checks setup, login, logout, and the password file; both files are the same in TaskList, TaskList Stats, and SpendTracker.
- An unknown API address answers 404 `{ "error": "Not found" }` like NewsReview, instead of the app page (GET) or 405 (POST).
- CI runs every test file (the browser tests skip there), not only test_api.py.

### v1.2.34

- `theme.css` starts with one shared palette, the same color names and values in every app (light and dark), followed by the colors only this app uses.

### v1.2.33

- Dropdowns and menus share one file, `dropdown.js`, the same in every app: Arrow Down/Up move through a menu (Arrow Down on a closed dropdown opens it), Home and End jump to the first and last item, and Escape closes it and returns to its button without closing the dialog under it. A dropdown that would be cut off inside a dialog floats over the page and opens upward when there is more room there, like SpendTracker's.
- Selection-mode check boxes are the Windows 95 kind, like the rest of the app.

### v1.2.32

- Each entry's ID in the ledger is a link that opens the entry with one click, like TaskList's task ID links.
- Names sort one way everywhere, A–Z in the browser's language ignoring capitals and accents, so "Émile" sits with the Es in every list.
- An empty ledger's message is centered in what you can see and wraps on phones instead of being cut off.
- Fix: hover-help popups no longer catch the pointer (a CSS typo).

### v1.2.31

- Every dialog is a `<form method="dialog">`, and its Cancel/Close/OK button is marked `data-close="dialogId"`; one shared handler closes it, the same code in every app.
- Keyboard focus draws the same dotted Windows 95 focus rectangle in every app; mouse clicks draw none.
- Screen readers get the same structure in every app: a hidden page heading with the app name and a **Skip to content** link that appears when you press Tab.
- In Fresh Start, Enter in the confirmation box does what Reset Selected Data does.

### v1.2.30

- The login and main pages share one set of page tags, the same in every app: a description, the iPhone home-screen and status-bar settings, the manifest, and icons.
- Icons live in `/icons/` with the same names in every app: `favicon.svg`, `favicon.ico`, and `touch-180/192/512.png`. The manifest has an app ID, scope, and description.
- The main page sets the iPhone status-bar style like its login page; there is now a `favicon.ico`.

### v1.2.29

- Sign-in code lives in `src/PasswordAuth.cs`, the same file in all four apps. Passwords are capped at 1024 characters and `auth.json` is saved readable only by its owner on Linux and macOS.
- New `appsettings.json` with the listen address and log level, the same keys in every app.
- New `deploy/spendtracker.service` systemd template, like NewsReview's.

### v1.2.28

- Wording matches the other apps: menu paths are written **File > Import/Export...**, only "..." and straight quotes are used.
- Loading text is **Loading...** like the other apps; add and search boxes end with "..." like TaskList's (**New tag...**, **Search people...**).
- **Reset Selected Data** is in Title Case like the other buttons.
- Money, counts, percentages and times use the browser's locale (amounts still show $; amount boxes keep the 1,234.50 style they read back).
- When the session expires, SpendTracker goes to the login page with **Your session has expired.**, like TaskList.

### v1.2.27

- On phones the status bar keeps both sides, like TaskList: the right side shortens with an ellipsis.
- Errors show in the status bar as **Error: ...**, like TaskList, instead of a red panel over the page.

### v1.2.26

- The View menu has a **Tabs** heading over its tab list, like TaskList's **Tasks** heading.

### v1.2.25

- A brand-new database shows **Restore a Backup Before Starting** after the first login, the same box as TaskList's: **Start Fresh** or **Import/Export...**. Updating an existing installation does not show it.

### v1.2.24

- Download names follow one pattern in every app, in local time: `spendtracker-backup-YYYYMMDD-HHMMSS.zip` and `spendtracker-transactions-YYYYMMDD-HHMMSS.csv`.

### v1.2.23

- No offline copy, like NewsReview: without a connection the browser shows its own offline page instead of a stale app. The old service worker and its cache are removed automatically.
- One `theme.js` shared word for word with the other three apps: the page marks its theme with `data-theme`, and it loads at the top of every page, login included, so it never flashes the wrong theme.
- The ledger's row highlight no longer fades when the system asks for reduced motion.

### v1.2.22

- **View > Use Retro Font**: the whole app, login page and chart labels included, can use W95FA, an open-source recreation of the Windows 95 font bundled with the app (SIL Open Font License, `wwwroot/fonts/OFL.txt`), so it looks the same on Windows, Linux, macOS, Android, and iOS. Off by default; saved per browser.

### v1.2.21

- The Fresh Start dialog has no × in its title bar, like every other dialog in the four apps; Enter in the confirmation box no longer reaches it before the confirm button.

### v1.2.20

- The ledger and History search boxes sit at the right, like Merchants'.
- People, Payment Methods, Tags, and Collections have a search box at the right of their Add row, like Merchants.
- On phones the Add and Search rows stack with boxes and buttons the same size.

### v1.2.19

- Restores also run `PRAGMA foreign_key_check`, like TaskList and NewsReview, and refuse a backup with links to missing rows.

### v1.2.18

- The database is now `spendtracker.db` (no hyphen). An existing `spend-tracker.db` is renamed on first start; backups made before this release still restore.
- Command-line options like NewsReview: `--data-dir PATH`, `--version`, and `backup --output FILE`. The data folder can also come from `SpendTracker:DataDirectory` or `SPENDTRACKER_DATA_DIR`.

### v1.2.17

- Startup logs the version and data folder, the database settings, and where the sign-in keys are, in the same three lines as the other apps.
- Without a Windows profile key ring (Linux, Task Scheduler), sign-in keys now live in data/keys like NewsReview, so a systemd service with ProtectHome stays signed in. Expect to log in once after updating.
- The login page words wrong-password and too-many-attempts messages itself; setup conflicts say "A password is already configured."

### v1.2.16

- Browser hardening like NewsReview: a content security policy, no MIME sniffing, no referrer, and writes from other sites are refused.
- API replies are never stored by the browser; pages and scripts are revalidated on each load.
- Requests give up after 30 seconds instead of waiting forever on a stopped server (backups and restores excepted).

### v1.2.15

- The browser tab title leaves out the version ("SpendTracker", "SpendTracker Login"), like the other apps; the title bar and About box still show it.
- Help is a short About box, about as long as TaskList Stats' and NewsReview's, pointing to MANUAL.md for the rest.

### v1.2.14

- Opening the app signed out goes to plain `login.html`, like NewsReview, instead of `login.html?ReturnUrl=%2F`; deep links still keep their address through signing in.

### v1.2.13

- The Home Screen icons leave a margin around the window, like NewsReview's, so iOS's rounded corners no longer cut off its frame and title bar. They have new file names (touch-180.png, touch-192.png, touch-512.png) so iOS downloads them; remove the app from your Home Screen and add it again to update it.

### v1.2.12

- The Home Screen icons have new file names (home-180.png, home-192.png, home-512.png), so iOS downloads the current icon instead of reusing one it saved earlier. To update an app already on your Home Screen, remove it and add it again from Safari's Share menu.

### v1.2.11

- On phones (650px wide or less) the title bar leaves out the version number, which was often cut off; desktops and the About box still show it.

### v1.2.10

- On phones the title bar starts the same distance from the top as TaskList's (`--ios-top-offset`, at least 20px below the status bar).
- Home Screen and app icons are PNGs drawn from the favicon (180, 192, and 512 px), so the installed app's icon matches the browser tab's.

### v1.2.9

- **Linked To** column: a refund's or payback's purchase, or a purchase's refunds and paybacks; double-click one to open it.
- **View Entry in Time** in the editor shows the entry in the ledger, filters and search cleared, briefly highlighted like TaskList.
- **Clear Filters** appears while a filter is checked, and **Today** whenever the time frame is not this month.
- The hint under Refund of / For purchase sits a little lower.

### v1.2.8

- The Filters dropdown is as tall as the Time frame dropdown and its ◀ / ▶ buttons, with the same bevel and a separator before it.

### v1.2.7

- Every dialog puts **Cancel** first and the confirming button (OK, Save, Reset Selected Data) on the right, as in TaskList and NewsReview; Enter still confirms.
- Dropdowns with more than ten choices, such as Merchant and Tags, have a search box at the top.
- People are listed by name after Me, in dropdowns, dialogs, and the People tab.

### v1.2.6

- **Filters** dropdown after Time frame on the Transactions tab: types, payment methods, people, merchants, tags, and collections, grouped and combinable.
- Searches also run when you leave the box after changing it, as in NewsReview.
- A merchant's Rename, Archive, and Delete buttons are in the dialog its row opens.
- Bulk actions can add a new tag, collection, person, or merchant from their dropdowns.
- Dropdowns in dialogs float over the page instead of being cut off by the dialog.
- Phones: the Time frame arrows are drawn instead of characters shown as emoji, text boxes are 16px so focusing them does not zoom, and dialogs no longer scroll sideways.

### v1.2.5

- Select a column heading to sort any table by it (ascending, descending, then the table's own order). The ledger sorts every entry in the time frame, not just the 200 drawn.
- On a touch screen, touch and hold a heading to see its definition; a tap sorts.
- The Merchants search box sits at the far right of its row.

### v1.2.4

- The ledger has a search box with a **Search** button above it, replacing **File > Search...**: it keeps only the matching entries in the time frame (merchant, description, note, tags, collections, amount, or #ID), and the Totals row adds up the matches.
- The Merchants search box sits beside the Add box, and the Merchants and History searches run on their **Search** button or Enter instead of while typing.

### v1.2.3

- The Time frame dropdown shows several months as a count (*3 months*) instead of listing them.
- Merchants and History have search boxes; History searches every recorded change on the server.
- **Fresh Start** can clear every label, used ones too (together with every entry), so IDs and entry numbers start again at 1.
- Ledger rows open on a double click (or Enter) instead of a single click.
- The ledger table uses separate borders, so its pinned Totals row sits flush at the bottom in more browsers.

### v1.2.2

- The ledger only has columns for the payment methods used in the time frame.
- The Time frame dropdown lists months under their years, which expand and collapse in place; you can still check several months, across years.
- The ledger's Totals row covers the few pixels below it, so rows no longer show through underneath at some display scalings.

### v1.2.1

- The server compresses its responses (Brotli or gzip): with 2,000 entries the data download is 139 KB instead of 938 KB.
- Removed an unused screenshot from the repository and leftover styles for the old toolbar search box.

### v1.2.0

- Saves update the data already in the browser instead of downloading every entry again (about 10× faster with 5,000 entries); deleting a list item, Fresh Start, Restore, and File > Refresh still load everything.
- Stats and its charts load the first time the Stats tab opens.
- The ledger shows the newest 200 rows, with **Show 200 More** and **Show All** below it; the Totals row still covers the whole time frame.

### v1.1.0

- The ledger lists entries newest first (highest ID on top), like TaskList, and scrolls inside its frame so its headers and Totals row stay in view.
- Stats > Overview has ten totals in two even rows of five, adding **Average per day** and **Entries**.
- **Charts: Bars / Lines** beside Period switches charts over time between bars and lines; line charts give counts their own axis.
- New **Counts** sub-tab: how many entries rather than how much money, with busiest day, month, weekday, and merchant, and charts of entries over time and by weekday, purchases by size, visits per merchant, and purchases per tag.

### v1.0.0

SpendTracker 1.0: the ledger, calendar, people, collections, history, Stats with heatmaps and trends, and Import/Export are complete.

- The Transactions tab no longer has summary cards above the ledger; the same totals are on Stats > Overview, and the ledger keeps its **Totals** row.
- The net spent chart moves from Stats > Overview to the top of Stats > Trends.
- Notes under charts and heatmaps on Stats have more room above them.
- Running totals across several years label each month once, on its first day.

### v0.14.0

- **Stats sub-tabs**, like TaskList Stats: Overview, Heatmaps, Trends, Compare, and People & Places.
- **Heatmaps** in TaskList Stats' style: a year of days, months by year, tags or merchants by month, and weekdays by week of the month, with one Show choice (net spent, spent, refunds, or purchases).
- **Trends:** running total against the month or year before, average by month of year, and purchase sizes (size bands, median, middle half).
- **Compare** two periods side by side, overall and per tag and merchant.
- **Streaks:** longest and current spending streaks and the longest streak at or under the daily average, beside the no-spend streaks.
- **People & Places:** People Over Time (month-end balances), Merchant Loyalty, and Recurring Purchases (weekly to yearly repeats, next expected date, yearly cost).

### v0.13.0

- **File > Import/Export...** replaces the three File menu items Export Transactions CSV, Download Backup, and Restore Backup with one dialog like TaskList's: an explanation above each of **Download Backup**, **Choose File to Restore...**, and **Export Transactions CSV**, and an OK button.

### v0.12.3

- Muted text in the Dark theme is `#b8b8b8`, and dialogs dim the page with NewsReview's `#0007` backdrop, matching NewsReview, TaskList, and TaskList Stats.

### v0.12.2

- The Dark theme's error red is `#ff9c9c`, the same as NewsReview's and TaskList's, so error text and the Fresh Start **Reset Selected Data** button match across the apps.

### v0.12.1

- **Fresh Start...** moves to the bottom of the File menu, below Log Out.
- The Fresh Start dialog matches NewsReview's Fresh start dialog: size, frame, title bar with ×, footer, and a **Reset Selected Data** button.

### v0.12.0

- Add **File > Fresh Start...**, like NewsReview's and TaskList's: choose what to clear (archived entries, every entry, unused labels, change history, or pre-restore recovery backups), type `RESET SELECTED`, and the database is compacted afterwards to free disk space. Removals are recorded as Deleted unless history is cleared too, and entry numbers are never reused.

### v0.11.4

- The status bar is the same size as TaskList's: body-size text in 24px panels.

### v0.11.3

- Collection names in a day's dialog are links to `/collection/{id}`, like TaskList's `/task/{id}` deep links. A plain click still shows the collection in the calendar; opened in a new tab, the link shows the collection's entries on the Collections tab.
- Calendar days with no entries can no longer be selected.

### v0.11.2

- The transaction editor has an etched divider under each field.
- In a calendar day's dialog, each collection name is a link: it sets the time frame to the months that collection spans, opens the Calendar with its days outlined, and scrolls to its first day. Changing the time frame or tab clears the outline.

### v0.11.1

- The editor's amount boxes show a **$** at the left.
- **For who** rows have more space between them and an etched divider.
- The ledger's **Tags** column wraps between tags instead of growing wider.
- The day dialog's collections line is larger and in the normal text color (white in dark mode).
- **Include gifts in Balance** on the People tab uses the Windows 95 check box.

### v0.11.0

- The editor's **Amount** and split boxes are formatted as `1,234.50` when you leave them.
- **For who** lists each person on a row with a divider, like TaskList's task rows, and waits until its dropdown closes before adding or removing rows, so the editor no longer changes size while you check people.
- **Gift** uses a Windows 95 check box.
- Tags are separated by a dot (`food · gifts`) in the editor, the ledger, and History.
- People: **Bought for Them** is now **Their Shares**.
- Calendar: the day dialog has its own **Net Spent** column like the ledger, **Add on This Day** is now **Add to This Day**, and collection names on days are a little larger.

### v0.10.1

- The Time frame dropdown no longer has an extra black edge under it, so it lines up with its ◀ / ▶ buttons.

### v0.10.0

- **Gifts:** mark a person's share of a purchase as a gift in **For who**. Gifts stay off their balance unless **People > Include gifts in Balance** is checked; the People tab and person dialog show them, and the ledger marks them *(gift)*. The API's shares take `gift`; database schema 6, with no upgrade from schema 5.
- **Add New...** at the end of every editor dropdown of your own items adds one without leaving the editor.
- **New Transaction...** is the first item in the toolbar, so it stays in the top left on every tab.

### v0.9.0

- **Events are now Collections**, everywhere: the tab, editor, bulk action, Stats, search, CSV, and Help, and internally too (database tables `collections` and `transaction_collections`, `/api/collections`, `collectionIds`, the `collection` numbering scope, and `Collection` history entries). Database schema 5; databases and backups from earlier versions are not upgraded.
- **Stats > Period** is a dropdown of check items: combine any years, months, and collections. Entries count when they fall in any checked period, and day-based numbers use only the checked days.
- The **Rename** dialog has **Cancel**, then **Save**; Enter saves.
- Add boxes on each tab are exactly as tall as their **Add** button.

### v0.8.2

- The money and count bars of a chart day touch, with no gap between them.

### v0.8.1

- The ledger's net spent total is its own **Net Spent** column, showing each row's effect and the total in a **Totals** footer row; the Net spent card is back in the first row of cards.
- Several chart measures stack as colored sections of one bar instead of side-by-side bars; counts stack in a second bar on the right axis.

### v0.8.0

- **No more Manage tab:** payment methods, people, tags, events, and merchants are added, renamed, archived, and deleted on their own tabs. A new **Payment Methods** tab totals each method like the Tags, Events, and Merchants tabs; People lists you too.
- **File > Search...** has **Keyword** and **Date** tabs like TaskList, and its fields fill the dialog.
- **Bulk Tags..., Events..., and People...** take any number of check items at once.
- The Stats chart's **Show** is a check list: several measures at once, each in its own color with a key whose entries explain each measure, and a tooltip listing all of them.
- Archived-item errors name the tab to restore them on.

### v0.7.0

- **Search** moved to **File > Search...**, a dialog like TaskList's that searches every transaction in any time frame, archived or not. **New Transaction...** is back in the toolbar so it is there on every tab.
- **Tags** and **Merchants** tabs join People and Events, totaling each tag and merchant the way the Events tab totals events.
- **Bulk actions** are one per kind: **Tags...**, **Events...**, and **People...** ask whether to add or remove, and **Merchant...** sets one, instead of separate Add and Remove items.
- The Stats chart's **Show** dropdown picks net spent, spent, refunds, paybacks, purchases, entries, average purchase, or running net spent.
- File, View, and Help highlight on hover and while open, like NewsReview's top bar.

### v0.6.0

- **Merchant is a dropdown** in the editor, like payment methods and tags, with **No merchant**; merchants are added and managed only under **Manage > Merchants**. The API takes `merchantId` instead of a merchant name.
- **Stats** lists **People**, **Tags**, **Events**, and **Merchants** in the same table layout (purchases, spent, refunds, net, average purchase, last purchase); selecting a row opens its numbered list.
- The chart tooltip matches TaskList Stats: its colors (light in the Dark theme), font, and position below the pointer. Hover help popups keep the note color.
- The Time frame ◀ / ▶ buttons are exactly the dropdown's height.
- **Fixed: the page behind the transaction editor jumped by a pixel** when hovering or clicking in the editor on Windows at fractional scaling (Brave/Chrome). The Merchant box's suggestion arrow, which triggered most of it, is gone with the dropdown, and the scrolling area behind dialogs now keeps one stable layer.

### v0.5.0

- **Time frame** replaces Month in the toolbar: choose **All time**, one month, or several months together. The ledger, its cards, and the calendar (one grid per month) follow it; ◀ / ▶ move the chosen months by one.
- **Events work like tags:** created, renamed, archived, and deleted under **Manage > Events**, and chosen on purchases in the editor or with **Add Event...** / **Remove Event...** in bulk actions. They no longer have dates; an event covers its purchases and the refunds on them. Events are numbered like tags and have numbered lists. The Events tab totals each event, the ledger gains an Events column once events exist, and search and CSV include events.
- **New Transaction...** is a bold default-style button.
- Database schema 4. Databases and backups from 0.4 are not upgraded; start with a new `data/spend-tracker.db`.
- Browser tests sign in with the shared API session after first-run setup, staying under the login rate limit, and ignore Firefox's message for a service-worker fetch abandoned by navigation.

### v0.4.2

- **Set Merchant...** in bulk actions is a dropdown of your merchants, like Add Tag and Add Person, with **No merchant** to clear it.
- The bulk-action chooser no longer scrolls inside a small box: its dropdown opens at full size over the dialog and scrolls on its own.
- **Payment methods** are numbered like people, tags, and merchants (*Cash #40*), and selecting one under Manage lists its entries. Existing entries are numbered at the next start; restoring a backup without these numbers fills them in.
- Selection mode spaces the menu bar exactly like TaskList (full-size buttons, same margins), and the extra **Done** button is gone; Escape or **File > Select...** leaves it.
- The **search bar** moved into the toolbar, filling it like TaskList's new-task bar, and **New Transaction** moved to where the search was, above the ledger.

### v0.4.1

- **Restore** replaces *Unarchive* for archived transactions, matching Manage.
- The selection count and bulk actions sit in the middle of the menu bar, as in TaskList, and move to their own row on narrow screens.
- `POST /api/restore` now requires `Content-Type: application/zip`, so nothing else can be mistaken for a backup upload.
- **Numbered lists:** select a person, tag, or merchant under Manage, or a number such as *Alex #3* at the top of the editor, to list every entry in it with its number.

### v0.4.0

- **IDs:** the ledger shows each entry's permanent ID, and searching `#12` finds entry #12. People, payment methods, tags, merchants, and events show their IDs under Manage.
- **Per-scope numbers:** every entry is numbered within each person, tag, and merchant it belongs to (*Alex #3*, *food #12*), shown in the editor and the person dialog. Numbers are never reused. The scopes are a single list in the server, so new kinds can be numbered later.
- **Merchants** are now their own records with IDs: matched ignoring case, created when first used, and managed (rename, archive, delete unused) under **Manage > Merchants**. Stats groups merchants by ID.
- **Archive transactions:** hidden from the ledger and calendar unless **View > Show Archived** is on, still counted in Stats, balances, and totals.
- **Select and bulk actions** like TaskList: **File > Select...**, Shift-click ranges, and Archive, Unarchive, Add/Remove Tag, Add/Remove Person (re-split evenly), Set Merchant, and Delete. Entries the server's rules refuse are skipped and listed with the reason.
- Database schema 3. Databases and backups from 0.3 are not upgraded; start with a new `data/spend-tracker.db`.

### v0.3.4

- Opening a menu no longer moves focus to its first item, which made **New Transaction...** look stuck highlighted in the File menu. Menus now behave like TaskList and TaskList Stats.

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
