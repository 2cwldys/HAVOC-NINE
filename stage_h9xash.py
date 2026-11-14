#!/usr/bin/env python3
# stage_h9xash.py -- packs H9XASH into the clean client ZIPs players extract and play.
#
# The same program as stage-h9xash.ps1, for Linux (stage-h9xash.sh starts it) and for Windows with
# Python 3.8 or newer; standard library only. stage-h9xash.ps1's header comment describes what
# goes in and what stays out; this file follows it rule for rule, in the same order, with the same
# report and the same stop conditions. One run writes:
#   dist/H9XASH.zip                Windows files (leaves out h9xash.sh, h9_userid.sh,
#                                  README_LINUX.txt and every *.so)
#   dist/H9XASH-linux.zip          the native Linux build laid over the game data when the folder
#                                  H9XASH-linux (or --linux-native) holds an xash3d client;
#                                  otherwise the Wine/Proton package, with a warning
#   dist/H9XASH-linux-server.zip   when that folder holds xashds and no client
#   dist/H9XASH.report.txt         what was left out, scrubbed and warned about (never a value)
#   dist/files/                    the web files for H9XASH-Updater (tools/updater/publish_files.py)
# H9XASH itself is only read.
#
# Options (the PowerShell parameter in brackets; both spellings are accepted):
#   --source DIR           [-Source]       the H9XASH folder to pack; default: H9XASH beside this script
#   --out-dir DIR          [-OutDir]       ZIPs and report; default: dist beside this script
#   --stage-dir DIR        [-StageDir]     where the temporary copy is built; default: .stage in --out-dir
#   --name NAME            [-Name]         ZIP file name without .zip; default H9XASH
#   --allow-ip IP [IP...]  [-AllowIp]      public addresses that may stay in config files
#   --dry-run              [-DryRun]       stage and scrub, write the report, no ZIP
#   --keep-stage           [-KeepStage]    keep the staged folder after zipping
#   --no-linux             [-NoLinux]      the Windows ZIP only
#   --linux-native DIR     [-LinuxNative]  the native Linux build; default: H9XASH-linux beside this script
#   --files-dir DIR        [-FilesDir]     the web files; default: files in --out-dir
#   --no-web-files         [-NoWebFiles]   publish no web files
#   --compression Optimal|Fastest          [-Compression] deflate level of the Windows ZIP (6 or 1);
#                                          the Linux ZIPs are always written at level 6
# Two options have no PowerShell twin:
#   --here DIR             the folder that holds tools/, havoc9.org/ and the defaults above;
#                          default: the folder of this file
#   --check-lfs PATH...    only run the Git LFS / cut-short-file check (tools/check-lfs.ps1) on the paths
#
# Paths in the rules are written with backslashes as in stage-h9xash.ps1 and compared without regard
# to case; internally and in every ZIP entry the separator is a forward slash. The report writes
# paths with the separator of the system it runs on. Exit code 0: done (or a dry run); 1: stopped.

import argparse
import hashlib
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.realpath(__file__))


class Stop(Exception):
    """A condition that ends the run with an error message and exit code 1."""


class PackageStopped(Exception):
    """A ZIP that failed its read-back; the message names the problems."""


# ---- rules ----------------------------------------------------------------------------
# Paths are written as stage-h9xash.ps1 writes them (backslashes) and stored with forward slashes.

def slash(path):
    return path.replace('\\', '/')


def native(path):
    """A rule or relative path with the separator of this system, for messages and the report."""
    return path.replace('/', os.sep)


def lower_rules(items):
    return [slash(i).lower() for i in items]


# Folders left out wherever they are.
SKIP_DIR_NAMES = lower_rules([
    'logs', 'save', 'screenshots', 'scrshots', 'ts_downloads', 'downloads',
    '.fontcache', 'userconfig.d', '__pycache__', '.venv', 'venv', '.git', 'node_modules',
    # a Wine prefix someone keeps inside H9XASH
    'drive_c', 'dosdevices',
    # H9XASH-Updater's own folder in an install it keeps
    '.h9xash-updater'])
# Folders left out at this path under H9XASH. Each is made again, empty, when RECREATE_DIRS lists it.
# webview2\data is the splash MOTD's embedded browser's own files; webview2\runtime a player's own runtime.
# data\sqlite3 holds a server's databases (Apollo RP's arp.sq3: its accounts, wallets and inventories): a new install makes its own on
# its first roleplay map and loads that map's SQL file, which ships, into it.
SKIP_DIR_PATHS = lower_rules(['presets\\backup', 'ts\\addons\\amxmodx\\data\\vault', 'ts\\addons\\amxmodx\\data\\sqlite3',
                              'webview2\\data', 'webview2\\runtime'])
RECREATE_DIRS = [slash(d) for d in ('ts\\addons\\amxmodx\\data\\vault', 'ts\\addons\\amxmodx\\data\\sqlite3',
                                    'ts\\addons\\amxmodx\\logs')]

# Files left out wherever they are (lower case).
SKIP_NAMES = set(lower_rules([
    'console_history.txt', 'history_servers.lst', 'favorite_servers.lst', 'xashcomm.lst',
    'user_id.ini', 'device_id.ini', '.xash_id',
    'config.cfg', 'video.cfg', 'opengl.cfg', 'custom.hpk', 'voice_ban.dt', 'tempdecal.wad',
    'tsstats.dat', 'vault.ini', 'bot_playerids.ini',
    'ts_advertise.cfg', 'ts_advertise_local.cfg', 'h9_presence.cfg',
    'listip.cfg', 'banned.cfg', 'mail.env', 'accounts.json', 'networking.ini',
    'thumbs.db', 'desktop.ini', '.ds_store',
    # git's attribute file, a Wine prefix's registry files, the updater's timestamp
    '.gitattributes', 'system.reg', 'user.reg', 'userdef.reg', '.update-timestamp']))
SKIP_EXT = set(['.log', '.pid', '.tmp', '.new', '.orig', '.rej', '.dmp', '.mdmp', '.dem', '.env', '.key', '.sav'])
# File names matched by pattern: backups, files h9xash.bat writes per launch, stray build output, and any database file with its journal,
# write-ahead log and shared-memory files (SQLite's .sq3, .sqlite, .sqlite3 or .db).
SKIP_PATTERNS = [re.compile(p, re.IGNORECASE) for p in (
    r'\.bak($|[._-])', r'_resolved\.cfg$', r'^user_id\.ini', r'^device_id\.ini',
    r'^h9_presence.*\.(key|cfg\.bak.*)$', r'downloadstsm', r'\.(sq3|sqlite3?|db)(-journal|-wal|-shm)?$')]

