// capstellation-helper.exe — Windows side of Capstellation.
//
// Writes one line per update to stdout (UTF-8):
//   R <rate>               sample rate of the captured audio (once)
//   L <base64>             ~60×/s: 512-bin spectrum, same byte scale as Web Audio's getByteFrequencyData (−95…−25 dB)
//   P <base64>             the same audio as 16 kHz mono 16-bit PCM, for song recognition
//   N <json>               ~2.5×/s: what's playing (from Windows' media controls)
//   A <key> <base64>       album art for the current track, sent once per track
//
// Also: --wallpaper <hwnd> <x> <y> <w> <h> puts the app's wallpaper window behind the desktop icons,
//       --wallpaper-restore repaints the normal desktop picture afterwards.
// Notes and errors go to stderr.

using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using NAudio.Wave;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace Capstellation;

static class Out
{
    static readonly object Gate = new();
    static readonly Stream Std = Console.OpenStandardOutput();

    public static void Line(string s)
    {
        var bytes = Encoding.UTF8.GetBytes(s + "\n");
        lock (Gate) { Std.Write(bytes, 0, bytes.Length); Std.Flush(); }
    }

    public static void Note(string s)
    {
        lock (Gate) { Console.Error.WriteLine(s); Console.Error.Flush(); }
    }
}

/// <summary>FFT spectrum + 16 kHz PCM from a mono sample stream (mirrors audiotap.swift).</summary>
sealed class Analyzer
{
    const int N = 2048, Bins = 512;
    readonly int hop;
    readonly float[] ring = new float[N];
    readonly double[] window = new double[N];
    readonly double[] smooth = new double[Bins];
    readonly double[] re = new double[N], im = new double[N];
    readonly double decimStep;
    readonly List<short> pcm = new();
    int pos, sinceHop, decimN;
    double decimAcc;
    float decimSum;

    public Analyzer(int rate)
    {
        hop = Math.Max(1, rate / 60);
        decimStep = rate / 16000.0;
        for (int i = 0; i < N; i++)   // Blackman window
            window[i] = 0.42 - 0.5 * Math.Cos(2 * Math.PI * i / (N - 1)) + 0.08 * Math.Cos(4 * Math.PI * i / (N - 1));
    }

    public void Push(float s)
    {
        ring[pos] = s;
        pos = (pos + 1) % N;
        sinceHop++;

        decimSum += s; decimN++; decimAcc += 1;               // any rate → 16 kHz for recognition
        if (decimAcc >= decimStep)
        {
            decimAcc -= decimStep;
            float v = Math.Clamp(decimSum / decimN, -1f, 1f);
            pcm.Add((short)(v * 32767));
            decimSum = 0; decimN = 0;
        }

        if (sinceHop >= hop)
        {
            sinceHop = 0;
            Analyze();
            if (pcm.Count > 0)
            {
                var bytes = new byte[pcm.Count * 2];
                System.Buffer.BlockCopy(pcm.ToArray(), 0, bytes, 0, bytes.Length);
                Out.Line("P " + Convert.ToBase64String(bytes));
                pcm.Clear();
            }
        }
    }

    void Analyze()
    {
        for (int i = 0; i < N; i++) { re[i] = ring[(pos + i) % N] * window[i]; im[i] = 0; }
        Fft(re, im);
        var bytes = new byte[Bins];
        for (int k = 0; k < Bins; k++)
        {
            double m = 2 * Math.Sqrt(re[k] * re[k] + im[k] * im[k]) / N;
            smooth[k] = 0.45 * smooth[k] + 0.55 * m;           // like smoothingTimeConstant = 0.45
            double db = 20 * Math.Log10(Math.Max(smooth[k], 1e-12));
            bytes[k] = (byte)Math.Clamp((db + 95) / 70 * 255, 0, 255);
        }
        Out.Line("L " + Convert.ToBase64String(bytes));
    }

