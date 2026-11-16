#!/bin/bash
# Build EntMod + HookMod as 32-bit Linux Metamod plugins (.so).
# Requires a 32-bit-capable g++ (g++ -m32; on Debian/Ubuntu: apt install g++-multilib).
# Run inside Linux or WSL. From Windows with the bundled WSL distro, e.g.:
#     wsl -d h9build -e bash "/mnt/d/GIT Storage/ts_h9_team_elimination/EntMod4/src/build-linux.sh"
# Output: EntMod4/dist/{EntMod_i386.so, HookMod_i386.so}
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/../dist"
mkdir -p "$dist"

for p in EntMod4 HookMod; do
	echo "=== building $p (Linux .so) ==="
	make -C "$here/$p" clean >/dev/null 2>&1 || true
	make -C "$here/$p"
done

cp "$here/EntMod4/EntMod_i386.so"  "$dist/EntMod_i386.so"
cp "$here/HookMod/HookMod_i386.so" "$dist/HookMod_i386.so"
echo "=== done -> $dist/{EntMod_i386.so, HookMod_i386.so} ==="
ls -la "$dist/EntMod_i386.so" "$dist/HookMod_i386.so"
