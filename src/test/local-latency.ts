/**
 * Measures what the bundled model actually costs on a *realistic* request.
 *
 * The other local check proves correctness — the engine runs, the tool is
 * called, the context fits. It says nothing about whether a person waiting in
 * front of the sidebar gets an answer, and that turned out to be the thing that
 * matters: a real sign-in page with the full tool catalogue attached left the
 * assistant blank while the engine spent minutes on prompt processing.
 *
 * Reports time-to-first-token and total, because they are different problems:
 * slow generation still shows progress, slow prompt processing shows nothing.
 *
 *   node dist/test/local-latency.js [pageChars]
 */
import path from 'node:path';
import { fitToContext, shapeRequest } from '../main/ai/agent';
import { LocalProvider, bundledPaths } from '../main/ai/providers/local';
import { browserTools } from '../main/ai/tools/browser';
import type { Tool } from '../main/ai/tools/types';
import { tabTools, webTools } from '../main/ai/tools/workspace';
import { DEFAULT_SETTINGS } from '../main/store';
import type { ToolSpec } from '../shared/types';

const toSpec = (t: Tool): ToolSpec => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  risk: t.risk,
  source: t.source,
});

/** Roughly the shape of a real sign-in page's accessibility outline. */
function syntheticPage(chars: number): string {
  const lines: string[] = ['# IAMOnline - Sign In', ''];
  let i = 0;
  while (lines.join('\n').length < chars) {
    lines.push(`- link "Option number ${i} for the account holder" href=/path/${i} [ref=doc-${i}]`);
    lines.push(`  Supporting description text for option ${i}, of the sort a real page carries.`);
    i++;
  }
  return lines.join('\n');
}

async function main() {
  const pageChars = Number(process.argv[2] ?? 6000);
  const paths = bundledPaths(null, path.join(__dirname, '..', '..'));
  const provider = new LocalProvider(
    () => paths,
    () => ({
      contextSize: DEFAULT_SETTINGS.localModel.contextSize,
      // The shipped default (0 = llama.cpp decides). Passing a hand-picked
      // thread count here measured a configuration the app never uses.
      threads: DEFAULT_SETTINGS.localModel.threads,
    }),
  );

  if (!provider.installed) {
    console.log('SKIP  weights not present — run `npm run fetch:model`');
    return;
  }

  // Shaped exactly as the agent shapes it, so this measures the real request.
  const { system, tools, lean } = shapeRequest({
    contextTokens: provider.contextTokens,
    tools: [...browserTools().map(toSpec), ...tabTools().map(toSpec), ...webTools().map(toSpec)],
    vision: false,
  });
  const page = syntheticPage(pageChars);

  const fitted = fitToContext(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'lets create a new account as a citizen' },
          { type: 'text', text: `<attached_page>\n${page}\n</attached_page>` },
        ],
      },
    ],
    system,
    tools,
    provider.contextTokens,
  );

  const promptChars =
    system.length + JSON.stringify(tools).length + JSON.stringify(fitted.messages).length;
  console.log(`context window : ${provider.contextTokens} tokens`);
  console.log(`tools          : ${tools.length}${lean ? ' (lean set)' : ' (full set)'}`);
  console.log(`prompt         : ~${promptChars} chars (~${Math.ceil(promptChars / 3.4)} tokens)`);
  console.log(`threads        : ${DEFAULT_SETTINGS.localModel.threads || 'llama.cpp default'}`);
  console.log('');

  const started = Date.now();
  let firstToken = 0;
  let text = '';
  const calls: string[] = [];

  for await (const event of provider.stream({
    model: 'bundled',
    system,
    messages: fitted.messages,
    tools,
    maxTokens: fitted.maxOutputTokens,
    thinking: false,
    signal: AbortSignal.timeout(600_000),
    conversationKey: 'latency',
  })) {
    if (!firstToken && (event.type === 'text' || event.type === 'tool_use')) {
      firstToken = Date.now() - started;
    }
    if (event.type === 'text') text += event.delta;
    if (event.type === 'tool_use') calls.push(event.name);
  }

  const total = Date.now() - started;
  console.log(`time to first output : ${(firstToken / 1000).toFixed(1)}s`);
  console.log(`total turn           : ${(total / 1000).toFixed(1)}s`);
  console.log(`tool calls           : ${JSON.stringify(calls)}`);
  console.log(`text                 : ${JSON.stringify(text.slice(0, 200))}`);
  provider.stop();
}

void main();
