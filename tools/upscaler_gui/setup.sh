#!/bin/sh
# setup.sh -- installs what H9 Upscaler needs, into a virtual environment beside this script.
#
# Nothing goes into the system Python and nothing needs root. Run it once, then ./run.sh to start
# the program or ./build.sh to make a standalone copy.
#
# It picks the ONNX runtime for this machine. On Linux that is onnxruntime-gpu, which is CUDA and
# therefore NVIDIA only; there is no DirectML here. Without an NVIDIA card it installs the CPU
# build, which works but is perhaps thirty times slower, so it says which one it got.
#
#   ./setup.sh           install into .venv beside this script
#   ./setup.sh --build   install the build tool (PyInstaller) too
#
# Needs Python 3.10 or newer, and python3-venv and python3-tk from your package manager:
#   Debian/Ubuntu   sudo apt install python3-venv python3-tk
#   Fedora          sudo dnf install python3-tkinter
#   Arch            sudo pacman -S tk
set -eu
cd "$(dirname "$0")"

PY=python3
command -v "$PY" >/dev/null 2>&1 || {
	echo "No python3 found. Install Python 3.10 or newer."
	exit 1
}

echo "--- making the virtual environment in .venv"
"$PY" -m venv .venv || {
	echo
	echo "  venv failed. On Debian or Ubuntu: sudo apt install python3-venv"
	exit 1
}
VPY="$PWD/.venv/bin/python"

echo "--- pip"
"$VPY" -m pip install --quiet --upgrade pip

echo "--- numpy and Pillow"
"$VPY" -m pip install --quiet -r requirements.txt

echo "--- the ONNX runtime"
if command -v nvidia-smi >/dev/null 2>&1; then
	if "$VPY" -m pip install --quiet onnxruntime-gpu; then
		echo "    onnxruntime-gpu (CUDA)"
	else
		echo "    onnxruntime-gpu would not install; using the CPU build instead (much slower)"
		"$VPY" -m pip install --quiet onnxruntime
	fi
else
	echo "    no NVIDIA card found; using the CPU build (much slower)"
	"$VPY" -m pip install --quiet onnxruntime
fi

if [ "${1:-}" = "--build" ]; then
	echo "--- PyInstaller, for build.sh"
	"$VPY" -m pip install --quiet pyinstaller
fi

# tkinter is not a pip package: it comes with the system Python, and a venv inherits it
if ! "$VPY" -c 'import tkinter' 2>/dev/null; then
	echo
	echo "  tkinter is missing, so the window cannot open. Install it and run this again:"
	echo "    Debian/Ubuntu  sudo apt install python3-tk"
	echo "    Fedora         sudo dnf install python3-tkinter"
	echo "    Arch           sudo pacman -S tk"
	echo
fi

echo
echo "--- what it ended up with"
"$VPY" h9upscale.py --check || true
echo
if [ ! -f model/4xLSDIRplus.onnx ]; then
	echo "  The model is missing. It is 64 MB and is not kept in git: README.txt says how to"
	echo "  make model/4xLSDIRplus.onnx from the .pth, or copy one in from a built release."
	echo
fi
echo "  Done. ./run.sh starts it; ./build.sh makes a standalone copy."
