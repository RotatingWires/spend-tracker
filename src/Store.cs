using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

/// <summary>A request the server refuses. The message is shown to the user, so it must say how to fix the problem.</summary>
sealed class RequestException(int statusCode, string message) : Exception(message)
{
    public int StatusCode { get; } = statusCode;

    public static RequestException Invalid(string message) => new(StatusCodes.Status400BadRequest, message);
    public static RequestException NotFound(string message) => new(StatusCodes.Status404NotFound, message);
}

/// <summary>SQLite storage for SpendTracker. Every change is validated here and recorded in the history table in the same transaction.</summary>
sealed class Store
{
    public const int SchemaVersion = 2;

    /// <summary>Every data table, in an order where referenced rows are inserted before the rows that point at them.</summary>
    public static readonly string[] Tables = ["payment_methods", "people", "tags", "events", "transactions", "transaction_shares", "transaction_tags", "history"];

    const long MaxAmountCents = 1_000_000_000; // $10,000,000.00 — far above any real purchase, small enough to stay exact in JavaScript.
    const int MaxNameLength = 60;
    const int MaxMerchantLength = 120;
    const int MaxDescriptionLength = 500;
    const int MaxNoteLength = 2000;

    static readonly string[] Kinds = ["Purchase", "Refund", "Payback"];
    static readonly JsonSerializerOptions HistoryJson = new(JsonSerializerDefaults.Web);

    readonly string connectionString;
    readonly string databasePath;

    public Store(string databasePath)
    {
        this.databasePath = databasePath;
        connectionString = new SqliteConnectionStringBuilder { DataSource = databasePath, ForeignKeys = true }.ToString();
    }

    public string DatabasePath => databasePath;

    // ---------------------------------------------------------------- schema

    /// <summary>Creates or upgrades the schema and returns the journal mode in use.</summary>
    public string Initialize()
    {
        using var connection = Open();
        var journalMode = CanUseWal(databasePath)
            ? Convert.ToString(Scalar(connection, null, "PRAGMA journal_mode=WAL;"), CultureInfo.InvariantCulture) ?? "unknown"
            : $"{Scalar(connection, null, "PRAGMA journal_mode;")} (WAL skipped: network/unknown drive)";

        var version = Convert.ToInt32(Scalar(connection, null, "PRAGMA user_version;"), CultureInfo.InvariantCulture);
        if (version > SchemaVersion)
            throw new InvalidOperationException($"spend-tracker.db uses schema version {version}, but this SpendTracker build only understands version {SchemaVersion}. Update SpendTracker before opening this database.");
        if (version == SchemaVersion) return journalMode;
        if (version != 0)
            throw new InvalidOperationException($"spend-tracker.db was created by SpendTracker 0.2 (schema {version}), which this version cannot upgrade. Stop SpendTracker, move or delete data/spend-tracker.db, and start again to create a new database.");

        using var transaction = connection.BeginTransaction();
        Execute(connection, transaction, """
            CREATE TABLE payment_methods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
                created_at TEXT NOT NULL
            );
            CREATE TABLE people (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                is_self INTEGER NOT NULL DEFAULT 0 CHECK(is_self IN (0, 1)),
                archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
                created_at TEXT NOT NULL,
                CHECK(is_self = 0 OR archived = 0)
            );
            CREATE UNIQUE INDEX idx_people_single_self ON people(is_self) WHERE is_self = 1;
            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
                created_at TEXT NOT NULL
            );
            CREATE TABLE transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('Purchase', 'Refund', 'Payback')),
                date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
                amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
                -- Payback: who paid you back. Refund: whose share of the purchase it refunds.
                -- Purchase: NULL; who it was for, and how much each, is in transaction_shares.
                person_id INTEGER NULL REFERENCES people(id),
                linked_id INTEGER NULL REFERENCES transactions(id),
                merchant TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NULL,
                CHECK((kind = 'Purchase') = (person_id IS NULL)),
                CHECK(kind <> 'Refund' OR linked_id IS NOT NULL),
                CHECK(kind <> 'Purchase' OR linked_id IS NULL)
            );
            CREATE INDEX idx_transactions_date ON transactions(date, id);
            CREATE INDEX idx_transactions_linked ON transactions(linked_id);
            CREATE TABLE transaction_shares (
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                person_id INTEGER NOT NULL REFERENCES people(id),
                amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                PRIMARY KEY (transaction_id, person_id)
            );
            CREATE TABLE transaction_tags (
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (transaction_id, tag_id)
            );
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                start_date TEXT NOT NULL CHECK(start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
                end_date TEXT NOT NULL CHECK(end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NULL,
                CHECK(end_date >= start_date)
            );
            CREATE TABLE history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('Created', 'Edited', 'Deleted', 'Restored')),
                entity TEXT NOT NULL CHECK(entity IN ('Transaction', 'PaymentMethod', 'Person', 'Tag', 'Event', 'Backup')),
                entity_id INTEGER NULL,
                before_json TEXT NULL,
                after_json TEXT NULL
            );
            """);

        // Starter rows a new user can rename. "Me" is the one person who never owes anyone.
        var now = Now();
        Execute(connection, transaction, """
            INSERT INTO people (name, is_self, created_at) VALUES ('Me', 1, $now);
            INSERT INTO payment_methods (name, created_at) VALUES ('Cash', $now), ('Credit Card', $now), ('Debit Card', $now);
            """, ("$now", now));
        Execute(connection, transaction, $"PRAGMA user_version = {SchemaVersion};");
        transaction.Commit();
        return journalMode;
    }

    static bool CanUseWal(string databasePath)
    {
        try
        {
            var fullPath = Path.GetFullPath(databasePath);
            if (fullPath.StartsWith(@"\\", StringComparison.Ordinal) || fullPath.StartsWith("//", StringComparison.Ordinal))
                return false;
            if (!OperatingSystem.IsWindows()) return true;

            var root = Path.GetPathRoot(fullPath);
            if (string.IsNullOrWhiteSpace(root)) return false;
            var drive = new DriveInfo(root);
            return drive.DriveType is not DriveType.Network and not DriveType.Unknown;
        }
        catch
        {
            return false;
        }
    }

    // ---------------------------------------------------------------- reads

