presets\ -- config/plugin presets for h9_presets.bat
======================================================

Run h9_presets.bat (in H9XASH\, next to this folder) to swap files in
ts\addons\amxmodx\configs\ for alternate versions kept here, or to toggle
individual plugins on/off in plugins.ini directly. Nothing in here is read by
the game or the server on its own -- only h9_presets.ps1 reads this folder,
and only when you run it.

NAMING CONVENTION
-----------------
Name every preset file:

    <target-base>.<tag>.<ext>

where <target-base>.<ext> is the real filename it replaces in
ts\addons\amxmodx\configs\, and <tag> is whatever you want to call that
variant -- a profile name, a mode name, anything without a dot in it.

    plugins.competitive.ini      -> replaces configs\plugins.ini
    ts_matchmode.casual.cfg      -> replaces configs\ts_matchmode.cfg
    arp\arp.roleplay.ini         -> replaces configs\arp\arp.ini

That last example shows the one other rule: a subfolder here mirrors the same
subfolder under configs\. A preset for a file that lives in
configs\arp\arp.ini goes in presets\arp\, named the same way. Most presets
won't need a subfolder at all -- everything directly under configs\ (most
AMXX config files) just goes directly in presets\.

A file whose name doesn't split into exactly three dot-separated parts
(base, tag, extension) is skipped, with a warning when the tool lists what
it found.

TWO RESERVED FOLDER NAMES
--------------------------
backup\   -- the tool's own backups, one timestamped folder per run that
             actually changed something. Never treated as a preset source.
example\  -- this is where you're reading this from right now. Reference
             files only, to copy and rename when making a real preset.
             Never treated as a preset source either.

Both are skipped by the scan no matter how deep they appear, so you can't
accidentally make them live by naming a real preset folder "backup" or
"example".

TWO WAYS TO APPLY A PRESET
---------------------------
* Swap one file: pick a target (e.g. "ts_matchmode.cfg"), then pick which of
  its variants to apply. Only that one file changes.
* Apply a full profile: pick a tag (e.g. "competitive"), and every target
  that has a file tagged with it gets swapped in at once -- a quick way to
  hot-swap a whole mode (plugins + whichever configs go with it) in one go.
  Anything that doesn't have a variant under that tag is left alone, and the
  tool tells you so rather than silently skipping it.

Either way, whatever file is about to be overwritten is backed up first,
into presets\backup\<timestamp>\, the first time that file is touched in a
given run of the tool.

THE OFFICIAL PRESET FILES
-------------------------
official-preset.json and official-preset-<Mode>.json (one for each plugins.<Mode>.ini) are not presets: they hold the
SHA-256 of the plugins, modules and Metamod plugins an authenticated server may run (tools\preset-check.mjs writes them,
build.bat at every build; docs\H9_PRESENCE.txt 4d). They are named with a hyphen on purpose, so this tool never takes
them for a preset. Do not edit them by hand. Each official-preset-<Mode>.json says "gameMode": "<Mode>", the list of
havoc9.org's allowlist its import fills.

WHICH PRESET A SERVER RUNS
--------------------------
h9_preset.<Tag>.cfg (Assault, Siege, TeamElimination) is a real preset: applying a profile puts it in configs\ as
h9_preset.cfg, with one line, h9_preset "<Tag>". h9_presence.amxx runs it after h9_presence.cfg and names the preset in
every report to havoc9.org, which then judges the server's plugins against that game mode's list of official files and
the ones every mode shares. Without the file, the server is judged against every mode's list together. Keep the tags
in step with plugins.<Tag>.ini (the list of files for a tag is made from it), and add an h9_preset.<Tag>.cfg for each
new tag.

TOGGLING INDIVIDUAL PLUGINS
----------------------------
Separate from presets entirely. The tool's own menu can list every plugin
line in plugins.ini and flip one on or off at a time -- the same effect as
hand-editing the leading ";" yourself, for when you want one small change
without making or picking a whole preset for it.
