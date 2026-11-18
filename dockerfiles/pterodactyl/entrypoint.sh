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

printf '\033[1m\033[33mcontainer@h9xash~ \033[0m%s\n' "$STARTUP_EXPANDED"

# shellcheck disable=SC2086
exec env ${STARTUP_EXPANDED}
