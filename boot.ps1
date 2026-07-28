# red-dev bootstrap for native Windows.
#
#   irm https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.ps1 | iex
#
# Needs no admin rights: the binary lands in the user's own bin
# directory and winget installs per-user where the package allows it.

$ErrorActionPreference = 'Stop'

$Repo   = 'reddb-io/red-dev'
$Asset  = 'red-dev-windows-x64.exe'
$BinDir = if ($env:RED_DEV_BIN_DIR) { $env:RED_DEV_BIN_DIR } else { "$env:LOCALAPPDATA\red-dev\bin" }
$Bin    = Join-Path $BinDir 'red-dev.exe'

function Say  { param($m) Write-Host ":: $m" }
function Fail { param($m) Write-Error "fail $m"; exit 1 }

if ([Environment]::Is64BitOperatingSystem -eq $false) {
    Fail 'red-dev publishes 64-bit builds only'
}

Say "resolving latest release of $Repo"

# Ask the API which assets exist rather than assembling a URL from an
# assumed version — the failure mode that motivated this project.
$headers = @{ 'User-Agent' = 'red-dev-boot'; 'Accept' = 'application/vnd.github+json' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
} catch {
    Fail "cannot reach the GitHub API (rate limited? set GITHUB_TOKEN): $($_.Exception.Message)"
}

$match = $release.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1
if (-not $match) {
    Write-Host "fail no asset named $Asset in the latest release. Available:" -ForegroundColor Red
    $release.assets | ForEach-Object { Write-Host "  $($_.name)" }
    exit 1
}

Say "downloading $Asset ($([math]::Round($match.size / 1MB, 1)) MB)"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Invoke-WebRequest -Uri $match.browser_download_url -OutFile $Bin -UseBasicParsing
Say "installed $Bin"

# Put the bin directory on the user's PATH permanently. Read the stored
# user value rather than $env:PATH, which is the merged machine+user
# string — writing that back would copy every machine entry into the
# user scope.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $BinDir } else { "$userPath;$BinDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Say "added $BinDir to your user PATH (new terminals only)"
}
$env:Path = "$env:Path;$BinDir"

Say 'converging'
& $Bin install
