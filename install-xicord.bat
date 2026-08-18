@echo off
setlocal enabledelayedexpansion
title Xicord installer
echo.
echo   Installing Xicord (private Vencord fork)...
echo.

REM ---- prerequisites ----
where git >nul 2>nul || (echo   [X] Git not found - install from https://git-scm.com/download/win, then re-run. & pause & exit /b 1)
where node >nul 2>nul || (echo   [X] Node not found - install Node 18+ from https://nodejs.org, then re-run. & pause & exit /b 1)

REM ---- clone the PRIVATE repo ----
REM Private repos need auth. The GitHub CLI (gh) carries it cleanly, so prefer it.
set "REPO=Athology0000/Vencord"
set "URL=https://github.com/%REPO%.git"

if exist "Vencord\.git" (
  echo   Existing checkout found - pulling latest...
  pushd Vencord
  git pull --ff-only
  popd
  goto build
)

where gh >nul 2>nul
if %errorlevel%==0 (
  REM make sure gh is signed in; if not, walk the user through it
  gh auth status >nul 2>nul || (
    echo   You need to sign in to GitHub once on this PC.
    echo   A browser / code prompt will appear...
    gh auth login -h github.com -p https -w
  )
  echo   Cloning %REPO% via gh...
  gh repo clone %REPO% Vencord || (echo   [X] gh clone failed & pause & exit /b 1)
) else (
  echo   gh (GitHub CLI) not found - falling back to git clone.
  echo   Git may prompt for your GitHub username + a Personal Access Token.
  git clone %URL% Vencord || (
    echo   [X] clone failed. Install GitHub CLI ^(https://cli.github.com^) and re-run,
    echo       or make sure your git credentials can read the private repo.
    pause & exit /b 1
  )
)

:build
cd Vencord

REM ---- pnpm ----
call corepack enable >nul 2>nul
where pnpm >nul 2>nul || call npm install -g pnpm

echo   Installing dependencies...
call pnpm install || (echo   [X] pnpm install failed & pause & exit /b 1)
echo   Building...
call pnpm build || (echo   [X] build failed & pause & exit /b 1)
echo   Injecting into Discord (close Discord if prompted)...
call pnpm inject

echo.
echo   Done. This PC gets its OWN Xicord account:
echo     1. Open  https://xicord-sync-production.up.railway.app/login
echo        Sign in with the Discord account this PC runs, copy the xic-... token.
echo     2. Restart Discord, then Vencord Settings -^> Plugins -^> Xicord Dossier:
echo          Sync URL    https://xicord-sync-production.up.railway.app
echo          Sync token  the xic-... token from step 1
echo.
pause
