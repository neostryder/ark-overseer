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
  [switch]$DryRun,
  [switch]$FunctionsOnly,
  [string]$ApiBase = 'https://api.github.com',
  [string[]]$AllowedHosts = @('github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com')
)
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun -and -not $FunctionsOnly) {
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
  return Invoke-RestMethod -Uri $Url -Headers $headers | ForEach-Object { $_ }
}

function Get-ReleaseAssets($Release, [string]$Channel) {
  $assets = @($Release.assets)
  if ($Channel -eq 'edge') {
    $packages = @($assets | Where-Object { $_.name -match '^ark-overseer-\d+\.\d+\.\d+-edge\.[0-9a-f]{7,40}-win-x64\.zip$' })
    if ($packages.Count -ne 1) { return $null }
    $package = $packages[0]
    $version = $package.name.Substring('ark-overseer-'.Length, $package.name.Length - 'ark-overseer-'.Length - '-win-x64.zip'.Length)
  }
  else {
    if ($Release.tag_name -notmatch $TagPattern) { return $null }
    $version = $Release.tag_name.Substring(1)
    $expected = "ark-overseer-$version-win-x64.zip"
    $packages = @($assets | Where-Object { $_.name -ceq $expected })
    if ($packages.Count -ne 1) { return $null }
    $package = $packages[0]
  }
  $checksums = @($assets | Where-Object { $_.name -ceq "$($package.name).sha256" })
  if ($checksums.Count -ne 1) { return $null }
  return @{ package = $package; checksum = $checksums[0]; version = $version }
}

function Get-NewestRef([string]$Channel) {
  $releases = @(Get-GitHubJson "$ApiBase/repos/$repository/releases?per_page=100")
  if ($Channel -eq 'edge') {
    $release = $releases | Where-Object { -not $_.draft -and $_.tag_name -ceq 'edge' } | Select-Object -First 1
    $assets = if ($release) { Get-ReleaseAssets $release $Channel } else { $null }
    if (-not $assets) { throw 'No installable Edge package was found.' }
    return @{ ref = $assets.version; commit = ($assets.version -split '\.')[-1]; tag = 'edge'; release = $release; assets = $assets }
  }
  $candidates = foreach ($release in $releases) {
    if ($release.draft -or $release.tag_name -notmatch $TagPattern) { continue }
    if ($Channel -eq 'stable' -and $release.tag_name -match '-beta\.') { continue }
    $assets = Get-ReleaseAssets $release $Channel
    if (-not $assets) { continue } # Releases without both package assets cannot be installed or offered for rollback.
    [pscustomobject]@{ release = $release; assets = $assets }
  }
  $best = $null
  foreach ($candidate in $candidates) {
    if (-not $best -or (Compare-Tag $candidate.release.tag_name $best.release.tag_name) -gt 0) { $best = $candidate }
  }
  if (-not $best) { throw "No installable releases were found for $Channel." }
  return @{ ref = $best.release.tag_name; commit = $null; tag = $best.release.tag_name; release = $best.release; assets = $best.assets }
}

function Test-AllowedAssetUri([string]$Url, [string[]]$Hosts) {
  try {
    $uri = [uri]$Url
    if (($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) -or $uri.UserInfo) { return $false }
    return $Hosts -contains $uri.Host.ToLowerInvariant()
  } catch { return $false }
}

function Receive-Asset([string]$Url, [string]$Path, [string[]]$Hosts, [long]$MaxBytes) {
  $current = [uri]$Url
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler)
  try {
    for ($redirect = 0; $redirect -le 5; $redirect++) {
      if (-not (Test-AllowedAssetUri $current.AbsoluteUri $Hosts)) { throw 'The package asset URL has an unapproved host.' }
      $response = $client.GetAsync($current, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      if ([int]$response.StatusCode -in @(301, 302, 303, 307, 308)) {
        $location = $response.Headers.Location
        $response.Dispose()
        if (-not $location -or $redirect -eq 5) { throw 'The package asset redirect is invalid.' }
        $current = [uri]::new($current, $location)
        continue
      }
      if (-not $response.IsSuccessStatusCode) { throw 'The package asset could not be downloaded.' }
      $contentLength = $response.Content.Headers.ContentLength
      if ($contentLength -gt $MaxBytes) {
        $response.Dispose()
        Test-AssetSize $contentLength $MaxBytes | Out-Null
      }
      $input = $response.Content.ReadAsStream()
      $output = [IO.File]::Create($Path)
      try {
        $buffer = [byte[]]::new(65536); $total = 0L
        while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $total += $read
          Test-AssetSize $total $MaxBytes | Out-Null
          $output.Write($buffer, 0, $read)
        }
      } finally { $output.Dispose(); $input.Dispose(); $response.Dispose() }
      return
    }
  } finally { $client.Dispose(); $handler.Dispose() }
}

