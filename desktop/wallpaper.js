'use strict';
// Wallpaper mode: a second, click-through window that sits behind the desktop icons and shows
// the same page (with ?wallpaper=1, so no controls). A menu bar / tray icon turns it off again.
//
//   macOS:   a window at the desktop level (Electron's type: 'desktop'), on every Space.
//   Windows: the window is re-parented behind the desktop icons by capstellation-helper.exe
//            (--wallpaper), the same trick wallpaper apps use.
const { BrowserWindow, Tray, Menu, nativeImage, screen, app } = require('electron');
// macOS: the menu bar is tinted by the real desktop picture, not by windows. So while we're the
// wallpaper, the desktop picture is set to a snapshot of us (refreshed when the cover changes),
// and the person's own picture is put back when wallpaper mode stops.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const ICON = {
  mac: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACWUlEQVR4Xr2XSYsUQRCFPx3Xg4KgMHoS3A/iijuKeBJ/swfFHWUQBB3UwYPg0YMHcRvlKyLG7O5qrMzu9kFBdVdFxIuIl5FZMBu2AztncbG50TjtLgN3wsdSi69ZCdwCbkfgTS0EtrQYAb/D7hKwHPfrjb6qkZna/0/AV2BPaxVaWpAEjgL7gB3A6SBQ7a/aADZsrsKG8GyFqNZBC4Hs/42ieVfiPp8tDJnhVmAtxGjQj8U8qK5CDbJix4CfQUD1S+JUiw5qW+D7ZugAcvBI4lcE9r9SI4MwlIDvGdDLbMv+J1IH+d5Q3xMwQ40dUtMG1WoQMXsvSb2ZknL6yeqNIAXjQy8dZUlLHAbOQbfcrgFnoxVpn+p/ATwAnkB3/66HlBXSTu2s9ynW/44D56Fb6/bW39sGNfUvvkdVHgMPgefxe2SpGsyRega4DlwMNR8shkwiS53V6kOXVWQ4vjtq/wF4CTwF7gMrKa7dwAFgP7C3J/g8ICF9G8NYxlzqa8Eu4ERUw57bikMNpMz4fZReTZj1a+BLmU0SGBHGWLqq+EgQcaldiM1H23ERrgDPgEcR+G3MihL/EnznVEIGnnbKqVmGpa+JivcNi1yKOeXKuaBghRmKFJ0wc+E7ks91byvS18RmNWRaaWSgktC9HlVKSrIZMPeIuWLum1Et5r4dD2lBCduhqH7Eskqofs+GuVkNRi0BkVUodZCiXOhhJJGkTxaHkpvxsOnjpBZzPZa3fJikDr4Br+LD5HOs++qPkxYCpQ6c8W4swtb8NwIZ6G7scGLhR/I+zPx5/geOAICWvYItjwAAAABJRU5ErkJggg==',     // black star, used as a template image (macOS tints it for light / dark menu bars)
  win: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADx0lEQVR4XtWXz2tcVRTHP+fel4wjKIa2ASsUfzXETaxaTNOKGXFTdaOLySKKiAtd+TcM8yeIK124EOlistBVXYh0IjZpSkuwLmxQoVjcWEsXrQ5J3rtH7nl5mUwm0nmTKvgNgcvcH+fc+/2e770P9gH98HRFW/XqPpbADTNZG4183viBGRh9LTa1VffDrDVUAtTa+bwkvAz6irUP/S7/XQI3xtWCqZwAnrd2uxaGSaB01goioHr2gwp3/rgGPMSmHJY3z9xSRUTikMFRnoJGI0/6zs0JnDtEJbmPCsfst4V66fVKT9jmXzlFJfF4B4FIxVA6KJ9AwT/MWtBMIyEnrd3tGxilNLDN/8fvjTB2e43EP2aMZ9lvkB6VuYVOMWbQDMqdQMH/2J+P49wR0gBpULx/hFCZsKDFmAFRLoFa28Udgs5QHfEoadw/1QQkzFjMwiMGxEAJROczp+tM+RgddLaPPNnSQWfKx7HbbnkX9GnAdmjHmLudNBfjLnugrfk1Rv0EG5EDYDRxbGZrUj8z2Te2MZvkv9UCzabmG+jCErBs49HdGFeZW8j6A771JC48B5xA5AVUnyXY3GIDai0nl1H9DrhAcJdl7vOf+9eqe7Ptdi1Isxn6T0BV+OLtSYTjpNkphBlUJqkmoziBzQDrfYeSo5LASPQFhU66gehVlGUSfx7lEm98dlVEek9Az56u0DnwDE5eJNNplKeBR6l4b6ZrSs/iwWWo8e8Q2Vs7qiGqEbE/T+IhcdEnYD2LJ3sN4Xu8rBD0W6o3Vx3XE0/gQeAw8DCiB0lcHjxOtP+7SWkPxDnF/LiWrakHLUaMFWNeT6Kodwnsy3cfIKRPodm0ca4cR3mC+0e88TwIBTH4X5sZwi8Il0wT4ldwyY/y+qe3+0VYCKNWCyLNnmtVz80m3Dpy1DSRhZOoxuv32JbsekUIq4hcxLsl43zs15/kpd4qUm042l3B7yFCxG61qNR/rIoSZVhsLt4T9YWw+7reqtEddWn3ebcUe3xhesrLqx+tgy6ZD6xnWz7gHRvpRSvp+E5YuZJt1/0eZb0TfQnshhlHsxlZDXrO9Cggiyjv9LqTLFlf9UqWm9fiQModyIq3Ec0jz2GZjoksbsDTSWN1LltfyafZ/+s6Nmdo1b28/8kmKiuMFEbDqr0FYl9J1yhHQUT3+Z2THEOKLO3qGxjlEyg4Fs6znmbEQnBcsIj/9pPMyuweP8uHQvEZpq35r7U1/4MlVnyulUR5CnbqQDQevRlQ2adYgeESKHSQum9AvhqW/33jXnye/w1Y3rYP5r6/6gAAAABJRU5ErkJggg==',
};

