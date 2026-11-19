import { t, language, setLanguage, translatePage } from './i18n';
import { installLanguageSetting } from './language-setting';
import { InterfaceError, describeError, describeIssues, diagnosticText } from './diagnostics';
import { api, token } from './api';
import { parseCellLiteral } from '../../packages/schema/literal';
import { createUniver, LocaleType } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import enUS from '@univerjs/preset-sheets-core/locales/en-US';
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import {
  fromSnapshot,
  toStyle,
  expandSharedFormulas,
  serialDate,
} from '../../packages/univer-adapter/index';
import { address, serialize, type Style, type Book } from '../../packages/schema/index';
import {
  CommandType,
  DEFAULT_STYLES,
  LifecycleService,
  LifecycleStages,
  numfmt,
  type IDisposable,
  type IWorkbookData,
  type IUndoRedoItem,
} from '@univerjs/core';
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort';
import { LocalEdits } from './local-edits';
import { AutoSave } from './autosave';
import { createColorPalette } from './color-palette';
import type { Operation } from '../../packages/core/index';
import { statistics } from '../../packages/core/stats';
import {
  AibEngineGuardPlugin,
  assertScalarFormulas,
} from '../../packages/univer-adapter/guard-plugin';
import type { FormulaDataModel } from '@univerjs/engine-formula';
import './style.css';
import type { DialogKind } from '../server/file-dialog';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let id = new URLSearchParams(location.search).get('book'),
  original: Omit<Book, 'sheets'>,
  revision = '',
  instance: ReturnType<typeof createUniver> | undefined;
let savedHead: IUndoRedoItem | null = null,
  lastHead: IUndoRedoItem | null = null;
let rootExpired = false,
  lastUndoCount = 0,
  saving: Promise<void> | null = null;
let conflicted = false,
  installing = false,
  fileBusy = false,
  pickingFile = false;
let saveFailed = false,
  automaticWrite = false;
const autoSave = new AutoSave(() => {
  if (dirty && !autoSavePaused()) void save(true).catch(showError);
});
let edits: LocalEdits;
let activeSheet = 'Sheet1',
  activeRange = 'A1',
  dirty = false;
let editing = false,
  formulaPending: { workbookId: string; sheetId: string; cell: string } | null = null,
  editSequence = 0;
let formulaModel: FormulaDataModel | undefined;
let renderReady: Promise<void>;
let refreshSelection: (() => void) | undefined;
let workbookListeners: IDisposable[] = [];
function editorLocale() {
  return language() === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US;
}
function status(text: string, state = 'ok') {
  $('status').textContent = text;
  $('status').dataset.state = state;
}
let messageContent: () => string = () => '';
function message(content: () => string = () => '') {
  messageContent = content;
  const text = content();
  $('message').textContent = text;
  $('message').hidden = !text;
}
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const themeSelect = $<HTMLSelectElement>('theme');
let themeWrites = Promise.resolve(),
  themeSequence = 0;
