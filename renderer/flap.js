// Split-flap display lines. Every character is a two-half flap. When a cell
// changes it turns over the way a departure board does: the top flap falls,
// the bottom flap rises, and it passes through the characters in between.

const CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.-/';
const MAX_STEPS = 8;
const HALF_MS = 46;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function leaf(part, ch) {
  const el = document.createElement('div');
  el.className = `leaf leaf-${part}`;
  el.innerHTML = `<span>${ch}</span>`;
  return el;
}

function pathTo(from, to) {
  const n = CHARSET.length;
  const a = Math.max(0, CHARSET.indexOf(from));
  const b = Math.max(0, CHARSET.indexOf(to));
  const steps = (b - a + n) % n;
  if (steps === 0) return [];
  const first = Math.max(1, steps - MAX_STEPS + 1);
  const path = [];
  for (let k = first; k <= steps; k += 1) path.push(CHARSET[(a + k) % n]);
  return path;
}

function flipOnce(cell, ch) {
  const from = cell.dataset.ch || ' ';
  const top = cell.querySelector('.top > span');
  const bottom = cell.querySelector('.bottom > span');
  top.textContent = ch;

  if (reduceMotion.matches) {
    bottom.textContent = ch;
    cell.dataset.ch = ch;
    return Promise.resolve();
  }

  const fall = leaf('top', from);
  cell.append(fall);
  return fall
    .animate(
      [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(90deg)' }],
      { duration: HALF_MS, easing: 'cubic-bezier(.5,0,1,.6)', fill: 'forwards' },
    )
    .finished.then(() => {
      fall.remove();
      bottom.textContent = ch;
      cell.dataset.ch = ch;
      const rise = leaf('bottom', ch);
      cell.append(rise);
      return rise
        .animate(
          [{ transform: 'rotateX(-90deg)' }, { transform: 'rotateX(0deg)' }],
          { duration: HALF_MS, easing: 'cubic-bezier(0,.6,.4,1)', fill: 'forwards' },
        )
        .finished.then(() => rise.remove());
    });
}

async function runFlip(cell, target, token) {
  const path = pathTo(cell.dataset.ch || ' ', target);
  for (const ch of path) {
    if (cell._token !== token) return;
    await flipOnce(cell, ch);
  }
  if (cell._token === token) cell.dataset.ch = target;
}

// Turns a container into a flap line of `length` cells.
// Sizes come from data-ch (cell height in px) and data-cw (cell width in px).
export function mountFlapLine(el, length) {
  const ch = Number(el.dataset.ch || 40);
  const cw = Number(el.dataset.cw || Math.round(ch * 0.62));
  el.classList.add('flapline');
  el.style.setProperty('--ch', `${ch}px`);
  el.style.setProperty('--cw', `${cw}px`);
  el.style.setProperty('--fs', `${Math.round(ch * 0.84)}px`);
  el.innerHTML = '';
  el._length = length;
  for (let i = 0; i < length; i += 1) {
    const cell = document.createElement('span');
    cell.className = 'cell';
    cell.setAttribute('aria-hidden', 'true');
    cell.dataset.ch = ' ';
    cell.innerHTML =
      '<span class="half top"><span>&nbsp;</span></span><span class="half bottom"><span>&nbsp;</span></span>';
    el.append(cell);
  }
}

// Sets the text. Only cells whose character changes move. Each one cascades in from the left.
export function setFlap(el, text, { stagger = 38, instant = false } = {}) {
  if (!el || !el._length) return;
  const value = String(text ?? '')
    .toUpperCase()
    .slice(0, el._length)
    .padEnd(el._length, ' ');
  el.setAttribute('aria-label', value.trim() || ' ');

  const cells = el.querySelectorAll('.cell');
  cells.forEach((cell, i) => {
    const target = value[i];
    if (!instant && cell.dataset.ch === target) return;
    cell._token = (cell._token || 0) + 1;
    const token = cell._token;
    if (instant || reduceMotion.matches) {
      cell.dataset.ch = target;
      cell.querySelector('.top > span').textContent = target;
      cell.querySelector('.bottom > span').textContent = target;
      return;
    }
    setTimeout(() => runFlip(cell, target, token), i * stagger);
  });
}
