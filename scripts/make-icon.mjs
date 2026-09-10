/**
 * Generates build/icon.png — a 512x512 app icon.
 *
 * Written by hand rather than pulled from a design tool so the repo has no
 * binary asset to keep in sync and no image dependency. electron-builder
 * derives the .ico (Windows) and .icns (macOS) from this single PNG.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------ primitives -- */

const canvas = new Uint8Array(SIZE * SIZE * 4);

function setPixel(x, y, [r, g, b], alpha = 1) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return;
  const i = (y * SIZE + x) * 4;
  const a = Math.min(1, alpha);
  // Source-over onto whatever is already there.
  const dstA = canvas[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA === 0) return;
  canvas[i] = (r * a + canvas[i] * dstA * (1 - a)) / outA;
  canvas[i + 1] = (g * a + canvas[i + 1] * dstA * (1 - a)) / outA;
  canvas[i + 2] = (b * a + canvas[i + 2] * dstA * (1 - a)) / outA;
  canvas[i + 3] = outA * 255;
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/** Signed distance to a rounded rectangle, for cheap anti-aliasing. */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Coverage from a signed distance: 1 inside, 0 outside, smooth across the edge. */
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d));

/* ----------------------------------------------------------------- shape -- */

const VIOLET = [124, 92, 255];
const DEEP = [74, 47, 208];
const INK = [18, 18, 26];
const WHITE = [246, 245, 255];

const c = SIZE / 2;

// Rounded-square body with a diagonal gradient.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = roundedRectSdf(x + 0.5, y + 0.5, c, c, 232, 232, 108);
    const cov = coverage(d);
    if (cov <= 0) continue;
    const t = (x / SIZE) * 0.5 + (y / SIZE) * 0.5;
    setPixel(x, y, mix(VIOLET, DEEP, t), cov);
  }
}

// A browser window: title bar with three dots, over a darker content area.
const winHalfW = 150;
const winHalfH = 116;
const winTop = c - winHalfH;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = roundedRectSdf(x + 0.5, y + 0.5, c, c, winHalfW, winHalfH, 26);
    const cov = coverage(d);
    if (cov <= 0) continue;
    // Top 56px is the chrome; the rest is the page.
    const inChrome = y < winTop + 56;
    setPixel(x, y, inChrome ? [38, 38, 52] : INK, cov);
  }
}

for (let i = 0; i < 3; i++) {
  const dotX = c - winHalfW + 34 + i * 30;
  const dotY = winTop + 28;
  for (let y = dotY - 10; y <= dotY + 10; y++) {
    for (let x = dotX - 10; x <= dotX + 10; x++) {
      const cov = coverage(Math.hypot(x + 0.5 - dotX, y + 0.5 - dotY) - 7);
      if (cov > 0) setPixel(x, y, [90, 90, 118], cov);
    }
  }
}

/**
 * A cursor/spark mark in the page area — the "agent acting on the page" idea,
 * drawn as a four-point star so it reads at 16px as well as 512px.
 */
const sparkX = c;
const sparkY = winTop + 150;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = (x + 0.5 - sparkX) / 74;
    const dy = (y + 0.5 - sparkY) / 74;
    const r = Math.hypot(dx, dy);
    if (r > 1.2) continue;
    // Astroid: |x|^(2/3) + |y|^(2/3) = 1 gives concave star arms.
    const star = Math.pow(Math.abs(dx), 2 / 3) + Math.pow(Math.abs(dy), 2 / 3);
    const cov = coverage((star - 1) * 34);
    if (cov > 0) setPixel(x, y, WHITE, cov);
  }
}

/* ------------------------------------------------------------ PNG output -- */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c2 = n;
      for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1;
      table[n] = c2;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Each scanline is prefixed with a filter byte; 0 means "no filter".
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  Buffer.from(canvas.buffer, y * SIZE * 4, SIZE * 4).copy(raw, rowStart + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, png);
console.log(`[icon] wrote ${outFile} (${SIZE}x${SIZE}, ${png.length} bytes)`);
