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
