# Project context

TS Match Mode / H9XASH. Source of truth: this directory (`<TSM>`).
Git mirror at `<repo>` (never edit directly).
Live install at `<Half-Life>`.

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
- `apollo-rp\` -- Apollo RP (the roleplay plugin set) as H9 builds it for The Specialists. `docs\APOLLO_RP.txt` is what it is and
  what a player sees, `apollo-rp\ORIGIN.txt` every H9 change to it (with the `H9-*.patch` diffs), `docs\ARP_CONTENT.txt` the
  content of H9's two roleplay maps, `docs\ARP_INVENTORY.txt` (the server's half) and `docs\ARP_INVENTORY_WINDOW.txt` (the
  client's) the inventory and the exchange of goods, `docs\ARP_ADMINS.txt` how to give a player ARP admin (and, in 8, how to give yourself
  money, items and a job to test), `docs\ARP_COMMANDS.txt` every ARP command and what it does. Every H9 addition to
  it has a server switch with a stock "off" (`docs\APOLLO_RP.txt`, 10). The colour of every H9 panel is the player's own:
  `cl_h9_vgui_color` and `cl_h9_vgui_r/_g/_b` (`COMMANDS.txt`, H9XASH CLIENT; `docs\H9_VGUI.txt`, 4k).
- `reTS\` -- The Specialists' game library (`mp.dll`) and client library (`client.dll`) as H9 builds them. `reTS\cl_dll` holds
  H9's panels (`docs\H9_VGUI.txt`: the menus, the notices, Apollo RP's HUD and inventory windows, the colour cvars). A change
  to a library goes in the `.patch` note beside its DLL (`tools\patch-notes-check.mjs` asks for it).
- `xash3d-fwgs` -- the engine fork, branch `h9`. Rebuilt via
  `xash3d-h9-patches\xash.bat`, which replays the patch chain above.
- `H9XASH` -- the built client, propagated via `export.bat`.
- `linux\`, `build-linux.cmd` -- the native Linux i386 server build (WSL2 distro
  `h9build`), laid out as `H9XASH-linux\` and packed by `stage-h9xash`; status and
  known gaps in `docs\LINUX_SUPPORT.txt`. The third-party easy_http module it installs
  carries its license (`linux\LICENSE-AMXXEASYHTTP.txt`). It is synced in tandem with the
  web client: `build-linux.cmd -Stage` follows every `node tools\webclient-sync.mjs`
  (`CLAUDE.md`, "The Linux build moves with the web client"). `node tools\linux-sync.mjs`
  checks that `H9XASH-linux\` is in step with `H9XASH` and the sources
  (`docs\LINUX_BUILD_LAYOUT.txt` is the map of the folder and its ZIPs).
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
- No backup copies of text files (git is the backup); only a binary being replaced
  (a DLL, EXE, AMXX or the like) may keep one: `<file>.bak_<description>`.
- Engine, client-library, server-library and `H9XASH` content changes finish with
  `node tools\webclient-sync.mjs` and then `build-linux.cmd -Stage`: the web client
  and the Linux build move together. Both are heavy jobs; one at a time, never together.
  They run once, after the last feature of a batch, and not after each feature (`CLAUDE.md`, "Parity comes last, once").
- Full server/client restart needed to pick up engine or plugin rebuilds.
