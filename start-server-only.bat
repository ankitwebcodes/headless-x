@echo off
REM Start ONLY the X Panel Next.js server (tunnels + worker already running).
cd /d C:\Users\ankit\x_panel
start /min "X-Panel-Server" cmd /c "npm run start >> panel-out.log 2>&1"
