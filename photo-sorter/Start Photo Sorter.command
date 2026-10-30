#!/bin/bash
# Mac: double-click this file to start Photo Sorter.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is needed. Install it from https://www.python.org/downloads/ and try again."
  read -r -p "Press Return to close."
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "First start: setting things up (takes a minute)..."
  python3 -m venv .venv || { read -r -p "Setup failed. Press Return to close."; exit 1; }
fi
.venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt || {
  read -r -p "Couldn't install what's needed. Check your internet connection. Press Return to close."; exit 1; }
.venv/bin/python -m photosorter
