/** Writes a 16x16 PNG for the test extension, so its manifest icon resolves. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 16;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pixels = Buffer.alloc(SIZE * (SIZE * 4 + 1));

for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  pixels[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = row + 1 + x * 4;
    // A filled violet square with a lighter diagonal, so it is recognisable.
    const diagonal = Math.abs(x - y) < 2;
    pixels[i] = diagonal ? 0xd6 : 0x7c;
    pixels[i + 1] = diagonal ? 0xcc : 0x5c;
    pixels[i + 2] = 0xff;
    pixels[i + 3] = 0xff;
  }
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(root, 'scripts', 'fixtures', 'test-extension', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out}`);
