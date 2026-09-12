/**
 * Refuses to package a release that is missing what it claims to ship.
 *
 * The README says the browser works out of the box with no account and no
 * network. That is only true if the engine, the weights, and their licences are
 * actually in the payload — and nothing enforced it: `npm run dist` would
 * happily build an installer whose advertised default backend was absent, and
 * CI would publish it, because the local harness *skips* when weights are
 * missing rather than failing.
 *
 * A skip is not a pass. This turns the claim into a build gate.
 *
 *   node scripts/check-release-payload.mjs
 *   node scripts/check-release-payload.mjs --allow-missing-model   (dev builds)
 *   node scripts/check-release-payload.mjs --resources release/win-unpacked/resources
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const allowMissing = process.argv.includes('--allow-missing-model');
const resourcesArg = process.argv.indexOf('--resources');
if (resourcesArg !== -1 && (!process.argv[resourcesArg + 1] || process.argv[resourcesArg + 1].startsWith('--'))) {
  console.error('--resources requires the packaged resources directory');
  process.exit(1);
}
const resources = resourcesArg === -1 ? null : path.resolve(process.argv[resourcesArg + 1]);
// Application notices live inside app.asar; engine and model files are unpacked.
const asar = resources ? await import('@electron/asar') : null;

/** Things whose absence changes what the product is, not merely how it looks. */
const REQUIRED = [
  {
    // A ~9 KB launcher: this build splits the server into a stub plus a DLL,
    // so a size threshold here would only encode a wrong assumption. The
    // implementation below is the part with real weight to it.
    file: 'vendor/llama/llama-server.exe',
    why: 'the inference engine entry point for the default backend',
    minBytes: 1_000,
  },
  {
    file: 'vendor/llama/llama-server-impl.dll',
    why: 'the engine implementation — the .exe is only a launcher without it',
    minBytes: 1_000_000,
  },
  {
    file: 'vendor/llama/ggml-base.dll',
    why: 'the ggml runtime the engine loads',
    minBytes: 100_000,
  },
  {
    file: 'vendor/models/Qwen3-1.7B-Q4_K_M.gguf',
    why: 'the default model weights',
    minBytes: 1_000_000_000,
  },
  {
    file: 'vendor/models/LICENSE-Apache-2.0.txt',
    why: 'the licence the weights are redistributed under (Apache-2.0 §4 requires the text)',
    minBytes: 5_000,
  },
  {
    file: 'vendor/llama/LICENSE-llama.cpp.txt',
    why: "the engine's MIT licence text",
    minBytes: 500,
  },
  {
    // Apache-2.0 wants the attribution to travel with the redistribution, not
    // only the licence text. This names the model, its revision and its source,
    // and it is generated beside the weights by `npm run fetch:model`.
    file: 'vendor/models/MODEL-LICENSE.txt',
    why: 'the attribution notice that must accompany the redistributed weights',
    minBytes: 200,
  },
  { file: 'THIRD-PARTY-NOTICES.md', why: 'the attribution notice for both', minBytes: 500 },
  { file: 'LICENSE', why: "Nabsun's own licence", minBytes: 500 },
];

const problems = [];
for (const item of REQUIRED) {
  const full = path.join(resources ?? root, item.file);
  let size = -1;
  try {
    if (resources && !item.file.startsWith('vendor/')) {
      size = asar.extractFile(path.join(resources, 'app.asar'), item.file).length;
    } else {
      const stat = fs.statSync(full);
      size = stat.isFile() ? stat.size : -1;
    }
  } catch {
    // Reported below.
  }
  if (size < 0) problems.push(`missing  ${item.file}  — ${item.why}`);
  else if (size < item.minBytes) {
    problems.push(`too small ${item.file}  (${size} bytes) — ${item.why}`);
  }
}

if (!problems.length) {
  console.log(`${resources ? 'packaged' : 'release'} payload: engine, weights and licences all present`);
  process.exit(0);
}

console.error('\nRelease payload incomplete:\n');
for (const p of problems) console.error(`  ${p}`);
console.error(resources ? '\nRebuild after checking the source payload and packaging configuration.' : '\nRun `npm run fetch:model` first.');

if (allowMissing) {
  console.error('\n--allow-missing-model given: continuing with a DEVELOPMENT build.');
  console.error('Do not publish this artifact as a release.\n');
  process.exit(0);
}
process.exit(1);
