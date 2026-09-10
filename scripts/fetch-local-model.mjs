/**
 * Fetches the embedded inference engine and model into `vendor/`.
 *
 * These are not in git: together they are over a gigabyte, and a repository is
 * the wrong place for binary weights. The packaged installer picks `vendor/` up
 * through electron-builder's extraResources, so the shipped app needs no
 * download and no separate runtime — which is the whole point of embedding a
 * model rather than asking users to install Ollama.
 *
 *   node scripts/fetch-local-model.mjs [--force]
 *
 * Both artefacts are pinned by immutable revision *and* verified by digest,
 * before use and on every run — not only when freshly downloaded. An engine and
 * a model are exactly the things you do not want silently changing under a
 * release, and "the file is present" is not evidence that it is the right file,
 * complete, or the version this build was tested against.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendor = path.join(root, 'vendor');

/**
 * The CPU build, deliberately: the target machine is assumed to have no GPU,
 * and the CUDA builds are an order of magnitude larger for hardware most users
 * do not have. llama.cpp still uses AVX2 where present.
 */
const ENGINE = {
  version: 'b10867',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10867/llama-b10867-bin-win-cpu-x64.zip',
  sha256: 'ae11c93008fd76943ce190a3f852097220d1237c20564554eec9012493e224d0',
  bytes: 18426564,
  dir: path.join(vendor, 'llama'),
  marker: 'llama-server.exe',
};

/**
 * Qwen3 1.7B, 4-bit, from the llama.cpp org's own GGUF repository.
 *
 * Chosen for three reasons that all had to hold at once: Apache 2.0, so the
 * weights can be redistributed inside an installer; a published Q4_K_M quant at
 * ~1.1 GB, which leaves headroom inside a 2 GB budget; and a chat template with
 * real tool-call support, which is what the browser's tools actually need. See
 * ARCHITECTURE section 5.1 for why a GUI-grounding vision model was not the fit
 * here despite being the obvious-sounding choice.
 */