    /// <summary>In-place iterative radix-2 FFT.</summary>
    static void Fft(double[] re, double[] im)
    {
        int n = re.Length;
        for (int i = 1, j = 0; i < n; i++)
        {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { (re[i], re[j]) = (re[j], re[i]); (im[i], im[j]) = (im[j], im[i]); }
        }
        for (int len = 2; len <= n; len <<= 1)
        {
            double ang = -2 * Math.PI / len, wr = Math.Cos(ang), wi = Math.Sin(ang);
            for (int i = 0; i < n; i += len)
            {
                double cr = 1, ci = 0;
                for (int k = 0; k < len / 2; k++)
                {
                    int a = i + k, b = i + k + len / 2;
                    double tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                    double ncr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr; cr = ncr;
                }
            }
        }
    }
}

static class Program
{
    static async Task<int> Main(string[] args)
    {
        // one-off jobs for the app's wallpaper mode
        if (args.Length >= 6 && args[0] == "--wallpaper") return Wallpaper.Attach(args);
        if (args.Length >= 1 && args[0] == "--wallpaper-restore") return Wallpaper.Restore();

        StartAudio();
        await NowPlayingLoop();
        return 0;
    }

    /// <summary>Listens to what the speakers/headphones are playing (loopback), never the microphone.</summary>
    static void StartAudio()
    {
        try
        {
            var capture = new WasapiLoopbackCapture();
            var fmt = capture.WaveFormat;
            int ch = Math.Max(1, fmt.Channels), bits = fmt.BitsPerSample;
            if (bits != 32 && bits != 16)
            {
                Out.Line($"E Unsupported audio format ({bits}-bit).");
                return;
            }
            var analyzer = new Analyzer(fmt.SampleRate);
            Out.Line($"R {fmt.SampleRate}");
            capture.DataAvailable += (_, e) =>
            {
                int bytesPerSample = bits / 8, frames = e.BytesRecorded / (bytesPerSample * ch);
                for (int f = 0; f < frames; f++)
                {
                    float sum = 0;
                    for (int c = 0; c < ch; c++)
                    {
                        int at = (f * ch + c) * bytesPerSample;
                        sum += bits == 32 ? BitConverter.ToSingle(e.Buffer, at) : BitConverter.ToInt16(e.Buffer, at) / 32768f;
                    }
                    analyzer.Push(sum / ch);
                }
            };
            capture.RecordingStopped += (_, e) =>
            {
                if (e.Exception != null) Out.Note("audio capture stopped: " + e.Exception.Message);
            };
            capture.StartRecording();
            Out.Note($"listening to the system audio output ({fmt.SampleRate} Hz, {ch} ch)");
        }
        catch (Exception ex)
        {
            Out.Line("E Couldn't listen to the system audio: " + ex.Message);
            Out.Note("audio: " + ex);
        }
    }

