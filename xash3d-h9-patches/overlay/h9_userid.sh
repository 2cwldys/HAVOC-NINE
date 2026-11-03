#!/usr/bin/env bash
# h9_userid.sh -- this install's client id: what the launcher still does for it, and the old ways
# of changing it by hand. The Linux side of h9_userid.ps1, h9_regenerate_userid.bat and
# enter_userid.cmd.
#
# The engine owns the id now (engine-h9-link.patch, docs/CUSTOM_XASH_USERID.txt in the H9
# repository): it keeps it in user_id.ini protected for this user (DPAPI, which Wine and Proton
# provide), reads it itself, makes it when there is none, and links it to a havoc9.org account from
# the main menu (Link your Account). So on every start (h9xash.sh runs this before HAVOC 9.exe
# starts) this script only clears the id out of the plain text files older builds left it in:
#   ts/userid_resolved.cfg   written again with no id in it, byte for byte as h9_userid.ps1 writes
#                            it (ts/userconfig.cfg still runs it: the web client writes its own copy)
#   ts/config.cfg            any cl_h9_userid line taken out, everything else left as it is
#
#   ./h9_userid.sh              the above
#   ./h9_userid.sh --new        delete user_id.ini: the game makes a new random id at its next
#                               start (h9_regenerate_userid.bat on Windows)
#   ./h9_userid.sh --set [ID]   put a player id in user_id.ini as a plain id= line, beside the
#                               protected records there; the game protects it at its next start
#                               (enter_userid.cmd); asks for it when ID is left out
#   --root DIR                  the H9XASH folder to work in; default: this script's own
#
# A failure never stops the game: the only exit other than 0 is a refused --set ID or a failed
# --new or --set (1), or a wrong option (2).
#
# Source: TSM/xash3d-h9-patches/overlay/h9_userid.sh -- edit it there, not in H9XASH.

# Run by sh or dash: start again under bash.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then echo "h9_userid.sh needs bash 4 or newer" >&2; exit 2; fi

# Plain ASCII rules for case, spaces and patterns, whatever the player's locale.
export LC_ALL=C

RESOLVED1='// Written by h9_userid.ps1 on every launch. Do not edit here.'
RESOLVED2="// The engine reads this install's id from user_id.ini itself, protected: nothing to set here."

if [ -t 1 ]; then YELLOW=$'\033[33m'; PLAIN=$'\033[0m'; else YELLOW=''; PLAIN=''; fi

note() { printf '[h9-uid] %s\n' "$1"; }
warn() { printf '%s[h9-uid] WARNING: %s%s\n' "$YELLOW" "$1" "$PLAIN"; }

usage() {
	cat << 'EOF'
h9_userid.sh -- this install's client id (user_id.ini, kept protected by the game)

  ./h9_userid.sh              take the id out of ts/userid_resolved.cfg and ts/config.cfg,
                              where older builds kept it (h9xash.sh does this on every start)
  ./h9_userid.sh --new        delete user_id.ini: a new random id at the game's next start
                              (h9_regenerate_userid.bat on Windows)
  ./h9_userid.sh --set [ID]   the player id of your havoc9.org account (ACCOUNT, SHOW
                              PLAYER ID); asks for it when ID is left out. The game protects
                              it at its next start. Easier: Link your Account in the game's
                              main menu, with no id to paste.
  --root DIR                  work on the H9XASH folder DIR, not this script's own
EOF
}

