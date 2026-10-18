@echo off
rem ===================================================================
rem  Desktop Lyrics launcher (ASCII only on purpose: cmd.exe mis-parses
rem  UTF-8 Chinese in .cmd files on a GBK console.)
rem  Chinese docs: see README.md
rem ===================================================================
title Desktop Lyrics
setlocal enabledelayedexpansion

set "HERE=%~dp0"
set "LOGDIR=%HERE%logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>nul

rem ---------- locate node ----------
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE (
  echo [x] node.exe not found.
  echo     Install Node.js from https://nodejs.org/ and run this again.
  echo     Or launch the server manually:  node "%HERE%server.js"
  pause
  exit /b 1
)
echo [i] node: !NODE!

rem ---------- start the local service if it is not already up ----------
call :health
if "!HEALTH!"=="200" (
  echo [i] lyric service already running
) else (
  echo [i] starting lyric service ...
  start "wyy-desktop-server" /min "!NODE!" "%HERE%server.js"
  for /l %%t in (1,1,20) do (
    if not "!HEALTH!"=="200" (
      timeout /t 1 >nul
      call :health
    )
  )
  if not "!HEALTH!"=="200" (
    echo [x] service did not come up - check whether port 28123 is in use
    echo     try manually: "!NODE!" "%HERE%server.js"
    pause
    exit /b 1
  )
  echo [i] service ready
)

rem ---------- start the SMTC bridge (reads Windows media session; no browser extension needed) ----------
set "BRIDGE_ALIVE="
if exist "%HERE%logs\bridge.pid" (
  for /f "delims=" %%p in ('type "%HERE%logs\bridge.pid"') do (
    for /f "delims=" %%q in ('powershell -NoProfile -Command "if (Get-Process -Id %%p -ErrorAction SilentlyContinue) { 'yes' }"') do set "BRIDGE_ALIVE=%%q"
  )
)
if "%BRIDGE_ALIVE%"=="yes" (
  echo [i] media-session bridge already running
) else (
  echo [i] starting media-session bridge ...
  start "wyy-smtc-bridge" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%smtc-bridge.ps1" -Port 28123
)

rem ---------- show the lyric window ----------
echo [i] starting lyric window ...
echo     drag the top edge to move; right-click for the menu
echo     Ctrl+Alt+L show/hide   Ctrl+Alt+C one-line/two-line   Ctrl+Alt+Q quit
echo.
"%HERE%DesktopLyric.exe" --port 28123

echo [i] lyric window closed ^(the service keeps running^)
exit /b 0

:health
set "HEALTH="
for /f "delims=" %%i in ('powershell -NoProfile -Command "try{(Invoke-WebRequest http://127.0.0.1:28123/api/health -UseBasicParsing -TimeoutSec 2).StatusCode}catch{''}"') do set "HEALTH=%%i"
exit /b 0
