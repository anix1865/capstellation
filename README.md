# Capstellation

A full-screen lyric visualizer. Each lyric line becomes a constellation of word-stars, the word being sung glows large under its star, the last 10 lines stay on screen while older ones fade, and the background is the album cover, blurred, with sharp patches drifting across it. Skipping forward or back clears the sky and starts again from the new spot.

## Run it (Mac)

```bash
git clone https://github.com/anix1865/capstellation.git
cd capstellation
python3 capstellation.py
```

That starts the app and opens **http://127.0.0.1:8787** in your browser. Chrome or Edge works best. Then play something in **Spotify** or **Apple Music**.

The first time, macOS asks whether Terminal may control Spotify / Music. Click **OK**. If you clicked Don't Allow, turn it back on in *System Settings → Privacy & Security → Automation → Terminal*.

The helper uses only Python's standard library, so there's nothing to install. If `python3` isn't found, run `xcode-select --install` once.

## Keys

| Key | Action |
|---|---|
| F / double-click | Fullscreen |
| H | Hide all UI. Click anywhere (or press H) to bring it back; moving the mouse won't |
| C | Toggle the clock |
| V | Toggle the visualizer |
| [ / ] | Nudge lyric timing ±250 ms (saved) |

## Sources

**Mac (default).** `capstellation.py` asks the Spotify and Apple Music desktop apps, through AppleScript, what's playing: title, artist, album, exact position, and play/pause. The page checks every 0.8 s, so skips and pauses show up almost immediately and timing is exact. It needs no keys or accounts, and nothing leaves your Mac. If both apps are open, whichever is playing wins.

**Spotify (Web API).** Use this on a non-Mac computer, or to follow Spotify playing on another device. Create an app at developer.spotify.com/dashboard, add the Redirect URI shown in the app (e.g. `http://127.0.0.1:8787/`), and paste the Client ID.

**Listen.** For anything else (Amazon Music, YouTube…). It records the audio and identifies the song with the AudD API, which needs a token from dashboard.audd.io. A token is needed because recognizing a song from raw sound means matching it against a fingerprint database.

Lyrics come from **lrclib.net** (free, no key). Covers come from Spotify, or the iTunes Search API as a fallback.

## Background

- **Album art:** blurred, with three soft sharp spots drifting independently.
- **My image:** pick one image (or drag it onto the screen). It shows sharp by default; tick **Blur** for the same blur + drifting-spots treatment. The image is remembered in this browser.

The clock, sung word, star labels and lines take their color from whatever background is showing. They use the image's own hue at a lightness that keeps them readable. If an image is too bright for light text, it gets a dark shade, but only as much as needed. The visualizer uses the complementary color.

## Visualizer

A slim mirrored bar visualizer sits at the bottom center. In **Listen** mode it uses the audio you already shared. In **Mac** and **Spotify** modes, click **Share audio** (choose your screen and switch on its audio, where your Chrome/macOS offers that) or **Mic** in the panel.

## How sync works

Every source calls `setPlayback(positionMs, isPlaying)`. If the reported position differs from the predicted one by more than 2.5 s, that counts as a skip: the sky fades out and rebuilds from the current line.

Lyric files only time whole lines, so word timing is estimated. The app learns each song's singing pace (ms per syllable) and sings each line at that pace from its start. When a file has real per-word timestamps (enhanced LRC), those are used instead.

Tunables are at the top of the script: `MAX_CAPTIONS`, `MAX_ON_SCREEN`, `FADE_SPEED`, `DIE_SPEED`, `SEEK_THRESHOLD`, `MAC_POLL_MS`, `LISTEN_CLIP_MS`, `LISTEN_EVERY`, `SP_POLL_MS`.

## Roadmap: native Mac app

- Wrap the page in a native shell (Swift/WKWebView, Tauri or Electron) so there's no Terminal step.
- Use **ShazamKit** (Apple's free, on-device song recognition for native apps) in place of AudD for Listen mode, so recognizing any audio source needs no API key.
- Read Now Playing for every player from the system instead of per-app AppleScript.
