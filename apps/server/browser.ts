import { execFile } from 'node:child_process';
import path from 'node:path';
import { AibError } from '../../packages/schema/index';

/** Wait for the OS URL handler to accept the request, propagating launch failures. */
export async function openBrowser(url: string): Promise<void> {
  const cli = path.resolve(process.argv[1]);
  const directory = cli.endsWith('.ts')
    ? path.resolve(path.dirname(cli), '../../dist')
    : path.dirname(cli);
  const command =
    process.platform === 'win32'
      ? path.join(directory, 'AIB.Browser.exe')
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      [url],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      (error, _stdout, stderr) => {
        if (error)
          reject(
            new AibError(
              'BROWSER_OPEN_FAILED',
              `本地服务已启动，但无法打开默认浏览器。可复制此地址手动打开：${url}`,
              { reason: stderr.trim() || error.message },
            ),
          );
        else resolve();
      },
    );
  });
}
