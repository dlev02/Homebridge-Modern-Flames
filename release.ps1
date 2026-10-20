<#
.SYNOPSIS
  Publish homebridge-modern-flames to GitHub and npm in one go.

.DESCRIPTION
  First run: installs the GitHub CLI if needed, opens the GitHub and npm sign-ins in the browser,
  creates the public repo dlev02/homebridge-modern-flames, pushes, tags, creates the GitHub release
  with the CHANGELOG notes, and publishes to npm.

  Later updates: add a CHANGELOG section for the new version, then run
    .\release.ps1 -Bump patch      (or minor / major)
  It bumps package.json, commits, pushes, tags, releases and publishes.

  Steps that are already done (repo exists, tag pushed, release created, version on npm) are skipped,
  so it is safe to run again after a failure.

.PARAMETER Bump
  patch, minor or major: raise the version first. Omit to publish the version in package.json.

.PARAMETER DryRun
  Run the checks and show what would happen, without signing in, pushing or publishing.
#>
[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$Owner = 'dlev02'
$Repo = 'homebridge-modern-flames'
$Description = 'Local (LAN) Homebridge plugin for Tuya-based Modern Flames electric fireplaces: power, heat, colors and flame effects in Apple Home.'
$Topics = @('homebridge', 'homebridge-plugin', 'homekit', 'modern-flames', 'fireplace', 'tuya')

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Note([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

# Run a native command and stop on failure.
function Invoke-Native {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @())
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "'$Exe $($Arguments -join ' ')' failed (exit code $LASTEXITCODE)." }
}

# Run a native command quietly and report only whether it succeeded.
function Test-Native {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @())
  & $Exe @Arguments *> $null
  return ($LASTEXITCODE -eq 0)
}

function Get-Version { (Get-Content -Raw package.json | ConvertFrom-Json).version }

function Get-ReleaseNotes([string]$Version) {
  $text = Get-Content -Raw CHANGELOG.md
  $pattern = "(?ms)^## \[$([regex]::Escape($Version))\][^\n]*\n(.*?)(?=^## \[|^\[[^\]]+\]: |\z)"
  $m = [regex]::Match($text, $pattern)
  if (-not $m.Success -or -not $m.Groups[1].Value.Trim()) { return $null }
  return $m.Groups[1].Value.Trim()
}

