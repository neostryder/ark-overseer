# Updates the ARK Overseer service to the checkout's last commit. The Update button on the This computer
# page opens the ark-overseer-update: link, which service.ps1 registers for the Windows account that
# installed the service. The link starts this script in that account's session, where it can ask Windows
# for administrator approval (a service cannot). Approved, it runs service.ps1 install -Force -Start with
# the options recorded at install time and leaves the outcome in Root\logs\update-result.json, which the
# page reads once the service is back. Nothing from the link itself is used.
#Requires -Version 7.3
param(
  [string]$Root = 'C:\ProgramData\ARK Overseer',
  [switch]$Elevated,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) {
  if ($Elevated) { exit 1 }
  $pwsh = (Get-Process -Id $PID).Path
  # The link starts the PowerShell kept in the service's runtime folder, which the install may replace.
  # Windows will not overwrite a program that is running, so the approved run uses a copy in TEMP.
  $pwshHome = Split-Path -Parent $pwsh
  if ($pwshHome.StartsWith((Join-Path $Root 'runtime'), [StringComparison]::OrdinalIgnoreCase)) {
    $temp = [IO.Path]::GetTempPath()
    Get-ChildItem -LiteralPath $temp -Directory -Filter 'ark-overseer-update-pwsh-*' -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    $copy = Join-Path $temp "ark-overseer-update-pwsh-$([guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath $pwshHome -Destination $copy -Recurse
    $pwsh = Join-Path $copy 'pwsh.exe'
  }
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-Root', ('"{0}"' -f $Root), '-Elevated')
  # Declining the Windows prompt throws here, and the page then reports that nothing changed.
  try { Start-Process -FilePath $pwsh -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden } catch { exit 1 }
  exit 0
}

$data = Join-Path $Root 'data'
$logs = Join-Path $Root 'logs'
$options = Get-Content -LiteralPath (Join-Path $data 'updater.json') -Raw | ConvertFrom-Json
$serviceScript = Join-Path $options.appDir 'tools\service.ps1'
$grant = @($options.grantFolder | Where-Object { $_ })
$shown = "$serviceScript install -Force -Start -AppDir `"$($options.appDir)`" -Root `"$Root`" -Port $($options.port)"
if ($grant.Count) { $shown += ' -GrantFolder ' + (($grant | ForEach-Object { "`"$_`"" }) -join ',') }
if ($DryRun) {
  Write-Output "UPDATE: $shown"
  exit 0
}

$started = (Get-Date).ToUniversalTime().ToString('o')
$lines = [System.Collections.Generic.List[string]]::new()
$code = 0
try {
  # Called in this process, so the array of folders binds to -GrantFolder as an array. An exit inside
  # service.ps1 ends only that script and sets LASTEXITCODE.
  $global:LASTEXITCODE = 0
  & $serviceScript install -Force -Start -AppDir $options.appDir -Root $Root -Port ([int]$options.port) -GrantFolder $grant *>&1 |
    ForEach-Object { $lines.Add("$_") }
  $code = $LASTEXITCODE
}
catch {
  $lines.Add("ERROR: $($_.Exception.Message)")
  $code = 1
}
$failure = $lines | Where-Object { $_ -match '^(FAIL|ERROR): ' } | Select-Object -Last 1
$commitFile = Join-Path $Root 'app\.deployed-commit'
$result = [ordered]@{
  ok        = ($code -eq 0 -and -not $failure)
  startedAt = $started
  endedAt   = (Get-Date).ToUniversalTime().ToString('o')
  exitCode  = $code
  commit    = if (Test-Path -LiteralPath $commitFile) { (Get-Content -LiteralPath $commitFile -Raw).Trim() } else { $null }
  message   = if ($failure) { $failure -replace '^(FAIL|ERROR): ', '' } else { $null }
}
New-Item -ItemType Directory -Path $logs -Force | Out-Null
Set-Content -LiteralPath (Join-Path $logs 'update.log') -Value $lines -Encoding utf8NoBOM
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'update-result.json') -Encoding utf8NoBOM
exit $code
