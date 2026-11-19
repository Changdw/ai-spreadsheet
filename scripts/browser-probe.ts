import { chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../apps/server/index';
import { create } from '../packages/storage/index';
import { newBook } from '../packages/schema/index';
process.env.AIB_HOME = path.resolve('.verification/browser-state');
await fs.mkdir('.verification', { recursive: true });
const file = path.resolve('.verification/browser.aib');
try {
  await create(file, newBook('AIB 测试工作簿'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
}
const server = await startServer(0, path.resolve('dist/web'));
const base = `http://127.0.0.1:${server.info.port}`;
const opened = (await fetch(base + '/api/open', {
  method: 'POST',
  headers: { Authorization: `Bearer ${server.info.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ file }),
}).then((x) => x.json())) as { data: { id: string } };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${base}/?book=${opened.data.id}#token=${server.info.token}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '.verification/browser.png', fullPage: true });
  console.log(
    JSON.stringify(
      {
        errors,
        body: await page.locator('body').innerText(),
        inputs: await page.locator('input,textarea').evaluateAll((es) =>
          es.map((e) => ({
            tag: e.tagName,
            placeholder: e.getAttribute('placeholder'),
            role: e.getAttribute('role'),
            aria: e.getAttribute('aria-label'),
            id: e.id,
            rect: e.getBoundingClientRect().toJSON(),
          })),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
