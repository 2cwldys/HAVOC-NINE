# HAVOC 9 (TS Match Mode / H9XASH) -- Project Context

## This file is not the description. Two files at the repo root are.

- `CONTEXT.md` -- what the components are and which folder holds each one.
- `CLAUDE.md` -- the working rules: the patch chain, web-client and Linux
  parity, licences, cvar documentation, the build lock.

Both are read straight from the repo root and put in front of every query
(`h9context.js`), so you already have them above this. This file carries only
what they assume you know. Where it disagrees with them, they win: they are
maintained, this is a summary and can drift.

## What it is

A Half-Life 1 / GoldSrc project built on The Specialists 3.0: a set of AMX Mod X
game-mode plugins, a patched Xash3D-FWGS engine, a rebuilt game library and
client library, a WebAssembly client, a native Linux i386 server, and havoc9.org
with a server list and an updater.

## The languages, by weight

Measured in this repo, biggest hand-written body first:

- **AMX Mod X Pawn (`.sma`)** -- the bulk of the gameplay code. H9's own are the
  22 in `src\`, and `src\ts_matchmode.sma` alone is 32,895 lines. Shared headers
  in `src\include\`. Most questions are about these.
  The 185 `.sma` under `AMXMODX\plugins\` are the AMX Mod X distribution's own,
  and the copies under `H9XASH\ts\addons\`, `ts\addons\` and
  `reTS\release_binaries\` are build output. Do not "fix" any of those.
- **C / C++**, in two different shapes. Engine changes are **not** source files:
  they are 63 tracked `.patch` files in `xash3d-h9-patches\patches\`. The game
  and client libraries are ordinary C++ under `reTS\dlls\` and `reTS\cl_dll\`.
  Vendored C/C++ also sits in `metamod-r\`, `AMXMODX\modules\` and
  `EntMod4\src\`.
- **PowerShell (`.ps1`)** -- the release machinery, 13 files at the repo root:
  `ship.ps1`, `deploy-vps.ps1`, `stage-h9xash.ps1`, `build-linux.ps1`,
  `verify-release.ps1`, `ship-status.ps1`.
- **Node (`.mjs`, `.js`)** -- `tools\*.mjs` is the pipelines and checkers
  (`webclient-sync.mjs`, `release-prepare.mjs`, `preset-check.mjs`,
  `release-check.mjs`). Server-side `.js` lives in `h9web\`, `p2p\` and
  `havoc9.org\`.
- **Python (`.py`)** -- `tools\h9chain\` (the patch-chain harness),
  `tools\gen_cvar_index.py` (writes `CVARS.md`), `vps\windows\delta.py` (the
  deploy's delta), `reTS\scripts\`.

A local model is most useful here on the PowerShell, Node, Python and docs, and
least useful on the Pawn and the engine patches. `MEMORY.md`, which is also in
front of you, says why.

## Two trees, and this is the generated one

The master tree is the source of truth; this git copy is what the ZIPs, the web
client and the site are built from. What follows from that is the most common way
work gets lost here:

- This copy has **no** `build.bat` and no `export.bat`; both live in the master
  only. `release-prepare.mjs` run from here refuses for exactly that reason.
- Paths that `export.bat` fills -- `H9XASH\` above all, and `H9XASH-linux\` --
  are generated output. An edit there is overwritten by the next export.
- So plugin and reTS source edits belong in the master, while `ship.ps1` and the
  deploy scripts run from here. If you are not sure which tree a file should be
  edited in, say so rather than guessing.

## Rules any answer must already obey

Each of these has broken a build.

1. **Never hand-edit anything under `xash3d-fwgs`.** It is a submodule pinned to
   pristine upstream FWGS. Every H9 engine change is a `.patch` file, and
   `PATCH_CHANGELOG.md` is read before and written after touching one.
2. **ASCII only.** No em dashes or other non-ASCII punctuation in files or
   commands -- use `--`.
3. **No `git commit` without the owner's explicit permission for that specific
   commit.** An approved plan is not that permission. Never push.
4. **No backup copies of text files** -- git is the backup. Only a binary being
   replaced may keep one, as `<file>.bak_<description>`.
5. **One heavy job at a time**, behind the heavy-job lock. Never create that lock
   yourself to be safe, and never take an existing one over.
6. **Every new cvar is documented in the same piece of work**: its
   `docs\COMMANDS.txt` row and its config comment, then
   `python tools\gen_cvar_index.py` writes `CVARS.md`.
7. **Parity comes last, once.** `webclient-sync.mjs` and `build-linux.cmd` run
   once at the end of a batch, not once per feature.

## Tools instead of guesses

This bridge registers tools that read the repo rather than asking a model:

- `h9_rules <path>` -- the rules for the file you are about to edit. Ask it
  before changing anything under `H9XASH`, `xash3d-fwgs`, the patches, a `.sma`,
  `reTS`, the site, or a `packaging*.ini`.
- `h9_doc <topic>` -- finds and reads the right one of the 67 documents in
  `docs\`. `topic='list'` names them all.
- `h9_find <kind> <name>` -- where a cvar, command, plugin, patch, document or
  map actually is.

The SMAK MCP server is registered beside this one for model, map, wad and sprite
work. Use it rather than reasoning about binary formats.
