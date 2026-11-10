# TS Match Mode / H9XASH -- instructions for working in this repo

TSM (`<TSM>`; `<TSM>`, `<repo>`, `<Half-Life>` and `<temp>` stand for the maintainer's local folders) is the source of truth for the TS Match Mode /
H9XASH project. `<repo>` is a git mirror --
never edit it directly. `<Half-Life>` is the
live install.

## Before touching the engine: check the patch chain first

`xash3d-h9-patches\xash.bat` rebuilds the `xash3d-fwgs` engine by replaying
every `.patch` file in `xash3d-h9-patches\patches\`, in order, against the
real source. It re-verifies **every** patch on **every** build, not just the
one you're adding -- a patch that silently went stale relative to someone
else's change does not error until the *next* full rebuild, which then fails
for whoever runs it with no indication which of 10+ patches is the problem.
This happened for real on 2026-10-23 (`engine-h9-spraypicker.patch` had gone
stale against an already-committed, unrelated change) -- see
`xash3d-h9-patches\patches\PATCH_CHANGELOG.md` for the full account.

So, before hand-editing anything under `xash3d-fwgs`, or adding new engine
work of your own:

1. **Read `xash3d-h9-patches\patches\PATCH_CHANGELOG.md` first.** It lists
   every tracked patch, what each one touches, and any apply-order
   dependencies between them (several patches must apply in a specific
   sequence because a later one's hunks are numbered against an earlier
   one's result).
2. Check whether the region you're about to touch is already covered by an
   existing patch before hand-editing it directly -- a hand-edit that isn't
   folded back into the matching `.patch` file breaks the *next* person's
   build, not yours.
3. If you add, edit, regenerate, split, merge, or remove a `.patch` file,
   **add a dated entry to `PATCH_CHANGELOG.md` in the same turn.** Not
   optional -- that file exists specifically so the next agent or session
   doesn't have to rediscover this from scratch.
4. Verify a patch both ways before trusting it: forward (`git apply
   --check`) against a clean/prior state, and reverse (`git apply --reverse
   --check`) against the state it's supposed to already be applied to. Don't
   trust hand-derived line-number arithmetic across multiple hunks/patches --
   it's easy to get wrong; reconstruct the real file state (a scratch copy,
   or a real `git apply --check`) and read it instead.
5. Two different kinds of "already applied" exist in this codebase: a
   tracked `.patch` file in `xash3d-h9-patches\patches\` (re-verified every
   build, covered by the changelog above), and an already-committed change
   on the `h9` branch in `xash3d-fwgs` (`git log --oneline`, never
   re-verified by `xash.bat`, permanent once committed). A tracked patch can
   go stale against a committed one without anyone touching the tracked
   patch file at all -- that's exactly what happened on 2026-10-23.

## The web client moves with the engine

The browser build (`webclient-bin`, `webclient-build\stage`, the page in `havoc9.org\webclient`) is made from the same
patched `xash3d-fwgs` tree and the same patch chain as the native game, plus `webassembly-patch\` (the browser port).
Both patch sets, the builds and the page are in git. A change that reaches the native game must reach the web client in the
same piece of work, or the web client silently falls behind: the server browser's chain and the scoreboard's pictures were
native-only for days before anyone saw it.

1. **Finish every engine, client-library or page change with `node tools\webclient-sync.mjs`.** It covers `xash3d-fwgs`,
   `xash3d-h9-patches\patches`, `webassembly-patch`, `reTS`, `build-webclient.ps1`, `tools\make_webclient_*` and
   `havoc9.org\webclient`. When the engine or the client library changed it builds them (about 4 minutes, below-normal priority);
   otherwise it takes seconds. It lays out the stage, copies `webclient-bin`, the stage, the web tools and the page into the
   git mirror, publishes the page files to this PC's local site, runs a headless-browser smoke test, and records what it built
   from in `webclient-bin\INPUTS.json`. "The web client matches the engine" (exit 0) is the bar for done, not "the engine built".
   `--check` builds nothing and says what is out of date; `--watch` keeps syncing while you work; `--force` builds anyway;
   `--stage` lays the stage out again after game files changed.
2. It is a heavy job and takes `<temp>\HEAVY-JOB.lock` itself. When you already hold the lock for the engine build, pass
   `--lock-held`; to wait for another holder instead of giving up, `--wait <minutes>`. Never take the lock over.
3. **Native-only code needs its web counterpart in the same turn.** A patch that compiles code out of the browser build
   (`#if !XASH_EMSCRIPTEN`) needs either a page half (an object handed over as `Module.<name>` in `engineConfig` in
   `havoc9.org\webclient\client.js`, called from the engine through `EM_JS`; or a feed the page sets, as `chainFeed` does for the
   server browser) or the reason none is needed, as an entry in `xash3d-h9-patches\WEB_PARITY.json` (`bridged`, `page-fed`, or
   `native-only` with its reason; the markers it lists must be in `client.js`). The pipeline stops (exit 3) at a patch with such
   code and no entry, at an engine call into a `Module.*` object the page does not hand over, and at an entry whose marker is gone.
