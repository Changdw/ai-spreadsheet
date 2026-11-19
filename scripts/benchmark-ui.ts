import { chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { startServer } from '../apps/server/index';
process.env.AIB_HOME = path.resolve('.verification/ui-benchmark-state');
const s = await startServer(0, path.resolve('dist/web')),
  base = `http://127.0.0.1:${s.info.port}`,
  browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const results = [];
  for (const [rows, kind] of [
    [10000, 'values'],
    [100000, 'values'],
    [10000, 'formulas'],
  ] as const) {
    const file = path.resolve(`.verification/benchmark-${kind}-${rows}.aib`);
    const opened = (await fetch(base + '/api/open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.info.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    }).then((r) => r.json())) as { data: { id: string } };
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }),
      errors: string[] = [],
      remote: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (route) => {
      if (!route.request().url().startsWith(base)) {
        remote.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const t = performance.now();
    await page.goto(`${base}/?book=${opened.data.id}#token=${s.info.token}`);
    await page.locator('#name').filter({ hasText: kind }).waitFor({ timeout: 30000 });
    await page.locator('#canvas canvas:visible').first().waitFor();
    results.push({
      rows,
      kind,
      editorReadyMs: performance.now() - t,
      errors,
      externalRequests: remote,
    });
    await page.close();
  }
  await fs.writeFile('.verification/ui-metrics.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  await s.close();
}
