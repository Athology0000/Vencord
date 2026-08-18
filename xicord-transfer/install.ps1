<#
  Xicord installer - sets up Vencord with the Xicord plugin suite on a fresh Windows PC.

  Run this from the folder it ships in (the transfer bundle: it must sit next to
  src\userplugins\, xicord-crypto.js and the dashboard files).

  What it does, in order:
    1. Checks for git / Node 18+ / pnpm; installs the missing ones via winget/npm.
    2. Clones Vencord (Vendicated/Vencord) into a target folder.
    3. Copies the Xicord plugins + crypto + dashboard into that checkout.
    4. pnpm install, pnpm build.
    5. Injects the build into your Discord.
    6. Prints how to point this PC at your sync pool.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Dest "C:\Vencord" -NoInject
#>
[CmdletBinding()]
param(
  [string]$Dest = (Join-Path $HOME "Vencord"),
  [string]$Repo = "https://github.com/Vendicated/Vencord.git",
  [switch]$NoInject
)

$ErrorActionPreference = "Stop"
$Bundle = Split-Path -Parent $MyInvocation.MyCommand.Path

function Info($m){ Write-Host "  $m" -ForegroundColor Gray }
function Ok($m){ Write-Host "OK  $m" -ForegroundColor Green }
function Step($m){ Write-Host "`n== $m ==" -ForegroundColor White }
function Die($m){ Write-Host "`nX  $m" -ForegroundColor Red; exit 1 }
function Have($c){ return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host "`nXicord installer" -ForegroundColor Cyan
Write-Host "Bundle:  $Bundle"
Write-Host "Target:  $Dest`n"

# --- sanity: the bundle actually holds the plugins ---
if (-not (Test-Path (Join-Path $Bundle "src\userplugins"))) {
  Die "This script must run from the Xicord transfer bundle (missing src\userplugins next to it)."
}

# --- 1. prerequisites ---
Step "Checking prerequisites"

if (-not (Have git)) {
  Info "git not found - installing via winget..."
  if (Have winget) { winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null }
  else { Die "git is missing and winget is unavailable. Install Git from https://git-scm.com/download/win and re-run." }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  if (-not (Have git)) { Die "git still not on PATH - open a new terminal and re-run." }
}
Ok "git $(git --version)"

if (-not (Have node)) {
  Info "Node not found - installing LTS via winget..."
  if (Have winget) { winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null }
  else { Die "Node is missing and winget is unavailable. Install Node 18+ from https://nodejs.org and re-run." }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  if (-not (Have node)) { Die "Node still not on PATH - open a new terminal and re-run." }
}
$nodeMajor = [int]((node -v) -replace 'v(\d+).*','$1')
if ($nodeMajor -lt 18) { Die "Node 18+ required (found $(node -v)). Update Node and re-run." }
Ok "node $(node -v)"

if (-not (Have pnpm)) {
  Info "pnpm not found - enabling via corepack..."
  try { corepack enable | Out-Null; corepack prepare pnpm@latest --activate | Out-Null } catch { }
  if (-not (Have pnpm)) { npm install -g pnpm | Out-Null }
  if (-not (Have pnpm)) { Die "Could not install pnpm. Run 'npm install -g pnpm' manually and re-run." }
}
Ok "pnpm $(pnpm -v)"

# --- 2. clone Vencord ---
Step "Getting Vencord"
if (Test-Path (Join-Path $Dest ".git")) {
  Info "Existing checkout at $Dest - updating..."
  Push-Location $Dest; try { git pull --ff-only 2>$null | Out-Null } catch { } finally { Pop-Location }
  Ok "reused existing Vencord checkout"
} else {
  if (Test-Path $Dest) { Die "$Dest exists but is not a git checkout. Move it aside or pass -Dest <other path>." }
  git clone --depth 1 $Repo $Dest
  Ok "cloned Vencord -> $Dest"
}

# --- 3. layer Xicord on top ---
Step "Installing the Xicord plugins"
$dstPlugins = Join-Path $Dest "src\userplugins"
New-Item -ItemType Directory -Force -Path $dstPlugins | Out-Null
Copy-Item -Recurse -Force (Join-Path $Bundle "src\userplugins\*") $dstPlugins
Ok "copied $((Get-ChildItem $dstPlugins -Recurse -File | Measure-Object).Count) plugin files -> src\userplugins"

# xicord-crypto.js must sit at the repo ROOT (xicordCache/native.ts imports ../../../xicord-crypto)
Copy-Item -Force (Join-Path $Bundle "xicord-crypto.js") (Join-Path $Dest "xicord-crypto.js")
Ok "copied xicord-crypto.js -> repo root"

# dashboard + launcher, so this PC can view its own pool too
foreach ($f in @("xicord-dashboard.html","xicord-dashboard-server.js","start.bat","xicord-cache-sample.json","xicord-app.html")) {
  $src = Join-Path $Bundle $f
  if (Test-Path $src) { Copy-Item -Force $src (Join-Path $Dest $f) }
}
Ok "copied dashboard + launcher"

# --- 4. build ---
Step "Building (this can take a few minutes the first time)"
Push-Location $Dest
try {
  Info "pnpm install..."; pnpm install --frozen-lockfile 2>$null; if ($LASTEXITCODE -ne 0) { pnpm install }
  Info "pnpm build...";  pnpm build
  if ($LASTEXITCODE -ne 0) { Die "Build failed - see the output above." }
  Ok "built into dist\"

  # --- 5. inject ---
  if (-not $NoInject) {
    Step "Injecting into Discord"
    Info "Close Discord if it is open, then this will patch it."
    pnpm inject
    if ($LASTEXITCODE -ne 0) { Info "Inject reported an issue - you can re-run 'pnpm inject' in $Dest later." }
    else { Ok "injected - restart Discord to load Xicord" }
  } else {
    Info "Skipped inject (-NoInject). Run 'pnpm inject' in $Dest when ready."
  }
} finally { Pop-Location }

# --- 6. sync setup ---
Step "Give this PC its own Xicord account"
Write-Host @"
  This PC gets its OWN account, separate from your other PC - its own token,
  its own slice in the pool, tracked as a distinct identity (not merged into 4has).

  1. On THIS PC, open in a browser:
        https://xicord-sync-production.up.railway.app/login
     Click "Sign in", authorise with the Discord account this PC runs, and copy
     the xic-... token it shows you. That token is bound to THIS account only.

  2. Start Discord - the Xicord plugins load automatically.
  3. Open Vencord Settings -> Plugins -> Xicord Dossier and set:
        Sync URL    https://xicord-sync-production.up.railway.app
        Sync token  <the xic-... token from step 1>
  4. Enable the Xicord plugins you want (Dossier, Mutuals, Voice Log, ...).
  5. To view the local dashboard, run start.bat in:
        $Dest

Done. Xicord is installed at $Dest, signed in as its own account.
"@ -ForegroundColor Gray
