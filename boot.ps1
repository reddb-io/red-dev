# red-dev bootstrap for native Windows.
#
#   irm https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.ps1 | iex
#
# Needs no admin rights: the binary lands in the user's own bin
# directory and winget installs per-user where the package allows it.

$ErrorActionPreference = 'Stop'

# Silence Invoke-WebRequest's progress bar.
#
# Not cosmetic. With $ProgressPreference at its default, PowerShell
# redraws that bar for every block it reads, which turns a 90 MB
# download into minutes of work spent on the console rather than the
# network -- a long-standing and well-documented slowdown. The bar also
# renders as a smear of half-written lines over a piped `iex`, and its
# text says "Writing request stream", which belongs to uploads and is
# simply wrong here.
#
# Saved and restored: this script is dot-sourced into the caller's
# session by `irm | iex`, so leaving the preference changed would
# silence progress bars in a shell the user keeps using afterwards.
$PreviousProgressPreference = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'

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

$SizeMb = [math]::Round($match.size / 1MB, 1)
Say "downloading $Asset ($SizeMb MB)"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# Downloaded to a temporary file and moved into place: an interrupted
# transfer that wrote straight to $Bin would leave a truncated
# executable on PATH, which fails in a far more confusing way than not
# being there at all.
$Tmp = "$Bin.download"
try {
    Invoke-WebRequest -Uri $match.browser_download_url -OutFile $Tmp -UseBasicParsing
} catch {
    if (Test-Path $Tmp) { Remove-Item $Tmp -Force }
    Fail "download failed: $($_.Exception.Message)"
}

# A silenced progress bar means no feedback during the transfer, so
# confirm the size afterwards instead. A wrong one here is a truncated
# or redirected download, not a working install.
$Got = [math]::Round((Get-Item $Tmp).Length / 1MB, 1)
if ((Get-Item $Tmp).Length -ne $match.size) {
    Remove-Item $Tmp -Force
    Fail "downloaded $Got MB, expected $SizeMb MB -- transfer was incomplete"
}

# Windows keeps a running executable open. A setup window from the old
# version may still be winding down while another terminal runs this
# bootstrap, and Move-Item cannot overwrite that file even with -Force.
# Rename the held image out of the canonical path, then put the completed
# download in its place. The running process keeps its existing image;
# every new process gets the new one.
try {
    Move-Item -Path $Tmp -Destination $Bin -Force -ErrorAction Stop
} catch {
    $Held = "$Bin.running-$((Get-Date).ToString('yyyyMMddHHmmssfff'))"
    try {
        Rename-Item -Path $Bin -NewName $Held -ErrorAction Stop
        Move-Item -Path $Tmp -Destination $Bin -ErrorAction Stop
        Say 'previous red-dev is still running; its old executable will be cleaned after it closes'
    } catch {
        # If the second move failed after the rename, restore the working
        # binary so the bootstrap never leaves the command absent.
        if ((-not (Test-Path $Bin)) -and (Test-Path $Held)) {
            Rename-Item -Path $Held -NewName $Bin -ErrorAction SilentlyContinue
        }
        if (Test-Path $Tmp) { Remove-Item $Tmp -Force -ErrorAction SilentlyContinue }
        Fail "cannot replace $Bin; close every red-dev window and retry"
    }
}

# A renamed running image becomes removable once that old process exits.
# Best effort only: the one still held by this exact update remains until
# the next bootstrap, and must never turn a successful update into failure.
Get-ChildItem -Path "$Bin.running-*" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
Say "installed $Bin ($Got MB)"

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

Say 'starting red-dev'

# Restore what we changed before handing over: the interface draws its own
# output, and the caller's session keeps this preference afterwards.
$ProgressPreference = $PreviousProgressPreference

# Hand over to red-dev itself, with no command.
#
# Not 'install'. The one-liner and the binary have to arrive at the same
# place, and they did not: typing red-dev opens the interface that lets
# you choose between a first install and maintenance, while this went
# straight to converging. Someone who ran the documented one-liner never
# saw the screen the product is built around.
#
# With no arguments red-dev opens that interface when there is a terminal,
# falls back to a line menu in a narrow one, and prints help when there is
# no terminal at all.
& $Bin
