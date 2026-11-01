#!/usr/bin/env bash
# webclient-setup.sh -- the web client's game files and browser builds on the VPS, laid out from a
# clone of the repository, as havoc9.org/webclient/DEPLOY.txt section 5 describes. Keep the two in
# step.
#
# Run it as root after a git pull. In order, it:
#   1. makes the package from the clone when there is none, or when REPACK=1: python3 runs
#      tools/make_webclient_game.py, which takes the game from the clone's H9XASH, the browser builds
#      from webclient-bin and Half-Life's own files to leave out from tools/webclient_leave_out.txt,
#      into <clone>/webclient-build/stage (about 1.2 GB; git ignores it). No Half-Life install is
#      needed;
#   2. copies the package's game files into /srv/h9web/game, which nginx serves at /webclient/game/;
#      files the package no longer has are removed there;
#   3. copies the engine (xash.js, xash.wasm) into <site>/webclient/engine/ and the two lists
#      (manifest.json, preload.json) into <site>/webclient/, the lists last, so a player never gets a
#      list naming files that are not there yet;
#   4. keeps a gzip copy beside each large file for nginx's gzip_static, made again only where the
#      file is newer than its copy, and removes copies whose file is gone;
#   5. checks what it laid out.
#
# Usage, as root (sudo -i first), from this folder in the clone:
#   bash webclient-setup.sh
#   REPACK=1 bash webclient-setup.sh      the package made again from the clone first
# DOMAIN changes the default, as for nginx-setup.sh.
#
# It does not copy the site's own pages in (DEPLOY.txt section 5: index.html, client.js, auth.js and
# settings.json come with the site) and does not touch nginx or h9web.
set -euo pipefail

DOMAIN="${DOMAIN:-havoc9.org}"
SITE_ROOT="/var/www/$DOMAIN"
GAME_ROOT="/srv/h9web/game"
HERE="$(cd "$(dirname "$0")" && pwd)"
CLONE="$(cd "$HERE/../.." && pwd)"
STAGE="$CLONE/webclient-build/stage"

say()  { printf '\n== %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it as root: sudo -i, then bash $0"
[ -f "$CLONE/tools/make_webclient_game.py" ] || die "$CLONE is not a clone of the repository (no tools/make_webclient_game.py)"
[ -d "$SITE_ROOT/webclient" ] || die "no $SITE_ROOT/webclient: copy the site in first (DEPLOY.txt section 5)"

export DEBIAN_FRONTEND=noninteractive
missing=()
for p in python3 rsync gzip; do command -v "$p" >/dev/null || missing+=("$p"); done
if [ "${#missing[@]}" -gt 0 ]; then apt-get update -q; apt-get install -y -q "${missing[@]}"; fi

say "1. the package"
if [ "${REPACK:-0}" = "1" ] || [ ! -f "$STAGE/manifest.json" ]; then
  [ -d "$CLONE/webclient-bin" ] || die "no $CLONE/webclient-bin: the browser builds are not in this clone"
  python3 "$CLONE/tools/make_webclient_game.py" --replace
else
  echo "  $STAGE (made $(date -r "$STAGE/manifest.json" '+%Y-%m-%d %H:%M'); REPACK=1 makes it again)"
fi
for f in manifest.json preload.json engine/xash.js engine/xash.wasm; do
  [ -f "$STAGE/$f" ] || die "the package has no $f"
done
if find "$STAGE/game" \( -iname 'ts_advertise*' -o -iname '.xash_id' -o -iname 'user_id.ini' -o -iname '*_resolved.cfg' \) | grep -q .; then
  die "the package holds a file that must never be served; see DEPLOY.txt section 9"
fi

say "2. the game files: $GAME_ROOT"
mkdir -p "$GAME_ROOT"
# the gzip copies are this script's own: rsync leaves them alone, step 4 looks after them
rsync -a --delete --exclude='*.gz' "$STAGE/game/" "$GAME_ROOT/"
echo "  $(find "$GAME_ROOT" -type f ! -name '*.gz' | wc -l) files, $(du -sh --exclude='*.gz' "$GAME_ROOT" | cut -f1)"

say "3. the engine and the lists: $SITE_ROOT/webclient"
mkdir -p "$SITE_ROOT/webclient/engine"
install -m 644 "$STAGE/engine/xash.js" "$STAGE/engine/xash.wasm" "$SITE_ROOT/webclient/engine/"
install -m 644 "$STAGE/preload.json" "$SITE_ROOT/webclient/preload.json"
install -m 644 "$STAGE/manifest.json" "$SITE_ROOT/webclient/manifest.json"
echo "  engine/xash.js, engine/xash.wasm, preload.json, manifest.json"

say "4. gzip copies for gzip_static"
made=0
while IFS= read -r -d '' f; do
  if [ ! -e "$f.gz" ] || [ "$f" -nt "$f.gz" ]; then
    gzip -k -f -9 "$f"
    made=$((made + 1))
  fi
done < <(find "$GAME_ROOT" "$SITE_ROOT/webclient/engine" -type f -size +4k \
  \( -name '*.bsp' -o -name '*.mdl' -o -name '*.wad' -o -name '*.wav' -o -name '*.spr' -o -name '*.tga' \
     -o -name '*.wasm' -o -name '*.txt' -o -name '*.js' \) -print0)
gone=0
while IFS= read -r -d '' g; do
  [ -e "${g%.gz}" ] || { rm -f "$g"; gone=$((gone + 1)); }
done < <(find "$GAME_ROOT" "$SITE_ROOT/webclient/engine" -type f -name '*.gz' -print0)
echo "  $made made, $gone removed"

say "5. checks"
python3 - "$SITE_ROOT/webclient/manifest.json" "$GAME_ROOT" <<'PY'
import json, os, sys
m = json.load(open(sys.argv[1]))
bad = [e["path"] for e in m["files"] if not os.path.isfile(os.path.join(sys.argv[2], e["path"]))
       or os.path.getsize(os.path.join(sys.argv[2], e["path"])) != e["size"]]
print("  %d files listed, %d missing or a different size" % (len(m["files"]), len(bad)))
for p in bad[:10]:
    print("    " + p)
sys.exit(1 if bad else 0)
PY
if command -v curl >/dev/null; then
  ct="$(curl -sI "https://$DOMAIN/webclient/engine/xash.wasm" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
  [ "$ct" = "application/wasm" ] && echo "  https://$DOMAIN/webclient/engine/xash.wasm: application/wasm" \
    || warn "https://$DOMAIN/webclient/engine/xash.wasm answers content-type '$ct', not application/wasm (nginx, DEPLOY.txt section 8)"
fi
echo
echo "  The web client's files are in place: the game in $GAME_ROOT, the engine and the lists in $SITE_ROOT/webclient."
