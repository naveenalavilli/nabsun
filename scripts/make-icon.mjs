/**
 * Generates build/icon.png — a 1024x1024 app icon.
 *
 * Written by hand rather than pulled from a design tool so the repo has no
 * binary asset to keep in sync and no image dependency. electron-builder
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

/*
 * A gradient tile carrying a sparkle.
 *
 * The previous mark drew a browser window - a title bar, three dots and a
 * cursor - which is a lot of incident for something that spends most of its
 * life 16px wide in a taskbar. At that size the dots merge into a smear and
 * the window outline reads as a plain rectangle, so the icon said "some app"
 * rather than naming itself.
 *
 * This keeps one shape big enough to survive the downscale. The sparkle is
 * doing double duty: it is the common visual shorthand for a model acting on
 * your behalf, and the product is called Nabsun, so a small sun is the mark
 * the name already implies.
 */

// The site's palette: warm paper, one flat orange. No second hue, because the
// brand does not have one - nabsun.web.app uses no gradient anywhere.
const PAPER = [244, 242, 235];  // --bg in the light theme
const ORANGE = [255, 91, 44];   // --accent
const DEEP = [217, 65, 15];     // --accent-dim, for the faintest depth

const c = SIZE / 2;
const unit = SIZE / 1024; // every measurement below is quoted at 1024

/** Flat paper. The brand's tile has no ramp in it. */
function tileColour() {
  return PAPER;
}

// The tile. A generous corner radius reads as a modern app icon and survives
// the mask macOS and Windows apply anyway.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = roundedRectSdf(x + 0.5, y + 0.5, c, c, 464 * unit, 464 * unit, 224 * unit);
    const cov = coverage(d);
    if (cov <= 0) continue;
    setPixel(x, y, tileColour(), cov);
  }
}

/**
 * A four-point sparkle.
 *
 * The astroid |x|^(2/3) + |y|^(2/3) = 1 gives concave arms, which stay
 * recognisable as a star when the whole glyph is a dozen pixels across - a
 * convex diamond at that size just looks like a blob. `soft` widens the
 * anti-aliased edge for the glow that sits under the main one.
 */
function sparkle(cx, cy, radius, alpha = 1, soft = 34, colour = ORANGE) {
  const reach = radius * 1.25;
  for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++) {
    for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
      const dx = (x + 0.5 - cx) / radius;
      const dy = (y + 0.5 - cy) / radius;
      if (Math.hypot(dx, dy) > 1.3) continue;
      const star = Math.pow(Math.abs(dx), 2 / 3) + Math.pow(Math.abs(dy), 2 / 3);
      const cov = coverage((star - 1) * soft);
      if (cov > 0) setPixel(x, y, colour, cov * alpha);
    }
  }
}

const mainX = c - 46 * unit;
const mainY = c + 30 * unit;

sparkle(mainX, mainY, 246 * unit, 1);
// A second, smaller sparkle. One star is a bullet; two read as motion, and it
// fills the corner the main glyph leaves empty.
sparkle(c + 210 * unit, c - 226 * unit, 104 * unit, 1, 34, DEEP);

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
