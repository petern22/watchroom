import { getRelays } from '@trystero-p2p/core';
import { defaultRelayUrls, joinRoom } from 'trystero/nostr';
import { lossPercent, megabitsPerSecond } from './meters.mjs';
import { CODE_LENGTH, MAX_PEERS, nextSpeaking, PRESETS, UPLOAD_BUDGET_BPS, bitrateFor, cleanCode, newRoomCode, normalizeProfile } from './room-policy.mjs';

export { CODE_LENGTH, MAX_PEERS, PRESETS, UPLOAD_BUDGET_BPS, bitrateFor, cleanCode, newRoomCode } from './room-policy.mjs';

// Room layer: presence, chat, microphone and screen streams over WebRTC.
// Signaling runs through public Nostr relays, so there is no account and no server to run.
// Everything here lives in memory. Nothing is stored between sessions.

const APP_ID = 'watchroom-v1';
const WAITING_AFTER_MS = 25000;
const ADAPT_EVERY_MS = 2000;
const STATS_EVERY_MS = 1000;
const MIN_VIDEO_BPS = 1e6;
const AUDIO_BPS = 128e3;
const REQUEST_KINDS = new Set(['pause', 'ready']);
const REQUEST_GAP_MS = 3000;

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanName(value) {
  return clip(value, 24) || 'Guest';
}

function isKind(metadata, kind) {
  return Boolean(metadata) && typeof metadata === 'object' && metadata.kind === kind;
}

// Worst limitation across viewers, for the sender's summary.
const LIMIT_RANK = { none: 0, other: 1, cpu: 2, bandwidth: 3 };

// H.264 first: most computers compress it in dedicated hardware, which is sharper per bit and uses less processor.
// Set when each video track is added, so the browser negotiates H.264 from the first offer.
function preferredCodecs() {
  const all = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const h264 = all.filter((c) => c.mimeType === 'video/H264' && /profile-level-id=42e01f/.test(c.sdpFmtpLine || ''));
  return [...h264, ...all.filter((c) => !h264.includes(c))];
}

class H264PreferringConnection extends RTCPeerConnection {
  addTrack(track, ...streams) {
    const sender = super.addTrack(track, ...streams);
    if (track.kind === 'video') {
      const transceiver = this.getTransceivers().find((t) => t.sender === sender);
      try {
        transceiver?.setCodecPreferences(preferredCodecs());
      } catch {
        /* the browser keeps its own order if the preference is refused */
      }
    }
    return sender;
  }
}

