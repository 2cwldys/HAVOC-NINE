# HAVOC 9 -- the native Linux dedicated server, built from this clone.
#
#   git clone https://github.com/2cwldys/HAVOC-NINE
#   cd HAVOC-NINE && git lfs pull
#   docker build -f dockerfiles/Dockerfile -t h9xash-server .
#   docker run -d --init -p 27015:27015/udp h9xash-server
#
# The build context is the REPOSITORY ROOT, not this folder, so the image takes the game from the
# clone. docs/DOCKER.txt is the long version.
#
# ---------------------------------------------------------------------------------------------
# WHAT COMES FROM WHERE, AND WHY IT IS IN TWO PIECES
#
# A clone gives you the whole game -- 7,330 files, 1.89 GiB of maps, models, sounds, configs and
# compiled plugins under H9XASH/ -- and that is what makes a Docker build worth doing from git:
# you get the newest content without waiting for a published package.
#
# What a clone does NOT give you is the 32-bit Linux binaries. H9XASH-linux/ is build output,
# git-ignored on purpose: the engine (xashds), the game library (ts_i386.so), Metamod-R and the
# AMX Mod X modules are compiled by linux/build-linux.sh and are not in version control. They are
# only 44 MiB across 46 files, so they are a small overlay on top of the content, and
# H9_BINARIES below says where to get them.
#
# WHY THIS BASE, AND WHY IT IS NOT NEGOTIABLE
#
#   * Alpine cannot run this at all. Its libc is musl; these are glibc binaries and will not load.
#   * The glibc must be 2.34 or newer. H9XASH-linux/BUILDINFO.txt records the floor of every
#     library, and the highest is GLIBC_2.34 (amxmodx_mm_i386.so, and the engine, fun, fakemeta
#     and hamsandwich modules). Debian 11 is glibc 2.31 and fails at load with an unhelpful
#     "version `GLIBC_2.34' not found".
#
# Debian 12 is glibc 2.36, which clears it. Ubuntu 22.04 (2.35) and 24.04 (2.39) work too. Do not
# "optimise" this to Alpine or to an older Debian.
# ---------------------------------------------------------------------------------------------

ARG H9_BUILD=dev

# Where the 32-bit binaries come from:
#   download  fetch the published H9XASH-linux-server.zip and take its binaries (the default:
#             it needs nothing of you but a network, and it is 44 MiB)
#   local     use the H9XASH-linux/ folder in this clone, for a maintainer who has built it
#             with linux/build-linux.sh
#
# There is deliberately no "build from source" mode. linux/build-linux.sh compiles reTS,
# Metamod-R, the engine, AMX Mod X through AMBuild and RCBot, and it has only ever been run in
# the WSL2 distro the project sets up (docs/BUILDING.txt 7b). Wiring it into a container here
# and calling it supported would be a claim nobody has tested.
ARG H9_BINARIES=download

# Where the GAME CONTENT comes from: the maps, models, sounds, configs and compiled plugins.
#
#   clone     from this clone's H9XASH/ (the default). The newest content there is, and it costs
#             no Git LFS bandwidth at build time -- the files are already on your disk, so COPY
#             never fetches anything. The LFS cost is the one-off `git lfs pull` you already did.
#   release   from the published H9XASH-linux-server.zip, with no clone and no LFS at all. The
#             build context then needs nothing but dockerfiles/, so this is the one for CI, for a
#             machine that should not hold a 2 GB checkout, and for anyone who would rather not
#             spend LFS quota at all.
#
# The quota does matter, just not here: GitHub meters LFS bandwidth, and anything that clones
# PER BUILD or PER INSTALL burns it fast. That is why the Pterodactyl egg's install defaults to
# the published package too (dockerfiles/pterodactyl/install.sh).
ARG H9_CONTENT=clone