try {
  # --- Version -------------------------------------------------------------------------------
  if ($Bump) {
    Step "Raising the version ($Bump)"
    if ($DryRun) {
      Note "Would run: npm version $Bump --no-git-tag-version"
    } else {
      Invoke-Native npm @('version', $Bump, '--no-git-tag-version')
    }
  }
  $Version = Get-Version
  $Tag = "v$Version"
  Step "Releasing $Repo $Version"

  $Notes = Get-ReleaseNotes $Version
  if (-not $Notes) {
    throw "CHANGELOG.md has no section for [$Version]. Add '## [$Version] - <date>' with the changes, then run this again."
  }

  # --- Checks --------------------------------------------------------------------------------
  Step 'Installing dependencies and running lint + tests'
  Invoke-Native npm @('ci', '--no-audit', '--no-fund')
  Invoke-Native npm @('run', 'check')

  if ($DryRun) {
    Step 'Dry run: nothing was signed in, pushed or published'
    Note "Would create/push github.com/$Owner/$Repo, tag $Tag, create the release and run npm publish."
    Note 'Release notes:'
    $Notes -split "`n" | ForEach-Object { Note $_ }
    Invoke-Native npm @('pack', '--dry-run')
    return
  }

  # --- Tools and sign-ins ----------------------------------------------------------------------
  Step 'GitHub CLI'
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Note 'Not installed; installing it with winget.'
    Invoke-Native winget @('install', '--id', 'GitHub.cli', '-e', '--accept-source-agreements', '--accept-package-agreements')
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
      $ghExe = Join-Path $env:ProgramFiles 'GitHub CLI'
      if (Test-Path (Join-Path $ghExe 'gh.exe')) { $env:Path += ";$ghExe" } else { throw 'GitHub CLI installed but not found. Open a new terminal and run this again.' }
    }
  }
  if (-not (Test-Native gh @('auth', 'status', '--hostname', 'github.com'))) {
    Note 'Sign in to GitHub in the browser window that opens.'
    Invoke-Native gh @('auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web')
  }
  Invoke-Native gh @('auth', 'setup-git')
  $Login = (gh api user --jq .login).Trim()
  $UserId = (gh api user --jq .id).Trim()
  if ($Login -ne $Owner) {
    throw "Signed in to GitHub as '$Login', not '$Owner'. Run 'gh auth switch' or 'gh auth login' as $Owner, then run this again."
  }
  Note "GitHub: $Login"

  Step 'npm'
  if (-not (Test-Native npm @('whoami'))) {
    Note 'Sign in to npm in the browser window that opens.'
    Invoke-Native npm @('login', '--auth-type=web')
  }
  Note "npm: $((npm whoami).Trim())"

  # --- Git -------------------------------------------------------------------------------------
  Step 'Committing'
  if (-not (Test-Path .git)) { Invoke-Native git @('init', '-b', 'main') }
  if (-not (git config --get user.name)) { Invoke-Native git @('config', 'user.name', 'Drew') }
  if (-not (git config --get user.email)) {
    # GitHub's private no-reply address, so no personal email goes into the public history.
    Invoke-Native git @('config', 'user.email', "$UserId+$Login@users.noreply.github.com")
  }
  Invoke-Native git @('add', '-A')
  if (-not (Test-Native git @('diff', '--cached', '--quiet'))) {
    $msg = if (Test-Native git @('rev-parse', '--verify', 'HEAD')) { "Release $Tag" } else { "homebridge-modern-flames $Version" }
    Invoke-Native git @('commit', '-m', $msg)
  } else {
    Note 'Nothing new to commit.'
  }
  $Branch = (git rev-parse --abbrev-ref HEAD).Trim()

  Step "GitHub repo $Owner/$Repo"
  if (-not (Test-Native gh @('repo', 'view', "$Owner/$Repo"))) {
    Invoke-Native gh @('repo', 'create', "$Owner/$Repo", '--public', '--description', $Description,
      '--homepage', "https://www.npmjs.com/package/$Repo")
  } else {
    Note 'Already exists.'
  }
  Invoke-Native gh @('repo', 'edit', "$Owner/$Repo", '--enable-issues', '--add-topic', ($Topics -join ','))
  if (-not (Test-Native git @('remote', 'get-url', 'origin'))) {
    Invoke-Native git @('remote', 'add', 'origin', "https://github.com/$Owner/$Repo.git")
  }
  Invoke-Native git @('push', '-u', 'origin', $Branch)

  Step "Tag $Tag"
  if (-not (Test-Native git @('rev-parse', '--verify', "refs/tags/$Tag"))) {
    Invoke-Native git @('tag', '-a', $Tag, '-m', $Tag)
  }
  Invoke-Native git @('push', 'origin', "refs/tags/$Tag")

  Step 'GitHub release'
  if (Test-Native gh @('release', 'view', $Tag, '--repo', "$Owner/$Repo")) {
    Note 'Already exists.'
  } else {
    $notesFile = New-TemporaryFile
    try {
      Set-Content -LiteralPath $notesFile -Value $Notes -Encoding utf8
      Invoke-Native gh @('release', 'create', $Tag, '--repo', "$Owner/$Repo", '--title', $Tag, '--notes-file', $notesFile, '--verify-tag')
    } finally {
      Remove-Item -LiteralPath $notesFile -ErrorAction SilentlyContinue
    }
  }

  Step 'npm publish'
  if (Test-Native npm @('view', "$Repo@$Version", 'version')) {
    Note "$Version is already on npm."
  } else {
    Invoke-Native npm @('publish', '--access', 'public')
  }

  Step 'Done'
  Write-Host "    GitHub:  https://github.com/$Owner/$Repo" -ForegroundColor Green
  Write-Host "    Release: https://github.com/$Owner/$Repo/releases/tag/$Tag" -ForegroundColor Green
  Write-Host "    npm:     https://www.npmjs.com/package/$Repo" -ForegroundColor Green
} catch {
  Write-Host "`nStopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Fix that and run this script again; finished steps are skipped.' -ForegroundColor Yellow
  exit 1
}
