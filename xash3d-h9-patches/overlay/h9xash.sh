#!/usr/bin/env bash
# ===========================================================================
#  h9xash.sh -- starts The Specialists (H9TE client) on Linux: HAVOC 9.exe
#               under Wine
#
#  The Linux side of h9xash.bat. Wine has no PowerShell, so what h9xash.bat and
#  its PowerShell scripts do before the game starts is done here in bash. The
#  files come out byte for byte as on Windows, comment lines naming the Windows
#  scripts included, so one H9XASH folder works from either system:
#    ts/xashcomm.lst, ts/networking_resolved.cfg   from networking.ini, as
#                                                  h9_networking.ps1 writes them
#    ts/userid_resolved.cfg, ts/config.cfg         the client id taken out of
#                                                  them (h9_userid.sh); the game
#                                                  keeps it in user_id.ini itself
#    ts/menu_music_resolved.cfg      a random track from ts/menu_music.txt
#    ts/menu_bg_video_resolved.cfg   a random video from ts/menu_bg_videos.txt
#  Then it runs  wine "HAVOC 9.exe" -game ts -console -port <port>  with the
#  arguments given here, the port being port= under [server] in networking.ini
#  (27015 when there is none), the port Create Game takes; a -port or +port given
#  here wins, and then none is added. Nothing else is written inside H9XASH: the
#  Wine prefix lives outside it.
#
#      ./h9xash.sh                        main menu, with a random menu track
#      ./h9xash.sh -dev 2 -log            the same, with a full engine.log
#      ./h9xash.sh +map h9_te_neuropolis
#      ./h9xash.sh --check                check Wine and the prefix, start nothing
#      ./h9xash.sh --prepare-only         write the files above, start nothing
#      ./h9xash.sh --prepare-only CMD...  write them, then run CMD with
#                                         -game ts -console added when it has no
#                                         -game: Steam's launch options
#                                         "<this file>" --prepare-only %command%
#
#  Wine: $WINE when it is set, else wine on the PATH. It must run 32-bit Windows
#  programs. Prefix: $WINEPREFIX when it is set, else
#  ${XDG_DATA_HOME:-~/.local/share}/h9xash/prefix, made on the first start.
#  H9XASH_NO_WINE_CHECK=1 skips the 32-bit check. Wine's own log lines are off
#  (WINEDEBUG=-all) unless WINEDEBUG is set.
#
#  The Windows Steam broker (steam_broker=1 in networking.ini) is not started
#  here; the server lists work as usual. README_LINUX.txt has the rest: Proton,
#  Discord, the splash MOTD.
#
#  Source: TSM/xash3d-h9-patches/overlay/h9xash.sh -- edit it there, not in H9XASH.
# ===========================================================================

# Run by sh or dash: start again under bash.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then echo "h9xash.sh needs bash 4 or newer" >&2; exit 1; fi

SELF=$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null) || SELF=${BASH_SOURCE[0]}
if ! HERE=$(cd -- "$(dirname -- "$SELF")" 2>/dev/null && pwd); then
	echo "[h9xash] cannot open the folder this script is in" >&2
	exit 1
fi
cd -- "$HERE" || exit 1

# With no ts/config.cfg yet, the game starts from TS's stock binds and settings in
# ts/config.stock.cfg. A config.cfg that exists is the player's own (it holds their id) and is
# never replaced.
if [ ! -e ts/config.cfg ] && [ -f ts/config.stock.cfg ]; then cp -- ts/config.stock.cfg ts/config.cfg; fi

EXE='HAVOC 9.exe'
NET_BANNER='// Written by h9_networking.ps1 from networking.ini on every launch. Do not edit here.'

if [ -t 1 ]; then YELLOW=$'\033[33m'; PLAIN=$'\033[0m'; else YELLOW=''; PLAIN=''; fi

