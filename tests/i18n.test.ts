import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { detectLanguage, isLanguage } from '../apps/language';
import en from '../apps/web/locales/en-US.json';
import zh from '../apps/web/locales/zh-CN.json';
import { setLanguage, t } from '../apps/web/i18n';
import { describeIssues } from '../apps/web/diagnostics';

it('matches browser preferences in order and falls back to English', () => {
  expect(detectLanguage(['fr-FR', 'zh-Hant', 'en-GB'])).toBe('zh-CN');
  expect(detectLanguage(['en-AU', 'zh-CN'])).toBe('en-US');
  expect(detectLanguage(['ja-JP'])).toBe('en-US');
  expect(isLanguage('auto')).toBe(false);
});

it('ships matching keys, parameters and translations for every marked HTML element', async () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  const parameters = (s: string) => Array.from(s.matchAll(/\{\w+\}/g), (m) => m[0]).sort();
  for (const [key, source] of Object.entries(zh)) {
    expect(parameters(en[key as keyof typeof en]), key).toEqual(parameters(source));
  }
  const html = await readFile('apps/web/index.html', 'utf8');
  for (const [, key] of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) {
    expect(en, key).toHaveProperty(key);
  }
});

it('keeps workbook text literal when interpolating messages and converting loss reports', () => {
  setLanguage('en-US');
  expect(t('exported', { file: '表格/{file}/$&.xlsx' })).toBe('Exported to 表格/{file}/$&.xlsx');
  expect(
    describeIssues([{ location: '保存', message: '旧版 XLS 导出将公式保存为当前计算结果' }]),
  ).toBe('保存 · Legacy XLS export saves formulas as their current calculated values.');
  setLanguage('zh-CN');
});
