using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace IRelay;

/// What iDeck sends with POST /jobs: per depot, the chunks it still needs in
/// the order it will ask for them, and the content servers it uses with their
/// authorization fragments ("?token=..." or "").
public sealed class JobRequest
{
    public uint AppId { get; set; }
    public string Name { get; set; } = "";
    public List<JobDepot> Depots { get; set; } = new();
}

public sealed class JobDepot
{
    public uint DepotId { get; set; }
    public List<string> Hosts { get; set; } = new();
    public Dictionary<string, string> Auth { get; set; } = new();
    public List<string> Chunks { get; set; } = new();
}

public sealed class Job
{
    public required uint AppId { get; init; }
    public required string Name { get; init; }
    public required int Total { get; init; }
    public DateTime Started { get; } = DateTime.Now;
    public int Downloaded;
    public int Sent;
    public int Failed;
    public long Bytes;
    public CancellationTokenSource Cancel { get; } = new();
    public bool Finished => Downloaded + Failed >= Total;
}

/// Downloads chunks from Steam's content servers into the cache, ahead of the
/// device, and hands each one over as soon as it is there. The bytes are kept
/// exactly as the content server sent them (encrypted, compressed): iDeck
/// checks and decrypts them itself, so no Steam account is needed here.
public sealed class RelayEngine
{
    static readonly Regex Sha = new("^[0-9a-f]{40}$", RegexOptions.Compiled);

    readonly Config config;
    readonly HttpClient http;
    readonly SemaphoreSlim slots;
    readonly ConcurrentDictionary<string, Lazy<Task<string?>>> inflight = new();
    readonly ConcurrentDictionary<uint, JobDepot> servers = new();
    readonly ConcurrentDictionary<string, Job> chunkJob = new();
    // Chunks already counted as on the PC, and chunks iDeck already has (not
    // downloaded again once their file is deleted).
    readonly ConcurrentDictionary<string, byte> counted = new();
    readonly ConcurrentDictionary<string, byte> delivered = new();
    readonly object jobsLock = new();
    readonly List<Job> jobs = new();
    long totalBytes;
    readonly Stopwatch clock = Stopwatch.StartNew();

    public event Action<string>? Log;

    public RelayEngine(Config config)
    {
        this.config = config;
        slots = new SemaphoreSlim(Math.Clamp(config.Parallel, 1, 64));
        var handler = new SocketsHttpHandler
        {
            MaxConnectionsPerServer = 32,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            AutomaticDecompression = System.Net.DecompressionMethods.None,
        };
        http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(60) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("Valve/Steam HTTP Client 1.0");
        Directory.CreateDirectory(config.CacheDir);
    }

    public long TotalBytes => Interlocked.Read(ref totalBytes);
    public TimeSpan Uptime => clock.Elapsed;

    public IReadOnlyList<Job> Jobs
    {
        get { lock (jobsLock) return jobs.ToList(); }
    }

    public static bool ValidSha(string sha) => Sha.IsMatch(sha);

    string PathFor(uint depot, string sha) => Path.Combine(config.CacheDir, depot.ToString(), sha);

    /// Starts downloading a job's chunks in the order iDeck will ask for them.
    /// A newer job for the same app replaces the older one.
    public Job Start(JobRequest request)
    {
        int total = request.Depots.Sum(d => d.Chunks.Count);
        var job = new Job { AppId = request.AppId, Name = request.Name.Length > 0 ? request.Name : $"App {request.AppId}", Total = total };
        lock (jobsLock)
        {
            foreach (var old in jobs.Where(j => j.AppId == request.AppId && !j.Finished)) old.Cancel.Cancel();
            jobs.RemoveAll(j => j.AppId == request.AppId);
            jobs.Insert(0, job);
            if (jobs.Count > 20) jobs.RemoveRange(20, jobs.Count - 20);
        }
        foreach (var depot in request.Depots)
        {
            servers[depot.DepotId] = depot;
            foreach (var sha in depot.Chunks)
            {
                var key = Key(depot.DepotId, sha.ToLowerInvariant());
                chunkJob[key] = job;
                counted.TryRemove(key, out _);
                delivered.TryRemove(key, out _);
            }
        }
        Log?.Invoke($"Download iniciado: {job.Name} ({total} pedaços)");
        _ = Task.Run(() => RunJob(job, request));
        return job;
    }

