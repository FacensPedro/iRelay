using System.Diagnostics;
using System.Text;

namespace IRelay;

/// "Ignorar Windows Defender": with the user's consent (Windows asks for
/// administrator rights), adds iRelay's program and cache folders to Microsoft
/// Defender Antivirus' exclusions, so chunks are not scanned as they are
/// written, and allows iRelay through Windows Defender Firewall on the local
/// network, so iDeck can connect. "Desfazer" removes both.
public static class Defender
{
    const string RuleName = "iRelay (iDeck)";

    static string Quote(string text) => "'" + text.Replace("'", "''") + "'";

    public static Task<(bool ok, string message)> Ignore(Config config) => Run(Script(config, add: true));

    public static Task<(bool ok, string message)> Undo(Config config) => Run(Script(config, add: false));

    static string Script(Config config, bool add)
    {
        var exe = Environment.ProcessPath ?? Application.ExecutablePath;
        var folder = Path.GetDirectoryName(exe) ?? AppContext.BaseDirectory;
        var paths = string.Join(",", new[] { folder, Config.DataDir, config.CacheDir }.Distinct().Select(Quote));
        var script = new StringBuilder("$ErrorActionPreference = 'Continue'\n");
        script.AppendLine($"Remove-NetFirewallRule -DisplayName {Quote(RuleName)} -ErrorAction SilentlyContinue");
        if (add)
        {
            script.AppendLine($"Add-MpPreference -ExclusionPath {paths}");
            script.AppendLine($"Add-MpPreference -ExclusionProcess {Quote(exe)}");
            script.AppendLine($"New-NetFirewallRule -DisplayName {Quote(RuleName)} -Direction Inbound -Program {Quote(exe)} " +
                              $"-Protocol TCP -LocalPort {config.Port} -RemoteAddress LocalSubnet -Profile Any -Action Allow | Out-Null");
        }
        else
        {
            script.AppendLine($"Remove-MpPreference -ExclusionPath {paths}");
            script.AppendLine($"Remove-MpPreference -ExclusionProcess {Quote(exe)}");
        }
        script.AppendLine("if ($Error.Count) { exit 1 } else { exit 0 }");
        return script.ToString();
    }

    static async Task<(bool, string)> Run(string script)
    {
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var start = new ProcessStartInfo("powershell.exe", $"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {encoded}")
        {
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        try
        {
            using var process = Process.Start(start);
            if (process == null) return (false, "O PowerShell não abriu.");
            await process.WaitForExitAsync();
            return process.ExitCode == 0
                ? (true, "Pronto.")
                : (false, "O Windows recusou parte da alteração (o Defender pode estar gerenciado por outro antivírus ou pela empresa).");
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return (false, "Permissão de administrador negada.");
        }
    }
}
