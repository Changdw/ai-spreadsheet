import { parseCellLiteral } from '../schema/literal';
import { parse } from 'csv-parse/sync';
import path from 'node:path';
import { AibError, newBook, validate, type Cell } from '../schema/index';

function decode(buffer: Buffer) {
  const sample = buffer.subarray(0, 256);
  let encoding = 'utf-8';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf-16le';
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf-16be';
  else if (sample.includes(0)) {
    // Some Windows exporters omit the UTF-16 BOM. Look for NUL bytes paired with ASCII.
    const pairs = [0, 0];
    sample.forEach((v, i) => {
      if (!v) pairs[i % 2]++;
    });
    if (Math.max(...pairs) > sample.length / 8)
      encoding = pairs[1] > pairs[0] ? 'utf-16le' : 'utf-16be';
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    if (encoding === 'utf-8' && !buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      try {
        return new TextDecoder('gb18030', { fatal: true }).decode(buffer);
      } catch {
        /* unknown encoding */
      }
    }
    throw new AibError('INVALID_TEXT', '无法识别表格文本编码，支持 UTF-8、UTF-16 和 GBK/GB18030');
  }
}

export function importTextTable(buffer: Buffer, file: string, csv = false) {
  const text = decode(buffer);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new AibError('INVALID_TEXT', '文件包含无法识别的二进制数据');
  const firstLine = text.split(/[\r\n]/, 1)[0];
  const delimiter = !csv && firstLine.includes('\t') ? '\t' : ',';
  if (!csv && (!firstLine.includes(delimiter) || /^\s*</.test(text)))
    throw new AibError('UNSUPPORTED_FORMAT', '无法识别为 Excel 工作簿或分隔文本表格');
  let footprint = 0;
  const data: Cell[][] = [];
  parse(text, {
    delimiter,
    bom: true,
    relax_column_count: true,
    max_record_size: 1024 * 1024,
    record_delimiter: ['\r\n', '\n', '\r'],
    on_record(row: string[]) {
      footprint += row.length;
      if (footprint > 2000000 || row.length > 16384 || data.length >= 1048576)
        throw new AibError('CAPACITY_EXCEEDED', '表格超过 AIB 容量限制');
      const values = csv ? row : row.map(parseCellLiteral);
      if (!csv) while (values.length && values.at(-1) === null) values.pop();
      data.push(values);
      return null;
    },
  });
  if (!csv) while (data.length && !data.at(-1)!.length) data.pop();
  const book = newBook(path.basename(file, path.extname(file)));
  const sheet = book.sheets[0];
  sheet.data = data;
  sheet.dimensions.rows = Math.max(100, data.length);
  sheet.dimensions.columns = data.reduce((max, row) => Math.max(max, row.length), 26);
  return { book: validate(book), issues: [] };
}
