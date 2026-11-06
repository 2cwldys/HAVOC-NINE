# Project context

TS Match Mode / H9XASH. Source of truth: this directory (`D:\Downloads\TSM`).
Git mirror at `D:\GIT Storage\ts_h9_team_elimination` (never edit directly).
Live install at `D:\SteamLibrary\steamapps\common\Half-Life`.

See `CLAUDE.md` in this same directory for the full working rules. The one
most worth repeating here: **check the patch chain before adding engine work
or hand-editing anything under `xash3d-fwgs`.**
`xash3d-h9-patches\patches\PATCH_CHANGELOG.md` is the required-reading,
required-editing log of every tracked `.patch` file -- what it does, what it
depends on applying after, and a dated history of what's changed and why.
Read it before touching a patch; add an entry to it in the same turn you
touch one. Skipping this is exactly how `engine-h9-spraypicker.patch` went
stale and broke a build on 2026-10-23 without anyone noticing until the next
full rebuild -- see that file's log for the full account, including an open
suspicion that the still-unresolved sudden-death fog bug may be the same
class of problem.

## Components

- `ts_matchmode.sma` -- the AMX Mod X plugin, ~19000+ lines. Build/deploy via
  `build.bat`.
- `xash3d-fwgs` -- the engine fork, branch `h9`. Rebuilt via
  `xash3d-h9-patches\xash.bat`, which replays the patch chain above.
- `H9XASH` -- the built client, propagated via `export.bat`.
- `serverlist-bot` -- standalone server-list/heartbeat service; see
  `docs\NETWORKING.txt`.
- `tools\assault-spawns` -- Node.js library and command line that places an
  Assault map's respawn sets (the forward spawn points of each capture point),
  proposes capture points over a map's several floors (`--suggest --levels`) and flag
  pads for a Capture the Flag map (`--pads`)
  from the map's own BSP, with a plan picture and tests. Read
  `docs\ai_context\ASSAULT_SPAWNS.txt` before placing, moving or judging
  Assault spawns on any map.
- The release gate -- a server holds its players to one HAVOC 9 release (`h9_require_release`, `h9_plugin_release`;
  engine-h9-serverinfo, engine-h9-presence and mainui-h9-joinscreen patches; `docs\H9_RELEASE.txt`). Test it with
  `tools\webclient-test\gate.mjs`: a real join against a live server on 127.0.0.1:27015 whose release it sets over rcon.
  A cvar showing the right value proves nothing, the key has to be in the client's `setinfo` list.
- `export-map` -- level work (e.g. `h9_te_neuropolis`); a combined-map task
  (`h9_tsrp_allcities`, merging three existing maps via the SMAK tool) was
  scoped but deferred, not started.

## Standing rules worth repeating

- No `git commit` anywhere in this project without the user's explicit,
  separate permission for that specific commit.
- Back up before nontrivial edits (`<file>.bak_<description>`).
- Full server/client restart needed to pick up engine or plugin rebuilds.
