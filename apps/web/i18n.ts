import type { Language } from '../language';
import zh from './locales/zh-CN.json';
import en from './locales/en-US.json';

export type MessageKey = keyof typeof zh;
const catalogs: Record<Language, Record<MessageKey, string>> = { 'zh-CN': zh, 'en-US': en };
let selected: Language = 'zh-CN';
export const language = () => selected;
export function setLanguage(value: Language) {
  selected = value;
}
export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  return catalogs[selected][key].replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

/** Update only explicitly marked UI nodes. Workbook names, cell text and inputs are user data. */
export function translatePage() {
  document.documentElement.lang = selected;
  for (const attr of ['', 'aria-label', 'title', 'placeholder']) {
    const marker = attr ? 'data-i18n-' + attr : 'data-i18n';
    for (const element of document.querySelectorAll('[' + marker + ']')) {
      const key = element.getAttribute(marker) as MessageKey;
      if (attr) element.setAttribute(attr, t(key));
      else element.textContent = t(key);
    }
  }
}
