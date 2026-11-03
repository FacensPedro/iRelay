using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace IRelay;

/// The HTTP server iDeck connects to directly (see iDeck's IRelayClient).
public sealed class RelayServer
{
    readonly Config config;
    readonly RelayEngine engine;
    WebApplication? app;

    public event Action<string>? Log;

    public RelayServer(Config config, RelayEngine engine)
    {
        this.config = config;
        this.engine = engine;
    }

    public async Task StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.ListenAnyIP(config.Port);
            options.Limits.MaxRequestBodySize = 256L * 1024 * 1024;
        });
        app = builder.Build();

        app.Use(async (context, next) =>
        {
            var given = context.Request.Headers["X-iRelay-Code"].ToString();
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(given), Encoding.UTF8.GetBytes(config.Code)))
            {
                context.Response.StatusCode = 401;
                return;
            }
            await next();
        });

        app.MapGet("/ping", () => Results.Json(new { name = "iRelay", version = 1, machine = Environment.MachineName }));

        app.MapPost("/jobs", async (HttpContext context) =>
        {
            var request = await context.Request.ReadFromJsonAsync<JobRequest>();
            if (request == null || request.Depots.Count == 0) return Results.BadRequest();
            var job = engine.Start(request);
            var remote = context.Connection.RemoteIpAddress?.ToString() ?? "?";
            Log?.Invoke($"iDeck ({remote}) pediu {job.Name}");
            return Results.Json(new { total = job.Total });
        });

        app.MapGet("/depot/{depot}/chunk/{sha}", async (uint depot, string sha, HttpContext context) =>
        {
            sha = sha.ToLowerInvariant();
            if (!RelayEngine.ValidSha(sha)) return Results.BadRequest();
            var path = await engine.Ensure(depot, sha);
            if (path == null || !File.Exists(path)) return Results.NotFound();
            byte[] data;
            try { data = await File.ReadAllBytesAsync(path); }
            catch (IOException) { return Results.NotFound(); }
            context.Response.ContentType = "application/octet-stream";
            context.Response.ContentLength = data.Length;
            await context.Response.Body.WriteAsync(data);
            engine.Delivered(depot, sha, path);
            return Results.Empty;
        });

        await app.StartAsync();
        Log?.Invoke($"Aguardando o iDeck na porta {config.Port}");
    }

    public async Task StopAsync()
    {
        if (app != null) await app.StopAsync();
    }

    /// This PC's IPv4 addresses on its active network adapters, for the window.
    public static List<string> LocalAddresses()
    {
        var list = new List<string>();
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                var properties = nic.GetIPProperties();
                if (properties.GatewayAddresses.Count == 0) continue;
                foreach (var address in properties.UnicastAddresses)
                {
                    if (address.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(address.Address))
                        list.Add(address.Address.ToString());
                }
            }
        }
        catch { }
        return list.Distinct().ToList();
    }
}
