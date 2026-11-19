import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AibError, type Book } from '../schema/index';
import * as store from '../storage/index';
import { importCsv, importExcel, exportCsv, exportXls, exportXlsx } from '../conversion/index';
import { coveredCells } from '../schema/merges';
import { exportHtml } from '../conversion/html';
import { requiredString } from './request';

export async function importWorkbook(file: string, source: string, allowLossy: boolean) {
  const ext = path.extname(source).toLowerCase();
  if (!['.csv', '.xls', '.xlsx', '.aib'].includes(ext))
    throw new AibError('UNSUPPORTED_FORMAT', ext);
  const result =
    ext === '.xlsx' || ext === '.xls'
      ? await importExcel(source, allowLossy)
      : ext === '.csv'
        ? await importCsv(source)
        : { book: (await store.load(source)).book, issues: [] };
  return { ...(await store.create(file, result.book)), issues: result.issues };
}
export async function exportWorkbook(book: Book, a: Record<string, unknown>) {
  const target = requiredString(a, 'target');
  const ext = path.extname(target).toLowerCase();
  if (!['.xls', '.xlsx', '.csv', '.html'].includes(ext))
    throw new AibError('UNSUPPORTED_FORMAT', ext);
  const result =
    ext === '.html'
      ? await exportHtml(book, a.language === 'en-US' ? 'en-US' : 'zh-CN')
      : ext === '.xlsx'
        ? await exportXlsx(book)
        : ext === '.xls'
          ? await exportXls(book)
          : {
              buffer: Buffer.from(
                await exportCsv(
                  book,
                  requiredString(a, 'sheet'),
                  a.formulas === true ? 'formulas' : 'values',
                ),
              ),
              issues: [
                {
                  feature: 'csv-metadata',
                  location: requiredString(a, 'sheet'),
                  message:
                    'CSV exports one sheet without styles, merges, types or other workbook metadata',
                },
              ],
            };
  const issues = [...result.issues];
  // CSV writes each raw cell, including cells beneath a merge. Visual formats hide them.
  if (ext !== '.csv') {
    for (const sheet of book.sheets) {
      const first = coveredCells(sheet).next();
      if (!first.done)
        issues.push({
          feature: 'merged-cell-content',
          location: sheet.name + '!' + first.value,
          message: 'Merged cells cover stored content. Unmerge before export to retain it.',
        });
    }
    if (issues.length && a.allowLossy !== true)
      throw new AibError('CONVERSION_LOSS', 'Export needs --allow-lossy', issues);
  }
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.writeFile(target, result.buffer, { flag: 'wx' });
  return { file: path.resolve(target), issues };
}
