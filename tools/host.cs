// wzsc-collector 的原生消息宿主（Native Messaging Host）。
//
// 扩展点一下的时候，浏览器会启动这个小程序；它只做一件事：
// 把「本机服务」在后台拉起来（没有窗口），然后立刻退出。
// 服务自己会在闲置几分钟后退出，所以平时不会有任何东西在跑。
//
// 由 install.js 编译成 bin\wzsc-host.exe（用 Windows 自带的 csc.exe，不需要额外装东西）。

using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;

internal static class WzscHost
{
    // 服务低于这个版本就当作"不是我们的服务"
    private const string MinVersion = "0.3.0";

    private static int Main()
    {
        try
        {
            ReadMessage();
            string root = ProjectRoot();

            if (!ServiceUp())
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = FindNode(root);
                info.Arguments = "\"" + Path.Combine(Path.Combine(root, "src"), "server.js") + "\"";
                info.WorkingDirectory = root;
                // UseShellExecute = true：新进程不继承我们的管道，
                // 否则浏览器会一直等管道关闭（扩展那边的回调就会卡住）
                info.UseShellExecute = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(info);
                WriteMessage("{\"ok\":true,\"started\":true}");
            }
            else
            {
                WriteMessage("{\"ok\":true,\"started\":false,\"reason\":\"already-running\"}");
            }
            return 0;
        }
        catch (Exception error)
        {
            WriteMessage("{\"ok\":false,\"error\":\"" + Escape(error.Message) + "\"}");
            return 0;
        }
    }

    /** 项目根目录 = exe 所在目录（bin）的上一层 */
    private static string ProjectRoot()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        DirectoryInfo parent = Directory.GetParent(baseDir);
        return (parent != null ? parent.FullName : baseDir);
    }

    /** 优先用安装时记下来的 node 路径 */
    private static string FindNode(string root)
    {
        string recorded = Path.Combine(root, "node-path.txt");
        if (File.Exists(recorded))
        {
            string path = File.ReadAllText(recorded, Encoding.UTF8).Trim();
            if (path.Length > 0 && File.Exists(path)) return path;
        }

        string[] guesses = new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs\\node.exe"),
            "C:\\nvm4w\\nodejs\\node.exe"
        };
        for (int i = 0; i < guesses.Length; i++)
        {
            if (File.Exists(guesses[i])) return guesses[i];
        }
        return "node.exe";
    }

    /** 已经有一个"够新"的服务在跑就不用再起一个 */
    private static bool ServiceUp()
    {
        for (int port = 8765; port <= 8768; port++)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/health");
                request.Timeout = 500;
                request.ReadWriteTimeout = 500;
                request.Method = "GET";
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    string body = reader.ReadToEnd();
                    if (body.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0 &&
                        body.IndexOf("\"version\":\"" + MinVersion + "\"", StringComparison.Ordinal) >= 0)
                    {
                        return true;
                    }
                }
            }
            catch (Exception)
            {
                // 这个端口上没有服务，试下一个
            }
        }
        return false;
    }

    private static void ReadMessage()
    {
        try
        {
            Stream stdin = Console.OpenStandardInput();
            byte[] header = new byte[4];
            int read = 0;
            while (read < 4)
            {
                int got = stdin.Read(header, read, 4 - read);
                if (got <= 0) break;
                read += got;
            }
            if (read == 4)
            {
                int length = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
                if (length > 0 && length < 1024 * 1024)
                {
                    byte[] body = new byte[length];
                    int total = 0;
                    while (total < length)
                    {
                        int got = stdin.Read(body, total, length - total);
                        if (got <= 0) break;
                        total += got;
                    }
                }
            }
        }
        catch (Exception)
        {
            // 读不到也无所谓，照样把服务拉起来
        }
    }

    private static void WriteMessage(string json)
    {
        try
        {
            byte[] body = Encoding.UTF8.GetBytes(json);
            Stream stdout = Console.OpenStandardOutput();
            byte[] header = new byte[4];
            header[0] = (byte)(body.Length & 0xFF);
            header[1] = (byte)((body.Length >> 8) & 0xFF);
            header[2] = (byte)((body.Length >> 16) & 0xFF);
            header[3] = (byte)((body.Length >> 24) & 0xFF);
            stdout.Write(header, 0, 4);
            stdout.Write(body, 0, body.Length);
            stdout.Flush();
        }
        catch (Exception)
        {
            // 忽略
        }
    }

    private static string Escape(string text)
    {
        if (text == null) return "";
        return text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
    }
}
