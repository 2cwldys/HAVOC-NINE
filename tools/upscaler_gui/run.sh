#!/bin/sh
# run.sh -- starts H9 Upscaler from this folder, using the .venv setup.sh made.
set -eu
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { echo "  No .venv here. Run ./setup.sh first."; exit 1; }
exec .venv/bin/python h9upscale.py "$@"
