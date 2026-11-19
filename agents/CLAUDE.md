# Agent Instructions -- the local model and the H9 tools

Two MCP servers are registered for this repo in `.claude/settings.json`:

- **`lmstudio`** -- a local model running in LM Studio, plus H9's own repo tools.
- **`smak`** -- the SMAK submodule's own server for models, maps, wads and sprites, started
  `--no-run` so it only lists, describes, checks and draws.

The repo root's `CLAUDE.md` is the authority on everything about HAVOC 9 itself; this file is only
about dividing work between the agents. Where they disagree, the root file wins.

## Reach for a tool before you reach for the model

This is the part that is specific to this codebase. Three tools answer from the repository's own
files and cannot invent anything, and they are nearly always the right first call:

| Tool | Use it when |
|---|---|
| `h9_rules <path>` | **before editing anything.** Especially under `H9XASH/`, `xash3d-fwgs/`, `xash3d-h9-patches/patches/`, a `.sma`, `reTS/`, `h9web/`, or a `packaging*.ini` -- those are the places where the obvious edit is the wrong edit and the work is silently lost or the next build breaks |
| `h9_doc <topic>` | the answer is written down. 67 documents in `docs/` plus `CVARS.md`; `topic='list'` names them all. Prefer this to reasoning about how the release, the patch chain or the preset system works |
| `h9_find <kind> <name>` | where a cvar, command, plugin, patch, document or map actually lives. Bounded searches -- a recursive grep of this repo times out |

If you are about to tell the user how something works in this project, check with `h9_doc` first.
The rules here are unusual and written down, and a confident wrong answer about the patch chain or
the join gate costs a build.

## Division of labour

**This only applies when Claude Code is active.** If someone is in the terminal chat
(`chat.cmd` / `chat.js`) with no Claude Code in the session, the local model is the primary agent:
no seniority, no oversight, just do the best job it can on its own.

**With Claude Code active:**

Claude handles architecture, cross-file reasoning, anything needing the whole picture, the final
review of what the local model produced, and stepping in the moment an answer looks confused.

Delegate to the local model: boilerplate and repetitive edits, first drafts of simple functions,
reviews of individual snippets, quick syntax questions, and parallel work -- while you reason about
the hard part, have it draft the easy sibling instead of making the user wait for one step at a
time.

**The rule:** quality stays with Claude; volume goes to the local model. If its output is wrong,
incomplete or confused, take over at once rather than patching it.

## Where the local model is NOT good enough here

Read `lmstudio-mcp/context/MEMORY.md` for the full version. The short form, because it changes what
you should delegate:

- **AMX Mod X Pawn (`src/*.sma`) -- do not delegate.** There is almost no Pawn in any model's
  training data, so it produces confident natives that do not exist and argument orders that are
  wrong. Every native, forward and `register_*` call it writes is unverified until you find it in
  the `AMXMODX/` includes or already in use in `src/`. This is the biggest body of code in the repo
  and the worst thing to hand over.
- **Engine changes -- do not delegate.** A change is a `.patch` in a verified chain plus a dated
  `PATCH_CHANGELOG.md` entry, not an edit to a `.c` file. Asked to "change the engine", a model
  writes C and presents it as the change. Use `h9_rules` and `tools/chain.cmd` instead, and never
  let a model do line-number arithmetic across hunks.
- **Anything that decides what ships** -- `ship.ps1`, `deploy-vps.ps1`, `build.bat`, `export.bat`,
  the `packaging*.ini` switches. It does not know these rules and they are where real damage
  happens.

Good to delegate: PowerShell, Node, Python, `.cfg` and docs. That is most of the machinery around
the game, and it is a real saving.

## `query_local_model` and `review_code`

Project context is already attached to both -- the repo's `CONTEXT.md` and `CLAUDE.md`, plus
`PROJECT.md`, `MEMORY.md`, `CURRENT.md` and `SOLUTIONS.md` -- so do not re-explain the codebase in
the prompt. Say what you want, and give it the code.

`review_code` is worth a call after writing any non-trivial function in a language the model is good
at, before reporting done. Pass `language` so it gets the right reviewer prompt.

## Working session context

`update_working_context` writes `context/CURRENT.md`, which goes into every local query afterwards.
Call it when the focus shifts to a different area so the model stops guessing at what you are doing.
It is per-machine and not committed; `clear-context.cmd` empties it.

## `log_solution` -- shared, committed, so be strict

It appends to `context/SOLUTIONS.md`, which **is** committed and read by everyone afterwards. Log a
real non-obvious finding: a root cause that took real work, something that surprised both of you,
the thing you wish had been written down three hours earlier. Do not log routine fixes, typos, or
anything a search would have answered.

Scope test: *does knowing this make future work on HAVOC 9 easier?* A fix found while working on
something unrelated still counts if the answer helps here.

ASCII only, `--` not an em dash -- the same rule as the rest of the repo.

An engine patch change needs its own dated entry in
`xash3d-h9-patches/patches/PATCH_CHANGELOG.md` as well. `SOLUTIONS.md` does not replace that, and
that one is required rather than optional.
