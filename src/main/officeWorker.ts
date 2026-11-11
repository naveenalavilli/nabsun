import { parentPort, workerData } from 'node:worker_threads';
import { processOffice } from './office/engine';
try {
  const value = processOffice(workerData.job, workerData.bytes);
  parentPort!.postMessage({ ok: true, value });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Office document processing failed.' });
}
