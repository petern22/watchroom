import './web-shim.js';
import { mountFlapLine, setFlap } from './flap.js';
import { LEVEL_WORDS, delayLevel, limitWords, overallLevel, pictureName, smoothnessLevel, speedLevel } from './meters.mjs';
import { createAttemptGate } from './room-policy.mjs';
import { DEFAULT_SETTINGS, formatTogether, glowPulse, heartBurst, isHeart, loadTogether, saveTogether, playChime, loadSettings, saveSettings, searchGifs, stageAlert, systemNotify } from './extras.js';
import { levelFromSlider, sliderFromLevel } from './room-policy.mjs';
import { CODE_LENGTH, PRESETS, bitrateFor, cleanCode, newRoomCode, openRoom } from './room.js';

// Screen wiring: home, room, source picker, chat and the flap board.
// The entry point for the bundle. Everything here is rendered from room state, never stored.

const $ = (id) => document.getElementById(id);
const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;
const NAME_KEY = 'watchroom.name';
const roomAttempts = createAttemptGate();
let settings = loadSettings();
const STATUS_TEXT = {
  ready: 'Ready',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting…',
  offline: 'Offline. Waiting for your connection.',
  live: 'Connected',
  waiting: 'Waiting for others. Share the code.',
  error: 'Connection problem',
};

