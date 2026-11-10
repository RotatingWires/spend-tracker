using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Data.Sqlite;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.RateLimiting;

// SpendTracker options are read here; everything else (such as --urls) goes to ASP.NET Core. Same as NewsReview.
if (args is ["--version"])
{
    Console.WriteLine(Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0");
    return;
}
if (args is ["backup", .. var backupArgs])
{
    var defaultDatabase = File.Exists(Path.Combine("data", "spendtracker.db")) || !File.Exists(Path.Combine("data", "spend-tracker.db"))
        ? Path.Combine("data", "spendtracker.db") : Path.Combine("data", "spend-tracker.db");
    Environment.ExitCode = DatabaseFiles.BackupCommand("SpendTracker", defaultDatabase, backupArgs);
    return;
}
var hostArgs = new List<string>();
string? dataDirectoryArgument = null;
for (var i = 0; i < args.Length; i++)
{
    if (args[i] == "--data-dir" && i + 1 < args.Length) dataDirectoryArgument = args[++i];
    else hostArgs.Add(args[i]);
}

var builder = WebApplication.CreateBuilder(hostArgs.ToArray());
// --data-dir, then the SpendTracker:DataDirectory setting, then SPENDTRACKER_DATA_DIR, then data/ next to the app.
var dataDir = Path.GetFullPath(dataDirectoryArgument ?? builder.Configuration["SpendTracker:DataDirectory"]
    ?? Environment.GetEnvironmentVariable("SPENDTRACKER_DATA_DIR") ?? Path.Combine(builder.Environment.ContentRootPath, "data"));
Directory.CreateDirectory(dataDir);
var consoleLogPath = Path.Combine(builder.Environment.ContentRootPath, "logs", "console.log");
builder.Logging.AddProvider(new SingleFileLoggerProvider(consoleLogPath, 10 * 1024 * 1024));

// Loopback unless --urls, ASPNETCORE_URLS, or an appsettings "urls" value chooses another address.
if (string.IsNullOrEmpty(builder.Configuration["urls"]))
    builder.WebHost.UseUrls("http://127.0.0.1:8715");

// Requests are strict: unknown fields and explicit nulls for required values are rejected instead of ignored.
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
    options.SerializerOptions.RespectNullableAnnotations = true;
});
builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);

// Session-cookie keys must outlive restarts, or every restart signs you out, so they always live in data/keys,
// encrypted with machine-scope DPAPI on Windows and with the spendtracker-sign-in-keys systemd credential on Linux
// (src/SignInKeys.cs, the same in every app). The startup log says how.
var keysDirectory = Path.Combine(dataDir, "keys");
SignInKeys.Configure(builder.Services, "SpendTracker", _ => keysDirectory, "spendtracker");
var keyLocation = SignInKeys.Describe(keysDirectory, "spendtracker");

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "SpendTracker.Auth";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        options.ExpireTimeSpan = TimeSpan.FromDays(30);
        options.SlidingExpiration = true;
        options.LoginPath = "/login.html";
        options.Events.OnRedirectToLogin = context =>
        {
            if (context.Request.Path.StartsWithSegments("/api"))
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            else
                context.Response.Redirect(LoginRedirect(context));
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            if (context.Request.Path.StartsWithSegments("/api"))
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
            else
                context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
    });
builder.Services.AddAuthorization();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("auth", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 5,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0,
                AutoReplenishment = true
            }));
    // The iPhone Shortcut sends its whole queue at once, so a handful of runs a minute is plenty.
    options.AddPolicy("shortcut", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0,
                AutoReplenishment = true
            }));
});

// Brotli or gzip for text responses (data, scripts, styles), so they cross the network several times smaller.
// HTTPS responses are left uncompressed, ASP.NET's default, which avoids compression side-channel attacks there.
builder.Services.AddResponseCompression(options =>
{
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(["image/svg+xml", "application/manifest+json"]);
});

var app = builder.Build();
app.UseResponseCompression();
var appVersion = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

var authPath = Path.Combine(dataDir, "auth.json");
var shortcutKeyPath = ShortcutKey.PathIn(dataDir);

