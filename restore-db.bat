@echo off
setlocal enabledelayedexpansion
title AgentSphere AI - Restore Database
color 0B

:: ── Paths ──────────────────────────────────────────────────────────────────────
set "APPDIR=C:\AgentSphere"
set "SRCDIR=C:\AgentSphere-AI"

echo.
echo  ============================================================
echo    AgentSphere AI - Restore Database
echo  ============================================================
echo.
echo  Live app folder:    %APPDIR%
echo  New build folder:   %SRCDIR%
echo.
echo  This will:
echo    1. Stop the app in %APPDIR%
echo    2. Back up the current (possibly corrupted) hanny.db
echo    3. Delete the current hanny.db / hanny.db-wal / hanny.db-shm
echo    4. Copy everything from %SRCDIR% over %APPDIR%
echo       (overwrites app code, .env, and hanny.db)
echo    5. Restart the app
echo.

if not exist "%APPDIR%" (
    echo  ERROR: Live app folder not found: %APPDIR%
    pause
    exit /b 1
)
if not exist "%SRCDIR%" (
    echo  ERROR: New build folder not found: %SRCDIR%
    pause
    exit /b 1
)

set /p CONFIRM="Continue? This will overwrite hanny.db, .env, and app code in %APPDIR%. (Y/N): "
if /i not "!CONFIRM!"=="Y" (
    echo  Cancelled.
    pause
    exit /b 0
)

:: ── Step 1: Stop the app ──────────────────────────────────────────────────────
echo.
echo  [1/5] Stopping the app...
if exist "%APPDIR%\Stop.bat" (
    call "%APPDIR%\Stop.bat" >nul 2>&1
) else (
    echo  WARNING: Stop.bat not found in %APPDIR% - force-killing all node.exe processes.
    taskkill /F /IM node.exe >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo  OK

:: ── Step 2: Back up the current database ──────────────────────────────────────
echo.
echo  [2/5] Backing up current database...
if not exist "%APPDIR%\db-backup-corrupt" mkdir "%APPDIR%\db-backup-corrupt"
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%d"
if exist "%APPDIR%\hanny.db"     copy /y "%APPDIR%\hanny.db"     "%APPDIR%\db-backup-corrupt\hanny.db.!STAMP!.bak" >nul
if exist "%APPDIR%\hanny.db-wal" copy /y "%APPDIR%\hanny.db-wal" "%APPDIR%\db-backup-corrupt\hanny.db-wal.!STAMP!.bak" >nul
if exist "%APPDIR%\hanny.db-shm" copy /y "%APPDIR%\hanny.db-shm" "%APPDIR%\db-backup-corrupt\hanny.db-shm.!STAMP!.bak" >nul
echo  OK   Backed up to %APPDIR%\db-backup-corrupt\

:: ── Step 3: Delete the corrupted database files ───────────────────────────────
echo.
echo  [3/5] Removing corrupted database files...
if exist "%APPDIR%\hanny.db"     del /f /q "%APPDIR%\hanny.db"
if exist "%APPDIR%\hanny.db-wal" del /f /q "%APPDIR%\hanny.db-wal"
if exist "%APPDIR%\hanny.db-shm" del /f /q "%APPDIR%\hanny.db-shm"
echo  OK

:: ── Step 4: Copy the new build over the live app folder ───────────────────────
echo.
echo  [4/5] Copying new build into place...
robocopy "%SRCDIR%" "%APPDIR%" /E /IS /IT /NFL /NDL /NJH
if !errorlevel! GEQ 8 (
    echo.
    echo  ERROR: Copy failed ^(robocopy exit code !errorlevel!^).
    pause
    exit /b 1
)
echo  OK

:: ── Step 5: Restart the app ───────────────────────────────────────────────────
echo.
echo  [5/5] Restarting the app...
if exist "%APPDIR%\Start.bat" (
    call "%APPDIR%\Start.bat"
) else (
    cd /d "%APPDIR%"
    start "" node chat-server.mjs
)

echo.
echo  ============================================================
echo    Done. Open http://localhost:3000 to check it.
echo    Old database backed up in: %APPDIR%\db-backup-corrupt\
echo  ============================================================
echo.
pause
