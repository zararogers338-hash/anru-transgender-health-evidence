$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$release = [IO.Path]::GetFullPath((Join-Path $project 'release'))
$payloadRoot = [IO.Path]::GetFullPath((Join-Path $release 'installer-payload'))
$installerOutput = [IO.Path]::GetFullPath((Join-Path $release 'installer'))
$sevenZip = Join-Path $env:ProgramFiles '7-Zip'
if (-not (Test-Path -LiteralPath $sevenZip)) { throw '7-Zip is required at C:\Program Files\7-Zip' }

foreach ($target in @($payloadRoot, $installerOutput)) {
    if (-not $target.StartsWith($release + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the release directory: $target"
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

Push-Location $project
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Electron build failed' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stage-portable.ps1') -ProjectRoot $project
    if ($LASTEXITCODE -ne 0) { throw 'Release staging failed' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-release-installer.ps1') -PortableDirectory (Join-Path $payloadRoot 'app') -OutputDirectory $installerOutput -SevenZipRoot $sevenZip
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
}
finally {
    Pop-Location
}
