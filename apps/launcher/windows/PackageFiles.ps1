$ErrorActionPreference = 'Stop'
# npm may be launched from PowerShell 7 and inherit its module search path.
$builtInModules = Join-Path $PSHOME 'Modules'
$env:PSModulePath = (@($builtInModules) + @(($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -ne $builtInModules })) -join ';'

function Test-AibPlainPath([string]$Path) {
    $parent = [IO.Path]::GetFullPath($Path)
    while ($parent) {
        $item = Get-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
    return $true
}

function Get-AibPackagePath([string]$Root, [string]$Relative) {
    if (!$Relative -or [IO.Path]::IsPathRooted($Relative) -or $Relative -match '[:]' -or
        ($Relative -split '[/\\]' | Where-Object { $_ -eq '.' -or $_ -eq '..' -or $_ -eq '' })) {
        throw "Invalid package path: $Relative"
    }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (!$full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        $full -eq (Join-Path $Root 'aib-package.json')) { throw "Invalid package path: $Relative" }
    return $full
}

function Read-AibFileManifest([string]$Root, [switch]$AllowLegacy) {
    $manifest = Join-Path $Root 'aib-package.json'
    if (!(Test-AibPlainPath $manifest)) { throw "Unexpected reparse point: $manifest" }
    $pkg = Get-Content -Encoding UTF8 -Raw -LiteralPath $manifest | ConvertFrom-Json
    if ($pkg.name -ne 'aib' -or $pkg.platform -ne 'win-x64' -or $pkg.version -ne '0.1.0') {
        throw "AIB file manifest missing or incompatible: $manifest"
    }
    if (!$pkg.files) {
        if ($AllowLegacy -and !($pkg.PSObject.Properties['files'])) { return $null }
        throw "AIB package file list missing: $manifest"
    }
    $files = @{}
    foreach ($entry in $pkg.files) {
        $name = ([string]$entry.path).Replace('\', '/')
        $null = Get-AibPackagePath $Root $name
        if ($files.ContainsKey($name) -or $entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw "Invalid package manifest entry: $name"
        }
        $files.Add($name, $entry.sha256)
    }
    return $files
}

function Install-AibFiles([string]$Source, [string]$Destination) {
    $files = Read-AibFileManifest $Source
    $destinationManifest = Join-Path $Destination 'aib-package.json'
    if (!(Test-AibPlainPath $destinationManifest)) { throw "Unexpected reparse point: $destinationManifest" }
    $previous = @{}
    $legacy = $false
    if (Test-Path -LiteralPath $destinationManifest) {
        $previous = Read-AibFileManifest $Destination -AllowLegacy
        $legacy = $null -eq $previous
        if ($legacy) { $previous = @{} }
    }
    $backups = @()
    $pending = @()
    foreach ($name in $files.Keys) {
        $sourceFile = Get-AibPackagePath $Source $name
        $targetFile = Get-AibPackagePath $Destination $name
        if (!(Test-AibPlainPath $sourceFile) -or !(Test-AibPlainPath $targetFile)) {
            throw "Unexpected reparse point for package file: $name"
        }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceFile).Hash -ne $files[$name]) {
            throw "Package checksum mismatch: $sourceFile"
        }
        if (Test-Path -LiteralPath $targetFile) {
            $existing = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetFile).Hash
            if ($existing -eq $files[$name]) { continue }
            if ($existing -ne $previous[$name]) {
                if ($name.StartsWith('examples/', [StringComparison]::OrdinalIgnoreCase)) { continue }
                if ($legacy) { $backups += $name }
                else { throw "Preserve the modified file before installing: $targetFile" }
            }
        }
        $pending += $name
    }
    if ($backups.Count) {
        # Older versions have no file hashes. Keep every original that the update must replace.
        $backup = Join-Path $Destination ('AIB-before-update-' + [guid]::NewGuid().ToString('N'))
        foreach ($name in $backups) {
            $saved = Get-AibPackagePath $backup $name
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null
            [IO.File]::Copy((Get-AibPackagePath $Destination $name), $saved, $false)
        }
        Write-Output "Saved previous files: $backup"
    }
    foreach ($name in $pending) {
        $targetFile = Get-AibPackagePath $Destination $name
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($targetFile)) | Out-Null
        Copy-Item -LiteralPath (Get-AibPackagePath $Source $name) -Destination $targetFile -Force
    }
    # Remove superseded assets only when the previous installer still owns their current content.
    foreach ($name in $previous.Keys) {
        if ($files.ContainsKey($name)) { continue }
        $targetFile = Get-AibPackagePath $Destination $name
        if ((Test-AibPlainPath $targetFile) -and [IO.File]::Exists($targetFile) -and
            (Get-FileHash -Algorithm SHA256 -LiteralPath $targetFile).Hash -eq $previous[$name]) {
            Remove-Item -LiteralPath $targetFile -Force
        }
    }
    Copy-Item -LiteralPath (Join-Path $Source 'aib-package.json') -Destination $destinationManifest -Force
}

function Remove-AibFiles([string]$Root, [hashtable]$Files) {
    $directories = @{}
    foreach ($name in $Files.Keys) {
        $targetFile = Get-AibPackagePath $Root $name
        if (!(Test-AibPlainPath $targetFile)) { continue }
        if ([IO.File]::Exists($targetFile) -and
            (Get-FileHash -Algorithm SHA256 -LiteralPath $targetFile).Hash -eq $Files[$name]) {
            Remove-Item -LiteralPath $targetFile -Force
        }
        $parent = [IO.Path]::GetDirectoryName($targetFile)
        while ($parent -ne $Root) {
            $directories[$parent] = $true
            $parent = [IO.Path]::GetDirectoryName($parent)
        }
    }
    Remove-Item -LiteralPath (Join-Path $Root 'aib-package.json') -Force
    $directories[$Root] = $true
    foreach ($directory in ($directories.Keys | Sort-Object Length -Descending)) {
        if ((Test-AibPlainPath $directory) -and [IO.Directory]::Exists($directory) -and
            !(Get-ChildItem -Force -LiteralPath $directory | Select-Object -First 1)) {
            [IO.Directory]::Delete($directory, $false)
        }
    }
}
