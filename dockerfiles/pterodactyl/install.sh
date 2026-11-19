#!/bin/bash
# HAVOC 9 dedicated server -- the Pterodactyl / Pelican install script.
#
# This runs ONCE when a server is created or reinstalled, in a throwaway installer container,
# with the server's files at /mnt/server. It is embedded into egg-h9xash.json by build-egg.py;
# edit it here and regenerate, do not edit the JSON.
#
# Two sources, chosen by the H9_SOURCE variable in the egg:
#
#   release   the published H9XASH-linux-server.zip. Fast, about 300 MB, and it is the build the
#             servers on havoc9.org are running. This is the default.
#   git       clone this repository and pull its LFS objects, then lay the published Linux
#             binaries over it. Slower and about 2 GB, but it is the newest content there is.
#
# Either way the 32-bit binaries come from the published package: they are build output and are
# NOT in git (docs/LINUX_SUPPORT.txt).
set -euo pipefail

say() { printf '\n\033[1m\033[33m[h9-install]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1m\033[31m[h9-install]\033[0m %s\n' "$*" >&2; exit 1; }

SOURCE=${H9_SOURCE:-release}
REPO=${H9_REPO:-https://github.com/2cwldys/HAVOC-NINE.git}
BRANCH=${H9_BRANCH:-main}
ZIP_URL=${H9_SERVER_ZIP_URL:-https://havoc9.org/downloads/H9XASH-linux-server.zip}

mkdir -p /mnt/server
cd /mnt/server

say "HAVOC 9 dedicated server -- installing from: $SOURCE"

# ---- the published package, always: it carries the 32-bit binaries -------------------------------
say "fetching $ZIP_URL"
curl -fsSL "$ZIP_URL" -o /tmp/h9server.zip || die "could not download $ZIP_URL
   If havoc9.org is up and this still fails, the Linux server package may not be published for
   this build yet. Set H9_SERVER_ZIP_URL to a package you have."

mkdir -p /tmp/pkg
unzip -q -o /tmp/h9server.zip -d /tmp/pkg
PKG=$(dirname "$(find /tmp/pkg -name xashds -type f -print -quit)")
[ -n "$PKG" ] && [ -f "$PKG/xashds" ] || die "that archive holds no xashds: it is not a Linux server package"

if [ "$SOURCE" = "git" ]; then
    # ---- the newest content, from the repository -------------------------------------------------
    say "cloning $REPO ($BRANCH) -- this is about 2 GB with its LFS objects"
    command -v git >/dev/null || die "git is not in the installer image"
    git clone --depth 1 --branch "$BRANCH" "$REPO" /tmp/repo || die "could not clone $REPO"
    cd /tmp/repo

    # Without this every map, model and wad is a 130-byte pointer and no map will load.
    if command -v git-lfs >/dev/null || git lfs version >/dev/null 2>&1; then
        say "pulling Git LFS objects (the maps, models and wads)"
        git lfs pull || die "git lfs pull failed: without it the maps are pointers, not maps"
    else
        die "git-lfs is not in the installer image, and the maps are LFS objects.
   Use H9_SOURCE=release, or use an installer image that has git-lfs."
    fi

    [ -d H9XASH ] || die "this clone has no H9XASH folder"
    say "copying the game from the clone"
    cp -a H9XASH/. /mnt/server/
    # The optional HD textures are a separate 19.7 GB download and are never part of a server.
    rm -rf /mnt/server/ts/materials
    cp -f linux/h9xash_server.sh /mnt/server/h9xash_server.sh
    cd /mnt/server
else
    say "copying the published package"
    cp -a "$PKG/." /mnt/server/
fi

# ---- the Linux overlay, over whatever content is now in place ------------------------------------
# Every item here is Linux-specific and must win over the clone's Windows copy. In particular
# liblist.gam and gameinfo.txt name the game library: the clone's say dlls/ts.dll, and the engine
# would look for a Windows DLL. metamod/plugins.ini is scoped by full path on purpose, because
# amxmodx/configs/plugins.ini is a different file (the list of plugins to run) that must stay as
# the content left it. Every .patch note travels with its binary, as it does everywhere else in
# this project -- note xashds.patch is not *.so.patch.
say "laying the Linux binaries and their patch notes over it"
cd "$PKG"
find . \( -name '*.so' -o -name 'xashds' -o -name '*.patch' \
          -o -name 'BUILDINFO.txt' -o -name 'INPUTS.json' \
          -o -path './ts/liblist.gam' -o -path './ts/gameinfo.txt' \
          -o -path './ts/addons/metamod/plugins.ini' \
          -o -name 'easy_http_LICENSE.txt' -o -name 'amxx_easy_http_cacert.pem' \) \
    -exec cp -a --parents {} /mnt/server/ \;
cd /mnt/server

# ---- H9XASH-Updater, so the server can be brought up to date in place --------------------------
# Optional on purpose. The updater is a convenience for the operator -- it updates the install and
# fetches the HD textures with --hd -- and a panel install that cannot reach the file is still a
# working server, so a failure here is a note, never a stop. It carries its own CA bundle, so it
# does not depend on this image's certificates.
UPD_URL=${H9_UPDATER_URL:-https://havoc9.org/downloads/H9XASH-Updater}
say "fetching H9XASH-Updater (optional)"
if curl -fsSL "$UPD_URL" -o /mnt/server/H9XASH-Updater 2>/dev/null \
   && [ -s /mnt/server/H9XASH-Updater ]; then
    chmod +x /mnt/server/H9XASH-Updater
    say "  H9XASH-Updater in place: ./H9XASH-Updater --check, or --hd for the HD textures"
else
    rm -f /mnt/server/H9XASH-Updater
    say "  not fetched from $UPD_URL -- the server is complete without it."
    say "  Set H9_UPDATER_URL if it is published elsewhere."
fi

# ---- make it runnable, and check it -----------------------------------------------------------------
chmod +x ./xashds ./h9xash_server.sh 2>/dev/null || true
find . -name '*.so' -exec chmod 0644 {} + 2>/dev/null || true

[ -x ./xashds ]                            || die "no runnable ./xashds after the install"
[ -x ./h9xash_server.sh ]                  || die "no runnable ./h9xash_server.sh after the install"
[ -f ./ts/liblist.gam ]                    || die "no ts/liblist.gam: the engine would not find the game"
[ -f ./ts/addons/metamod/plugins.ini ]     || die "no ts/addons/metamod/plugins.ini: Metamod would load nothing"
[ -d ./ts/maps ]                           || die "no ts/maps: there is no game content here"

pointers=$(find ./ts -type f \( -name '*.bsp' -o -name '*.mdl' -o -name '*.wad' \) -size -1k \
           -exec grep -l '^version https://git-lfs' {} + 2>/dev/null | head -n 3 || true)
[ -z "$pointers" ] || die "some game files are Git LFS pointers, not the files:
$pointers
   The clone was made without Git LFS. Reinstall with H9_SOURCE=release, or fix git-lfs."

maps=$(find ./ts/maps -name '*.bsp' | wc -l)
say "done: $maps map(s), engine $(ls -la ./xashds | awk '{print $5}') bytes"
say "the join gate release is: $(head -n1 ./ts/h9_release.txt 2>/dev/null || echo 'unknown')"
say "GoldSrc is UDP. The allocation for this server must be UDP or nothing can reach it."