const MODEL = {
  repo: 'ggml-org/Qwen3-1.7B-GGUF',
  file: 'Qwen3-1.7B-Q4_K_M.gguf',
  license: 'apache-2.0',
  // A commit, not `main`. `resolve/main` is a moving target: the same command
  // would fetch different weights after any upstream push, with nothing to
  // notice it by.
  revision: 'daeb8e2d528a760970442092f6bf1e55c3b659eb',
  sha256: 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
  bytes: 1282439264,
  dir: path.join(vendor, 'models'),
};
MODEL.url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${MODEL.file}`;

const force = process.argv.includes('--force');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams to disk via curl.
 *
 * Node's own `fetch` piped through a web `TransformStream` stalls at zero bytes
 * on the CDN this model is served from — it works for the small engine archive
 * and then hangs on the gigabyte one. curl is present on Windows 10 1803+,
 * macOS and effectively every Linux, resumes a partial file, and retries a
 * dropped connection, all of which matter for a download this size.
 *
 * The file lands at `.partial` and is renamed only on success, so an interrupted
 * run cannot leave something that looks complete to the next one.
 */
async function download(url, dest, label, expect) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  console.log(`  ${label}`);
  execFileSync(
    'curl',
    [
      '--location',
      '--fail',
      // Resume where a previous attempt stopped. Safe only because the digest
      // is checked afterwards: a resumed file with a different tail fails there
      // rather than being trusted.
      '--continue-at', '-',
      '--retry', '5',
      '--retry-delay', '2',
      '--connect-timeout', '30',
      // Give up if it drops below 1 KB/s for 60s, rather than hanging forever.
      '--speed-limit', '1024',
      '--speed-time', '60',
      // A progress bar is useful at a terminal and ruinous in a log: curl
      // redraws it constantly, and on CI those thousands of lines pushed the
      // actual failure past the log size limit, leaving a run that could not be
      // diagnosed at all.
      ...(process.env.CI ? ['--no-progress-meter'] : ['--progress-bar']),
      '--output', partial,
      url,
    ],
    { stdio: 'inherit' },
  );
  await verify(partial, expect, label);
  await fs.rename(partial, dest);
}

/** SHA-256 of a file, streamed — these are too big to read into memory. */
async function digestOf(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * Refuses anything that is not byte-for-byte what this build was tested with.
 *
 * A partial file left by an interrupted resume, a mirror serving something
 * else, or an artefact from a different engine version all look like a present
 * file and none of them are the right one.
 */
async function verify(file, expect, label) {
  const { size } = await fs.stat(file);
  if (size !== expect.bytes) {
    await fs.rm(file, { force: true });
    throw new Error(`${label}: expected ${expect.bytes} bytes, got ${size}. Removed; run again.`);
  }
  const actual = await digestOf(file);
  if (actual !== expect.sha256) {
    await fs.rm(file, { force: true });
    throw new Error(
      `${label}: digest mismatch.\n  expected ${expect.sha256}\n  actual   ${actual}\nRemoved; run again.`,
    );
  }
}

async function fetchEngine() {
  const server = path.join(ENGINE.dir, ENGINE.marker);
  const manifestPath = path.join(ENGINE.dir, '.manifest.json');

  // Every extracted file is hashed, not just recorded as present.
  //
  // A stamp states a claimed version; it proves nothing about the files beside
  // it. With only a version check, a plain-text dummy named `llama-server.exe`
  // and no engine DLLs at all reported "verified" — and CI restores this
  // directory from a cache, so a corrupt or truncated extraction would be
  // carried into a release. The manifest is written after a verified archive is
  // extracted, and re-checked on every run.
  const manifest = await readJson(manifestPath);
  if (!force && manifest?.version === ENGINE.version) {
    const drift = await verifyManifest(ENGINE.dir, manifest);
    if (!drift.length) {
      console.log(`engine: verified ${Object.keys(manifest.files).length} files (${ENGINE.version})`);
      return;
    }
    console.log(`engine: cache rejected — ${drift.slice(0, 3).join('; ')}`);
    await fs.rm(ENGINE.dir, { recursive: true, force: true });
  } else if (manifest && manifest.version !== ENGINE.version) {
    console.log(`engine: replacing ${manifest.version} with ${ENGINE.version}`);
    await fs.rm(ENGINE.dir, { recursive: true, force: true });
  } else if (!force && (await exists(server))) {
    // An engine directory from before manifests existed.
    console.log('engine: no manifest, re-extracting to establish integrity');
    await fs.rm(ENGINE.dir, { recursive: true, force: true });
  }
  console.log(`engine: llama.cpp ${ENGINE.version}`);
  const zip = path.join(vendor, `llama-${ENGINE.version}.zip`);
  await download(ENGINE.url, zip, 'llama.cpp', ENGINE);

  await fs.mkdir(ENGINE.dir, { recursive: true });
  // bsdtar, shipped with Windows since 1803, addressed by full path.
  //
  // Two traps here. PowerShell's Expand-Archive fails on these archives with
  // "Central Directory corrupt" — the file is fine, the 5.1 archive module is
  // not — and reports that failure through a *zero* exit code. And bare `tar`
  // resolves to Git for Windows' GNU tar on many machines, which cannot read a
  // zip at all. Only the system bsdtar does the right thing.
  const bsdtar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  execFileSync(bsdtar, ['-xf', zip, '-C', ENGINE.dir], { stdio: 'inherit' });
  await fs.rm(zip, { force: true });

  // The archive nests its payload in a build directory on some releases.
  if (!(await exists(server))) {
    const nested = await findFile(ENGINE.dir, ENGINE.marker, 3);
    if (!nested) throw new Error(`${ENGINE.marker} not found in the archive`);
    const from = path.dirname(nested);
    for (const entry of await fs.readdir(from)) {
      await fs.rename(path.join(from, entry), path.join(ENGINE.dir, entry));
    }
  }
  await fs.writeFile(manifestPath, JSON.stringify(await buildManifest(ENGINE.dir), null, 2), 'utf8');
  console.log(`engine: ${server}`);
}

/** Hashes every extracted file, so the cache can be checked rather than trusted. */
async function buildManifest(dir) {
  const files = {};
  for (const rel of await listFiles(dir, dir)) {
    if (rel === '.manifest.json') continue;
    const full = path.join(dir, rel);
    files[rel] = { sha256: await digestOf(full), bytes: (await fs.stat(full)).size };
  }
  return { version: ENGINE.version, files };
}

/** Differences between a manifest and what is on disk. */
async function verifyManifest(dir, manifest) {
  const problems = [];
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const full = path.join(dir, rel);
    let size = -1;
    try {
      const stat = await fs.stat(full);
      size = stat.isFile() ? stat.size : -1;
    } catch {
      problems.push(`missing ${rel}`);
      continue;
    }
    if (size !== expected.bytes) {
      problems.push(`${rel} is ${size} bytes, expected ${expected.bytes}`);
      continue;
    }
    if ((await digestOf(full)) !== expected.sha256) problems.push(`${rel} digest mismatch`);
  }
  return problems;
}

async function listFiles(dir, root) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, root)));
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function findFile(dir, name, depth) {
  if (depth < 0) return null;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = await findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Writes the attribution notice that ships beside the weights.
 *
 * Redistributing weights carries the licence with them, so where they came
 * from is recorded next to the file rather than in a document someone has to
 * go and find.
 *
 * Written on every run, not only after a download. The notice names the
 * product, and the product has been renamed: a machine whose weights already
 * verify takes the early return in fetchModel, so a notice written under the
 * old name is never corrected - not on a developer's disk, and not in the CI
 * cache that feeds the installer. It is a few hundred bytes, and it is the one
 * file here whose contents can go stale without the digest checks noticing.
 */
async function writeModelNotice() {
  await fs.writeFile(
    path.join(MODEL.dir, 'MODEL-LICENSE.txt'),
    [
      `Model:      ${MODEL.repo}`,
      `File:       ${MODEL.file}`,
      `License:    ${MODEL.license} (Apache License 2.0)`,
      `Source:     https://huggingface.co/${MODEL.repo}`,
      `Base model: Qwen/Qwen3-1.7B — Copyright the Qwen team, Alibaba Cloud`,
      '',
      'Redistributed under the Apache License 2.0. The full licence text ships',
      'with the model repository above and must accompany any redistribution,',
      'along with this attribution notice.',
      '',
      'Nabsun bundles these weights unmodified as its default local model.',
    ].join('\n'),
    'utf8',
  );
}

