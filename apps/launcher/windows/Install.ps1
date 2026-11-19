$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PackageFiles.ps1')
. (Join-Path $PSScriptRoot 'Associations.ps1')
$source = [IO.Path]::GetFullPath($PSScriptRoot)
$destination = Join-Path $env:LOCALAPPDATA 'Programs\AIB\0.1.0'
if ($source -ne [IO.Path]::GetFullPath($destination)) {
    Install-AibFiles $source $destination
}
$exe = Join-Path $destination 'AIB.exe'
$classes = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes')
try { Register-AibWorkbookAssociation $classes $exe } finally { $classes.Dispose() }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'AIB.lnk'))
$shortcut.TargetPath = $exe
$shortcut.Save()
Write-Output "已安装：$destination"
Write-Output '右键工作簿，在“打开方式”中选择 AIB。要让双击默认使用 AIB，请选择“始终”。CLI：安装目录中的 aib.cmd。'
