# Updates the ARK Overseer service from the recorded checkout or from a GitHub release. The Update button
# on the This computer page writes data\update-request.json, then opens the ark-overseer-update: link,
# which service.ps1 registered for the Windows account that installed the service. The link starts this
# script in that account's session, where it can ask Windows for administrator approval (a service
# cannot). Approved, it checks the request strictly, downloads a GitHub archive itself when asked, and
# runs service.ps1 install -Force -Start. The outcome is left in Root\logs\update-result.json.
# The request never chooses the repository, an archive or a command.
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

# The published repository. updater.json may override it; the request may not.
$Repository = 'neostryder/ark-overseer'
$ApiBase = 'https://api.github.com'
$CodeloadBase = 'https://codeload.github.com'
$TagPattern = '^v\d+\.\d+\.\d+(-beta\.\d+)?$'
$CommitPattern = '^[0-9a-f]{40}$'
$MaxRequestAge = [TimeSpan]::FromMinutes(15)
$System = '*S-1-5-18'
$Administrators = '*S-1-5-32-544'
$Icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'

# A folder counts only if it holds a git checkout whose package.json name is ark-overseer. This is read
# without running git, which refuses a repository owned by another user.
function Test-OverseerCheckout([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $Path '.git'))) { return $false }
  $manifest = Join-Path $Path 'package.json'
  if (-not (Test-Path -LiteralPath $manifest)) { return $false }
  try { return ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name -eq 'ark-overseer') }
  catch { return $false }
}

function Compare-Tag([string]$A, [string]$B) {
  $pa = $null; $pb = $null
  if ($A -match $TagPattern) { $pa = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $(if ($Matches[4]) { [int]$Matches[4] } else { [int]::MaxValue })) }
  if ($B -match $TagPattern) { $pb = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $(if ($Matches[4]) { [int]$Matches[4] } else { [int]::MaxValue })) }
  if (-not $pa) { return -1 }
  if (-not $pb) { return 1 }
  for ($i = 0; $i -lt 4; $i++) { if ($pa[$i] -ne $pb[$i]) { return [Math]::Sign($pa[$i] - $pb[$i]) } }
  return 0
}

function Get-GitHubJson([string]$Url) {
  $headers = @{ 'User-Agent' = 'ark-overseer'; 'Accept' = 'application/vnd.github+json' }
  return Invoke-RestMethod -Uri $Url -Headers $headers
}

# Which commit a tag points at. An annotated tag is peeled to the commit it wraps.
function Resolve-Commit([string]$Ref) {
  if ($Ref -match $CommitPattern) { return $Ref }
  $response = Get-GitHubJson "$ApiBase/repos/$repository/git/ref/tags/$Ref"
  $object = $response.object
  if ($object.type -eq 'tag') { $object = (Get-GitHubJson $object.url).object }
  if ($object.sha -notmatch $CommitPattern) { throw "The tag $Ref did not point at a commit." }
  return $object.sha
}

# The newest ref on a channel, for a request that did not name one.
function Get-NewestRef([string]$Channel) {
  if ($Channel -eq 'edge') {
    $commit = Get-GitHubJson "$ApiBase/repos/$repository/commits/main"
    if ($commit.sha -notmatch $CommitPattern) { throw 'main had no commit.' }
    return @{ ref = $commit.sha; commit = $commit.sha; tag = $null }
  }
  $releases = Get-GitHubJson "$ApiBase/repos/$repository/releases?per_page=100"
  $best = $null
  foreach ($release in @($releases)) {
    if ($release.draft) { continue }
    if ($release.tag_name -notmatch $TagPattern) { continue }
    if ($Channel -eq 'stable' -and $release.tag_name -match '-beta\.') { continue }
    if (-not $best -or (Compare-Tag $release.tag_name $best) -gt 0) { $best = $release.tag_name }
  }
  if (-not $best) { throw "No releases were found for $Channel." }
  return @{ ref = $best; commit = (Resolve-Commit $best); tag = $best }
}

$data = Join-Path $Root 'data'
$logs = Join-Path $Root 'logs'

# The service writes only this small file. Everything below checks it again before acting on it.
$requestFile = Join-Path $data 'update-request.json'
if (-not (Test-Path -LiteralPath $requestFile)) {
  Write-Output 'FAIL: There is no update request. Open the This computer page and try again.'
  exit 1
}
try { $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json }
catch { Write-Output 'FAIL: The update request could not be read.'; exit 1 }

$reason = $null
if ($request.PSObject.Properties.Name -contains 'repository') {
  $reason = 'The request may not choose the repository.'
}
elseif ($request.source -notin @('checkout', 'github')) {
  $reason = 'The request must choose a checkout or GitHub.'
}
elseif (-not $request.requestedAt) {
  $reason = 'The request has no time.'
}
else {
  $requested = $null
  try { $requested = ([datetime]$request.requestedAt).ToUniversalTime() } catch { $requested = $null }
  $age = if ($requested) { (Get-Date).ToUniversalTime() - $requested } else { $null }
  if (-not $age) { $reason = 'The request has no valid time.' }
  elseif ($age -gt $MaxRequestAge) { $reason = 'The request is too old. Open the This computer page and try again.' }
}
if (-not $reason -and $request.source -eq 'checkout') {
  if ($request.checkout -match '^\\\\') { $reason = 'The checkout must be a local folder, not a network share.' }
  elseif ($request.checkout -notmatch '^[A-Za-z]:[\\/]') { $reason = 'The checkout must be a full local folder path.' }
  elseif (-not (Test-OverseerCheckout $request.checkout)) { $reason = 'That folder is not an ARK Overseer checkout.' }
}
if (-not $reason -and $request.source -eq 'github') {
  if ($request.channel -and $request.channel -notin @('stable', 'beta', 'edge')) { $reason = 'The channel must be Stable, Beta or Edge.' }
  elseif ($request.ref -and $request.ref -notmatch $TagPattern -and $request.ref -notmatch $CommitPattern) {
    $reason = 'The ref must be a release tag or a 40-character commit id.'
  }
}
if ($reason) { Write-Output "FAIL: $reason"; exit 1 }

