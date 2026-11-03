using System.Diagnostics;
using System.Runtime.InteropServices;

namespace IRelay;

/// iRelay's window: black, with the address and pairing code to type into
/// iDeck (Settings › Steam › iRelay), the downloads and their progress.
public sealed class MainForm : Form
{
    static readonly Color Back = Color.Black;
    static readonly Color Panel = Color.FromArgb(18, 18, 18);
    static readonly Color Line = Color.FromArgb(55, 55, 55);
    static readonly Color Text1 = Color.White;
    static readonly Color Text2 = Color.FromArgb(160, 160, 160);
    static readonly Color Accent = Color.FromArgb(64, 156, 255);

    readonly Config config;
    readonly RelayEngine engine;
    readonly RelayServer server;
    readonly UsbTunnel usb;
    readonly Label cable = new();

    readonly Label address = new();
    readonly Label code = new();
    readonly Label status = new();
    readonly Label footer = new();
    readonly ListView list = new();
    readonly TextBox log = new();
    readonly CheckBox deleteAfter = new();
    readonly System.Windows.Forms.Timer timer = new() { Interval = 1000 };
    long lastBytes;

    public MainForm(Config config)
    {
        this.config = config;
        engine = new RelayEngine(config);
        server = new RelayServer(config, engine);
        usb = new UsbTunnel(config);
        usb.Log += AddLog;
        engine.Log += AddLog;
        server.Log += AddLog;

        Text = "iRelay";
        BackColor = Back;
        ForeColor = Text1;
        Font = new Font("Segoe UI", 10f);
        MinimumSize = new Size(760, 560);
        Size = new Size(900, 640);
        StartPosition = FormStartPosition.CenterScreen;

        BuildLayout();
        timer.Tick += (_, _) => Refresh_();
        Load += async (_, _) =>
        {
            DarkTitleBar();
            try
            {
                await server.StartAsync();
                status.Text = "Pronto. No iDeck: Ajustes › Steam › iRelay › Conexão: Cabo USB, e digite o código.";
                usb.Start();
            }
            catch (Exception error)
            {
                status.Text = "Não foi possível abrir a porta " + config.Port + ": " + error.Message;
                status.ForeColor = Color.FromArgb(255, 110, 110);
            }
            Refresh_();
            timer.Start();
        };
        FormClosing += async (_, _) =>
        {
            timer.Stop();
            engine.CancelAll();
            usb.Stop();
            await server.StopAsync();
        };
    }

