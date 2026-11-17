# Capstellation

A full-screen lyric visualizer. Each lyric line becomes a constellation of word-stars, the word being sung glows large under its star, the last 10 lines stay on screen while older ones fade, and the background is the album cover, blurred, with sharp patches drifting across it. Skipping forward or back clears the sky and starts again from the new spot.

## Run it

The page needs to run from a local server (not opened as a file) so Spotify login and audio capture work:

```bash
cd capstellation
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open **http://127.0.0.1:8080** in Chrome or Edge.

## Keys

| Key | Action |
|---|---|
| F / double-click | Fullscreen |
| H | Hide all UI (H or double-click to bring it back) |
| C | Toggle the clock |
| [ / ] | Nudge lyric timing ±250 ms (saved) |
| Space, ← / → | Play/pause and seek ±5 s (Demo & Search modes) |

The controls and cursor also auto-hide after 3 seconds without mouse movement.

## Sources

**Spotify (most accurate).** Reads the exact track, position, pauses and skips every 1.2 s.
1. Create an app at developer.spotify.com/dashboard.
2. Add the Redirect URI shown in the app (e.g. `http://127.0.0.1:8080/`). Spotify doesn't accept `localhost`, so use `127.0.0.1`.
3. Paste the Client ID → Connect. Check Spotify's current rules for development-mode apps (account type, user allow-list).

**Listen (any app: Apple Music, Amazon Music, YouTube…).** Captures audio and identifies the song plus its position with the AudD API, then re-checks every ~16 s. It also reacts to silence: the lyrics pause, and when sound comes back the song is re-checked right away, which is how skips get caught.
- Get a token at dashboard.audd.io (each check is one API request).
- Click *Share audio & listen* and choose the browser tab playing your music (the web players work) or your whole screen with "Share system audio" turned on (Windows / ChromeOS, and recent Chrome on newer macOS). *Use mic* is a fallback.
- If AudD ever blocks browser requests (CORS), put a tiny proxy in front of it.

**Search (manual).** Search LRCLIB, pick the song, and press Play when it starts in your player.

**Demo.** A built-in song with original placeholder lyrics.

Lyrics come from **lrclib.net** (free, no key). Covers come from Spotify/AudD, or the iTunes Search API as a fallback.

## How sync works

All sources call one function, `setPlayback(positionMs, isPlaying)`. If the reported position differs from the predicted one by more than 2.5 s, that counts as a skip: the current constellations fade out, and the sky rebuilds from the line playing now. Word timing is spread across each line by word length, because LRC files only time whole lines.

Tunables are at the top of the script: `MAX_CAPTIONS`, `MAX_ON_SCREEN`, `FADE_SPEED`, `DIE_SPEED`, `SEEK_THRESHOLD`, `LISTEN_CLIP_MS`, `LISTEN_EVERY`, `SP_POLL_MS`.

## Going native later

A browser can't see what other apps are playing. For a true desktop app with no setup, wrap the page in Electron or Tauri and read now-playing info from the OS: MediaRemote / ScriptingBridge on macOS, `GlobalSystemMediaTransportControlsSessionManager` on Windows, MPRIS on Linux. That gives track, position and seeks for every player, and the visual code stays the same.
