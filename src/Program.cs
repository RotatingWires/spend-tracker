using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Data.Sqlite;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);
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
                context.Response.Redirect(context.RedirectUri);
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
});

var app = builder.Build();
var appVersion = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

var dataDir = Path.Combine(app.Environment.ContentRootPath, "data");
Directory.CreateDirectory(dataDir);
var authPath = Path.Combine(dataDir, "auth.json");
const int PasswordIterations = 600_000;

var store = new Store(Path.Combine(dataDir, "spend-tracker.db"));
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
app.Logger.LogInformation("SpendTracker v{Version} database ready: journal_mode={JournalMode}, synchronous=NORMAL, busy_timeout=5000 ms.", appVersion, journalMode);

string? setupToken = PasswordConfigured(authPath) ? null : GenerateSetupToken();
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
    configured = PasswordConfigured(authPath),
    authenticated = context.User.Identity?.IsAuthenticated == true
}));

app.MapPost("/api/auth/setup", async (SetupRequest request, HttpContext context) =>
{
    if (PasswordConfigured(authPath))
        return Results.Conflict(new { error = "A password has already been configured." });

    if (setupToken is null)
        return Results.Conflict(new { error = "No setup token is active. Restart SpendTracker to generate a new one." });

    if (!SetupTokenMatches(setupToken, request.SetupToken))
        return Results.Json(new { error = "Invalid setup token." }, statusCode: StatusCodes.Status401Unauthorized);

    var passwordError = ValidateNewPassword(request.Password, request.ConfirmPassword);
    if (passwordError is not null)
        return Results.BadRequest(new { error = passwordError });

    SavePassword(authPath, request.Password!);
    setupToken = null;
    await SignInOwner(context);
    return Results.Ok(new { authenticated = true });
}).RequireRateLimiting("auth");

app.MapPost("/api/auth/login", async (LoginRequest request, HttpContext context) =>
{
    if (!PasswordConfigured(authPath))
        return Results.Conflict(new { error = "No password has been configured yet." });
    if (string.IsNullOrEmpty(request.Password) || !VerifyPassword(authPath, request.Password, out var needsRehash))
        return Results.Unauthorized();

    if (needsRehash)
    {
        SavePassword(authPath, request.Password);
        app.Logger.LogInformation("Upgraded the saved password hash to {Iterations} PBKDF2 iterations.", PasswordIterations);
    }

    await SignInOwner(context);
    return Results.Ok(new { authenticated = true });
}).RequireRateLimiting("auth");

app.MapPost("/api/auth/logout", async (HttpContext context) =>
{
    await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.NoContent();
}).RequireAuthorization();

var api = app.MapGroup("/api").RequireAuthorization();

api.MapGet("/snapshot", () => Results.Ok(store.ReadSnapshot(appVersion)));
api.MapGet("/history", (long? beforeId, int? limit) => Results.Ok(store.ReadHistory(beforeId, limit ?? 200)));

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
api.MapDelete("/merchants/{id:long}", (long id) =>
{
    store.DeleteMerchant(id);
    return Results.NoContent();
});

api.MapPost("/events", (NameRequest request) => Results.Ok(store.CreateLabel(Store.Events, request)));
api.MapPatch("/events/{id:long}", (long id, UpdateNameRequest request) => Results.Ok(store.UpdateLabel(Store.Events, id, request)));
api.MapDelete("/events/{id:long}", (long id) =>
{
    store.DeleteLabel(Store.Events, id);
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
        await Results.File(path, "application/zip", $"spend-tracker-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.zip").ExecuteAsync(context);
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
        app.Logger.LogInformation("Restored a backup with {Transactions} transactions. Previous data saved to data/backups/{RecoveryFile}.", result.Transactions, result.RecoveryFile);
        return Results.Ok(result);
    }
    finally
    {
        workDirectory.Delete(recursive: true);
    }
}).WithMetadata(new RequestSizeLimitAttribute(Transfer.MaxUploadBytes));

app.MapFallbackToFile("index.html").RequireAuthorization();
app.Run();

static string GenerateSetupToken()
{
    var raw = Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
    return $"{raw[..4]}-{raw[4..8]}-{raw[8..12]}-{raw[12..16]}";
}

static bool SetupTokenMatches(string expected, string? supplied)
{
    if (string.IsNullOrWhiteSpace(supplied)) return false;
    var expectedValue = expected.Replace("-", string.Empty, StringComparison.Ordinal);
    var suppliedValue = Regex.Replace(supplied, @"[\s-]", string.Empty);
    return string.Equals(expectedValue, suppliedValue, StringComparison.OrdinalIgnoreCase);
}

static bool PasswordConfigured(string authPath) => File.Exists(authPath);

static string? ValidateNewPassword(string? password, string? confirmation)
{
    if (string.IsNullOrEmpty(password) || password.Length < 8)
        return "Password must be at least 8 characters long.";
    if (password != confirmation)
        return "Passwords do not match.";
    return null;
}

static void SavePassword(string authPath, string password)
{
    var salt = RandomNumberGenerator.GetBytes(16);
    var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, PasswordIterations, HashAlgorithmName.SHA256, 32);
    var auth = new PasswordFile(1, PasswordIterations, Convert.ToBase64String(salt), Convert.ToBase64String(hash));
    // Write beside the target and rename, so an interrupted rehash cannot leave a truncated auth.json.
    var temporaryPath = authPath + ".tmp";
    File.WriteAllText(temporaryPath, JsonSerializer.Serialize(auth));
    File.Move(temporaryPath, authPath, overwrite: true);
}

static bool VerifyPassword(string authPath, string password, out bool needsRehash)
{
    needsRehash = false;
    try
    {
        var auth = JsonSerializer.Deserialize<PasswordFile>(File.ReadAllText(authPath));
        if (auth is null || auth.Version != 1 || auth.Iterations < 1) return false;
        var salt = Convert.FromBase64String(auth.Salt);
        var expected = Convert.FromBase64String(auth.Hash);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, auth.Iterations, HashAlgorithmName.SHA256, expected.Length);
        if (!CryptographicOperations.FixedTimeEquals(actual, expected)) return false;
        needsRehash = auth.Iterations < PasswordIterations;
        return true;
    }
    catch
    {
        return false;
    }
}

static async Task SignInOwner(HttpContext context)
{
    var identity = new ClaimsIdentity(
        [new Claim(ClaimTypes.NameIdentifier, "owner"), new Claim(ClaimTypes.Name, "Owner")],
        CookieAuthenticationDefaults.AuthenticationScheme);
    var principal = new ClaimsPrincipal(identity);
    await context.SignInAsync(
        CookieAuthenticationDefaults.AuthenticationScheme,
        principal,
        new AuthenticationProperties
        {
            IsPersistent = true,
            AllowRefresh = true,
            ExpiresUtc = DateTimeOffset.UtcNow.AddDays(30)
        });
}

record LoginRequest(string? Password);
record SetupRequest(string? SetupToken, string? Password, string? ConfirmPassword);
record PasswordFile(int Version, int Iterations, string Salt, string Hash);
