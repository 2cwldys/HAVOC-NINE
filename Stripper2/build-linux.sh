#!/bin/bash
# Build Stripper2 as a 32-bit Linux Metamod plugin (.so), the same way EntMod4/HookMod build
# (EntMod4/src/build-linux.sh). Stripper2's own src/dlls/Makefile is VC6-era: it calls gcc with -m386
# (modern gcc only knows -m32) and includes ../../metamod, which is not in the tree. This builds the
# same five plugin sources with a 32-bit g++ and the metamod headers EntMod4 already bundles.
# Requires a 32-bit-capable g++ (on Debian/Ubuntu: apt install g++-multilib). Run in Linux or WSL, e.g.
#     wsl -d h9build -e bash "/mnt/d/GIT Storage/ts_h9_team_elimination/Stripper2/build-linux.sh"
# Output: Stripper2/dist/stripper2_mm_i386.so
set -e
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/src/dlls"
meta="$here/../EntMod4/src/EntMod4/include/metamod"   # Stripper2 ships no metamod headers; reuse EntMod4's
out="$here/dist"
mkdir -p "$out"

CXX=g++
# Arrays, so a path with a space (this repo lives under "GIT Storage") is one argument, not two.
FLAGS=(-Dstricmp=strcasecmp -Dstrcmpi=strcasecmp -m32 -O2 -w -fPIC
       -I"$src" -I"$here/src/engine" -I"$here/src/common" -I"$meta")

OBJS=()
for f in config dllapi h_export sdk_util stripper2_api; do
	echo "  CXX $f.cpp"
	"$CXX" "${FLAGS[@]}" -c "$src/$f.cpp" -o "$out/$f.o"
	OBJS+=("$out/$f.o")
done
"$CXX" -m32 -shared -fPIC -o "$out/stripper2_mm_i386.so" "${OBJS[@]}"
echo "=== done -> $out/stripper2_mm_i386.so ==="
ls -la "$out/stripper2_mm_i386.so"
