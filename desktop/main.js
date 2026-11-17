'use strict';
// Capstellation desktop app: starts the local server (server.js) and shows the UI in its own window.
const { app, BrowserWindow, session, shell, Menu } = require('electron');
const path = require('path');
const { startServer, PLATFORM } = require('./server');
const { checkForUpdates } = require('./updater');
const wallpaper = require('./wallpaper');

// Packaged app: web UI + native helper live in Resources. Development: straight from the repo.
const repoRoot = path.join(__dirname, '..');
const paths = app.isPackaged
  ? { root: path.join(process.resourcesPath, 'web'), nativeDir: path.join(process.resourcesPath, 'native'), repoRoot: null }
  : { root: repoRoot, nativeDir: path.join(__dirname, 'native-bin', PLATFORM), repoRoot };

let server = null, mainWin = null;

/** Wallpaper mode: the page's "Use as wallpaper" button (via the local server) or the menu. */
async function startWallpaper(){
  await wallpaper.start({ url: server.url, nativeDir: paths.nativeDir, onStop: stopWallpaper });
  if (mainWin && !mainWin.isDestroyed()){
    if (mainWin.isFullScreen()){                 // macOS: leave the fullscreen Space before hiding, or it stays behind empty
      await new Promise(ok => { mainWin.once('leave-full-screen', ok); mainWin.setFullScreen(false); setTimeout(ok, 1500); });
    }
    mainWin.hide();
  }
}
async function stopWallpaper(){
  await wallpaper.stop({ nativeDir: paths.nativeDir });
  if (mainWin && !mainWin.isDestroyed()) mainWin.show(); else createWindow();
}
const hooks = {
  wallpaper: async on => {
    try{ await (on ? startWallpaper() : stopWallpaper()); return { ok: true }; }
    catch(e){ return { ok: false, error: String(e.message || e) }; }
  },
  tint: () => { wallpaper.tint(); return { ok: true }; },   // the wallpaper page drew a new background
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

  // Links (AudD, Spotify dashboard…) open in the normal browser; Spotify login stays in-app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    const u = new URL(url);
    const ok = u.origin === new URL(server.url).origin || u.hostname === 'accounts.spotify.com';
    if (!ok){ e.preventDefault(); shell.openExternal(url); }
  });
  win.loadURL(server.url);
}

app.whenReady().then(() => {
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
  createWindow();
  // clicking the Dock icon brings the normal window back (and stops wallpaper mode)
  app.on('activate', () => {
    if (wallpaper.state.active) stopWallpaper();
    else if (!mainWin || mainWin.isDestroyed()) createWindow();
  });
});

// closing the window while it's the wallpaper keeps the wallpaper going (stop it from the tray icon)
app.on('window-all-closed', () => { if (!wallpaper.state.active){ server?.close(); app.quit(); } });
app.on('before-quit', () => { wallpaper.stop({ nativeDir: paths.nativeDir }); });
