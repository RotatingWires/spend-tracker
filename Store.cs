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
    public const string BackupFormat = "spendtracker-backup";
    public const int BackupFormatVersion = 1;
    const int SchemaVersion = 1;
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
                created_at TEXT NOT NULL
            );
            CREATE TABLE transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('Purchase', 'Refund', 'Payback')),
                date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
                amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
                person_id INTEGER NULL REFERENCES people(id),
                linked_id INTEGER NULL REFERENCES transactions(id),
                merchant TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NULL,
                -- A refund belongs to whoever the original purchase was for, so it never stores its own person.
                CHECK((kind = 'Refund') = (person_id IS NULL)),
                CHECK(kind <> 'Refund' OR linked_id IS NOT NULL),
                CHECK(kind <> 'Purchase' OR linked_id IS NULL)
            );
            CREATE INDEX idx_transactions_date ON transactions(date, id);
            CREATE INDEX idx_transactions_linked ON transactions(linked_id);
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

    public Backup ReadBackup(string version)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred: true);
        var snapshot = ReadSnapshot(connection, transaction, version);
        var history = ReadHistoryEntries(connection, transaction, null, null);
        history.Reverse();
        return new Backup(BackupFormat, BackupFormatVersion, version, Now(),
            snapshot.PaymentMethods, snapshot.People, snapshot.Tags, snapshot.Events, snapshot.Transactions, history);
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
        using var command = Sql(connection, transaction, "SELECT id, name, created_at FROM tags ORDER BY name COLLATE NOCASE, id;");
        using var reader = command.ExecuteReader();
        while (reader.Read())
            tags.Add(new Tag(reader.GetInt64(0), reader.GetString(1), reader.GetString(2)));
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
            Execute(connection, transaction, "DELETE FROM transaction_tags WHERE transaction_id = $id;", ("$id", savedId));
        }
        foreach (var tagId in values.TagIds)
            Execute(connection, transaction, "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($id, $tag);", ("$id", savedId), ("$tag", tagId));

        var after = ReadTransactions(connection, transaction, savedId).Single();
        RecordHistory(connection, transaction, before is null ? "Created" : "Edited", "Transaction", savedId, before, after);
        transaction.Commit();
        return after;
    }

    static bool Unchanged(SpendTransaction before, TransactionValues values) =>
        before.Kind == values.Kind && before.Date == values.Date && before.AmountCents == values.AmountCents &&
        before.PaymentMethodId == values.PaymentMethodId && before.PersonId == values.PersonId && before.LinkedId == values.LinkedId &&
        before.Merchant == values.Merchant && before.Description == values.Description && before.Note == values.Note &&
        before.TagIds.SequenceEqual(values.TagIds);

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
            if (Scalar(connection, transaction, "SELECT 1 FROM tags WHERE id = $id;", ("$id", tagId)) is null)
                throw RequestException.Invalid("One of the selected tags no longer exists. Refresh and try again.");
        }

        long? personId = request.PersonId;
        long? linkedId = request.LinkedId;
        switch (kind)
        {
            case "Purchase":
                if (linkedId is not null) throw RequestException.Invalid("A purchase cannot be linked to another transaction.");
                RequireUsablePerson(connection, transaction, personId, before?.PersonId, "Choose who this purchase was for.");
                break;

            case "Refund":
                if (personId is not null) throw RequestException.Invalid("A refund belongs to the person on its original purchase; do not set For Who.");
                var refunded = RequireLinkedPurchase(connection, transaction, id, linkedId, "Choose the purchase this refund is for.");
                if (string.CompareOrdinal(date, refunded.Date) < 0)
                    throw RequestException.Invalid("A refund cannot be dated before its purchase.");
                var otherRefunds = LinkedTotal(connection, transaction, refunded.Id, "Refund", id);
                var refundPaybacks = LinkedTotal(connection, transaction, refunded.Id, "Payback", id);
                if (otherRefunds + refundPaybacks + amount > refunded.AmountCents)
                    throw RequestException.Invalid($"Refunds and paybacks for that purchase would total more than its {FormatCents(refunded.AmountCents)}.");
                break;

            case "Payback":
                var payer = RequireUsablePerson(connection, transaction, personId, before?.PersonId, "Choose who paid you back.");
                if (payer.IsSelf) throw RequestException.Invalid("A payback must come from someone other than you.");
                if (linkedId is not null)
                {
                    var repaid = RequireLinkedPurchase(connection, transaction, id, linkedId, "Choose the purchase this payback is for.");
                    if (repaid.PersonId != personId)
                        throw RequestException.Invalid("A payback can only be linked to a purchase made for the same person.");
                    if (string.CompareOrdinal(date, repaid.Date) < 0)
                        throw RequestException.Invalid("A payback cannot be dated before its purchase.");
                    var refunds = LinkedTotal(connection, transaction, repaid.Id, "Refund", id);
                    var otherPaybacks = LinkedTotal(connection, transaction, repaid.Id, "Payback", id);
                    if (refunds + otherPaybacks + amount > repaid.AmountCents)
                        throw RequestException.Invalid($"Refunds and paybacks for that purchase would total more than its {FormatCents(repaid.AmountCents)}.");
                }
                break;
        }

        if (before?.Kind == "Purchase" && id is not null)
            ValidatePurchaseDependents(connection, transaction, id.Value, kind, date, amount, personId);

        return new TransactionValues(kind, date, amount, methodId, personId, linkedId, merchant, description, note, tagIds);
    }

    /// <summary>Editing a purchase must keep every refund and payback that points at it valid.</summary>
    static void ValidatePurchaseDependents(SqliteConnection connection, SqliteTransaction transaction, long id, string kind, string date, long amount, long? personId)
    {
        var dependents = ReadDependents(connection, transaction, id);
        if (dependents.Count == 0) return;
        if (kind != "Purchase")
            throw RequestException.Invalid("This purchase has linked refunds or paybacks, so it must stay a purchase.");
        if (dependents.Sum(d => d.AmountCents) > amount)
            throw RequestException.Invalid($"Linked refunds and paybacks already total {FormatCents(dependents.Sum(d => d.AmountCents))}; the purchase cannot be less than that.");
        if (dependents.Any(d => string.CompareOrdinal(d.Date, date) < 0))
            throw RequestException.Invalid("A linked refund or payback is dated before that date.");
        if (dependents.Any(d => d.Kind == "Payback" && d.PersonId != personId))
            throw RequestException.Invalid("This purchase has paybacks from its current person, so For Who cannot change.");
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

    static (long Id, string Date, long AmountCents, long? PersonId) RequireLinkedPurchase(SqliteConnection connection, SqliteTransaction transaction, long? selfId, long? linkedId, string missingMessage)
    {
        if (linkedId is null) throw RequestException.Invalid(missingMessage);
        if (linkedId == selfId) throw RequestException.Invalid("A transaction cannot be linked to itself.");
        using var command = Sql(connection, transaction, "SELECT id, kind, date, amount_cents, person_id FROM transactions WHERE id = $id;", ("$id", linkedId));
        using var reader = command.ExecuteReader();
        if (!reader.Read()) throw RequestException.Invalid("The linked purchase no longer exists.");
        if (reader.GetString(1) != "Purchase") throw RequestException.Invalid("Refunds and paybacks can only be linked to a purchase.");
        return (reader.GetInt64(0), reader.GetString(2), reader.GetInt64(3), reader.IsDBNull(4) ? null : reader.GetInt64(4));
    }

    static long LinkedTotal(SqliteConnection connection, SqliteTransaction transaction, long purchaseId, string kind, long? excludingId) =>
        Convert.ToInt64(Scalar(connection, transaction,
            "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE linked_id = $purchase AND kind = $kind AND ($exclude IS NULL OR id <> $exclude);",
            ("$purchase", purchaseId), ("$kind", kind), ("$exclude", excludingId)), CultureInfo.InvariantCulture);

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
        var uses = Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM transactions WHERE person_id = $id;", ("$id", id)), CultureInfo.InvariantCulture);
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

    public Tag UpdateTag(long id, TagUpdateRequest request)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadTags(connection, transaction).SingleOrDefault(t => t.Id == id) ?? throw RequestException.NotFound("Tag not found.");
        var name = RequireName(request.Name, "Tag name");
        EnsureNameFree(connection, transaction, "tags", name, id, "A tag with that name already exists.");
        var after = before with { Name = name };
        if (after == before) return before;
        Execute(connection, transaction, "UPDATE tags SET name = $name WHERE id = $id;", ("$name", name), ("$id", id));
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
        RecordHistory(connection, transaction, "Deleted", "Tag", id, new { before.Id, before.Name, before.CreatedAt, RemovedFromTransactions = uses }, null);
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

    // ---------------------------------------------------------------- backup restore

    /// <summary>
    /// Replaces all data with a backup. Rows keep their original IDs so links survive. Everything happens in one
    /// transaction and is checked before commit, so an invalid backup leaves the current data untouched.
    /// </summary>
    public RestoreResult Restore(Backup backup, string recoveryPath, string version)
    {
        if (backup.Format != BackupFormat || backup.FormatVersion != BackupFormatVersion)
            throw RequestException.Invalid("This is not a SpendTracker backup file.");
        if (!System.Version.TryParse(backup.AppVersion, out var backupVersion) || backupVersion > System.Version.Parse(version))
            throw RequestException.Invalid("This backup was made by a newer SpendTracker version. Update SpendTracker first.");
        if (backup.PaymentMethods is null || backup.People is null || backup.Tags is null || backup.Events is null || backup.Transactions is null || backup.History is null)
            throw RequestException.Invalid("The backup is missing one or more data sections.");
        ValidateBackupRows(backup);

        // Keep a recovery copy before changing any live rows. It is private server data.
        Directory.CreateDirectory(Path.GetDirectoryName(recoveryPath)!);
        File.WriteAllText(recoveryPath, JsonSerializer.Serialize(ReadBackup(version), HistoryJson));

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        Execute(connection, transaction, "PRAGMA defer_foreign_keys = ON;");
        Execute(connection, transaction, """
            DELETE FROM transaction_tags;
            DELETE FROM transactions;
            DELETE FROM events;
            DELETE FROM tags;
            DELETE FROM people;
            DELETE FROM payment_methods;
            DELETE FROM history;
            DELETE FROM sqlite_sequence;
            """);

        try
        {
            foreach (var m in backup.PaymentMethods)
                Execute(connection, transaction, "INSERT INTO payment_methods (id, name, archived, created_at) VALUES ($id, $name, $archived, $created);",
                    ("$id", m.Id), ("$name", m.Name.Trim()), ("$archived", m.Archived ? 1 : 0), ("$created", m.CreatedAt));
            foreach (var p in backup.People)
                Execute(connection, transaction, "INSERT INTO people (id, name, is_self, archived, created_at) VALUES ($id, $name, $self, $archived, $created);",
                    ("$id", p.Id), ("$name", p.Name.Trim()), ("$self", p.IsSelf ? 1 : 0), ("$archived", p.Archived ? 1 : 0), ("$created", p.CreatedAt));
            foreach (var t in backup.Tags)
                Execute(connection, transaction, "INSERT INTO tags (id, name, created_at) VALUES ($id, $name, $created);",
                    ("$id", t.Id), ("$name", t.Name.Trim()), ("$created", t.CreatedAt));
            foreach (var e in backup.Events)
                Execute(connection, transaction, """
                    INSERT INTO events (id, name, start_date, end_date, note, created_at, updated_at)
                    VALUES ($id, $name, $start, $end, $note, $created, $updated);
                    """, ("$id", e.Id), ("$name", e.Name.Trim()), ("$start", e.StartDate), ("$end", e.EndDate), ("$note", e.Note ?? ""), ("$created", e.CreatedAt), ("$updated", e.UpdatedAt));
            foreach (var x in backup.Transactions)
            {
                Execute(connection, transaction, """
                    INSERT INTO transactions
                        (id, kind, date, amount_cents, payment_method_id, person_id, linked_id, merchant, description, note, created_at, updated_at)
                    VALUES ($id, $kind, $date, $amount, $method, $person, $linked, $merchant, $description, $note, $created, $updated);
                    """, ("$id", x.Id), ("$kind", x.Kind), ("$date", x.Date), ("$amount", x.AmountCents), ("$method", x.PaymentMethodId),
                    ("$person", x.PersonId), ("$linked", x.LinkedId), ("$merchant", x.Merchant ?? ""), ("$description", x.Description ?? ""),
                    ("$note", x.Note ?? ""), ("$created", x.CreatedAt), ("$updated", x.UpdatedAt));
                foreach (var tagId in (x.TagIds ?? []).Distinct())
                    Execute(connection, transaction, "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($id, $tag);", ("$id", x.Id), ("$tag", tagId));
            }
            foreach (var h in backup.History)
                Execute(connection, transaction, """
                    INSERT INTO history (id, at, action, entity, entity_id, before_json, after_json)
                    VALUES ($id, $at, $action, $entity, $entityId, $before, $after);
                    """, ("$id", h.Id), ("$at", h.At), ("$action", h.Action), ("$entity", h.Entity), ("$entityId", h.EntityId),
                    ("$before", h.Before?.GetRawText()), ("$after", h.After?.GetRawText()));
        }
        catch (SqliteException error) when (error.SqliteErrorCode is 19) // SQLITE_CONSTRAINT: duplicate IDs/names or a failed CHECK.
        {
            throw RequestException.Invalid($"The backup contains invalid or duplicate rows: {error.Message}");
        }

        CheckIntegrity(connection, transaction);
        RecordHistory(connection, transaction, "Restored", "Backup", null, null, new
        {
            backup.AppVersion,
            backup.ExportedAt,
            Transactions = backup.Transactions.Count,
            RecoveryFile = Path.GetFileName(recoveryPath)
        });
        transaction.Commit();
        return new RestoreResult(backup.Transactions.Count, Path.GetFileName(recoveryPath));
    }

    static void ValidateBackupRows(Backup backup)
    {
        foreach (var m in backup.PaymentMethods) RequireName(m.Name, $"Payment method #{m.Id} name");
        foreach (var p in backup.People) RequireName(p.Name, $"Person #{p.Id} name");
        foreach (var t in backup.Tags) RequireName(t.Name, $"Tag #{t.Id} name");
        foreach (var e in backup.Events) RequireName(e.Name, $"Event #{e.Id} name");
        foreach (var x in backup.Transactions)
        {
            if (!Kinds.Contains(x.Kind)) throw RequestException.Invalid($"Transaction #{x.Id} has an unknown type.");
            RequireDate(x.Date, $"Transaction #{x.Id} date");
            if (x.AmountCents < 1 || x.AmountCents > MaxAmountCents) throw RequestException.Invalid($"Transaction #{x.Id} has an invalid amount.");
        }
        foreach (var e in backup.Events)
        {
            RequireDate(e.StartDate, $"Event #{e.Id} start date");
            RequireDate(e.EndDate, $"Event #{e.Id} end date");
        }
        if (backup.People.Count(p => p.IsSelf) != 1) throw RequestException.Invalid("The backup must contain exactly one self person.");
        if (!backup.PaymentMethods.Any(m => !m.Archived)) throw RequestException.Invalid("The backup must contain at least one active payment method.");
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
            // A linked payback comes from the person the purchase was for.
            """
            SELECT x.id FROM transactions x JOIN transactions p ON p.id = x.linked_id
            WHERE x.kind = 'Payback' AND x.person_id IS NOT p.person_id LIMIT 1;
            """,
            // Paybacks never come from yourself.
            """
            SELECT x.id FROM transactions x JOIN people me ON me.id = x.person_id
            WHERE x.kind = 'Payback' AND me.is_self = 1 LIMIT 1;
            """,
            // Nothing is returned or repaid before it was bought, and never more than it cost.
            """
            SELECT x.id FROM transactions x JOIN transactions p ON p.id = x.linked_id
            WHERE x.date < p.date LIMIT 1;
            """,
            """
            SELECT p.id FROM transactions p JOIN transactions x ON x.linked_id = p.id
            GROUP BY p.id HAVING SUM(x.amount_cents) > p.amount_cents LIMIT 1;
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
record Tag(long Id, string Name, string CreatedAt);
record SpendEvent(long Id, string Name, string StartDate, string EndDate, string Note, string CreatedAt, string? UpdatedAt);
record SpendTransaction(long Id, string Kind, string Date, long AmountCents, long PaymentMethodId, long? PersonId, long? LinkedId,
    string Merchant, string Description, string Note, List<long> TagIds, string CreatedAt, string? UpdatedAt);
record HistoryEntry(long Id, string At, string Action, string Entity, long? EntityId, JsonElement? Before, JsonElement? After);
record HistoryPage(List<HistoryEntry> Entries, bool HasMore);
record Snapshot(string Version, List<PaymentMethod> PaymentMethods, List<Person> People, List<Tag> Tags, List<SpendEvent> Events, List<SpendTransaction> Transactions);
record Backup(string Format, int FormatVersion, string AppVersion, string ExportedAt, List<PaymentMethod> PaymentMethods, List<Person> People,
    List<Tag> Tags, List<SpendEvent> Events, List<SpendTransaction> Transactions, List<HistoryEntry> History);
record RestoreResult(int Transactions, string RecoveryFile);

record TransactionRequest(string? Kind, string? Date, long? AmountCents, long? PaymentMethodId, long? PersonId, long? LinkedId,
    string? Merchant, string? Description, string? Note, List<long>? TagIds);
record TransactionValues(string Kind, string Date, long AmountCents, long PaymentMethodId, long? PersonId, long? LinkedId,
    string Merchant, string Description, string Note, List<long> TagIds);
record NameRequest(string? Name);
record UpdateNameRequest(string? Name, bool? Archived);
record TagUpdateRequest(string? Name);
record EventRequest(string? Name, string? StartDate, string? EndDate, string? Note);
