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
#  Here: when p2p.ini beside this script says enabled=1, the P2P helper (Node.js 20 or newer,
#  p2p/bin/h9p2p.js) is started in the background and stopped when the server ends, so that
#  friends can join without a forwarded port (docs/P2P_JOIN.txt). Without p2p.ini nothing
#  changes.
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

# The P2P helper, only when p2p.ini beside this script says enabled=1 (docs/P2P_JOIN.txt): the helper that lets friends
# join this server without a forwarded port is started in the background (its output in p2p.log) and stopped again when
# the server exits. A helper that is running already is left alone, and only one started here is stopped. No p2p.ini,
# or enabled=0: nothing happens here, and the server is started with exec as before. It needs Node.js 20 or newer.
p2p_ours=0
if [ -f p2p.ini ]; then
	line=$(grep -i -m1 '^[[:space:]]*enabled[[:space:]]*=' p2p.ini | tr -d '\r') || line=
	v=${line#*=}; v=${v//[[:space:]]/}
	if [ "$v" = 1 ]; then
		p2p_node=$(command -v node 2>/dev/null) || p2p_node=
		p2p_major=0
		if [ -n "$p2p_node" ]; then p2p_major=$("$p2p_node" -p 'process.versions.node.split(".")[0]' 2>/dev/null); fi
		case $p2p_major in ''|*[!0-9]*) p2p_major=0 ;; esac
		p2p_helper=
		for c in "${H9_P2P_HELPER:-}" "$HERE/p2p/bin/h9p2p.js" "$HERE/../p2p/bin/h9p2p.js"; do
			if [ -n "$c" ] && [ -f "$c" ]; then p2p_helper=$c; break; fi
		done
		if [ "$p2p_major" -ge 20 ] && [ -n "$p2p_helper" ]; then
			"$p2p_node" "$p2p_helper" ensure --ini "$HERE/p2p.ini"; rc=$?
			case $rc in
				0) p2p_ours=1 ;;
				10) echo "[h9xash_server] A P2P helper is running already: leaving it alone." ;;
				*) echo "[h9xash_server] The P2P helper did not start (code $rc, see p2p.log): the server starts without it." >&2 ;;
			esac
		else
			echo "[h9xash_server] p2p.ini says enabled=1, but the P2P helper needs Node.js 20 or newer and p2p/bin/h9p2p.js: the server starts without it." >&2
		fi
	fi
fi

# 128 slots are built in; 64 is the default (docs/PLAYER_LIMIT_128.txt)
server_args=(-game ts -console -log -num_edicts 4096 "${port_args[@]}" +ip 0.0.0.0 \
	+mp_teamplay 1 +sv_lan 0 +maxplayers 64 +map h9_te_neuropolis +hostname "HAVOC 9 TEAM ELIMINATION" "$@")

if [ "$p2p_ours" = 1 ]; then
	# not exec: the helper this run started is stopped when the server ends; a signal for this script goes on to the server
	./xashds "${server_args[@]}" &
	server=$!
	trap 'kill -TERM "$server" 2>/dev/null' TERM INT HUP
	rc=0
	while kill -0 "$server" 2>/dev/null; do wait "$server"; rc=$?; done
	"$p2p_node" "$p2p_helper" stop --ini "$HERE/p2p.ini" || true
	exit "$rc"
fi
exec ./xashds "${server_args[@]}"
