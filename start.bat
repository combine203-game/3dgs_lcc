@echo off
setlocal
title Maoming GS Viewer - Static Server
cd /d "%~dp0"

set "LOGFILE=%~dp0serve.log"

rem ---------------------------------------------------------------
rem This file is DELIBERATELY pure ASCII (including its file name).
rem cmd.exe parses .bat with the OEM code page. A UTF-8 .bat with
rem Chinese text only works if "chcp 65001" succeeds; on some servers
rem / PowerShell hosts it does not, and commands get truncated.
rem All Chinese messages are printed by serve.py (Python handles the
rem console encoding) and written to serve.log as UTF-8.
rem ---------------------------------------------------------------

rem ---- Preflight: missing files -> write log and STOP ----
if not exist "serve.py" set "FAILMSG=Missing serve.py - extract the WHOLE folder, do not copy partial files"
if not exist "serve.py" goto :logfail
if not exist "web\index.html" set "FAILMSG=Missing web\index.html - extract the WHOLE folder, do not copy partial files"
if not exist "web\index.html" goto :logfail

rem Set MMGS_FORCE_RUNTIME=1 to force the bundled offline Python (troubleshooting)
if "%MMGS_FORCE_RUNTIME%"=="1" (
  echo [env] Forced bundled offline runtime.
  goto :offline
)

rem ---- 1) Host Python 3.8+ ----
set "PYCMD="
for %%C in ("py -3" "python" "python3") do (
  if not defined PYCMD (
    %%~C -c "import sys,http.server,socketserver,webbrowser,mimetypes,threading,argparse;raise SystemExit(0 if sys.version_info>=(3,8) else 1)" >nul 2>nul
    if not errorlevel 1 set "PYCMD=%%~C"
  )
)
if defined PYCMD goto :run_system

:offline
echo [env] No usable host Python 3.8+, using bundled offline runtime.

rem ---- 2) Pre-unpacked runtime: shipped ready to run, NO unzip tool needed ----
rem Many server hosts have no PowerShell 5+ (no Expand-Archive), no tar.exe,
rem a read-only deploy folder, or EDR blocking powershell -Command.
rem A ready-made runtime\python bypasses all of those.
if exist "runtime\python\python.exe" goto :verify

rem ---- 3) Fallback only: unpack the zip, and NEVER swallow the error text ----
if not exist "runtime\python-3.11.9-embed-amd64.zip" set "FAILMSG=Missing runtime\python\ and runtime\python-3.11.9-embed-amd64.zip - copy the WHOLE folder again"
if not exist "runtime\python-3.11.9-embed-amd64.zip" goto :logfail
if not exist "runtime" mkdir "runtime" 2>nul
echo probe > "runtime\_wtest.tmp" 2>nul
if not exist "runtime\_wtest.tmp" set "FAILMSG=Cannot write to runtime\ - folder is read-only. Copy the package to a local writable folder and retry"
if not exist "runtime\_wtest.tmp" goto :logfail
del "runtime\_wtest.tmp" >nul 2>nul

echo [setup] runtime\python not found; unpacking fallback zip...
set "UNZIP_CMD=$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '%~dp0runtime\python-3.11.9-embed-amd64.zip' -DestinationPath '%~dp0runtime\python' -Force"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%UNZIP_CMD%" > "runtime\_unzip_ps.log" 2>&1
if exist "runtime\python\python.exe" goto :installed
echo [setup] PowerShell unpack failed, retrying with tar...
if not exist "runtime\python" mkdir "runtime\python" 2>nul
tar -xf "runtime\python-3.11.9-embed-amd64.zip" -C "runtime\python" > "runtime\_unzip_tar.log" 2>&1
if exist "runtime\python\python.exe" goto :installed

echo [ERROR] [launcher] PowerShell unpack stderr: >> "%LOGFILE%"
type "runtime\_unzip_ps.log" >> "%LOGFILE%" 2>nul
echo [ERROR] [launcher] tar unpack stderr: >> "%LOGFILE%"
type "runtime\_unzip_tar.log" >> "%LOGFILE%" 2>nul
set "FAILMSG=Failed to unpack the offline runtime (details in serve.log). Unzip runtime\python-3.11.9-embed-amd64.zip into runtime\python\ manually, or install Python 3.8+"
goto :logfail

:installed
del "runtime\_unzip_ps.log" >nul 2>nul
del "runtime\_unzip_tar.log" >nul 2>nul
echo Python 3.11.9 embeddable > "runtime\python\.installed"
echo [setup] Offline runtime ready.

:verify
rem ---- Universal C Runtime (UCRT) ----
rem Older Windows Server without KB2999226 has no api-ms-win-crt-*.dll,
rem so python.exe aborts with "api-ms-win-crt-runtime-l1-1-0.dll is
rem missing". Use the bundled app-local UCRT: no install, no registry,
rem no admin rights. Windows 8.1 / Server 2016+ skip this branch entirely.
if exist "%SystemRoot%\System32\api-ms-win-crt-runtime-l1-1-0.dll" goto :ucrt_ready
if not exist "runtime\ucrt\ucrtbase.dll" set "FAILMSG=System UCRT missing and runtime\ucrt\ is absent - copy the WHOLE folder again or install VC++ 2015-2022 x64 Redistributable"
if not exist "runtime\ucrt\ucrtbase.dll" goto :logfail
copy /y "runtime\ucrt\*.dll" "runtime\python" >nul 2>nul
set "PATH=%~dp0runtime\ucrt;%PATH%"
echo [env] System UCRT missing; using bundled Universal C Runtime.
:ucrt_ready
"runtime\python\python.exe" -c "import sys,http.server,socketserver,webbrowser,mimetypes,threading,argparse;raise SystemExit(0 if sys.version_info>=(3,8) else 1)" >nul 2>nul
if errorlevel 1 set "FAILMSG=Offline runtime self-check failed (UCRT missing or runtime corrupt). Install VC++ 2015-2022 x64 Redistributable, or delete runtime\python and retry"
if errorlevel 1 goto :logfail
echo [env] Using bundled Python 3.11.9
echo Starting local static server; the browser will open the showroom.
echo Keep this window open; close it or press Ctrl+C to stop.
echo.
"runtime\python\python.exe" serve.py %*
set "RC=%ERRORLEVEL%"
goto :finished

:run_system
echo [env] Using host Python: %PYCMD%
echo Starting local static server; the browser will open the showroom.
echo Keep this window open; close it or press Ctrl+C to stop.
echo.
%PYCMD% serve.py %*
set "RC=%ERRORLEVEL%"
goto :finished

:finished
echo.
if "%RC%"=="0" (
  echo Server stopped.
) else (
  echo [ERROR] [launcher] Server process exited with code %RC% >> "%LOGFILE%"
  echo [hint] Server stopped or failed to start (exit code %RC%).
  echo See serve.log for details: %LOGFILE%
)
echo.
pause
exit /b %RC%

:logfail
echo [ERROR] [launcher] %FAILMSG% >> "%LOGFILE%"
echo.
echo [ERROR] %FAILMSG%
echo See serve.log for details: %LOGFILE%
echo.
pause
exit /b 1
