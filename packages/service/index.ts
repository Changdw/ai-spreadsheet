import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AibError, newBook, validate } from '../schema/index';
import { getSheet, readRange, readRangeResult, evaluate, diff } from '../core/index';
import { fromSnapshot } from '../univer-adapter/index';
import * as store from '../storage/index';
import type { IWorkbookData } from '@univerjs/core';
import { statistics } from '../core/stats';
import { address } from '../schema/index';

import { requiredString, type Request } from './request';
import { schemas, capabilities, workbookContext } from './context';
import { importWorkbook, exportWorkbook } from './formats';
export { errorResult, type Request } from './request';
export async function execute(req: Request): Promise<unknown> {
  if (!req || typeof req.command !== 'string')
    throw new AibError('INVALID_ARGUMENT', 'Command required');
  const a = req.args ?? {},
    file = req.file;
  if (req.command === 'schema') return schemas();
  if (req.command === 'capabilities') return capabilities();
  if (req.command === 'context') return workbookContext(file);
  if (req.command === 'diff') return store.draftDiff(requiredString(a, 'id'));
  if (req.command === 'draft-edit') return store.editDraft(requiredString(a, 'id'), a.operations);
  if (req.command === 'draft-validate') {
    const d = await store.readDraft(requiredString(a, 'id'));
    await evaluate(d.book);
    return { id: d.id, valid: true, baseHash: d.baseHash };
  }
  if (req.command === 'draft-discard') return store.discardDraft(requiredString(a, 'id'));
  if (req.command === 'apply') return store.applyDraft(requiredString(a, 'id'));
  if (!file || typeof file !== 'string')
    throw new AibError('INVALID_ARGUMENT', 'File path required');
  switch (req.command) {
    case 'stats':
      return statistics(
        await readRange(
          (await store.load(file)).book,
          requiredString(a, 'sheet'),
          requiredString(a, 'range'),
          true,
        ),
      );
    case 'find': {
      const b = (await store.load(file)).book,
        search = requiredString(a, 'text'),
        matches: { sheet: string; cell: string; value: unknown }[] = [];
      const sheets = a.sheet ? [getSheet(b, requiredString(a, 'sheet'))] : b.sheets;
      for (const s of sheets) {
        s.data.forEach((row, r) =>
          row.forEach((v, c) => {
            if (v !== null && String(v).includes(search))
              matches.push({ sheet: s.name, cell: address(r, c), value: v });
          }),
        );
        for (const [cell, value] of Object.entries(s.formulas))
          if (value.includes(search)) matches.push({ sheet: s.name, cell, value });
      }
      return { matches };
    }
    case 'new':
      return store.create(
        file,
        newBook(typeof a.name === 'string' ? a.name : path.basename(file, '.aib')),
      );
    case 'save-as':
      return store.create(requiredString(a, 'target'), (await store.load(file)).book);
    case 'revision':
      return {
        file: await store.canonical(file),
        hash: store.hash(await fs.readFile(await store.canonical(file))),
      };
    case 'inspect':
    case 'validate':
      return store.load(file);
    case 'read': {
      const b = await store.load(file);
      return {
        file: b.file,
        hash: b.hash,
        ...(await readRangeResult(
          b.book,
          requiredString(a, 'sheet'),
          requiredString(a, 'range'),
          a.calculated === true,
        )),
      };
    }
    case 'fill':
      return store.transact(
        file,
        [
          {
            type: 'fill',
            sheet: requiredString(a, 'sheet'),
            range: requiredString(a, 'range'),
            target: requiredString(a, 'to'),
          },
        ],
        typeof a.expectedHash === 'string' ? a.expectedHash : undefined,
      );
    case 'batch': {
      const result = await store.transact(
        file,
        a.operations,
        typeof a.expectedHash === 'string' ? a.expectedHash : undefined,
      );
      if (a.includeBook === false) return { hash: result.hash, warnings: result.warnings };
      return result;
    }
    case 'snapshot': {
      const b = await store.load(file);
      return { ...b, snapshot: await evaluate(b.book) };
    }
    case 'save-snapshot': {
      const b = await store.load(file),
        expectedHash = requiredString(a, 'expectedHash');
      if (b.hash !== expectedHash)
        throw new AibError('CONFLICT', 'File changed; reload or preserve your edits as a draft');
      if (!a.snapshot || typeof a.snapshot !== 'object')
        throw new AibError('INVALID_ARGUMENT', 'snapshot required');
      const book = fromSnapshot(a.snapshot as IWorkbookData, b.book);
      return store.transact(file, [{ type: 'replace', book }], expectedHash);
    }
    case 'undo':
    case 'redo':
      return store.travel(
        file,
        req.command,
        typeof a.expectedHash === 'string' ? a.expectedHash : undefined,
      );
    case 'draft':
      return store.draft(file, a.operations);
    case 'recovery':
      return store.recoveryList(file);
    case 'recover':
      return store.recover(file, requiredString(a, 'id'), requiredString(a, 'expectedHash'));
    case 'import':
      return importWorkbook(file, requiredString(a, 'source'), a.allowLossy === true);
    case 'export':
      return exportWorkbook((await store.load(file)).book, a);
    case 'export-memory':
      return exportWorkbook(validate(a.book), a);
    case 'compare': {
      const other = await store.load(requiredString(a, 'other'));
      return diff((await store.load(file)).book, other.book);
    }
    default:
      throw new AibError('UNKNOWN_COMMAND', req.command);
  }
}
