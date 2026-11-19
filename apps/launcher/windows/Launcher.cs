using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class Launcher {
    // Windows command-line quoting, including embedded quotes and trailing slashes.
    private static string Quote(string value) {
        var output = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { output.Append('\\', slashes * 2 + 1); output.Append(ch); }
            else { output.Append('\\', slashes); output.Append(ch); }
            slashes = 0;
        }
        output.Append('\\', slashes * 2); output.Append('"'); return output.ToString();
    }
    private static void Open(string root, string file) {
        var info = new ProcessStartInfo {
            FileName = Path.Combine(root, "node.exe"),
            Arguments = Quote(Path.Combine(root, "cli.cjs")) + " open" + (file == null ? "" : " " + Quote(Path.GetFullPath(file))),
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardError = true, RedirectStandardOutput = true
        };
        using (var process = Process.Start(info)) {
            var errors = process.StandardError.ReadToEndAsync();
            var output = process.StandardOutput.ReadToEndAsync();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new Exception(errors.Result);
        }
    }
    [STAThread]
    private static int Main(string[] args) {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            if (args.Length == 0) Open(root, null);
            else foreach (string file in args) Open(root, file);
            return 0;
        } catch (Exception error) {
            MessageBox.Show(error.Message, "AIB 无法打开文件", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