function displayTheme(value: string | null) {
  themeSelect.value = value === 'light' || value === 'dark' ? value : 'system';
  const dark =
    themeSelect.value === 'dark' || (themeSelect.value === 'system' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  instance?.univerAPI.toggleDarkMode(dark);
}
const themeKey = 'aib-theme';
displayTheme(localStorage.getItem(themeKey));
systemTheme.addEventListener('change', () => displayTheme(themeSelect.value));
window.addEventListener('storage', (e) => {
  if (e.key === themeKey) {
    themeSequence++;
    displayTheme(e.newValue);
  }
});
themeSelect.onchange = () => {
  const theme = themeSelect.value;
  themeSequence++;
  displayTheme(theme);
  localStorage.setItem(themeKey, theme);
  if (token)
    themeWrites = themeWrites
      .then(() => api('/api/theme', { theme }))
      .catch((e) => message(() => describeError(e)));
};
if (token)
  void api('/api/theme')
    .then((theme) => {
      if (!themeSequence) {
        displayTheme(theme);
        localStorage.setItem(themeKey, theme);
      }
    })
    .catch(() => {
      /* Cached preference is usable while the service is unavailable. */
    });
async function execute(command: string, args: Record<string, unknown> = {}) {
  if (!id) throw new InterfaceError('needBook');
  return api(`/api/books/${id}`, { command, args });
}
function snapshot() {
  assertScalarFormulas(formulaModel, original.id);
  const wb = instance!.univerAPI.getActiveWorkbook()!;
  const s = expandSharedFormulas(wb.save(), (sheet, cell) =>
    wb.getSheetBySheetId(sheet)!.getRange(cell).getFormula(),
  );
  return s;
}
function current() {
  return fromSnapshot(snapshot(), original);
}
function markConflict() {
  conflicted = true;
  $('conflict').hidden = false;
  refreshStatus();
}
function autoSavePaused() {
  return (
    !id ||
    !!saving ||
    fileBusy ||
    installing ||
    pickingFile ||
    editing ||
    !!formulaPending ||
    conflicted
  );
}
function refreshStatus() {
  autoSave.update(dirty, autoSavePaused());
  $('save').toggleAttribute(
    'disabled',
    !id || !!saving || fileBusy || !(dirty || editing || formulaPending) || conflicted,
  );
  $('syncDisk').toggleAttribute('disabled', !id || fileBusy || !!saving);
  if (!id) status(t('ready'));
  else if (conflicted) status(t('conflicted'), 'error');
  else if (saving) status(automaticWrite ? t('autosaving') : t('saving'), 'busy');
  else if (editing || formulaPending) status(t('editing'), 'busy');
  else if (dirty && saveFailed) status(t('retry'), 'error');
  else status(dirty ? t('pending') : t('saved'), dirty ? 'busy' : 'ok');
}
function changed() {
  const wb = instance?.univerAPI.getActiveWorkbook();
  if (installing || !wb || !edits) return;
  const { undos: count, redos } = edits.history.getUndoRedoStatus(wb.id);
  const head = count ? edits.history.pitchTopUndoElement() : null;
  if (count && head?.unitID !== wb.id) return;
  if (head !== lastHead) {
    // A new undo item at the same depth means the oldest item was evicted.
    if (count > 0 && count === lastUndoCount && !redos) rootExpired = true;
    lastHead = head ?? null;
    editSequence++;
    autoSave.recordEdit();
  }
  lastUndoCount = count;
  dirty = lastHead !== savedHead || (!lastHead && rootExpired && !savedHead);
  if (!dirty && !saving) saveFailed = false;
  refreshStatus();
}
function finishInput() {
  if (editing || formulaPending) throw new InterfaceError('finishInput');
}
function showError(error: unknown) {
  const e = error as Error & { code?: string; details?: unknown };
  if (e.code === 'CONFLICT') markConflict();
  message(() => `${e.code ? `${e.code} · ` : ''}${describeError(e)}`);
  if (!conflicted && !saveFailed) status(t('errorStatus'), 'error');
}
async function save(automatic = false) {
  if (saving) {
    const bookId = id;
    await saving;
    if (!automatic && id === bookId) await save();
    return;
  }
  if (fileBusy) throw new InterfaceError('reading');
  if (!automatic) {
    if (formulaPending) commitFormula();
    if (editing && !(await instance!.univerAPI.getActiveWorkbook()!.endEditingAsync(true)))
      throw new InterfaceError('finishInput');
  }
  if (saving) return save(automatic);
  if (fileBusy || installing || (automatic && autoSavePaused())) return;
  changed();
  if (!dirty) return;
  if (conflicted) throw new InterfaceError('externalChange');
  const head = lastHead,
    bookId = id;
  autoSave.reset();
  automaticWrite = automatic;
  saving = (async () => {
    const result = await execute('batch', {
      operations: [{ type: 'replace', book: current() }],
      expectedHash: revision,
      includeBook: false,
    });
    if (id !== bookId) return;
    revision = result.hash;
    savedHead = head;
    if (!head) rootExpired = false;
    if (!automatic || saveFailed || result.warnings?.length)
      message(() => (result.warnings ?? []).map(diagnosticText).join('\n'));
    saveFailed = false;
  })();
  refreshStatus();
  try {
    await saving;
  } catch (error) {
    if ((error as { code?: string }).code === 'CONFLICT') markConflict();
    else {
      saveFailed = true;
      autoSave.retryLater();
    }
    throw error;
  } finally {
    saving = null;
    changed();
  }
}
async function fileAction(action: () => Promise<void>) {
  if (fileBusy) throw new InterfaceError('busy');
  if (saving) await saving;
  if (fileBusy) throw new InterfaceError('busy');
  fileBusy = true;
  refreshStatus();
  try {
    await action();
  } finally {
    fileBusy = false;
    refreshStatus();
  }
}
function createEditor() {
  $('canvas').replaceChildren();
  const editor = createUniver({
    darkMode: document.documentElement.dataset.theme === 'dark',
    locale: editorLocale(),
    locales: { [LocaleType.ZH_CN]: zhCN, [LocaleType.EN_US]: enUS },
    presets: [
      UniverSheetsCorePreset({
        container: 'canvas',
        header: false,
        toolbar: false,
        contextMenu: false,
        formulaBar: true,
        sheets: { enableFillHandle: true },
      }),
    ],
  });
  editor.univer.registerPlugin(UniverSheetsSortPlugin);
  editor.univer.registerPlugin(AibEngineGuardPlugin, {
    ready: (model: FormulaDataModel, injector: import('@univerjs/core').Injector) => {
      renderReady = injector.get(LifecycleService).onStage(LifecycleStages.Rendered);
      edits = new LocalEdits(editor.univerAPI, injector, () => original.dateSystem);
      formulaModel = model;
    },
  });
  editor.univerAPI.addEvent(editor.univerAPI.Event.SheetEditStarted, () => {
    editing = true;
    editSequence++;
    refreshStatus();
  });
  editor.univerAPI.addEvent(editor.univerAPI.Event.SheetEditEnded, () => {
    editing = false;
    queueMicrotask(changed);
  });
  return editor;
}
type OpenWorkbook = { book: Book; snapshot: IWorkbookData; hash: string; file: string };
async function install(data: OpenWorkbook) {
  autoSave.reset();
  saveFailed = false;
  installing = true;
  try {
    await mountWorkbook(data);
  } finally {
    installing = false;
  }
  changed();
}
async function mountWorkbook(data: OpenWorkbook) {
  const previous = instance?.univerAPI.getActiveWorkbook();
  const switchedFile = !!previous && $('path').title !== data.file;
  const sheet =
    !switchedFile && previous?.id === data.book.id ? previous.getActiveSheet() : undefined;
  const view = sheet && {
    id: sheet.getSheetId(),
    range: previous?.getActiveRange()?.getRange(),
    scroll:
      instance!.univerAPI.getCurrentLifecycleStage() >= LifecycleStages.Rendered
        ? sheet.getScrollState()
        : undefined,
  };
  for (const listener of workbookListeners) listener.dispose();
  workbookListeners = [];
  if (previous) {
    instance!.univer.dispose();
    instance = undefined;
    formulaModel = undefined;
  }
  instance ??= createEditor();
  editing = false;
  formulaPending = null;
  const { sheets, ...metadata } = data.book;
  original = metadata;
  revision = data.hash;
  conflicted = false;
  dirty = false;
  $('conflict').hidden = true;
  for (const sheet of sheets) {
    data.snapshot.sheets[sheet.id].custom = {
      ...data.snapshot.sheets[sheet.id].custom,
      aibFilter: sheet.filter,
    };
  }
  const wb = instance.univerAPI.createWorkbook(data.snapshot);
  edits.history.clearUndoRedo(wb.id);
  savedHead = lastHead = null;
  lastUndoCount = 0;
  rootExpired = false;
  const previousSheet = view && wb.getSheetBySheetId(view.id);
  // Restoring the viewport needs the scroll services installed by the Rendered stage.
  if (previousSheet) await renderReady;
  if (
    view &&
    previousSheet &&
    !editing &&
    !formulaPending &&
    !edits.history.getUndoRedoStatus(wb.id).undos
  ) {
    wb.setActiveSheet(previousSheet);
    const r = view.range;
    const maxRow = previousSheet.getMaxRows() - 1,
      maxCol = previousSheet.getMaxColumns() - 1;
    if (r) {
      const from = address(Math.min(r.startRow, maxRow), Math.min(r.startColumn, maxCol));
      const to = address(Math.min(r.endRow, maxRow), Math.min(r.endColumn, maxCol));
      previousSheet.getRange(from + ':' + to).activate();
    }
    if (view.scroll)
      previousSheet.scrollToCell(
        Math.min(view.scroll.sheetViewStartRow, maxRow),
        Math.min(view.scroll.sheetViewStartColumn, maxCol),
      );
  }
  const selectionChanged = () => {
    const range = wb.getActiveRange();
    const r = range?.getRange();
    activeSheet = wb.getActiveSheet().getSheetName();
    activeRange = r
      ? `${address(r.startRow, r.startColumn)}:${address(r.endRow, r.endColumn)}`
      : 'A1';
    $('selection').textContent = activeSheet + ' ! ' + activeRange;
    updateFormula();
    if (range) {
      const r = range.getRange();
      if ((r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1) <= 200000) {
        const stats = statistics(range.getRawValues());
        $('sync').textContent = t('stats', {
          count: stats.count,
          sum: stats.sum,
          average: stats.average ?? '—',
        });
      } else {
        $('sync').textContent = t('largeRange');
      }
    }
  };
  refreshSelection = selectionChanged;
  workbookListeners.push(wb.onSelectionChange(selectionChanged));
  workbookListeners.push(
    instance.univerAPI.addEvent(instance.univerAPI.Event.ActiveSheetChanged, selectionChanged),
  );
  let queued = false;
  workbookListeners.push(
    wb.onCommandExecuted((command) => {
      if (installing || queued || command.type !== CommandType.MUTATION) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (
          instance?.univerAPI.getActiveWorkbook()?.getWorkbook() !== wb.getWorkbook() ||
          installing
        )
          return;
        changed();
        updateFormula();
      });
    }),
  );
  for (const key of ['name', 'path', 'sync']) $(key).removeAttribute('data-i18n');
  document.querySelector('title')?.removeAttribute('data-i18n');
  $('name').textContent = data.book.name;
  $('path').textContent = data.file;
  $('path').title = data.file;
  document.title = data.book.name + ' · AIB';
  refreshStatus();
  selectionChanged();
}
function activeCell() {
  const wb = instance?.univerAPI.getActiveWorkbook();
  return wb?.getActiveCell() ?? wb?.getActiveSheet().getRange(activeRange.split(':')[0]);
}
function updateFormula() {
  const wb = instance?.univerAPI.getActiveWorkbook();
  const cell = activeCell();
  if (!wb || !cell) return;
  const fmt = cell.getCellStyleData() ?? {};
  $<HTMLFieldSetElement>('fontTools').disabled = false;
  $('bold').setAttribute('aria-pressed', String(fmt.bl === 1));
  $('italic').setAttribute('aria-pressed', String(fmt.it === 1));
  $('normal').setAttribute('aria-pressed', String(fmt.bl !== 1 && fmt.it !== 1));
  const size = String(fmt.fs ?? DEFAULT_STYLES.fs);
  const sizes = $<HTMLSelectElement>('fontSize');
  if (sizes.value !== size) {
    sizes.querySelector('[data-custom]')?.remove();
    if (![...sizes.options].some((o) => o.value === size)) {
      const option = new Option(size, size);
      option.dataset.custom = '';
      sizes.add(option);
    }
    sizes.value = size;
  }
  const align = ['', 'left', 'center', 'right'][fmt.ht ?? 0];
  for (const button of alignButtons)
    button.setAttribute('aria-pressed', String(button.dataset.align === align));
  palette.sync('color', fmt.cl?.rgb ?? null);
  palette.sync('background', fmt.bg?.rgb ?? null);
  const pattern = fmt.n?.pattern || 'General';
  const select = $<HTMLSelectElement>('numberFormat');
  if (select.value !== pattern) {
    select.querySelector('[data-custom]')?.remove();
    if (!Array.from(select.options).some((option) => option.value === pattern)) {
      const category = numfmt.isPercentFormat(pattern)
        ? t('percent')
        : numfmt.isDateFormat(pattern)
          ? t('date')
          : t('custom');
      const option = new Option(category + ' · ' + pattern, pattern);
      option.dataset.custom = '';
      select.add(option);
    }
    select.value = pattern;
  }
  if (formulaPending || document.activeElement === $('cellAddress')) return;
  $<HTMLInputElement>('cellAddress').value = address(cell.getRow(), cell.getColumn());
  const data = wb.getActiveSheet().getSheet().getCellRaw(cell.getRow(), cell.getColumn());
  let value = data?.v;
  const type = data?.custom?.aibType;
  if ((type === 'date' || type === 'datetime') && typeof value === 'number') {
    const iso = serialDate(value, original.dateSystem);
    value = type === 'date' ? iso.slice(0, 10) : iso;
  } else if (data?.t === 3) value = Boolean(value);
  $<HTMLInputElement>('formulaValue').value = cell.getFormula() || String(value ?? '');
}
async function readDisk(discard = false) {
  const bookId = id,
    sequence = editSequence;
  if (!bookId) return;
  const info = await api('/api/books/' + bookId + '/revision');
  if (id !== bookId) return;
  if (info.hash === revision && !discard) {
    conflicted = false;
    $('conflict').hidden = true;
    refreshStatus();
    message(() => t('diskMatch'));
    return;
  }
  if (!discard && (dirty || editing || formulaPending)) {
    markConflict();
    return;
  }
  const data = await api('/api/books/' + bookId);
  if (id !== bookId) return;
  if (sequence !== editSequence || (!discard && (editing || formulaPending))) {
    markConflict();
    return;
  }
  await install(data);
  message(() => t('diskLoaded'));
}
function mutate(ops: Operation[]) {
  finishInput();
  for (const op of ops) edits.apply(op);
  changed();
  updateFormula();
  return Promise.resolve();
}
async function openPath(file: string, saveCopy = false) {
  await fileAction(async () => {
    finishInput();
    changed();
    const sequence = editSequence;
    if (saveCopy) {
      await api('/api/save-copy', { file, book: current() });
      if (sequence !== editSequence || editing || formulaPending)
        throw new InterfaceError('copyHasEdits');
    }
    if (dirty && !saveCopy && !confirm(t('discardOpen'))) return;
    const opened = await api('/api/open', { file });
    const data = await api('/api/books/' + opened.id);
    if (sequence !== editSequence || editing || formulaPending)
      throw new InterfaceError('editedDuringOpen');
    id = opened.id;
    history.replaceState(null, '', '?book=' + id);
    await install(data);
    message();
  });
}
type Field = {
  key: string;
  label: string;
  value?: string;
  options?: [string, string][];
  type?: string;
};
function form(
  title: string,
  fields: Field[],
  action: (v: Record<string, string>) => Promise<void | false>,
  button = t('ok'),
) {
  $('dialogTitle').textContent = title;
  $('submit').textContent = button;
  $('dialogError').textContent = '';
  const host = $('fields');
  host.replaceChildren();
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = field.options
      ? document.createElement('select')
      : document.createElement('input');
    input.name = field.key;
    if (field.options)
      for (const [value, text] of field.options) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        (input as HTMLSelectElement).append(o);
      }
    else (input as HTMLInputElement).type = field.type ?? 'text';
    input.value = field.value ?? '';
    label.append(input);
    host.append(label);
  }
  $('form').onsubmit = async (event) => {
    event.preventDefault();
    $('submit').setAttribute('disabled', '');
    try {
      const result = await action(
        Object.fromEntries(new FormData($<HTMLFormElement>('form')).entries()) as Record<
          string,
          string
        >,
      );
      if (result !== false) $<HTMLDialogElement>('dialog').close();
    } catch (e) {
      const error = e as Error & { details?: unknown };
      $('dialogError').textContent =
        describeError(error) + (error.details ? '\n' + describeIssues(error.details) : '');
    } finally {
      $('submit').removeAttribute('disabled');
    }
  };
  $<HTMLDialogElement>('dialog').showModal();
}
const bind = (id: string, action: () => void | Promise<void>) => {
  $(id).onclick = () => {
    Promise.resolve().then(action).catch(showError);
  };
};
$('formulaValue').onkeydown = (event) => {
  if (event.key === 'Escape' && formulaPending) {
    event.preventDefault();
    formulaPending = null;
    updateFormula();
    refreshStatus();
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  try {
    commitFormula();
  } catch (e) {
    showError(e);
  }
};
function commitFormula() {
  if (!formulaPending) return;
  const wb = instance?.univerAPI.getActiveWorkbook();
  const sheet =
    wb?.id === formulaPending.workbookId ? wb.getSheetBySheetId(formulaPending.sheetId) : null;
  if (!sheet) throw new InterfaceError('sheetGone');
  const v = $<HTMLInputElement>('formulaValue').value;
  const target = sheet.getRange(formulaPending.cell);
  const previous = target.getValue();
  const preserveText = typeof previous === 'string' && /^[+-]?\d/.test(previous);
  const value = preserveText && v !== '' ? v : parseCellLiteral(v);
  target.setValues([
    [
      v.startsWith('=')
        ? { f: v, v: null, custom: null }
        : { v: value, f: null, custom: null, t: typeof value === 'number' ? 2 : 4 },
    ],
  ]);
  formulaPending = null;
  changed();
  updateFormula();
}
$('formulaValue').oninput = () => {
  if (!formulaPending) {
    const wb = instance?.univerAPI.getActiveWorkbook();
    const cell = activeCell();
    if (!wb || !cell) return;
    formulaPending = {
      workbookId: wb.id,
      sheetId: wb.getActiveSheet().getSheetId(),
      cell: address(cell.getRow(), cell.getColumn()),
    };
  }
  editSequence++;
  refreshStatus();
};
$('cellAddress').onkeydown = (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const a = $<HTMLInputElement>('cellAddress').value.toUpperCase();
  try {
    instance!.univerAPI.getActiveWorkbook()!.getActiveSheet().getRange(a).activate();
    activeRange = a;
    $('cellAddress').blur();
    updateFormula();
  } catch (e) {
    showError(e);
  }
};
bind('cancel', () => $<HTMLDialogElement>('dialog').close());
async function pickFile(
  kind: DialogKind,
  name?: string,
  near = $('path').title,
): Promise<string | null> {
  pickingFile = true;
  refreshStatus();
  document.body.inert = true;
  try {
    return await api('/api/file-dialog', { kind, name, near, language: language() });
  } finally {
    document.body.inert = false;
    pickingFile = false;
    refreshStatus();
  }
}
function fileStem(file: string) {
  return file
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.[^.]+$/, '');
}
bind('exportGuide', async () => {
  try {
    const guideLanguage = language();
    const target = await pickFile('guide', t('guideName'));
    if (target) {
      const result = await api('/api/export-guide', { target, language: guideLanguage });
      message(() => t('guideExported', { file: result.file }));
    }
  } catch (error) {
    message(() => t('guideFailed', { reason: describeError(error) }));
  }
});
bind('open', async () => {
  const file = await pickFile('open');
  if (file) await openPath(file);
});
bind('new', async () => {
  const file = await pickFile('save', t('workbook'));
  if (!file) return;
  form(
    t('newWorkbook'),
    [{ key: 'name', label: t('bookName'), value: fileStem(file) }],
    async (v) => {
      finishInput();
      await api('/api/execute', { command: 'new', file, args: { name: v.name || fileStem(file) } });
      await openPath(file);
    },
    t('create'),
  );
});
bind('import', async () => {
  const source = await pickFile('import');
  if (!source) return;
  form(
    t('importNamed', { file: fileStem(source) }),
    [
      {
        key: 'lossy',
        label: t('unsupported'),
        options: [
          ['false', t('stopOnLoss')],
          ['true', t('acceptLoss')],
        ],
      },
    ],
    async (v) => {
      const file = await pickFile('save', fileStem(source), source);
      if (!file) return false;
      finishInput();
      const r = await api('/api/execute', {
        command: 'import',
        file,
        args: { source, allowLossy: v.lossy === 'true' },
      });
      await openPath(file);
      if (r.issues.length) message(() => describeIssues(r.issues));
    },
    t('chooseTarget'),
  );
});
bind('export', async () => {
  if (!id) throw new InterfaceError('needBook');
  const target = await pickFile('export', fileStem($('path').title));
  if (!target) return;
  if (target.toLowerCase().endsWith('.aib')) {
    await openPath(target, true);
    return;
  }
  const write = async (sheet: string) => {
    finishInput();
    const args = { target, sheet, book: current(), language: language() };
    const r = await execute('export-memory', args).catch((error) => {
      if (error.code === 'UNKNOWN_COMMAND') throw new InterfaceError('updateBeforeExport');
      if (error.code !== 'CONVERSION_LOSS' || !Array.isArray(error.details)) throw error;
      const report = describeIssues(error.details);
      if (!confirm(report + '\n\n' + t('confirmLoss'))) return null;
      return execute('export-memory', { ...args, allowLossy: true });
    });
    if (!r) return;
    message(
      () =>
        t('exported', { file: r.file }) + (r.issues.length ? '\n' + describeIssues(r.issues) : ''),
    );
  };
  const workbook = instance!.univerAPI.getActiveWorkbook()!;
  const sheets = workbook.getSheets();
  const activeSheetId = workbook.getActiveSheet().getSheetId();
  if (target.toLowerCase().endsWith('.csv') && sheets.length > 1) {
    form(
      t('exportCsv'),
      [
        {
          key: 'sheet',
          label: t('sheets'),
          options: sheets.map((s) => [s.getSheetId(), s.getSheetName()]),
          value: activeSheetId,
        },
      ],
      (v) => write(v.sheet),
      t('exportFile'),
    );
  } else await write(activeSheetId);
});
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-action]'))
  b.onclick = () => {
    void travel(b.dataset.action === 'redo').catch(showError);
  };
