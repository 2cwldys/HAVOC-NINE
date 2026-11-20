#!/usr/bin/env bash
# entrypoint.sh -- turns environment variables into the engine arguments h9xash_server.sh takes.
#
# The game is baked into the image from the clone it was built from (dockerfiles/Dockerfile), so
# this normally finds a complete server at /opt/h9xash and starts it. A volume mounted over that
# path replaces it, which is how you run a server you keep outside the image.
#
# Everything here is optional. With no variables set at all this starts exactly the server
# h9xash_server.sh starts by itself, which is the point -- the script already has sane defaults
# and this does not second-guess them. A variable that is set wins, because h9xash_server.sh
# passes anything given to it to the engine AFTER its own defaults, and the last value wins.
#
# docs/DOCKER.txt is the long version.
set -euo pipefail

SERVER_DIR=${H9_SERVER_DIR:-/opt/h9xash}

say() { printf '[h9-docker] %s\n' "$*"; }
die() { printf '[h9-docker] %s\n' "$*" >&2; exit 1; }

# ---- the folder has to be a server, and it has to be writable --------------------------------
[ -d "$SERVER_DIR" ] || die "there is no $SERVER_DIR in this image, and nothing is mounted there."

cd "$SERVER_DIR"

[ -x ./xashds ] || die "$SERVER_DIR holds no runnable ./xashds.
   If you mounted a volume over it, that volume is now the server and it needs the whole thing:
   the unpacked H9XASH-linux-server.zip, or this image's own /opt/h9xash copied out first.
   If the files are there but not executable, an archive unpacked on Windows lost its Unix
   modes (docs/LINUX_SUPPORT.txt):  chmod +x xashds h9xash_server.sh"

[ -x ./h9xash_server.sh ] || die "$SERVER_DIR has no runnable ./h9xash_server.sh (chmod +x it)"

# The server writes into its own folder on every run: engine.log, the certificate lists, the AMX
# Mod X vault and sqlite3 data, the logs. A read-only mount looks like it works and then loses
# every bit of state, so it is worth failing loudly here instead.
probe=".h9-docker-write-test"
if ! ( : > "$probe" ) 2>/dev/null; then
    die "$SERVER_DIR is not writable by this container (uid $(id -u), gid $(id -g)).
   The server writes engine.log, its certificate lists and the AMX Mod X vault into this folder.
   If this is a mounted volume, chown it to that uid:gid on the host, or build the image with
   --build-arg PUID=\$(id -u) --build-arg PGID=\$(id -g)."
fi
rm -f "$probe"

# ---- environment to engine arguments -----------------------------------------------------------
# Only variables that are actually SET are passed, so an unset one leaves the script's own default
# alone rather than overwriting it with an empty string.
args=()
add_plus() { [ -n "${2:-}" ] && args+=("+$1" "$2"); return 0; }

[ -n "${H9_PORT:-}" ] && args+=(-port "$H9_PORT")
add_plus hostname    "${H9_HOSTNAME:-}"
add_plus map         "${H9_MAP:-}"
add_plus maxplayers  "${H9_MAXPLAYERS:-}"
add_plus sv_lan      "${H9_SV_LAN:-}"
add_plus mp_teamplay "${H9_TEAMPLAY:-}"
add_plus sv_password "${H9_PASSWORD:-}"

# rcon_password is deliberately LAST of the cvars and is never echoed. Prefer H9_RCON_PASSWORD_FILE
# with a Docker secret; a password in an environment variable is visible to anything that can run
# `docker inspect` on this container.
rcon=${H9_RCON_PASSWORD:-}
if [ -n "${H9_RCON_PASSWORD_FILE:-}" ]; then
    [ -r "$H9_RCON_PASSWORD_FILE" ] || die "H9_RCON_PASSWORD_FILE is set but $H9_RCON_PASSWORD_FILE cannot be read"
    rcon=$(head -n 1 -- "$H9_RCON_PASSWORD_FILE" | tr -d '\r\n')
fi
[ -n "$rcon" ] && args+=(+rcon_password "$rcon")

# Anything else, verbatim. Word-split on purpose: this is how you pass several.
#   H9_ARGS="+sv_cheats 0 +mp_timelimit 20"
if [ -n "${H9_ARGS:-}" ]; then
    # shellcheck disable=SC2206
    extra=(${H9_ARGS})
    args+=("${extra[@]}")
fi

# ---- say what is about to happen, without the password ------------------------------------------
shown=()
skip_next=0
for a in "${args[@]}"; do
    if [ "$skip_next" = 1 ]; then shown+=("<hidden>"); skip_next=0; continue; fi
    case $a in +rcon_password|+sv_password) skip_next=1 ;; esac
    shown+=("$a")
done
say "server folder : $SERVER_DIR"
say "running as    : uid $(id -u), gid $(id -g)"
say "arguments     : ${shown[*]:-(none: h9xash_server.sh defaults)}"
say "note          : the game is UDP. A published port without /udp reaches nothing."


# ---- is this image behind? ----------------------------------------------------------------------
# $H9_BUILD is baked in at build time; havoc9.org/downloads/.build is what the site serves now.
# This only reports. It never updates anything by itself: a boot script that rewrites a running
# server's files without being asked is how a working server stops working.
#   H9_VERSION_CHECK=0   skip it entirely (no network call at boot)
#   H9_BUILD_URL=...     ask somewhere else
if [ "${H9_VERSION_CHECK:-1}" != "0" ] && [ -n "${H9_BUILD:-}" ] && [ "${H9_BUILD}" != "dev" ]; then
    build_url=${H9_BUILD_URL:-https://havoc9.org/downloads/.build}
    # -m 4: a slow or unreachable site must never hold up the server starting
    published=$(curl -fsSL -m 4 "$build_url" 2>/dev/null | head -n 1 | tr -d '\r\n' || true)
    if [ -z "$published" ]; then
        say "build         : $H9_BUILD (could not reach $build_url to compare)"
    elif [ "$published" = "$H9_BUILD" ]; then
        say "build         : $H9_BUILD (up to date)"
    else
        say "build         : $H9_BUILD -- havoc9.org now serves $published"
        if [ -x ./H9XASH-Updater ]; then
            say "                to update this install in place:  ./H9XASH-Updater"
        else
            say "                pull a newer image, or run H9XASH-Updater from havoc9.org/downloads/"
        fi
        say "                a server refuses a client of another release, so being behind matters"
    fi
fi

# exec, so the engine is the process Docker signals and `docker stop` ends it properly.
exec ./h9xash_server.sh "${args[@]}" "$@"
