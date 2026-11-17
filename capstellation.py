#!/usr/bin/env python3
"""
Capstellation Mac helper.

Runs the app at http://127.0.0.1:8787 and gives it what a web page can't get on its own:
  /now        what Spotify or Apple Music is playing (title, artist, exact position, play/pause)
  /levels     live spectrum of the music itself (only Spotify/Music audio, never the microphone)
  /recognize  identify the song from that audio with AudD (Listen mode, no mic needed)
  /lyrics, /art, /img   lyric + artwork lookups, relayed so browser extensions/CORS can't block them

    python3 capstellation.py            # start + open the browser
    python3 capstellation.py --check    # self-test: shows exactly what the helper sees
    python3 capstellation.py --no-open --port 9000

macOS will ask once for:
  * Automation (Terminal → Spotify / Music): to read what's playing. Click OK.
  * Screen & System Audio Recording (Terminal): to hear the music for the visualizer and glitch.
    Only Spotify and Music audio is captured, and nothing leaves your Mac.
Change either later in System Settings > Privacy & Security.
"""
import argparse
import base64
import collections
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
SEP = "␞"  # a character that never shows up in song titles
UA = "Capstellation (https://github.com/anix1865/capstellation)"
IS_MAC = sys.platform == "darwin" or os.environ.get("CAPSTELLATION_FAKE_MAC") == "1"   # the env var is for tests

# ---------------------------------------------------------------------------
# What's playing (AppleScript)
# ---------------------------------------------------------------------------
# Each script checks "is running" first so it never launches an app you aren't using.
# Only plain property reads happen inside the `tell` block; all maths happens outside it
# (some apps reject commands like `round` sent to them).
SCRIPTS = {
    "spotify": f'''
if application "Spotify" is running then
  tell application "Spotify"
    set playerState to player state as text
    if playerState is "stopped" then return "stopped"
    set t to current track
    set trackName to name of t
    set trackArtist to artist of t
    set trackAlbum to album of t
    set trackDur to duration of t
    set playerPos to player position
    set trackId to id of t
    set artUrl to ""
    try
      set artUrl to artwork url of t
    end try
  end tell
  set durMillis to trackDur as integer
  set posMillis to (playerPos * 1000) as integer
  return playerState & "{SEP}" & trackName & "{SEP}" & trackArtist & "{SEP}" & trackAlbum & "{SEP}" & (durMillis as text) & "{SEP}" & (posMillis as text) & "{SEP}" & trackId & "{SEP}" & artUrl
end if
return "off"
''',
    "music": f'''
if application "Music" is running then
  tell application "Music"
    set playerState to player state as text
    if playerState is "stopped" then return "stopped"
    set t to current track
    set trackName to name of t
    set trackArtist to artist of t
    set trackAlbum to ""
    try
      set trackAlbum to album of t
    end try
    set trackDur to 0
    try
      set trackDur to duration of t
    end try
    set playerPos to player position
    set trackId to ""
    try
      set trackId to persistent ID of t
    end try
  end tell
  set durMillis to (trackDur * 1000) as integer
  set posMillis to (playerPos * 1000) as integer
  return playerState & "{SEP}" & trackName & "{SEP}" & trackArtist & "{SEP}" & trackAlbum & "{SEP}" & (durMillis as text) & "{SEP}" & (posMillis as text) & "{SEP}" & trackId & "{SEP}"
end if
return "off"
''',
}


def run_osascript(player):
    t0 = time.monotonic()
    out = subprocess.run(["osascript", "-e", SCRIPTS[player]], capture_output=True, text=True, timeout=6)
    return out, (t0 + time.monotonic()) / 2


def ask(player):
    """One player's state: a dict, None if it isn't open/playing, or {'error': ...}."""
    try:
        out, sampled = run_osascript(player)
    except FileNotFoundError:
        return {"error": "osascript not found: the Mac helper only works on macOS."}
    except subprocess.TimeoutExpired:
        return {"error": f"{player.title()} didn't answer. If macOS is asking for permission, click OK."}

    if out.returncode != 0:
        err = out.stderr.strip()
        if "-1743" in err or "Not authorized" in err:
            return {"error": f"macOS blocked access to {player.title()}. Allow it in System Settings > Privacy & "
                             f"Security > Automation > Terminal > {player.title()}, then restart the helper."}
        if "-600" in err or "isn’t running" in err or "isn't running" in err:
            return None
        if "Can’t get application" in err or "Can't get application" in err:
            return None                      # app not installed
        if "-1728" in err and "current track" in err:
            return None                      # nothing loaded (e.g. radio)
        return {"error": f"{player.title()} AppleScript error: {err[:240]}"}

    text = out.stdout.rstrip("\n")
    if text in ("off", "stopped", ""):
        return None
    parts = text.split(SEP)
    if len(parts) < 8:
        return {"error": f"Unexpected answer from {player.title()}: {text[:120]!r}"}
    state, title, artist, album, dur, pos, tid, art = parts[:8]

    def to_int(s):
        try:
            return int(float(s.strip().replace(",", ".")))
        except ValueError:
            return 0

    return {
        "player": player,
        "state": "playing" if state.strip() == "playing" else "paused",
        "title": title, "artist": artist, "album": album,
        "duration_ms": to_int(dur), "position_ms": to_int(pos),
        "id": tid or f"{title}|{artist}",
        "artwork": art or None,
        "_sampled": sampled,
    }


