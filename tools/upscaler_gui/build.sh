#!/bin/sh
# build.sh -- makes a standalone H9Upscaler that runs on a machine with no Python.
#
# Run ./setup.sh --build first. The result is dist/H9Upscaler, a folder of about 200 MB holding
# the program, the ONNX runtime and the model. Tar that folder to hand it on.
#
#   ./build.sh            build into dist/
#   ./build.sh <folder>   build somewhere else
#
# A build made here runs on Linux only. PyInstaller does not cross-compile: a Windows copy has to
# be built on Windows with build.cmd.
set -eu
cd "$(dirname "$0")"

VPY="$PWD/.venv/bin/python"
[ -x "$VPY" ] || {
	echo
	echo "  No .venv here. Run ./setup.sh --build first."
	exit 1
}

"$VPY" -c 'import PyInstaller' 2>/dev/null || {
	echo "  PyInstaller is missing. Installing it now..."
	"$VPY" -m pip install --quiet pyinstaller
}

[ -f model/4xLSDIRplus.onnx ] || {
	echo
	echo "  model/4xLSDIRplus.onnx is missing, so the build would have nothing to run."
	echo "  README.txt says how to make it. Stopping."
	exit 1
}

OUT="${1:-$PWD/dist}"
WORK="$OUT/.build"

echo "--- building into $OUT"
"$VPY" -m PyInstaller build/h9upscale.spec --noconfirm --distpath "$OUT" --workpath "$WORK"

echo
echo "--- checking the built copy actually works"
"$OUT/H9Upscaler/H9Upscaler" --selftest || {
	echo
	echo "  The built copy failed its own test. Do not ship it."
	exit 1
}

echo
echo "  Built: $OUT/H9Upscaler"
echo "  That folder is the whole program. Tar it to pass it on."