# Strips leading and trailing white space; the result is in REPLY.
trim() {
	REPLY=$1
	REPLY=${REPLY#"${REPLY%%[![:space:]]*}"}
	REPLY=${REPLY%"${REPLY##*[![:space:]]}"}
}

# The protected= values under [client] in user_id.ini, read as h9_userid.ps1 reads them: lines
# trimmed, blank lines and ; or # comments skipped, section names in any case. Into PROTECTED.
read_protected() {
	local path=$1 raw line section='' first=1 re_section='^\[(.+)\]$'
	PROTECTED=()
	[ -f "$path" ] && [ -r "$path" ] || return 0
	while IFS= read -r raw || [ -n "$raw" ]; do
		# a UTF-8 byte order mark, as Notepad may leave, is not part of the first line
		if [ "$first" = 1 ]; then raw=${raw#$'\xef\xbb\xbf'}; first=0; fi
		trim "$raw"; line=$REPLY
		case $line in ''|';'*|'#'*) continue ;; esac
		if [[ $line =~ $re_section ]]; then
			trim "${BASH_REMATCH[1]}"; section=${REPLY,,}
			continue
		fi
		[ "$section" = client ] || continue
		# a key needs at least one character before its "="
		case $line in [!=]*=*) ;; *) continue ;; esac
		trim "${line%%=*}"
		if [ "${REPLY,,}" = protected ]; then
			trim "${line#*=}"; PROTECTED+=("$REPLY")
		fi
	done < "$path"
	return 0
}

# Writes user_id.ini with the plain id in $2 and the protected records kept, CRLF line ends and no
# byte order mark, byte for byte as h9_userid.ps1 -SetId does, through a temporary file so a failed
# write never leaves a half-written one behind.
write_set_id() {
	local path=$1 tmp="$1.tmp$$" p
	read_protected "$path"
	if {
		printf '%s\r\n' \
			"; user_id.ini -- this install's client id. The engine reads and writes this file." \
			'; The id= line below was put here by enter_userid.cmd: the game takes it and protects' \
			'; it at its next start. See docs\CUSTOM_XASH_USERID.txt.' \
			'' \
			'[client]' \
			"id=$2"
		for p in "${PROTECTED[@]}"; do printf 'protected=%s\r\n' "$p"; done
	} 2>/dev/null > "$tmp" && mv -f -- "$tmp" "$path" 2>/dev/null; then
		return 0
	fi
	rm -f -- "$tmp" 2>/dev/null
	return 1
}

# What a pasted id becomes before it is checked: white space (the Unicode spaces a web
# page can hold included) and quotes taken out, then lower case, as h9_userid.ps1 -SetId
# does.
clean_pasted_id() {
	local s=$1 sp b
	s=${s//[[:space:]\"\']/}
	for sp in $'\xc2\xa0' $'\xc2\x85' $'\xe1\x9a\x80' $'\xe2\x80\xa8' $'\xe2\x80\xa9' \
		$'\xe2\x80\xaf' $'\xe2\x81\x9f' $'\xe3\x80\x80'; do
		s=${s//"$sp"/}
	done
	for b in 80 81 82 83 84 85 86 87 88 89 8a; do
		printf -v sp "\\xe2\\x80\\x$b"
		s=${s//"$sp"/}
	done
	REPLY=${s,,}
}

# ts/config.cfg without its cl_h9_userid lines, every other byte as it was (h9_userid.ps1's
# regex: a line that starts, after spaces or tabs, with cl_h9_userid as a whole word).
scrub_config() {
	local path=$1 tmp="$1.tmp$$" line dropped=0 last
	[ -f "$path" ] && [ -r "$path" ] || return 0
	grep -qi '^[[:blank:]]*cl_h9_userid\([^[:alnum:]_]\|$\)' -- "$path" 2>/dev/null || return 0
	# whether the file ends in a line end, to keep the last line as it is
	last=$(tail -c 1 -- "$path" | od -An -tx1 | tr -d ' \n')
	local kept_last=0
	{
		while IFS= read -r line || [ -n "$line" ]; do
			if [[ ${line,,} =~ ^[[:blank:]]*cl_h9_userid([^[:alnum:]_]|$) ]]; then
				dropped=1
				kept_last=0
				continue
			fi
			printf '%s\n' "$line"
			kept_last=1
		done < "$path"
	} > "$tmp" 2>/dev/null || { rm -f -- "$tmp"; return 1; }
	# a last line that had no line end, and is kept, gets none
	if [ "$last" != 0a ] && [ "$kept_last" = 1 ] && [ -s "$tmp" ]; then
		truncate -s -1 -- "$tmp" 2>/dev/null
	fi
	if [ "$dropped" = 1 ] && mv -f -- "$tmp" "$path" 2>/dev/null; then
		note 'took the id out of ts/config.cfg: the engine keeps it protected in user_id.ini.'
		return 0
	fi
	rm -f -- "$tmp" 2>/dev/null
	return 0
}

# ---- options -----------------------------------------------------------------------
ROOT=''
MODE=keep
SETID=''
GOTSETID=0
while [ $# -gt 0 ]; do
	case $1 in
		--new|--force) MODE=new ;;
		--set)
			MODE=set
			if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then SETID=$2; GOTSETID=1; shift; fi ;;
		--set=*) MODE=set; SETID=${1#--set=}; GOTSETID=1 ;;
		--root)
			if [ $# -lt 2 ]; then echo "h9_userid.sh: --root needs a folder" >&2; exit 2; fi
			ROOT=$2; shift ;;
		--root=*) ROOT=${1#--root=} ;;
		--help|-h) usage; exit 0 ;;
		*) echo "h9_userid.sh: unknown option '$1' (see --help)" >&2; exit 2 ;;
	esac
	shift
