@echo off
REM Double-click this to check whether the CX demo is ready.
REM
REM The dashboard login is not in this file. It is read from local.env, which is
REM gitignored, so the password never reaches a commit. Without it the shallow
REM checks still run and the deep ones say SKIPPED rather than passing quietly.

setlocal
cd /d "%~dp0"

REM eol=# skips comment lines; delims== splits KEY=VALUE. Substring tests on a
REM for-variable are not valid batch, which is why the first version silently
REM set nothing and the deep checks reported SKIPPED.
if exist "local.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("local.env") do set "%%a=%%b"
)

where python >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Python was not found on the PATH, and this script needs it.
  echo   Install Python 3, or run:  py tools\system-check\check.py
  echo.
  pause
  exit /b 1
)

python check.py %*
echo.
pause
