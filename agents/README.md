# Agents

Local AI tooling for HAVOC 9. Optional: nothing here is needed to build, host or play the game, and
the rest of the repository does not depend on it. It exists so that a contributor can run their own
model on their own machine, privately, beside Claude Code -- and so that whichever model is working
has the project's real rules in front of it instead of guessing at them.

Ported from the SpacebuildRP-Helix project's `agents/` folder, retooled for this codebase.

## What is in here

| Thing | What it is |
|---|---|
| `lmstudio-mcp/` | the bridge: an MCP server that hands tool calls to a local model running in LM Studio, a terminal chat against the same model, and the installer and server scripts around both |
| `lmstudio-mcp/h9tools.js` | H9's own MCP tools. They read this repo and never call a model, so they cannot invent an answer: `h9_rules`, `h9_doc`, `h9_find` |
| `lmstudio-mcp/h9context.js` | puts the repo's own `CONTEXT.md` and `CLAUDE.md` in front of every query, read from the root rather than copied, so there is one set of rules and it cannot drift |
| `lmstudio-mcp/context/` | `PROJECT.md` (what `CONTEXT.md` assumes you know), `MEMORY.md` (where a local model is unreliable here), `SOLUTIONS.md` (past fixes, and it grows) |
| `CLAUDE.md` | who does what when both Claude Code and a local model are in the session |
| `SETUP.txt` | the long-form walkthrough |

## Quick start

**Windows:** double-click `lmstudio-mcp/install.cmd`
**Linux / macOS:** `chmod +x lmstudio-mcp/install.sh && ./lmstudio-mcp/install.sh`

Read the next section first. The installer downloads third-party software.

## What the installer does, before you run it

It is a convenience script, and it reaches the internet. In order, it:

1. runs `npm install` in `lmstudio-mcp/` -- five direct dependencies, 144 packages in all, every one
   MIT, ISC, BSD or Apache-2.0 (`THIRD_PARTY_LICENSES/lmstudio-mcp-NOTICE.txt` lists them);
2. offers to download and install **LM Studio** from <https://lmstudio.ai/>;
3. offers to let you pick a model, which it downloads **inside LM Studio** -- these are 3 to 16 GB;
4. offers to start the LM Studio server automatically when you log in;
5. starts the server.

**LM Studio is not part of this repository and is not distributed with it.** If you accept that
download you are using LM Studio under its own
**[application terms of service](https://lmstudio.ai/app-terms)**, which are between you and its
makers. Each model you then download carries its own licence as well, and several are research-only
or not free for commercial use -- the names in `.env.example` are suggestions, not endorsements.

Say no to any of it and nothing else breaks. If you would rather not run the installer at all, you
can install LM Studio yourself, copy `.env.example` to `.env`, and run `npm install` by hand.

## How it fits together

```
You --> Claude Code --> architecture, cross-file reasoning, the final say
           |
           +--> lmstudio MCP --> your local model: drafts, boilerplate, reviews, parallel work
           |
           +--> h9_rules / h9_doc / h9_find --> this repo's own files: the rules, the docs, the paths
           |
           +--> smak MCP --> models, maps, wads and sprites (the SMAK submodule's own server)
```

`.claude/settings.json` in the repo root registers two MCP servers, so both appear in Claude Code
with no configuration:

- **`lmstudio`** -- `agents/lmstudio-mcp/index.js`. Until you run the installer it will show as
  unavailable and say why in one line; that is expected and harmless. Delete the entry if you never
  want it.
- **`smak`** -- `SMAK/cli/mcp/server.mjs`, the map and model kit's own server, started with
  `--no-run`. That flag matters: with `run` enabled the server executes whatever script a model
  sends, as you, unsandboxed. Without it the server only lists, describes, checks and draws. If you
  want `run`, take the flag out in your own checkout and know what you are enabling.
  SMAK is a git submodule -- a clone made without `--recurse-submodules` leaves it empty and this
  server will not start. `git submodule update --init SMAK` fixes it.

## Using it

From Claude Code, the tools are just there. Ask it to delegate -- "draft the PowerShell for this
while you work out the engine side" -- or ask it for the rules before an edit:

    h9_rules  xash3d-fwgs/engine/client/cl_main.c
    h9_doc    release
    h9_find   cvar h9_customweapons

Without Claude Code, `lmstudio-mcp/chat.cmd` (or `chat.sh`) is a terminal chat against the same
model with the same project context loaded. `/context` shows exactly what it was given.

`check.cmd` / `node check.js` says whether the server, the model and the registration are all in
place, and names what is not.

## What to expect of a local model here

Be realistic, and read `context/MEMORY.md` before trusting an answer. A 7B coder model is genuinely
useful on this project's PowerShell, Node, Python and prose. It is **not** reliable on AMX Mod X
Pawn -- there is almost no Pawn in any model's training data, so it produces confident natives that
do not exist -- nor on the engine, where a change is a patch in a verified chain rather than an edit
to a `.c` file. Those are the two biggest bodies of code in the repo, so the honest summary is: good
for the scaffolding around the game, poor at the game itself.

That is also why `h9_rules`, `h9_doc` and `h9_find` exist. The rules are written down; a tool that
reads them beats a model that guesses at them.

## Contributing through it

- `log_solution` appends to `context/SOLUTIONS.md`, which **is** committed and shared. Use it for
  real non-obvious findings, not for notes to yourself.
- `update_working_context` writes `context/CURRENT.md`, which is **not** committed -- it is yours,
  per machine, and `clear-context.cmd` empties it.
- `PROJECT.md` and `MEMORY.md` are shared: correct them when they go stale rather than working
  around them.
- ASCII only, like the rest of the repo, and `--` instead of an em dash. A model will reach for one
  by default; check before you paste.

## Licensing

`agents/` is H9's own code under the GPLv3 (`agents/LICENSE-GPLV3.txt`). The npm packages and LM
Studio are covered by `THIRD_PARTY_LICENSES/lmstudio-mcp-NOTICE.txt` and the row for it in
`LICENSE.md`.
