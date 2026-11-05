const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const MAX_PEERS = 8;

// Bitrates are per viewer. The total sender upload remains capped at 25 Mbps.
export const PRESETS = {
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

export const UPLOAD_BUDGET_BPS = 25e6;

// Speaking detection. A quiet voice after noise suppression sits near 0.01, so the old 0.025 missed it.
// Two thresholds stop the flag flickering, and a short hold keeps the movie quiet between words.
export const SPEAK_ON_LEVEL = 0.01;
export const SPEAK_OFF_LEVEL = 0.006;
export const SPEAK_HOLD_MS = 600;

// The threshold slider runs 0 to 100. It is squared so the quiet end, where most voices live, has fine steps.
const SLIDER_TOP_LEVEL = 0.12;
export const levelFromSlider = (value) => Math.max(0.003, SLIDER_TOP_LEVEL * (Math.min(100, Math.max(0, Number(value) || 0)) / 100) ** 2);
export const sliderFromLevel = (level) => Math.round(100 * Math.sqrt(Math.min(SLIDER_TOP_LEVEL, Math.max(0, level)) / SLIDER_TOP_LEVEL));

// Returns the next state. `loudAt` is the time the voice was last above the on-level.
export function nextSpeaking({ level, speaking, loudAt, now, on = SPEAK_ON_LEVEL }) {
  const off = on * (SPEAK_OFF_LEVEL / SPEAK_ON_LEVEL);
  if (level >= on || (speaking && level >= off)) return { speaking: true, loudAt: now };
  if (speaking && now - loudAt < SPEAK_HOLD_MS) return { speaking: true, loudAt };
  return { speaking: false, loudAt };
}

export function normalizeProfile(quality, fps) {
  const normalizedQuality = PRESETS[quality] ? quality : '720';
  const normalizedFps = Number(fps) === 60 ? 60 : 30;
  return { quality: normalizedQuality, fps: normalizedFps, ...PRESETS[normalizedQuality] };
}

export function bitrateFor(quality, fps, viewers) {
  const profile = normalizeProfile(quality, fps);
  const wanted = BITRATE_BPS[`${profile.quality}-${profile.fps}`];
  return Math.min(wanted, UPLOAD_BUDGET_BPS / Math.max(1, viewers));
}

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function cleanCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

// Hands out numbered attempts. Only the latest attempt may finish; older ones stop after any await.
export function createAttemptGate() {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (attempt) => attempt === current,
    cancel: () => {
      current += 1;
    },
  };
}

// Only GIPHY's own media links are shown, so a peer cannot make everyone load an image from any server.
const GIF_URL = /^https:\/\/media\d?\.giphy\.com\/media\/[\w./-]+\.(gif|webp)$/;
export const cleanGifUrl = (url) => (typeof url === 'string' && url.length <= 300 && GIF_URL.test(url) && !url.includes('..') ? url : '');
