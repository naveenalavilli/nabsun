import type { OfficeJob } from '../../shared/office';
import { word } from './word';
import { excel } from './excel';
export function processOffice(job: OfficeJob, bytes?: Uint8Array) {
  if (!job || !['word', 'excel'].includes(job.kind) || !['read', 'create', 'edit'].includes(job.action)) throw Error('Unsupported Office operation.');
  return job.kind === 'word' ? word(job, bytes) : excel(job, bytes);
}
