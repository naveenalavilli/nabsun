import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileAuditSink } from '../main/ai/audit';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-audit-'));
const sink = new FileAuditSink(profile);
sink.append({
  actionId: 'fixture',
  phase: 'intent',
  tool: 'browser_type',
  task: 'chat',
  origin: 'https://example.com',
  input: {
    text: 'PRIVATE_TYPED_VALUE',
    url: 'https://example.com?token=PRIVATE_TOKEN',
  },
});
sink.append({
  actionId: 'fixture',
  phase: 'result',
  tool: 'browser_type',
  task: 'chat',
  status: 'ok',
});
assert.equal(new FileAuditSink(profile).verify().sequence, 2);
const file = path.join(
  sink.directory,
  fs.readdirSync(sink.directory).find((file) => file.endsWith('.jsonl'))!,
);
const original = fs.readFileSync(file, 'utf8');
assert.ok(!original.includes('PRIVATE_'));
assert.ok(original.includes('sha256'));
console.log(
  'PASS daily hash-chain journal survives restart and hashes typed data and URL tokens',
);
fs.writeFileSync(file, original.replace('browser_type', 'browser_click'));
assert.throws(() => new FileAuditSink(profile), /integrity/);
fs.writeFileSync(file, original.split('\n').slice(0, 1).join('\n') + '\n');
assert.throws(() => new FileAuditSink(profile), /checkpoint/);
fs.writeFileSync(file, original.slice(0, -3));
assert.throws(() => new FileAuditSink(profile), /incomplete/);
fs.writeFileSync(file, original);
assert.equal(new FileAuditSink(profile).verify().sequence, 2);
console.log(
  'PASS changed records, a removed final record, and partial writes fail verification',
);
const originalOpen = fs.openSync;
try {
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === file) throw Error('fixture storage unavailable');
    return originalOpen(...args);
  }) as typeof fs.openSync;
  assert.throws(
    () =>
      sink.append({
        actionId: 'fail',
        phase: 'intent',
        tool: 'browser_click',
        task: 'chat',
      }),
    /blocked/,
  );
} finally {
  fs.openSync = originalOpen;
}
assert.throws(
  () =>
    sink.append({
      actionId: 'later',
      phase: 'intent',
      tool: 'browser_click',
      task: 'chat',
    }),
  /Restart/,
);
console.log(
  'PASS a storage failure latches closed and refuses later action records',
);
{
  const rotation = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nabsun-audit-retention-'),
  );
  let now = new Date('2026-01-01T12:00:00Z');
  const rotating = new FileAuditSink(rotation, () => now);
  rotating.append({
    actionId: 'old',
    phase: 'intent',
    tool: 'browser_click',
    task: 'chat',
  });
  now = new Date('2026-02-01T12:00:00Z');
  rotating.append({
    actionId: 'new',
    phase: 'intent',
    tool: 'browser_click',
    task: 'chat',
  });
  rotating.retain(7);
  assert.deepEqual(rotating.days(), ['2026-02-01']);
  assert.equal(rotating.verify().sequence, 2);
  assert.equal(new FileAuditSink(rotation).verify().sequence, 2);
  assert.ok(!fs.existsSync(path.join(rotating.directory, '2026-01-01.jsonl')));
  now = new Date('2026-02-02T12:00:00Z');
  rotating.append({
    actionId: 'new',
    phase: 'result',
    tool: 'browser_click',
    task: 'chat',
    status: 'ok',
  });
  assert.equal(rotating.verify().sequence, 3);
  fs.appendFileSync(
    path.join(rotating.directory, '2026-02-02.jsonl'),
    'changed\n',
  );
  assert.throws(
    () =>
      rotating.append({
        actionId: 'blocked',
        phase: 'intent',
        tool: 'browser_click',
        task: 'chat',
      }),
    /blocked/,
  );
  console.log(
    'PASS retention removes expired days with a verifiable anchor; live journal changes block the next action',
  );
}
