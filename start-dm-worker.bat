@echo off
REM ============================================================
REM  repostops.xyz  ::  DM automation WORKER (cookie backend)
REM
REM  Advances every started DM run (up to 12 accounts, in
REM  parallel) while the panel is closed. Deliberately NOT a
REM  child of Hermes and NOT a child of the panel: a worker
REM  started inside an agent session dies with that session,
REM  which is why accounts used to sit idle.
REM
REM  Safe to run repeatedly - exits if a DM worker is already up.
REM ============================================================
setlocal

set "PANEL=C:\Users\ankit\x_panel"
set "NODEDIR=C:\Users\ankit\AppData\Local\hermes\node"
set "LOG=%PANEL%\dm-worker.log"
set "GUARDLOG=%PANEL%\dm-worker-guard.log"

REM --- guard: is a dm-worker.mjs process already running? ---
for /f %%A in ('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" ^| Where-Object { $_.CommandLine -like '*dm-worker.mjs*' } ^| Measure-Object).Count"') do set "RUNNING=%%A"
if not "%RUNNING%"=="0" (
  echo [%date% %time%] dm worker already running - skipping start >> "%GUARDLOG%" 2>nul
  exit /b 0
)

cd /d "%PANEL%" || exit /b 1
set "PATH=%NODEDIR%;%PATH%"
set "PYTHONIOENCODING=utf-8:replace"
set "PYTHONUTF8=1"

echo. >> "%LOG%"
echo ============================================================ >> "%LOG%"
echo [%date% %time%] starting DM worker >> "%LOG%"
echo ============================================================ >> "%LOG%"

:loop
"%NODEDIR%\node.exe" --experimental-strip-types "%PANEL%\scripts\dm-worker.mjs" >> "%LOG%" 2>&1
echo [%date% %time%] DM worker exited with code %errorlevel% - restarting in 5s >> "%LOG%"
timeout /t 5 /nobreak >nul
goto loop
