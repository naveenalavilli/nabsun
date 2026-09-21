import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { app, shell, type DownloadItem, type Session } from 'electron';
import type { DownloadEntry } from '../shared/types';

/**
 * Download manager.
 *
 * Behaves like Chrome: files go straight to the Downloads folder without a save
 * dialog, with an in-app list to watch progress, open the file, or reveal it.
 * "Save as" flows (the context menu, a page calling downloadURL) still get a
 * dialog because Electron shows one when no save path is set.
 */
export class DownloadManager extends EventEmitter {
  private items = new Map<string, { entry: DownloadEntry; item: DownloadItem }>();
  private nextId = 1;

  attach(session: Session) {
    session.on('will-download', (_event, item) => {
      const id = String(this.nextId++);
      const savePath = this.uniquePath(item.getFilename());
      item.setSavePath(savePath);

      const entry: DownloadEntry = {
        id,
        filename: path.basename(savePath),
        url: item.getURL(),
        savePath,
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        startedAt: Date.now(),
        paused: false,
      };
      this.items.set(id, { entry, item });
      this.emit('change');

      item.on('updated', (_e, state) => {
        entry.receivedBytes = item.getReceivedBytes();
        entry.totalBytes = item.getTotalBytes();
        entry.paused = item.isPaused();
        entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        this.emit('change');
      });

      item.once('done', (_e, state) => {
        entry.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
        entry.receivedBytes = item.getReceivedBytes();
        entry.completedAt = Date.now();
        this.emit('change');
      });
    });
  }

  /**
   * Never silently overwrite: "report.pdf" becomes "report (2).pdf", the way
   * every browser handles a repeat download.
   */
  private uniquePath(filename: string): string {
    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(filename);
    const base = path.basename(filename, ext) || 'download';
    let candidate = path.join(dir, `${base}${ext}`);
    let n = 2;
    // A second download can arrive before Chromium creates the first file.
    // Reserve paths already handed to a DownloadItem as well as files on disk.
    while (fs.existsSync(candidate) || [...this.items.values()].some(({ entry }) =>
      process.platform === 'win32'
        ? entry.savePath.toLowerCase() === candidate.toLowerCase()
        : entry.savePath === candidate)) {
      candidate = path.join(dir, `${base} (${n++})${ext}`);
    }
    return candidate;
  }

  list(): DownloadEntry[] {
    return [...this.items.values()].map((v) => v.entry).sort((a, b) => b.startedAt - a.startedAt);
  }

  get activeCount(): number {
    return this.list().filter((d) => d.state === 'progressing').length;
  }

  cancel(id: string) {
    this.items.get(id)?.item.cancel();
  }

  togglePause(id: string) {
    const record = this.items.get(id);
    if (!record) return;
    if (record.item.isPaused()) record.item.resume();
    else record.item.pause();
    this.emit('change');
  }

  open(id: string) {
    const entry = this.items.get(id)?.entry;
    if (entry?.state === 'completed') void shell.openPath(entry.savePath);
  }

  reveal(id: string) {
    const entry = this.items.get(id)?.entry;
    if (entry) shell.showItemInFolder(entry.savePath);
  }

  /** Clears finished rows from the list; the files themselves are untouched. */
  clearFinished() {
    for (const [id, { entry }] of this.items) {
      if (entry.state !== 'progressing') this.items.delete(id);
    }
    this.emit('change');
  }

  openFolder() {
    void shell.openPath(app.getPath('downloads'));
  }
}
