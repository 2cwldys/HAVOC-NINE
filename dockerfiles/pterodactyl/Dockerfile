# HAVOC 9 dedicated server, as a Pterodactyl / Pelican yolk image.
#
#   docker build -t ghcr.io/<you>/h9xash-server:1.66 --build-arg H9_BUILD=1.66 \
#       -f dockerfiles/pterodactyl/Dockerfile dockerfiles/pterodactyl
#
# This is a SEPARATE image from ../Dockerfile, and it has to be, because the panel fixes three
# things an ordinary image is free to choose:
#
#   * the server lives at /home/container, not a path we pick;
#   * it runs as the user `container`, uid 988, which the panel's wings daemon chowns the volume
#     to -- an image with a different uid writes nothing;
#   * the panel supplies its own startup command from the egg, so there is no ENTRYPOINT of ours
#     doing the argument building. The egg does that with {{VARIABLE}} substitution instead.
#
# Everything about the BINARIES is the same as the ordinary image, and so is the reasoning:
# 32-bit i386 glibc, floor GLIBC_2.34 (H9XASH-linux/BUILDINFO.txt), so Debian 12 and not Alpine
# and not Debian 11. See ../Dockerfile for the full explanation.
FROM debian:bookworm-slim

ARG H9_BUILD=dev
LABEL org.opencontainers.image.title="HAVOC 9 dedicated server (Pterodactyl)" \
      org.opencontainers.image.version="${H9_BUILD}" \
      org.opencontainers.image.source="https://github.com/2cwldys/HAVOC-NINE"
ENV H9_BUILD=${H9_BUILD}

ENV DEBIAN_FRONTEND=noninteractive

# ca-certificates is required, not optional: h9xash_server.sh rebuilds the game's own certificate
# lists from the system bundle on every launch, and without one the web module's TLS to havoc9.org
# can fail with nothing obvious in the log.
#
# curl, unzip and file are here for the egg's install script, which runs in THIS image by default
# so that the install and the runtime agree about the architecture.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      libc6:i386 \
      libstdc++6:i386 \
      zlib1g:i386 \
      ca-certificates \
      bash \
      curl \
      unzip \
      file \
      tzdata \
      iproute2 \
      procps \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# uid 988 is what the panel's wings daemon expects and chowns volumes to. Changing it means the
# server cannot write its own folder.
RUN useradd -m -d /home/container -u 988 -s /bin/bash container

USER container
ENV USER=container HOME=/home/container
WORKDIR /home/container

COPY --chown=container:container entrypoint.sh /entrypoint.sh

# The panel replaces this with the egg's startup command at run time; the entrypoint expands the
# {{VARIABLE}} placeholders and execs it, which is the convention every Pterodactyl image follows.
CMD ["/bin/bash", "/entrypoint.sh"]
