# Patch changelog -- required reading and required editing

**Any agent or session that adds, edits, regenerates, splits, merges, or
removes a `.patch` file in this folder MUST add a dated entry to the log at
the bottom of this file in the same turn, before considering that work done.**
Not a suggestion -- this file exists because skipping it already broke a real
build. See 2026-10-23 below for exactly what that looked like.

## Why this file exists

`xash3d-h9-patches\xash.bat` re-verifies every patch here against the live
`xash3d-fwgs` source on **every build** (its `:patch` subroutine): it tries
`git apply --reverse --check`, and if that succeeds the patch is "in place"
and gets skipped; if it fails, it tries a forward `git apply` instead and
**stops the entire build** if that also fails.

That means a patch file only has to be *technically correct* once: the moment
its content drifts from reality -- another patch gets inserted before it in
the chain and shifts its line numbers, the file it touches gets rewritten by
a *different*, already-committed change on the `h9` branch, or someone hand-
edits the live source without regenerating the matching `.patch` -- it fails
silently (no error) **until the next full rebuild**, which then breaks for
whoever runs it, with no clue which of the 10+ patches is actually stale.
Reading this log before touching a patch, and writing an entry after, is the
only thing that keeps that lag from turning into exactly this.

Two different kinds of "patch" exist in this project and this file is only
about the first kind:
- **Tracked `.patch` files in this folder** -- re-verified on every build as
  described above. This log covers these.
- **Already-committed changes on the `h9` branch** (`git log --oneline` in
  `xash3d-fwgs`, e.g. `engine-h9-spraywad.patch`, `engine-h9-cloak.patch`'s
  own commit) -- baked into the branch, never re-verified by `xash.bat`,
  and a legitimate way for an earlier session's patch to become permanent.
  `git log` is the source of truth for these, not this file. But a *tracked*
  patch generated before one of these commits landed can go stale against it
  without anyone touching the tracked patch at all -- that is exactly what
  happened to `engine-h9-spraypicker.patch` below.

## Current patches, in `xash.bat` apply order

