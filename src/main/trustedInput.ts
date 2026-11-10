import { AsyncLocalStorage } from 'node:async_hooks';
import type { WebContents } from 'electron';

export type ProtocolSend = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<any>;
const activeProtocol = new AsyncLocalStorage<{
  wc: WebContents;
  send: ProtocolSend;
}>();

/** Serialize complete input gestures per tab, including between external clients. */
const queues = new WeakMap<WebContents, Promise<unknown>>();
export async function withTrustedInput<T>(
  wc: WebContents,
  signal: AbortSignal | undefined,
  action: (send: ProtocolSend) => Promise<T>,
): Promise<T> {
  const active = activeProtocol.getStore();
  if (active?.wc === wc) {
    if (signal?.aborted) throw Error('Stopped before page access.');
    return action(active.send);
  }
  const previous = queues.get(wc) ?? Promise.resolve();
  let release!: () => void;
  const queued = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(
    wc,
    previous.catch(() => {}).then(() => queued),
  );
  await previous.catch(() => {});
  let attached = false;
  let heldMouse: Record<string, unknown> | null = null;
  const heldKeys = new Map<string, Record<string, unknown>>();
  const live = () => {
    if (signal?.aborted) throw Error('Stopped before trusted input.');
    if (wc.isDestroyed()) throw Error('Target tab closed before input.');
  };
  try {
    live();
    if (wc.debugger.isAttached())
      throw Error(
        'The page debugger is in use. Close page DevTools before this browser action. No input was sent.',
      );
    wc.debugger.attach('1.3');
    attached = true;
    const send: ProtocolSend = async (method, params = {}, sessionId) => {
      live();
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed') heldMouse = params;
        if (params.type === 'mouseReleased') heldMouse = null;
      }
      if (method === 'Input.dispatchKeyEvent') {
        if (params.type === 'keyDown') heldKeys.set(String(params.key), params);
        if (params.type === 'keyUp') heldKeys.delete(String(params.key));
      }
      return wc.debugger.sendCommand(method, params, sessionId);
    };
    return await activeProtocol.run({ wc, send }, () => action(send));
  } finally {
    if (attached && !wc.isDestroyed() && wc.debugger.isAttached()) {
      // Always release a held button/key even if Stop arrives mid-gesture.
      const pendingMouse = heldMouse as Record<string, unknown> | null;
      if (pendingMouse)
        await wc.debugger
          .sendCommand('Input.dispatchMouseEvent', {
            ...pendingMouse,
            type: 'mouseReleased',
            buttons: 0,
          })
          .catch(() => {});
      for (const params of heldKeys.values())
        await wc.debugger
          .sendCommand('Input.dispatchKeyEvent', {
            ...params,
            type: 'keyUp',
            text: undefined,
            commands: undefined,
            modifiers: 0,
          })
          .catch(() => {});
      wc.debugger.detach();
    }
    release();
  }
}
export const mouse = (
  type: string,
  x: number,
  y: number,
  button = 'left',
  clickCount = 1,
) => ({
  type,
  x,
  y,
  button,
  clickCount,
  buttons:
    type === 'mousePressed'
      ? button === 'right'
        ? 2
        : button === 'middle'
          ? 4
          : 1
      : 0,
});
