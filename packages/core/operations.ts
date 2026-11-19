import Ajv from 'ajv';
import { AibError, type Cell, type Style, type Sheet, type Book } from '../schema/index';
export type Operation =
  | { type: 'set'; sheet: string; range: string; values: Cell[][] }
  | { type: 'formula'; sheet: string; cell: string; formula: string }
  | { type: 'clear' | 'merge' | 'unmerge'; sheet: string; range: string }
  | { type: 'style'; sheet: string; range: string; style: Style }
  | { type: 'freeze'; sheet: string; rows: number; columns: number }
  | {
      type: 'rows.insert' | 'rows.delete' | 'columns.insert' | 'columns.delete';
      sheet: string;
      index: number;
      count: number;
    }
  | {
      type: 'rows.meta' | 'columns.meta';
      sheet: string;
      index: number;
      count: number;
      size?: number;
      hidden?: boolean;
    }
  | { type: 'sheet.add'; name: string; id?: string }
  | { type: 'sheet.delete'; sheet: string }
  | { type: 'sheet.rename'; sheet: string; name: string }
  | { type: 'sheet.move'; sheet: string; index: number }
  | { type: 'sort'; sheet: string; range: string; column: number; ascending: boolean }
  | { type: 'filter'; sheet: string; filter: Sheet['filter'] }
  | { type: 'copy' | 'fill'; sheet: string; range: string; target: string }
  | { type: 'replaceText'; sheet: string; search: string; replacement: string }
  | { type: 'replace'; book: Book };

const st = { type: 'string', minLength: 1 },
  ix = { type: 'integer', minimum: 0 },
  count = { type: 'integer', minimum: 1 };
const fields: Record<Operation['type'], Record<string, unknown>> = {
  set: {
    sheet: st,
    range: st,
    values: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'array',
        minItems: 1,
        items: { type: ['string', 'number', 'boolean', 'null'] },
      },
    },
  },
  formula: { sheet: st, cell: st, formula: { type: 'string', pattern: '^=' } },
  clear: { sheet: st, range: st },
  merge: { sheet: st, range: st },
  unmerge: { sheet: st, range: st },
  style: { sheet: st, range: st, style: { type: 'object' } },
  freeze: { sheet: st, rows: ix, columns: ix },
  'rows.insert': { sheet: st, index: ix, count },
  'rows.delete': { sheet: st, index: ix, count },
  'columns.insert': { sheet: st, index: ix, count },
  'columns.delete': { sheet: st, index: ix, count },
  'rows.meta': {
    sheet: st,
    index: ix,
    count,
    size: { type: 'number', exclusiveMinimum: 0 },
    hidden: { type: 'boolean' },
  },
  'columns.meta': {
    sheet: st,
    index: ix,
    count,
    size: { type: 'number', exclusiveMinimum: 0 },
    hidden: { type: 'boolean' },
  },
  'sheet.add': { name: st, id: st },
  'sheet.delete': { sheet: st },
  'sheet.rename': { sheet: st, name: st },
  'sheet.move': { sheet: st, index: ix },
  sort: { sheet: st, range: st, column: ix, ascending: { type: 'boolean' } },
  filter: { sheet: st, filter: { type: ['object', 'null'] } },
  copy: { sheet: st, range: st, target: st },
  fill: { sheet: st, range: st, target: st },
  replaceText: { sheet: st, search: st, replacement: { type: 'string' } },
  replace: { book: { type: 'object' } },
};
export const operationSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 1000,
  items: {
    oneOf: Object.entries(fields).map(([type, properties]) => ({
      type: 'object',
      additionalProperties: false,
      properties: { type: { const: type }, ...properties },
      required: [
        'type',
        ...Object.keys(properties).filter((k) => !['id', 'size', 'hidden'].includes(k)),
      ],
    })),
  },
};
const checkOps = new Ajv({ allowUnionTypes: true }).compile(operationSchema);
export function validateOperations(ops: unknown): asserts ops is Operation[] {
  if (!checkOps(ops))
    throw new AibError('INVALID_OPERATION', 'Invalid operation batch', checkOps.errors);
}
