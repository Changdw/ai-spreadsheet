import { address, coords, range, type Book, type Sheet, AibError } from './index';

function covers(merge: ReturnType<typeof range>, row: number, column: number) {
  return (
    row >= merge.startRow &&
    row <= merge.endRow &&
    column >= merge.startColumn &&
    column <= merge.endColumn &&
    (row !== merge.startRow || column !== merge.startColumn)
  );
}

/** Older AIB files may retain literal values or formulas beneath a merged cell's anchor. */
export function* coveredCells(sheet: Sheet): Generator<string> {
  if (!sheet.merges.length) return;
  const merges = sheet.merges.map(range);
  for (const merge of merges) {
    const lastRow = Math.min(merge.endRow, sheet.data.length - 1);
    for (let row = merge.startRow; row <= lastRow; row++) {
      const values = sheet.data[row];
      const lastColumn = Math.min(merge.endColumn, values.length - 1);
      const firstColumn = merge.startColumn + (row === merge.startRow ? 1 : 0);
      for (let column = firstColumn; column <= lastColumn; column++)
        if (values[column] != null) yield address(row, column);
    }
  }
  // Formulas may exist beyond the literal-data rectangle.
  for (const cell of Object.keys(sheet.formulas)) {
    const [row, column] = coords(cell);
    if (merges.some((merge) => covers(merge, row, column))) yield cell;
  }
}

export function checkMergedEdits(before: Book, after: Book) {
  for (const sheet of after.sheets) {
    const previous = before.sheets.find((s) => s.id === sheet.id);
    let previouslyCovered: Set<string> | undefined;
    for (const cell of coveredCells(sheet)) {
      // Keep a legacy file editable, including clearing or unmerging previously hidden data.
      previouslyCovered ??= new Set(previous ? coveredCells(previous) : []);
      const [row, column] = coords(cell);
      if (
        !previous ||
        !previouslyCovered.has(cell) ||
        (previous.data[row]?.[column] ?? null) !== (sheet.data[row]?.[column] ?? null) ||
        previous.formulas[cell] !== sheet.formulas[cell] ||
        previous.cellTypes[cell] !== sheet.cellTypes[cell]
      )
        throw new AibError('MERGE_DATA_LOSS', `Unmerge before writing to ${sheet.name}!${cell}`);
    }
  }
}
