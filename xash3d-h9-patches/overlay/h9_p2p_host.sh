#!/usr/bin/env bash
# ===========================================================================
#  h9_p2p_host.sh -- runs the P2P helper beside your game, so that friends can join
#  it without a forwarded port (docs/P2P_JOIN.txt). The Linux side of h9_p2p_host.bat.
#
#  You need
#    * Node.js 20 or newer (your distribution's package, or https://nodejs.org),
#    * p2p.ini beside this file: copy p2p.ini.example to p2p.ini and fill in
#      service= (the relay's address) and token= (the host token its owner gave you),
#    * the game running (Create Game, or h9xash_server.sh), with  h9_p2p 1  typed in
#      its console.
#
#  Leave it running while friends play. In the game's console, h9_p2p_invite <label>
#  makes an invite: the code is printed there. Ctrl+C closes the path; every friend
#  and invite goes with it. Anything after the name goes to the helper:
#  --idle-exit <minutes>, --service <url>.
#
#  The helper is looked for in $H9_P2P_HELPER, then p2p/bin/h9p2p.js beside this file,
#  then ../p2p/bin/h9p2p.js (the repository: H9XASH sits next to p2p/). Nothing is
#  downloaded or installed.
#
#  Source: TSM/xash3d-h9-patches/overlay/h9_p2p_host.sh -- edit it there, not in H9XASH.
# ===========================================================================
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

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

if [ ! -f p2p.ini ]; then
	echo "[p2p] There is no p2p.ini beside this file." >&2
	echo "[p2p] Copy p2p.ini.example to p2p.ini, put the relay's address in service= and your host token in token=, and run this again." >&2
	exit 1
fi

exec "$node" "$helper" host --ini "$HERE/p2p.ini" "$@"
