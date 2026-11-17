# Capstellation

A full-screen lyric visualizer. Each lyric line becomes a constellation of word-stars, the word being sung glows large under its star, the last 10 lines stay on screen while older ones fade, and the background is the album cover, blurred, with sharp patches drifting across it. Skipping forward or back clears the sky and starts again from the new spot.

## Run it (Mac)

```bash
git clone https://github.com/anix1865/capstellation.git
cd capstellation
python3 capstellation.py
```

That starts the app and opens **http://127.0.0.1:8787** in your browser. Chrome or Edge works best. Then play something in **Spotify** or **Apple Music**.

macOS asks for two permissions the first time. Click **OK / Allow** for both:
- **Automation** (Terminal → Spotify / Music), to read what's playing.
- **Screen & System Audio Recording** (Terminal), to *hear the music itself* for the visualizer and the beat-synced glitch. Only Spotify's and Apple Music's own audio is captured: never the microphone, other apps or notifications. After allowing it, restart the helper.

The first run also builds a small native audio tap (`audiotap.swift`, about 30 s). The helper otherwise uses only Python's standard library. If `python3` or `swiftc` isn't found, run `xcode-select --install` once.

### Something not working?

```bash
python3 capstellation.py --check
```

This prints exactly what the helper sees: the raw AppleScript answers from Spotify/Music, what the app receives, whether lyrics were found, and whether the system audio is working. While the helper runs, its Terminal window also logs each new song and any error. The app shows a short message in the middle of the screen whenever it has nothing to draw, explaining why.

## Desktop app (macOS + Windows), in progress

`desktop/` packages Capstellation as a real app, so there's no Terminal step. It's an Electron window around the same UI, with the helper rewritten in Node (`desktop/server.js`, same endpoints as `capstellation.py`).

| | Now playing | Music audio (visualizer, glitch, Listen) |
|---|---|---|
| **macOS** | AppleScript → Spotify / Apple Music | `audiotap.swift` (ScreenCaptureKit, only those apps) |
| **Windows** | Windows media controls → Spotify, Apple Music, Amazon Music, browsers… | `native/windows` (WASAPI loopback of the speakers, never the mic) |

**Run it from source on your Mac:**

```bash
cd desktop
npm install
npm start
```

The first launch builds the audio tap. macOS asks for Automation and Screen & System Audio Recording permissions, this time for the app itself.

**Installers:** every push to `main` runs the *Desktop app* workflow (GitHub → Actions), which builds a macOS `.dmg` (Apple Silicon + Intel) and a Windows `Setup.exe`. Download them from the run's *Artifacts*. The builds aren't signed with a developer certificate yet, so the first time you open them:
- **macOS:** right-click the app → **Open**. If it says the app is damaged, run `xattr -dr com.apple.quarantine /Applications/Capstellation.app`.
- **Windows:** SmartScreen → **More info → Run anyway**.

**Build the Windows helper yourself** (needs the .NET 8 SDK): `dotnet publish native/windows -c Release -o desktop/native-bin/win`, then `npm run dist:win` in `desktop/`.

## Keys

Press **?** (or click the **?** button in the top right) for this list in the app.

| Key | Action |
|---|---|
| F / double-click / ⛶ button | Fullscreen on / off |
| H | Hide everything. Click anywhere to bring it back; moving the mouse won't |
| C | Show / hide the clock |
| V | Show / hide the visualizer |
| [ / ] | Lyrics earlier / later by ¼ s (saved) |

## Sources

**Mac (default).** `capstellation.py` asks the Spotify and Apple Music desktop apps, through AppleScript, what's playing: title, artist, album, exact position, and play/pause. The page checks every 0.8 s, so skips and pauses show up almost immediately and timing is exact. It needs no keys or accounts. If both apps are open, whichever is playing wins. Lyric and artwork lookups also go through the helper, so browser extensions can't block them.

**Spotify (Web API).** Use this on a non-Mac computer, or to follow Spotify playing on another device. Create an app at developer.spotify.com/dashboard, add the Redirect URI shown in the app (e.g. `http://127.0.0.1:8787/`), and paste the Client ID.

Lyrics come from **lrclib.net** (free, no key). Covers come from Spotify, or the iTunes Search API as a fallback.

## Background

- **Album art:** an asymmetrical **collage** of the cover: one big copy leaning to one side, a staggered column of medium copies on the other, small zoomed-in fragments and thin strips. Each song gets its own layout; **Shuffle layout** makes a new one. It's blurred, with three sharp spots drifting across it. Untick **Collage** for the plain cover.
- **Liquid:** the background slowly flows and ripples like ink in water (WebGL), a little stronger in loud parts.
- **Light bar:** a glow that travels around the edges of the screen in the clock and lyric colors, and pulses with the kick drum.
- **Glitch:** thin torn scanlines and neon pixel blocks, with a slight red/cyan split on the clock and sung word. Kept restrained: even at a drop, it flickers across a few bands and never takes over the screen. When the app can hear the music (mic, shared tab or BlackHole), it follows the bass. Each kick triggers a burst, and its size depends on how loud that part of the song is *compared with the rest of the song*: quiet verses give small flickers, the loudest parts give heavy tearing plus a constant crackle, and the moment a drop hits gets one big 0.7 s burst. The app learns a song's quiet and loud range as it plays, so the first minute is its best guess. Without audio, gentle bursts come at random.
- **My image:** pick one image (or drag it onto the screen). It shows sharp by default; tick **Blur** for the same blur + drifting-spots treatment. The image is remembered in this browser.

The clock, sung word, star labels and lines take their color from whatever background is showing. They use the image's own hue at a lightness that keeps them readable. If an image is too bright for light text, it gets a dark shade, but only as much as needed. The visualizer uses the complementary color.

## Visualizer

A slim mirrored bar visualizer sits at the bottom center, in the same colors as the clock and sung word: a horizontal gradient from the vivid word color (bass, center) to the softer clock color (edges), with brighter tips. Constellations keep just clear of it.

It's driven by the **music itself**: the helper's ScreenCaptureKit tap captures only Spotify's and Apple Music's audio and streams its spectrum to the page about 60 times a second. The room microphone is never used for the visuals, so talking or other noise won't move the bars or trigger glitches. Browsers can't hear desktop apps on their own, so the visualizer and beat-synced glitch need the helper running.

## How sync works

Every source calls `setPlayback(positionMs, isPlaying)`. If the reported position differs from the predicted one by more than 2.5 s, that counts as a skip: the sky fades out and rebuilds from the current line.

Lyric files only time whole lines, so word timing is estimated. The app learns each song's singing pace (ms per syllable) and sings each line at that pace from its start. When a file has real per-word timestamps (enhanced LRC), those are used instead.

Tunables are at the top of the script: `MAX_CAPTIONS`, `MAX_ON_SCREEN`, `FADE_SPEED`, `DIE_SPEED`, `SEEK_THRESHOLD`, `MAC_POLL_MS`, `LISTEN_CLIP_MS`, `LISTEN_EVERY`, `SP_POLL_MS`.

## Roadmap: native Mac app

- Wrap the page in a native shell (Swift/WKWebView, Tauri or Electron) so there's no Terminal step.
- Use **ShazamKit** (Apple's free, on-device song recognition for native apps) in place of AudD for Listen mode, so recognizing any audio source needs no API key.
- Read Now Playing for every player from the system instead of per-app AppleScript.