window.addEventListener(
  'keydown',
  (event) => {
    if (instance && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopImmediatePropagation();
      void save().catch(showError);
      return;
    }
    if (
      !instance ||
      editing ||
      formulaPending ||
      event.altKey ||
      !(event.ctrlKey || event.metaKey) ||
      (event.target instanceof Element &&
        !event.target.closest('#canvas') &&
        event.target.closest('input,textarea,select,[contenteditable="true"],dialog'))
    )
      return;
    const key = event.key.toLowerCase();
    if (key === 'b' || key === 'i') {
      event.preventDefault();
      event.stopImmediatePropagation();
      void toggleFont(key === 'b' ? 'bold' : 'italic').catch(showError);
      return;
    }
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void travel(key === 'y' || event.shiftKey).catch(showError);
  },
  true,
);
async function travel(redo: boolean) {
  finishInput();
  if (!instance) return;
  if (redo) await instance.univerAPI.redo();
  else await instance.univerAPI.undo();
  changed();
  updateFormula();
}
async function style(s: Style) {
  finishInput();
  edits.style(activeRange, toStyle(s));
  changed();
  updateFormula();
}
async function toggleFont(key: 'bold' | 'italic') {
  const fmt = activeCell()?.getCellStyleData();
  return style({ [key]: fmt?.[key === 'bold' ? 'bl' : 'it'] !== 1 });
}
bind('bold', () => toggleFont('bold'));
bind('italic', () => toggleFont('italic'));
bind('normal', () => style({ bold: false, italic: false }));
const alignButtons = document.querySelectorAll<HTMLButtonElement>('[data-align]');
for (const button of alignButtons)
  button.onclick = () =>
    void style({ horizontal: button.dataset.align as Style['horizontal'] }).catch(showError);
