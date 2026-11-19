import { InterfaceError } from './diagnostics';
import {
  CommandType,
  ICommandService,
  IUndoRedoService,
  type Injector,
  type ICellData,
  type IStyleData,
  type IObjectMatrixPrimitiveType,
} from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';
import {
  INTERCEPTOR_POINT,
  SheetInterceptorService,
  SetRangeValuesCommand,
  SetStyleCommand,
} from '@univerjs/sheets';
import '@univerjs/sheets-sort/facade';
import type { Operation } from '../../packages/core/index';
import { address, range, type Sheet } from '../../packages/schema/index';
import { serialDate } from '../../packages/univer-adapter/index';

type Filter = Sheet['filter'];
const filterMutation = 'aib.mutation.filter';

/** All commands share the grid's undo stack, including AIB's portable value filter. */
export class LocalEdits {
  readonly history: IUndoRedoService;
  private readonly commands: ICommandService;
  constructor(
    private readonly api: FUniver,
    injector: Injector,
    private readonly dateSystem: () => '1900' | '1904',
  ) {
    this.commands = injector.get(ICommandService);
    this.history = injector.get(IUndoRedoService);
    this.commands.registerCommand({
      id: filterMutation,
      type: CommandType.MUTATION,
      handler: (_, raw) => {
        const params = raw as { unitId: string; subUnitId: string; filter: Filter };
        const wb = this.api.getActiveWorkbook();
        if (!params || wb?.id !== params.unitId) return false;
        const sheet = wb.getSheetBySheetId(params.subUnitId);
        if (!sheet) return false;
        sheet
          .getSheet()
          .setCustomMetadata({ ...sheet.getSheet().getCustomMetadata(), aibFilter: params.filter });
        sheet.refreshCanvas();
        return true;
      },
    });
    injector.get(SheetInterceptorService).intercept(INTERCEPTOR_POINT.ROW_FILTERED, {
      handler: (hidden, location, next) => {
        const f = location.worksheet.getCustomMetadata()?.aibFilter as Filter | undefined;
        if (f) {
          const bounds = range(f.range);
          if (
            location.row > bounds.startRow &&
            location.row <= bounds.endRow &&
            f.columns.some((c) => {
              const raw = location.worksheet.getCellRaw(location.row, c.column);
              return !c.values.includes(this.literal(raw));
            })
          )
            return true;
        }
        return next(hidden);
      },
    });
  }
  private literal(cell: ICellData | null | void) {
    if (cell?.t === 3) return Boolean(cell.v);
    const tag = cell?.custom?.aibType;
    if (!cell?.f && typeof cell?.v === 'number' && (tag === 'date' || tag === 'datetime')) {
      const iso = serialDate(cell.v, this.dateSystem());
      return tag === 'date' ? iso.slice(0, 10) : iso;
    }
    return cell?.v ?? null;
  }
  style(target: string, attrs: IStyleData) {
    const wb = this.api.getActiveWorkbook()!,
      ws = wb.getActiveSheet(),
      r = range(target);
    if ((r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1) > 2000000)
      throw new InterfaceError('selectionLimit');
    const group = this.history.beginUndoRedoGroup(wb.id, crypto.randomUUID());
    try {
      for (const [type, value] of Object.entries(attrs)) {
        // Explicit literal types keep strings like "00123" intact when applying a number format.
        if (type === 'n') {
          const matrix: IObjectMatrixPrimitiveType<ICellData> = {};
          for (let row = r.startRow; row <= r.endRow; row++) {
            const cells = (matrix[row] = {} as Record<number, ICellData>);
            for (let col = r.startColumn; col <= r.endColumn; col++) {
              const c = ws.getSheet().getCellRaw(row, col);
              cells[col] = {
                s: { n: attrs.n },
                ...(c && c.v != null && !c.f && !c.si ? { v: c.v, t: c.t } : {}),
              };
            }
          }
          this.command(SetRangeValuesCommand.id, {
            unitId: wb.id,
            subUnitId: ws.getSheetId(),
            range: r,
            value: matrix,
          });
        } else
          this.command(SetStyleCommand.id, {
            unitId: wb.id,
            subUnitId: ws.getSheetId(),
            range: r,
            style: { type, value },
          });
      }
    } finally {
      group.dispose();
    }
  }
  private command(id: string, params: Record<string, unknown>) {
    if (!this.api.syncExecuteCommand(id, params)) throw new InterfaceError('sheetActionFailed');
  }
  find(search: string, replacement?: string) {
    if (!search) throw new InterfaceError('enterSearch');
    const wb = this.api.getActiveWorkbook()!,
      ws = wb.getActiveSheet(),
      matches: string[] = [];
    let count = 0;
    const changes: IObjectMatrixPrimitiveType<ICellData> = {};
    ws.getSheet()
      .getCellMatrix()
      .forValue((row, col, cell) => {
        const value = this.literal(cell);
        if (!(cell?.f ?? String(value ?? '')).includes(search)) return;
        count++;
        if (matches.length < 20) matches.push(address(row, col));
        if (replacement !== undefined && cell && !cell.f && typeof cell.v === 'string') {
          (changes[row] ??= {})[col] = { v: cell.v.split(search).join(replacement), t: cell.t };
        }
      });
    if (Object.keys(changes).length)
      this.command(SetRangeValuesCommand.id, {
        unitId: wb.id,
        subUnitId: ws.getSheetId(),
        value: changes,
      });
    return { count, matches };
  }
  apply(op: Operation) {
    const wb = this.api.getActiveWorkbook()!,
      ws = wb.getActiveSheet();
    if ('sheet' in op && op.sheet !== ws.getSheetName()) throw new InterfaceError('sheetChanged');
    if (
      (op.type.endsWith('.insert') || op.type.endsWith('.delete')) &&
      wb.getSheets().some((s) => s.getSheet().getCustomMetadata()?.aibFilter)
    )
      throw new InterfaceError('clearFilter');
    const rows = ws.getMaxRows(),
      cols = ws.getMaxColumns();
    const bounds = (a: string) => {
      const r = range(a);
      if (r.endRow >= rows || r.endColumn >= cols) throw new InterfaceError('outOfRange');
      return r;
    };
    switch (op.type) {
      case 'freeze':
        if (
          !Number.isInteger(op.rows) ||
          !Number.isInteger(op.columns) ||
          op.rows < 0 ||
          op.columns < 0 ||
          op.rows > rows ||
          op.columns > cols
        )
          throw new InterfaceError('invalidFreeze');
        ws.setFreeze({
          xSplit: op.columns,
          ySplit: op.rows,
          startColumn: op.columns || -1,
          startRow: op.rows || -1,
        });
        break;
      case 'merge': {
        const r = bounds(op.range);
        for (let y = r.startRow; y <= r.endRow; y++)
          for (let x = r.startColumn; x <= r.endColumn; x++) {
            if (y === r.startRow && x === r.startColumn) continue;
            const c = ws.getSheet().getCellRaw(y, x);
            if (c?.v != null || c?.f) throw new InterfaceError('clearMerge');
          }
        ws.getRange(op.range).merge();
        break;
      }
      case 'unmerge':
        bounds(op.range);
        ws.getRange(op.range).breakApart();
        break;
      case 'sheet.add':
      case 'sheet.rename':
        if (!op.name.trim() || op.name.length > 31 || /[\[\]*?/\\:]/.test(op.name))
          throw new InterfaceError('invalidSheetName');
        if (
          wb
            .getSheets()
            .some(
              (s) =>
                (op.type === 'sheet.add' || s.getSheetId() !== ws.getSheetId()) &&
                s.getSheetName().toLowerCase() === op.name.toLowerCase(),
            )
        )
          throw new InterfaceError('duplicateSheet');
        if (op.type === 'sheet.add') {
          if (wb.getSheets().length >= 100) throw new InterfaceError('sheetLimit');
          wb.create(op.name, 100, 26);
        } else ws.setName(op.name);
        break;
      case 'sheet.delete':
        if (wb.getSheets().length === 1) throw new InterfaceError('keepSheet');
        wb.deleteSheet(ws);
        break;
      case 'sheet.move':
        if (!Number.isInteger(op.index) || op.index < 0 || op.index >= wb.getSheets().length)
          throw new InterfaceError('invalidPosition');
        wb.moveSheet(ws, op.index);
        break;
      case 'sort': {
        const r = bounds(op.range);
        if (
          !Number.isInteger(op.column) ||
          op.column < 0 ||
          op.column > r.endColumn - r.startColumn
        )
          throw new InterfaceError('sortOutOfRange');
        ws.getRange(op.range).sort({ column: op.column, ascending: op.ascending });
        break;
      }
      case 'filter': {
        if (op.filter) {
          const r = bounds(op.filter.range);
          for (const c of op.filter.columns)
            if (
              !Number.isInteger(c.column) ||
              c.column < r.startColumn ||
              c.column > r.endColumn ||
              !Array.isArray(c.values) ||
              !c.values.every(
                (v) => v === null || ['number', 'string', 'boolean'].includes(typeof v),
              )
            )
              throw new InterfaceError('invalidFilter');
        }
        const target = { unitId: wb.id, subUnitId: ws.getSheetId() };
        const undo = {
          id: filterMutation,
          params: { ...target, filter: ws.getSheet().getCustomMetadata()?.aibFilter ?? null },
        };
        const redo = { id: filterMutation, params: { ...target, filter: op.filter } };
        this.command(redo.id, redo.params);
        this.history.pushUndoRedo({ unitID: wb.id, undoMutations: [undo], redoMutations: [redo] });
        break;
      }
      case 'replaceText':
        this.find(op.search, op.replacement);
        break;
      default: {
        if (!('count' in op)) throw new InterfaceError('unsupportedEdit');
        const row = op.type.startsWith('rows.'),
          length = row ? rows : cols;
        if (
          !Number.isInteger(op.index) ||
          !Number.isInteger(op.count) ||
          op.index < 0 ||
          op.index >= length ||
          op.count < 1 ||
          (!op.type.endsWith('.insert') && op.index + op.count > length) ||
          (op.type.endsWith('.delete') && op.count >= length) ||
          (op.type.endsWith('.insert') && length + op.count > (row ? 1048576 : 16384))
        )
          throw new InterfaceError('rowColRange');
        if (op.type === 'rows.insert') ws.insertRows(op.index, op.count);
        else if (op.type === 'columns.insert') ws.insertColumns(op.index, op.count);
        else if (op.type === 'rows.delete') ws.deleteRows(op.index, op.count);
        else if (op.type === 'columns.delete') ws.deleteColumns(op.index, op.count);
        else if (op.type === 'rows.meta' || op.type === 'columns.meta') {
          if (op.size !== undefined) {
            if (!Number.isFinite(op.size) || op.size <= 0) throw new InterfaceError('positiveSize');
            row
              ? ws.setRowHeights(op.index, op.count, op.size)
              : ws.setColumnWidths(op.index, op.count, op.size);
          }
          if (op.hidden !== undefined) {
            if (row) op.hidden ? ws.hideRows(op.index, op.count) : ws.showRows(op.index, op.count);
            else
              op.hidden ? ws.hideColumns(op.index, op.count) : ws.showColumns(op.index, op.count);
          }
        }
      }
    }
  }
}
