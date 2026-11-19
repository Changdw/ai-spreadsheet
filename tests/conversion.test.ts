import { it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { newBook, serialize } from '../packages/schema/index';
import { execute } from '../packages/service/index';
import { exportHtml } from '../packages/conversion/html';
import {
  importExcel,
  importXlsx,
  exportXlsx,
  importCsv,
  exportCsv,
} from '../packages/conversion/index';
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aib-convert-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
it('exports a scriptless HTML snapshot with calculated, formatted and visible cells', async () => {
  const b = newBook('报价 <A>'),
    s = b.sheets[0];
  b.dateSystem = '1904';
  s.data = [
    ['名称', '金额', '日期'],
    ['001', 8, '1904-01-02'],
    ['过滤行', 2],
    ['手动隐藏', 8],
    ['<长文本>&'.repeat(60)],
  ];
  s.cellTypes.C2 = 'date';
  s.formulas.D2 = '=B2*3';
  s.styleRules = [{ range: 'D2', style: { numberFormat: '0.00', bold: true } }];
  s.filter = { range: 'A1:D3', columns: [{ column: 1, values: [8] }] };
  s.rowMeta['3'] = { hidden: true };
  s.merges = ['A5:C6'];
  const out = (await exportHtml(b)).buffer.toString();
  for (const value of [
    '报价 &lt;A&gt;',
    '24.00',
    '1904-01-02',
    '001',
    'rowspan="2" colspan="3"',
    '<details>',
    '&lt;长文本&gt;&amp;',
  ])
    expect(out).toContain(value);
  for (const value of ['过滤行', '手动隐藏', '<script', '<长文本>'])
    expect(out).not.toContain(value);
});
it.each(['xls', 'xlsx'])('recognizes a GBK tabular export in a .%s file', async (ext) => {
  const file = path.join(dir, '行情.' + ext);
  const header = Buffer.from('cab1bce409bfaac5cc09', 'hex'); // 时间、开盘
  await fs.writeFile(
    file,
    Buffer.concat([header, Buffer.from('ID\t\r2026-09-07,Mon\t+3763.30\t000685\t\r\r\n')]),
  );
  const result = await importExcel(file);
  expect(result.issues).toEqual([]);
  expect(result.book.sheets[0].data).toEqual([
    ['时间', '开盘', 'ID'],
    ['2026-09-07,Mon', 3763.3, '000685'],
  ]);
});
it('reads UTF-16 text and keeps long IDs and formula-looking literals verbatim on disk', async () => {
  const file = path.join(dir, '行情.xls');
  await fs.writeFile(file, '\ufeff代号\t文本\r\n123456789012345678\t=$&', 'utf16le');
  expect(JSON.parse(serialize((await importExcel(file)).book)).sheets[0].data[1]).toEqual([
    '123456789012345678',
    '=$&',
  ]);
  await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5, 6]));
  await expect(importExcel(file, true)).rejects.toBeDefined();
  await fs.writeFile(file, Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
  await expect(importExcel(file, true)).rejects.toMatchObject({ code: 'INVALID_XLSX' });
});
it('imports real BIFF8 cells, dates, formulas, merges and multiple sheets', async () => {
  const result = await importExcel(path.resolve('tests/fixtures/legacy-types.xls'));
  expect(result.issues).toEqual([]);
  expect(result.book.sheets.map((s) => s.name)).toEqual(['行情', '说明']);
  const sheet = result.book.sheets[0];
  expect(sheet.data.slice(0, 3)).toEqual([['000685', 12.25], [true, null], ['2026-11-17']]);
  expect(sheet.formulas.B2).toBe('=B1*2');
  expect(sheet.merges).toEqual(['A5:B5']);
  expect(sheet.cellTypes.A3).toBe('date');
});
it('exports binary XLS and requires explicit consent to flatten a formula', async () => {
  const book = newBook(),
    source = path.join(dir, 'book.aib'),
    target = path.join(dir, 'out.xls');
  book.sheets[0].data = [[12, '001', '长'.repeat(300)]];
  book.sheets[0].formulas.A2 = '=A1*2';
  await fs.writeFile(source, serialize(book));
  await expect(
    execute({ command: 'export', file: source, args: { target } }),
  ).rejects.toMatchObject({ code: 'CONVERSION_LOSS' });
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  await execute({ command: 'export', file: source, args: { target, allowLossy: true } });
  expect((await fs.readFile(target)).subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');
  const converted = (await importExcel(target)).book.sheets[0];
  expect(converted.data).toEqual([...book.sheets[0].data, [24]]);
  expect(converted.formulas).toEqual({});
});
it('roundtrips xlsx values, formulas, styles, merges, freeze and dates', async () => {
  const b = newBook(),
    s = b.sheets[0];
  s.data = [
    ['001', true, '2026-11-17'],
    [10, 20, null],
  ];
  s.cellTypes.C1 = 'date';
  s.formulas.C2 = '=SUM(A2:B2)';
  s.styleRules = [{ range: 'A1', style: { bold: true, background: '#AABBCC', numberFormat: '@' } }];
  s.merges = ['D1:E1'];
  s.freeze = { rows: 1, columns: 1 };
  const x = await exportXlsx(b),
    file = path.join(dir, '样例.xlsx');
  await fs.writeFile(file, x.buffer);
  const result = await importXlsx(file);
  expect(result.issues).toEqual([]);
  const r = result.book.sheets[0];
  expect(r.data.slice(0, 2).map((row) => row.slice(0, 3))).toEqual(s.data);
  expect(r.formulas.C2).toBe(s.formulas.C2);
  expect(r.cellTypes.C1).toBe('date');
  expect(r.merges).toEqual(s.merges);
  expect(r.freeze).toEqual(s.freeze);
  expect(r.styleRules.find((x) => x.range === 'A1')?.style.bold).toBe(true);
});
it('rejects unsupported Excel features by default and reports explicitly permitted loss', async () => {
  const wb = new ExcelJS.Workbook(),
    s = wb.addWorksheet('Sheet1');
  s.getCell('A1').value = { text: '链接', hyperlink: 'https://example.com' };
  const file = path.join(dir, 'link.xlsx');
  await wb.xlsx.writeFile(file);
  await expect(importXlsx(file)).rejects.toMatchObject({ code: 'CONVERSION_LOSS' });
  expect((await importXlsx(file, true)).issues.length).toBeGreaterThan(0);
});
it('preserves CSV leading zeros, formula-looking literals, Unicode, quotes and multiline text', async () => {
  const file = path.join(dir, 'data.csv');
  await fs.writeFile(file, '001,"你好\n世界","a""b",=1+1\r\n');
  const b = (await importCsv(file)).book;
  expect(b.sheets[0].data).toEqual([['001', '你好\n世界', 'a"b', '=1+1']]);
  expect(await exportCsv(b, 'Sheet1')).toContain('001,"你好\n世界","a""b",=1+1');
});
it('roundtrips early 1900 and 1904 ISO dates without a one-day shift', async () => {
  for (const dateSystem of ['1900', '1904'] as const) {
    const b = newBook();
    b.dateSystem = dateSystem;
    const s = b.sheets[0];
    s.data = [['1900-01-01', '1900-02-28', '1904-01-01']];
    s.cellTypes = { A1: 'date', B1: 'date', C1: 'date' };
    const file = path.join(dir, dateSystem + '.xlsx');
    await fs.writeFile(file, (await exportXlsx(b)).buffer);
    expect((await importXlsx(file)).book.sheets[0].data[0]).toEqual(s.data[0]);
  }
});
it('keeps formatting and hidden state on empty cells and rows', async () => {
  const b = newBook(),
    s = b.sheets[0];
  s.styleRules = [{ range: 'D7', style: { background: '#AABBCC' } }];
  s.rowMeta['9'] = { hidden: true };
  const file = path.join(dir, 'blank-styles.xlsx');
  await fs.writeFile(file, (await exportXlsx(b)).buffer);
  const imported = (await importXlsx(file)).book.sheets[0];
  expect(
    imported.styleRules.some((x) => x.range === 'D7' && x.style.background === '#AABBCC'),
  ).toBe(true);
  expect(imported.rowMeta['9'].hidden).toBe(true);
});

it('imports dimensions referenced only by column metadata, filters and frozen panes', async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Layout');
  sheet.getCell('A1').value = 'Header';
  sheet.getColumn(40).hidden = true;
  sheet.getColumn(40).width = 22;
  sheet.autoFilter = 'A1:B200';
  sheet.views = [{ state: 'frozen', xSplit: 45, ySplit: 125 }];
  const file = path.join(dir, 'layout.xlsx');
  await wb.xlsx.writeFile(file);
  const imported = (await importExcel(file)).book.sheets[0];
  expect(imported.dimensions).toEqual({ rows: 200, columns: 45 });
  expect(imported.columnMeta[39]).toMatchObject({ hidden: true });
  expect(imported.filter?.range).toBe('A1:B200');
  expect(imported.freeze).toEqual({ columns: 45, rows: 125 });
});