_cache = {"at": 0.0, "data": None}
_lock = threading.Lock()
_last_track = {"key": None, "error": None}


def now_playing():
    """Current track across players, cached briefly so several tabs don't hammer osascript."""
    with _lock:
        if time.monotonic() - _cache["at"] < 0.35 and _cache["data"] is not None:
            data = dict(_cache["data"])
        else:
            if not IS_MAC:
                data = {"ok": False, "error": "The Mac helper only works on macOS."}
            else:
                found, errors = [], []
                for p in ("spotify", "music"):
                    r = ask(p)
                    if r is None:
                        continue
                    (errors if "error" in r else found).append(r)
                    if p == "spotify" and r.get("state") == "playing":
                        break           # Spotify is playing: no need to ask Music too (half the AppleScript work)
                found.sort(key=lambda r: (r["state"] != "playing", r["player"] != "spotify"))
                if found:
                    data = {"ok": True, **found[0]}
                elif errors:
                    data = {"ok": False, "error": errors[0]["error"]}
                else:
                    data = {"ok": True, "state": "none"}
            _cache.update(at=time.monotonic(), data=dict(data))
            _log_changes(data)
    sampled = data.pop("_sampled", None)
    if sampled is not None:
        data["age_ms"] = round((time.monotonic() - sampled) * 1000)
    return data


def _log_changes(data):
    """Print track changes and new errors in the Terminal, so it's obvious what the helper sees."""
    if not data.get("ok"):
        if data.get("error") != _last_track["error"]:
            print(f"  ! {data.get('error')}", flush=True)
            _last_track["error"] = data.get("error")
        return
    _last_track["error"] = None
    key = f"{data.get('player')}:{data.get('id')}" if data.get("state") != "none" else None
    if key != _last_track["key"]:
        _last_track["key"] = key
        if key:
            print(f"  ♪ {data['title']} — {data['artist']}  ({data['player'].title()}, {data['state']})", flush=True)
        else:
            print("  · nothing playing in Spotify or Music", flush=True)


