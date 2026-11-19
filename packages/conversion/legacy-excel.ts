import path from 'node:path';
import * as XLS from 'xlsx';
import * as codepages from 'xlsx/dist/cpexcel.full.mjs';
import { AibError, emptySheet, newBook, validate, type Book, type Cell } from '../schema/index';
import { serialDate } from '../univer-adapter/index';
import type { ConversionIssue } from './index';

XLS.set_cptable(codepages);
export const oleSignature = Buffer.from('d0cf11e0a1b11ae1', 'hex');
export function isBiff(data: Buffer) {
  return data.length >= 8 && [0x0009, 0x0209, 0x0409, 0x0809].includes(data.readUInt16LE(0));
}

// BIFF exposes features which a cell-oriented reader doesn't include in the worksheet model.
function inspectRecords(stream: Buffer, warn: (feature: string, message: string) => void) {
  const fonts: (Buffer | undefined)[] = [];
  for (let p = 0; p + 4 <= stream.length;) {
    const record = stream.readUInt16LE(p),
      length = stream.readUInt16LE(p + 2);
    p += 4;
    if (p + length > stream.length) throw new AibError('INVALID_XLS', 'XLS 工作簿记录不完整');
    if (record === 0x005d) warn('objects', '图形、图表或嵌入对象将被省略');
    if (record === 0x01b0 || record === 0x01be) warn('rules', '条件格式或数据验证将被省略');
    if (record === 0x0041) warn('panes', '窗口拆分或冻结设置将被省略');
    if (record === 0x009e) warn('filter-criteria', '旧版筛选条件将被省略');
    if (record === 0x0031) {
      if (fonts.length === 4) fonts.push(undefined); // BIFF reserves font index 4.
      fonts.push(stream.subarray(p, p + length));
    }
    if (record === 0x00e0 && length === 20 && !(stream.readUInt16LE(p + 4) & 4)) {
      const font = fonts[stream.readUInt16LE(p)];
      if (
        (font && fonts[0] && !font.equals(fonts[0])) ||
        stream[p + 6] & ~0x20 ||
        stream[p + 7] ||
        stream[p + 8] ||
        stream.readUInt16LE(p + 10) ||
        stream.readUInt32LE(p + 14) >>> 26
      )
        warn('xls-style', '旧版字体、对齐、边框和填充可能无法完整还原，数字格式会保留');
    }
    p += length;
  }
}

