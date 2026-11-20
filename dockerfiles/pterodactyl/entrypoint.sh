#!/bin/bash
# The Pterodactyl / Pelican entrypoint, in the shape every egg image uses.
#
# The panel does not run a command of ours. It puts the egg's startup line in the STARTUP
# environment variable, with {{VARIABLE}} placeholders still in it, and expects the image to
# expand those against the environment and exec the result. That is all this does.
#
# It is deliberately dumb. Any cleverness belongs in the egg, where an operator can read it in the
# panel and change it without rebuilding an image.
cd /home/container || exit 1

# The internal address the panel allocated, for anything that wants to know it.
INTERNAL_IP=$(ip route get 1 2>/dev/null | awk '{print $(NF-2); exit}')
export INTERNAL_IP

printf '\033[1m\033[33mcontainer@h9xash~ \033[0mHAVOC 9 dedicated server'
if [ -n "${H9_BUILD:-}" ]; then printf ' (image for build %s)' "$H9_BUILD"; fi
printf '\n'

# The game is UDP, rcon included. A port allocated without UDP reaches nothing, and the server
# looks perfectly healthy while being unreachable, so it is worth saying before the engine starts.
printf '\033[1m\033[33mcontainer@h9xash~ \033[0mport %s/udp -- GoldSrc is UDP only\n' "${SERVER_PORT:-27015}"

if [ ! -x ./xashds ]; then
    printf '\033[1m\033[31mcontainer@h9xash~ \033[0mNo runnable ./xashds here.\n'
    printf '   Reinstall the server from the egg, or if the files are present but not executable\n'
    printf '   the archive lost its Unix modes: chmod +x xashds h9xash_server.sh\n'
    exit 1
fi

# Expand {{VARIABLE}} against the environment. Done with a parameter expansion loop rather than
# eval, so a hostname holding a quote or a backtick cannot run as a command.
STARTUP_EXPANDED=${STARTUP}
while [[ $STARTUP_EXPANDED =~ \{\{([A-Za-z_][A-Za-z0-9_]*)\}\} ]]; do
    name=${BASH_REMATCH[1]}
    STARTUP_EXPANDED=${STARTUP_EXPANDED//\{\{$name\}\}/${!name}}
done


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
        printf '[h9] %s\n' "build         : $H9_BUILD (could not reach $build_url to compare)"
    elif [ "$published" = "$H9_BUILD" ]; then
        printf '[h9] %s\n' "build         : $H9_BUILD (up to date)"
    else
        printf '[h9] %s\n' "build         : $H9_BUILD -- havoc9.org now serves $published"
        if [ -x ./H9XASH-Updater ]; then
            printf '[h9] %s\n' "                to update this install in place:  ./H9XASH-Updater"
        else
            printf '[h9] %s\n' "                pull a newer image, or run H9XASH-Updater from havoc9.org/downloads/"
        fi
        printf '[h9] %s\n' "                a server refuses a client of another release, so being behind matters"
    fi
fi

printf '\033[1m\033[33mcontainer@h9xash~ \033[0m%s\n' "$STARTUP_EXPANDED"

# shellcheck disable=SC2086
exec env ${STARTUP_EXPANDED}
