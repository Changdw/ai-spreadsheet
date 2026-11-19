import type { Cell } from './index';

export function parseCellLiteral(value: string): Cell {
  if (!value) return null;
  // Use numbers for ordinary measurements; keep identifiers and high-precision literals intact.
  if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
  const digits = value.replace(/\D/g, '').replace(/^0+/, '');
  const n = Number(value);
  return digits.length <= 15 && Number.isFinite(n) ? n : value;
}
