#!/usr/bin/env bash
# ===========================================================================
#  linux/h9build-setup.sh -- the build tools for linux/build-linux.sh, on Debian or
#  Ubuntu x86-64. Run it as root, once, in the h9build WSL2 distro (build-linux.ps1
#  -Setup does that): the 32-bit toolchain, cmake 3.23 or newer (reTS asks for it;
#  Ubuntu 22.04's own is 3.22, so it comes from pip), ninja, clang for RCBot, nasm.
#
#      h9build-setup.sh                 the tools from the distribution's own packages and pip's cmake
#      h9build-setup.sh --with-ambuild  and AMBuild, from github.com/alliedmodders/ambuild:
#                                       the build tool AMX Mod X itself uses; the step that
#                                       builds AMX Mod X and its modules needs it
#
#  Source: TSM/linux/h9build-setup.sh -- edit it there.
# ===========================================================================
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (wsl -d h9build -u root)" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
dpkg --add-architecture i386
apt-get update
apt-get install -y --no-install-recommends \
	build-essential gcc-multilib g++-multilib libc6-dev-i386 \
	cmake ninja-build make python3 python3-pip python3-venv git pkg-config clang lld ccache nasm \
	curl ca-certificates unzip xz-utils zip file patch rsync \
	zlib1g-dev zlib1g-dev:i386 libbz2-dev libbz2-dev:i386 libssl-dev
pip3 install --quiet cmake
if [ "${1:-}" = "--with-ambuild" ]; then
	pip3 install --quiet "git+https://github.com/alliedmodders/ambuild"
fi
echo "---- versions"
gcc --version | head -1
g++ -m32 --version | head -1
clang --version | head -1
/usr/local/bin/cmake --version | head -1
python3 --version
if python3 -c 'import ambuild2' 2>/dev/null; then echo "ambuild2: installed"; else echo "ambuild2: not installed (h9build-setup.sh --with-ambuild)"; fi
echo 'int main(){return 0;}' > /tmp/t.c && gcc -m32 /tmp/t.c -o /tmp/t32 && file /tmp/t32 | cut -c1-90
echo SETUP-DONE
