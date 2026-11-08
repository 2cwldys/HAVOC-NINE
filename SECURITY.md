# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue or on Discord.

- Use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**.
- If that is not available to you, open an issue that says only "I have a security report" (no details) and a maintainer
  will arrange a private channel.

Include what you found, how to reproduce it, and what it lets an attacker do. Please give a reasonable time to fix
before telling anyone else.

### In scope

- The web back end (`h9web/`), the server list bot (`serverlist-bot/`) and the public site (`havoc9.org/`).
- The game plugins and engine patches in this repository (`AMXMODX/`, `src/`, `xash3d-h9-patches/`, `reTS/`).
- Anything that exposes a player's id, a server key, a password or another player's data.

### Out of scope

- Findings that need a modified game client plus an unsupported third-party plugin set (report them, but they are low priority).
- Denial of service by raw traffic volume.
- Third-party code kept as-is (Metamod-R, AMX Mod X, mbedTLS, Apollo RP): please report those upstream as well.

## Secrets

No secret belongs in this repository. Keys, tokens and passwords live in files that `.gitignore` excludes
(`secrets.json`, `data.key`, `serverlist.cfg`, `h9_presence.cfg`, `.env`). If you find one in a commit, report it
privately so it can be rotated.

## Modified binaries

Chained patch files are supplemented with each modified DLL version, source code available at: https://github.com/2cwldys/HAVOC-NINE/
Works not made by me or the XASH3D FWGS team does not reflect either.
This project also contains decompiled and recompiled TS 3.0 source code, which is considered experimental work.
Use at your own risk.

## TS 3.0 only

If you are for any reason encountering bugs and/or disapprove of UI or dll patching elements, you may use `restore_originals.bat`.

STEAM LEGACY BRANCH ONLY
