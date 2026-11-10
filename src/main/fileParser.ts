import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readSheet } from 'read-excel-file/node';

export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const pushCell = () => {
    if (cell.length > 32768) throw Error('A cell exceeds 32768 characters.');
    row.push(cell);
    cell = '';
    closed = false;
    if (row.length > 200) throw Error('More than 200 columns.');
  };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
    if (rows.length > 5001) throw Error('More than 5000 data rows.');
  };
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
      continue;
    }
    if (ch === '"' && !cell && !closed) {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[index + 1] === '\n') index++;
      pushRow();
      continue;
    }
    if (closed && ch.trim())
      throw Error('Unexpected characters after a quoted cell.');
    cell += ch;
  }
  if (quoted) throw Error('Unclosed quoted cell.');
  if (cell || row.length || closed) pushRow();
  return rows;
}
function table(rows: unknown[][]) {
  if (!rows.length) return { columns: [], rows: [] };
  if (rows.length > 5001) throw Error('More than 5000 data rows.');
  const columns = rows[0].map(
    (value, index) => String(value ?? '').trim() || `Column ${index + 1}`,
  );
  if (
    columns.length > 200 ||
    columns.some((column) => column.length > 200) ||
    new Set(columns).size !== columns.length
  )
    throw Error('Use at most 200 columns with unique names.');
  return {
    columns,
    rows: rows.slice(1).map((row) => {
      if (row.length > columns.length)
        throw Error('A data row has more cells than its header.');
      return Object.fromEntries(
        columns.map((name, index) => {
          const value =
            row[index] instanceof Date
              ? (row[index] as Date).toISOString()
              : String(row[index] ?? '');
          if (value.length > 32768)
            throw Error('A cell exceeds 32768 characters.');
          return [name, value];
        }),
      );
    }),
  };
}
async function parse() {
  const { bytes, extension } = workerData as {
    bytes: Uint8Array;
    extension: string;
  };
  if (bytes.length > 20 * 1024 * 1024) throw Error('File exceeds 20 MB.');
  if (extension === '.xlsx')
    return { kind: 'table', ...table(await readSheet(Buffer.from(bytes))) };
  if (extension === '.csv' || extension === '.tsv')
    return {
      kind: 'table',
      ...table(
        parseDelimited(
          new TextDecoder('utf-8', { fatal: true })
            .decode(bytes)
            .replace(/^\uFEFF/, ''),
          extension === '.tsv' ? '\t' : ',',
        ),
      ),
    };
  if (extension === '.pdf') {
    const pdf = await import(
      pathToFileURL(path.join(__dirname, '../pdf/pdf.mjs')).href
    );
    const loading = pdf.getDocument({
      standardFontDataUrl:
        path
          .join(__dirname, '../pdf/standard_fonts')
          .split(path.sep)
          .join('/') + '/',
      cMapUrl:
        path.join(__dirname, '../pdf/cmaps').split(path.sep).join('/') + '/',
      cMapPacked: true,
      data: new Uint8Array(bytes),
      disableAutoFetch: true,
      disableStream: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      isEvalSupported: false,
      stopAtErrors: true,
      useWasm: false,
      verbosity: 0,
    });
    const document = await loading.promise;
    try {
      if (document.numPages > 100) throw Error('PDF exceeds 100 pages.');
      let text = '';
      for (let page = 1; page <= document.numPages; page++) {
        const content = await (await document.getPage(page)).getTextContent();
        text +=
          content.items
            .map((item: { str?: string }) => item.str ?? '')
            .join(' ') + '\n';
        if (text.length > 100000)
          throw Error('PDF text exceeds 100000 characters.');
      }
      return { kind: 'text', text, pages: document.numPages };
    } finally {
      await loading.destroy();
    }
  }
  if (
    ![
      '.txt',
      '.md',
      '.json',
      '.log',
      '.xml',
      '.html',
      '.htm',
      '.yaml',
      '.yml',
    ].includes(extension)
  )
    throw Error(
      'Reading supports text, CSV, TSV, XLSX, and text-based PDF files.',
    );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw Error('This is not a supported text file.');
  if (text.length > 100000) throw Error('Text exceeds 100000 characters.');
  return { kind: 'text', text };
}
if (parentPort)
  parse().then(
    (value) => parentPort!.postMessage({ ok: true, value }),
    (error) =>
      parentPort!.postMessage({
        ok: false,
        error: String(error.message || error).slice(0, 300),
      }),
  );
