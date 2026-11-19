import { DateSystem, type IWorkbookData, type ICellData, type IStyleData } from '@univerjs/core';
import { ERROR_TYPE_SET } from '@univerjs/engine-formula';
const errorValues: ReadonlySet<string> = ERROR_TYPE_SET;
export const isErrorCell = (cell: ICellData | undefined | null) =>
  !!cell && cell.t !== 4 && typeof cell.v === 'string' && errorValues.has(cell.v);
import {
  address,
  coords,
  range,
  emptySheet,
  validate,
  AibError,
  type Book,
  type Style,
} from '../schema/index';

export function toStyle(s: Style): IStyleData {
  const x: IStyleData = {};
  if (s.bold !== undefined) x.bl = s.bold ? 1 : 0;
  if (s.italic !== undefined) x.it = s.italic ? 1 : 0;
  if (s.fontFamily !== undefined) x.ff = s.fontFamily;
  if (s.fontSize !== undefined) x.fs = s.fontSize;
  if (s.color) x.cl = { rgb: s.color };
  if (s.background) x.bg = { rgb: s.background };
  if (s.horizontal) x.ht = { left: 1, center: 2, right: 3 }[s.horizontal];
  if (s.vertical) x.vt = { top: 1, middle: 2, bottom: 3 }[s.vertical];
  if (s.numberFormat) x.n = { pattern: s.numberFormat };
  if (s.border) {
    const b = { s: { thin: 1, medium: 2, thick: 5 }[s.border.style], cl: { rgb: s.border.color } };
    x.bd = { t: b, b, l: b, r: b };
  }
  return x;
}
export function fromStyle(x: IStyleData): Style {
  const s: Style = {};
  const allowed = new Set(['bl', 'it', 'ff', 'fs', 'cl', 'bg', 'ht', 'vt', 'n', 'bd']);
  for (const [key, value] of Object.entries(x))
    if (!allowed.has(key) && value !== null && value !== undefined && value !== 0)
      throw new AibError('UNSUPPORTED_STYLE', `Unsupported style field: ${key}`);
  if (x.bl != null) s.bold = x.bl === 1;
  if (x.it != null) s.italic = x.it === 1;
  if (x.ff) s.fontFamily = x.ff;
  if (x.fs) s.fontSize = x.fs;
  if (x.cl?.rgb) s.color = x.cl.rgb;
  if (x.bg?.rgb) s.background = x.bg.rgb;
  if (x.ht && x.ht <= 3) s.horizontal = (['left', 'center', 'right'] as const)[x.ht - 1];
  if (x.vt && x.vt <= 3) s.vertical = (['top', 'middle', 'bottom'] as const)[x.vt - 1];
  if (x.n?.pattern) s.numberFormat = x.n.pattern;
  if (x.bd) {
    const b = x.bd.t;
    if (
      !b ||
      !['b', 'l', 'r'].every((k) => JSON.stringify(x.bd?.[k as 'b']) === JSON.stringify(b)) ||
      ![1, 2, 5].includes(b.s)
    )
      throw new AibError(
        'UNSUPPORTED_STYLE',
        'Only uniform thin/medium/thick borders are currently supported',
      );
    s.border = {
      color: b.cl.rgb ?? '#000000',
      style: b.s === 2 ? 'medium' : b.s === 5 ? 'thick' : 'thin',
    };
  }
  return s;
}
const day = 86400000;
export function dateSerial(v: string, system: '1900' | '1904'): number {
  const n =
    (Date.parse(v) -
      Date.UTC(
        system === '1900' ? 1899 : 1904,
        system === '1900' ? 11 : 0,
        system === '1900' ? 31 : 1,
      )) /
    day;
  return system === '1900' && n >= 60 ? n + 1 : n;
}
export function serialDate(v: number, system: '1900' | '1904'): string {
  if (system === '1900' && v >= 60 && v < 61)
    throw new AibError(
      'INVALID_DATE',
      'Excel fictitious 1900-02-29 cannot be represented as ISO date',
    );
  return new Date(
    Math.round((system === '1900' && v >= 61 ? v - 1 : v) * day) +
      Date.UTC(
        system === '1900' ? 1899 : 1904,
        system === '1900' ? 11 : 0,
        system === '1900' ? 31 : 1,
      ),
  ).toISOString();
}
export function toSnapshot(book: Book): IWorkbookData {
  validate(book);
  const sheets: IWorkbookData['sheets'] = {};
  for (const s of book.sheets) {
    const cells: Record<number, Record<number, ICellData>> = {};
    const cell = (r: number, c: number) => ((cells[r] ??= {})[c] ??= {});
    s.data.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v !== null) {
          cell(r, c).v = v;
          cell(r, c).t =
            typeof v === 'string' ? (errorValues.has(v) ? 4 : 1) : typeof v === 'boolean' ? 3 : 2;
        }
      }),
    );
    for (const [a, f] of Object.entries(s.formulas)) {
      const [r, c] = coords(a);
      cell(r, c).f = f;
    }
    for (const [a, t] of Object.entries(s.cellTypes)) {
      const [r, c] = coords(a);
      const x = cell(r, c);
      x.custom = { aibType: t };
      if (t === 'error') x.t = 1;
      else {
        x.v = dateSerial(String(x.v), book.dateSystem);
        x.t = 2;
        x.s = { n: { pattern: t === 'date' ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss' } };
      }
    }
    for (const rule of s.styleRules) {
      const rr = range(rule.range);
      if ((rr.endRow - rr.startRow + 1) * (rr.endColumn - rr.startColumn + 1) > 2000000)
        throw new AibError('CAPACITY_EXCEEDED', 'Style range too large');
      for (let r = rr.startRow; r <= rr.endRow; r++)
        for (let c = rr.startColumn; c <= rr.endColumn; c++) {
          const x = cell(r, c);
          x.s = { ...((x.s as IStyleData) ?? {}), ...toStyle(rule.style) };
        }
    }
    sheets[s.id] = {
      id: s.id,
      name: s.name,
      rowCount: s.dimensions.rows,
      columnCount: s.dimensions.columns,
      cellData: cells,
      mergeData: s.merges.map(range),
      freeze: {
        xSplit: s.freeze.columns,
        ySplit: s.freeze.rows,
        startColumn: s.freeze.columns ? s.freeze.columns : -1,
        startRow: s.freeze.rows ? s.freeze.rows : -1,
      },
      rowData: Object.fromEntries(
        Object.entries(s.rowMeta).map(([k, v]) => [
          k,
          {
            ...(v.size ? { h: v.size } : {}),
            ...(v.hidden !== undefined ? { hd: v.hidden ? 1 : 0 } : {}),
          },
        ]),
      ),
      columnData: Object.fromEntries(
        Object.entries(s.columnMeta).map(([k, v]) => [
          k,
          {
            ...(v.size ? { w: v.size } : {}),
            ...(v.hidden !== undefined ? { hd: v.hidden ? 1 : 0 } : {}),
          },
        ]),
      ),
    };
  }
  return {
    id: book.id,
    name: book.name,
    appVersion: '1.5.2',
    locale: 'zhCN' as IWorkbookData['locale'],
    styles: {},
    sheetOrder: book.sheets.map((s) => s.id),
    sheets,
    dateSystem: book.dateSystem === '1904' ? DateSystem.Date1904 : DateSystem.Date1900,
  };
}
export function fromSnapshot(
  snapshot: IWorkbookData,
  original: Omit<Book, 'sheets'> & { sheets?: Book['sheets'] },
): Book {
  let allocated = 0;
  if (!Array.isArray(snapshot.sheetOrder) || snapshot.sheetOrder.length > 100)
    throw new AibError('INVALID_SNAPSHOT', 'Invalid sheet list');
  if (snapshot.id !== original.id)
    throw new AibError('IDENTITY_MISMATCH', 'Snapshot workbook id differs');
  const safeResources = new Set([
    'SHEET_RANGE_PROTECTION_PLUGIN',
    'SHEET_AuthzIoMockService_PLUGIN',
    'SHEET_WORKSHEET_PROTECTION_PLUGIN',
    'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
    'SHEET_DEFINED_NAME_PLUGIN',
    'SHEET_RANGE_THEME_MODEL_PLUGIN',
  ]);
  for (const resource of snapshot.resources ?? [])
    if (
      !safeResources.has(resource.name) &&
      resource.data &&
      !['{}', '[]', 'null'].includes(resource.data)
    )
      throw new AibError('UNSUPPORTED_RESOURCE', resource.name);
  const sheets = snapshot.sheetOrder.map((id) => {
    const s = snapshot.sheets[id];
    if (s.hidden) throw new AibError('UNSUPPORTED_SHEET', 'Hidden worksheets are outside AIB v1');
    const out = emptySheet(id, s.name ?? id, s.rowCount ?? 100, s.columnCount ?? 26);
    out.filter = structuredClone(
      s.custom && Object.hasOwn(s.custom, 'aibFilter')
        ? (s.custom.aibFilter as typeof out.filter)
        : (original.sheets?.find((x) => x.id === id)?.filter ?? null),
    );
    for (const [rs, row] of Object.entries(s.cellData ?? {}))
      for (const [cs, x] of Object.entries(row as Record<string, ICellData>)) {
        if (!x) continue;
        const r = +rs,
          c = +cs,
          a = address(r, c);
        if (
          !Number.isInteger(r) ||
          !Number.isInteger(c) ||
          r < 0 ||
          c < 0 ||
          r >= out.dimensions.rows ||
          c >= out.dimensions.columns
        )
          throw new AibError('OUT_OF_BOUNDS', a);
        if (x.p || x.si)
          throw new AibError('UNSUPPORTED_CELL', `Rich text or unresolved shared formula at ${a}`);
        if (x.f) out.formulas[a] = x.f;
        let v = x.f ? null : (x.v ?? null);
        const t = x.custom?.aibType;
        if (!x.f && (t === 'date' || t === 'datetime') && typeof v === 'number') {
          out.cellTypes[a] = t;
          const iso = serialDate(v, original.dateSystem);
          v = t === 'date' ? iso.slice(0, 10) : iso;
        } else if (!x.f && isErrorCell(x) && v !== null) {
          out.cellTypes[a] = 'error';
          v = String(v);
        }
        if (x.t === 3 && !x.f && typeof v === 'number') v = Boolean(v);
        if (v !== null || x.f) {
          allocated += Math.max(0, c + 1 - (out.data[r]?.length ?? 0));
          if (allocated > 2000000)
            throw new AibError('CAPACITY_EXCEEDED', 'Snapshot exceeds 2,000,000 cells');
          while (out.data.length <= r) out.data.push([]);
          while (out.data[r].length <= c) out.data[r].push(null);
          out.data[r][c] = v;
        }
        const st = typeof x.s === 'string' ? snapshot.styles[x.s] : x.s;
        if (st) {
          const style = fromStyle(st);
          if (Object.keys(style).length) out.styleRules.push({ range: a, style });
        }
      }
    out.merges = (s.mergeData ?? []).map(
      (r) => `${address(r.startRow, r.startColumn)}:${address(r.endRow, r.endColumn)}`,
    );
    out.freeze = { rows: s.freeze?.ySplit ?? 0, columns: s.freeze?.xSplit ?? 0 };
    for (const [key, v] of Object.entries(s.rowData ?? {})) {
      if (v && (v.h || v.hd))
        out.rowMeta[key] = { ...(v.h ? { size: v.h } : {}), ...(v.hd ? { hidden: true } : {}) };
    }
    for (const [key, v] of Object.entries(s.columnData ?? {})) {
      if (v && (v.w || v.hd))
        out.columnMeta[key] = { ...(v.w ? { size: v.w } : {}), ...(v.hd ? { hidden: true } : {}) };
    }
    return out;
  });
  return validate({ ...original, name: snapshot.name, sheets });
}

