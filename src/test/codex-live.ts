/**
 * Opt-in live check of the Codex backend, end to end through the real provider.
 *
 * This is the path that produced "spawn EINVAL": resolve the launcher, spawn
 * the CLI, send the prompt on stdin, parse its JSONL, and surface whatever it
 * reports. It runs the real CLI, so it is gated behind an env flag and is not
 * part of `npm run verify`.
 *
 *   set NABSUN_TEST_LIVE_CLI=1
 *   node dist/test/codex-live.js
 */
import { CodexProvider } from '../main/ai/providers/cli';
import type { StreamEvent } from '../main/ai/provider';

/**
 * The second turn can only answer this if the first turn reached the model, so
 * a plain "reply with X" would pass even with the history dropped entirely.
 */
const SECRET = 'GRAPEFRUIT';
const FIRST_TURN = `Remember the word ${SECRET}. Reply with exactly: OK`;
const SECOND_TURN = 'What word did I ask you to remember? Reply with only that word.';

async function main() {
  if (process.env.NABSUN_TEST_LIVE_CLI !== '1') {
    console.log('SKIP  live Codex check (set NABSUN_TEST_LIVE_CLI=1 to run it)');
    return;
  }

  const provider = new CodexProvider(
    // A stand-in bridge: this check is about launching and parsing, not tools.
    () => ({ url: 'http://127.0.0.1:1', token: 'test', serverScript: 'noop.js' }),
    () => '',
  );

  if (!provider.binaryPath) {
    console.log('SKIP  codex is not installed');
    return;
  }
  console.log(`codex at: ${provider.binaryPath}`);
  console.log(`launcher: ${JSON.stringify(provider.launcher)}`);

  const events: StreamEvent[] = [];
  const controller = new AbortController();
  let thrown: string | null = null;

  try {
    for await (const event of provider.stream({
      model: '',
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: FIRST_TURN }] }],
      tools: [],
      maxTokens: 1000,
      thinking: false,
      signal: controller.signal,
      conversationKey: 'live-check',
    })) {
      events.push(event);
    }
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }

  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { delta: string }).delta)
    .join('');

  // The second turn is the one that used to fail. It no longer resumes the
  // CLI's thread — `codex exec resume` cannot approve tool calls — so the
  // transcript is replayed in the prompt, and this is what proves it arrives.
  let secondText = '';
  let secondThrown: string | null = null;
  if (!thrown) {
    try {
      for await (const event of provider.stream({
        model: '',
        system: '',
        messages: [
          { role: 'user', content: [{ type: 'text', text: FIRST_TURN }] },
          { role: 'assistant', content: [{ type: 'text', text: text || 'OK' }] },
          { role: 'user', content: [{ type: 'text', text: SECOND_TURN }] },
        ],
        tools: [],
        maxTokens: 1000,
        thinking: false,
        signal: controller.signal,
        conversationKey: 'live-check',
      })) {
        if (event.type === 'text') secondText += event.delta;
      }
    } catch (err) {
      secondThrown = err instanceof Error ? err.message : String(err);
    }
  }

  console.log('\n--- events -------------------------------------------------');
  for (const e of events) console.log(JSON.stringify(e).slice(0, 200));
  console.log('\n--- assistant text ----------------------------------------');
  console.log(text || '(none)');
  console.log('\n--- thrown ------------------------------------------------');
  console.log(thrown ?? '(none)');

  // The point of the exercise: EINVAL must be gone, and whatever the CLI says
  // must reach the user rather than being swallowed.
  const einval = /EINVAL/i.test(thrown ?? '');
  console.log(`\n${einval ? 'FAIL' : 'PASS'}  the CLI launches without EINVAL`);
  const silent = !text && !thrown;
  console.log(`${silent ? 'FAIL' : 'PASS'}  the turn produced either output or a reported error`);

  console.log('\n--- second turn (history replayed) ------------------------');
  console.log(`text:   ${secondText || '(none)'}`);
  console.log(`thrown: ${secondThrown ?? '(none)'}`);
  console.log(
    `${secondThrown ? 'FAIL' : 'PASS'}  a follow-up message runs without erroring`,
  );
  const remembered = secondText.toUpperCase().includes(SECRET);
  console.log(
    `${remembered ? 'PASS' : 'FAIL'}  the earlier turn reached the model (it recalled ${SECRET})`,
  );
}

void main();
