/**
 * Exercises the embedded model end to end: spawn llama.cpp, load the bundled
 * weights, and get a real tool call back through the provider.
 *
 * This is the check that would have caught "it builds, ships, and answers
 * nothing useful". A local model is only worth defaulting to if it can drive
 * the browser's tools, so that is what is asserted — not merely that a server
 * starts and returns prose.
 *
 * It runs a real inference on CPU, so it is slower than the rest of the suite
 * and is gated: it skips cleanly when the weights are absent, which is the
 * state of a fresh clone and of CI.
 *
 *   node dist/test/local-harness.js
 */
import path from 'node:path';
import { estimateTokens, fitToContext as fitForTest, shapeRequest } from '../main/ai/agent';
import { LocalProvider, bundledPaths } from '../main/ai/providers/local';
import { systemPrompt } from '../main/ai/prompt';
import { DEFAULT_SETTINGS } from '../main/store';
import { browserTools } from '../main/ai/tools/browser';
import type { Tool } from '../main/ai/tools/types';
import { tabTools, webTools } from '../main/ai/tools/workspace';
import type { StreamEvent } from '../main/ai/provider';
import type { ToolSpec } from '../shared/types';

/** A Tool is a ToolSpec plus its handler; the provider only needs the spec. */
const toSpec = (t: Tool): ToolSpec => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  risk: t.risk,
  source: t.source,
});

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}
function skip(name: string, why: string) {
  console.log(`SKIP  ${name}\n      ${why}`);
}

const TOOLS: ToolSpec[] = [
  {
    name: 'tab_open',
    description: 'Open a URL in a new browser tab.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to open' } },
      required: ['url'],
      additionalProperties: false,
    },
    risk: 'write',
    source: 'tabs',
  },
];