    /// <summary>Polls Windows' media controls for the current song, position and artwork.</summary>
    static async Task NowPlayingLoop()
    {
        GlobalSystemMediaTransportControlsSessionManager? mgr = null;
        string lastThumb = "";
        while (true)
        {
            try
            {
                mgr ??= await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                GlobalSystemMediaTransportControlsSession? session = null;
                foreach (var s in mgr.GetSessions())   // prefer whatever is actually playing
                {
                    if (s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing) { session = s; break; }
                }
                session ??= mgr.GetCurrentSession();

                if (session == null)
                {
                    Out.Line("N " + JsonSerializer.Serialize(new { state = "none" }));
                }
                else
                {
                    var props = await session.TryGetMediaPropertiesAsync();
                    var timeline = session.GetTimelineProperties();
                    bool playing = session.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;

                    // Apps report the position only now and then; move it forward by the time since that report.
                    var position = timeline.Position;
                    if (playing && timeline.LastUpdatedTime.Year > 2000)
                    {
                        var since = DateTimeOffset.Now - timeline.LastUpdatedTime;
                        if (since > TimeSpan.Zero && since < TimeSpan.FromHours(3)) position += since;
                    }
                    long durMs = (long)Math.Max(0, (timeline.EndTime - timeline.StartTime).TotalMilliseconds);

                    string app = AppName(session.SourceAppUserModelId);
                    string id = $"{session.SourceAppUserModelId}|{props.Title}|{props.Artist}";
                    string thumbKey = Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(Encoding.UTF8.GetBytes(id)))[..12];

                    if (thumbKey != lastThumb && props.Thumbnail != null)
                    {
                        lastThumb = thumbKey;
                        try
                        {
                            using var stream = await props.Thumbnail.OpenReadAsync();
                            var size = (uint)stream.Size;
                            using var reader = new DataReader(stream.GetInputStreamAt(0));
                            await reader.LoadAsync(size);
                            var bytes = new byte[size];
                            reader.ReadBytes(bytes);
                            Out.Line($"A {thumbKey} {Convert.ToBase64String(bytes)}");
                        }
                        catch (Exception ex) { Out.Note("artwork: " + ex.Message); }
                    }

                    Out.Line("N " + JsonSerializer.Serialize(new
                    {
                        state = playing ? "playing" : "paused",
                        title = props.Title ?? "",
                        artist = string.IsNullOrEmpty(props.Artist) ? props.AlbumArtist ?? "" : props.Artist,
                        album = props.AlbumTitle ?? "",
                        duration_ms = durMs,
                        position_ms = (long)Math.Max(0, position.TotalMilliseconds),
                        id,
                        app,
                        thumb = lastThumb == thumbKey ? thumbKey : null,
                    }));
                }
            }
            catch (Exception ex)
            {
                Out.Note("now playing: " + ex.Message);
                mgr = null;
            }
            await Task.Delay(400);
        }
    }

    static string AppName(string aumid)
    {
        var a = aumid.ToLowerInvariant();
        if (a.Contains("spotify")) return "spotify";
        if (a.Contains("applemusic") || a.Contains("apple music") || a.Contains("itunes")) return "music";
        if (a.Contains("amazon")) return "amazon";
        if (a.Contains("chrome") || a.Contains("msedge") || a.Contains("firefox") || a.Contains("opera") || a.Contains("brave")) return "browser";
        return "windows";
    }
}

