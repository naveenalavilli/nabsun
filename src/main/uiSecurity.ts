import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function sameUiFile(actual: string, expected: string): boolean {
  try {
    const a = path.resolve(fileURLToPath(actual));
    const b = path.resolve(fileURLToPath(expected));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

interface TrustedUi {
  contents: WebContents;
  url: string;
  /** Omitted for the main shell; overlays only need a few channels. */
  channels?: ReadonlySet<string>;
}

/** Verify both the sending frame and its document, not just its process. */
export function isTrustedUiSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
  views: readonly TrustedUi[],
): boolean {
  return views.some(({ contents, url, channels }) => {
    if (contents.isDestroyed() || event.sender !== contents) return false;
    const frame = event.senderFrame;
    return frame !== null && frame === contents.mainFrame &&
      sameUiFile(frame.url, url) &&
      (!channels || channels.has(channel));
  });
}

/** All privileged UI handlers share the same sender boundary. */
export function uiIpc(views: readonly TrustedUi[]) {
  return {
    handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedUiSender(event, channel, views)) throw new Error('Untrusted IPC sender');
        return listener(event, ...args);
      });
    },
    on(channel: string, listener: Parameters<typeof ipcMain.on>[1]) {
      ipcMain.on(channel, (event, ...args) => {
        if (isTrustedUiSender(event, channel, views)) listener(event, ...args);
      });
    },
  };
}

/** A privileged preload must never be carried into a navigated web page. */
export function lockUiNavigation(contents: WebContents): void {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
