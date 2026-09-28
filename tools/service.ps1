# Installs, removes or reports ARK Overseer as a Windows service run by shawl as Network Service.
# Run install and uninstall from an administrator PowerShell 7. -DryRun prints every step and changes nothing.
# The service runs its own copy of the checkout's last commit, under Root\app, so uncommitted work never
# goes live and Network Service needs no rights on the repo or the folders above it. Installing again with
# -Force deploys the current commit.
# 7.3 is the first version that passes an empty argument, such as sc.exe's password=, to a program.
#Requires -Version 7.3
param(
  [Parameter(Position = 0)][ValidateSet('install', 'uninstall', 'status')][string]$Action = 'status',
  [string]$AppDir = (Split-Path -Parent $PSScriptRoot),
  [string]$Root = 'C:\ProgramData\ARK Overseer',
  [string]$ShawlZip,
  [string]$PwshZip,
  [string[]]$GrantFolder = @(),
  [int]$Port = 3310,
  [switch]$Start,
  [switch]$Force,
  [switch]$RemoveData,
  [switch]$DryRun,
  [Parameter(DontShow)][string]$ServiceName = 'ArkOverseer'
)
$ErrorActionPreference = 'Stop'
if (-not $ShawlZip) { $ShawlZip = Join-Path $AppDir 'vendor\shawl-v1.9.0-win64.zip' }
if (-not $PwshZip) { $PwshZip = Join-Path $AppDir 'vendor\PowerShell-7.6.6-win-x64.zip' }
$Hashes = @{
  $ShawlZip = 'f883c5d09c9beae2efaeabd8513e7d3f57cd1d0864cec3df4f4a7b6ee904351c'
  $PwshZip  = '02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860'
}
# Well-known SIDs, so the grants work on any Windows display language.
$NetworkService = '*S-1-5-20'
$System = '*S-1-5-18'
$Administrators = '*S-1-5-32-544'
$Icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
$Sc = Join-Path $env:SystemRoot 'System32\sc.exe'
$script:Failed = $false

function Quote([string]$Text) { '"' + $Text + '"' }

# A PowerShell step: prints what it will do, then runs the block unless this is a dry run.
function Invoke-Step([string]$Description, [string]$Shown, [scriptblock]$Block) {
  Write-Output "STEP: $Description :: $Shown"
  if (-not $DryRun) { & $Block }
}

# A native step: the printed line and the call are built from the same argument array.
# robocopy reports success with exit codes up to 7, hence -MaxSuccess.
function Invoke-Native([string]$Description, [string]$Exe, [string[]]$Arguments, [int]$MaxSuccess = 0) {
  Write-Output "STEP: $Description :: $(Quote $Exe) $(($Arguments | ForEach-Object { Quote $_ }) -join ' ')"
  if ($DryRun) { return }
  $global:LASTEXITCODE = 0
  & $Exe @Arguments
  if ($LASTEXITCODE -gt $MaxSuccess -or $LASTEXITCODE -lt 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}

function Fail([string]$Reason) {
  Write-Output "FAIL: $Reason"
  $script:Failed = $true
  if (-not $DryRun) { exit 1 }
}

function Wait-ServiceGone {
  $deadline = (Get-Date).AddSeconds(60)
  while (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    # A service stays marked for deletion while anything, such as the Services window, holds it open.
    if ((Get-Date) -gt $deadline) { throw "$ServiceName is still marked for deletion. Close the Services window and run this again." }
    Start-Sleep -Seconds 1
  }
}

function Remove-ExistingService {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $service) { Write-Output "SKIP: The $ServiceName service is not installed."; return }
  Invoke-Step 'Stop the service' "Stop-Service $ServiceName, waiting up to 90 seconds" {
    if ($service.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force -NoWait
      $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90))
    }
  }
  Invoke-Native 'Delete the service' $Sc @('delete', $ServiceName)
  Invoke-Step 'Wait for the service to go' "Get-Service $ServiceName until it is gone, up to 60 seconds" { Wait-ServiceGone }
}

