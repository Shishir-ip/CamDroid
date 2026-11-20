const { app, BrowserWindow, protocol, net, ipcMain, dialog, Tray, Menu, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Keep the renderer fully active when the window is hidden/minimized to tray.
// Without this, Chromium throttles timers and pauses requestAnimationFrame in
// the background, which freezes the virtual-camera output in other apps.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');

function openExternal(url) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported URL scheme');
  return shell.openExternal(parsed.href);
}
const discovery = require('./discovery');
const vcam = require('./virtualcam');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'dist', 'renderer');

let win = null;
let tray = null;

// ---------------------------------------------------------------- settings

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = {
  theme: 'dark',
  autoConnect: true,
  autoStart: false,
  lastDevice: null,
  vcam: { width: 1280, height: 720, fps: 30 }
};

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  } catch {}
  return s;
}

// ---------------------------------------------------------------- window

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#101013',
    show: false,
    autoHideMenuBar: true,
    title: 'CamDroid',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  win.webContents.setBackgroundThrottling(false);

  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== 'app://bundle/index.html') event.preventDefault();
  });
  win.on('close', (event) => {
    if (tray && !app.isQuitting) { event.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.loadURL('app://bundle/index.html');
}

function sendDevices(list) {
  if (win && !win.isDestroyed()) win.webContents.send('devices', list);
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    try {
      const url = new URL(req.url);
      if (url.hostname !== 'bundle') return new Response('forbidden', { status: 403 });
      const rel = decodeURIComponent(url.pathname);
      const filePath = path.resolve(RENDERER_DIR, '.' + (rel === '/' ? '/index.html' : rel));
      const relative = path.relative(RENDERER_DIR, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return new Response('forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(filePath).href);
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });

  createWindow();
  discovery.start(sendDevices);
  vcam.init(app);

  // Tray
  try {
    tray = new Tray(path.join(ROOT, 'assets', 'tray.png'));
    tray.setToolTip('CamDroid');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open CamDroid', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit(); } }
    ]));
    tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  } catch {}

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopPowerBlock();
  vcam.shutdown();
  discovery.stop();
  if (tray) { tray.destroy(); tray = null; }
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));

ipcMain.handle('devices:refresh', () => discovery.refresh());
ipcMain.handle('adb:status', () => discovery.adbStatus());

ipcMain.handle('vcam:status', () => vcam.status());
ipcMain.handle('vcam:enable', (_e, opts) => {
  const s = vcam.enable(opts);
  if (s.active) startPowerBlock();
  return s;
});
ipcMain.handle('vcam:disable', () => {
  const s = vcam.disable();
  stopPowerBlock();
  return s;
});
ipcMain.on('vcam:frame', (_e, payload) => vcam.sendFrame(payload));

// Prevent the system from sleeping/suspending the app while the camera is live.
let powerBlockId = null;
function startPowerBlock() {
  if (powerBlockId === null || !powerSaveBlocker.isStarted(powerBlockId)) {
    powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
  }
}
function stopPowerBlock() {
  if (powerBlockId !== null && powerSaveBlocker.isStarted(powerBlockId)) {
    powerSaveBlocker.stop(powerBlockId);
  }
  powerBlockId = null;
}

ipcMain.handle('file:save', async (_e, { name, data, filters }) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: name,
    filters: filters || [{ name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  fs.writeFileSync(res.filePath, Buffer.from(data));
  return { ok: true, path: res.filePath };
});

ipcMain.handle('win:alwaysOnTop', (_e, on) => { if (win) win.setAlwaysOnTop(!!on); return !!on; });
ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('app:autoStart', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  saveSettings({ autoStart: !!on });
  return !!on;
});
ipcMain.handle('shell:open', (_e, url) => openExternal(url));
ipcMain.handle('app:version', () => app.getVersion());

// Hidden autostart: start minimized to tray.
if (process.argv.includes('--hidden')) {
  app.whenReady().then(() => { if (win) win.hide(); });
}