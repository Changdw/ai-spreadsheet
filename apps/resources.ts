import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { AibError } from '../packages/schema/index';
import { detectLanguage, isLanguage } from './language';

/** Export the bundled guide in the requested language, using the system locale by default. */
export async function exportGuide(
  target: unknown,
  resourceRoot: string,
  language: unknown = detectLanguage([Intl.DateTimeFormat().resolvedOptions().locale]),
) {
  if (typeof target !== 'string' || path.extname(target).toLowerCase() !== '.md')
    throw new AibError('INVALID_EXTENSION', '请选择 Markdown (.md) 文件');
  const file = path.resolve(target);
  const lang = isLanguage(language) ? language.slice(0, 2) : language;
  if (lang !== 'zh' && lang !== 'en')
    throw new AibError('INVALID_ARGUMENT', 'Supported guide languages are zh and en');
  const source = path.join(resourceRoot, 'skills/aib-workbook/references', lang, 'aib-offline.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.copyFile(source, file, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AibError('FILE_EXISTS', '目标文件已存在，请选择新的文件名');
    throw error;
  }
  return { file };
}
