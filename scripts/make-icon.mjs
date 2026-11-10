/**
 * Generates build/icon.png — a 1024x1024 app icon.
 *
 * Written by hand rather than pulled from a design tool so the repo has no
 * external design-tool dependency. electron-builder
 * derives the .ico (Windows) and .icns (macOS) from this single PNG.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
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

// A freestanding rising sun: no tile or opaque backdrop. Keep generous optical
// margins while making the mark large enough for taskbar and Dock sizes.
const u = SIZE / 100;
const clamp = (t) => Math.min(1, Math.max(0, t));
function rrect(px, py, cx, cy, halfW, halfH, r) {
  return coverage(roundedRectSdf(px, py, cx, cy, halfW, halfH, r));
}
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const nx = px / u;
    const ny = py / u;
    const sun = coverage(Math.hypot(px - 50 * u, py - 55 * u) - 37 * u)
      * coverage(py - 67 * u);
    if (sun > 0) {
      // Warm gold at the crown, vivid orange at the horizon. A broad soft
      // reflection and a fine rim give depth without muddying the silhouette.
      const height = clamp((ny - 18) / 49);
      let color = mix([255, 220, 67], [255, 91, 20], height);
      const light = Math.exp(-(((nx - 37) / 22) ** 2 + ((ny - 29) / 15) ** 2));
      color = mix(color, [255, 249, 196], light * 0.72);
      const gloss = clamp((43 - ny + 0.12 * (nx - 50)) / 3);
      color = mix(color, [255, 249, 221], gloss * 0.15);
      const radius = Math.hypot(nx - 50, ny - 55);
      const rim = clamp((radius - 35.9) / 1.1) * clamp((53 - ny) / 20);
      color = mix(color, [255, 244, 161], rim * 0.7);
      setPixel(x, y, color, sun);
    }
    // A warm rounded horizon remains visible against both light and dark
    // surfaces, unlike the old paper-white bar. The top edge catches light.
    const bar = rrect(px, py, 50 * u, 71 * u, 44 * u, 4 * u, 4 * u);
    if (bar > 0) {
      const vertical = clamp((ny - 67) / 8);
      let color = mix([255, 193, 59], [232, 73, 19], vertical);
      color = mix(color, [255, 239, 159], Math.exp(-(((ny - 68) / 0.8) ** 2)) * 0.65);
      setPixel(x, y, color, bar);
    }
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