say() { printf '[h9xash] %s\n' "$1"; }
say_warn() { printf '%s[h9xash] WARNING: %s%s\n' "$YELLOW" "$1" "$PLAIN"; }
net_note() { printf '[h9-net] %s\n' "$1"; }
net_warn() { printf '%s[h9-net] WARNING: %s%s\n' "$YELLOW" "$1" "$PLAIN"; }

usage() {
	cat << 'EOF'
h9xash.sh -- HAVOC 9 (H9XASH) on Linux, through Wine

  ./h9xash.sh [engine options]       start the game, e.g. ./h9xash.sh -dev 2 -log
  ./h9xash.sh --check                check Wine, its 32-bit part and the prefix
  ./h9xash.sh --prepare-only         write the files the game reads at startup
                                     (client id, server lists, menu music and
                                     video), start nothing
  ./h9xash.sh --prepare-only CMD...  write them, then run CMD; for Steam's launch
                                     options: "<path>/h9xash.sh" --prepare-only %command%

  WINE=/path/to/wine          another Wine than the one on the PATH
  WINEPREFIX=/path/to/prefix  another prefix than ~/.local/share/h9xash/prefix
  H9XASH_NO_WINE_CHECK=1      start without checking Wine's 32-bit part

README_LINUX.txt, beside this script, has the whole account.
EOF
}

# Strips leading and trailing white space; the result is in REPLY.
trim() {
	REPLY=$1
	REPLY=${REPLY#"${REPLY%%[![:space:]]*}"}
	REPLY=${REPLY%"${REPLY##*[![:space:]]}"}
}

# ---- networking.ini -> ts/xashcomm.lst, ts/networking_resolved.cfg ----------------
# h9_networking.ps1's rules: lines trimmed; blank lines and ; or # comments skipped;
# sections and keys in any case; the last of a repeated key wins.
declare -A INI=()
read_ini() {
	local path=$1 raw line section='' first=1 re_section='^\[(.+)\]$'
	INI=()
	[ -f "$path" ] && [ -r "$path" ] || return 0
	while IFS= read -r raw || [ -n "$raw" ]; do
		# a UTF-8 byte order mark is not part of the first line
		if [ "$first" = 1 ]; then raw=${raw#$'\xef\xbb\xbf'}; first=0; fi
		trim "$raw"; line=$REPLY
		case $line in ''|';'*|'#'*) continue ;; esac
		if [[ $line =~ $re_section ]]; then
			trim "${BASH_REMATCH[1]}"; section=${REPLY,,}
			continue
		fi
		# a key needs at least one character before its "="
		case $line in [!=]*=*) ;; *) continue ;; esac
		trim "${line%%=*}"; local key=${REPLY,,}
		trim "${line#*=}"; INI["$section|$key"]=$REPLY
	done < "$path"
}

# The value of [section] key, or the default when networking.ini has none; in REPLY.
get_setting() {
	if [ "${INI["$1|$2"]+set}" = set ]; then REPLY=${INI["$1|$2"]}; else REPLY=$3; fi
}

# The -port the game gets, h9xash.bat's rule: port= under [server] in networking.ini, 27015
# when it is missing or not a port from 1 to 65535; nothing when the arguments given here
# have a -port or +port of their own. Into PORT_ARGS.
port_args() {
	local a port
	PORT_ARGS=()
	for a in "$@"; do
		case ${a,,} in -port|+port) return 0 ;; esac
	done
	read_ini networking.ini
	get_setting server port 27015; port=$REPLY
	if ! [[ $port =~ ^[1-9][0-9]{0,4}$ ]] || [ "$port" -gt 65535 ]; then
		port=27015
	fi
	PORT_ARGS=(-port "$port")
}

