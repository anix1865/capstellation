'use strict';
/**
 * Capstellation local server — the desktop app's version of capstellation.py.
 *
 * Serves the web UI and gives it what a page can't get on its own:
 *   GET  /now        what's playing (title, artist, exact position, play/pause)
 *   GET  /levels     live spectrum of the music (server-sent events, ~60/s)
 *   GET  /audio      status of the system-audio tap (+ which platform we're on)
 *   GET  /lyrics /art /img /thumb   lookups relayed so nothing in the page can block them
 *   POST /recognize  identify the song from the captured audio (AudD), no microphone
 *   POST /audd       relay for audio the page recorded itself (tab / mic)
 *
 * Platforms
 *   macOS   – now playing: AppleScript to Spotify / Music.  Audio: audiotap (ScreenCaptureKit, only those apps).
 *   Windows – now playing + audio: capstellation-helper.exe (system media controls + WASAPI loopback).
 *
 * Run on its own for development:  node server.js [--port 8787]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, execFile, spawnSync } = require('child_process');

const UA = 'Capstellation (https://github.com/anix1865/capstellation)';
const SEP = '␞';
const PLATFORM = process.env.CAPSTELLATION_PLATFORM ||                // override is for tests
  (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'other');
const log = (...a) => console.log('  ' + a.join(' '));

/* ------------------------------------------------------------------------------------------
   System audio tap (and, on Windows, now-playing): a native child process speaking lines
     R <rate>   L <base64 spectrum>   P <base64 16 kHz PCM>   E <error>
     N <json>   now playing (Windows)     A <key> <base64 image>   artwork (Windows)
   ------------------------------------------------------------------------------------------ */
