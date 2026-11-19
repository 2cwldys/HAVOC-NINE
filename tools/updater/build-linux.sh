#!/usr/bin/env bash
# build-linux.sh -- makes dist/H9XASH-Updater, the Linux build of the updater, from the same
# sources build.ps1 makes the Windows exe from.
#
# Run it in the h9build WSL distro (or any x86_64 Linux with python3 and PyInstaller 6.12.0):
#
#     wsl -d h9build -- bash "/mnt/d/GIT Storage/ts_h9_team_elimination/tools/updater/build-linux.sh"
#
# PyInstaller is installed once with:
#     python3 -m pip install --user pyinstaller==6.12.0 pyinstaller-hooks-contrib==2025.2
#
# Two things differ from the Windows build and both matter:
#
#   * --add-data separates with ':' here, not ';'. cacert.pem has to travel INSIDE the binary:
#     h9tls.py builds its first TLS context from the copy beside it and only falls back to the
#     machine's own root store, so a build without it cannot reach havoc9.org from a machine whose
#     store holds an expired certificate, and the message blames the site rather than the machine.
#
#   * no --icon and no --version-file: both are Windows resources and PyInstaller rejects them on
#     Linux. The binary carries its version in --version instead, which is what the build checks.
#
# It builds in /tmp rather than on /mnt: PyInstaller writes thousands of small files, and across
# the Windows filesystem boundary that is slow and the modes do not survive. Only the finished
# binary is copied back.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DIST="$REPO/dist"
WORK="$(mktemp -d /tmp/h9updater.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "  sources : $HERE"
echo "  work    : $WORK"

for f in h9xash_updater.py h9link.py h9tls.py cacert.pem; do
	if [ ! -f "$HERE/$f" ]; then
		echo "  [FAIL] $f is not beside this script" >&2
		exit 1
	fi
	cp -p "$HERE/$f" "$WORK/$f"
done

cd "$WORK"
python3 -m PyInstaller \
	--noconfirm --clean --onefile --console --noupx \
	--name H9XASH-Updater \
	--distpath "$WORK/dist" --workpath "$WORK/work" --specpath "$WORK" \
	--paths "$WORK" \
	--add-data "$WORK/cacert.pem:." \
	--log-level WARN \
	"$WORK/h9xash_updater.py"

OUT="$WORK/dist/H9XASH-Updater"
if [ ! -f "$OUT" ]; then
	echo "  [FAIL] PyInstaller produced no binary" >&2
	exit 1
fi

# it has to answer before it is shipped: a binary that cannot start is worse than none
VER="$("$OUT" --version 2>&1 | head -1 || true)"
case "$VER" in
	H9XASH-Updater*) ;;
	*) echo "  [FAIL] the new binary answered '$VER' to --version" >&2; exit 1 ;;
esac

mkdir -p "$DIST"
cp -p "$OUT" "$DIST/H9XASH-Updater"
chmod 755 "$DIST/H9XASH-Updater"

SIZE="$(stat -c%s "$DIST/H9XASH-Updater")"
SHA="$(sha256sum "$DIST/H9XASH-Updater" | cut -d' ' -f1)"
echo "  $DIST/H9XASH-Updater: $SIZE bytes, SHA-256 $SHA"
echo "  $VER"
echo "  Built."