4. A page file changed under `havoc9.org\webclient` is not seen by a running local site until it is published (the local site
   copies the page once at its start); the pipeline does that, so run it after a `client.js` edit as well.
5. Report both builds when you report an engine change: the native `xash.dll` and the web `xash.wasm` (the pipeline prints
   the second). If the smoke test fails, the work is not done; say so with its output.
6. `webclient-bin\INPUTS.json` is the pipeline's record, never written by hand. The pipeline never commits.

## The Linux build moves with the web client

The native Linux i386 server (`linux\`, `build-linux.cmd`, the WSL2 distro `h9build`; `docs\LINUX_SUPPORT.txt`) is built from the
same patched `xash3d-fwgs` tree and patch chain, the same `reTS` and `rcbot-patch` sources, the AMX Mod X modules and the
`H9XASH` folder as the Windows game and the web client, and its ZIPs pack whatever `H9XASH` holds at that moment. So the Linux
build is synced in tandem with the web client: every piece of work that ends with `node tools\webclient-sync.mjs` ends with the
Linux sync as well, or `H9XASH-linux\` and the Linux ZIPs silently fall behind the way the web client once did.

1. **After the web sync, run `build-linux.cmd -Stage`.** Its steps are `rets metamod engine amxx rcbot assemble`
   (`-Steps` picks some, `-Skip` leaves some out). A change to `xash3d-fwgs`, `xash3d-h9-patches\patches`, `reTS`'s game library,
   `rcbot-patch`, an AMX Mod X module or `linux\` needs the step that builds it plus `assemble` (`-Steps engine,assemble`). A change
   to `H9XASH` content only (a plugin, config, preset, model, sound, map, or the Windows client library) needs
   `-Steps assemble -Stage`, which lays `H9XASH-linux\` out again and packs the ZIPs. When unsure, run every step.
2. It is a heavy job like the web sync: it takes `<temp>\HEAVY-JOB.lock` itself and refuses while the lock exists. Run the two
   one after the other, never together, and never take the lock over.
3. Client-only code (`cl_dll`, the in-game panels, the Windows SAPI voices, WebView2, Discord presence) is not built for Linux,
   because there is no native Linux client: the Wine package carries the Windows client and the web client runs the page.
   When a feature is client-only, say in `docs\LINUX_SUPPORT.txt` what a Linux player gets.
4. "Done" is `build-linux.cmd` exiting 0, `H9XASH-linux\BUILDINFO.txt` listing the hashes of what was built, and the three
   ZIPs in `dist\` staged again (`H9XASH.zip`, `H9XASH-linux.zip`, `H9XASH-linux-server.zip`). A server-side change is also
   started once in the distro (the unpacked server ZIP with `H9XASH-linux` laid over it, `h9xash_server.sh -port 27099`, rcon
   over UDP: the engine, Metamod, AMX Mod X, RCBot and the plugins must load) before it is called working. Say what was and was
   not run.
5. Report the Linux build next to the two web builds when you report an engine change: the libraries built and their glibc
   floor (`BUILDINFO.txt`), or "Linux: assemble only". The build never commits.
6. `node tools\linux-sync.mjs` says whether `H9XASH-linux\` is in step with `H9XASH` and with the sources its libraries were built
   from (it also checks the derived `gameinfo.txt`, `liblist.gam` and Metamod `plugins.ini`, the Linux counterpart of every module the
   configuration loads, and the staged ZIPs); `docs\LINUX_BUILD_LAYOUT.txt` is the map of the folder and the ZIPs. Run it before
   calling the Linux build current. `H9XASH-linux\` is the build's output, never edited by hand, and not a second copy of the
   game's content. State what each ZIP holds when you report staging: `H9XASH-linux.zip` is the Wine/Proton package until a native
   client build puts `xash3d` in `H9XASH-linux\`.

## Assault maps: placing the respawn sets

An Assault map (`h9_as_<name>`, `ts_assault.amxx`) has a spawn set for each
capture point: the points of tier N in `configs\tsm_spawns_<map>.cfg` belong to
capture point N. Do not place them by guesswork or by hand coordinates: read
`docs\ai_context\ASSAULT_SPAWNS.txt`, then run `node
tools/assault-spawns/cli.mjs <map> --plan <folder>` (it reads the BSP's own
collision, applies the placement rules, writes the sets between two marker
comments and draws a plan PNG to look at). `node --test
tools/assault-spawns/assault-spawns.test.mjs` runs its tests. The library is
called from a map generator with `generateForMap()` (same guide, section 7).

## General project rules

- Never `git commit` anywhere in this project (including the `xash3d-fwgs`
  clone on branch `h9`) without the user's separate, explicit permission for
  that specific commit. An approved plan is not that permission.
- No backup copies of text files (source, scripts, docs, configs): git is the
  backup. Only a binary being replaced (a DLL, EXE, AMXX or the like) may keep
  one beside it: `<file>.bak_<short description>`.
- One heavy job at a time on this machine: engine, AMX Mod X, RCBot and reTS
  builds, build.bat, export.bat, map compiles and test servers. Only one agent
  holds the build lock, `<temp>\HEAVY-JOB.lock`, unless told otherwise. Create
  it atomically (fail if it exists) in the same step that starts the job, write
  who, what and when in it, and delete it when done. If it exists, wait and
  check again every few minutes; never start a heavy job while another holds
  it, and never take it over. Maps compile at `-threads 6` (the user's rule after a thermal
  shutdown at an honoured `-threads 8` on 2026-11-02).
- Every new agent working with this codebase asks where its temporary files
  (work folders, builds, caches, downloads, test copies) will be stored
  before it proceeds. Never assume %TEMP% or C:; drive space differs per
  machine and C: may be a small SSD.
- A third-party file (a binary, an include, a data file) ships with its license beside it,
  in every folder that holds a copy: `easy_http_LICENSE.txt` next to AmxxEasyHttp's module,
  CA bundle and include (compts, H9XASH, the Steam install, the git copy), and
  `linux\LICENSE-AMXXEASYHTTP.txt` and `linux\LICENSE-AMBUILD.txt` for the Linux build's own.
  A new third-party file brings its license text with it. A third-party binary carries no
  `.patch` note (`tools\patch-notes-map.json`, binariesWithoutNotes); a rebuilt or changed one does.
- The Linux server build is `build-linux.cmd` (the WSL2 distro `h9build`; it is a heavy job and
  takes the lock); `H9XASH-linux\` is its git-ignored output and `stage-h9xash` packs it. It runs in
  tandem with the web sync (the section above says when and how).
  Pinned downloads (easy_http) are checked against the SHA-256 in `linux\build-linux.sh`.
- A plugin, module or preset-list change ships with its hash: `build.bat` rewrites
  `H9XASH\presets\official-preset.json` (`tools\preset-check.mjs --write`); commit it with
  the `.amxx` files (the workflow `preset-hash.yml` fails otherwise) and have an admin import
  it into the site (`docs\H9_PRESENCE.txt` 4d). The build's version is `VERSION` in
  `ts_matchmode.sma` (what the plugin registers, so what the site lists): bump it with the update.
- `ts_matchmode.sma` changes build+deploy via `build.bat`; confirm `Deployed:
  N Failed: 0`. Engine changes build via `xash3d-h9-patches\xash.bat` (full
  rebuild, applies/verifies the whole patch chain above), then `export.bat`
  to propagate into `H9XASH\`, then `node tools\webclient-sync.mjs` so the web
  client follows, then `build-linux.cmd -Stage` so the Linux build follows (the
  two sections above).
- No Unicode / non-ASCII in `.dm`-adjacent... n/a for this project, but: no
  em dashes or other non-ASCII punctuation in source files the toolchain is
  touchy about -- use `--` instead, consistent with the style already in
  this codebase's own comments.
- A full server/client restart is generally required to pick up engine or
  plugin rebuilds -- don't assume a running instance hot-reloads either one.
