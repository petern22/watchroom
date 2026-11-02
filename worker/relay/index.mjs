// A tiny Nostr relay for Watchroom's room discovery, run as one Cloudflare Durable Object.
// It only passes short-lived "ephemeral" events (kinds 20000-29999) between peers that are connected right now.
// Nothing is stored, nothing is logged. Peers still talk to each other directly over WebRTC.
// Free plan friendly: the object sleeps when idle (WebSocket hibernation).

const MIN_KIND = 20000;
const MAX_KIND = 29999;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SUBS = 8;
const MAX_TOPICS_PER_SUB = 250;
const RATE_WINDOW_MS = 10000;
const RATE_MAX_EVENTS = 120;

const send = (ws, message) => {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* the socket is closing; nothing to do */
  }
};

// Only the filter parts Watchroom uses are kept, so a subscription always fits in the 2 KB socket attachment.
function cleanFilter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kinds = Array.isArray(raw.kinds) ? raw.kinds.filter((k) => Number.isInteger(k) && k >= MIN_KIND && k <= MAX_KIND) : [];
  const topics = Array.isArray(raw['#x']) ? raw['#x'].filter((t) => typeof t === 'string' && t.length <= 128) : [];
  if (!kinds.length || !topics.length || topics.length > MAX_TOPICS_PER_SUB) return null;
  return { kinds: kinds.slice(0, 250), x: topics };
}

export function matches(filter, event) {
  if (!filter.kinds.includes(event.kind)) return false;
  return event.tags.some((tag) => tag[0] === 'x' && filter.x.includes(tag[1]));
}

export function validEvent(event) {
  return Boolean(
    event &&
    typeof event === 'object' &&
    typeof event.id === 'string' &&
    event.id.length <= 128 &&
    Number.isInteger(event.kind) &&
    event.kind >= MIN_KIND &&
    event.kind <= MAX_KIND &&
    typeof event.content === 'string' &&
    Array.isArray(event.tags) &&
    event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'))
  );
}

export class Hub {
  constructor(ctx) {
    this.ctx = ctx;
  }

  fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Watchroom relay', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ subs: {}, hits: [] });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_BYTES) return ws.close(1009, 'message too large');
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return send(ws, ['NOTICE', 'invalid: bad json']);
    }
    if (!Array.isArray(message)) return send(ws, ['NOTICE', 'invalid: expected an array']);
    const [type, a, ...rest] = message;
    const state = ws.deserializeAttachment() || { subs: {}, hits: [] };

    if (type === 'EVENT') return this.onEvent(ws, state, a);

    if (type === 'REQ') {
      const filter = cleanFilter(rest[0]);
      if (typeof a !== 'string' || a.length > 64 || !filter) return send(ws, ['CLOSED', String(a), 'invalid: unsupported filter']);
      if (!state.subs[a] && Object.keys(state.subs).length >= MAX_SUBS) return send(ws, ['CLOSED', a, 'rate-limited: too many subscriptions']);
      state.subs[a] = filter;
      ws.serializeAttachment(state);
      return send(ws, ['EOSE', a]);
    }

    if (type === 'CLOSE') {
      delete state.subs[a];
      ws.serializeAttachment(state);
    }
  }

  onEvent(ws, state, event) {
    const now = Date.now();
    state.hits = state.hits.filter((at) => now - at < RATE_WINDOW_MS);
    if (state.hits.length >= RATE_MAX_EVENTS) return send(ws, ['OK', event?.id ?? '', false, 'rate-limited: slow down']);
    state.hits.push(now);
    ws.serializeAttachment(state);

    if (!validEvent(event)) return send(ws, ['OK', event?.id ?? '', false, 'invalid: only ephemeral events are accepted']);
    send(ws, ['OK', event.id, true, '']);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      const subs = peer.deserializeAttachment()?.subs || {};
      for (const [subId, filter] of Object.entries(subs)) {
        if (matches(filter, event)) send(peer, ['EVENT', subId, event]);
      }
    }
  }

  webSocketClose(ws) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}

export default {
  fetch(request, env) {
    return env.HUB.get(env.HUB.idFromName('hub')).fetch(request);
  },
};
