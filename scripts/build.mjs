/**
 * Build pipeline.
 *
 * Four bundles with genuinely different constraints:
 *  - main + preload: CommonJS for Node/Electron, `electron` left external
 *  - renderers: ESM for the browser, no Node builtins
 *  - page bridge: an IIFE, injected as a source string into an isolated world
 *
 * Run with --watch to rebuild on change, and --run to launch Electron after the
 * first successful build.
 */
import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const runApp = process.argv.includes('--run');
const dev = watch || process.argv.includes('--dev');

const shared = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

/** Electron and Node builtins are provided by the runtime, never bundled. */
const nodeBundle = (entry, outfile) => ({
  ...shared,
  entryPoints: [entry],
  outfile,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});

const webBundle = (entry, outfile) => ({
  ...shared,
  entryPoints: [entry],
  outfile,
  platform: 'browser',
  format: 'esm',
  target: 'chrome130',
});

const configs = [
  nodeBundle('src/test/office-harness.ts', `${out}/test/office-harness.js`),
  nodeBundle('src/main/officeWorker.ts', `${out}/main/office-worker.js`),
  nodeBundle('src/main/fileParser.ts', `${out}/main/file-parser.js`),
  nodeBundle('src/main/integrations/pluginWorker.ts', `${out}/main/plugin-worker.js`),
  nodeBundle('src/main/index.ts', `${out}/main/index.js`),
  nodeBundle('src/preload/shell.ts', `${out}/preload/shell.js`),
  nodeBundle('src/preload/overlay.ts', `${out}/preload/overlay.js`),
  nodeBundle('src/preload/page.ts', `${out}/preload/page.js`),
  nodeBundle('src/test/bench/runner.ts', `${out}/test/bench-runner.js`),
  webBundle('scripts/fixtures/bench/react-entry.js', `${out}/test/bench/react-fixture.js`),
  nodeBundle('src/test/frame-harness.ts', `${out}/test/frame-harness.js`),
  nodeBundle('src/test/local-files-agent-harness.ts', `${out}/test/local-files-agent-harness.js`),
  nodeBundle('src/test/local-files-harness.ts', `${out}/test/local-files-harness.js`),
  nodeBundle('src/test/file-harness.ts', `${out}/test/file-harness.js`),
  nodeBundle('src/test/voice-harness.ts', `${out}/test/voice-harness.js`),
  nodeBundle('src/test/delegation-harness.ts', `${out}/test/delegation-harness.js`),
  nodeBundle('src/test/workflow-harness.ts', `${out}/test/workflow-harness.js`),
  nodeBundle('src/test/batch-crash-worker.ts', `${out}/test/batch-crash-worker.js`),
  nodeBundle('src/test/approval-harness.ts', `${out}/test/approval-harness.js`),
  nodeBundle('src/test/audit-harness.ts', `${out}/test/audit-harness.js`),
  nodeBundle('src/test/site-permission-harness.ts', `${out}/test/site-permission-harness.js`),
  nodeBundle('src/test/network-auth-harness.ts', `${out}/test/network-auth-harness.js`),
  nodeBundle('src/test/network-config-harness.ts', `${out}/test/network-config-harness.js`),
  nodeBundle('src/test/plugin-isolation-harness.ts', `${out}/test/plugin-isolation-harness.js`),
  nodeBundle('src/test/integration-trust-harness.ts', `${out}/test/integration-trust-harness.js`),
  nodeBundle('src/test/input-harness.ts', `${out}/test/input-harness.js`),
  nodeBundle('src/test/agent-harness.ts', `${out}/test/agent-harness.js`),
  nodeBundle('src/test/bridge-harness.ts', `${out}/test/bridge-harness.js`),
  nodeBundle('src/test/cli-harness.ts', `${out}/test/cli-harness.js`),
  nodeBundle('src/test/connection-harness.ts', `${out}/test/connection-harness.js`),
  nodeBundle('src/test/native-install-harness.ts', `${out}/test/native-install-harness.js`),
  nodeBundle('src/test/local-harness.ts', `${out}/test/local-harness.js`),
  nodeBundle('src/test/local-latency.ts', `${out}/test/local-latency.js`),
  nodeBundle('src/test/codex-tools-live.ts', `${out}/test/codex-tools-live.js`),
  nodeBundle('src/test/codex-live.ts', `${out}/test/codex-live.js`),
  nodeBundle('src/test/browsing-harness.ts', `${out}/test/browsing-harness.js`),
  nodeBundle('src/test/review-harness.ts', `${out}/test/review-harness.js`),
  nodeBundle('src/test/assistant-harness.ts', `${out}/test/assistant-harness.js`),
  // Self-contained so a packaged app can spawn it without node_modules.
  nodeBundle('src/mcp-server/main.ts', `${out}/bin/nabsun-mcp.js`),
  webBundle('src/renderer/shell/main.ts', `${out}/renderer/shell/main.js`),
  webBundle('src/renderer/overlay/overlay.ts', `${out}/renderer/overlay/overlay.js`),
  {
    ...shared,
    entryPoints: ['src/page/agent-bridge.ts'],
    outfile: `${out}/page/agent-bridge.js`,
    platform: 'browser',
    // An IIFE, because this is injected as a source string rather than loaded
    // as a module: an ESM bundle would fail with "Cannot use import statement".
    format: 'iife',
    target: 'chrome130',
  },
];

