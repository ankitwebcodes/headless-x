@echo off
REM ============================================================
REM  repostops.xyz  ::  X-Panel service launcher
REM  Detached from Hermes so it survives agent sessions.
REM  Safe to run repeatedly - exits if port 3000 is already up.
REM ============================================================
setlocal

set "PANEL=C:\Users\ankit\x_panel"
set "NODEDIR=C:\Users\ankit\AppData\Local\hermes\node"
set "LOG=%PANEL%\panel-service.log"
set "GUARDLOG=%PANEL%\panel-guard.log"

REM --- guard: already running? ---
REM  NOTE: the guard message goes to GUARDLOG, never LOG -
REM  the live panel holds LOG open, so writing there fails.
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [%date% %time%] port 3000 already listening - skipping start >> "%GUARDLOG%" 2>nul
  exit /b 0
)

REM --- automation worker (the per-profile Start/Stop/Clear engine, :9411) ---
REM  Started in a SEPARATE hidden window so it keeps running independently of
REM  the panel and of any agent session.
start "" /min cmd /c "C:\Users\ankit\x_panel\start-worker.bat"

cd /d "%PANEL%" || exit /b 1
set "PATH=%NODEDIR%;%PATH%"
set "PYTHONIOENCODING=utf-8:replace"
set "PYTHONUTF8=1"

echo. >> "%LOG%"
echo ============================================================ >> "%LOG%"
echo [%date% %time%] starting X-Panel on :3000 >> "%LOG%"
echo ============================================================ >> "%LOG%"

call "%NODEDIR%\npm.cmd" run start >> "%LOG%" 2>&1

echo [%date% %time%] X-Panel exited with code %errorlevel% >> "%LOG%"
exit /b %errorlevel%
