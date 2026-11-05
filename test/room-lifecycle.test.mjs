// Run with: node test/room-lifecycle.test.mjs
import assert from 'node:assert/strict';

globalThis.RTCPeerConnection = class {};
globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: [] }) };

const windowListeners = new Map();
globalThis.window = {
  watchroom: {
    prepareShare: async () => true,
    cancelShare: async () => true,
  },
  addEventListener(type, listener) {
    windowListeners.set(type, listener);
  },
  removeEventListener(type, listener) {
    if (windowListeners.get(type) === listener) windowListeners.delete(type);
  },
};

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true, mediaDevices: {} },
});

globalThis.document = {
  body: { append() {} },
  createElement() {
    return { autoplay: false, hidden: false, paused: false, play: async () => {}, remove() {}, srcObject: null };
  },
};

globalThis.AudioContext = class {
  state = 'running';
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData() {} };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
};

const { openRoom } = await import('../renderer/room.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeTrack(kind, label = '') {
  const listeners = new Map();
  return {
    kind,
    label,
    enabled: true,
    stopped: false,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    emit(type) {
      listeners.get(type)?.();
    },
    stop() {
      this.stopped = true;
    },
    applyConstraints() {
      return Promise.resolve();
    },
  };
}

function makeStream({ audio = false, video = false, label = '' } = {}) {
  const tracks = [];
  if (audio) tracks.push(makeTrack('audio'));
  if (video) tracks.push(makeTrack('video', label));
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  };
}

function makePeer() {
  return {
    connectionState: 'connected',
    closed: false,
    addEventListener() {},
    close() {
      this.closed = true;
    },
    getSenders: () => [],
    getReceivers: () => [],
    getStats: async () => new Map(),
  };
}

function makeRoom() {
  const actions = {};
  const peers = {};
  return {
    actions,
    peers,
    sent: [],
    removed: [],
    makeAction(name) {
      const action = {
        send: (data, options) => {
          this.sent.push({ name, data, options });
          return [];
        },
        onMessage: null,
      };
      actions[name] = action;
      return action;
    },
    getPeers: () => peers,
    addStream: () => [],
    removeStream(stream) {
      this.removed.push(stream);
    },
    leave: async () => {},
  };
}

function makeHandlers() {
  return {
    chats: [],
    errors: [],
    fullCalls: [],
    statuses: [],
    peers: () => {},
    status(status) {
      this.statuses.push(status);
    },
    system: () => {},
    screen: () => {},
    chat(message) {
      this.chats.push(message);
    },
    error(message) {
      this.errors.push(message);
    },
    full(max) {
      this.fullCalls.push(max);
    },
  };
}

function makeSession() {
  const room = makeRoom();
  const handlers = makeHandlers();
  const session = openRoom('ABC234', 'Local', handlers, { joinRoom: () => room });
  return { handlers, room, session };
}

{
  const capture = deferred();
  const mic = makeStream({ audio: true });
  navigator.mediaDevices.getUserMedia = () => capture.promise;
  const { session } = makeSession();
  const first = session.startMic();
  assert.equal(await session.startMic(), false, 'a second microphone request is rejected while the first is pending');
  await session.leave();
  capture.resolve(mic);
  assert.equal(await first, false);
  assert.equal(mic.tracks[0].stopped, true, 'a microphone granted after leaving is stopped');
}

{
  const capture = deferred();
  const screen = makeStream({ video: true, label: 'Window' });
  navigator.mediaDevices.getDisplayMedia = () => capture.promise;
  const { session } = makeSession();
  const first = session.startShare({ sourceId: 'screen:1', label: 'Window', quality: '720', fps: 30 });
  await Promise.resolve();
  await assert.rejects(
    session.startShare({ sourceId: 'screen:1', label: 'Window', quality: '720', fps: 30 }),
    /Another sharing request/,
  );
  await session.leave();
  capture.resolve(screen);
  await assert.rejects(first, /Room closed/);
  assert.equal(screen.tracks[0].stopped, true, 'a screen granted after leaving is stopped');
}

{
  const firstScreen = makeStream({ video: true, label: 'First' });
  const secondScreen = makeStream({ video: true, label: 'Second' });
  let nextScreen = firstScreen;
  navigator.mediaDevices.getDisplayMedia = async () => nextScreen;
  const { session } = makeSession();
  await session.startShare({ sourceId: 'screen:1', label: 'First', quality: '720', fps: 30 });
  nextScreen = secondScreen;
  await session.startShare({ sourceId: 'screen:2', label: 'Second', quality: '720', fps: 30 });
  firstScreen.tracks[0].emit('ended');
  assert.equal(session.me.sharing, true, 'an old track ending does not stop the current share');
  assert.equal(session.me.label, 'Second');
  await session.leave();
}

