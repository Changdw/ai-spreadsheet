import { it, expect, vi, beforeEach } from 'vitest';
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: launch }));
import { openBrowser } from '../apps/server/browser';
beforeEach(() => {
  launch.mockReset();
});
it('waits for URL dispatch to finish instead of treating a started process as success', async () => {
  let complete!: (error: Error | null, stdout: string, stderr: string) => void;
  launch.mockImplementation((_command, _args, _options, callback) => {
    complete = callback;
  });
  let accepted = false;
  const pending = openBrowser('http://127.0.0.1:9683/').then(() => {
    accepted = true;
  });
  await Promise.resolve();
  expect(accepted).toBe(false);
  complete(null, '', '');
  await pending;
  expect(accepted).toBe(true);
});
it.each(['URL handler failed', 'spawn ENOENT', 'dispatch timed out'])(
  'reports browser failure and a usable fallback URL: %s',
  async (reason) => {
    launch.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error(reason), '', reason);
    });
    await expect(openBrowser('http://127.0.0.1:9683/#token=test')).rejects.toMatchObject({
      code: 'BROWSER_OPEN_FAILED',
      message: expect.stringContaining('http://127.0.0.1:9683/#token=test'),
      details: { reason },
    });
  },
);
