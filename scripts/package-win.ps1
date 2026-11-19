param([string]$NodePath, [string]$OutputDirectory = $env:AIB_RELEASE_DIR)
$ErrorActionPreference = 'Stop'
# npm may be launched from PowerShell 7 and inherit its module search path.
$builtInModules = Join-Path $PSHOME 'Modules'
$env:PSModulePath = (@($builtInModules) + @(($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -ne $builtInModules })) -join ';'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
if ((& $NodePath --version) -notmatch '^v24\.' -or (& $NodePath -p 'process.arch') -ne 'x64') { throw 'Windows x64 Node.js 24 is required.' }
$license = if ($env:AIB_NODE_LICENSE) { $env:AIB_NODE_LICENSE } else { Join-Path (Split-Path $NodePath) 'LICENSE' }
if (!(Test-Path -LiteralPath $license -PathType Leaf)) { throw 'Set AIB_NODE_LICENSE to the LICENSE from the same Node distribution.' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root 'release' }
$release = [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($OutputDirectory)).FullName
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version
$name = "aib-$version-win-x64"
$temp = [IO.Directory]::CreateDirectory((Join-Path $release ('.stage-'+[guid]::NewGuid()))).FullName
$out = [IO.Directory]::CreateDirectory((Join-Path $temp $name)).FullName
Push-Location $root
try {
    & $NodePath --import tsx scripts/stage-release.ts stage $out
    if ($LASTEXITCODE) { throw 'Staging failed' }
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $out 'node.exe')
    Copy-Item -LiteralPath $license -Destination (Join-Path $out 'NODE-LICENSE.txt')
    Copy-Item -LiteralPath 'dist/AIB.Browser.exe' -Destination $out
    Get-ChildItem 'apps/launcher/windows/*.ps1','apps/launcher/windows/*.cmd' | Copy-Item -Destination $out
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $icon = Join-Path $root 'assets\brand\aib.ico'
    $launcher = Join-Path $root 'apps\launcher\windows\Launcher.cs'
    $exe = Join-Path $out 'AIB.exe'
    & $compiler /nologo /target:winexe /platform:x64 /reference:System.Windows.Forms.dll "/win32icon:$icon" "/out:$exe" $launcher
    if ($LASTEXITCODE) { throw 'Launcher compilation failed' }
    & $NodePath --import tsx scripts/stage-release.ts manifest $out win-x64
    if ($LASTEXITCODE) { throw 'Manifest generation failed' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = Join-Path $temp "$name.zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($out,$zip,[IO.Compression.CompressionLevel]::Optimal,$true)
    $archive = Join-Path $release "$name.zip"
    if (Test-Path -LiteralPath $archive) { [IO.File]::Replace($zip,$archive,(Join-Path $temp 'previous.zip')) }
    else { [IO.File]::Move($zip,$archive) }
    $expanded = Join-Path $release $name
    if (!(Test-Path -LiteralPath $expanded)) { [IO.Directory]::Move($out,$expanded) }
    Write-Output ("SHA256 "+(Get-FileHash -LiteralPath $archive).Hash+"  "+$archive)
} finally {
    Pop-Location
    if ([IO.Path]::GetDirectoryName($temp) -eq $release -and [IO.Path]::GetFileName($temp) -like '.stage-*') {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
}
