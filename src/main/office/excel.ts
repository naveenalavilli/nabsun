import type { Document, Element } from '@xmldom/xmldom';
import type { ExcelValue, OfficeJob } from '../../shared/office';
import { S, R, P, CT, XML, xml, readXml, putXml, pack, openOffice, elements, childElements, related, relationshipPart, escapeXml, safeText, type Parts } from './package';

function address(input: string) {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(input);
  if (!match) throw Error('Use a cell address such as A1 or C12.');
  let column = 0;for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw Error('Cell address exceeds Excel worksheet limits.');
  return { row, column };
}
function columnName(column: number) {
  let result = '';
  for (; column; column = Math.floor((column - 1) / 26)) result = String.fromCharCode(65 + (column - 1) % 26) + result;
  return result;
}
function range(input: string) {
  const pieces = input.split(':');
  if (pieces.length > 2) throw Error('Use a cell range such as A1:C10.');
  const first = address(pieces[0]), last = address(pieces[1] ?? pieces[0]);
  if (last.row < first.row || last.column < first.column) throw Error('Cell range is reversed.');
  return { first, last };
}
const contains = (bounds: ReturnType<typeof range>, point: ReturnType<typeof address>) => point.row >= bounds.first.row && point.row <= bounds.last.row && point.column >= bounds.first.column && point.column <= bounds.last.column;
function formula(input: unknown, sheets: string[]) {
  const value = safeText(input, 2000).replace(/^=/, '');
  if (!value || /[\[\]|\\\r\n{};]/.test(value)) throw Error('External, array and command formulas are not supported.');
  let expression = value.replace(/"(?:[^"]|"")*"/g, '0');
  expression = expression.replace(/'(?:[^']|'')+'!/g, sheet => {
    if (!sheets.includes(sheet.slice(1, -2).replace(/''/g, "'"))) throw Error('Formula references an unknown sheet.');return '';
  }).replace(/([A-Za-z_][A-Za-z0-9_.]*)!/g, (_all, sheet: string) => {
    if (!sheets.includes(sheet)) throw Error('Formula references an unknown sheet.');return '';
  });
  const allowed = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS', 'SUMIF', 'SUMIFS', 'IF', 'IFERROR', 'AND', 'OR', 'NOT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'MOD', 'INT', 'LEN', 'LEFT', 'RIGHT', 'MID', 'TRIM', 'UPPER', 'LOWER', 'CONCAT', 'CONCATENATE', 'DATE', 'YEAR', 'MONTH', 'DAY', 'TODAY']);
  expression = expression.replace(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g, (_all, name: string) => {
    if (!allowed.has(name.toUpperCase())) throw Error('This formula function is not supported by the safe editor.');return '(';
  }).replace(/\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}/g, match => { address(match.replace(/\$/g, '').toUpperCase());return '0'; }).replace(/\b(?:TRUE|FALSE)\b/gi, '0');
  if (/[^0-9\s()+\-*/^%,:.<>=&]/.test(expression)) throw Error('Named ranges and unsupported formula expressions are not edited.');
  let depth = 0;for (const char of expression) { if (char === '(') depth++;if (char === ')' && --depth < 0) throw Error('Formula parentheses are unbalanced.'); }
  if (depth) throw Error('Formula parentheses are unbalanced.');
  return value;
}
function valueCell(document: Document, cell: Element, value: ExcelValue, sheets: string[]) {
  for (const node of childElements(cell)) if (node.namespaceURI === S && ['f', 'v', 'is'].includes(node.localName ?? '')) cell.removeChild(node);
  cell.removeAttribute('t');
  const extension = childElements(cell).find(node => node.namespaceURI === S && node.localName === 'extLst') ?? null;
  const add = (name: string, text: string) => { const node = document.createElementNS(S, name);node.textContent = text;cell.insertBefore(node, extension);return node; };
  if (value === null) return;
  if (typeof value === 'string') {
    safeText(value);cell.setAttribute('t', 'inlineStr');
    const inline = document.createElementNS(S, 'is'), text = document.createElementNS(S, 't');
    text.setAttributeNS(XML, 'xml:space', 'preserve');text.textContent = value;inline.appendChild(text);cell.insertBefore(inline, extension);
  } else if (typeof value === 'number' && Number.isFinite(value)) add('v', String(value));
  else if (typeof value === 'boolean') { cell.setAttribute('t', 'b');add('v', value ? '1' : '0'); }
  else if (value && typeof value === 'object' && Object.keys(value).length === 1 && 'formula' in value) add('f', formula(value.formula, sheets));
  else throw Error('A cell value must be text, a finite number, a boolean, null or an explicit formula object.');
}
function cellNode(document: Document, input: string) {
  const point = address(input), data = elements(document, S, 'sheetData')[0];
  if (!data) throw Error('Worksheet cell data is missing.');
  let row = childElements(data).find(row => row.localName === 'row' && Number(row.getAttribute('r')) === point.row);
  if (!row) {
    row = document.createElementNS(S, 'row');row.setAttribute('r', String(point.row));
    const following = childElements(data).find(row => Number(row.getAttribute('r')) > point.row);
    data.insertBefore(row, following ?? null);
  }
  let cell = childElements(row).find(cell => cell.localName === 'c' && cell.getAttribute('r') === input);
  if (!cell) {
    cell = document.createElementNS(S, 'c');cell.setAttribute('r', input);
    const following = childElements(row).find(cell => cell.localName === 'c' && address(cell.getAttribute('r') ?? '').column > point.column);
    row.insertBefore(cell, following ?? null);
  }
  return cell;
}
function updateDimension(document: Document, changes: { cell: string }[]) {
  const node = elements(document, S, 'dimension')[0];
  let bounds = node?.getAttribute('ref') ? range(node.getAttribute('ref')!) : range('A1');
  for (const change of changes) {
    const point = address(change.cell);
    bounds = { first: { row: Math.min(bounds.first.row, point.row), column: Math.min(bounds.first.column, point.column) }, last: { row: Math.max(bounds.last.row, point.row), column: Math.max(bounds.last.column, point.column) } };
  }
  const ref = columnName(bounds.first.column) + bounds.first.row + ':' + columnName(bounds.last.column) + bounds.last.row;
  if (node) node.setAttribute('ref', ref); // Dimension is optional; do not insert it out of schema order.
}
function sheetsOf(parts: Parts, main: string, document: Document) {
  return elements(document, S, 'sheet').map(sheet => ({ name: sheet.getAttribute('name') ?? '', state: sheet.getAttribute('state') ?? 'visible', part: related(parts, main, sheet.getAttributeNS(R, 'id') ?? '') }));
}
function assertEditable(parts: Parts, part: string, document: Document, changes: { cell: string }[]) {
  if (elements(document, S, 'sheetProtection').length) throw Error('This worksheet is protected. Use an unprotected copy.');
  if (elements(document, S, 'row').some(row => !row.getAttribute('r')) || elements(document, S, 'c').some(cell => !cell.getAttribute('r')))
    throw Error('Implicit cell addresses cannot be safely edited. Save a standard .xlsx copy.');
  const special = elements(document, S, 'f').filter(node => ['shared', 'array', 'dataTable'].includes(node.getAttribute('t') ?? ''));
  for (const change of changes) {
    const point = address(change.cell);
    for (const merged of elements(document, S, 'mergeCell')) {
      const bounds = range(merged.getAttribute('ref') ?? '');
      if (contains(bounds, point) && (point.row !== bounds.first.row || point.column !== bounds.first.column)) throw Error('Write to the top-left cell of a merged range.');
    }
    for (const node of special) {
      const ref = node.getAttribute('ref');
      if ((ref && contains(range(ref), point)) || (node.parentNode as Element)?.getAttribute('r') === change.cell)
        throw Error('Shared, array and data-table formulas are preserved and cannot be edited cell by cell.');
    }
    const cell = elements(document, S, 'c').find(cell => cell.getAttribute('r') === change.cell);
    if (cell?.hasAttribute('cm') || cell?.hasAttribute('vm')) throw Error('Rich-data and dynamic-array metadata cells cannot be safely edited.');
    for (const tablePart of elements(document, S, 'tablePart')) {
      const target = related(parts, part, tablePart.getAttributeNS(R, 'id') ?? '');
      const table = readXml(parts, target).documentElement!;
      const bounds = range(table.getAttribute('ref') ?? '');
      if (!contains(bounds, point)) continue;
      const headers = Number(table.getAttribute('headerRowCount') || '1'), totals = Number(table.getAttribute('totalsRowCount') || '0');
      if (point.row < bounds.first.row + headers || point.row > bounds.last.row - totals)
        throw Error('Table headers and totals are preserved. Choose a table data cell.');
      const column = elements(table, S, 'tableColumn')[point.column - bounds.first.column];
      if (column && elements(column, S, 'calculatedColumnFormula').length) throw Error('Calculated table columns cannot be edited cell by cell.');
    }
  }
}
function recalculate(parts: Parts, main: string, document: Document) {
  // A stale calc chain can reference a formula that the user replaced with a value.
  const relName = relationshipPart(main);
  if (parts[relName]) {
    const rels = readXml(parts, relName), types = readXml(parts, '[Content_Types].xml');
    let removed = false;
    for (const rel of elements(rels, P, 'Relationship').filter(node => node.getAttribute('Type') === R + '/calcChain')) {
      const target = related(parts, main, rel.getAttribute('Id') ?? '');delete parts[target];rel.parentNode!.removeChild(rel);removed = true;
      for (const entry of elements(types, CT, 'Override')) if (entry.getAttribute('PartName') === '/' + target) entry.parentNode!.removeChild(entry);
    }
    if (removed) { putXml(parts, relName, rels);putXml(parts, '[Content_Types].xml', types); }
  }
  let calc = elements(document, S, 'calcPr')[0];
  if (!calc) {
    calc = document.createElementNS(S, 'calcPr');
    const following = childElements(document.documentElement!).find(node => ['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst'].includes(node.localName ?? ''));
    document.documentElement!.insertBefore(calc, following ?? null);
  }
  calc.setAttribute('calcId', '0');calc.setAttribute('fullCalcOnLoad', '1');calc.setAttribute('forceFullCalc', '1');
}
export function excel(job: Extract<OfficeJob, { kind: 'excel' }>, bytes?: Uint8Array) {
  if (job.action === 'create') {
    if (!Array.isArray(job.sheets) || !job.sheets.length || job.sheets.length > 20) throw Error('Create between one and twenty worksheets.');
    const names = job.sheets.map(sheet => safeText(sheet.name, 31));
    if (names.some(name => !name.trim() || /[\\/?*\[\]:]/.test(name) || /^'|'$/.test(name)) || new Set(names.map(name => name.toLowerCase())).size !== names.length) throw Error('Use unique Excel sheet names, up to 31 characters, without reserved characters.');
    const parts: Parts = Object.create(null);
    parts['_rels/.rels'] = Buffer.from(`<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    parts['[Content_Types].xml'] = Buffer.from(`<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${job.sheets.map((_sheet, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
    const workbook = xml(`<workbook xmlns="${S}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`);
    parts['xl/_rels/workbook.xml.rels'] = Buffer.from(`<Relationships xmlns="${P}">${names.map((_name, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/></Relationships>`);
    parts['xl/styles.xml'] = Buffer.from(`<styleSheet xmlns="${S}"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF245A78"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
    let total = 0;
    job.sheets.forEach((sheet, i) => {
      if (!Array.isArray(sheet.rows) || sheet.rows.length > 5000 || sheet.rows.some(row => !Array.isArray(row) || row.length > 200)) throw Error('Use up to 5000 rows and 200 columns per new sheet.');
      const header = sheet.header !== false, width = Math.max(1, ...sheet.rows.map(row => row.length)), height = Math.max(1, sheet.rows.length);
      if ((total += sheet.rows.reduce((n, row) => n + row.length, 0)) > 50000) throw Error('Create at most 50000 cells in one workbook.');
      const document = xml(`<worksheet xmlns="${S}"><dimension ref="A1:${columnName(width)}${height}"/>${header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ''}<cols><col min="1" max="${width}" width="20" customWidth="1"/></cols><sheetData/>${header && height > 1 ? `<autoFilter ref="A1:${columnName(width)}${height}"/>` : ''}</worksheet>`);
      sheet.rows.forEach((row, y) => row.forEach((value, x) => {
        const cell = cellNode(document, columnName(x + 1) + (y + 1));
        if (header && y === 0) cell.setAttribute('s', '1');valueCell(document, cell, value, names);
      }));
      putXml(parts, `xl/worksheets/sheet${i + 1}.xml`, document);
    });
    putXml(parts, 'xl/workbook.xml', workbook);
    return { bytes: pack(parts), summary: { sheets: names, cellsCreated: total } };
  }
  if (!bytes) throw Error('Read an Excel file before editing it.');
  const { parts, main, document } = openOffice(bytes, 'excel', job.action === 'edit');
  const sheets = sheetsOf(parts, main, document), sheet = job.sheet ? sheets.find(sheet => sheet.name === job.sheet) : sheets.find(sheet => sheet.state === 'visible') ?? sheets[0];
  if (!sheet) throw Error('Choose an existing worksheet by its exact name.');
  const worksheet = readXml(parts, sheet.part);
  if (worksheet.documentElement?.namespaceURI !== S || worksheet.documentElement.localName !== 'worksheet') throw Error('This worksheet format is not supported.');
  if (job.action === 'read') {
    const bounds = range(job.range ?? 'A1:J20');
    if ((bounds.last.row - bounds.first.row + 1) * (bounds.last.column - bounds.first.column + 1) > 500) throw Error('Read at most 500 cells at a time.');
    const stringsRel = parts[relationshipPart(main)] && elements(readXml(parts, relationshipPart(main)), P, 'Relationship').find(rel => rel.getAttribute('Type') === R + '/sharedStrings');
    const strings = stringsRel ? elements(readXml(parts, related(parts, main, stringsRel.getAttribute('Id') ?? '')), S, 'si').map(si => elements(si, S, 't').map(t => t.textContent ?? '').join('')) : [];
    const cells = elements(worksheet, S, 'c').filter(cell => contains(bounds, address(cell.getAttribute('r') ?? ''))).map(cell => {
      const f = childElements(cell).find(node => node.localName === 'f'), v = childElements(cell).find(node => node.localName === 'v')?.textContent ?? '', type = cell.getAttribute('t');
      let value: string | number | boolean | null = null;
      if (type === 's') value = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') value = elements(cell, S, 't').map(t => t.textContent ?? '').join('');
      else if (type === 'b') value = v === '1';
      else if (type === 'str' || type === 'e' || type === 'd') value = v;
      else if (v !== '') value = Number.isFinite(Number(v)) ? Number(v) : v;
      return { cell: cell.getAttribute('r'), ...(f ? { formula: f.textContent, cachedValue: value, cacheMayBeStale: true } : { value }), style: cell.getAttribute('s') ?? undefined };
    });
    return { value: { kind: 'excel', sheets: sheets.map(({ name, state }) => ({ name, state })), sheet: sheet.name, range: job.range ?? 'A1:J20', cells, note: 'Formula caches are not calculated by Nabsun. Excel recalculates when opening the saved workbook.' } };
  }
  if (!job.sheet) throw Error('Specify the exact worksheet name before editing.');
  if (!Array.isArray(job.changes) || !job.changes.length || job.changes.length > 500 || new Set(job.changes.map(change => change.cell)).size !== job.changes.length) throw Error('Provide up to 500 unique cell changes.');
  assertEditable(parts, sheet.part, worksheet, job.changes);
  for (const change of job.changes) valueCell(worksheet, cellNode(worksheet, change.cell), change.value, sheets.map(sheet => sheet.name));
  updateDimension(worksheet, job.changes);recalculate(parts, main, document);
  putXml(parts, sheet.part, worksheet);putXml(parts, main, document);
  return { bytes: pack(parts), summary: { sheet: sheet.name, cellsChanged: job.changes.length, recalculation: 'Recalculation is requested in Excel; existing manual-calculation mode is preserved.' } };
}
