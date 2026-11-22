'use strict';
// Capstellation desktop app: starts the local server (server.js) and shows the UI in its own window.
const { app, BrowserWindow, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer, PLATFORM } = require('./server');
const { checkForUpdates } = require('./updater');
const wallpaper = require('./wallpaper');

// Packaged app: web UI + native helper live in Resources. Development: straight from the repo.
const repoRoot = path.join(__dirname, '..');
const paths = app.isPackaged
  ? { root: path.join(process.resourcesPath, 'web'), nativeDir: path.join(process.resourcesPath, 'native'), repoRoot: null }
  : { root: repoRoot, nativeDir: path.join(__dirname, 'native-bin', PLATFORM), repoRoot };

let server = null, mainWin = null;

/* ---------- app settings kept by the app itself (the page's own settings live in its storage) ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings(){ try{ return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); }catch{ return {}; } }
function writeSettings(patch){
  const s = { ...readSettings(), ...patch };
  try{ fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }catch{}
  return s;
}
/** Open at login: on unless turned off. Re-applied every launch so it points at the current copy of the app. */
function applyOpenAtLogin(){
  const on = readSettings().openAtLogin !== false;
  if (app.isPackaged){ try{ app.setLoginItemSettings({ openAtLogin: on }); }catch{} }
  return on;
}

/** Wallpaper mode: the page's "Use as wallpaper" button (via the local server) or the menu. */
async function startWallpaper(){
  server = server || await startServer({ ...paths, hooks });
  await wallpaper.start({ url: server.url, nativeDir: paths.nativeDir, onStop: stopWallpaper });
  if (mainWin && !mainWin.isDestroyed()){
    if (mainWin.isFullScreen()){                 // macOS: leave the fullscreen Space before hiding, or it stays behind empty
      await new Promise(ok => { mainWin.once('leave-full-screen', ok); mainWin.setFullScreen(false); setTimeout(ok, 1500); });
    }
    mainWin.hide();
  }
  writeSettings({ wallpaper: true });            // come back as the wallpaper next time
}
async function stopWallpaper(){
  writeSettings({ wallpaper: false });
  await wallpaper.stop({ nativeDir: paths.nativeDir });
  if (mainWin && !mainWin.isDestroyed()) mainWin.show(); else createWindow();
}
const hooks = {
  wallpaper: async on => {
    try{ await (on ? startWallpaper() : stopWallpaper()); return { ok: true }; }
    catch(e){ return { ok: false, error: String(e.message || e) }; }
  },
  tint: () => { wallpaper.tint(); return { ok: true }; },
  controls: (open, h) => wallpaper.controls(open, h),
  screens: body => wallpaper.screens(body),
  startup: on => {
    if (typeof on === 'boolean') writeSettings({ openAtLogin: on });
    return { ok: true, on: applyOpenAtLogin(), packaged: app.isPackaged };
  },               // open / close the corner control's settings   // the wallpaper page drew a new background
};

async function createWindow(){
  server = server || await startServer({ ...paths, hooks });
  const win = mainWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 420,
    title: 'Capstellation',
    backgroundColor: '#050505',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => {
    win.show();
    setTimeout(() => checkForUpdates(win).catch(() => {}), 2500);   // ask about updates once the window is up
    // and every 6 hours while it's open (not while it's quietly being the wallpaper)
    setInterval(() => { if (!wallpaper.state.active && !win.isDestroyed()) checkForUpdates(win).catch(() => {}); }, 6 * 3600 * 1000);
  });

  // Links open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    const u = new URL(url);
    const ok = u.origin === new URL(server.url).origin;
    if (!ok){ e.preventDefault(); shell.openExternal(url); }
  });
  win.loadURL(server.url);
}

app.whenReady().then(() => {
  applyOpenAtLogin();
  // the page may use the microphone (Listen → Mic) and fullscreen; nothing else
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(['media', 'fullscreen'].includes(permission)));
  // menu: standard app menu plus "Check for Updates…" (Windows has no menu bar; use Ctrl+U)
  const checkNow = () => { if (mainWin && !mainWin.isDestroyed()) checkForUpdates(mainWin, { quiet: false }).catch(() => {}); };
  const toggleWallpaper = () => hooks.wallpaper(!wallpaper.state.active);
  if (process.platform === 'darwin'){
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: checkNow },
        { label: 'Use as Wallpaper / Stop', click: toggleWallpaper },
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' } ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [ { role: 'reload' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' } ] },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'App', visible: false, submenu: [
        { label: 'Check for Updates…', accelerator: 'Ctrl+U', click: checkNow },
        { label: 'Use as Wallpaper', accelerator: 'Ctrl+Shift+W', click: toggleWallpaper } ] },
    ]));
  }
  // open the way it was left: as the wallpaper (quitting keeps that choice), or as a window
  const launchedAt = Date.now();
  if (readSettings().wallpaper){
    startWallpaper().catch(e => { console.warn('wallpaper:', e.message || e); writeSettings({ wallpaper: false }); createWindow(); });
  } else createWindow();
  // clicking the Dock icon brings the normal window back (and stops wallpaper mode)
  app.on('activate', () => {
    if (Date.now() - launchedAt < 4000) return;     // macOS also sends this while the app is starting up
    if (wallpaper.state.active) stopWallpaper();
    else if (!mainWin || mainWin.isDestroyed()) createWindow();
  });
});

// closing the window while it's the wallpaper keeps the wallpaper going (stop it from the tray icon)
app.on('window-all-closed', () => { if (!wallpaper.state.active){ server?.close(); app.quit(); } });
app.on('before-quit', () => { wallpaper.stop({ nativeDir: paths.nativeDir }); });
