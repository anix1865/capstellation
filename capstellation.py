#!/usr/bin/env python3
"""
Capstellation Mac helper.

Runs the app at http://127.0.0.1:8787 and answers /now with whatever the
Spotify or Apple Music desktop app is playing (title, artist, album, exact
position, play/pause), read through AppleScript. No API keys, nothing leaves
your Mac.

    python3 capstellation.py            # start + open the browser
    python3 capstellation.py --no-open  # start without opening a browser
    python3 capstellation.py --port 9000

The first time it runs, macOS asks whether Terminal may control Spotify /
Music. Click OK. (Changed your mind? System Settings > Privacy & Security >
Automation.)
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
SEP = "␞"  # a character that never shows up in song titles

# Each script checks "is running" first so it never launches an app you aren't using.
# Times are converted to whole milliseconds inside AppleScript so decimal commas
# in some locales can't break parsing.
SCRIPTS = {
    "spotify": f'''
if application "Spotify" is running then
  tell application "Spotify"
    set st to player state as text
    if st is "stopped" then return "stopped"
    set t to current track
    set art to ""
    try
      set art to artwork url of t
    end try
    return st & "{SEP}" & (name of t) & "{SEP}" & (artist of t) & "{SEP}" & (album of t) & "{SEP}" & ((duration of t) as integer as text) & "{SEP}" & ((round ((player position) * 1000)) as text) & "{SEP}" & (id of t) & "{SEP}" & art
  end tell
end if
return "off"
''',
    "music": f'''
if application "Music" is running then
  tell application "Music"
    set st to player state as text
    if st is "stopped" then return "stopped"
    set t to current track
    set tid to ""
    try
      set tid to persistent ID of t
    end try
    set alb to ""
    try
      set alb to album of t
    end try
    set dur to 0
    try
      set dur to round ((duration of t) * 1000)
    end try
    return st & "{SEP}" & (name of t) & "{SEP}" & (artist of t) & "{SEP}" & alb & "{SEP}" & (dur as text) & "{SEP}" & ((round ((player position) * 1000)) as text) & "{SEP}" & tid & "{SEP}"
  end tell
end if
return "off"
''',
}


def ask(player):
    """Run one player's AppleScript. Returns a dict, None if the app is off, or {'error': ...}."""
    t0 = time.monotonic()
    try:
        out = subprocess.run(["osascript", "-e", SCRIPTS[player]], capture_output=True, text=True, timeout=4)
    except FileNotFoundError:
        return {"error": "osascript not found: the Mac helper only works on macOS."}
    except subprocess.TimeoutExpired:
        return {"error": f"{player} didn't answer in time."}
    sampled = (t0 + time.monotonic()) / 2  # middle of the call ≈ when the position was read

    if out.returncode != 0:
        err = out.stderr.strip()
        if "-1743" in err or "Not authorized" in err:
            return {"error": f"macOS blocked access to {player.title()}. Allow it in System Settings > "
                             f"Privacy & Security > Automation (Terminal > {player.title()})."}
        if "-1728" in err or "-1708" in err:      # no current track (e.g. radio, nothing loaded)
            return None
        if "Can’t get application" in err or "Can't get application" in err or "-2700" in err:
            return None                           # app not installed
        return {"error": f"{player}: {err[:200]}"}

    text = out.stdout.rstrip("\n")
    if text in ("off", "stopped", ""):
        return None
    parts = text.split(SEP)
    if len(parts) < 8:
        return None
    state, title, artist, album, dur, pos, tid, art = parts[:8]
    to_int = lambda s: int(float(s.replace(",", "."))) if s.strip() else 0
    return {
        "player": player,
        "state": "playing" if state == "playing" else "paused",
        "title": title, "artist": artist, "album": album,
        "duration_ms": to_int(dur), "position_ms": to_int(pos),
        "id": tid or f"{title}|{artist}",
        "artwork": art or None,
        "_sampled": sampled,
    }


_cache = {"at": 0.0, "data": None}
_lock = threading.Lock()


def now_playing():
    """Current track across players, cached briefly so several tabs don't hammer osascript."""
    with _lock:
        if time.monotonic() - _cache["at"] < 0.35 and _cache["data"] is not None:
            data = dict(_cache["data"])
        else:
            if sys.platform != "darwin":
                data = {"ok": False, "error": "The Mac helper only works on macOS."}
            else:
                found, errors = [], []
                for p in ("spotify", "music"):
                    r = ask(p)
                    if r is None:
                        continue
                    (errors if "error" in r else found).append(r)
                # prefer whatever is actually playing; Spotify wins a tie
                found.sort(key=lambda r: (r["state"] != "playing", r["player"] != "spotify"))
                if found:
                    data = {"ok": True, **found[0]}
                elif errors:
                    data = {"ok": False, "error": errors[0]["error"]}
                else:
                    data = {"ok": True, "state": "none"}
            _cache.update(at=time.monotonic(), data=data)
    sampled = data.pop("_sampled", None)
    if sampled is not None:
        data["age_ms"] = round((time.monotonic() - sampled) * 1000)
    return data


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/now":
            body = json.dumps(now_playing()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        # /audd relays Listen-mode song recognition to AudD, so the browser never hits CORS limits
        if self.path.split("?")[0] != "/audd":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        req = urllib.request.Request("https://api.audd.io/", data=body,
                                     headers={"Content-Type": self.headers.get("Content-Type", "")})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                out = r.read()
        except urllib.error.HTTPError as e:
            out = e.read()
        except Exception as e:  # network down, or Python missing SSL certificates
            hint = (" (python.org installs: run 'Install Certificates.command' in your Python folder)"
                    if "CERTIFICATE" in str(e).upper() else "")
            out = json.dumps({"status": "error", "error": {"error_message": f"helper couldn't reach AudD: {e}{hint}"}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def end_headers(self):
        if not self.path.startswith("/now"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):  # keep the terminal quiet
        pass


def main():
    ap = argparse.ArgumentParser(description="Serve Capstellation and report what's playing on this Mac.")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    args = ap.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=ROOT))
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Capstellation is running at {url}")
    print("Play something in Spotify or Apple Music. Press Ctrl+C to stop.")
    if sys.platform != "darwin":
        print("(Not on macOS: the app will load, but Mac mode can't read what's playing.)")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