var databasePath = DatabaseFiles.Locate(dataDir, "spendtracker.db", "spend-tracker.db", app.Logger);
Onboarding.Initialize(dataDir, databasePath);
var store = new Store(databasePath);
string journalMode;
try
{
    journalMode = store.Initialize();
}
catch (InvalidOperationException error)
{
    // A database this version cannot use: say why and stop, without touching the file.
    app.Logger.LogError("{Error}", error.Message);
    Environment.ExitCode = 1;
    return;
}
app.Logger.LogInformation("SpendTracker v{Version}, data folder {DataDirectory}.", appVersion, dataDir);
app.Logger.LogInformation("Database ready: journal_mode={JournalMode}, synchronous=NORMAL, busy_timeout=5000 ms.", journalMode);
app.Logger.LogInformation("Sign-in keys: {Location}.", keyLocation);

string? setupToken = PasswordAuth.IsConfigured(authPath) ? null : PasswordAuth.GenerateSetupToken();
if (setupToken is not null)
{
    Console.WriteLine();
    Console.WriteLine("============================================================");
    Console.WriteLine("SPENDTRACKER FIRST-RUN SETUP TOKEN");
    Console.WriteLine();
    Console.WriteLine($"  {setupToken}");
    Console.WriteLine();
    Console.WriteLine("Enter this token on the Create Password screen.");
    Console.WriteLine("It changes each time SpendTracker restarts until setup is complete.");
    Console.WriteLine("============================================================");
    Console.WriteLine();
}

// Browser hardening: API replies are never stored, and pages and scripts are checked for changes on every load.
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        var headers = context.Response.Headers;
        headers.CacheControl = context.Request.Path.StartsWithSegments("/api") ? "no-store" : "no-cache";
        headers.XContentTypeOptions = "nosniff";
        headers["Referrer-Policy"] = "no-referrer";
        headers.ContentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
        return Task.CompletedTask;
    });
    await next();
});
// Cross-origin writes are refused before rate limiting, so they never use up login attempts.
app.Use(async (context, next) =>
{
    if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
    {
        var origin = context.Request.Headers.Origin.ToString();
        var sameOrigin = origin.Length == 0
            || (Uri.TryCreate(origin, UriKind.Absolute, out var originUri)
                && string.Equals(originUri.Authority, context.Request.Host.Value, StringComparison.OrdinalIgnoreCase));
        if (context.Request.Headers["Sec-Fetch-Site"] == "cross-site" || !sameOrigin)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "Cross-origin writes are not allowed." });
            return;
        }
    }
    await next();
});
app.UseRouting();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    var authenticated = context.User.Identity?.IsAuthenticated == true;

    if ((path == "/" || path == "/index.html") && !authenticated)
    {
        context.Response.Redirect("/login.html");
        return;
    }

    if (path == "/login.html" && authenticated)
    {
        context.Response.Redirect("/");
        return;
    }

    await next();
});

// Every refused request answers with { error } so the browser can show the reason as-is.
app.Use(async (context, next) =>
{
    try
    {
        await next();
    }
    catch (RequestException error) when (!context.Response.HasStarted)
    {
        context.Response.StatusCode = error.StatusCode;
        await context.Response.WriteAsJsonAsync(new { error = error.Message });
    }
    catch (BadHttpRequestException error) when (!context.Response.HasStarted)
    {
        context.Response.StatusCode = error.StatusCode;
        var detail = error.InnerException is JsonException json ? json.Message : error.Message;
        await context.Response.WriteAsJsonAsync(new { error = $"The request was not understood: {detail}" });
    }
    catch (SqliteException error) when (!context.Response.HasStarted)
    {
        app.Logger.LogError(error, "Database error on {Method} {Path}.", context.Request.Method, context.Request.Path);
        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        await context.Response.WriteAsJsonAsync(new { error = $"The database could not complete the request: {error.Message}" });
    }
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/auth/status", (HttpContext context) => Results.Ok(new
{
    version = appVersion,
    configured = PasswordAuth.IsConfigured(authPath),
    authenticated = context.User.Identity?.IsAuthenticated == true
}));

