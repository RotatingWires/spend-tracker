using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

/// <summary>
/// Backup ZIPs: manifest.json plus an online copy of spendtracker.db, the same layout as TaskList and NewsReview.
/// Restores are bounded and verified before any live row changes. The password file is never included.
/// </summary>
static class Transfer
{
    public const long MaxUploadBytes = 256L * 1024 * 1024;
    const long MaxDatabaseBytes = 1024L * 1024 * 1024;
    const int MaxManifestBytes = 64 * 1024;
    const string Format = "spendtracker-backup";
    const int FormatVersion = 1;
    const string DatabaseEntry = "spendtracker.db";
    const string LegacyDatabaseEntry = "spend-tracker.db"; // Backups before v1.2.18
    const string ManifestEntry = "manifest.json";

    static readonly JsonSerializerOptions ManifestJson = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>
    /// Writes a backup ZIP to <paramref name="outputPath"/>. Its database is plain, so any SpendTracker can restore it,
    /// unless <paramref name="keepEncrypted"/> keeps this server's database key on it, for recovery backups kept in data/backups.
    /// </summary>
    public static BackupManifest CreateArchive(Store store, string outputPath, string version, bool keepEncrypted = false)
    {
        var workDirectory = Directory.CreateTempSubdirectory("spend-tracker-export-");
        try
        {
            var snapshotPath = Path.Combine(workDirectory.FullName, DatabaseEntry);
            store.CopyTo(snapshotPath, keepEncrypted);
            Dictionary<string, long> totals;
            using (var snapshot = OpenReadOnly(store, snapshotPath))
                totals = Store.CountRows(snapshot);

            var manifest = new BackupManifest(Format, FormatVersion, version, Store.SchemaVersion,
                DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture), Sha256(snapshotPath), totals);
            using (var stream = new FileStream(outputPath, FileMode.Create, FileAccess.Write))
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Create))
            {
                archive.CreateEntryFromFile(snapshotPath, DatabaseEntry, CompressionLevel.Optimal);
                using var writer = new StreamWriter(archive.CreateEntry(ManifestEntry, CompressionLevel.Optimal).Open(), new UTF8Encoding(false));
                writer.Write(JsonSerializer.Serialize(manifest, ManifestJson));
            }
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(outputPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            return manifest;
        }
        finally
        {
            workDirectory.Delete(recursive: true);
        }
    }

    /// <summary>Verifies an uploaded ZIP, saves a recovery backup of the current data, then replaces all data with it.</summary>
    public static RestoreResult RestoreArchive(Store store, string uploadPath, string recoveryDirectory, string version)
    {
        var workDirectory = Directory.CreateTempSubdirectory("spend-tracker-import-");
        try
        {
            var (databasePath, manifest) = ExtractAndVerify(store, uploadPath, workDirectory.FullName, version);

            if (OperatingSystem.IsWindows())
                Directory.CreateDirectory(recoveryDirectory);
            else
                Directory.CreateDirectory(recoveryDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var recoveryName = $"before-restore-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant()}.zip";
            var recoveryPath = Path.Combine(recoveryDirectory, recoveryName);
            CreateArchive(store, recoveryPath, version, keepEncrypted: true);

            var transactions = manifest.Totals["transactions"];
            try
            {
                store.ReplaceAllData(databasePath, manifest.SchemaVersion, new
                {
                    AppVersion = manifest.ApplicationVersion,
                    manifest.ExportedAt,
                    Transactions = transactions,
                    RecoveryFile = recoveryName
                });
            }
            catch
            {
                // The restore rolled back, so the current data is unchanged and this copy would only be clutter.
                File.Delete(recoveryPath);
                throw;
            }
            return new RestoreResult(transactions, recoveryName);
        }
        finally
        {
            SqliteConnection.ClearAllPools(); // Release the extracted database file so it can be deleted.
            workDirectory.Delete(recursive: true);
        }
    }

    /// <summary>Extracts only the two expected members, to fixed paths, with size bounds, and checks the database before use.</summary>
    static (string DatabasePath, BackupManifest Manifest) ExtractAndVerify(Store store, string uploadPath, string workDirectory, string version)
    {
        var databasePath = Path.Combine(workDirectory, "restore.db");
        try
        {
            BackupManifest manifest;
            using (var archive = ZipFile.OpenRead(uploadPath))
            {
                var names = archive.Entries.Select(entry => entry.FullName).ToHashSet();
                var databaseEntry = names.Contains(LegacyDatabaseEntry) ? LegacyDatabaseEntry : DatabaseEntry;
                if (archive.Entries.Count != 2 || !names.SetEquals([ManifestEntry, databaseEntry]))
                    throw RequestException.Invalid($"Choose a SpendTracker backup ZIP containing only {ManifestEntry} and {DatabaseEntry}.");
                foreach (var entry in archive.Entries)
                {
                    var limit = entry.FullName == ManifestEntry ? MaxManifestBytes : MaxDatabaseBytes;
                    if (entry.IsEncrypted || entry.Length > limit)
                        throw RequestException.Invalid("The backup ZIP is encrypted or a file inside it is too large.");
                }

                using (var reader = new StreamReader(archive.GetEntry(ManifestEntry)!.Open(), Encoding.UTF8))
                    manifest = JsonSerializer.Deserialize<BackupManifest>(reader.ReadToEnd(), ManifestJson)
                        ?? throw RequestException.Invalid("This is not a SpendTracker backup.");
                if (manifest.Format != Format || manifest.FormatVersion != FormatVersion || manifest.Totals is null)
                    throw RequestException.Invalid("This is not a SpendTracker backup.");
                if (!Version.TryParse(manifest.ApplicationVersion, out var backupVersion) || backupVersion > Version.Parse(version) || manifest.SchemaVersion > Store.SchemaVersion)
                    throw RequestException.Invalid("This backup was made by a newer SpendTracker version. Update SpendTracker first.");
                // Schema 6 and 7 backups restore too: the same tables and columns without merchant aliases and received
                // Shortcut entries, and schema 6 without $0.00 shares.
                if (manifest.SchemaVersion is not (6 or 7 or Store.SchemaVersion))
                    throw RequestException.Invalid($"This backup uses database schema {manifest.SchemaVersion}, which this version cannot restore.");

                using var source = archive.GetEntry(databaseEntry)!.Open();
                using var destination = File.Create(databasePath);
                CopyLimited(source, destination, MaxDatabaseBytes);
            }

            if (!string.Equals(Sha256(databasePath), manifest.Sha256, StringComparison.Ordinal))
                throw RequestException.Invalid("The backup database does not match its checksum; the file is damaged.");

            using var imported = OpenReadOnly(store, databasePath);
            try
            {
                Scalar(imported, "SELECT COUNT(*) FROM sqlite_master;");
            }
            catch (SqliteException) when (!DatabaseKey.IsPlain(databasePath))
            {
                throw RequestException.Invalid("This backup's database is encrypted with another SpendTracker server's database key (a recovery backup from its data/backups), or it is damaged. Restore it on the server that made it.");
            }
            if (Convert.ToString(Scalar(imported, "PRAGMA integrity_check;"), CultureInfo.InvariantCulture) != "ok")
                throw RequestException.Invalid("The backup database failed SQLite's integrity check.");
            // Like TaskList and NewsReview: every link must point at a row that exists.
            if (Scalar(imported, "PRAGMA foreign_key_check;") is not null)
                throw RequestException.Invalid("The backup database has links to missing rows.");
            if (Convert.ToInt64(Scalar(imported, "PRAGMA user_version;"), CultureInfo.InvariantCulture) != manifest.SchemaVersion)
                throw RequestException.Invalid("The backup database schema does not match its manifest.");
            VerifySchema(store, imported, manifest.SchemaVersion);

            var totals = Store.CountRows(imported, manifest.SchemaVersion);
            if (manifest.Totals.Count != totals.Count || totals.Any(pair => !manifest.Totals.TryGetValue(pair.Key, out var count) || count != pair.Value))
                throw RequestException.Invalid("The backup's row counts do not match its manifest.");
            return (databasePath, manifest);
        }
        catch (Exception error) when (error is InvalidDataException or SqliteException or JsonException or DecoderFallbackException)
        {
            throw RequestException.Invalid("This file is not a valid SpendTracker backup ZIP, or it is damaged.");
        }
    }

    /// <summary>The backup must hold exactly the live tables and columns of its schema version, and nothing that could run code.</summary>
    static void VerifySchema(Store store, SqliteConnection imported, int schemaVersion)
    {
        var tables = new HashSet<string>();
        using (var command = imported.CreateCommand())
        {
            command.CommandText = "SELECT type, name, COALESCE(sql, '') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%';";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var type = reader.GetString(0);
                if (type is not ("table" or "index") || reader.GetString(2).Contains("VIRTUAL", StringComparison.OrdinalIgnoreCase))
                    throw RequestException.Invalid("The backup contains triggers, views, or virtual tables, which are never accepted.");
                if (type == "table") tables.Add(reader.GetString(1));
            }
        }
        var expected = Store.TablesInSchema(schemaVersion);
        if (!tables.SetEquals(expected))
            throw RequestException.Invalid("The backup's tables do not match this version of SpendTracker.");

        // The live database was created or upgraded by this build at startup, so its layout is the expected one.
        using var live = OpenReadOnly(store, store.DatabasePath);
        foreach (var table in expected)
        {
            if (!Store.TableLayout(live, table).SequenceEqual(Store.TableLayout(imported, table)))
                throw RequestException.Invalid($"The backup's {table} table does not match this version of SpendTracker.");
        }
    }

    public static async Task SaveUpload(Stream body, string path, CancellationToken cancellationToken)
    {
        await using var output = File.Create(path);
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await body.ReadAsync(buffer, cancellationToken)) > 0)
        {
            total += read;
            if (total > MaxUploadBytes) throw RequestException.Invalid("The backup ZIP exceeds the 256 MiB upload limit.");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        if (total == 0) throw RequestException.Invalid("Choose a backup ZIP to restore.");
    }

    static void CopyLimited(Stream source, Stream destination, long limit)
    {
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = source.Read(buffer)) > 0)
        {
            total += read;
            if (total > limit) throw RequestException.Invalid("The backup database is larger than the 1 GiB limit.");
            destination.Write(buffer, 0, read);
        }
    }

    /// <summary>Opens a database file read-only, with the live database's key when the file is encrypted.</summary>
    static SqliteConnection OpenReadOnly(Store store, string path)
    {
        var connection = Store.OpenFile(path, DatabaseKey.IsPlain(path) ? null : store.DatabasePassword, SqliteOpenMode.ReadOnly);
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA trusted_schema=OFF;";
        command.ExecuteNonQuery();
        return connection;
    }

    static object? Scalar(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}

record BackupManifest(string Format, int FormatVersion, string ApplicationVersion, int SchemaVersion, string ExportedAt, string Sha256, Dictionary<string, long> Totals);
record RestoreResult(long Transactions, string RecoveryFile);
