// Settings, emoji, hearts and alerts. The pure parts have no DOM, so they are unit tested.

const KEY = 'watchroom.settings';

export const DEFAULT_SETTINGS = {
  micMode: 'always',
  threshold: 25,
  micDevice: '',
  duck: 25,
  notify: true,
  hearts: true,
  preview: true,
  sounds: true,
  nuki: false,
};

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    micMode: r.micMode === 'voice' ? 'voice' : 'always',
    threshold: clampInt(r.threshold, 1, 100, d.threshold),
    micDevice: typeof r.micDevice === 'string' ? r.micDevice.slice(0, 300) : '',
    duck: clampInt(r.duck, 0, 100, d.duck),
    notify: r.notify === undefined ? d.notify : Boolean(r.notify),
    hearts: r.hearts === undefined ? d.hearts : Boolean(r.hearts),
    preview: r.preview === undefined ? d.preview : Boolean(r.preview),
    nuki: Boolean(r.nuki),
    sounds: r.sounds === undefined ? d.sounds : Boolean(r.sounds),
  };
}

export function loadSettings() {
  try {
    return cleanSettings(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return cleanSettings(null);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private window: settings last for this session only */
  }
}

// Heart emojis that start the full-screen animation.
const HEARTS = /[❤♥💕💖💗💓💞💘💝💟🩷🧡💛💚💙💜🤍🖤🤎😍🥰😘]/u;
export const isHeart = (text) => HEARTS.test(String(text ?? ''));

const GIF_API = 'https://watchroom-gifs.peterndrio.workers.dev';

export async function searchGifs(query) {
  const res = await fetch(`${GIF_API}/?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error('gif search failed');
  return (await res.json()).gifs || [];
}

let lastBurst = 0;

// A heart drawn around the origin, about 2 units wide. Vector, so it stays sharp at any size.
function heartPath(g, size) {
  const s = size / 2;
  g.beginPath();
  g.moveTo(0, 0.95 * s);
  g.bezierCurveTo(-0.35 * s, 0.62 * s, -1.05 * s, 0.2 * s, -1.05 * s, -0.32 * s);
  g.bezierCurveTo(-1.05 * s, -0.78 * s, -0.68 * s, -0.98 * s, -0.42 * s, -0.98 * s);
  g.bezierCurveTo(-0.2 * s, -0.98 * s, -0.06 * s, -0.84 * s, 0, -0.64 * s);
  g.bezierCurveTo(0.06 * s, -0.84 * s, 0.2 * s, -0.98 * s, 0.42 * s, -0.98 * s);
  g.bezierCurveTo(0.68 * s, -0.98 * s, 1.05 * s, -0.78 * s, 1.05 * s, -0.32 * s);
  g.bezierCurveTo(1.05 * s, 0.2 * s, 0.35 * s, 0.62 * s, 0, 0.95 * s);
  g.closePath();
}

// The size of the big heart over time: it springs in, beats twice like a real heart, then swells away.
export function heartScale(t) {
  if (t < 0.45) {
    const p = t / 0.45;
    return 1 - Math.exp(-5 * p) * Math.cos(9 * p);
  }
  const beat = (at) => 0.16 * Math.exp(-(((t - at) / 0.09) ** 2));
  return 1 + beat(0.75) + beat(1.05) + beat(1.75) + beat(2.05) + Math.max(0, t - 2.5) * 0.9;
}

const LIFE = 3.4;
const BEATS = [0.75, 1.05, 1.75, 2.05];

// A big glowing heart that beats and throws out shockwaves and sparks, on top of everything, video included.
// In full screen it goes inside the full-screen element, or it would be hidden.
export function heartBurst() {
  const started = Date.now();
  if (started - lastBurst < 3500) return;
  lastBurst = started;

  const canvas = document.createElement('canvas');
  canvas.className = 'hearts';
  canvas.setAttribute('aria-hidden', 'true');
  (document.fullscreenElement || document.body).append(canvas);
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = (canvas.width = Math.round(innerWidth * dpr)) / dpr;
  const H = (canvas.height = Math.round(innerHeight * dpr)) / dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const cx = W / 2;
  const cy = H / 2;
  const big = Math.min(W, H) * 0.62;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const colors = ['#ff2d6f', '#ff5c8a', '#ff8f6b', '#ffb020', '#ffd1dc'];
  const sparks = [];
  const rings = [];
  let nextBeat = 0;
  let last = 0;

  const burst = (count) => {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = (0.35 + Math.random() * 0.9) * Math.max(W, H) * 0.55;
      sparks.push({
        x: cx + Math.cos(a) * big * 0.2,
        y: cy + Math.sin(a) * big * 0.2,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        size: 8 + Math.random() * Math.min(W, H) * 0.05,
        spin: (Math.random() - 0.5) * 5,
        turn: Math.random() * 6,
        life: 1.1 + Math.random() * 1.1,
        age: 0,
        color: colors[i % colors.length],
      });
    }
  };

  const frame = () => {
    const t = (Date.now() - started) / 1000;
    if (t >= LIFE || !canvas.isConnected) {
      canvas.remove();
      return;
    }
    const dt = Math.min(0.05, t - last);
    last = t;
    g.clearRect(0, 0, W, H);
    const fade = Math.min(1, t / 0.2) * Math.min(1, (LIFE - t) / 0.8);

    // A warm wash, so the heart reads over a bright movie as well as a dark one.
    const wash = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
    wash.addColorStop(0, `rgba(255, 45, 111, ${0.42 * fade})`);
    wash.addColorStop(1, 'rgba(60, 0, 25, 0)');
    g.fillStyle = wash;
    g.fillRect(0, 0, W, H);

    if (!reduced && nextBeat < BEATS.length && t >= BEATS[nextBeat]) {
      nextBeat += 1;
      rings.push({ at: t });
      burst(nextBeat % 2 ? 46 : 28);
    }

    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const ring of rings) {
      const p = (t - ring.at) / 1.1;
      if (p > 1) continue;
      g.save();
      g.translate(cx, cy);
      heartPath(g, big * (1 + p * 1.5));
      g.lineWidth = 10 * (1 - p) + 1;
      g.strokeStyle = `rgba(255, 120, 160, ${0.75 * (1 - p)})`;
      g.stroke();
      g.restore();
    }
    for (const s of sparks) {
      s.age += dt;
      if (s.age > s.life) continue;
      s.vx *= 0.975;
      s.vy = s.vy * 0.975 + 240 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.turn += s.spin * dt;
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.turn);
      g.globalAlpha = Math.min(1, (1 - s.age / s.life) * 1.6);
      heartPath(g, s.size);
      g.fillStyle = s.color;
      g.fill();
      g.restore();
    }
    g.restore();

    g.save();
    g.translate(cx, cy);
    const scale = reduced ? 1 : heartScale(t);
    g.scale(scale, scale);
    g.globalAlpha = fade;
    g.shadowColor = '#ff2d6f';
    g.shadowBlur = big * 0.22;
    const fill = g.createLinearGradient(0, -big / 2, 0, big / 2);
    fill.addColorStop(0, '#ff7aa2');
    fill.addColorStop(0.5, '#ff2d6f');
    fill.addColorStop(1, '#b3093f');
    heartPath(g, big);
    g.fillStyle = fill;
    g.fill();
    g.shadowBlur = 0;
    // A soft highlight on the left lobe gives it depth.
    const shine = g.createRadialGradient(-big * 0.24, -big * 0.26, 0, -big * 0.24, -big * 0.26, big * 0.3);
    shine.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = shine;
    g.fill();
    g.restore();

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// A system notification, only when Watchroom is not the window in front.
// Phones refuse `new Notification`, so an installed app or browser tab goes through its service worker.
export async function systemNotify(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus() && !document.hidden) return;
  const options = { body, tag: 'watchroom', renotify: true, icon: 'icons/icon-192.png' };
  try {
    const worker = await navigator.serviceWorker?.getRegistration();
    if (worker) {
      await worker.showNotification(title, options);
      return;
    }
    const n = new Notification(title, { body, tag: 'watchroom' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* blocked by the system; the message is still in the chat */
  }
}

// A card on top of the picture. Full screen shows nothing else, so this is how you see chat there.
export function stageAlert(list, title, text) {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = title;
  li.append(b, document.createTextNode(text));
  list.append(li);
  while (list.childElementCount > 3) list.firstElementChild.remove();
  setTimeout(() => li.remove(), 6000);
}

let chimeContext = null;
let lastChime = 0;

// A soft two-note chime, made in code so there are no sound files: rising for a join, falling for a leave.
export function playChime(kind) {
  const now = Date.now();
  if (now - lastChime < 400) return; // several people arriving at once make one chime
  lastChime = now;
  try {
    chimeContext ||= new AudioContext();
    if (chimeContext.state !== 'running') chimeContext.resume().catch(() => {});
    const notes = kind === 'join' ? [587, 880] : [659, 440];
    notes.forEach((freq, i) => {
      const at = chimeContext.currentTime + i * 0.13;
      const osc = chimeContext.createOscillator();
      const gain = chimeContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(chimeContext.destination);
      osc.start(at);
      osc.stop(at + 0.36);
    });
  } catch {
    /* no audio available; the chat line still says who came and went */
  }
}

// "Thinking of you": a slow rose glow breathing around the edge of the screen. It leaves the movie visible.
export function glowPulse() {
  const glow = document.createElement('div');
  glow.setAttribute('aria-hidden', 'true');
  glow.style.cssText =
    'position:fixed;inset:0;z-index:300;pointer-events:none;opacity:0;box-shadow:inset 0 0 14vmin 4vmin rgba(255,70,130,.85)';
  (document.fullscreenElement || document.body).append(glow);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const frames = reduced ? [0, 1, 1, 0] : [0, 1, 0.35, 1, 0];
  glow.animate(frames.map((opacity) => ({ opacity })), { duration: 3400, easing: 'ease-in-out' }).finished.finally(() => glow.remove());
}

const TOGETHER_KEY = 'watchroom.together';

export function loadTogether() {
  try {
    return Math.max(0, Number(localStorage.getItem(TOGETHER_KEY)) || 0);
  } catch {
    return 0;
  }
}

export function saveTogether(seconds) {
  try {
    localStorage.setItem(TOGETHER_KEY, String(seconds));
  } catch {
    /* private window: the counter lasts for this session only */
  }
}

export function formatTogether(seconds) {
  const hours = Math.floor(seconds / 360) / 10;
  if (hours < 0.1) return 'Your first hour together has started';
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} together`;
}
