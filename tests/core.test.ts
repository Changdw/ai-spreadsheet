import { describe, it, expect } from 'vitest';
import { newBook, validate, serialize, AibError } from '../packages/schema/index';
import { applyOperations, readRange } from '../packages/core/index';
import { toSnapshot, fromSnapshot, dateSerial, serialDate } from '../packages/univer-adapter/index';

describe('AIB and headless engine', () => {
  it('extends numeric series and mixed formula references through the fill batch operation', async () => {
    const b = newBook();
    b.sheets[0].data = [[2], [5]];
    b.sheets[0].formulas.B1 = '=A1+$A$1';
    const result = await applyOperations(b, [
      { type: 'fill', sheet: 'Sheet1', range: 'A1:A2', target: 'A1:A5' },
      { type: 'fill', sheet: 'Sheet1', range: 'B1', target: 'B1:B5' },
    ]);
    expect(result.sheets[0].data.map((row) => row[0])).toEqual([2, 5, 8, 11, 14]);
    expect(result.sheets[0].formulas.B5).toBe('=A5+$A$1');
  });
  it('fills dates backwards horizontally while retaining portable ISO date values', async () => {
    const b = newBook();
    b.sheets[0].data = [[null, null, '2026-11-18', '2026-11-19']];
    b.sheets[0].cellTypes = { C1: 'date', D1: 'date' };
    const result = await applyOperations(b, [
      { type: 'fill', sheet: 'Sheet1', range: 'C1:D1', target: 'A1:D1' },
    ]);
    expect(result.sheets[0].data[0]).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
    ]);
    expect(result.sheets[0].cellTypes.A1).toBe('date');
  });
  it('preserves literal types, escaping, dates and roundtrips JSON deterministically', () => {
    const b = newBook();
    b.sheets[0].data = [['001', 'a\nb', '="literal"', true, 1.2, null, '2026-11-17']];
    b.sheets[0].cellTypes.G1 = 'date';
    expect(serialize(JSON.parse(serialize(b)))).toBe(serialize(b));
    expect(fromSnapshot(toSnapshot(b), b).sheets[0].data).toEqual(b.sheets[0].data);
    expect(dateSerial('1900-01-01', '1900')).toBe(1);
    expect(dateSerial('1900-03-01', '1900')).toBe(61);
    expect(dateSerial('1904-01-01', '1904')).toBe(0);
    expect(() => serialDate(60, '1900')).toThrow();
  });
  it('rejects unsupported schema and formula/value conflicts', () => {
    const b = newBook();
    b.sheets[0].data = [[1]];
    b.sheets[0].formulas.A1 = '=1';
    expect(() => validate(b)).toThrow(AibError);
    expect(() => validate({ ...newBook(), formatVersion: 2 })).toThrow();
  });
  it('calculates, shifts cross-sheet references and copies mixed absolute references', async () => {
    const b = await applyOperations(newBook(), [
      {
        type: 'set',
        sheet: 'Sheet1',
        range: 'A1:B2',
        values: [
          [10, 20],
          [30, 40],
        ],
      },
      { type: 'formula', sheet: 'Sheet1', cell: 'C1', formula: '=SUM(A1:B2)' },
      { type: 'sheet.add', name: 'Summary' },
      { type: 'formula', sheet: 'Summary', cell: 'A1', formula: '=Sheet1!C1' },
      { type: 'rows.insert', sheet: 'Sheet1', index: 0, count: 1 },
      { type: 'formula', sheet: 'Sheet1', cell: 'D2', formula: '=$A2+B$2' },
      { type: 'copy', sheet: 'Sheet1', range: 'D2', target: 'E3' },
    ]);
    expect(await readRange(b, 'Summary', 'A1', true)).toEqual([[100]]);
    expect(b.sheets[0].formulas.C2).toBe('=SUM(A2:B3)');
    expect(b.sheets[0].formulas.E3).toBe('=$A3+C$2');
  });
  it('supports base formulas and reports formula errors as values', async () => {
    let b = newBook();
    b = await applyOperations(b, [
      { type: 'set', sheet: 'Sheet1', range: 'A1:A3', values: [[1], [2], [3]] },
      ...[
        '=AVERAGE(A1:A3)',
        '=MIN(A1:A3)',
        '=MAX(A1:A3)',
        '=COUNT(A1:A3)',
        '=IF(A1=1,7,8)',
        '=SUMIF(A1:A3,">1")',
        '=1/0',
      ].map((formula, i) => ({ type: 'formula', sheet: 'Sheet1', cell: `B${i + 1}`, formula })),
    ]);
    expect(await readRange(b, 'Sheet1', 'B1:B7', true)).toEqual([
      [2],
      [1],
      [3],
      [3],
      [7],
      [5],
      ['#DIV/0!'],
    ]);
  });
  it('preserves metadata through structure changes and rejects destructive merges', async () => {
    const b = await applyOperations(newBook(), [
      { type: 'style', sheet: 'Sheet1', range: 'A1', style: { bold: true, background: '#ff0000' } },
      { type: 'rows.meta', sheet: 'Sheet1', index: 1, count: 1, size: 40, hidden: true },
      { type: 'merge', sheet: 'Sheet1', range: 'B2:C2' },
      { type: 'rows.insert', sheet: 'Sheet1', index: 0, count: 1 },
    ]);
    expect(b.sheets[0].styleRules.find((x) => x.range === 'A2')?.style.bold).toBe(true);
    expect(b.sheets[0].merges).toContain('B3:C3');
    expect(b.sheets[0].rowMeta['2']).toEqual({ size: 40, hidden: true });
    await expect(
      applyOperations(b, [
        { type: 'set', sheet: 'Sheet1', range: 'D1:E1', values: [[1, 2]] },
        { type: 'merge', sheet: 'Sheet1', range: 'D1:E1' },
      ]),
    ).rejects.toThrow('Clear non-anchor');
  });
});
