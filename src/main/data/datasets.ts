import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dataset, DatasetSummary } from '../../shared/workflows';
import type { FileStore } from '../files';
import { durableJson, readJson, validId } from './storage';
export class DatasetStore {
  private dir: string;
  constructor(
    private profile: string,
    private files: FileStore,
  ) {
    this.dir = path.join(profile, 'datasets');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  async fromFile(
    scope: string,
    fileId: string,
    name?: string,
    signal?: AbortSignal,
  ): Promise<DatasetSummary> {
    if (this.list(scope).length >= 20)
      throw Error('A chat can hold at most 20 datasets.');
    const parsed = await this.files.read(scope, fileId, signal);
    if (
      parsed.kind !== 'table' ||
      !parsed.columns?.length ||
      !parsed.rows?.length
    )
      throw Error(
        'Choose a CSV, TSV, or XLSX table with a header and at least one row.',
      );
    if (parsed.rows.length > 5000)
      throw Error('Datasets support up to 5000 rows.');
    const dataset: Dataset = {
      schemaVersion: 1,
      id: randomUUID(),
      scope,
      name: (name || this.files.describe(scope, fileId).name).slice(0, 120),
      columns: parsed.columns,
      rows: parsed.rows,
      createdAt: Date.now(),
    };
    if (Buffer.byteLength(JSON.stringify(dataset)) > 20 * 1024 * 1024)
      throw Error('Parsed table exceeds 20 MB. Split it into smaller tables.');
    durableJson(path.join(this.dir, dataset.id + '.json'), dataset);
    return this.summary(dataset);
  }
  async paste(
    scope: string,
    text: string,
    name = 'Pasted table',
  ): Promise<DatasetSummary> {
    if (Buffer.byteLength(text) > 8 * 1024 * 1024)
      throw Error('Pasted data exceeds 8 MB.');
    const incoming = path.join(this.profile, 'incoming-data', randomUUID());
    fs.mkdirSync(incoming, { recursive: true });
    const delimiter = text.split(/\r?\n/, 1)[0].includes('\t') ? 'tsv' : 'csv',
      file = path.join(incoming, 'pasted-table.' + delimiter);
    fs.writeFileSync(file, text, { mode: 0o600 });
    let id: string | undefined;
    try {
      id = this.files.attach(scope, file).id;
      return await this.fromFile(scope, id, name);
    } finally {
      if (id) this.files.remove(scope, id);
      fs.unlinkSync(file);
      fs.rmdirSync(incoming);
    }
  }
  get(scope: string | null | undefined, id: string): Dataset {
    const dataset = readJson<Dataset>(
      path.join(this.dir, validId(id) + '.json'),
      20 * 1024 * 1024,
    );
    if (dataset.schemaVersion !== 1 || dataset.scope !== scope || !scope)
      throw Error('This dataset does not belong to this chat.');
    if (
      dataset.id !== id ||
      typeof dataset.name !== 'string' ||
      dataset.name.length > 120 ||
      !Array.isArray(dataset.columns) ||
      !dataset.columns.length ||
      dataset.columns.length > 200 ||
      dataset.columns.some(
        (column) =>
          typeof column !== 'string' || !column || column.length > 200,
      ) ||
      new Set(dataset.columns).size !== dataset.columns.length ||
      !Array.isArray(dataset.rows) ||
      !dataset.rows.length ||
      dataset.rows.length > 5000
    )
      throw Error('Invalid dataset.');
    const columns = new Set(dataset.columns);
    if (
      dataset.rows.some(
        (row) =>
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          Object.keys(row).length !== columns.size ||
          Object.entries(row).some(
            ([column, value]) =>
              !columns.has(column) ||
              typeof value !== 'string' ||
              value.length > 32768,
          ),
      )
    )
      throw Error('Invalid dataset cells.');
    return dataset;
  }
  list(scope: string): DatasetSummary[] {
    return fs
      .readdirSync(this.dir)
      .filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
      .flatMap((file) => {
        const dataset = readJson<Dataset>(
          path.join(this.dir, file),
          20 * 1024 * 1024,
        );
        return dataset.scope === scope
          ? [this.summary(this.get(scope, file.slice(0, -5)))]
          : [];
      });
  }
  summary(dataset: Dataset): DatasetSummary {
    return {
      id: dataset.id,
      name: dataset.name,
      columns: dataset.columns,
      rowCount: dataset.rows.length,
    };
  }
  row(scope: string | null | undefined, id: string, index: number) {
    const dataset = this.get(scope, id);
    if (!Number.isInteger(index) || index < 1 || index > dataset.rows.length)
      throw Error('Row number is outside this dataset.');
    return structuredClone(dataset.rows[index - 1]);
  }
}
