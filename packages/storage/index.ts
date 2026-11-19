import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { AibError, serialize, validate, type Book } from '../schema/index';
import { applyOperations, diff } from '../core/index';

export const home = () => path.resolve(process.env.AIB_HOME || path.join(os.homedir(), '.aib'));
export const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
export async function canonical(file: string, create = false) {
  const full = path.resolve(file);
  if (create) {
    await fs.mkdir(path.dirname(full), { recursive: true });
    try {
      return await fs.realpath(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return path.join(await fs.realpath(path.dirname(full)), path.basename(full));
    }
  }
  return fs.realpath(full);
}
const key = (file: string) => hash(process.platform === 'win32' ? file.toLowerCase() : file);
const maxWorkbookBytes = 100 * 1024 * 1024;
function checkFileSize(bytes: number) {
  if (bytes > maxWorkbookBytes) throw new AibError('CAPACITY_EXCEEDED', 'AIB file exceeds 100 MiB');
}
function workbookText(book: Book) {
  const text = serialize(book);
  checkFileSize(Buffer.byteLength(text, 'utf8'));
  return text;
}
async function checkDiskHash(file: string, expectedHash: string) {
  if (hash(await fs.readFile(file)) !== expectedHash)
    throw new AibError('CONFLICT', 'File changed outside AIB; reload before saving');
}
export async function load(file: string) {
  const real = await canonical(file),
    stat = await fs.stat(real);
  checkFileSize(stat.size);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await fs.readFile(real),
    );
  } catch {
    throw new AibError('INVALID_ENCODING', 'AIB must be UTF-8 text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new AibError('INVALID_JSON', 'AIB must contain valid UTF-8 JSON');
  }
  return { file: real, book: validate(parsed), hash: hash(text) };
}
export async function atomicWrite(
  file: string,
  text: string | Uint8Array,
  beforePublish?: () => Promise<void>,
) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforePublish?.();
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function locked<T>(
  file: string,
  action: (real: string) => Promise<T>,
  create = false,
): Promise<T> {
  const real = await canonical(file, create);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(real, {
      realpath: false,
      stale: 30000,
      retries: { retries: 15, minTimeout: 30, maxTimeout: 300 },
    });
  } catch {
    throw new AibError('FILE_BUSY', 'Another AIB process is writing this file');
  }
  try {
    return await action(real);
  } finally {
    await release();
  }
}
interface History {
  current: string;
  undo: string[];
  redo: string[];
}
const historyPath = (file: string) => path.join(home(), 'history', key(file) + '.json');
async function history(file: string, current: string): Promise<History> {
  try {
    const h = JSON.parse(await fs.readFile(historyPath(file), 'utf8')) as History;
    if (h.current === current && [...h.undo, ...h.redo].every((x) => typeof x === 'string'))
      return h;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return { current, undo: [], redo: [] };
}
async function saveHistory(file: string, h: History) {
  await atomicWrite(historyPath(file), JSON.stringify(h));
}
async function finishHistory(file: string, h: History): Promise<string[]> {
  try {
    await saveHistory(file, h);
  } catch {
    return ['Workbook saved, but undo history could not be updated; use recovery snapshots.'];
  }
  const dir = path.join(home(), 'recovery', key(file));
  try {
    const names = (await fs.readdir(dir))
      .filter((x) => x.endsWith('.json'))
      .sort()
      .reverse();
    const keep = new Set([...names.slice(0, 50), ...h.undo, ...h.redo]);
    for (const name of names) if (!keep.has(name)) await fs.rm(path.join(dir, name));
  } catch {
    return ['Workbook saved; recovery snapshot cleanup will be retried on the next save.'];
  }
  return [];
}
async function commit(real: string, before: Awaited<ReturnType<typeof load>>, book: Book) {
  const text = workbookText(book),
    afterHash = hash(text);
  if (afterHash === before.hash)
    return { file: real, hash: before.hash, book, changed: false, journalId: '' };
  // Persist both versions before replacing the original: recovery survives a killed process.
  const journal = {
    file: real,
    createdAt: new Date().toISOString(),
    beforeHash: before.hash,
    afterHash,
    before: before.book,
    after: book,
  };
  const journalId = `${Date.now()}-${randomUUID()}.json`;
  await atomicWrite(path.join(home(), 'recovery', key(real), journalId), JSON.stringify(journal));
  await atomicWrite(real, text, () => checkDiskHash(real, before.hash));
  return { file: real, hash: afterHash, book, changed: true, journalId };
}
export async function create(file: string, book: Book) {
  validate(book);
  return locked(
    file,
    async (real) => {
      const text = workbookText(book);
      // Exclusive creation never overwrites an existing workbook.
      const temporary = real + '.' + randomUUID() + '.tmp';
      try {
        const f = await fs.open(temporary, 'wx', 0o600);
        try {
          await f.writeFile(text, 'utf8');
          await f.sync();
        } finally {
          await f.close();
        }
        await fs.link(temporary, real);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return { file: real, hash: hash(text), book };
    },
    true,
  );
}
export async function transact(file: string, ops: unknown, expectedHash?: string) {
  return locked(file, async (real) => {
    const before = await load(real);
    if (expectedHash && expectedHash !== before.hash)
      throw new AibError('CONFLICT', 'File changed since it was read', {
        expectedHash,
        actualHash: before.hash,
      });
    const book = await applyOperations(before.book, ops),
      h = await history(real, before.hash),
      result = await commit(real, before, book);
    const warnings = result.changed
      ? await finishHistory(real, {
          current: result.hash,
          undo: [...h.undo, result.journalId].slice(-50),
          redo: [],
        })
      : [];
    return { ...result, warnings };
  });
}
export async function travel(file: string, direction: 'undo' | 'redo', expectedHash?: string) {
  return locked(file, async (real) => {
    const before = await load(real);
    if (expectedHash && expectedHash !== before.hash)
      throw new AibError('CONFLICT', 'File changed');
    const h = await history(real, before.hash),
      source = h[direction],
      journalId = source.pop();
    if (!journalId)
      throw new AibError('NO_HISTORY', `Nothing to ${direction}; external edits reset history`);
    if (!/^[0-9]+-[a-f0-9-]+\.json$/.test(journalId))
      throw new AibError('INVALID_HISTORY', 'Invalid snapshot id');
    const journal = JSON.parse(
      await fs.readFile(path.join(home(), 'recovery', key(real), journalId), 'utf8'),
    );
    const result = await commit(real, before, validate(journal.before));
    if (result.changed) h[direction === 'undo' ? 'redo' : 'undo'].push(result.journalId);
    h.current = result.hash;
    const warnings = await finishHistory(real, h);
    return { ...result, warnings };
  });
}
interface Draft {
  id: string;
  file: string;
  baseHash: string;
  base: Book;
  book: Book;
}
const draftPath = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AibError('INVALID_DRAFT', 'Invalid draft id');
  return path.join(home(), 'drafts', id + '.json');
};
export async function readDraft(id: string): Promise<Draft> {
  const d = JSON.parse(await fs.readFile(draftPath(id), 'utf8')) as Draft;
  validate(d.base);
  validate(d.book);
  return d;
}
export async function draft(file: string, ops: unknown) {
  const before = await load(file),
    book = await applyOperations(before.book, ops),
    id = randomUUID();
  const d: Draft = { id, file: before.file, baseHash: before.hash, base: before.book, book };
  await atomicWrite(draftPath(id), JSON.stringify(d));
  return { id, file: d.file, baseHash: d.baseHash, changes: diff(d.base, d.book) };
}
export async function draftDiff(id: string) {
  const d = await readDraft(id);
  return { id, file: d.file, baseHash: d.baseHash, changes: diff(d.base, d.book) };
}
export async function editDraft(id: string, ops: unknown) {
  return locked(draftPath(id), async () => {
    const d = await readDraft(id);
    d.book = await applyOperations(d.book, ops);
    await atomicWrite(draftPath(id), JSON.stringify(d));
    return draftDiff(id);
  });
}
export async function discardDraft(id: string) {
  return locked(draftPath(id), async () => {
    await fs.rm(draftPath(id));
    return { id, discarded: true };
  });
}
export async function applyDraft(id: string) {
  return locked(draftPath(id), async () => {
    const d = await readDraft(id);
    const result = await transact(d.file, [{ type: 'replace', book: d.book }], d.baseHash);
    try {
      await fs.rm(draftPath(id));
    } catch {
      result.warnings.push('Workbook saved; the applied draft could not be removed.');
    }
    return result;
  });
}
export async function recoveryList(file: string) {
  const dir = path.join(home(), 'recovery', key(await canonical(file)));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return Promise.all(
    names
      .filter((x) => x.endsWith('.json'))
      .sort()
      .reverse()
      .map(async (name) => {
        const j = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        return {
          id: name,
          createdAt: j.createdAt,
          beforeHash: j.beforeHash,
          afterHash: j.afterHash,
        };
      }),
  );
}
export async function recover(file: string, id: string, expectedHash: string) {
  if (!/^[0-9]+-[a-f0-9-]+\.json$/.test(id))
    throw new AibError('INVALID_RECOVERY', 'Invalid recovery id');
  const real = await canonical(file),
    j = JSON.parse(await fs.readFile(path.join(home(), 'recovery', key(real), id), 'utf8'));
  return locked(real, async () => {
    const raw = await fs.readFile(real);
    if (hash(raw) !== expectedHash) throw new AibError('CONFLICT', 'File changed before recovery');
    const book = validate(j.before),
      text = workbookText(book);
    await atomicWrite(
      path.join(home(), 'recovery', key(real), `${Date.now()}-${randomUUID()}.damaged`),
      raw,
    );
    await atomicWrite(real, text, () => checkDiskHash(real, expectedHash));
    return { file: real, hash: hash(text), book };
  });
}