# networking.ini from before the H9 list was hosted shipped list_bot= empty, under the
# three comment lines below. A file that still has them with list_bot= still empty gets the
# hosted list, comment and value together, in the file's own line ends. Any other list_bot,
# the player's own value or a blank under any other comment, stays as it is. Once moved the
# old comment is gone, so this changes a file once and never again: running it on every
# launch is safe. h9_networking.ps1 does the same on Windows.
update_old_list_bot() {
	local path=$1 tmp
	[ -f "$path" ] && [ -w "$path" ] || return 0
	grep -q '^; once it is hosted\. A local test address left here makes the Internet tab report' "$path" || return 0
	tmp="$path.tmp"
	# BINMODE=3 keeps carriage returns where awk would otherwise drop them (gawk on Windows)
	awk -v BINMODE=3 '
		BEGIN {
			old[1] = "; The H9 list from the list bot (serverlist-bot\\ in the TSM repo): its public address,"
			old[2] = "; once it is hosted. A local test address left here makes the Internet tab report"
			old[3] = "; \"cannot connect\" whenever that bot is not running."
			new[1] = "; The H9 list from the list bot (serverlist-bot\\ in the TSM repo), hosted at havoc9.org"
			new[2] = "; behind its HTTPS. To try a list bot running on this PC instead, set"
			new[3] = "; list_bot=http://127.0.0.1:8081 (the port in its serverlist.ini), and set it back after:"
			new[4] = "; while that bot is not running, the Internet tab reports \"cannot connect\"."
			new[5] = "list_bot=https://havoc9.org/serverlist"
			n = 0; moved = 0
		}
		{ line[++n] = $0 }
		END {
			for (i = 1; i <= n; i++) {
				if (!moved && i + 3 <= n) {
					hit = 1
					for (k = 1; k <= 3; k++) { s = line[i + k - 1]; sub(/\r$/, "", s); sub(/[ \t]+$/, "", s); if (s != old[k]) hit = 0 }
					s = line[i + 3]; cr = (s ~ /\r$/) ? "\r" : ""; sub(/\r$/, "", s)
					if (hit && s ~ /^list_bot=[ \t]*$/) {
						for (k = 1; k <= 5; k++) print new[k] cr
						i += 3; moved = 1; continue
					}
				}
				print line[i]
			}
			exit moved ? 0 : 3
		}' "$path" > "$tmp"
	case $? in
		0) mv -f -- "$tmp" "$path" && net_note 'networking.ini: list_bot now points at the hosted H9 list, https://havoc9.org/serverlist.' ;;
		*) rm -f -- "$tmp" ;;
	esac
}

# networking.ini from before a setting was shipped has not got it: port= under [server], or
# priority= under [process]. Each one missing gets the shipped file's own lines for it, comment
# and default together, at the end of its section, or the section with them at the end of the
# file when it has none, in the file's own line ends. A key already there, whatever its value,
# stays as it is, so each changes a file once and never again. h9_networking.ps1 does the same
# on Windows.
PORT_LINES=(
	'; The UDP port a server started here takes: a dedicated one (h9xash_server.bat and'
	'; h9xash_server_debug.bat, whose heartbeat names it too) and Create Game (h9xash.bat and'
	'; h9xash.sh pass it to the game). 27015 is the default; change it to run two servers on one'
	'; PC, or for a network that blocks 27015, and open it in the firewall and the router. A'
	'; -port given on a launcher'\''s own command line wins.'
	'port=27015'
)
PRIORITY_LINES=(
	'; The priority h9xash.bat, h9xash_server.bat and h9xash_server_debug.bat start HAVOC 9.exe at:'
	'; Normal, AboveNormal or High. AboveNormal when this line is missing or holds anything else.'
	'; It matters only while the PC is busy: Windows then gives the game the CPU first, and other'
	'; programs wait. High suits a PC that does nothing but host. Realtime runs as High: a busy game'
	'; at Realtime holds back Windows'\'' own input, disk and network work. The game is never pinned to'
	'; some cores; Windows runs it on any of them. h9xash.sh (Linux) does not read this line.'
	'priority=AboveNormal'
)

