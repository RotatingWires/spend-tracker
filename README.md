> [!WARNING]
> This project is fully vibecoded, probably inefficient, but it does what I wanted lol

# SpendTracker v0.1.0

A self-hosted personal spending tracker with a Windows 95-style interface, built to replace a spending spreadsheet.

**[Full manual](MANUAL.md)** — concepts, every statistic's definition, data files, backup/restore, API, and troubleshooting.

SpendTracker only reports what you record. It never guesses categories, auto-tags purchases, or estimates missing data; every statistic is a defined calculation over your own entries, and its definition is one hover or tap away.

## Features

- **Monthly ledger** laid out like a spending spreadsheet: date, for who, what, tags, and one column per payment method, with monthly totals.
- **Purchases, refunds, and paybacks.** Refunds link to the purchase they return. Paybacks record money other people gave you back, optionally settling a specific purchase.
- **People ledger** showing what each person owes you, purchase by purchase.
- **Calendar** with daily net spending, a per-day detail view, and your events.
- **Events**: named date ranges (a trip, a move) with their own totals and stats.
- **Stats** for any month, year, event, or all time: totals, daily averages, no-spend streaks, highest day/week/month, and breakdowns by payment method, person, tag, merchant, weekday, and month.
- **History** of every add, edit, delete, and restore with before/after values.
- **Backup and restore** as a readable JSON file, plus CSV export.
- Light and dark themes, desktop and phone layouts, installable as a PWA.

## Quickstart

Requires the **.NET 10 SDK**. Nothing else needs to be installed; SQLite is included through the `Microsoft.Data.Sqlite` package.

```sh
git clone https://github.com/RotatingWires/spend-tracker.git
cd spend-tracker
dotnet run
```

SpendTracker listens on **http://127.0.0.1:8715** unless `--urls` (or `ASPNETCORE_URLS`) chooses another address. Open it in a browser. Enter the setup token printed in the server console, choose and confirm a password of at least 8 characters, then start adding transactions.

A new database starts with you ("Me") and three payment methods: Cash, Credit Card, and Debit Card. Rename, add, or archive them under **Manage**.

All data lives in the `data/` folder next to the project (`data/spend-tracker.db`); logs go to `logs/console.log`. Use **File → Download Backup** regularly. See [Data and backups](MANUAL.md#data-and-backups).

## Security and privacy

SpendTracker holds personal financial data. Recommended deployment:

- keep the default loopback address, or use LAN, VPN, or a private reverse proxy
- use HTTPS across untrusted networks
- firewall the port to the devices that need it
- keep `data/`, downloaded backups, and CSV exports private

The quickstart uses plain HTTP on loopback. HTTP does not encrypt passwords, session cookies, or spending data in transit. For LAN access, start it with `dotnet run --urls "http://0.0.0.0:8715"` and connect using the server's actual address; use HTTPS across untrusted networks.

- **Passwords:** salted PBKDF2-HMAC-SHA256 with 600,000 iterations in `data/auth.json`; the plaintext password is never stored. The setup token is printed to the console only and is not written to the log file.
- **Sessions:** HttpOnly, SameSite=Strict cookies lasting up to 30 days, marked Secure when the request uses HTTPS. Setup/login allow 5 attempts per source IP per minute.
- **No third parties:** SpendTracker makes no outbound network requests. The service worker never caches API responses.
- **Backups** contain every entry and the full history but never the password hash.

See the manual for [authentication](MANUAL.md#authentication), [statistics definitions](MANUAL.md#statistics), [configuration](MANUAL.md#configuration-and-running), and [troubleshooting](MANUAL.md#troubleshooting).
