import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, BaseWindow, session as browserSession } from 'electron';
import { version } from '../../../package.json';
import { FileStore } from '../../main/files';
import { fileTools } from '../../main/ai/tools/files';
import { tasks, trustedTask, type BenchTask } from './tasks';
import { Agent } from '../../main/ai/agent';
import { ApprovalManager } from '../../main/ai/approvals';
import { SessionStore } from '../../main/ai/sessions';
import {
  LocalProvider,
  bundledPaths,
  DEFAULT_LOCAL_OPTIONS,
} from '../../main/ai/providers/local';
import type {
  Provider,
  StreamRequest,
  StreamEvent,
} from '../../main/ai/provider';
import { browserTools } from '../../main/ai/tools/browser';
import { SettingsStore } from '../../main/store';
import { HistoryStore } from '../../main/history';
import { TabManager, delay } from '../../main/tabs';
import type { AgentEvent } from '../../shared/types';

const root = path.resolve(__dirname, '../..');
const option = (name: string, fallback: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') || fallback;
const backend = option('provider', 'scripted');
const output = path.resolve(
  option('output', path.join(root, 'bench-results', backend + '.json')),
);
const attempts = Number(option('attempts', '3'));
const threads = Number(option('threads', '4'));
if (!Number.isInteger(threads) || threads < 1 || threads > 64)
  throw Error('threads must be 1-64');
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3)
  throw Error('attempts must be 1-3');
