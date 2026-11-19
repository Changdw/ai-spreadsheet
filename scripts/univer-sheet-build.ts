import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Both bundlers consume the ESM layout module. Univer also inlines its US English dictionary.
export const univerDocSkeleton =
  /[\\/]@univerjs[\\/]engine-render[\\/]lib[\\/]es[\\/]doc-skeleton-[^\\/]+\.js$/;

export async function loadSheetLayout(file: string): Promise<string> {
  const source = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  if (
    createHash('sha256').update(source).digest('hex') !==
    'd2177db9cc19516b5c6184fb9ca53458abad3f6123e32e533ea83188750d4992'
  ) {
    throw new Error(
      'Review the Univer document layout and its dictionary licenses before upgrading.',
    );
  }
  const start = source.indexOf('// src/components/docs/layout/hyphenation/pattern-loaders.gen.ts');
  const end = source.indexOf('// src/components/docs/layout/hyphenation/tools.ts', start);
  const layout =
    source.slice(0, start) + 'const PATTERN_LOADERS = Object.create(null);\n' + source.slice(end);
  // With an empty pattern map the renderer uses its ordinary line breaker for every language.
  return layout
    .replace('\n\t\tthis._preloadPatterns();', '')
    .replace(/\n\t_preloadPatterns\(\) \{[^}]+\}/, '');
}
