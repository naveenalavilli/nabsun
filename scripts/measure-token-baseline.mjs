// Offline diagnostic: uses production shaping/pruning, never calls a model or tool.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(path.join(tmpdir(), 'nabsun-token-baseline-'));
try {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const entry = path.join(temporary, 'measure.cjs');
  await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `
      import { estimateTokens, shapeRequest, pruneHistory } from './src/main/ai/agent';
      import { browserTools } from './src/main/ai/tools/browser';
      import { tabTools, webTools, memoryTools } from './src/main/ai/tools/workspace';
      const tools = [...browserTools(), ...tabTools(), ...webTools(), ...memoryTools()]
        .map(({handler, ...spec}) => spec);
      const catalogue = (contextTokens, vision) => {
        const shaped = shapeRequest({ tools, contextTokens, vision });
        return { tools: shaped.tools.length, systemEstimate: estimateTokens(shaped.system),
          toolSpecEstimate: estimateTokens(JSON.stringify(shaped.tools)) };
      };
      const observation = 'Synthetic page observation. '.repeat(300).slice(0, 8000);
      const fixture = name => [
        {role:'user', content:[{type:'text', text:'Complete the requested task.'}]},
        {role:'assistant', content:[{type:'tool_use', id:'one', name, input:{}}]},
        {role:'user', content:[{type:'tool_result',toolUseId:'one',content:observation}]},
        {role:'assistant', content:[{type:'text',text:'Continue.'}]},
        {role:'user', content:[{type:'text',text:'Check the result.'}]},
      ];
      const results = ['browser_snapshot', 'browser_click', 'browser_type'].map(tool => {
        const messages = fixture(tool);
        const before = messages[2].content[0].content;
        const after = pruneHistory(messages)[2].content[0].content;
        return {tool, beforeChars:before.length, afterChars:after.length,
          beforeEstimate:estimateTokens(before), afterEstimate:estimateTokens(after)};
      });
      console.log(JSON.stringify({ schemaVersion:1, revision:${JSON.stringify(revision)},
        method:'Production character heuristic; synthetic fixtures, not provider billing or model accuracy.',
        scope:'Core browser/tab/web/memory catalogue; excludes files, datasets, plugins and MCP.',
        catalogue:{hostedText:catalogue(undefined,false), hostedVision:catalogue(undefined,true),
          local8k:catalogue(8192,false)}, oldToolResultPruning:results },null,2));
      process.exit(0);
    ` },
    outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent',
  });
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/electron-run.mjs'), entry], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr || `Diagnostic exited ${run.status}`);
  // Electron may emit blank lines; write only the parsed report to stdout.
  console.log(JSON.stringify(JSON.parse(run.stdout.trim()), null, 2));
} finally {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(temporary));
  if (relative.startsWith('..') || path.isAbsolute(relative) ||
      !relative.startsWith('nabsun-token-baseline-')) throw new Error('Unexpected temporary directory');
  await rm(temporary, { recursive: true, force: true });
}