# Files a new player gets from a stock source instead. 'at' is relative to H9XASH, 'sources' are the
# candidates relative to the folder H9XASH sits in.
REPLACEMENTS = [
    {'at': 'ts/config.cfg',
     'sources': ['H9XASH/ts/config.stock.cfg', 'reTS/game/ts/config.cfg', 'ts3.0/ts/config.cfg'],
     'fallback': 'scrub'},
    {'at': 'networking.ini', 'sources': ['xash3d-h9-patches/overlay/networking.ini'], 'fallback': 'scrub'},
    {'at': 'ts/tempdecal.wad', 'sources': ['reTS/game/ts/tempdecal.wad', 'ts3.0/ts/tempdecal.wad'],
     'fallback': 'drop'},
]

# The Linux launcher, its id tool and their README, in H9XASH from the overlay.
LINUX_FILES = ['h9xash.sh', 'h9_userid.sh', 'README_LINUX.txt']

# Files that must reach the ZIP whenever H9XASH has them.
ESSENTIALS = [slash(e) for e in (
    'HAVOC 9.exe', 'xash.dll', 'menu.dll', 'ref_gl.dll', 'SDL2.dll', 'filesystem_stdio.dll',
    'h9xash.bat', 'h9_userid.ps1', 'h9_networking.ps1', 'enter_userid.cmd',
    'ts\\liblist.gam', 'ts\\gameinfo.txt', 'ts\\delta.lst', 'ts\\dlls\\mp.dll', 'ts\\cl_dlls\\client.dll',
    'ts\\autoexec.cfg', 'ts\\userconfig.cfg', 'ts\\addons\\metamod\\plugins.ini',
    'ts\\addons\\amxmodx\\configs\\plugins.ini', 'ts\\addons\\amxmodx\\configs\\amxx.cfg')] + LINUX_FILES

# What only Windows runs and what only Linux runs, by path under H9XASH. The Windows ZIP leaves out the
# second; a native Linux package leaves out both (the build brings its own Linux files); the Wine/Proton
# package keeps both. A DLL's .patch note goes with the DLL, a .so's with the .so.
WINDOWS_ONLY_EXT = set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.pdb', '.lib', '.exp'])
WINDOWS_ONLY_DIR_PATHS = ['webview2']
WINDOWS_ONLY_PATTERNS = [re.compile(r'\.(exe|dll)\.patch$', re.IGNORECASE)]
LINUX_ONLY_NAMES = set(n.lower() for n in LINUX_FILES)
LINUX_ONLY_PATTERNS = [re.compile(p, re.IGNORECASE) for p in (r'\.so(\.\d+)*$', r'\.so(\.\d+)*\.patch$')]

# Config-like files are scrubbed line by line; every text file is scanned for hard secrets.
CONFIG_EXT = set(['.cfg', '.ini', '.lst', '.rc', '.json'])
TEXT_EXT = set(['.cfg', '.ini', '.lst', '.rc', '.json', '.txt', '.md', '.htm', '.html', '.xml', '.yml', '.yaml',
                '.csv', '.bat', '.cmd', '.ps1', '.py', '.sma', '.inc', '.gam', '.example', '.pem', '.url', '.js',
                '.res', '.sh'])

# Settings whose value is a secret or a player id.
SECRET_KEY_EXACT = re.compile(
    r'^(cl_h9_userid|h9_clientid|h9_userid|h9_deviceid|device_id|_pw|password|rcon_password|sv_password'
    r'|h9_presence_key|tsm_ad_token)$', re.IGNORECASE)
SECRET_KEY_PART = re.compile(r'(token|secret|webhook|apikey|api_key|passwd|private_key|(^|_)pass$)', re.IGNORECASE)
RX_CFG_SETTING = re.compile(r'^\s*(?:setinfo\s+)?"?(?P<k>[A-Za-z0-9_.\-]+)"?\s+"(?P<v>[^"]*)"')
RX_INI_SETTING = re.compile(r'^\s*(?P<k>[A-Za-z0-9_.\-]+)\s*=\s*(?P<v>.*?)\s*$')
RX_STEAMID = re.compile(r'STEAM_\d:\d:\d+|VALVE_\d:\d:\d+|\[U:1:\d+\]|\b7656119\d{10}\b')
RX_IPV4 = re.compile(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])')
RX_VERSION_LINE = re.compile(r'version|\bbuild\b|\bver\b', re.IGNORECASE)
RX_NAME_LINE = re.compile(r'^\s*name\s+"', re.IGNORECASE)
# Hard stops: a Discord bot token, a Discord webhook, a private key.
RX_HARD = [
    ('Discord bot token', re.compile(r'[MNO][A-Za-z\d_\-]{23,27}\.[A-Za-z\d_\-]{6}\.[A-Za-z\d_\-]{27,40}')),
    ('Discord webhook URL', re.compile(r'discord(?:app)?\.com/api/webhooks/\d+/[\w\-]+')),
    ('private key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
]
# Documentation's own example address, safe to keep.
EXAMPLE_IPS = ['123.45.67.89']

# Characters .NET's String.Trim() removes from Latin-1 text.
TRIM_CHARS = '\t\n\x0b\x0c\r \x85\xa0'
MB = 1024 * 1024
LFS_POINTER = b'version https://git-lfs.github.com/spec/v1'
NEWLINE = '\r\n' if os.name == 'nt' else '\n'


# ---- small helpers --------------------------------------------------------------------

def get_extension(name):
    """The extension of a file name as .NET's Path.GetExtension gives it: from the last dot, which can be the
    first character (.gitattributes), and empty when the name ends with the dot."""
    i = name.rfind('.')
    if i < 0 or i == len(name) - 1:
        return ''
    return name[i:]


def n0(value):
    """A number with thousands separators and no decimals (the N0 format)."""
    return format(int(value + 0.5), ',')


def read_latin1(path):
    with open(path, 'rb') as fh:
        return fh.read().decode('latin-1')


def write_latin1(path, text):
    with open(path, 'wb') as fh:
        fh.write(text.encode('latin-1'))


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        while True:
            block = fh.read(1 << 20)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def full_path(path):
    """The absolute path without a trailing separator."""
    p = os.path.abspath(path)
    stripped = p.rstrip('\\/')
    if stripped and not stripped.endswith(':'):
        return stripped
    return p


def find_path(base, rel):
    """rel under base, found by its exact spelling or else without regard to case (how a Windows folder
    answers); None when it is not there."""
    cur = base
    for part in rel.split('/'):
        nxt = os.path.join(cur, part)
        if os.path.exists(nxt):
            cur = nxt
            continue
        try:
            names = os.listdir(cur)
        except OSError:
            return None
        low = part.lower()
        hit = None
        for n in names:
            if n.lower() == low:
                hit = n
                break
        if hit is None:
            return None
        cur = os.path.join(cur, hit)
    return cur


def is_file_at(base, rel):
    p = find_path(base, rel)
    return p is not None and os.path.isfile(p)


def is_dir_at(base, rel):
    p = find_path(base, rel)
    return p is not None and os.path.isdir(p)


def scan_tree(base, strict=True):
    """Every file and folder under base as (files, dirs): files as (rel, path) pairs, rel with forward
    slashes. The order is the one Get-ChildItem -Recurse gives on NTFS: names sorted without regard to case,
    a folder's files before its sub-folders' files, and all of a folder's sub-folders listed before any of
    their children. A folder that cannot be read stops the run, or is skipped when strict is false."""
    files = []
    dirs = []

    def rec(path, rel):
        try:
            with os.scandir(path) as it:
                entries = sorted(it, key=lambda e: (e.name.upper(), e.name))
        except OSError:
            if strict:
                raise
            return
        subs = []
        for e in entries:
            try:
                is_dir = e.is_dir(follow_symlinks=False)
                is_file = (not is_dir) and e.is_file()
            except OSError:
                continue
            r = rel + '/' + e.name if rel else e.name
            if is_dir:
                subs.append((e.path, r))
            elif is_file:
                files.append((r, e.path))
        for _, r in subs:
            dirs.append(r)
        for p, r in subs:
            rec(p, r)

    rec(base, '')
    return files, dirs


def remove_tree(path):
    def writable(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC)
            func(p)
        except OSError:
            pass
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=writable)
    else:
        shutil.rmtree(path, onerror=writable)


