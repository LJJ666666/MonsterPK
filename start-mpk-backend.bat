@echo off
setlocal
set "NODEBIN=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6"
set "PATH=%NODEBIN%;%PATH%"
cd /d D:\MyJob\MonsterPK\backend
call npm run dev
endlocal