/// <summary>
/// Puts a window behind the desktop icons (the way wallpaper apps do it).
///  - Windows 10 / 11 up to 23H2: ask Explorer to split the desktop (message 0x052C); the icons move into a
///    top-level WorkerW and the plain wallpaper is drawn by the next top-level WorkerW. Parent our window there.
///  - Windows 11 24H2+ ("raised desktop"): the icons (SHELLDLL_DefView) stay a layered child of Progman and the
///    wallpaper is a WorkerW child of Progman below them. Our window must be a layered child of Progman,
///    placed between the two, or the system never draws it.
/// Prints what it found, for the app's wallpaper.log.
/// </summary>
static class Wallpaper
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string? cls, string? title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string? cls, string? title);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SystemParametersInfo(uint action, uint param, StringBuilder? sb, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SystemParametersInfo(uint action, uint param, string? str, uint flags);

    const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
    const long WS_CHILD = 0x40000000, WS_POPUP = 0x80000000, WS_EX_LAYERED = 0x80000, WS_EX_NOREDIRECTIONBITMAP = 0x200000;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40;

    static long Style(IntPtr h, int i) => GetWindowLongPtr(h, i).ToInt64();
    static void SetStyle(IntPtr h, int i, long v) => SetWindowLongPtr(h, i, new IntPtr(v));

    /// <summary>The wallpaper WorkerW among Progman's children: the biggest visible one (Explorer also keeps tiny helpers).</summary>
    static IntPtr BiggestChildWorker(IntPtr progman)
    {
        IntPtr best = IntPtr.Zero, w = IntPtr.Zero; long area = -1;
        while ((w = FindWindowEx(progman, w, "WorkerW", null)) != IntPtr.Zero)
        {
            GetWindowRect(w, out var r); long a = (long)(r.R - r.L) * (r.B - r.T);
            if (IsWindowVisible(w) && a > area) { area = a; best = w; }
        }
        return best;
    }

    /// <summary>Make the window a plain child before re-parenting (a popup that's half-attached misbehaves).</summary>
    static void MakeChild(IntPtr win, bool layered)
    {
        SetStyle(win, GWL_STYLE, (Style(win, GWL_STYLE) & ~WS_POPUP) | WS_CHILD);
        if (layered)
        {
            SetStyle(win, GWL_EXSTYLE, Style(win, GWL_EXSTYLE) | WS_EX_LAYERED);
            SetLayeredWindowAttributes(win, 0, 255, 2 /* LWA_ALPHA: fully opaque */);
        }
    }

    public static int Attach(string[] a)
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));   // work in real pixels, whatever the display scaling
        var win = new IntPtr(long.Parse(a[1]));
        if (!IsWindow(win)) { Console.Error.WriteLine("The wallpaper window wasn't found."); return 2; }

        var progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) { Console.Error.WriteLine("Couldn't find the desktop (Progman)."); return 3; }
        // ask Explorer for a wallpaper layer behind the icons (0xD, 1 is what Windows 11 needs; 0, 0 for older)
        SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(0x1), 0, 1000, out _);
        SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out _);

        // the main screen, in real pixels
        var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        GetMonitorInfo(MonitorFromPoint(new POINT(), 1 /* primary */), ref mi);
        var rc = mi.rcMonitor;
        Console.WriteLine($"build {Environment.OSVersion.Version} monitor {rc.L},{rc.T} {rc.R - rc.L}x{rc.B - rc.T}");

        var iconsInProgman = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        bool raised = (Style(progman, GWL_EXSTYLE) & WS_EX_NOREDIRECTIONBITMAP) != 0 || iconsInProgman != IntPtr.Zero;

        IntPtr parent, after = IntPtr.Zero;
        if (raised)
        {
            if (iconsInProgman == IntPtr.Zero) { Console.Error.WriteLine("Couldn't find the desktop icon layer."); return 4; }
            parent = progman; after = iconsInProgman;              // z-order: icons, us, wallpaper
            MakeChild(win, layered: true);
            SetParent(win, progman);
        }
        else
        {
            IntPtr worker = IntPtr.Zero;
            EnumWindows((top, _) =>
            {
                if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
                    worker = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
                return true;
            }, IntPtr.Zero);
            if (worker == IntPtr.Zero) { Console.Error.WriteLine("Couldn't find the wallpaper layer (WorkerW)."); return 5; }
            parent = worker;
            MakeChild(win, layered: false);
            SetParent(win, worker);
        }

        // place it over the main screen, in the parent's coordinates
        var tl = new POINT { X = rc.L, Y = rc.T };
        ScreenToClient(parent, ref tl);
        SetWindowPos(win, after, tl.X, tl.Y, rc.R - rc.L, rc.B - rc.T, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED | (after == IntPtr.Zero ? 0x4u /* NOZORDER */ : 0));
        if (raised)
        {
            var wp = BiggestChildWorker(progman);
            if (wp != IntPtr.Zero && wp != win) SetWindowPos(wp, win, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);   // plain wallpaper below us
        }

        // check it really landed
        bool ok = GetParent(win) == parent && IsWindowVisible(win);
        GetWindowRect(win, out var got);
        Console.WriteLine($"{(raised ? "raised" : "classic")} desktop; parent ok={GetParent(win) == parent} visible={IsWindowVisible(win)} rect={got.L},{got.T} {got.R - got.L}x{got.B - got.T}");
        if (!ok) { Console.Error.WriteLine("The window didn't attach to the desktop."); return 6; }
        Console.WriteLine("ok");
        return 0;
    }

    /// <summary>Re-apply the current wallpaper so Windows repaints it after our window is gone.</summary>
    public static int Restore()
    {
        const uint SPI_GETDESKWALLPAPER = 0x0073, SPI_SETDESKWALLPAPER = 0x0014;
        var sb = new StringBuilder(520);
        SystemParametersInfo(SPI_GETDESKWALLPAPER, (uint)sb.Capacity, sb, 0);
        SystemParametersInfo(SPI_SETDESKWALLPAPER, 0, sb.ToString(), 0);
        Console.WriteLine("ok");
        return 0;
    }
}
