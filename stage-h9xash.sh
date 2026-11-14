#!/usr/bin/env bash
# stage-h9xash.sh -- packs H9XASH into clean ZIPs in dist/, one per platform: the Linux and Windows
# twin of stage-h9xash.ps1 (see the header of that file, and stage_h9xash.py for the options).
#   ./stage-h9xash.sh                    H9XASH.zip (Windows files) and H9XASH-linux.zip (Linux files); a
#                                        native build with only xashds also gives H9XASH-linux-server.zip
#   ./stage-h9xash.sh --dry-run          stage and scrub only, keep the staged folder, no ZIP
#   ./stage-h9xash.sh --keep-stage       make the ZIPs and keep the staged folder to test-play it
#   ./stage-h9xash.sh --no-linux         the Windows ZIP only
#   ./stage-h9xash.sh --linux-native DIR the native Linux build to lay over the game data
# Every argument goes to stage_h9xash.py as it is. This only finds a Python 3.8 or newer.

src="${BASH_SOURCE[0]}"
while [ -h "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    case "$src" in /*) ;; *) src="$dir/$src" ;; esac
done
here="$(cd -P "$(dirname "$src")" && pwd)"
script="$here/stage_h9xash.py"
if [ ! -f "$script" ]; then
    echo "stage-h9xash.sh: $script is missing" >&2
    exit 127
fi

ok='import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'
for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "$ok" >/dev/null 2>&1; then
        exec "$cand" "$script" "$@"
    fi
done
if command -v py >/dev/null 2>&1 && py -3 -c "$ok" >/dev/null 2>&1; then
    exec py -3 "$script" "$@"
fi
echo "stage-h9xash.sh: Python 3.8 or newer was not found (tried python3, python, py -3)" >&2
exit 127