app.MapPost("/api/auth/setup", async (SetupRequest request, HttpContext context) =>
{
    if (PasswordAuth.IsConfigured(authPath))
        return Results.Conflict(new { error = "A password is already configured." });

    if (setupToken is null)
        return Results.Conflict(new { error = "No setup token is active. Restart SpendTracker to generate a new one." });

    if (!PasswordAuth.SetupTokenMatches(setupToken, request.SetupToken))
        return Results.Json(new { error = "Invalid setup token." }, statusCode: StatusCodes.Status401Unauthorized);

    var passwordError = PasswordAuth.ValidateNewPassword(request.Password, request.ConfirmPassword);
    if (passwordError is not null)
        return Results.BadRequest(new { error = passwordError });

    PasswordAuth.Save(authPath, request.Password!);
    setupToken = null;
    await PasswordAuth.SignInOwner(context);
    return Results.Ok(new { authenticated = true });
}).RequireRateLimiting("auth");

app.MapPost("/api/auth/login", async (LoginRequest request, HttpContext context) =>
{
    if (!PasswordAuth.IsConfigured(authPath))
        return Results.Conflict(new { error = "No password has been configured yet." });
    if (string.IsNullOrEmpty(request.Password) || !PasswordAuth.Verify(authPath, request.Password, out var needsRehash))
        return Results.Unauthorized();

    if (needsRehash)
    {
        PasswordAuth.Save(authPath, request.Password);
        app.Logger.LogInformation("Upgraded the saved password hash to {Iterations} PBKDF2 iterations.", PasswordAuth.Iterations);
    }

    await PasswordAuth.SignInOwner(context);
    return Results.Ok(new { authenticated = true });
}).RequireRateLimiting("auth");

app.MapPost("/api/auth/logout", async (HttpContext context) =>
{
    await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.NoContent();
}).RequireAuthorization();

// The iPhone Shortcut uses its own key instead of a session, and can only add entries (src/ShortcutKey.cs).
app.MapPost("/api/shortcut/entries", async (HttpRequest request) =>
{
    if (!ShortcutKey.Matches(shortcutKeyPath, request.Headers.Authorization))
        return Results.Json(new { error = "The Shortcut key is missing or wrong. Create one in SpendTracker under File > iPhone Shortcut... and paste it into the Shortcut." },
            statusCode: StatusCodes.Status401Unauthorized);
    using var reader = new StreamReader(request.Body, Encoding.UTF8);
    var result = store.ReceiveShortcutEntries(await reader.ReadToEndAsync(request.HttpContext.RequestAborted));
    app.Logger.LogInformation("Shortcut entries: {Saved} saved, {Duplicates} already saved, {Rejected} not saved.", result.Saved, result.Duplicates, result.Rejected.Count);
    return Results.Ok(result);
}).RequireRateLimiting("shortcut").WithMetadata(new RequestSizeLimitAttribute(1024 * 1024));

var api = app.MapGroup("/api").RequireAuthorization();

// The first-start "Restore a Backup Before Starting" prompt, like TaskList's.
api.MapGet("/onboarding", () => Results.Ok(new { importReminderPending = Onboarding.Pending(dataDir) }));
api.MapPost("/onboarding/acknowledge", () =>
{
    Onboarding.Acknowledge(dataDir);
    return Results.NoContent();
});

api.MapGet("/snapshot", () => Results.Ok(store.ReadSnapshot(appVersion)));
api.MapGet("/history", (long? beforeId, int? limit, string? query) => Results.Ok(store.ReadHistory(beforeId, limit ?? 200, query)));

api.MapPost("/transactions", (TransactionRequest request) =>
{
    var created = store.SaveTransaction(null, request);
    return Results.Created($"/api/transactions/{created.Id}", created);
});
api.MapPut("/transactions/{id:long}", (long id, TransactionRequest request) => Results.Ok(store.SaveTransaction(id, request)));
api.MapDelete("/transactions/{id:long}", (long id) =>
{
    store.DeleteTransaction(id);
    return Results.NoContent();
});

api.MapPost("/payment-methods", (NameRequest request) => Results.Ok(store.CreatePaymentMethod(request)));
api.MapPatch("/payment-methods/{id:long}", (long id, UpdateNameRequest request) => Results.Ok(store.UpdatePaymentMethod(id, request)));
api.MapDelete("/payment-methods/{id:long}", (long id) =>
{
    store.DeletePaymentMethod(id);
    return Results.NoContent();
});

