using System;
using System.Diagnostics;

internal static class OpenBrowser {
    [STAThread]
    private static int Main(string[] args) {
        try {
            Uri url;
            if (args.Length != 1 || !Uri.TryCreate(args[0], UriKind.Absolute, out url)
                || url.Scheme != Uri.UriSchemeHttp || url.Host != "127.0.0.1"
                || !String.IsNullOrEmpty(url.UserInfo)) {
                throw new ArgumentException("Expected an AIB loopback HTTP URL.");
            }
            // Use the registered URL handler, not Explorer's process-start notification.
            // https://learn.microsoft.com/en-us/troubleshoot/developer/visualstudio/csharp/language-compilers/start-internet-browser
            using (var browser = Process.Start(new ProcessStartInfo {
                FileName = url.AbsoluteUri,
                UseShellExecute = true,
                ErrorDialog = false,
                Verb = "open"
            })) { }
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
