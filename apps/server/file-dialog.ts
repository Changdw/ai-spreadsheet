import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AibError } from '../../packages/schema/index';

const run = promisify(execFile);
const dialogs = {
  open: {
    title: '打开 AIB 工作簿',
    englishTitle: 'Open an AIB workbook',
    extensions: ['aib'],
    save: false,
  },
  import: {
    title: '选择要导入的 Excel 或 CSV 文件',
    englishTitle: 'Choose an Excel or CSV file to import',
    extensions: ['xlsx', 'xls', 'csv'],
    save: false,
  },
  save: {
    title: '保存新的 AIB 工作簿',
    englishTitle: 'Save a new AIB workbook',
    extensions: ['aib'],
    save: true,
  },
  guide: {
    title: '导出 AIB 离线处理指南',
    englishTitle: 'Export the AIB offline guide',
    extensions: ['md'],
    save: true,
  },
  export: {
    title: '导出工作簿（.xlsx / .xls / .csv / .html / .aib）',
    englishTitle: 'Export workbook (.xlsx / .xls / .csv / .html / .aib)',
    extensions: ['xlsx', 'xls', 'csv', 'html', 'aib'],
    save: true,
  },
};
export type DialogKind = keyof typeof dialogs;

// Pass user-controlled names as data. Only this fixed script is executed by PowerShell.
const windowsDialog = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.TopMost = $true
$owner.Show()
$dialog = if ($env:AIB_PICK_SAVE -eq '1') { New-Object Windows.Forms.SaveFileDialog } else { New-Object Windows.Forms.OpenFileDialog }
try {
  $dialog.Title = $env:AIB_PICK_TITLE
  $dialog.Filter = $env:AIB_PICK_FILTER
  $dialog.DefaultExt = $env:AIB_PICK_EXTENSION
  $dialog.FileName = $env:AIB_PICK_NAME
  if ($env:AIB_PICK_DIR) { $dialog.InitialDirectory = $env:AIB_PICK_DIR }
  if ($env:AIB_PICK_SAVE -eq '1') { $dialog.OverwritePrompt = $false }
  if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }
} finally { $dialog.Dispose(); $owner.Dispose() }
`;

const macDialog = `on run argv
  set {kind, promptText, folderPath, suggestedName} to argv
  if folderPath is "" then
    set startFolder to path to documents folder
  else
    set startFolder to POSIX file folderPath as alias
  end if
  activate
  try
    if kind is "open" then
      set picked to choose file with prompt promptText of type {"aib"} default location startFolder
    else if kind is "import" then
      set picked to choose file with prompt promptText of type {"xlsx", "xls", "csv"} default location startFolder
    else
      set picked to choose file name with prompt promptText default name suggestedName default location startFolder
    end if
    return POSIX path of picked
  on error number -128
    return ""
  end try
end run`;

export async function chooseFile(
  request: { kind?: string; near?: string; name?: string; language?: string },
  signal: AbortSignal,
) {
  if (!request || !Object.hasOwn(dialogs, request.kind ?? ''))
    throw new AibError('INVALID_ARGUMENT', '未知文件选择类型');
  const kind = request.kind as DialogKind;
  const english = request.language === 'en-US';
  const { extensions, save } = dialogs[kind];
  const title = english ? dialogs[kind].englishTitle : dialogs[kind].title;
  const directory =
    typeof request.near === 'string' && path.isAbsolute(request.near)
      ? path.dirname(request.near)
      : '';
  const stem = (
    (typeof request.name === 'string' && request.name) ||
    (english ? 'Workbook' : '工作簿')
  )
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
    .slice(0, 120);
  const suggested = save ? stem + '.' + extensions[0] : '';
  let picked: string;
  try {
    if (process.platform === 'win32') {
      const filter =
        kind === 'import'
          ? (english ? 'Excel or CSV' : 'Excel 或 CSV') +
            ' (*.xlsx, *.xls, *.csv)|*.xlsx;*.xls;*.csv'
          : extensions
              .map((ext) => {
                const label =
                  kind === 'export' && ext === 'aib'
                    ? english
                      ? 'AIB workbook (save a copy and open)'
                      : 'AIB 工作簿（另存为并打开）'
                    : ext.toUpperCase();
                return label + ' (*.' + ext + ')|*.' + ext;
              })
              .join('|');
      const powershell = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      picked = (
        await run(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-EncodedCommand',
            Buffer.from(windowsDialog, 'utf16le').toString('base64'),
          ],
          {
            signal,
            windowsHide: true,
            encoding: 'utf8',
            env: {
              ...process.env,
              AIB_PICK_TITLE: title,
              AIB_PICK_SAVE: save ? '1' : '0',
              AIB_PICK_FILTER: filter,
              AIB_PICK_DIR: directory,
              AIB_PICK_EXTENSION: extensions[0],
              AIB_PICK_NAME: save ? stem : '',
            },
          },
        )
      ).stdout;
    } else if (process.platform === 'darwin') {
      picked = (
        await run('/usr/bin/osascript', ['-e', macDialog, kind, title, directory, suggested], {
          signal,
        })
      ).stdout.replace(/\n$/, '');
    } else {
      const args = [
        '--file-selection',
        '--title=' + title,
        '--file-filter=' + extensions.map((ext) => '*.' + ext).join(' '),
      ];
      if (save) args.push('--save');
      if (directory || suggested)
        args.push('--filename=' + (directory ? directory + path.sep : '') + suggested);
      picked = (await run('zenity', args, { signal })).stdout.replace(/\n$/, '');
    }
  } catch (error) {
    if (process.platform === 'linux' && (error as { code?: number }).code === 1) return null;
    throw new AibError(
      'DIALOG_FAILED',
      (english ? 'Could not open the system file dialog. ' : '无法打开系统文件窗口。') +
        (error as Error).message.split('\n').at(-1),
    );
  }
  if (!picked) return null;
  if (save && !path.extname(picked)) picked += '.' + extensions[0];
  if (!extensions.includes(path.extname(picked).slice(1).toLowerCase()))
    throw new AibError(
      'INVALID_EXTENSION',
      english
        ? 'Choose a file with one of these extensions: ' + extensions.join(', ')
        : '请选择 ' + extensions.map((ext) => '.' + ext).join(' 或 ') + ' 文件',
    );
  if (
    save &&
    (await fs.stat(picked).then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    ))
  )
    throw new AibError('FILE_EXISTS', '目标文件已存在，请选择新的文件名');
  return picked;
}