| # | Patch | Files | Purpose |
|---|-------|-------|---------|
| 1 | `engine-library_suffix.patch` | `3rdparty/library_suffix` | webassembly patch, library suffix part |
| 2 | `engine.patch` | engine-wide | webassembly patch, engine part |
| 3 | `engine-mainui.patch` | `3rdparty/mainui` | webassembly patch, mainui part |
| 4 | `freevgui.patch` | `3rdparty/freevgui` | upstream freevgui |
| 5 | `freevgui-h9-scheme.patch` | `3rdparty/freevgui` | H9's VGUI color scheme |
| 6 | `engine-h9-cloak.patch` | `cl_frame.c`, `cl_main.c`, `cl_view.c`, `client.h` | server-side cloak shown on your own model |
| 7 | `engine-h9-cmdbuf.patch` | `cmd.c` | command buffer holding H9's configs |
| 8 | `engine-h9-chatmouse.patch` | `input.c` | mouse-look stays on while typing in chat |
| 9 | `engine-h9-suddendeath.patch` | `server.h`, `sv_main.c`, `sv_phys.c`, `gl_rmain.c` | sudden-death fog: `h9_fog_*` server cvars into `movevars.fog_settings`, read back client-side |
| 10 | `engine-h9-xray.patch` | `gl_studio.c` | renderfx 64: sudden death's glow shells drawn through walls |
| 11 | `engine-h9-sprguard.patch` | `cl_sprite.c`, `dll_int/cl_game.c` | sprite query family answers 0 on a bad/unloaded HSPRITE instead of crashing |
| 12 | `engine-h9-spraypicker.patch` | `cl_main.c` (`CL_CreateResourceList`) | the bitmap picked from `ts\logos` is remapped into the player's own `tempdecal.wad`, sent under every protocol |
| 13 | `engine-h9-spraycmd.patch` | `cl_main.c` (new `CL_Spray_f`, registered in `CL_InitLocal`) | the `spray` console command: list/equip/unequip from the `ts\logos` shelf. **Applies after #12** -- its hunks assume spraypicker's `CL_CreateResourceList` rewrite already shifted the file |
| 14 | `mainui-h9-gamestartup.patch` | `3rdparty/mainui/BaseMenu.cpp` | menu startup behavior |
| 15 | `engine-h9-userid.patch` | `cl_main.c`, `client.h`, `identification.c` | `cl_h9_userid`: a plain, regenerable client id, salted per destination server via `ID_GetMD5ForAddressEx`, sent as userinfo key `h9_clientid`. **Applies after #12/#13** -- its `CL_InitLocal` registration hunk and connect-packet hunk are numbered against the file state *after* spraypicker+spraycmd. See `docs\CUSTOM_XASH_USERID.txt` |
| 16 | `engine-h9-presence.patch` | `cl_main.c`, `client.h`, `host.c`, `game_launch\game.rc`, `cl_presence.c` (new), `game_launch\havoc9.ico` (new, binary) | Discord Rich Presence: `CL_Presence_Init/Frame/Shutdown/ServerReply`, the exe icon swap to `havoc9.ico`. **Applies after #15** -- its `CL_InitLocal` registration hunk is numbered against the file state *after* userid's own registration line exists. See `docs\RICH_PRESENCE.txt` |
| 17 | `mainui-h9-sprayui.patch` | `3rdparty\mainui\menus\PlayerSetup.cpp` | Customize screen's logo picker: `Reload()` now chains up so it resyncs with console-side `spray`/`spray off`; `WriteNewLogo()` saves a colored pick back to the shelf file itself (`logos\<name>.<ext>`) instead of a now-unread `remapped.*`; a synthetic `none` row lets a player keep a hand-dropped `tempdecal.wad` as-is, visible and selectable instead of only an incidental, non-durable display fallback. Independent of `mainui-h9-gamestartup.patch` -- different function, no ordering dependency between the two |
| 18 | `engine-h9-autoconfig.patch` | `sv_main.c` (`SV_Init`), `sv_init.c` (`SV_ActivateServer`) | `h9_autoconfig` (default on): a second, independent per-map cfg lookup in its own `mapconfigs/<mapname>.cfg` folder, separate from the existing mapper-facing `maps/<mapname>_load.cfg` convention. The exec is queued right after `pfnServerActivate`, so the cfg runs after Metamod/AMXX plugins register their cvars and run their own configs, and overrides them. Server-host-facing, same audience as `engine-h9-userid.patch`. Independent of every other patch in this list -- no ordering dependency |
| 19 | `engine-h9-deltabits.patch` | `net_encode.c` (`Delta_ParseField`, new `Delta_H9WidenIndexField`) | widens `delta.lst`'s model-index fields (`viewmodel`, `modelindex`, `weaponmodel`) to `MAX_MODEL_BITS` and entity-index fields (`aiment`, `event_t.entindex`, `entity_state_t.skin`) to `MAX_ENTITY_BITS` (+1 when signed), `owner` to `MAX_CLIENT_BITS + 1`, when the local `delta.lst` is parsed. The server sends its tables to clients, so clients follow. Never touches `Delta_ParseTableField`: a client must use exactly the widths the server sends. Independent of every other patch -- no ordering dependency |

Not tracked here (already committed on `h9`, see `git log` in `xash3d-fwgs`):
`engine-h9-spraywad.patch` (the classic-HL "whatever's in tempdecal.wad IS
the spray" rewrite of `CL_CreateResourceList` that spraypicker above now
further builds on), and the webassembly/cloak/cmdbuf/chatmouse base commits
referenced by name in some of the rows above.

