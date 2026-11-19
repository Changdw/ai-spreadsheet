param([switch]$FilesOnly)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $root 'apps\launcher\windows\PackageFiles.ps1')

# This file-policy test is isolated from the registry, Start menu and real AIB installation.
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('aib-install-policy-' + [guid]::NewGuid().ToString('N'))
$src = Join-Path $fixture 'package'
$dest = Join-Path $fixture 'installed'
$outside = Join-Path $fixture 'outside'
$junction = Join-Path $dest 'assets'
$example = Join-Path $dest 'examples\budget.aib'
$userFile = Join-Path $dest 'mine.aib'
try {
    foreach ($dir in @($src, $dest, $outside, (Join-Path $src 'examples'), (Join-Path $src 'assets'))) {
        [IO.Directory]::CreateDirectory($dir) | Out-Null
    }
    $names = @('program.txt', 'examples/budget.aib', 'assets/icon.txt')
    $files = foreach ($name in $names) {
        $p = Join-Path $src $name
        [IO.File]::WriteAllText($p, 'distributed')
        @{path=$name; sha256=(Get-FileHash -LiteralPath $p).Hash}
    }
    $meta = @{name='aib'; version='0.1.0'; platform='win-x64'}
    $meta | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $dest 'aib-package.json')
    [IO.File]::WriteAllText((Join-Path $dest 'program.txt'), 'legacy')
    $meta.files = $files
    $meta | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $src 'aib-package.json')
    [IO.File]::WriteAllText((Join-Path $src 'private.aib'), 'private')
    Install-AibFiles $src $dest
    $backup = @(Get-ChildItem -Directory -LiteralPath $dest | Where-Object { $_.Name -like 'AIB-before-update-*' })
    if ($backup.Count -ne 1 -or [IO.File]::ReadAllText((Join-Path $backup[0].FullName 'program.txt')) -ne 'legacy') { throw 'Previous file was not preserved.' }
    if (Test-Path -LiteralPath (Join-Path $dest 'private.aib')) { throw 'An unlisted file was installed.' }
    [IO.File]::WriteAllText($example, 'edited')
    [IO.File]::WriteAllText($userFile, 'user')
    Install-AibFiles $src $dest
    if ([IO.File]::ReadAllText($example) -ne 'edited') { throw 'Install overwrote an edited example.' }
    [IO.File]::Delete((Join-Path $junction 'icon.txt'))
    [IO.Directory]::Delete($junction, $false)
    [IO.File]::WriteAllText((Join-Path $outside 'icon.txt'), 'distributed')
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    $rejected = $false
    try { Install-AibFiles $src $dest } catch { $rejected = $true }
    if (!$rejected) { throw 'Installer followed a junction.' }
    $owned = Read-AibFileManifest $dest
    Remove-AibFiles $dest $owned
    if ([IO.File]::ReadAllText($example) -ne 'edited' -or [IO.File]::ReadAllText($userFile) -ne 'user' -or
        [IO.File]::ReadAllText((Join-Path $outside 'icon.txt')) -ne 'distributed' -or
        [IO.File]::Exists((Join-Path $dest 'program.txt'))) { throw 'Incorrect uninstall ownership handling.' }
    Write-Output 'PASS: installer preserved user files, modified examples, legacy contents and junction targets.'
} finally {
    $item = Get-Item -LiteralPath $junction -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { [IO.Directory]::Delete($junction, $false) }
    $tmpPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\aib-install-policy-'
    if ([IO.Path]::GetFullPath($fixture).StartsWith($tmpPrefix,[StringComparison]::OrdinalIgnoreCase) -and
        (Test-AibPlainPath $fixture) -and [IO.Directory]::Exists($fixture)) {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
. (Join-Path $root 'apps\launcher\windows\Associations.ps1')
# Use a throwaway HKCU key, separate from both real Shell association stores.
$registryPath = 'Software\AIB-Association-Test-' + [guid]::NewGuid().ToString('N')
$classes = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
$testExe = 'C:\AIB fixture\AIB.exe'
try {
    foreach ($default in @('', 'Other.Workbook', 'AIB.Workbook')) {
        $ext = $classes.CreateSubKey('.aib')
        $openWith = $ext.CreateSubKey('OpenWithProgids')
        try {
            if ($default) { $ext.SetValue('', $default) } else { $ext.DeleteValue('', $false) }
            $openWith.SetValue('Other.Workbook', '')
            Register-AibWorkbookAssociation $classes $testExe
            Register-AibWorkbookAssociation $classes $testExe
            if ($ext.GetValue('', '<absent>') -ne $(if ($default) { $default } else { '<absent>' }) -or
                $openWith.GetValueNames() -notcontains 'Other.Workbook' -or
                $openWith.GetValueNames() -notcontains 'AIB.Workbook') { throw 'Registration changed the default or lost an Open with handler.' }
            if (Unregister-AibWorkbookAssociation $classes 'C:\Other Copy\AIB.exe') { throw 'Wrong installation claimed the association.' }
            if (!(Unregister-AibWorkbookAssociation $classes $testExe)) { throw 'Owned association was not removed.' }
            $expected = if ($default -eq 'Other.Workbook') { $default } else { '<absent>' }
            if ($ext.GetValue('', '<absent>') -ne $expected -or
                $openWith.GetValueNames() -contains 'AIB.Workbook' -or
                $openWith.GetValueNames() -notcontains 'Other.Workbook') { throw 'Uninstall damaged another association.' }
        } finally { $openWith.Dispose(); $ext.Dispose() }
    }
    Write-Output 'PASS: Open with preserves other handlers, defaults and legacy upgrade choices.'
} finally {
    $classes.Dispose()
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryPath)
}
if ($FilesOnly) { return }
$package = Join-Path $root 'release\aib-0.1.0-win-x64'
$installed = Join-Path $env:LOCALAPPDATA 'Programs\AIB\0.1.0'
$extension = 'HKCU:\Software\Classes\.aib'
$program = 'HKCU:\Software\Classes\AIB.Workbook'
if ((Test-Path -LiteralPath $installed) -or (Test-Path -LiteralPath $extension) -or (Test-Path -LiteralPath $program)) { throw 'Existing AIB installation or association; refusing to disturb it.' }
$oldHome = $env:AIB_HOME
$oldNoBrowser = $env:AIB_NO_BROWSER
$env:AIB_HOME = Join-Path $root '.verification\installer-state'
$env:AIB_NO_BROWSER = '1'
$testFile = Join-Path $root '.verification\association-test.aib'
[IO.Directory]::CreateDirectory((Split-Path -Parent $testFile)) | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'examples\budget.aib') -Destination $testFile -Force
try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'Install.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Installer failed.' }
    if ($null -ne (Get-Item $extension).GetValue('') -or
        (Get-Item "$extension\OpenWithProgids").GetValueNames() -notcontains 'AIB.Workbook') { throw 'Incorrect Open with registration.' }
    $exe = Join-Path $installed 'AIB.exe'
    if ((Get-Item "$program\shell\open\command").GetValue('') -ne ('"' + $exe + '" "%1"')) { throw 'Incorrect file-open command.' }
    $launch = Start-Process -FilePath $exe -ArgumentList ('"' + $testFile + '"') -WindowStyle Hidden -PassThru
    if (!$launch.WaitForExit(20000)) { throw 'File launcher did not exit within 20 seconds.' }
    $state = (& (Join-Path $installed 'node.exe') (Join-Path $installed 'cli.cjs') status | ConvertFrom-Json).data
    if (!$state.running) { throw 'The registered launcher did not start the local server.' }
    Write-Output 'PASS: per-user registration and explicit workbook launch.'
} finally {
    if (Test-Path -LiteralPath (Join-Path $installed 'Uninstall.ps1')) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'Uninstall.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'Uninstaller failed; inspect the installation directory.' }
    }
    if (Test-Path -LiteralPath $extension) {
        $item = Get-Item -LiteralPath $extension
        $children = @($item.GetSubKeyNames())
        if ($item.GetValueNames().Count -eq 0 -and $children.Count -le 1 -and ($children.Count -eq 0 -or $children[0] -eq 'OpenWithProgids')) {
            $openWith = "$extension\OpenWithProgids"
            if (!(Test-Path $openWith) -or (Get-Item $openWith).GetValueNames().Count -eq 0) { Remove-Item -LiteralPath $extension -Recurse -Force }
        }
    }
    $env:AIB_HOME = $oldHome
    $env:AIB_NO_BROWSER = $oldNoBrowser
}
if ((Test-Path -LiteralPath $installed) -or (Test-Path -LiteralPath $extension) -or (Test-Path -LiteralPath $program)) { throw 'Test installation was not fully removed.' }
if (!(Test-Path -LiteralPath $testFile)) { throw 'Uninstall removed the workbook.' }
Write-Output 'PASS: uninstall removed the application and test association, retaining the workbook.'
