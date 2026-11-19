import { Univer, LocaleType, type IWorkbookData } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import type { FormulaDataModel } from '@univerjs/engine-formula';
import { AibEngineGuardPlugin, assertScalarFormulas } from '../univer-adapter/guard-plugin';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort';
import sheetsEnUS from '@univerjs/sheets/locale/en-US';
import '@univerjs/sheets/facade';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-sort/facade';
import {
  AibError,
  address,
  range,
  validate,
  emptySheet,
  type Book,
  type Cell,
  type Sheet,
} from '../schema/index';
import {
  fromSnapshot,
  toSnapshot,
  expandSharedFormulas,
  isErrorCell,
} from '../univer-adapter/index';

import { checkMergedEdits } from '../schema/merges';
import { validateOperations } from './operations';
export { validateOperations, operationSchema, type Operation } from './operations';
export function getSheet(b: Book, name: string): Sheet {
  const s = b.sheets.find((s) => s.id === name) ?? b.sheets.find((s) => s.name === name);
  if (!s) throw new AibError('SHEET_NOT_FOUND', name);
  return s;
}
export function bounded(s: Sheet, a: string) {
  const r = range(a);
  if (
    r.endRow >= s.dimensions.rows ||
    r.endColumn >= s.dimensions.columns ||
    (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1) > 2000000
  )
    throw new AibError('OUT_OF_BOUNDS', a);
  return r;
}
function put(s: Sheet, r: number, c: number, v: Cell) {
  while (s.data.length <= r) s.data.push([]);
  while (s.data[r].length <= c) s.data[r].push(null);
  s.data[r][c] = v;
  const a = address(r, c);
  delete s.formulas[a];
  delete s.cellTypes[a];
}

/** A disposable engine: failed batches can never leak partial mutations to disk. */
export class Engine {
  private formulaModel?: FormulaDataModel;
  readonly univer: Univer;
  readonly api: FUniver;
  readonly workbook;
  constructor(readonly source: Book) {
    this.univer = new Univer({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: sheetsEnUS },
    });
    this.univer.registerPlugin(UniverFormulaEnginePlugin);
    this.univer.registerPlugin(UniverSheetsPlugin);
    this.univer.registerPlugin(UniverSheetsFormulaPlugin);
    this.univer.registerPlugin(UniverSheetsNumfmtPlugin);
    this.univer.registerPlugin(UniverSheetsSortPlugin);
    this.univer.registerPlugin(AibEngineGuardPlugin, {
      ready: (model: FormulaDataModel) => {
        this.formulaModel = model;
      },
    });
    this.api = FUniver.newAPI(this.univer);
    this.workbook = this.api.createWorkbook(toSnapshot(source));
  }
  async calculate() {
    if (!this.source.sheets.some((s) => Object.keys(s.formulas).length)) return;
    const done = this.api.getFormula().onCalculationResultApplied(15000);
    this.api.getFormula().executeCalculation();
    try {
      await done;
    } catch (e) {
      throw new AibError(
        'CALCULATION_TIMEOUT',
        'Formula calculation did not complete in 15 seconds',
        { cause: (e as Error).message },
      );
    }
  }
  snapshot(): IWorkbookData {
    assertScalarFormulas(this.formulaModel, this.source.id);
    return expandSharedFormulas(this.workbook.save(), (sheet, cell) =>
      this.workbook.getSheetBySheetId(sheet)!.getRange(cell).getFormula(),
    );
  }
  book(): Book {
    return fromSnapshot(this.snapshot(), this.source);
  }
  dispose() {
    this.univer.dispose();
  }
}