/** Static assets are copied rather than bundled. */
function copyStatic() {
  // PDF parsing is confined to a bounded worker. Keep its ESM worker and
  // resources local so no CDN or dynamic code download is used.
  const pdfOut=path.join(out,'pdf');fs.mkdirSync(pdfOut,{recursive:true});
  for(const file of ['pdf.mjs','pdf.worker.mjs'])fs.copyFileSync(path.join(root,'node_modules/pdfjs-dist/legacy/build',file),path.join(pdfOut,file));
  for(const directory of ['standard_fonts','cmaps'])fs.cpSync(path.join(root,'node_modules/pdfjs-dist',directory),path.join(pdfOut,directory),{recursive:true});
  fs.copyFileSync(path.join(root,'node_modules/pdfjs-dist/LICENSE'),path.join(pdfOut,'LICENSE'));
  const jobs = [
    ['src/renderer/shell/index.html', 'renderer/shell/index.html'],
    ['src/renderer/shell/styles.css', 'renderer/shell/styles.css'],
    ['src/pages/themes.css', 'renderer/shell/themes.css'],
    ['src/pages/themes.css', 'renderer/overlay/themes.css'],
    ['src/renderer/overlay/index.html', 'renderer/overlay/index.html'],
  ];
  for (const [from, to] of jobs) {
    const dest = path.join(out, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, from), dest);
  }

  const pagesSrc = path.join(root, 'src', 'pages');
  const pagesOut = path.join(out, 'pages');
  fs.mkdirSync(pagesOut, { recursive: true });
  for (const file of fs.readdirSync(pagesSrc)) {
    fs.copyFileSync(path.join(pagesSrc, file), path.join(pagesOut, file));
  }
}

async function main() {
  fs.mkdirSync(out, { recursive: true });

  if (watch) {
    const contexts = await Promise.all(configs.map((c) => context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    copyStatic();

    // esbuild does not watch non-imported assets, so poll the static tree.
    fs.watch(path.join(root, 'src'), { recursive: true }, (_e, file) => {
      if (file && /\.(html|css)$/.test(file)) {
        try {
          copyStatic();
          console.log(`[build] copied ${file}`);
        } catch (err) {
          console.error('[build] copy failed:', err);
        }
      }
    });

    console.log('[build] watching...');
    if (runApp) launchElectron();
  } else {
    await Promise.all(configs.map((c) => build(c)));
    copyStatic();
    console.log('[build] done');
  }
}

function launchElectron() {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'electron-run.mjs')], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



