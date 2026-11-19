# Encode the source PNG artwork for desktop icons; preserve its transparency.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assets = Join-Path $root 'assets\brand'
$source = [Drawing.Image]::FromFile((Join-Path $assets 'aib.png'))
$frames = @{}
try {
    foreach ($size in @(16, 24, 32, 48, 64, 128, 256, 512, 1024)) {
        $bitmap = New-Object Drawing.Bitmap($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $stream = New-Object IO.MemoryStream
        try {
            $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.DrawImage($source, 0, 0, $size, $size)
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $frames[$size] = $stream.ToArray()
        } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
    }
} finally { $source.Dispose() }
# Windows ICO: directory followed by independently encoded PNG frames.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$icoStream = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter($icoStream)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    foreach ($size in $sizes) {
        $dimension = if ($size -eq 256) { 0 } else { $size }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$size].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$size].Length
    }
    foreach ($size in $sizes) { $writer.Write([byte[]]$frames[$size]) }
    [IO.File]::WriteAllBytes((Join-Path $assets 'aib.ico'), $icoStream.ToArray())
} finally { $writer.Dispose(); $icoStream.Dispose() }
# macOS ICNS uses big-endian lengths and PNG chunks for modern icon representations.
function Write-BigEndianLength($writer, [uint32]$value) {
    $bytes = [BitConverter]::GetBytes($value)
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($bytes) }
    $writer.Write($bytes)
}
$types = [ordered]@{ icp4 = 16; icp5 = 32; icp6 = 64; ic07 = 128; ic08 = 256; ic09 = 512; ic10 = 1024 }
$icnsStream = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter($icnsStream)
try {
    $total = 8
    foreach ($size in $types.Values) { $total += 8 + $frames[$size].Length }
    $writer.Write([Text.Encoding]::ASCII.GetBytes('icns'))
    Write-BigEndianLength $writer $total
    foreach ($type in $types.Keys) {
        $bytes = $frames[$types[$type]]
        $writer.Write([Text.Encoding]::ASCII.GetBytes($type))
        Write-BigEndianLength $writer ($bytes.Length + 8)
        $writer.Write([byte[]]$bytes)
    }
    [IO.File]::WriteAllBytes((Join-Path $assets 'aib.icns'), $icnsStream.ToArray())
} finally { $writer.Dispose(); $icnsStream.Dispose() }
[IO.File]::WriteAllBytes((Join-Path $assets 'aib-128.png'), $frames[128])
Write-Output 'Encoded transparent ICO (7 sizes), ICNS (7 sizes) and 128 px Web icon.'
