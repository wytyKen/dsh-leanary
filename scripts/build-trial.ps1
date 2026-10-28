[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
function Get-TrialDigest([string]$TaskFile) {
    $taskStream = [IO.File]::OpenRead($TaskFile)
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-','').ToLowerInvariant() }
    finally { $taskHasher.Dispose(); $taskStream.Dispose() }
}
$taskProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskManifest = Get-Content -LiteralPath (Join-Path $taskProject 'package.json') -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $taskProject 'artifacts/trials' }
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
$null = New-Item -ItemType Directory -Path $taskOutput -Force
$taskStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$taskBuild = Join-Path $taskOutput ('trial-' + $taskStamp)
$null = New-Item -ItemType Directory -Path $taskBuild
$taskName = $taskManifest.name -replace '[^A-Za-z0-9_.-]', '-'
$taskTarName = "$taskName-$($taskManifest.version).tgz"
Push-Location $taskProject
try {
    & pnpm pack --pack-destination $taskBuild
    if ($LASTEXITCODE -ne 0) { throw 'Plugin packaging failed; the build directory was preserved.' }
} finally { Pop-Location }
$taskTar = Join-Path $taskBuild $taskTarName
if (-not (Test-Path -LiteralPath $taskTar -PathType Leaf)) { throw "Expected archive was not produced: $taskTar" }
$taskBundleName = "$taskName-$($taskManifest.version)-trial"
$taskBundle = Join-Path $taskBuild $taskBundleName
$null = New-Item -ItemType Directory -Path $taskBundle
Copy-Item -LiteralPath $taskTar -Destination (Join-Path $taskBundle $taskTarName)
Copy-Item -LiteralPath (Join-Path $taskProject 'docs/QUICKSTART.md') -Destination (Join-Path $taskBundle 'START_HERE.md')
$taskExample = Join-Path $taskBundle 'example'
$null = New-Item -ItemType Directory -Path $taskExample
foreach ($taskFile in @('problem.md','OrderBound.lean','lean-toolchain','README.md')) {
    Copy-Item -LiteralPath (Join-Path $taskProject "examples/order-bound/$taskFile") -Destination (Join-Path $taskExample $taskFile)
}
$taskZip = Join-Path $taskBuild ($taskBundleName + '.zip')
Compress-Archive -LiteralPath $taskBundle -DestinationPath $taskZip
$taskResult = [ordered]@{
    version = $taskManifest.version
    archive = $taskTar
    archiveSha256 = Get-TrialDigest $taskTar
    trialZip = $taskZip
    trialZipSha256 = Get-TrialDigest $taskZip
    trialDirectory = $taskBundle
    modelRequests = 0
}
$taskResultPath = Join-Path $taskBuild 'build-result.json'
[IO.File]::WriteAllText($taskResultPath, ($taskResult | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
$taskResult | ConvertTo-Json
