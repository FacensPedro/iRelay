using System.Buffers.Binary;
using System.Net.Sockets;
using System.Security;
using System.Text;
using System.Xml.Linq;

namespace IRelay;

/// iDeck over a USB cable. Apple's device service on Windows (installed with
/// the Apple Devices app or iTunes) runs usbmux on 127.0.0.1:27015: it lists
/// the cabled, trusted iPhones and iPads and opens TCP connections to a port on
/// one of them. iRelay keeps a few connections open to iDeck's port 27091;
/// iDeck hands each to one of its own requests, and iRelay joins the other end
/// to its HTTP server, so iDeck talks to iRelay over the cable exactly as over
/// the network.
public sealed class UsbTunnel
{
    const int MuxPort = 27015;
    const int DevicePort = 27091;
    const int Idle = 6;

    readonly Config config;
    readonly CancellationTokenSource stop = new();
    readonly Dictionary<int, int> idle = new();
    readonly HashSet<int> active = new();
    readonly object gate = new();
    int busy;

    public event Action<string>? Log;
    public string Status { get; private set; } = "Cabo USB: procurando o iPad...";

    public UsbTunnel(Config config) => this.config = config;

    public void Start() => _ = Task.Run(Run);

    public void Stop() => stop.Cancel();

    async Task Run()
    {
        string? lastStatus = null;
        var refusedUntil = new Dictionary<int, DateTime>();
        while (!stop.IsCancellationRequested)
        {
            try
            {
                var devices = await ListDevices();
                if (devices.Count == 0)
                {
                    Status = "Cabo USB: nenhum iPad conectado (conecte o cabo e toque em Confiar no iPad).";
                }
                else
                {
                    int ready;
                    lock (gate) ready = devices.Sum(d => idle.GetValueOrDefault(d));
                    Status = ready > 0 || busy > 0
                        ? $"Cabo USB: iDeck conectado ({devices.Count} aparelho{(devices.Count > 1 ? "s" : "")})."
                        : "Cabo USB: iPad conectado; abra o iDeck e ative o iRelay (Ajustes › Steam).";
                }
                foreach (var device in devices)
                {
                    if (refusedUntil.TryGetValue(device, out var until) && DateTime.Now < until) continue;
                    while (true)
                    {
                        lock (gate) { if (idle.GetValueOrDefault(device) >= Idle) break; }
                        var stream = await Connect(device);
                        if (stream == null)
                        {
                            refusedUntil[device] = DateTime.Now.AddSeconds(2);
                            break;
                        }
                        lock (gate) idle[device] = idle.GetValueOrDefault(device) + 1;
                        _ = Task.Run(() => Serve(device, stream));
                    }
                }
                lock (gate)
                {
                    foreach (var gone in idle.Keys.Where(d => !devices.Contains(d)).ToList()) idle.Remove(gone);
                }
            }
            catch (SocketException)
            {
                Status = "Cabo USB: instale o app Apple Devices (ou o iTunes) para usar o cabo.";
            }
            catch (Exception error)
            {
                Status = "Cabo USB: " + error.Message;
            }
            if (Status != lastStatus) { Log?.Invoke(Status); lastStatus = Status; }
            try { await Task.Delay(1000, stop.Token); } catch (OperationCanceledException) { }
        }
    }

    /// Waits for iDeck to use this cable connection, then joins it to the HTTP server.
    async Task Serve(int device, NetworkStream deviceStream)
    {
        var client = deviceStream.Socket;
        try
        {
            var first = new byte[64 * 1024];
            int read = await deviceStream.ReadAsync(first, stop.Token);
            lock (gate) idle[device] = Math.Max(0, idle.GetValueOrDefault(device) - 1);
            if (read <= 0) return;
            Interlocked.Increment(ref busy);
            try
            {
                using var local = new TcpClient { NoDelay = true };
                await local.ConnectAsync("127.0.0.1", config.Port, stop.Token);
                var localStream = local.GetStream();
                await localStream.WriteAsync(first.AsMemory(0, read), stop.Token);
                var up = deviceStream.CopyToAsync(localStream, 256 * 1024, stop.Token);
                var down = localStream.CopyToAsync(deviceStream, 256 * 1024, stop.Token);
                await Task.WhenAny(up, down);
            }
            finally
            {
                Interlocked.Decrement(ref busy);
            }
        }
        catch
        {
            lock (gate) idle[device] = Math.Max(0, idle.GetValueOrDefault(device) - (deviceStream.CanRead ? 0 : 0));
        }
        finally
        {
            client.Dispose();
            deviceStream.Dispose();
        }
    }

