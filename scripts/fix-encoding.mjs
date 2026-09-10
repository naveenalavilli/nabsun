/**
 * Repairs mojibake and BOMs left by Windows PowerShell's
 * `Set-Content -Encoding utf8`, which reads a file as CP1252, re-encodes it as
 * UTF-8, and prepends a byte-order mark.
 *
 * The corruption is derived rather than hardcoded: for each character we care
 * about, its UTF-8 bytes decoded as CP1252 *are* the mangled form. An earlier
 * version listed the mangled sequences literally, which meant running this
 * script over itself rewrote its own table into no-ops. Deriving them keeps the
 * file pure ASCII, so that cannot happen — and it is refused on itself anyway.
 *
 *   node scripts/fix-encoding.mjs <file...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(here));

/** CP1252 overrides in 0x80-0x9F, where it differs from Latin-1. */
const CP1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

/** What `char` looks like after the round-trip that corrupted it. */
function mangle(char) {
  return [...Buffer.from(char, 'utf8')]
    .map((byte) => String.fromCodePoint(CP1252[byte] ?? byte))
    .join('');
}

// Characters this project actually uses in source and docs.
const CHARS = [
  '•', // bullet
  '\u{1F512}', '\u{1F507}', '\u{1F50A}', '\u{1F9E9}', '\u{1F5D1}',
  '⚠', // warning
  '★', '☆', // stars
  '✕', '⟳', // close, reload
  '—', '–', // em/en dash
  '…', // ellipsis
  '→', // right arrow
  '⚙', // gear
  '−', // minus
  '·', // middle dot
  '⬳', // download arrow
  '◨', // sidebar glyph
  '‘', '’', '“', '”', // quotes
];

// Longest first, so a multi-byte sequence is not partially consumed.
const FIXES = CHARS.map((char) => [mangle(char), char]).sort(
  (a, b) => b[0].length - a[0].length,
);

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/fix-encoding.mjs <file...>');
  process.exit(1);
}

let totalChanged = 0;
for (const rel of files) {
  const file = path.resolve(root, rel);

  // Never rewrite this script: its own table would be the target.
  if (path.resolve(file) === path.resolve(here)) continue;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    console.error(`skip (unreadable): ${rel}`);
    continue;
  }

  let changed = 0;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    changed += 1;
  }
  for (const [bad, good] of FIXES) {
    const parts = text.split(bad);
    if (parts.length > 1) {
      changed += parts.length - 1;
      text = parts.join(good);
    }
  }

  if (changed) {
    fs.writeFileSync(file, text, 'utf8');
    console.log(`fixed ${changed} in ${path.relative(root, file)}`);
    totalChanged += changed;
  }
}

console.log(totalChanged ? `\nrepaired ${totalChanged} total` : 'nothing to fix');
