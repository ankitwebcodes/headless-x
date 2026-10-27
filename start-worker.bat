@echo off
REM ============================================================
REM  repostops.xyz  ::  automation WORKER (bridge on :9411)
REM
REM  ONE long-lived controller. The console drives per-profile
REM  START / STOP / CLEAR through it. It is deliberately NOT a
REM  child of Hermes and NOT a child of the panel: the old
REM  one-shot controller died whenever its session ended, which
REM  is why repostops.xyz kept going down.
REM
REM  Safe to run repeatedly - exits if :9411 is already up.
REM ============================================================
setlocal

set "XFLOW=C:\Users\ankit\xflow"
set "PYEXE=C:\Users\ankit\AppData\Local\Programs\Python\Python311\python.exe"
set "LOG=%XFLOW%\logs\worker-service.log"
set "GUARDLOG=%XFLOW%\logs\worker-guard.log"

REM --- guard: worker already running? ---
netstat -ano | findstr ":9411" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [%date% %time%] bridge 9411 already listening - skipping start >> "%GUARDLOG%" 2>nul
  exit /b 0
)

cd /d "%XFLOW%" || exit /b 1
set "PYTHONIOENCODING=utf-8:replace"
set "PYTHONUTF8=1"

echo. >> "%LOG%"
echo ============================================================ >> "%LOG%"
echo [%date% %time%] starting automation worker (controller.py --serve) >> "%LOG%"
echo ============================================================ >> "%LOG%"

"%PYEXE%" controller.py --serve >> "%LOG%" 2>&1

echo [%date% %time%] worker exited with code %errorlevel% >> "%LOG%"
exit /b %errorlevel%
