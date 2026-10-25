# HAVOC9 — AI Context Brief

Hand this file to an AI coding agent (Claude, OpenCode, Freebuff, Cursor, etc.) and tell it:

> Study this document fully, then work inside the HAVOC-NINE repository with these rules.

---

## What this project is

**HAVOC 9** is a highly modified version of **The Specialists 3.0** (a Half-Life 1 / GoldSrc multiplayer mod). It adds mapped progressive siege and team elimination mechanics themed in the Havoc Nine universe (dystopian future, Middlesea Republic, Ministry of Defense).

- Site: https://havoc9.org  
- Repo: https://github.com/2cwldys/HAVOC-NINE  
- Discord: https://discord.gg/b76pqqVsNY  

You **must** own a legal copy of Half-Life. The project does not ship Valve content.

License: GPLv3 (nested tools may be GPLv2 / MIT). Non-commercial fan project. See `NON_COMMERCIAL.MD` and `SECURITY.MD` in the repo.

---

## Core components

| Folder / Area | Purpose |
|---|---|
| `ts/` / Match Mode plugins | AMX Mod X plugins (`ts_matchmode`, etc.) that implement siege / team elimination |
| `H9XASH/` | Custom Xash3D-based client + server layout |
| `xash3d-fwgs` + `xash3d-h9-patches` | Engine source and H9-specific patches |
| `SMAK/` | **Studio Model Agent Kit** — AI-driven GoldSrc `.mdl` and map tooling |
| `AMXMODX/` | AMX Mod X with H9 edits |
| `rcbot` / `rcbot-patch` | Bot support with team logic |
| `discord-bot` / `serverlist-bot` / `presence` | Community tooling |
| `docs/` | Human and agent documentation |

Build pipeline lives in the developer’s local `TSM` tree and is mirrored into the repo via `export.bat`. See the repo’s `CONTEXT.md` and `CLAUDE.md` for the full pipeline rules.

---

## SMAK — Studio Model Agent Kit

SMAK (inside `SMAK/`) is a Node.js toolkit built so an AI agent can create and edit GoldSrc models (`.mdl`) and maps without Blender / studiomdl.

**What it can do:**
- Extract / replace / recolour textures
- Replace weapon shapes inside existing viewmodels while keeping hands, skeleton, animations
- Create new prop / pickup models
- Edit animations and sound events
- Import .fbx / .glb / .obj
- Check models against GoldSrc / Xash limits
- Render preview images so the agent can verify its own work
- Map reading, checking, generation, and walk-testing

**How an agent should use it:**
1. Read `SMAK/AGENTS.md` and `SMAK/CLAUDE.md` first.
2. Work from the kit folder or point the agent at it.
3. Prefer small steps (texture change first) before large shape replacements.
4. Always keep originals. Output new `.mdl` files for the human to test in-game.

Key entry: `node bin/smak.mjs help`

---

## Standing rules for any AI agent on this project

Taken from the project’s `CLAUDE.md` (adapt to your agent):

### Git
- Do **not** commit, amend, rebase, push, or move branches unless the human explicitly asks.
- Show diffs / patches and wait for approval.

### Editing
- Change only what was asked. Do not “clean up” surrounding code.
- Edit the **source of truth**, never generated folders (`export/`, built H9XASH copies, etc.).
- Prefer exact-string replace that respects the file’s own line endings (many TS files are CRLF).

### Builds
- TS plugins are built with `build.bat` only.
- Engine work goes through `xash.bat`.
- Every shipping DLL should carry a matching `.patch` history file.
- Never ship or print secrets (Discord tokens, etc.).

### Game content
- Never launch or kill the game/server while the user may be playing.
- Never include Valve proprietary assets in the repo.

### Diagnosis
- Trace the code path. Do not stall on “did you recompile?”.
- Verify in proportion to the question.

---

## Recommended tools for contributors

- **Claude** — https://claude.ai/  
- **OpenCode** — https://opencode.ai/  
- **Freebuff** — https://freebuff.com/  

These work well with the SMAK kit and the project’s `AGENTS.md` / `CLAUDE.md` style briefing files.

---

## Roleplay / community expectations (for context)

On the roleplay servers the expectation is **realism** and the ability to be **humble in defeat**. Stay in character, respect the world, and take losses gracefully. Clique culture is discouraged.

---

## Quick start for a new agent session

1. Clone https://github.com/2cwldys/HAVOC-NINE  
2. Read this file + the repo’s `CONTEXT.md` + `CLAUDE.md`  
3. If working on models/maps, also read `SMAK/AGENTS.md`  
4. Ask the human what to change. Propose a plan. Wait for approval before large edits or any git operations.  
5. After changes, tell the human exactly what to rebuild / restart.

---

*Generated for havoc9.org — Join the Team page. Keep this brief up to date with the repo’s own CONTEXT.md and CLAUDE.md.*
