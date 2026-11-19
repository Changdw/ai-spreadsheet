import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../../apps/server/index';
import { create, load, transact } from '../../packages/storage/index';
import { newBook } from '../../packages/schema/index';
const exec = promisify(execFile);
let dir: string, file: string, server: Awaited<ReturnType<typeof startServer>>, url: string;
test.beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aib-browser-')));
  process.env.AIB_HOME = path.join(dir, 'state');
  file = path.join(dir, '测试 空格.aib');
  await create(file, newBook('浏览器测试'));
  server = await startServer(0, path.resolve('dist/web'));
  const base = `http://127.0.0.1:${server.info.port}`;
  const response = (await fetch(base + '/api/open', {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  }).then((x) => x.json())) as { data: { id: string } };
  url = `${base}/?book=${response.data.id}#token=${server.info.token}`;
});
test.afterEach(async ({ context }) => {
  await context.close();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.AIB_HOME;
});
async function saveEdits(page: Page) {
  await page.locator('#save').click();
  await expect(page.locator('#status')).toHaveText('已保存');
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('browser and CLI share values, formulas, styles, undo and external reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  await page.getByLabel('单元格内容或公式').fill('12');
  await page.getByLabel('单元格内容或公式').press('Enter');
  expect((await load(file)).book.sheets[0].data[0]?.[0]).toBeUndefined();
  await page.getByLabel('单元格地址').fill('B1');
  await page.getByLabel('单元格地址').press('Enter');
  await page.getByLabel('单元格内容或公式').fill('=A1*2');
  await page.getByLabel('单元格内容或公式').press('Enter');
  await saveEdits(page);
  await expect.poll(async () => (await load(file)).book.sheets[0].formulas.B1).toBe('=A1*2');
  const read = await exec(process.execPath, [
    '--import',
    'tsx',
    'apps/cli/main.ts',
    'read',
    file,
    '--sheet',
    'Sheet1',
    '--range',
    'B1',
    '--calculated',
  ]);
  expect(JSON.parse(read.stdout).data.values).toEqual([[24]]);
  const relativeRead = await exec(
    process.execPath,
    [
      path.resolve('dist/cli.cjs'),
      'read',
      path.basename(file),
      '--sheet',
      'Sheet1',
      '--range',
      'B1',
      '--calculated',
    ],
    { cwd: dir },
  );
  expect(JSON.parse(relativeRead.stdout).data.values).toEqual([[24]]);
  await page.locator('#bold').click();
  await saveEdits(page);
  await expect
    .poll(async () => (await load(file)).book.sheets[0].styleRules.length)
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '↶ 撤销' }).click();
  await saveEdits(page);
  await expect.poll(async () => (await load(file)).book.sheets[0].styleRules.length).toBe(0);
  const ops = path.join(dir, 'ops.json');
  await fs.writeFile(
    ops,
    JSON.stringify([{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [[7]] }]),
  );
  await exec(process.execPath, [
    '--import',
    'tsx',
    'apps/cli/main.ts',
    'batch',
    file,
    '--ops',
    ops,
  ]);
  await expect(page.getByLabel('单元格地址')).toHaveValue('B1');
  await page.getByLabel('单元格地址').fill('A1');
  await page.getByLabel('单元格地址').press('Enter');
  await page.locator('#syncDisk').click();
  await expect(page.getByLabel('单元格内容或公式')).toHaveValue('7', { timeout: 6000 });
  await page.screenshot({ path: '.verification/editor-tested.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('dragging the grid handle fills numbers and relative formulas and can be undone', async ({
  page,
}) => {
  await transact(file, [
    { type: 'set', sheet: 'Sheet1', range: 'A1:A2', values: [[2], [5]] },
    { type: 'formula', sheet: 'Sheet1', cell: 'B1', formula: '=A1+$A$1' },
  ]);
  await page.goto(url);
  const canvas = page.locator('#canvas canvas:visible').first();
  await expect(canvas).toBeVisible();
  const rect = (await canvas.boundingBox())!;
  const drag = async (x: number, y: number, end: number) => {
    await page.mouse.move(rect.x + x, rect.y + y);
    await page.mouse.down();
    await page.mouse.move(rect.x + x, rect.y + end, { steps: 12 });
    await page.mouse.up();
  };
  // The default worksheet uses a 46px row header, 88px columns and 24px rows.
  await drag(90, 32, 56);
  await expect(page.locator('#selection')).toContainText('A1:A2');
  await drag(134, 68, 129);
  await saveEdits(page);
  await expect
    .poll(async () => (await load(file)).book.sheets[0].data.map((r) => r[0]))
    .toEqual([2, 5, 8, 11, 14]);
  await page.mouse.click(rect.x + 170, rect.y + 32);
  await drag(222, 44, 129);
  await saveEdits(page);
  await expect.poll(async () => (await load(file)).book.sheets[0].formulas.B5).toBe('=A5+$A$1');
  await page.locator('[data-action="undo"]').click();
  await saveEdits(page);
  await expect.poll(async () => (await load(file)).book.sheets[0].formulas.B5).toBeUndefined();
  await page.locator('[data-action="redo"]').click();
  await saveEdits(page);
  await expect.poll(async () => (await load(file)).book.sheets[0].formulas.B5).toBe('=A5+$A$1');
});
test('format follows the active cell, and formatting and history keep the same scrolled grid', async ({
  page,
}) => {
  await transact(file, [
    { type: 'set', sheet: 'Sheet1', range: 'B1', values: [['00123']] },
    { type: 'style', sheet: 'Sheet1', range: 'A1', style: { numberFormat: '0.00%' } },
    { type: 'style', sheet: 'Sheet1', range: 'B1', style: { numberFormat: '0.0000' } },
  ]);
  await page.goto(url);
  const format = page.getByLabel('数字格式'),
    addr = page.getByLabel('单元格地址');
  await expect(format).toHaveValue('0.00%');
  const canvas = page.locator('#canvas canvas:visible').first();
  const handle = (await canvas.elementHandle())!;
  const rect = (await canvas.boundingBox())!;
  await page.mouse.click(rect.x + 170, rect.y + 32);
  await expect(format).toHaveValue('0.0000');
  await format.selectOption('0.00');
  await saveEdits(page);
  await expect
    .poll(async () => (await load(file)).book.sheets[0].styleRules.at(-1)?.style.numberFormat)
    .toBe('0.00');
  await expect(page.getByLabel('单元格内容或公式')).toHaveValue('00123');
  await page.mouse.click(rect.x + 90, rect.y + 32);
  await expect(format).toHaveValue('0.00%');
  await page.keyboard.press('ArrowRight');
  await expect(format).toHaveValue('0.00');
  await page.keyboard.press('ArrowRight');
  await expect(format).toHaveValue('General');
  await page.mouse.move(rect.x + 180, rect.y + 230);
  await page.mouse.wheel(0, 750);
  await expect(async () => {
    await page.mouse.click(rect.x + 180, rect.y + 230);
    expect(Number((await addr.inputValue()).slice(1))).toBeGreaterThan(10);
  }).toPass();
  const selected = await addr.inputValue();
  await format.selectOption('0.00%');
  await saveEdits(page);
  await expect
    .poll(async () => (await load(file)).book.sheets[0].styleRules.at(-1)?.range)
    .toContain(selected);
  await page.locator('[data-action="undo"]').click();
  await expect(format).toHaveValue('General');
  await page.mouse.click(rect.x + 180, rect.y + 230);
  await expect(addr).toHaveValue(selected);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
  await expect(format).toHaveValue('0.00%');
  await expect(addr).toHaveValue(selected);
  expect(await handle.evaluate((node) => node.isConnected)).toBe(true);
});
test('font controls follow the active cell and queued toggles apply to the selected range', async ({
  page,
}) => {
  await transact(file, [
    {
      type: 'style',
      sheet: 'Sheet1',
      range: 'A1',
      style: {
        bold: true,
        italic: true,
        fontSize: 17,
        horizontal: 'center',
        fontFamily: 'Cambria',
        color: '#7030A0',
        background: '#FFC000',
      },
    },
  ]);
  await page.goto(url);
  const select = async (address: string) => {
    const input = page.getByLabel('单元格地址');
    await input.fill(address);
    await input.press('Enter');
  };
  const bold = page.locator('#bold'),
    italic = page.locator('#italic');
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('字号', { exact: true })).toHaveValue('17');
  await expect(page.getByLabel('水平居中')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#colorMenu')).toHaveAttribute('title', /7030A0/);
  await page.locator('#format').click();
  await expect(page.locator('[name="fontFamily"]')).toHaveValue('Cambria');
  await expect(page.locator('[name="horizontal"]')).toHaveValue('center');
  await page.locator('#submit').click();
  await select('B1:C1');
  await expect(page.locator('#normal')).toHaveAttribute('aria-pressed', 'true');
  await bold.dblclick({ delay: 10 });
  expect((await load(file)).book.sheets[0].styleRules).toHaveLength(1);
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-action="undo"]').click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await select('C1');
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#italic').click();
  await expect(italic).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#italic').click();
  await expect(italic).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Control+b');
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await select('A1');
  await expect(page.locator('#backgroundMenu')).toHaveAttribute('title', /FFC000/);
});
test('color palette shows the selected paint, reuses the last choice and clears only that property', async ({
  page,
}) => {
  await transact(file, [
    {
      type: 'style',
      sheet: 'Sheet1',
      range: 'A1:B1',
      style: { bold: true, color: '#FF0000', background: '#FFFF00' },
    },
  ]);
  await page.goto(url);
  const menu = page.locator('#backgroundMenu'),
    palette = page.locator('#colorPalette');
  await menu.click();
  await expect(palette).toBeVisible();
  await menu.click();
  await expect(palette).toBeHidden();
  await menu.click();
  await expect(palette.getByRole('button', { name: '#FFFF00', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await palette.getByRole('button', { name: '#0070C0', exact: true }).click();
  await expect(menu).toHaveAttribute('title', /0070C0/);
  const address = page.getByLabel('单元格地址');
  await address.fill('B1');
  await address.press('Enter');
  await expect(menu).toHaveAttribute('title', /FFFF00/);
  await page.locator('#background').click();
  await expect(menu).toHaveAttribute('title', /0070C0/);
  await menu.click();
  await palette.getByRole('button', { name: '无填充颜色' }).click();
  await expect(menu).toHaveAttribute('title', /无填充/);
  await expect(page.locator('#bold')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#colorMenu')).toHaveAttribute('title', /FF0000/);
  await saveEdits(page);
  await expect
    .poll(
      async () => (await load(file)).book.sheets[0].styleRules.find((r) => r.range === 'B1')?.style,
    )
    .toEqual({ bold: true, color: '#FF0000' });
  await page.locator('[data-action="undo"]').click();
  await expect(menu).toHaveAttribute('title', /0070C0/);
  await page.locator('#colorMenu').click();
  await palette.getByRole('button', { name: '自动', exact: true }).click();
  await expect(page.locator('#colorMenu')).toHaveAttribute('title', /自动/);
  await saveEdits(page);
  await expect
    .poll(
      async () => (await load(file)).book.sheets[0].styleRules.find((r) => r.range === 'B1')?.style,
    )
    .toEqual({ bold: true, background: '#0070C0' });
  await page.reload();
  await expect(page.locator('#bold')).toBeEnabled();
  await address.fill('B1');
  await address.press('Enter');
  await expect(menu).toHaveAttribute('title', /0070C0/);
  await expect(page.locator('#colorMenu')).toHaveAttribute('title', /自动/);
  await page.locator('#colorMenu').click();
  await page.locator('#customColor').fill('#123456');
  await expect(page.locator('#colorMenu')).toHaveAttribute('title', /123456/);
  await page.locator('#colorMenu').click();
  await expect(page.locator('#recentSwatches button').first()).toHaveAttribute(
    'aria-label',
    '#123456',
  );
});
test('switching sheets and undoing a structural change restores the active sheet and selection', async ({
  page,
}) => {
  await transact(file, [
    { type: 'sheet.add', name: '明细' },
    { type: 'style', sheet: '明细', range: 'D6', style: { numberFormat: '0%' } },
  ]);
  await page.goto(url);
  await page.getByText('明细', { exact: true }).click();
  const addr = page.getByLabel('单元格地址'),
    format = page.getByLabel('数字格式');
  await addr.fill('D6');
  await addr.press('Enter');
  await expect(format).toHaveValue('0%');
  await page.getByText('Sheet1', { exact: true }).click();
  await expect(format).toHaveValue('General');
  await page.getByText('明细', { exact: true }).click();
  await expect(addr).toHaveValue('D6');
  await page.locator('#freeze').click();
  await page.locator('#submit').click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  await expect(addr).toHaveValue('D6');
  await expect(format).toHaveValue('0%');
  await page.locator('[data-action="undo"]').click();
  await expect(page.locator('#status')).toHaveText('已保存');
  expect((await load(file)).book.sheets[1].freeze.rows).toBe(0);
  await expect(page.locator('#selection')).toContainText('明细 ! D6');
  await expect(format).toHaveValue('0%');
});
test('pending formula-bar edits retain their original sheet and address on save', async ({
  page,
}) => {
  await transact(file, [
    { type: 'set', sheet: 'Sheet1', range: 'B3', values: [['original']] },
    { type: 'sheet.add', name: 'Second' },
    { type: 'set', sheet: 'Second', range: 'A1', values: [['keep A1']] },
    { type: 'set', sheet: 'Second', range: 'B3', values: [['keep B3']] },
  ]);
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const addr = page.getByLabel('单元格地址');
  await addr.fill('B3');
  await addr.press('Enter');
  const formula = page.getByLabel('单元格内容或公式');
  await formula.fill('for Sheet1');
  await page.getByText('Second', { exact: true }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect(page.locator('#status')).toHaveText('已保存');
  const sheets = (await load(file)).book.sheets;
  expect(sheets[0].data[2][1]).toBe('for Sheet1');
  expect(sheets[1].data).toEqual([['keep A1'], [], [null, 'keep B3']]);
  await formula.fill('discard this');
  await formula.press('Escape');
  await expect(formula).toHaveValue('keep A1');
  await expect(page.locator('#save')).toBeDisabled();
});
test('formula-bar editing preserves long identifiers and the type of untouched text', async ({
  page,
}) => {
  await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [['1234']] }]);
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const formula = page.getByLabel('单元格内容或公式');
  await expect(formula).toHaveValue('1234');
  await formula.press('Enter');
  await expect(page.locator('#save')).toBeDisabled();
  await formula.fill('5678');
  await formula.press('Enter');
  const address = page.getByLabel('单元格地址');
  await address.fill('B1');
  await address.press('Enter');
  await formula.fill('9007199254740993');
  await formula.press('Enter');
  await saveEdits(page);
  expect((await load(file)).book.sheets[0].data[0]).toEqual(['5678', '9007199254740993']);
});
test('keeps pending input across a blocked sheet change and clears it on explicit disk reload', async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const formula = page.getByLabel('单元格内容或公式');
  await formula.fill('pending value');
  await page.locator('#sheets').click();
  await page.locator('#submit').click();
  await expect(page.locator('#dialogError')).toContainText('完成单元格输入');
  await page.locator('#cancel').click();
  await expect(formula).toHaveValue('pending value');
  await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [['from disk']] }]);
  await page.locator('#syncDisk').click();
  await expect(page.locator('#conflict')).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#reload').click();
  await expect(formula).toHaveValue('pending value');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#reload').click();
  await expect(formula).toHaveValue('from disk');
  await expect(page.locator('#save')).toBeDisabled();
  expect((await load(file)).book.sheets).toHaveLength(1);
});
test('native grid typing stays in memory until save and stale saves conflict', async ({ page }) => {
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const canvas = page.locator('#canvas canvas:visible').first();
  await expect(canvas).toBeVisible();
  const rect = (await canvas.boundingBox())!;
  await page.mouse.click(rect.x + 90, rect.y + 32);
  await page.keyboard.type('42');
  await page.keyboard.press('Enter');
  await saveEdits(page);
  await expect
    .poll(async () => (await load(file)).book.sheets[0].data[0]?.[0], { timeout: 10000 })
    .toBe(42);
  await page.mouse.click(rect.x + 90, rect.y + 32);
  await page.keyboard.type('99');
  await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [[123]] }]);
  await page.keyboard.press('Enter');
  await page.locator('#save').click();
  await expect(page.locator('#conflict')).toBeVisible();
  expect((await load(file)).book.sheets[0].data[0][0]).toBe(123);
});
test('edits stay local before the deadline and edits made during a save remain pending', async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const before = await fs.readFile(file);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/books/')) requests.push(request.method());
  });
  const input = page.getByLabel('单元格内容或公式');
  await input.fill('first');
  await input.press('Enter');
  await page.locator('#bold').click();
  await page.locator('[data-action="undo"]').click();
  await page.locator('[data-action="redo"]').click();
  // A short pause after a small burst should cause neither a disk write nor a poll.
  await page.waitForTimeout(2300);
  expect(requests).toEqual([]);
  expect(await fs.readFile(file)).toEqual(before);
  const received = deferred();
  const release = deferred();
  await page.route('**/api/books/*', async (route) => {
    const response = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.locator('#save').click();
  await received.promise;
  expect((await load(file)).book.sheets[0].data[0][0]).toBe('first');
  await input.fill('second');
  await input.press('Enter');
  release.resolve();
  await expect(page.locator('#status')).toHaveText('待自动保存');
  expect((await load(file)).book.sheets[0].data[0][0]).toBe('first');
  // Ctrl+S also commits an in-progress formula-bar edit.
  await input.fill('third');
  await input.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect(page.locator('#status')).toHaveText('已保存');
  expect((await load(file)).book.sheets[0].data[0][0]).toBe('third');
});
test('twenty edits share one automatic write and an untouched workbook stays clean', async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/books/'))
      writes.push(request.postDataJSON().command);
  });
  const input = page.locator('#formulaValue');
  await input.fill('batch');
  await input.press('Enter');
  for (let i = 0; i < 19; i++) await page.locator('#bold').click();
  expect(writes).toEqual([]);
  await expect(page.locator('#status')).toHaveText('已保存', { timeout: 5000 });
  expect(writes).toEqual(['batch']);
  const sheet = (await load(file)).book.sheets[0];
  expect(sheet.data[0][0]).toBe('batch');
  expect(sheet.styleRules.some((rule) => rule.range === 'A1' && rule.style.bold)).toBe(true);
  await page.locator('#cellAddress').fill('B3');
  await page.locator('#cellAddress').press('Enter');
  await expect(page.locator('#save')).toBeDisabled();
});
test('idle autosave waits for uncommitted input and preserves external changes', async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const input = page.locator('#formulaValue');
  await input.fill('committed');
  await input.press('Enter');
  await expect(page.locator('#status')).toHaveText('待自动保存');
  await expect(page.locator('#status')).toHaveText('已保存', { timeout: 15000 });
  expect((await load(file)).book.sheets[0].data[0][0]).toBe('committed');
  // Make the accelerated batch due and leave the formula bar mid-edit.
  for (let i = 0; i < 20; i++) await page.locator('#italic').click();
  await input.fill('unfinished');
  await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [['external']] }]);
  await page.waitForTimeout(1300);
  await expect(input).toHaveValue('unfinished');
  await expect(page.locator('#conflict')).not.toBeVisible();
  await input.press('Enter');
  await expect(page.locator('#conflict')).toBeVisible();
  await expect(input).toHaveValue('unfinished');
  expect((await load(file)).book.sheets[0].data[0][0]).toBe('external');
});
test('a failed autosave retries once with the latest in-memory edits', async ({ page }) => {
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  await page.clock.install();
  let attempts = 0;
  await page.route('**/api/books/*', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (++attempts > 1) return route.continue();
    return route.fulfill({
      status: 503,
      json: { ok: false, error: { code: 'IO_ERROR', message: '暂时无法写入' } },
    });
  });
  const original = await fs.readFile(file);
  const input = page.locator('#formulaValue');
  await input.fill('first');
  await input.press('Enter');
  await page.clock.fastForward(10_000);
  await expect(page.locator('#status')).toHaveText('保存失败，等待重试');
  await input.fill('latest');
  await input.press('Enter');
  await page.clock.fastForward(25_000);
  expect(attempts).toBe(1);
  expect(await fs.readFile(file)).toEqual(original);
  await page.clock.fastForward(5_000);
  await expect(page.locator('#status')).toHaveText('已保存');
  expect(attempts).toBe(2);
  expect((await load(file)).book.sheets[0].data[0][0]).toBe('latest');
});
test('exports the visible workbook while unsaved or behind an external edit', async ({ page }) => {
  await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [['saved']] }]);
  await page.goto(url);
  await expect(page.locator('#formulaValue')).toHaveValue('saved');
  await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [['external']] }]);
  const clean = path.join(dir, 'visible.csv'),
    dirty = path.join(dir, 'edited.csv');
  const choices = [clean, dirty];
  await page.route('**/api/file-dialog', (route) =>
    route.fulfill({ json: { ok: true, data: choices.shift() } }),
  );
  await page.locator('#export').click();
  await expect(page.locator('#message')).toContainText(clean);
  expect((await fs.readFile(clean, 'utf8')).trim()).toBe('saved');
  await page.locator('#formulaValue').fill('edited');
  await page.locator('#formulaValue').press('Enter');
  await page.locator('#export').click();
  await expect(page.locator('#message')).toContainText(dirty);
  expect((await fs.readFile(dirty, 'utf8')).trim()).toBe('edited');
  expect((await load(file)).book.sheets[0].data[0][0]).toBe('external');
  await page.locator('#syncDisk').click();
  await expect(page.locator('#conflict')).toBeVisible();
  await expect(page.locator('#formulaValue')).toHaveValue('edited');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#reload').click();
  await expect(page.locator('#message')).toHaveText('已载入磁盘版本');
  await expect(page.locator('#formulaValue')).toHaveValue('external');
  await expect(page.locator('#status')).toHaveText('已保存');
});
test('exports unsaved cells to an offline HTML that works in a sandboxed iframe', async ({
  page,
  browser,
}) => {
  const target = path.join(dir, '报价.html');
  await transact(file, [{ type: 'sheet.add', name: '明细' }]);
  const before = await fs.readFile(file);
  await page.route('**/api/file-dialog', (route) => {
    expect(route.request().postDataJSON().kind).toBe('export');
    return route.fulfill({ json: { ok: true, data: target } });
  });
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  await page.locator('#formulaValue').fill('001 <A>');
  await page.locator('#formulaValue').press('Enter');
  await page.locator('#export').click();
  await expect(page.locator('#message')).toContainText(target);
  expect(await fs.readFile(file)).toEqual(before);
  const offline = await browser.newContext({ offline: true, javaScriptEnabled: false });
  try {
    const view = await offline.newPage();
    const requests: string[] = [];
    view.on('request', (req) => {
      if (/^https?:/.test(req.url())) requests.push(req.url());
    });
    const host = path.join(dir, 'host.html');
    await fs.writeFile(
      host,
      '<!doctype html><meta charset="utf-8"><iframe sandbox src="报价.html" title="报价"></iframe>',
    );
    await view.goto(pathToFileURL(host).href);
    const frame = view.frameLocator('iframe');
    await expect(frame.getByText('001 <A>', { exact: true })).toBeVisible();
    await frame.locator('label').filter({ hasText: '明细' }).click();
    await expect(frame.getByText('没有可显示的单元格')).toBeVisible();
    await expect(frame.getByText('001 <A>', { exact: true })).not.toBeVisible();
    expect(requests).toEqual([]);
  } finally {
    await offline.close();
  }
});
test('filters share local undo and preserve manually hidden rows when saving', async ({ page }) => {
  await transact(file, [
    { type: 'set', sheet: 'Sheet1', range: 'A1:A4', values: [['名称'], ['甲'], ['乙'], ['甲']] },
    { type: 'rows.meta', sheet: 'Sheet1', index: 3, count: 1, hidden: true },
  ]);
  await page.goto(url);
  await expect(page.locator('#formulaValue')).toHaveValue('名称');
  await page.locator('#filter').click();
  await page.locator('[name="range"]').fill('A1:A4');
  await page.locator('[name="values"]').fill('["甲"]');
  await page.locator('#submit').click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  expect((await load(file)).book.sheets[0].filter).toBe(null);
  await page.locator('[data-action="undo"]').click();
  await expect(page.locator('#status')).toHaveText('已保存');
  await page.locator('[data-action="redo"]').click();
  await saveEdits(page);
  const sheet = (await load(file)).book.sheets[0];
  expect(sheet.filter).toEqual({ range: 'A1:A4', columns: [{ column: 0, values: ['甲'] }] });
  expect(Object.keys(sheet.rowMeta)).toEqual(['3']);
});
test('pastes a rectangular block and reloads another open tab', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator('#name')).toHaveText('浏览器测试');
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText('3\t4\n5\t6'));
  const rect = (await page.locator('#canvas canvas:visible').first().boundingBox())!;
  await page.mouse.click(rect.x + 90, rect.y + 32);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await saveEdits(page);
  await expect
    .poll(
      async () => (await load(file)).book.sheets[0].data.slice(0, 2).map((r) => r.slice(0, 2)),
      { timeout: 10000 },
    )
    .toEqual([
      [3, 4],
      [5, 6],
    ]);
  await expect(other.getByLabel('单元格内容或公式')).toHaveValue('');
  await other.locator('#syncDisk').click();
  await expect(other.locator('#message')).toHaveText('已载入磁盘版本');
  await expect(other.getByLabel('单元格内容或公式')).toHaveValue('3', { timeout: 6000 });
});
test('does not replace edits started while an external reload is in flight', async ({ page }) => {
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const held = deferred(),
    loading = deferred();
  const bookId = new URL(url).searchParams.get('book');
  await page.route(`**/api/books/${bookId}`, async (route) => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      loading.resolve();
      await held.promise;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [[123]] }]);
  await page.locator('#syncDisk').click();
  await loading.promise;
  await page.getByLabel('单元格内容或公式').fill('99');
  held.resolve();
  await expect(page.locator('#conflict')).toBeVisible();
  await expect(page.getByLabel('单元格内容或公式')).toHaveValue('99');
  await page.getByLabel('单元格内容或公式').press('Enter');
  const copy = path.join(dir, 'unsaved.aib');
  await page.route('**/api/file-dialog', (route) =>
    route.fulfill({ json: { ok: true, data: copy } }),
  );
  await page.locator('#download').click();
  await expect
    .poll(
      async () =>
        await fs.readFile(copy, 'utf8').then(
          (text) => JSON.parse(text).sheets[0].data[0][0],
          () => null,
        ),
    )
    .toBe(99);
  expect((await load(file)).book.sheets[0].data[0][0]).toBe(123);
});
test('the CSV picker exports the selected sheet even when another sheet uses its name as an ID', async ({
  page,
}) => {
  await transact(file, [
    { type: 'sheet.rename', sheet: 'sheet1', name: 'second-id' },
    { type: 'set', sheet: 'sheet1', range: 'A1', values: [['first']] },
    { type: 'sheet.add', id: 'second-id', name: 'Other' },
    { type: 'set', sheet: 'second-id', range: 'A1', values: [['other']] },
  ]);
  const csv = path.join(dir, 'selected.csv');
  await page.route('**/api/file-dialog', (route) =>
    route.fulfill({ json: { ok: true, data: csv } }),
  );
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  await page.locator('#export').click();
  const sheet = page.locator('#dialog select[name=sheet]');
  await sheet.selectOption({ label: 'second-id' });
  await page.locator('#submit').click();
  await expect(page.locator('#message')).toContainText(csv);
  expect((await fs.readFile(csv, 'utf8')).trim()).toBe('first');
});

