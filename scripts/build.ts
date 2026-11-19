import { build as bundle } from 'esbuild';
import { build as web } from 'vite';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execute } from '../packages/service/index';
import { loadSheetLayout, univerDocSkeleton } from './univer-sheet-build';
await web({ configFile: 'apps/web/vite.config.ts', logLevel: 'warn' });
await bundle({
  entryPoints: ['apps/cli/main.ts'],
  outfile: 'dist/cli.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: false,
  plugins: [
    {
      name: 'aib-sheet-layout',
      setup(build) {
        let loaded = false;
        build.onLoad({ filter: univerDocSkeleton }, async ({ path }) => {
          const contents = await loadSheetLayout(path);
          loaded = true;
          return { contents, loader: 'js' };
        });
        build.onEnd((result) => {
          if (!result.errors.length && !loaded)
            throw new Error('Unrecognized Univer CLI layout entry');
        });
      },
    },
  ],
  logLevel: 'info',
});
const skill = 'skills/aib-workbook';
await fs.mkdir(`dist/${skill}/references`, { recursive: true });
await fs.copyFile(`${skill}/SKILL.md`, `dist/${skill}/SKILL.md`);
await fs.cp(`${skill}/references`, `dist/${skill}/references`, { recursive: true });
await fs.writeFile(
  `dist/${skill}/references/aib-context.json`,
  JSON.stringify(await execute({ command: 'context' }), null, 2) + '\n',
);
if (process.platform === 'win32') {
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      `/out:${path.resolve('dist/AIB.Browser.exe')}`,
      path.resolve('apps/launcher/windows/OpenBrowser.cs'),
    ],
    { stdio: 'inherit', windowsHide: true },
  );
}
