import { language, t, type MessageKey } from './i18n';
import diagnostics from './locales/diagnostics.json';

// Older backends and file converters return diagnostics in either language. Translate their
// known messages only at the UI boundary, keeping machine codes and user-supplied locations.
const english = new Map(Object.entries(diagnostics));
const chinese = new Map(Object.entries(diagnostics).map(([zh, en]) => [en, zh]));
export function diagnosticText(text: string): string {
  const en = language() === 'en-US';
  const translated = (en ? english : chinese).get(text);
  if (translated) return translated;
  if (en && text.startsWith('无法读取旧版 Excel 工作簿：'))
    return (
      'Could not read the legacy Excel workbook: ' +
      text.slice('无法读取旧版 Excel 工作簿：'.length)
    );
  if (en && text.endsWith(' 超过旧版 XLS 的 65,536 行或 256 列上限，请导出为 XLSX'))
    return (
      text.slice(0, -' 超过旧版 XLS 的 65,536 行或 256 列上限，请导出为 XLSX'.length) +
      ' exceeds the XLS limit of 65,536 rows or 256 columns. Export as XLSX.'
    );
  if (en && text.endsWith(' 含有超过 32,767 个字符的文本'))
    return (
      text.slice(0, -' 含有超过 32,767 个字符的文本'.length) +
      ' contains text longer than 32,767 characters.'
    );
  if (!en && text.endsWith(' is outside AIB v1'))
    return text.slice(0, -' is outside AIB v1'.length) + ' 超出 AIB v1 的支持范围';
  return text;
}

export class InterfaceError extends Error {
  constructor(readonly key: MessageKey) {
    super(t(key));
  }
}
export function describeError(error: unknown) {
  if (error instanceof InterfaceError) return t(error.key);
  const e = error as Error & { code?: string };
  const text = e?.message ?? String(error);
  if (e?.code === 'EEXIST' || e?.code === 'FILE_EXISTS')
    return diagnosticText('目标文件已存在，请选择新的文件名');
  // These fields can contain arbitrary sheet names or addresses.
  if (
    ['DUPLICATE_SHEET', 'SHEET_NOT_FOUND', 'OUT_OF_BOUNDS', 'INVALID_DATE'].includes(e?.code ?? '')
  )
    return text;
  return diagnosticText(text);
}
export function describeIssues(details: unknown): string {
  if (!Array.isArray(details)) return JSON.stringify(details, null, 2);
  return details
    .map((item) => {
      if (typeof item?.location === 'string' && typeof item.message === 'string')
        return [item.location, diagnosticText(item.message)].join(' · ');
      return JSON.stringify(item);
    })
    .join('\n');
}