test('exports the project Markdown guide without a workbook and keeps edits on export failure', async ({
  page,
}) => {
  const target = path.join(dir, '交给 AI 的指南.md');
  const englishTarget = path.join(dir, 'guide.en.md');
  const choices = [null, target, englishTarget, target];
  await page.route('**/api/file-dialog', (route) => {
    const file = choices.shift();
    expect(route.request().postDataJSON()).toMatchObject({
      kind: 'guide',
      name: file === englishTarget ? 'AIB Offline Guide-en' : 'AIB离线处理指南-zh',
    });
    return route.fulfill({ json: { ok: true, data: file } });
  });
  const blank = new URL(url);
  blank.search = '';
  await page.goto(blank.href);
  const button = page.getByRole('button', { name: '导出离线处理指南' });
  await button.click();
  await expect(page.locator('body')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#message')).toBeHidden();
  expect(await fs.readdir(dir)).not.toContain(path.basename(target));
  await button.click();
  await expect(page.locator('#message')).toContainText(target);
  expect(await fs.readFile(target)).toEqual(
    await fs.readFile('skills/aib-workbook/references/zh/aib-offline.md'),
  );
  await page.locator('#language').selectOption('en-US');
  await page.getByRole('button', { name: 'Export offline guide' }).click();
  await expect(page.locator('#message')).toContainText(englishTarget);
  expect(await fs.readFile(englishTarget)).toEqual(
    await fs.readFile('skills/aib-workbook/references/en/aib-offline.md'),
  );
  const reset = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/language') &&
      r.request().method() === 'POST' &&
      r.request().postDataJSON().language === 'zh-CN',
  );
  await page.locator('#language').selectOption('zh-CN');
  await reset;
  await page.goto(url);
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  await page.locator('#formulaValue').fill('当前未提交输入');
  await fs.writeFile(target, '保留已有内容');
  await button.click();
  await expect(page.locator('#message')).toContainText('目标文件已存在');
  expect(await fs.readFile(target, 'utf8')).toBe('保留已有内容');
  await expect(page.locator('#formulaValue')).toHaveValue('当前未提交输入');
  await expect(page.locator('#status')).toHaveText('正在输入');
  expect(choices).toHaveLength(0);
});
test('opens, creates, saves copies, imports and exports using the selected native paths', async ({
  page,
}) => {
  const fresh = path.join(dir, '新的 工作簿.aib'),
    copy = path.join(dir, '副本.aib'),
    csv = path.join(dir, '销售.csv'),
    imported = path.join(dir, '导入.aib'),
    xlsx = path.join(dir, '销售.xlsx');
  await fs.writeFile(csv, '名称,数量\n苹果,02');
  const choices: [string, string | null][] = [
    ['open', null],
    ['save', fresh],
    ['export', copy],
    ['open', file],
    ['import', csv],
    ['save', null],
    ['save', imported],
    ['export', xlsx],
  ];
  await page.route('**/api/file-dialog', async (route) => {
    const [kind, selected] = choices.shift()!;
    expect(route.request().postDataJSON().kind).toBe(kind);
    await route.fulfill({ json: { ok: true, data: selected } });
  });
  await page.goto(url);
  await page.locator('#open').click();
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  await page.locator('#new').click();
  await page.locator('#submit').click();
  await expect(page.locator('#path')).toHaveText(fresh);
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导出为 HTML', exact: true })).toHaveCount(0);
  const freshBytes = await fs.readFile(fresh);
  await page.locator('#formulaValue').fill('仅写入副本');
  await page.locator('#formulaValue').press('Enter');
  await page.locator('#export').click();
  await expect(page.locator('#path')).toHaveText(copy);
  await expect(page.locator('#status')).toHaveText('已保存');
  expect((await load(copy)).book.sheets[0].data[0][0]).toBe('仅写入副本');
  expect(await fs.readFile(fresh)).toEqual(freshBytes);
  await page.locator('#open').click();
  await expect(page.locator('#path')).toHaveText(file);
  await page.locator('#import').click();
  await page.locator('#submit').click();
  await expect(page.locator('#dialog')).toBeVisible();
  await page.locator('#submit').click();
  await expect(page.locator('#path')).toHaveText(imported);
  expect((await load(imported)).book.sheets[0].data[1]).toEqual(['苹果', '02']);
  await page.locator('#export').click();
  await expect(page.locator('#message')).toContainText(xlsx);
  expect((await fs.readFile(xlsx)).subarray(0, 2).toString()).toBe('PK');
  expect(choices).toHaveLength(0);
});
test('imports a binary XLS and asks before exporting its formulas as values', async ({ page }) => {
  const source = path.resolve('tests/fixtures/legacy-types.xls');
  const imported = path.join(dir, '旧版.aib');
  const exported = path.join(dir, '旧版.xls');
  const choices = [source, imported, exported, exported];
  await page.route('**/api/file-dialog', (route) =>
    route.fulfill({ json: { ok: true, data: choices.shift() } }),
  );
  await page.goto(url);
  await page.locator('#import').click();
  await page.locator('#submit').click();
  await expect(page.locator('#path')).toHaveText(imported);
  expect((await load(imported)).book.sheets[0].formulas.B2).toBe('=B1*2');
  for (const accept of [false, true]) {
    const answered = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('当前计算结果');
      if (accept) await dialog.accept();
      else await dialog.dismiss();
    });
    await page.locator('#export').click();
    await answered;
    if (!accept) await expect(fs.stat(exported)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  await expect(page.locator('#message')).toContainText(exported);
  expect((await fs.readFile(exported)).subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');
});
test('theme follows the OS, persists an explicit choice, and keeps workbook and selection intact', async ({
  page,
  browser,
}) => {
  const hash = (await load(file)).hash;
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const canvas = page.locator('#canvas canvas:visible').first();
  const handle = (await canvas.elementHandle())!;
  await page.getByLabel('单元格地址').fill('D6');
  await page.getByLabel('单元格地址').press('Enter');
  await expect(page.locator('html')).toHaveClass(/univer-dark/);
  const rect = (await canvas.boundingBox())!;
  const gridImage = () =>
    page.screenshot({ clip: { x: rect.x + 300, y: rect.y + 200, width: 120, height: 65 } });
  const dark = await gridImage();
  await page.getByLabel('主题').selectOption('light');
  await expect(page.locator('html')).not.toHaveClass(/univer-dark/);
  await expect.poll(async () => (await gridImage()).equals(dark)).toBe(false);
  expect(await handle.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.getByLabel('单元格地址')).toHaveValue('D6');
  await expect
    .poll(() => fs.readFile(path.join(dir, 'state', 'theme.json'), 'utf8').catch(() => ''))
    .toBe('"light"');
  const other = await browser.newPage({ colorScheme: 'dark', locale: 'zh-CN' });
  try {
    await other.goto(url);
    await expect(other.getByLabel('主题')).toHaveValue('light');
  } finally {
    await other.close();
  }
  await page.getByLabel('主题').selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect((await load(file)).hash).toBe(hash);
});
test('switches languages in place with pending input, formatting, undo and saved preference intact', async ({
  page,
  browser,
}) => {
  await page.goto(url);
  await expect(page.getByLabel('界面语言')).toHaveValue('zh-CN');
  await expect(page.locator('#name')).toHaveText('浏览器测试');
  const original = await load(file);
  const canvas = await page.locator('#canvas canvas:visible').first().elementHandle();
  await page.locator('#cellAddress').fill('D6');
  await page.locator('#cellAddress').press('Enter');
  await page.locator('#formulaValue').fill('保留 {name}');
  await page.getByLabel('界面语言').selectOption('en-US');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('#canvas [aria-label="Sheet tabs"]')).toBeAttached();
  await expect(page.getByLabel('Cell value or formula')).toHaveValue('保留 {name}');
  await expect(page.getByLabel('Cell address')).toHaveValue('D6');
  await expect(page.locator('#status')).toHaveText('Editing');
  await expect(page.getByLabel('Number format').locator('option:checked')).toHaveText('General');
  expect(await canvas!.evaluate((node) => node.isConnected)).toBe(true);
  expect((await load(file)).hash).toBe(original.hash);
  await page.getByLabel('Cell value or formula').press('Enter');
  await page.getByTitle('Format cells').click();
  await expect(page.getByRole('heading', { name: 'Format selection' })).toBeVisible();
  await expect(page.getByLabel('Vertical alignment')).toBeVisible();
  await page.getByLabel('Close', { exact: true }).click();
  await page.getByRole('button', { name: 'Choose font color' }).click();
  await expect(page.getByRole('button', { name: 'Automatic' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '↶ Undo' }).click();
  await expect(page.locator('#formulaValue')).toHaveValue('');
  await page.getByRole('button', { name: '↷ Redo' }).click();
  await expect(page.locator('#formulaValue')).toHaveValue('保留 {name}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Saved');
  expect((await load(file)).book.sheets[0].data[5][3]).toBe('保留 {name}');
  await expect
    .poll(async () => fs.readFile(path.join(dir, 'state/language.json'), 'utf8').catch(() => ''))
    .toBe('"en-US"');
  const fresh = await browser.newPage({ locale: 'zh-CN' });
  try {
    await fresh.goto(url);
    await expect(fresh.getByLabel('Interface language')).toHaveValue('en-US');
    await expect(fresh.locator('#name')).toHaveText('浏览器测试');
  } finally {
    await fresh.close();
  }
  await page.getByLabel('Interface language').selectOption('zh-CN');
  await expect(page.locator('#canvas [aria-label="工作表标签页"]')).toBeAttached();
  await expect(page.getByLabel('单元格地址')).toHaveValue('D6');
  await expect(page.locator('#status')).toHaveText('已保存');
});

test('detects an English browser and passes the language to the picker, HTML and diagnostics', async ({
  browser,
}) => {
  const page = await browser.newPage({ locale: 'en-GB' });
  try {
    const blank = new URL(url);
    blank.search = '';
    await page.goto(blank.href);
    await expect(
      page.getByRole('heading', { name: 'Your spreadsheet, in one file.' }),
    ).toBeVisible();
    await expect(page).toHaveTitle('AIB · Local spreadsheets');
    await page.goto(url);
    await expect(page.locator('#status')).toHaveText('Saved');
    const target = path.join(dir, '空白表.html');
    await page.route('**/api/file-dialog', (route) => {
      expect(route.request().postDataJSON()).toMatchObject({ kind: 'export', language: 'en-US' });
      return route.fulfill({ json: { ok: true, data: target } });
    });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.locator('#message')).toHaveText('Exported to ' + target);
    const text = await fs.readFile(target, 'utf8');
    expect(text).toContain('<html lang="en-US">');
    expect(text).toContain('No visible cells');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.locator('#message')).toContainText('Choose a new filename');
  } finally {
    await page.close();
  }
});

test('local HTTP rejects missing tokens and hostile origins', async () => {
  const base = `http://127.0.0.1:${server.info.port}`;
  expect((await fetch(base + '/api/health')).status).toBe(401);
  expect(
    (
      await fetch(base + '/api/health', {
        headers: { Authorization: `Bearer ${server.info.token}`, Origin: 'https://evil.example' },
      })
    ).status,
  ).toBe(403);
});
