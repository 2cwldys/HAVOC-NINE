#!/usr/bin/env bash
# ===========================================================================
#  h9xash_server.sh -- runs H9's native Linux dedicated server (xashds)
#
#  The Linux side of h9xash_server.bat, for the folder linux/build-linux.sh
#  makes (and dist\H9XASH-linux-server.zip holds). Run it from anywhere:
#
#      ./h9xash_server.sh                       the same server h9xash_server.bat starts
#      ./h9xash_server.sh +map h9_te_neuropolis +maxplayers 32
#
#  The port is port= under [server] in networking.ini (27015 when there is none or it is
#  not a port from 1 to 65535); a -port or +port given here wins, and then none is added.
#  Anything given here goes to the engine after the arguments below, so +map, +maxplayers
#  and +hostname given here win over the defaults. -log writes engine.log (cleared first).
#
#  Not here: the Discord bot and the server-list heartbeat (h9_heartbeat.ps1) are Windows
#  scripts; run discord-bot/ts_bot.py yourself, and see docs/LINUX_SUPPORT.txt for the
#  heartbeat.
#
#  Source: TSM/linux/h9xash_server.sh -- edit it there, not in H9XASH-linux.
# ===========================================================================
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

SELF=$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null) || SELF=${BASH_SOURCE[0]}
HERE=$(cd -- "$(dirname -- "$SELF")" 2>/dev/null && pwd) || { echo "[h9xash_server] cannot open the folder this script is in" >&2; exit 1; }
cd -- "$HERE" || exit 1

[ -x ./xashds ] || { echo "[h9xash_server] no ./xashds here: this is not a native server folder" >&2; exit 1; }

# the engine finds filesystem_stdio.so, and a game library finds its own, beside the binary
export LD_LIBRARY_PATH="$HERE${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

port=27015
if [ -f networking.ini ]; then
	line=$(grep -i -m1 '^[[:space:]]*port[[:space:]]*=' networking.ini | tr -d '\r') || line=
	v=${line#*=}; v=${v//[[:space:]]/}
	if [[ $v =~ ^[1-9][0-9]{0,4}$ ]] && [ "$v" -le 65535 ]; then port=$v; fi
fi
port_args=(-port "$port")
for a in "$@"; do
	case ${a,,} in -port|+port) port_args=() ;; esac
done

rm -f engine.log

# 128 slots are built in; 64 is the default (docs/PLAYER_LIMIT_128.txt)
exec ./xashds -game ts -console -log -num_edicts 4096 "${port_args[@]}" +ip 0.0.0.0 \
	+mp_teamplay 1 +sv_lan 0 +maxplayers 64 +map h9_te_neuropolis +hostname "HAVOC 9 TEAM ELIMINATION" "$@"
