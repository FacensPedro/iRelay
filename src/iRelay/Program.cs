namespace IRelay;

static class Program
{
    [STAThread]
    static void Main()
    {
        using var single = new Mutex(true, "Local\\iRelay-iDeck", out bool first);
        if (!first)
        {
            MessageBox.Show("O iRelay já está aberto.", "iRelay", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        ApplicationConfiguration.Initialize();
        var config = Config.Load();
        Application.Run(new MainForm(config));
    }
}
