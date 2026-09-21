import { dialog, shell, type BaseWindow, type WebContents } from 'electron';

const pending = new WeakSet<BaseWindow>();

/** Websites cannot launch local applications without a separate user decision. */
export async function requestExternalLink(window: BaseWindow, contents: WebContents, raw: string): Promise<void> {
  if (window.isDestroyed() || contents.isDestroyed() || pending.has(window) || raw.length > 4096) return;
  let target: URL;
  try { target = new URL(raw); } catch { return; }
  if (/^(https?|file|javascript|vbscript|data|about|chrome|nabsun|smart|view-source):$/i.test(target.protocol)) return;
  const source = contents.getURL();
  let origin = 'This page';
  try { origin = new URL(source).origin; } catch {}
  pending.add(window);
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', title: 'Open another app?',
      message: `${origin} wants to open an application on your computer.`,
      detail: target.href,
      buttons: ['Cancel', 'Open app'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response === 1 && !window.isDestroyed() && !contents.isDestroyed() && contents.getURL() === source) {
      await shell.openExternal(target.href);
    }
  } catch (error) {
    console.warn('[external link] Could not open the application:', error instanceof Error ? error.message : error);
  } finally { pending.delete(window); }
}
