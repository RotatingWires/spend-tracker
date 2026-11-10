using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// The iPhone Shortcut's key (File > iPhone Shortcut...). It is shown once when created; only its SHA-256 hash is kept,
/// in data/shortcut-key.json, which backups never include. The key can only add entries through
/// POST /api/shortcut/entries: it cannot read, change, or delete anything.
/// </summary>
static class ShortcutKey
{
    const string Prefix = "stk_";

    record KeyFile(string Sha256, string CreatedAt);

    public static string PathIn(string dataDir) => Path.Combine(dataDir, "shortcut-key.json");

    /// <summary>When the current key was created, or null when there is none and the Shortcut is turned off.</summary>
    public static string? CreatedAt(string path) => Read(path)?.CreatedAt;

    /// <summary>Makes a new key, replacing any earlier one, and returns it; it cannot be shown again.</summary>
    public static string Create(string path)
    {
        // 256 random bits, so the unsalted hash cannot be guessed back, like the Tag System's API keys.
        var key = Prefix + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var file = new KeyFile(Hash(key), DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        // Written beside the target and renamed, like auth.json, so an interrupted save never leaves half a file.
        var temporaryPath = path + ".tmp";
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using (var stream = new FileStream(temporaryPath, options))
        {
            JsonSerializer.Serialize(stream, file);
            stream.Flush(flushToDisk: true);
        }
        File.Move(temporaryPath, path, overwrite: true);
        return key;
    }

    public static void Delete(string path) => File.Delete(path);

    /// <summary>Whether an Authorization header carries the current key as "Bearer stk_...". No key file fails closed.</summary>
    public static bool Matches(string path, string? authorization)
    {
        const string scheme = "Bearer ";
        if (authorization is null || !authorization.StartsWith(scheme, StringComparison.OrdinalIgnoreCase)) return false;
        var supplied = authorization[scheme.Length..].Trim();
        var expected = Read(path)?.Sha256;
        if (expected is null || !supplied.StartsWith(Prefix, StringComparison.Ordinal)) return false;
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Hash(supplied)), Encoding.ASCII.GetBytes(expected));
    }

    static KeyFile? Read(string path)
    {
        try
        {
            return File.Exists(path) ? JsonSerializer.Deserialize<KeyFile>(File.ReadAllText(path)) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    static string Hash(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();
}