if ($Action -eq 'status') {
  $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
  if (-not $service) { Write-Output "$ServiceName is not installed."; exit 0 }
  Write-Output "Service: $ServiceName"
  Write-Output "State: $($service.State)"
  Write-Output "Account: $($service.StartName)"
  Write-Output "Start type: $($service.StartMode)"
  Write-Output "Command: $($service.PathName)"
  $deployed = Join-Path $Root 'app\.deployed-commit'
  if (Test-Path -LiteralPath $deployed) { Write-Output "Deployed commit: $((Get-Content -LiteralPath $deployed -Raw).Trim())" }
  exit 0
}

if (-not $DryRun) {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Output 'FAIL: Run this from an administrator PowerShell.'
    exit 1
  }
}

$Runtime = Join-Path $Root 'runtime'
$App = Join-Path $Root 'app'
$Data = Join-Path $Root 'data'
$Logs = Join-Path $Root 'logs'
# The link is registered under the installing account's own classes, so it needs no machine-wide change.
# A service under another name (as in the tests) gets its own link, so it never replaces the real one.
$LinkScheme = if ($ServiceName -eq 'ArkOverseer') { 'ark-overseer-update' } else { "ark-overseer-update-$($ServiceName.ToLowerInvariant())" }
$UpdateLink = "HKCU:\Software\Classes\$LinkScheme"

