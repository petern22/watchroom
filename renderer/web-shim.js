// Browser adapter. The desktop shell gives the page window.watchroom; in a browser (the installed web app) there is no shell,
// so this fills in the same interface with browser equivalents. Inside the desktop app it does nothing.

const TURN_URL = 'https://watchroom-turn.peterndrio.workers.dev';
const VERSION = typeof __WEB_VERSION__ === 'string' ? __WEB_VERSION__ : '1.0.3';

if (!window.watchroom) {
  const params = new URLSearchParams(location.hash.slice(1) || location.search);
  const invite = (params.get('join') || '').toUpperCase();

  window.watchroom = {
    platform: 'web',
    isWeb: true,
    appInfo: async () => ({ version: VERSION, platform: 'web' }),
    // The browser shows its own picker for screens, windows and tabs, so there is no source list to build.
    listSources: async () => [],
    prepareShare: async () => true,
    cancelShare: async () => true,
    screenAccess: async () => 'granted',
    openScreenSettings: async () => false,
    // A website is always the newest version, so there is nothing to check or download.
    checkForUpdates: async () => ({ status: 'web' }),
    openUpdate: async () => true,
    pendingInvite: async () => (/^[A-Z0-9]{6}$/.test(invite) ? invite : null),
    onInvite: () => {},
    turnServers: async () => {
      try {
        const response = await fetch(TURN_URL, { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.iceServers)) return data.iceServers;
        }
      } catch {
        /* no connection to the relay service; direct connections still work */
      }
      return [];
    },
    copyText: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Older browsers and some embedded views: select a hidden field and copy it.
        const field = document.createElement('textarea');
        field.value = text;
        field.style.cssText = 'position:fixed;opacity:0';
        document.body.append(field);
        field.select();
        const ok = document.execCommand('copy');
        field.remove();
        return ok;
      }
    },
    relayUrl: async () => 'wss://watchroom-relay.peterndrio.workers.dev',
    forceRelay: async () => false,
  };

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
