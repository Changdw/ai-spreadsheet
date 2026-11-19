import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOperations, getSheet } from '../packages/core/index';
import { emptySheet, newBook, serialize } from '../packages/schema/index';
import { execute } from '../packages/service/index';
import { exportWorkbook } from '../packages/service/formats';
import { create, load, recoveryList, transact } from '../packages/storage/index';

let dir: string, file: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aib-integrity-')));
  file = path.join(dir, 'workbook.aib');
  vi.stubEnv('AIB_HOME', path.join(dir, 'state'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

it('checks the serialized UTF-8 limit before creating a file or committing a journal', async () => {
  const book = newBook();
  await create(file, book);
  const original = await fs.readFile(file);
  // This text fits in fewer than 35 million JS characters, but exceeds 100 MiB in UTF-8.
  const text = '表'.repeat(Math.ceil((100 * 1024 * 1024) / 3));
  book.sheets[0].data = [[text]];
  const target = path.join(dir, 'new.aib');
  await expect(create(target, book)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [[text]] }]),
  ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
  expect(await fs.readFile(file)).toEqual(original);
  expect(await recoveryList(file)).toEqual([]);
}, 20_000);

it('detects external edits arriving while the replacement workbook is staged', async () => {
  const book = newBook();
  const { hash } = await create(file, book);
  book.sheets[0].data = [['external change']];
  const externalText = serialize(book);
  const realOpen = fs.open.bind(fs);
  let externalSaved = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const temp = String(args[0]);
    if (
      path.dirname(temp) === path.dirname(file) &&
      path.basename(temp).startsWith('.workbook.aib.')
    ) {
      await fs.writeFile(file, externalText);
      externalSaved = true;
    }
    return handle;
  });
  await expect(
    transact(
      file,
      [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [['editor change']] }],
      hash,
    ),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(externalSaved).toBe(true);
  expect(await fs.readFile(file, 'utf8')).toBe(externalText);
});

it('rejects newly covered literals and formulas and keeps a prior workbook repairable', async () => {
  const book = newBook();
  const sheet = book.sheets[0];
  sheet.data = [['anchor']];
  sheet.merges = ['A1:B2'];
  for (const ops of [
    [{ type: 'set', sheet: sheet.id, range: 'B2', values: [['under merge']] }],
    [{ type: 'formula', sheet: sheet.id, cell: 'B2', formula: '=2' }],
  ])
    await expect(applyOperations(book, ops)).rejects.toMatchObject({ code: 'MERGE_DATA_LOSS' });
  const replacement = structuredClone(book);
  replacement.sheets[0].formulas.B2 = '=2';
  await expect(
    applyOperations(book, [{ type: 'replace', book: replacement }]),
  ).rejects.toMatchObject({ code: 'MERGE_DATA_LOSS' });
  sheet.data[0].push('legacy');
  await create(file, book);
  const old = (await load(file)).book;
  const edited = await applyOperations(old, [
    { type: 'set', sheet: sheet.id, range: 'C1', values: [['outside']] },
  ]);
  expect(edited.sheets[0].data[0][1]).toBe('legacy');
  const repaired = await applyOperations(edited, [
    { type: 'unmerge', sheet: sheet.id, range: 'A1:B2' },
  ]);
  expect(repaired.sheets[0].merges).toEqual([]);
  expect(repaired.sheets[0].data[0][1]).toBe('legacy');
  const cleared = await applyOperations(edited, [{ type: 'clear', sheet: sheet.id, range: 'B1' }]);
  expect(cleared.sheets[0].data[0][1]).toBeNull();
});

it('reports legacy covered data for visual exports and retains both literal values in CSV', async () => {
  const book = newBook();
  book.sheets[0].data = [['visible', 'legacy']];
  book.sheets[0].merges = ['A1:B1'];
  for (const ext of ['xlsx', 'xls', 'html']) {
    const target = path.join(dir, 'result.' + ext);
    await expect(exportWorkbook(book, { target })).rejects.toMatchObject({
      code: 'CONVERSION_LOSS',
      details: expect.arrayContaining([
        expect.objectContaining({ feature: 'merged-cell-content', location: 'Sheet1!B1' }),
      ]),
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const accepted = await exportWorkbook(book, { target, allowLossy: true });
    expect(accepted.issues).toContainEqual(
      expect.objectContaining({ feature: 'merged-cell-content' }),
    );
  }
  const csv = path.join(dir, 'result.csv');
  await exportWorkbook(book, { target: csv, sheet: 'Sheet1' });
  expect(await fs.readFile(csv, 'utf8')).toContain('visible,legacy');
});

it('targets stable sheet IDs across reordered sheets and filtered searches', async () => {
  const book = newBook();
  const first = book.sheets[0];
  first.name = 'second-id';
  first.data = [['match: first']];
  const other = emptySheet('second-id', 'Other');
  other.data = [['match: second']];
  book.sheets.push(other);
  for (const order of [
    [first, other],
    [other, first],
  ]) {
    book.sheets = order;
    expect(getSheet(book, 'second-id')).toBe(other);
    expect(getSheet(book, first.id)).toBe(first);
    const edited = await applyOperations(book, [
      { type: 'set', sheet: 'second-id', range: 'B1', values: [[3]] },
    ]);
    expect(getSheet(edited, 'Other').data[0][1]).toBe(3);
    expect(getSheet(edited, first.id).data[0]).toEqual(first.data[0]);
  }
  await create(file, book);
  const found = await execute({
    command: 'find',
    file,
    args: { sheet: 'second-id', text: 'match' },
  });
  expect(found).toEqual({ matches: [{ sheet: 'Other', cell: 'A1', value: 'match: second' }] });
});
