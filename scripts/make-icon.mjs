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

/** Coverage from a signed distance, with a one-pixel antialiased edge. */
const coverage = d => Math.min(1, Math.max(0, 0.5 - d));
const clamp = t => Math.min(1, Math.max(0, t));
const u = SIZE / 100;

// A glossy half-sun rising above a rounded horizon, with five separated rays
// following its upper arc. The exterior and the gaps between rays stay transparent.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const nx = (x + 0.5) / u - 50;
    const ny = (y + 0.5) / u - 63;
    let ray = 0;
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI * 5 / 6 + i * Math.PI / 6;
      const along = nx * Math.cos(angle) + ny * Math.sin(angle);
      const across = -nx * Math.sin(angle) + ny * Math.cos(angle);
      const distance = Math.hypot(along - Math.max(36, Math.min(43, along)), across) - 3.1;
      ray = Math.max(ray, coverage(distance * u));
    }
    if (ray > 0) setPixel(x, y, mix([255, 184, 23], [255, 108, 12], clamp((ny + 46) / 92)), ray);
    const radius = Math.hypot(nx, ny);
    const sun = coverage((radius - 28.5) * u) * coverage((ny - 1) * u);
    if (sun > 0) {
      let color = mix([255, 198, 24], [255, 91, 12], clamp((ny + 28.5) / 29.5));
      const reflection = Math.exp(-(((nx + 10) / 16) ** 2 + ((ny + 17) / 9) ** 2));
      color = mix(color, [255, 235, 120], reflection * 0.65);
      const rim = clamp((radius - 27.3) / 1.2) * clamp((-ny + 5) / 28);
      color = mix(color, [255, 230, 92], rim * 0.55);
      setPixel(x, y, color, sun);
    }
    // Capsule-shaped horizon, with a bright upper edge and warm lower bevel.
    const bar = coverage((Math.hypot(nx - Math.max(-40, Math.min(40, nx)), ny - 5) - 4) * u);
    if (bar > 0) {
      let color = mix([255, 193, 59], [232, 73, 19], clamp((ny - 1) / 8));
      color = mix(color, [255, 239, 159], Math.exp(-(((ny - 2) / 0.8) ** 2)) * 0.65);
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