    // MARK: usbmux

    static async Task<NetworkStream> Open()
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        await socket.ConnectAsync("127.0.0.1", MuxPort);
        return new NetworkStream(socket, ownsSocket: true);
    }

    static string Plist(params (string key, object value)[] entries)
    {
        var body = new StringBuilder();
        body.Append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>");
        foreach (var (key, value) in entries)
        {
            body.Append("<key>").Append(SecurityElement.Escape(key)).Append("</key>");
            body.Append(value is int number ? $"<integer>{number}</integer>" : $"<string>{SecurityElement.Escape(value.ToString())}</string>");
        }
        body.Append("</dict></plist>");
        return body.ToString();
    }

    static async Task Send(NetworkStream stream, string plist, int tag)
    {
        var payload = Encoding.UTF8.GetBytes(plist);
        var header = new byte[16];
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(0), 16 + payload.Length);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(4), 1);  // version: plist
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(8), 8);  // message: plist
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(12), tag);
        await stream.WriteAsync(header);
        await stream.WriteAsync(payload);
    }

    static async Task<XElement> Receive(NetworkStream stream)
    {
        var header = new byte[16];
        await stream.ReadExactlyAsync(header);
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length < 16 || length > 16 * 1024 * 1024) throw new IOException("Resposta inválida do serviço da Apple.");
        var payload = new byte[length - 16];
        await stream.ReadExactlyAsync(payload);
        var document = XDocument.Parse(Encoding.UTF8.GetString(payload), LoadOptions.None);
        return document.Root!.Element("dict")!;
    }

    /// A plist dict as key → value element.
    static Dictionary<string, XElement> Dict(XElement dict)
    {
        var result = new Dictionary<string, XElement>();
        var children = dict.Elements().ToList();
        for (int i = 0; i + 1 < children.Count; i += 2)
            if (children[i].Name == "key") result[children[i].Value] = children[i + 1];
        return result;
    }

    static (string, object)[] Client(params (string, object)[] entries) =>
        entries.Concat(new (string, object)[] { ("ClientVersionString", "iRelay 1.0"), ("ProgName", "iRelay") }).ToArray();

    /// The cabled devices' usbmux IDs.
    static async Task<List<int>> ListDevices()
    {
        await using var stream = await Open();
        await Send(stream, Plist(Client(("MessageType", "ListDevices"))), 1);
        var reply = Dict(await Receive(stream));
        var list = new List<int>();
        if (!reply.TryGetValue("DeviceList", out var array)) return list;
        foreach (var entry in array.Elements("dict"))
        {
            var fields = Dict(entry);
            if (!fields.TryGetValue("Properties", out var propertiesElement)) continue;
            var properties = Dict(propertiesElement);
            if (properties.TryGetValue("ConnectionType", out var type) && type.Value != "USB") continue;
            if (properties.TryGetValue("DeviceID", out var id) && int.TryParse(id.Value, out var number)) list.Add(number);
        }
        return list;
    }

    /// A TCP connection to iDeck's port on the device, or null when refused.
    static async Task<NetworkStream?> Connect(int device)
    {
        var stream = await Open();
        try
        {
            // usbmux takes the port in network byte order.
            int port = ((DevicePort & 0xff) << 8) | ((DevicePort >> 8) & 0xff);
            await Send(stream, Plist(Client(("MessageType", "Connect"), ("DeviceID", device), ("PortNumber", port))), 2);
            var reply = Dict(await Receive(stream));
            if (reply.TryGetValue("Number", out var number) && number.Value == "0") return stream;
        }
        catch
        {
        }
        await stream.DisposeAsync();
        return null;
    }
}
