import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { OfficeJob } from '../shared/office';
export interface OfficeResult { bytes?: Uint8Array; summary?: unknown; value?: unknown }
export function runOffice(job: OfficeJob, bytes?: Buffer, signal?: AbortSignal, workerPath = path.join(__dirname, '../main/office-worker.js')): Promise<OfficeResult> {
  if (signal?.aborted) return Promise.reject(Error('Stopped before processing the Office document.'));
  if (JSON.stringify(job).length > 2 * 1024 * 1024 || (bytes?.length ?? 0) > 20 * 1024 * 1024) return Promise.reject(Error('Office document input exceeds the size limit.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), { workerData: { job, bytes }, execArgv: ['--no-addons'], resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let done = false;
    const finish = (error?: Error, value?: OfficeResult) => {
      if (done) return;done = true;clearTimeout(timer);signal?.removeEventListener('abort', abort);void worker.terminate();
      if (error) reject(error);else resolve(value!);
    };
    const timer = setTimeout(() => finish(Error('Office processing exceeded 25 seconds. No changes were saved.')), 25000);
    const abort = () => finish(Error('Stopped while processing the Office document. No changes were saved.'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => message.ok ? finish(undefined, message.value) : finish(Error(message.error)));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!done) finish(Error('Office worker stopped before completing (' + code + ').')); });
    if (signal?.aborted) abort();
  });
}
