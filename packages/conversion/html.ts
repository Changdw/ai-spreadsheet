import { numfmt, type ICellData, type IWorkbookData, type IStyleData } from '@univerjs/core';
import { evaluate } from '../core/index';
import { address, range, type Book, type Sheet } from '../schema/index';
import { filteredRows, toSnapshot } from '../univer-adapter/index';

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Keep ordinary worksheet spacing, but do not materialize a million empty rows for a distant cell. */
function visibleAxis(used: Set<number>, hidden: (index: number) => boolean) {
  const indices: number[] = [];
  let previous = -1;
  for (const n of [...used].sort((a, b) => a - b)) {
    if (n - previous <= 16) {
      for (let i = previous + 1; i < n; i++) if (!hidden(i)) indices.push(i);
    }
    if (!hidden(n)) indices.push(n);
    previous = n;
  }
  return indices;
}

function lowerBound(axis: number[], value: number) {
  let lo = 0,
    hi = axis.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (axis[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function styleCss(st: IStyleData) {
  const css: string[] = [];
  if (st.bl === 1) css.push('font-weight:bold');
  if (st.it === 1) css.push('font-style:italic');
  if (st.fs) css.push('font-size:' + st.fs + 'pt');
  if (st.ff) {
    const family = Array.from(st.ff, (c) => '\\' + c.codePointAt(0)!.toString(16) + ' ').join('');
    css.push('font-family:"' + family + '"');
  }
  if (st.cl?.rgb) css.push('color:' + st.cl.rgb);
  if (st.bg?.rgb) css.push('background-color:' + st.bg.rgb);
  if (st.ht) css.push('text-align:' + (['', 'left', 'center', 'right'][st.ht] || 'start'));
  if (st.vt) css.push('vertical-align:' + (['', 'top', 'middle', 'bottom'][st.vt] || 'middle'));
  const edge = st.bd?.t;
  if (edge?.s && edge.cl?.rgb)
    css.push('border:' + (edge.s === 5 ? 3 : edge.s === 2 ? 2 : 1) + 'px solid ' + edge.cl.rgb);
  return css.join(';');
}

function blankCells(count: number) {
  const cells: string[] = [];
  // HTML limits a single colspan to 1000.
  while (count > 0) {
    const span = Math.min(count, 1000);
    cells.push(span === 1 ? '<td></td>' : '<td colspan="' + span + '"></td>');
    count -= span;
  }
  return cells.join('');
}

function sheetTable(
  s: Sheet,
  snap: IWorkbookData,
  filtered: Set<number>,
  cssClasses: Map<string, string>,
  emptyLabel: string,
) {
  const sheet = snap.sheets[s.id],
    matrix = sheet.cellData ?? {};
  const usedRows = new Set<number>([0]),
    usedCols = new Set<number>([0]);
  for (const [key, cells] of Object.entries(matrix)) {
    usedRows.add(+key);
    for (const col of Object.keys(cells!)) usedCols.add(+col);
  }
  for (const r of Object.keys(s.rowMeta)) usedRows.add(+r);
  for (const c of Object.keys(s.columnMeta)) usedCols.add(+c);
  const merges = s.merges.map(range);
  for (const m of merges) {
    usedRows.add(m.startRow);
    usedRows.add(m.endRow);
    usedCols.add(m.startColumn);
    usedCols.add(m.endColumn);
  }
  const rows = visibleAxis(usedRows, (r) => !!s.rowMeta[r]?.hidden || filtered.has(r));
  const cols = visibleAxis(usedCols, (c) => !!s.columnMeta[c]?.hidden);
  if (!rows.length || !cols.length || (!Object.keys(matrix).length && !merges.length))
    return '<p class="empty">' + emptyLabel + '</p>';
  const colIndex = new Map(cols.map((c, i) => [c, i]));
  const spans = merges
    .map((m) => ({
      r: lowerBound(rows, m.startRow),
      end: lowerBound(rows, m.endRow + 1),
      c: lowerBound(cols, m.startColumn),
      right: lowerBound(cols, m.endColumn + 1),
      cell:
        s.rowMeta[m.startRow]?.hidden ||
        filtered.has(m.startRow) ||
        s.columnMeta[m.startColumn]?.hidden
          ? undefined
          : matrix[m.startRow]?.[m.startColumn],
    }))
    .filter((m) => m.r < m.end && m.c < m.right)
    .sort((a, b) => a.r - b.r);

  function cellHtml(cell: ICellData | undefined, attributes = '') {
    const st = typeof cell?.s === 'string' ? snap.styles[cell.s] : cell?.s;
    let cls = typeof cell?.v === 'number' ? 'num' : '';
    if (st) {
      const css = styleCss(st);
      if (css) {
        if (!cssClasses.has(css)) cssClasses.set(css, 's' + cssClasses.size);
        cls += ' ' + cssClasses.get(css);
      }
    }
    const v = cell?.v;
    let text = v == null ? '' : String(v);
    if (cell?.t === 3 && v != null) text = v ? 'TRUE' : 'FALSE';
    else if (typeof v === 'number' && st?.n?.pattern)
      text = numfmt.format(st.n.pattern, v, { dateSystem: snap.dateSystem });
    const content =
      text.length > 240 || text.split('\n', 5).length > 4
        ? '<details><summary>' +
          escape(text.slice(0, 90)) +
          '…</summary>' +
          escape(text) +
          '</details>'
        : escape(text);
    return (
      '<td' +
      (cls.trim() ? ' class="' + cls.trim() + '"' : '') +
      attributes +
      (cell?.f ? ' title="' + escape(cell.f) + '"' : '') +
      '>' +
      content +
      '</td>'
    );
  }
  const width = cols.reduce((w, c) => w + Math.max(1, s.columnMeta[c]?.size ?? 112), 50);
  const out = [
    '<div class="grid" tabindex="0" role="region" aria-label="' +
      escape(s.name) +
      '"><table style="width:' +
      width +
      'px"><colgroup><col class="rowno">',
  ];
  for (const c of cols)
    out.push('<col style="width:' + Math.max(1, s.columnMeta[c]?.size ?? 112) + 'px">');
  out.push('</colgroup><thead><tr><th></th>');
  for (const c of cols) out.push('<th scope="col">' + address(0, c).slice(0, -1) + '</th>');
  out.push('</tr></thead><tbody>');
  let nextMerge = 0,
    active: typeof spans = [];
  rows.forEach((r, i) => {
    active = active.filter((m) => m.end > i);
    while (nextMerge < spans.length && spans[nextMerge].r === i) active.push(spans[nextMerge++]);
    const entries = new Map<number, { end: number; html: string }>();
    for (const [key, cell] of Object.entries(matrix[r] ?? {})) {
      const c = colIndex.get(+key);
      if (c !== undefined) entries.set(c, { end: c + 1, html: cellHtml(cell) });
    }
    // Native table spans are limited to 1000 columns and 65534 rows. Tile larger merges
    // so subsequent cells keep their correct position, with the value in the first tile.
    for (const m of active) {
      const startsTile = (i - m.r) % 65534 === 0;
      for (let c = m.c; c < m.right; c += 1000) {
        const end = Math.min(c + 1000, m.right);
        const attrs = ` rowspan="${Math.min(65534, m.end - i)}" colspan="${end - c}"`;
        const cell = i === m.r && c === m.c ? m.cell : { s: m.cell?.s };
        entries.set(c, { end, html: startsTile ? cellHtml(cell, attrs) : '' });
      }
    }
    out.push(
      '<tr' +
        (s.rowMeta[r]?.size ? ' style="height:' + s.rowMeta[r].size + 'px"' : '') +
        '><th scope="row">' +
        (r + 1) +
        '</th>',
    );
    let cursor = 0;
    for (const [c, entry] of [...entries].sort((a, b) => a[0] - b[0])) {
      if (c < cursor) continue;
      out.push(blankCells(c - cursor), entry.html);
      cursor = entry.end;
    }
    out.push(blankCells(cols.length - cursor), '</tr>');
  });
  out.push('</tbody></table></div>');
  return out.join('');
}

/** Portable read-only snapshot. CSS sheet selection works even inside a scriptless iframe. */
export async function exportHtml(book: Book, language: 'zh-CN' | 'en-US' = 'zh-CN') {
  const snap = book.sheets.some((s) => Object.keys(s.formulas).length)
    ? await evaluate(book)
    : toSnapshot(book);
  const filtered = filteredRows(snap, book),
    cssClasses = new Map<string, string>();
  const tables = book.sheets.map((sheet, i) => {
    const hidden = new Set(Object.hasOwn(filtered, sheet.id) ? filtered[sheet.id] : []);
    const table = sheetTable(
      sheet,
      snap,
      hidden,
      cssClasses,
      language === 'en-US' ? 'No visible cells' : '没有可显示的单元格',
    );
    return `<section id="panel-${i}" aria-label="${escape(sheet.name)}">${table}</section>`;
  });
  const tabCss = book.sheets
    .map(
      (_, i) => `
    #tab-${i}:checked ~ #panel-${i} { display: block }
    #tab-${i}:checked ~ nav [for="tab-${i}"] { color: #125d44; border-color: #147650; font-weight: 650 }
    #tab-${i}:focus-visible ~ nav [for="tab-${i}"] { outline: 2px solid #137653; outline-offset: -2px }
  `,
    )
    .join('\n');
  const radio = book.sheets
    .map(
      (sheet, i) =>
        `<input type="radio" class="tab" name="sheet" id="tab-${i}" aria-controls="panel-${i}" aria-label="${escape(sheet.name)}"${i === 0 ? ' checked' : ''}>`,
    )
    .join('\n');
  const tabs = book.sheets
    .map((sheet, i) => `<label for="tab-${i}">${escape(sheet.name)}</label>`)
    .join('\n');
  const styles = [...cssClasses].map(([css, name]) => `td.${name}{${css}}`).join('\n');
  const name = escape(book.name);
  const html = `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${name}</title><style>
* { box-sizing: border-box }
body { margin: 0; background: #fff; color: #21362e; font: 14px/1.45 system-ui,"Microsoft YaHei",sans-serif }
main { padding: clamp(8px,2vw,24px) } h1 { font-size: 22px; margin: 0 0 12px }
nav { display: flex; gap: 4px; overflow-x: auto; margin: 0 0 8px }
label { padding: 6px 12px; white-space: nowrap; cursor: pointer; border-bottom: 3px solid transparent }
.tab { position: absolute; width: 1px; height: 1px; opacity: 0 }
.grid { overflow: auto; max-height: 76vh; border: 1px solid #d4ded8 } section { display: none } .empty { color: #546b60 }
table { border-collapse: separate; border-spacing: 0; table-layout: fixed; min-width: 100% }
th, td { padding: 4px 8px; border: 0; border-right: 1px solid #dbe3de; border-bottom: 1px solid #dbe3de;
  text-align: left; vertical-align: middle; overflow-wrap: anywhere; white-space: pre-wrap }
th { background: #eff4f1; font-size: 12px; text-align: center; font-weight: 500 }
thead th { position: sticky; top: 0; z-index: 2 } .rowno { width: 50px } tbody th { position: sticky; left: 0; z-index: 1 }
.num { text-align: right } summary { cursor: pointer; white-space: nowrap; text-overflow: ellipsis; overflow: hidden }
details[open] summary { color: #476357 }
${tabCss}\n${styles}
</style></head><body><main><h1>${name}</h1>
${radio}<nav aria-label="${language === 'en-US' ? 'Worksheets' : '工作表'}">${tabs}</nav>${tables.join('\n')}
</main></body></html>\n`;
  return { buffer: Buffer.from(html), issues: [] };
}
