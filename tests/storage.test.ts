import { it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  create,
  load,
  transact,
  travel,
  draft,
  applyDraft,
  recoveryList,
} from '../packages/storage/index';
import { newBook, validate, type Book } from '../packages/schema/index';
import { execute } from '../packages/service/index';
import { applyOperations } from '../packages/core/index';
let dir: string, file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aib-test-'));
  file = path.join(dir, '中文 space.aib');
  process.env.AIB_HOME = path.join(dir, 'state');
  await create(file, newBook());
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.AIB_HOME;
});
const set = (value: number) => [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [[value]] }];
it('exports a runnable AI example and only the requested workbook metadata', async () => {
  const sample = (await execute({ command: 'context' })) as {
    example: Book;
    exampleOperations: unknown;
  };
  expect(sample).not.toHaveProperty('workbookMetadata');
  expect(
    (await applyOperations(validate(sample.example), sample.exampleOperations)).sheets[0]
      .data[1][0],
  ).toBe(120);
  const revision = await transact(file, [
    { type: 'set', sheet: 'Sheet1', range: 'A1', values: [['private-cell-27']] },
  ]);
  const context = await execute({ command: 'context', file });
  expect(context).toMatchObject({
    workbookMetadata: {
      id: revision.book.id,
      hash: revision.hash,
      sheets: [{ id: 'sheet1', name: 'Sheet1', dimensions: { rows: 100, columns: 26 } }],
    },
  });
  expect(JSON.stringify(context)).not.toContain('private-cell-27');
});
it('rejects stale revisions, rolls back failed batches and supports undo/redo', async () => {
  const before = await load(file);
  await transact(file, set(3), before.hash);
  await expect(transact(file, set(4), before.hash)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(
    transact(file, [...set(5), { type: 'sheet.delete', sheet: 'Sheet1' }]),
  ).rejects.toMatchObject({ code: 'LAST_SHEET' });
  expect((await load(file)).book.sheets[0].data).toEqual([[3]]);
  await travel(file, 'undo');
  expect((await load(file)).book.sheets[0].data).toEqual([]);
  await travel(file, 'redo');
  expect((await load(file)).book.sheets[0].data).toEqual([[3]]);
  expect((await recoveryList(file)).length).toBe(3);
});
it('only one concurrent CAS writer commits', async () => {
  const before = await load(file);
  const results = await Promise.allSettled([
    transact(file, set(1), before.hash),
    transact(file, set(2), before.hash),
  ]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
});
it('draft is isolated and refuses apply after an external text edit', async () => {
  const d = await draft(file, set(9));
  expect((await load(file)).book.sheets[0].data).toEqual([]);
  await fs.appendFile(file, '\n');
  await expect(applyDraft(d.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  const d2 = await draft(file, set(8));
  await applyDraft(d2.id);
  expect((await load(file)).book.sheets[0].data).toEqual([[8]]);
});
