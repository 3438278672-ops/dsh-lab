@echo off
rem pixiv MCP launcher (stdio). Everything is resolved next to this file, so the
rem directory can live anywhere; only credential.json and .venv must exist here.
setlocal

set "PIXIV_DUTY_HOME=%~dp0"
if "%PIXIV_DUTY_HOME:~-1%"=="\" set "PIXIV_DUTY_HOME=%PIXIV_DUTY_HOME:~0,-1%"
set "PIXIV_CREDENTIAL_FILE=%PIXIV_DUTY_HOME%\credential.json"
if not defined PIXIV_CACHE_DIR set "PIXIV_CACHE_DIR=%PIXIV_DUTY_HOME%\cache"

rem Clear proxy vars: a sandbox proxy answers 502 on pixiv, and the App API is
rem reachable directly from this machine.
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=

if not exist "%PIXIV_DUTY_HOME%\.venv\Scripts\python.exe" (
  echo [pixiv] .venv not found. Run: python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt 1>&2
  exit /b 1
)
if not exist "%PIXIV_CREDENTIAL_FILE%" (
  echo [pixiv] credential.json missing. Put {"refresh_token": "..."} there first. 1>&2
  exit /b 1
)

"%PIXIV_DUTY_HOME%\.venv\Scripts\python.exe" "%PIXIV_DUTY_HOME%\mcp_server.py"
