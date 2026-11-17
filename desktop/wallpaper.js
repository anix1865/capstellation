'use strict';
// Wallpaper mode: a second, click-through window that sits behind the desktop icons and shows
// the same page (with ?wallpaper=1, so no controls). A menu bar / tray icon turns it off again.
//
//   macOS:   a window at the desktop level (Electron's type: 'desktop'), on every Space.
//   Windows: the window is re-parented behind the desktop icons by capstellation-helper.exe
//            (--wallpaper), the same trick wallpaper apps use.
const { BrowserWindow, Tray, Menu, nativeImage, screen, app } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const ICON = {
  mac: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACWUlEQVR4Xr2XSYsUQRCFPx3Xg4KgMHoS3A/iijuKeBJ/swfFHWUQBB3UwYPg0YMHcRvlKyLG7O5qrMzu9kFBdVdFxIuIl5FZMBu2AztncbG50TjtLgN3wsdSi69ZCdwCbkfgTS0EtrQYAb/D7hKwHPfrjb6qkZna/0/AV2BPaxVaWpAEjgL7gB3A6SBQ7a/aADZsrsKG8GyFqNZBC4Hs/42ieVfiPp8tDJnhVmAtxGjQj8U8qK5CDbJix4CfQUD1S+JUiw5qW+D7ZugAcvBI4lcE9r9SI4MwlIDvGdDLbMv+J1IH+d5Q3xMwQ40dUtMG1WoQMXsvSb2ZknL6yeqNIAXjQy8dZUlLHAbOQbfcrgFnoxVpn+p/ATwAnkB3/66HlBXSTu2s9ynW/44D56Fb6/bW39sGNfUvvkdVHgMPgefxe2SpGsyRega4DlwMNR8shkwiS53V6kOXVWQ4vjtq/wF4CTwF7gMrKa7dwAFgP7C3J/g8ICF9G8NYxlzqa8Eu4ERUw57bikMNpMz4fZReTZj1a+BLmU0SGBHGWLqq+EgQcaldiM1H23ERrgDPgEcR+G3MihL/EnznVEIGnnbKqVmGpa+JivcNi1yKOeXKuaBghRmKFJ0wc+E7ks91byvS18RmNWRaaWSgktC9HlVKSrIZMPeIuWLum1Et5r4dD2lBCduhqH7Eskqofs+GuVkNRi0BkVUodZCiXOhhJJGkTxaHkpvxsOnjpBZzPZa3fJikDr4Br+LD5HOs++qPkxYCpQ6c8W4swtb8NwIZ6G7scGLhR/I+zPx5/geOAICWvYItjwAAAABJRU5ErkJggg==',     // black star, used as a template image (macOS tints it for light / dark menu bars)
  win: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADx0lEQVR4XtWXz2tcVRTHP+fel4wjKIa2ASsUfzXETaxaTNOKGXFTdaOLySKKiAtd+TcM8yeIK124EOlistBVXYh0IjZpSkuwLmxQoVjcWEsXrQ5J3rtH7nl5mUwm0nmTKvgNgcvcH+fc+/2e770P9gH98HRFW/XqPpbADTNZG4183viBGRh9LTa1VffDrDVUAtTa+bwkvAz6irUP/S7/XQI3xtWCqZwAnrd2uxaGSaB01goioHr2gwp3/rgGPMSmHJY3z9xSRUTikMFRnoJGI0/6zs0JnDtEJbmPCsfst4V66fVKT9jmXzlFJfF4B4FIxVA6KJ9AwT/MWtBMIyEnrd3tGxilNLDN/8fvjTB2e43EP2aMZ9lvkB6VuYVOMWbQDMqdQMH/2J+P49wR0gBpULx/hFCZsKDFmAFRLoFa28Udgs5QHfEoadw/1QQkzFjMwiMGxEAJROczp+tM+RgddLaPPNnSQWfKx7HbbnkX9GnAdmjHmLudNBfjLnugrfk1Rv0EG5EDYDRxbGZrUj8z2Te2MZvkv9UCzabmG+jCErBs49HdGFeZW8j6A771JC48B5xA5AVUnyXY3GIDai0nl1H9DrhAcJdl7vOf+9eqe7Ptdi1Isxn6T0BV+OLtSYTjpNkphBlUJqkmoziBzQDrfYeSo5LASPQFhU66gehVlGUSfx7lEm98dlVEek9Az56u0DnwDE5eJNNplKeBR6l4b6ZrSs/iwWWo8e8Q2Vs7qiGqEbE/T+IhcdEnYD2LJ3sN4Xu8rBD0W6o3Vx3XE0/gQeAw8DCiB0lcHjxOtP+7SWkPxDnF/LiWrakHLUaMFWNeT6Kodwnsy3cfIKRPodm0ca4cR3mC+0e88TwIBTH4X5sZwi8Il0wT4ldwyY/y+qe3+0VYCKNWCyLNnmtVz80m3Dpy1DSRhZOoxuv32JbsekUIq4hcxLsl43zs15/kpd4qUm042l3B7yFCxG61qNR/rIoSZVhsLt4T9YWw+7reqtEddWn3ebcUe3xhesrLqx+tgy6ZD6xnWz7gHRvpRSvp+E5YuZJt1/0eZb0TfQnshhlHsxlZDXrO9Cggiyjv9LqTLFlf9UqWm9fiQModyIq3Ec0jz2GZjoksbsDTSWN1LltfyafZ/+s6Nmdo1b28/8kmKiuMFEbDqr0FYl9J1yhHQUT3+Z2THEOKLO3qGxjlEyg4Fs6znmbEQnBcsIj/9pPMyuweP8uHQvEZpq35r7U1/4MlVnyulUR5CnbqQDQevRlQ2adYgeESKHSQum9AvhqW/33jXnye/w1Y3rYP5r6/6gAAAABJRU5ErkJggg==',
};

let wallWin = null, tray = null;
const state = { active: false };

function helperExe(nativeDir){
  const exe = path.join(nativeDir, 'capstellation-helper.exe');
  return fs.existsSync(exe) ? exe : null;
}
function runHelper(nativeDir, args){
  return new Promise((ok, bad) => {
    const exe = helperExe(nativeDir);
    if (!exe) return bad(new Error('capstellation-helper.exe is missing'));
    execFile(exe, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return bad(new Error((stderr || stdout || err.message).trim()));
      ok(stdout.trim());
    });
  });
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  wallWin.setIgnoreMouseEvents(true);
  if (mac) wallWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  wallWin.on('closed', () => { wallWin = null; });
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
    wallWin.showInactive();
  }
  state.active = true;
  makeTray(onStop);
  // follow display changes (resolution, docking a laptop)
  screen.on('display-metrics-changed', refit);
}

function refit(){
  if (!wallWin) return;
  const b = screen.getPrimaryDisplay().bounds;
  if (process.platform === 'darwin') wallWin.setBounds(b);
}

/** Stop wallpaper mode and put the normal desktop picture back. */
async function stop({ nativeDir } = {}){
  if (!state.active && !wallWin) return;
  state.active = false;
  screen.removeListener('display-metrics-changed', refit);
  if (wallWin){ wallWin.destroy(); wallWin = null; }
  if (tray){ tray.destroy(); tray = null; }
  if (process.platform === 'win32' && nativeDir){
    try{ await runHelper(nativeDir, ['--wallpaper-restore']); }catch{}   // repaint the normal wallpaper
  }
}

module.exports = { start, stop, state };
