using NativeDeviceService.Endpoints;
using NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Native Device Service – Entry Point
//
// This ASP.NET Core minimal-API application runs as a background CLI process.
// Electron spawns it on startup and communicates through the local HTTP API.
//
// Default URL: http://localhost:8765
// Override with: NativeDeviceService --urls "http://localhost:9000"
// ---------------------------------------------------------------------------

var builder = WebApplication.CreateBuilder(args);

// ── Logging ─────────────────────────────────────────────────────────────────
// Write structured logs to stdout so Electron can capture them via stdio.
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(opts =>
{
    opts.TimestampFormat = "[HH:mm:ss] ";
});
builder.Logging.SetMinimumLevel(LogLevel.Information);

// ── Kestrel – bind to localhost only ────────────────────────────────────────
// Never expose to the network; this service is local-only.
builder.WebHost.UseUrls("http://localhost:8765");

// ── Dependency Injection ─────────────────────────────────────────────────────
builder.Services.AddSingleton<IBluetoothService, BluetoothService>();
builder.Services.AddSingleton<IAudioService,     AudioService>();
builder.Services.AddSingleton<ITelephonyService, TelephonyService>();
builder.Services.AddSingleton<IDeviceService,    DeviceService>();

// ── JSON serialisation – camelCase to match TypeScript conventions ───────────
builder.Services.ConfigureHttpJsonOptions(opts =>
{
    opts.SerializerOptions.PropertyNamingPolicy =
        System.Text.Json.JsonNamingPolicy.CamelCase;
    opts.SerializerOptions.WriteIndented = false;
});

// ── CORS – allow Electron renderer (file://) and localhost pages ─────────────
builder.Services.AddCors(opts =>
{
    opts.AddDefaultPolicy(policy =>
        policy.SetIsOriginAllowed(_ => true)   // safe – bound to localhost only
              .AllowAnyHeader()
              .AllowAnyMethod());
});

// ─────────────────────────────────────────────────────────────────────────────
var app = builder.Build();

app.UseCors();

// ── Graceful shutdown signal ─────────────────────────────────────────────────
// Print a structured line so Electron's process-monitor can detect readiness.
var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
lifetime.ApplicationStarted.Register(() =>
{
    // This line is parsed by Electron's DeviceServiceClient to confirm readiness.
    Console.WriteLine("[NativeDeviceService] READY port=8765");
});
lifetime.ApplicationStopping.Register(() =>
    Console.WriteLine("[NativeDeviceService] STOPPING"));

// ── Register API routes ──────────────────────────────────────────────────────
app.MapDeviceEndpoints();

// ── Start ────────────────────────────────────────────────────────────────────
await app.RunAsync();
