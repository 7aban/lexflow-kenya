param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$leases = [Collections.Generic.List[IDisposable]]::new()
$moved = [Collections.Generic.List[object]]::new()
$lockStream = $null
$lockOwned = $false
$published = $false
$result = @{success=$false; recoverable=$false}
try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath($request.targetDb)
  $operationDir = [IO.Path]::GetFullPath($request.operationDir)
  if ([IO.Path]::GetDirectoryName($operationDir) -ne [IO.Path]::GetDirectoryName($target) -or
      [IO.Path]::GetFileName($operationDir) -notlike '.lexflow-restore-*') { throw 'Unsafe restoration staging location' }
  $staged = Join-Path $operationDir 'restored.db'
  $rollback = Join-Path $operationDir 'original'
  $lockPath = $target + '.restore-lock'
  $lockStream = [IO.FileStream]::new($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $lockOwned = $true
  $paths = @($target, ($target+'-wal'), ($target+'-shm'), ($target+'-journal'))
  if ($target -match '(?i)\.db$') { $paths += @(($target -replace '(?i)\.db$', '-wal.db'), ($target -replace '(?i)\.db$', '-shm.db')) }
  if ([IO.File]::Exists($target) -and -not $request.force) { throw 'Target database already exists; use --force to overwrite' }
  if ([IO.Directory]::Exists($target)) { throw 'Target database is a directory' }
  # Deny reader/writer sharing while permitting same-volume renames. Active
  # SQLite/file handles conflict: refuse before any destination file moves.
  foreach ($file in $paths) {
    if ([IO.File]::Exists($file)) {
      if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a reparse-point destination or sidecar' }
      try { $leases.Add([IO.FileStream]::new($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Delete)) }
      catch { throw "Destination must be offline; cannot lease $file : $($_.Exception.Message)" }
    }
  }
  [IO.Directory]::CreateDirectory($rollback) | Out-Null
  $journal = Join-Path $operationDir 'recovery.json'
  @{target=$target; originalDirectory=$rollback; state='prepared'; paths=$paths} | ConvertTo-Json | Set-Content -LiteralPath $journal -Encoding UTF8
  foreach ($file in $paths) {
    if ([IO.File]::Exists($file)) {
      $saved = Join-Path $rollback ([IO.Path]::GetFileName($file))
      [IO.File]::Move($file, $saved)
      $moved.Add(@{source=$file; saved=$saved})
    }
  }
  [IO.File]::Move($staged, $target)
  $published = $true
  @{target=$target; originalDirectory=$rollback; state='published'; moved=$moved.ToArray()} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $journal -Encoding UTF8
  $result = @{success=$true; recoverable=$false; preservedOriginals=$moved.Count}
} catch {
  $failureReason = $_.Exception.Message
  $recoveryErrors = [Collections.Generic.List[string]]::new()
  if ($published) {
    try { [IO.File]::Move($target, $staged) } catch { $recoveryErrors.Add($_.Exception.Message) }
  }
  for ($i=$moved.Count-1; $i -ge 0; $i--) {
    try { [IO.File]::Move($moved[$i].saved, $moved[$i].source) } catch { $recoveryErrors.Add($_.Exception.Message) }
  }
  if ($recoveryErrors.Count) {
    $result = @{success=$false; recoverable=$true; error="Replacement failed: $failureReason; recovery incomplete: $($recoveryErrors -join '; '); preserved files: $operationDir"}
  } else {
    $result = @{success=$false; recoverable=$false; error="Replacement failed: $failureReason; original state preserved/restored"}
  }
} finally {
  foreach ($lease in $leases) { $lease.Dispose() }
  if ($lockStream) { $lockStream.Dispose() }
  if ($lockOwned) {
    try { [IO.File]::Delete($lockPath) } catch {
      $result = @{success=$false; recoverable=$true; error="Restore lock cleanup failed; retain recovery files at $operationDir : $($_.Exception.Message)"}
    }
  }
}
$result | ConvertTo-Json -Compress
if ($result.success) { exit 0 } else { exit 1 }
