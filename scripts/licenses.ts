import { promises as fs } from 'node:fs';
import path from 'node:path';
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const entries: { name: string; version: string; license: string; files: string[] }[] = [];
// Notices omitted from the published tarball, or required for embedded components.
const supplements: Record<string, Record<string, string>> = {
  // https://github.com/dream-num/univer/blob/v1.5.2/LICENSE
  '@univerjs/protocol@1.5.2': { 'UPSTREAM-LICENSE.txt': 'univer-1.5.2.txt' },
  'binary@0.3.0': { 'MIT-NOTICE.txt': 'halliday-mit.txt' },
  'buffers@0.1.1': { 'UPSTREAM-LICENSE.txt': 'buffers-0.1.1.txt' },
  'chainsaw@0.1.0': { 'MIT-NOTICE.txt': 'halliday-mit.txt' },
  // https://github.com/wooorm/franc/blob/6.2.0/license
  'franc-min@6.2.0': { 'UPSTREAM-LICENSE.txt': 'franc-6.2.0.txt' },
  // https://github.com/lddubeau/saxes/blob/v5.0.1/LICENSE
  'saxes@5.0.1': { 'UPSTREAM-LICENSE.txt': 'saxes-5.0.1.txt' },
  // This tarball declares MIT. Its maintainer also published the license text in the repository.
  // https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE
  'react-remove-scroll-bar@2.3.8': { 'UPSTREAM-LICENSE.txt': 'react-remove-scroll-bar-MIT.txt' },
  '@univerjs/engine-render@1.5.2': {
    'HYPHEN-LICENSE.txt': 'hyphen-1.10.3.txt',
    'AIB-CHANGES.txt': 'univer-engine-render-1.5.2-changes.txt',
  },
};
await fs.mkdir('dist/licenses', { recursive: true });
for (const [location, value] of Object.entries(lock.packages) as [
  string,
  { dev?: boolean; optional?: boolean; version: string; license?: string },
][]) {
  if (!location || value.dev) continue;
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && value.optional) continue;
    throw error;
  }
  const out = path.join('dist/licenses', pkg.name.replaceAll('/', '__') + '-' + value.version);
  await fs.mkdir(out, { recursive: true });
  const names: string[] = [];
  const top = await fs.readdir(location, { withFileTypes: true });
  for (const entry of top) {
    if (
      entry.isFile() &&
      /^(licenses?|licences?|notices?|copying|copyright)([._ -]|$)/i.test(entry.name)
    )
      names.push(entry.name);
  }
  if (!names.length) {
    // Some published tarballs carry their only attribution in the README or package metadata.
    names.push(
      'package.json',
      ...top
        .filter((entry) => entry.isFile() && /^readme([._-]|$)/i.test(entry.name))
        .map((entry) => entry.name),
    );
  }
  for (const n of names) await fs.copyFile(path.join(location, n), path.join(out, n));
  let license = pkg.license ?? value.license ?? 'SEE PACKAGE';
  if (pkg.name === 'buffers' && value.version === '0.1.1') {
    // The tarball predates the maintainer's explicit MIT/X11 declaration.
    license = 'MIT/X11';
  }
  for (const [name, source] of Object.entries(supplements[pkg.name + '@' + value.version] ?? {})) {
    await fs.copyFile(path.join('scripts/notices', source), path.join(out, name));
    names.push(name);
  }
  entries.push({
    name: pkg.name,
    version: value.version,
    license,
    files: names,
  });
}
await fs.writeFile(
  'dist/dependencies.json',
  JSON.stringify(
    entries.sort((a, b) => a.name.localeCompare(b.name)),
    null,
    2,
  ),
);
console.log(`Collected notices for ${entries.length} dependencies`);