export async function applyOperations(input: Book, operations: unknown): Promise<Book> {
  validateOperations(operations);
  let b = structuredClone(validate(input));
  for (const op of operations) {
    if (op.type === 'replace') {
      if (op.book.id !== b.id)
        throw new AibError('IDENTITY_MISMATCH', 'Replacement must keep workbook id');
      b = structuredClone(validate(op.book));
      continue;
    }
    if (op.type === 'sheet.add') {
      b.sheets.push(emptySheet(op.id ?? crypto.randomUUID(), op.name));
      validate(b);
      continue;
    }
    const s = getSheet(b, op.sheet);
    if (op.type === 'set') {
      const r = bounded(s, op.range),
        width = op.values[0].length;
      if (op.values.some((row) => row.length !== width))
        throw new AibError('INVALID_OPERATION', 'Values must be rectangular');
      if (
        op.range.includes(':') &&
        (width !== r.endColumn - r.startColumn + 1 ||
          op.values.length !== r.endRow - r.startRow + 1)
      )
        throw new AibError('INVALID_OPERATION', 'Range and values dimensions differ');
      bounded(
        s,
        `${address(r.startRow, r.startColumn)}:${address(r.startRow + op.values.length - 1, r.startColumn + width - 1)}`,
      );
      op.values.forEach((row, i) =>
        row.forEach((v, j) => put(s, r.startRow + i, r.startColumn + j, v)),
      );
    } else if (op.type === 'formula') {
      const r = bounded(s, op.cell);
      if (op.cell.includes(':')) throw new AibError('INVALID_OPERATION', 'Formula needs a cell');
      put(s, r.startRow, r.startColumn, null);
      s.formulas[op.cell.toUpperCase()] = op.formula;
    } else if (op.type === 'clear') {
      const r = bounded(s, op.range);
      for (let i = r.startRow; i <= r.endRow; i++)
        for (let j = r.startColumn; j <= r.endColumn; j++) put(s, i, j, null);
    } else if (op.type === 'style') {
      bounded(s, op.range);
      s.styleRules.push({ range: op.range.toUpperCase(), style: op.style });
    } else if (op.type === 'freeze') {
      s.freeze = { rows: op.rows, columns: op.columns };
    } else if (op.type === 'filter') {
      s.filter = op.filter;
    } else if (op.type === 'replaceText') {
      s.data = s.data.map((row) =>
        row.map((v) => (typeof v === 'string' ? v.split(op.search).join(op.replacement) : v)),
      );
    } else if (op.type === 'sheet.move') {
      if (op.index >= b.sheets.length) throw new AibError('OUT_OF_BOUNDS', 'Sheet index');
      b.sheets.splice(b.sheets.indexOf(s), 1);
      b.sheets.splice(op.index, 0, s);
    } else {
      if (
        (op.type.includes('.insert') || op.type.includes('.delete')) &&
        b.sheets.some((s) => s.filter)
      )
        throw new AibError('FILTER_ACTIVE', 'Clear filters before structural edits');
      if (op.type === 'sheet.delete' && b.sheets.length === 1)
        throw new AibError('LAST_SHEET', 'Cannot delete the last sheet');
      if (op.type === 'sheet.rename')
        validate({
          ...b,
          sheets: b.sheets.map((x) => (x.id === s.id ? { ...x, name: op.name } : x)),
        });
      const e = new Engine(b);
      try {
        const ws = e.workbook.getSheetBySheetId(s.id)!;
        switch (op.type) {
          case 'sheet.rename':
            ws.setName(op.name);
            break;
          case 'sheet.delete':
            if (!e.workbook.deleteSheet(s.id)) throw new AibError('COMMAND_FAILED', op.type);
            break;
          case 'merge': {
            const r = bounded(s, op.range);
            for (let i = r.startRow; i <= r.endRow; i++)
              for (let j = r.startColumn; j <= r.endColumn; j++)
                if (
                  (i !== r.startRow || j !== r.startColumn) &&
                  ((s.data[i]?.[j] ?? null) !== null || s.formulas[address(i, j)])
                )
                  throw new AibError('MERGE_DATA_LOSS', 'Clear non-anchor cells before merging');
            ws.getRange(op.range).merge();
            break;
          }
          case 'unmerge':
            bounded(s, op.range);
            ws.getRange(op.range).breakApart();
            break;
          case 'sort': {
            const r = bounded(s, op.range);
            if (op.column > r.endColumn - r.startColumn)
              throw new AibError('OUT_OF_BOUNDS', 'Relative sort column');
            await e.calculate();
            ws.getRange(op.range).sort({ column: op.column, ascending: op.ascending });
            break;
          }
          case 'fill': {
            bounded(s, op.range);
            bounded(s, op.target);
            if (!(await ws.getRange(op.range).autoFill(ws.getRange(op.target))))
              throw new AibError('INVALID_OPERATION', 'Fill target must extend the source range');
            break;
          }
          case 'copy': {
            const r = bounded(s, op.range),
              t = bounded(s, op.target);
            if (op.target.includes(':'))
              throw new AibError('INVALID_OPERATION', 'Copy target must be a cell');
            const dest = `${op.target}:${address(t.startRow + r.endRow - r.startRow, t.startColumn + r.endColumn - r.startColumn)}`;
            const d = bounded(s, dest);
            if (
              s.merges.some((m) => {
                const x = range(m);
                return [r, d].some(
                  (y) =>
                    !(
                      x.endRow < y.startRow ||
                      x.startRow > y.endRow ||
                      x.endColumn < y.startColumn ||
                      x.startColumn > y.endColumn
                    ),
                );
              })
            )
              throw new AibError('MERGED_COPY', 'Unmerge source and destination before copying');
            const snap = e.snapshot(),
              source = snap.sheets[s.id].cellData;
            const values = Array.from({ length: r.endRow - r.startRow + 1 }, (_, i) =>
              Array.from({ length: r.endColumn - r.startColumn + 1 }, (_, j) => {
                const x = structuredClone(
                  source?.[r.startRow + i]?.[r.startColumn + j] ?? { v: null },
                );
                if (x.f) {
                  x.f = e.api
                    .getFormula()
                    .moveFormulaRefOffset(
                      x.f,
                      t.startColumn - r.startColumn,
                      t.startRow - r.startRow,
                    );
                  x.v = null;
                }
                if (typeof x.s === 'string') x.s = snap.styles[x.s];
                return { v: null, f: null, s: null, custom: null, ...x };
              }),
            );
            ws.getRange(dest).setValues(values);
            break;
          }
          default: {
            if (!('index' in op) || !('count' in op))
              throw new AibError('INVALID_OPERATION', op.type);
            const isRow = op.type.startsWith('rows.'),
              length = isRow ? s.dimensions.rows : s.dimensions.columns;
            if (
              op.index >= length ||
              (!op.type.endsWith('insert') && op.index + op.count > length) ||
              (op.type.endsWith('delete') && op.count >= length)
            )
              throw new AibError('OUT_OF_BOUNDS', 'Row/column operation');
            if (op.type === 'rows.insert') ws.insertRows(op.index, op.count);
            else if (op.type === 'rows.delete') ws.deleteRows(op.index, op.count);
            else if (op.type === 'columns.insert') ws.insertColumns(op.index, op.count);
            else if (op.type === 'columns.delete') ws.deleteColumns(op.index, op.count);
            else if (op.type === 'rows.meta' || op.type === 'columns.meta') {
              if (op.size !== undefined) {
                if (isRow) ws.setRowHeights(op.index, op.count, op.size);
                else ws.setColumnWidths(op.index, op.count, op.size);
              }
              if (op.hidden !== undefined) {
                if (isRow)
                  op.hidden ? ws.hideRows(op.index, op.count) : ws.showRows(op.index, op.count);
                else
                  op.hidden
                    ? ws.hideColumns(op.index, op.count)
                    : ws.showColumns(op.index, op.count);
              }
            }
          }
        }
        b = e.book();
      } finally {
        e.dispose();
      }
    }
    validate(b);
  }
  checkMergedEdits(input, b);
  if (b.sheets.some((s) => Object.keys(s.formulas).length)) await evaluate(b);
  return b;
}

