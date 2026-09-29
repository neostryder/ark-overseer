param([switch]$DryRun, [int]$Port = 3310, [Parameter(DontShow)][switch]$TestPortBusy, [Parameter(DontShow)][switch]$TestPortFree, [Parameter(DontShow)][switch]$TestAlreadyInstalled)
$Text = @{
  plan = 'ARK Overseer will install as a Windows service and keep its data in ProgramData.'
  admin = 'Administrator approval is needed to install the service.'
  elevate = 'STEP: Request administrator approval once'
  platform = 'ARK Overseer needs 64-bit Windows 10 or later.'
  port = 'Port 3310 is in use. The next free port is {0}.'
  noPort = 'Ports 3310 through 3320 are in use.'
  update = 'ARK Overseer is already installed. Update it and keep its data and servers? [Y/n]'
  kept = 'The data and servers are kept.'
  declined = 'The installed service was left unchanged.'
  failed = 'Install failed at {0}. Log files are in {1}.'
  checkWindows = 'STEP: Check Windows version and 64-bit support'
  checkPort = 'STEP: Check port {0}'
  installService = 'STEP: Install the service'
  updateService = 'STEP: Update the existing service and keep its data and servers'
  runService = 'STEP: Run service.ps1 {0} -DryRun'
  wait = 'Press Enter to close'
  serviceError = 'service.ps1 exited with {0}'
  dataLogs = 'Data is in {0}. Logs are in {1}.'
  url = 'http://localhost:{0}/'
}
$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $PSScriptRoot
$root = 'C:\ProgramData\ARK Overseer'
$logs = Join-Path $root 'logs'
$step = 'starting'
trap {
  Write-Output ($Text.failed -f $step, $logs)
  Write-Output $_.Exception.Message
  if (-not $DryRun) { Read-Host $Text.wait }
  exit 1
}
Write-Output $Text.plan
if ($DryRun) { Write-Output $Text.elevate }
if (-not $DryRun) {
  $identity = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Output $Text.admin
    $elevatedArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
    if ($PSBoundParameters.ContainsKey('Port')) { $elevatedArgs += @('-Port', $Port) }
    $elevated = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $elevatedArgs -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
  }
}
$step = 'checking Windows'
Write-Output $Text.checkWindows
if ([Environment]::Is64BitOperatingSystem -eq $false -or [Environment]::OSVersion.Version.Major -lt 10) { throw $Text.platform }
$step = 'checking port'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { if ($TestPortBusy) { throw 'Test port is busy.' }; if (-not $TestPortFree) { $listener.Start(); $listener.Stop() } }
catch {
  $listener.Stop()
  $available = $null
  foreach ($candidate in 3311..3320) {
    if ($TestPortBusy) { $available = $candidate; break }
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
    try { $probe.Start(); $probe.Stop(); $available = $candidate; break } catch { $probe.Stop() }
  }
  if (-not $available) { throw $Text.noPort }
  Write-Output ($Text.port -f $available)
  $Port = $available
}
Write-Output ($Text.checkPort -f $Port)
$step = 'checking existing service'
$installed = [bool](Get-Service -Name ArkOverseer -ErrorAction SilentlyContinue) -or $TestAlreadyInstalled
if ($installed) {
  Write-Output $Text.updateService
  if (-not $DryRun -and (Read-Host $Text.update) -match '^[Nn]') { Write-Output $Text.declined; exit 0 }
} else { Write-Output $Text.installService }
$step = 'installing service'
$serviceArgs = @('-NoProfile', '-File', ('"{0}"' -f (Join-Path $PSScriptRoot 'service.ps1')), 'install', '-Package', '-Start', '-AppDir', ('"{0}"' -f $packageDir), '-Port', $Port, '-Root', ('"{0}"' -f $root))
if ($installed) { $serviceArgs += '-Force' }
if ($DryRun) {
  Write-Output ($Text.runService -f ($serviceArgs -join ' '))
  exit 0
}
$serviceOutput = Join-Path ([IO.Path]::GetTempPath()) "ark-overseer-install-$PID.txt"
$serviceError = "$serviceOutput.err"
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$child = Start-Process -FilePath $pwshPath -ArgumentList $serviceArgs -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $serviceOutput -RedirectStandardError $serviceError
if ($child.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $serviceOutput) { Get-Content -LiteralPath $serviceOutput | ForEach-Object { Write-Output $_ } }
  if (Test-Path -LiteralPath $serviceError) { Get-Content -LiteralPath $serviceError | ForEach-Object { Write-Output $_ } }
  throw ($Text.serviceError -f $child.ExitCode)
}
Remove-Item -LiteralPath $serviceOutput -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $serviceError -Force -ErrorAction SilentlyContinue
Start-Process ($Text.url -f $Port)
if ($installed) { Write-Output $Text.kept }
Write-Output ($Text.dataLogs -f (Join-Path $root 'data'), $logs)
