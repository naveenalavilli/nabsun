import type { PluginApi, PagePluginContext } from './plugins';
import type { RiskLevel } from '../../shared/types';

const [entry, storage, id, version] = process.argv.slice(2);
if (!process.permission)
  throw Error('Plugin host requires enforced Node permissions.');
if (!process.send) throw Error('Plugin host requires a private IPC channel.');
type Handler = (
  input: Record<string, unknown>,
  page: PagePluginContext,
) => unknown;
interface Definition {
  name: string;
  description: string;
  risk?: RiskLevel;
  parameters?: Record<string, unknown>;
  required?: string[];
  handler: Handler;
}
const definitions = new Map<string, Definition>();
const commands = new Map<string, () => unknown>();
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let serial = 0,
  active: string | null = null,
  pageState = { url: '', title: '' };
const send = (message: unknown) => {
  if (JSON.stringify(message).length > 256000)
    throw Error('Plugin message exceeds 256 KB.');
  process.send!(message);
};
function helper(method: string, args: unknown[]) {
  if (!active) return Promise.reject(Error('No active plugin invocation.'));
  const request = String(++serial),
    call = active;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(request, { resolve, reject });
    try {
      send({ type: 'helper', request, call, method, args });
    } catch (error) {
      pending.delete(request);
      reject(error);
    }
  });
}
const page: PagePluginContext = {
  url: () => pageState.url,
  title: () => pageState.title,
  navigate: async (url) => {
    await helper('navigate', [url]);
  },
  readText: async (selector) => String(await helper('readText', [selector])),
  snapshot: async () => String(await helper('snapshot', [])),
  evaluate: async <T>(expression: string) =>
    (await helper('evaluate', [expression])) as T,
  openTab: async (url, background) =>
    String(await helper('openTab', [url, background])),
  status: (message) => {
    void helper('status', [message]).catch(() => {});
  },
};
const api: PluginApi = {
  id,
  version,
  storagePath: storage,
  log: () => {}, // Untrusted plugin output cannot become host diagnostics or prompts.
  registerTool: (spec) => {
    if (
      definitions.size >= 100 ||
      !spec ||
      typeof spec.name !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(spec.name) ||
      typeof spec.description !== 'string' ||
      spec.description.length > 4000 ||
      typeof spec.handler !== 'function' ||
      definitions.has(spec.name)
    )
      throw Error('Invalid plugin tool definition.');
    definitions.set(spec.name, spec);
  },
  registerCommand: (spec) => {
    if (
      commands.size >= 100 ||
      !spec ||
      typeof spec.id !== 'string' ||
      typeof spec.run !== 'function'
    )
      throw Error('Invalid plugin command.');
    commands.set(spec.id, spec.run);
  },
};
process.on('message', async (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as Record<string, unknown>;
  if (message.type === 'helper-result') {
    const waiting = pending.get(String(message.request));
    if (!waiting) return;
    pending.delete(String(message.request));
    if (message.error) waiting.reject(Error(String(message.error)));
    else {
      if (message.page && typeof message.page === 'object')
        pageState = message.page as typeof pageState;
      waiting.resolve(message.value);
    }
    return;
  }
  if (message.type !== 'invoke' || typeof message.call !== 'string') return;
  const call = message.call;
  if (active) {
    send({ type: 'result', call, error: 'Plugin is already busy.' });
    return;
  }
  active = call;
  try {
    if (JSON.stringify(message).length > 256000)
      throw Error('Plugin invocation is too large.');
    const definition = definitions.get(String(message.tool));
    if (!definition) throw Error('Plugin tool is not registered.');
    pageState = message.page as typeof pageState;
    const value = await definition.handler(
      message.input as Record<string, unknown>,
      page,
    );
    send({ type: 'result', call, value: value ?? null });
  } catch (error) {
    send({
      type: 'result',
      call,
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        1000,
      ),
    });
  } finally {
    active = null;
    for (const item of pending.values())
      item.reject(Error('Plugin invocation ended.'));
    pending.clear();
  }
});
process.on('disconnect', () => process.exit(0));
async function start() {
  const plugin = require(entry) as { activate?: (api: PluginApi) => unknown };
  if (typeof plugin.activate !== 'function')
    throw Error('Plugin must export activate(api).');
  await plugin.activate(api);
  send({
    type: 'ready',
    tools: [...definitions.values()].map(
      ({ handler: _handler, ...definition }) => definition,
    ),
  });
}
start().catch((error) => {
  send({
    type: 'startup-error',
    error: String(error instanceof Error ? error.message : error).slice(
      0,
      1000,
    ),
  });
  process.exit(1);
});