# ---------------------------------------------------------------------------
# System audio (Swift ScreenCaptureKit tap: Spotify + Music only)
# ---------------------------------------------------------------------------
class AudioTap:
    """Builds and runs audiotap.swift; keeps the latest spectrum and the last ~20 s of audio."""

    def __init__(self):
        self.levels = None          # latest spectrum frame (base64 of 512 bytes)
        self.levels_at = 0.0
        self.rate = 16000           # rate of the PCM we keep (48 kHz / 3)
        self.pcm = collections.deque()
        self.pcm_bytes = 0
        self.pcm_lock = threading.Lock()
        self.error = None
        self.status = "starting"
        self.proc = None

    def start(self):
        if not IS_MAC:
            self.status, self.error = "off", "System audio capture needs macOS."
            return
        threading.Thread(target=self._run, daemon=True).start()

    def _build(self):
        src = os.path.join(ROOT, "audiotap.swift")
        out_dir = os.path.join(ROOT, ".build")
        binary = os.path.join(out_dir, "audiotap")
        if os.path.exists(binary) and os.path.getmtime(binary) >= os.path.getmtime(src):
            return binary
        swiftc = shutil.which("swiftc")
        if not swiftc:
            raise RuntimeError("Swift compiler not found. Run `xcode-select --install` once, then restart the helper.")
        os.makedirs(out_dir, exist_ok=True)
        print("  … building the system-audio tap (first run only, ~30 s)", flush=True)
        r = subprocess.run([swiftc, "-O", src, "-o", binary], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError("Couldn't build audiotap.swift:\n" + (r.stderr or r.stdout)[-1500:])
        return binary

    def _run(self):
        try:
            binary = self._build()
        except Exception as e:  # noqa: BLE001
            self.status, self.error = "off", str(e)
            print(f"  ! system audio: {e}", flush=True)
            return
        while True:
            self.status = "running"
            try:
                self.proc = subprocess.Popen([binary], stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            except OSError as e:
                self.status, self.error = "off", f"Couldn't start the audio tap: {e}"
                return
            threading.Thread(target=self._stderr, daemon=True).start()
            for raw in self.proc.stdout:
                self._line(raw.decode("ascii", "ignore").strip())
            self.proc.wait()
            self.status = "restarting"
            time.sleep(3)  # crashed or was stopped: try again

    def _stderr(self):
        for raw in self.proc.stderr:
            msg = raw.decode("utf-8", "ignore").strip()
            if msg:
                print(f"  [audio] {msg}", flush=True)

    def _line(self, line):
        tag, _, rest = line.partition(" ")
        if tag == "L":
            self.levels, self.levels_at, self.error = rest, time.monotonic(), None
        elif tag == "P":
            data = base64.b64decode(rest)
            with self.pcm_lock:
                self.pcm.append((time.monotonic(), data))
                self.pcm_bytes += len(data)
                while self.pcm_bytes > self.rate * 2 * 20:      # keep ~20 s
                    _, old = self.pcm.popleft()
                    self.pcm_bytes -= len(old)
        elif tag == "R":
            try:
                self.rate = int(float(rest) / 3)
            except ValueError:
                pass
        elif tag == "E":
            self.error = rest

    def fresh(self):
        return self.levels is not None and time.monotonic() - self.levels_at < 0.4

    def clip(self, seconds):
        """WAV of the last `seconds` of audio, and how long ago (s) that clip started."""
        with self.pcm_lock:
            chunks = list(self.pcm)
        if not chunks:
            return None, 0
        need = int(seconds * self.rate) * 2
        data, got = [], 0
        for _, c in reversed(chunks):
            data.append(c)
            got += len(c)
            if got >= need:
                break
        pcm = b"".join(reversed(data))[-need:]
        end_age = time.monotonic() - chunks[-1][0]
        start_ago = end_age + len(pcm) / 2 / self.rate
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.rate)
            w.writeframes(pcm)
        return buf.getvalue(), start_ago

    def info(self):
        return {"available": self.fresh() or (self.status == "running" and self.error is None),
                "hearing": self.fresh(), "status": self.status, "error": self.error, "platform": "mac"}


TAP = AudioTap()


# ---------------------------------------------------------------------------
# Web relays
# ---------------------------------------------------------------------------
def http_get(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def net_error(e):
    hint = (" (python.org Python: run 'Install Certificates.command' in your Python folder)"
            if "CERTIFICATE" in str(e).upper() else "")
    return f"{e}{hint}"


def lookup_lyrics(q):
    """LRCLIB exact match first, then a search; returns the best record or None."""
    params = {k: v for k, v in q.items() if v}
    try:
        body, _ = http_get("https://lrclib.net/api/get?" + urllib.parse.urlencode(params))
        rec = json.loads(body)
        if rec.get("syncedLyrics") or rec.get("plainLyrics") or rec.get("instrumental"):
            return rec
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    body, _ = http_get("https://lrclib.net/api/search?" + urllib.parse.urlencode(
        {"track_name": q.get("track_name", ""), "artist_name": q.get("artist_name", "")}))
    lst = json.loads(body) or []
    return next((x for x in lst if x.get("syncedLyrics")), lst[0] if lst else None)


IMG_HOSTS = ("scdn.co", "spotifycdn.com", "mzstatic.com", "audd.tech", "audd.io")


def recognize(token, seconds):
    wav, start_ago = TAP.clip(seconds)
    if not wav:
        return {"status": "error", "error": {"error_message": "No audio from Spotify/Music yet. "
                + (TAP.error or "Is something playing?")}}
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (("api_token", token), ("return", "apple_music,spotify")):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\n'
                 f'Content-Type: audio/wav\r\n\r\n'.encode() + wav + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    t0 = time.monotonic()
    req = urllib.request.Request("https://api.audd.io/", data=b"".join(parts), headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.loads(r.read())
    res["clip_start_ago_ms"] = round((start_ago + time.monotonic() - t0) * 1000)
    return res


class Handler(SimpleHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        q = dict(urllib.parse.parse_qsl(query))
        if path == "/now":
            return self._json(now_playing())
        if path == "/audio":
            return self._json(TAP.info())
        if path == "/levels":
            return self._levels()
        if path == "/lyrics":
            try:
                return self._json({"ok": True, "rec": lookup_lyrics(q)})
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": net_error(e)})
        if path == "/art":
            try:
                body, _ = http_get("https://itunes.apple.com/search?" + urllib.parse.urlencode(
                    {"term": q.get("term", ""), "entity": "song", "limit": "1"}))
                res = json.loads(body).get("results") or []
                url = res[0].get("artworkUrl100") if res else None
                return self._json({"ok": True, "url": url.replace("100x100bb", "1200x1200bb") if url else None})
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": net_error(e)})
        if path == "/img":
            u = q.get("u", "")
            host = urllib.parse.urlparse(u).hostname or ""
            if not u.startswith("https://") or not host.endswith(IMG_HOSTS):
                return self.send_error(400)
            try:
                body, ctype = http_get(u)
            except Exception:  # noqa: BLE001
                return self.send_error(502)
            self.send_response(200)
            self.send_header("Content-Type", ctype or "image/jpeg")
            self.send_header("Cache-Control", "max-age=86400")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def _levels(self):
        """Server-sent events: the music's spectrum ~60×/s ('-' when there's nothing to hear)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last, idle = None, 0
        try:
            while True:
                if TAP.fresh() and TAP.levels is not last:
                    last = TAP.levels
                    self.wfile.write(f"data: {last}\n\n".encode())
                    idle = 0
                else:
                    idle += 1
                    if idle == 25 or idle % 600 == 0:   # tell the page it's silent / keep the connection alive
                        self.wfile.write(b"data: -\n\n")
                self.wfile.flush()
                time.sleep(1 / 90)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if path == "/recognize":      # Listen mode on the Mac's own audio
            try:
                args = json.loads(body or b"{}")
                return self._json(recognize(args.get("token", ""), float(args.get("seconds", 6))))
            except Exception as e:  # noqa: BLE001
                return self._json({"status": "error", "error": {"error_message": f"helper: {net_error(e)}"}})
        if path == "/audd":           # Listen mode on mic / tab audio recorded by the page
            req = urllib.request.Request("https://api.audd.io/", data=body, headers={
                "Content-Type": self.headers.get("Content-Type", ""), "User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    out = r.read()
            except urllib.error.HTTPError as e:
                out = e.read()
            except Exception as e:  # noqa: BLE001
                out = json.dumps({"status": "error", "error": {"error_message": f"helper: {net_error(e)}"}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        self.send_error(404)

    def end_headers(self):
        if not self.path.startswith(("/now", "/levels", "/img")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):  # keep the terminal quiet
        pass


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
def check():
    print(f"Python {sys.version.split()[0]} on {sys.platform}")
    if not IS_MAC:
        print("Not macOS: Mac mode can't work here.")
        return
    for p in ("spotify", "music"):
        print(f"\n[{p}] raw AppleScript result:")
        try:
            out, _ = run_osascript(p)
            print("  exit code:", out.returncode)
            print("  stdout:", repr(out.stdout.strip())[:300])
            if out.stderr.strip():
                print("  stderr:", out.stderr.strip()[:300])
        except Exception as e:  # noqa: BLE001
            print("  failed:", e)
        print("  parsed:", ask(p))
    print("\n[now] what the app receives:")
    now = now_playing()
    print(" ", now)
    if now.get("ok") and now.get("state") not in (None, "none"):
        print("\n[lyrics] LRCLIB lookup:")
        try:
            rec = lookup_lyrics({"track_name": now["title"], "artist_name": now["artist"],
                                 "album_name": now.get("album"), "duration": round(now["duration_ms"] / 1000)})
            if not rec:
                print("  no lyrics found for this song")
            else:
                synced = rec.get("syncedLyrics") or ""
                print(f"  found: synced lines={synced.count(chr(10)) + 1 if synced else 0}, "
                      f"plain={'yes' if rec.get('plainLyrics') else 'no'}, instrumental={rec.get('instrumental')}")
        except Exception as e:  # noqa: BLE001
            print("  lookup failed:", net_error(e))
    print("\n[system audio]")
    print("  swiftc:", shutil.which("swiftc") or "not found (run xcode-select --install)")
    TAP.start()
    for _ in range(240):
        time.sleep(0.25)
        if TAP.fresh() or TAP.status == "off":
            break
    print("  ", TAP.info())


def main():
    ap = argparse.ArgumentParser(description="Serve Capstellation and report what's playing on this Mac.")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    ap.add_argument("--check", action="store_true", help="self-test and exit")
    args = ap.parse_args()
    if args.check:
        return check()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=ROOT))
    server.daemon_threads = True
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Capstellation is running at {url}")
    print("Play something in Spotify or Apple Music. Press Ctrl+C to stop.\n")
    if not IS_MAC:
        print("(Not on macOS: the app will load, but Mac mode can't read what's playing.)")
    TAP.start()
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        if TAP.proc:
            TAP.proc.terminate()


if __name__ == "__main__":
    main()