$options = $null
try { $options = Get-Content -LiteralPath (Join-Path $data 'updater.json') -Raw | ConvertFrom-Json }
catch { Write-Output 'FAIL: The update options could not be read. Run the installer again.'; exit 1 }
if ($options.repository -and $options.repository -match '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { $repository = $options.repository }
else { $repository = $Repository }

# The service.ps1 that runs is the one in the recorded checkout, or, when the service was installed from
# GitHub with no checkout, the one in the deployed app folder.
$fromCheckout = Test-OverseerCheckout $options.appDir
$serviceScript = if ($fromCheckout) { Join-Path $options.appDir 'tools\service.ps1' } else { Join-Path $Root 'app\tools\service.ps1' }
$grant = @($options.grantFolder | Where-Object { $_ })

# Where node_modules and the search model come from. A checkout keeps them; a GitHub install uses the
# deployed app, which was installed from a checkout once.
$appDir = if ($request.source -eq 'checkout') { $request.checkout } elseif ($fromCheckout) { $options.appDir } else { Join-Path $Root 'app' }
$ref = $request.ref
$commit = $null
$downloadUrl = $null
$resolveUrl = $null
$zip = $null

if ($request.source -eq 'github') {
  if (-not $ref) {
    if ($DryRun) {
      $resolveUrl = if ($request.channel -eq 'edge') { "$ApiBase/repos/$repository/commits/main" } else { "$ApiBase/repos/$repository/releases?per_page=100" }
      $ref = '<newest>'
    }
    else {
      $newest = Get-NewestRef $(if ($request.channel) { $request.channel } else { 'stable' })
      $ref = $newest.ref
      $commit = $newest.commit
    }
  }
  $downloadUrl = "$CodeloadBase/$repository/zip/$ref"
  if ($ref -match $CommitPattern) {
    if (-not $commit) { $commit = $ref }
  }
  elseif (-not $commit) {
    $resolveUrl = "$ApiBase/repos/$repository/git/ref/tags/$ref"
    if ($DryRun) { $commit = '<commit>' }
  }
  if ($DryRun) {
    if (-not $zip) {
      $zip = Join-Path ([IO.Path]::GetTempPath()) 'ark-overseer-download\archive.zip'
    }
  }
  else {
    if (-not $commit) { $commit = Resolve-Commit $ref }
    $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) "ark-overseer-download-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
    # Only administrators and SYSTEM may reach the downloaded archive.
    & $Icacls $downloadRoot '/inheritance:r' '/grant:r' "${Administrators}:(OI)(CI)F" "${System}:(OI)(CI)F" | Out-Null
    $zip = Join-Path $downloadRoot 'archive.zip'
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zip -MaximumRedirection 5
  }
}

$shown = "$serviceScript install -Force -Start -AppDir `"$appDir`" -Root `"$Root`" -Port $([int]$options.port)"
if ($grant.Count) { $shown += ' -GrantFolder ' + (($grant | ForEach-Object { "`"$_`"" }) -join ',') }
if ($request.source -eq 'github') { $shown += " -Archive `"$zip`" -Commit `"$commit`"" }

if ($DryRun) {
  Write-Output "CHECK: source $($request.source)"
  if ($request.source -eq 'checkout') { Write-Output "CHECK: checkout $($request.checkout)" }
  else {
    Write-Output "CHECK: channel $(if ($request.channel) { $request.channel } else { 'stable' })"
    Write-Output "CHECK: ref $ref"
    if ($resolveUrl) { Write-Output "API: $resolveUrl" }
    Write-Output "URL: $downloadUrl"
  }
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
  $arguments = @('install', '-Force', '-Start', '-AppDir', $appDir, '-Root', $Root, '-Port', [int]$options.port)
  if ($grant.Count) { $arguments += @('-GrantFolder') + $grant }
  if ($request.source -eq 'github') { $arguments += @('-Archive', $zip, '-Commit', $commit) }
  & $serviceScript @arguments *>&1 | ForEach-Object { $lines.Add("$_") }
  $code = $LASTEXITCODE
}
catch {
  $lines.Add("ERROR: $($_.Exception.Message)")
  $code = 1
}
$failure = $lines | Where-Object { $_ -match '^(FAIL|ERROR): ' } | Select-Object -Last 1
$commitFile = Join-Path $Root 'app\.deployed-commit'
$deployed = if (Test-Path -LiteralPath $commitFile) { (Get-Content -LiteralPath $commitFile -Raw).Trim() } else { $null }
$result = [ordered]@{
  ok        = ($code -eq 0 -and -not $failure)
  startedAt = $started
  endedAt   = (Get-Date).ToUniversalTime().ToString('o')
  exitCode  = $code
  source    = $request.source
  channel   = $request.channel
  ref       = $ref
  commit    = if ($deployed) { $deployed } else { $commit }
  message   = if ($failure) { $failure -replace '^(FAIL|ERROR): ', '' } else { $null }
}
New-Item -ItemType Directory -Path $logs -Force | Out-Null
Set-Content -LiteralPath (Join-Path $logs 'update.log') -Value $lines -Encoding utf8NoBOM
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'update-result.json') -Encoding utf8NoBOM
exit $code
