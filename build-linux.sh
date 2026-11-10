#!/usr/bin/env bash
# ===========================================================================
#  build-linux.sh -- builds H9's Linux i386 server on a Linux machine (the same job
#                    build-linux.cmd does through WSL2 on Windows)
#
#      ./build-linux.sh --setup [--with-ambuild]   install the build tools (needs sudo, Debian or Ubuntu x86-64)
#      ./build-linux.sh                            every step, into H9XASH-linux/
#      ./build-linux.sh rcbot assemble             only these steps
#      ./build-linux.sh --stage                    after the build, pack dist/ with stage-h9xash.sh
#
#  The steps, the environment variables (H9_OUT, H9_WORK, H9_JOBS, H9_SKIP) and the layout of
#  H9XASH-linux/ are described in linux/build-linux.sh; AMBuild's license is linux/LICENSE-AMBUILD.txt.
#  The build runs at nice 10 with 4 jobs by default (H9_JOBS).
#
#  Source of truth: TSM/build-linux.sh -- edit it there.
# ===========================================================================
set -euo pipefail
HERE=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)
export H9_SRC="$HERE"

setup=0 ambuild=0 stage=0
steps=()
for a in "$@"; do
	case "$a" in
		--setup) setup=1 ;;
		--with-ambuild) ambuild=1 ;;
		--stage) stage=1 ;;
		-h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		-*) echo "build-linux.sh: unknown option $a" >&2; exit 2 ;;
		*) steps+=("$a") ;;
	esac
done

# a build folder is made by whoever builds; scripts run with LF line ends whatever a checkout did to them
for f in "$HERE"/linux/*.sh; do sed -i 's/\r$//' "$f"; done

if [ "$setup" = 1 ]; then
	args=()
	[ "$ambuild" = 1 ] && args+=(--with-ambuild)
	if [ "$(id -u)" = 0 ]; then bash "$HERE/linux/h9build-setup.sh" "${args[@]}"; else sudo bash "$HERE/linux/h9build-setup.sh" "${args[@]}"; fi
fi

# the build needs no root; as root (WSL) it still works
bash "$HERE/linux/build-linux.sh" "${steps[@]}"

if [ "$stage" = 1 ]; then
	[ -f "$HERE/stage-h9xash.sh" ] || { echo "build-linux.sh: no stage-h9xash.sh beside this script to pack with" >&2; exit 1; }
	bash "$HERE/stage-h9xash.sh"
fi