# =================================================================== the binaries, 44 MiB of them
FROM debian:bookworm-slim AS bin-download
ARG SERVER_ZIP_URL=https://havoc9.org/downloads/H9XASH-linux-server.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
# Only the Linux-specific parts are taken; the content is the clone's, which is newer, and
# unpacking the whole archive over it would bury it.
#
# The list below is the shape of H9XASH-linux/ and every item in it is here for a reason:
#
#   *.so, xashds            the engine, the game library, Metamod, RCBot and the AMX Mod X modules
#   *.patch                 the patch chain note that ships beside every patched or rebuilt
#                           binary in this project, so a shipped binary always says what went
#                           into it. Note xashds.patch is NOT *.so.patch -- matching only the
#                           latter silently drops the engine's own note.
#   BUILDINFO.txt           the hashes and glibc floors of all of the above
#   INPUTS.json             what each step was built from
#   ts/liblist.gam          names the game library. The clone's copy says dlls/ts.dll, which is
#   ts/gameinfo.txt         a Windows DLL: without these two the engine looks for the wrong file.
#   metamod/plugins.ini     Metamod loads nothing at all without it. Scoped by full path on
#                           purpose: amxmodx/configs/plugins.ini is a DIFFERENT file, the list of
#                           plugins to run, and that one must stay the clone's.
#   easy_http bits          the third-party module's licence and its certificate list
RUN set -eux; \
    curl -fsSL "$SERVER_ZIP_URL" -o /tmp/server.zip; \
    mkdir -p /bin-overlay /tmp/unzipped; \
    unzip -q /tmp/server.zip -d /tmp/unzipped; \
    root=$(dirname "$(find /tmp/unzipped -name xashds -type f -print -quit)"); \
    [ -n "$root" ] && [ -f "$root/xashds" ] || { echo "no xashds in $SERVER_ZIP_URL"; exit 1; }; \
    cd "$root"; \
    find . \( -name '*.so' -o -name 'xashds' -o -name '*.patch' \
              -o -name 'BUILDINFO.txt' -o -name 'INPUTS.json' \
              -o -path './ts/liblist.gam' -o -path './ts/gameinfo.txt' \
              -o -path './ts/addons/metamod/plugins.ini' \
              -o -name 'easy_http_LICENSE.txt' -o -name 'amxx_easy_http_cacert.pem' \) \
        -exec cp -a --parents {} /bin-overlay/ \; ; \
    test -f /bin-overlay/xashds.patch || echo "WARNING: no xashds.patch in the package"; \
    test -f /bin-overlay/ts/addons/metamod/plugins.ini \
      || { echo "no ts/addons/metamod/plugins.ini in the package: Metamod would load nothing"; exit 1; }; \
    test -f /bin-overlay/ts/liblist.gam \
      || { echo "no ts/liblist.gam in the package: the engine would look for the Windows game DLL"; exit 1; }; \
    printf 'Linux overlay: %s files, %s\n' "$(find /bin-overlay -type f | wc -l)" "$(du -sh /bin-overlay | cut -f1)"

FROM debian:bookworm-slim AS bin-local
# Fails with a clear message rather than an empty overlay when the folder is not there.
COPY H9XASH-linu[x] /bin-overlay
RUN test -f /bin-overlay/xashds || { \
      echo "H9_BINARIES=local, but this clone has no H9XASH-linux/xashds."; \
      echo "Build it first (linux/build-linux.sh, docs/BUILDING.txt 7b), or use the default"; \
      echo "H9_BINARIES=download."; exit 1; }

FROM bin-${H9_BINARIES} AS binaries

# ======================================================================== the game content
# Two sources, picked by H9_CONTENT. Both end with the game at /srv/h9xash.

FROM debian:bookworm-slim AS content-clone
COPY H9XASH /srv/h9xash

FROM debian:bookworm-slim AS content-release
# No clone and no Git LFS: the published package carries the content as well as the binaries.
ARG SERVER_ZIP_URL=https://havoc9.org/downloads/H9XASH-linux-server.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    curl -fsSL "$SERVER_ZIP_URL" -o /tmp/server.zip; \
    mkdir -p /tmp/unzipped /srv; \
    unzip -q /tmp/server.zip -d /tmp/unzipped; \
    root=$(dirname "$(find /tmp/unzipped -name xashds -type f -print -quit)"); \
    [ -n "$root" ] && [ -d "$root/ts" ] || { echo "no server in $SERVER_ZIP_URL"; exit 1; }; \
    mv "$root" /srv/h9xash; \
    rm -rf /tmp/unzipped /tmp/server.zip

FROM content-${H9_CONTENT} AS content
COPY --from=binaries /bin-overlay/ /srv/h9xash/
# After the overlay, deliberately. Both H9XASH-linux/ and the published package carry a copy of
# this launcher, but its own header names linux/h9xash_server.sh as the source -- "edit it there,
# not in H9XASH-linux" -- so the clone's copy is the one that should win.
COPY linux/h9xash_server.sh /srv/h9xash/h9xash_server.sh

# H9XASH-Updater, the Linux build, so an operator can bring the server up to date (and fetch the
# HD textures with --hd) from inside the container instead of rebuilding the image. It is build
# output like the 32-bit binaries, so the bracket makes this COPY optional the same way
# "COPY H9XASH-linu[x]" above is: a glob that matches nothing is allowed, a literal path that does
# not exist is not. A clone that has never run tools/updater/build-linux.sh simply gets an image
# without it, which is why nothing below tests for it.
#
# It carries its own CA bundle, so it does not depend on the image's ca-certificates to reach
# havoc9.org. Note it will refuse to run against /opt/h9xash without --force if that folder ever
# sits inside a git checkout; in the image it does not.
COPY dist/H9XASH-Update[r] /srv/h9xash/