async function main() {
  const repoRoot = path.join(__dirname, '..', '..');
  const paths = bundledPaths(null, repoRoot);

  // The shipped default, not a smaller one convenient for a test: the point of
  // this harness is whether the configuration users actually get works.
  const provider = new LocalProvider(
    () => paths,
    () => ({ contextSize: DEFAULT_SETTINGS.localModel.contextSize, threads: DEFAULT_SETTINGS.localModel.threads }),
  );

  if (!provider.installed) {
    // A skip is right on a developer's machine and wrong in CI, where the
    // whole point is to exercise the shipped default. Setting this turns the
    // skip into a failure, so a run cannot go green having tested nothing.
    if (process.env.NABSUN_REQUIRE_LOCAL === '1') {
      check(
        'the embedded model is present (NABSUN_REQUIRE_LOCAL=1)',
        false,
        'weights absent; `npm run fetch:model` did not produce them',
      );
      process.exit(1);
    }
    skip('the embedded model answers', 'weights not present — run `npm run fetch:model`');
    return;
  }

  check('the bundled engine is found', provider.binaryPath !== null, String(provider.binaryPath));
  check('the bundled weights are found', provider.modelPath !== null, String(provider.modelPath));

  const models = await provider.listModels();
  check('the loaded model reports a name', models.length === 1, JSON.stringify(models));
  check(
    'vision is reported as unsupported, since this is a text model',
    provider.supportsVision() === false,
  );

  const started = Date.now();
  const events: StreamEvent[] = [];
  try {
    for await (const event of provider.stream({
      model: models[0] ?? '',
      system: 'You operate a web browser. Use the tools you are given.',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Open https://example.com in a new tab. Use the tool.' }],
        },
      ],
      tools: TOOLS,
      maxTokens: 256,
      thinking: false,
      signal: new AbortController().signal,
      conversationKey: 'local-check',
    })) {
      events.push(event);
    }
  } catch (err) {
    check('the local model produced a turn', false, err instanceof Error ? err.message : String(err));
    provider.stop();
    process.exit(1);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { delta: string }).delta)
    .join('');
  const calls = events.filter((e) => e.type === 'tool_use') as {
    name: string;
    input: Record<string, unknown>;
  }[];

  console.log(`      first turn took ${elapsed}s on CPU`);
  check('the local model produced a turn', events.length > 0);
  check(
    'and it called a browser tool rather than only talking about it',
    calls.some((c) => c.name === 'tab_open'),
    `text=${JSON.stringify(text.slice(0, 200))} calls=${JSON.stringify(calls)}`,
  );
  const opened = calls.find((c) => c.name === 'tab_open');
  check(
    'with the URL it was asked for',
    typeof opened?.input.url === 'string' && /example\.com/.test(String(opened.input.url)),
    JSON.stringify(opened?.input),
  );
  check('the turn ends with a stop event', events.at(-1)?.type === 'stop', JSON.stringify(events.at(-1)));

  // The server is reused across turns; a second call must not restart it.
  const second = Date.now();
  for await (const _e of provider.stream({
    model: models[0] ?? '',
    system: 'Answer in one word.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK.' }] }],
    tools: [],
    maxTokens: 16,
    thinking: false,
    signal: new AbortController().signal,
    conversationKey: 'local-check',
  })) {
    void _e;
  }
  const reuse = Date.now() - second;
  check(
    'a second turn reuses the loaded model instead of reloading it',
    reuse < Number(elapsed) * 1000 + 15_000,
    `${(reuse / 1000).toFixed(1)}s`,
  );

  // --- the default experience, not a one-tool smoke test --------------------
  // The full catalogue plus an ordinary page snapshot was rejected outright —
  // 8,920 tokens into an 8,192-token window — so the default backend failed on
  // the default action while a single-tool check passed. The agent now fits the
  // request to the window; this proves it against the real server.
  const bigPage = `Search results\n${'Result item with a reasonably long description line. '.repeat(240)}`;
  const everyTool: ToolSpec[] = [
    ...browserTools().map(toSpec),
    ...tabTools().map(toSpec),
    ...webTools().map(toSpec),
  ];
  // Shaped as the agent shapes it. Building the request by hand measured
  // something the app never sends — and on this backend the full catalogue plus
  // the long prompt genuinely does not fit, which is why the agent trims both.
  const shaped = shapeRequest({
    contextTokens: provider.contextTokens,
    tools: everyTool,
    vision: false,
  });
  console.log(
    `      catalogue: ${everyTool.length} tools -> ${shaped.tools.length} sent, page: ${bigPage.length} chars`,
  );

  const fitted = fitForTest(
    [
      { role: 'user', content: [{ type: 'text', text: 'What is on this page?' }] },
      { role: 'user', content: [{ type: 'text', text: bigPage }] },
    ],
    shaped.system,
    shaped.tools,
    provider.contextTokens,
  );

  let rejected: string | null = null;
  try {
    for await (const _e of provider.stream({
      model: models[0] ?? '',
      system: shaped.system,
      messages: fitted.messages,
      tools: shaped.tools,
      maxTokens: fitted.maxOutputTokens,
      thinking: false,
      signal: new AbortController().signal,
      conversationKey: 'local-context',
    })) {
      void _e;
    }
  } catch (err) {
    rejected = err instanceof Error ? err.message : String(err);
  }
  check(
    'a large page fits the local context window once shaped for it',
    rejected === null,
    String(rejected),
  );

  // A page far beyond the window: this one has to be cut down rather than
  // rejected, because the user asked about the page in front of them.
  const hugePage = 'Result row with a long description that keeps going. '.repeat(1200);
  const trimmedFit = fitForTest(
    [{ role: 'user', content: [{ type: 'text', text: hugePage }] }],
    shaped.system,
    shaped.tools,
    provider.contextTokens,
  );
  const serialised = JSON.stringify(trimmedFit.messages);
  check(
    'an observation past the window is trimmed rather than dropped or rejected',
    serialised.includes('trimmed to fit'),
    `${hugePage.length} chars in, ${serialised.length} out`,
  );
  check(
    'and the trimmed request is actually under the limit',
    estimateTokens(serialised) < provider.contextTokens,
    `~${estimateTokens(serialised)} tokens vs ${provider.contextTokens}`,
  );

  // The other half of fitting. Trimming can always shrink a page, so the case
  // that must be refused is the one no trimming can help: a window too small
  // for the tool schemas and system prompt themselves. It has to say so, rather
  // than sending a request for the server to reject.
  let refusal: string | null = null;
  try {
    fitForTest(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      systemPrompt(),
      everyTool,
      2048,
    );
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  }
  check(
    'a window too small for the tools themselves is refused, with a way out',
    refusal !== null && /Context size|larger model/i.test(refusal),
    String(refusal),
  );

  provider.stop();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

void main();
