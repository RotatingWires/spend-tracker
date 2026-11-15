using System.Security.Cryptography;
using System.Text;

/// <summary>
/// The key spendtracker.db is encrypted with (SQLite3 Multiple Ciphers, ChaCha20-Poly1305), found the same way as the
/// sign-in keys' secret (src/SignInKeys.cs) but kept separate from it, so deleting data/keys never locks the data. On
/// Linux it comes from an encrypted systemd credential handed only to the service; on Windows it is a random key in
/// data/database.key, encrypted with machine-scope DPAPI and created on first start. Either way a copied data folder or
/// disk is unreadable on its own. Without one (macOS, or the app started from a terminal) the database stays
/// unencrypted, an owner-only file as before.
/// </summary>
static class DatabaseKey
{
    public const string CredentialName = "spendtracker-database-key";
    const string WindowsKeyFile = "database.key";
    static readonly byte[] PlainHeader = "SQLite format 3\0"u8.ToArray();

    /// <summary>
    /// The key as the connection string's Password ("x'hex'", a raw 256-bit key used without key stretching), or null
    /// when this run has no key. On Windows a missing data/database.key is created only when <paramref name="create"/>.
    /// </summary>
    public static string? Load(string dataDir, bool create)
    {
        var key = OperatingSystem.IsWindows() ? LoadWindowsKey(dataDir, create) : ReadCredential();
        return key is null ? null : $"x'{Convert.ToHexString(key)}'";
    }

    /// <summary>Where the key comes from, for the startup log.</summary>
    public static string Describe(string? password) =>
        password is null
            ? $"not encrypted (the {CredentialName} systemd credential would encrypt it, see the README)"
            : OperatingSystem.IsWindows()
                ? "encrypted with a key in data/database.key, protected with machine-scope DPAPI"
                : $"encrypted with the {CredentialName} systemd credential";

    /// <summary>
    /// True when the file is a plain SQLite database. An encrypted one has no readable header, so nothing about it can
    /// be read without the key.
    /// </summary>
    public static bool IsPlain(string path)
    {
        Span<byte> header = stackalloc byte[16];
        using var stream = File.OpenRead(path);
        return stream.ReadAtLeast(header, header.Length, throwOnEndOfStream: false) == header.Length && header.SequenceEqual(PlainHeader);
    }

    /// <summary>The 256-bit key derived from the credential systemd passed in, or null without one.</summary>
    static byte[]? ReadCredential()
    {
        var folder = Environment.GetEnvironmentVariable("CREDENTIALS_DIRECTORY");
        if (string.IsNullOrEmpty(folder)) return null;
        var path = Path.Combine(folder, CredentialName);
        if (!File.Exists(path)) return null;
        var raw = File.ReadAllBytes(path);
        if (raw.Length < 16) throw new InvalidOperationException($"The {CredentialName} credential is too short; create it from 32 random bytes as the README shows.");
        return HKDF.DeriveKey(HashAlgorithmName.SHA256, raw, 32, info: "spendtracker database"u8.ToArray());
    }

    /// <summary>data/database.key, created once from 32 random bytes and readable only through DPAPI on this computer.</summary>
    static byte[]? LoadWindowsKey(string dataDir, bool create)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var path = Path.Combine(dataDir, WindowsKeyFile);
        var entropy = Encoding.UTF8.GetBytes("SpendTracker database key");
        if (File.Exists(path))
        {
            try { return ProtectedData.Unprotect(File.ReadAllBytes(path), entropy, DataProtectionScope.LocalMachine); }
            catch (CryptographicException)
            {
                throw new InvalidOperationException("data/database.key was made on another computer, so this one cannot read spendtracker.db. Move SpendTracker with Download Backup and Restore instead of copying the data folder.");
            }
        }
        if (!create) return null;
        var key = RandomNumberGenerator.GetBytes(32);
        // Written beside the final name and renamed over it, so a crash cannot leave half a key.
        var temporary = path + ".tmp";
        File.WriteAllBytes(temporary, ProtectedData.Protect(key, entropy, DataProtectionScope.LocalMachine));
        File.Move(temporary, path, overwrite: false);
        return key;
    }
}