# add_missing_setting <file> <section> <key> <line>...: the lines for a key, its own the last
add_missing_setting() {
	local path=$1 section=$2 key=$3 tmp lines
	shift 3
	[ -f "$path" ] && [ -w "$path" ] || return 0
	tmp="$path.tmp"
	lines=$(printf '%s\n' "$@")
	H9_SECTION=$section H9_KEY=$key H9_LINES=$lines awk -v BINMODE=3 '
		BEGIN {
			want = tolower(ENVIRON["H9_SECTION"]); wkey = tolower(ENVIRON["H9_KEY"])
			nadd = split(ENVIRON["H9_LINES"], add, "\n")
			n = 0; section = ""; has = 0; after = 0; found = 0; cr = ""; text = 0
		}
		{
			line[++n] = $0
			s = $0
			if (s ~ /\r$/) cr = "\r"
			gsub(/^[ \t\r]+|[ \t\r]+$/, "", s)
			if (s != "") text = 1
			if (s ~ /^\[.+\]$/) {
				section = tolower(substr(s, 2, length(s) - 2))
				gsub(/^[ \t]+|[ \t]+$/, "", section)
				if (section == want) { has = 1; after = n }
				next
			}
			if (section != want || s == "" || s ~ /^[;#]/) next
			eq = index(s, "=")
			if (eq < 2) next
			key = tolower(substr(s, 1, eq - 1))
			gsub(/[ \t]+$/, "", key)
			if (key == wkey) found = 1
			after = n
		}
		END {
			if (found) exit 3
			if (!has) after = n
			for (i = 1; i <= after; i++) print line[i]
			if (text) print cr
			if (!has) print "[" ENVIRON["H9_SECTION"] "]" cr
			for (k = 1; k <= nadd; k++) print add[k] cr
			for (i = after + 1; i <= n; i++) print line[i]
			exit 0
		}' "$path" > "$tmp"
	case $? in
		0) mv -f -- "$tmp" "$path" && net_note "networking.ini: ${*: -1} added under [$section]." ;;
		*) rm -f -- "$tmp" ;;
	esac
}

prepare_networking() {
	local key item url u dup app_id browse_id re_url='^https?://[^[:space:]"]+$'
	local -a items lists=()

	if mkdir -p -- ts 2>/dev/null; then
		update_old_list_bot networking.ini
		add_missing_setting networking.ini server port "${PORT_LINES[@]}"
		add_missing_setting networking.ini process priority "${PRIORITY_LINES[@]}"
		read_ini networking.ini

		for key in list_static list_bot; do
			get_setting client "$key" ''
			IFS=',' read -r -a items <<< "$REPLY"
			for item in "${items[@]}"; do
				trim "$item"; url=$REPLY
				while [ "${url%/}" != "$url" ]; do url=${url%/}; done
				[ -z "$url" ] && continue
				shopt -s nocasematch
				if ! [[ $url =~ $re_url ]]; then
					shopt -u nocasematch
					net_warn "$key entry '$url' is not an http:// or https:// address. Skipped."
					continue
				fi
				shopt -u nocasematch
				dup=0
				for u in "${lists[@]}"; do [ "$u" = "$url" ] && { dup=1; break; }; done
				[ "$dup" = 0 ] && lists+=("$url")
			done
		done

		# Read for their warnings, as on Windows; only the Steam broker would use them.
		get_setting broker steam_appid '480'; app_id=$REPLY
		get_setting broker steam_browse_appid '480'; browse_id=$REPLY
		[[ $app_id =~ ^[0-9]+$ ]] || net_warn "steam_appid '$app_id' is not a number. Using 480."
		[[ $browse_id =~ ^[0-9]+$ ]] || net_warn "steam_browse_appid '$browse_id' is not a number. Using 480."

		get_setting client steam_broker '0'; trim "$REPLY"
		if [ "$REPLY" = 1 ]; then
			net_warn 'steam_broker=1, but the Steam broker is a Windows program h9xash.sh does not start. Using the server lists only.'
		fi
	else
		net_warn 'networking setup stopped early: the ts folder could not be made. Using the defaults.'
	fi

	if {
		{
			printf '%s\r\n' "$NET_BANNER"
			for u in "${lists[@]}"; do printf 'masterstatic "%s"\r\n' "$u"; done
		} > ts/xashcomm.lst &&
		{
			printf '%s\r\n' "$NET_BANNER" 'cl_ticket_generator revemu2013' 'clearmasters'
			for u in "${lists[@]}"; do printf 'addmasterstatic "%s"\r\n' "$u"; done
		} > ts/networking_resolved.cfg
	} 2>/dev/null; then
		net_note "server lists: ${#lists[@]} set. Ticket generator: revemu2013."
	else
		net_warn 'could not write ts/xashcomm.lst or ts/networking_resolved.cfg.'
	fi
}

