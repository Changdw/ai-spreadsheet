import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aib-package-'));
const windows = process.platform === 'win32';
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const name = 'aib-' + version + '-' + (windows ? 'win-x64' : 'macos-arm64');
const archive = path.resolve(process.env.AIB_RELEASE_DIR || 'release', name + '.zip');
const pkg = windows ? path.join(dir, name) : path.join(dir, 'AIB.app', 'Contents', 'Resources');
const runtime = path.join(pkg, windows ? 'node.exe' : 'node');
const env = { ...process.env, AIB_HOME: path.join(dir, 'state'), AIB_NO_BROWSER: '1' };
const cli = async (...args: string[]) =>
  JSON.parse(
    (
      await exec(runtime, [path.join(pkg, 'cli.cjs'), ...args], {
        env,
        windowsHide: true,
      })
    ).stdout,
  ).data;
try {
  if (windows) await exec('tar.exe', ['-xf', archive, '-C', dir], { windowsHide: true });
  else await exec('ditto', ['-x', '-k', archive, dir]);
  assert.deepEqual((await fs.readdir(path.join(pkg, 'examples'))).sort(), [
    'budget.aib',
    'change-budget.json',
  ]);
  for (const file of [
    'LICENSE',
    'README.md',
    'README.zh.md',
    'README.en.md',
    'docs/guide/architecture.html',
    'docs/guide/zh/architecture.mmd',
    'docs/guide/en/architecture.mmd',
    'docs/guide/zh/architecture.svg',
    'docs/guide/en/architecture.svg',
    'docs/guide/aib-quickstart.html',
    'docs/guide/installation.html',
    'docs/guide/usage.html',
    'docs/guide/zh/module-dependencies.mmd',
    'docs/guide/en/module-dependencies.mmd',
    'docs/guide/zh/module-dependencies.svg',
    'docs/guide/en/module-dependencies.svg',
    'docs/guide/guide.css',
    'docs/guide/guide.js',
  ].flatMap((file) =>
    file.startsWith('docs/guide/') && file.endsWith('.html')
      ? [file, file.replace('guide/', 'guide/zh/'), file.replace('guide/', 'guide/en/')]
      : [file],
  ))
    assert.deepEqual(await fs.readFile(path.join(pkg, file)), await fs.readFile(file), file);
  for (const file of ['README.html', 'NODE-LICENSE.txt', 'dependencies.json'])
    await fs.access(path.join(pkg, file));
  const inventory: { name: string; version: string; license: string; files: string[] }[] =
    JSON.parse(await fs.readFile(path.join(pkg, 'dependencies.json'), 'utf8'));
  const buffers = inventory.find((dep) => dep.name === 'buffers' && dep.version === '0.1.1');
  if (buffers) {
    assert.equal(buffers.license, 'MIT/X11');
    assert.ok(buffers.files.includes('UPSTREAM-LICENSE.txt'));
    assert.deepEqual(
      await fs.readFile(path.join(pkg, 'licenses/buffers-0.1.1/UPSTREAM-LICENSE.txt')),
      await fs.readFile('scripts/notices/buffers-0.1.1.txt'),
    );
  }
  for (const [name, version, notice, original] of [
    ['@univerjs/protocol', '1.5.2', 'UPSTREAM-LICENSE.txt', 'univer-1.5.2.txt'],
    ['binary', '0.3.0', 'MIT-NOTICE.txt', 'halliday-mit.txt'],
    ['chainsaw', '0.1.0', 'MIT-NOTICE.txt', 'halliday-mit.txt'],
    ['franc-min', '6.2.0', 'UPSTREAM-LICENSE.txt', 'franc-6.2.0.txt'],
    ['saxes', '5.0.1', 'UPSTREAM-LICENSE.txt', 'saxes-5.0.1.txt'],
    ['react-remove-scroll-bar', '2.3.8', 'UPSTREAM-LICENSE.txt', 'react-remove-scroll-bar-MIT.txt'],
    ['@univerjs/engine-render', '1.5.2', 'HYPHEN-LICENSE.txt', 'hyphen-1.10.3.txt'],
    [
      '@univerjs/engine-render',
      '1.5.2',
      'AIB-CHANGES.txt',
      'univer-engine-render-1.5.2-changes.txt',
    ],
  ]) {
    const dependency = inventory.find((item) => item.name === name && item.version === version);
    assert.ok(dependency?.files.includes(notice), name + ' ' + notice);
    const folder = name.replaceAll('/', '__') + '-' + version;
    assert.deepEqual(
      await fs.readFile(path.join(pkg, 'licenses', folder, notice)),
      await fs.readFile(path.join('scripts/notices', original)),
      notice,
    );
  }
  // Inspect the compressed trie strings, including English embedded in the main layout module.
  // Bundlers can select a different quote delimiter and escape non-ASCII characters.
  const patternRoot = 'node_modules/@univerjs/engine-render/lib/es';
  const fingerprints: string[] = [];
  for (const entry of await fs.readdir(patternRoot)) {
    if (!entry.endsWith('.js')) continue;
    const source = await fs.readFile(path.join(patternRoot, entry), 'utf8');
    if (!source.includes('// src/components/docs/layout/hyphenation/patterns/')) continue;
    const match = /const \w+ = \[\s*"[0-9,]+",\s*("(?:\\.|[^"\\]){128,256})/.exec(source);
    assert.ok(match, 'Unknown dictionary encoding in ' + entry);
    fingerprints.push(match[1].slice(1).replaceAll('\\"', '"').slice(0, 96));
  }
  assert.equal(fingerprints.length, 78, 'Review dictionaries when changing Univer');
  const bundles = [
    'cli.cjs',
    ...(await fs.readdir(path.join(pkg, 'web'), { recursive: true }))
      .filter((file) => file.endsWith('.js'))
      .map((file) => path.join('web', file)),
  ];
  assert.ok(bundles.length > 1);
  for (const file of bundles) {
    const js = (await fs.readFile(path.join(pkg, file), 'utf8'))
      .replaceAll('\\"', '"')
      .replace(/\\x([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    for (const trie of fingerprints) assert.ok(!js.includes(trie), 'Dictionary in ' + file);
  }
  if (windows) {
    const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'aib-package.json'), 'utf8'));
    for (const item of manifest.files)
      assert.equal(
        createHash('sha256')
          .update(await fs.readFile(path.join(pkg, item.path)))
          .digest('hex'),
        item.sha256,
        item.path,
      );
  }
  for (const lang of ['zh', 'en']) {
    const guide = path.join(dir, 'guide.' + lang + '.md');
    await cli('--offline', 'export-guide', guide, '--lang', lang);
    assert.deepEqual(
      await fs.readFile(guide),
      await fs.readFile('skills/aib-workbook/references/' + lang + '/aib-offline.md'),
    );
  }
  const invalid = path.join(dir, 'invalid.md');
  await assert.rejects(cli('--offline', 'export-guide', invalid, '--lang', 'fr'));
  await assert.rejects(fs.access(invalid));
  await assert.rejects(cli('--offline', 'export-guide', path.join(dir, '选错格式.aib')));
  if (windows) {
    await fs.access(path.join(pkg, 'AIB.Browser.exe'));
    // Reject arbitrary protocols without opening a browser or invoking a shell command.
    await assert.rejects(
      exec(path.join(pkg, 'AIB.Browser.exe'), ['file:///C:/Windows/notepad.exe'], {
        windowsHide: true,
      }),
      (error: unknown) => (error as { code: number }).code === 1,
    );
  } else {
    await fs.access(path.join(dir, 'AIB.app', 'Contents', 'MacOS', 'AIB'));
    const plist = path.join(dir, 'AIB.app', 'Contents', 'Info.plist');
    const rank = await exec('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleDocumentTypes:0:LSHandlerRank',
      plist,
    ]);
    assert.equal(rank.stdout.trim(), 'Alternate');
  }
  for (const [content, code] of [
    [Buffer.from([0xff, 0xfe, 0x00, 0x80]), 'INVALID_ENCODING'],
    [Buffer.from('{"type":"image"}'), 'INVALID_AIB'],
  ] as const) {
    const foreign = path.join(dir, 'other-format.aib');
    await fs.writeFile(foreign, content);
    await assert.rejects(
      cli('--offline', 'validate', foreign),
      (e: unknown) => JSON.parse((e as { stderr: string }).stderr).error.code === code,
    );
    assert.deepEqual(await fs.readFile(foreign), content);
  }
  // Follow the public quick start using only the extracted CLI, guide and sample files.
  const budget = path.join(dir, 'review-budget.aib');
  await cli('--offline', 'save-as', path.join(pkg, 'examples/budget.aib'), budget);
  const total = async () =>
    (await cli('--offline', 'read', budget, '--sheet', '预算', '--range', 'D5', '--calculated'))
      .values[0][0];
  assert.equal(await total(), 14100);
  const draft = await cli(
    '--offline',
    'draft',
    budget,
    '--ops',
    path.join(pkg, 'examples/change-budget.json'),
  );
  assert.ok((await cli('--offline', 'diff', draft.id)).changes.length > 0);
  await cli('--offline', 'draft-validate', draft.id);
  await cli('--offline', 'apply', draft.id);
  assert.equal(await total(), 15100);
  for (const extension of ['xlsx', 'html']) {
    const output = path.join(dir, 'budget.' + extension);
    await cli('--offline', 'export', budget, output);
    assert.ok((await fs.stat(output)).size > 0);
  }
  const source = path.join(dir, '原始 表格.xlsx'),
    file = path.join(dir, '中文 空格.aib'),
    second = path.join(dir, '第二个.aib');
  const wb = new ExcelJS.Workbook(),
    ws = wb.addWorksheet('Sales');
  ws.addRows([
    ['商品', '金额'],
    ['A', 10],
    ['B', 20],
  ]);
  await wb.xlsx.writeFile(source);
  await cli('import', source, file);
  await cli('new', second);
  const ops = path.join(dir, 'ops.json');
  await fs.writeFile(
    ops,
    JSON.stringify([{ type: 'formula', sheet: 'Sales', cell: 'B4', formula: '=SUM(B2:B3)' }]),
  );
  const d = await cli('draft', file, '--ops', ops);
  await cli('draft-validate', d.id);
  assert.equal(
    (await cli('diff', d.id)).changes.some((x: { path: string }) =>
      x.path.endsWith('/formulas/B4'),
    ),
    true,
  );
  await cli('apply', d.id);
  assert.deepEqual(
    (await cli('read', file, '--sheet', 'Sales', '--range', 'B4', '--calculated')).values,
    [[30]],
  );
  const exported = path.join(dir, '结果.xlsx');
  await cli('export', file, exported);
  const out = new ExcelJS.Workbook();
  await out.xlsx.readFile(exported);
  assert.equal(out.getWorksheet('Sales')!.getCell('B4').result, 30);
  if (windows) {
    await exec(path.join(pkg, 'AIB.exe'), [file], { env, windowsHide: true, timeout: 20000 });
    const first = await cli('status');
    assert.equal(first.running, true);
    await exec(path.join(pkg, 'AIB.exe'), [file, second], {
      env,
      windowsHide: true,
      timeout: 20000,
    });
    const next = await cli('status');
    assert.equal(next.pid, first.pid);
  } else {
    await cli('open', file, '--no-browser');
    assert.equal((await cli('status')).running, true);
  }
  console.log(
    JSON.stringify({
      packagedCli: true,
      supplementalNotices: true,
      excludedDocumentDictionaries: fingerprints.length,
      quickStartBudget: [14100, 15100],
      offlineMarkdownGuide: true,
      browserHelperRejectsNonLocalUrls: windows,
      xlsxDraftRoundtrip: true,
      windowsLauncherColdWarm: windows,
      multipleFiles: windows,
      singleServer: true,
      node: await exec(runtime, ['--version']).then((r) => r.stdout.trim()),
      fileAssociation: 'Installer supplied; not changed during this test',
      browserLaunch: 'Suppressed for automated launcher test',
    }),
  );
} finally {
  await cli('stop').catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
}