it('keeps independent horizontal and vertical alignment rules on XLSX export', async () => {
  const book = newBook(),
    sheet = book.sheets[0];
  sheet.data = [[1, 2]];
  sheet.styleRules = [
    { range: 'A1', style: { horizontal: 'right' } },
    { range: 'A1', style: { vertical: 'top' } },
    { range: 'B1', style: { vertical: 'bottom' } },
    { range: 'B1', style: { horizontal: 'left' } },
  ];
  const file = path.join(dir, 'alignments.xlsx');
  await fs.writeFile(file, (await exportXlsx(book)).buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  expect(wb.worksheets[0].getCell('A1').alignment).toMatchObject({
    horizontal: 'right',
    vertical: 'top',
  });
  expect(wb.worksheets[0].getCell('B1').alignment).toMatchObject({
    horizontal: 'left',
    vertical: 'bottom',
  });
});

it('distinguishes boolean values, cached boolean formulas and blanks in CSV', async () => {
  const book = newBook(),
    sheet = book.sheets[0];
  sheet.data = [[true, false, null]];
  sheet.formulas.D1 = '=FALSE()';
  sheet.formulas.E1 = '=TRUE()';
  expect(await exportCsv(book, sheet.id)).toBe('TRUE,FALSE,,FALSE,TRUE\r\n');
});

it.each(['hidden row', 'hidden column', 'filtered row'])(
  'omits a merged anchor in a %s from exported HTML',
  async (mode) => {
    const book = newBook(),
      sheet = book.sheets[0];
    sheet.data = [
      ['Header', null, 'Status'],
      ['private merged label', null, 'drop'],
      [null, null, 'keep'],
      [null, null, 'public label'],
    ];
    sheet.merges = ['A2:B3'];
    if (mode === 'hidden row') sheet.rowMeta[1] = { hidden: true };
    if (mode === 'hidden column') sheet.columnMeta[0] = { hidden: true };
    if (mode === 'filtered row')
      sheet.filter = { range: 'A1:C3', columns: [{ column: 2, values: ['keep'] }] };
    const html = (await exportHtml(book)).buffer.toString();
    expect(html).not.toContain('private merged label');
    expect(html).toContain('public label');
    expect(html).toContain('rowspan=');
  },
);