let wallWin = null, tray = null, ctrlWin = null;
const CTRL = { closed: [94, 52], open: [272, 360] };   // control window size (px)
const state = { active: false };

function helperExe(nativeDir){
  const exe = path.join(nativeDir, 'capstellation-helper.exe');
  return fs.existsSync(exe) ? exe : null;
}
/** wallpaper.log in the app's data folder: what the desktop looked like and what happened (for troubleshooting). */
function log(...parts){
  try{
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(path.join(app.getPath('userData'), 'wallpaper.log'), `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
  }catch{}
}
function runHelper(nativeDir, args){
  return new Promise((ok, bad) => {
    const exe = helperExe(nativeDir);
    if (!exe){ log('helper missing in', nativeDir); return bad(new Error('capstellation-helper.exe is missing')); }
    execFile(exe, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      log(args[0], '→', (stdout || '').trim().replace(/\s*\n\s*/g, ' | '), err ? `ERROR ${(stderr || err.message).trim()}` : '');
      if (err) return bad(new Error((stderr || stdout || err.message).trim()));
      ok(stdout.trim());
    });
  });
}

/* ---------- macOS desktop picture (through the audiotap helper, which needs no extra permission) ---------- */
let macCtx = null;          // { nativeDir }
const tintDir = () => path.join(app.getPath('userData'), 'wallpaper');
const savedFile = () => path.join(app.getPath('userData'), 'wallpaper-original.json');
function tapRun(nativeDir, args){
  return new Promise((ok, bad) => {
    const bin = path.join(nativeDir, 'audiotap');
    if (!fs.existsSync(bin)) return bad(new Error('audiotap is missing'));
    execFile(bin, args, { timeout: 8000 }, (err, stdout, stderr) => err ? bad(new Error((stderr || err.message).trim())) : ok(stdout.trim()));
  });
}
/**
 * macOS: Electron's 'desktop' window type sits one layer *below* the desktop picture, so a normal
 * picture (like the menu-bar snapshot) covers it. Put the wallpaper one layer above the picture
 * and still well below the desktop icons.
 */
async function placeAboveDesktopPicture(nativeDir){
  let picture = -2147483623;                         // CGWindowLevelForKey(.desktopWindow) on current macOS
  try{ const [p] = (await tapRun(nativeDir, ['--desktop-levels'])).split(' ').map(Number); if (Number.isFinite(p)) picture = p; }
  catch(e){ console.warn('wallpaper: desktop levels:', e.message || e); }
  try{ wallWin.setAlwaysOnTop(true, 'normal', picture + 1); }       // 'normal' is level 0, so this lands at picture + 1
  catch(e){ console.warn('wallpaper: level:', e.message || e); }
}
async function rememberMacPicture(nativeDir){
  const [p, scaling, clip] = (await tapRun(nativeDir, ['--get-wallpaper'])).split('\t');
  // if it's already one of our snapshots (the app quit mid-way), keep the original we saved before
  if (!p || p.startsWith(tintDir())) return;
  fs.writeFileSync(savedFile(), JSON.stringify({ path: p, scaling, clip }));
}
let tintBusy = false, tintAgain = false;
/** Snapshot the wallpaper window and make it the real desktop picture, so the menu bar matches. */
async function tint(){
  if (process.platform !== 'darwin' || !wallWin || !macCtx) return;
  if (tintBusy){ tintAgain = true; return; }
  tintBusy = true;
  try{
    const img = await wallWin.webContents.capturePage();
    if (img.isEmpty()) return;
    fs.mkdirSync(tintDir(), { recursive: true });
    const file = path.join(tintDir(), `capstellation-${Date.now()}.jpg`);     // new name each time, or macOS keeps the cached one
    fs.writeFileSync(file, img.toJPEG(88));
    await tapRun(macCtx.nativeDir, ['--set-wallpaper', file]);
    for (const f of fs.readdirSync(tintDir())) if (path.join(tintDir(), f) !== file) fs.rmSync(path.join(tintDir(), f), { force: true });
  }catch(e){ console.warn('wallpaper tint:', e.message || e); }
  finally{ tintBusy = false; if (tintAgain){ tintAgain = false; setTimeout(tint, 500); } }
}
async function restoreMacPicture(nativeDir){
  try{
    const o = JSON.parse(fs.readFileSync(savedFile(), 'utf8'));
    if (o.path && fs.existsSync(o.path)) await tapRun(nativeDir, ['--set-wallpaper', o.path, String(o.scaling ?? 3), String(o.clip ?? 1)]);
    fs.rmSync(savedFile(), { force: true });
    fs.rmSync(tintDir(), { recursive: true, force: true });
  }catch{}
}

function makeTray(onStop){
  if (tray) return;
  const img = nativeImage.createFromBuffer(Buffer.from(process.platform === 'darwin' ? ICON.mac : ICON.win, 'base64'), { scaleFactor: 2 });
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Capstellation wallpaper');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Capstellation is your wallpaper', enabled: false },
    { type: 'separator' },
    { label: 'Stop Wallpaper', click: onStop },
    { label: 'Quit Capstellation', click: () => app.quit() },
  ]));
  if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu());
}

/** Tell the page how much of the screen the menu bar, Dock or taskbar covers, so nothing hides under them. */
function sendInsets(){
  if (!wallWin || wallWin.isDestroyed()) return;
  const d = screen.getPrimaryDisplay(), b = d.bounds, w = d.workArea;
  const t = w.y - b.y, l = w.x - b.x, r = b.x + b.width - (w.x + w.width), bt = b.y + b.height - (w.y + w.height);
  wallWin.webContents.executeJavaScript(`typeof setWallInsets === 'function' && setWallInsets(${t},${r},${bt},${l})`).catch(() => {});
}

/** The small shuffle / settings control in the top-left corner (the wallpaper itself can't be clicked). */
function makeControls(url){
  const w = screen.getPrimaryDisplay().workArea;
  ctrlWin = new BrowserWindow({
    x: w.x, y: w.y, width: CTRL.closed[0], height: CTRL.closed[1],
    frame: false, transparent: true, hasShadow: false, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, show: false, title: 'Capstellation',
    acceptFirstMouse: true,          // macOS: the first click works even when another app is in front
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (process.platform === 'darwin') ctrlWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  ctrlWin.on('closed', () => { ctrlWin = null; });
  ctrlWin.loadURL(url + 'controls.html');
  ctrlWin.once('ready-to-show', () => ctrlWin && ctrlWin.showInactive());
}
function controls(open){
  if (!ctrlWin || ctrlWin.isDestroyed()) return { ok: false };
  const [width, height] = open ? CTRL.open : CTRL.closed, b = ctrlWin.getBounds();
  ctrlWin.setBounds({ x: b.x, y: b.y, width, height });
  return { ok: true };
}

/** Start wallpaper mode. Resolves once it's showing; rejects with a readable error. */
async function start({ url, nativeDir, onStop }){
  if (state.active) return;
  const b = screen.getPrimaryDisplay().bounds;
  const mac = process.platform === 'darwin';
  wallWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    type: mac ? 'desktop' : undefined,
    frame: false, show: false, skipTaskbar: true, focusable: false, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    enableLargerThanScreen: true, roundedCorners: false,
    backgroundColor: '#050505', title: 'Capstellation wallpaper',
    // keep drawing even when macOS thinks the desktop is covered
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  wallWin.setIgnoreMouseEvents(true);
  if (mac) wallWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  wallWin.on('closed', () => { wallWin = null; });
  wallWin.webContents.on('did-finish-load', sendInsets);
  await wallWin.loadURL(url + '?wallpaper=1');

  if (process.platform === 'win32'){
    wallWin.showInactive();
    const hwnd = wallWin.getNativeWindowHandle();
    const handle = (hwnd.length >= 8 ? hwnd.readBigUInt64LE(0) : BigInt(hwnd.readUInt32LE(0))).toString();
    try{
      await runHelper(nativeDir, ['--wallpaper', handle, String(b.x), String(b.y), String(b.width), String(b.height)]);
    }catch(e){
      wallWin.destroy(); wallWin = null;
      throw e;
    }
  } else {
    await placeAboveDesktopPicture(nativeDir);
    wallWin.showInactive();
    macCtx = { nativeDir };
    try{ await rememberMacPicture(nativeDir); }catch(e){ console.warn('wallpaper:', e.message || e); }
    setTimeout(tint, 2500);              // once the page has drawn its background
  }
  state.active = true;
  sendInsets();
  makeControls(url);
  makeTray(onStop);
  // follow display changes (resolution, docking a laptop)
  screen.on('display-metrics-changed', refit);
}

function refit(){
  if (!wallWin) return;
  const b = screen.getPrimaryDisplay().bounds;
  if (process.platform === 'darwin') wallWin.setBounds(b);
  sendInsets();
  if (ctrlWin){ const w = screen.getPrimaryDisplay().workArea, c = ctrlWin.getBounds(); ctrlWin.setBounds({ ...c, x: w.x, y: w.y }); }
}

/** Stop wallpaper mode and put the normal desktop picture back. */
async function stop({ nativeDir } = {}){
  if (!state.active && !wallWin) return;
  state.active = false;
  screen.removeListener('display-metrics-changed', refit);
  if (wallWin){ wallWin.destroy(); wallWin = null; }
  if (ctrlWin){ ctrlWin.destroy(); ctrlWin = null; }
  if (process.platform === 'darwin' && macCtx){ const d = macCtx.nativeDir; macCtx = null; await restoreMacPicture(d); }
  if (tray){ tray.destroy(); tray = null; }
  if (process.platform === 'win32' && nativeDir){
    try{ await runHelper(nativeDir, ['--wallpaper-restore']); }catch{}   // repaint the normal wallpaper
  }
}

module.exports = { start, stop, state, tint, controls };
