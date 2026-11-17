# Capstellation

A full-screen lyric visualizer for macOS and Windows. Each lyric line becomes a constellation of word-stars, and the word being sung glows large under its star. The newest constellations shine like real stars, and older ones fade away. Behind it all is a slowly flowing collage of the album cover, a clock, a light bar around the screen edges, and a visualizer that follows the music itself.

Skip forward or back and the sky clears and starts again from the new spot.

## Download

Get the latest version from the [**Releases**](https://github.com/anix1865/capstellation/releases/latest) page:

| Your computer | File |
|---|---|
| Mac with Apple chip (M1, M2, M3…) | `Capstellation-<version>-arm64.dmg` |
| Mac with Intel processor | `Capstellation-<version>-x64.dmg` |
| Windows 10 / 11 | `Capstellation-Setup-<version>.exe` |

Not sure which Mac you have? Apple menu → **About This Mac** → **Chip**.

**First launch.** The app isn't signed with a developer certificate yet, so your system will warn you once:
- **macOS:** drag Capstellation into **Applications**, then run this once in Terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Capstellation.app
  ```
  Or open it, click **Cancel**, and choose **Open Anyway** in System Settings → Privacy & Security.
- **Windows:** at the SmartScreen warning, choose **More info → Run anyway**.

**Permissions (macOS).** Capstellation asks for two permissions:
- **Automation** (Spotify / Music), to read what's playing.
- **Screen & System Audio Recording**, to hear the music for the visualizer and the beat-synced glitch. Only Spotify's and Apple Music's own audio is captured: never the microphone, other apps or notifications. No screen pixels are kept.

**Updates.** Each time the app opens, and every 6 hours while it's open, it checks for a newer release and asks **Install now / Later**. You can also check any time with **Capstellation → Check for Updates…** (macOS) or **Ctrl+U** (Windows). Until the app is signed, macOS treats each update as a new app and asks for the permissions again.

## Using it

Play something in **Spotify** or **Apple Music** (on Windows, any player that shows up in the system media controls, including browsers). The lyrics, cover and visualizer follow along on their own.

**Sources** (panel, bottom left):
- **Mac / Windows (default):** reads the song, exact position, pauses and skips from the player on this computer. No accounts or keys.
- **Spotify:** uses the Spotify Web API, for example to follow Spotify playing on another device. Create an app at developer.spotify.com, add the Redirect URI shown in the panel, and paste its Client ID.

**Background** (panel):
- **Album art / My image:** a collage of the album cover, or one image of your own (pick it, or drag it onto the screen).
- **Collage:** an asymmetrical arrangement of the cover, laid out differently for each song. **Shuffle layout** makes a new arrangement.
- **Blur:** a soft blur with sharp spots drifting across it. Untick it for a sharp background; album art and your own image each remember their own setting.
- **Liquid:** the background slowly flows and ripples, a little more in loud parts.
- **Light bar:** a glow that travels around the screen edges and pulses with the kick drum.
- **Glitch:** thin torn scanlines and neon pixel blocks that follow the bass. Quiet verses get small flickers, loud parts get more, and a drop gets one bigger burst. It's kept restrained, so it never takes over the screen.
- **Interludes:** when the music plays on with no words (intros, solos, outros), the sky goes to warp speed. The stars move as fast as the bass pushes them, kicks send out rings, and three dots fill in as the next line gets close.

**Visualizer** (panel): **Bars** along the bottom, or **Radial**: the album cover spins slowly in the middle like a record, with the bars standing out around it. The constellations steer around it.

**Open at login** (panel, desktop app only): Capstellation starts when you log in to your computer. It's on by default; untick it to turn it off.

**Use as wallpaper** (panel, desktop app only): Capstellation plays behind your desktop icons on your main screen instead of in a window. It's click-through, so the desktop works as normal, and the clock and song name stay clear of the menu bar. A small control in the top-left corner shuffles the collage, and its arrow opens the other settings. To turn it off, use **Stop wallpaper** there, use the star icon in the menu bar (Mac) or the system tray (Windows), or click Capstellation in the Dock.

The clock, lyrics, stars, visualizer and light bar all take their colors from the background, always at a brightness that keeps them readable.

### Keys

Press **?** in the app (or click the **?** button, top right) to see these.

| Key | Action |
|---|---|
| **F** / double-click / ⛶ button | Fullscreen on / off |
| **H** | Hide everything. Click anywhere to bring it back |
| **C** | Show / hide the clock |
| **V** | Show / hide the visualizer |
| **[** / **]** | Lyrics earlier / later by ¼ s (remembered) |
| **?** | Shortcut list |

The controls also fade out after a few seconds without mouse movement.

## Run from source

**Desktop app** (needs Node.js 20+):

```bash
git clone https://github.com/anix1865/capstellation.git
cd capstellation/desktop
npm install
npm start
```

On macOS the first launch builds the audio tap (`audiotap.swift`, about 30 s). If `swiftc` isn't found, run `xcode-select --install` once. The source version updates with `git pull`.

**Lightweight Mac version** (Python only, opens in your browser):

```bash
python3 capstellation.py
```

Then open **http://127.0.0.1:8787** (Chrome or Edge work best).

**Troubleshooting:** `python3 capstellation.py --check` prints exactly what the helper sees: the raw answers from Spotify and Music, whether lyrics were found, and whether the music audio is coming through. While the app runs, its Terminal window logs each new song and any error. When the app has nothing to draw, a short message in the middle of the screen says why.

## How it works

The UI is a single page (`index.html`). A small local helper gives it what a web page can't get on its own:

| | Now playing | Music audio |
|---|---|---|
| **macOS** | AppleScript → Spotify / Apple Music | `audiotap.swift`: ScreenCaptureKit, only those two apps |
| **Windows** | Windows media controls (any player) | `native/windows`: WASAPI loopback of the speakers |

The helper is `desktop/server.js` in the app, or `capstellation.py` standalone. Both serve the page and the same endpoints:

| Endpoint | What it does |
|---|---|
| `/now` | what's playing |
| `/levels` | the music's spectrum (server-sent events, ~60/s) |
| `/audio` | audio status |
| `/lyrics`, `/art`, `/img` | lyric and artwork lookups, relayed through the helper |

**Sync.** Every source reports "the song is at *x* ms, playing or paused". When the reported position differs from the expected one by more than 2.5 s, that's a skip: the sky fades out and rebuilds from the current line.

**Word timing.** Lyric files time whole lines, so the app learns each song's singing pace (milliseconds per syllable) and sings each line at that pace. When a file has real per-word timestamps (enhanced LRC), those are used instead.

**Rendering.** The background (collage, blur, drifting spots, liquid flow, grain and light bar) is drawn in a single WebGL pass, with a CSS fallback. Constellations are drawn on a canvas, using ready-made star images rather than per-frame blur.

Tunables live at the top of the script in `index.html`: `MAX_CAPTIONS`, `MAX_ON_SCREEN`, `FADE_SPEED`, `DIE_SPEED`, `SEEK_THRESHOLD`, `MAC_POLL_MS`, `SP_POLL_MS`.

## Building

Every push to `main` that changes the app runs the **Desktop app** workflow (`.github/workflows/desktop.yml`):
1. **macOS:** builds the audio tap for Apple Silicon and Intel, and packages both `.dmg` files.
2. **Windows:** builds the Windows helper (.NET 8) and packages the installer.
3. **Release:** publishes everything as release `v0.1.<build number>`, which installed apps then offer as an update.

To build the Windows helper yourself (needs the .NET 8 SDK):

```bash
dotnet publish native/windows -c Release -o desktop/native-bin/win
cd desktop && npm run dist:win
```

## Project layout

```
index.html              the whole UI (visuals, lyrics, settings)
capstellation.py        standalone Mac helper (Python, no dependencies)
audiotap.swift          macOS music-audio tap (ScreenCaptureKit)
desktop/                Electron app: main.js, server.js (helper), updater.js, wallpaper.js
native/windows/         Windows helper (C#): now playing, loopback audio, wallpaper placement
fonts/                  font licenses
.github/workflows/      builds and releases
```

## Roadmap

- Sign and notarize the app, so there are no first-launch warnings and permissions survive updates.
- Previous / play-pause / next controls.
- Song recognition from the audio itself (ShazamKit on macOS), for players that don't report what's playing.
- On Windows, capture only the music player's audio rather than all system output.

## Credits

- Lyrics: [LRCLIB](https://lrclib.net). Artwork fallback: iTunes Search API.
- Fonts: Montserrat (SIL Open Font License, see `fonts/Montserrat-OFL.txt`), Instrument Serif, Fraunces and Space Mono (Google Fonts). The clock digits are a custom font built for this project.
