import check from './validator.js';

export type Cell = string | number | boolean | null;
export interface Style {
  bold?: boolean;
  italic?: boolean;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  background?: string;
  horizontal?: 'left' | 'center' | 'right';
  vertical?: 'top' | 'middle' | 'bottom';
  numberFormat?: string;
  border?: { color: string; style: 'thin' | 'medium' | 'thick' };
}
export interface Sheet {
  id: string;
  name: string;
  dimensions: { rows: number; columns: number };
  data: Cell[][];
  formulas: Record<string, string>;
  cellTypes: Record<string, 'date' | 'datetime' | 'error'>;
  styleRules: { range: string; style: Style }[];
  merges: string[];
  freeze: { rows: number; columns: number };
  rowMeta: Record<string, { size?: number; hidden?: boolean }>;
  columnMeta: Record<string, { size?: number; hidden?: boolean }>;
  filter: { range: string; columns: { column: number; values: Cell[] }[] } | null;
}
export interface Book {
  format: 'aib';
  formatVersion: 1;
  id: string;
  name: string;
  dateSystem: '1900' | '1904';
  sheets: Sheet[];
}
export class AibError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AibError';
  }
}
const text = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const addressPattern = '^[A-Z]+[1-9][0-9]*$';
const addressMap = (value: unknown) => ({
  type: 'object',
  patternProperties: { [addressPattern]: value },
  additionalProperties: false,
});
const dimensionMeta = {
  type: 'object',
  patternProperties: {
    '^[0-9]+$': object(
      { size: { type: 'number', exclusiveMinimum: 0 }, hidden: { type: 'boolean' } },
      [],
    ),
  },
  additionalProperties: false,
};
const styleSchema = object(
  {
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    fontFamily: text,
    fontSize: { type: 'number', minimum: 1, maximum: 400 },
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    background: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    horizontal: { enum: ['left', 'center', 'right'] },
    vertical: { enum: ['top', 'middle', 'bottom'] },
    numberFormat: text,
    border: object({
      color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      style: { enum: ['thin', 'medium', 'thick'] },
    }),
  },
  [],
);
export const schema = {
  $id: 'urn:aib:workbook:1',
  ...object({
    format: { const: 'aib' },
    formatVersion: { const: 1 },
    id: { type: 'string', minLength: 1 },
    name: text,
    dateSystem: { enum: ['1900', '1904'] },
    sheets: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: object({
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 31, pattern: '^[^\\[\\]\\*?/\\\\:]+$' },
        dimensions: object({
          rows: { type: 'integer', minimum: 1, maximum: 1048576 },
          columns: { type: 'integer', minimum: 1, maximum: 16384 },
        }),
        data: {
          type: 'array',
          items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
        },
        formulas: addressMap({ type: 'string', pattern: '^=' }),
        cellTypes: addressMap({ enum: ['date', 'datetime', 'error'] }),
        styleRules: { type: 'array', items: object({ range: text, style: styleSchema }) },
        merges: { type: 'array', items: text },
        freeze: object({ rows: integer, columns: integer }),
        rowMeta: dimensionMeta,
        columnMeta: dimensionMeta,
        filter: {
          anyOf: [
            { type: 'null' },
            object({
              range: text,
              columns: {
                type: 'array',
                items: object({
                  column: integer,
                  values: {
                    type: 'array',
                    items: { type: ['string', 'number', 'boolean', 'null'] },
                  },
                }),
              },
            }),
          ],
        },
      }),
    },
  }),
};
export function address(row: number, column: number): string {
  let n = column + 1,
    name = '';
  while (n > 0) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name + (row + 1);
}
export function coords(a: string): [number, number] {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(a);
  if (!match) throw new AibError('INVALID_RANGE', `Invalid cell address: ${a}`);
  let col = 0;
  for (const c of match[1]) col = col * 26 + c.charCodeAt(0) - 64;
  return [Number(match[2]) - 1, col - 1];
}
export function range(a: string) {
  const parts = a.toUpperCase().split(':');
  if (parts.length > 2) throw new AibError('INVALID_RANGE', a);
  const [startRow, startColumn] = coords(parts[0]);
  const [endRow, endColumn] = coords(parts[1] ?? parts[0]);
  if (endRow < startRow || endColumn < startColumn) throw new AibError('INVALID_RANGE', a);
  return { startRow, startColumn, endRow, endColumn };
}
export function validate(value: unknown): Book {
  if (!check(value)) throw new AibError('INVALID_AIB', 'Invalid AIB v1 document', check.errors);
  const b = value as unknown as Book,
    ids = new Set<string>(),
    names = new Set<string>();
  let cells = 0,
    formulas = 0;
  for (const s of b.sheets) {
    if (ids.has(s.id) || names.has(s.name.toLowerCase()))
      throw new AibError('DUPLICATE_SHEET', s.name);
    if (['__proto__', 'constructor', 'prototype'].includes(s.id))
      throw new AibError('INVALID_AIB', 'Reserved sheet id');
    ids.add(s.id);
    names.add(s.name.toLowerCase());
    if (
      s.data.length > s.dimensions.rows ||
      s.freeze.rows > s.dimensions.rows ||
      s.freeze.columns > s.dimensions.columns
    )
      throw new AibError('OUT_OF_BOUNDS', s.name);
    for (const row of s.data) {
      if (row.length > s.dimensions.columns) throw new AibError('OUT_OF_BOUNDS', s.name);
      cells += row.length;
    }
    if (cells > 2000000) throw new AibError('CAPACITY_EXCEEDED', 'Maximum 2,000,000 stored cells');
    const bounded = (a: string) => {
      const r = range(a);
      if (r.endRow >= s.dimensions.rows || r.endColumn >= s.dimensions.columns)
        throw new AibError('OUT_OF_BOUNDS', `${s.name}!${a}`);
      return r;
    };
    for (const a of Object.keys(s.formulas)) {
      bounded(a);
      const [r, c] = coords(a);
      if ((s.data[r]?.[c] ?? null) !== null)
        throw new AibError('FORMULA_VALUE_CONFLICT', `${s.name}!${a}`);
    }
    for (const [a, t] of Object.entries(s.cellTypes)) {
      bounded(a);
      const [r, c] = coords(a);
      const v = s.data[r]?.[c];
      if (s.formulas[a] || typeof v !== 'string') throw new AibError('INVALID_CELL_TYPE', a);
      if (t !== 'error') {
        const pattern =
          t === 'date' ? /^\d{4}-\d\d-\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
        if (
          !pattern.test(v) ||
          !Number.isFinite(Date.parse(v)) ||
          new Date(v).toISOString().slice(0, 10) !== v.slice(0, 10)
        )
          throw new AibError('INVALID_DATE', a);
      }
    }
    for (const x of s.styleRules) {
      const r = bounded(x.range);
      cells += (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1);
    }
    cells += Object.keys(s.formulas).length;
    formulas += Object.keys(s.formulas).length;
    if (formulas > 100000)
      throw new AibError('CAPACITY_EXCEEDED', 'Maximum 100,000 formula cells per workbook');
    if (cells > 2000000)
      throw new AibError(
        'CAPACITY_EXCEEDED',
        'Combined value, formula and style footprint exceeds 2,000,000 cells',
      );
    if (s.filter) {
      const f = bounded(s.filter.range);
      for (const c of s.filter.columns)
        if (c.column < f.startColumn || c.column > f.endColumn)
          throw new AibError('INVALID_FILTER', 'Filter columns are absolute zero-based indexes');
    }
    const merges = s.merges.map(bounded);
    for (let i = 0; i < merges.length; i++)
      for (let j = i + 1; j < merges.length; j++) {
        const a = merges[i],
          c = merges[j];
        if (!(
          a.endRow < c.startRow ||
          a.startRow > c.endRow ||
          a.endColumn < c.startColumn ||
          a.startColumn > c.endColumn
        ))
          throw new AibError('OVERLAPPING_MERGES', s.name);
      }
    for (const [key] of Object.entries(s.rowMeta))
      if (+key >= s.dimensions.rows) throw new AibError('OUT_OF_BOUNDS', `row ${key}`);
    for (const [key] of Object.entries(s.columnMeta))
      if (+key >= s.dimensions.columns) throw new AibError('OUT_OF_BOUNDS', `column ${key}`);
  }
  return b;
}
export function emptySheet(id = 'sheet1', name = 'Sheet1', rows = 100, columns = 26): Sheet {
  return {
    id,
    name,
    dimensions: { rows, columns },
    data: [],
    formulas: {},
    cellTypes: {},
    styleRules: [],
    merges: [],
    freeze: { rows: 0, columns: 0 },
    rowMeta: {},
    columnMeta: {},
    filter: null,
  };
}
export function newBook(name = '工作簿'): Book {
  return {
    format: 'aib',
    formatVersion: 1,
    id: crypto.randomUUID(),
    name,
    dateSystem: '1900',
    sheets: [emptySheet()],
  };
}
export function serialize(b: Book): string {
  validate(b);
  // A row stays on one physical line; JSON escaping handles multiline cell text.
  const marker = `__AIB_ROWS_${crypto.randomUUID()}__`;
  const copy = { ...b, sheets: b.sheets.map((s, i) => ({ ...s, data: marker + i })) };
  let result = JSON.stringify(copy, null, 2);
  b.sheets.forEach((s, i) => {
    result = result.replace(JSON.stringify(marker + i), () =>
      s.data.length
        ? '[\n' + s.data.map((row) => '        ' + JSON.stringify(row)).join(',\n') + '\n      ]'
        : '[]',
    );
  });
  return result + '\n';
}
