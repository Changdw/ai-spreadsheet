import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [action, destination] = process.argv.slice(2);
if (!destination) throw new Error('Expected stage or manifest and a distribution directory');
const out = path.resolve(destination);
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
async function copy(source: string, name = source) {
  const file = path.join(out, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.copyFile(source, file);
}
if (action === 'stage') {
  await copy('dist/cli.cjs', 'cli.cjs');
  await fs.cp('dist/web', path.join(out, 'web'), { recursive: true });
  for (const file of [
    'SKILL.md',
    'references/aib-offline.md',
    'references/zh/aib-offline.md',
    'references/en/aib-offline.md',
    'references/aib-context.json',
  ]) {
    const rel = 'skills/aib-workbook/' + file;
    await copy('dist/' + rel, rel);
  }
  for (const file of ['budget.aib', 'change-budget.json']) await copy('examples/' + file);
  await copy('LICENSE');
  await copy('README.md');
  await copy('README.zh.md');
  await copy('README.en.md');
  await fs.cp('docs/guide', path.join(out, 'docs/guide'), {
    recursive: true,
    filter: (file) =>
      [
        'guide',
        'zh',
        'en',
        'aib-quickstart.html',
        'usage.html',
        'installation.html',
        'architecture.html',
        'architecture.mmd',
        'architecture.svg',
        'module-dependencies.mmd',
        'module-dependencies.svg',
        'workbench.png',
        'draft-review.png',
        'guide.css',
        'guide.js',
      ].includes(path.basename(file)),
  });
  await fs.writeFile(
    path.join(out, 'README.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIB</title><link rel="stylesheet" href="docs/guide/guide.css"><main><h1>AIB</h1><nav aria-label="Language"><a lang="zh" hreflang="zh" href="docs/guide/zh/aib-quickstart.html">中文</a><a lang="en" hreflang="en" href="docs/guide/en/aib-quickstart.html">English</a></nav></main></html>\n',
  );
  await copy('dist/dependencies.json', 'dependencies.json');
  const dependencies = JSON.parse(await fs.readFile('dist/dependencies.json', 'utf8')) as {
    name: string;
    version: string;
    files: string[];
  }[];
  for (const d of dependencies)
    for (const file of d.files) {
      const rel = path.join('licenses', d.name.replaceAll('/', '__') + '-' + d.version, file);
      await copy(path.join('dist', rel), rel);
    }
} else if (action === 'manifest') {
  const files: { path: string; sha256: string }[] = [];
  async function visit(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile())
        files.push({
          path: path.relative(out, file).split(path.sep).join('/'),
          sha256: createHash('sha256')
            .update(await fs.readFile(file))
            .digest('hex'),
        });
      else throw new Error('Unexpected staged entry: ' + file);
    }
  }
  await visit(out);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  await fs.writeFile(
    path.join(out, 'aib-package.json'),
    JSON.stringify(
      { name: 'aib', version: pkg.version, platform: process.argv[4], files },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
} else throw new Error('Unknown distribution step');
