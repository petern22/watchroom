import { joinRoom } from 'trystero/nostr';
import { lossPercent, megabitsPerSecond } from './meters.mjs';

// Room layer: presence, chat, microphone and screen streams over WebRTC.
// Signaling runs through public Nostr relays, so there is no account and no server to run.
// Everything here lives in memory. Nothing is stored between sessions.

const APP_ID = 'watchroom-v1';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const WAITING_AFTER_MS = 25000;
const SPEAKING_LEVEL = 0.025;
const ADAPT_EVERY_MS = 2000;
const STATS_EVERY_MS = 1000;
const MIN_VIDEO_BPS = 1e6;
const AUDIO_BPS = 128e3;

// Share presets. Bitrates are per viewer at the sender, in bits per second.
// Each viewer gets its own stream, so the sender's total upload is bitrate x viewers.
const PRESETS = {
  720: { width: 1280, height: 720, label: '720p' },
  1080: { width: 1920, height: 1080, label: '1080p' },
  1440: { width: 2560, height: 1440, label: '1440p' },
  2160: { width: 3840, height: 2160, label: '4K' },
};
const BITRATE_BPS = {
  '720-30': 3e6,
  '720-60': 4.5e6,
  '1080-30': 6e6,
  '1080-60': 9e6,
  '1440-30': 10e6,
  '1440-60': 14e6,
  '2160-30': 16e6,
  '2160-60': 22e6,
};
// Most home uplinks cannot carry more than this, so the sender's total is capped here.
const UPLOAD_BUDGET_BPS = 25e6;

export function normalizeProfile(quality, fps) {
  const q = PRESETS[quality] ? quality : '720';
  const f = Number(fps) === 60 ? 60 : 30;
  return { quality: q, fps: f, ...PRESETS[q] };
}

// Bitrate per viewer after the upload budget is applied.
export function bitrateFor(quality, fps, viewers) {
  const { quality: q, fps: f } = normalizeProfile(quality, fps);
  const wanted = BITRATE_BPS[`${q}-${f}`];
  return Math.min(wanted, UPLOAD_BUDGET_BPS / Math.max(1, viewers));
}

export { CODE_LENGTH, PRESETS, UPLOAD_BUDGET_BPS };

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function cleanCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

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