class AudioTap {
  constructor(){
    this.levels = null; this.levelsAt = 0;
    this.rate = 16000; this.pcm = []; this.pcmBytes = 0;
    this.error = null; this.status = 'starting'; this.proc = null;
    this.now = null; this.nowAt = 0; this.thumbs = new Map();
  }
  start(command){
    if (!command){ this.status = 'off'; return; }
    if (command.error){ this.status = 'off'; this.error = command.error; log('! system audio:', command.error); return; }
    const run = () => {
      this.status = 'running';
      let proc;
      try{ proc = spawn(command.file, command.args || [], { stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch(e){ this.status = 'off'; this.error = `Couldn't start the audio helper: ${e.message}`; return; }
      this.proc = proc;
      readline.createInterface({ input: proc.stdout }).on('line', l => this.line(l.trim()));
      readline.createInterface({ input: proc.stderr }).on('line', l => { if (l.trim()) log('[audio]', l.trim()); });
      proc.on('error', e => { this.error = `Audio helper failed: ${e.message}`; });
      proc.on('exit', () => { if (this.stopped) return; this.status = 'restarting'; setTimeout(run, 3000); });
    };
    run();
  }
  stop(){ this.stopped = true; this.proc?.kill(); }
  line(l){
    const sp = l.indexOf(' '), tag = sp < 0 ? l : l.slice(0, sp), rest = sp < 0 ? '' : l.slice(sp + 1);
    if (tag === 'L'){ this.levels = rest; this.levelsAt = Date.now(); this.error = null; }
    else if (tag === 'P'){
      const b = Buffer.from(rest, 'base64');
      this.pcm.push([Date.now(), b]); this.pcmBytes += b.length;
      while (this.pcmBytes > this.rate * 2 * 20){ this.pcmBytes -= this.pcm.shift()[1].length; }   // keep ~20 s
    }
    else if (tag === 'R'){ const r = parseFloat(rest); if (r > 0) this.rate = 16000; }
    else if (tag === 'E'){ this.error = rest; }
    else if (tag === 'N'){ try{ this.now = JSON.parse(rest); this.nowAt = Date.now(); }catch{} }
    else if (tag === 'A'){
      const sp2 = rest.indexOf(' ');
      if (sp2 > 0){ this.thumbs.set(rest.slice(0, sp2), Buffer.from(rest.slice(sp2 + 1), 'base64')); if (this.thumbs.size > 20) this.thumbs.delete(this.thumbs.keys().next().value); }
    }
  }
  fresh(){ return this.levels !== null && Date.now() - this.levelsAt < 400; }
  /** WAV of the last `seconds` of audio, and how long ago (ms) that clip started. */
  clip(seconds){
    if (!this.pcm.length) return [null, 0];
    const need = Math.floor(seconds * this.rate) * 2, parts = [];
    let got = 0;
    for (let i = this.pcm.length - 1; i >= 0 && got < need; i--){ parts.unshift(this.pcm[i][1]); got += this.pcm[i][1].length; }
    const pcm = Buffer.concat(parts).subarray(-need);
    const startAgo = (Date.now() - this.pcm[this.pcm.length - 1][0]) + pcm.length / 2 / this.rate * 1000;
    return [wav(pcm, this.rate), startAgo];
  }
  info(){
    return { available: this.fresh() || (this.status === 'running' && !this.error), hearing: this.fresh(),
             status: this.status, error: this.error, platform: PLATFORM };
  }
}
function wav(pcm, rate){
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/* ------------------------------------------------------------------------------------------
   Now playing — macOS (AppleScript; only plain property reads inside `tell`, no reserved words)
   ------------------------------------------------------------------------------------------ */
const SCRIPTS = {
  spotify: `
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
  return playerState & "${SEP}" & trackName & "${SEP}" & trackArtist & "${SEP}" & trackAlbum & "${SEP}" & (durMillis as text) & "${SEP}" & (posMillis as text) & "${SEP}" & trackId & "${SEP}" & artUrl
end if
return "off"`,
  music: `
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
  return playerState & "${SEP}" & trackName & "${SEP}" & trackArtist & "${SEP}" & trackAlbum & "${SEP}" & (durMillis as text) & "${SEP}" & (posMillis as text) & "${SEP}" & trackId & "${SEP}"
end if
return "off"`,
};
const title = s => s[0].toUpperCase() + s.slice(1);
function askMac(player){
  return new Promise(resolve => {
    const t0 = Date.now();
    execFile('osascript', ['-e', SCRIPTS[player]], { timeout: 6000 }, (err, stdout, stderr) => {
      const sampled = (t0 + Date.now()) / 2;
      if (err){
        const e = String(stderr || err.message || '');
        if (err.killed) return resolve({ error: `${title(player)} didn't answer. If macOS is asking for permission, click OK.` });
        if (/-1743|Not authorized/.test(e)) return resolve({ error: `macOS blocked access to ${title(player)}. Allow it in System Settings > Privacy & Security > Automation, then restart Capstellation.` });
        if (/-600|isn.t running|Can.t get application/.test(e) || (/-1728/.test(e) && /current track/.test(e))) return resolve(null);
        if (err.code === 'ENOENT') return resolve({ error: 'osascript not found.' });
        return resolve({ error: `${title(player)} AppleScript error: ${e.trim().slice(0, 240)}` });
      }
      const text = stdout.replace(/\n$/, '');
      if (['off', 'stopped', ''].includes(text)) return resolve(null);
      const p = text.split(SEP);
      if (p.length < 8) return resolve({ error: `Unexpected answer from ${title(player)}: ${text.slice(0, 120)}` });
      const int = v => { const n = parseFloat(String(v).trim().replace(',', '.')); return Number.isFinite(n) ? Math.trunc(n) : 0; };
      resolve({ player, state: p[0].trim() === 'playing' ? 'playing' : 'paused', title: p[1], artist: p[2], album: p[3],
                duration_ms: int(p[4]), position_ms: int(p[5]), id: p[6] || `${p[1]}|${p[2]}`, artwork: p[7] || null, _sampled: sampled });
    });
  });
}

/* ------------------------------------------------------------------------------------------ */
function createServer({ root, tap, hooks = {} }){
  let cache = { at: 0, data: null, pending: null };
  const last = { key: undefined, error: null };

  function logChanges(d){
    if (!d.ok){ if (d.error !== last.error){ log('!', d.error); last.error = d.error; } return; }
    last.error = null;
    const key = d.state !== 'none' ? `${d.player}:${d.id}` : null;
    if (key !== last.key){
      last.key = key;
      log(key ? `♪ ${d.title} — ${d.artist}  (${title(d.player)}, ${d.state})` : '· nothing playing');
    }
  }

  async function nowPlaying(){
    if (PLATFORM === 'win'){
      const n = tap.now;
      let d;
      if (!n) d = tap.error ? { ok: false, error: tap.error } : { ok: true, state: 'none' };
      else if (n.state === 'none') d = { ok: true, state: 'none' };
      else {
        const thumbKey = n.thumb && tap.thumbs.has(n.thumb) ? n.thumb : null;
        d = { ok: true, player: n.app || 'windows', state: n.state, title: n.title, artist: n.artist, album: n.album,
              duration_ms: n.duration_ms, position_ms: n.position_ms, id: n.id,
              artwork: thumbKey ? `thumb?k=${encodeURIComponent(thumbKey)}` : null, age_ms: Date.now() - tap.nowAt };
      }
      logChanges(d);
      return d;
    }
    if (PLATFORM !== 'mac') return { ok: false, error: 'Now playing is only available on macOS and Windows.' };
    if (Date.now() - cache.at < 350 && cache.data) return withAge({ ...cache.data });
    if (!cache.pending){
      cache.pending = (async () => {
        const found = [], errors = [];
        for (const p of ['spotify', 'music']){
          const r = await askMac(p);
          if (r) (r.error ? errors : found).push(r);
          if (p === 'spotify' && r && r.state === 'playing') break;   // no need to ask Music too
        }
        found.sort((a, b) => (a.state !== 'playing') - (b.state !== 'playing') || (a.player !== 'spotify') - (b.player !== 'spotify'));
        const d = found.length ? { ok: true, ...found[0] } : errors.length ? { ok: false, error: errors[0].error } : { ok: true, state: 'none' };
        cache = { at: Date.now(), data: d, pending: null };
        logChanges(d);
        return d;
      })();
    }
    return withAge({ ...(await cache.pending) });
  }
  function withAge(d){ if (d._sampled){ d.age_ms = Math.round(Date.now() - d._sampled); delete d._sampled; } return d; }

  const send = (res, code, body, type = 'application/json', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const json = (res, obj) => send(res, 200, JSON.stringify(obj));
  const get = (url, opt = {}) => fetch(url, { ...opt, headers: { 'User-Agent': UA, ...(opt.headers || {}) } });
  const readBody = req => new Promise((ok, bad) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });

  /** 'Song (feat. X) [with Y] - 2011 Remaster' -> 'Song' (lyric sites often store the plain title). */
  const cleanTitle = t => String(t || '').replace(/\s*[([](?:with|feat\.?|ft\.?|featuring)\b[^)\]]*[)\]]/gi, '')
                                         .replace(/\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?\b.*$/i, '').trim();
  /**
   * Best LRCLIB record for this exact recording. Songs often exist in several versions (single,
   * album, edit) with different lengths and lyrics; the wrong one drifts or stops early. So: the
   * exact match if it's timed and the right length, otherwise the synced version closest in length.
   */
  async function lyrics(q){
    const want = Number(q.duration) || 0, album = String(q.album_name || '').toLowerCase();
    const off = r => want ? Math.abs((Number(r.duration) || 0) - want) : 0;
    const cands = [];
    const r = await get('https://lrclib.net/api/get?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v)));
    if (r.ok){
      const rec = await r.json();
      if (rec.instrumental || (rec.syncedLyrics && off(rec) <= 3)) return rec;
      cands.push(rec);
    } else if (r.status !== 404) throw new Error(`lrclib ${r.status}`);
    const title = q.track_name || '', artist = q.artist_name || '';
    for (const params of [{ track_name: title, artist_name: artist }, { track_name: cleanTitle(title), artist_name: artist }, { q: `${cleanTitle(title)} ${artist}` }]){
      try{ const s = await get('https://lrclib.net/api/search?' + new URLSearchParams(params)); if (s.ok) cands.push(...await s.json()); }catch{}
    }
    const seen = new Set(), uniq = cands.filter(c => c && !seen.has(c.id) && seen.add(c.id));
    const pool = uniq.filter(c => c.syncedLyrics).length ? uniq.filter(c => c.syncedLyrics) : uniq;
    pool.sort((a, b) => off(a) - off(b) || ((a.albumName || '').toLowerCase() !== album) - ((b.albumName || '').toLowerCase() !== album));
    return pool[0] || null;
  }

  async function recognize(token, seconds){
    const [clip, startAgo] = tap.clip(seconds);
    if (!clip) return { status: 'error', error: { error_message: 'No audio captured yet. ' + (tap.error || 'Is something playing?') } };
    const fd = new FormData();
    fd.append('api_token', token); fd.append('return', 'apple_music,spotify');
    fd.append('file', new Blob([clip], { type: 'audio/wav' }), 'clip.wav');
    const t0 = Date.now();
    const r = await get('https://api.audd.io/', { method: 'POST', body: fd });
    const res = await r.json();
    res.clip_start_ago_ms = Math.round(startAgo + Date.now() - t0);
    return res;
  }

  const IMG_HOSTS = ['scdn.co', 'spotifycdn.com', 'mzstatic.com', 'audd.tech', 'audd.io'];
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
                  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    try{
      if (req.method === 'GET'){
        switch (url.pathname){
          case '/now':   return json(res, await nowPlaying());
          case '/audio': return json(res, tap.info());
          case '/startup': return json(res, hooks.startup ? hooks.startup() : { ok: false });
          case '/levels': {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            let lastSent = null, idle = 0;
            const iv = setInterval(() => {
              if (tap.fresh() && tap.levels !== lastSent){ lastSent = tap.levels; res.write(`data: ${lastSent}\n\n`); idle = 0; }
              else if (++idle === 25 || idle % 600 === 0) res.write('data: -\n\n');   // silent / keep-alive
            }, 11);
            req.on('close', () => clearInterval(iv));
            return;
          }
          case '/lyrics':
            try{ return json(res, { ok: true, rec: await lyrics(q) }); }catch(e){ return json(res, { ok: false, error: String(e.message || e) }); }
          case '/art':
            try{
              const r = await get('https://itunes.apple.com/search?' + new URLSearchParams({ term: q.term || '', entity: 'song', limit: '1' }));
              const u = (await r.json()).results?.[0]?.artworkUrl100;
              return json(res, { ok: true, url: u ? u.replace('100x100bb', '1200x1200bb') : null });
            }catch(e){ return json(res, { ok: false, error: String(e.message || e) }); }
          case '/img': {
            let u; try{ u = new URL(q.u); }catch{ return send(res, 400, 'bad url', 'text/plain'); }
            if (u.protocol !== 'https:' || !IMG_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return send(res, 400, 'host not allowed', 'text/plain');
            const r = await get(u.href);
            if (!r.ok) return send(res, 502, 'upstream ' + r.status, 'text/plain');
            return send(res, 200, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'image/jpeg', { 'Cache-Control': 'max-age=86400' });
          }
          case '/thumb': {
            const b = tap.thumbs.get(q.k || '');
            return b ? send(res, 200, b, 'image/jpeg', { 'Cache-Control': 'max-age=86400' }) : send(res, 404, 'no thumbnail', 'text/plain');
          }
        }
        // static files from the web root
        let p = decodeURIComponent(url.pathname);
        if (p === '/') p = '/index.html';
        const file = path.normalize(path.join(root, p));
        if (!file.startsWith(path.normalize(root + path.sep))) return send(res, 403, 'forbidden', 'text/plain');
        return fs.readFile(file, (err, data) => err ? send(res, 404, 'not found', 'text/plain')
          : send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': 'no-cache' }));
      }
      if (req.method === 'POST'){
        const body = await readBody(req);
        if (url.pathname === '/recognize'){
          let a = {}; try{ a = JSON.parse(body.toString() || '{}'); }catch{}
          try{ return json(res, await recognize(a.token || '', Number(a.seconds) || 6)); }
          catch(e){ return json(res, { status: 'error', error: { error_message: 'recognition failed: ' + (e.message || e) } }); }
        }
        if (url.pathname === '/startup'){
          let a = {}; try{ a = JSON.parse(body.toString() || '{}'); }catch{}
          return json(res, hooks.startup ? hooks.startup(!!a.on) : { ok: false });
        }
        if (url.pathname === '/wallpaper/controls') return json(res, hooks.controls ? hooks.controls(q.open === '1', Number(q.h)) : { ok: false });
        if (url.pathname === '/wallpaper/screens'){
          let a = null; try{ a = JSON.parse(body.toString() || 'null'); }catch{}
          return json(res, hooks.screens ? hooks.screens(a) : { ok: false });
        }
        if (url.pathname === '/wallpaper/tint') return json(res, hooks.tint ? hooks.tint() : { ok: false });
        if (url.pathname === '/wallpaper'){
          if (!hooks.wallpaper) return json(res, { ok: false, error: 'only available in the Capstellation app' });
          let a = {}; try{ a = JSON.parse(body.toString() || '{}'); }catch{}
          return json(res, await hooks.wallpaper(a.on !== false));
        }
        if (url.pathname === '/audd'){
          try{
            const r = await get('https://api.audd.io/', { method: 'POST', body, headers: { 'Content-Type': req.headers['content-type'] || '' } });
            return send(res, 200, Buffer.from(await r.arrayBuffer()));
          }catch(e){ return json(res, { status: 'error', error: { error_message: 'couldn’t reach AudD: ' + (e.message || e) } }); }
        }
      }
      send(res, 404, 'not found', 'text/plain');
    }catch(e){
      if (!res.headersSent) send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  });
}

/* ------------------------------------------------------------------------------------------
   Finding / building the native helper for this platform
   ------------------------------------------------------------------------------------------ */
function tapCommand({ nativeDir, repoRoot }){
  if (process.env.CAPSTELLATION_TAP) return { file: process.env.CAPSTELLATION_TAP };   // tests / custom builds
  if (PLATFORM === 'mac'){
    const bin = path.join(nativeDir, 'audiotap');
    const src = repoRoot && path.join(repoRoot, 'audiotap.swift');
    const stale = src && fs.existsSync(src) && (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs);
    if (stale){                                    // development: build it from source
      log('… building the system-audio tap (first run only, ~30 s)');
      fs.mkdirSync(nativeDir, { recursive: true });
      const r = spawnSync('swiftc', ['-O', src, '-o', bin], { encoding: 'utf8', timeout: 600000 });
      if (r.error) return { error: 'Swift compiler not found. Run `xcode-select --install` once, then restart.' };
      if (r.status !== 0) return { error: "Couldn't build audiotap.swift: " + (r.stderr || r.stdout).slice(-800) };
    }
    return fs.existsSync(bin) ? { file: bin } : { error: 'audiotap is missing from this build.' };
  }
  if (PLATFORM === 'win'){
    const exe = path.join(nativeDir, 'capstellation-helper.exe');
    return fs.existsSync(exe) ? { file: exe }
      : { error: 'capstellation-helper.exe is missing. Build it with: dotnet publish native/windows -c Release -o desktop/native-bin/win' };
  }
  return { error: 'System audio capture is only available on macOS and Windows.' };
}

/** Start everything; tries ports 8787… so the app keeps the same address (and saved settings). */
async function startServer({ root, nativeDir, repoRoot, hooks, port = 8787 } = {}){
  const tap = new AudioTap();
  tap.start(tapCommand({ nativeDir, repoRoot }));
  const server = createServer({ root, tap, hooks });
  for (let p = port; p < port + 10; p++){
    try{
      await new Promise((ok, bad) => { server.once('error', bad); server.listen(p, '127.0.0.1', ok); });
      return { url: `http://127.0.0.1:${p}/`, port: p, close: () => { tap.stop(); server.close(); } };
    }catch(e){ if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('No free port between ' + port + ' and ' + (port + 9));
}

module.exports = { startServer, PLATFORM };

if (require.main === module){
  const i = process.argv.indexOf('--port');
  const repoRoot = path.join(__dirname, '..');
  startServer({ root: repoRoot, repoRoot, nativeDir: path.join(__dirname, 'native-bin', PLATFORM), port: i > 0 ? +process.argv[i + 1] : 8787 })
    .then(s => { console.log(`Capstellation is running at ${s.url}`); console.log('Play some music. Press Ctrl+C to stop.\n'); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