const state = {
  askedPause: false,
  isHost: false,
  roomNuki: false,
  preview: null,
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
  ducked: false,
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

// ---------- persistence (per viewer: name and the last share choices) ----------

const SHARE_KEY = 'watchroom.share';

function loadShareSettings() {
  try {
    return JSON.parse(localStorage.getItem(SHARE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveShareSettings(settings) {
  try {
    localStorage.setItem(SHARE_KEY, JSON.stringify(settings));
  } catch {
    /* storage can be unavailable; the choices simply are not remembered */
  }
}

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
  if (kind === 'connecting' || kind === 'reconnecting' || kind === 'waiting') lamp.classList.add('is-wait');
  if (kind === 'offline' || kind === 'error') lamp.classList.add('is-error');
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

function micOptionsFrom(s) {
  return { mode: s.micMode, threshold: levelFromSlider(s.threshold), deviceId: s.micDevice };
}

async function startRoom(code, host = false) {
  // Asked here, straight from the button press, because browsers only allow the question after a click.
  if (settings.notify) askNotificationPermission();
  const attempt = roomAttempts.begin();
  const name = readName();
  if (!name) {
    showHomeError('Add your name first, so the others know who just walked in.');
    $('name').focus();
    return;
  }
  hideHomeError();
  saveName(name);
  setStatus('connecting');
  const buttons = [$('create-room'), $('join-form').querySelector('button')];
  const activeButton = host ? buttons[0] : buttons[1];
  buttons.forEach((button) => { button.disabled = true; });
  activeButton.setAttribute('aria-busy', 'true');
  let turn, forceRelay, relayUrl;
  try {
    [turn, forceRelay, relayUrl] = await Promise.all([
      window.watchroom.turnServers(), window.watchroom.forceRelay(), window.watchroom.relayUrl(),
    ]);
  } catch {
    if (roomAttempts.isCurrent(attempt)) {
      setStatus('error');
      showHomeError('Could not prepare the connection. Please try again.');
    }
    return;
  } finally {
    if (roomAttempts.isCurrent(attempt)) {
      buttons.forEach((button) => { button.disabled = false; button.removeAttribute('aria-busy'); });
    }
  }
  if (!roomAttempts.isCurrent(attempt)) return;
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

  const session = openRoom(code, name, handlers, { turnConfig: turn, forceRelay, relayUrl, host });
  state.session = session;
  session.setMicOptions(micOptionsFrom(settings));
  state.isHost = host;
  state.roomNuki = false;
  if (host) session.setNuki(settings.nuki);
  applyNuki();
}

function onCreate() {
  startRoom(newRoomCode(), true);
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

  // Viewers can ask the sharer to pause. It is only a request: the sharer still presses pause themselves.
  const pause = $('pause-btn');
  pause.hidden = !other;
  if (!other) state.askedPause = false;
  $('pause-label').textContent = state.askedPause ? 'Ask to resume' : 'Ask to pause';

  const share = $('share-btn');
  share.classList.toggle('is-live', Boolean(me?.sharing));
  if (me?.sharing) {
    $('share-label').textContent = 'Stop sharing';
    share.disabled = false;
  } else if (other) {
    $('share-label').textContent = `${other.name} is showing`;
    share.disabled = true;
  } else if (!navigator.mediaDevices?.getDisplayMedia) {
    // Phones and tablets cannot share their screen from a browser. They can still watch, talk and chat.
    $('share-label').textContent = 'Can’t share here';
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
  const ambientVideo = $('ambient-video');
  const ambientStream = state.remote?.stream || (me?.sharing ? state.preview : null);
  if (ambientVideo && ambientVideo.srcObject !== ambientStream) {
    ambientVideo.srcObject = ambientStream;
    if (ambientStream) ambientVideo.play().catch(() => {});
  }
  document.body.classList.toggle('has-ambient', Boolean(ambientStream));
  if (!video._ambientTimer) {
    const sample = document.createElement('canvas');
    sample.width = sample.height = 8;
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    video._ambientTimer = setInterval(() => {
      const source = state.remote ? video : $('preview-video');
      if (!source.srcObject || source.readyState < 2 || !ctx) {
        $('stage').style.removeProperty('--ambient');
        return;
      }
      try {
        ctx.drawImage(source, 0, 0, 8, 8);
        const px = ctx.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
        $('stage').style.setProperty('--ambient', `rgb(${r >> 6}, ${g >> 6}, ${b >> 6})`);
      } catch { $('stage').style.removeProperty('--ambient'); }
    }, 500);
  }
  const empty = $('stage-empty');
  const emptyText = $('empty-text');

  let title = '';
  $('player').hidden = !state.remote;
  if (state.remote) {
    if (video.srcObject !== state.remote.stream) {
      video.srcObject = state.remote.stream;
      video.play().catch(() => toast('Tap the screen to turn on the sound.'));
    }
    video.hidden = false;
    empty.hidden = true;
    title = state.remote.info.label || remoteSharer?.label || 'Screen';
  } else {
    video.srcObject = null;
    video.hidden = true;
    empty.hidden = false;
    setPseudoFullscreen(false);
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
      setFlap($('empty-line'), nukiActive() ? 'NUKI TIME' : 'NOTHING SHOWING');
      emptyText.textContent = nukiActive()
        ? 'Pick something to watch together, then press Share screen.'
        : 'Press Share screen to put a movie, a browser tab or a window on the board.';
    }
  }

  // The sharer sees what the room sees, small, above the send details.
  const pv = $('preview-video');
  const previewing = !state.remote && Boolean(me?.sharing && state.preview && settings.preview);
  if (previewing && pv.srcObject !== state.preview) pv.srcObject = state.preview;
  if (!previewing) pv.srcObject = null;
  pv.hidden = !previewing;
  empty.classList.toggle('is-previewing', previewing);
  $('preview-badge').hidden = !previewing;

  setFlap($('now-title'), title || (nukiActive() ? 'NUKI TIME' : 'STANDING BY'));
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
  if (msg.gif) {
    const img = el('img', 'msg-gif');
    img.src = msg.gif;
    img.alt = msg.text;
    img.addEventListener('load', () => {
      list.scrollTop = list.scrollHeight;
    });
    li.append(head, img);
  } else {
    li.append(head, el('p', 'msg-text', msg.text));
  }
  list.append(li);
  if (settings.hearts && !msg.gif && isHeart(msg.text)) {
    // The desktop app can draw over the movie in other windows. A browser can only draw inside its own page.
    playHearts();
  }
  if (!msg.self) alertUser(msg.name, msg.gif ? 'Sent a GIF' : msg.text);
  while (list.childElementCount > 250) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
  if (state.tab !== 'chat') {
    state.unread += 1;
    renderUnread();
  }
}

// Messages and requests reach you even when the movie is full screen, or when another window is in front.
function alertUser(title, text) {
  if (!settings.notify) return;
  if (window.watchroom.showAlert) window.watchroom.showAlert(title, text).catch(() => systemNotify(title, text));
  else systemNotify(title, text);
  const stage = $('stage');
  if (document.fullscreenElement === stage || stage.classList.contains('pseudo-fs')) stageAlert($('stage-alerts'), title, text);
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
  $('picker-hint').textContent =
    source?.id === 'web'
      ? 'Your browser asks what to share next.'
      : source
        ? `Ready to show ${source.name}.`
        : 'Choose a source to continue.';

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
  if (window.watchroom.isWeb) {
    // In a browser, the browser itself asks what to share after you confirm here.
    $('picker').classList.add('is-web');
    state.picker.sources = [{ id: 'web', name: 'Chosen in your browser', kind: 'screen', thumbnail: '' }];
    state.picker.sourceId = 'web';
    $('perm-notice').hidden = true;
    updatePickerFooter();
    $('picker-share').focus();
    return;
  }
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
  if (err?.name === 'NotFoundError') return 'No screen or window is available to share.';
  if (err?.name === 'NotReadableError') return 'The selected screen is busy or blocked by the operating system. Try another source.';
  if (err?.name === 'AbortError') return 'Screen sharing stopped before it could start. Please try again.';
  return err?.message || 'The screen could not be shared.';
}

async function confirmShare() {
  const source = selectedSource();
  if (!source || !state.session) return;
  const audio = $('audio-toggle').checked;
  const lowDelay = $('lowdelay-toggle').checked;
  const sharp = $('sharp-toggle').checked;
  const { quality, fps } = state.picker;
  saveShareSettings({ quality, fps, audio, lowDelay, sharp });
  $('picker').hidden = true;
  try {
    const result = await state.session.startShare({ sourceId: source.id, label: source.id === 'web' ? '' : source.name, audio, quality, fps, lowDelay, sharp });
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
    const talking = list.some((p) => !p.you && p.speaking);
    if (talking !== state.ducked) {
      state.ducked = talking;
      applyVolume();
    }
  },
  chat: addChat,
  system: addSystem,
  nuki(on, name) {
    if (on === state.roomNuki) return;
    state.roomNuki = on;
    applyNuki();
    addSystem(on ? 'Nuki Time is on.' : 'Nuki Time is off.');
    if (on && settings.hearts) playHearts();
  },
  thinking(name) {
    if (!nukiActive()) return;
    if (window.watchroom.showGlow) window.watchroom.showGlow().catch(glowPulse);
    else glowPulse();
    const text = `${name} is thinking of you`;
    addSystem(`${text}.`);
    alertUser('Nuki Time', text);
  },
  presence(kind) {
    if (settings.sounds) playChime(kind);
  },
  micLevel(level) {
    $('level-fill').style.width = `${sliderFromLevel(level)}%`;
  },
  preview(stream) {
    state.preview = stream;
    updateStage();
  },
  request({ name, kind, self }) {
    const sharer = state.peers.find((p) => p.sharing && !p.you)?.name;
    const text =
      kind === 'pause'
        ? `${self ? 'You ask' : `${name} asks`} to pause${sharer && !self ? `. Only ${sharer} can press pause` : ''}.`
        : `${self ? 'You are' : `${name} is`} ready to continue.`;
    addSystem(text);
    if (!self) {
      toast(text);
      alertUser(name, text);
    }
  },
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
  full(max) {
    toast(`This room is full. It supports up to ${max} people.`, true);
    leaveRoom();
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
  $('d-route').textContent = info.route === 'relay' ? 'Relayed (Cloudflare)' : info.route === 'direct' ? 'Direct' : 'Measuring';
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
  $('s-codec').textContent = s.codec ? (s.codec === 'H264' ? 'H.264' : s.codec) : 'Measuring';
  $('s-viewers').textContent = String(s.viewers);
}

function showPlayerControls() {
  const stage = $('stage');
  stage.classList.add('show-controls');
  clearTimeout(state.controlsTimer);
  state.controlsTimer = setTimeout(() => stage.classList.remove('show-controls'), 2500);
}

// The movie's volume follows the slider, and drops to 30% while someone in the room is talking.
function applyVolume() {
  const base = Number($('volume').value) / 100;
  $('screen').volume = state.ducked ? base * (settings.duck / 100) : base;
}

function setMuted(muted) {
  const video = $('screen');
  video.muted = muted;
  const btn = $('mute-btn');
  btn.setAttribute('aria-pressed', String(muted));
  btn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

// Full screen with fallbacks: the standard call, the old WebKit call, the iPhone video player,
// and last a stage that fills the page (for browsers that offer nothing else).
function toggleFullscreen() {
  if (!state.remote) return;
  const stage = $('stage');
  const video = $('screen');
  if (stage.classList.contains('pseudo-fs')) return setPseudoFullscreen(false);
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
  const fallback = () => {
    if (video.webkitEnterFullscreen) {
      try {
        video.webkitEnterFullscreen();
        return;
      } catch {}
    }
    setPseudoFullscreen(true);
  };
  if (!request) return fallback();
  Promise.resolve(request.call(stage)).catch(fallback);
}

function setPseudoFullscreen(on) {
  $('stage').classList.toggle('pseudo-fs', on);
  document.body.classList.toggle('has-pseudo-fs', on);
  showPlayerControls();
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
  roomAttempts.cancel();
  const session = state.session;
  state.session = null;
  state.isHost = false;
  state.roomNuki = false;
  state.remote = null;
  state.peers = [];
  state.unread = 0;
  state.code = '';
  if (state.clockTimer) {
    clearInterval(state.clockTimer);
    state.clockTimer = null;
  }
  $('screen').srcObject = null;
  $('ambient-video').srcObject = null;
  document.body.classList.remove('has-ambient');
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

async function onCopy() {
  if (!state.code) return;
  // In a browser, copy a link friends can open to join straight away. On the desktop, copy the code.
  const web = window.watchroom.isWeb;
  const text = web ? `${location.origin}${location.pathname}#join=${state.code}` : state.code;
  const copied = await window.watchroom.copyText(text).catch(() => false);
  $('copy-label').textContent = copied ? 'Copied' : 'Copy failed';
  clearTimeout(state.copyTimer);
  state.copyTimer = setTimeout(() => {
    $('copy-label').textContent = web ? 'Copy link' : 'Copy code';
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
  if (window.watchroom.isWeb) return;
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

// Browsers offer to install the web app. The update button becomes an Install button when they do.
function setupInstallChip() {
  const chip = $('update-chip');
  chip.hidden = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installEvent = event;
    setUpdateChip('available', 'Install app');
    chip.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.installEvent = null;
    chip.hidden = true;
  });
}

function onUpdateChip() {
  if (state.installEvent) {
    state.installEvent.prompt();
    state.installEvent = null;
    return;
  }
  if (updateUrl) {
    window.watchroom.openUpdate(updateUrl);
    return;
  }
  runUpdateCheck();
}

// ---------- invite links ----------

// A watchroom:// link fills in the code. The room is joined once there is a name to show.
function handleInvite(code) {
  if (!code || !CODE_PATTERN.test(code)) return;
  state.codeInputs.forEach((input, i) => {
    input.value = code[i];
  });
  if (readName()) {
    startRoom(code);
  } else {
    showHomeError('Enter your name, then press Start a room or Join room.');
    $('name').focus();
  }
}

// ---------- boot ----------

// ---------- settings and emoji ----------

// Inside someone else's room, their choice applies. Otherwise your own.
function nukiActive() {
  return state.session && !state.isHost ? state.roomNuki : settings.nuki;
}

function applyNuki() {
  const on = Boolean(nukiActive());
  $('app').classList.toggle('is-nuki', on);
  $('thinking-btn').hidden = !on;
  $('together').hidden = !on;
  $('together').textContent = formatTogether(loadTogether());
  syncSettingsForm();
  updateStage();
}

function playHearts() {
  // The desktop app can draw over the movie in other windows. A browser can only draw inside its own page.
  if (window.watchroom.showHearts) window.watchroom.showHearts().catch(heartBurst);
  else heartBurst();
}

// Counts only time actually spent together: Nuki Time on, and someone else in the room.
const TOGETHER_TICK_S = 30;
function tickTogether() {
  if (!state.session || !nukiActive() || !state.peers.some((p) => !p.you)) return;
  const total = loadTogether() + TOGETHER_TICK_S;
  saveTogether(total);
  $('together').textContent = formatTogether(total);
}

function syncSettingsForm() {
  $('duck').value = settings.duck;
  $('duck-value').textContent = `${settings.duck}%`;
  $('threshold').value = settings.threshold;
  $('level-mark').style.left = `${settings.threshold}%`;
  $('notify-toggle').checked = settings.notify;
  $('hearts-toggle').checked = settings.hearts;
  $('preview-toggle').checked = settings.preview;
  $('sounds-toggle').checked = settings.sounds;
  const guest = Boolean(state.session && !state.isHost);
  $('nuki-toggle').checked = nukiActive();
  $('nuki-toggle').disabled = guest;
  $('nuki-hint').textContent = guest
    ? 'Only the person who created this room can change this.'
    : 'Turns on for everyone in rooms you create.';
  $('threshold-row').hidden = settings.micMode !== 'voice';
  document.querySelectorAll('#settings [data-mode]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.mode === settings.micMode));
  });
}

async function refreshMicDevices() {
  const select = $('mic-device');
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
    select.replaceChildren(new Option('System default', ''));
    devices.forEach((d, i) => {
      if (d.deviceId !== 'default') select.append(new Option(d.label || `Microphone ${i + 1}`, d.deviceId));
    });
    select.value = [...select.options].some((o) => o.value === settings.micDevice) ? settings.micDevice : '';
  } catch {
    /* no device list in this browser; the default microphone is used */
  }
}

function changeSettings(patch) {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  state.session?.setMicOptions(micOptionsFrom(settings));
  applyVolume();
  updateStage();
  syncSettingsForm();
}

function openSettings() {
  syncSettingsForm();
  $('settings').hidden = false;
  refreshMicDevices();
  $('settings-close').focus();
}

function closeSettings() {
  $('settings').hidden = true;
  $('settings-btn').focus();
}

async function askNotificationPermission() {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'default') return Notification.requestPermission().catch(() => 'denied');
  return Notification.permission;
}

function setupSettings() {
  syncSettingsForm();
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings').addEventListener('click', (event) => {
    if (event.target === $('settings')) closeSettings();
  });
  $('mic-device').addEventListener('change', (event) => changeSettings({ micDevice: event.target.value }));
  document.querySelectorAll('#settings [data-mode]').forEach((b) => {
    b.addEventListener('click', () => changeSettings({ micMode: b.dataset.mode }));
  });
  $('threshold').addEventListener('input', (event) => changeSettings({ threshold: Number(event.target.value) }));
  $('duck').addEventListener('input', (event) => changeSettings({ duck: Number(event.target.value) }));
  $('hearts-toggle').addEventListener('change', (event) => changeSettings({ hearts: event.target.checked }));
  $('nuki-toggle').addEventListener('change', (event) => {
    changeSettings({ nuki: event.target.checked });
    state.session?.setNuki(settings.nuki);
    applyNuki();
    if (settings.nuki && settings.hearts) playHearts();
  });
  $('sounds-toggle').addEventListener('change', (event) => changeSettings({ sounds: event.target.checked }));
  $('preview-toggle').addEventListener('change', (event) => changeSettings({ preview: event.target.checked }));
  $('notify-toggle').addEventListener('change', async (event) => {
    if (event.target.checked && (await askNotificationPermission()) !== 'granted') {
      toast('Notifications are blocked. Allow them for Watchroom in your system or browser settings.', true);
    }
    changeSettings({ notify: event.target.checked });
  });
  $('mic-test').addEventListener('click', async () => {
    if (!state.session) {
      toast('Join a room first, then test your microphone here.', true);
      return;
    }
    if (await state.session.startMic()) $('mic-hint').textContent = 'Talk now. The bar shows your voice. The white line is your threshold.';
    refreshMicDevices();
  });
}

function setupGifs() {
  const pop = $('gif-pop');
  const grid = $('gif-grid');
  const note = $('gif-note');
  let searchId = 0;
  let timer = null;
  const load = async (query) => {
    const id = ++searchId;
    note.textContent = 'Loading…';
    note.hidden = false;
    let gifs;
    try {
      gifs = await searchGifs(query);
    } catch {
      if (id === searchId) note.textContent = 'GIFs are unavailable right now. Try again later.';
      return;
    }
    if (id !== searchId) return;
    note.hidden = gifs.length > 0;
    note.textContent = 'No GIFs found.';
    grid.replaceChildren(
      ...gifs.map((gif) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', gif.title);
        const img = document.createElement('img');
        img.src = gif.preview;
        img.alt = '';
        img.loading = 'lazy';
        b.append(img);
        b.addEventListener('click', () => {
          state.session?.sendGif(gif.url, gif.title);
          toggle(false);
        });
        return b;
      }),
    );
  };
  const toggle = (open) => {
    pop.hidden = !open;
    $('gif-btn').setAttribute('aria-expanded', String(open));
    if (open) {
      $('gif-search').value = '';
      load('');
      $('gif-search').focus();
    }
  };
  $('gif-btn').addEventListener('click', () => toggle(pop.hidden));
  $('gif-search').addEventListener('input', (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => load(event.target.value), 350);
  });
  // The heart button starts the love animation for everyone in the room.
  $('heart-btn').addEventListener('click', () => state.session?.sendChat('❤️'));
  document.addEventListener('pointerdown', (event) => {
    if (!pop.hidden && !pop.contains(event.target) && !$('gif-btn').contains(event.target)) toggle(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !pop.hidden) toggle(false);
  });
}

function init() {
  document.addEventListener('keydown', () => { document.documentElement.dataset.input = 'keyboard'; }, true);
  document.addEventListener('pointerdown', () => { document.documentElement.dataset.input = 'pointer'; }, true);
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

  setupSettings();
  setupGifs();
  applyNuki();
  setInterval(tickTogether, TOGETHER_TICK_S * 1000);
  $('thinking-btn').addEventListener('click', () => {
    if (!state.session?.sendThinking()) {
      toast('Nobody else is in the room yet.');
      return;
    }
    toast('Sent. They know you are thinking of them.');
    $('thinking-btn').disabled = true;
    setTimeout(() => ($('thinking-btn').disabled = false), 3000);
  });
  $('mic-btn').addEventListener('click', onMicClick);
  $('share-btn').addEventListener('click', onShareClick);
  $('pause-btn').addEventListener('click', () => {
    const kind = state.askedPause ? 'ready' : 'pause';
    if (!state.session?.sendRequest(kind)) return;
    state.askedPause = !state.askedPause;
    updateDock();
    // One request every few seconds, so the button cannot be used to spam the room.
    $('pause-btn').disabled = true;
    setTimeout(() => ($('pause-btn').disabled = false), 3000);
  });
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
      if (state.session?.me.sharing) state.session.setProfile(state.picker.quality, state.picker.fps, $('lowdelay-toggle').checked);
    });
  }
  for (const btn of document.querySelectorAll('[data-fps]')) {
    btn.addEventListener('click', () => {
      setFps(Number(btn.dataset.fps));
      if (state.session?.me.sharing) state.session.setProfile(state.picker.quality, state.picker.fps, $('lowdelay-toggle').checked);
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('picker').hidden) closePicker();
    if (event.key === 'Escape' && !$('settings').hidden) closeSettings();
    if (event.key.toLowerCase() === 'm' && state.view === 'room' && !isTyping(event.target) && !event.metaKey && !event.ctrlKey) {
      onMicClick();
    }
  });

  $('update-chip').addEventListener('click', onUpdateChip);
  if (window.watchroom.isWeb) {
    setupInstallChip();
    $('copy-label').textContent = 'Copy link';
  }
  window.watchroom.pendingInvite().then(handleInvite);
  window.watchroom.onInvite(handleInvite);
  window.watchroom.appInfo().then((info) => {
    state.version = info.version;
    setTimeout(runUpdateCheck, 2000);
  });

  // Viewer player: controls appear on movement, volume and mute, full screen, pop-out.
  $('screen').volume = 0.8;
  $('volume').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    applyVolume();
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
  document.addEventListener('fullscreenchange', showPlayerControls);
  $('pip-btn').addEventListener('click', togglePopOut);
  $('fit-btn').addEventListener('click', () => {
    const whole = $('stage').classList.toggle('show-whole');
    $('fit-btn').setAttribute('aria-pressed', String(whole));
    $('fit-btn').setAttribute('aria-label', whole ? 'Fill the screen' : 'Show the whole picture');
  });
  $('sharp-toggle').addEventListener('change', () => {
    if (state.session?.me.sharing) {
      state.session.setProfile(state.picker.quality, state.picker.fps, $('lowdelay-toggle').checked, $('sharp-toggle').checked);
    }
  });
  $('lowdelay-toggle').addEventListener('change', () => {
    if (state.session?.me.sharing) {
      state.session.setProfile(state.picker.quality, state.picker.fps, $('lowdelay-toggle').checked);
    }
  });
  $('details-toggle').addEventListener('click', () => {
    const open = $('player-details').hidden;
    $('player-details').hidden = !open;
    $('details-toggle').setAttribute('aria-expanded', String(open));
    $('details-toggle').textContent = open ? 'Hide details' : 'Details';
  });
  $('stage').addEventListener('mousemove', showPlayerControls);
  // Touch screens have no hover: a tap on the picture brings the controls up.
  $('stage').addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') showPlayerControls();
  });
  // Phones only start sound after a tap. The first touch anywhere wakes up all room audio.
  const unlock = () => {
    state.session?.unlockAudio();
    const video = $('screen');
    if (video.srcObject && video.paused) video.play().catch(() => {});
  };
  for (const type of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(type, unlock, { capture: true });
  document.addEventListener('webkitfullscreenchange', showPlayerControls);
  $('stage').addEventListener('dblclick', toggleFullscreen);
  $('stage').addEventListener('mouseleave', () => $('stage').classList.remove('show-controls'));
  // Viewer shortcuts, usable in every state, including full screen when the bar is hidden.
  document.addEventListener('keydown', (event) => {
    if (state.view !== 'room' || !state.remote || isTyping(event.target) || event.metaKey || event.ctrlKey) return;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') setPseudoFullscreen(false);
    if (key === 'f') toggleFullscreen();
    else if (key === 'p') togglePopOut();
    else if (key === 'w') $('fit-btn').click();
    else return;
    showPlayerControls();
  });

  window.addEventListener('beforeunload', () => {
    if (state.session) state.session.leave().catch(() => {});
  });

  const saved = loadShareSettings();
  if (['720', '1080', '1440', '2160'].includes(saved.quality)) setQuality(saved.quality);
  if (saved.fps === 30 || saved.fps === 60) setFps(saved.fps);
  if (typeof saved.audio === 'boolean') $('audio-toggle').checked = saved.audio;
  if (typeof saved.lowDelay === 'boolean') $('lowdelay-toggle').checked = saved.lowDelay;
  if (typeof saved.sharp === 'boolean') $('sharp-toggle').checked = saved.sharp;

  setView('home');
  if ($('name').value) state.codeInputs[0].focus();
  else $('name').focus();
}

init();