    public Snapshot ReadSnapshot(string version)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred: true);
        return ReadSnapshot(connection, transaction, version);
    }

    static Snapshot ReadSnapshot(SqliteConnection connection, SqliteTransaction transaction, string version) => new(
        version,
        ReadPaymentMethods(connection, transaction),
        ReadPeople(connection, transaction),
        ReadTags(connection, transaction),
        ReadEvents(connection, transaction),
        ReadTransactions(connection, transaction, null));

    public HistoryPage ReadHistory(long? beforeId, int limit)
    {
        limit = Math.Clamp(limit, 1, 500);
        using var connection = Open();
        var entries = ReadHistoryEntries(connection, null, beforeId, limit + 1);
        var hasMore = entries.Count > limit;
        if (hasMore) entries.RemoveAt(entries.Count - 1);
        return new HistoryPage(entries, hasMore);
    }

    static List<PaymentMethod> ReadPaymentMethods(SqliteConnection connection, SqliteTransaction? transaction)
    {
        var methods = new List<PaymentMethod>();
        using var command = Sql(connection, transaction, "SELECT id, name, archived, created_at FROM payment_methods ORDER BY id;");
        using var reader = command.ExecuteReader();
        while (reader.Read())
            methods.Add(new PaymentMethod(reader.GetInt64(0), reader.GetString(1), reader.GetInt64(2) != 0, reader.GetString(3)));
        return methods;
    }

    static List<Person> ReadPeople(SqliteConnection connection, SqliteTransaction? transaction)
    {
        var people = new List<Person>();
        using var command = Sql(connection, transaction, "SELECT id, name, is_self, archived, created_at FROM people ORDER BY is_self DESC, id;");
        using var reader = command.ExecuteReader();
        while (reader.Read())
            people.Add(new Person(reader.GetInt64(0), reader.GetString(1), reader.GetInt64(2) != 0, reader.GetInt64(3) != 0, reader.GetString(4)));
        return people;
    }

    static List<Tag> ReadTags(SqliteConnection connection, SqliteTransaction? transaction)
    {
        var tags = new List<Tag>();
        using var command = Sql(connection, transaction, "SELECT id, name, archived, created_at FROM tags ORDER BY name COLLATE NOCASE, id;");
        using var reader = command.ExecuteReader();
        while (reader.Read())
            tags.Add(new Tag(reader.GetInt64(0), reader.GetString(1), reader.GetInt64(2) != 0, reader.GetString(3)));
        return tags;
    }

    static List<SpendEvent> ReadEvents(SqliteConnection connection, SqliteTransaction? transaction)
    {
        var events = new List<SpendEvent>();
        using var command = Sql(connection, transaction, "SELECT id, name, start_date, end_date, note, created_at, updated_at FROM events ORDER BY start_date, id;");
        using var reader = command.ExecuteReader();
        while (reader.Read())
            events.Add(ReadEvent(reader));
        return events;
    }

    static SpendEvent ReadEvent(SqliteDataReader reader) => new(
        reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
        reader.GetString(4), reader.GetString(5), NullableString(reader, 6));

    static List<SpendTransaction> ReadTransactions(SqliteConnection connection, SqliteTransaction? transaction, long? onlyId)
    {
        var tagsByTransaction = new Dictionary<long, List<long>>();
        using (var tagCommand = Sql(connection, transaction,
            "SELECT transaction_id, tag_id FROM transaction_tags WHERE $id IS NULL OR transaction_id = $id ORDER BY transaction_id, tag_id;",
            ("$id", onlyId)))
        using (var reader = tagCommand.ExecuteReader())
        {
            while (reader.Read())
            {
                var transactionId = reader.GetInt64(0);
                if (!tagsByTransaction.TryGetValue(transactionId, out var tagIds))
                    tagsByTransaction[transactionId] = tagIds = [];
                tagIds.Add(reader.GetInt64(1));
            }
        }

        var sharesByTransaction = new Dictionary<long, List<Share>>();
        using (var shareCommand = Sql(connection, transaction,
            "SELECT transaction_id, person_id, amount_cents FROM transaction_shares WHERE $id IS NULL OR transaction_id = $id ORDER BY transaction_id, person_id;",
            ("$id", onlyId)))
        using (var reader = shareCommand.ExecuteReader())
        {
            while (reader.Read())
            {
                var transactionId = reader.GetInt64(0);
                if (!sharesByTransaction.TryGetValue(transactionId, out var shares))
                    sharesByTransaction[transactionId] = shares = [];
                shares.Add(new Share(reader.GetInt64(1), reader.GetInt64(2)));
            }
        }

        var transactions = new List<SpendTransaction>();
        using var command = Sql(connection, transaction, """
            SELECT id, kind, date, amount_cents, payment_method_id, person_id, linked_id,
                   merchant, description, note, created_at, updated_at
            FROM transactions
            WHERE $id IS NULL OR id = $id
            ORDER BY date, id;
            """, ("$id", onlyId));
        using var rows = command.ExecuteReader();
        while (rows.Read())
        {
            var id = rows.GetInt64(0);
            transactions.Add(new SpendTransaction(
                id,
                rows.GetString(1),
                rows.GetString(2),
                rows.GetInt64(3),
                rows.GetInt64(4),
                rows.IsDBNull(5) ? null : rows.GetInt64(5),
                rows.IsDBNull(6) ? null : rows.GetInt64(6),
                rows.GetString(7),
                rows.GetString(8),
                rows.GetString(9),
                tagsByTransaction.TryGetValue(id, out var tagIds) ? tagIds : [],
                sharesByTransaction.TryGetValue(id, out var shares) ? shares : [],
                rows.GetString(10),
                NullableString(rows, 11)));
        }
        return transactions;
    }

    static List<HistoryEntry> ReadHistoryEntries(SqliteConnection connection, SqliteTransaction? transaction, long? beforeId, int? limit)
    {
        var entries = new List<HistoryEntry>();
        using var command = Sql(connection, transaction, """
            SELECT id, at, action, entity, entity_id, before_json, after_json
            FROM history
            WHERE $beforeId IS NULL OR id < $beforeId
            ORDER BY id DESC
            LIMIT $limit;
            """, ("$beforeId", beforeId), ("$limit", limit ?? -1));
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            entries.Add(new HistoryEntry(
                reader.GetInt64(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetInt64(4),
                ParseJson(NullableString(reader, 5)),
                ParseJson(NullableString(reader, 6))));
        }
        return entries;
    }

    static JsonElement? ParseJson(string? json) => json is null ? null : JsonDocument.Parse(json).RootElement.Clone();

    // ---------------------------------------------------------------- transactions

    public SpendTransaction SaveTransaction(long? id, TransactionRequest request)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();

        SpendTransaction? before = null;
        if (id is not null)
            before = ReadTransactions(connection, transaction, id).SingleOrDefault() ?? throw RequestException.NotFound("Transaction not found.");

        var values = ValidateTransaction(connection, transaction, id, before, request);
        if (before is not null && Unchanged(before, values)) return before; // Keeps the original updated_at and adds no history.

        var now = Now();
        long savedId;
        if (before is null)
        {
            savedId = Convert.ToInt64(Scalar(connection, transaction, """
                INSERT INTO transactions
                    (kind, date, amount_cents, payment_method_id, person_id, linked_id, merchant, description, note, created_at)
                VALUES
                    ($kind, $date, $amount, $method, $person, $linked, $merchant, $description, $note, $now);
                SELECT last_insert_rowid();
                """, TransactionParameters(values, now)), CultureInfo.InvariantCulture);
        }
        else
        {
            savedId = before.Id;
            Execute(connection, transaction, """
                UPDATE transactions SET
                    kind = $kind, date = $date, amount_cents = $amount, payment_method_id = $method,
                    person_id = $person, linked_id = $linked, merchant = $merchant,
                    description = $description, note = $note, updated_at = $now
                WHERE id = $id;
                """, [.. TransactionParameters(values, now), ("$id", savedId)]);
            Execute(connection, transaction, "DELETE FROM transaction_tags WHERE transaction_id = $id; DELETE FROM transaction_shares WHERE transaction_id = $id;", ("$id", savedId));
        }
        foreach (var tagId in values.TagIds)
            Execute(connection, transaction, "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($id, $tag);", ("$id", savedId), ("$tag", tagId));
        foreach (var share in values.Shares)
            Execute(connection, transaction, "INSERT INTO transaction_shares (transaction_id, person_id, amount_cents) VALUES ($id, $person, $amount);",
                ("$id", savedId), ("$person", share.PersonId), ("$amount", share.AmountCents));

        var after = ReadTransactions(connection, transaction, savedId).Single();
        RecordHistory(connection, transaction, before is null ? "Created" : "Edited", "Transaction", savedId, before, after);
        transaction.Commit();
        return after;
    }

    static bool Unchanged(SpendTransaction before, TransactionValues values) =>
        before.Kind == values.Kind && before.Date == values.Date && before.AmountCents == values.AmountCents &&
        before.PaymentMethodId == values.PaymentMethodId && before.PersonId == values.PersonId && before.LinkedId == values.LinkedId &&
        before.Merchant == values.Merchant && before.Description == values.Description && before.Note == values.Note &&
        before.TagIds.SequenceEqual(values.TagIds) && before.Shares.SequenceEqual(values.Shares);

    static (string Name, object? Value)[] TransactionParameters(TransactionValues values, string now) =>
    [
        ("$kind", values.Kind), ("$date", values.Date), ("$amount", values.AmountCents), ("$method", values.PaymentMethodId),
        ("$person", values.PersonId), ("$linked", values.LinkedId), ("$merchant", values.Merchant),
        ("$description", values.Description), ("$note", values.Note), ("$now", now)
    ];

    static TransactionValues ValidateTransaction(SqliteConnection connection, SqliteTransaction transaction, long? id, SpendTransaction? before, TransactionRequest request)
    {
        var kind = Kinds.FirstOrDefault(k => string.Equals(k, request.Kind?.Trim(), StringComparison.OrdinalIgnoreCase))
            ?? throw RequestException.Invalid("Type must be Purchase, Refund, or Payback.");
        var date = RequireDate(request.Date, "Date");
        var amount = request.AmountCents ?? throw RequestException.Invalid("Amount is required.");
        if (amount < 1 || amount > MaxAmountCents)
            throw RequestException.Invalid("Amount must be between $0.01 and $10,000,000.00.");

        var methodId = request.PaymentMethodId ?? throw RequestException.Invalid("Payment method is required.");
        var methodArchived = Scalar(connection, transaction, "SELECT archived FROM payment_methods WHERE id = $id;", ("$id", methodId))
            ?? throw RequestException.Invalid("That payment method no longer exists.");
        if (Convert.ToInt64(methodArchived, CultureInfo.InvariantCulture) != 0 && before?.PaymentMethodId != methodId)
            throw RequestException.Invalid("That payment method is archived. Restore it under Manage to use it again.");

        var merchant = OptionalText(request.Merchant, MaxMerchantLength, "Merchant");
        var description = OptionalText(request.Description, MaxDescriptionLength, "Description");
        var note = OptionalText(request.Note, MaxNoteLength, "Note");
        if (merchant.Length == 0 && description.Length == 0)
            throw RequestException.Invalid("Enter a merchant or a description so you can recognize this later.");

        var tagIds = (request.TagIds ?? []).Distinct().Order().ToList();
        if (kind != "Purchase" && tagIds.Count > 0)
            throw RequestException.Invalid("Only purchases have tags. Refunds count under their purchase's tags.");
        foreach (var tagId in tagIds)
        {
            var tagArchived = Scalar(connection, transaction, "SELECT archived FROM tags WHERE id = $id;", ("$id", tagId))
                ?? throw RequestException.Invalid("One of the selected tags no longer exists. Refresh and try again.");
            if (Convert.ToInt64(tagArchived, CultureInfo.InvariantCulture) != 0 && before?.TagIds.Contains(tagId) != true)
                throw RequestException.Invalid("That tag is archived. Restore it under Manage to use it again.");
        }

        long? personId = request.PersonId;
        long? linkedId = request.LinkedId;
        List<Share> shares = [];
        if (kind != "Purchase" && request.Shares is { Count: > 0 })
            throw RequestException.Invalid("Only purchases are split between people.");
        switch (kind)
        {
            case "Purchase":
                if (linkedId is not null) throw RequestException.Invalid("A purchase cannot be linked to another transaction.");
                if (personId is not null) throw RequestException.Invalid("A purchase lists who it was for in its shares, not in personId.");
                shares = ValidateShares(connection, transaction, request.Shares, amount, before);
                break;

            case "Refund":
                var refunded = RequireLinkedPurchase(connection, transaction, id, linkedId, "Choose the purchase this refund is for.");
                if (string.CompareOrdinal(date, refunded.Date) < 0)
                    throw RequestException.Invalid("A refund cannot be dated before its purchase.");
                var refundShare = RequireShare(connection, transaction, refunded.Id, personId, "Choose whose share of the purchase this refund is for.");
                if (LinkedShareTotal(connection, transaction, refunded.Id, personId!.Value, id) + amount > refundShare)
                    throw RequestException.Invalid($"Refunds and paybacks for {PersonName(connection, transaction, personId.Value)}'s share would total more than their {FormatCents(refundShare)}.");
                break;

            case "Payback":
                var payer = RequireUsablePerson(connection, transaction, personId, before?.PersonId, "Choose who paid you back.");
                if (payer.IsSelf) throw RequestException.Invalid("A payback must come from someone other than you.");
                if (linkedId is not null)
                {
                    var repaid = RequireLinkedPurchase(connection, transaction, id, linkedId, "Choose the purchase this payback is for.");
                    if (string.CompareOrdinal(date, repaid.Date) < 0)
                        throw RequestException.Invalid("A payback cannot be dated before its purchase.");
                    var paybackShare = RequireShare(connection, transaction, repaid.Id, personId,
                        "A payback can only be linked to a purchase that person had a share of.");
                    if (LinkedShareTotal(connection, transaction, repaid.Id, personId!.Value, id) + amount > paybackShare)
                        throw RequestException.Invalid($"Refunds and paybacks for {PersonName(connection, transaction, personId.Value)}'s share would total more than their {FormatCents(paybackShare)}.");
                }
                break;
        }

        if (before?.Kind == "Purchase" && id is not null)
            ValidatePurchaseDependents(connection, transaction, id.Value, kind, date, shares);

        return new TransactionValues(kind, date, amount, methodId, personId, linkedId, merchant, description, note, tagIds, shares);
    }

    /// <summary>Who a purchase was for: each person once, each share at least a cent, adding up exactly to the amount.</summary>
    static List<Share> ValidateShares(SqliteConnection connection, SqliteTransaction transaction, List<ShareRequest>? requested, long amount, SpendTransaction? before)
    {
        if (requested is null || requested.Count == 0) throw RequestException.Invalid("Choose who this purchase was for.");
        var shares = new List<Share>();
        foreach (var share in requested)
        {
            var personId = share.PersonId ?? throw RequestException.Invalid("Every share needs a person.");
            var cents = share.AmountCents ?? throw RequestException.Invalid("Every share needs an amount.");
            if (cents < 1) throw RequestException.Invalid("Each person's share must be at least $0.01.");
            if (shares.Any(s => s.PersonId == personId)) throw RequestException.Invalid("Each person can only be on a purchase once.");
            var wasOnPurchase = before?.Shares.Any(s => s.PersonId == personId) == true;
            RequireUsablePerson(connection, transaction, personId, wasOnPurchase ? personId : null, "Choose who this purchase was for.");
            shares.Add(new Share(personId, cents));
        }
        var total = shares.Sum(s => s.AmountCents);
        if (total != amount)
            throw RequestException.Invalid($"The shares add up to {FormatCents(total)}, but the purchase is {FormatCents(amount)}.");
        return shares.OrderBy(s => s.PersonId).ToList();
    }

    /// <summary>Editing a purchase must keep every refund and payback that points at it valid.</summary>
    static void ValidatePurchaseDependents(SqliteConnection connection, SqliteTransaction transaction, long id, string kind, string date, List<Share> shares)
    {
        var dependents = ReadDependents(connection, transaction, id);
        if (dependents.Count == 0) return;
        if (kind != "Purchase")
            throw RequestException.Invalid("This purchase has linked refunds or paybacks, so it must stay a purchase.");
        if (dependents.Any(d => string.CompareOrdinal(d.Date, date) < 0))
            throw RequestException.Invalid("A linked refund or payback is dated before that date.");
        foreach (var group in dependents.GroupBy(d => d.PersonId!.Value))
        {
            var name = PersonName(connection, transaction, group.Key);
            var share = shares.FirstOrDefault(s => s.PersonId == group.Key)
                ?? throw RequestException.Invalid($"{name} has linked refunds or paybacks on this purchase, so they must stay on it.");
            var linked = group.Sum(d => d.AmountCents);
            if (linked > share.AmountCents)
                throw RequestException.Invalid($"Refunds and paybacks for {name}'s share already total {FormatCents(linked)}; their share cannot be less than that.");
        }
    }

    public void DeleteTransaction(long id)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadTransactions(connection, transaction, id).SingleOrDefault() ?? throw RequestException.NotFound("Transaction not found.");
        var dependents = ReadDependents(connection, transaction, id);
        if (dependents.Count > 0)
            throw RequestException.Invalid($"This purchase has {dependents.Count} linked refund/payback {(dependents.Count == 1 ? "entry" : "entries")}. Delete those first.");
        Execute(connection, transaction, "DELETE FROM transactions WHERE id = $id;", ("$id", id));
        RecordHistory(connection, transaction, "Deleted", "Transaction", id, before, null);
        transaction.Commit();
    }

    static List<(string Kind, string Date, long AmountCents, long? PersonId)> ReadDependents(SqliteConnection connection, SqliteTransaction transaction, long id)
    {
        var dependents = new List<(string, string, long, long?)>();
        using var command = Sql(connection, transaction, "SELECT kind, date, amount_cents, person_id FROM transactions WHERE linked_id = $id;", ("$id", id));
        using var reader = command.ExecuteReader();
        while (reader.Read())
            dependents.Add((reader.GetString(0), reader.GetString(1), reader.GetInt64(2), reader.IsDBNull(3) ? null : reader.GetInt64(3)));
        return dependents;
    }

    static (long Id, string Date) RequireLinkedPurchase(SqliteConnection connection, SqliteTransaction transaction, long? selfId, long? linkedId, string missingMessage)
    {
        if (linkedId is null) throw RequestException.Invalid(missingMessage);
        if (linkedId == selfId) throw RequestException.Invalid("A transaction cannot be linked to itself.");
        using var command = Sql(connection, transaction, "SELECT id, kind, date FROM transactions WHERE id = $id;", ("$id", linkedId));
        using var reader = command.ExecuteReader();
        if (!reader.Read()) throw RequestException.Invalid("The linked purchase no longer exists.");
        if (reader.GetString(1) != "Purchase") throw RequestException.Invalid("Refunds and paybacks can only be linked to a purchase.");
        return (reader.GetInt64(0), reader.GetString(2));
    }

    /// <summary>The share a person had of a purchase; refunds and paybacks are always for one person's share.</summary>
    static long RequireShare(SqliteConnection connection, SqliteTransaction transaction, long purchaseId, long? personId, string missingMessage)
    {
        if (personId is null) throw RequestException.Invalid(missingMessage);
        var share = Scalar(connection, transaction, "SELECT amount_cents FROM transaction_shares WHERE transaction_id = $purchase AND person_id = $person;",
            ("$purchase", purchaseId), ("$person", personId));
        return share is null ? throw RequestException.Invalid(missingMessage) : Convert.ToInt64(share, CultureInfo.InvariantCulture);
    }

    static long LinkedShareTotal(SqliteConnection connection, SqliteTransaction transaction, long purchaseId, long personId, long? excludingId) =>
        Convert.ToInt64(Scalar(connection, transaction,
            "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE linked_id = $purchase AND person_id = $person AND ($exclude IS NULL OR id <> $exclude);",
            ("$purchase", purchaseId), ("$person", personId), ("$exclude", excludingId)), CultureInfo.InvariantCulture);

    static string PersonName(SqliteConnection connection, SqliteTransaction transaction, long personId) =>
        Convert.ToString(Scalar(connection, transaction, "SELECT name FROM people WHERE id = $id;", ("$id", personId)), CultureInfo.InvariantCulture) ?? $"Person #{personId}";

    static (long Id, bool IsSelf) RequireUsablePerson(SqliteConnection connection, SqliteTransaction transaction, long? personId, long? previousPersonId, string missingMessage)
    {
        if (personId is null) throw RequestException.Invalid(missingMessage);
        using var command = Sql(connection, transaction, "SELECT is_self, archived FROM people WHERE id = $id;", ("$id", personId));
        using var reader = command.ExecuteReader();
        if (!reader.Read()) throw RequestException.Invalid("That person no longer exists.");
        if (reader.GetInt64(1) != 0 && previousPersonId != personId)
            throw RequestException.Invalid("That person is archived. Restore them under Manage to use them again.");
        return (personId.Value, reader.GetInt64(0) != 0);
    }

    // ---------------------------------------------------------------- payment methods, people, tags

    public PaymentMethod CreatePaymentMethod(NameRequest request)
    {
        var name = RequireName(request.Name, "Payment method name");
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        EnsureNameFree(connection, transaction, "payment_methods", name, null, "A payment method with that name already exists.");
        var id = Convert.ToInt64(Scalar(connection, transaction,
            "INSERT INTO payment_methods (name, created_at) VALUES ($name, $now); SELECT last_insert_rowid();",
            ("$name", name), ("$now", Now())), CultureInfo.InvariantCulture);
        var created = ReadPaymentMethods(connection, transaction).Single(m => m.Id == id);
        RecordHistory(connection, transaction, "Created", "PaymentMethod", id, null, created);
        transaction.Commit();
        return created;
    }

    public PaymentMethod UpdatePaymentMethod(long id, UpdateNameRequest request)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadPaymentMethods(connection, transaction).SingleOrDefault(m => m.Id == id) ?? throw RequestException.NotFound("Payment method not found.");
        var name = request.Name is null ? before.Name : RequireName(request.Name, "Payment method name");
        var archived = request.Archived ?? before.Archived;
        EnsureNameFree(connection, transaction, "payment_methods", name, id, "A payment method with that name already exists.");
        if (archived && !before.Archived)
        {
            var active = Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM payment_methods WHERE archived = 0;"), CultureInfo.InvariantCulture);
            if (active <= 1) throw RequestException.Invalid("Keep at least one active payment method.");
        }
        var after = before with { Name = name, Archived = archived };
        if (after == before) return before;
        Execute(connection, transaction, "UPDATE payment_methods SET name = $name, archived = $archived WHERE id = $id;",
            ("$name", name), ("$archived", archived ? 1 : 0), ("$id", id));
        RecordHistory(connection, transaction, "Edited", "PaymentMethod", id, before, after);
        transaction.Commit();
        return after;
    }

    public void DeletePaymentMethod(long id)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadPaymentMethods(connection, transaction).SingleOrDefault(m => m.Id == id) ?? throw RequestException.NotFound("Payment method not found.");
        var uses = Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM transactions WHERE payment_method_id = $id;", ("$id", id)), CultureInfo.InvariantCulture);
        if (uses > 0) throw RequestException.Invalid($"{before.Name} is used by {uses} transaction{(uses == 1 ? "" : "s")}. Archive it instead to hide it from new entries.");
        var remaining = Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM payment_methods WHERE archived = 0 AND id <> $id;", ("$id", id)), CultureInfo.InvariantCulture);
        if (remaining == 0) throw RequestException.Invalid("Keep at least one active payment method.");
        Execute(connection, transaction, "DELETE FROM payment_methods WHERE id = $id;", ("$id", id));
        RecordHistory(connection, transaction, "Deleted", "PaymentMethod", id, before, null);
        transaction.Commit();
    }

    public Person CreatePerson(NameRequest request)
    {
        var name = RequireName(request.Name, "Name");
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        EnsureNameFree(connection, transaction, "people", name, null, "A person with that name already exists.");
        var id = Convert.ToInt64(Scalar(connection, transaction,
            "INSERT INTO people (name, created_at) VALUES ($name, $now); SELECT last_insert_rowid();",
            ("$name", name), ("$now", Now())), CultureInfo.InvariantCulture);
        var created = ReadPeople(connection, transaction).Single(p => p.Id == id);
        RecordHistory(connection, transaction, "Created", "Person", id, null, created);
        transaction.Commit();
        return created;
    }

    public Person UpdatePerson(long id, UpdateNameRequest request)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadPeople(connection, transaction).SingleOrDefault(p => p.Id == id) ?? throw RequestException.NotFound("Person not found.");
        var name = request.Name is null ? before.Name : RequireName(request.Name, "Name");
        var archived = request.Archived ?? before.Archived;
        if (archived && before.IsSelf) throw RequestException.Invalid("You cannot archive yourself.");
        EnsureNameFree(connection, transaction, "people", name, id, "A person with that name already exists.");
        var after = before with { Name = name, Archived = archived };
        if (after == before) return before;
        Execute(connection, transaction, "UPDATE people SET name = $name, archived = $archived WHERE id = $id;",
            ("$name", name), ("$archived", archived ? 1 : 0), ("$id", id));
        RecordHistory(connection, transaction, "Edited", "Person", id, before, after);
        transaction.Commit();
        return after;
    }

    public void DeletePerson(long id)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadPeople(connection, transaction).SingleOrDefault(p => p.Id == id) ?? throw RequestException.NotFound("Person not found.");
        if (before.IsSelf) throw RequestException.Invalid("You cannot delete yourself.");
        var uses = Convert.ToInt64(Scalar(connection, transaction, """
            SELECT COUNT(*) FROM transactions t
            WHERE t.person_id = $id OR EXISTS (SELECT 1 FROM transaction_shares s WHERE s.transaction_id = t.id AND s.person_id = $id);
            """, ("$id", id)), CultureInfo.InvariantCulture);
        if (uses > 0) throw RequestException.Invalid($"{before.Name} is on {uses} transaction{(uses == 1 ? "" : "s")}. Archive them instead to hide them from new entries.");
        Execute(connection, transaction, "DELETE FROM people WHERE id = $id;", ("$id", id));
        RecordHistory(connection, transaction, "Deleted", "Person", id, before, null);
        transaction.Commit();
    }

    public Tag CreateTag(NameRequest request)
    {
        var name = RequireName(request.Name, "Tag name");
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        EnsureNameFree(connection, transaction, "tags", name, null, "A tag with that name already exists.");
        var id = Convert.ToInt64(Scalar(connection, transaction,
            "INSERT INTO tags (name, created_at) VALUES ($name, $now); SELECT last_insert_rowid();",
            ("$name", name), ("$now", Now())), CultureInfo.InvariantCulture);
        var created = ReadTags(connection, transaction).Single(t => t.Id == id);
        RecordHistory(connection, transaction, "Created", "Tag", id, null, created);
        transaction.Commit();
        return created;
    }

    public Tag UpdateTag(long id, UpdateNameRequest request)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadTags(connection, transaction).SingleOrDefault(t => t.Id == id) ?? throw RequestException.NotFound("Tag not found.");
        var name = request.Name is null ? before.Name : RequireName(request.Name, "Tag name");
        var archived = request.Archived ?? before.Archived;
        EnsureNameFree(connection, transaction, "tags", name, id, "A tag with that name already exists.");
        var after = before with { Name = name, Archived = archived };
        if (after == before) return before;
        Execute(connection, transaction, "UPDATE tags SET name = $name, archived = $archived WHERE id = $id;",
            ("$name", name), ("$archived", archived ? 1 : 0), ("$id", id));
        RecordHistory(connection, transaction, "Edited", "Tag", id, before, after);
        transaction.Commit();
        return after;
    }

    /// <summary>Deleting a tag removes it from every transaction; the history entry records how many were affected.</summary>
    public void DeleteTag(long id)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadTags(connection, transaction).SingleOrDefault(t => t.Id == id) ?? throw RequestException.NotFound("Tag not found.");
        var uses = Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM transaction_tags WHERE tag_id = $id;", ("$id", id)), CultureInfo.InvariantCulture);
        Execute(connection, transaction, "DELETE FROM tags WHERE id = $id;", ("$id", id));
        RecordHistory(connection, transaction, "Deleted", "Tag", id, new { before.Id, before.Name, before.Archived, before.CreatedAt, RemovedFromTransactions = uses }, null);
        transaction.Commit();
    }

    // ---------------------------------------------------------------- events

    public SpendEvent SaveEvent(long? id, EventRequest request)
    {
        var name = RequireName(request.Name, "Event name");
        var start = RequireDate(request.StartDate, "Start date");
        var end = RequireDate(request.EndDate, "End date");
        if (string.CompareOrdinal(end, start) < 0) throw RequestException.Invalid("End date cannot be before the start date.");
        var note = OptionalText(request.Note, MaxNoteLength, "Note");

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var now = Now();
        SpendEvent? before = null;
        if (id is not null)
            before = ReadEvents(connection, transaction).SingleOrDefault(e => e.Id == id) ?? throw RequestException.NotFound("Event not found.");

        long savedId;
        if (before is null)
        {
            savedId = Convert.ToInt64(Scalar(connection, transaction, """
                INSERT INTO events (name, start_date, end_date, note, created_at) VALUES ($name, $start, $end, $note, $now);
                SELECT last_insert_rowid();
                """, ("$name", name), ("$start", start), ("$end", end), ("$note", note), ("$now", now)), CultureInfo.InvariantCulture);
        }
        else
        {
            savedId = before.Id;
            if (before.Name == name && before.StartDate == start && before.EndDate == end && before.Note == note) return before;
            Execute(connection, transaction,
                "UPDATE events SET name = $name, start_date = $start, end_date = $end, note = $note, updated_at = $now WHERE id = $id;",
                ("$name", name), ("$start", start), ("$end", end), ("$note", note), ("$now", now), ("$id", savedId));
        }
        var after = ReadEvents(connection, transaction).Single(e => e.Id == savedId);
        RecordHistory(connection, transaction, before is null ? "Created" : "Edited", "Event", savedId, before, after);
        transaction.Commit();
        return after;
    }

    public void DeleteEvent(long id)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadEvents(connection, transaction).SingleOrDefault(e => e.Id == id) ?? throw RequestException.NotFound("Event not found.");
        Execute(connection, transaction, "DELETE FROM events WHERE id = $id;", ("$id", id));
        RecordHistory(connection, transaction, "Deleted", "Event", id, before, null);
        transaction.Commit();
    }

    // ---------------------------------------------------------------- backup and restore

    /// <summary>Writes a consistent online copy of the database, safe to take while SpendTracker is in use.</summary>
    public void CopyTo(string destinationPath)
    {
        using var source = Open();
        using var destination = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = destinationPath, Pooling = false }.ToString());
        destination.Open();
        source.BackupDatabase(destination);
        Execute(destination, null, "PRAGMA journal_mode=DELETE;"); // One self-contained file with no -wal sidecar.
    }

    public static Dictionary<string, long> CountRows(SqliteConnection connection) =>
        Tables.ToDictionary(table => table, table => Convert.ToInt64(Scalar(connection, null, $"SELECT COUNT(*) FROM {table};"), CultureInfo.InvariantCulture));

    /// <summary>Column definitions of a table, used to require that a backup has exactly the live layout.</summary>
    public static List<string> TableLayout(SqliteConnection connection, string table)
    {
        var columns = new List<string>();
        using var command = Sql(connection, null, $"PRAGMA table_info({table});");
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var values = Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? "NULL" : Convert.ToString(reader.GetValue(i), CultureInfo.InvariantCulture));
            columns.Add(string.Join('|', values));
        }
        return columns;
    }

    /// <summary>
    /// Replaces all data with the rows of an already verified backup database. Rows keep their IDs so links survive.
    /// Everything runs in one transaction and is checked before commit, so a backup that breaks any rule leaves the
    /// current data untouched. Only rows are copied; the backup's own schema, triggers, and views are never used.
    /// </summary>
    public void ReplaceAllData(string importedPath, object restoreDetails)
    {
        using var imported = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = importedPath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        imported.Open();
        Execute(imported, null, "PRAGMA trusted_schema=OFF;");

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        Execute(connection, transaction, "PRAGMA defer_foreign_keys = ON;");
        foreach (var table in Tables.Reverse())
            Execute(connection, transaction, $"DELETE FROM {table};");

        try
        {
            foreach (var table in Tables)
                CopyRows(imported, connection, transaction, table);
        }
        catch (SqliteException error) when (error.SqliteErrorCode is 19 or 20) // SQLITE_CONSTRAINT or SQLITE_MISMATCH
        {
            throw RequestException.Invalid($"The backup contains invalid or duplicate rows: {error.Message}");
        }

        ValidateRestoredRows(connection, transaction);
        CheckIntegrity(connection, transaction);
        RecordHistory(connection, transaction, "Restored", "Backup", null, null, restoreDetails);
        transaction.Commit();
    }

    static void CopyRows(SqliteConnection source, SqliteConnection destination, SqliteTransaction transaction, string table)
    {
        var columns = new List<string>();
        using (var info = Sql(destination, transaction, $"PRAGMA table_info({table});"))
        using (var reader = info.ExecuteReader())
        {
            while (reader.Read()) columns.Add(reader.GetString(1));
        }
        var columnList = string.Join(", ", columns);

        using var insert = Sql(destination, transaction,
            $"INSERT INTO {table} ({columnList}) VALUES ({string.Join(", ", columns.Select((_, i) => $"$p{i}"))});");
        var parameters = columns.Select((_, i) => insert.Parameters.Add(new SqliteParameter { ParameterName = $"$p{i}" })).ToArray();
        using var select = Sql(source, null, $"SELECT {columnList} FROM {table};");
        using var rows = select.ExecuteReader();
        while (rows.Read())
        {
            for (var i = 0; i < parameters.Length; i++)
                parameters[i].Value = rows.IsDBNull(i) ? DBNull.Value : rows.GetValue(i);
            insert.ExecuteNonQuery();
        }
    }

    /// <summary>Rules the API enforces on every save that SQLite constraints alone do not, applied to restored rows.</summary>
    static void ValidateRestoredRows(SqliteConnection connection, SqliteTransaction transaction)
    {
        foreach (var (table, label) in new[] { ("payment_methods", "payment method"), ("people", "person"), ("tags", "tag"), ("events", "event") })
        {
            var bad = Scalar(connection, transaction,
                $"SELECT id FROM {table} WHERE typeof(name) <> 'text' OR length(trim(name)) = 0 OR length(name) > {MaxNameLength} OR name <> trim(name) LIMIT 1;");
            if (bad is not null) throw RequestException.Invalid($"The backup has an invalid {label} name (#{bad}).");
        }

        var badTransaction = Scalar(connection, transaction, $"""
            SELECT id FROM transactions
            WHERE typeof(amount_cents) <> 'integer' OR amount_cents > {MaxAmountCents}
               OR typeof(payment_method_id) <> 'integer'
               OR typeof(person_id) NOT IN ('integer', 'null') OR typeof(linked_id) NOT IN ('integer', 'null')
               OR typeof(merchant) <> 'text' OR typeof(description) <> 'text' OR typeof(note) <> 'text'
               OR length(merchant) > {MaxMerchantLength} OR length(description) > {MaxDescriptionLength} OR length(note) > {MaxNoteLength}
               OR (trim(merchant) = '' AND trim(description) = '')
            LIMIT 1;
            """);
        if (badTransaction is not null) throw RequestException.Invalid($"Transaction #{badTransaction} in the backup has an invalid value.");

        var badShare = Scalar(connection, transaction,
            "SELECT transaction_id FROM transaction_shares WHERE typeof(person_id) <> 'integer' OR typeof(amount_cents) <> 'integer' LIMIT 1;");
        if (badShare is not null) throw RequestException.Invalid($"Transaction #{badShare} in the backup has an invalid share.");

        var taggedNonPurchase = Scalar(connection, transaction,
            "SELECT t.transaction_id FROM transaction_tags t JOIN transactions x ON x.id = t.transaction_id WHERE x.kind <> 'Purchase' LIMIT 1;");
        if (taggedNonPurchase is not null) throw RequestException.Invalid($"Transaction #{taggedNonPurchase} in the backup has tags, but only purchases can.");

        if (Scalar(connection, transaction, $"SELECT id FROM events WHERE typeof(note) <> 'text' OR length(note) > {MaxNoteLength} LIMIT 1;") is { } badEvent)
            throw RequestException.Invalid($"Event #{badEvent} in the backup has an invalid note.");

        var badHistory = Scalar(connection, transaction, """
            SELECT id FROM history
            WHERE typeof(entity_id) NOT IN ('integer', 'null')
               OR (before_json IS NOT NULL AND NOT json_valid(before_json))
               OR (after_json IS NOT NULL AND NOT json_valid(after_json))
            LIMIT 1;
            """);
        if (badHistory is not null) throw RequestException.Invalid($"History entry #{badHistory} in the backup is damaged.");

        if (Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM people WHERE is_self = 1;"), CultureInfo.InvariantCulture) != 1)
            throw RequestException.Invalid("The backup must contain exactly one self person.");
        if (Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM payment_methods WHERE archived = 0;"), CultureInfo.InvariantCulture) == 0)
            throw RequestException.Invalid("The backup must contain at least one active payment method.");

        // The schema only checks the YYYY-MM-DD shape; this rejects dates that do not exist, like 2026-02-30.
        using var dates = Sql(connection, transaction, "SELECT date FROM transactions UNION SELECT start_date FROM events UNION SELECT end_date FROM events;");
        using var reader = dates.ExecuteReader();
        while (reader.Read())
            RequireDate(reader.GetString(0), "Every date in the backup");
    }

    /// <summary>Checks relationships that SQLite constraints cannot express. Throws instead of letting inconsistent data commit.</summary>
    static void CheckIntegrity(SqliteConnection connection, SqliteTransaction transaction)
    {
        using (var foreignKeys = Sql(connection, transaction, "PRAGMA foreign_key_check;"))
        using (var reader = foreignKeys.ExecuteReader())
        {
            if (reader.Read()) throw RequestException.Invalid($"The backup references a missing row in {reader.GetString(2)}.");
        }

        string[] checks =
        [
            // Refunds and paybacks may only point at purchases.
            """
            SELECT x.id FROM transactions x JOIN transactions p ON p.id = x.linked_id
            WHERE p.kind <> 'Purchase' LIMIT 1;
            """,
            // A purchase's shares add up exactly to its amount; only purchases have shares.
            """
            SELECT t.id FROM transactions t
            LEFT JOIN (SELECT transaction_id, SUM(amount_cents) AS total FROM transaction_shares GROUP BY transaction_id) s ON s.transaction_id = t.id
            WHERE t.kind = 'Purchase' AND (s.total IS NULL OR s.total <> t.amount_cents) LIMIT 1;
            """,
            """
            SELECT s.transaction_id FROM transaction_shares s JOIN transactions t ON t.id = s.transaction_id
            WHERE t.kind <> 'Purchase' LIMIT 1;
            """,
            // Linked refunds and paybacks are for someone who had a share of that purchase.
            """
            SELECT x.id FROM transactions x
            WHERE x.linked_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM transaction_shares s WHERE s.transaction_id = x.linked_id AND s.person_id = x.person_id)
            LIMIT 1;
            """,
            // Paybacks never come from yourself.
            """
            SELECT x.id FROM transactions x JOIN people me ON me.id = x.person_id
            WHERE x.kind = 'Payback' AND me.is_self = 1 LIMIT 1;
            """,
            // Nothing is returned or repaid before it was bought, and never more than a person's share.
            """
            SELECT x.id FROM transactions x JOIN transactions p ON p.id = x.linked_id
            WHERE x.date < p.date LIMIT 1;
            """,
            """
            SELECT x.linked_id FROM transactions x
            JOIN transaction_shares s ON s.transaction_id = x.linked_id AND s.person_id = x.person_id
            GROUP BY x.linked_id, x.person_id, s.amount_cents HAVING SUM(x.amount_cents) > s.amount_cents LIMIT 1;
            """
        ];
        foreach (var check in checks)
        {
            var bad = Scalar(connection, transaction, check);
            if (bad is not null) throw RequestException.Invalid($"Transaction #{bad} in the backup has an invalid refund/payback link.");
        }
    }

    // ---------------------------------------------------------------- helpers

    static void RecordHistory(SqliteConnection connection, SqliteTransaction transaction, string action, string entity, long? entityId, object? before, object? after)
    {
        Execute(connection, transaction, """
            INSERT INTO history (at, action, entity, entity_id, before_json, after_json)
            VALUES ($at, $action, $entity, $entityId, $before, $after);
            """,
            ("$at", Now()), ("$action", action), ("$entity", entity), ("$entityId", entityId),
            ("$before", before is null ? null : JsonSerializer.Serialize(before, HistoryJson)),
            ("$after", after is null ? null : JsonSerializer.Serialize(after, HistoryJson)));
    }

    static void EnsureNameFree(SqliteConnection connection, SqliteTransaction transaction, string table, string name, long? excludingId, string message)
    {
        var taken = Scalar(connection, transaction, $"SELECT 1 FROM {table} WHERE name = $name COLLATE NOCASE AND ($id IS NULL OR id <> $id);",
            ("$name", name), ("$id", excludingId));
        if (taken is not null) throw RequestException.Invalid(message);
    }

    static string RequireName(string? value, string label)
    {
        var name = value?.Trim() ?? "";
        if (name.Length == 0) throw RequestException.Invalid($"{label} is required.");
        if (name.Length > MaxNameLength) throw RequestException.Invalid($"{label} must be {MaxNameLength} characters or fewer.");
        return name;
    }

    static string OptionalText(string? value, int maxLength, string label)
    {
        var text = value?.Trim() ?? "";
        if (text.Length > maxLength) throw RequestException.Invalid($"{label} must be {maxLength} characters or fewer.");
        return text;
    }

    static string RequireDate(string? value, string label)
    {
        if (!DateOnly.TryParseExact(value?.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
            throw RequestException.Invalid($"{label} must be a real date (YYYY-MM-DD).");
        return date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }

    static string FormatCents(long cents) => (cents / 100m).ToString("C2", CultureInfo.GetCultureInfo("en-US"));

    static string Now() => DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);

    static string? NullableString(SqliteDataReader reader, int index) => reader.IsDBNull(index) ? null : reader.GetString(index);

    SqliteConnection Open()
    {
        var connection = new SqliteConnection(connectionString);
        connection.Open();
        Execute(connection, null, "PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
        return connection;
    }

    static SqliteCommand Sql(SqliteConnection connection, SqliteTransaction? transaction, string text, params (string Name, object? Value)[] parameters)
    {
        var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = text;
        foreach (var (name, value) in parameters)
            command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return command;
    }

    static object? Scalar(SqliteConnection connection, SqliteTransaction? transaction, string text, params (string Name, object? Value)[] parameters)
    {
        using var command = Sql(connection, transaction, text, parameters);
        var value = command.ExecuteScalar();
        return value is DBNull ? null : value;
    }

    static void Execute(SqliteConnection connection, SqliteTransaction? transaction, string text, params (string Name, object? Value)[] parameters)
    {
        using var command = Sql(connection, transaction, text, parameters);
        command.ExecuteNonQuery();
    }
}

record PaymentMethod(long Id, string Name, bool Archived, string CreatedAt);
record Person(long Id, string Name, bool IsSelf, bool Archived, string CreatedAt);
record Tag(long Id, string Name, bool Archived, string CreatedAt);
record Share(long PersonId, long AmountCents);
record SpendEvent(long Id, string Name, string StartDate, string EndDate, string Note, string CreatedAt, string? UpdatedAt);
record SpendTransaction(long Id, string Kind, string Date, long AmountCents, long PaymentMethodId, long? PersonId, long? LinkedId,
    string Merchant, string Description, string Note, List<long> TagIds, List<Share> Shares, string CreatedAt, string? UpdatedAt);
record HistoryEntry(long Id, string At, string Action, string Entity, long? EntityId, JsonElement? Before, JsonElement? After);
record HistoryPage(List<HistoryEntry> Entries, bool HasMore);
record Snapshot(string Version, List<PaymentMethod> PaymentMethods, List<Person> People, List<Tag> Tags, List<SpendEvent> Events, List<SpendTransaction> Transactions);

record TransactionRequest(string? Kind, string? Date, long? AmountCents, long? PaymentMethodId, long? PersonId, long? LinkedId,
    string? Merchant, string? Description, string? Note, List<long>? TagIds, List<ShareRequest>? Shares);
record ShareRequest(long? PersonId, long? AmountCents);
record TransactionValues(string Kind, string Date, long AmountCents, long PaymentMethodId, long? PersonId, long? LinkedId,
    string Merchant, string Description, string Note, List<long> TagIds, List<Share> Shares);
record NameRequest(string? Name);
record UpdateNameRequest(string? Name, bool? Archived);
record EventRequest(string? Name, string? StartDate, string? EndDate, string? Note);
