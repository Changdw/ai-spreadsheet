$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PackageFiles.ps1')
. (Join-Path $PSScriptRoot 'Associations.ps1')
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\AIB\0.1.0'))
if ($root -ne $expected) { throw '请运行已安装目录中的 Uninstall.ps1。' }
$manifest = Read-AibFileManifest $root
# An installed CLI can discover a server belonging to a different portable copy.
$node = Join-Path $root 'node.exe'
$cli = Join-Path $root 'cli.cjs'
if ((Test-AibPlainPath $node) -and (Test-AibPlainPath $cli) -and [IO.File]::Exists($node) -and
    [IO.File]::Exists($cli) -and (Get-FileHash -LiteralPath $node).Hash -eq $manifest['node.exe'] -and
    (Get-FileHash -LiteralPath $cli).Hash -eq $manifest['cli.cjs']) {
    $status = (& $node $cli status | ConvertFrom-Json).data
    if ($status.running) {
        $server = Get-Process -Id $status.pid -ErrorAction SilentlyContinue
        if ($server -and $server.Path -eq $node) {
            & $node $cli stop | Out-Null
            if (!$server.WaitForExit(20000)) { throw 'AIB did not stop. Retry after closing the server.' }
        }
    }
}
$classes = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes', $true)
$owned = $false
if ($classes) {
    try { $owned = Unregister-AibWorkbookAssociation $classes (Join-Path $root 'AIB.exe') }
    finally { $classes.Dispose() }
}
if ($owned) {
    $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'AIB.lnk'
    if ((Test-AibPlainPath $shortcut) -and [IO.File]::Exists($shortcut)) {
        $shell = New-Object -ComObject WScript.Shell
        if ($shell.CreateShortcut($shortcut).TargetPath -eq (Join-Path $root 'AIB.exe')) {
            Remove-Item -LiteralPath $shortcut -Force
        }
    }
}
Remove-AibFiles $root $manifest
Write-Output 'AIB 已卸载。已保留用户文件和修改过的示例。'
