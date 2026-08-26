param(
    [string]$ProjectRoot = '',
    [string]$Destination = ''
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
$project = if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
} else {
    [IO.Path]::GetFullPath($ProjectRoot)
}
$source = Join-Path $project 'release\win-unpacked'
$destination = if ([string]::IsNullOrWhiteSpace($Destination)) {
    Join-Path $project 'release\installer-payload\app'
} else {
    [IO.Path]::GetFullPath($Destination)
}
if (-not (Test-Path -LiteralPath $source)) { throw "Built application is missing: $source" }
if ([IO.Path]::GetFileName($destination) -cne 'app') { throw "Destination must be named app: $destination" }
if (Test-Path -LiteralPath $destination) { throw "Destination already exists; refusing to overwrite: $destination" }

New-Item -ItemType Directory -Force -Path $destination | Out-Null
& robocopy.exe $source $destination /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) { throw "Robocopy failed with exit code $LASTEXITCODE" }

$database = Join-Path $destination 'resources\anru\data\anru_evidence.db'
$executable = Join-Path $destination 'Anru.exe'
foreach ($required in @($database, $executable, (Join-Path $destination 'resources\app.asar'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Staged release is incomplete: $required" }
}
$packageMetadata = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$sha = [ordered]@{
    executable = Get-Sha256 $executable
    database = Get-Sha256 $database
}
$model = Join-Path $destination 'resources\anru\models\bge-m3\pytorch_model.bin'
if (Test-Path -LiteralPath $model) {
    $sha.model = Get-Sha256 $model
}
$countsJson = & node (Join-Path $project 'scripts\inspect-release-corpus.cjs') $database
if ($LASTEXITCODE -ne 0) { throw 'Unable to audit the bundled corpus' }
$counts = $countsJson | ConvertFrom-Json
if (-not $counts.releaseSafe -or [int]$counts.unsafeAbstracts -ne 0) { throw 'Refusing to package a corpus that is not marked release-safe' }
$manifest = [ordered]@{
    product = 'Anru'
    version = [string]$packageMetadata.version
    platform = 'windows-x64'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    runtime = 'Pi Agent Core + Electron SQLite'
    corpus = [ordered]@{
        papers = [int]$counts.papers
        abstracts = [int]$counts.abstracts
        redistributableAbstracts = [int]$counts.redistributableAbstracts
        releaseSafe = [bool]$counts.releaseSafe
        sourceRecords = [int]$counts.sources
        databaseBytes = (Get-Item -LiteralPath $database).Length
    }
    sha256 = $sha
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $destination 'MANIFEST.json') -Encoding utf8

$measure = Get-ChildItem -LiteralPath $destination -Recurse -File | Measure-Object Length -Sum
[pscustomobject]@{
    Destination = $destination
    Files = $measure.Count
    Bytes = $measure.Sum
    MiB = [math]::Round($measure.Sum / 1MB, 1)
}
