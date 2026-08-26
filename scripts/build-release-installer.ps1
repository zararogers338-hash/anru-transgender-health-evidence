param(
    [Parameter(Mandatory = $true)]
    [string]$PortableDirectory,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [Parameter(Mandatory = $true)]
    [string]$SevenZipRoot
)

$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $algorithm.Dispose() }
    }
    finally { $stream.Dispose() }
}
$portable = [IO.Path]::GetFullPath($PortableDirectory).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$sevenZip = [IO.Path]::GetFullPath($SevenZipRoot).TrimEnd('\')
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$sevenZa = @((Join-Path $sevenZip 'extra\x64\7za.exe'), (Join-Path $sevenZip '7z.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$sevenZaDll = @((Join-Path $sevenZip 'extra\x64\7za.dll'), (Join-Path $sevenZip '7z.dll')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$manifest = Join-Path $project 'installer\asInvoker.manifest'
$source = Join-Path $project 'installer\Setup.cs'

foreach ($required in @($portable, $csc, $sevenZa, $sevenZaDll, $manifest, $source)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing installer input: $required" }
}
if ([IO.Path]::GetFileName($portable) -cne 'app') {
    throw "Installer payload directory must be named exactly 'app': $portable"
}
$longestRelativePath = Get-ChildItem -LiteralPath $portable -Recurse -File -Force |
    ForEach-Object { $_.FullName.Substring($portable.Length + 1) } |
    Sort-Object Length -Descending |
    Select-Object -First 1
if ($longestRelativePath.Length -gt 180) {
    throw "Installer payload contains an unsafe path ($($longestRelativePath.Length) characters): $longestRelativePath"
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
$archive = Join-Path $output 'Anru.payload.7z'
$installer = Join-Path $output 'Anru-Setup.exe'
foreach ($target in @($archive, $installer)) {
    if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite existing release artifact: $target" }
}

Push-Location $output
try {
    & $sevenZa a -t7z $archive $portable -m0=lzma2 -mx=6 -mmt=on -ms=256m -myv=2200
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Anru payload archive' }
}
finally {
    Pop-Location
}

$references = @(
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:Microsoft.CSharp.dll'
)
$arguments = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    "/win32manifest:$manifest",
    "/out:$installer"
) + $references + @(
    "/resource:$archive,Anru.Payload.7z",
    "/resource:$sevenZa,Anru.7za.exe",
    "/resource:$sevenZaDll,Anru.7za.dll",
    $source
)
& $csc $arguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installer)) { throw 'Anru installer compilation failed' }

Remove-Item -LiteralPath $archive -Force

[pscustomobject]@{
    Installer = $installer
    Bytes = (Get-Item -LiteralPath $installer).Length
    Sha256 = Get-Sha256 $installer
    Shell = 'Anru custom bootstrapper (no 7-Zip SFX window)'
}
