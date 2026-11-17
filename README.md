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

**Listen.** For anything else (Amazon Music, YouTube…). It records audio (the MacBook mic works) and identifies the song with the AudD API, which needs a token from dashboard.audd.io. A token is needed because recognizing a song from raw sound means matching it against a fingerprint database. When the Mac helper is running, recognition requests go through it, which avoids browser blocking. Until the first match it retries every ~1 s; after that it re-checks every ~15 s to catch skips.

Lyrics come from **lrclib.net** (free, no key). Covers come from Spotify, or the iTunes Search API as a fallback.

## Background

- **Album art:** an asymmetrical **collage** of the cover: one big copy leaning to one side, a staggered column of medium copies on the other, small zoomed-in fragments and thin strips. Each song gets its own layout; **Shuffle layout** makes a new one. It's blurred, with three sharp spots drifting across it. Untick **Collage** for the plain cover.
- **Glitch effect:** torn scanlines and neon pixel blocks, with a red/cyan split on the clock and sung word. When the app can hear the music (mic, shared tab or BlackHole), it follows the bass. Each kick triggers a burst, and its size depends on how loud that part of the song is *compared with the rest of the song*: quiet verses give small flickers, the loudest parts give heavy tearing plus a constant crackle, and the moment a drop hits gets one big 0.7 s burst. The app learns a song's quiet and loud range as it plays, so the first minute is its best guess. Without audio, gentle bursts come at random.
- **My image:** pick one image (or drag it onto the screen). It shows sharp by default; tick **Blur** for the same blur + drifting-spots treatment. The image is remembered in this browser.

The clock, sung word, star labels and lines take their color from whatever background is showing. They use the image's own hue at a lightness that keeps them readable. If an image is too bright for light text, it gets a dark shade, but only as much as needed. The visualizer uses the complementary color.

## Visualizer

A slim mirrored bar visualizer sits at the bottom center, in the same colors as the clock and sung word: a horizontal gradient from the vivid word color (bass, center) to the softer clock color (edges), with brighter tips. Constellations keep just clear of it. Browsers can't capture the Spotify/Music *desktop* apps' sound directly, so:

- **Use mic** (Mac and Spotify modes): listens through your microphone, with automatic gain so quiet speakers still move the bars. The choice is remembered, and the mic reconnects automatically next time.
- **Share tab:** if the music plays in a browser tab (e.g. the Spotify web player), share that tab's audio.
- **Exact system audio (optional):** install the free [BlackHole](https://github.com/ExistentialAudio/BlackHole) driver, create a *Multi-Output Device* in Audio MIDI Setup (your speakers + BlackHole), and choose **BlackHole** under *Audio input*. The visualizer, and Listen mode, then hear your Mac's sound directly.

## How sync works

Every source calls `setPlayback(positionMs, isPlaying)`. If the reported position differs from the predicted one by more than 2.5 s, that counts as a skip: the sky fades out and rebuilds from the current line.

Lyric files only time whole lines, so word timing is estimated. The app learns each song's singing pace (ms per syllable) and sings each line at that pace from its start. When a file has real per-word timestamps (enhanced LRC), those are used instead.

Tunables are at the top of the script: `MAX_CAPTIONS`, `MAX_ON_SCREEN`, `FADE_SPEED`, `DIE_SPEED`, `SEEK_THRESHOLD`, `MAC_POLL_MS`, `LISTEN_CLIP_MS`, `LISTEN_EVERY`, `SP_POLL_MS`.

## Roadmap: native Mac app

- Wrap the page in a native shell (Swift/WKWebView, Tauri or Electron) so there's no Terminal step.
- Use **ShazamKit** (Apple's free, on-device song recognition for native apps) in place of AudD for Listen mode, so recognizing any audio source needs no API key.
- Read Now Playing for every player from the system instead of per-app AppleScript.
