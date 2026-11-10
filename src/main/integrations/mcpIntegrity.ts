import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { McpServerConfig } from '../../shared/types';
export function mcpEnvironment(explicit: Record<string, string> = {}) {
  const names =
    process.platform === 'win32'
      ? [
          'APPDATA',
          'HOMEDRIVE',
          'HOMEPATH',
          'LOCALAPPDATA',
          'PATH',
          'PROCESSOR_ARCHITECTURE',
          'SYSTEMDRIVE',
          'SYSTEMROOT',
          'TEMP',
          'TMP',
          'USERNAME',
          'USERPROFILE',
          'PROGRAMFILES',
          'COMSPEC',
          'PATHEXT',
          'LOGONSERVER',
          'USERDOMAIN',
          'WINDIR',
        ]
      : [
          'HOME',
          'LOGNAME',
          'PATH',
          'SHELL',
          'TERM',
          'USER',
          'LANG',
          'LC_ALL',
          'LC_CTYPE',
          'TMPDIR',
          '__CF_USER_TEXT_ENCODING',
        ];
  const inherited: Record<string, string> = {};
  for (const key of names) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) inherited[key] = value;
  }
  const values = { ...inherited, ...explicit },
    env: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || key.includes('\0') || value.includes('\0'))
      throw Error('Invalid MCP environment.');
    env[process.platform === 'win32' ? key.toUpperCase() : key] = value;
  }
  return env;
}
function executable(command: string, env: Record<string, string>) {
  if (typeof command !== 'string' || !command || command.length > 2000)
    throw Error('Choose an MCP executable.');
  const candidates = path.isAbsolute(command)
    ? [command]
    : command.includes('/') || command.includes('\\')
      ? []
      : (env.PATH ?? '').split(path.delimiter).flatMap((folder) => {
          const base = path.join(folder.replace(/^"|"$/g, ''), command);
          return process.platform === 'win32' && !path.extname(command)
            ? ['.exe', '.com', '.cmd', '.bat'].map(
                (extension) => base + extension,
              )
            : [base];
        });
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      /* Try the next explicit PATH entry. */
    }
  }
  throw Error(
    'MCP executable not found. Choose an absolute installed executable path.',
  );
}
async function fileDigest(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > 300 * 1024 * 1024)
    throw Error('MCP executable or script exceeds 300 MB.');
  const hash = createHash('sha256'),
    stream = fs.createReadStream(file, { highWaterMark: 65536 });
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      bytes += (chunk as Buffer).length;
      if (bytes > stat.size) throw Error('MCP source changed during review.');
      hash.update(chunk);
    }
    if (bytes !== stat.size) throw Error('MCP source changed during review.');
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}
export async function inspectMcp(
  config: McpServerConfig,
  signal?: AbortSignal,
) {
  if (
    !config ||
    !Array.isArray(config.args) ||
    config.args.length > 100 ||
    config.args.some(
      (value) => typeof value !== 'string' || value.length > 16000,
    ) ||
    Object.keys(config.env ?? {}).length > 100
  )
    throw Error('Invalid MCP configuration.');
  const env = mcpEnvironment(config.env),
    command = executable(config.command, env);
  if (
    /^(?:npx|npm|pnpm|yarn|bunx)(?:\.(?:cmd|exe|bat))?$/i.test(
      path.basename(command),
    )
  )
    throw Error(
      'Install this MCP server locally and choose its executable or entry script. Dynamic package runners cannot be pinned safely.',
    );
  const files = new Map<string, string>();
  files.set(command, await fileDigest(command, signal));
  for (const [index, arg] of config.args.entries()) {
    if (
      [
        '-e',
        '--eval',
        '-p',
        '--print',
        '-c',
        '--command',
        '-encodedcommand',
      ].includes(config.args[index - 1]?.toLowerCase())
    )
      continue;
    const value =
      arg.startsWith('-') && arg.includes('=')
        ? arg.slice(arg.indexOf('=') + 1)
        : arg;
    if (value.length > 2000) continue;
    const candidate = path.resolve(value);
    try {
      if ((await fs.promises.stat(candidate)).isFile()) {
        const real = await fs.promises.realpath(candidate);
        if (!files.has(real)) files.set(real, await fileDigest(real, signal));
      }
    } catch (error) {
      if (
        !['ENOENT', 'ENOTDIR', 'EINVAL'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  }
  const source = {
    command,
    args: config.args,
    environment: Object.entries(config.env ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    files: [...files].sort(([a], [b]) => a.localeCompare(b)),
  };
  return {
    command,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(source))
      .digest('hex'),
    env,
  };
}
