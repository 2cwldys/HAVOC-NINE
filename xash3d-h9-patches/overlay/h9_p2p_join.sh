#!/usr/bin/env bash
# ===========================================================================
#  h9_p2p_join.sh <invite code> -- joins a friend's game through the P2P relay
#  (docs/P2P_JOIN.txt). The Linux side of h9_p2p_join.bat.
#
#      ./h9_p2p_join.sh H9-7KQMX-2PDRT
#
#  It redeems the code, waits until the relay answers, then starts the game
#  (h9xash.sh, under Wine) with +connect <the address it prints> and keeps the helper
#  running until the game ends. The code is good once and for ten minutes; a link that
#  ends in the code works too.
#
#  You need Node.js 20 or newer and the relay's address: either service= in p2p.ini
#  (copy p2p.ini.example; the host tells you the address) or
#      ./h9_p2p_join.sh H9-7KQMX-2PDRT --service https://relay.example.org
#
#  Other options: --no-game (print the address, start nothing: type connect <address>
#  in a game that is running, or set start_game=0 in p2p.ini), --relay-only (never
#  exchange network addresses with the host).
#
#  Source: TSM/xash3d-h9-patches/overlay/h9_p2p_join.sh -- edit it there, not in H9XASH.
# ===========================================================================
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

if [ $# -lt 1 ]; then
	echo "Usage: h9_p2p_join.sh <invite code> [--service <relay address>] [--no-game] [--relay-only]" >&2
	echo "The code looks like H9-7KQMX-2PDRT and comes from the host." >&2
	exit 1
fi

SELF=$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null) || SELF=${BASH_SOURCE[0]}
HERE=$(cd -- "$(dirname -- "$SELF")" 2>/dev/null && pwd) || { echo "[p2p] cannot open the folder this script is in" >&2; exit 1; }
cd -- "$HERE" || exit 1

node=$(command -v node 2>/dev/null) || node=
if [ -z "$node" ]; then
	echo "[p2p] Node.js is not installed. The P2P helper needs Node.js 20 or newer (https://nodejs.org). Nothing is downloaded by this script." >&2
	exit 1
fi
major=$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || major=0
case $major in ''|*[!0-9]*) major=0 ;; esac
if [ "$major" -lt 20 ]; then
	echo "[p2p] Node.js $major is too old: the P2P helper needs Node.js 20 or newer." >&2
	exit 1
fi

helper=
for c in "${H9_P2P_HELPER:-}" "$HERE/p2p/bin/h9p2p.js" "$HERE/../p2p/bin/h9p2p.js"; do
	if [ -n "$c" ] && [ -f "$c" ]; then helper=$c; break; fi
done
if [ -z "$helper" ]; then
	echo "[p2p] The helper (p2p/bin/h9p2p.js) is not beside this file or in the folder above it." >&2
	echo "[p2p] Copy the p2p folder of the H9 repository next to this one, or set H9_P2P_HELPER to the full path of p2p/bin/h9p2p.js." >&2
	exit 1
fi

exec "$node" "$helper" play "$@" --ini "$HERE/p2p.ini"
