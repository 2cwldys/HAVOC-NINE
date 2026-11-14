#!/bin/sh
# Starts the P2P relay (bin/h9rv.js) from relay.config.json beside this script. README.txt explains every key.
#
#   sh run.sh                  run the relay; Ctrl+C stops it
#   sh run.sh --check          read the config and the hosts file, say what is wrong, start nothing
#   sh run.sh token Mike       make a host token for Mike: its hash goes into hosts.json, the token is shown once
#   sh run.sh hosts list       who has a token (never the tokens);  sh run.sh hosts remove <id>
#
# The first run makes relay.config.json and hosts.json from the examples and stops, so that you fill them in; h9rv itself refuses
# a config or a hosts file that still holds the examples' CHANGE-ME values. Nothing is downloaded and nothing is installed.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "run.sh: Node.js 20 or newer is needed and was not found (https://nodejs.org, or your package manager)." >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "run.sh: Node.js $(node --version) is too old: 20 or newer is needed." >&2
  exit 1
fi

case "$1" in
  token|hosts) exec node bin/h9rv.js "$@" --hosts hosts.json ;;
esac

made=0
if [ ! -f relay.config.json ]; then cp relay.config.example.json relay.config.json && made=1; fi
if [ ! -f hosts.json ]; then cp hosts.example.json hosts.json && made=1; fi
if [ "$made" = 1 ]; then
  echo "run.sh: made relay.config.json and hosts.json from the examples. Now:"
  echo "  1. edit relay.config.json: publicUdp.host is the name or address that players reach this machine by"
  echo "  2. make a token for each host:   sh run.sh token Mike"
  echo "  3. start the relay:              sh run.sh"
  exit 1
fi

exec node bin/h9rv.js --config relay.config.json "$@"