# ---- the menu music and video -----------------------------------------------------
# One line of a list at random, as h9xash.bat picks it: empty lines, lines that start
# with | (cmd's for /f skips those) and # comments do not count; the line is taken as
# it stands. $1 the list, $2 the pick when it has no usable line; the pick is in REPLY.
pick_from_list() {
	local line
	local -a usable=()
	REPLY=$2
	[ -f "$1" ] && [ -r "$1" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		line=${line%$'\r'}
		case $line in ''|'|'*|'#'*) continue ;; esac
		usable+=("$line")
	done < "$1"
	[ ${#usable[@]} -gt 0 ] && REPLY=${usable[RANDOM % ${#usable[@]}]}
	return 0
}

prepare_menu() {
	local chosen
	# Xash has no "mp3 on"; "mp3 loop" alone starts the track. The volume is the player's
	# own MP3Volume (ts/userconfig.cfg sets it), so nothing here sets it.
	pick_from_list ts/menu_music.txt equilibrium.mp3; chosen=$REPLY
	{ printf 'mp3 loop sound/music/%s\r\n' "$chosen" > ts/menu_music_resolved.cfg; } 2>/dev/null ||
		say_warn 'could not write ts/menu_music_resolved.cfg.'
	say "main menu music: $chosen"

	pick_from_list ts/menu_bg_videos.txt mainmenu_bg.avi; chosen=$REPLY
	{ printf 'ui_background_video_file "%s"\r\n' "$chosen" > ts/menu_bg_video_resolved.cfg; } 2>/dev/null ||
		say_warn 'could not write ts/menu_bg_video_resolved.cfg.'
	say "main menu video: $chosen"
}

# Everything the game reads at startup, in h9xash.bat's order. The C locale holds only
# inside these subshells, so Wine and the game still get the player's own.
prepare() {
	( export LC_ALL=C; prepare_networking )
	if [ -f "$HERE/h9_userid.sh" ]; then
		bash "$HERE/h9_userid.sh"
	else
		say_warn 'h9_userid.sh is missing: the engine reads the id from user_id.ini itself, as always.'
	fi
	( export LC_ALL=C; prepare_menu )
}

# ---- Wine ---------------------------------------------------------------------------
# WINE_PATH: the wine to run ($WINE, else wine on the PATH).
find_wine() {
	WINE_PATH=$(command -v -- "${WINE:-wine}" 2>/dev/null) || WINE_PATH=''
	[ -n "$WINE_PATH" ] || return 1
	WINE_VER=$("$WINE_PATH" --version 2>/dev/null | head -n 1)
	[ -n "$WINE_VER" ] || WINE_VER='version unknown'
	return 0
}

# Warns when the Wine is older than 9.
check_wine_version() {
	local major=${WINE_VER#wine-}
	major=${major%%[!0-9]*}
	if [ -n "$major" ] && [ "$major" -lt 9 ]; then
		say_warn "$WINE_VER is older than Wine 9, which README_LINUX.txt asks for. Starting anyway."
	fi
}

# Looks for Wine's 32-bit Windows side (i386-windows\kernel32.dll) beside this wine,
# then in the usual system folders. Sets WINE32_DIR and WINE32_KIND.
find_wine_32bit() {
	local real bin d
	WINE32_DIR=''; WINE32_KIND=''
	real=$(readlink -f -- "$WINE_PATH" 2>/dev/null) || real=$WINE_PATH
	bin=$(dirname -- "$real")
	for d in "$bin/../lib/wine" "$bin/../lib32/wine" "$bin/../lib64/wine" \
		"$bin/../lib/i386-linux-gnu/wine" "$bin/../lib/x86_64-linux-gnu/wine" \
		/usr/lib/wine /usr/lib32/wine /usr/lib64/wine \
		/usr/lib/i386-linux-gnu/wine /usr/lib/x86_64-linux-gnu/wine \
		/usr/local/lib/wine /usr/local/lib32/wine /usr/local/lib64/wine; do
		[ -f "$d/i386-windows/kernel32.dll" ] || continue
		WINE32_DIR=$(cd -- "$d" 2>/dev/null && pwd) || WINE32_DIR=$d
		if [ -d "$d/i386-unix" ]; then WINE32_KIND='32-bit Wine'
		elif [ -d "$d/x86_64-unix" ]; then WINE32_KIND='WoW64'
		else WINE32_KIND='32-bit Windows side'
		fi
		return 0
	done
	return 1
}

# The architecture a prefix was made for: win32, win64, or empty when unknown.
prefix_arch() {
	local line
	line=$(grep -m 1 '^#arch=' "$WINEPREFIX/system.reg" 2>/dev/null)
	REPLY=${line#\#arch=}
	REPLY=${REPLY%$'\r'}
}

# Makes the prefix on the first start, without Wine's Mono and Gecko install prompts
# and without Wine's menu entries for the programs in it.
ensure_prefix() {
	local server
	[ -d "$WINEPREFIX/drive_c" ] && return 0
	say "making the Wine prefix $WINEPREFIX (first start only, this takes a minute)"
	if ! mkdir -p -- "$WINEPREFIX" 2>/dev/null; then
		say_warn "could not make the folder $WINEPREFIX"
		return 1
	fi
	WINEDLLOVERRIDES="mscoree,mshtml=;winemenubuilder.exe=d${WINEDLLOVERRIDES:+;$WINEDLLOVERRIDES}" \
		"$WINE_PATH" wineboot --init > /dev/null 2>&1
	# wineserver writes the registry files when it exits; wait for that
	server=$(command -v -- "${WINESERVER:-$(dirname -- "$WINE_PATH")/wineserver}" 2>/dev/null) ||
		server=$(command -v wineserver 2>/dev/null)
	[ -n "$server" ] && "$server" -w > /dev/null 2>&1
	[ -d "$WINEPREFIX/drive_c" ]
}

# Runs the prefix's 32-bit cmd.exe: the answer when no 32-bit side was found on disk.
test_wine_32bit() {
	local cmdexe='C:\windows\system32\cmd.exe'
	prefix_arch
	if [ "$REPLY" != win32 ]; then
		[ -d "$WINEPREFIX/drive_c/windows/syswow64" ] || return 1
		cmdexe='C:\windows\syswow64\cmd.exe'
	fi
	"$WINE_PATH" "$cmdexe" /c exit 0 > /dev/null 2>&1
}

explain_no_32bit() {
	say_warn "this Wine ($WINE_PATH, $WINE_VER) cannot run 32-bit Windows programs, and HAVOC 9.exe is one."
	echo '          Add the 32-bit part of Wine, then start again. Debian and Ubuntu:'
	echo '            sudo dpkg --add-architecture i386 && sudo apt update'
	echo '            sudo apt install wine32:i386'
	echo "          Elsewhere: your distribution's wine package, or winehq.org/download."
	echo '          Or play through Steam with Proton (README_LINUX.txt).'
	echo '          H9XASH_NO_WINE_CHECK=1 ./h9xash.sh starts without this check.'
}

# Where an Edge WebView2 runtime would be: the prefix's, or H9XASH/webview2/runtime.
find_webview2() {
	local d
	for d in "$HERE/webview2/runtime" \
		"$WINEPREFIX/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application" \
		"$WINEPREFIX/drive_c/Program Files/Microsoft/EdgeWebView/Application"; do
		if [ -d "$d" ] && [ -n "$(ls -A -- "$d" 2>/dev/null)" ]; then REPLY=$d; return 0; fi
	done
	return 1
}

run_check() {
	local fail=0
	say "H9XASH: $HERE"
	if [ -f "$EXE" ]; then say "$EXE: here"; else say_warn "$EXE is not in this folder."; fail=1; fi
	if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
		say_warn 'no desktop session here (DISPLAY and WAYLAND_DISPLAY are empty): the game needs one.'
	fi
	if ! find_wine; then
		say_warn "no Wine: '${WINE:-wine}' is not on the PATH. Install Wine 9 or newer with its 32-bit part, or play through Steam with Proton (README_LINUX.txt)."
		return 1
	fi
	say "Wine: $WINE_PATH ($WINE_VER)"
	check_wine_version
	if find_wine_32bit; then
		say "32-bit Windows programs: yes ($WINE32_KIND, $WINE32_DIR)"
	else
		explain_no_32bit
		fail=1
	fi
	if [ -d "$WINEPREFIX/drive_c" ]; then
		prefix_arch
		say "prefix: $WINEPREFIX (${REPLY:-arch unknown})"
	else
		say "prefix: $WINEPREFIX (made on the first start)"
	fi
	if find_webview2; then
		say "Edge WebView2, for splash MOTD pages (cl_h9_motd_wine 1): $REPLY"
	else
		say 'Edge WebView2, for splash MOTD pages: not installed (only needed for cl_h9_motd_wine 1)'
	fi
	[ "$fail" = 0 ] && say 'ready.'
	return "$fail"
}

# ---- main ---------------------------------------------------------------------------
MODE=run
case ${1-} in
	--check) MODE=check; shift ;;
	--prepare-only) MODE=prepare; shift ;;
	--help) usage; exit 0 ;;
	--) shift ;;
