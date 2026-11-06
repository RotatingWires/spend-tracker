> [!WARNING]
> This project is fully vibecoded, probably inefficient, but it does what I wanted lol

# SpendTracker v0.10.1

A self-hosted personal spending tracker with a Windows 95-style interface, built to replace a spending spreadsheet.

**[Full manual](MANUAL.md)** — concepts, every statistic's definition, data files, backup/restore, API, and troubleshooting.

SpendTracker only reports what you record. It never guesses categories, auto-tags purchases, or estimates missing data; every statistic is a defined calculation over your own entries, and its definition is one hover or tap away.

## Quickstart

Requires the **.NET 10 SDK**. Nothing else needs to be installed; SQLite is included through the `Microsoft.Data.Sqlite` package.

```sh
git clone https://github.com/RotatingWires/spend-tracker.git
cd spend-tracker
dotnet run
```

SpendTracker listens on **http://127.0.0.1:8715** unless `--urls` (or `ASPNETCORE_URLS`) chooses another address. Open it in a browser. Enter the setup token printed in the server console, choose and confirm a password of at least 8 characters, then start adding transactions.

A new database starts with you ("Me") and three payment methods: Cash, Credit Card, and Debit Card. Rename, add, or archive them on the **People** and **Payment Methods** tabs.

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
- **Backups** are ZIPs holding a copy of the database with every entry and the full history, but never the password hash.

See the manual for [authentication](MANUAL.md#authentication), [statistics definitions](MANUAL.md#statistics), [configuration](MANUAL.md#configuration-and-running), and [troubleshooting](MANUAL.md#troubleshooting).