if (!['scripted', 'local'].includes(backend))
  throw Error(
    'Supported providers: scripted, local. No paid backend is called implicitly.',
  );
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-bench-'));
app.setPath('userData', profile);
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
class ScriptedProvider implements Provider {
  readonly id = 'anthropic' as const;
  readonly label = 'Scripted benchmark (no model)';
  step = 0;
  constructor(
    private task: BenchTask,
    private fileId?: string,
  ) {}
  async listModels() {
    return ['scripted'];
  }
  supportsVision() {
    return false;
  }
  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    if (this.step++ === 0) {
      yield {
        type: 'tool_use',
        id: 'snapshot',
        name: 'browser_snapshot',
        input: {},
      };
      yield { type: 'stop', reason: 'tool_use' };
      return;
    }
    const operation = this.task.operations[this.step - 2];
    if (!operation) {
      yield { type: 'stop', reason: 'end_turn' };
      return;
    }
    const outline = req.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => (block as { content: string }).content)
      .join('\n');
    const ref = (name: string) => {
      const line = outline
        .split('\n')
        .reverse()
        .find(
          (line) =>
            line.includes(JSON.stringify(name)) && line.includes('[ref='),
        );
      const result = line?.match(/\[ref=([^\]]+)\]/);
      if (!result) throw Error('Missing target in outline: ' + name);
      return result[1];
    };
    const input = {
      ...operation.input,
      ...(operation.input?.fileId === 'BENCH_ATTACHMENT'
        ? { fileId: this.fileId }
        : {}),
      ...(operation.name ? { ref: ref(operation.name) } : {}),
      ...(operation.to ? { toRef: ref(operation.to) } : {}),
    };
    yield {
      type: 'tool_use',
      id: 'step-' + this.step,
      name: operation.tool,
      input,
    };
    yield { type: 'stop', reason: 'tool_use' };
  }
}
async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function main() {
  await app.whenReady();
  const html = fs.readFileSync(
    path.join(root, 'scripts/fixtures/bench/page.html'),
    'utf8',
  );
  const react = fs.readFileSync(
    path.join(root, 'dist/test/bench/react-fixture.js'),
  );
  let topPort = 0,
    framePort = 0;
  const handle: http.RequestListener = (req, res) => {
    res.setHeader('Connection', 'close');
    if (req.url === '/react-fixture.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(react);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      html
        .replaceAll('__FRAME_PORT__', String(framePort))
        .replaceAll('__TOP_PORT__', String(topPort)),
    );
  };
  const server = http.createServer(handle),
    frames = http.createServer(handle);
  topPort = await listen(server);
  framePort = await listen(frames);
  const allowed = new Set([
    `http://127.0.0.1:${topPort}`,
    `http://127.0.0.1:${framePort}`,
    `http://localhost:${framePort}`,
  ]);
  const fixtureSession = browserSession.fromPartition('bench');
  fixtureSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      callback({
        cancel:
          !allowed.has(url.origin) &&
          !['about:', 'data:', 'blob:'].includes(url.protocol),
      });
    } catch {
      callback({ cancel: true });
    }
  });
  fixtureSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  fixtureSession.setPermissionCheckHandler(() => false);
  fixtureSession.setDevicePermissionHandler(() => false);
  const settings = new SettingsStore();
  settings.save({
    provider: backend === 'local' ? 'local' : 'anthropic',
    autoApprove: { safe: true, write: true, dangerous: false },
    maxAgentSteps: 12,
    personalContext: false,
    memoryEnabled: false,
  });
  const history = new HistoryStore(),
    sessions = new SessionStore(profile),
    approvals = new ApprovalManager(settings),
    files = new FileStore(profile);
  approvals.setEmitter((request) => approvals.resolve(request.id, 'allow'));
  const window = new BaseWindow({ show: false, width: 1100, height: 800 });
  window.showInactive();
  const tabs = new TabManager({
    window,
    preloadPath: path.join(root, 'dist/preload/page.js'),
    partition: 'bench',
    history,
    homepage: 'about:blank',
    onFindResult: () => {},
  });
  tabs.setBounds({ x: 0, y: 0, width: 1100, height: 800 });
  const local = new LocalProvider(
    () => bundledPaths(null, root),
    () => ({ ...DEFAULT_LOCAL_OPTIONS, threads }),
  );
  const metadata = {
    version,
    startedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    threads,
    contextSize: DEFAULT_LOCAL_OPTIONS.contextSize,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
  const reports: Record<string, unknown>[] = [];
  try {
    const selected = option('task', 'all');
    for (const task of [...tasks, trustedTask].filter(
      (task) => selected === 'all' || task.id === selected,
    )) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        for (const tab of [...tabs.all]) tabs.close(tab.id);
        const tab = tabs.create(
          `http://127.0.0.1:${topPort}/?kind=${task.kind}&value=${encodeURIComponent(task.value)}`,
        );
        await tabs.waitForSettled(tab, 5000);
        await delay(100);
        const session = sessions.create();
        let attachmentId: string | undefined;
        if (task.kind === 'upload') {
          const file = path.join(profile, 'fixture.txt');
          fs.writeFileSync(file, task.value);
          attachmentId = files.attach(session.id, file).id;
        }
        const provider =
            backend === 'local'
              ? local
              : new ScriptedProvider(task, attachmentId),
          events: AgentEvent[] = [];
        const agent = new Agent({
          files,
          providers: new Map([[provider.id, provider]]),
          settings,
          sessions,
          tabs,
          history,
          approvals,
          getTools: () => [...browserTools(), ...fileTools()],
          userDataPath: profile,
          emit: (event) => {
            events.push(event);
            if (event.type === 'tool_start')
              console.log(`STEP ${task.id} attempt ${attempt}: ${event.name}`);
          },
        });
        const start = Date.now();
        const timeout = setTimeout(
          () => agent.abortAll(),
          backend === 'local' ? 180000 : 20000,
        );
        let error = '';
        try {
          await agent.send(session.id, task.instruction, { attachPage: false });
        } catch (err) {
          error = String(err);
        } finally {
          clearTimeout(timeout);
        }
        const actual = await tab.wc
          .executeJavaScript('JSON.stringify(window.result||{})')
          .then((text) => JSON.parse(text))
          .catch(() => ({}));
        const success =
          actual.value === task.value &&
          (!task.trusted || actual.trusted === true);
        const usage = events.filter((event) => event.type === 'usage').at(-1);
        const result = {
          task: task.id,
          backend,
          attempt,
          success,
          steps: events.filter((event) => event.type === 'tool_start').length,
          inputTokens: usage?.type === 'usage' ? usage.usage.inputTokens : 0,
          outputTokens: usage?.type === 'usage' ? usage.usage.outputTokens : 0,
          wallTimeMs: Date.now() - start,
          tiers: events
            .filter((event) => event.type === 'tool_start')
            .map(() => (backend === 'scripted' ? 'scripted' : backend)),
          actual,
          error:
            error ||
            events
              .filter(
                (event) =>
                  event.type === 'error' ||
                  (event.type === 'tool_end' && event.status !== 'ok'),
              )
              .map((event) =>
                event.type === 'error'
                  ? event.message
                  : event.type === 'tool_end'
                    ? event.result
                    : '',
              )
              .join('; '),
        };
        reports.push(result);
        console.log(
          `${success ? 'PASS' : 'FAIL'} ${task.id} attempt ${attempt}`,
        );
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(
          output,
          JSON.stringify(
            { schemaVersion: 1, backend, attempts, metadata, reports },
            null,
            2,
          ),
        );
        agent.abortAll();
      }
    }
    if (!reports.length) throw Error('No matching tasks');
    const success = reports.filter((result) => result.success).length;
    const summary =
      `# Generated task benchmark\n\nBackend: ${backend}. Attempts per task: ${attempts}.\n\n| Task | Passed | Attempts |\n| --- | ---: | ---: |\n` +
      [...new Set(reports.map((result) => result.task))]
        .map((id) => {
          const group = reports.filter((result) => result.task === id);
          return `| ${id} | ${group.filter((result) => result.success).length} | ${group.length} |`;
        })
        .join('\n') +
      `\n\nTotal: ${success}/${reports.length} (${((100 * success) / reports.length).toFixed(1)}%).\n`;
    fs.writeFileSync(output.replace(/\.json$/, '.md'), summary);
    console.log(
      `Benchmark: ${success}/${reports.length} (${((100 * success) / reports.length).toFixed(1)}%)`,
    );
    const baselinePath = path.join(root, 'docs/bench/scripted-baseline.json');
    if (
      backend === 'scripted' &&
      !process.argv.includes('--record-baseline') &&
      fs.existsSync(baselinePath)
    ) {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
        reports: { task: string; success: boolean }[];
      };
      for (const id of new Set(reports.map((result) => result.task))) {
        const old = baseline.reports.filter((result) => result.task === id),
          now = reports.filter((result) => result.task === id);
        if (
          old.length &&
          now.filter((result) => result.success).length / now.length <
            old.filter((result) => result.success).length / old.length
        )
          throw Error('Benchmark regression: ' + id);
      }
    }
    if (process.argv.includes('--record-baseline')) {
      if (backend !== 'scripted' || reports.length !== 111)
        throw Error(
          'Baseline needs all 37 tasks, three attempts, scripted provider',
        );
      fs.copyFileSync(output, baselinePath);
      fs.copyFileSync(
        output.replace(/\.json$/, '.md'),
        path.join(root, 'docs/bench/scripted-baseline.md'),
      );
    }
  } finally {
    local.stop();
    tabs.destroyAll();
    window.destroy();
    settings.flush();
    server.closeAllConnections();
    frames.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => frames.close(() => resolve())),
    ]);
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
