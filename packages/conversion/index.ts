import { promises as fs } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { stringify } from 'csv-stringify/sync';
import {
  AibError,
  address,
  coords,
  range,
  emptySheet,
  newBook,
  validate,
  type Book,
  type Cell,
  type Style,
} from '../schema/index';
import { evaluate, getSheet, readRange } from '../core/index';
import { isErrorCell, dateSerial } from '../univer-adapter/index';
import { importTextTable } from './text-table';
import {
  checkLegacyLimits,
  importLegacyExcel,
  isBiff,
  oleSignature,
  writeLegacyExcel,
} from './legacy-excel';

export interface ConversionIssue {
  feature: string;
  location: string;
  message: string;
}
/** Inspect expanded sizes before handing an untrusted XLSX archive to ExcelJS. */
async function inspectZip(buffer: Buffer) {
  return new Promise<{ files: string[]; xml: Map<string, string> }>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(new AibError('INVALID_XLSX', 'Invalid XLSX archive'));
      const files: string[] = [],
        xml = new Map<string, string>();
      let total = 0,
        failed = false;
      const fail = (e: unknown) => {
        if (!failed) {
          failed = true;
          zip.close();
          reject(e);
        }
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!failed) resolve({ files, xml });
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        total += entry.uncompressedSize;
        files.push(entry.fileName);
        if (
          total > 200 * 1024 * 1024 ||
          entry.uncompressedSize > 100 * 1024 * 1024 ||
          files.length > 10000
        )
          return fail(new AibError('CAPACITY_EXCEEDED', 'Expanded XLSX exceeds limits'));
        if (
          !/^xl\/(worksheets\/sheet\d+\.xml|workbook\.xml|theme\/theme1\.xml)$/.test(entry.fileName)
        ) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return fail(e);
          const chunks: Buffer[] = [];
          stream.on('error', fail);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            xml.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
function color(c: Partial<ExcelJS.Color> | undefined): string | undefined {
  if (!c) return undefined;
  if ('tint' in c && c.tint !== undefined && c.tint !== 0)
    throw new AibError('UNSUPPORTED_COLOR', 'Tinted theme colors need explicit RGB conversion');
  if (c.argb) return '#' + c.argb.slice(-6);
  if (c.theme === 0) return '#FFFFFF';
  if (c.theme === 1) return '#000000';
  if ((c as { indexed?: number }).indexed === 64) return '#000000';
  throw new AibError('UNSUPPORTED_COLOR', 'Theme/indexed colors need explicit RGB conversion');
}
function importStyle(cell: ExcelJS.Cell): Style {
  const st: Style = {},
    f = cell.font,
    a = cell.alignment;
  if (f) {
    if (f.bold !== undefined) st.bold = f.bold;
    if (f.italic !== undefined) st.italic = f.italic;
    if (f.name) st.fontFamily = f.name;
    if (f.size) st.fontSize = f.size;
    if (f.color) st.color = color(f.color);
    if (f.underline || f.strike || f.vertAlign)
      throw new AibError('UNSUPPORTED_STYLE', 'Underline, strike or superscript');
  }
  if (a) {
    if (a.horizontal) {
      if (!['left', 'center', 'right'].includes(a.horizontal))
        throw new AibError('UNSUPPORTED_STYLE', 'Alignment');
      st.horizontal = a.horizontal as Style['horizontal'];
    }
    if (a.vertical) {
      if (!['top', 'middle', 'bottom'].includes(a.vertical))
        throw new AibError('UNSUPPORTED_STYLE', 'Vertical alignment');
      st.vertical = a.vertical as Style['vertical'];
    }
    if (a.wrapText || a.textRotation || a.indent || a.shrinkToFit)
      throw new AibError('UNSUPPORTED_STYLE', 'Wrap, rotation, indentation or shrink');
  }
  if (cell.numFmt && cell.numFmt !== 'General') st.numberFormat = cell.numFmt;
  if (cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid')
    st.background = color(cell.fill.fgColor);
  else if (cell.fill && !(cell.fill.type === 'pattern' && cell.fill.pattern === 'none'))
    throw new AibError('UNSUPPORTED_STYLE', 'Pattern or gradient fill');
  if (cell.border && Object.keys(cell.border).length) {
    const b = cell.border.top;
    if (
      !b ||
      !['bottom', 'left', 'right'].every(
        (k) => JSON.stringify(cell.border[k as 'bottom']) === JSON.stringify(b),
      ) ||
      !['thin', 'medium', 'thick'].includes(b.style ?? '')
    )
      throw new AibError('UNSUPPORTED_STYLE', 'Non-uniform or advanced border');
    st.border = { style: b.style as 'thin', color: color(b.color) ?? '#000000' };
  }
  return st;
}
function exportStyle(s: Style): Partial<ExcelJS.Style> {
  const rgb = (x: string) => ({ argb: 'FF' + x.replace('#', '').slice(-6) });
  const st: Partial<ExcelJS.Style> = {
    font: {
      ...(s.bold !== undefined ? { bold: s.bold } : {}),
      ...(s.italic !== undefined ? { italic: s.italic } : {}),
      ...(s.fontFamily ? { name: s.fontFamily } : {}),
      ...(s.fontSize ? { size: s.fontSize } : {}),
      ...(s.color ? { color: rgb(s.color) } : {}),
    },
  };
  if (s.numberFormat) st.numFmt = s.numberFormat;
  if (s.background) st.fill = { type: 'pattern', pattern: 'solid', fgColor: rgb(s.background) };
  if (s.horizontal || s.vertical)
    st.alignment = {
      ...(s.horizontal && { horizontal: s.horizontal }),
      ...(s.vertical && { vertical: s.vertical }),
    };
  if (s.border) {
    const b = { style: s.border.style, color: rgb(s.border.color) };
    st.border = { top: b, bottom: b, left: b, right: b };
  }
  return st;
}
async function readSource(file: string) {
  if ((await fs.stat(file)).size > 100 * 1024 * 1024)
    throw new AibError('CAPACITY_EXCEEDED', '文件超过 100 MiB');
  return fs.readFile(file);
}
export async function importExcel(file: string, allowLossy = false) {
  const buffer = await readSource(file);
  if (buffer.subarray(0, 8).equals(oleSignature) || isBiff(buffer))
    return importLegacyExcel(buffer, file, allowLossy);
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || ![3, 5, 7].includes(buffer[2]))
    return importTextTable(buffer, file);
  const archive = await inspectZip(buffer),
    issues: ConversionIssue[] = [];
  const issue = (feature: string, location: string, message: string) => {
    issues.push({ feature, location, message });
  };
  for (const f of archive.files)
    if (
      /^xl\/(charts|drawings|pivot|externalLinks|queryTables|tables|comments|threadedComments|connections|vbaProject)/.test(
        f,
      )
    )
      issue('unsupported-part', f, 'This workbook part is outside AIB v1');
  for (const [name, xml] of archive.xml)
    for (const tag of [
      'conditionalFormatting',
      'dataValidations',
      'hyperlinks',
      'sheetProtection',
      'definedNames',
      'extLst',
    ])
      if (new RegExp(`<${tag}[\\s>]`).test(xml)) issue(tag, name, `${tag} is outside AIB v1`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const b = newBook(path.basename(file, path.extname(file)));
  b.dateSystem = wb.properties.date1904 ? '1904' : '1900';
  b.sheets = [];
  let footprint = 0;
  for (const ws of wb.worksheets) {
    if (ws.state !== 'visible') issue('hidden-sheet', ws.name, 'Hidden sheet will become visible');
    const s = emptySheet(
      `sheet${ws.id}`,
      ws.name,
      Math.max(100, ws.rowCount),
      Math.max(26, ws.columnCount),
    );
    if (ws.rowCount > 1048576 || ws.columnCount > 16384)
      throw new AibError('CAPACITY_EXCEEDED', 'Excel sheet dimensions exceed limits');
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.findRow(r);
      if (!row) continue;
      footprint += row.cellCount;
      if (footprint > 2000000)
        throw new AibError('CAPACITY_EXCEEDED', 'Excel sheet footprint exceeds 2,000,000 cells');
      if (row.height || row.hidden)
        s.rowMeta[r - 1] = {
          ...(row.height ? { size: (row.height * 96) / 72 } : {}),
          ...(row.hidden ? { hidden: true } : {}),
        };
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const a = address(r - 1, c - 1),
          v = cell.value;
        let value: Cell = null;
        if (cell.formula) {
          s.formulas[a] = '=' + cell.formula;
          if ((v as { shareType?: string }).shareType === 'array') {
            issue(
              'array-formula',
              `${ws.name}!${a}`,
              'Array formula is flattened to its cached result',
            );
            delete s.formulas[a];
            const cached = cell.result;
            if (
              typeof cached === 'number' ||
              typeof cached === 'string' ||
              typeof cached === 'boolean'
            )
              value = cached;
          }
        } else if (v instanceof Date) {
          let milliseconds = v.getTime();
          const serial = (milliseconds - Date.UTC(1899, 11, 30)) / 86400000;
          if (b.dateSystem === '1900' && serial >= 60 && serial < 61) {
            value = serial;
            issue(
              'fictitious-date',
              `${ws.name}!${a}`,
              'Excel 1900-02-29 retained as a numeric serial, without an ISO date type',
            );
          } else {
            if (b.dateSystem === '1900' && serial < 60) milliseconds += 86400000;
            value = new Date(milliseconds).toISOString();
            s.cellTypes[a] = value.endsWith('T00:00:00.000Z') ? 'date' : 'datetime';
            if (s.cellTypes[a] === 'date') value = value.slice(0, 10);
          }
        } else if (typeof v === 'object' && v) {
          if ('error' in v) {
            value = v.error;
            s.cellTypes[a] = 'error';
          } else if ('richText' in v) {
            value = v.richText.map((x) => x.text).join('');
            issue('rich-text', `${ws.name}!${a}`, 'Rich text formatting will be flattened');
          } else if ('text' in v) {
            value = v.text;
            issue('hyperlink', `${ws.name}!${a}`, 'Hyperlink target will be removed');
          } else issue('cell-value', `${ws.name}!${a}`, 'Unsupported cell value');
        } else value = v as Cell;
        if (value !== null || s.formulas[a]) {
          while (s.data.length < r) s.data.push([]);
          while (s.data[r - 1].length < c) s.data[r - 1].push(null);
          s.data[r - 1][c - 1] = value;
        }
        try {
          const style = importStyle(cell);
          if (Object.keys(style).length) s.styleRules.push({ range: a, style });
        } catch (e) {
          issue('style', `${ws.name}!${a}`, (e as Error).message);
        }
        if (cell.note) issue('note', `${ws.name}!${a}`, 'Notes are outside AIB v1');
      });
    }
    ws.columns?.forEach((col, c) => {
      if (col.width || col.hidden) {
        s.dimensions.columns = Math.max(s.dimensions.columns, c + 1);
        s.columnMeta[c] = {
          ...(col.width ? { size: Math.round(col.width * 7 + 5) } : {}),
          ...(col.hidden ? { hidden: true } : {}),
        };
      }
    });
    s.merges = ws.model.merges ?? [];
    const view = ws.views?.find((x) => x.state === 'frozen');
    if (view && view.state === 'frozen')
      s.freeze = { rows: view.ySplit ?? 0, columns: view.xSplit ?? 0 };
    if (ws.autoFilter) {
      if (typeof ws.autoFilter === 'string') s.filter = { range: ws.autoFilter, columns: [] };
      else issue('filter', ws.name, 'Filter definition is outside AIB v1');
    }
    // Layout metadata can extend well beyond the last cell that carries a value.
    s.dimensions.rows = Math.max(s.dimensions.rows, s.freeze.rows);
    s.dimensions.columns = Math.max(s.dimensions.columns, s.freeze.columns);
    if (s.filter) {
      const extent = range(s.filter.range);
      s.dimensions.rows = Math.max(s.dimensions.rows, extent.endRow + 1);
      s.dimensions.columns = Math.max(s.dimensions.columns, extent.endColumn + 1);
    }
    const xml = archive.xml.get(`xl/worksheets/sheet${ws.id}.xml`) ?? '';
    if (/<filterColumn[\s>]/.test(xml))
      issue('filter-criteria', ws.name, 'Excel filter criteria are not imported');
    b.sheets.push(s);
  }
  if (issues.length && !allowLossy)
    throw new AibError(
      'CONVERSION_LOSS',
      'Conversion needs explicit --allow-lossy; original file is unchanged',
      issues,
    );
  return { book: validate(b), issues };
}
export { importExcel as importXlsx };
export async function exportXlsx(b: Book) {
  validate(b);
  const wb = new ExcelJS.Workbook(),
    snapshot = await evaluate(b);
  wb.properties.date1904 = b.dateSystem === '1904';
  const issues: ConversionIssue[] = [];
  for (const s of b.sheets) {
    const ws = wb.addWorksheet(s.name);
    s.data.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v !== null) {
          const cell = ws.getCell(r + 1, c + 1),
            t = s.cellTypes[address(r, c)];
          cell.value =
            t === 'error'
              ? { error: v as ExcelJS.CellErrorValue['error'] }
              : t === 'date' || t === 'datetime'
                ? dateSerial(String(v), b.dateSystem)
                : v;
        }
      }),
    );
    for (const [a, f] of Object.entries(s.formulas)) {
      const [r, c] = coords(a),
        x = snapshot.sheets[s.id].cellData?.[r]?.[c];
      ws.getCell(a).value = {
        formula: f.slice(1),
        result: isErrorCell(x)
          ? { error: String(x!.v) as ExcelJS.CellErrorValue['error'] }
          : x?.t === 3
            ? Boolean(x.v)
            : (x?.v as number),
      };
    }
    for (const rule of s.styleRules) {
      const r = range(rule.range);
      for (let i = r.startRow; i <= r.endRow; i++)
        for (let j = r.startColumn; j <= r.endColumn; j++) {
          const cell = ws.getCell(i + 1, j + 1),
            st = exportStyle(rule.style);
          cell.style = {
            ...cell.style,
            ...st,
            font: { ...cell.font, ...st.font },
            alignment: { ...cell.alignment, ...st.alignment },
          };
        }
    }
    for (const a of Object.keys(s.cellTypes))
      if (s.cellTypes[a] !== 'error' && !ws.getCell(a).numFmt)
        ws.getCell(a).numFmt = s.cellTypes[a] === 'date' ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss';
    s.merges.forEach((m) => ws.mergeCells(m));
    for (const [k, m] of Object.entries(s.rowMeta)) {
      const row = ws.getRow(+k + 1);
      if (m.size) row.height = (m.size * 72) / 96;
      if (m.hidden !== undefined) {
        row.hidden = m.hidden;
        if (m.hidden && !row.height) row.height = 18;
      }
    }
    for (const [k, m] of Object.entries(s.columnMeta)) {
      const col = ws.getColumn(+k + 1);
      if (m.size) col.width = Math.max(0, (m.size - 5) / 7);
      if (m.hidden !== undefined) col.hidden = m.hidden;
    }
    if (s.freeze.rows || s.freeze.columns)
      ws.views = [{ state: 'frozen', xSplit: s.freeze.columns, ySplit: s.freeze.rows }];
    if (s.filter) {
      ws.autoFilter = s.filter.range;
      if (s.filter.columns.length)
        issues.push({
          feature: 'filter-criteria',
          location: s.name,
          message: 'AIB filter conditions cannot currently be exported',
        });
    }
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), issues };
}
export async function importCsv(file: string) {
  return importTextTable(await readSource(file), file, true);
}
export async function exportXls(book: Book) {
  checkLegacyLimits(book);
  return writeLegacyExcel(book, await exportXlsx(book));
}
export async function exportCsv(
  b: Book,
  sheet: string,
  formulaMode: 'values' | 'formulas' = 'values',
) {
  const s = getSheet(b, sheet);
  let rows = Math.max(s.data.length, 1),
    cols = s.data.reduce((max, r) => Math.max(max, r.length), 1);
  for (const a of Object.keys(s.formulas)) {
    const [r, c] = coords(a);
    rows = Math.max(rows, r + 1);
    cols = Math.max(cols, c + 1);
  }
  const values = await readRange(
    b,
    s.id,
    `A1:${address(rows - 1, cols - 1)}`,
    formulaMode === 'values',
  );
  return stringify(values, {
    record_delimiter: '\r\n',
    quoted_match: /[\r\n]/,
    cast: { boolean: (v) => (v ? 'TRUE' : 'FALSE') },
  });
}
