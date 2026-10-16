import { mountFlapLine, setFlap } from './flap.js';
import { LEVEL_WORDS, delayLevel, limitWords, overallLevel, pictureName, smoothnessLevel, speedLevel } from './meters.mjs';
import { CODE_LENGTH, PRESETS, bitrateFor, cleanCode, newRoomCode, openRoom } from './room.js';

// Screen wiring: home, room, source picker, chat and the flap board.
// The entry point for the bundle. Everything here is rendered from room state, never stored.

const $ = (id) => document.getElementById(id);
const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;
const NAME_KEY = 'watchroom.name';
const STATUS_TEXT = {
  ready: 'Ready',
  connecting: 'Connecting',
  live: 'Connected',
  waiting: 'Waiting for others. Share the code.',
  error: 'Connection problem',
};

const state = {
  session: null,
  code: '',
  view: 'home',
  peers: [],
  remote: null,
  unread: 0,
  tab: 'people',
  shareSince: 0,
  clockTimer: null,
  toastTimer: null,
  copyTimer: null,
  codeInputs: [],
  picker: { kind: 'screen', quality: '1080', fps: 30, sourceId: null, sources: [] },
  sendSummary: null,
  controlsTimer: null,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

// ---------- persistence (display name only, per viewer) ----------

function loadName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage can be unavailable; the name simply is not remembered */
  }
}

// ---------- views and status ----------

function setView(view) {
  state.view = view;
  $('app').dataset.view = view;
  $('home').hidden = view !== 'home';
  $('room').hidden = view !== 'room';
  $('room-id').hidden = view !== 'room';
}

function setStatus(kind) {
  const lamp = $('status-lamp');
  lamp.className = 'lamp';
  if (kind === 'live') lamp.classList.add('is-live');
  if (kind === 'connecting' || kind === 'waiting') lamp.classList.add('is-wait');
  if (kind === 'error') lamp.classList.add('is-error');
  $('status-text').textContent = STATUS_TEXT[kind] || STATUS_TEXT.ready;
}

function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

function showHomeError(message) {
  const node = $('home-error');
  node.textContent = message;
  node.hidden = false;
}

function hideHomeError() {
  $('home-error').hidden = true;
}

// ---------- home: name, code entry ----------