export function importLegacyExcel(buffer: Buffer, file: string, allowLossy: boolean) {
  let workbook: XLS.WorkBook;
  try {
    workbook = XLS.read(buffer, {
      type: 'buffer',
      cellNF: true,
      cellStyles: true,
      sheetStubs: true,
      bookFiles: true,
      bookVBA: true,
    });
  } catch (error) {
    throw new AibError('INVALID_XLS', '无法读取旧版 Excel 工作簿：' + (error as Error).message);
  }
  const book = newBook(path.basename(file, path.extname(file)));
  book.dateSystem = workbook.Workbook?.WBProps?.date1904 ? '1904' : '1900';
  book.sheets = [];
  const issues: ConversionIssue[] = [];
  const reported = new Set<string>();
  const warn = (feature: string, message: string, location = book.name) => {
    const key = JSON.stringify([feature, location]);
    if (!reported.has(key)) {
      issues.push({ feature, location, message });
      reported.add(key);
    }
  };
  const cfb = (
    workbook as XLS.WorkBook & { cfb?: { FileIndex: { name: string; content?: Uint8Array }[] } }
  ).cfb;
  const stream = cfb?.FileIndex.find((entry) => /^(?:Book|Workbook)$/i.test(entry.name))?.content;
  if (!workbook.SheetNames.length || (buffer.subarray(0, 8).equals(oleSignature) && !stream))
    throw new AibError('INVALID_XLS', '文件中没有可读的 Excel 工作表');
  inspectRecords(stream ? Buffer.from(stream) : buffer, warn);
  if (workbook.vbaraw) warn('vba', '宏将被省略');
  if (workbook.Workbook?.Names?.length) warn('defined-names', '定义名称将被省略');
  let footprint = 0;
  workbook.SheetNames.forEach((name, i) => {
    const ws = workbook.Sheets[name],
      end = XLS.utils.decode_range(ws['!ref'] || 'A1').e;
    const sheet = emptySheet(
      'sheet' + (i + 1),
      name,
      Math.max(100, end.r + 1),
      Math.max(26, end.c + 1),
    );
    if (workbook.Workbook?.Sheets?.[i]?.Hidden) warn('hidden-sheet', '隐藏工作表将可见', name);
    for (const [addr, cell] of Object.entries(ws) as [string, XLS.CellObject][]) {
      if (addr.startsWith('!')) continue;
      let value: Cell = null;
      if (cell.F) warn('array-formula', '数组公式将转换为缓存值', name);
      if (cell.f && !cell.F) sheet.formulas[addr] = '=' + cell.f;
      else if (cell.t === 'e') {
        value = cell.w ?? '#VALUE!';
        sheet.cellTypes[addr] = 'error';
      } else if (cell.t === 'n' && typeof cell.v === 'number') {
        value = cell.v;
        if (typeof cell.z === 'string' && XLS.SSF.is_date(cell.z)) {
          if (book.dateSystem === '1900' && value >= 60 && value < 61)
            warn('fictitious-date', 'Excel 1900-02-29 将保留为日期序号', name);
          else {
            const iso = serialDate(value, book.dateSystem);
            sheet.cellTypes[addr] = iso.endsWith('T00:00:00.000Z') ? 'date' : 'datetime';
            value = sheet.cellTypes[addr] === 'date' ? iso.slice(0, 10) : iso;
          }
        }
      } else if (typeof cell.v === 'string' || typeof cell.v === 'boolean') value = cell.v;
      if (cell.l || cell.c?.length) warn('annotation', '超链接或批注将被省略', name);
      if (typeof cell.z === 'string' && cell.z !== 'General')
        sheet.styleRules.push({ range: addr, style: { numberFormat: cell.z } });
      if (value === null && !sheet.formulas[addr]) continue;
      const { r, c } = XLS.utils.decode_cell(addr);
      footprint += Math.max(0, c + 1 - (sheet.data[r]?.length ?? 0));
      if (footprint > 2000000)
        throw new AibError('CAPACITY_EXCEEDED', 'XLS 超过 2,000,000 个单元格');
      while (sheet.data.length <= r) sheet.data.push([]);
      const row = sheet.data[r];
      while (row.length <= c) row.push(null);
      row[c] = value;
    }
    sheet.merges = (ws['!merges'] ?? []).map((r) => XLS.utils.encode_range(r));
    for (const merge of ws['!merges'] ?? []) {
      sheet.dimensions.rows = Math.max(sheet.dimensions.rows, merge.e.r + 1);
      sheet.dimensions.columns = Math.max(sheet.dimensions.columns, merge.e.c + 1);
    }
    ws['!rows']?.forEach((row, r) => {
      const size = row.hpx ?? (row.hpt ? (row.hpt * 96) / 72 : 0);
      if (size || row.hidden) {
        sheet.rowMeta[r] = { ...(size ? { size } : {}), ...(row.hidden ? { hidden: true } : {}) };
        sheet.dimensions.rows = Math.max(sheet.dimensions.rows, r + 1);
      }
    });
    ws['!cols']?.forEach((col, c) => {
      if (col.wpx || col.hidden) {
        sheet.columnMeta[c] = {
          ...(col.wpx ? { size: col.wpx } : {}),
          ...(col.hidden ? { hidden: true } : {}),
        };
        sheet.dimensions.columns = Math.max(sheet.dimensions.columns, c + 1);
      }
    });
    book.sheets.push(sheet);
  });
  if (issues.length && !allowLossy)
    throw new AibError(
      'CONVERSION_LOSS',
      '旧版工作簿包含无法完整还原的内容，请查看损失报告',
      issues,
    );
  return { book: validate(book), issues };
}

export function checkLegacyLimits(book: Book) {
  for (const sheet of book.sheets) {
    if (sheet.dimensions.rows > 65536 || sheet.dimensions.columns > 256)
      throw new AibError(
        'XLS_LIMIT',
        sheet.name + ' 超过旧版 XLS 的 65,536 行或 256 列上限，请导出为 XLSX',
      );
    if (
      sheet.data.some((row) =>
        row.some((value) => typeof value === 'string' && value.length > 32767),
      )
    )
      throw new AibError('XLS_LIMIT', sheet.name + ' 含有超过 32,767 个字符的文本');
  }
}

export function writeLegacyExcel(
  book: Book,
  result: { buffer: Buffer; issues: ConversionIssue[] },
) {
  // Reuse AIB's Excel date-system, error and calculated-value mapping before writing BIFF8.
  const workbook = XLS.read(result.buffer, { type: 'buffer', cellNF: true, cellStyles: true });
  const issues = [...result.issues];
  for (const sheet of book.sheets) {
    const warn = (feature: string, message: string) =>
      issues.push({ feature, location: sheet.name, message });
    if (Object.keys(sheet.formulas).length)
      warn('xls-formulas', '旧版 XLS 导出将公式保存为当前计算结果');
    if (
      sheet.styleRules.some((rule) => Object.keys(rule.style).some((key) => key !== 'numberFormat'))
    )
      warn('xls-style', '旧版 XLS 导出仅保留数字格式');
    if (
      sheet.freeze.rows ||
      sheet.freeze.columns ||
      sheet.filter ||
      Object.keys(sheet.rowMeta).length
    )
      warn('xls-layout', '旧版 XLS 导出将省略冻结、筛选及行布局');
  }
  return {
    buffer: XLS.write(workbook, { type: 'buffer', bookType: 'biff8', bookSST: true }) as Buffer,
    issues,
  };
}
