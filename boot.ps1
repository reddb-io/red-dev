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

# Channel, matching boot.sh and toon's installer. 'stable' asks for
# /releases/latest, which by GitHub's definition never returns a
# prerelease -- so a repository publishing only prereleases 404s there
# and looks empty. 'next' lists all releases and takes the newest.
$Channel = if ($env:RED_DEV_CHANNEL) { $env:RED_DEV_CHANNEL } else { 'stable' }
if ($Channel -notin @('stable', 'next')) {
    Fail "RED_DEV_CHANNEL must be 'stable' or 'next' (got '$Channel')"
}

$api = if ($Channel -eq 'stable') {
    "https://api.github.com/repos/$Repo/releases/latest"
} else {
    # Not per_page=1: /releases is not ordered so the newest prerelease
    # comes first, and taking [0] handed the stable release to everyone
    # who asked for next. Fetch a page and filter below.
    "https://api.github.com/repos/$Repo/releases?per_page=20"
}

Say "resolving $Channel release of $Repo"

# Ask the API which assets exist rather than assembling a URL from an
# assumed version -- the failure mode that motivated this project.
$headers = @{ 'User-Agent' = 'red-dev-boot'; 'Accept' = 'application/vnd.github+json' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

try {
    $release = Invoke-RestMethod $api -Headers $headers
    if ($release -is [array]) {
        # Filter, do not index: the array mixes stable and prerelease
        # entries and is not ordered newest-prerelease-first.
        $release = $release | Where-Object { $_.prerelease } | Select-Object -First 1
        if (-not $release) { Fail "$Repo has no prerelease to install" }
    }
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    # 404 is ambiguous: GitHub returns it both for "no releases" and for
    # "you cannot see this repository". Reporting only the first sends
    # someone with a private repo hunting a release that already exists.
    if ($code -eq 404 -and $Channel -eq 'stable') {
        # Distinguish "no stable yet" from "nothing at all" instead of
        # guessing, the same way boot.sh does.
        $any = $null
        try {
            $any = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=1" -Headers $headers
        } catch { }
        if ($any -and $any.Count -gt 0) {
            Fail "$Repo has no stable release yet, only prereleases. Install the newest with: `$env:RED_DEV_CHANNEL='next'; irm .../boot.ps1 | iex"
        }
        Fail "no release found for $Repo. Either none has been published, or the repository is private -- in which case set GITHUB_TOKEN and retry."
    } elseif ($code -eq 404) {
        Fail "$Repo has no published releases yet"
    } elseif ($code -eq 403) {
        Fail "GitHub API rate limit reached -- set GITHUB_TOKEN and retry"
    } elseif ($code -eq 401) {
        Fail "GITHUB_TOKEN was rejected -- check that it can read $Repo"
    } else {
        Fail "cannot reach the GitHub API: $($_.Exception.Message)"
    }
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
# string -- writing that back would copy every machine entry into the
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
