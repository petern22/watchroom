# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Electron desktop shell, plain JavaScript (no framework), bundled with esbuild, WebRTC for media, Trystero for peer signaling with no account or server to run. The user approved this stack in the plan. Chosen so the whole app is free to run and needs no setup beyond installing it.

## Users

Families and friends, 2 to 4 people per room, on Mac and Windows. Each person wants to watch a movie or show together while talking to each other, from different homes. Stremio is the example source. Any app or window on the host's screen should work, but DRM-protected services such as Netflix show black frames in any screen share, and this is outside the app's control.

## Product Purpose

A desktop app where one person shares a screen or window (movie player, browser tab, local file) and the others watch it live, with voice and chat. Success means a group can start a room in under a minute, share a movie, and talk through it without any of them paying for a service.

## Positioning

A room code and a screen share, nothing else. No accounts, no subscriptions, no server bill. The host's stream is the single source of truth, so nobody has to keep playback in sync.

## Operating Context

Used on a laptop or desktop during evenings, often with a TV connected through HDMI or AirPlay. Most rooms are created by one person and joined by others. Participants may use headphones or speakers, which affects echo.

## Capabilities and Constraints

- Create a room (generates a short code) and join one with a code.
- Share a screen or window, optionally with system audio, at a chosen quality.
- Microphone on or off for all participants; chat with names and timestamps.
- One active share per room. The share stage is the center of the screen.
- Peer-to-peer media with free public STUN servers. Some strict networks (cellular, corporate) may not connect without a relay. This is a known limit.
- Groups of 2 to 4 people are the target. Upload bandwidth of the sharer limits the number of viewers, so quality adapts to the viewer count.
- macOS needs Screen Recording permission for the app. System audio on macOS requires macOS 13 or newer.
- Not decided: accounts (none planned), recording (none planned), mobile apps (none planned).

## Brand Commitments

None. The name is provisional: Watchroom.

## Evidence on Hand

No real customer content or metrics exist. Any shown data is synthetic. No testimonials or claims about streaming services.

## Product Principles

- Free to run is a hard requirement. Any dependency must have a free tier that covers a family.
- The host's stream is the single source of truth. Avoid playback sync logic.
- Show who is sharing, who is in the room, and what the recovery is for every failure.
- Never claim a source works. Name the one thing that will be black (DRM) and let the user try.

## Accessibility & Inclusion

Keyboard operable controls, visible focus rings, sufficient contrast on all text (4.5:1 minimum), and status conveyed with text as well as color (mic on or off, sharing or not).
