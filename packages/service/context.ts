import { emptySheet, schema, type Book } from '../schema/index';
import { operationSchema } from '../core/operations';
import { load } from '../storage/index';

export function schemas() {
  return { workbook: schema, operations: operationSchema };
}
export function capabilities() {
  return {
    format: 'aib',
    formatVersion: 1,
    operations: operationSchema.items.oneOf.map((x) => x.properties.type.const),
    importFormats: ['xlsx', 'xls', 'csv', 'aib'],
    exportFormats: ['xlsx', 'xls', 'csv', 'html'],
    commands: [
      'new',
      'inspect',
      'validate',
      'read',
      'fill',
      'batch',
      'snapshot',
      'undo',
      'redo',
      'draft',
      'diff',
      'apply',
      'import',
      'export',
      'recovery',
      'recover',
      'schema',
      'context',
      'export-guide',
      'capabilities',
      'open',
      'serve',
      'save-as',
      'revision',
      'draft-edit',
      'draft-validate',
      'draft-discard',
      'compare',
      'status',
      'stop',
      'find',
      'stats',
    ],
    limits: {
      fileMiB: 100,
      combinedDataFormulaStyleCells: 2000000,
      batchOperations: 1000,
      history: 50,
      formulaCells: 100000,
      recoverySnapshots: 50,
    },
    unsupported: [
      'charts',
      'pivots',
      'macros',
      'rich-text',
      'conditional-formatting',
      'data-validation',
      'nonuniform-borders',
      'spilling-array-formulas',
    ],
    filter: 'Value equality; clear before structural edits',
    csv: 'All imported fields are literal strings; export strips workbook metadata',
  };
}
export async function workbookContext(file?: string) {
  const sheet = emptySheet('sales', '销售', 100, 26);
  sheet.data = [
    ['金额', '含税金额', '日期'],
    [100, null, '2026-01-15'],
  ];
  sheet.formulas.B2 = '=A2*1.13';
  sheet.cellTypes.C2 = 'date';
  const example: Book = {
    format: 'aib',
    formatVersion: 1,
    id: 'sales-example',
    name: '销售示例',
    dateSystem: '1900',
    sheets: [sheet],
  };
  const target = file ? await load(file) : null;
  return {
    format: 'aib',
    formatVersion: 1,
    encoding: 'UTF-8 JSON',
    semantics: [
      'The CLI reads and writes the saved file. The web editor batches committed edits for autosave or saves immediately on request. After an external edit, use Sync in the web editor to read the new disk revision.',
      'Preserve workbook and sheet IDs when editing. Array order determines sheet order. Sheet names are unique ignoring case.',
      'data is a row-major, zero-based array of JSON literals. Short rows and omitted trailing rows are empty within dimensions. Keep leading-zero identifiers as strings.',
      'formulas, cellTypes and styleRules use A1 addresses. Formulas start with = and their data slot must be null or absent. Read computed results with aib read --calculated.',
      'Dates are YYYY-MM-DD strings; datetimes are UTC ISO strings ending in Z. Tag these addresses in cellTypes. Preserve dateSystem (1900 or 1904).',
      'Style rules apply in array order; later properties take precedence. Number formats change display. rowMeta, columnMeta and filter column indices are zero-based.',
      'Preserve workbook metadata outside the requested edit. Validate with aib validate; the CLI also checks bounds, formula/value conflicts and overlapping merges.',
    ],
    schemas: schemas(),
    capabilities: capabilities(),
    example,
    exampleOperations: [{ type: 'set', sheet: '销售', range: 'A2', values: [[120]] }],
    ...(target && {
      workbookMetadata: {
        id: target.book.id,
        name: target.book.name,
        hash: target.hash,
        dateSystem: target.book.dateSystem,
        sheets: target.book.sheets.map(({ id, name, dimensions }) => ({ id, name, dimensions })),
      },
    }),
  };
}