def copy_into_stage(src, dst):
    """Copies a file with its modification time and leaves the copy writable (the scrub rewrites it)."""
    shutil.copy2(src, dst)
    os.chmod(dst, os.stat(dst).st_mode | stat.S_IWRITE)


# ---- the skip rules -------------------------------------------------------------------

def get_skip_reason(rel, is_dir):
    """Why a path under H9XASH stays out of the package, or None."""
    low = rel.lower()
    parts = low.split('/')
    for d in SKIP_DIR_PATHS:
        if low == d or low.startswith(d + '/'):
            return 'folder ' + native(d)
    dir_parts = parts if is_dir else parts[:-1]
    for part in dir_parts:
        if part in SKIP_DIR_NAMES:
            return 'folder ' + part
    if is_dir:
        return None
    leaf = parts[-1]
    if leaf in SKIP_NAMES:
        return "a player's, a server's or a secret file"
    ext = get_extension(leaf)
    if ext in SKIP_EXT:
        return ext + ' file'
    for rx in SKIP_PATTERNS:
        if rx.search(leaf):
            return 'matches ' + rx.pattern
    return None


def is_windows_only(rel):
    low = rel.lower()
    for d in WINDOWS_ONLY_DIR_PATHS:
        if low == d or low.startswith(d + '/'):
            return True
    leaf = low.split('/')[-1]
    if get_extension(leaf) in WINDOWS_ONLY_EXT:
        return True
    for rx in WINDOWS_ONLY_PATTERNS:
        if rx.search(leaf):
            return True
    return False


def is_linux_only(rel):
    leaf = rel.lower().split('/')[-1]
    if leaf in LINUX_ONLY_NAMES:
        return True
    for rx in LINUX_ONLY_PATTERNS:
        if rx.search(leaf):
            return True
    return False


# ---- report and console ---------------------------------------------------------------

class Run(object):
    """The report, the warnings and the console output of one run."""

    def __init__(self, allow_ip):
        self.report = []
        self.warnings = []
        self.allow_ip = list(allow_ip)
        self.color = os.name != 'nt' and sys.stdout.isatty()

    def host(self, text):
        """Console only."""
        print(text)
        sys.stdout.flush()

    def say(self, text=''):
        """Console and report."""
        self.host(text)
        self.report.append(text)

    def note(self, text):
        """Report only."""
        self.report.append(text)

    def warn(self, text):
        line = '  [WARN] ' + text
        if self.color:
            line = '\x1b[33m' + line + '\x1b[0m'
        self.host(line)
        self.warnings.append(text)

    def write_report(self, report_path):
        os.makedirs(os.path.dirname(report_path), exist_ok=True)
        lines = list(self.report) + ['', 'Warnings:']
        if self.warnings:
            lines += ['  ' + w for w in self.warnings]
        else:
            lines.append('  none')
        with open(report_path, 'wb') as fh:
            fh.write((NEWLINE.join(lines) + NEWLINE).encode('latin-1', 'replace'))


# ---- scrubbing ------------------------------------------------------------------------

def is_public_ip(run, ip):
    p = [int(x) for x in ip.split('.')]
    if any(x > 255 for x in p):
        return False
    if ip in run.allow_ip or ip in EXAMPLE_IPS:
        return False
    if p[0] == 0 or p[0] == 10 or p[0] == 127 or p[0] >= 224:
        return False
    if p[0] == 169 and p[1] == 254:
        return False
    if p[0] == 172 and 16 <= p[1] <= 31:
        return False
    if p[0] == 192 and p[1] == 168:
        return False
    if p[0] == 100 and 64 <= p[1] <= 127:
        return False
    # TEST-NET-1/2/3, reserved for documentation
    if (p[0] == 192 and p[1] == 0 and p[2] == 2) or (p[0] == 198 and p[1] == 51 and p[2] == 100) or \
            (p[0] == 203 and p[1] == 0 and p[2] == 113):
        return False
    return True


