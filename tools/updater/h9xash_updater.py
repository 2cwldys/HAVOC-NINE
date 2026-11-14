#!/usr/bin/env python3
# H9XASH-Updater: installs H9XASH, H9's client for The Specialists on Xash3D FWGS, into a folder and
# keeps it up to date, downloading and copying only the files that changed: from havoc9.org's
# files/ (the build stage-h9xash.ps1 publishes there), or for developers from the HAVOC-NINE git
# repository, or from the published H9XASH.zip.
#
#   H9XASH-Updater.exe            asks for the folder, offers the account link on first run, updates
#   H9XASH-Updater.exe --help     every option
#
# README_UPDATER.txt beside this file says what it does, what it never touches, and how build.cmd
# makes dist\H9XASH-Updater.exe from it. Python 3 standard library only.

import argparse
import ctypes
import gzip
import hashlib
import http.client
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import zipfile

import h9link

VERSION = '1.1.0'
WEB_URL = 'https://havoc9.org/files/'
REPO_URL = 'https://github.com/2cwldys/HAVOC-NINE.git'
BRANCH = 'main'
ZIP_URL = 'https://havoc9.org/downloads/H9XASH.zip'
GIT_FOR_WINDOWS = 'https://git-scm.com/download/win'
GIT_LFS_SITE = 'https://git-lfs.com'
GAME_EXE = 'HAVOC 9.exe'
STATE_DIR = '.h9xash-updater'
USER_AGENT = 'H9XASH-Updater/' + VERSION
# What the site's files/ answers to (stage-h9xash.ps1 publishes them, the server's rule hides them):
# without this header and this User-Agent, every address there is a 404.
WEB_HEADERS = {'User-Agent': USER_AGENT, 'X-H9-Updater': '1'}
LFS_POINTER = b'version https://git-lfs.github.com/spec/v1'
HEX64 = re.compile(r'^[0-9a-f]{64}$')

# What the git cache checks out: H9XASH itself, plus the few repo files the updater reads (the
# release's own build number, the packer's rules, the stock networking.ini a new install starts from).
SPARSE_PATTERNS = ['/.gitattributes', '/H9XASH/', '/VERSION.txt', '/stage-h9xash.ps1',
                   '/xash3d-h9-patches/overlay/networking.ini']


class UpdaterError(Exception):
    pass


# ---- player files ------------------------------------------------------------------------------
# The rules stage-h9xash.ps1 (repo root) packs the client ZIP by: everything they leave out belongs
# to one player or one server and is never installed, overwritten, removed or rolled back here.
# The release's own stage-h9xash.ps1 is read too, and whatever it adds joins these lists.

SKIP_DIR_NAMES = ['logs', 'save', 'screenshots', 'scrshots', 'ts_downloads', 'downloads',
                  '.fontcache', 'userconfig.d', '__pycache__', '.venv', 'venv', '.git', 'node_modules',
                  'drive_c', 'dosdevices', STATE_DIR]
SKIP_DIR_PATHS = ['presets\\backup', 'ts\\addons\\amxmodx\\data\\vault', 'ts\\addons\\amxmodx\\data\\sqlite3', 'webview2\\data',
                  'webview2\\runtime']
RECREATE_DIRS = ['ts\\addons\\amxmodx\\data\\vault', 'ts\\addons\\amxmodx\\data\\sqlite3', 'ts\\addons\\amxmodx\\logs']
SKIP_NAMES = ['console_history.txt', 'history_servers.lst', 'favorite_servers.lst', 'xashcomm.lst',
              'user_id.ini', 'device_id.ini', '.xash_id',
              'config.cfg', 'video.cfg', 'opengl.cfg', 'custom.hpk', 'voice_ban.dt', 'tempdecal.wad',
              'tsstats.dat', 'vault.ini', 'bot_playerids.ini',
              'ts_advertise.cfg', 'ts_advertise_local.cfg', 'h9_presence.cfg',
              'listip.cfg', 'banned.cfg', 'mail.env', 'accounts.json', 'networking.ini',
              'thumbs.db', 'desktop.ini', '.ds_store',
              '.gitattributes', 'system.reg', 'user.reg', 'userdef.reg', '.update-timestamp']
SKIP_EXT = ['.log', '.pid', '.tmp', '.new', '.orig', '.rej', '.dmp', '.mdmp', '.dem', '.env', '.key', '.sav']
SKIP_PATTERNS = [r'\.bak($|[._-])', r'_resolved\.cfg$', r'^user_id\.ini', r'^device_id\.ini',
                 r'^h9_presence.*\.(key|cfg\.bak.*)$', r'downloadstsm', r'\.(sq3|sqlite3?|db)(-journal|-wal|-shm)?$']

_PS_LIST = re.compile(r'^[ \t]*\$(SkipDirNames|SkipDirPaths|SkipNames|SkipExt|SkipPatterns)[ \t]*\+?=[ \t]*@\(',
                      re.M | re.I)


def _ps_strings(text, pos):
    """The single-quoted strings of a PowerShell @( ... ) list that starts at pos, or None."""
    out, i, n = [], pos, len(text)
    while i < n:
        c = text[i]
        if c == "'":
            j, buf = i + 1, []
            while j < n:
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        buf.append("'")
                        j += 2
                        continue
                    break
                buf.append(text[j])
                j += 1
            out.append(''.join(buf))
            i = j + 1
        elif c == ')':
            return out
        elif c == '#':
            nl = text.find('\n', i)
            i = n if nl < 0 else nl
        elif c in ' \t\r\n,':
            i += 1
        else:
            return None
    return None


def dotnet_ext(leaf):
    """The extension as .NET's Path.GetExtension gives it: '.env' for '.env', '' for 'name.'."""
    i = leaf.rfind('.')
    if i < 0 or i == len(leaf) - 1:
        return ''
    return leaf[i:]


class Rules:
    def __init__(self):
        self.dir_names = set(SKIP_DIR_NAMES)
        self.dir_paths = list(SKIP_DIR_PATHS)
        self.names = set(SKIP_NAMES) | set(n.lower() for n in h9link.PLAYER_FILES)
        self.exts = set(SKIP_EXT)
        self.patterns = [re.compile(p, re.I) for p in SKIP_PATTERNS]
        self.added = 0

    def add_from_stage_script(self, text):
        known = set(p.pattern for p in self.patterns)
        for m in _PS_LIST.finditer(text):
            values = _ps_strings(text, m.end())
            if not values:
                continue
            which = m.group(1).lower()
            for v in values:
                low = v.lower()
                if which == 'skipdirnames' and low not in self.dir_names:
                    self.dir_names.add(low)
                elif which == 'skipdirpaths' and low.replace('/', '\\') not in self.dir_paths:
                    self.dir_paths.append(low.replace('/', '\\'))
                elif which == 'skipnames' and low not in self.names:
                    self.names.add(low)
                elif which == 'skipext' and low not in self.exts:
                    self.exts.add(low)
                elif which == 'skippatterns' and v not in known:
                    try:
                        self.patterns.append(re.compile(v, re.I))
                        known.add(v)
                    except re.error:
                        continue
                else:
                    continue
                self.added += 1

    def skip_reason(self, rel, is_dir=False):
        low = rel.replace('/', '\\').lower()
        parts = low.split('\\')
        for d in self.dir_paths:
            if low == d or low.startswith(d + '\\'):
                return 'folder ' + d
        for part in (parts if is_dir else parts[:-1]):
            if part in self.dir_names:
                return 'folder ' + part
        if is_dir:
            return None
        leaf = parts[-1]
        if leaf in self.names:
            return "a player's, a server's or a secret file"
        ext = dotnet_ext(leaf)
        if ext in self.exts:
            return ext + ' file'
        for rx in self.patterns:
            if rx.search(leaf):
                return 'matches ' + rx.pattern
        return None