const sizeSelect = $<HTMLSelectElement>('fontSize');
for (const n of [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72])
  sizeSelect.add(new Option(String(n), String(n)));
sizeSelect.onchange = () => void style({ fontSize: Number(sizeSelect.value) }).catch(showError);
const palette = createColorPalette((key, value) => {
  if (value) {
    void style({ [key]: value }).catch(showError);
    return;
  }
  try {
    finishInput();
    edits.style(activeRange, { [key === 'color' ? 'cl' : 'bg']: null });
    changed();
    updateFormula();
  } catch (e) {
    showError(e);
  }
});
bind('save', save);
bind('syncDisk', () => fileAction(() => readDisk()));
bind('format', () => {
  const fmt = activeCell()?.getCellStyleData() ?? {};
  const before: Record<string, string> = {
    fontFamily: fmt.ff ?? DEFAULT_STYLES.ff,
    fontSize: String(fmt.fs ?? DEFAULT_STYLES.fs),
    horizontal: ['', 'left', 'center', 'right'][fmt.ht ?? 0] ?? '',
    vertical: ['', 'top', 'middle', 'bottom'][fmt.vt ?? 0] ?? '',
    border:
      ({ 1: 'thin', 2: 'medium', 5: 'thick' } as Record<number, string>)[fmt.bd?.t?.s ?? 0] ?? '',
    borderColor: fmt.bd?.t?.cl?.rgb ?? '#333333',
    numberFormat: fmt.n?.pattern ?? 'General',
  };
  const fields: Field[] = [
    { key: 'fontFamily', label: t('font') },
    { key: 'fontSize', label: t('fontSize'), type: 'number' },
    {
      key: 'horizontal',
      label: t('alignment'),
      options: [
        ['', before.horizontal ? t('keep') : t('automaticFormat')],
        ['left', t('left')],
        ['center', t('center')],
        ['right', t('right')],
      ],
    },
    {
      key: 'vertical',
      label: t('vertical'),
      options: [
        ['', before.vertical ? t('keep') : t('defaultAlignment')],
        ['top', t('top')],
        ['middle', t('center')],
        ['bottom', t('bottom')],
      ],
    },
    {
      key: 'border',
      label: t('borders'),
      options: [
        ['', before.border ? t('keep') : t('noBorder')],
        ['thin', t('thin')],
        ['medium', t('medium')],
        ['thick', t('thick')],
      ],
    },
    { key: 'borderColor', label: t('borderColor'), type: 'color' },
    { key: 'numberFormat', label: t('customFormat') },
  ];
  form(
    t('formatSelection'),
    fields.map((f) => ({ ...f, value: before[f.key] })),
    async (v) => {
      const s: Record<string, unknown> = {};
      for (const k of ['fontFamily', 'horizontal', 'vertical', 'numberFormat'])
        if (v[k] && v[k] !== before[k]) s[k] = v[k];
      if (v.fontSize && v.fontSize !== before.fontSize) s.fontSize = +v.fontSize;
      if (
        v.border &&
        (v.border !== before.border ||
          v.borderColor.toLowerCase() !== before.borderColor.toLowerCase())
      )
        s.border = { style: v.border, color: v.borderColor };
      if (Object.keys(s).length) return style(s);
    },
  );
});
$('numberFormat').onchange = () => {
  const value = $<HTMLSelectElement>('numberFormat').value;
  if (value) void style({ numberFormat: value }).catch(showError);
};
for (const k of ['merge', 'unmerge'] as const)
  bind(k, () => mutate([{ type: k, sheet: activeSheet, range: activeRange }]));