export function openRoom(code, name, on, options = {}) {
  const config = { appId: APP_ID, password: code, rtcPolyfill: H264PreferringConnection };
  if (options.turnConfig?.length) config.turnConfig = options.turnConfig;
  // Our own relay first, then the same public relays older versions use, so old and new apps always share one.
  if (options.relayUrl) config.relayConfig = { urls: [options.relayUrl, ...getRelays(config, defaultRelayUrls, 5, true)] };
  if (options.forceRelay) config.rtcConfig = { iceTransportPolicy: 'relay' };
  const room = (options.joinRoom || joinRoom)(config, code);
  const helloAction = room.makeAction('hello');
  const stateAction = room.makeAction('state');
  const chatAction = room.makeAction('chat');
  const capacityAction = room.makeAction('capacity');
  const requestAction = room.makeAction('request');

  let audioCtx = null;
  const me = { id: 'me', name: cleanName(name), mic: false, sharing: false, label: '', speaking: false, you: true };
  const peers = new Map();
  const meters = new Map();
  const audioEls = new Map();

  let micStream = null;
  let micPending = false;
  let sharePending = false;
  let screenStream = null;
  let screenTrack = null;
  let profile = { ...normalizeProfile('720', 30), lowDelay: false, sharp: false };
  let stageId = null;
  let closed = false;
  const recoverConnections = () => {
    if (closed) return;
    const open = Object.values(room.getPeers());
    // With nobody else in the room there is nothing to reconnect to. Go back to waiting, not "Reconnecting" forever.
    on.status(navigator.onLine === false ? 'offline' : open.length ? 'reconnecting' : 'waiting');
    for (const pc of open) {
      if (pc.connectionState !== 'connected') pc.close();
    }
  };
  window.addEventListener('online', recoverConnections);
  window.addEventListener('offline', recoverConnections);
  // Per viewer: the bitrate cap and resolution scale the sender has settled on.
  const sendState = new Map();
  let adaptTimer = null;
  let statsTimer = null;
  let statsPeer = null;
  let lastInbound = null;

  const waitTimer = setTimeout(() => {
    if (peers.size === 0 && !closed) on.status('waiting');
  }, WAITING_AFTER_MS);

  function ensurePeer(id) {
    if (!peers.has(id)) {
      peers.set(id, { id, name: 'Guest', joined: false, mic: false, sharing: false, label: '', speaking: false, screen: null });
    }
    return peers.get(id);
  }

  function emitPeers() {
    const list = [me, ...[...peers.values()].filter((p) => p.joined)];
    on.peers(list);
  }

  function snapshot() {
    return { name: me.name, mic: me.mic, sharing: me.sharing, label: me.label };
  }

  function announce(target) {
    if (target) stateAction.send(snapshot(), { target });
    else stateAction.send(snapshot());
  }

  function addMedia(stream, metadata, target) {
    const options = target ? { target, metadata } : { metadata };
    return Promise.allSettled(room.addStream(stream, options));
  }

  function captureConstraints() {
    return {
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: profile.fps, max: profile.fps },
    };
  }

  // Lowest-delay mode sends less, so frames never queue behind a full upload.
  function targetBps() {
    const base = bitrateFor(profile.quality, profile.fps, peers.size);
    return profile.lowDelay ? base * 0.6 : base;
  }

  // Applies the target profile and each viewer's settled cap to the senders.
  function applySenderParams() {
    if (!screenTrack) return;
    const target = targetBps();
    for (const [peerId, pc] of Object.entries(room.getPeers())) {
      const start = target;
      const state = sendState.get(peerId) || { cap: start, scale: 1, limit: 'none', stable: 0 };
      sendState.set(peerId, state);
      state.cap = Math.min(state.cap, state.ceiling ?? start);
      for (const sender of pc.getSenders()) {
        if (!sender.track) continue;
        const isScreen = sender.track === screenTrack;
        const isScreenAudio = !isScreen && screenStream?.getAudioTracks().includes(sender.track);
        if (!isScreen && !isScreenAudio) continue;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        const encoding = params.encodings[0];
        if (isScreen) {
          encoding.maxBitrate = Math.round(state.cap);
          encoding.scaleResolutionDownBy = state.scale;
          // At 60 fps keep the frame rate and let resolution give way when the link is short.
          // Sharper picture keeps the resolution and drops frames instead. Otherwise keep the frame rate at 60 fps.
          params.degradationPreference = profile.sharp
            ? 'maintain-resolution'
            : profile.fps >= 60
              ? 'maintain-framerate'
              : 'balanced';
        } else {
          encoding.maxBitrate = AUDIO_BPS;
        }
        sender.setParameters(params).catch(() => {});
      }
    }
  }

  // Every few seconds, look at why each viewer's stream is limited and adjust that viewer alone.
  async function adaptSenders() {
    if (!screenTrack) return;
    const target = targetBps();
    let worst = { limit: 'none', cap: target, scale: 1 };
    let uploadMbps = 0;
    let availableMbps = Infinity;
    let rttMs = 0;
    let encoderFps = 0;
    let frame = { width: 0, height: 0 };
    let codecName = '';
    const now = Date.now();
    for (const [peerId, pc] of Object.entries(room.getPeers())) {
      const sender = pc.getSenders().find((s) => s.track === screenTrack);
      if (!sender) continue;
      const state = sendState.get(peerId) || { cap: target, scale: 1, limit: 'none', stable: 0 };
      sendState.set(peerId, state);
      let outbound = null;
      let pair = null;
      let remoteInbound = null;
      const report = await sender.getStats().catch(() => null);
      report?.forEach((entry) => {
        if (entry.type === 'outbound-rtp' && entry.kind === 'video') outbound = entry;
        if (entry.type === 'candidate-pair' && entry.nominated) pair = entry;
        if (entry.type === 'remote-inbound-rtp' && entry.kind === 'video') remoteInbound = entry;
      });
      if (!outbound) continue;

      const seconds = state.sampledAt ? (now - state.sampledAt) / 1000 : 0;
      uploadMbps += megabitsPerSecond(outbound.bytesSent || 0, state.bytesSent, seconds);
      state.bytesSent = outbound.bytesSent || 0;
      state.sampledAt = now;
      encoderFps = Math.max(encoderFps, Math.round(outbound.framesPerSecond || 0));
      if (outbound.frameWidth) frame = { width: outbound.frameWidth, height: outbound.frameHeight };
      codecName = report?.get(outbound.codecId)?.mimeType?.replace('video/', '') || codecName;
      if (pair?.availableOutgoingBitrate) availableMbps = Math.min(availableMbps, pair.availableOutgoingBitrate / 1e6);
      if (pair?.currentRoundTripTime) rttMs = Math.max(rttMs, Math.round(pair.currentRoundTripTime * 1000));

      const rtt = pair?.currentRoundTripTime ? pair.currentRoundTripTime * 1000 : 0;
      if (rtt) state.minRtt = Math.min(state.minRtt ?? rtt, rtt);
      // A round trip that keeps rising means frames are waiting in a queue: that is delay.
      const queuing = Boolean(rtt && state.minRtt && rtt > state.minRtt + (profile.lowDelay ? 60 : 120));
      // A short delay spike is normal on Wi-Fi. Cut quality only when delay stays high, or when packets are really lost.
      state.queueCount = queuing ? (state.queueCount || 0) + 1 : 0;
      const lossy = (remoteInbound?.fractionLost || 0) > 0.02;
      const reported = outbound.qualityLimitationReason || 'none';
      const limit = reported === 'none' && (lossy || state.queueCount >= 2) ? 'bandwidth' : reported;
      state.limit = limit;
      // Room to grow: up to 2.5x the default, but never past this viewer's share of the upload.
      const shareBps = UPLOAD_BUDGET_BPS / Math.max(1, peers.size);
      const measured = (pair?.availableOutgoingBitrate || 0) / Math.max(1, peers.size);
      const growTo = profile.lowDelay ? 1 : 2.5;
      state.ceiling = Math.max(target, Math.min(target * growTo, shareBps, measured * 0.8));
      if (limit === 'bandwidth') {
        state.cap = Math.max(MIN_VIDEO_BPS, state.cap * 0.85);
        state.stable = 0;
      } else if (limit === 'cpu') {
        state.scale = Math.min(2, state.scale * 1.25);
        state.stable = 0;
      } else {
        state.stable = (state.stable || 0) + 1;
        if (state.stable >= 2) {
          state.cap = Math.min(state.ceiling, state.cap * 1.25);
          state.scale = Math.max(1, state.scale / 1.25);
          state.stable = 0;
        }
      }
      if (LIMIT_RANK[limit] > LIMIT_RANK[worst.limit]) worst = { limit, cap: state.cap, scale: state.scale };
      else if (state.cap < worst.cap) worst.cap = state.cap;
    }
    applySenderParams();
    on.sendStats?.({
      viewers: peers.size,
      limit: worst.limit,
      capBps: Math.round(worst.cap),
      scale: worst.scale,
      width: frame.width || Math.round(profile.width / worst.scale),
      height: frame.height || Math.round(profile.height / worst.scale),
      fps: profile.fps,
      encoderFps,
      uploadMbps: Math.round(uploadMbps * 10) / 10,
      availableMbps: Number.isFinite(availableMbps) ? Math.round(availableMbps * 10) / 10 : 0,
      rttMs,
      targetMbps: Math.round(target / 1e5) / 10,
      codec: codecName,
    });
  }

  function startAdapting() {
    stopAdapting();
    adaptTimer = setInterval(() => {
      adaptSenders().catch(() => {});
    }, ADAPT_EVERY_MS);
  }

  function stopAdapting() {
    if (adaptTimer) clearInterval(adaptTimer);
    adaptTimer = null;
  }

  // Viewer side: sample the incoming picture so the player can show what is actually arriving.
  function startWatching(peerId) {
    stopWatching();
    statsPeer = peerId;
    lastInbound = null;
    statsTimer = setInterval(async () => {
      const pc = room.getPeers()[statsPeer];
      if (!pc) return;
      const report = await pc.getStats().catch(() => null);
      let inbound = null;
      let pair = null;
      report?.forEach((entry) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') inbound = entry;
        if (entry.type === 'candidate-pair' && entry.nominated) pair = entry;
      });
      if (!inbound) return;

      const now = Date.now();
      const received = inbound.packetsReceived || 0;
      const lost = inbound.packetsLost || 0;
      const bytes = inbound.bytesReceived || 0;
      const seconds = lastInbound ? (now - lastInbound.at) / 1000 : 0;
      const usedMbps = megabitsPerSecond(bytes, lastInbound?.bytes, seconds);
      const loss = lastInbound ? lossPercent(received, lost, lastInbound.received, lastInbound.lost) : 0;
      lastInbound = { at: now, bytes, received, lost };

      const bufferMs = inbound.jitterBufferEmittedCount
        ? Math.round((inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000)
        : 0;
      const rttMs = Math.round((pair?.currentRoundTripTime || 0) * 1000);
      // The route: a relay candidate means the call goes through Cloudflare, anything else is a direct connection.
      const local = pair ? report?.get(pair.localCandidateId) : null;
      const route = local ? (local.candidateType === 'relay' ? 'relay' : 'direct') : '';
      on.quality?.({
        route,
        width: inbound.frameWidth || 0,
        height: inbound.frameHeight || 0,
        fps: Math.round(inbound.framesPerSecond || 0),
        usedMbps: Math.round(usedMbps * 10) / 10,
        availableMbps: Math.round(((pair?.availableIncomingBitrate || 0) / 1e6) * 10) / 10,
        lossPct: Math.round(loss * 10) / 10,
        bufferMs,
        rttMs,
        delayMs: Math.round(rttMs / 2 + bufferMs),
      });
    }, STATS_EVERY_MS);
  }

  function stopWatching() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    statsPeer = null;
    lastInbound = null;
  }

  function stopMeter(id) {
    const entry = meters.get(id);
    if (!entry) return;
    clearInterval(entry.timer);
    entry.source.disconnect();
    meters.delete(id);
  }

  function receiverLevel(id) {
    try {
      const receiver = room.getPeers()[id]?.getReceivers().find((r) => r.track?.kind === 'audio' && r.track.readyState === 'live');
      const sources = receiver?.getSynchronizationSources?.() || [];
      return sources.reduce((max, s) => Math.max(max, Number(s.audioLevel) || 0), 0);
    } catch {
      return 0;
    }
  }

  function meter(id, stream) {
    stopMeter(id);
    if (stream.getAudioTracks().length === 0) return;
    audioCtx ||= new AudioContext();
    // Browsers start the context asleep until a touch. Ask now; unlockAudio asks again on the first tap.
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      let level = Math.sqrt(sum / buf.length);
      const who = id === 'me' ? me : peers.get(id);
      if (!who) return;
      // The receiver reports its own audio level too. It works even while the audio context is still asleep.
      if (id !== 'me') level = Math.max(level, receiverLevel(id));
      const live = id === 'me' ? me.mic : who.mic;
      const next = nextSpeaking({ level: live ? level : 0, speaking: who.speaking, loudAt: who.loudAt || 0, now: Date.now() });
      who.loudAt = next.loudAt;
      if (next.speaking !== who.speaking) {
        who.speaking = next.speaking;
        emitPeers();
      }
    }, 140);
    meters.set(id, { timer, source });
  }

  function playMic(id, stream) {
    let el = audioEls.get(id);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.hidden = true;
      document.body.append(el);
      audioEls.set(id, el);
    }
    el.srcObject = stream;
    el.play().catch(() => {});
    meter(id, stream);
  }

  function dropAudio(id) {
    stopMeter(id);
    const el = audioEls.get(id);
    if (el) {
      el.srcObject = null;
      el.remove();
      audioEls.delete(id);
    }
  }

  function setStage(id, stream, info) {
    stageId = id;
    if (id) startWatching(id);
    else stopWatching();
    on.screen(stream, info);
  }

  // Keep a small playout buffer so mobile receivers absorb ordinary Wi-Fi jitter without adding much delay.
  function lowerPlayoutDelay(peerId) {
    const pc = room.getPeers()[peerId];
    pc?.getReceivers().forEach((receiver) => {
      try {
        receiver.playoutDelayHint = 0.1;
        // Chromium's newer setting uses milliseconds.
        if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 100;
      } catch {
        /* not supported in this browser build; playback still works */
      }
    });
  }

  // ---- presence, chat and state from peers ----

  helloAction.onMessage = (data, { peerId }) => {
    const p = ensurePeer(peerId);
    const wasNew = !p.joined;
    p.name = cleanName(data?.name);
    p.joined = true;
    if (wasNew) on.system(`${p.name} joined`);
    emitPeers();
  };

  stateAction.onMessage = (data, { peerId }) => {
    const p = ensurePeer(peerId);
    p.name = cleanName(data?.name ?? p.name);
    p.mic = Boolean(data?.mic);
    const wasSharing = p.sharing;
    p.sharing = Boolean(data?.sharing);
    p.label = clip(data?.label, 60);
    if (wasSharing && !p.sharing) {
      p.screen = null;
      if (stageId === peerId) setStage(null, null, null);
    }
    emitPeers();
  };

  chatAction.onMessage = (data, { peerId }) => {
    const p = peers.get(peerId);
    if (!p || typeof data?.text !== 'string' || !data.text.trim()) return;
    const now = Date.now();
    p.chatTimes = (p.chatTimes || []).filter((at) => now - at < 3000);
    if (p.chatTimes.length >= 8) return;
    p.chatTimes.push(now);
    on.chat({
      id: clip(data?.id, 64) || crypto.randomUUID(),
      name: p.name,
      text: clip(data?.text, 500),
      at: now,
      self: false,
    });
  };

  // A request is only a message. Watchroom cannot control the app being shared, so the sharer decides.
  requestAction.onMessage = (data, { peerId }) => {
    const p = peers.get(peerId);
    if (!p || !REQUEST_KINDS.has(data?.kind)) return;
    const now = Date.now();
    if (now - (p.lastRequestAt || 0) < REQUEST_GAP_MS) return;
    p.lastRequestAt = now;
    on.request?.({ name: p.name, kind: data.kind, self: false });
  };

  capacityAction.onMessage = (data) => {
    if (data?.full) on.full?.(Number(data.max) || MAX_PEERS);
  };

  // ---- room lifecycle ----

  room.onPeerJoin = (peerId) => {
    const pc = room.getPeers()[peerId];
    if (peers.size >= MAX_PEERS - 1) {
      // The newcomer leaves the whole room when it hears this, so a rejection never leaves it in a partial mesh.
      // Close late enough for the notice to arrive. A failed send is not actionable here: the peer is already gone.
      Promise.resolve(capacityAction.send({ full: true, max: MAX_PEERS }, { target: peerId })).catch(() => {});
      setTimeout(() => pc?.close(), 1000);
      return;
    }
    pc?.addEventListener('connectionstatechange', () => {
      if (closed) return;
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') on.status('reconnecting');
      if (pc.connectionState === 'connected') on.status('live');
    });
    ensurePeer(peerId);
    clearTimeout(waitTimer);
    on.status('live');
    helloAction.send({ name: me.name }, { target: peerId });
    announce(peerId);
    if (micStream) addMedia(micStream, { kind: 'mic' }, peerId);
    if (screenStream) addMedia(screenStream, { kind: 'screen', label: me.label }, peerId);
    applySenderParams();
    emitPeers();
  };

  room.onPeerLeave = (peerId) => {
    const p = peers.get(peerId);
    peers.delete(peerId);
    sendState.delete(peerId);
    dropAudio(peerId);
    if (p?.joined) on.system(`${p.name} left`);
    if (stageId === peerId) setStage(null, null, null);
    if (peers.size === 0 && !closed) on.status('waiting');
    emitPeers();
  };

  room.onPeerStream = (stream, peerId, metadata) => {
    const p = ensurePeer(peerId);
    if (isKind(metadata, 'screen')) {
      p.screen = stream;
      p.label = clip(metadata.label, 60) || p.label;
      lowerPlayoutDelay(peerId);
      setStage(peerId, stream, { id: peerId, name: p.name, label: p.label || 'Screen' });
      stream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (stageId === peerId) setStage(null, null, null);
        });
      });
    } else if (isKind(metadata, 'mic')) {
      playMic(peerId, stream);
    }
    emitPeers();
  };

  // ---- local actions ----

  async function startMic() {
    if (closed || micPending) return false;
    if (micStream) return true;
    micPending = true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      on.error('Microphone is unavailable. You can still watch and chat.');
      return false;
    } finally {
      micPending = false;
    }
    if (closed) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
      return false;
    }
    micStream.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    addMedia(micStream, { kind: 'mic' });
    meter('me', micStream);
    announce();
    emitPeers();
    return true;
  }

  async function toggleMic() {
    if (!micStream && !(await startMic())) return me.mic;
    me.mic = !me.mic;
    micStream.getAudioTracks().forEach((track) => {
      track.enabled = me.mic;
    });
    announce();
    emitPeers();
    return me.mic;
  }

  async function startShare({ sourceId, label, audio, quality, fps, lowDelay, sharp }) {
    if (closed || sharePending) throw new Error('Another sharing request is active or the room has closed.');
    sharePending = true;
    if (screenStream) stopShare();
    profile = { ...normalizeProfile(quality, fps), lowDelay: Boolean(lowDelay), sharp: Boolean(sharp) };
    sendState.clear();
    let stream;
    try {
      await window.watchroom.prepareShare(sourceId, audio);
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: captureConstraints(),
        audio: Boolean(audio),
      });
    } catch (err) {
      await window.watchroom.cancelShare().catch(() => {});
      throw err;
    } finally {
      sharePending = false;
    }

    if (closed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Room closed.');
    }
    screenStream = stream;
    screenTrack = stream.getVideoTracks()[0];
    if (screenTrack) {
      screenTrack.contentHint = 'motion';
      screenTrack.addEventListener('ended', () => {
        if (screenStream === stream) stopShare();
      });
    }
    me.sharing = true;
    // In a browser there is no name from our own picker, so use what the browser reports. Skip its internal ids.
    const trackName = screenTrack?.label && !screenTrack.label.includes('://') ? screenTrack.label : '';
    me.label = clip(label, 60) || clip(trackName, 60) || 'Shared screen';
    addMedia(screenStream, { kind: 'screen', label: me.label });
    applySenderParams();
    startAdapting();
    announce();
    emitPeers();
    return { hasAudio: stream.getAudioTracks().length > 0 };
  }

  function stopShare() {
    if (!screenStream) return;
    const stream = screenStream;
    screenStream = null;
    screenTrack = null;
    stopAdapting();
    sendState.clear();
    room.removeStream(stream);
    stream.getTracks().forEach((track) => track.stop());
    me.sharing = false;
    me.label = '';
    announce();
    emitPeers();
  }

  function sendChat(text) {
    const body = clip(text, 500);
    if (!body) return;
    const msg = { id: crypto.randomUUID(), name: me.name, text: body, at: Date.now() };
    chatAction.send(msg);
    on.chat({ ...msg, self: true });
  }

  function sendRequest(kind) {
    if (!REQUEST_KINDS.has(kind) || peers.size === 0) return false;
    Promise.resolve(requestAction.send({ kind })).catch(() => {});
    on.request?.({ name: me.name, kind, self: true });
    return true;
  }

  async function leave() {
    if (closed) return;
    closed = true;
    window.removeEventListener('online', recoverConnections);
    window.removeEventListener('offline', recoverConnections);
    clearTimeout(waitTimer);
    stopShare();
    stopWatching();
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    for (const id of [...meters.keys()]) stopMeter(id);
    for (const id of [...audioEls.keys()]) dropAudio(id);
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    await room.leave();
  }

  on.status('connecting');
  emitPeers();

  return {
    me,
    startMic,
    toggleMic,
    startShare,
    stopShare,
    sendChat,
    sendRequest,
    leave,
    // Phones keep audio asleep until a touch. Called from a tap, it starts everything that was blocked.
    unlockAudio() {
      audioCtx ||= new AudioContext();
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
      for (const el of audioEls.values()) if (el.paused) el.play().catch(() => {});
    },
    setProfile(quality, fps, lowDelay = profile.lowDelay, sharp = profile.sharp) {
      profile = { ...normalizeProfile(quality, fps), lowDelay: Boolean(lowDelay), sharp: Boolean(sharp) };
      sendState.clear();
      if (screenTrack) screenTrack.applyConstraints(captureConstraints()).catch(() => {});
      applySenderParams();
    },
  };
}