def split_lines(text):
    """The lines of a text, each with its line end; only LF ends a line (a lone CR does not)."""
    parts = text.split('\n')
    lines = [p + '\n' for p in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def scrub_file(run, path, rel, reset_name=False):
    """Removes the lines of one config-like file that hold a secret, an id, a SteamID or a public IP.
    Returns how many lines went. The report names the setting or the kind, never the value."""
    text = read_latin1(path)
    is_ini = get_extension(os.path.basename(path)).lower() != '.cfg'
    kept = []
    removed = 0
    shown = native(rel)
    for i, line in enumerate(split_lines(text)):
        why = None
        m = RX_INI_SETTING.search(line) if is_ini else RX_CFG_SETTING.search(line)
        if m is None and is_ini:
            m = RX_CFG_SETTING.search(line)
        if m is not None:
            k = m.group('k').lower()
            v = m.group('v').strip(TRIM_CHARS).strip('"')
            if v != '' and v != '0' and (SECRET_KEY_EXACT.search(k) or SECRET_KEY_PART.search(k)):
                why = 'setting %s (value of %d characters)' % (k, len(v))
        if why is None and RX_STEAMID.search(line):
            why = 'a SteamID'
        # a version or build number such as 1.0.0.1 reads like an address; such lines are not IPs
        if why is None and not RX_VERSION_LINE.search(line):
            for ipm in RX_IPV4.finditer(line):
                if is_public_ip(run, ipm.group(0)):
                    why = 'a public IP address'
                    break
        if why is not None:
            removed += 1
            run.note('    %s line %d: removed, %s' % (shown, i + 1, why))
            continue
        if reset_name and RX_NAME_LINE.search(line):
            nl = '\r\n' if line.endswith('\r\n') else ('\n' if line.endswith('\n') else '')
            line = 'name "Player"' + nl
            run.note('    %s line %d: player name reset to Player' % (shown, i + 1))
        kept.append(line)
    new = ''.join(kept)
    if new != text:
        write_latin1(path, new)
    return removed


# ---- the Git LFS and cut-short-file check (tools/check-lfs.ps1) -----------------------

def lfs_short(path, size, ext):
    """Why a game file is not whole (its own header says it is longer than the file), or None."""
    def head(count):
        with open(path, 'rb') as fh:
            return fh.read(count)

    if ext == '.bsp':
        if size < 124:
            return 'a .bsp of %d bytes' % size
        h = head(124)
        magic = h[0:4]
        version = struct.unpack_from('<i', h, 0)[0]
        if version != 30 and magic != b'BSP2' and magic != b'2PSB':
            return 'not a GoldSrc or BSP2 map'
        need = 0
        for i in range(15):
            end = struct.unpack_from('<i', h, 4 + i * 8)[0] + struct.unpack_from('<i', h, 8 + i * 8)[0]
            if end > need:
                need = end
        if need > size:
            return 'its lumps end at %d bytes, the file has %d' % (need, size)
    elif ext == '.mdl':
        if size < 76:
            return 'a .mdl of %d bytes' % size
        h = head(76)
        if h[0:4] != b'IDST' and h[0:4] != b'IDSQ':
            return 'not a studio model'
        need = struct.unpack_from('<i', h, 72)[0]
        if need > size:
            return 'its header says %d bytes, the file has %d' % (need, size)
    elif ext == '.wad':
        if size < 12:
            return 'a .wad of %d bytes' % size
        h = head(12)
        if h[0:4] != b'WAD2' and h[0:4] != b'WAD3':
            return 'not a WAD'
        need = struct.unpack_from('<i', h, 8)[0] + struct.unpack_from('<i', h, 4)[0] * 32
        if need > size:
            return 'its directory ends at %d bytes, the file has %d' % (need, size)
    elif ext == '.pk3' or ext == '.zip':
        if size < 22:
            return 'an archive of %d bytes' % size
        tail = min(size, 65557)
        with open(path, 'rb') as fh:
            fh.seek(-tail, os.SEEK_END)
            buf = fh.read(tail)
        if buf.rfind(b'PK\x05\x06', 0, len(buf) - 22 + 4) < 0:
            return 'no end-of-archive record: cut short'
    return None


def check_lfs(paths, out=print):
    """Refuses game folders that hold Git LFS pointers or cut-short game files, as tools/check-lfs.ps1 does.
    Prints what it found and returns the number of problems (0: fine)."""
    problems = []
    checked = 0
    for p in paths:
        if not os.path.exists(p):
            continue
        root = os.path.abspath(p)
        if os.path.isfile(root):
            files = [(os.path.basename(root), root)]
        else:
            files = scan_tree(root, strict=False)[0]
        for _, f in files:
            checked += 1
            try:
                size = os.path.getsize(f)
            except OSError:
                continue
            if size < 1024:
                with open(f, 'rb') as fh:
                    if fh.read(len(LFS_POINTER)) == LFS_POINTER:
                        problems.append((f, 'a Git LFS pointer, not the file', True))
                        continue
            why = lfs_short(f, size, get_extension(os.path.basename(f)).lower())
            if why:
                problems.append((f, why, False))
    if not problems:
        out('  check-lfs: %d files, no Git LFS pointer and no cut-short game file' % checked)
        return 0
    lfs = sum(1 for p in problems if p[2])
    out('')
    out('STOP: %d of the files this needs are not whole (%d of them Git LFS pointers):' % (len(problems), lfs))
    for f, why, _ in problems[:25]:
        out('  %s  -- %s' % (f, why))
    if len(problems) > 25:
        out('  ... and %d more' % (len(problems) - 25))
    out('')
    if lfs > 0:
        out('This clone was made without Git LFS, which holds the maps, models and archives. To fix it:')
        out('  1. install Git LFS (https://git-lfs.com; Git for Windows includes it)')
        out('  2. in this checkout:   git lfs install')
        out('                         git lfs pull')
        out('then run this again. If git lfs pull fails with a quota or bandwidth error, the files are')
        out('not downloadable from that host right now; get them from a release ZIP instead.')
    else:
        out('Get these files again (git lfs pull, or git checkout -- <file>), then run this again.')
    return len(problems)


# ---- the ZIP writers ------------------------------------------------------------------

def zip_entry(name, mode, mtime):
    """An entry made as a Unix one: mode in the high half of the external attributes."""
    when = time.localtime(mtime)[:6]
    if when[0] < 1980:
        when = (1980, 1, 1, 0, 0, 0)
    zi = zipfile.ZipInfo(name, when)
    zi.create_system = 3
    zi.external_attr = mode << 16
    if stat.S_ISDIR(mode):
        zi.external_attr |= 0x10
    else:
        zi.compress_type = zipfile.ZIP_DEFLATED
    return zi


def copy_file_into(zf, zi, path, size, level):
    """Streams a file into the ZIP as the entry zi."""
    try:
        zi._compresslevel = level
    except AttributeError:
        pass
    with open(path, 'rb') as fh, zf.open(zi, 'w', force_zip64=size > 0x7fffffff) as dst:
        shutil.copyfileobj(fh, dst, 1 << 20)


def make_unix_zip(stage, out, skip=(), overlay=None, no_windows=False):
    """The staged H9XASH folder (less the skip list, plus the overlay folder when the build is native) as one
    H9XASH/ folder in a .zip made as a Unix one -- folders 0755, files 0644, .sh files and ELF binaries 0755,
    .sh files with LF line ends, in sorted order -- then read back and checked against those rules. unzip and
    Linux archive managers give the modes back.
      stage       the staged H9XASH folder
      out         the .zip to write
      skip        paths (relative to stage, with /) left out of the package
      overlay     a folder laid out like H9XASH whose files go in on top of the staged ones
      no_windows  the read-back refuses any .exe .dll .bat .cmd .ps1 in the package
    Returns the summary line; raises PackageStopped when the read-back finds a problem."""
    part = out + '.part'
    top = 'H9XASH'
    skip = set(slash(s) for s in skip)
    files = {}
    dirs = set([''])

    def add_dirs(rel):
        parts = rel.split('/')[:-1]
        for n in range(1, len(parts) + 1):
            dirs.add('/'.join(parts[:n]))

    def walk(base, skipping):
        for root, dnames, fnames in os.walk(base):
            dnames.sort()
            fnames.sort()
            rel_root = os.path.relpath(root, base).replace(os.sep, '/')
            if rel_root == '.':
                rel_root = ''
            if rel_root and not dnames and not fnames:
                dirs.add(rel_root)
            for f in fnames:
                rel = rel_root + '/' + f if rel_root else f
                if skipping and rel in skip:
                    continue
                files[rel] = os.path.join(root, f)
                add_dirs(rel)

    walk(stage, True)
    over_added = 0
    over_replaced = 0
    if overlay:
        before = dict(files)
        walk(overlay, False)
        over_replaced = sum(1 for r, p in before.items() if files[r] != p)
        over_added = len(files) - len(before)

    now = time.time()
    count = {'dirs': 0, 'files': 0, 'sh': 0, 'elf': 0}
    try:
        with zipfile.ZipFile(part, 'w', zipfile.ZIP_DEFLATED, allowZip64=True, compresslevel=6) as zf:
            for d in sorted(dirs):
                arc = top + '/' + d + '/' if d else top + '/'
                zf.writestr(zip_entry(arc, stat.S_IFDIR | 0o755, now), b'')
                count['dirs'] += 1
            for rel in sorted(files):
                p = files[rel]
                st = os.stat(p)
                arc = top + '/' + rel
                with open(p, 'rb') as fh:
                    head = fh.read(4)
                if rel.lower().endswith('.sh'):
                    with open(p, 'rb') as fh:
                        data = fh.read().replace(b'\r\n', b'\n')
                    zf.writestr(zip_entry(arc, stat.S_IFREG | 0o755, st.st_mtime), data)
                    count['sh'] += 1
                else:
                    elf = head == b'\x7fELF'
                    zi = zip_entry(arc, stat.S_IFREG | (0o755 if elf else 0o644), st.st_mtime)
                    copy_file_into(zf, zi, p, st.st_size, 6)
                    if elf:
                        count['elf'] += 1
                count['files'] += 1

        problems = []
        windows_ext = ('.exe', '.dll', '.bat', '.cmd', '.ps1')
        with zipfile.ZipFile(part) as zf:
            infos = zf.infolist()
            for zi in infos:
                if not zi.filename.startswith(top + '/'):
                    problems.append('outside H9XASH/: ' + zi.filename)
                if zi.create_system != 3:
                    problems.append('not a Unix entry: ' + zi.filename)
                if zi.is_dir():
                    continue
                mode = (zi.external_attr >> 16) & 0o777
                low = zi.filename.lower()
                if low.endswith('.sh'):
                    if mode != 0o755:
                        problems.append('mode %o: %s' % (mode, zi.filename))
                    if b'\r' in zf.read(zi):
                        problems.append('a CR in ' + zi.filename)
                elif zi.file_size >= 4:
                    with zf.open(zi) as fh:
                        if fh.read(4) == b'\x7fELF' and mode != 0o755:
                            problems.append('a binary at mode %o: %s' % (mode, zi.filename))
                if no_windows and low.endswith(windows_ext):
                    problems.append('a Windows file in a native package: ' + zi.filename)
            bad = zf.testzip()
            if bad:
                problems.append('bad CRC: ' + bad)
        if len(infos) != count['dirs'] + count['files']:
            problems.append('%d entries read back, %d written' % (len(infos), count['dirs'] + count['files']))
        if problems:
            raise PackageStopped('; '.join(problems[:10]))
        os.replace(part, out)
    finally:
        if os.path.exists(part):
            os.remove(part)
    line = '%d files in %d folders, all under H9XASH/' % (count['files'], count['dirs'])
    if overlay:
        line += '; %d from the native build folder, %d of them over staged files' % (
            over_added + over_replaced, over_replaced)
    line += '; %d .sh file(s) and %d binaries at mode 0755; read back and checked' % (count['sh'], count['elf'])
    return line


def make_windows_zip(files, empty_dirs, out, level):
    """The Windows package: one H9XASH/ folder, forward slashes, entries for the folders that are empty on
    purpose (the AMXX vault and logs), no Unix modes. files are (rel, path) pairs; returns how many were
    written. The ZIP is read back before it is put in place."""
    part = out + '.part'
    top = 'H9XASH'
    written = 0
    try:
        with zipfile.ZipFile(part, 'w', zipfile.ZIP_DEFLATED, allowZip64=True, compresslevel=level) as zf:
            now = time.localtime(time.time())[:6]
            for d in empty_dirs:
                zi = zipfile.ZipInfo(top + '/' + d + '/', now)
                zi.create_system = 0
                zf.writestr(zi, b'')
                zi.external_attr = 0
            for rel, path in files:
                st = os.stat(path)
                when = time.localtime(st.st_mtime)[:6]
                if when[0] < 1980:
                    when = (1980, 1, 1, 0, 0, 0)
                zi = zipfile.ZipInfo(top + '/' + rel, when)
                zi.create_system = 0
                zi.compress_type = zipfile.ZIP_DEFLATED
                copy_file_into(zf, zi, path, st.st_size, level)
                # zipfile gives a streamed entry 0600 when it has no attributes; the central directory is
                # written at close, so the attributes can be cleared now (a Windows ZIP carries none)
                zi.external_attr = 0
                written += 1
        with zipfile.ZipFile(part) as zf:
            if len(zf.infolist()) != len(empty_dirs) + written:
                raise PackageStopped('%d entries read back, %d written' % (len(zf.infolist()), len(empty_dirs) + written))
            bad = zf.testzip()
            if bad:
                raise PackageStopped('bad CRC: ' + bad)
        os.replace(part, out)
    finally:
        if os.path.exists(part):
            os.remove(part)
    return written


# ---- the game running from the folder -------------------------------------------------

def processes_running_from(folder):
    """Names of the programs started from a file under folder (best effort: /proc on Linux, the process list
    through ctypes on Windows, nothing elsewhere)."""
    found = []
    try:
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            psapi = ctypes.WinDLL('psapi')
            k32 = ctypes.WinDLL('kernel32')
            k32.OpenProcess.restype = wintypes.HANDLE
            k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k32.CloseHandle.argtypes = [wintypes.HANDLE]
            k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                       ctypes.POINTER(wintypes.DWORD)]
            ids = (wintypes.DWORD * 8192)()
            needed = wintypes.DWORD()
            if not psapi.EnumProcesses(ids, ctypes.sizeof(ids), ctypes.byref(needed)):
                return []
            prefix = os.path.normcase(folder)
            for pid in ids[:needed.value // ctypes.sizeof(wintypes.DWORD)]:
                handle = k32.OpenProcess(0x1000, False, pid)
                if not handle:
                    continue
                try:
                    buf = ctypes.create_unicode_buffer(32768)
                    size = wintypes.DWORD(len(buf))
                    if k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                        if os.path.normcase(buf.value).startswith(prefix):
                            found.append(os.path.splitext(os.path.basename(buf.value))[0])
                finally:
                    k32.CloseHandle(handle)
        elif os.path.isdir('/proc'):
            for pid in os.listdir('/proc'):
                if not pid.isdigit():
                    continue
                try:
                    exe = os.readlink('/proc/%s/exe' % pid)
                except OSError:
                    continue
                if exe.startswith(folder):
                    found.append(os.path.basename(exe))
    except Exception:
        return []
    unique = []
    for n in found:
        if n not in unique:
            unique.append(n)
    return unique


# ---- the run --------------------------------------------------------------------------

def compression_name(text):
    """Optimal or Fastest, in any case (the ValidateSet of the PowerShell parameter)."""
    return text.strip().capitalize()


def parse_args(argv):
    ap = argparse.ArgumentParser(
        prog='stage-h9xash', allow_abbrev=False,
        description='Packs H9XASH into clean client ZIPs for players (stage-h9xash.ps1, for any system).')

    def opt(names, **kw):
        ap.add_argument(*names, **kw)

    opt(['--source', '-Source'], help='the H9XASH folder to pack (default: H9XASH beside this script)')
    opt(['--out-dir', '--outdir', '-OutDir'], help='where the ZIPs and the report go (default: dist)')
    opt(['--stage-dir', '--stagedir', '-StageDir'], help='where the temporary copy is built (default: .stage in the out dir)')
    opt(['--name', '-Name'], help='the ZIP name without .zip (default: H9XASH)')
    opt(['--allow-ip', '--allowip', '-AllowIp'], nargs='+', action='extend', default=[],
        help='public IP addresses that may stay in config files')
    opt(['--dry-run', '--dryrun', '-DryRun'], action='store_true', help='stage and scrub, write the report, no ZIP')
    opt(['--keep-stage', '--keepstage', '-KeepStage'], action='store_true', help='keep the staged folder')
    opt(['--no-linux', '--nolinux', '-NoLinux'], action='store_true', help='the Windows ZIP only')
    opt(['--linux-native', '--linuxnative', '-LinuxNative'],
        help='the native Linux build, a folder laid out like H9XASH (default: H9XASH-linux)')
    opt(['--files-dir', '--filesdir', '-FilesDir'], help='where the web files for H9XASH-Updater go')
    opt(['--no-web-files', '--nowebfiles', '-NoWebFiles'], action='store_true', help='publish no web files')
    opt(['--compression', '-Compression'], default='Optimal', type=compression_name,
        choices=['Optimal', 'Fastest'], help='deflate level of the Windows ZIP')
    opt(['--here'], help='the folder with tools/ and havoc9.org/ and the default paths (default: this script\'s)')
    opt(['--check-lfs'], nargs='+', metavar='PATH',
        help='only check the paths for Git LFS pointers and cut-short game files')
    return ap.parse_args(argv)


def stage_main(a):
    here = full_path(a.here) if a.here else HERE
    source = a.source or os.path.join(here, 'H9XASH')
    out_dir = a.out_dir or os.path.join(here, 'dist')
    stage_dir = a.stage_dir or os.path.join(out_dir, '.stage')
    files_dir = a.files_dir or os.path.join(out_dir, 'files')
    linux_native = a.linux_native or os.path.join(here, 'H9XASH-linux')
    allow_ip = []
    for item in a.allow_ip:
        allow_ip += [x for x in re.split(r'[,\s]+', item) if x]
    run = Run(allow_ip)
    say, warn = run.say, run.warn

    # ---- checks before anything is copied
    source = full_path(source)
    if not os.path.isdir(os.path.join(source, 'ts')):
        raise Stop('No H9XASH at %s (no ts folder in it). Give the folder with --source.' % source)
    root = os.path.dirname(source)
    out_dir = full_path(out_dir)

    # A clone made without Git LFS holds pointer files in place of the maps, models and archives, and
    # the ZIP would ship them.
    if check_lfs([source]) != 0:
        raise Stop('H9XASH holds Git LFS pointers or cut-short game files (listed above); no ZIP was written.')

    build = 'local'
    version_file = os.path.join(root, 'VERSION.txt')
    if os.path.isfile(version_file):
        with open(version_file, 'r', encoding='utf-8-sig', errors='replace') as fh:
            for line in fh:
                vm = re.match(r'\s*Build:\s*(\S+)', line, re.IGNORECASE)
                if vm:
                    build = vm.group(1)
                    break
    stamp = time.strftime('%Y%m%d-%H%M')
    name = a.name or 'H9XASH'
    zip_path = os.path.join(out_dir, name + '.zip')
    linux_zip = os.path.join(out_dir, name + '-linux.zip')
    report_path = os.path.join(out_dir, name + '.report.txt')

    say('stage-h9xash: ' + source)
    say('  build %s, %s' % (build, time.strftime('%Y-%m-%d %H:%M:%S')))

    # The game may be running from this folder. It is never stopped here; the files it writes
    # (config.cfg, logs, histories) are left out anyway.
    running = processes_running_from(source)
    if running:
        warn('the game is running from this folder (%s); files it is writing are left out anyway' % ', '.join(running))

    stage_base = os.path.join(full_path(stage_dir), 'h9xash-stage-%s-%d' % (stamp, os.getpid()))
    stage = os.path.join(stage_base, 'H9XASH')

    all_files, all_dirs = scan_tree(source)
    source_bytes = 0
    for _, p in all_files:
        try:
            source_bytes += os.path.getsize(p)
        except OSError:
            pass
    probe = stage_base
    while not os.path.exists(probe) and os.path.dirname(probe) != probe:
        probe = os.path.dirname(probe)
    free = shutil.disk_usage(probe).free
    if free < source_bytes * 1.1:
        drive = os.path.splitdrive(stage_base)[0].rstrip(':') or probe
        raise Stop('Not enough free space for the stage on %s: about %s MB needed, %s MB free.' % (
            drive, n0(source_bytes / MB * 1.1), n0(free / MB)))

    # ---- copy what goes in
    say('')
    say('1. copying into ' + stage)
    skipped = []
    copied = 0
    os.makedirs(stage, exist_ok=True)
    for rel in all_dirs:
        if not get_skip_reason(rel, True):
            os.makedirs(os.path.join(stage, rel.replace('/', os.sep)), exist_ok=True)
    for rel, path in all_files:
        why = get_skip_reason(rel, False)
        if why:
            skipped.append('    %s  (%s)' % (native(rel), why))
            continue
        dest = os.path.join(stage, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        copy_into_stage(path, dest)
        copied += 1
    for d in RECREATE_DIRS:
        if is_dir_at(source, d):
            os.makedirs(os.path.join(stage, d.replace('/', os.sep)), exist_ok=True)
    say('  %d files copied, %d left out:' % (copied, len(skipped)))
    for s in skipped:
        run.note(s)
    run.host('  (the list is in the report)')

    # ---- stock files for a new player
    say('')
    say('2. stock files a new player starts from')
    for r in REPLACEMENTS:
        at = r['at']
        dest = os.path.join(stage, at.replace('/', os.sep))
        frm = None
        shown_from = None
        for c in r['sources']:
            if is_file_at(root, c):
                frm = find_path(root, c)
                shown_from = os.path.join(root, native(c))
                break
        if frm:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            copy_into_stage(frm, dest)
            say('  %s <- %s' % (native(at), shown_from))
            continue
        mine = find_path(source, at)
        if mine is None or not os.path.isfile(mine):
            say('  %s: none in H9XASH and no stock copy, left out' % native(at))
            continue
        if r['fallback'] == 'scrub':
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            copy_into_stage(mine, dest)
            n = scrub_file(run, dest, at, reset_name=True)
            warn("%s: no stock copy found beside H9XASH, so this install's own was scrubbed instead (%d lines removed)"
                 % (native(at), n))
        else:
            say('  %s: no stock copy, left out' % native(at))

    # ---- the Linux package's own files
    linux_ok = False
    if not a.no_linux:
        say('')
        say('2b. Linux files (h9xash.sh, h9_userid.sh, README_LINUX.txt)')
        overlay = os.path.join(root, 'xash3d-h9-patches', 'overlay')
        linux_ok = True
        for lf in LINUX_FILES:
            dest = find_path(stage, lf)
            have = dest is not None and os.path.isfile(dest)
            ov = find_path(overlay, lf)
            ov_file = ov is not None and os.path.isfile(ov)
            if not have:
                if ov_file:
                    copy_into_stage(ov, os.path.join(stage, lf))
                    say('  %s <- %s (H9XASH has none yet; xash.bat assets puts it there)' % (lf, ov))
                else:
                    warn('%s is in neither H9XASH nor the overlay, so there is no Linux package' % lf)
                    linux_ok = False
            elif ov_file and sha256_of(dest) != sha256_of(ov):
                warn("%s in H9XASH differs from the overlay's; H9XASH's goes out (xash.bat assets brings the overlay's in)" % lf)
        # a Windows checkout may have given the .sh files CRLF line ends; bash on Linux needs LF
        lf_fixed = 0
        for rel, path in scan_tree(stage)[0]:
            if get_extension(os.path.basename(path)).lower() != '.sh':
                continue
            t = read_latin1(path)
            if '\r\n' in t:
                write_latin1(path, t.replace('\r\n', '\n'))
                lf_fixed += 1
        say('  .sh files given LF line ends: %d' % lf_fixed)
        if linux_ok:
            say("  the Linux packages are written by Python %s's zipfile (Unix mode 0755 on the .sh files and the binaries)"
                % sys.version.split()[0])

    # ---- scrub what is left
    say('')
    say('3. scrubbing config files (passwords, keys, tokens, player ids, SteamIDs, public IPs)')
    scrubbed_files = 0
    scrubbed_lines = 0
    for rel, path in scan_tree(stage)[0]:
        ext = get_extension(os.path.basename(path)).lower()
        if ext not in CONFIG_EXT or os.path.getsize(path) > 4 * MB:
            continue
        n = scrub_file(run, path, rel)
        if n > 0:
            scrubbed_files += 1
            scrubbed_lines += n
    say('  %d lines removed from %d files (listed in the report, values never shown)' % (scrubbed_lines, scrubbed_files))

    # ---- final scan
    say('')
    say('4. final scan')
    stops = []
    stage_files = scan_tree(stage)[0]
    replacement_ats = set(r['at'].lower() for r in REPLACEMENTS)
    for rel, path in stage_files:
        shown = native(rel)
        if rel.lower() not in replacement_ats:
            why = get_skip_reason(rel, False)
            if why:
                stops.append('%s is still in the stage (%s)' % (shown, why))
        ext = get_extension(os.path.basename(path)).lower()
        if ext not in TEXT_EXT or os.path.getsize(path) > 8 * MB:
            continue
        text = read_latin1(path)
        for why, rx in RX_HARD:
            if rx.search(text):
                stops.append('%s holds a %s' % (shown, why))
        if ext not in CONFIG_EXT:
            # documents and scripts are reported, not edited
            if RX_STEAMID.search(text):
                warn('%s mentions a SteamID (documentation or script, left as is)' % shown)
            pub = []
            for m in RX_IPV4.finditer(text):
                if is_public_ip(run, m.group(0)) and m.group(0) not in pub:
                    pub.append(m.group(0))
            if pub:
                warn('%s mentions %d public IP address(es) (documentation or script, left as is)' % (shown, len(pub)))
    for e in ESSENTIALS:
        if find_path(source, e) is not None and find_path(stage, e) is None:
            stops.append('%s is in H9XASH but missing from the stage' % native(e))

    if stops:
        say('  STOPPED, nothing was zipped:')
        for s in stops:
            say('    ' + s)
        run.write_report(report_path)
        say('  stage kept for a look: ' + stage)
        say('  report: ' + report_path)
        return 1
    say('  clean: no tokens, webhooks or private keys; nothing left out came back; essentials present')

    # ---- what goes in which package
    say('')
    say('4b. the two packages')
    stage_rels = [r for r, _ in stage_files]
    linux_only_rels = [r for r in stage_rels if is_linux_only(r)]
    windows_only_rels = [r for r in stage_rels if is_windows_only(r)]

    # A native Linux build is a folder laid out like H9XASH (xash3d, libxash.so, ts/dlls/ts_i386.so, a launcher ...).
    linux_native = full_path(linux_native)
    native_count = 0
    native_client = False
    native_server = False
    native_is_dir = os.path.isdir(linux_native)
    if native_is_dir:
        native_count = len(scan_tree(linux_native)[0])
        native_client = is_file_at(linux_native, 'xash3d')
        native_server = is_file_at(linux_native, 'xashds')
    server_zip = os.path.join(out_dir, name + '-linux-server.zip')
    make_server_zip = linux_ok and (not native_client) and native_server
    linux_kind = 'native' if native_client else 'wine'

    say('  Windows package %s: %d files, the %d Linux-only files left out' % (
        name + '.zip', len(stage_rels) - len(linux_only_rels), len(linux_only_rels)))
    if a.no_linux:
        say('  Linux package: none (--no-linux)')
    elif not linux_ok:
        say('  Linux package: none (the Linux launcher files are missing, see 2b)')
    elif native_client:
        say('  Linux package %s: native build from %s (%d files); the %d Windows-only and %d Linux-only files of '
            'H9XASH stay out, the build brings its own' % (
                name + '-linux.zip', linux_native, native_count, len(windows_only_rels), len(linux_only_rels)))
    else:
        if native_is_dir:
            warn('%s holds no xash3d client (%d files): %s-linux.zip is the Wine/Proton package, the Windows game '
                 'with h9xash.sh' % (linux_native, native_count, name))
        else:
            warn('no native Linux build (%s, --linux-native): %s-linux.zip is the Wine/Proton package, the Windows '
                 'game with h9xash.sh (docs%sLINUX_SUPPORT.txt)' % (linux_native, name, os.sep))
        say('  Linux package %s-linux.zip: Wine/Proton package, the Windows game with h9xash.sh' % name)
    if make_server_zip:
        say('  Linux dedicated server package %s: native build from %s (xashds, no client)' % (
            name + '-linux-server.zip', linux_native))
    elif os.path.isfile(server_zip) and not a.dry_run:
        warn('an older %s is in %s; this run made no dedicated server package' % (server_zip, out_dir))
    if native_client or make_server_zip:
        # what a native package needs from its build folder, since H9XASH's own Linux files are left out of it
        dlls = find_path(linux_native, 'ts/dlls')
        has_so = False
        if dlls is not None and os.path.isdir(dlls):
            has_so = any(n.lower().endswith('.so') for n in os.listdir(dlls))
        if not has_so:
            warn('the native build has no game library in %s (ts_i386.so), so its package cannot start a match'
                 % os.path.join(linux_native, 'ts', 'dlls'))
        launcher = 'h9xash.sh' if native_client else 'h9xash_server.sh'
        if not is_file_at(linux_native, launcher):
            warn('the native build has no %s launcher in %s; its package has none' % (launcher, linux_native))
        for gf in ('gameinfo.txt', 'liblist.gam'):
            if not is_file_at(linux_native, 'ts/' + gf):
                warn('the native build has no ts%s%s in %s: the staged one names no Linux game library for Metamod '
                     '(gamedll_linux), so the game would start without Metamod and AMX Mod X' % (
                         os.sep, gf, linux_native))
    run.note('  left out of the Windows package (Linux-only):')
    for r in linux_only_rels:
        run.note('    ' + native(r))
    if native_client or make_server_zip:
        run.note('  left out of a native Linux package (Windows-only, and the stock Linux files the build replaces):')
        for r in windows_only_rels + linux_only_rels:
            run.note('    ' + native(r))

    # ---- zip
    if a.dry_run:
        run.write_report(report_path)
        say('')
        say('Dry run: no ZIP. Stage kept: ' + stage)
        say('Report: ' + report_path)
        return 0

    os.makedirs(out_dir, exist_ok=True)
    level = 1 if a.compression == 'Fastest' else 6

    say('')
    say('5. Windows package: ' + zip_path)
    if os.path.exists(zip_path):
        os.remove(zip_path)
    leave_out = set(r.lower() for r in linux_only_rels)
    # the folders that are empty on purpose (the AMXX vault and logs) get an entry of their own
    empty_dirs = []
    for d in scan_tree(stage)[1]:
        if not os.listdir(os.path.join(stage, d.replace('/', os.sep))):
            empty_dirs.append(d)
    win_list = [(r, p) for r, p in stage_files if r.lower() not in leave_out]
    try:
        win_files = make_windows_zip(win_list, empty_dirs, zip_path, level)
    except PackageStopped as e:
        say('  STOPPED: ' + str(e))
        run.write_report(report_path)
        say('  report: ' + report_path)
        return 1
    say('  %s files, %s MB, SHA-256 %s' % (n0(win_files), n0(os.path.getsize(zip_path) / float(MB)),
                                         sha256_of(zip_path).upper()))

    # ---- the Linux packages
    if linux_ok:
        jobs = [(linux_zip, linux_kind, 'Linux package (native)' if native_client else 'Linux package (Wine/Proton)')]
        if make_server_zip:
            jobs.append((server_zip, 'native', 'Linux dedicated server package (native)'))
        step = 6
        for out_zip, kind, label in jobs:
            say('')
            say('%d. %s: %s' % (step, label, out_zip))
            step += 1
            if os.path.exists(out_zip):
                os.remove(out_zip)
            made = None
            try:
                if kind == 'native':
                    line = make_unix_zip(stage, out_zip, skip=windows_only_rels + linux_only_rels,
                                         overlay=linux_native, no_windows=True)
                else:
                    line = make_unix_zip(stage, out_zip)
                say('  ' + line)
                made = out_zip
            except PackageStopped as e:
                say('  STOPPED: ' + str(e))
                warn('%s was not made (Python exit 1); the Windows ZIP is done' % out_zip)
            if made:
                say('  %s MB, SHA-256 %s' % (n0(os.path.getsize(made) / float(MB)), sha256_of(made).upper()))

    # ---- the web files for H9XASH-Updater
    if not a.no_web_files:
        say('')
        files_dir = full_path(files_dir)
        publisher = os.path.join(here, 'tools', 'updater', 'publish_files.py')
        if not os.path.exists(publisher):
            warn('no %s, so no web files for H9XASH-Updater were published' % publisher)
        else:
            say('7. web files for H9XASH-Updater: %s (Python %s)' % (files_dir, sys.version.split()[0]))
            seed_args = []
            for r in REPLACEMENTS:
                if is_file_at(stage, r['at']):
                    seed_args += ['--seed', r['at']]
            cmd = [sys.executable, '-I', publisher, stage, files_dir, '--build', build, '--name', name] + seed_args
            sys.stdout.flush()
            proc = subprocess.run(cmd, stdout=subprocess.PIPE)
            for l in proc.stdout.decode('utf-8', 'replace').splitlines():
                say('  ' + l)
            if proc.returncode != 0:
                warn('the web files were not published (Python exit %d); the ZIPs are done' % proc.returncode)
            else:
                say("  copy %s to the site's files/ (tools%supdater%sREADME_UPDATER.txt, section 3)" % (
                    files_dir, os.sep, os.sep))

    # The downloads page beside this script links the two packages by name and shows the build.
    page = os.path.join(here, 'havoc9.org', 'downloads', 'index.html')
    if os.path.exists(page):
        html = read_latin1(page)
        for want in ('href="%s.zip"' % name, 'href="%s-linux.zip"' % name):
            if want not in html:
                warn('the downloads page (%s) has no %s' % (page, want))
        if ('Version %s<' % build) not in html:
            warn('the downloads page does not show Version %s; update its two download notes' % build)

    if a.keep_stage:
        say('  stage kept: ' + stage)
    else:
        remove_tree(stage_base)

    run.write_report(report_path)
    say('Report: ' + report_path)
    if run.warnings:
        run.host('%d warning(s); see the report.' % len(run.warnings))
    return 0


def main(argv=None):
    a = parse_args(sys.argv[1:] if argv is None else argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except (AttributeError, ValueError):
            pass
    if a.check_lfs:
        return 1 if check_lfs(a.check_lfs) else 0
    try:
        return stage_main(a)
    except Stop as e:
        sys.stdout.flush()
        print(str(e), file=sys.stderr)
        return 1
    except OSError as e:
        sys.stdout.flush()
        print('stage-h9xash: %s' % e, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
