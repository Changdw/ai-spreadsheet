export function statistics(values: readonly (readonly unknown[])[]) {
  let count = 0,
    numericCount = 0,
    sum = 0,
    min = Infinity,
    max = -Infinity;
  for (const row of values)
    for (const v of row) {
      if (v !== null && v !== undefined && v !== '') count++;
      if (typeof v === 'number') {
        numericCount++;
        sum += v;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
  return {
    count,
    numericCount,
    sum,
    average: numericCount ? sum / numericCount : null,
    min: numericCount ? min : null,
    max: numericCount ? max : null,
  };
}
