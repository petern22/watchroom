const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences } = require('electron');
const path = require('node:path');
const { checkForUpdate } = require('./updates');
const pkg = require('./package.json');

// The share the user picked in the renderer. Consumed by the display-media
// handler below, so a page can only capture what the user explicitly chose.
let pendingShare = null;

const isMac = process.platform === 'darwin';

// Invite links: watchroom://join/ABC123 opens the app with that room code filled in.
const INVITE = /^watchroom:\/\/join\/([A-Za-z0-9]{6})\/?$/;
let pendingInvite = null;

function inviteFrom(args) {
  const link = args.find((arg) => typeof arg === 'string' && arg.startsWith('watchroom://'));
  const match = link && link.match(INVITE);
  return match ? match[1].toUpperCase() : null;
}

function deliverInvite(code) {
  if (!code) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    pendingInvite = code;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('invite', code);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Watchroom',
    backgroundColor: '#0b0c0d',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 22 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

function listSources(excludeId) {
  return desktopCapturer
    .getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: false,
    })
    .then((sources) =>
      sources
        .filter((source) => source.id !== excludeId && source.name.trim() !== '')
        .map((source) => ({
          id: source.id,
          name: source.name,
          kind: source.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: source.thumbnail.toDataURL(),
        })),
    );
}

function registerIpc() {
  ipcMain.handle('sources:list', (event) => {
    const own = BrowserWindow.fromWebContents(event.sender);
    return listSources(own ? own.getMediaSourceId() : null);
  });

  ipcMain.handle('share:prepare', (_event, { sourceId, audio }) => {
    if (typeof sourceId !== 'string' || sourceId.length > 200) throw new Error('Invalid source');
    pendingShare = { sourceId, audio: Boolean(audio) };
    return true;
  });

  ipcMain.handle('share:cancel', () => {
    pendingShare = null;
    return true;
  });

  ipcMain.handle('system:screen-access', () => {
    if (!isMac) return 'granted';
    return systemPreferences.getMediaAccessStatus('screen');
  });

  ipcMain.handle('system:open-screen-settings', () => {
    if (isMac) {
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
    return false;
  });

  ipcMain.handle('updates:check', () =>
    checkForUpdate({
      owner: pkg.watchroomUpdates?.owner,
      repo: pkg.watchroomUpdates?.repo,
      currentVersion: app.getVersion(),
    }),
  );

  // Only ever opens GitHub download pages, never arbitrary links from the page.
  ipcMain.handle('updates:open', (_event, url) => {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) shell.openExternal(url);
    return true;
  });

  // Optional relay servers for networks that block direct connections. Empty until one is set in package.json.
  ipcMain.handle('config:turn', () => pkg.watchroomTurn || []);

  ipcMain.handle('invite:pending', () => {
    const code = pendingInvite;
    pendingInvite = null;
    return code;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));
}

pendingInvite = inviteFrom(process.argv);
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverInvite(inviteFrom([url]));
});
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => deliverInvite(inviteFrom(argv)));
}

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('watchroom');
  // Only the renderer's own page may capture, and only the source chosen in the picker.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const choice = pendingShare;
      pendingShare = null;
      if (!choice) return callback({});

      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((item) => item.id === choice.sourceId);
      if (!source) return callback({});

      callback(choice.audio ? { video: source, audio: 'loopback' } : { video: source });
    },
    { useSystemPicker: false },
  );

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'display-capture', 'notifications', 'fullscreen'].includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    ['media', 'display-capture', 'fullscreen'].includes(permission),
  );

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
