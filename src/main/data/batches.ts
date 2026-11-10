import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Batch, RowResult, BatchReport } from '../../shared/workflows';
import { durableJson, readJson, validId } from './storage';
export class BatchStore {
  readonly dir: string;
  constructor(profile: string) {
    this.dir = path.join(profile, 'batches');
    fs.mkdirSync(this.dir, { recursive: true });
    this.recover();
  }
  private folder(id: string) {
    return path.join(this.dir, validId(id));
  }
  save(batch: Batch) {
    batch.updatedAt = Date.now();
    durableJson(path.join(this.folder(batch.id), 'batch.json'), batch);
  }
  get(scope: string, id: string) {
    const batch = readJson<Batch>(path.join(this.folder(id), 'batch.json'));
    if (
      batch.schemaVersion !== 1 ||
      batch.scope !== scope ||
      batch.rowCount < 1 ||
      batch.rowCount > 5000
    )
      throw Error('Batch is not available in this chat.');
    return batch;
  }
  list(scope: string) {
    return fs
      .readdirSync(this.dir)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .flatMap((id) => {
        try {
          const batch = readJson<Batch>(
            path.join(this.folder(id), 'batch.json'),
          );
          return batch.scope === scope ? [batch] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  row(batch: Batch, row: number): RowResult | undefined {
    if (!Number.isInteger(row) || row < 1 || row > batch.rowCount)
      throw Error('Invalid row.');
    try {
      return readJson<RowResult>(
        path.join(this.folder(batch.id), 'rows', row + '.json'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  saveRow(batch: Batch, row: RowResult) {
    if (row.row < 1 || row.row > batch.rowCount) throw Error('Invalid row.');
    durableJson(
      path.join(this.folder(batch.id), 'rows', row.row + '.json'),
      row,
    );
  }
  report(scope: string, id: string): BatchReport {
    const batch = this.get(scope, id);
    return {
      batch,
      rows: Array.from(
        { length: batch.rowCount },
        (_, index) =>
          this.row(batch, index + 1) ?? {
            row: index + 1,
            status: 'pending' as const,
            steps: 0,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            modelCalls: 0,
            repairs: 0,
            targets: [],
          },
      ),
    };
  }
  create(
    value: Omit<Batch, 'schemaVersion' | 'id' | 'createdAt' | 'updatedAt'>,
  ) {
    const batch: Batch = {
      ...value,
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.save(batch);
    return batch;
  }
  advance(batch: Batch, row: RowResult) {
    if (!['succeeded', 'failed', 'skipped'].includes(row.status))
      throw Error('Uncertain rows cannot be advanced automatically.');
    // The row checkpoint must be durable before advancing the manifest/cursor.
    this.saveRow(batch, row);
    this.count(batch, row);
    batch.cursor = row.row + 1;
    this.save(batch);
  }
  private count(batch: Batch, row: RowResult) {
    if (row.status === 'succeeded') {
      batch.successes++;
      batch.consecutiveFailures = 0;
    } else if (row.status === 'failed') {
      batch.failures++;
      batch.consecutiveFailures++;
    } else if (row.status === 'skipped') batch.skipped++;
  }
  recover() {
    for (const id of fs
      .readdirSync(this.dir)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))) {
      const file = path.join(this.folder(id), 'batch.json');
      let batch: Batch;
      try {
        batch = readJson<Batch>(file);
      } catch {
        continue;
      }
      if (!['running', 'pausing'].includes(batch.state)) continue;
      const row =
        batch.cursor <= batch.rowCount
          ? this.row(batch, batch.cursor)
          : undefined;
      if (row && ['succeeded', 'failed', 'skipped'].includes(row.status)) {
        this.count(batch, row);
        batch.cursor++;
      } else if (row?.status === 'running') {
        row.status = 'needs-review';
        row.error =
          'The app closed during this row. Check the website before retrying or marking it complete.';
        this.saveRow(batch, row);
      }
      batch.state = batch.cursor > batch.rowCount ? 'completed' : 'paused';
      this.save(batch);
    }
  }
}
export function csvReport(report: BatchReport): string {
  const cell = (value: unknown) => {
    let text = String(value ?? '').replace(/[\r\n]/g, ' ');
    if (/^[=+@\t-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const columns = [
    'row',
    'status',
    'steps',
    'durationMs',
    'inputTokens',
    'outputTokens',
    'modelCalls',
    'repairs',
    'targets',
    'entries',
    'error',
  ];
  return (
    columns.join(',') +
    '\n' +
    report.rows
      .map((row) =>
        columns
          .map((column) =>
            cell(
              column === 'targets'
                ? row.targets.join('; ')
                : column === 'entries'
                  ? JSON.stringify(row.entries ?? [])
                  : row[column as keyof RowResult],
            ),
          )
          .join(','),
      )
      .join('\n') +
    '\n'
  );
}