export function openRoom(code, name, on) {
  const room = joinRoom({ appId: APP_ID, password: code }, code);
  const helloAction = room.makeAction('hello');
  const stateAction = room.makeAction('state');
  const chatAction = room.makeAction('chat');

  const audioCtx = new AudioContext();
  const me = { id: 'me', name: cleanName(name), mic: false, sharing: false, label: '', speaking: false, you: true };
  const peers = new Map();
  const meters = new Map();
  const audioEls = new Map();

  let micStream = null;
  let screenStream = null;
  let screenTrack = null;
  let profile = normalizeProfile('720', 30);
  let stageId = null;
  let closed = false;
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

  // Applies the target profile and each viewer's settled cap to the senders.
  function applySenderParams() {
    if (!screenTrack) return;
    const target = bitrateFor(profile.quality, profile.fps, peers.size);
    for (const [peerId, pc] of Object.entries(room.getPeers())) {
      const state = sendState.get(peerId) || { cap: target, scale: 1, limit: 'none', stable: 0 };
      sendState.set(peerId, state);
      state.cap = Math.min(state.cap, target);
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
          params.degradationPreference = profile.fps >= 60 ? 'maintain-framerate' : 'balanced';
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
    const target = bitrateFor(profile.quality, profile.fps, peers.size);
    let worst = { limit: 'none', cap: target, scale: 1 };
    let uploadMbps = 0;
    let availableMbps = Infinity;
    let rttMs = 0;
    let encoderFps = 0;
    let frame = { width: 0, height: 0 };
    const now = Date.now();
    for (const [peerId, pc] of Object.entries(room.getPeers())) {
      const sender = pc.getSenders().find((s) => s.track === screenTrack);
      if (!sender) continue;
      const state = sendState.get(peerId) || { cap: target, scale: 1, limit: 'none', stable: 0 };
      sendState.set(peerId, state);
      let outbound = null;
      let pair = null;
      const report = await sender.getStats().catch(() => null);
      report?.forEach((entry) => {
        if (entry.type === 'outbound-rtp' && entry.kind === 'video') outbound = entry;
        if (entry.type === 'candidate-pair' && entry.nominated) pair = entry;
      });
      if (!outbound) continue;

      const seconds = state.sampledAt ? (now - state.sampledAt) / 1000 : 0;
      uploadMbps += megabitsPerSecond(outbound.bytesSent || 0, state.bytesSent, seconds);
      state.bytesSent = outbound.bytesSent || 0;
      state.sampledAt = now;
      encoderFps = Math.max(encoderFps, Math.round(outbound.framesPerSecond || 0));
      if (outbound.frameWidth) frame = { width: outbound.frameWidth, height: outbound.frameHeight };
      if (pair?.availableOutgoingBitrate) availableMbps = Math.min(availableMbps, pair.availableOutgoingBitrate / 1e6);
      if (pair?.currentRoundTripTime) rttMs = Math.max(rttMs, Math.round(pair.currentRoundTripTime * 1000));

      const limit = outbound.qualityLimitationReason || 'none';
      state.limit = limit;
      if (limit === 'bandwidth') {
        state.cap = Math.max(MIN_VIDEO_BPS, state.cap * 0.85);
        state.stable = 0;
      } else if (limit === 'cpu') {
        state.scale = Math.min(2, state.scale * 1.25);
        state.stable = 0;
      } else {
        state.stable = (state.stable || 0) + 1;
        if (state.stable >= 3) {
          state.cap = Math.min(target, state.cap * 1.1);
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
      on.quality?.({
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

  function meter(id, stream) {
    stopMeter(id);
    if (stream.getAudioTracks().length === 0) return;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.sqrt(sum / buf.length);
      const who = id === 'me' ? me : peers.get(id);
      if (!who) return;
      const speaking = level > SPEAKING_LEVEL && (id === 'me' ? me.mic : who.mic);
      if (speaking !== who.speaking) {
        who.speaking = speaking;
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

  // Ask the browser to skip its jitter buffer for incoming video. Frames show as soon as they arrive.
  function lowerPlayoutDelay(peerId) {
    const pc = room.getPeers()[peerId];
    pc?.getReceivers().forEach((receiver) => {
      try {
        receiver.playoutDelayHint = 0;
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
    on.chat({
      id: clip(data?.id, 64) || crypto.randomUUID(),
      name: cleanName(data?.name ?? p?.name),
      text: clip(data?.text, 500),
      at: Number(data?.at) || Date.now(),
      self: false,
    });
  };

  // ---- room lifecycle ----

  room.onPeerJoin = (peerId) => {
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
    if (micStream) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      on.error('Microphone is unavailable. You can still watch and chat.');
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

  async function startShare({ sourceId, label, audio, quality, fps }) {
    if (screenStream) stopShare();
    profile = normalizeProfile(quality, fps);
    sendState.clear();
    await window.watchroom.prepareShare(sourceId, audio);
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: captureConstraints(),
        audio: Boolean(audio),
      });
    } catch (err) {
      await window.watchroom.cancelShare();
      throw err;
    }

    screenStream = stream;
    screenTrack = stream.getVideoTracks()[0];
    if (screenTrack) {
      screenTrack.contentHint = 'motion';
      screenTrack.addEventListener('ended', () => stopShare());
    }
    me.sharing = true;
    me.label = clip(label, 60) || 'Screen';
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

  async function leave() {
    if (closed) return;
    closed = true;
    clearTimeout(waitTimer);
    stopShare();
    stopWatching();
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    for (const id of [...meters.keys()]) stopMeter(id);
    for (const id of [...audioEls.keys()]) dropAudio(id);
    audioCtx.close().catch(() => {});
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
    leave,
    setProfile(quality, fps) {
      profile = normalizeProfile(quality, fps);
      sendState.clear();
      if (screenTrack) screenTrack.applyConstraints(captureConstraints()).catch(() => {});
      applySenderParams();
    },
  };
}