function buildCodeInputs() {
  const box = $('code-inputs');
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const input = el('input', 'code-cell');
    input.type = 'text';
    input.maxLength = 1;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Character ${i + 1} of ${CODE_LENGTH}`);
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => {
      input.value = cleanCode(input.value).slice(-1);
      if (input.value && i < CODE_LENGTH - 1) state.codeInputs[i + 1].focus();
      hideHomeError();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !input.value && i > 0) {
        event.preventDefault();
        state.codeInputs[i - 1].value = '';
        state.codeInputs[i - 1].focus();
      } else if (event.key === 'ArrowLeft' && i > 0) {
        state.codeInputs[i - 1].focus();
      } else if (event.key === 'ArrowRight' && i < CODE_LENGTH - 1) {
        state.codeInputs[i + 1].focus();
      }
    });
    input.addEventListener('paste', (event) => {
      const text = cleanCode(event.clipboardData?.getData('text') ?? '');
      if (!text) return;
      event.preventDefault();
      fillCode(text, i);
    });
    box.append(input);
    state.codeInputs.push(input);
  }
}

function fillCode(text, start = 0) {
  const chars = cleanCode(text);
  for (let k = 0; k < chars.length && start + k < CODE_LENGTH; k += 1) {
    state.codeInputs[start + k].value = chars[k];
  }
  const next = Math.min(start + chars.length, CODE_LENGTH - 1);
  state.codeInputs[next].focus();
  hideHomeError();
}

function readCode() {
  return state.codeInputs.map((input) => cleanCode(input.value)).join('');
}

function readName() {
  return $('name').value.trim().slice(0, 24);
}

function startRoom(code) {
  const name = readName();
  if (!name) {
    showHomeError('Add your name first, so the others know who just walked in.');
    $('name').focus();
    return;
  }
  hideHomeError();
  saveName(name);
  if (state.session) leaveRoom();

  state.code = code;
  setView('room');
  setFlap($('room-code'), code);
  setFlap($('now-title'), 'STANDING BY');
  setFlap($('clock'), '00:00:00');
  setStatus('connecting');
  $('chat-input').value = '';
  $('messages').replaceChildren();
  $('people').replaceChildren();
  updateStage();

  const session = openRoom(code, name, handlers);
  state.session = session;
  session.startMic();
}

function onCreate() {
  startRoom(newRoomCode());
}

function onJoin(event) {
  event.preventDefault();
  const code = readCode();
  if (code.length < CODE_LENGTH) {
    showHomeError('Enter all six characters of the room code.');
    const firstEmpty = state.codeInputs.find((input) => !input.value) || state.codeInputs[0];
    firstEmpty.focus();
    return;
  }
  if (!CODE_PATTERN.test(code)) {
    showHomeError('Codes use letters and digits 2 to 9. There is no I, L, O, 0 or 1.');
    return;
  }
  startRoom(code);
}

// ---------- room: presence, dock, chat ----------

function renderPeers(list) {
  const ul = $('people');
  ul.replaceChildren();
  for (const p of list) {
    const li = el('li');
    const who = el('div', 'who');
    const lamp = el('span', p.speaking ? 'lamp is-speaking' : 'lamp');
    lamp.setAttribute('aria-hidden', 'true');
    who.append(lamp, el('span', 'who-name', p.name));
    if (p.you) who.append(el('span', 'who-you', 'You'));

    const tags = el('div', 'status-tags');
    if (p.sharing) tags.append(el('span', 'sharing', 'Sharing'));
    tags.append(el('span', p.mic ? 'on' : '', p.mic ? 'Mic on' : 'Muted'));

    li.append(who, tags);
    ul.append(li);
  }
  $('count').textContent = String(list.length);
}

function updateDock() {
  const me = state.peers.find((p) => p.you);
  const other = state.peers.find((p) => !p.you && p.sharing);

  const micOn = Boolean(me?.mic);
  $('mic-btn').setAttribute('aria-pressed', String(micOn));
  $('mic-label').textContent = micOn ? 'Mic on' : 'Mic off';

  const share = $('share-btn');
  share.classList.toggle('is-live', Boolean(me?.sharing));
  if (me?.sharing) {
    $('share-label').textContent = 'Stop sharing';
    share.disabled = false;
  } else if (other) {
    $('share-label').textContent = `${other.name} is showing`;
    share.disabled = true;
  } else {
    $('share-label').textContent = 'Share screen';
    share.disabled = false;
  }
}

function updateStage() {
  const me = state.peers.find((p) => p.you);
  const remoteSharer = state.peers.find((p) => !p.you && p.sharing);
  const video = $('screen');
  const empty = $('stage-empty');
  const emptyText = $('empty-text');

  let title = '';
  $('player').hidden = !state.remote;
  if (state.remote) {
    if (video.srcObject !== state.remote.stream) video.srcObject = state.remote.stream;
    video.hidden = false;
    empty.hidden = true;
    title = state.remote.info.label || remoteSharer?.label || 'Screen';
  } else {
    video.srcObject = null;
    video.hidden = true;
    empty.hidden = false;
    if (me?.sharing) {
      setFlap($('empty-line'), 'ON THE BOARD');
      emptyText.textContent = `Everyone in the room sees ${me.label} live. Stop any time from the dock.`;
      renderSendPanel(state.sendSummary);
      title = me.label;
    } else if (remoteSharer) {
      setFlap($('empty-line'), 'CONNECTING');
      emptyText.textContent = `${remoteSharer.name} is showing ${remoteSharer.label}. The picture is on its way.`;
      title = remoteSharer.label;
    } else {
      setFlap($('empty-line'), 'NOTHING SHOWING');
      emptyText.textContent = 'Press Share screen to put a movie, a browser tab or a window on the board.';
    }
  }

  setFlap($('now-title'), title || 'STANDING BY');
  trackClock(Boolean(title));
}

function trackClock(showing) {
  if (showing && !state.clockTimer) {
    state.shareSince = Date.now();
    tickClock();
    state.clockTimer = setInterval(tickClock, 1000);
  } else if (!showing && state.clockTimer) {
    clearInterval(state.clockTimer);
    state.clockTimer = null;
    setFlap($('clock'), '00:00:00');
  }
}

function tickClock() {
  setFlap($('clock'), formatElapsed(Date.now() - state.shareSince));
}

function renderUnread() {
  const n = state.unread;
  setFlap($('unread'), n > 9 ? '9+' : n ? String(n) : '');
  $('unread').hidden = n === 0;
  $('tab-dot').hidden = n === 0;
}

function addChat(msg) {
  const list = $('messages');
  const li = el('li', 'msg');
  const head = el('div', 'msg-head');
  head.append(el('span', msg.self ? 'msg-name is-you' : 'msg-name', msg.name), el('time', 'msg-time', formatTime(msg.at)));
  li.append(head, el('p', 'msg-text', msg.text));
  list.append(li);
  list.scrollTop = list.scrollHeight;
  if (state.tab !== 'chat') {
    state.unread += 1;
    renderUnread();
  }
}

function addSystem(text) {
  const list = $('messages');
  list.append(el('li', 'msg is-system', text));
  list.scrollTop = list.scrollHeight;
}

function selectTab(name) {
  state.tab = name;
  const isChat = name === 'chat';
  $('tab-people').setAttribute('aria-selected', String(!isChat));
  $('tab-chat').setAttribute('aria-selected', String(isChat));
  $('panel-people').hidden = isChat;
  $('panel-chat').hidden = !isChat;
  if (isChat) {
    state.unread = 0;
    renderUnread();
  }
}

// ---------- share picker ----------

function selectedSource() {
  return state.picker.sources.find((s) => s.id === state.picker.sourceId) || null;
}

function renderSources() {
  const box = $('sources');
  box.replaceChildren();
  const items = state.picker.sources.filter((s) => s.kind === state.picker.kind);
  $('sources-empty').hidden = items.length > 0;
  for (const source of items) {
    const button = el('button', 'source');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(source.id === state.picker.sourceId));
    const img = el('img', 'source-thumb');
    img.alt = '';
    img.src = source.thumbnail;
    button.append(img, el('span', 'source-name', source.name));
    button.addEventListener('click', () => selectSource(source.id));
    box.append(button);
  }
  updatePickerFooter();
}

function selectSource(id) {
  state.picker.sourceId = id;
  renderSources();
}

function updatePickerFooter() {
  const source = selectedSource();
  $('picker-share').disabled = !source;
  $('picker-hint').textContent = source ? `Ready to show ${source.name}.` : 'Choose a source to continue.';

  const { quality, fps } = state.picker;
  const viewers = Math.max(1, state.peers.length - 1);
  const perViewer = bitrateFor(quality, fps, viewers) / 1e6;
  const total = perViewer * viewers;
  let cost = `${PRESETS[quality].label} at ${fps} fps needs about ${perViewer.toFixed(1)} Mbps up per viewer. `;
  cost += `With ${viewers} ${viewers === 1 ? 'viewer' : 'viewers'} that is ${total.toFixed(1)} Mbps.`;
  if (quality === '2160' && fps === 60) {
    cost += ' 4K at 60 fps needs a recent graphics card on this computer. Keep it to a few viewers.';
  }
  $('picker-cost').textContent = cost;
}

function setPickerKind(kind) {
  state.picker.kind = kind;
  for (const btn of document.querySelectorAll('[data-kind]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.kind === kind));
  }
  renderSources();
}

function setQuality(quality) {
  state.picker.quality = quality;
  for (const btn of document.querySelectorAll('[data-quality]')) {
    btn.setAttribute('aria-checked', String(btn.dataset.quality === quality));
  }
  updatePickerFooter();
}

function setFps(fps) {
  state.picker.fps = fps;
  for (const btn of document.querySelectorAll('[data-fps]')) {
    btn.setAttribute('aria-checked', String(Number(btn.dataset.fps) === fps));
  }
  updatePickerFooter();
}

async function openPicker() {
  if (!state.session || state.session.me.sharing) return;
  $('picker').hidden = false;
  state.picker.sourceId = null;
  updatePickerFooter();

  const access = await window.watchroom.screenAccess();
  $('perm-notice').hidden = !(access === 'denied' || access === 'restricted');
  $('open-settings').hidden = window.watchroom.platform !== 'darwin';

  state.picker.sources = await window.watchroom.listSources().catch(() => []);
  setPickerKind(state.picker.kind);
  $('sources').querySelector('button')?.focus();
}

function closePicker() {
  $('picker').hidden = true;
  window.watchroom.cancelShare().catch(() => {});
  $('share-btn').focus();
}

function describeShareError(err) {
  if (err?.name === 'NotAllowedError') {
    return 'Screen sharing was blocked. On a Mac, check Screen Recording for Watchroom in System Settings.';
  }
  return err?.message || 'The screen could not be shared.';
}

async function confirmShare() {
  const source = selectedSource();
  if (!source || !state.session) return;
  const audio = $('audio-toggle').checked;
  const { quality, fps } = state.picker;
  $('picker').hidden = true;
  try {
    const result = await state.session.startShare({ sourceId: source.id, label: source.name, audio, quality, fps });
    if (audio && !result.hasAudio) toast('This source has no system sound. Sharing the picture only.');
  } catch (err) {
    toast(describeShareError(err), true);
  }
}

// ---------- session handlers ----------

const handlers = {
  peers(list) {
    state.peers = list;
    renderPeers(list);
    updateDock();
    updateStage();
  },
  chat: addChat,
  system: addSystem,
  screen(stream, info) {
    state.remote = stream ? { stream, info } : null;
    updateStage();
  },
  status(kind) {
    setStatus(kind);
  },
  error(message) {
    toast(message, true);
  },
  quality(info) {
    renderPlayer(info);
  },
  sendStats(summary) {
    state.sendSummary = summary;
    renderSendPanel(summary);
    updateStage();
  },
};

// ---------- viewer player ----------

function setMeter(name, level, value) {
  $(`meter-${name}-value`).textContent = value;
  const cells = $(`meter-${name}`).querySelectorAll('.segments i');
  cells.forEach((cell, i) => cell.classList.toggle('on', i < level));
}

// Everything the viewer sees about the picture and the connection, in plain words.
function renderPlayer(info) {
  if (!state.remote || !info.width) return;
  const used = info.usedMbps ?? 0;
  const available = info.availableMbps ?? 0;
  const speed = speedLevel(used, available);
  const smooth = smoothnessLevel(info.lossPct ?? 0, info.fps ?? 0, 0);
  const delay = delayLevel(info.delayMs ?? 0);
  const overall = overallLevel(speed, smooth, delay);

  $('player-title').textContent = state.remote.info.label || 'Live';
  $('player-status').textContent = `Connection ${LEVEL_WORDS[overall].toLowerCase()}`;
  setMeter('speed', speed, `${LEVEL_WORDS[speed]} · ${used} Mbps`);
  setMeter('smooth', smooth, `${LEVEL_WORDS[smooth]} · ${info.lossPct}% lost`);
  setMeter('delay', delay, `${LEVEL_WORDS[delay]} · ${info.delayMs} ms`);
  $('meter-picture-value').textContent = `${pictureName(info.height)} · ${info.fps} fps`;

  $('d-res').textContent = `${info.width}×${info.height}`;
  $('d-fps').textContent = `${info.fps} fps`;
  $('d-used').textContent = `${used} Mbps`;
  $('d-avail').textContent = available ? `${available} Mbps` : 'Measuring';
  $('d-loss').textContent = `${info.lossPct}%`;
  $('d-buffer').textContent = `${info.bufferMs} ms`;
  $('d-rtt').textContent = info.rttMs ? `${info.rttMs} ms` : 'Measuring';
}

// The sharer's own view: what viewers are receiving and what limits it.
function renderSendPanel(s) {
  const sharing = Boolean(state.peers.find((p) => p.you)?.sharing);
  const panel = $('send-panel');
  panel.hidden = !sharing || !s;
  if (panel.hidden) return;
  const speed = speedLevel(s.uploadMbps, s.availableMbps);
  $('s-picture').textContent = `${s.width}×${s.height} · ${s.encoderFps || s.fps} fps`;
  $('s-upload').textContent = `${s.uploadMbps} Mbps · ${LEVEL_WORDS[speed]}`;
  $('s-avail').textContent = s.availableMbps ? `${s.availableMbps} Mbps` : 'Measuring';
  $('s-rtt').textContent = s.rttMs ? `${s.rttMs} ms` : 'Measuring';
  $('s-limit').textContent = limitWords(s.limit);
  $('s-viewers').textContent = String(s.viewers);
}

function showPlayerControls() {
  const stage = $('stage');
  stage.classList.add('show-controls');
  clearTimeout(state.controlsTimer);
  state.controlsTimer = setTimeout(() => stage.classList.remove('show-controls'), 2500);
}

function setMuted(muted) {
  const video = $('screen');
  video.muted = muted;
  const btn = $('mute-btn');
  btn.setAttribute('aria-pressed', String(muted));
  btn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

function toggleFullscreen() {
  if (!state.remote) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    $('stage').requestFullscreen().catch(() => toast('Full screen is not available right now.', true));
  }
}

async function togglePopOut() {
  if (!state.remote) return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await $('screen').requestPictureInPicture();
  } catch {
    toast('Pop-out is not available for this picture right now.', true);
  }
}


function leaveRoom() {
  const session = state.session;
  state.session = null;
  state.remote = null;
  state.peers = [];
  state.unread = 0;
  state.code = '';
  if (state.clockTimer) {
    clearInterval(state.clockTimer);
    state.clockTimer = null;
  }
  $('screen').srcObject = null;
  $('picker').hidden = true;
  renderUnread();
  selectTab('people');
  if (session) session.leave().catch(() => {});
  setView('home');
  setStatus('ready');
}

async function onMicClick() {
  if (!state.session) return;
  await state.session.toggleMic();
}

function onShareClick() {
  if (!state.session) return;
  if (state.session.me.sharing) {
    state.session.stopShare();
    return;
  }
  openPicker();
}

function onCopy() {
  if (!state.code) return;
  navigator.clipboard?.writeText(state.code).catch(() => {});
  $('copy-label').textContent = 'Copied';
  clearTimeout(state.copyTimer);
  state.copyTimer = setTimeout(() => {
    $('copy-label').textContent = 'Copy code';
  }, 1600);
}

function isTyping(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

// ---------- updates ----------

const UPDATE_TEXT = {
  checking: 'Checking for updates…',
  'not-configured': 'Updates not set up yet',
  none: 'No releases yet',
  error: 'Can’t check right now. Try again',
};

let updateUrl = null;

function setUpdateChip(kind, text) {
  $('update-chip').dataset.state = kind;
  $('update-label').textContent = text ?? UPDATE_TEXT[kind] ?? 'Check for updates';
}

async function runUpdateCheck() {
  setUpdateChip('checking');
  const result = await window.watchroom.checkForUpdates().catch(() => ({ status: 'error' }));
  updateUrl = result.status === 'available' ? result.url : null;

  if (result.status === 'available') {
    setUpdateChip('available', `Update ${result.latest} · Download`);
    toast(`Version ${result.latest} is available. Click the update button to download it.`);
  } else if (result.status === 'current') {
    setUpdateChip('current', `Up to date · ${state.version}`);
  } else if (result.status === 'error') {
    setUpdateChip('error', result.message ? `${result.message}` : UPDATE_TEXT.error);
  } else {
    setUpdateChip(result.status);
  }
}

function onUpdateChip() {
  if (updateUrl) {
    window.watchroom.openUpdate(updateUrl);
    return;
  }
  runUpdateCheck();
}

// ---------- boot ----------

function init() {
  if (window.watchroom.platform === 'darwin') document.documentElement.classList.add('is-mac');

  mountFlapLine($('wordmark-a'), 5);
  mountFlapLine($('wordmark-b'), 8);
  mountFlapLine($('room-code'), CODE_LENGTH);
  mountFlapLine($('now-title'), 26);
  mountFlapLine($('clock'), 8);
  mountFlapLine($('empty-line'), 15);
  mountFlapLine($('unread'), 2);

  setTimeout(() => {
    setFlap($('wordmark-a'), 'WATCH');
    setFlap($('wordmark-b'), 'TOGETHER');
  }, 180);

  buildCodeInputs();
  $('name').value = loadName();
  setStatus('ready');

  $('create-room').addEventListener('click', onCreate);
  $('join-form').addEventListener('submit', onJoin);
  $('name').addEventListener('input', hideHomeError);
  $('name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onCreate();
  });

  $('mic-btn').addEventListener('click', onMicClick);
  $('share-btn').addEventListener('click', onShareClick);
  $('chat-btn').addEventListener('click', () => selectTab('chat'));
  $('leave-btn').addEventListener('click', leaveRoom);
  $('copy-code').addEventListener('click', onCopy);
  $('tab-people').addEventListener('click', () => selectTab('people'));
  $('tab-chat').addEventListener('click', () => selectTab('chat'));

  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('chat-input');
    if (!state.session || !input.value.trim()) return;
    state.session.sendChat(input.value);
    input.value = '';
  });

  $('picker-close').addEventListener('click', closePicker);
  $('picker-cancel').addEventListener('click', closePicker);
  $('picker-share').addEventListener('click', confirmShare);
  $('open-settings').addEventListener('click', () => window.watchroom.openScreenSettings());
  $('picker').addEventListener('click', (event) => {
    if (event.target === $('picker')) closePicker();
  });
  for (const btn of document.querySelectorAll('[data-kind]')) {
    btn.addEventListener('click', () => setPickerKind(btn.dataset.kind));
  }
  for (const btn of document.querySelectorAll('[data-quality]')) {
    btn.addEventListener('click', () => {
      setQuality(btn.dataset.quality);
      if (state.session?.me.sharing) state.session.setProfile(state.picker.quality, state.picker.fps);
    });
  }
  for (const btn of document.querySelectorAll('[data-fps]')) {
    btn.addEventListener('click', () => {
      setFps(Number(btn.dataset.fps));
      if (state.session?.me.sharing) state.session.setProfile(state.picker.quality, state.picker.fps);
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('picker').hidden) closePicker();
    if (event.key.toLowerCase() === 'm' && state.view === 'room' && !isTyping(event.target) && !event.metaKey && !event.ctrlKey) {
      onMicClick();
    }
  });

  $('update-chip').addEventListener('click', onUpdateChip);
  window.watchroom.appInfo().then((info) => {
    state.version = info.version;
    setTimeout(runUpdateCheck, 2000);
  });

  // Viewer player: controls appear on movement, volume and mute, full screen, pop-out.
  $('screen').volume = 0.8;
  $('volume').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    $('screen').volume = value / 100;
    setMuted(value === 0);
  });
  $('mute-btn').addEventListener('click', () => {
    const muting = !$('screen').muted;
    setMuted(muting);
    if (!muting && $('screen').volume === 0) {
      $('screen').volume = 0.5;
      $('volume').value = '50';
    }
  });
  $('fullscreen-btn').addEventListener('click', toggleFullscreen);
  $('pip-btn').addEventListener('click', togglePopOut);
  $('details-toggle').addEventListener('click', () => {
    const open = $('player-details').hidden;
    $('player-details').hidden = !open;
    $('details-toggle').setAttribute('aria-expanded', String(open));
    $('details-toggle').textContent = open ? 'Hide details' : 'Details';
  });
  $('stage').addEventListener('mousemove', showPlayerControls);
  $('stage').addEventListener('dblclick', toggleFullscreen);
  $('stage').addEventListener('mouseleave', () => $('stage').classList.remove('show-controls'));
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'f' && state.view === 'room' && state.remote && !isTyping(event.target)) {
      toggleFullscreen();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.session) state.session.leave().catch(() => {});
  });

  setView('home');
  if ($('name').value) state.codeInputs[0].focus();
  else $('name').focus();
}

init();
