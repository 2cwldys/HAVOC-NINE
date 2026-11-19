# HAVOC 9 -- Solutions & Past Fixes

This file is a shared knowledge base committed to git. Every AI query on this project
automatically reads it before answering -- so the more real solutions get logged here,
the smarter the collective context becomes.

**Scope:** Log it if it has a meaningful connection to this project. Even if the problem came up
while working on something else, if the solution directly helped with HAVOC 9 -- the AMX Mod X
plugins, the engine patch chain, reTS, the web client, the Linux build, the deploy or the site --
it belongs. The test is: *does knowing this make future work on this codebase easier?* Solutions
purely about an unrelated project with no bearing here do not.

**When to add an entry:** A real "ah-ha" moment. A non-obvious fix. Something that took a long time
to understand and finally clicked -- especially after a long, frustrating session where the
breakthrough came late. Those are the most valuable entries. Claude logs them with `log_solution`,
or add one by hand.

**What NOT to add:** unrelated fixes, generic programming advice, typos, or anything a quick search
would answer.

**Format:** date -- problem, then solution, tags, files. ASCII only: `--`, never an em dash.
An engine patch change ALSO needs its own dated entry in
`xash3d-h9-patches\patches\PATCH_CHANGELOG.md`; this file does not replace that one.

---

### 2026-10-23 -- a full engine rebuild failed on a patch nobody had touched

**Solution:** `engine-h9-spraypicker.patch` had been generated against a `CL_CreateResourceList`
that a different, already-committed change later rewrote, so its expected context no longer existed
anywhere. `xash.bat` re-verifies every patch on every build, so a patch that drifts fails silently
until the next full rebuild -- which then breaks for whoever runs it, with no sign of which of
60-plus patches is stale. The fix was to regenerate it against a from-clean-HEAD reconstruction and
verify BOTH directions (`git apply --check` and `--reverse --check`), not against whatever happened
to be in the working tree. `tools\chain.cmd doctor` now names a stale link in about 15 seconds. A
development clone cannot tell you, because there the change is already present and every link reads
"in place".

**Tags:** engine, patch chain, xash.bat, stale patch, h9chain, git apply

**Files:** xash3d-h9-patches\patches\PATCH_CHANGELOG.md, xash3d-h9-patches\xash.bat, tools\h9chain

---

### 2026-11-15 -- a build sat waiting on a lock that was taken "to be safe"

**Solution:** `release-prepare.mjs`, `build-linux.cmd` and `export.bat` take the heavy-job lock
THEMSELVES. Creating that file by hand before running one makes the job wait for your lock instead:
release-prepare waits up to 90 minutes, build-linux just refuses. 25 minutes were lost to it. Never
create the lock for a job that takes its own, and never take an existing one over -- wait, and look
again in a few minutes.

**Tags:** heavy job, lock, build, release-prepare, build-linux, export

**Files:** docs\SHIP_A_VERSION.txt (0b), CLAUDE.md

---

### undated -- a plugin nobody changed still broke the official preset

**Solution:** `amxxpc` is not deterministic: rebuilding a plugin changes its hash even with no code
change. The site authenticates servers against the build's official plugin list, so a blanket
rebuild makes that list stale and the project's own servers report "not authenticated" -- a red
broken chain in the browser and matches answered not_rated. Build only what changed, and make sure
the delivery carries the plugin list with it.

**Tags:** amxxpc, plugins, hashes, preset, deploy, authentication

**Files:** docs\SHIP_A_VERSION.txt, docs\H9_PRESENCE.txt

---

### undated -- patches stopped applying, and the Linux server would not start

**Solution:** Both were line endings done by the checkout, not by anyone's edit. Patches are applied
with `git apply` and keep the exact endings they were made with, so a normal Windows checkout
turning them CRLF stopped them applying; `.gitattributes` marks `*.patch` as `-text`. A shell script
checked out CRLF makes Linux look for an interpreter literally named `bash` plus a carriage return
(`/usr/bin/env: 'bash^M': No such file or directory`), which stopped `linux\h9xash_server.sh`;
`*.sh` is `text eol=lf`. Related rule when editing: change a CRLF file with an exact byte replace,
never `sed -i`, which flips the whole file to LF.

**Tags:** crlf, line endings, gitattributes, git apply, linux, shebang

**Files:** .gitattributes, docs\SHIP_A_VERSION.txt (0b), docs\DOCKER.txt

---

### undated -- a stale file survived an export after a branch switch

**Solution:** `export.bat` copies with `robocopy /XO`, so a file NEWER in the git copy is kept
rather than overwritten by the master's. After a branch switch every file in the git copy looks
newer, so stale content can survive an export and ship. The mirror check lists "differs" files:
compare the content and copy the master's file by hand wherever the master holds the newer work.
The same class of problem in reverse cost time when the git copy held reTS work the master did not
-- compare with `diff -rq` and merge by hand, never by timestamp, because some files are newer in
each tree.

**Tags:** export.bat, robocopy, two trees, git copy, mirror, reTS

**Files:** docs\SHIP_A_VERSION.txt, tools\mirror-check.ps1

---

### 2026-11-19 -- the join screen was finished on both sides and never appeared

**Solution:** The engine raised it and the menu drew it, and three lines of stock FWGS took the menu
back down again before a player saw anything, so a join looked exactly like upstream with no patch
at all. `CL_ClientConnect` called `UI_SetActiveMenu( cl.background )` the moment the server answered
the connect packet -- about one frame after the screen came up, on a LAN. `SCR_BeginLoadingPlaque`
made the same call under `cls.key_dest == key_menu`, which is the key destination the screen itself
sets. And `V_PreRender` returns false for as long as `cls.disable_screen` is set, so no frame is
drawn at all and the window keeps its last picture: `Host_NewGame` sets that before the local
client even starts joining, which is why "create server" froze on the menu. The lesson that
generalises: when a feature is complete and invisible, look for who UNDOES it, not for what is
missing.

**Tags:** engine, join screen, menu, loading screen, cl_h9join, patch chain

**Files:** xash3d-h9-patches\patches\engine-h9-joinscreen.patch,
xash3d-h9-patches\patches\PATCH_CHANGELOG.md
