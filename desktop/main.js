'use strict';
// Capstellation desktop app: starts the local server (server.js) and shows the UI in its own window.
const { app, BrowserWindow, session, shell, Menu } = require('electron');
const path = require('path');
const { startServer, PLATFORM } = require('./server');

// Packaged app: web UI + native helper live in Resources. Development: straight from the repo.
const repoRoot = path.join(__dirname, '..');
const paths = app.isPackaged
  ? { root: path.join(process.resourcesPath, 'web'), nativeDir: path.join(process.resourcesPath, 'native'), repoRoot: null }
  : { root: repoRoot, nativeDir: path.join(__dirname, 'native-bin', PLATFORM), repoRoot };

let server = null;

async function createWindow(){
  server = server || await startServer(paths);
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 420,
    title: 'Capstellation',
    backgroundColor: '#050505',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());

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
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { server?.close(); app.quit(); });
