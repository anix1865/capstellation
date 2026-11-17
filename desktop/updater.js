'use strict';
/**
 * Update check: when the app opens, look at the latest GitHub Release. If it's newer than this
 * version, ask "Install now / Later". Installing downloads the right installer, swaps it in, and
 * relaunches (macOS) or runs the installer (Windows).
 *
 * The app isn't signed with an Apple Developer ID yet, so this replaces the app bundle directly
 * rather than using Squirrel (which requires signing on macOS).
 */
const { app, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'anix1865/capstellation';
const UA = 'Capstellation-updater';

const parse = v => String(v).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
function isNewer(latest, current){
  const a = parse(latest), b = parse(current);
  for (let i = 0; i < 3; i++){ if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

function pickAsset(assets){
  if (process.platform === 'darwin') return assets.find(a => a.name.endsWith(`-${process.arch}.dmg`)) || assets.find(a => a.name.endsWith('.dmg'));
  if (process.platform === 'win32') return assets.find(a => /setup.*\.exe$/i.test(a.name)) || assets.find(a => a.name.endsWith('.exe'));
  return null;
}

async function download(url, file, win){
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/octet-stream' } });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  let got = 0;
  for await (const chunk of r.body){
    out.write(chunk);
    got += chunk.length;
    if (total && win && !win.isDestroyed()) win.setProgressBar(got / total);
  }
  await new Promise((ok, bad) => out.end(err => err ? bad(err) : ok()));
  if (win && !win.isDestroyed()) win.setProgressBar(-1);
}

/** macOS: wait for this app to quit, replace the .app from the DMG, relaunch. */
function installMac(dmg){
  const bundle = path.resolve(process.execPath, '../../..');            // …/Capstellation.app
  if (!bundle.endsWith('.app')) throw new Error('unexpected app location');
  try{ fs.accessSync(path.dirname(bundle), fs.constants.W_OK); }
  catch{ return false; }                                               // can't write there: fall back to opening the DMG
  const script = path.join(os.tmpdir(), 'capstellation-update.sh');
  fs.writeFileSync(script, `#!/bin/bash
PID="$1"; DMG="$2"; DEST="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
MNT="$(mktemp -d)"
hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$DMG" || { open "$DMG"; exit 1; }
SRC="$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)"
rm -rf "$DEST.old"
if mv "$DEST" "$DEST.old" && ditto "$SRC" "$DEST"; then rm -rf "$DEST.old"; else rm -rf "$DEST"; mv "$DEST.old" "$DEST"; fi
hdiutil detach -quiet "$MNT"; rm -f "$DMG"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
open "$DEST"
`, { mode: 0o755 });
  spawn('/bin/bash', [script, String(process.pid), dmg, bundle], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

/** Windows: start the installer and quit so it can replace the files. */
function installWin(exe){
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

async function checkForUpdates(win, { quiet = true } = {}){
  if (!app.isPackaged) return;                                         // running from source: `git pull` updates it
  let rel;
  try{
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    rel = await r.json();
  }catch{ return; }                                                    // offline: try again next launch
  const latest = (rel.tag_name || '').replace(/^v/, '');
  if (!latest || !isNewer(latest, app.getVersion())) return;
  const asset = pickAsset(rel.assets || []);
  if (!asset) return;

  const notes = (rel.body || '').split('\n').filter(l => l.trim()).slice(0, 6).join('\n');
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Install now', 'Later'], defaultId: 0, cancelId: 1,
    title: 'Update available',
    message: `Capstellation ${latest} is available`,
    detail: `You have ${app.getVersion()}.${notes ? '\n\nWhat’s new:\n' + notes : ''}\n\nThe app will restart to finish installing.`,
  });
  if (response !== 0) return;

  const file = path.join(os.tmpdir(), asset.name);
  try{
    await download(asset.browser_download_url, file, win);
  }catch(e){
    dialog.showMessageBox(win, { type: 'warning', message: 'The update couldn’t be downloaded', detail: String(e.message || e) });
    return;
  }
  let started = false;
  try{ started = process.platform === 'darwin' ? installMac(file) : installWin(file); }catch{}
  if (!started){                                                       // e.g. the app isn't somewhere writable
    await shell.openPath(file);
    dialog.showMessageBox(win, { type: 'info', message: 'Drag the new Capstellation into Applications to finish updating.' });
    return;
  }
  app.quit();
}

module.exports = { checkForUpdates, isNewer };
