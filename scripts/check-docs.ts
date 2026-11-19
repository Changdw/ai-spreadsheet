import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validate } from '../packages/schema/index';

const pages = ['aib-quickstart', 'usage', 'installation', 'architecture'];
const docs = path.resolve('docs/guide');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
async function checkLinks(file: string) {
  const source = await fs.readFile(file, 'utf8');
  const links = file.endsWith('.html') ? /(?:href|src)="([^"#]+)"/g : /\]\(([^)]+)\)/g;
  const markup = source.replace(/<code>[\s\S]*?<\/code>/g, '');
  for (const [, href] of markup.matchAll(links))
    if (!/^https?:/.test(href)) await fs.access(path.resolve(path.dirname(file), href));
  return source;
}
for (const name of pages) await checkLinks(path.join(docs, name + '.html'));
await checkLinks('README.md');
await checkLinks('skills/aib-workbook/SKILL.md');
await checkLinks('skills/aib-workbook/references/aib-offline.md');
for (const lang of ['zh', 'en']) {
  await checkLinks('README.' + lang + '.md');
  for (const name of pages) {
    const file = name + '.html';
    const source = await checkLinks(path.join(docs, lang, file));
    assert.ok(source.includes('<html lang="' + (lang === 'zh' ? 'zh-CN' : 'en') + '">'));
    assert.ok(source.includes('../' + (lang === 'zh' ? 'en' : 'zh') + '/' + file), file);
    if (lang === 'en') {
      const main = source.match(/<main>([\s\S]+)<\/main>/)![1];
      assert.doesNotMatch(main.replace(/<code>[\s\S]*?<\/code>/g, ''), /\p{Script=Han}/u);
    }
    for (const snippet of source.matchAll(/<figure>([\s\S]*?)<\/figure>/g)) {
      assert.ok(snippet[1].includes('data-copy') && snippet[1].includes('<code>'), file);
    }
    if (name === 'usage')
      for (const script of Object.keys(pkg.scripts))
        assert.ok(source.includes('<td>' + script + '</td>'), lang + ' missing script ' + script);
  }
  const guide = await fs.readFile(
    'skills/aib-workbook/references/' + lang + '/aib-offline.md',
    'utf8',
  );
  const sample = guide.match(/\x60{3}json\s+([\s\S]*?)\x60{3}/);
  assert.ok(sample);
  validate(JSON.parse(sample[1]));
  if (lang === 'en') assert.doesNotMatch(guide, /\p{Script=Han}/u);
}
console.log('Verified zh/en guides, links, npm scripts, copy controls and both AIB samples.');
