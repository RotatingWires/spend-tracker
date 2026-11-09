using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

/// <summary>
/// File > Fresh Start...: what each option would clear, clearing only the chosen data, and compacting the database
/// afterward. Its own file like TaskList's and NewsReview's FreshStart.cs; the rest of Store is in Store.cs.
/// </summary>
sealed partial class Store
{
    /// <summary>Fresh start options handled in the database; recovery backups are files, so Program.cs removes those.</summary>
    public static readonly string[] FreshStartOptions = ["archivedEntries", "allEntries", "unusedLabels", "allLabels", "history"];

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
        var allLabels = Count("SELECT (SELECT COUNT(*) FROM tags) + (SELECT COUNT(*) FROM collections) + (SELECT COUNT(*) FROM merchants) + (SELECT COUNT(*) FROM people WHERE is_self = 0) + (SELECT COUNT(*) FROM payment_methods);");
        return new FreshStartSummary(
            Count($"SELECT COUNT(*) FROM ({DeletableArchivedEntries});"),
            Count("SELECT COUNT(*) FROM transactions WHERE archived = 1;"),
            Count("SELECT COUNT(*) FROM transactions;"),
            labels,
            allLabels,
            Count("SELECT COUNT(*) FROM history;"));
    }

    /// <summary>
    /// Clears the selected categories in one transaction. Removed entries and labels get the usual Deleted history
    /// entries unless the same Fresh start clears history. Scope counters stay, so entry numbers are never reused.
    /// </summary>
    public FreshStartResult FreshStart(IReadOnlyDictionary<string, bool> selections)
    {
        bool Selected(string key) => selections.TryGetValue(key, out var selected) && selected;
        if (Selected("allLabels") && !Selected("allEntries"))
            throw RequestException.Invalid("Every label can only be cleared together with every entry, since entries use them.");
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

        if (Selected("allLabels"))
        {
            // Every entry is gone too, so nothing uses a label any more: all of them go, numbering starts over, and the
            // next IDs are 1 again. The default payment methods come back as in a new database; Me stays.
            foreach (var (table, entity, scope, _) in UnusedLabels)
            {
                var all = table switch
                {
                    "merchants" => ReadMerchants(connection, transaction).Select(m => ((object)m, m.Id)),
                    "people" => ReadPeople(connection, transaction).Select(p => ((object)p, p.Id)),
                    _ => ReadLabels(connection, transaction, table == "tags" ? Tags : Collections).Select(l => ((object)l, l.Id)),
                };
                removedLabels += RemoveLabels(connection, transaction, table, entity, scope,
                    table == "people" ? "SELECT id FROM people WHERE is_self = 0" : $"SELECT id FROM {table}", all, recordHistory);
            }
            removedLabels += RemoveLabels(connection, transaction, "payment_methods", "PaymentMethod", "method", "SELECT id FROM payment_methods",
                ReadPaymentMethods(connection, transaction).Select(m => ((object)m, m.Id)), recordHistory);
            Execute(connection, transaction, """
                DELETE FROM scope_numbers;
                DELETE FROM scope_counters;
                DELETE FROM sqlite_sequence WHERE name IN ('payment_methods', 'tags', 'collections', 'merchants', 'transactions');
                UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM people) WHERE name = 'people';
                INSERT INTO payment_methods (name, created_at) VALUES ('Cash', $now), ('Credit Card', $now), ('Debit Card', $now);
                """, ("$now", Now()));
            if (recordHistory)
                foreach (var method in ReadPaymentMethods(connection, transaction))
                    RecordHistory(connection, transaction, "Created", "PaymentMethod", method.Id, null, method);
        }
        else if (Selected("unusedLabels"))
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
}
