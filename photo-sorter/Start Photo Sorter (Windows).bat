@echo off
rem Windows: double-click this file to start Photo Sorter.
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3 is needed. Install it from https://www.python.org/downloads/ and try again.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo First start: setting things up, this takes a minute...
  py -3 -m venv .venv || (echo Setup failed. & pause & exit /b 1)
)
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt || (echo Couldn't install what's needed. Check your internet connection. & pause & exit /b 1)
".venv\Scripts\python.exe" -m photosorter
pause