function Test-ZipEntryPath([string]$Name) {
  if (-not $Name -or $Name.StartsWith('/') -or $Name.StartsWith('\\') -or $Name -match '^[A-Za-z]:') { return $false }
  $parts = $Name.Replace('\', '/').Split('/')
  if ($parts | Where-Object { $_ -eq '..' }) { return $false }
  return $true
}

function Expand-ReleasePackage([string]$Zip, [string]$Destination, [string]$ExpectedVersion) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    $top = $null
    foreach ($entry in $archive.Entries) {
      if (-not (Test-ZipEntryPath $entry.FullName)) { throw 'The package contains an unsafe path.' }
      $first = ($entry.FullName.Replace('\', '/').Split('/'))[0]
      if (-not $first) { throw 'The package contains an invalid path.' }
      if ($null -eq $top) { $top = $first } elseif ($top -cne $first) { throw 'The package must contain one top folder.' }
      if ($entry.FullName.TrimEnd('/', '\') -eq $first -and -not $entry.FullName.EndsWith('/') -and -not $entry.FullName.EndsWith('\')) {
        throw 'The package must contain one top folder.'
      }
    }
  } finally { $archive.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
  $folders = @(Get-ChildItem -LiteralPath $Destination -Directory)
  if ($folders.Count -ne 1) { throw 'The package must contain one top folder.' }
  $app = $folders[0].FullName
  $releaseFile = Join-Path $app 'RELEASE.json'
  if (-not (Test-Path -LiteralPath $releaseFile)) { throw 'The package has no RELEASE.json.' }
  $release = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json
  if ($release.version -cne $ExpectedVersion) { throw 'The package version does not match the release.' }
  if ($release.commit -notmatch $CommitPattern) { throw 'The package commit is invalid.' }
  return @{ app = $app; commit = $release.commit }
}

function Test-PackageHash([string]$Zip, [string]$ChecksumPath, [string]$Digest) {
  $hash = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumText = Get-Content -LiteralPath $ChecksumPath -Raw
  if ($checksumText -notmatch "(?i)\b$hash\b") {
    Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue
    throw 'The package SHA-256 does not match its checksum file.'
  }
  if ($Digest -and $Digest -cnotmatch "^sha256:$hash$") {
    Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue
    throw 'The package SHA-256 does not match the GitHub asset digest.'
  }
  return $hash
}

function Test-AssetSize([long]$Size, [long]$MaxBytes = 629145600) {
  if ($Size -gt $MaxBytes) { throw 'The package download is larger than 600 MB.' }
  return $true
}

function Remove-UpdateTemp([string]$Path) {
  if ($Path -and (Test-Path -LiteralPath $Path)) {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Write-AtomicJson([string]$Path, $Value) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = ConvertTo-Json -InputObject $Value -Depth 8
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
  }
  finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Write-UpdateProgress([string]$LogsPath, [string]$StartedAt, [string]$Stage, [string]$Message, [string]$Source, [string]$Step = $null) {
  $stages = @('requested', 'checking', 'downloading', 'verifying', 'installing', 'restarting', 'done', 'failed')
  if ($Stage -notin $stages) { throw 'The update progress stage is invalid.' }
  if ($Message -match '[\\/]|[A-Za-z]:|https?://|token|password') { $Message = 'The update failed. Check the update log.' }
  if ($Step -match '[\\/]|[A-Za-z]:|https?://|token|password') { $Step = 'Working on service setup' }
  $progress = [ordered]@{ startedAt = $StartedAt; at = (Get-Date).ToUniversalTime().ToString('o'); stage = $Stage; message = $Message; step = $Step; source = $Source }
  Write-AtomicJson (Join-Path $LogsPath 'update-progress.json') $progress
}

function Write-UpdateResult([string]$LogsPath, $Result) {
  Write-AtomicJson (Join-Path $LogsPath 'update-result.json') $Result
}

function Write-UpdateFailure([string]$LogsPath, [string]$StartedAt, [string]$Reason, [string]$Source = 'unknown') {
  $endedAt = (Get-Date).ToUniversalTime().ToString('o')
  $result = [ordered]@{ ok = $false; startedAt = $StartedAt; endedAt = $endedAt; exitCode = 1; message = $Reason }
  Write-UpdateResult $LogsPath $result
  Write-UpdateProgress $LogsPath $StartedAt 'failed' $Reason $Source
}

function Update-ProgressFromLine([string]$LogsPath, [string]$StartedAt, [string]$Source, [string]$Line) {
  if ($Line -notmatch '^STEP: ([^:]*) ::') { return }
  $description = $Matches[1].Trim()
  if ($description -match '[\\/]|[A-Za-z]:|https?://|token|password') { $description = 'Working on service setup' }
  # service.ps1 prints this immediately before the service is stopped and replaced.
  $stage = if ($description -eq 'Stop the service') { 'restarting' } else { 'installing' }
  $message = if ($stage -eq 'restarting') { 'Restarting ARK Overseer' } else { 'Copying the new version' }
  Write-UpdateProgress $LogsPath $StartedAt $stage $message $Source $description
}

# Tests dot-source the validation helpers without entering the update request path.
# The parameters go in as a hashtable. An array splatted into a script binds by position, so a string such as
# '-Force' would arrive as an unnamed argument and the install would fail before it started.
function Invoke-ServiceInstall([string]$ServiceScript, [hashtable]$Parameters) {
  & $ServiceScript install @Parameters
}

if ($FunctionsOnly) { return }

$data = Join-Path $Root 'data'
$logs = Join-Path $Root 'logs'
$started = (Get-Date).ToUniversalTime().ToString('o')
Write-UpdateProgress $logs $started 'requested' 'Starting the update' 'unknown'

# An early refusal is written where the page reads it, so the page can say why nothing changed. The
# elevated window is hidden and nobody sees its output.
function Stop-Update([string]$Reason) {
  Write-Output "FAIL: $Reason"
  if ($DryRun) { exit 1 }
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  Write-UpdateFailure $logs $started $Reason $(if ($request) { $request.source } else { 'unknown' })
  exit 1
}
# A failed download, hash check or unpack ends here too, with its message on the page.
trap { Stop-Update $_.Exception.Message }

$options = $null
Write-UpdateProgress $logs $started 'checking' 'Checking the update request' 'unknown'
try { $options = Get-Content -LiteralPath (Join-Path $data 'updater.json') -Raw | ConvertFrom-Json }
catch { Stop-Update 'The update options could not be read. Run the installer again.' }

# The service writes only this small file. Everything below checks it again before acting on it.
$requestFile = Join-Path $data 'update-request.json'
if (Test-Path -LiteralPath $requestFile) {
  try { $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json }
  catch { Stop-Update 'The update request could not be read.' }
}
elseif (-not $options.package -and $options.appDir) {
  # A service installed before requests existed opens this script without one. Its Update button always
  # meant the recorded checkout, which is the same folder an administrator installed it from.
  $request = [pscustomobject]@{ source = 'checkout'; checkout = $options.appDir; requestedAt = (Get-Date).ToUniversalTime().ToString('o') }
}
else { Stop-Update 'There is no update request. Open the This computer page and try again.' }

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
if ($reason) { Stop-Update $reason }

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
$assetName = $null
$verifiedSha256 = $null
$downloadRoot = $null
$packageInfo = $null
$channel = if ($request.channel) { $request.channel } else { 'stable' }

if ($request.source -eq 'github') {
  if ($DryRun) {
    $ref = if ($ref) { $ref } else { '<newest>' }
    $assetName = if ($channel -eq 'edge') { 'ark-overseer-<version>-edge.<commit>-win-x64.zip' } else { "ark-overseer-$($ref -replace '^v','')-win-x64.zip" }
    $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) 'ark-overseer-update-package'
    $appDir = Join-Path $downloadRoot 'package'
    # A package install uses the service script shipped with that package when no checkout was recorded.
    if (-not $fromCheckout) { $serviceScript = Join-Path $appDir 'tools\service.ps1' }
  }
  else {
    $selected = Get-NewestRef $channel
    if ($ref) {
      $selected = @(Get-GitHubJson "$ApiBase/repos/$repository/releases?per_page=100") | Where-Object { $_.tag_name -ceq $ref -or ($channel -eq 'edge' -and $_.tag_name -ceq 'edge') } | ForEach-Object {
        $assets = Get-ReleaseAssets $_ $channel
        if ($assets) { @{ ref = if ($channel -eq 'edge') { $assets.version } else { $_.tag_name }; commit = $null; tag = $_.tag_name; release = $_; assets = $assets } }
      } | Select-Object -First 1
      if (-not $selected) { throw 'That release does not have an installable package.' }
    }
    $ref = $selected.ref
    $assetName = $selected.assets.package.name
    Test-AssetSize ([long]$selected.assets.package.size) | Out-Null
    $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) "ark-overseer-update-package-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $downloadRoot | Out-Null
    $zip = Join-Path $downloadRoot 'package.zip'
    $checksumPath = Join-Path $downloadRoot 'package.sha256'
    try {
      # Only administrators and SYSTEM may read package downloads and their extracted contents.
      & $Icacls $downloadRoot '/inheritance:r' '/grant:r' "${Administrators}:(OI)(CI)F" "${System}:(OI)(CI)F" | Out-Null
      Receive-Asset $selected.assets.package.browser_download_url $zip $AllowedHosts 629145600
      Receive-Asset $selected.assets.checksum.browser_download_url $checksumPath $AllowedHosts 1048576
      $verifiedSha256 = Test-PackageHash $zip $checksumPath $selected.assets.package.digest
      $packageInfo = Expand-ReleasePackage $zip (Join-Path $downloadRoot 'unpacked') $selected.assets.version
      $commit = $packageInfo.commit
      $appDir = $packageInfo.app
      if (-not $fromCheckout) {
        # This bundled service script has the same trust as the package being installed.
        $serviceScript = Join-Path $appDir 'tools\service.ps1'
      }
    }
    catch {
      Remove-UpdateTemp $downloadRoot
      throw
    }
  }
}

$shown = "$serviceScript install -Force -Start$(if ($request.source -eq 'github') { ' -Package' }) -AppDir `"$appDir`" -Root `"$Root`" -Port $([int]$options.port)"
if ($grant.Count) { $shown += ' -GrantFolder ' + (($grant | ForEach-Object { "`"$_`"" }) -join ',') }

if ($DryRun) {
  Write-Output "CHECK: source $($request.source)"
  if ($request.source -eq 'checkout') { Write-Output "CHECK: checkout $($request.checkout)" }
  else {
    Write-Output "CHECK: channel $(if ($request.channel) { $request.channel } else { 'stable' })"
    Write-Output "CHECK: ref $ref"
    Write-Output "ASSET: $assetName"
  }
  Write-Output "UPDATE: $shown"
  exit 0
}

$lines = [System.Collections.Generic.List[string]]::new()
$ifGithub = $request.source -eq 'github'
if ($ifGithub) {
  $lines.Add("Release: $ref")
  $lines.Add("Asset: $assetName")
  if ($verifiedSha256) { $lines.Add("SHA-256: $verifiedSha256") }
}
$code = 0
try {
  # Called in this process, so the array of folders binds to -GrantFolder as an array. An exit inside
  # service.ps1 ends only that script and sets LASTEXITCODE.
  $global:LASTEXITCODE = 0
  $parameters = @{ Force = $true; Start = $true; AppDir = $appDir; Root = $Root; Port = [int]$options.port }
  if ($grant.Count) { $parameters.GrantFolder = [string[]]$grant }
  if ($request.source -eq 'github') { $parameters.Package = $true }
  Invoke-ServiceInstall $serviceScript $parameters *>&1 | ForEach-Object {
    $line = "$_"
    $lines.Add($line)
    Update-ProgressFromLine $logs $started $request.source $line
  }
  $code = $LASTEXITCODE
}
catch {
  $lines.Add("ERROR: $($_.Exception.Message)")
  $code = 1
}
finally {
  Remove-UpdateTemp $downloadRoot
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
  asset     = $assetName
  sha256    = $verifiedSha256
  commit    = if ($deployed) { $deployed } else { $commit }
  message   = if ($failure) { $failure -replace '^(FAIL|ERROR): ', '' } else { $null }
}
New-Item -ItemType Directory -Path $logs -Force | Out-Null
Set-Content -LiteralPath (Join-Path $logs 'update.log') -Value $lines -Encoding utf8NoBOM
Write-UpdateResult $logs $result
Write-UpdateProgress $logs $started $(if ($result.ok) { 'done' } else { 'failed' }) $(if ($result.ok) { 'Update complete' } else { $result.message }) $request.source
exit $code
