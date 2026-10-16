// Draws build/icon.png: a split-flap tile in steel and soft black with one amber lamp.
// Run with: node build/make-icon.js
// No dependencies. Shapes are drawn with signed distance fields for clean edges.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const N = 1024;

const hexToRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Signed distance to a rounded rectangle centred at (cx, cy).
function roundRectDistance(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

function circleDistance(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r;
}

const shapes = [
  // Background: rounded square, full bleed.
  { color: '0b0c0d', d: (x, y) => roundRectDistance(x, y, 512, 512, 512, 512, 230) },
  // Tile.
  { color: '1f2327', d: (x, y) => roundRectDistance(x, y, 512, 512, 362, 362, 96) },
  // Top flap, lit a little more.
  { color: '2a2f34', d: (x, y) => roundRectDistance(x, y, 512, 338, 322, 168, 40) },
  // Bottom flap, in shadow.
  { color: '16191c', d: (x, y) => roundRectDistance(x, y, 512, 686, 322, 168, 40) },
  // Seam between the flaps.
  { color: '000000', d: (x, y) => roundRectDistance(x, y, 512, 512, 322, 7, 3) },
  // The one lamp.
  { color: 'ffb020', d: (x, y) => circleDistance(x, y, 760, 290, 44) },
];

const pixels = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y += 1) {
  for (let x = 0; x < N; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (const shape of shapes) {
      const coverage = Math.min(Math.max(0.5 - shape.d(x + 0.5, y + 0.5), 0), 1);
      if (coverage <= 0) continue;
      const [sr, sg, sb] = hexToRgb(shape.color);
      const outA = coverage + a * (1 - coverage);
      r = (sr * coverage + r * a * (1 - coverage)) / outA;
      g = (sg * coverage + g * a * (1 - coverage)) / outA;
      b = (sb * coverage + b * a * (1 - coverage)) / outA;
      a = outA;
    }
    const i = (y * N + x) * 4;
    pixels[i] = Math.round(r);
    pixels[i + 1] = Math.round(g);
    pixels[i + 2] = Math.round(b);
    pixels[i + 3] = Math.round(a * 255);
  }
}

// PNG encoding: 8-bit RGBA, filter type 0 on every scanline.
const rows = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y += 1) {
  rows[y * (N * 4 + 1)] = 0;
  pixels.copy(rows, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(N, 0);
header.writeUInt32BE(N, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
