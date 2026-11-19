# Persistent Memory -- HAVOC 9 Local Model Context

Where a 7B-class local model is and is not reliable in THIS codebase. The default configured model
is `qwen2.5-coder-7b-instruct` (`.env.example`).

It is loaded alongside PROJECT.md and SOLUTIONS.md. (In the Helix original this file said the same
and no loader ever read it -- `loadContext` in `index.js` and `chat.js` read PROJECT, CURRENT and
SOLUTIONS only. Both now read this file; if you move it, teach both loaders the new name.)

---

## Local Model Trust Level

Use it for drafts, boilerplate, scaffolding and parallel work. Have Claude or a human review
anything before it goes in. In this repo the gap between "looks right" and "is right" is unusually
wide, for reasons specific to the languages here.

**Good for:** PowerShell, Node and Python scripts; docs and `.txt` prose; config and `.cfg`
scaffolding; first drafts; explaining code it has been shown; naming and structure; repetitive
edits.

**Not reliable for:** AMX Mod X Pawn, engine patches, anything that decides what ships.

### 1. Pawn has almost no training corpus, so invented natives look plausible

`src\*.sma` is AMX Mod X Pawn, and `src\ts_matchmode.sma` alone is 32,895 lines. There is very
little Pawn in any model's training data, so the failure mode is not a refusal -- it is a
confident, well-formatted native that does not exist, or one whose argument order is wrong. Treat
every native, forward and `register_*` call as unverified until it is found in the `AMXMODX\`
includes or already used in `src\`. This is the single biggest risk here.

### 2. Engine changes are patch files in a verified chain, not free edits

`xash3d-fwgs` is a pristine-upstream submodule; every H9 engine change is one of the 63 `.patch`
files in `xash3d-h9-patches\patches\`, and `xash.bat` re-verifies every one on every build. A model
asked to "change the engine" will write C and present it as the change. That is not a deliverable
here. Patches also have apply-ORDER dependencies, and doing line-number arithmetic across hunks by
hand is explicitly warned against -- `tools\h9chain` exists for exactly that. Use the `h9_rules`
tool on the path first.

### 3. H9XASH is generated output -- never edited directly

`H9XASH\` is the built client, written by `export.bat` from the master tree; `H9XASH-linux\` is
build output too. A model shown a file there will happily edit it, and the edit is gone at the next
export. The same trap in reverse: `export.bat` copies with `robocopy /XO`, so a file NEWER in the
git copy is kept and a stale file can survive an export.

### 4. ASCII only -- and the model will reach for an em dash

Non-ASCII punctuation is banned in files and commands here; use `--`. Models produce em dashes,
curly quotes and ellipses by default. Check output before pasting it into a file. (The ported
bridge itself had 199 of them, including one in the template that writes every `SOLUTIONS.md`
entry.)

### 5. CRLF files, and files whose line endings are load-bearing

`.gitattributes` marks `*.patch` as `-text`, because patches are applied with `git apply` and keep
the exact endings they were made with -- a normal Windows checkout turned them CRLF and they
stopped applying. `*.sh` is `text eol=lf`, because a CRLF shebang makes Linux look for an
interpreter named `bash` plus a carriage return, which stopped the native Linux server. Edit a CRLF
file with an exact byte replace, never `sed -i`. A model that rewrites a whole file normalises the
endings silently.

### 6. It does not know the release rules, and they are where damage happens

Commits need explicit permission per commit, nothing is ever pushed, the heavy-job lock must never
be created by hand or taken over, and parity runs once per batch. None of it is inferable from the
code. Never let a local model's output drive `ship.ps1`, `deploy-vps.ps1`, `build.bat` or
`export.bat`.

---

## Practical rule

Ask the local model for the shape, then verify every API call, every path and every line ending
against the real source before anything is built or committed. Its wrong answers in this repo are
fluent, not obviously broken.

Two shortcuts that beat asking it: `h9_rules <path>` for the rules on a file, and
`h9_doc <topic>` / `h9_find <kind> <name>` for what is actually written down. Those read the repo
and cannot invent an answer.
