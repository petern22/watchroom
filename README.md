# Watchroom

Watch together. Share a screen or window with family and friends, with voice and chat.
Nothing to pay for, no accounts, no server to run.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

## Use it

1. Enter your name and press **Start a room**. You get a six-character code.
2. Send the code to the others. They enter your name, type the code, and press **Join room**.
3. Press **Share screen**, pick a screen or window, choose resolution and frame rate, and press **Put it on the board**.
4. Everyone sees the shared screen live. Mic and chat are in the dock and the side panel.

Press `M` to toggle your mic.

## What works, and what does not

- **Works:** Stremio, browser tabs, local files, YouTube, Jellyfin, Plex, games, any window.
- **Does not work:** Netflix, Disney+ and other DRM-protected streams show black frames in any screen share. This is set by the streaming service, not the app.

## Quality and frame rate

| Resolution | 30 fps | 60 fps |
| --- | --- | --- |
| 720p | 3 Mbps per viewer | 4.5 Mbps |
| 1080p | 6 Mbps | 9 Mbps |
| 1440p | 10 Mbps | 14 Mbps |
| 4K | 16 Mbps | 22 Mbps |

Each viewer gets its own stream, so the sharer's upload is the bitrate times the number of viewers.
The app caps the total at **25 Mbps** and shows the estimate in the picker.
With a typical home upload, 4K at 60 fps is realistic for one or two viewers only.

4K at 60 fps also needs a recent graphics card on the sharing computer.

## Requirements and permissions

- **macOS:** Screen Recording must be allowed for Watchroom (System Settings → Privacy & Security → Screen Recording). Restart the app after allowing it. System sound sharing needs macOS 13 or newer.
- **Windows:** system sound sharing works out of the box.
- **Microphone:** asked once when you join a room.

## Connection limits

- Media goes directly between computers (WebRTC). Strict networks, such as some cellular or corporate connections, may fail to connect without a relay server.
- Signaling uses public Nostr relays. If one relay is down or rate-limits, the others are used.
- Rooms support up to eight people. Media and room messages use WebRTC encryption and are not stored by Watchroom. Public relays handle peer discovery and can observe connection metadata.
- Watchroom shares a picture of a window. It cannot press play, pause or seek in the app being shared, so playback is not synchronized. The person sharing controls it.
- Rooms are not stored. When everyone leaves, the room is gone.

## Build installers

```bash
npm run dist
```

This writes a macOS `.dmg` and a Windows `.exe` installer to `release/`. The builds are not code-signed. On a Mac, the first launch needs right-click → Open. Windows may show a SmartScreen warning, which you can get past with "More info" → "Run anyway".

## Project layout

- `main.js`: window, screen-capture permissions, source list, share selection.
- `preload.js`: the small API the page gets from the desktop shell.
- `renderer/index.html`, `renderer/styles.css`: the interface.
- `renderer/app.js`: screens, picker, chat, board.
- `renderer/room.js`: rooms, presence, chat, microphone, screen streams and bitrate.
- `renderer/flap.js`: the split-flap display.

## Web app (installable, no download)

Live: https://watchroom.peterndrio.workers.dev

Open it in Chrome or Edge and use the Install button in the top bar. It then opens like a normal app, in its own window.

- Screen sharing uses the browser's own picker (screen, window or tab). System sound is only offered by some browsers and sources.
- Phones and tablets can watch, talk and chat, but cannot share their screen.
- The relay for strict networks works the same as in the desktop app.
- Share a room with the "Copy link" button. The link opens the web app with the code filled in.

Build and publish:

```bash
npm run build:web
```

```bash
npm run deploy:web
```

The second command needs `npx wrangler login` once. The web app is a copy of the same code, with a small browser adapter in `renderer/web-shim.js`.

## Own relay

`worker/relay` is a small Nostr relay on Cloudflare that helps peers find each other. It only passes short-lived messages between people connected right now and stores nothing. Apps use it together with the public relays. Deploy it with:

```bash
cd worker/relay && npx wrangler deploy
```

The address is `watchroomRelayUrl` in `package.json` and `renderer/web-shim.js`.