done

if [ -z "$ROOT" ]; then
	SELF=$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null) || SELF=${BASH_SOURCE[0]}
	ROOT=$(dirname -- "$SELF")
fi
if ! ROOT=$(cd -- "$ROOT" 2>/dev/null && pwd); then
	echo "h9_userid.sh: there is no folder $ROOT" >&2
	exit 2
fi
TS_DIR=$ROOT/ts
INI=$ROOT/user_id.ini

# ---- --set: enter_userid.cmd ---------------------------------------------------------
if [ "$MODE" = set ]; then
	if [ "$GOTSETID" = 0 ]; then
		echo
		echo ' Paste your player id from havoc9.org (ACCOUNT), then press Enter.'
		echo ' It is 32 characters, 0-9 and a-f. Keep it to yourself: whoever has it'
		echo " is you to H9's servers. Easier: Link your Account in the game's main menu."
		echo
		IFS= read -r -p 'Player id: ' SETID || SETID=''
	fi
	if [ -z "$SETID" ]; then
		echo ' Nothing entered; nothing was changed.'
		exit 0
	fi
	clean_pasted_id "$SETID"; NEW=$REPLY
	if ! [[ $NEW =~ ^[0-9a-f]{32}$ ]]; then
		warn 'that is not a player id: it is 32 characters, 0-9 and a-f (havoc9.org, ACCOUNT). Nothing was changed.'
		exit 1
	fi
	if ! write_set_id "$INI" "$NEW"; then
		warn 'could not write user_id.ini. Nothing was changed.'
		exit 1
	fi
	note 'id saved to user_id.ini. The game protects it at its next start, and servers then see this install as that player.'
	note "Easier next time: Link your Account in the game's main menu, with no id to paste."
	exit 0
fi

# ---- --new: h9_regenerate_userid.bat ---------------------------------------------------
if [ "$MODE" = new ]; then
	if [ -e "$INI" ] && ! rm -f -- "$INI" 2>/dev/null; then
		warn 'could not delete user_id.ini. Nothing was changed.'
		exit 1
	fi
	note 'user_id.ini deleted: the game makes a new id at its next start, not linked to any account.'
	exit 0
fi

# ---- every start: no id left in plain text where older builds put it ------------------
if ! { mkdir -p -- "$TS_DIR" && printf '%s\r\n' "$RESOLVED1" "$RESOLVED2" > "$TS_DIR/userid_resolved.cfg"; } 2>/dev/null; then
	warn 'could not write ts/userid_resolved.cfg.'
fi
scrub_config "$TS_DIR/config.cfg" || warn 'could not read or write ts/config.cfg.'
exit 0