There's an existing (informal, undocumented-until-now) convention for this
exact situation: `patches\retired\` is where a tracked `.patch` file goes
once its content is permanently committed on `h9` and it no longer needs
`xash.bat`'s per-build reverse-check -- a historical copy, not a delete.
`engine-h9-spraywad.patch` went through exactly this (its commit date and
the file's retirement both land on 2026-10-23), which is how it was found
while investigating the entry below: safe in `git log`, but its retired copy
is currently an orphan in `export\` and the git mirror (robocopy's plain copy
mode never deletes a destination file that's gone from source) -- harmless,
just a stale leftover, not evidence of lost work.

Still currently uncommitted in the live `xash3d-fwgs` working tree, with
**no tracked patch file at all yet**: a menu-background-video struct
addition (`gameui_static_t.menubg_*` in `client.h`). Real, intentional
in-progress work -- not garbage, do not revert it -- but because it isn't
captured as a patch, `git stash`/`git checkout --` on `client.h` will
silently drop it, and a clean rebuild from scratch will not reproduce it.
If you touch this feature, this is a good time to give it its own tracked
patch instead of leaving it as loose working-tree state (presence, just
above, used to be in the exact same spot -- see the 2026-10-23 log entry for
how that one got fixed).

## Entry format

```
### YYYY-MM-DD -- <patch name(s)>
What changed, why, and what you verified (forward `git apply --check`,
reverse `git apply --reverse --check`, and/or a real `xash.bat` run).
```

## Log

### 2026-10-23 -- engine-h9-spraypicker.patch, engine-h9-spraycmd.patch (fixed), engine-h9-userid.patch (new)

A routine build (verifying new, unrelated `cl_h9_userid` engine edits) failed
on `engine-h9-spraypicker.patch` with "does not apply -- resolve it by hand."
Root cause, found by reading the patch's expected old-side content against
the real file: `engine-h9-spraypicker.patch` had gone stale. It was generated
against code that still had the pre-`engine-h9-spraywad.patch` sanitize/remap
logic in `CL_CreateResourceList` (an older `.patch` file's own base), but
`engine-h9-spraywad.patch` is an *already-committed* change on `h9` that
rewrote that same function to the simpler classic-HL form first -- so by the
time anyone ran a full chain rebuild, spraypicker's expected context no
longer existed anywhere. Nobody edited `engine-h9-spraypicker.patch` when
spraywad landed; it just quietly stopped matching reality and nothing
surfaced that until the next full rebuild.

While fixing it, found a second, related problem: `engine-h9-spraycmd.patch`
was a byte-for-byte duplicate of content that had *also* ended up folded into
the real uncommitted spray-picker hand-edit sitting in the working tree (the
`CL_Spray_f` command function and its registration) -- a leftover from before
that command was absorbed into the picker feature, never removed from
`xash.bat`'s chain. Left as-is, it would have either errored the same way or
silently double-applied once spraypicker was fixed.

Fix: regenerated `engine-h9-spraypicker.patch` to contain only the
`CL_CreateResourceList` remap rewrite (matching the current, post-spraywad
baseline), and regenerated `engine-h9-spraycmd.patch` to contain only the
`CL_Spray_f` function + its `Cmd_AddCommand` registration, correctly numbered
to apply *after* the fixed spraypicker. Verified both forward (`git apply
--check`) and reverse (`git apply --reverse --check`) against a from-clean-
HEAD reconstruction, not just against whatever happened to be in the working
tree at the time.

Also added `engine-h9-userid.patch` (new feature, see `docs
\CUSTOM_XASH_USERID.txt`) and registered it at the end of the chain. Its
`CL_InitLocal` registration hunk originally shared an anchor line
(immediately after `cl_ticket_generator`'s own registration) with the
uncommitted, not-yet-patched Discord-presence hook mentioned above -- moved
it to anchor after `cl_autorecord`'s registration instead so it does not
depend on presence's position at all. Verified forward+reverse against a
from-clean-HEAD-plus-spraypicker-plus-spraycmd reconstruction in a scratch
dir, not against hand-derived line arithmetic (got that arithmetic wrong
twice while working this out -- do not trust it, always verify against real
file content or a real `git apply --check`).

### 2026-10-23 -- engine-h9-presence.patch (new)

While adding `docs\CUSTOM_XASH_USERID.txt` to `export.bat`'s doc-copy list,
noticed `docs\RICH_PRESENCE.txt` was already there, describing Discord Rich
Presence as a finished, on-by-default, shipped feature (`ts_richpresence`
cvar, referenced from `ts\userconfig.cfg`). Checked: the feature was real and
fully wired (`CL_Presence_Frame()` called every frame from `host.c`'s
`Host_Frame`, confirmed via grep, not a stub) -- but it existed *only* as
uncommitted working-tree state across `cl_main.c`, `client.h`, `host.c`,
`game_launch\game.rc`, plus the untracked `cl_presence.c` (498 lines) and
`game_launch\havoc9.ico`. Exactly the risk flagged in the entry above: no
tracked patch, so `git stash`/`git checkout --`/a fresh clone would silently
lose a feature documented as already shipped.

Fixed the same way as spraypicker/spraycmd/userid above: captured a clean,
isolated patch via a from-clean-HEAD scratch reconstruction (chain-applying
the existing patches first, then adding just the presence hunks on top,
rather than diffing the live tree directly -- the live tree has userid,
menubg, and presence all mixed into the same two files). Verified forward
(`git apply --check`) and reverse (`git apply --reverse --check`) against
that reconstruction and against the real tree. Registered at the end of the
chain, after `engine-h9-userid.patch` (its `CL_InitLocal` hunk assumes
userid's registration line already exists).

### 2026-10-24 -- mainui-h9-sprayui.patch (temporary diagnostic added)

The user reports the new "none" entry from the 2026-10-23 entry below still
doesn't show in-game, despite every static check passing: the object file
and the linked `menu.dll` are both timestamped after the source edit (genuine
recompile, not a stale/cached build), no second `menu.dll` exists anywhere in
`H9XASH\` (no shadow copy), `cl_logofile` defaults to `"lambda"` which is a
real file (not an unmatched-cvar stuck state), `hideLogos` cannot be forced
true, `AddItem(logo)` is correctly reached, "Customize" has exactly one entry
point in the whole menu tree and it routes to the edited class, and
`CStringVectorModel` is a dynamic `CUtlVector` with no fixed capacity the
real logo files could be filling. Static analysis is exhausted.

Added a temporary `Con_Printf` at the end of `CLogosListModel::Update()`
printing the final row count, matching this project's own established
pattern (`engine-h9-suddendeath.patch`'s fog debug print) for exactly this
situation: get the one missing data point from a live session instead of
guessing further. Remove once the user confirms what it prints.

### 2026-10-23 -- mainui-h9-sprayui.patch (new)

Part of a separate, larger multi-codebase bug-fix pass (seven reported-broken
items across `ts_matchmode.sma`, this engine, RCBot, and waypoint data -- see
that session's plan file for the full account). This entry covers only the
patch-tracking side of the mainui piece.

Three real findings in `PlayerSetup.cpp`'s Customize-screen logo picker, none
previously tracked as a patch at all (this file had zero prior uncommitted
changes before this session -- confirmed via `git diff --stat` before
touching it, so this is a clean, newly-captured patch, not an untangling):
`Reload()` never chained up to `CMenuFramework::Reload()` (unlike sibling
menus), so the picker's selection went stale after a console-side `spray`
command on any visit after the first each session; `WriteNewLogo()` baked a
chosen color into pixels and saved to a fixed `logos\remapped.*`, a filename
the current engine's `CL_CreateResourceList()` no longer reads at all (it
converts `logos\<cl_logofile>.<cl_logoext>` directly) -- so a colored pick
through the menu was silently never used; and there was no menu entry at all
for "keep whatever's already in tempdecal.wad," by design gap rather than
bug, added as a new synthetic `none` catalog row.

Fixed the `WriteNewLogo` contract by writing straight to `filename` (the
same path `GetFullPath` already computes) instead of a separate
`remapped.*` file -- deliberately overwrites the shelf's own bitmap with the
recolored version, since `logos\*.*` is per-player customizable state, not a
read-only catalog. Caught one latent crash risk while adding the `none` row:
`UpdateLogo()` calls `CBMP::LoadFile()` then unconditionally dereferences the
result (`GetBitmapHdr()`) with no null check -- harmless today because every
real catalog entry corresponds to an actual file, but the new `none` entry
has none, so it needed the same `pos < 0`-style early-out the function
already uses, not a fix to the missing null check itself (left alone,
out of scope, every other call site still assumes a real file exists).

Verified forward (`git apply --check`) and reverse (`git apply --reverse
--check`) against the live submodule tree; confirmed the diff is exactly
these edits (`git diff --stat`, 5 hunks, no surrounding contamination)
before capturing it.

**Open suspicion, not yet confirmed:** the user raised that the sudden-death
green fog bug (investigated at length earlier, root cause never confirmed --
see session history) may be the same class of problem: a tracked patch
(`engine-h9-suddendeath.patch`, touches `server.h`, `sv_main.c`, `sv_phys.c`,
`gl_rmain.c`) silently going stale or incomplete relative to some other
change, rather than the plugin-side logic being wrong (which was already
proven correct by direct tracing). As of this entry, `engine-h9-suddendeath
.patch` reverse-checks cleanly ("in place") against the current tree, so it
is *not* currently stale in the way spraypicker was -- but that only proves
its tracked hunks match current content, not that those hunks still capture
the complete original feature. Worth a dedicated look before resuming that
investigation: diff the patch's own hunks against what the fog feature
actually needs to do, rather than re-tracing the plugin side again.

### 2026-10-26 -- engine-h9-autoconfig.patch (added earlier this day, now revised), engine-h9-deltabits.patch (new)

`engine-h9-autoconfig.patch` was added earlier on 2026-10-26 without a log
entry; this entry covers both its addition and today's revision. As first
written it queued `exec mapconfigs/<map>.cfg` in `SV_SpawnServer`, beside
`maps/<map>_load.cfg`. That ran too early: reTS's `CWorld::Precache` ->
`InstallGameRules` does `exec game.cfg` + `SERVER_EXECUTE` during worldspawn
(`reTS\dlls\gamerules.cpp:220-221`), flushing the whole buffer -- mapconfig
included -- before `pfnServerActivate`, which is where Metamod/AMXX run
`plugin_init`/`plugin_cfg` (AMXMODX `meta_api.cpp:681-684`). A cfg setting a
plugin cvar (`tsm_no_weapons 1`) hit "Unknown command", and the plugins'
global configs then ran after it and won. The exec now sits right after
`pfnServerActivate` in `SV_ActivateServer`, using `sv.name`. The `sv_main.c`
hunk only changed its comment and cvar help text.

Procedure (editing the .patch alone would have stopped the build: the old
hunks were in the tree, so neither the reverse check nor the forward apply
would succeed): reverted the old patch from the tree with `git apply
--reverse`, confirmed `sv_init.c` was back at HEAD and `sv_main.c` carried
only `engine-h9-suddendeath.patch`'s `SV_H9FogCvars();` line, made the edits,
then regenerated from `git diff` with suddendeath's hunk removed from the
`sv_main.c` section and no `diff --git`/`index` lines (the format every other
tracked patch uses).

`engine-h9-deltabits.patch` is new. `delta.lst` (TS/reTS ship the same file)
sends `viewmodel`, `modelindex` and `weaponmodel` in 10 bits, and
`Delta_ClampIntegerField` silently pins any larger value to 1023 (the warning
is `_DEBUG` only). `h9_tsrp_hive` reserves model slots 1..873 for its own
brush models before the game precaches anything, so every model past #1023 --
non-primary weapons and ~359 props/sprites -- drew as model #1023. The patch
raises those fields to `MAX_MODEL_BITS`, entity-index fields to
`MAX_ENTITY_BITS` (+1 signed), and `owner` to `MAX_CLIENT_BITS + 1`, at parse
time in `Delta_ParseField`, printing one console line per widened field per
run. Nothing else in the chain touches `net_encode.c`.

Verified: both patches reverse-check in place; round trip for each (`git
apply --reverse`, file back at HEAD, `git apply --check`, `git apply`, in
place again); then a reverse check of every patch in `xash.bat`'s order --
the four webassembly patches and all 19 here -- all in place. Registered
`engine-h9-deltabits.patch` in `xash.bat` after autoconfig, and added both
to its ENGINE.txt list and the `xash.dll` description.