esac

WINEPREFIX=${WINEPREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/h9xash/prefix}
export WINEPREFIX
export WINEDEBUG=${WINEDEBUG--all}

if [ "$MODE" = check ]; then
	run_check
	exit $?
fi

if [ "$MODE" = prepare ]; then
	case ${1-} in
		-*|+*)
			say_warn "--prepare-only takes a command to run (Steam's %command%), not engine options."
			echo '          To start the game with options: ./h9xash.sh -dev 2 -log'
			exit 2 ;;
	esac
	prepare
	[ $# -eq 0 ] && exit 0
	# The command is the game, started by Steam (Proton) or umu-run: it gets h9xash.bat's
	# own -game ts -console unless it names a game already.
	for a in "$@"; do [ "$a" = -game ] && exec "$@"; done
	exec "$@" -game ts -console
fi

if [ ! -f "$EXE" ]; then
	say_warn "$EXE is not in $HERE. Run h9xash.sh from the H9XASH folder it came in."
	exit 1
fi
if ! find_wine; then
	say_warn "no Wine: '${WINE:-wine}' is not on the PATH."
	echo '          Install Wine 9 or newer with its 32-bit part (README_LINUX.txt),'
	echo '          or play through Steam with Proton.'
	exit 1
fi
check_wine_version
if [ "${H9XASH_NO_WINE_CHECK:-0}" != 1 ] && ! find_wine_32bit; then
	# nothing on disk says so: ask the prefix's own 32-bit cmd.exe
	if ! ensure_prefix || ! test_wine_32bit; then
		explain_no_32bit
		exit 1
	fi
fi
ensure_prefix || say_warn 'the Wine prefix could not be made; starting anyway.'

prepare

say "Wine: $WINE_PATH ($WINE_VER), prefix $WINEPREFIX"
port_args "$@"
"$WINE_PATH" "$EXE" -game ts -console "${PORT_ARGS[@]}" "$@"
GAMEEXIT=$?
if [ "$GAMEEXIT" != 0 ]; then
	say "$EXE exited with code $GAMEEXIT. README_LINUX.txt, Troubleshooting, has the usual causes."
fi
exit "$GAMEEXIT"
