import { expect, it } from 'vitest';
import express from 'express';
import { listenForBrowser } from '../apps/server/listen';
it('rejects browser-reserved ports and serves HTTP on OS-assigned ports', async () => {
  const app = express();
  app.get('/', (_req, res) => res.send('ready'));
  await expect(listenForBrowser(app, 6000)).rejects.toMatchObject({ code: 'INVALID_PORT' });
  const server = await listenForBrowser(app, 0);
  try {
    const { port } = server.address() as { port: number };
    expect(await fetch('http://127.0.0.1:' + port).then((r) => r.text())).toBe('ready');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
