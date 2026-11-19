import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const dependencies: Record<string, string[]> = {
  schema: [],
  'univer-adapter': ['schema'],
  core: ['schema', 'univer-adapter'],
  storage: ['schema', 'core'],
  conversion: ['schema', 'univer-adapter', 'core'],
  service: ['schema', 'core', 'storage', 'conversion', 'univer-adapter'],
};
it('keeps domain packages independent of application entry points and higher layers', async () => {
  const root = path.resolve('packages');
  for (const [owner, allowed] of Object.entries(dependencies)) {
    const folder = path.join(root, owner);
    for (const name of await fs.readdir(folder, { recursive: true })) {
      if (!name.endsWith('.ts')) continue;
      const file = path.join(folder, name);
      const source = await fs.readFile(file, 'utf8');
      for (const [, specifier] of source.matchAll(
        /\b(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g,
      )) {
        const dest = path
          .relative(root, path.resolve(path.dirname(file), specifier))
          .split(path.sep)[0];
        expect([owner, ...allowed], file + ' → ' + specifier).toContain(dest);
      }
    }
  }
});
