import { it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { newBook, validate } from '../packages/schema/index';
import { applyOperations, readRangeResult, evaluate } from '../packages/core/index';
import { filteredRows } from '../packages/univer-adapter/index';
import { create, load, transact, recover, recoveryList, hash } from '../packages/storage/index';
afterEach(() => vi.restoreAllMocks());
it('sorts rows and persists a value filter independently of manually hidden rows', async () => {
  const b = await applyOperations(newBook(), [
    {
      type: 'set',
      sheet: 'Sheet1',
      range: 'A1:B4',
      values: [
        ['Name', 'Amount'],
        ['C', 3],
        ['A', 1],
        ['B', 2],
      ],
    },
    { type: 'sort', sheet: 'Sheet1', range: 'A2:B4', column: 0, ascending: true },
    {
      type: 'filter',
      sheet: 'Sheet1',
      filter: { range: 'A1:B4', columns: [{ column: 0, values: ['B'] }] },
    },
  ]);
  expect(b.sheets[0].data).toEqual([
    ['Name', 'Amount'],
    ['A', 1],
    ['B', 2],
    ['C', 3],
  ]);
  expect(filteredRows(await evaluate(b), b).sheet1).toEqual([1, 3]);
  await expect(
    applyOperations(b, [{ type: 'rows.insert', sheet: 'Sheet1', index: 0, count: 1 }]),
  ).rejects.toMatchObject({ code: 'FILTER_ACTIVE' });
});
it('reports formula errors explicitly and rejects invalid calendar dates', async () => {
  const b = await applyOperations(newBook(), [
    { type: 'formula', sheet: 'Sheet1', cell: 'A1', formula: '=1/0' },
  ]);
  expect((await readRangeResult(b, 'Sheet1', 'A1', true)).errors).toEqual([
    { cell: 'A1', error: '#DIV/0!' },
  ]);
  b.sheets[0].data = [['2026-02-30']];
  b.sheets[0].formulas = {};
  b.sheets[0].cellTypes.A1 = 'date';
  expect(() => validate(b)).toThrow('A1');
});
it('keeps booleans and ISO dates in calculated reads and value filters', async () => {
  const b = newBook();
  b.sheets[0].data = [
    ['Flag', 'Date', 'Computed'],
    [true, '2026-11-17', null],
    [false, '2026-11-18', null],
  ];
  b.sheets[0].cellTypes = { B2: 'date', B3: 'date' };
  b.sheets[0].formulas = { C2: '=A2', C3: '=A3' };
  b.sheets[0].filter = {
    range: 'A1:C3',
    columns: [
      { column: 2, values: [true] },
      { column: 1, values: ['2026-11-17'] },
    ],
  };
  validate(b);
  expect((await readRangeResult(b, 'Sheet1', 'A2:C3', true)).values).toEqual([
    [true, '2026-11-17', true],
    [false, '2026-11-18', false],
  ]);
  expect(filteredRows(await evaluate(b), b).sheet1).toEqual([2]);
});
it('distinguishes error-looking strings and refuses spilling formula caches', async () => {
  const b = await applyOperations(newBook(), [
    { type: 'set', sheet: 'Sheet1', range: 'A1', values: [['#DIV/0!']] },
    { type: 'formula', sheet: 'Sheet1', cell: 'B1', formula: '=A1' },
    { type: 'formula', sheet: 'Sheet1', cell: 'C1', formula: '=SUM(A1)' },
  ]);
  const r = await readRangeResult(b, 'Sheet1', 'A1:C1', true);
  expect(r.values).toEqual([['#DIV/0!', '#DIV/0!', 0]]);
  expect(r.errors).toEqual([]);
  await expect(
    applyOperations(newBook(), [
      { type: 'formula', sheet: 'Sheet1', cell: 'A1', formula: '=SEQUENCE(2,2)' },
    ]),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_ARRAY' });
});
it('keeps the original intact when the final rename fails, then recovers corrupted JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aib-recovery-')),
    file = path.join(dir, 'a.aib');
  process.env.AIB_HOME = path.join(dir, 'state');
  try {
    await create(file, newBook());
    const before = await fs.readFile(file, 'utf8'),
      rename = fs.rename.bind(fs),
      real = await fs.realpath(file);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).toLowerCase() === real.toLowerCase())
        throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
      return rename(from, to);
    });
    await expect(
      transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [[7]] }]),
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    spy.mockRestore();
    await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [[7]] }]);
    const records = await recoveryList(file);
    await fs.writeFile(file, '{broken');
    await recover(file, records[0].id, hash('{broken'));
    expect((await load(file)).book.sheets[0].data).toEqual([]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    delete process.env.AIB_HOME;
  }
});
