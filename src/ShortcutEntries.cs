using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

/// <summary>
/// Entries sent by the iPhone Shortcut (POST /api/shortcut/entries): the phone's queue file as-is, JSON entries one after
/// another (one per line, or spread over several). Each is saved on its own, as a purchase for you alone, so one bad
/// entry never holds up the rest. An entry ID received before is skipped, so a queue sent again after a lost reply
/// never adds anything twice.
/// </summary>
sealed partial class Store
{
    public const int MaxShortcutEntries = 500;
    const int MinShortcutIdLength = 8;
    const int MaxShortcutIdLength = 100;

    // As strict as the rest of the API: unknown fields and explicit nulls for required values are refused.
    static readonly JsonSerializerOptions ShortcutJson = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectNullableAnnotations = true
    };

    public ShortcutResult ReceiveShortcutEntries(string body)
    {
        var (entries, unreadable) = ReadShortcutQueue(body);
        if (entries.Count == 0 && unreadable is null) throw RequestException.Invalid("Send at least one entry.");

        var saved = 0;
        var duplicates = 0;
        var rejected = new List<ShortcutRejection>();
        using var connection = Open();
        foreach (var (number, element) in entries)
        {
            ShortcutEntry? entry;
            try
            {
                entry = element.Deserialize<ShortcutEntry>(ShortcutJson);
            }
            catch (JsonException error)
            {
                rejected.Add(new ShortcutRejection(number, null, $"Entry {number} is not a valid entry: {error.Message}"));
                continue;
            }
            if (entry is null)
            {
                rejected.Add(new ShortcutRejection(number, null, $"Entry {number} is not a valid entry."));
                continue;
            }

            using var transaction = connection.BeginTransaction();
            try
            {
                var entryId = RequireShortcutId(entry.Id);
                if (Scalar(connection, transaction, "SELECT 1 FROM shortcut_entries WHERE entry_id = $id;", ("$id", entryId)) is not null)
                {
                    duplicates++;
                    continue;
                }
                var created = SaveTransaction(connection, transaction, null, ShortcutPurchase(connection, transaction, entry));
                Execute(connection, transaction, "INSERT INTO shortcut_entries (entry_id, transaction_id, received_at) VALUES ($id, $transaction, $now);",
                    ("$id", entryId), ("$transaction", created.Id), ("$now", Now()));
                transaction.Commit();
                saved++;
            }
            catch (RequestException error)
            {
                rejected.Add(new ShortcutRejection(number, entry.Id, $"{DescribeShortcutEntry(entry)}: {error.Message}"));
            }
        }
        if (unreadable is not null) rejected.Add(unreadable);
        return new ShortcutResult(saved, duplicates, rejected, ShortcutMessage(saved, duplicates, rejected));
    }

    /// <summary>
    /// The JSON values in the queue, numbered from 1. Text that is not JSON ends the reading there: the entries before it
    /// are still saved, and the reply says where reading stopped.
    /// </summary>
    static (List<(int Number, JsonElement Value)> Entries, ShortcutRejection? Unreadable) ReadShortcutQueue(string body)
    {
        var entries = new List<(int, JsonElement)>();
        var reader = new Utf8JsonReader(Encoding.UTF8.GetBytes(body), new JsonReaderOptions { AllowMultipleValues = true });
        try
        {
            while (reader.Read())
            {
                if (entries.Count == MaxShortcutEntries) throw RequestException.Invalid($"Send at most {MaxShortcutEntries} entries at a time.");
                using var document = JsonDocument.ParseValue(ref reader);
                entries.Add((entries.Count + 1, document.RootElement.Clone()));
            }
            return (entries, null);
        }
        catch (JsonException error)
        {
            var number = entries.Count + 1;
            return (entries, new ShortcutRejection(number, null, $"Entry {number} and anything after it could not be read, so they were not saved: {error.Message}"));
        }
    }

    static string RequireShortcutId(string? value)
    {
        var id = value?.Trim() ?? "";
        if (id.Length < MinShortcutIdLength || id.Length > MaxShortcutIdLength || !ShortcutIdPattern().IsMatch(id))
            throw RequestException.Invalid($"id must be {MinShortcutIdLength}–{MaxShortcutIdLength} letters, digits, or . _ : - and different for every entry.");
        return id;
    }

    [GeneratedRegex(@"^[A-Za-z0-9._:-]+$")]
    private static partial Regex ShortcutIdPattern();

    /// <summary>A purchase for you alone, paid with the payment method of that name, from what the Shortcut sent.</summary>
    static TransactionRequest ShortcutPurchase(SqliteConnection connection, SqliteTransaction transaction, ShortcutEntry entry)
    {
        var date = RequireDate(entry.Date, "date");
        var amount = ParseShortcutAmount(entry.Amount);
        var methodId = ResolvePaymentMethod(connection, transaction, entry.PaymentMethod);

        var merchantId = ResolveMerchant(connection, transaction, NormalizeMerchantText(OptionalText(entry.Merchant, MaxMerchantLength, "merchant")));
        var description = OptionalText(entry.Description, MaxDescriptionLength, "description");

        var self = Convert.ToInt64(Scalar(connection, transaction, "SELECT id FROM people WHERE is_self = 1;"), CultureInfo.InvariantCulture);
        return new TransactionRequest("Purchase", date, amount, methodId, null, null,
            merchantId, description, entry.Note, [], [new ShareRequest(self, amount)]);
    }

    /// <summary>
    /// The payment method of that name (ignoring case). A name SpendTracker does not have yet, such as a new card's name in
    /// Wallet, is added as a payment method, so the purchase is never lost; it is undone with the entry if the entry is
    /// refused. A name you archived is refused instead of being brought back unasked.
    /// </summary>
    static long ResolvePaymentMethod(SqliteConnection connection, SqliteTransaction transaction, string? requested)
    {
        var name = RequireName(requested, "paymentMethod");
        using (var lookup = Sql(connection, transaction, "SELECT id, name, archived FROM payment_methods WHERE name = $name;", ("$name", name)))
        using (var found = lookup.ExecuteReader())
        {
            if (found.Read())
            {
                if (found.GetInt64(2) != 0)
                    throw RequestException.Invalid($"{found.GetString(1)} is an archived payment method. Restore it on the Payment Methods tab, or change the Shortcut.");
                return found.GetInt64(0);
            }
        }
        return InsertPaymentMethod(connection, transaction, name).Id;
    }

    /// <summary>
    /// The merchant for a merchant name as a payment app shows it. Aliases come first, since each is a rule you set: the
    /// merchant with the longest alias the text starts with as whole words, so "BURGER KING" matches "BURGER KING #1234"
    /// but not "BURGER KINGDOM". Then the merchant of exactly that name, ignoring case. A name neither matches is added
    /// as a merchant, undone with the entry if the entry is refused. A match you archived is refused instead of being
    /// used unasked. Null when no merchant was sent.
    /// </summary>
    static long? ResolveMerchant(SqliteConnection connection, SqliteTransaction transaction, string text)
    {
        if (text.Length == 0) return null;
        long? matched = null;
        var matchedLength = 0;
        using (var command = Sql(connection, transaction, "SELECT alias, merchant_id FROM merchant_aliases;"))
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                var alias = reader.GetString(0);
                if (alias.Length <= matchedLength || !text.StartsWith(alias, StringComparison.OrdinalIgnoreCase)) continue;
                var wholeWords = text.Length == alias.Length || !char.IsLetterOrDigit(alias[^1]) || !char.IsLetterOrDigit(text[alias.Length]);
                if (!wholeWords) continue;
                matched = reader.GetInt64(1);
                matchedLength = alias.Length;
            }
        }
        matched ??= Scalar(connection, transaction, "SELECT id FROM merchants WHERE name = $name;", ("$name", text)) is { } exact
            ? Convert.ToInt64(exact, CultureInfo.InvariantCulture) : null;
        if (matched is null) return InsertMerchant(connection, transaction, text).Id;

        using var lookup = Sql(connection, transaction, "SELECT name, archived FROM merchants WHERE id = $id;", ("$id", matched));
        using var found = lookup.ExecuteReader();
        found.Read();
        if (found.GetInt64(1) != 0)
            throw RequestException.Invalid($"{found.GetString(0)} is an archived merchant. Restore it on the Merchants tab, or give the Shortcut's merchant to another one with an alias.");
        return matched;
    }

    /// <summary>Dollars as a number (12.34) or text ("$1,234.56"), to cents; at most two decimal places.</summary>
    static long ParseShortcutAmount(JsonElement? value)
    {
        var text = value?.ValueKind switch
        {
            JsonValueKind.Number => value.Value.GetRawText(),
            JsonValueKind.String => value.Value.GetString(),
            _ => null
        } ?? throw RequestException.Invalid("amount is required, such as 12.34.");
        var cleaned = text.Replace("$", "", StringComparison.Ordinal).Replace(",", "", StringComparison.Ordinal).Trim();
        if (!decimal.TryParse(cleaned, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var dollars) || decimal.Round(dollars, 2) != dollars)
            throw RequestException.Invalid($"amount {text} is not a dollar amount like 12.34.");
        if (dollars * 100 > MaxAmountCents) throw RequestException.Invalid("Amount must be between $0.01 and $10,000,000.00.");
        return (long)(dollars * 100);
    }

    /// <summary>How the Shortcut's notification names an entry it could not save, from what was sent.</summary>
    static string DescribeShortcutEntry(ShortcutEntry entry)
    {
        var amount = entry.Amount?.ValueKind switch
        {
            JsonValueKind.Number => entry.Amount.Value.GetRawText(),
            JsonValueKind.String => entry.Amount.Value.GetString(),
            _ => null
        };
        var parts = new[] { entry.Merchant, entry.Description, amount, entry.Date }.Select(part => part?.Trim()).Where(part => !string.IsNullOrEmpty(part));
        return string.Join(", ", parts) is { Length: > 0 } described ? described : "An entry";
    }

    static string ShortcutMessage(int saved, int duplicates, List<ShortcutRejection> rejected)
    {
        var parts = new List<string> { saved == 1 ? "Saved 1 entry." : $"Saved {saved} entries." };
        if (duplicates > 0) parts.Add(duplicates == 1 ? "1 was already saved." : $"{duplicates} were already saved.");
        if (rejected.Count > 0)
            parts.Add($"Not saved, add {(rejected.Count == 1 ? "it" : "them")} by hand: {string.Join(" ", rejected.Select(r => r.Error.EndsWith('.') ? r.Error : r.Error + "."))}");
        return string.Join(" ", parts);
    }
}

/// <summary>One entry of the Shortcut's queue. Amount is a number or text so a Shortcut can pass Wallet's "$12.34" as-is.</summary>
record ShortcutEntry(string? Id, string? Date, JsonElement? Amount, string? PaymentMethod, string? Merchant = null, string? Description = null, string? Note = null);
record ShortcutRejection(int Entry, string? Id, string Error);
record ShortcutResult(int Saved, int Duplicates, List<ShortcutRejection> Rejected, string Message);
