param([switch]$DryRun)
$Text = @{
  plan = 'ARK Overseer will remove its service and program files.'
  admin = 'Administrator approval is needed to uninstall the service.'
  keep = 'Keep the data folder and servers? [Y/n]'
  remove = 'Remove the data folder? Type YES to confirm.'
  elevateStep = 'STEP: Elevate once if needed'
  runStep = 'STEP: Run service.ps1 uninstall'
  keepStep = 'STEP: Ask whether to keep {0} with default keep'
  failed = 'Uninstall failed. The data folder was left in place.'
  wait = 'Press Enter to close'
}
$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $PSScriptRoot
Write-Output $Text.plan
if (-not $DryRun) {
  $identity = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Output $Text.admin
    $elevated = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath)) -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
  }
}
if ($DryRun) {
  Write-Output $Text.elevateStep
  Write-Output $Text.runStep
  Write-Output ($Text.keepStep -f (Join-Path 'C:\ProgramData\ARK Overseer' 'data'))
  exit 0
}
$serviceOutput = Join-Path ([IO.Path]::GetTempPath()) "ark-overseer-uninstall-$PID.txt"
$serviceError = "$serviceOutput.err"
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$serviceArgs = @('-NoProfile', '-File', ('"{0}"' -f (Join-Path $PSScriptRoot 'service.ps1')), 'uninstall', '-AppDir', ('"{0}"' -f $packageDir))
$child = Start-Process -FilePath $pwshPath -ArgumentList $serviceArgs -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $serviceOutput -RedirectStandardError $serviceError
if ($child.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $serviceOutput) { Get-Content -LiteralPath $serviceOutput | ForEach-Object { Write-Output $_ } }
  if (Test-Path -LiteralPath $serviceError) { Get-Content -LiteralPath $serviceError | ForEach-Object { Write-Output $_ } }
  Write-Output $Text.failed
  Read-Host $Text.wait
  exit 1
}
Remove-Item -LiteralPath $serviceOutput, $serviceError -Force -ErrorAction SilentlyContinue
$answer = Read-Host $Text.keep
if ($answer -match '^[Nn]') {
  $confirm = Read-Host $Text.remove
  if ($confirm -ceq 'YES') { Remove-Item -LiteralPath 'C:\ProgramData\ARK Overseer\data' -Recurse -Force }
}
