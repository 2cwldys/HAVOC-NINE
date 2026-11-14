H9XASH-UPDATER

H9XASH-Updater.exe installs H9XASH, H9's client for The Specialists on Xash3D FWGS, and keeps it up
to date. It takes the place of downloading and unpacking H9XASH.zip by hand: each run asks havoc9.org
which files the current build has, compares them with your folder file by file, and downloads and
copies in only what changed. Your own files (settings, ids, saves, screenshots, sprays, logs) are
never touched.

  1. USING IT                   install, update, check, roll back
  2. WHERE H9XASH COMES FROM    havoc9.org (the default), git, or the published ZIP
  3. PUBLISHING A BUILD         stage-h9xash.ps1, dist\files, the site's files/
  4. YOUR ACCOUNT               linking the install to havoc9.org
  5. WHAT IT NEVER TOUCHES      your files
  6. SAFETY                     hashes, atomic swaps, the journal, the rollback
  7. FILES AND DISK SPACE       what it keeps where
  8. BUILDING                   dist\H9XASH-Updater.exe from tools\updater\


1. USING IT

Get H9XASH-Updater.exe from the dist folder of the HAVOC-NINE repository
(https://github.com/2cwldys/HAVOC-NINE). It runs on Windows 8.1 or later and needs nothing else
installed. Put it where H9XASH should go, D:\Games say, and run it:

  - It asks for the H9XASH folder. Enter takes H9XASH beside the exe (D:\Games\H9XASH), or the
    exe's own folder when that is already an H9XASH folder.
  - On the first run it offers to link your havoc9.org account (section 4). You can skip it.
  - It shows how many files are new, changed and removed, and asks before it changes anything.
  - Start the game with h9xash.bat in that folder, as always.

Run it again whenever you want the latest H9XASH. Close the game first: the updater will not change a
folder while HAVOC 9.exe, or any other program from that folder, is running.

Already have H9XASH from the ZIP? Put the updater beside that H9XASH folder, or in it, and run it. It
takes the folder over: files that already match are left alone, the others are replaced, and nothing
of yours is touched.

Options (H9XASH-Updater.exe --help lists them all):

  --dir <folder>     the H9XASH folder, without being asked
  --check            show what an update would change, and change nothing
  --rollback         undo the last update
  --status           what is installed, whether a rollback is possible, the account link
  --link             link the account now (also when it was skipped on the first run)
  --source git       the latest commit of the git repository instead, for developers (section 2)
  --source zip       the published H9XASH.zip instead, downloaded whole
  --cache <folder>   where the download cache goes (default: <folder>-updater-cache beside it)
  --yes              ask nothing, for scripts (the account step is skipped unless --link is given)


2. WHERE H9XASH COMES FROM

web (the default). The build published on havoc9.org, at https://havoc9.org/files/ (section 3):
manifest.json lists every file of the build with its size and SHA-256, and each file is stored once
under its SHA-256. The updater fetches the manifest (only when it has changed: ETag), compares it
with your folder, and downloads only the files that are new or different, each one checked against
its SHA-256 before it goes in. A download cut short goes on from where it stopped at the next run.
No Git, no Git LFS and no GitHub are involved, so players cost the repository nothing.

git (--source git, for developers). The updater keeps its own copy of the repository's H9XASH folder
in the download cache: a shallow, sparse, partial clone of https://github.com/2cwldys/HAVOC-NINE.git
(branch main) that fetches only H9XASH\ and three small files from the repository's root
(VERSION.txt, stage-h9xash.ps1 and the stock networking.ini). Git LFS brings the maps, models and
archives as the files are checked out. The first run downloads about 530 MB of git data and 690 MB
from Git LFS; later runs fetch only what changed. Git LFS bandwidth is metered on GitHub (10 GiB a
month on a free account, billed to the repository's owner), which is why players use the web source.
It needs Git for Windows, which includes Git LFS: https://git-scm.com/download/win (Git LFS alone:
https://git-lfs.com). The cache checks out with Windows line ends (core.autocrlf true) and the LFS
filter set in its own git settings, so the developer's own git settings change nothing.

zip (--source zip). The published H9XASH.zip from https://havoc9.org/downloads/H9XASH.zip. It is
downloaded again, whole, only when the site's copy has changed (ETag and Last-Modified), unpacked in
the cache with every file's CRC checked, and then applied exactly as the other sources are.


3. PUBLISHING A BUILD

stage-h9xash.ps1 (the repository's root) publishes the web files every time it makes the ZIPs, from
the very tree it zips, so the web build is the ZIP's: the same files left out, the same configs
scrubbed. Into dist\files (-FilesDir to change it, -NoWebFiles to skip it) tools\updater\
publish_files.py writes:

  manifest.json           the build (VERSION.txt), and every file's path, size, SHA-256 and mode
  manifest.previous.json  the build before it (kept with the files, never served)
  <sha256>                each distinct file once, named by its SHA-256
  .htaccess               the rule below, for an Apache host

The files a new player starts from (the stock config.cfg, networking.ini and tempdecal.wad) go in as
seeds: the updater puts one only where the folder has none. A new file is written under a temporary
name and checked before it is renamed; every file is in place before the manifest that names it,
and files that neither this build nor the one before it names are removed after it, so a player in
the middle of an update can always finish it. The first publish copies about 1.2 GB; later ones only
the files that changed.

Then copy dist\files to the site's files/ folder, the files first and the manifest last:

  Linux VPS:    rsync -a --delay-updates --delete-after dist/files/ root@<host>:/var/www/havoc9.org/files/
  Windows VPS:  robocopy dist\files <ROOT>\site\files /E /XF manifest.json
                robocopy dist\files <ROOT>\site\files /MIR

vps\linux\setup.sh and vps\windows\setup.ps1 keep files/ when they put a new copy of the site in.

The folder is hidden from everyone but the updater. havoc9.org/deploy/nginx-setup.sh (the Linux
VPS), vps\windows\Caddyfile.template (the Windows VPS) and the .htaccess (an Apache host) all answer
404 to any request under /files/ that lacks the updater's X-H9-Updater: 1 header and its
H9XASH-Updater/ User-Agent, and to any name there but a SHA-256 or manifest.json; none lists the
folder. The manifest is sent with Cache-Control no-cache, the files with a year's immutable caching.
THIS HIDES THE FOLDER FROM BROWSERS AND SEARCH ENGINES; IT IS NOT SECURITY. Anyone can send those two
headers, and the files are the public game anyway: nothing secret may ever go in.


4. YOUR ACCOUNT

Linking tells H9's servers that this install is you, without a player id ever being typed, pasted or
shown. It is the same link the game's menu makes ("Link your Account", or h9_link in the console):

  1. the updater asks havoc9.org for a code and opens havoc9.org/link/ in your browser;
  2. you sign in there, check that the page shows the same code, and press LINK;
  3. the updater, which asks the site every few seconds, gets the link and stores it.

It is stored in user_id.ini as a protected= line: the player id and the link, encrypted with Windows
DPAPI for your Windows user on this PC. Only that user on this PC can open it; a copy of the file on
another PC, or under another Windows user, opens nothing. Each Windows user on the PC can link their
own account in the same install (four at most). device_id.ini, the install's device id, is made first
when the game has not made it yet, in the game's own format.

A link belongs to the site that made it, kept in the record as site= the way the game keeps it:
https://havoc9.org, or for a test a local h9web given with --link-site (http://127.0.0.1:<port> or
http://localhost:<port>, the sites the game's cl_h9_site takes). The game asks only that site
whether the link still stands, and only that site's answer can end it.

The account step comes once, on the first run, and you can skip it (N, or Ctrl+C while it waits).
Link later from the game menu, or with H9XASH-Updater.exe --link. Unlinking is done in the game (the
menu's "Unlink account", or h9_unlink) or on havoc9.org (ACCOUNT, LINKED GAMES).


5. WHAT IT NEVER TOUCHES

Everything stage-h9xash.ps1 leaves out of the client ZIP belongs to one player or one server, and the
updater never installs, replaces, removes or rolls it back, whatever a manifest or the repository
lists:

  - ids: user_id.ini, device_id.ini, .xash_id, every *_resolved.cfg;
  - settings: config.cfg (in any folder), video.cfg, opengl.cfg, networking.ini;
  - your own files: the console history, the server history and favorites, saves, screenshots,
    demos, downloads (ts_downloads), the font cache, your spray (ts\tempdecal.wad), the spray cache
    (custom.hpk), voice_ban.dt;
  - a server's: ts_advertise.cfg, h9_presence.cfg, any *.key or *.env, ban lists, AMXX stats and
    vaults, RCBot's player-name list, its databases (ts\addons\amxmodx\data\sqlite3, Apollo RP's arp.sq3, and any
    .sq3, .sqlite or .db file: a new install makes its own and loads each map's shipped SQL file into it);
  - logs, process ids, backups (*.bak*), temporary and junk files, a Wine prefix kept in the folder.

With --source git, the release's own stage-h9xash.ps1 is read at every update too, and any rule it
adds joins these. publish_files.py refuses to publish a stage that holds any of them.

Files you add yourself, a picture in ts\logos say, are never removed: the updater removes only files
an earlier update installed that the new release no longer has, and keeps even those when you have
changed them since. A new install gets the seeds (section 3) only where the folder has none.


6. SAFETY

  - Every download is checked against its SHA-256 before it is kept; every new or changed file is
    then copied into .h9xash-updater\stage and checked again. Nothing in the game folder changes
    until every copy matches.
  - Each file then goes in by an atomic rename, so a file is always either the old one or the new one.
    The old one is kept in .h9xash-updater\rollback\files (as a hard link, so it costs no space).
  - A journal (rollback\journal.jsonl) records every step before it is taken. An update that fails
    part way, a file held open by another program say, puts every file back at once; one that was
    cut off (the window closed, the PC went off) is undone at the start of the next run.
  - It refuses while a program from the folder is running, while another updater works on it, when
    the release holds Git LFS pointer files instead of game files, and when a manifest names a path
    outside the folder.
  - It refuses a folder inside a git checkout or a TS Match Mode source folder: it keeps players'
    copies, never a source tree.
  - Every run is logged in .h9xash-updater\updater.log.

H9XASH-Updater.exe --rollback undoes the last update (one update back: an update replaces the
previous rollback). It uses the copies kept in the folder, not the site. The next update installs
the newer files again.


7. FILES AND DISK SPACE

In the H9XASH folder, .h9xash-updater\ holds installed.json (the files the updater installed, with
size, time and SHA-256), updater.log, the rollback, and link-asked (the first-run question was asked).
stage-h9xash.ps1 leaves the folder out of packages.

Beside it, <folder>-updater-cache\ (H9XASH-updater-cache) holds what each source needs. web: the last
manifest, and while an update runs the files it downloads, deleted once they are installed. git: the
git copy, about 1.6 GB (its checkout and git's own packed copy; git-lfs's copies are deleted after
each update). zip: the unpacked ZIP, about 1.3 GB. Delete the cache any time: the next run downloads
again. H9XASH itself takes about 1.3 GB, and an update needs room for the files it changes, twice
(the download and the stage).

The one-file exe unpacks itself (about 20 MB) into the Windows temporary folder while it runs and
removes that when it ends.


8. BUILDING

  tools\updater\build.cmd [-WorkDir <folder>] [-Python <python.exe>] [-UseInstalled]

makes dist\H9XASH-Updater.exe: Python 3.12 in a venv with exactly the packages pinned in
requirements-build.txt, PyInstaller one-file, no UPX, PYTHONHASHSEED=0 and a fixed build time, so the
same sources give the same exe (two builds, same SHA-256). The venv, PyInstaller's work files, pip's
cache and every temporary file go in -WorkDir (default tools\updater\.build, which git ignores). The
build ends by running the exe once and printing its SHA-256.

  py -3 tools\updater\test_updater.py --work <scratch folder> [--exe dist\H9XASH-Updater.exe]

tests it end to end in <scratch folder>\updater-test, with no network: a local git origin, an install
over a player's folder, an update after a change, a check-only run, the refusal while a program runs
from the folder, a failed update that undoes itself, recovery from an unfinished one, the rollback,
the LFS pointer guard, the ZIP source over a local web server, the web source (publish_files.py's
output behind a stand-in for the site's files/ with the same hiding rule: an install, a 304, a delta,
pruning, a resumed and a damaged download, a rollback, a missing file, a manifest with a bad path),
and the account step against a stand-in for havoc9.org.

Sources: h9xash_updater.py (everything but the account), h9link.py (the account step, after
h9web\lib\link.js and the engine's store), publish_files.py (the web files), test_updater.py,
build.ps1 and build.cmd. git tracks only two files in dist\: H9XASH-Updater.exe and .keep.