api.MapPost("/people", (NameRequest request) => Results.Ok(store.CreatePerson(request)));
api.MapPatch("/people/{id:long}", (long id, UpdateNameRequest request) => Results.Ok(store.UpdatePerson(id, request)));
api.MapDelete("/people/{id:long}", (long id) =>
{
    store.DeletePerson(id);
    return Results.NoContent();
});

api.MapPost("/tags", (NameRequest request) => Results.Ok(store.CreateLabel(Store.Tags, request)));
api.MapPatch("/tags/{id:long}", (long id, UpdateNameRequest request) => Results.Ok(store.UpdateLabel(Store.Tags, id, request)));
api.MapDelete("/tags/{id:long}", (long id) =>
{
    store.DeleteLabel(Store.Tags, id);
    return Results.NoContent();
});

api.MapPost("/merchants", (NameRequest request) => Results.Ok(store.CreateMerchant(request)));
api.MapPatch("/merchants/{id:long}", (long id, UpdateNameRequest request) => Results.Ok(store.UpdateMerchant(id, request)));
api.MapPut("/merchants/{id:long}/aliases", (long id, AliasesRequest request) => Results.Ok(store.SetMerchantAliases(id, request)));
api.MapDelete("/merchants/{id:long}", (long id) =>
{
    store.DeleteMerchant(id);
    return Results.NoContent();
});

api.MapPost("/collections", (NameRequest request) => Results.Ok(store.CreateLabel(Store.Collections, request)));
api.MapPatch("/collections/{id:long}", (long id, UpdateNameRequest request) => Results.Ok(store.UpdateLabel(Store.Collections, id, request)));
api.MapDelete("/collections/{id:long}", (long id) =>
{
    store.DeleteLabel(Store.Collections, id);
    return Results.NoContent();
});

// File > iPhone Shortcut...: the key is shown only in the reply that creates it.
api.MapGet("/shortcut", () => Results.Ok(new { keyCreatedAt = ShortcutKey.CreatedAt(shortcutKeyPath) }));
api.MapPost("/shortcut/key", () =>
{
    var key = ShortcutKey.Create(shortcutKeyPath);
    app.Logger.LogInformation("Created a new iPhone Shortcut key; any earlier key stopped working.");
    return Results.Ok(new { key, keyCreatedAt = ShortcutKey.CreatedAt(shortcutKeyPath) });
});
api.MapDelete("/shortcut/key", () =>
{
    ShortcutKey.Delete(shortcutKeyPath);
    app.Logger.LogInformation("Turned off the iPhone Shortcut by deleting its key.");
    return Results.NoContent();
});

api.MapGet("/backup", async (HttpContext context) =>
{
    var workDirectory = Directory.CreateTempSubdirectory("spend-tracker-download-");
    try
    {
        var path = Path.Combine(workDirectory.FullName, "backup.zip");
        Transfer.CreateArchive(store, path, appVersion);
        context.Response.Headers.CacheControl = "no-store";
        await Results.File(path, "application/zip", $"spendtracker-backup-{DateTimeOffset.Now:yyyyMMdd-HHmmss}.zip").ExecuteAsync(context);
    }
    finally
    {
        workDirectory.Delete(recursive: true);
    }
});

api.MapPost("/restore", async (HttpRequest request) =>
{
    if (!string.Equals(request.ContentType, "application/zip", StringComparison.OrdinalIgnoreCase))
        throw RequestException.Invalid("Send the backup ZIP as the request body with Content-Type: application/zip.");
    var workDirectory = Directory.CreateTempSubdirectory("spend-tracker-upload-");
    try
    {
        var uploadPath = Path.Combine(workDirectory.FullName, "upload.zip");
        await Transfer.SaveUpload(request.Body, uploadPath, request.HttpContext.RequestAborted);
        var result = Transfer.RestoreArchive(store, uploadPath, Path.Combine(dataDir, "backups"), appVersion);
        Onboarding.Acknowledge(dataDir);
        app.Logger.LogInformation("Restored a backup with {Transactions} transactions. Previous data saved to data/backups/{RecoveryFile}.", result.Transactions, result.RecoveryFile);
        return Results.Ok(result);
    }
    finally
    {
        workDirectory.Delete(recursive: true);
    }
}).WithMetadata(new RequestSizeLimitAttribute(Transfer.MaxUploadBytes));