{
  const { handlers, room, session } = makeSession();
  room.peers.remote = makePeer();
  room.onPeerJoin('remote');
  room.actions.hello.onMessage({ name: 'Remote' }, { peerId: 'remote' });
  room.actions.chat.onMessage({ text: '   ' }, { peerId: 'remote' });
  for (let index = 0; index < 10; index += 1) {
    room.actions.chat.onMessage({ text: `message ${index}`, name: 'Forged', at: 1 }, { peerId: 'remote' });
  }
  assert.equal(handlers.chats.length, 8, 'chat burst limiting accepts at most eight messages per three seconds');
  assert.equal(handlers.chats[0].name, 'Remote', 'chat uses the established peer name');
  assert.notEqual(handlers.chats[0].at, 1, 'chat ignores a forged remote timestamp');
  navigator.onLine = false;
  windowListeners.get('offline')();
  assert.equal(handlers.statuses.at(-1), 'offline');
  navigator.onLine = true;
  room.peers.remote.connectionState = 'disconnected';
  windowListeners.get('online')();
  assert.equal(handlers.statuses.at(-1), 'reconnecting');
  assert.equal(room.peers.remote.closed, true, 'recovery closes an unhealthy connection so Trystero can rediscover it');
  delete room.peers.remote;
  windowListeners.get('online')();
  assert.equal(handlers.statuses.at(-1), 'waiting', 'coming back online alone returns to waiting');
  await session.leave();
  assert.equal(windowListeners.has('online'), false);
  assert.equal(windowListeners.has('offline'), false);
}

{
  const { handlers, room, session } = makeSession();
  room.actions.capacity.onMessage({ full: true, max: 8 }, { peerId: 'host' });
  assert.deepEqual(handlers.fullCalls, [8]);
  for (let index = 0; index < 7; index += 1) {
    const peerId = `peer-${index}`;
    room.peers[peerId] = makePeer();
    room.onPeerJoin(peerId);
    room.actions.hello.onMessage({ name: peerId }, { peerId });
  }
  room.peers.overflow = makePeer();
  room.onPeerJoin('overflow');
  const capacityNotice = room.sent.find((message) => message.name === 'capacity');
  assert.deepEqual(capacityNotice, {
    name: 'capacity',
    data: { full: true, max: 8 },
    options: { target: 'overflow' },
  });
  assert.equal(room.peers.overflow.closed, false, 'the rejected connection is closed late, so the notice can arrive');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(room.peers.overflow.closed, true);
  await session.leave();
}

{
  // A failing capacity notice must not throw or leave an unhandled rejection.
  const { room, session } = makeSession();
  room.actions.capacity.send = () => Promise.reject(new Error('peer gone'));
  for (let index = 0; index < 7; index += 1) {
    const peerId = `peer-${index}`;
    room.peers[peerId] = makePeer();
    room.onPeerJoin(peerId);
    room.actions.hello.onMessage({ name: peerId }, { peerId });
  }
  room.peers.late = makePeer();
  room.onPeerJoin('late');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await session.leave();
}

{
  const requests = [];
  const { handlers, room, session } = makeSession();
  handlers.request = (r) => requests.push(r);
  // makeHandlers builds the object once, so attach the listener on the same object the session reads.
  assert.equal(session.sendRequest('pause'), false, 'nobody to ask in an empty room');
  room.peers.remote = makePeer();
  room.onPeerJoin('remote');
  room.actions.hello.onMessage({ name: 'Remote' }, { peerId: 'remote' });
  room.actions.request.onMessage({ kind: 'pause' }, { peerId: 'remote' });
  room.actions.request.onMessage({ kind: 'pause' }, { peerId: 'remote' });
  room.actions.request.onMessage({ kind: 'delete-everything' }, { peerId: 'stranger' });
  assert.equal(requests.length, 1, 'repeat requests inside three seconds and unknown kinds are ignored');
  assert.deepEqual(requests[0], { name: 'Remote', kind: 'pause', self: false });
  assert.equal(session.sendRequest('ready'), true);
  assert.deepEqual(room.sent.find((m) => m.name === 'request').data, { kind: 'ready' });
  assert.equal(session.sendRequest('seek'), false, 'only pause and ready can be sent');
  await session.leave();
}

{
  const room = makeRoom();
  const calls = [];
  const handlers = { ...makeHandlers(), nuki: (on, name) => calls.push([on, name]), thinking: (name) => calls.push(name) };
  const session = openRoom('ABC234', 'Guest', handlers, { joinRoom: () => room });
  room.peers.host = makePeer();
  room.onPeerJoin('host');
  room.actions.hello.onMessage({ name: 'Host' }, { peerId: 'host' });
  room.actions.nuki.onMessage({ on: true }, { peerId: 'host' });
  room.actions.nuki.onMessage({ on: 'yes' }, { peerId: 'host' });
  room.actions.thinking.onMessage({}, { peerId: 'host' });
  room.actions.thinking.onMessage({}, { peerId: 'host' });
  room.actions.thinking.onMessage({}, { peerId: 'stranger' });
  assert.deepEqual(calls, [[true, 'Host'], 'Host'], 'bad values, repeats and strangers are ignored');
  session.setNuki(true);
  assert.equal(room.sent.some((m) => m.name === 'nuki'), false, 'a guest cannot switch Nuki Time');
  await session.leave();
}

{
  const room = makeRoom();
  const calls = [];
  const session = openRoom('ABC234', 'Host', { ...makeHandlers(), nuki: () => calls.push('x') }, { joinRoom: () => room, host: true });
  session.setNuki(true);
  room.peers.late = makePeer();
  room.onPeerJoin('late');
  const late = room.sent.filter((m) => m.name === 'nuki').at(-1);
  assert.deepEqual(late, { name: 'nuki', data: { on: true }, options: { target: 'late' } }, 'someone joining late gets the current mode');
  room.actions.nuki.onMessage({ on: false }, { peerId: 'late' });
  assert.equal(calls.length, 0, 'the creator ignores others');
  await session.leave();
}

console.log('room lifecycle ok');