export async function evaluate(b: Book) {
  const e = new Engine(b);
  try {
    await e.calculate();
    return e.snapshot();
  } finally {
    e.dispose();
  }
}
export async function readRange(b: Book, sheet: string, a: string, calculated = false) {
  return (await readRangeResult(b, sheet, a, calculated)).values;
}
export async function readRangeResult(b: Book, sheet: string, a: string, calculated = false) {
  const s = getSheet(b, sheet),
    r = bounded(s, a),
    snapshot = calculated ? await evaluate(b) : null;
  const errors: { cell: string; error: string }[] = [];
  const values = Array.from({ length: r.endRow - r.startRow + 1 }, (_, i) =>
    Array.from({ length: r.endColumn - r.startColumn + 1 }, (_, j) => {
      const row = r.startRow + i,
        col = r.startColumn + j;
      const cell = snapshot?.sheets[s.id].cellData?.[row]?.[col];
      if (isErrorCell(cell)) errors.push({ cell: address(row, col), error: String(cell!.v) });
      return snapshot
        ? s.formulas[address(row, col)]
          ? cell?.t === 3
            ? Boolean(cell.v)
            : (cell?.v ?? null)
          : (s.data[row]?.[col] ?? null)
        : (s.formulas[address(row, col)] ?? s.data[row]?.[col] ?? null);
    }),
  );
  return { values, errors };
}
export function diff(before: Book, after: Book) {
  const changes: { path: string; before: unknown; after: unknown }[] = [];
  const visit = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        visit(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
          `${path}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        );
    } else changes.push({ path, before: a ?? null, after: b ?? null });
  };
  // Sheets are compared by id so inserting a sheet doesn't shift every path.
  const left = fromSnapshot(toSnapshot(before), before),
    right = fromSnapshot(toSnapshot(after), after);
  visit(
    { ...left, sheets: Object.fromEntries(left.sheets.map((s) => [s.id, s])) },
    { ...right, sheets: Object.fromEntries(right.sheets.map((s) => [s.id, s])) },
    '',
  );
  if (before.sheets.map((s) => s.id).join() !== after.sheets.map((s) => s.id).join())
    changes.push({
      path: '/sheetOrder',
      before: before.sheets.map((s) => s.id),
      after: after.sheets.map((s) => s.id),
    });
  return changes;
}