// Fresh start: clear only what the user selects, then compact so the space goes back to the disk.
api.MapGet("/fresh-start", () =>
{
    var summary = store.ReadFreshStartSummary();
    var backups = RecoveryBackups(dataDir);
    return Results.Ok(new
    {
        summary.ArchivedEntries, summary.AllArchivedEntries, summary.Entries, summary.UnusedLabels, summary.AllLabels, summary.HistoryEntries,
        RecoveryBackups = backups.Length, RecoveryBackupBytes = backups.Sum(file => file.Length), DatabaseBytes = store.DatabaseBytes()
    });
});

api.MapPost("/fresh-start", (FreshStartRequest request) =>
{
    if (request.Confirmation != "RESET SELECTED") throw RequestException.Invalid("Type RESET SELECTED to confirm.");
    var selections = request.Selections;
    string[] options = [.. Store.FreshStartOptions, "recoveryBackups"];
    if (selections is null || selections.Keys.Any(key => !options.Contains(key)) || !selections.Values.Any(selected => selected))
        throw RequestException.Invalid("Choose at least one valid Fresh start option.");

    var bytesBefore = store.DatabaseBytes() + RecoveryBackups(dataDir).Sum(file => file.Length);
    var result = store.FreshStart(selections);
    var removedBackups = 0;
    string? warning = null;
    if (selections.TryGetValue("recoveryBackups", out var clearBackups) && clearBackups)
    {
        foreach (var file in RecoveryBackups(dataDir))
        {
            try { file.Delete(); removedBackups++; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                warning = "Some recovery backups could not be deleted. Check data/backups on the server.";
            }
        }
    }
    var compacted = true;
    try { store.Compact(); }
    catch (SqliteException error)
    {
        app.Logger.LogWarning(error, "Fresh start finished, but database compaction failed.");
        compacted = false;
        warning ??= "Selected data was cleared, but the database could not be compacted. Freed space can still be reused; check available disk space.";
    }
    var freedBytes = Math.Max(0, bytesBefore - store.DatabaseBytes() - RecoveryBackups(dataDir).Sum(file => file.Length));
    app.Logger.LogInformation("Fresh start removed {Entries} entries, {Labels} labels, {History} history entries, and {Backups} recovery backups; freed {Bytes} bytes.",
        result.RemovedEntries, result.RemovedLabels, result.RemovedHistory, removedBackups, freedBytes);
    return Results.Ok(new
    {
        result.RemovedEntries, result.KeptArchivedEntries, result.RemovedLabels, result.RemovedHistory,
        RemovedBackups = removedBackups, FreedBytes = freedBytes, Compacted = compacted, Warning = warning
    });
});

// An unknown API address answers 404 like NewsReview, instead of the page or 405.
app.MapFallback("/api/{**path}", () => Results.Json(new { error = "Not found" }, statusCode: StatusCodes.Status404NotFound)).RequireAuthorization();
app.MapFallbackToFile("index.html").RequireAuthorization();
app.Run();

static FileInfo[] RecoveryBackups(string dataDir)
{
    var directory = new DirectoryInfo(Path.Combine(dataDir, "backups"));
    return directory.Exists ? directory.GetFiles("before-restore-*.zip") : [];
}

// Signing in from the home page goes to plain /login.html, like NewsReview; only a deep link keeps a ReturnUrl.
static string LoginRedirect(RedirectContext<CookieAuthenticationOptions> context) =>
    (context.Request.Path.Value is null or "/" or "/index.html") && !context.Request.QueryString.HasValue ? "/login.html" : context.RedirectUri;

record LoginRequest(string? Password);
record FreshStartRequest(string? Confirmation, Dictionary<string, bool>? Selections);
record SetupRequest(string? SetupToken, string? Password, string? ConfirmPassword);
