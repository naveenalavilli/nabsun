/**
 * Spawns Electron with a clean environment.
 *
 * VS Code, Cursor and other Electron hosts export ELECTRON_RUN_AS_NODE=1 to
 * their child processes. Inherited by electron.exe it starts as plain Node, so
 * require('electron') returns the npm shim's path string instead of the API and
 * the app dies on its first API call. Every entry point goes through here.
 *
 *   node scripts/electron-run.mjs [entry]   (defaults to the app itself)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = process.argv[2] ?? root;

const local = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
if (!fs.existsSync(local)) {
  console.error(
    'Electron binary is missing. Run:  node node_modules/electron/install.js',
  );
  process.exit(1);
}

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(local, [entry, ...process.argv.slice(3)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
