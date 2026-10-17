param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')][string]$Label,
    [Parameter(Mandatory=$true)][string]$PythonExecutable,
    [string]$BackupRoot = (Join-Path $env:USERPROFILE '.codex/backups/goal-controller'),
    [switch]$IncludeDatabase
)
$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backupRootPath = [IO.Path]::GetFullPath($BackupRoot)
if ($backupRootPath.StartsWith($repoPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $backupRootPath -eq $repoPath) {
    throw 'Backup root must be outside the repository.'
}
$istanbulZone = [TimeZoneInfo]::FindSystemTimeZoneById('Turkey Standard Time')
$checkpointTime = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::UtcNow, $istanbulZone)
$targetPath = Join-Path $backupRootPath ($Label + '-' + $checkpointTime.ToString('yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $targetPath) { throw 'Checkpoint already exists; will not overwrite.' }
New-Item -ItemType Directory -Force -Path $backupRootPath | Out-Null
New-Item -ItemType Directory -Path $targetPath | Out-Null
$sourceCopyPath = Join-Path $targetPath 'source'
New-Item -ItemType Directory -Path $sourceCopyPath | Out-Null
$excluded = @('.git', 'node_modules', 'out', 'release', 'coverage')
$sourceFiles = foreach ($entry in Get-ChildItem -LiteralPath $repoPath -Force) {
    if ($excluded -contains $entry.Name) { continue }
    if ($entry.PSIsContainer) { Get-ChildItem -LiteralPath $entry.FullName -Recurse -Force -File }
    else { $entry }
}
$sourceManifest = foreach ($file in $sourceFiles) {
    $relative = [IO.Path]::GetRelativePath($repoPath, $file.FullName)
    $destinationFile = Join-Path $sourceCopyPath $relative
    $beforeHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destinationFile)) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destinationFile
    $copyHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
    $afterHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    if ($beforeHash -ne $copyHash -or $afterHash -ne $beforeHash) {
        throw "Source changed during checkpoint: $relative. No complete manifest will be created."
    }
    [ordered]@{ path=$relative; sha256=$copyHash }
}
$dbInfo = $null
if ($IncludeDatabase) {
    $dbDirectory = Join-Path $targetPath 'data'
    New-Item -ItemType Directory -Path $dbDirectory | Out-Null
    $dbCopyPath = Join-Path $dbDirectory 'goal-controller.db'
    $helperOutput = & $PythonExecutable (Join-Path $PSScriptRoot 'backup-controller-db.py') (Join-Path $env:APPDATA 'chatgpt-goal-controller/goal-controller.db') $dbCopyPath
    if ($LASTEXITCODE -ne 0) { throw 'Database snapshot failed; checkpoint is incomplete.' }
    $dbInfo = $helperOutput | ConvertFrom-Json
    $dbInfo | Add-Member -NotePropertyName sha256 -NotePropertyValue ((Get-FileHash -LiteralPath $dbCopyPath -Algorithm SHA256).Hash)
}
$repoVersion = (Get-Content -LiteralPath (Join-Path $repoPath 'package.json') -Raw | ConvertFrom-Json).version
$headCommit = & git -C $repoPath rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot record Git baseline.' }
$workingStatus = @(& git -C $repoPath status --short)
if ($LASTEXITCODE -ne 0) { throw 'Cannot record working status.' }
$manifest = [ordered]@{
    complete=$true; label=$Label; createdAt=$checkpointTime.ToString('o'); timezone='Europe/Istanbul';
    appVersion=$repoVersion; gitHead=$headCommit; gitStatus=$workingStatus;
    excludes=$excluded; sourceFiles=@($sourceManifest); database=$dbInfo;
    testsRun=$false; liveGoalWrites=$false; published=$false
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $targetPath 'manifest.json') -Encoding utf8
[ordered]@{ checkpoint=$targetPath; complete=$true; appVersion=$repoVersion; sourceFileCount=@($sourceManifest).Count; database=$dbInfo } | ConvertTo-Json -Depth 5
