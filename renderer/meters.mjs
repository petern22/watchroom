// Plain-language meters for the player and the sharer's panel.
// Pure functions only: they turn raw WebRTC numbers into the words people see.
// Levels run 1 (poor) to 4 (excellent). Each meter fills that many segments.

export const LEVEL_WORDS = { 4: 'Excellent', 3: 'Good', 2: 'Fair', 1: 'Poor' };

// Megabits per second from two byte counters taken `seconds` apart.
export function megabitsPerSecond(bytesNow, bytesBefore, seconds) {
  if (!seconds || seconds <= 0 || bytesBefore == null) return 0;
  return ((bytesNow - bytesBefore) * 8) / seconds / 1e6;
}

// Packet loss in percent over one sampling interval.
export function lossPercent(receivedNow, lostNow, receivedBefore, lostBefore) {
  const received = receivedNow - receivedBefore;
  const lost = lostNow - lostBefore;
  if (received + lost <= 0) return 0;
  return Math.max(0, (lost / (received + lost)) * 100);
}

// Friendly picture name from the height in pixels.
export function pictureName(height) {
  if (!height) return 'Waiting';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return 'Full HD';
  if (height >= 720) return 'HD';
  return `${height}p`;
}

// Smoothness: packet loss plus whether the frame rate holds up.
export function smoothnessLevel(loss, fps, targetFps) {
  if (fps > 0 && targetFps > 0 && fps < targetFps * 0.5) return 1;
  if (loss < 0.5 && (!targetFps || fps >= targetFps * 0.9)) return 4;
  if (loss < 1.5) return 3;
  if (loss < 4) return 2;
  return 1;
}

// Speed: how much spare room the connection has above what the picture needs.
// `availableMbps` comes from the browser's own estimate; 0 means unknown.
export function speedLevel(usedMbps, availableMbps) {
  if (!availableMbps || availableMbps <= 0) return usedMbps > 0 ? 3 : 2;
  const headroom = availableMbps / Math.max(usedMbps, 0.1);
  if (headroom >= 2) return 4;
  if (headroom >= 1.3) return 3;
  if (headroom >= 1) return 2;
  return 1;
}

// Delay: network round trip (half) plus the browser's own buffer.
export function delayLevel(delayMs) {
  if (delayMs < 150) return 4;
  if (delayMs < 300) return 3;
  if (delayMs < 600) return 2;
  return 1;
}

// The whole connection is only as good as its weakest meter.
export function overallLevel(...levels) {
  return Math.min(...levels);
}

// Turns the browser's limitation reason into words the sharer understands.
export function limitWords(reason) {
  if (reason === 'bandwidth') return 'Upload speed';
  if (reason === 'cpu') return 'This computer';
  return 'Nothing, full quality';
}
