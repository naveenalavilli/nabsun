import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  VoiceManager,
  WindowsVoiceBackend,
  type VoiceBackend,
} from '../main/voice';
import type { VoiceEvent } from '../shared/voice';

async function main() {
  let callback:
      | ((event: Pick<VoiceEvent, 'type' | 'text'>) => void)
      | undefined,
    starts = 0,
    stops = 0;
  const backend: VoiceBackend = {
    availability: async () => ({
      available: true,
      languages: [
        { code: 'en-US', name: 'English' },
        { code: 'te-IN', name: 'Telugu' },
      ],
      help: 'Local fixture',
    }),
    listen: (_language, emit) => {
      starts++;
      callback = emit;
      return () => {
        stops++;
      };
    },
  };
  const voice = new VoiceManager(backend),
    events: VoiceEvent[] = [];
  const id = randomUUID();
  let allow!: (value: boolean) => void;
  const pending = voice.start(
    1,
    'chat-a',
    id,
    'te-IN',
    (event) => events.push(event),
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 0, 'microphone does not start before explicit consent');
  await assert.rejects(
    voice.start(
      2,
      'chat-b',
      randomUUID(),
      'en-US',
      () => {},
      async () => true,
    ),
    /already/,
  );
  voice.stop(2, id);
  assert.equal(events.length, 0, 'another UI cannot stop the owner');
  voice.stop(1, id);
  allow(true);
  await pending;
  assert.equal(starts, 0, 'late consent cannot revive a stopped request');
  console.log(
    'PASS microphone ownership, single lease, explicit consent, and Stop while permission is pending',
  );
  const nextId = randomUUID();
  await voice.start(
    1,
    'chat-a',
    nextId,
    'te-IN',
    (event) => events.push(event),
    async () => true,
  );
  callback!({ type: 'listening' });
  callback!({ type: 'text', text: 'నమస్కారం, ప్రపంచం!' });
  assert.equal(events.at(-1)?.text, 'నమస్కారం, ప్రపంచం!');
  assert.equal(events.at(-1)?.sessionId, 'chat-a');
  const before = events.length;
  voice.stopSession('chat-a');
  assert.equal(stops, 1);
  callback!({ type: 'text', text: 'late output' });
  assert.equal(
    events.length,
    before + 1,
    'late words cannot reach another chat',
  );
  await assert.rejects(
    voice.start(
      1,
      'chat-a',
      randomUUID(),
      'not-installed',
      () => {},
      async () => true,
    ),
    /installed/,
  );
  await voice.start(
    1,
    'chat-a',
    randomUUID(),
    'en-US',
    () => {},
    async () => false,
  );
  assert.equal(starts, 1, 'declined consent never starts capture');
  console.log(
    'PASS multilingual Unicode, chat-bound events, Stop cleanup, stale output, missing languages and denied permission',
  );
  const native = await new WindowsVoiceBackend().availability();
  assert.equal(native.available, native.languages.length > 0);
  assert.ok(native.help);
  if (process.platform === 'win32')
    console.log(
      `PASS native Windows speech discovery: ${native.languages.map((language) => language.code).join(', ') || 'no installed recognizer (system voice typing fallback)'}`,
    );
  else {
    assert.equal(native.available, false);
    console.log(
      'PASS unsupported platform offers system dictation guidance without recording',
    );
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