bind('freeze', () =>
  form(
    t('freezeRowsCols'),
    [
      { key: 'rows', label: t('topRows'), value: '1', type: 'number' },
      { key: 'columns', label: t('leftCols'), value: '0', type: 'number' },
    ],
    (v) => mutate([{ type: 'freeze', sheet: activeSheet, rows: +v.rows, columns: +v.columns }]),
  ),
);
bind('structure', () =>
  form(
    t('rowColActions'),
    [
      {
        key: 'axis',
        label: t('target'),
        options: [
          ['rows', t('rows')],
          ['columns', t('columns')],
        ],
      },
      {
        key: 'action',
        label: t('action'),
        options: [
          ['insert', t('insert')],
          ['delete', t('delete')],
          ['hide', t('hide')],
          ['show', t('show')],
          ['size', t('resize')],
        ],
      },
      { key: 'index', label: t('startIndex'), value: '1', type: 'number' },
      { key: 'count', label: t('count'), value: '1', type: 'number' },
      { key: 'size', label: t('pixelSize'), value: '30', type: 'number' },
    ],
    (v) =>
      mutate([
        {
          type: `${v.axis}.${['insert', 'delete'].includes(v.action) ? v.action : 'meta'}`,
          sheet: activeSheet,
          index: +v.index - 1,
          count: +v.count,
          ...(v.action === 'size'
            ? { size: +v.size }
            : v.action === 'hide' || v.action === 'show'
              ? { hidden: v.action === 'hide' }
              : {}),
        } as Operation,
      ]),
  ),
);
bind('sheets', () =>
  form(
    t('sheetActions'),
    [
      {
        key: 'action',
        label: t('action'),
        options: [
          ['add', t('add')],
          ['rename', t('renameSheet')],
          ['delete', t('deleteSheet')],
          ['move', t('moveSheet')],
        ],
      },
      {
        key: 'name',
        label: t('newName'),
        value: 'Sheet' + ((instance?.univerAPI.getActiveWorkbook()?.getSheets().length ?? 0) + 1),
      },
      { key: 'index', label: t('sheetPosition'), value: '1', type: 'number' },
    ],
    (v) =>
      mutate([
        v.action === 'add'
          ? { type: 'sheet.add', name: v.name }
          : v.action === 'rename'
            ? { type: 'sheet.rename', sheet: activeSheet, name: v.name }
            : v.action === 'delete'
              ? { type: 'sheet.delete', sheet: activeSheet }
              : { type: 'sheet.move', sheet: activeSheet, index: +v.index - 1 },
      ]),
  ),
);
bind('sort', () =>
  form(
    t('sortHeading'),
    [
      { key: 'range', label: t('rangeToSort'), value: activeRange },
      { key: 'column', label: t('columnInRange'), value: '1', type: 'number' },
      {
        key: 'direction',
        label: t('order'),
        options: [
          ['asc', t('asc')],
          ['desc', t('desc')],
        ],
      },
    ],
    (v) =>
      mutate([
        {
          type: 'sort',
          sheet: activeSheet,
          range: v.range,
          column: +v.column - 1,
          ascending: v.direction === 'asc',
        },
      ]),
  ),
);
bind('filter', () =>
  form(
    t('filterHeading'),
    [
      { key: 'range', label: t('range'), value: activeRange },
      { key: 'column', label: t('sheetColumn'), value: '1', type: 'number' },
      { key: 'values', label: t('allowedValues'), value: t('sampleFilter') },
    ],
    (v) =>
      mutate([
        {
          type: 'filter',
          sheet: activeSheet,
          filter: v.values.trim()
            ? { range: v.range, columns: [{ column: +v.column - 1, values: JSON.parse(v.values) }] }
            : null,
        },
      ]),
  ),
);
bind('find', () =>
  form(
    t('findHeading'),
    [
      {
        key: 'mode',
        label: t('action'),
        options: [
          ['find', t('find')],
          ['replace', t('replaceSheet')],
        ],
      },
      { key: 'search', label: t('search') },
      { key: 'replacement', label: t('replaceWith') },
    ],
    async (v) => {
      if (v.mode === 'replace')
        await mutate([
          { type: 'replaceText', sheet: activeSheet, search: v.search, replacement: v.replacement },
        ]);
      else {
        finishInput();
        const result = edits.find(v.search);
        message(() =>
          t('found', {
            count: result.count,
            cells: result.matches.join(language() === 'zh-CN' ? '、' : ', '),
          }),
        );
        if (result.matches[0])
          instance!.univerAPI
            .getActiveWorkbook()!
            .getActiveSheet()
            .getRange(result.matches[0])
            .activate();
      }
    },
    t('run'),
  ),
);
bind('reload', () => {
  if ((dirty || editing || formulaPending) && !confirm(t('confirmReload'))) return;
  return fileAction(() => readDisk(true));
});
bind('download', async () => {
  if (editing || formulaPending) throw new InterfaceError('finishBackup');
  const book = current();
  try {
    const file = await pickFile('save', original.name + t('unsavedSuffix'));
    if (!file) return;
    await api('/api/save-copy', { file, book });
    message(() => t('copied', { file }));
    return;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // The in-memory copy can still be rescued when the local server is offline.
  }
  const blob = new Blob([serialize(book)], { type: 'application/json' }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = original.name + t('unsavedSuffix') + '.aib';
  a.click();
  URL.revokeObjectURL(url);
});
bind('drafts', () =>
  form(
    t('viewDraft'),
    [{ key: 'id', label: t('draftId') }],
    async (v) => {
      const d = await api('/api/execute', { command: 'diff', args: v });
      setTimeout(() => {
        form(
          t('reviewDraft', { id: d.id }),
          [],
          async () => {
            finishInput();
            if (dirty) throw new InterfaceError('saveBeforeDraft');
            await api('/api/execute', { command: 'apply', args: { id: d.id } });
            await fileAction(() => readDisk());
          },
          t('applyDraft'),
        );
        const p = document.createElement('p');
        p.textContent = t('draftFile', { file: d.file });
        $('fields').append(p);
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(d.changes, null, 2);
        $('fields').append(pre);
      }, 0);
    },
    t('viewDiff'),
  ),
);
window.addEventListener('beforeunload', (e) => {
  if (dirty || saving || editing || formulaPending || fileBusy) {
    e.preventDefault();
    e.returnValue = '';
  }
});
installLanguageSetting(
  (locale) => {
    setLanguage(locale);
    translatePage();
    if (instance && instance.univerAPI.getCurrentLocale() !== editorLocale()) {
      instance.univerAPI.setLocale(editorLocale());
    }
    // Rebuild the label of a custom pattern without altering the underlying cell format.
    $('numberFormat').querySelector('[data-custom]')?.remove();
    palette.translate();
    refreshSelection?.();
    refreshStatus();
    message(messageContent);
  },
  (error) => message(() => describeError(error)),
);
if (id) void fileAction(async () => install(await api('/api/books/' + id))).catch(showError);
else if (!token) message(() => t('openSession'));