/** Expand SDK shared-formula groups using its parser before writing the portable format. */
export function expandSharedFormulas(
  snapshot: IWorkbookData,
  lookup: (sheet: string, cell: string) => string,
): IWorkbookData {
  for (const id of snapshot.sheetOrder)
    for (const [r, row] of Object.entries(snapshot.sheets[id].cellData ?? {}))
      for (const [c, cell] of Object.entries(row as Record<string, ICellData>))
        if (cell?.si) {
          const formula = lookup(id, address(+r, +c));
          if (!formula) throw new AibError('UNRESOLVED_FORMULA', `${id}!${address(+r, +c)}`);
          cell.f = formula;
          delete cell.si;
        }
  return snapshot;
}

/** Filtering is view state; manually hidden rows remain independent in AIB. */
export function filteredRows(snapshot: IWorkbookData, book: Book): Record<string, number[]> {
  const hidden: Record<string, number[]> = {};
  for (const s of book.sheets)
    if (s.filter) {
      const r = range(s.filter.range);
      hidden[s.id] = [];
      for (let row = r.startRow + 1; row <= r.endRow; row++)
        if (
          s.filter.columns.some((c) => {
            const cell = snapshot.sheets[s.id].cellData?.[row]?.[c.column];
            const value = s.formulas[address(row, c.column)]
              ? cell?.t === 3
                ? Boolean(cell.v)
                : (cell?.v ?? null)
              : (s.data[row]?.[c.column] ?? null);
            return !c.values.includes(value);
          })
        )
          hidden[s.id].push(row);
    }
  return hidden;
}
