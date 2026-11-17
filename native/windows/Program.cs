// capstellation-helper.exe — Windows side of Capstellation.
//
// Writes one line per update to stdout (UTF-8):
//   R <rate>               sample rate of the captured audio (once)
//   L <base64>             ~60×/s: 512-bin spectrum, same byte scale as Web Audio's getByteFrequencyData (−95…−25 dB)
//   P <base64>             the same audio as 16 kHz mono 16-bit PCM, for song recognition
//   N <json>               ~2.5×/s: what's playing (from Windows' media controls)
//   A <key> <base64>       album art for the current track, sent once per track
// Notes and errors go to stderr.

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
    static async Task Main()
    {
        StartAudio();
        await NowPlayingLoop();
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
