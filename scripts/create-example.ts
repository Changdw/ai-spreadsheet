import { promises as fs } from 'node:fs';
import { emptySheet, newBook, serialize } from '../packages/schema/index';
import { readRange } from '../packages/core/index';
const book = newBook('月度预算');
book.id = 'aib-example-budget-v1';
const s = emptySheet('budget', '预算', 200, 16);
s.data = [
  ['项目', '数量', '单价', '金额'],
  ['设计调研', 2, 1200, null],
  ['原型开发', 5, 1800, null],
  ['测试与验收', 3, 900, null],
  ['合计', null, null, null],
];
s.formulas = { D2: '=B2*C2', D3: '=B3*C3', D4: '=B4*C4', D5: '=SUM(D2:D4)' };
s.styleRules = [
  { range: 'A1:D1', style: { bold: true, background: '#166E50', color: '#FFFFFF' } },
  { range: 'C2:D5', style: { numberFormat: '¥#,##0.00' } },
  { range: 'A5:D5', style: { bold: true, background: '#E8F3EC' } },
];
s.columnMeta = { '0': { size: 200 }, '1': { size: 90 }, '2': { size: 140 }, '3': { size: 160 } };
s.rowMeta = { '0': { size: 32 } };
s.freeze = { rows: 1, columns: 1 };
const summary = emptySheet('summary', '汇总');
summary.data = [
  ['项目', '值'],
  ['总预算', null],
  ['更新日期', '2026-11-17'],
  ['已审批', false],
  ['备注', '此文件为纯 JSON。可由 CLI、AI 或文本编辑器修改。'],
];
summary.formulas.B2 = "='预算'!D5";
summary.cellTypes.B3 = 'date';
summary.styleRules = [{ range: 'B3', style: { numberFormat: 'yyyy-mm-dd' } }];
summary.columnMeta = { '0': { size: 160 }, '1': { size: 430 } };
book.sheets = [s, summary];
await fs.mkdir('examples', { recursive: true });
await fs.writeFile('examples/budget.aib', serialize(book));
await fs.writeFile(
  'examples/change-budget.json',
  JSON.stringify([{ type: 'set', sheet: '预算', range: 'C3', values: [[2000]] }], null, 2) + '\n',
);
console.log(
  JSON.stringify({
    example: 'examples/budget.aib',
    total: await readRange(book, '预算', 'D5', true),
  }),
);