# ---- small helpers -----------------------------------------------------------------------------

def xp(path):
    """path in the form Windows file calls take past 260 characters."""
    if os.name != 'nt':
        return path
    path = os.path.abspath(path)
    if path.startswith('\\\\?\\'):
        return path
    if path.startswith('\\\\'):
        return '\\\\?\\UNC\\' + path[2:]
    return '\\\\?\\' + path


def native(rel):
    return rel.replace('/', os.sep)


def sha256_file(path):
    h = hashlib.sha256()
    with open(xp(path), 'rb') as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def mb(n):
    return '%.0f MB' % (n / 1048576.0) if n >= 1048576 else '%.1f MB' % (n / 1048576.0)


def load_json(path):
    try:
        with open(xp(path), 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_json(path, data):
    """Writes path through a temporary name, so a crash leaves the old file or the new one."""
    tmp = path + '.tmp'
    with open(xp(tmp), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(xp(tmp), xp(path))


def rmtree(path):
    def onerr(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    if os.path.isdir(xp(path)):
        shutil.rmtree(xp(path), onerror=onerr)


def exe_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def looks_like_h9xash(path):
    return os.path.isfile(os.path.join(path, GAME_EXE)) or os.path.isdir(os.path.join(path, 'ts'))


class Progress:
    """One console line that rewrites itself at most four times a second."""

    def __init__(self, label):
        self.label = label
        self.last = 0.0
        self.shown = False
        self.tty = sys.stdout is not None and sys.stdout.isatty()

    def update(self, text, force=False):
        now = time.monotonic()
        if self.tty and (force or now - self.last >= 0.25):
            self.last = now
            line = '  %s: %s' % (self.label, text)
            sys.stdout.write('\r' + line[:110].ljust(110))
            sys.stdout.flush()
            self.shown = True

    def done(self, text=None):
        if text is not None:
            self.update(text, force=True)
        if self.shown:
            sys.stdout.write('\n')
            sys.stdout.flush()


class Log:
    """Console output, and a dated copy of it in the install's updater.log."""

    def __init__(self):
        self.f = None
        self.pending = []

    def attach(self, path):
        try:
            if os.path.isfile(path) and os.path.getsize(path) > 4 * 1048576:
                os.replace(path, path + '.1')
            self.f = open(path, 'a', encoding='utf-8')
        except OSError as e:
            print('  (no log file: %s)' % e)
            return
        self.f.write('\n')
        for line in self.pending:
            self.f.write(line + '\n')
        self.f.flush()
        self.pending = []

    def note(self, text):
        line = time.strftime('%Y-%m-%d %H:%M:%S  ') + text
        if self.f:
            self.f.write(line + '\n')
            self.f.flush()
        else:
            self.pending.append(line)

    def say(self, text=''):
        print(text, flush=True)
        self.note(text)

    def close(self):
        if self.f:
            self.f.close()
            self.f = None


LOG = Log()


# ---- processes and the folder lock -------------------------------------------------------------

def _k32():
    from ctypes import wintypes
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                               ctypes.POINTER(wintypes.DWORD)]
    k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k32.K32EnumProcesses.argtypes = [ctypes.POINTER(wintypes.DWORD), wintypes.DWORD,
                                     ctypes.POINTER(wintypes.DWORD)]
    return k32, wintypes


def processes_in(folder):
    """(pid, program path) of each running program whose file is inside folder, this one aside."""
    if os.name != 'nt':
        return []
    k32, wt = _k32()
    size = 4096
    while True:
        arr = (wt.DWORD * size)()
        needed = wt.DWORD()
        if not k32.K32EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(needed)):
            return []
        if needed.value < ctypes.sizeof(arr):
            break
        size *= 2
    base = os.path.normcase(os.path.realpath(folder)).rstrip('\\') + '\\'
    mine = {os.getpid(), os.getppid()}
    found = []
    for pid in arr[:needed.value // 4]:
        if not pid or pid in mine:
            continue
        h = k32.OpenProcess(0x1000, False, pid)
        if not h:
            continue
        try:
            buf = ctypes.create_unicode_buffer(32768)
            n = wt.DWORD(32768)
            if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                if os.path.normcase(buf.value).startswith(base):
                    found.append((pid, buf.value))
        finally:
            k32.CloseHandle(h)
    return found


def pid_alive(pid):
    if os.name != 'nt':
        return False
    k32, wt = _k32()
    h = k32.OpenProcess(0x1000, False, pid)
    if not h:
        return False
    try:
        code = wt.DWORD()
        return bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259
    finally:
        k32.CloseHandle(h)


def refuse_if_running(install):
    running = processes_in(install)
    if running:
        names = sorted(set(os.path.basename(p) for _, p in running))
        raise UpdaterError('%s is running from this folder (%s). Close it, then run the updater again.'
                           % (' and '.join(names), install))


class FolderLock:
    def __init__(self, state):
        self.path = os.path.join(state, 'lock')
        self.held = False

    def __enter__(self):
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode('ascii'))
                os.close(fd)
                self.held = True
                return self
            except FileExistsError:
                try:
                    with open(self.path, 'r') as f:
                        pid = int(f.read().strip() or '0')
                except (OSError, ValueError):
                    pid = 0
                if pid and pid_alive(pid):
                    raise UpdaterError('another H9XASH-Updater (pid %d) is working on this folder. If none '
                                       'is open, delete %s and try again.' % (pid, self.path))
                os.remove(self.path)
        raise UpdaterError('cannot take the lock ' + self.path)

    def __exit__(self, *exc):
        if self.held:
            try:
                os.remove(self.path)
            except OSError:
                pass


# ---- the release, from git ---------------------------------------------------------------------

def find_git():
    git = shutil.which('git')
    if not git and os.name == 'nt':
        for base in (os.environ.get('ProgramFiles'), os.environ.get('ProgramW6432'),
                     os.environ.get('LOCALAPPDATA') and os.path.join(os.environ['LOCALAPPDATA'], 'Programs')):
            if base and os.path.isfile(os.path.join(base, 'Git', 'cmd', 'git.exe')):
                git = os.path.join(base, 'Git', 'cmd', 'git.exe')
                break
    return git


def git_env():
    env = dict(os.environ)
    for k in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_LFS_SKIP_SMUDGE', 'GIT_CEILING_DIRECTORIES'):
        env.pop(k, None)
    env['GIT_TERMINAL_PROMPT'] = '0'
    env['GCM_INTERACTIVE'] = 'never'
    return env


def git_tools():
    """(git.exe, None) when git and Git LFS both work, else (git.exe or None, what is missing)."""
    git = find_git()
    if not git:
        return None, 'Git is not installed'
    try:
        p = subprocess.run([git, 'lfs', 'version'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, env=git_env(), timeout=60)
        if p.returncode == 0 and b'git-lfs' in p.stdout:
            return git, None
    except (OSError, subprocess.SubprocessError):
        pass
    return git, 'Git LFS is not installed (git is, at %s)' % git


class Source:
    """Where a release comes from. git and zip give a folder holding the release (root); web gives
    the manifest, and fetches only the files an update needs."""
    kind = ''
    root = None

    def stage_script(self):
        return None

    def seeds(self):
        return list(SEEDS)

    def seed_sources(self, rel):
        return []

    def local_path(self, rel, sha):
        return os.path.join(self.root, rel)

    def fetch(self, items):
        pass

    def cleanup(self):
        pass

    def finish(self):
        pass


class GitSource(Source):
    kind = 'git'

    def __init__(self, git, cache, url, branch):
        self.git = git
        self.dir = os.path.join(cache, 'git')
        self.url = url
        self.branch = branch
        self.info = {}

    @property
    def root(self):
        return os.path.join(self.dir, 'H9XASH')

    def run(self, args, show=False, check=True):
        cmd = [self.git, '-C', self.dir] + args
        LOG.note('git ' + ' '.join(args))
        if show:
            p = subprocess.run(cmd, env=git_env(), stdin=subprocess.DEVNULL)
            out = ''
        else:
            p = subprocess.run(cmd, env=git_env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT)
            out = p.stdout.decode('utf-8', 'replace').strip()
            if out:
                LOG.note('  ' + out.replace('\n', '\n  '))
        if check and p.returncode != 0:
            last = out.splitlines()[-1] if out else 'see the messages above'
            raise UpdaterError('git %s failed (exit %d): %s' % (args[0], p.returncode, last))
        return out

    def sync(self):
        first = not os.path.isdir(os.path.join(self.dir, '.git'))
        if first:
            os.makedirs(self.dir, exist_ok=True)
            self.run(['init', '-q'])
        b = self.branch
        # A shallow partial clone, so only H9XASH's files are downloaded, with the LFS filter set
        # here rather than in the player's own git settings. Line ends as a Windows checkout has them.
        for key, value in (('core.repositoryformatversion', '1'), ('extensions.partialClone', 'origin'),
                           ('core.sparseCheckout', 'true'), ('core.longpaths', 'true'),
                           ('core.autocrlf', 'true'), ('core.safecrlf', 'false'), ('gc.auto', '0'),
                           ('protocol.version', '2'),
                           ('filter.lfs.process', 'git-lfs filter-process'),
                           ('filter.lfs.smudge', 'git-lfs smudge -- %f'),
                           ('filter.lfs.clean', 'git-lfs clean -- %f'), ('filter.lfs.required', 'true'),
                           ('remote.origin.url', self.url),
                           ('remote.origin.fetch', '+refs/heads/%s:refs/remotes/origin/%s' % (b, b)),
                           ('remote.origin.promisor', 'true'),
                           ('remote.origin.partialclonefilter', 'blob:none')):
            self.run(['config', key, value])
        sparse = os.path.join(self.dir, '.git', 'info', 'sparse-checkout')
        want = '\n'.join(SPARSE_PATTERNS) + '\n'
        try:
            with open(sparse, 'r', encoding='utf-8') as f:
                changed = f.read() != want
        except OSError:
            changed = True
        if changed:
            os.makedirs(os.path.dirname(sparse), exist_ok=True)
            with open(sparse, 'w', encoding='utf-8', newline='\n') as f:
                f.write(want)
        LOG.say('Downloading the latest H9XASH from %s (%s)...' % (self.url, b))
        self.run(['fetch', '--depth', '1', '--filter=blob:none', '--no-tags', '--progress', 'origin',
                  '+refs/heads/%s:refs/remotes/origin/%s' % (b, b)], show=True)
        LOG.say('Updating the download cache (Git LFS fetches the maps, models and archives)...')
        self.run(['checkout', '--force', '-B', b, 'refs/remotes/origin/' + b], show=True)
        if changed and not first:
            self.run(['read-tree', '-mu', 'HEAD'], show=True)
        line = self.run(['log', '-1', '--format=%H %ct'])
        commit, when = line.split()[:2]
        self.info = {'kind': 'git', 'url': self.url, 'branch': b, 'commit': commit,
                     'date': time.strftime('%Y-%m-%d %H:%M', time.localtime(int(when))),
                     'build': read_build(os.path.join(self.dir, 'VERSION.txt'))}
        if not os.path.isdir(os.path.join(self.root, 'ts')):
            raise UpdaterError('the repository has no H9XASH\\ts folder at %s' % commit[:10])
        return self.root

    def repair_pointers(self, rels):
        """Checks out again the files that are still Git LFS pointers, so LFS fetches them."""
        paths = ['H9XASH/' + r.replace('\\', '/') for r in rels]
        for p in paths:
            try:
                os.remove(xp(os.path.join(self.dir, native(p))))
            except OSError:
                pass
        for i in range(0, len(paths), 40):
            self.run(['checkout', '--force', 'HEAD', '--'] + paths[i:i + 40], show=True)

    def describe(self):
        i = self.info
        return 'git %s (%s)%s' % (i['commit'][:10], i['date'], ', build ' + i['build'] if i.get('build') else '')

    def stage_script(self):
        return os.path.join(self.dir, 'stage-h9xash.ps1')

    def seed_sources(self, rel):
        if rel.lower() == 'networking.ini':
            return [os.path.join(self.dir, 'xash3d-h9-patches', 'overlay', 'networking.ini')]
        return []

    def cleanup(self):
        # The working tree holds every LFS file already, so git-lfs's own copies only take space.
        # A later checkout fetches what it needs again.
        rmtree(os.path.join(self.dir, '.git', 'lfs', 'objects'))


def read_build(path):
    try:
        with open(path, 'r', encoding='latin-1') as f:
            for line in f:
                m = re.match(r'\s*Build:\s*(\S+)', line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return ''


# ---- the release, from the published ZIP -------------------------------------------------------

class ZipSource(Source):
    kind = 'zip'

    def __init__(self, cache, url):
        self.dir = os.path.join(cache, 'zip')
        self.url = url
        self.info = {}
        self.extract = os.path.join(self.dir, 'extract')

    @property
    def root(self):
        if os.path.isdir(os.path.join(self.extract, 'H9XASH', 'ts')):
            return os.path.join(self.extract, 'H9XASH')
        return self.extract

    def sync(self):
        os.makedirs(self.dir, exist_ok=True)
        meta_path = os.path.join(self.dir, 'source.json')
        meta = load_json(meta_path) or {}
        have = bool(meta.get('complete')) and os.path.isdir(self.extract)
        headers = {'User-Agent': USER_AGENT}
        if have and meta.get('etag'):
            headers['If-None-Match'] = meta['etag']
        if have and meta.get('last_modified'):
            headers['If-Modified-Since'] = meta['last_modified']
        LOG.say('Checking %s ...' % self.url)
        try:
            resp = urllib.request.urlopen(urllib.request.Request(self.url, headers=headers), timeout=60)
        except urllib.error.HTTPError as e:
            if e.code == 304 and have:
                return self._done(meta, 'unchanged since the last download')
            raise UpdaterError('%s answered %d %s' % (self.url, e.code, e.reason))
        except (urllib.error.URLError, OSError) as e:
            raise UpdaterError('cannot reach %s: %s' % (self.url, getattr(e, 'reason', e)))
        part = os.path.join(self.dir, 'H9XASH.zip.part')
        with resp:
            etag, modified = resp.headers.get('ETag'), resp.headers.get('Last-Modified')
            if have and ((etag and etag == meta.get('etag')) or (not etag and modified and modified == meta.get('last_modified'))):
                return self._done(meta, 'unchanged since the last download')
            length = int(resp.headers.get('Content-Length') or 0)
            h, got = hashlib.sha256(), 0
            prog = Progress('downloading H9XASH.zip')
            with open(part, 'wb') as f:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    got += len(chunk)
                    prog.update('%s of %s' % (mb(got), mb(length) if length else '?'))
            prog.done('%s' % mb(got))
        if length and got != length:
            raise UpdaterError('the download stopped at %d of %d bytes; run the updater again' % (got, length))
        LOG.note('H9XASH.zip SHA-256 %s, %d bytes' % (h.hexdigest(), got))
        new = self.extract + '.new'
        rmtree(new)
        try:
            with zipfile.ZipFile(part) as zf:
                names = zf.infolist()
                prog = Progress('unpacking (each file\'s CRC is checked)')
                for k, zi in enumerate(names, 1):
                    parts = zi.filename.replace('\\', '/').split('/')
                    if zi.filename.startswith(('/', '\\')) or '..' in parts or ':' in zi.filename:
                        raise UpdaterError('H9XASH.zip holds an unsafe path: %r' % zi.filename)
                    zf.extract(zi, xp(new))
                    prog.update('%d of %d files' % (k, len(names)))
                prog.done('%d files' % len(names))
        except zipfile.BadZipFile as e:
            raise UpdaterError('H9XASH.zip is damaged (%s); run the updater again to download it again' % e)
        rmtree(self.extract)
        os.replace(xp(new), xp(self.extract))
        os.remove(part)
        meta = {'complete': True, 'url': self.url, 'etag': etag, 'last_modified': modified, 'length': got,
                'sha256': h.hexdigest(), 'downloaded': time.strftime('%Y-%m-%d %H:%M')}
        save_json(meta_path, meta)
        return self._done(meta, 'downloaded')

    def _done(self, meta, how):
        LOG.say('  H9XASH.zip: %s' % how)
        if not os.path.isdir(os.path.join(self.root, 'ts')):
            raise UpdaterError('H9XASH.zip has no H9XASH\\ts folder')
        self.info = {'kind': 'zip', 'url': self.url, 'last_modified': meta.get('last_modified') or '',
                     'sha256': meta.get('sha256') or '', 'length': meta.get('length') or 0}
        return self.root

    def repair_pointers(self, rels):
        raise UpdaterError('H9XASH.zip holds Git LFS pointer files in place of game files (%s ...)' % rels[0])

    def describe(self):
        return 'H9XASH.zip (%s)' % (self.info.get('last_modified') or 'no date')

    def stage_script(self):
        return None

    def seed_sources(self, rel):
        if rel.lower() in ('networking.ini', 'ts\\tempdecal.wad'):
            return [os.path.join(self.root, native(rel))]
        return []


# ---- the release, from the site's files/ -------------------------------------------------------

def _safe_rel(path):
    """A manifest path as a relative Windows path, or None when it could leave the folder."""
    if not isinstance(path, str) or not path or len(path) > 400:
        return None
    parts = path.replace('\\', '/').split('/')
    if path.startswith(('/', '\\')) or ':' in path or any(p in ('', '.', '..') for p in parts):
        return None
    if any(ord(c) < 32 or c in '<>"|?*' for c in path):
        return None
    return '\\'.join(parts)


class WebSource(Source):
    """The release stage-h9xash.ps1 publishes on the site (tools\\updater\\publish_files.py):
    files/manifest.json, and each file under files/<its SHA-256>. Only the files an update needs
    are downloaded, each checked against its SHA-256; a download cut short resumes where it
    stopped."""
    kind = 'web'

    def __init__(self, cache, url):
        self.dir = os.path.join(cache, 'web')
        self.blobs = os.path.join(self.dir, 'files')
        self.url = url if url.endswith('/') else url + '/'
        self.info = {}
        self.manifest = None

    def _open(self, name, headers=None):
        h = dict(WEB_HEADERS)
        h.update(headers or {})
        return urllib.request.urlopen(urllib.request.Request(self.url + name, headers=h), timeout=60)

    def sync(self):
        os.makedirs(self.dir, exist_ok=True)
        meta_path = os.path.join(self.dir, 'source.json')
        saved_path = os.path.join(self.dir, 'manifest.json')
        meta = load_json(meta_path) or {}
        saved = load_json(saved_path)
        headers = {'Accept-Encoding': 'gzip'}
        if saved is not None and meta.get('etag'):
            headers['If-None-Match'] = meta['etag']
        if saved is not None and meta.get('last_modified'):
            headers['If-Modified-Since'] = meta['last_modified']
        LOG.say('Checking %smanifest.json ...' % self.url)
        try:
            resp = self._open('manifest.json', headers)
        except urllib.error.HTTPError as e:
            if e.code == 304 and saved is not None:
                manifest, how = saved, 'unchanged since the last check'
            elif e.code == 404:
                raise UpdaterError('%smanifest.json is not there (404): H9XASH has not been published at that '
                                   'address' % self.url)
            else:
                raise UpdaterError('%s answered %d %s' % (self.url, e.code, e.reason))
        except (urllib.error.URLError, OSError) as e:
            raise UpdaterError('cannot reach %s: %s' % (self.url, getattr(e, 'reason', e)))
        else:
            with resp:
                body = resp.read(64 * 1048576 + 1)
                if len(body) > 64 * 1048576:
                    raise UpdaterError('%smanifest.json is larger than 64 MB' % self.url)
                if (resp.headers.get('Content-Encoding') or '').lower() == 'gzip':
                    body = gzip.decompress(body)
                meta = {'etag': resp.headers.get('ETag'), 'last_modified': resp.headers.get('Last-Modified')}
            try:
                manifest = json.loads(body.decode('utf-8'))
            except ValueError:
                raise UpdaterError('%smanifest.json is not a manifest (not JSON)' % self.url)
            how = 'downloaded'
        self.manifest = self._checked(manifest)
        if how == 'downloaded':
            save_json(saved_path, manifest)
            save_json(meta_path, meta)
        self.info = {'kind': 'web', 'url': self.url, 'build': manifest.get('build') or '',
                     'published': manifest.get('published') or ''}
        LOG.say('  manifest.json: %s' % how)
        return None

    def _checked(self, manifest):
        if not isinstance(manifest, dict) or manifest.get('format') != 1 or not isinstance(manifest.get('files'), list):
            raise UpdaterError('%smanifest.json is not a manifest this updater reads (format %r); a newer '
                               'H9XASH-Updater may be needed' % (self.url, getattr(manifest, 'get', lambda k: None)('format')))
        for key in ('files', 'seeds'):
            for e in manifest.get(key) or []:
                if not isinstance(e, dict) or _safe_rel(e.get('path')) is None or not HEX64.match(str(e.get('sha256'))) \
                        or not isinstance(e.get('size'), int) or e['size'] < 0:
                    raise UpdaterError('%smanifest.json holds an entry this updater refuses: %r' % (self.url, e))
        return manifest

    def release(self, rules):
        files = {}
        for e in self.manifest['files']:
            rel = _safe_rel(e['path'])
            if not rules.skip_reason(rel):
                files[rel.lower()] = [rel, e['size'], e['sha256']]
        return files

    def describe(self):
        i = self.info
        return '%s build %s%s' % (i.get('url', ''), i.get('build') or '?',
                                 ' (published %s)' % i['published'] if i.get('published') else '')

    def seeds(self):
        return [_safe_rel(e['path']) for e in self.manifest.get('seeds') or []]

    def seed_sources(self, rel):
        for e in self.manifest.get('seeds') or []:
            if _safe_rel(e['path']).lower() == rel.lower():
                self.fetch([(rel, e['size'], e['sha256'])], quiet=True)
                return [self.local_path(rel, e['sha256'])]
        return []

    def local_path(self, rel, sha):
        return os.path.join(self.blobs, sha)

    def fetch(self, items, quiet=False):
        """Downloads the files of these (rel, size, sha256) items that the cache does not hold yet."""
        os.makedirs(self.blobs, exist_ok=True)
        need = {}
        for _rel, size, sha in items:
            need[sha] = size
        todo = [(sha, size) for sha, size in sorted(need.items())
                if not (os.path.isfile(xp(self.local_path('', sha))) and os.path.getsize(xp(self.local_path('', sha))) == size)]
        if not todo:
            return
        total = sum(size for _sha, size in todo)
        prog = Progress('downloading') if not quiet else None
        done = [0]
        for k, (sha, size) in enumerate(todo, 1):
            def tick(n, k=k):
                done[0] += n
                if prog:
                    prog.update('%d of %d files, %s of %s' % (k, len(todo), mb(done[0]), mb(total)))
            self._download(sha, size, tick)
        if prog:
            prog.done('%d files, %s, every one matches its SHA-256' % (len(todo), mb(total)))

    def _download(self, sha, size, tick):
        """One file into the cache as <sha>.part, resumed from what an earlier try left there,
        and renamed to <sha> only once its size and SHA-256 match."""
        final = os.path.join(self.blobs, sha)
        part = final + '.part'
        errors = mismatches = 0
        while True:
            have = os.path.getsize(part) if os.path.isfile(part) else 0
            if have > size:
                os.remove(part)
                have = 0
            h = hashlib.sha256()
            if have:
                with open(part, 'rb') as f:
                    while True:
                        b = f.read(1 << 20)
                        if not b:
                            break
                        h.update(b)
            try:
                if have < size:
                    with self._open(sha, {'Range': 'bytes=%d-' % have} if have else None) as resp:
                        if have and resp.status != 206:
                            have, h = 0, hashlib.sha256()
                        with open(part, 'ab' if have else 'wb') as f:
                            while True:
                                b = resp.read(1 << 20)
                                if not b:
                                    break
                                f.write(b)
                                h.update(b)
                                tick(len(b))
                elif not os.path.isfile(part):
                    open(part, 'wb').close()
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise UpdaterError('the site has no file %s that its manifest names (404): it is being '
                                       'published right now, or the publish is incomplete. Try again later.' % sha)
                if e.code == 416 and have:
                    os.remove(part)
                    continue
                raise UpdaterError('%s%s answered %d %s' % (self.url, sha, e.code, e.reason))
            except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
                errors += 1
                if errors >= 3:
                    raise UpdaterError('the download stopped (%s); run the updater again: it goes on from there'
                                       % getattr(e, 'reason', e))
                LOG.note('download of %s stopped (%s); going on from where it stopped' % (sha, e))
                time.sleep(2)
                continue
            got = os.path.getsize(part)
            if got == size and h.hexdigest() == sha:
                os.replace(part, final)
                return
            LOG.note('%s: %d bytes, SHA-256 %s, does not match; downloading it again' % (sha, got, h.hexdigest()))
            os.remove(part)
            mismatches += 1
            if mismatches >= 2:
                raise UpdaterError('the file %s from the site does not match its SHA-256 (downloaded twice)' % sha)

    def finish(self):
        # Everything downloaded is installed now: the cache keeps only the manifest.
        rmtree(self.blobs)


# Files a new install starts from, copied only when the install has none: the player edits them
# afterwards, so they are never owned, replaced or removed. (h9xash.bat makes ts\config.cfg from
# ts\config.stock.cfg itself.)
SEEDS = ['networking.ini', 'ts\\tempdecal.wad']


# ---- manifests ---------------------------------------------------------------------------------

def scan_release(root, rules, hash_cache):
    """{key: [rel, size, sha256]} of the release, and the files that are still LFS pointers."""
    files, pointers = {}, []
    total, count = 0, 0
    prog = Progress('checking the release')
    stack = ['']
    while stack:
        rel_dir = stack.pop()
        with os.scandir(xp(os.path.join(root, rel_dir) if rel_dir else root)) as it:
            entries = list(it)
        for e in entries:
            rel = e.name if not rel_dir else rel_dir + '\\' + e.name
            if e.is_symlink() or getattr(e, 'is_junction', lambda: False)():
                continue
            if e.is_dir(follow_symlinks=False):
                if rules.skip_reason(rel, True) is None:
                    stack.append(rel)
                continue
            if not e.is_file(follow_symlinks=False) or rules.skip_reason(rel):
                continue
            st = e.stat(follow_symlinks=False)
            key = rel.lower()
            cached = hash_cache.get(key)
            if cached and cached[0] == st.st_size and cached[1] == st.st_mtime_ns:
                sha = cached[2]
            else:
                if st.st_size < 1024:
                    with open(xp(os.path.join(root, rel)), 'rb') as f:
                        if f.read(len(LFS_POINTER)) == LFS_POINTER:
                            pointers.append(rel)
                sha = sha256_file(os.path.join(root, rel))
                hash_cache[key] = [st.st_size, st.st_mtime_ns, sha]
            files[key] = [rel, st.st_size, sha]
            total += st.st_size
            count += 1
            prog.update('%d files, %s' % (count, mb(total)))
    prog.done('%d files, %s' % (count, mb(total)))
    for k in [k for k in hash_cache if k not in files]:
        del hash_cache[k]
    return files, pointers


class State:
    """What the updater installed in one folder: the files it owns, with size, time and hash."""

    def __init__(self, state_dir):
        self.path = os.path.join(state_dir, 'installed.json')
        data = load_json(self.path) or {}
        self.source = data.get('source') or {}
        self.installed = data.get('installed') or ''
        self.files = {}
        for rel, size, mtime, sha in data.get('files') or []:
            self.files[rel.lower()] = [rel, size, mtime, sha]
        self.exists = bool(data)

    def save(self, source, files):
        data = {'format': 1, 'updater': VERSION, 'installed': time.strftime('%Y-%m-%d %H:%M:%S'),
                'source': source, 'files': sorted(files.values())}
        save_json(self.path, data)


class Plan:
    def __init__(self):
        self.add, self.replace, self.remove = [], [], []
        self.kept_changed, self.overwritten_changed = [], []
        self.same = 0

    def empty(self):
        return not (self.add or self.replace or self.remove)

    def copy_bytes(self):
        return sum(x[1] for x in self.add + self.replace)


def current_sha(path, size, owned):
    """The hash of an installed file, from what installed.json recorded when size and time still match."""
    st = os.stat(xp(path))
    if stat.S_ISDIR(st.st_mode):
        raise UpdaterError('%s is a folder, but the release has a file there' % path)
    if owned and owned[1] == st.st_size and owned[2] == st.st_mtime_ns:
        return owned[3]
    if size is not None and st.st_size != size:
        return None
    return sha256_file(path)


def make_plan(release, install, state, rules):
    plan = Plan()
    prog = Progress('comparing with your install')
    n = 0
    for key, (rel, size, sha) in sorted(release.items()):
        n += 1
        prog.update('%d of %d files' % (n, len(release)))
        target = os.path.join(install, rel)
        owned = state.files.get(key)
        if not os.path.lexists(xp(target)):
            plan.add.append((rel, size, sha))
            continue
        cur = current_sha(target, size, owned)
        if cur == sha:
            plan.same += 1
            continue
        plan.replace.append((rel, size, sha))
        if owned and cur != owned[3]:
            plan.overwritten_changed.append(rel)
    for key, owned in sorted(state.files.items()):
        if key in release or rules.skip_reason(owned[0]):
            continue
        target = os.path.join(install, owned[0])
        if not os.path.isfile(xp(target)):
            continue
        if current_sha(target, None, owned) == owned[3]:
            plan.remove.append((owned[0], owned[1], owned[3]))
        else:
            plan.kept_changed.append(owned[0])
    prog.done('%d files compared' % n)
    return plan


# ---- applying an update, and undoing it --------------------------------------------------------

def _journal_paths(state_dir):
    rb = os.path.join(state_dir, 'rollback')
    return rb, os.path.join(rb, 'journal.jsonl'), os.path.join(rb, 'files'), os.path.join(rb, 'installed.prev.json')


def read_journal(state_dir):
    """(header, ops, done) of the last update's journal, or None when there is none."""
    _, journal, _, _ = _journal_paths(state_dir)
    try:
        with open(xp(journal), 'r', encoding='utf-8') as f:
            lines = f.read().split('\n')
    except OSError:
        return None
    header, ops, done = None, [], False
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if header is None:
            header = rec
        elif rec.get('done'):
            done = True
        elif rec.get('op'):
            ops.append(rec)
    return (header, ops, done) if header else None


def _clear_readonly(path):
    try:
        os.chmod(xp(path), stat.S_IWRITE | stat.S_IREAD)
    except OSError:
        pass


def _replace(src, dst):
    try:
        os.replace(xp(src), xp(dst))
    except PermissionError:
        _clear_readonly(dst)
        os.replace(xp(src), xp(dst))


def _prune_empty_dirs(install, rel):
    d = os.path.dirname(os.path.join(install, rel))
    top = os.path.normcase(os.path.abspath(install))
    while os.path.normcase(os.path.abspath(d)) != top and len(d) > len(top):
        try:
            os.rmdir(xp(d))
        except OSError:
            return
        d = os.path.dirname(d)


def stage_files(plan, source, stage):
    """Copies every new and changed file under stage, and checks each copy's SHA-256."""
    items = plan.add + plan.replace
    total = plan.copy_bytes()
    done_bytes = 0
    prog = Progress('copying and checking')
    for k, (rel, size, sha) in enumerate(items, 1):
        src = source.local_path(rel, sha)
        dst = os.path.join(stage, rel)
        os.makedirs(xp(os.path.dirname(dst)), exist_ok=True)
        with open(xp(src), 'rb') as fi, open(xp(dst), 'wb') as fo:
            shutil.copyfileobj(fi, fo, 1 << 20)
        got = sha256_file(dst)
        if got != sha or os.path.getsize(xp(dst)) != size:
            raise UpdaterError('%s does not match the release (SHA-256 %s, expected %s): the download '
                               'cache changed or the disk is failing. Nothing was installed.' % (rel, got[:16], sha[:16]))
        if size < 1024:
            with open(xp(dst), 'rb') as f:
                if f.read(len(LFS_POINTER)) == LFS_POINTER:
                    raise UpdaterError('%s in the release is a Git LFS pointer, not the game file. Nothing was '
                                       'installed.' % rel)
        done_bytes += size
        prog.update('%d of %d files, %s of %s' % (k, len(items), mb(done_bytes), mb(total)))
    prog.done('%d files, %s, all match the release' % (len(items), mb(total)))


def apply_plan(plan, source, install, state_dir, state, release, source_info):
    stage = os.path.join(state_dir, 'stage')
    rmtree(stage)
    stage_files(plan, source, stage)
    refuse_if_running(install)

    rb, journal, backups, prev = _journal_paths(state_dir)
    rmtree(rb)
    os.makedirs(xp(backups))
    save_json(prev, {'source': state.source, 'installed': state.installed,
                     'files': sorted(state.files.values())} if state.exists else {'none': True})
    jf = open(xp(journal), 'w', encoding='utf-8', newline='\n')

    def record(rec):
        jf.write(json.dumps(rec) + '\n')
        jf.flush()

    record({'started': time.strftime('%Y-%m-%d %H:%M:%S'), 'from': state.source, 'to': source_info,
            'add': len(plan.add), 'replace': len(plan.replace), 'remove': len(plan.remove)})
    os.fsync(jf.fileno())
    prog = Progress('installing')
    steps = len(plan.replace) + len(plan.add) + len(plan.remove)
    n = 0
    try:
        for rel, _size, _sha in plan.replace:
            target, backup = os.path.join(install, rel), os.path.join(backups, rel)
            record({'op': 'replace', 'rel': rel})
            os.makedirs(xp(os.path.dirname(backup)), exist_ok=True)
            try:
                os.link(xp(target), xp(backup))
            except OSError:
                shutil.copy2(xp(target), xp(backup + '.part'))
                os.replace(xp(backup + '.part'), xp(backup))
            _replace(os.path.join(stage, rel), target)
            n += 1
            prog.update('%d of %d' % (n, steps))
        for rel, _size, _sha in plan.add:
            target = os.path.join(install, rel)
            record({'op': 'add', 'rel': rel})
            os.makedirs(xp(os.path.dirname(target)), exist_ok=True)
            os.replace(xp(os.path.join(stage, rel)), xp(target))
            n += 1
            prog.update('%d of %d' % (n, steps))
        for rel, _size, _sha in plan.remove:
            target, backup = os.path.join(install, rel), os.path.join(backups, rel)
            record({'op': 'remove', 'rel': rel})
            os.makedirs(xp(os.path.dirname(backup)), exist_ok=True)
            _replace(target, backup)
            _prune_empty_dirs(install, rel)
            n += 1
            prog.update('%d of %d' % (n, steps))
        prog.done('%d changes made' % steps)
        state.save(source_info, installed_files(release, install))
        record({'done': True, 'finished': time.strftime('%Y-%m-%d %H:%M:%S')})
        os.fsync(jf.fileno())
        jf.close()
    except BaseException as e:
        prog.done()
        jf.close()
        LOG.say('The update stopped part way (%s). Putting every file back as it was...'
                % (e if isinstance(e, Exception) else 'interrupted'))
        undo(install, state_dir)
        if isinstance(e, OSError):
            raise UpdaterError('a game file could not be replaced (%s: %s), so every file was put back as it '
                               'was. A program may have it open: close it and run the updater again.'
                               % (getattr(e, 'filename', '') or '?', e.strerror or e)) from e
        raise
    finally:
        rmtree(stage)


def installed_files(release, install):
    """installed.json's file list: each release file as it now is in the install."""
    files = {}
    for key, (rel, _size, sha) in release.items():
        st = os.stat(xp(os.path.join(install, rel)))
        files[key] = [rel, st.st_size, st.st_mtime_ns, sha]
    return files


def undo(install, state_dir):
    """Puts back what the last update changed, from its journal. Safe to run again after a crash."""
    j = read_journal(state_dir)
    if not j:
        return False
    header, ops, _done = j
    rb, _journal, backups, prev = _journal_paths(state_dir)
    restored = removed = 0
    for rec in reversed(ops):
        rel = rec['rel']
        target, backup = os.path.join(install, rel), os.path.join(backups, rel)
        if rec['op'] in ('replace', 'remove'):
            if os.path.lexists(xp(backup)):
                os.makedirs(xp(os.path.dirname(target)), exist_ok=True)
                _replace(backup, target)
                restored += 1
        elif rec['op'] == 'add':
            if os.path.lexists(xp(target)):
                _clear_readonly(target)
                os.remove(xp(target))
                _prune_empty_dirs(install, rel)
                removed += 1
    old = load_json(prev)
    state_path = os.path.join(state_dir, 'installed.json')
    if old is None:
        raise UpdaterError('the rollback has no copy of the previous installed.json; nothing more was changed')
    if old.get('none'):
        if os.path.exists(state_path):
            os.remove(state_path)
    else:
        old.update({'format': 1, 'updater': VERSION})
        save_json(state_path, old)
    rmtree(rb)
    LOG.say('  %d files put back, %d files the update had added removed.' % (restored, removed))
    return True


# ---- the steps a run goes through --------------------------------------------------------------

def git_checkout_root(path):
    d = os.path.abspath(path)
    while True:
        if os.path.exists(os.path.join(d, '.git')):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def install_dir_problem(path, cache, force):
    path = os.path.abspath(path)
    if os.path.dirname(path) == path:
        return 'a drive root is not a game folder; use a folder such as %s' % os.path.join(path, 'H9XASH')
    if os.path.isfile(path):
        return '%s is a file' % path
    repo = git_checkout_root(path)
    if repo:
        return ('%s is inside a git checkout (%s). The updater keeps a player\'s copy up to date, not a '
                'source tree: choose a folder outside it.' % (path, repo))
    parent = os.path.dirname(path)
    if os.path.isdir(os.path.join(parent, 'xash3d-h9-patches')) or os.path.isfile(os.path.join(parent, 'export.bat')):
        return '%s sits in a TS Match Mode source folder (%s): choose a folder outside it.' % (path, parent)
    c, p = os.path.normcase(os.path.abspath(cache)), os.path.normcase(path)
    if c == p or c.startswith(p + os.sep) or p.startswith(c + os.sep):
        return 'the install folder and the download cache (%s) must not be inside each other' % cache
    if os.path.isdir(path) and not force and not looks_like_h9xash(path) \
            and not os.path.isdir(os.path.join(path, STATE_DIR)) and os.listdir(path):
        return ('%s already holds other files and no H9XASH. Choose an empty folder or an H9XASH folder '
                '(or pass --force).' % path)
    return None


def ask(prompt, default=''):
    try:
        answer = input(prompt)
    except EOFError:
        return default
    return answer.strip().strip('"').strip() or default


def ask_yes(prompt, default=True):
    answer = ask(prompt + (' [Y/n] ' if default else ' [y/N] '), '').lower()
    return default if not answer else answer.startswith('y')


def choose_install_dir(args, interactive):
    if args.dir:
        path = os.path.abspath(os.path.expandvars(args.dir))
        cache = args.cache or path + '-updater-cache'
        problem = install_dir_problem(path, cache, args.force)
        if problem:
            raise UpdaterError(problem)
        return path, os.path.abspath(cache)
    here = exe_dir()
    default = here if looks_like_h9xash(here) else os.path.join(here, 'H9XASH')
    while True:
        if interactive:
            print('H9XASH folder: %s' % default)
            path = os.path.abspath(os.path.expandvars(ask('  Press Enter to use it, or type another folder: ', default)))
        else:
            path = default
        cache = os.path.abspath(args.cache or path + '-updater-cache')
        problem = install_dir_problem(path, cache, args.force)
        if not problem:
            return path, cache
        if not interactive:
            raise UpdaterError(problem + ' (give the folder with --dir)')
        print('  ' + problem)
        print()


def account_step(args, install, state_dir, interactive):
    if args.skip_link or args.check or not h9link.supported():
        return
    status, detail = h9link.status(install)
    LOG.note('account: %s %s' % (status, detail))
    if status == 'linked' and not args.link:
        LOG.say('Account: %s, for this Windows user on this PC.' % detail)
        return
    asked = os.path.join(state_dir, 'link-asked')
    first_run = not os.path.exists(os.path.join(state_dir, 'installed.json')) and not os.path.exists(asked)
    if not args.link and not (first_run and interactive):
        LOG.say('Account: %s. Run H9XASH-Updater.exe --link any time to link it.' % detail)
        return
    print()
    print('Your havoc9.org account')
    print('  Linking tells H9 servers that this install is you, in place of a pasted player id.')
    print('  The link is stored protected for this Windows user: copied to another user or PC, it')
    print('  does not work there. You can skip this and link later from the game menu.')
    if status == 'linked':
        print('  This install is already linked; linking again replaces the account it is linked to.')
    if interactive and not ask_yes('Link this install to your havoc9.org account now?', default=True):
        LOG.say('Account: skipped.')
    else:
        h9link.link(install, say=LOG.say, interactive=interactive, site=args.link_site)
    try:
        with open(asked, 'w') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S\n'))
    except OSError:
        pass


def choose_source(args, cache):
    if args.source == 'web':
        return WebSource(cache, args.web_url)
    if args.source == 'zip':
        return ZipSource(cache, args.zip_url)
    git, missing = git_tools()
    if missing:
        raise UpdaterError('\n'.join([
            missing + '.',
            '--source git gets H9XASH from its git repository with Git and Git LFS. Install Git for',
            'Windows (it includes Git LFS): %s, or Git LFS on its own: %s,' % (GIT_FOR_WINDOWS, GIT_LFS_SITE),
            'then run the updater again. Without --source, the updater uses havoc9.org and needs neither.']))
    return GitSource(git, cache, args.repo, args.branch)


def read_release(source, cache):
    """The release as {key: [rel, size, sha256]}: the manifest's list for web, a hashed scan of the
    release folder for git and zip."""
    rules = Rules()
    script = source.stage_script()
    if script and os.path.isfile(script):
        with open(script, 'r', encoding='latin-1') as f:
            rules.add_from_stage_script(f.read())
        if rules.added:
            LOG.note('stage-h9xash.ps1 adds %d rules' % rules.added)
    if source.kind == 'web':
        return source.release(rules), rules
    cache_hashes_path = os.path.join(cache, 'release-hashes-%s.json' % source.kind)
    hash_cache = load_json(cache_hashes_path) or {}
    release, pointers = scan_release(source.root, rules, hash_cache)
    if pointers:
        LOG.say('%d files came down as Git LFS pointers; fetching them again...' % len(pointers))
        source.repair_pointers(pointers)
        release, pointers = scan_release(source.root, rules, hash_cache)
        if pointers:
            for p in pointers[:10]:
                LOG.note('  still a pointer: ' + p)
            raise UpdaterError('%d game files are still Git LFS pointers (%s ...): Git LFS could not download '
                               'them. Run the updater again later.' % (len(pointers), pointers[0]))
    save_json(cache_hashes_path, hash_cache)
    source.cleanup()
    return release, rules


def run_update(args, install, cache, state_dir, interactive):
    running = processes_in(install)
    if running and not args.check:
        LOG.say('%s is running from this folder: close it before the update is applied.'
                % ' and '.join(sorted(set(os.path.basename(p) for _, p in running))))
    source = choose_source(args, cache)
    os.makedirs(cache, exist_ok=True)
    source.sync()
    release, rules = read_release(source, cache)
    LOG.say('Release: %s, %d files' % (source.describe(), len(release)))

    state = State(state_dir)
    plan = make_plan(release, install, state, rules)
    fresh = not state.exists and plan.same == 0 and not plan.replace
    LOG.say()
    LOG.say('  new files      %5d  (%s)' % (len(plan.add), mb(sum(x[1] for x in plan.add))))
    LOG.say('  changed files  %5d  (%s)' % (len(plan.replace), mb(sum(x[1] for x in plan.replace))))
    LOG.say('  removed files  %5d' % len(plan.remove))
    LOG.say('  unchanged      %5d' % plan.same)
    for word, items in (('new', plan.add), ('changed', plan.replace), ('removed', plan.remove)):
        for rel, _size, _sha in items:
            LOG.note('  %s %s' % (word, rel))
    if plan.overwritten_changed:
        LOG.say('  %d of the changed files were edited in this folder since the last update; the update '
                'replaces them (the old copies stay in the rollback).' % len(plan.overwritten_changed))
        for rel in plan.overwritten_changed:
            LOG.note('  edited here, replaced: ' + rel)
    if plan.kept_changed:
        LOG.say('  %d files the release no longer has were edited here, so they stay.' % len(plan.kept_changed))
        for rel in plan.kept_changed:
            LOG.note('  edited here, kept: ' + rel)

    if plan.empty():
        LOG.say()
        LOG.say('H9XASH is up to date.')
        if args.check:
            return 0
        if not state.exists or state.source != source.info:
            state.save(source.info, installed_files(release, install))
        seed_and_dirs(source, install)
        source.finish()
        return 0
    if args.check:
        LOG.say()
        LOG.say('Check only (--check): nothing was changed.')
        return 0
    free = shutil.disk_usage(install).free
    # the stage, and for web the downloads too when the cache is on the same drive
    need = plan.copy_bytes() * (2 if source.kind == 'web' else 1) + 64 * 1048576
    if free < need:
        raise UpdaterError('not enough free space on the drive of %s: %s needed, %s free' % (install, mb(need), mb(free)))
    refuse_if_running(install)
    if interactive:
        print()
        if not ask_yes('Install H9XASH into %s?' % install if fresh else 'Apply this update?', default=True):
            LOG.say('Stopped: nothing was changed.')
            return 1
    LOG.say()
    source.fetch(plan.add + plan.replace)
    apply_plan(plan, source, install, state_dir, state, release, source.info)
    seed_and_dirs(source, install)
    source.finish()
    LOG.say()
    LOG.say('Done: H9XASH in %s is %s.' % (install, source.describe()))
    if not fresh:
        LOG.say('If something is wrong, H9XASH-Updater.exe --rollback puts the previous files back.')
    LOG.say('Start the game with h9xash.bat in that folder.')
    return 0


def seed_and_dirs(source, install):
    rules = Rules()
    for rel in source.seeds():
        # a starter file is always one of a player's: anything else is no seed
        if not rel or not rules.skip_reason(rel):
            continue
        target = os.path.join(install, rel)
        if os.path.lexists(xp(target)):
            continue
        for src in source.seed_sources(rel):
            if os.path.isfile(xp(src)):
                os.makedirs(xp(os.path.dirname(target)), exist_ok=True)
                shutil.copyfile(xp(src), xp(target + '.h9new'))
                os.replace(xp(target + '.h9new'), xp(target))
                LOG.say('  %s: none here yet, the stock one was put in' % rel)
                break
    for rel in RECREATE_DIRS:
        os.makedirs(xp(os.path.join(install, rel)), exist_ok=True)


def run_rollback(install, state_dir, interactive):
    j = read_journal(state_dir)
    if not j or not j[2]:
        LOG.say('There is no finished update to roll back in %s.' % install)
        return 1
    header = j[0]
    to, frm = header.get('to') or {}, header.get('from') or {}
    LOG.say('The last update, %s: %s -> %s' % (header.get('started', '?'), describe_info(frm), describe_info(to)))
    LOG.say('  %s new, %s changed, %s removed files.' % (header.get('add'), header.get('replace'), header.get('remove')))
    refuse_if_running(install)
    if interactive and not ask_yes('Roll it back?', default=True):
        LOG.say('Stopped: nothing was changed.')
        return 1
    undo(install, state_dir)
    LOG.say('Rolled back. The next update installs the newer files again.')
    return 0


def describe_info(info):
    if info.get('kind') == 'git':
        return 'git %s (%s)' % (info.get('commit', '')[:10], info.get('date', ''))
    if info.get('kind') == 'zip':
        return 'H9XASH.zip (%s)' % info.get('last_modified', '')
    if info.get('kind') == 'web':
        return 'build %s from %s (published %s)' % (info.get('build') or '?', info.get('url', ''), info.get('published', ''))
    return 'files from before the updater'


def show_status(install, cache, state_dir):
    state = State(state_dir)
    LOG.say('H9XASH folder:   %s' % install)
    LOG.say('download cache:  %s' % cache)
    if state.exists:
        LOG.say('installed:       %s on %s, %d files' % (describe_info(state.source), state.installed, len(state.files)))
    else:
        LOG.say('installed:       nothing yet by the updater')
    j = read_journal(state_dir)
    LOG.say('rollback:        %s' % ('the update of %s can be rolled back' % j[0].get('started') if j and j[2] else 'none'))
    if h9link.supported():
        LOG.say('account:         %s' % h9link.status(install)[1])
    return 0


def parse_args(argv):
    p = argparse.ArgumentParser(
        prog='H9XASH-Updater',
        description='Installs H9XASH and keeps it up to date, copying only the files that changed. '
                    'Player files (config.cfg, user_id.ini, device_id.ini, networking.ini, saves, '
                    'screenshots, logs, histories, downloads, sprays) are never touched.')
    p.add_argument('--dir', help='the H9XASH folder (default: H9XASH beside this program, or this '
                                 'program\'s own folder when it is an H9XASH folder)')
    p.add_argument('--cache', help='the download cache (default: <folder>-updater-cache beside it)')
    p.add_argument('--source', choices=('web', 'git', 'zip'), default='web',
                   help='web (default): the published build from havoc9.org, only the files that changed; '
                        'git: the latest commit of the git repository, for developers (needs Git and Git LFS); '
                        'zip: the published H9XASH.zip, downloaded whole')
    p.add_argument('--web-url', default=WEB_URL, help='the published files (default %(default)s)')
    p.add_argument('--repo', default=REPO_URL, help='git repository (default %(default)s)')
    p.add_argument('--branch', default=BRANCH, help='git branch (default %(default)s)')
    p.add_argument('--zip-url', default=ZIP_URL, help='published ZIP (default %(default)s)')
    p.add_argument('--check', action='store_true', help='show what an update would change, change nothing')
    p.add_argument('--rollback', action='store_true', help='undo the last update')
    p.add_argument('--status', action='store_true', help='show what is installed, and the account link')
    p.add_argument('--link', action='store_true', help='link this install to a havoc9.org account')
    p.add_argument('--link-site', default=h9link.SITE,
                   help='the site to link with (default %(default)s; for a test, a local h9web such as '
                        'http://127.0.0.1:8090, as the game\'s cl_h9_site)')
    p.add_argument('--skip-link', action='store_true', help='do not ask about the account')
    p.add_argument('--yes', '-y', action='store_true', help='ask nothing (the account step is skipped '
                                                              'unless --link is given)')
    p.add_argument('--force', action='store_true', help='install into a folder that holds other files')
    p.add_argument('--no-pause', action='store_true', help='do not wait for Enter at the end')
    p.add_argument('--version', action='version', version='H9XASH-Updater ' + VERSION)
    return p.parse_args(argv)


def run(args):
    interactive = not args.yes and sys.stdin is not None and sys.stdin.isatty()
    print('H9XASH-Updater %s' % VERSION)
    print()
    install, cache = choose_install_dir(args, interactive)
    state_dir = os.path.join(install, STATE_DIR)
    if (args.status or args.rollback) and not os.path.isdir(state_dir):
        LOG.say('The updater has not installed anything in %s yet.' % install)
        return 0 if args.status else 1
    os.makedirs(state_dir, exist_ok=True)
    LOG.attach(os.path.join(state_dir, 'updater.log'))
    LOG.note('H9XASH-Updater %s: %s' % (VERSION, ' '.join(sys.argv[1:]) or '(no options)'))
    LOG.note('folder %s, cache %s' % (install, cache))
    with FolderLock(state_dir):
        j = read_journal(state_dir)
        if j and not j[2]:
            refuse_if_running(install)
            LOG.say('The last update did not finish (the updater was closed or the PC went off).')
            LOG.say('Putting every file back as it was before it...')
            undo(install, state_dir)
            LOG.say()
        if args.status:
            return show_status(install, cache, state_dir)
        if args.rollback:
            return run_rollback(install, state_dir, interactive)
        account_step(args, install, state_dir, interactive)
        LOG.say()
        return run_update(args, install, cache, state_dir, interactive)


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')
    if os.name == 'nt':
        try:
            ctypes.windll.kernel32.SetConsoleTitleW('H9XASH Updater')
        except (AttributeError, OSError):
            pass
    argv = sys.argv[1:] if argv is None else argv
    pause = not argv and getattr(sys, 'frozen', False)
    args = parse_args(argv)
    pause = pause and not args.no_pause
    try:
        rc = run(args)
    except UpdaterError as e:
        LOG.say()
        LOG.say('Stopped: %s' % e)
        rc = 1
    except KeyboardInterrupt:
        LOG.say()
        LOG.say('Stopped (Ctrl+C).')
        rc = 1
    except Exception:
        LOG.say()
        LOG.say('Stopped by an unexpected error:')
        LOG.say(traceback.format_exc().rstrip())
        rc = 2
    LOG.close()
    if pause:
        try:
            input('\nPress Enter to close.')
        except (EOFError, KeyboardInterrupt):
            pass
    return rc


if __name__ == '__main__':
    sys.exit(main())