if ($Action -eq 'install') {
  foreach ($zip in @($ShawlZip, $PwshZip)) {
    if (-not (Test-Path -LiteralPath $zip)) { Fail "Missing zip: $zip"; continue }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Hashes[$zip]) { Fail "SHA-256 mismatch for ${zip}: expected $($Hashes[$zip]), got $actual" }
  }

  # nvm4w reaches node.exe through a symlink, and the service needs the real file.
  $command = Get-Command node -ErrorAction SilentlyContinue
  $node = $null
  if (-not $command) { Fail 'node.exe was not found on PATH.' }
  else {
    $item = Get-Item -LiteralPath $command.Source
    while ($item.LinkType) {
      $target = [string]($item.Target | Select-Object -First 1)
      if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $item.DirectoryName $target }
      $item = Get-Item -LiteralPath $target
    }
    if ($item.PSIsContainer) { $item = Get-Item -LiteralPath (Join-Path $item.FullName 'node.exe') }
    $node = $item.FullName
    $version = & $node --version
    if ($version -notmatch '^v(\d+)\.') { Fail "Could not read the Node version from $node." }
    elseif ([int]$Matches[1] -lt 26) { Fail "ARK Overseer needs Node 26 or later; $node is $version." }
  }

  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    if (-not $Force) { Fail "The $ServiceName service already exists. Run again with -Force to replace it." }
    else { Remove-ExistingService }
  }

  $nodeDir = Join-Path $Runtime 'node'
  $shawlDir = Join-Path $Runtime 'shawl'
  $pwshDir = Join-Path $Runtime 'pwsh'
  foreach ($dir in @($nodeDir, $shawlDir, $pwshDir, $Data, $Logs)) {
    Invoke-Step "Create $dir" "New-Item -ItemType Directory -Force $(Quote $dir)" { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  }
  $nodeExe = Join-Path $nodeDir 'node.exe'
  Invoke-Step 'Copy Node' "Copy-Item $(Quote $node) $(Quote $nodeExe)" { Copy-Item -LiteralPath $node -Destination $nodeExe -Force }
  Invoke-Step 'Expand shawl' "Expand-Archive $(Quote $ShawlZip) $(Quote $shawlDir)" { Expand-Archive -LiteralPath $ShawlZip -DestinationPath $shawlDir -Force }
  Invoke-Step 'Expand PowerShell' "Expand-Archive $(Quote $PwshZip) $(Quote $pwshDir)" { Expand-Archive -LiteralPath $PwshZip -DestinationPath $pwshDir -Force }
  # Only committed files are deployed. node_modules is copied from the checkout, since the runtime has no npm.
  $commit = git -C $AppDir rev-parse --verify HEAD 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $commit) { Fail "$AppDir is not a git checkout with a commit to deploy."; $commit = 'HEAD' }
  elseif (git -C $AppDir status --porcelain) { Write-Output "NOTE: $AppDir has uncommitted changes. They are not deployed; the service runs commit $commit." }
  if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'node_modules'))) { Fail "$AppDir has no node_modules. Run npm ci there first." }
  $archive = Join-Path ([IO.Path]::GetTempPath()) "ark-overseer-$commit.zip"
  if ($DryRun -or (Test-Path -LiteralPath $App)) {
    Invoke-Step 'Remove the old app copy' "Remove-Item $(Quote $App) -Recurse -Force" { if (Test-Path -LiteralPath $App) { Remove-Item -LiteralPath $App -Recurse -Force } }
  }
  Invoke-Native "Export commit $commit" 'git' @('-C', $AppDir, 'archive', '--format=zip', '-o', $archive, $commit)
  Invoke-Step 'Unpack the app' "Expand-Archive $(Quote $archive) $(Quote $App)" {
    Expand-Archive -LiteralPath $archive -DestinationPath $App -Force
    Remove-Item -LiteralPath $archive
    Set-Content -LiteralPath (Join-Path $App '.deployed-commit') -Value $commit -NoNewline
  }
  Invoke-Native 'Copy node_modules' (Join-Path $env:SystemRoot 'System32\robocopy.exe') @((Join-Path $AppDir 'node_modules'), (Join-Path $App 'node_modules'), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1') 7
  $modelSource = Join-Path $AppDir '.model-cache'
  $modelCache = Join-Path $Data 'model-cache'
  if ((Test-Path -LiteralPath $modelSource) -and -not (Test-Path -LiteralPath $modelCache)) {
    Invoke-Step 'Copy the search model' "Copy-Item $(Quote $modelSource) $(Quote $modelCache) -Recurse" { Copy-Item -LiteralPath $modelSource -Destination $modelCache -Recurse }
  }

  # Inherited grants on the folder reach everything inside it, so no /T is needed.
  foreach ($dir in @($App, $Runtime)) {
    Invoke-Native "Let Network Service read $dir" $Icacls @($dir, '/grant', "${NetworkService}:(OI)(CI)RX")
  }
  # The database holds the password hash and the session secret, so data and logs drop the
  # read access every local user inherits from ProgramData.
  foreach ($dir in @($Data, $Logs)) {
    Invoke-Native "Limit $dir to the service and administrators" $Icacls @($dir, '/inheritance:r', '/grant:r', "${System}:(OI)(CI)F", "${Administrators}:(OI)(CI)F", "${NetworkService}:(OI)(CI)M")
  }
  $folders = @($GrantFolder)
  if ((Test-Path -LiteralPath (Join-Path $Data 'overseer.db')) -and $node) {
    $folders += @(& $node (Join-Path $AppDir 'tools\list-install-folders.js') $Data)
  }
  foreach ($dir in ($folders | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $dir)) { Write-Output "SKIP: $dir does not exist."; continue }
    Invoke-Native "Let Network Service change $dir" $Icacls @($dir, '/grant', "${NetworkService}:(OI)(CI)M")
  }

  $shawlArguments = @(
    'add', '--name', $ServiceName, '--cwd', $App,
    '--stop-timeout', '60000', '--restart-if-not', '0', '--restart-delay', '10000', '--log-dir', $Logs,
    '--env', "OVERSEER_DATA=$Data", '--env', 'OVERSEER_SERVICE=1',
    '--env', "OVERSEER_PWSH=$(Join-Path $pwshDir 'pwsh.exe')",
    '--env', "OVERSEER_MODEL_CACHE=$modelCache", '--env', "OVERSEER_PORT=$Port", '--env', "OVERSEER_LOGS=$Logs",
    '--', $nodeExe, (Join-Path $App 'src\main.js')
  )
  Invoke-Native 'Create the service' (Join-Path $shawlDir 'shawl.exe') $shawlArguments
  Invoke-Native 'Run it as Network Service, started after boot' $Sc @('config', $ServiceName, 'obj=', 'NT AUTHORITY\NetworkService', 'password=', '', 'start=', 'delayed-auto', 'DisplayName=', 'ARK Overseer')
  Invoke-Native 'Describe the service' $Sc @('description', $ServiceName, 'Runs ARK Overseer, the web manager for ARK: Survival Ascended servers.')
  Invoke-Native 'Restart it if it fails' $Sc @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000//0')

  # The Update button on the This computer page opens the update link, which runs tools\update.ps1 from the
  # checkout in this Windows account's session. It replays this install with the options recorded here.
  $updaterFile = Join-Path $Data 'updater.json'
  $updater = [ordered]@{ appDir = $AppDir; port = $Port; grantFolder = @($GrantFolder); link = $LinkScheme } | ConvertTo-Json -Compress
  Invoke-Step 'Record the update options' "Set-Content $(Quote $updaterFile) $updater" {
    Set-Content -LiteralPath $updaterFile -Value $updater -Encoding utf8NoBOM
  }
  $linkCommand = '"{0}" --headless "{1}" -NoProfile -ExecutionPolicy Bypass -File "{2}" -Root "{3}"' -f `
  (Join-Path $env:SystemRoot 'System32\conhost.exe'), (Join-Path $pwshDir 'pwsh.exe'), (Join-Path $AppDir 'tools\update.ps1'), $Root
  Invoke-Step 'Register the update link for this Windows account' "$UpdateLink :: $linkCommand" {
    New-Item -Path "$UpdateLink\shell\open\command" -Force | Out-Null
    Set-ItemProperty -LiteralPath $UpdateLink -Name '(default)' -Value 'URL:ARK Overseer update'
    Set-ItemProperty -LiteralPath $UpdateLink -Name 'URL Protocol' -Value ''
    Set-ItemProperty -LiteralPath "$UpdateLink\shell\open\command" -Name '(default)' -Value $linkCommand
  }

  if ($Start) {
    Invoke-Step 'Start the service' "Start-Service $ServiceName, then GET http://127.0.0.1:$Port/api/auth/state" {
      Start-Service -Name $ServiceName
      (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
      $deadline = (Get-Date).AddSeconds(30)
      $answered = $false
      while (-not $answered -and (Get-Date) -lt $deadline) {
        try { Invoke-WebRequest "http://127.0.0.1:$Port/api/auth/state" -TimeoutSec 2 | Out-Null; $answered = $true }
        catch { Start-Sleep -Milliseconds 500 }
      }
      if (-not $answered) { throw "The service is running but did not answer on port $Port. Its log is in $Logs." }
    }
  }
  Write-Output "Service: $ServiceName, run as NT AUTHORITY\NetworkService, commit $commit"
  Write-Output "Data: $Data"
  Write-Output "Logs: $Logs"
  Write-Output "Open: http://127.0.0.1:$Port"
}
elseif ($Action -eq 'uninstall') {
  Remove-ExistingService
  # Installs made before the app was deployed under Root granted Network Service on the checkout itself.
  Invoke-Native "Remove any old Network Service grant from $AppDir" $Icacls @($AppDir, '/remove:g', $NetworkService)
  Write-Output 'NOTE: Server install folders keep their Network Service grant.'
  if ($DryRun -or (Test-Path -LiteralPath $UpdateLink)) {
    Invoke-Step 'Remove the update link' "Remove-Item $UpdateLink -Recurse" { Remove-Item -LiteralPath $UpdateLink -Recurse -Force }
  }
  foreach ($dir in @($App, $Runtime, $Logs)) {
    if ($DryRun -or (Test-Path -LiteralPath $dir)) {
      Invoke-Step "Remove $dir" "Remove-Item $(Quote $dir) -Recurse -Force" { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
  }
  if ($RemoveData -and (Test-Path -LiteralPath $Data)) {
    $database = Join-Path $Data 'overseer.db'
    $servers = 0
    if (Test-Path -LiteralPath $database) {
      $count = 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("SELECT COUNT(*) AS n FROM servers").get().n); db.close();'
      $output = & node -e $count $database
      # An unreadable database counts as holding servers, so it is never deleted by mistake.
      if ($LASTEXITCODE -ne 0 -or "$output" -notmatch '^\d+$') { $servers = -1 } else { $servers = [int]$output }
    }
    if ($servers -lt 0) { Write-Output "KEEP: Could not read $database, so $Data stays." }
    elseif ($servers -gt 0) { Write-Output "KEEP: $Data holds $servers servers, so it stays. Delete it yourself if you mean to." }
    else { Invoke-Step "Remove $Data" "Remove-Item $(Quote $Data) -Recurse -Force" { Remove-Item -LiteralPath $Data -Recurse -Force } }
  }
}
if ($script:Failed) { exit 1 }
