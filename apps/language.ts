export type Language = 'zh-CN' | 'en-US';

export function isLanguage(value: unknown): value is Language {
  return value === 'zh-CN' || value === 'en-US';
}

export function detectLanguage(preferences: readonly string[]): Language {
  for (const locale of preferences) {
    const primary = locale.split('-')[0].toLowerCase();
    if (primary === 'zh') return 'zh-CN';
    if (primary === 'en') return 'en-US';
  }
  return 'en-US';
}
