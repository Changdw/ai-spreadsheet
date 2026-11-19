import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { newBook, serialize, validate } from '../packages/schema/index';
import { Engine } from '../packages/core/index';
import { atomicWrite, transact } from '../packages/storage/index';
const rows = Number(process.argv[2] ?? 10000),
  columns = Number(process.argv[3] ?? 20),
  kind = process.argv[4] ?? 'values';
process.env.AIB_HOME = path.resolve('.verification/benchmark-state');
const b = newBook(`${kind}-${rows}x${columns}`),
  s = b.sheets[0];
s.dimensions = { rows, columns };
s.data = Array.from({ length: rows }, (_, r) =>
  Array.from({ length: columns }, (_, c) => r * columns + c),
);
if (kind === 'formulas')
  for (let r = 0; r < rows; r++) {
    s.data[r][columns - 1] = null;
    const a = String.fromCharCode(64 + columns) + (r + 1);
    s.formulas[a] = `=SUM(A${r + 1}:${String.fromCharCode(63 + columns)}${r + 1})`;
  }
const file = path.resolve(`.verification/benchmark-${kind}-${rows}.aib`);
const t0 = performance.now(),
  text = serialize(b),
  t1 = performance.now();
await atomicWrite(file, text);
const t2 = performance.now();
const parsed = validate(JSON.parse(await fs.readFile(file, 'utf8'))),
  t3 = performance.now(),
  engine = new Engine(parsed),
  t4 = performance.now();
await engine.calculate();
const t5 = performance.now();
engine.book();
const t6 = performance.now();
engine.dispose();
await transact(file, [{ type: 'set', sheet: 'Sheet1', range: 'A1', values: [[10]] }]);
const t7 = performance.now();
const result = {
  rows,
  columns,
  kind,
  bytes: Buffer.byteLength(text),
  serializeMs: t1 - t0,
  persistMs: t2 - t1,
  readParseValidateMs: t3 - t2,
  engineInitializeMs: t4 - t3,
  calculateMs: t5 - t4,
  normalizeMs: t6 - t5,
  transactionMs: t7 - t6,
  peakRSSMiB: process.resourceUsage().maxRSS / 1024,
  node: process.version,
  platform: process.platform,
};
await fs.writeFile(file + '.metrics.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