# A clone made without Git LFS leaves a 130-byte text pointer where every map, model and wad
# should be. The image would build, start, and fail to load a single map. The updater guards
# against exactly this (tools/updater/h9xash_updater.py, LFS_POINTER); so does this.
RUN set -eux; \
    bad=$(find /srv/h9xash -type f \( -name '*.bsp' -o -name '*.mdl' -o -name '*.wad' \) -size -1k \
          -exec grep -l '^version https://git-lfs' {} + 2>/dev/null | head -n 5 || true); \
    if [ -n "$bad" ]; then \
        echo "STOPPED: this clone's game files are Git LFS pointers, not the files:"; \
        echo "$bad" | sed 's/^/  /'; \
        echo "Run  git lfs pull  in the clone and build again."; exit 1; \
    fi; \
    test -x /srv/h9xash/xashds || chmod +x /srv/h9xash/xashds; \
    chmod +x /srv/h9xash/h9xash_server.sh; \
    rm -rf /srv/h9xash/ts/materials; \
    # A Windows checkout hands us CRLF shell scripts -- the root .gitattributes has no *.sh rule,
    # so linux/h9xash_server.sh arrives with \r on every line. Linux then reads the shebang as an
    # interpreter literally named "bash\r" and the container dies with
    #   /usr/bin/env: 'bash\r': No such file or directory
    # Strip it here rather than depending on how the clone was made, since the image has to build
    # the same from a Windows checkout, a Linux one, and a CI runner.
    for sh in /srv/h9xash/*.sh; do \
        [ -f "$sh" ] && sed -i 's/\r$//' "$sh"; \
    done; \
    head -c 2 /srv/h9xash/h9xash_server.sh | grep -q '#!' \
      || { echo "h9xash_server.sh has no shebang after normalising"; exit 1; }

# ============================================================================== the runtime image
FROM debian:bookworm-slim

ARG H9_BUILD
LABEL org.opencontainers.image.title="HAVOC 9 dedicated server" \
      org.opencontainers.image.version="${H9_BUILD}" \
      org.opencontainers.image.source="https://github.com/2cwldys/HAVOC-NINE" \
      org.opencontainers.image.licenses="See LICENSE.md and THIRD_PARTY_LICENSES/"

# The build this image carries. release-prepare.mjs writes dockerfiles/VERSION with every bump and
# release-check.mjs fails when it falls behind, exactly like the other places the number appears
# (docs/H9_RELEASE.txt 5b). A server refuses a client of another release, so an operator wants to
# see at a glance whether their container is behind.
ENV H9_BUILD=${H9_BUILD} \
    H9_SERVER_DIR=/opt/h9xash \
    DEBIAN_FRONTEND=noninteractive

ARG PUID=10099
ARG PGID=10099
ARG WITH_P2P=0

# i386 is the architecture of every game library here; without the foreign architecture these
# packages do not exist and nothing loads.
#
# ca-certificates is NOT optional. h9xash_server.sh rebuilds the game's own certificate lists
# (ts/addons/amxmodx/data/amxx_easy_http_cacert.pem and valve/cacert.pem) from the system bundle
# on every launch. With no bundle in the image it leaves them alone, and the web module that
# talks to havoc9.org can fail its TLS handshake with nothing obvious in the log.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      libc6:i386 libstdc++6:i386 zlib1g:i386 \
      ca-certificates bash procps \
 && if [ "$WITH_P2P" = "1" ]; then \
      apt-get install -y --no-install-recommends curl \
      && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
      && apt-get install -y --no-install-recommends nodejs \
      && apt-get purge -y curl; \
    fi \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN groupadd -g "$PGID" h9 \
 && useradd -u "$PUID" -g "$PGID" -M -d /opt/h9xash -s /usr/sbin/nologin h9

COPY --from=content --chown=${PUID}:${PGID} /srv/h9xash /opt/h9xash
COPY --chown=${PUID}:${PGID} dockerfiles/entrypoint.sh /usr/local/bin/h9-entrypoint
RUN chmod 0755 /usr/local/bin/h9-entrypoint

# The server writes here: engine.log, its certificate lists, the AMX Mod X vault and sqlite3 data.
# Mount a volume over it to keep that across a new image; without one it lives and dies with the
# container, which is fine for a scrim server and wrong for a ranked one.
VOLUME ["/opt/h9xash/ts/addons/amxmodx/data"]

WORKDIR /opt/h9xash
USER h9

# GoldSrc is UDP only, rcon included. EXPOSE is documentation; the publish on `docker run` is what
# matters, and it needs the /udp suffix or the container is unreachable with no error shown.
EXPOSE 27015/udp

HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
    CMD bash -c 'exec 3<>/dev/udp/127.0.0.1/${H9_PORT:-27015} \
        && printf "\xff\xff\xff\xffTSource Engine Query\x00" >&3 \
        && timeout 4 head -c 1 <&3 >/dev/null' || exit 1

ENTRYPOINT ["/usr/local/bin/h9-entrypoint"]
