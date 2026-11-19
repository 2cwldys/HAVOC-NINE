# lmstudio-mcp

Bridges Claude Code to a local [LM Studio](https://lmstudio.ai) model, and adds HAVOC 9's own repo
tools. Both can run at once: Claude handles the reasoning, the local model handles fast drafts and
offline work, and the H9 tools answer from this repository's files instead of either model guessing.

`../README.md` is the overview and says what the installer downloads and under whose terms. Read
that first.

## Quick start

**Windows:** double-click `install.cmd`
**Linux / macOS:** `chmod +x install.sh && ./install.sh`

It runs `npm install`, then ASKS before downloading LM Studio from lmstudio.ai (third-party
software, its own [terms](https://lmstudio.ai/app-terms)), then offers a model, an optional
login-time startup task, and starts the server. Decline the download and everything except the
model server still works.

Then reload your editor window and type `/mcp` in Claude Code: `lmstudio` and `smak` should both be
listed.

## Terminal chat, no Claude needed

```
chat.cmd              Windows
./chat.sh             Linux / macOS
npm run chat          from this folder
```

Loads the same project context. Inside: `/clear`, `/context` (shows exactly what the model was
given), `/model`, `/exit`.

## Every session after setup

If you took the auto-startup option, nothing. Otherwise start the server before opening the project:
`start-server.cmd`, or `./start-server.sh`.

## Scripts

| Script | What it does |
|---|---|
| `install.cmd` / `.sh` | first-time setup; asks before each download |
| `start-server.cmd` / `.sh` | start the LM Studio API server |
| `launch-lmstudio.cmd` / `.sh` | start it via the CLI, or open the GUI if the CLI is not there |
| `stop-server.cmd` / `.sh` | stop the server |
| `stop-all-models.cmd` / `.sh` | unload every loaded model (frees VRAM) |
| `chat.cmd` / `.sh` | terminal chat with the local model |
| `clear-context.cmd` / `.sh` | wipe `context/CURRENT.md` |
| `purge-models.cmd` / `.sh` | delete downloaded models |
| `open-models-folder.cmd` | open where the models are kept |
| `monitor-server.cmd` | watch the server's state |
| `remove-startup.cmd` / `.sh` | remove the login-time startup task |
| `cleanup-links.cmd` / `.sh` | remove the symlinks the model-folder redirect makes |

npm scripts from this folder: `npm run setup` (re-pick the model, rewrite `.env`), `npm run check`
(health check of the whole chain), `npm run chat`.

## The context system

Everything below is put in front of every query, local model and Claude alike:

| Source | Shared via git? | What it is |
|---|---|---|
| `../../CONTEXT.md` | yes (the repo's own) | the map of the project, read from the repo root, never copied |
| `../../CLAUDE.md` | yes (the repo's own) | the working rules; the head of it, to a character budget |
| `context/PROJECT.md` | yes | what those two assume you already know: the languages, the two trees |
| `context/MEMORY.md` | yes | where a local model is and is not reliable in this codebase |
| `context/SOLUTIONS.md` | yes | past non-obvious fixes; it grows |
| `context/CURRENT.md` | **no**, gitignored | what you are working on right now, per machine |

Reading the root `CONTEXT.md` and `CLAUDE.md` in place is deliberate: a copy of the project's rules
under `context/` would drift inside a week and then quietly teach the model things that stopped
being true. `CLAUDE.md` is about 26 KB and goes in front of every query, so it is cut to a budget --
`H9_CLAUDE_MD_CHARS` in `.env` changes it, and `0` leaves it out.

## Tools

H9's own, which read the repo and never call a model:

| Tool | What it does |
|---|---|
| `h9_rules <path>` | the rules for the file you are about to edit, and why the obvious edit may be the wrong one |
| `h9_doc <topic>` | finds and reads the right one of the 67 documents in `docs/`; `topic='list'` names them all |
| `h9_find <kind> <name>` | where a cvar, command, plugin, patch, document or map actually is |

The local model:

| Tool | What it does |
|---|---|
| `query_local_model` | a general query, context already attached |
| `review_code` | a review with a language-aware prompt; pass `language` |
| `log_solution` | append a real finding to `SOLUTIONS.md` (shared and committed) |
| `update_working_context` | append to `CURRENT.md` (yours, not committed) |

Model, map, wad and sprite work is the separate `smak` server, registered in
`../../.claude/settings.json` with `--no-run`. Use it rather than reasoning about binary formats.

## Switching models

Edit `MODEL_NAME` in `.env` to match what is loaded in LM Studio, then reopen Claude Code. Or run
`npm run setup` to pick from what you have.

## Troubleshooting

| Problem | Fix |
|---|---|
| "LM Studio not reachable" | `start-server.cmd`, or `lms server start` |
| Wrong model answering | `MODEL_NAME` in `.env` must match the model loaded in LM Studio |
| `lmstudio` missing in Claude Code | run the installer (or `npm install`), then reload the editor window |
| `smak` missing or failed | the SMAK submodule is empty: `git submodule update --init SMAK` |
| `h9_*` tools say "not inside the repo" | this folder was moved; it expects to be at `<repo>/agents/lmstudio-mcp/` |
| Port conflict | change the port in LM Studio, then `LM_STUDIO_URL` in `.env` |

`npm run check` diagnoses all of the above at once and names what is missing.
