const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { checkForUpdate } = require('./updates');
const pkg = require('./package.json');

// The share the user picked in the renderer. Consumed by the display-media
// handler below, so a page can only capture what the user explicitly chose.
let pendingShare = null;

const isMac = process.platform === 'darwin';

// Invite links: watchroom://join/ABC123 opens the app with that room code filled in.
const INVITE = /^watchroom:\/\/join\/([A-Za-z0-9]{6})\/?$/;
let pendingInvite = null;
const rendererUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;

function isTrustedContents(webContents) {
  return Boolean(webContents && !webContents.isDestroyed() && webContents.getURL() === rendererUrl);
}

function assertTrustedEvent(event) {
  if (!isTrustedContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted renderer');
}

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
    if (url.startsWith('https://github.com/')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
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
    assertTrustedEvent(event);
    const own = BrowserWindow.fromWebContents(event.sender);
    return listSources(own ? own.getMediaSourceId() : null);
  });

  ipcMain.handle('share:prepare', (event, { sourceId, audio }) => {
    assertTrustedEvent(event);
    if (typeof sourceId !== 'string' || sourceId.length > 200) throw new Error('Invalid source');
    pendingShare = { sourceId, audio: Boolean(audio), frame: event.senderFrame, expires: Date.now() + 15000 };
    return true;
  });

  ipcMain.handle('share:cancel', (event) => {
    assertTrustedEvent(event);
    pendingShare = null;
    return true;
  });

  ipcMain.handle('system:screen-access', (event) => {
    assertTrustedEvent(event);
    if (!isMac) return 'granted';
    return systemPreferences.getMediaAccessStatus('screen');
  });

  ipcMain.handle('system:open-screen-settings', (event) => {
    assertTrustedEvent(event);
    if (isMac) {
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
    return false;
  });

  ipcMain.handle('updates:check', (event) => {
    assertTrustedEvent(event);
    return checkForUpdate({
      owner: pkg.watchroomUpdates?.owner,
      repo: pkg.watchroomUpdates?.repo,
      currentVersion: app.getVersion(),
    });
  });

  // Only ever opens GitHub download pages, never arbitrary links from the page.
  ipcMain.handle('updates:open', (event, url) => {
    assertTrustedEvent(event);
    if (typeof url === 'string' && url.startsWith('https://github.com/')) shell.openExternal(url);
    return true;
  });

  // Optional relay servers for networks that block direct connections. Empty until one is set in package.json.
  // Short-lived relay logins from the Cloudflare Worker, fetched fresh for each room. Falls back to any static list.
  ipcMain.handle('config:turn', async (event) => {
    assertTrustedEvent(event);
    if (pkg.watchroomTurnUrl) {
      try {
        const response = await fetch(pkg.watchroomTurnUrl, { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.iceServers)) return data.iceServers;
        }
      } catch {
        /* no connection to the relay service; the app still works on direct connections */
      }
    }
    return pkg.watchroomTurn || [];
  });

  // Our own room-discovery relay. Used in addition to the public ones, never instead of them.
  ipcMain.handle('config:relay', (event) => {
    assertTrustedEvent(event);
    return pkg.watchroomRelayUrl || '';
  });

  // Test switch only: WATCHROOM_FORCE_RELAY=1 sends every call through the relay, to prove the relay works.
  ipcMain.handle('config:force-relay', (event) => {
    assertTrustedEvent(event);
    return process.env.WATCHROOM_FORCE_RELAY === '1';
  });

  ipcMain.handle('invite:pending', (event) => {
    assertTrustedEvent(event);
    const code = pendingInvite;
    pendingInvite = null;
    return code;
  });

  ipcMain.handle('app:info', (event) => {
    assertTrustedEvent(event);
    return { version: app.getVersion(), platform: process.platform };
  });
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
    async (request, callback) => {
      const choice = pendingShare;
      pendingShare = null;
      if (!choice || choice.frame !== request.frame || Date.now() > choice.expires) return callback({});

      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] }).catch(() => []);
      const source = sources.find((item) => item.id === choice.sourceId);
      if (!source) return callback({});

      callback(choice.audio ? { video: source, audio: 'loopback' } : { video: source });
    },
    { useSystemPicker: false },
  );

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isTrustedContents(webContents) && ['media', 'display-capture', 'fullscreen'].includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    isTrustedContents(webContents) && requestingOrigin === 'file://' && ['media', 'display-capture', 'fullscreen'].includes(permission),
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
