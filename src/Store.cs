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
    public const int SchemaVersion = 6;

    /// <summary>Every data table, in an order where referenced rows are inserted before the rows that point at them.</summary>
    public static readonly string[] Tables = ["payment_methods", "people", "tags", "merchants", "collections", "transactions", "transaction_shares", "transaction_tags", "transaction_collections", "scope_counters", "scope_numbers", "history"];

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

    /// <summary>Creates the schema on first run and returns the journal mode in use.</summary>
    public string Initialize()
    {
        using var connection = Open();
        var journalMode = CanUseWal(databasePath)
            ? Convert.ToString(Scalar(connection, null, "PRAGMA journal_mode=WAL;"), CultureInfo.InvariantCulture) ?? "unknown"
            : $"{Scalar(connection, null, "PRAGMA journal_mode;")} (WAL skipped: network/unknown drive)";

        var version = Convert.ToInt32(Scalar(connection, null, "PRAGMA user_version;"), CultureInfo.InvariantCulture);
        if (version > SchemaVersion)
            throw new InvalidOperationException($"spend-tracker.db uses schema version {version}, but this SpendTracker build only understands version {SchemaVersion}. Update SpendTracker before opening this database.");
        if (version == SchemaVersion)
        {
            // Gives existing entries their numbers in any scope added to NumberedScopes since they were saved.
            using var renumber = connection.BeginTransaction();
            Renumber(connection, renumber, null);
            renumber.Commit();
            return journalMode;
        }
        if (version != 0)
            throw new InvalidOperationException($"spend-tracker.db was created by an earlier SpendTracker (schema {version}), which this version cannot upgrade. Stop SpendTracker, move or delete data/spend-tracker.db, and start again to create a new database.");

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
            CREATE TABLE collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
                created_at TEXT NOT NULL
            );
            CREATE TABLE merchants (
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
                merchant_id INTEGER NULL REFERENCES merchants(id),
                description TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                -- Archived entries are hidden from the ledger and calendar but still count everywhere else.
                archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
                created_at TEXT NOT NULL,
                updated_at TEXT NULL,
                CHECK((kind = 'Purchase') = (person_id IS NULL)),
                CHECK(kind <> 'Refund' OR linked_id IS NOT NULL),
                CHECK(kind <> 'Purchase' OR linked_id IS NULL)
            );
            CREATE INDEX idx_transactions_date ON transactions(date, id);
            CREATE INDEX idx_transactions_linked ON transactions(linked_id);
            CREATE INDEX idx_transactions_merchant ON transactions(merchant_id);
            CREATE TABLE transaction_shares (
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                person_id INTEGER NOT NULL REFERENCES people(id),
                amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                -- A gift share is bought for that person but not owed back, so it stays off their balance.
                gift INTEGER NOT NULL DEFAULT 0 CHECK(gift IN (0, 1)),
                PRIMARY KEY (transaction_id, person_id)
            );
            CREATE TABLE transaction_tags (
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (transaction_id, tag_id)
            );
            -- Collections work like tags: named labels on purchases, such as a trip, several per purchase if needed.
            CREATE TABLE transaction_collections (
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                PRIMARY KEY (transaction_id, collection_id)
            );
            -- Per-scope numbers (see NumberedScopes). Counters remember the last number given out so numbers are never reused.
            CREATE TABLE scope_counters (
                scope TEXT NOT NULL,
                scope_id INTEGER NOT NULL,
                last_number INTEGER NOT NULL CHECK(last_number > 0),
                PRIMARY KEY (scope, scope_id)
            );
            CREATE TABLE scope_numbers (
                scope TEXT NOT NULL,
                scope_id INTEGER NOT NULL,
                transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                number INTEGER NOT NULL CHECK(number > 0),
                PRIMARY KEY (scope, scope_id, transaction_id),
                UNIQUE (scope, scope_id, number)
            );
            CREATE INDEX idx_scope_numbers_transaction ON scope_numbers(transaction_id);
            CREATE TABLE history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('Created', 'Edited', 'Deleted', 'Restored')),
                entity TEXT NOT NULL CHECK(entity IN ('Transaction', 'PaymentMethod', 'Person', 'Tag', 'Merchant', 'Collection', 'Backup')),
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

    // ---------------------------------------------------------------- per-scope numbers

    /// <summary>
    /// Besides its permanent global ID, a transaction gets a number inside each scope it belongs to: Alex's 3rd entry,
    /// the 12th "food" purchase, the 5th visit to a merchant, the 40th card payment, the 3rd purchase on a trip. A new kind of scope only needs a row here: its name and a
    /// query listing (scope_id, transaction_id) memberships. Numbers follow the order entries join a scope and are never
    /// reused, so "Alex #3" keeps meaning the same entry even after others are deleted.
    /// </summary>
    static readonly (string Scope, string Members)[] NumberedScopes =
    [
        ("person", """
            SELECT person_id AS scope_id, transaction_id FROM transaction_shares
            UNION SELECT person_id, id FROM transactions WHERE person_id IS NOT NULL
            """),
        ("tag", "SELECT tag_id AS scope_id, transaction_id FROM transaction_tags"),
        ("collection", "SELECT collection_id AS scope_id, transaction_id FROM transaction_collections"),
        ("merchant", "SELECT merchant_id AS scope_id, id AS transaction_id FROM transactions WHERE merchant_id IS NOT NULL"),
        ("method", "SELECT payment_method_id AS scope_id, id AS transaction_id FROM transactions"),
    ];

    /// <summary>Brings the numbers of one transaction (or all, when null) in line with the scopes it now belongs to.</summary>
    static void Renumber(SqliteConnection connection, SqliteTransaction transaction, long? transactionId)
    {
        foreach (var (scope, members) in NumberedScopes)
        {
            var current = $"SELECT scope_id, transaction_id FROM ({members}) WHERE $id IS NULL OR transaction_id = $id";
            Execute(connection, transaction, $"""
                DELETE FROM scope_numbers
                WHERE scope = $scope AND ($id IS NULL OR transaction_id = $id) AND (scope_id, transaction_id) NOT IN ({current});
                """, ("$scope", scope), ("$id", transactionId));

            var joined = new List<(long ScopeId, long TransactionId)>();
            using (var command = Sql(connection, transaction, $"""
                SELECT m.scope_id, m.transaction_id FROM ({current}) m JOIN transactions t ON t.id = m.transaction_id
                WHERE NOT EXISTS (SELECT 1 FROM scope_numbers n WHERE n.scope = $scope AND n.scope_id = m.scope_id AND n.transaction_id = m.transaction_id)
                ORDER BY t.date, t.id, m.scope_id;
                """, ("$scope", scope), ("$id", transactionId)))
            using (var reader = command.ExecuteReader())
            {
                while (reader.Read()) joined.Add((reader.GetInt64(0), reader.GetInt64(1)));
            }

            foreach (var (scopeId, memberId) in joined)
            {
                var number = Scalar(connection, transaction, """
                    INSERT INTO scope_counters (scope, scope_id, last_number) VALUES ($scope, $scopeId, 1)
                    ON CONFLICT (scope, scope_id) DO UPDATE SET last_number = last_number + 1
                    RETURNING last_number;
                    """, ("$scope", scope), ("$scopeId", scopeId));
                Execute(connection, transaction, "INSERT INTO scope_numbers (scope, scope_id, transaction_id, number) VALUES ($scope, $scopeId, $tx, $number);",
                    ("$scope", scope), ("$scopeId", scopeId), ("$tx", memberId), ("$number", number));
            }
        }
    }

    /// <summary>Drops the numbers and counter of a scope whose person, tag, collection, merchant, or payment method was deleted.</summary>
    static void ForgetScope(SqliteConnection connection, SqliteTransaction transaction, string scope, long scopeId) =>
        Execute(connection, transaction, "DELETE FROM scope_numbers WHERE scope = $scope AND scope_id = $id; DELETE FROM scope_counters WHERE scope = $scope AND scope_id = $id;",
            ("$scope", scope), ("$id", scopeId));

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
        ReadLabels(connection, transaction, Tags),
        ReadMerchants(connection, transaction),
        ReadLabels(connection, transaction, Collections),
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

    static List<Label> ReadLabels(SqliteConnection connection, SqliteTransaction? transaction, LabelKind kind)
    {
        var labels = new List<Label>();
        using var command = Sql(connection, transaction, $"SELECT id, name, archived, created_at FROM {kind.Table} ORDER BY name COLLATE NOCASE, id;");
        using var reader = command.ExecuteReader();
        while (reader.Read())
            labels.Add(new Label(reader.GetInt64(0), reader.GetString(1), reader.GetInt64(2) != 0, reader.GetString(3)));
        return labels;
    }

    static List<Merchant> ReadMerchants(SqliteConnection connection, SqliteTransaction? transaction)
    {
        var merchants = new List<Merchant>();
        using var command = Sql(connection, transaction, "SELECT id, name, archived, created_at FROM merchants ORDER BY name COLLATE NOCASE, id;");
        using var reader = command.ExecuteReader();
        while (reader.Read())
            merchants.Add(new Merchant(reader.GetInt64(0), reader.GetString(1), reader.GetInt64(2) != 0, reader.GetString(3)));
        return merchants;
    }

    static List<SpendTransaction> ReadTransactions(SqliteConnection connection, SqliteTransaction? transaction, long? onlyId)
    {
        var tagsByTransaction = ReadLinks(connection, transaction, Tags, onlyId);
        var collectionsByTransaction = ReadLinks(connection, transaction, Collections, onlyId);

        var sharesByTransaction = new Dictionary<long, List<Share>>();
        using (var shareCommand = Sql(connection, transaction,
            "SELECT transaction_id, person_id, amount_cents, gift FROM transaction_shares WHERE $id IS NULL OR transaction_id = $id ORDER BY transaction_id, person_id;",
            ("$id", onlyId)))
        using (var reader = shareCommand.ExecuteReader())
        {
            while (reader.Read())
            {
                var transactionId = reader.GetInt64(0);
                if (!sharesByTransaction.TryGetValue(transactionId, out var shares))
                    sharesByTransaction[transactionId] = shares = [];
                shares.Add(new Share(reader.GetInt64(1), reader.GetInt64(2), reader.GetInt64(3) != 0));
            }
        }

        var numbersByTransaction = new Dictionary<long, List<ScopeNumber>>();
        using (var numberCommand = Sql(connection, transaction,
            "SELECT transaction_id, scope, scope_id, number FROM scope_numbers WHERE $id IS NULL OR transaction_id = $id ORDER BY transaction_id, scope, scope_id;",
            ("$id", onlyId)))
        using (var reader = numberCommand.ExecuteReader())
        {
            while (reader.Read())
            {
                var transactionId = reader.GetInt64(0);
                if (!numbersByTransaction.TryGetValue(transactionId, out var numbers))
                    numbersByTransaction[transactionId] = numbers = [];
                numbers.Add(new ScopeNumber(reader.GetString(1), reader.GetInt64(2), reader.GetInt64(3)));
            }
        }

        var transactions = new List<SpendTransaction>();
        using var command = Sql(connection, transaction, """
            SELECT t.id, t.kind, t.date, t.amount_cents, t.payment_method_id, t.person_id, t.linked_id,
                   t.merchant_id, COALESCE(m.name, ''), t.description, t.note, t.archived, t.created_at, t.updated_at
            FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
            WHERE $id IS NULL OR t.id = $id
            ORDER BY t.date, t.id;
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
                rows.IsDBNull(7) ? null : rows.GetInt64(7),
                rows.GetString(8),
                rows.GetString(9),
                rows.GetString(10),
                rows.GetInt64(11) != 0,
                tagsByTransaction.TryGetValue(id, out var tagIds) ? tagIds : [],
                collectionsByTransaction.TryGetValue(id, out var collectionIds) ? collectionIds : [],
                sharesByTransaction.TryGetValue(id, out var shares) ? shares : [],
                numbersByTransaction.TryGetValue(id, out var numbers) ? numbers : [],
                rows.GetString(12),
                NullableString(rows, 13)));
        }
        return transactions;
    }

    /// <summary>The tag or collection IDs of each transaction (or of one, when onlyId is set).</summary>
    static Dictionary<long, List<long>> ReadLinks(SqliteConnection connection, SqliteTransaction? transaction, LabelKind kind, long? onlyId)
    {
        var links = new Dictionary<long, List<long>>();
        using var command = Sql(connection, transaction,
            $"SELECT transaction_id, {kind.LinkColumn} FROM {kind.LinkTable} WHERE $id IS NULL OR transaction_id = $id ORDER BY transaction_id, {kind.LinkColumn};",
            ("$id", onlyId));
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var transactionId = reader.GetInt64(0);
            if (!links.TryGetValue(transactionId, out var ids))
                links[transactionId] = ids = [];
            ids.Add(reader.GetInt64(1));
        }
        return links;
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
                    (kind, date, amount_cents, payment_method_id, person_id, linked_id, merchant_id, description, note, archived, created_at)
                VALUES
                    ($kind, $date, $amount, $method, $person, $linked, $merchant, $description, $note, $archived, $now);
                SELECT last_insert_rowid();
                """, TransactionParameters(values, now)), CultureInfo.InvariantCulture);
        }
        else
        {
            savedId = before.Id;
            Execute(connection, transaction, """
                UPDATE transactions SET
                    kind = $kind, date = $date, amount_cents = $amount, payment_method_id = $method,
                    person_id = $person, linked_id = $linked, merchant_id = $merchant,
                    description = $description, note = $note, archived = $archived, updated_at = $now
                WHERE id = $id;
                """, [.. TransactionParameters(values, now), ("$id", savedId)]);
            Execute(connection, transaction, """
                DELETE FROM transaction_tags WHERE transaction_id = $id;
                DELETE FROM transaction_collections WHERE transaction_id = $id;
                DELETE FROM transaction_shares WHERE transaction_id = $id;
                """, ("$id", savedId));
        }
        foreach (var (kind, ids) in new[] { (Tags, values.TagIds), (Collections, values.CollectionIds) })
        {
            foreach (var labelId in ids)
                Execute(connection, transaction, $"INSERT INTO {kind.LinkTable} (transaction_id, {kind.LinkColumn}) VALUES ($id, $label);", ("$id", savedId), ("$label", labelId));
        }
        foreach (var share in values.Shares)
            Execute(connection, transaction, "INSERT INTO transaction_shares (transaction_id, person_id, amount_cents, gift) VALUES ($id, $person, $amount, $gift);",
                ("$id", savedId), ("$person", share.PersonId), ("$amount", share.AmountCents), ("$gift", share.Gift ? 1 : 0));
        Renumber(connection, transaction, savedId);

        var after = ReadTransactions(connection, transaction, savedId).Single();
        RecordHistory(connection, transaction, before is null ? "Created" : "Edited", "Transaction", savedId, before, after);
        transaction.Commit();
        return after;
    }

    static bool Unchanged(SpendTransaction before, TransactionValues values) =>
        before.Kind == values.Kind && before.Date == values.Date && before.AmountCents == values.AmountCents &&
        before.PaymentMethodId == values.PaymentMethodId && before.PersonId == values.PersonId && before.LinkedId == values.LinkedId &&
        before.MerchantId == values.MerchantId && before.Description == values.Description &&
        before.Note == values.Note && before.Archived == values.Archived &&
        before.TagIds.SequenceEqual(values.TagIds) && before.CollectionIds.SequenceEqual(values.CollectionIds) && before.Shares.SequenceEqual(values.Shares);

    static (string Name, object? Value)[] TransactionParameters(TransactionValues values, string now) =>
    [
        ("$kind", values.Kind), ("$date", values.Date), ("$amount", values.AmountCents), ("$method", values.PaymentMethodId),
        ("$person", values.PersonId), ("$linked", values.LinkedId), ("$merchant", values.MerchantId),
        ("$description", values.Description), ("$note", values.Note), ("$archived", values.Archived ? 1 : 0), ("$now", now)
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
            throw RequestException.Invalid("That payment method is archived. Restore it on the Payment Methods tab to use it again.");

        // Merchants are chosen by ID, like payment methods; they are created and renamed on the Merchants tab.
        var merchantId = request.MerchantId;
        var merchant = "";
        if (merchantId is not null)
        {
            using var lookup = Sql(connection, transaction, "SELECT name, archived FROM merchants WHERE id = $id;", ("$id", merchantId));
            using var found = lookup.ExecuteReader();
            if (!found.Read()) throw RequestException.Invalid("That merchant no longer exists. Refresh and try again.");
            merchant = found.GetString(0);
            if (found.GetInt64(1) != 0 && before?.MerchantId != merchantId)
                throw RequestException.Invalid($"{merchant} is an archived merchant. Restore it on the Merchants tab to use it again.");
        }
        var description = OptionalText(request.Description, MaxDescriptionLength, "Description");
        var note = OptionalText(request.Note, MaxNoteLength, "Note");
        if (merchant.Length == 0 && description.Length == 0)
            throw RequestException.Invalid("Enter a merchant or a description so you can recognize this later.");

        var tagIds = ValidateLabels(connection, transaction, Tags, kind, request.TagIds, before?.TagIds);
        var collectionIds = ValidateLabels(connection, transaction, Collections, kind, request.CollectionIds, before?.CollectionIds);

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
                    if (IsGiftShare(connection, transaction, repaid.Id, personId!.Value))
                        throw RequestException.Invalid($"{PersonName(connection, transaction, personId.Value)}'s share of that purchase was a gift, so there is nothing to pay back.");
                    if (LinkedShareTotal(connection, transaction, repaid.Id, personId!.Value, id) + amount > paybackShare)
                        throw RequestException.Invalid($"Refunds and paybacks for {PersonName(connection, transaction, personId.Value)}'s share would total more than their {FormatCents(paybackShare)}.");
                }
                break;
        }

        if (before?.Kind == "Purchase" && id is not null)
            ValidatePurchaseDependents(connection, transaction, id.Value, kind, date, shares);

        var archived = request.Archived ?? before?.Archived ?? false;
        return new TransactionValues(kind, date, amount, methodId, personId, linkedId, merchantId, merchant, description, note, archived, tagIds, collectionIds, shares);
    }

    /// <summary>Tags and collections: only on purchases (refunds count under their purchase's), existing, and active unless already on it.</summary>
    static List<long> ValidateLabels(SqliteConnection connection, SqliteTransaction transaction, LabelKind kind, string transactionKind, List<long>? requested, List<long>? before)
    {
        var ids = (requested ?? []).Distinct().Order().ToList();
        if (transactionKind != "Purchase" && ids.Count > 0)
            throw RequestException.Invalid($"Only purchases have {kind.Noun}s. Refunds count under their purchase's {kind.Noun}s.");
        foreach (var labelId in ids)
        {
            var archived = Scalar(connection, transaction, $"SELECT archived FROM {kind.Table} WHERE id = $id;", ("$id", labelId))
                ?? throw RequestException.Invalid($"One of the selected {kind.Noun}s no longer exists. Refresh and try again.");
            if (Convert.ToInt64(archived, CultureInfo.InvariantCulture) != 0 && before?.Contains(labelId) != true)
                throw RequestException.Invalid($"That {kind.Noun} is archived. Restore it on the {kind.Entity}s tab to use it again.");
        }
        return ids;
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
            var person = RequireUsablePerson(connection, transaction, personId, wasOnPurchase ? personId : null, "Choose who this purchase was for.");
            var gift = share.Gift ?? false;
            if (gift && person.IsSelf) throw RequestException.Invalid("Your own share cannot be a gift.");
            shares.Add(new Share(personId, cents, gift));
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
            if (share.Gift && group.Any(d => d.Kind == "Payback"))
                throw RequestException.Invalid($"{name} has paid back part of this purchase, so their share cannot be a gift.");
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

    static bool IsGiftShare(SqliteConnection connection, SqliteTransaction transaction, long purchaseId, long personId) =>
        Convert.ToInt64(Scalar(connection, transaction, "SELECT gift FROM transaction_shares WHERE transaction_id = $purchase AND person_id = $person;",
            ("$purchase", purchaseId), ("$person", personId)) ?? 0L, CultureInfo.InvariantCulture) != 0;

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
            throw RequestException.Invalid("That person is archived. Restore them on the People tab to use them again.");
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
        ForgetScope(connection, transaction, "method", id);
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
        ForgetScope(connection, transaction, "person", id);
        RecordHistory(connection, transaction, "Deleted", "Person", id, before, null);
        transaction.Commit();
    }

    // Tags and collections are the same kind of thing: named labels put on purchases, several per purchase.
    public static readonly LabelKind Tags = new("tags", "transaction_tags", "tag_id", "Tag", "tag", "tag");
    public static readonly LabelKind Collections = new("collections", "transaction_collections", "collection_id", "Collection", "collection", "collection");

    public Label CreateLabel(LabelKind kind, NameRequest request)
    {
        var name = RequireName(request.Name, $"{kind.Entity} name");
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        EnsureNameFree(connection, transaction, kind.Table, name, null, $"A {kind.Noun} with that name already exists.");
        var id = Convert.ToInt64(Scalar(connection, transaction,
            $"INSERT INTO {kind.Table} (name, created_at) VALUES ($name, $now); SELECT last_insert_rowid();",
            ("$name", name), ("$now", Now())), CultureInfo.InvariantCulture);
        var created = ReadLabels(connection, transaction, kind).Single(t => t.Id == id);
        RecordHistory(connection, transaction, "Created", kind.Entity, id, null, created);
        transaction.Commit();
        return created;
    }

    public Label UpdateLabel(LabelKind kind, long id, UpdateNameRequest request)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadLabels(connection, transaction, kind).SingleOrDefault(t => t.Id == id) ?? throw RequestException.NotFound($"{kind.Entity} not found.");
        var name = request.Name is null ? before.Name : RequireName(request.Name, $"{kind.Entity} name");
        var archived = request.Archived ?? before.Archived;
        EnsureNameFree(connection, transaction, kind.Table, name, id, $"A {kind.Noun} with that name already exists.");
        var after = before with { Name = name, Archived = archived };
        if (after == before) return before;
        Execute(connection, transaction, $"UPDATE {kind.Table} SET name = $name, archived = $archived WHERE id = $id;",
            ("$name", name), ("$archived", archived ? 1 : 0), ("$id", id));
        RecordHistory(connection, transaction, "Edited", kind.Entity, id, before, after);
        transaction.Commit();
        return after;
    }

    /// <summary>Deleting a tag or collection removes it from every transaction; the history entry records how many were affected.</summary>
    public void DeleteLabel(LabelKind kind, long id)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadLabels(connection, transaction, kind).SingleOrDefault(t => t.Id == id) ?? throw RequestException.NotFound($"{kind.Entity} not found.");
        var uses = Convert.ToInt64(Scalar(connection, transaction, $"SELECT COUNT(*) FROM {kind.LinkTable} WHERE {kind.LinkColumn} = $id;", ("$id", id)), CultureInfo.InvariantCulture);
        Execute(connection, transaction, $"DELETE FROM {kind.Table} WHERE id = $id;", ("$id", id));
        ForgetScope(connection, transaction, kind.Scope, id);
        RecordHistory(connection, transaction, "Deleted", kind.Entity, id, new { before.Id, before.Name, before.Archived, before.CreatedAt, RemovedFromTransactions = uses }, null);
        transaction.Commit();
    }

    public Merchant CreateMerchant(NameRequest request)
    {
        var name = RequireName(request.Name, "Merchant name", MaxMerchantLength);
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        EnsureNameFree(connection, transaction, "merchants", name, null, "A merchant with that name already exists.");
        var id = Convert.ToInt64(Scalar(connection, transaction,
            "INSERT INTO merchants (name, created_at) VALUES ($name, $now); SELECT last_insert_rowid();",
            ("$name", name), ("$now", Now())), CultureInfo.InvariantCulture);
        var created = ReadMerchants(connection, transaction).Single(m => m.Id == id);
        RecordHistory(connection, transaction, "Created", "Merchant", id, null, created);
        transaction.Commit();
        return created;
    }

    public Merchant UpdateMerchant(long id, UpdateNameRequest request)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadMerchants(connection, transaction).SingleOrDefault(m => m.Id == id) ?? throw RequestException.NotFound("Merchant not found.");
        var name = request.Name is null ? before.Name : RequireName(request.Name, "Merchant name", MaxMerchantLength);
        var archived = request.Archived ?? before.Archived;
        EnsureNameFree(connection, transaction, "merchants", name, id, "A merchant with that name already exists.");
        var after = before with { Name = name, Archived = archived };
        if (after == before) return before;
        Execute(connection, transaction, "UPDATE merchants SET name = $name, archived = $archived WHERE id = $id;",
            ("$name", name), ("$archived", archived ? 1 : 0), ("$id", id));
        RecordHistory(connection, transaction, "Edited", "Merchant", id, before, after);
        transaction.Commit();
        return after;
    }

    public void DeleteMerchant(long id)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var before = ReadMerchants(connection, transaction).SingleOrDefault(m => m.Id == id) ?? throw RequestException.NotFound("Merchant not found.");
        var uses = Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM transactions WHERE merchant_id = $id;", ("$id", id)), CultureInfo.InvariantCulture);
        if (uses > 0) throw RequestException.Invalid($"{before.Name} is on {uses} transaction{(uses == 1 ? "" : "s")}. Archive it instead to hide it from new entries.");
        Execute(connection, transaction, "DELETE FROM merchants WHERE id = $id;", ("$id", id));
        ForgetScope(connection, transaction, "merchant", id);
        RecordHistory(connection, transaction, "Deleted", "Merchant", id, before, null);
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
        // A backup from before a scope was added has no numbers for it yet; they are given out now, in date order.
        Renumber(connection, transaction, null);
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
        foreach (var (table, label) in new[] { ("payment_methods", "payment method"), ("people", "person"), ("tags", "tag"), ("collections", "collection") })
        {
            var bad = Scalar(connection, transaction,
                $"SELECT id FROM {table} WHERE typeof(name) <> 'text' OR length(trim(name)) = 0 OR length(name) > {MaxNameLength} OR name <> trim(name) LIMIT 1;");
            if (bad is not null) throw RequestException.Invalid($"The backup has an invalid {label} name (#{bad}).");
        }

        var badMerchant = Scalar(connection, transaction,
            $"SELECT id FROM merchants WHERE typeof(name) <> 'text' OR length(trim(name)) = 0 OR length(name) > {MaxMerchantLength} OR name <> trim(name) LIMIT 1;");
        if (badMerchant is not null) throw RequestException.Invalid($"The backup has an invalid merchant name (#{badMerchant}).");

        var badTransaction = Scalar(connection, transaction, $"""
            SELECT id FROM transactions
            WHERE typeof(amount_cents) <> 'integer' OR amount_cents > {MaxAmountCents}
               OR typeof(payment_method_id) <> 'integer'
               OR typeof(person_id) NOT IN ('integer', 'null') OR typeof(linked_id) NOT IN ('integer', 'null')
               OR typeof(merchant_id) NOT IN ('integer', 'null')
               OR typeof(description) <> 'text' OR typeof(note) <> 'text'
               OR length(description) > {MaxDescriptionLength} OR length(note) > {MaxNoteLength}
               OR (merchant_id IS NULL AND trim(description) = '')
            LIMIT 1;
            """);
        if (badTransaction is not null) throw RequestException.Invalid($"Transaction #{badTransaction} in the backup has an invalid value.");

        var badShare = Scalar(connection, transaction,
            "SELECT transaction_id FROM transaction_shares WHERE typeof(person_id) <> 'integer' OR typeof(amount_cents) <> 'integer' LIMIT 1;");
        if (badShare is not null) throw RequestException.Invalid($"Transaction #{badShare} in the backup has an invalid share.");

        foreach (var kind in new[] { Tags, Collections })
        {
            var labelledNonPurchase = Scalar(connection, transaction,
                $"SELECT t.transaction_id FROM {kind.LinkTable} t JOIN transactions x ON x.id = t.transaction_id WHERE x.kind <> 'Purchase' LIMIT 1;");
            if (labelledNonPurchase is not null) throw RequestException.Invalid($"Transaction #{labelledNonPurchase} in the backup has {kind.Noun}s, but only purchases can.");
        }

        ValidateRestoredNumbers(connection, transaction);


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
        using var dates = Sql(connection, transaction, "SELECT DISTINCT date FROM transactions;");
        using var reader = dates.ExecuteReader();
        while (reader.Read())
            RequireDate(reader.GetString(0), "Every date in the backup");
    }

    /// <summary>
    /// Restored numbers must belong to scopes their transaction is in, within each scope's counter. Numbers missing for a
    /// scope are not an error; ReplaceAllData gives them out after these checks.
    /// </summary>
    static void ValidateRestoredNumbers(SqliteConnection connection, SqliteTransaction transaction)
    {
        var scopes = string.Join(", ", NumberedScopes.Select(s => $"'{s.Scope}'"));
        var bad = Scalar(connection, transaction, $"""
            SELECT n.transaction_id FROM scope_numbers n LEFT JOIN scope_counters c ON c.scope = n.scope AND c.scope_id = n.scope_id
            WHERE n.scope NOT IN ({scopes}) OR typeof(n.scope_id) <> 'integer' OR typeof(n.number) <> 'integer'
               OR c.last_number IS NULL OR typeof(c.last_number) <> 'integer' OR n.number > c.last_number
            LIMIT 1;
            """);
        if (bad is not null) throw RequestException.Invalid($"Transaction #{bad} in the backup has an invalid number.");
        if (Scalar(connection, transaction, $"SELECT 1 FROM scope_counters WHERE scope NOT IN ({scopes}) OR typeof(scope_id) <> 'integer' LIMIT 1;") is not null)
            throw RequestException.Invalid("The backup has a number counter for an unknown scope.");

        foreach (var (scope, members) in NumberedScopes)
        {
            var stray = Scalar(connection, transaction, $"""
                SELECT n.transaction_id FROM scope_numbers n
                WHERE n.scope = $scope AND (n.scope_id, n.transaction_id) NOT IN (SELECT scope_id, transaction_id FROM ({members}))
                LIMIT 1;
                """, ("$scope", scope));
            if (stray is not null) throw RequestException.Invalid($"Transaction #{stray} in the backup has a {scope} number for a {scope} it does not belong to.");
        }
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
            // Your own share is never a gift, and nobody pays back a gift.
            """
            SELECT s.transaction_id FROM transaction_shares s JOIN people me ON me.id = s.person_id
            WHERE s.gift = 1 AND me.is_self = 1 LIMIT 1;
            """,
            """
            SELECT x.id FROM transactions x
            JOIN transaction_shares s ON s.transaction_id = x.linked_id AND s.person_id = x.person_id
            WHERE x.kind = 'Payback' AND s.gift = 1 LIMIT 1;
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

    // ---------------------------------------------------------------- fresh start

    /// <summary>Fresh start options handled in the database; recovery backups are files, so Program.cs removes those.</summary>
    public static readonly string[] FreshStartOptions = ["archivedEntries", "allEntries", "unusedLabels", "history"];

    // Archived entries go unless an active refund or payback still points at them, which would leave it linked to nothing.
    const string DeletableArchivedEntries = """
        SELECT t.id FROM transactions t
        WHERE t.archived = 1
          AND NOT EXISTS (SELECT 1 FROM transactions d WHERE d.linked_id = t.id AND d.archived = 0)
        """;

    // "Me" and every used label stay. Payment methods are chosen separately so at least one active one remains.
    static readonly (string Table, string Entity, string Scope, string Unused)[] UnusedLabels =
    [
        ("merchants", "Merchant", "merchant", "NOT EXISTS (SELECT 1 FROM transactions t WHERE t.merchant_id = merchants.id)"),
        ("tags", "Tag", "tag", "NOT EXISTS (SELECT 1 FROM transaction_tags l WHERE l.tag_id = tags.id)"),
        ("collections", "Collection", "collection", "NOT EXISTS (SELECT 1 FROM transaction_collections l WHERE l.collection_id = collections.id)"),
        ("people", "Person", "person", """
            is_self = 0
            AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.person_id = people.id)
            AND NOT EXISTS (SELECT 1 FROM transaction_shares s WHERE s.person_id = people.id)
            """),
    ];

    const string UnusedPaymentMethods = """
        SELECT id FROM payment_methods m
        WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.payment_method_id = m.id)
          AND (EXISTS (SELECT 1 FROM payment_methods k WHERE k.archived = 0
                       AND EXISTS (SELECT 1 FROM transactions t WHERE t.payment_method_id = k.id))
               OR m.archived = 1
               OR m.id <> (SELECT MIN(id) FROM payment_methods WHERE archived = 0))
        """;

    public FreshStartSummary ReadFreshStartSummary()
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction(deferred: true);
        long Count(string sql) => Convert.ToInt64(Scalar(connection, transaction, sql), CultureInfo.InvariantCulture);
        var labels = UnusedLabels.Sum(label => Count($"SELECT COUNT(*) FROM {label.Table} WHERE {label.Unused};"))
            + Count($"SELECT COUNT(*) FROM ({UnusedPaymentMethods});");
        return new FreshStartSummary(
            Count($"SELECT COUNT(*) FROM ({DeletableArchivedEntries});"),
            Count("SELECT COUNT(*) FROM transactions WHERE archived = 1;"),
            Count("SELECT COUNT(*) FROM transactions;"),
            labels,
            Count("SELECT COUNT(*) FROM history;"));
    }

    /// <summary>
    /// Clears the selected categories in one transaction. Removed entries and labels get the usual Deleted history
    /// entries unless the same Fresh start clears history. Scope counters stay, so entry numbers are never reused.
    /// </summary>
    public FreshStartResult FreshStart(IReadOnlyDictionary<string, bool> selections)
    {
        bool Selected(string key) => selections.TryGetValue(key, out var selected) && selected;
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var recordHistory = !Selected("history");
        long removedEntries = 0, keptArchivedEntries = 0, removedLabels = 0, removedHistory = 0;

        if (Selected("allEntries") || Selected("archivedEntries"))
        {
            var ids = new HashSet<long>();
            using (var command = Sql(connection, transaction, Selected("allEntries") ? "SELECT id FROM transactions;" : DeletableArchivedEntries + ";"))
            using (var reader = command.ExecuteReader())
                while (reader.Read()) ids.Add(reader.GetInt64(0));
            if (!Selected("allEntries"))
                keptArchivedEntries = Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM transactions WHERE archived = 1;"), CultureInfo.InvariantCulture) - ids.Count;
            var removed = recordHistory ? ReadTransactions(connection, transaction, null).Where(t => ids.Contains(t.Id)).ToList() : [];
            Execute(connection, transaction, "CREATE TEMP TABLE fresh_start_ids (id INTEGER PRIMARY KEY);");
            using (var insert = Sql(connection, transaction, "INSERT INTO fresh_start_ids (id) VALUES ($id);", ("$id", 0L)))
                foreach (var id in ids) { insert.Parameters["$id"].Value = id; insert.ExecuteNonQuery(); }
            // Refunds and paybacks first: they point at purchases, and that link does not cascade.
            Execute(connection, transaction, """
                DELETE FROM transactions WHERE linked_id IS NOT NULL AND id IN (SELECT id FROM fresh_start_ids);
                DELETE FROM transactions WHERE id IN (SELECT id FROM fresh_start_ids);
                DROP TABLE temp.fresh_start_ids;
                """);
            foreach (var before in removed) RecordHistory(connection, transaction, "Deleted", "Transaction", before.Id, before, null);
            removedEntries = ids.Count;
        }

        if (Selected("unusedLabels"))
        {
            foreach (var (table, entity, scope, unused) in UnusedLabels)
            {
                var all = table switch
                {
                    "merchants" => ReadMerchants(connection, transaction).Select(m => ((object)m, m.Id)),
                    "people" => ReadPeople(connection, transaction).Select(p => ((object)p, p.Id)),
                    _ => ReadLabels(connection, transaction, table == "tags" ? Tags : Collections).Select(l => ((object)l, l.Id)),
                };
                removedLabels += RemoveLabels(connection, transaction, table, entity, scope, $"SELECT id FROM {table} WHERE {unused}", all, recordHistory);
            }
            removedLabels += RemoveLabels(connection, transaction, "payment_methods", "PaymentMethod", "method", UnusedPaymentMethods,
                ReadPaymentMethods(connection, transaction).Select(m => ((object)m, m.Id)), recordHistory);
        }

        if (Selected("history"))
        {
            removedHistory = Convert.ToInt64(Scalar(connection, transaction, "SELECT COUNT(*) FROM history;"), CultureInfo.InvariantCulture);
            Execute(connection, transaction, "DELETE FROM history;");
        }
        transaction.Commit();
        return new FreshStartResult(removedEntries, keptArchivedEntries, removedLabels, removedHistory);
    }

    static long RemoveLabels(SqliteConnection connection, SqliteTransaction transaction, string table, string entity, string scope, string select,
        IEnumerable<(object Row, long Id)> rows, bool recordHistory)
    {
        var ids = new List<long>();
        using (var command = Sql(connection, transaction, select + ";"))
        using (var reader = command.ExecuteReader())
            while (reader.Read()) ids.Add(reader.GetInt64(0));
        var before = rows.ToDictionary(row => row.Id, row => row.Row);
        foreach (var id in ids)
        {
            Execute(connection, transaction, $"DELETE FROM {table} WHERE id = $id;", ("$id", id));
            ForgetScope(connection, transaction, scope, id);
            if (recordHistory) RecordHistory(connection, transaction, "Deleted", entity, id, before[id], null);
        }
        return ids.Count;
    }

    /// <summary>Rewrites the database without its free pages so deleted data stops taking disk space.</summary>
    public void Compact()
    {
        using var connection = Open();
        Execute(connection, null, "VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    }

    public long DatabaseBytes() => new[] { databasePath, databasePath + "-wal" }.Where(File.Exists).Sum(path => new FileInfo(path).Length);

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

    static string RequireName(string? value, string label, int maxLength = MaxNameLength)
    {
        var name = value?.Trim() ?? "";
        if (name.Length == 0) throw RequestException.Invalid($"{label} is required.");
        if (name.Length > maxLength) throw RequestException.Invalid($"{label} must be {maxLength} characters or fewer.");
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
/// <summary>A tag or a collection (see LabelKind).</summary>
record Label(long Id, string Name, bool Archived, string CreatedAt);
/// <summary>Where a label kind is stored: its table, the link table to transactions, and the names used in messages and history.</summary>
record LabelKind(string Table, string LinkTable, string LinkColumn, string Entity, string Scope, string Noun);
record Merchant(long Id, string Name, bool Archived, string CreatedAt);
/// <summary>A transaction's number inside one scope, such as ("person", 3, 12): the 12th entry for person #3.</summary>
record ScopeNumber(string Scope, long ScopeId, long Number);
/// <summary>One person's part of a purchase. A gift share is not owed back and stays off their balance.</summary>
record Share(long PersonId, long AmountCents, bool Gift = false);
record SpendTransaction(long Id, string Kind, string Date, long AmountCents, long PaymentMethodId, long? PersonId, long? LinkedId,
    long? MerchantId, string Merchant, string Description, string Note, bool Archived, List<long> TagIds, List<long> CollectionIds, List<Share> Shares,
    List<ScopeNumber> Numbers, string CreatedAt, string? UpdatedAt);
record HistoryEntry(long Id, string At, string Action, string Entity, long? EntityId, JsonElement? Before, JsonElement? After);
record HistoryPage(List<HistoryEntry> Entries, bool HasMore);
record Snapshot(string Version, List<PaymentMethod> PaymentMethods, List<Person> People, List<Label> Tags, List<Merchant> Merchants,
    List<Label> Collections, List<SpendTransaction> Transactions);

record TransactionRequest(string? Kind, string? Date, long? AmountCents, long? PaymentMethodId, long? PersonId, long? LinkedId,
    long? MerchantId, string? Description, string? Note, List<long>? TagIds, List<ShareRequest>? Shares, bool? Archived = null, List<long>? CollectionIds = null);
record ShareRequest(long? PersonId, long? AmountCents, bool? Gift = null);
record TransactionValues(string Kind, string Date, long AmountCents, long PaymentMethodId, long? PersonId, long? LinkedId,
    long? MerchantId, string Merchant, string Description, string Note, bool Archived, List<long> TagIds, List<long> CollectionIds, List<Share> Shares);
record FreshStartSummary(long ArchivedEntries, long AllArchivedEntries, long Entries, long UnusedLabels, long HistoryEntries);
record FreshStartResult(long RemovedEntries, long KeptArchivedEntries, long RemovedLabels, long RemovedHistory);
record NameRequest(string? Name);
record UpdateNameRequest(string? Name, bool? Archived);