    void BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(20), BackColor = Back,
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 60));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(root);

        // Header: title, address, pairing code.
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true, BackColor = Back };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 60));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 40));
        var left = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, BackColor = Back, WrapContents = false };
        left.Controls.Add(new Label { Text = "iRelay", Font = new Font("Segoe UI Semibold", 22f), AutoSize = true, ForeColor = Text1 });
        left.Controls.Add(new Label { Text = "Baixa jogos da Steam no PC e envia ao iDeck pelo cabo USB enquanto baixa.", AutoSize = true, ForeColor = Text2 });
        cable.AutoSize = true;
        cable.ForeColor = Text1;
        cable.Font = new Font("Segoe UI", 11f);
        cable.Margin = new Padding(3, 10, 3, 0);
        left.Controls.Add(cable);
        address.AutoSize = true;
        address.ForeColor = Text1;
        address.ForeColor = Text2;
        address.Margin = new Padding(3, 4, 3, 3);
        left.Controls.Add(address);
        header.Controls.Add(left, 0, 0);

        var right = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, BackColor = Back, Anchor = AnchorStyles.Right | AnchorStyles.Top, WrapContents = false };
        right.Controls.Add(new Label { Text = "Código de pareamento", AutoSize = true, ForeColor = Text2 });
        code.AutoSize = true;
        code.Font = new Font("Consolas", 28f, FontStyle.Bold);
        code.ForeColor = Accent;
        right.Controls.Add(code);
        var newCode = MakeButton("Novo código");
        newCode.Click += (_, _) =>
        {
            config.Code = Config.NewCode();
            config.Save();
            AddLog("Novo código de pareamento gerado. Atualize-o no iDeck.");
            Refresh_();
        };
        right.Controls.Add(newCode);
        header.Controls.Add(right, 1, 0);
        root.Controls.Add(header, 0, 0);

        status.AutoSize = true;
        status.ForeColor = Text2;
        status.Margin = new Padding(3, 8, 3, 8);
        root.Controls.Add(status, 0, 1);

        // Downloads.
        list.Dock = DockStyle.Fill;
        list.View = View.Details;
        list.FullRowSelect = true;
        list.BackColor = Panel;
        list.ForeColor = Text1;
        list.BorderStyle = BorderStyle.FixedSingle;
        list.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        list.OwnerDraw = true;
        list.DrawColumnHeader += (_, e) =>
        {
            using var back = new SolidBrush(Color.FromArgb(28, 28, 28));
            e.Graphics.FillRectangle(back, e.Bounds);
            using var pen = new Pen(Line);
            e.Graphics.DrawLine(pen, e.Bounds.Left, e.Bounds.Bottom - 1, e.Bounds.Right, e.Bounds.Bottom - 1);
            TextRenderer.DrawText(e.Graphics, e.Header?.Text, Font, Rectangle.Inflate(e.Bounds, -6, 0), Text2,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
        };
        list.DrawItem += (_, e) => e.DrawDefault = false;
        list.DrawSubItem += (_, e) =>
        {
            using var back = new SolidBrush(Panel);
            e.Graphics.FillRectangle(back, e.Bounds);
            if (e.ColumnIndex == 1 && e.Item?.Tag is Job job && job.Total > 0)
            {
                var bar = Rectangle.Inflate(e.Bounds, -6, -7);
                using var track = new SolidBrush(Color.FromArgb(40, 40, 40));
                using var sent = new SolidBrush(Color.FromArgb(46, 160, 67));
                using var pc = new SolidBrush(Accent);
                e.Graphics.FillRectangle(track, bar);
                e.Graphics.FillRectangle(pc, bar.X, bar.Y, (int)(bar.Width * Math.Min(1.0, (double)job.Downloaded / job.Total)), bar.Height);
                e.Graphics.FillRectangle(sent, bar.X, bar.Y, (int)(bar.Width * Math.Min(1.0, (double)job.Sent / job.Total)), bar.Height);
                return;
            }
            TextRenderer.DrawText(e.Graphics, e.SubItem?.Text, Font, Rectangle.Inflate(e.Bounds, -6, 0), Text1,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
        };
        list.Columns.Add("Jogo", 220);
        list.Columns.Add("Progresso (azul: no PC, verde: no iDeck)", 260);
        list.Columns.Add("No PC", 90);
        list.Columns.Add("No iDeck", 90);
        list.Columns.Add("Baixado", 90);
        list.Columns.Add("Falhas", 60);
        root.Controls.Add(list, 0, 2);

        log.Dock = DockStyle.Fill;
        log.Multiline = true;
        log.ReadOnly = true;
        log.ScrollBars = ScrollBars.Vertical;
        log.BackColor = Back;
        log.ForeColor = Text2;
        log.BorderStyle = BorderStyle.None;
        log.Font = new Font("Consolas", 9f);
        log.Margin = new Padding(3, 10, 3, 3);
        root.Controls.Add(log, 0, 3);

        // Actions.
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, BackColor = Back, Margin = new Padding(0, 10, 0, 0) };
        var defender = MakeButton("Ignorar Windows Defender");
        defender.ForeColor = Accent;
        defender.Click += async (_, _) =>
        {
            defender.Enabled = false;
            AddLog("Pedindo permissão de administrador para adicionar o iRelay às exclusões do Windows Defender e ao firewall...");
            var (ok, message) = await Defender.Ignore(config);
            AddLog((ok ? "Windows Defender ignorando o iRelay. " : "Windows Defender: ") + message);
            defender.Enabled = true;
        };
        var undo = MakeButton("Desfazer");
        undo.Click += async (_, _) =>
        {
            var (ok, message) = await Defender.Undo(config);
            AddLog((ok ? "Exclusões do Windows Defender removidas. " : "Windows Defender: ") + message);
        };
        var openCache = MakeButton("Abrir cache");
        openCache.Click += (_, _) =>
        {
            Directory.CreateDirectory(config.CacheDir);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{config.CacheDir}\"") { UseShellExecute = true });
        };
        var clear = MakeButton("Limpar cache");
        clear.Click += (_, _) =>
        {
            engine.CancelAll();
            engine.ClearCache();
            AddLog("Cache limpo.");
        };
        deleteAfter.Text = "Apagar cada pedaço depois de enviado ao iDeck";
        deleteAfter.Checked = config.DeleteAfterSend;
        deleteAfter.AutoSize = true;
        deleteAfter.ForeColor = Text1;
        deleteAfter.Margin = new Padding(12, 9, 3, 3);
        deleteAfter.CheckedChanged += (_, _) =>
        {
            config.DeleteAfterSend = deleteAfter.Checked;
            config.Save();
        };
        actions.Controls.AddRange(new Control[] { defender, undo, openCache, clear, deleteAfter });
        root.Controls.Add(actions, 0, 4);

        footer.AutoSize = true;
        footer.ForeColor = Text2;
        footer.Margin = new Padding(3, 8, 3, 0);
        root.Controls.Add(footer, 0, 5);
    }

    static Button MakeButton(string text)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = true,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(26, 26, 26),
            ForeColor = Color.White,
            Padding = new Padding(10, 4, 10, 4),
            Margin = new Padding(3, 3, 8, 3),
            Cursor = Cursors.Hand,
        };
        button.FlatAppearance.BorderColor = Line;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(45, 45, 45);
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(60, 60, 60);
        return button;
    }

    void Refresh_()
    {
        var addresses = RelayServer.LocalAddresses();
        address.Text = addresses.Count == 0
            ? "Wi‑Fi (opcional): sem rede"
            : "Wi‑Fi (opcional): " + string.Join("   ou   ", addresses.Select(a => config.Port == 27090 ? a : $"{a}:{config.Port}"));
        code.Text = config.Code;
        cable.Text = usb.Status;

        var jobs = engine.Jobs;
        list.BeginUpdate();
        while (list.Items.Count > jobs.Count) list.Items.RemoveAt(list.Items.Count - 1);
        for (int i = 0; i < jobs.Count; i++)
        {
            var job = jobs[i];
            string[] cells =
            {
                job.Name, "",
                Percent(job.Downloaded, job.Total), Percent(job.Sent, job.Total),
                FormatSize(job.Bytes), job.Failed.ToString(),
            };
            if (i >= list.Items.Count) list.Items.Add(new ListViewItem(cells) { Tag = job });
            else
            {
                var item = list.Items[i];
                item.Tag = job;
                for (int c = 0; c < cells.Length; c++) item.SubItems[c].Text = cells[c];
            }
        }
        list.EndUpdate();
        list.Invalidate();

        var total = engine.TotalBytes;
        var speed = Math.Max(0, total - lastBytes);
        lastBytes = total;
        footer.Text = $"Velocidade: {FormatSize(speed)}/s   ·   Total baixado: {FormatSize(total)}   ·   Cache: {FormatSize(engine.CacheSize())}   ·   {config.CacheDir}";
    }

    static string Percent(int part, int total) => total == 0 ? "-" : $"{100.0 * part / total:0}%";

    static string FormatSize(long bytes)
    {
        string[] units = { "B", "KB", "MB", "GB", "TB" };
        double value = bytes;
        int unit = 0;
        while (value >= 1024 && unit < units.Length - 1) { value /= 1024; unit++; }
        return $"{value:0.#} {units[unit]}";
    }

    void AddLog(string line)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(() => AddLog(line)); return; }
        log.AppendText($"[{DateTime.Now:HH:mm:ss}] {line}{Environment.NewLine}");
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    void DarkTitleBar()
    {
        try
        {
            int on = 1;
            if (DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int)) != 0) DwmSetWindowAttribute(Handle, 19, ref on, sizeof(int));
        }
        catch { }
    }
}