async function fetchModel() {
  const dest = path.join(MODEL.dir, MODEL.file);
  if (!force && (await exists(dest))) {
    // Verified, not assumed. A truncated download from an interrupted run is
    // the common case, and it loads far enough to look plausible.
    let verified = false;
    try {
      await verify(dest, MODEL, MODEL.file);
      verified = true;
    } catch (err) {
      console.log(`model: ${err.message.split('\n')[0]}`);
    }
    // Outside the catch: only a failed *digest* may fall through to a
    // re-download. A notice that could not be written is a locked file, not
    // bad weights, and is not worth refetching 1.2 GB over.
    if (verified) {
      await writeModelNotice();
      console.log('model: verified');
      return;
    }
  }
  console.log(`model: ${MODEL.repo} @ ${MODEL.revision.slice(0, 8)} (${MODEL.license})`);
  await download(MODEL.url, dest, MODEL.file, MODEL);
  await writeModelNotice();
  console.log(`model: ${dest}`);
}

/**
 * Fetches the full licence texts and puts them beside what they cover.
 *
 * Apache-2.0 §4 requires *a copy of the licence* to accompany a redistribution.
 * A URL and a short attribution stub do not satisfy that, and the packaged app
 * shipped only those — so an installer built from this tree was not compliant
 * with the licence of the weights it contained.
 */
async function fetchLicenses() {
  const jobs = [
    {
      dest: path.join(ENGINE.dir, 'LICENSE-llama.cpp.txt'),
      urls: [`https://raw.githubusercontent.com/ggml-org/llama.cpp/${ENGINE.version}/LICENSE`],
      label: 'llama.cpp MIT licence',
    },
    {
      dest: path.join(MODEL.dir, 'LICENSE-Apache-2.0.txt'),
      urls: [
        `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/LICENSE`,
        'https://www.apache.org/licenses/LICENSE-2.0.txt',
      ],
      label: 'Apache 2.0 licence',
    },
  ];

  for (const job of jobs) {
    if (!force && (await exists(job.dest))) continue;
    let saved = false;
    for (const url of job.urls) {
      try {
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) continue;
        const text = await res.text();
        // A licence file is a few tens of KB of text; anything tiny is an error
        // page and must not be shipped as if it were the licence.
        if (text.length < 500) continue;
        await fs.mkdir(path.dirname(job.dest), { recursive: true });
        await fs.writeFile(job.dest, text, 'utf8');
        saved = true;
        break;
      } catch {
        // Try the next source.
      }
    }
    if (!saved) {
      throw new Error(
        `could not fetch the ${job.label}. It must ship with the build, so this is a failure, ` +
          'not a warning.',
      );
    }
    console.log(`licence: ${job.dest}`);
  }
}

async function main() {
  await fs.mkdir(vendor, { recursive: true });

  // The model is portable; the engine is not. Downloading a Windows build on
  // macOS or Linux and calling it "ready" would produce a browser that fails on
  // the first turn — the previous version printed a warning and then did
  // exactly that. Fetch the weights, and be explicit about the missing half.
  if (process.platform !== 'win32') {
    await fetchModel();
    await fetchLicenses();
    console.log(
      [
        '',
        `The pinned engine build (${ENGINE.version}) is Windows x64 only, so it was not`,
        'downloaded. The weights above work anywhere.',
        '',
        'Install llama.cpp for this platform and set "Engine path" in',
        'Settings → Models to its llama-server binary.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  await fetchEngine();
  await fetchModel();
  await fetchLicenses();
  console.log('\nReady. The local model is used by default; no network needed from here.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