    async Task RunJob(Job job, JobRequest request)
    {
        var tasks = new List<Task>();
        foreach (var depot in request.Depots)
        {
            foreach (var raw in depot.Chunks)
            {
                var sha = raw.ToLowerInvariant();
                if (!ValidSha(sha)) { Interlocked.Increment(ref job.Failed); continue; }
                var key = Key(depot.DepotId, sha);
                if (delivered.ContainsKey(key)) continue;
                if (File.Exists(PathFor(depot.DepotId, sha))) { Counted(key, job, 0); continue; }
                try { await slots.WaitAsync(job.Cancel.Token); }
                catch (OperationCanceledException) { return; }
                tasks.Add(Task.Run(async () =>
                {
                    try { await Ensure(depot.DepotId, sha, job); }
                    finally { slots.Release(); }
                }));
            }
        }
        await Task.WhenAll(tasks);
        Log?.Invoke($"Download concluído no PC: {job.Name} ({job.Downloaded}/{job.Total}, {job.Failed} falhas)");
    }

    static string Key(uint depot, string sha) => depot + "/" + sha;

    void Counted(string key, Job? job, long bytes)
    {
        if (job == null || !counted.TryAdd(key, 0)) return;
        Interlocked.Increment(ref job.Downloaded);
        Interlocked.Add(ref job.Bytes, bytes);
    }

    /// The chunk's file in the cache, downloading it now if it is not there
    /// (once: concurrent callers wait for the same download).
    public Task<string?> Ensure(uint depot, string sha, Job? job = null)
    {
        var path = PathFor(depot, sha);
        if (File.Exists(path)) return Task.FromResult<string?>(path);
        var key = Key(depot, sha);
        var lazy = inflight.GetOrAdd(key, _ => new Lazy<Task<string?>>(() => Download(depot, sha, path, job ?? JobFor(key))));
        return lazy.Value;
    }

    Job? JobFor(string key) => chunkJob.TryGetValue(key, out var job) ? job : null;

    async Task<string?> Download(uint depot, string sha, string path, Job? job)
    {
        try
        {
            if (!servers.TryGetValue(depot, out var info) || info.Hosts.Count == 0) return null;
            for (int attempt = 0; attempt < Math.Max(3, info.Hosts.Count); attempt++)
            {
                var original = info.Hosts[(int)((uint)sha.GetHashCode() % (uint)info.Hosts.Count + (uint)attempt) % info.Hosts.Count];
                var host = original.TrimEnd('/');
                if (!info.Auth.TryGetValue(original, out var auth)) info.Auth.TryGetValue(host, out auth);
                var url = $"{host}/depot/{depot}/chunk/{sha}{auth ?? ""}";
                try
                {
                    using var response = await http.GetAsync(url, HttpCompletionOption.ResponseContentRead);
                    if (!response.IsSuccessStatusCode) throw new HttpRequestException($"HTTP {(int)response.StatusCode}");
                    var data = await response.Content.ReadAsByteArrayAsync();
                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    var temp = path + ".part";
                    await File.WriteAllBytesAsync(temp, data);
                    File.Move(temp, path, true);
                    Interlocked.Add(ref totalBytes, data.Length);
                    Counted(Key(depot, sha), job, data.Length);
                    return path;
                }
                catch (Exception error) when (attempt + 1 < Math.Max(3, info.Hosts.Count))
                {
                    Debug.WriteLine($"chunk {sha} attempt {attempt + 1}: {error.Message}");
                    await Task.Delay(300 * (attempt + 1));
                }
            }
        }
        catch (Exception error)
        {
            Log?.Invoke($"Falha no pedaço {sha[..8]}: {error.Message}");
        }
        finally
        {
            inflight.TryRemove(Key(depot, sha), out _);
        }
        if (job != null && !counted.ContainsKey(Key(depot, sha))) Interlocked.Increment(ref job.Failed);
        return null;
    }

    /// Called once iDeck has the chunk.
    public void Delivered(uint depot, string sha, string path)
    {
        var key = Key(depot, sha);
        delivered.TryAdd(key, 0);
        if (chunkJob.TryRemove(key, out var job))
        {
            Counted(key, job, 0);
            Interlocked.Increment(ref job.Sent);
        }
        if (config.DeleteAfterSend)
        {
            try { File.Delete(path); } catch { /* in use: removed with the cache */ }
        }
    }

    public void CancelAll()
    {
        lock (jobsLock) foreach (var job in jobs) job.Cancel.Cancel();
    }

    public long CacheSize()
    {
        try
        {
            return new DirectoryInfo(config.CacheDir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
        }
        catch { return 0; }
    }

    public void ClearCache()
    {
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(config.CacheDir)) Directory.Delete(dir, true);
        }
        catch (Exception error) { Log?.Invoke("Não foi possível limpar o cache: " + error.Message); }
    }
}
