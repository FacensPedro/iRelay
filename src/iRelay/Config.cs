using System.Security.Cryptography;
using System.Text.Json;

namespace IRelay;

/// Settings kept in %LOCALAPPDATA%\iRelay\config.json.
public sealed class Config
{
    public string Code { get; set; } = NewCode();
    public int Port { get; set; } = 27090;
    public string CacheDir { get; set; } = Path.Combine(DataDir, "cache");
    /// A chunk is deleted once iDeck has received it, so the PC keeps only
    /// what the device has not taken yet.
    public bool DeleteAfterSend { get; set; } = true;
    public int Parallel { get; set; } = 24;

    public static string DataDir { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "iRelay");

    static string FilePath => Path.Combine(DataDir, "config.json");

    public static string NewCode() => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");

    public static Config Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var config = JsonSerializer.Deserialize<Config>(File.ReadAllText(FilePath));
                if (config != null && config.Code.Length > 0) return config;
            }
        }
        catch
        {
            // A damaged file is replaced by defaults.
        }
        var fresh = new Config();
        fresh.Save();
        return fresh;
    }

    public void Save()
    {
        Directory.CreateDirectory(DataDir);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}
