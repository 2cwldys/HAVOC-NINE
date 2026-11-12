#!/usr/bin/env python3
# test_updater.py -- end-to-end test of H9XASH-Updater in a scratch folder: a local git origin with a
# small H9XASH tree, an install over a player's existing folder, an update after a change in the
# origin, a check-only run, refusal while a program runs from the folder, an update that fails part
# way and undoes itself, recovery from an unfinished update, rollback, the ZIP source over a local
# web server, the LFS pointer guard, the web source (publish_files.py's output served by a
# stand-in for the site's files/ with the same hiding rule: install, 304, a delta, pruning, a
# resumed and a damaged download, rollback, a missing file, a bad manifest), and the account step
# against a stand-in for havoc9.org.
#
#   py -3 test_updater.py --work D:\temp\updater-work\test                 (runs the .py)
#   py -3 test_updater.py --work D:\temp\updater-work\test --exe ..\..\dist\H9XASH-Updater.exe
#
# --work is required: the test never picks a temporary folder by itself. It deletes and remakes
# <work>\updater-test each run. Needs git on PATH. No network: everything is on 127.0.0.1.

import argparse
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import random
import re
import threading
import time
import urllib.error
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import h9link  # noqa: E402

FAILS = []
TMP = {}


def check(cond, what):
    print(('  ok    ' if cond else '  FAIL  ') + what)
    if not cond:
        FAILS.append(what)


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('ascii'))


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def sha(path):
    return hashlib.sha256(read(path)).hexdigest()


def git(cwd, *args):
    subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t'] + list(args),
                   cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def updater(args, cmd, expect=0, what=None):
    p = subprocess.run(cmd + ['--yes', '--skip-link', '--no-pause'] + args, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, env=dict(os.environ, PYTHONIOENCODING='utf-8', **TMP))
    out = p.stdout.decode('utf-8', 'replace')
    check(p.returncode == expect, '%s exits %d (got %d)' % (what or ' '.join(args[:1]), expect, p.returncode))
    if p.returncode != expect:
        print(out)
    return out


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class Gated(http.server.BaseHTTPRequestHandler):
    """A stand-in for the site's files/, with the rule the nginx, Caddy and Apache configs carry:
    404 without the updater's header and User-Agent, 404 for any name but a SHA-256 or
    manifest.json (so no listing), ETag and If-None-Match, and Range."""
    root = None
    seen = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        name = self.path.split('?')[0]
        ok = self.headers.get('X-H9-Updater') == '1' and (self.headers.get('User-Agent') or '').startswith('H9XASH-Updater/')
        m = re.match(r'^/files/([0-9a-f]{64}|manifest\.json)$', name)
        path = os.path.join(Gated.root, m.group(1)) if m else None
        if not ok or not m or not os.path.isfile(path):
            return self.answer(404, b'', name)
        data = read(path)
        etag = '"%s"' % hashlib.sha256(data).hexdigest()[:16]
        if self.headers.get('If-None-Match') == etag:
            return self.answer(304, b'', name, etag)
        rng = re.match(r'^bytes=(\d+)-$', self.headers.get('Range') or '')
        if rng:
            start = int(rng.group(1))
            if start >= len(data):
                return self.answer(416, b'', name)
            return self.answer(206, data[start:], name, etag, 'bytes %d-%d/%d' % (start, len(data) - 1, len(data)))
        self.answer(200, data, name, etag)

    def answer(self, code, body, name, etag=None, content_range=None):
        Gated.seen.append((name.rsplit('/', 1)[-1], code, self.headers.get('Range')))
        self.send_response(code)
        if etag:
            self.send_header('ETag', etag)
        if content_range:
            self.send_header('Content-Range', content_range)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def fetch(url, headers):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def serve(directory, handler=Quiet):
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), lambda *a, **k: handler(*a, directory=directory, **k))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, 'http://127.0.0.1:%d' % srv.server_address[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--exe')
    a = ap.parse_args()
    base = os.path.join(os.path.abspath(a.work), 'updater-test')
    if os.path.isdir(base):
        shutil.rmtree(base, onerror=lambda fn, p, _e: (os.chmod(p, 0o666), fn(p)))
    os.makedirs(base)
    # The one-file exe unpacks itself into TMP while it runs: keep that in the scratch folder too.
    TMP['TMP'] = TMP['TEMP'] = os.path.join(base, 'tmp')
    os.makedirs(TMP['TMP'])
    cmd =[os.path.abspath(a.exe)] if a.exe else [sys.executable, '-E', '-s', os.path.join(HERE, 'h9xash_updater.py')]
    origin, h = os.path.join(base, 'origin'), os.path.join(base, 'origin', 'H9XASH')
    install, cache = os.path.join(base, 'games', 'H9XASH'), os.path.join(base, 'games', 'cache')
    common = ['--dir', install, '--cache', cache, '--source', 'git',
              '--repo', 'file:///' + origin.replace('\\', '/')]

    print('origin v1')
    os.makedirs(h)
    git(origin, 'init', '-q')
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(origin, 'config', 'uploadpack.allowFilter', 'true')
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    write(os.path.join(origin, 'VERSION.txt'), 'Build:     test-1\n')
    with open(os.path.join(HERE, '..', '..', 'stage-h9xash.ps1'), 'rb') as f:
        stage = f.read().decode('latin-1')
    write(os.path.join(origin, 'stage-h9xash.ps1'), stage + "\n$SkipNames += @('testonly_player.cfg')\n")
    write(os.path.join(origin, 'xash3d-h9-patches', 'overlay', 'networking.ini'), '[client]\nlist_bot=stock\n')
    write(os.path.join(origin, 'README.txt'), 'not in H9XASH, never fetched into the install\n')
    files = {
        'HAVOC 9.exe': b'MZ fake exe\0\1\2', 'h9xash.bat': '@echo off\necho hi\n', 'ts/liblist.gam': 'game "TS"\n',
        'ts/sound/x.wav': b'RIFF\0\0\0\0WAVE\n\n\x00\x01', 'ts/remove_me.txt': 'old\n', 'ts/keep_me.txt': 'old\n',
        'ts/zz_late.txt': 'v1\n', 'ts/folder with space/a b.txt': 'x\n',
        'ts/addons/amxmodx/data/gamedata/common.games/entities.games/gearbox/offsets-csittingcleansuitscientist.txt': 'deep\n',
        # the developer's own files, which never reach a player
        'ts/config.cfg': 'name "dev"\n', 'user_id.ini': '[client]\nid=' + 'a' * 32 + '\n', 'networking.ini': 'dev\n',
        'ts/tempdecal.wad': b'WAD3dev', 'ts/opengl.cfg.bak': 'x\n', 'ts/testonly_player.cfg': 'x\n',
        'ts/logs/L1.log': 'x\n', 'device_id.ini': '[device]\nid=' + 'b' * 32 + '\n',
        # the developer's database, which never reaches a player, and a map's SQL file, which does
        'ts/addons/amxmodx/data/sqlite3/arp.sq3': b'SQLite format 3\0dev', 'ts/stray.db': b'dev',
        'ts/addons/amxmodx/configs/arp/maps/h9_test/h9_test.sql': "INSERT OR IGNORE INTO arp_jobs VALUES ('Citizen',10,'');\n",
    }
    for rel, data in files.items():
        write(os.path.join(h, rel), data)
    git(origin, 'add', '-A')
    git(origin, 'commit', '-q', '-m', 'v1')

    print('a player\'s existing folder')
    player = {'ts/config.cfg': 'name "me"\n', 'user_id.ini': '[client]\nid=' + 'c' * 32 + '\n',
              'ts/tempdecal.wad': b'WAD3mine', 'ts/logos/myspray.png': b'png', 'ts/save/s.sav': b's',
              'ts/console_history.txt': 'rcon_password x\n', 'ts/screenshots/a.bmp': b'b',
              'ts/liblist.gam': 'game "TS" (old)\n', 'ts/testonly_player.cfg': 'mine\n',
              'ts/addons/amxmodx/data/sqlite3/arp.sq3': b'SQLite format 3\0mine'}
    for rel, data in player.items():
        write(os.path.join(install, rel), data)
    before = {rel: sha(os.path.join(install, rel)) for rel in player if rel != 'ts/liblist.gam'}

    def players_untouched(when):
        check(all(sha(os.path.join(install, r)) == s for r, s in before.items()), 'player files untouched ' + when)

    print('refusals')
    updater(['--dir', os.path.join(HERE, 'x'), '--source', 'git'], cmd, 1, 'a folder inside a git checkout')

    print('install over the existing folder')
    out = updater(common, cmd, 0, 'install')
    rel_ok = [r for r in files if not any(x in r for x in ('config.cfg', 'user_id', 'networking', 'tempdecal',
                                                           '.bak', 'testonly', 'logs/', 'device_id', 'sqlite3', '.db'))]
    check(all(read(os.path.join(install, r)).replace(b'\r\n', b'\n') == (files[r] if isinstance(files[r], bytes)
              else files[r].encode()) for r in rel_ok), 'every game file installed with its content')
    check(read(os.path.join(install, 'h9xash.bat')) == b'@echo off\r\necho hi\r\n', '.bat files get CRLF line ends')
    check(read(os.path.join(install, 'ts/sound/x.wav')) == files['ts/sound/x.wav'], 'binary files byte for byte')
    check(read(os.path.join(install, 'networking.ini')).startswith(b'[client]\r\nlist_bot=stock'),
          'networking.ini seeded from the overlay template')
    check(not os.path.exists(os.path.join(install, 'ts/opengl.cfg.bak')) and not os.path.exists(
        os.path.join(install, 'device_id.ini')) and not os.path.exists(os.path.join(install, 'ts/logs/L1.log')),
        'the developer\'s backups, device id and logs not installed')
    check(not os.path.exists(os.path.join(install, 'README.txt')), 'nothing outside H9XASH\\ installed')
    check(os.path.isdir(os.path.join(install, 'ts/addons/amxmodx/data/vault')), 'empty vault folder made')
    check(not os.path.exists(os.path.join(install, 'ts/stray.db')), 'the developer\'s database not installed')
    check(read(os.path.join(install, 'ts/addons/amxmodx/data/sqlite3/arp.sq3')) == b'SQLite format 3\0mine',
          'the player\'s own database is not replaced')
    check(os.path.isfile(os.path.join(install, 'ts/addons/amxmodx/configs/arp/maps/h9_test/h9_test.sql')),
          'a map\'s SQL file is installed')
    players_untouched('after install')
    st = json.load(open(os.path.join(install, '.h9xash-updater', 'installed.json')))
    check(len(st['files']) == len(rel_ok), 'installed.json owns the %d game files' % len(rel_ok))
    check('build test-1' in out, 'release build shown')

    print('no change: up to date')
    out = updater(common, cmd, 0, 'second run')
    check('up to date' in out, 'reports up to date')

    print('origin v2')
    write(os.path.join(h, 'ts/liblist.gam'), 'game "TS" v2\n')
    write(os.path.join(h, 'ts/new dir/new.txt'), 'new\n')
    write(os.path.join(h, 'ts/zz_late.txt'), 'v2\n')
    write(os.path.join(h, 'ts/video.cfg'), 'dev video\n')
    write(os.path.join(origin, 'VERSION.txt'), 'Build:     test-2\n')
    os.remove(os.path.join(h, 'ts/remove_me.txt'))
    os.remove(os.path.join(h, 'ts/keep_me.txt'))
    git(origin, 'add', '-A')
    git(origin, 'commit', '-q', '-m', 'v2')
    write(os.path.join(install, 'ts/keep_me.txt'), 'edited by the player\n')
    v1_liblist = read(os.path.join(install, 'ts/liblist.gam'))

    out = updater(common + ['--check'], cmd, 0, 'check only')
    check('changed files      2' in out and 'new files          1' in out and 'removed files      1' in out,
          'check shows 1 new, 2 changed, 1 removed')
    check(read(os.path.join(install, 'ts/liblist.gam')) == v1_liblist, 'check changed nothing')

    print('refuses while a program runs from the folder')
    fake = os.path.join(install, 'fakegame.exe')
    shutil.copyfile(os.path.join(os.environ.get('SystemRoot', 'C:\\Windows'), 'System32', 'PING.EXE'), fake)
    proc = subprocess.Popen([fake, '-n', '30', '127.0.0.1'], stdout=subprocess.DEVNULL)
    try:
        out = updater(common, cmd, 1, 'update while fakegame.exe runs')
        check('is running from this folder' in out, 'says the program is running')
    finally:
        proc.kill()
        proc.wait()
    os.remove(fake)
    check(read(os.path.join(install, 'ts/liblist.gam')) == v1_liblist, 'nothing changed while it ran')

    print('an update that fails part way undoes itself')
    held = open(os.path.join(install, 'ts/zz_late.txt'), 'rb')
    try:
        out = updater(common, cmd, 1, 'update with ts\\zz_late.txt held open')
    finally:
        held.close()
    check('Putting every file back' in out, 'says it puts the files back')
    check(read(os.path.join(install, 'ts/liblist.gam')) == v1_liblist, 'the file it had replaced is back')
    check(not os.path.exists(os.path.join(install, 'ts/new dir/new.txt')), 'the file it had added is gone')

    print('update')
    out = updater(common, cmd, 0, 'update')
    check(read(os.path.join(install, 'ts/liblist.gam')).replace(b'\r\n', b'\n') == b'game "TS" v2\n', 'changed file updated')
    check(os.path.isfile(os.path.join(install, 'ts/new dir/new.txt')), 'new file added')
    check(not os.path.exists(os.path.join(install, 'ts/remove_me.txt')), 'file the release removed is removed')
    check(read(os.path.join(install, 'ts/keep_me.txt')) == b'edited by the player\n', 'removed-but-edited file kept')
    check(not os.path.exists(os.path.join(install, 'ts/video.cfg')), 'a player-file name in the release not installed')
    players_untouched('after update')

    print('recovery from an unfinished update')
    journal = os.path.join(install, '.h9xash-updater', 'rollback', 'journal.jsonl')
    lines = read(journal).decode().splitlines()
    write(journal, '\n'.join(l for l in lines if '"done"' not in l) + '\n')
    out = updater(common + ['--check'], cmd, 0, 'run after an update that did not finish')
    check('did not finish' in out, 'notices the unfinished update')
    check(read(os.path.join(install, 'ts/liblist.gam')) == v1_liblist, 'and undid it')
    out = updater(common, cmd, 0, 'update again')

    print('rollback')
    out = updater(['--dir', install, '--cache', cache, '--rollback'], cmd, 0, 'rollback')
    check(read(os.path.join(install, 'ts/liblist.gam')) == v1_liblist, 'changed file back to v1')
    check(not os.path.exists(os.path.join(install, 'ts/new dir/new.txt')), 'added file removed')
    check(read(os.path.join(install, 'ts/remove_me.txt')).replace(b'\r\n', b'\n') == b'old\n', 'removed file back')
    players_untouched('after rollback')
    updater(['--dir', install, '--cache', cache, '--rollback'], cmd, 1, 'second rollback (nothing left)')
    out = updater(common + ['--check'], cmd, 0, 'check after rollback')
    check('changed files      2' in out, 'the next update would install v2 again')

    print('LFS pointer guard')
    write(os.path.join(h, 'ts/maps/m.bsp'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0' * 64 + '\nsize 9\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-q', '-m', 'v3 pointer')
    out = updater(common, cmd, 1, 'release with an LFS pointer')
    check('Git LFS pointers' in out, 'refuses to install pointer files')
    check(read(os.path.join(install, 'ts/liblist.gam')) == v1_liblist, 'and changed nothing')

    print('ZIP source')
    web = os.path.join(base, 'web')
    zinstall = os.path.join(base, 'games2', 'H9XASH')
    zcommon = ['--dir', zinstall, '--cache', os.path.join(base, 'games2', 'cache'), '--source', 'zip']

    def make_zip(extra, later=0):
        os.makedirs(web, exist_ok=True)
        path = os.path.join(web, 'H9XASH.zip')
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for rel, data in dict(files, **extra).items():
                if rel in ('ts/config.cfg', 'user_id.ini', 'device_id.ini'):
                    continue
                zf.writestr('H9XASH/' + rel, data)
        t = time.time() + later
        os.utime(path, (t, t))
    make_zip({'networking.ini': '[client]\nzip stock\n', 'ts/tempdecal.wad': b'WAD3stock'})
    srv, url = serve(web)
    try:
        zc = zcommon + ['--zip-url', url + '/H9XASH.zip']
        updater(zc, cmd, 0, 'install from the ZIP')
        check(read(os.path.join(zinstall, 'ts/tempdecal.wad')) == b'WAD3stock', 'stock spray seeded from the ZIP')
        check(read(os.path.join(zinstall, 'networking.ini')) == b'[client]\nzip stock\n', 'networking.ini from the ZIP')
        out = updater(zc, cmd, 0, 'ZIP unchanged')
        check('unchanged since the last download' in out and 'up to date' in out, 'no download when unchanged')
        make_zip({'networking.ini': 'zip v2\n', 'ts/tempdecal.wad': b'WAD3v2', 'ts/zip_new.txt': 'n\n'}, later=5)
        out = updater(zc, cmd, 0, 'ZIP changed')
        check(os.path.isfile(os.path.join(zinstall, 'ts/zip_new.txt')), 'new file from the new ZIP')
        check(read(os.path.join(zinstall, 'networking.ini')) == b'[client]\nzip stock\n', 'seeded files never replaced')
    finally:
        srv.shutdown()

    print('web source: stage-h9xash.ps1\'s publish step and the site\'s files/')
    wstage = os.path.join(base, 'web', 'stage', 'H9XASH')
    wfiles = os.path.join(base, 'web', 'files')
    rnd = random.Random(9)
    big1 = bytes(rnd.getrandbits(8) for _ in range(3 * 1048576))
    game = {'HAVOC 9.exe': b'MZ web\0', 'h9xash.bat': b'@echo off\r\n', 'h9xash.sh': b'#!/bin/sh\n',
            'ts/liblist.gam': b'game "TS" web1\r\n', 'ts/maps/big.bsp': big1, 'ts/a.txt': b'same\r\n',
            'ts/b.txt': b'same\r\n', 'ts/gone.txt': b'v1 only\r\n', 'ts/empty.cfg': b''}
    stock = {'networking.ini': b'[client]\r\nweb stock\r\n', 'ts/config.cfg': b'name "Player"\r\n',
             'ts/tempdecal.wad': b'WAD3webstock'}
    seeds = ['--seed', 'networking.ini', '--seed', 'ts\\config.cfg', '--seed', 'ts\\tempdecal.wad']

    def publish(build, expect=0):
        p = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'publish_files.py'), wstage, wfiles,
                            '--build', build] + seeds, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        check(p.returncode == expect, 'publish %s exits %d (got %d)' % (build, expect, p.returncode))
        if p.returncode != expect:
            print(p.stdout.decode('utf-8', 'replace'))
        return p.stdout.decode('utf-8', 'replace')

    def blobs():
        return set(n for n in os.listdir(wfiles) if re.match(r'^[0-9a-f]{64}$', n))

    for rel, data in dict(game, **stock).items():
        write(os.path.join(wstage, rel), data)
    write(os.path.join(wstage, 'user_id.ini'), '[client]\r\nid=%s\r\n' % ('a' * 32))
    publish('web-0', 1)
    check(not os.path.exists(os.path.join(wfiles, 'manifest.json')), 'a player\'s file in the stage stops the publish')
    os.remove(os.path.join(wstage, 'user_id.ini'))
    publish('web-1')
    man = json.load(open(os.path.join(wfiles, 'manifest.json')))
    check(len(man['files']) == len(game) and len(man['seeds']) == 3, 'manifest: every game file, and 3 seeds')
    check(blobs() == set(hashlib.sha256(d).hexdigest() for d in list(game.values()) + list(stock.values())),
          'each distinct file stored once, named by its SHA-256')
    check([e['mode'] for e in man['files'] if e['path'] == 'h9xash.sh'] == ['0755'], '.sh files have mode 0755')
    check(os.path.isfile(os.path.join(wfiles, '.htaccess')), '.htaccess for Apache hosts written')
    Gated.root = wfiles
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Gated)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    wurl = 'http://127.0.0.1:%d/files/' % srv.server_address[1]
    good = {'X-H9-Updater': '1', 'User-Agent': 'H9XASH-Updater/test'}
    try:
        check(fetch(wurl + 'manifest.json', {'User-Agent': 'Mozilla/5.0'}) == 404 and
              fetch(wurl + 'manifest.json', {'User-Agent': 'H9XASH-Updater/test'}) == 404 and
              fetch(wurl + 'manifest.json', good) == 200 and fetch(wurl, good) == 404 and
              fetch(wurl + '.htaccess', good) == 404, 'the stand-in hides files/ as the server rules do')
        winst = os.path.join(base, 'games5', 'H9XASH')
        write(os.path.join(winst, 'ts/config.cfg'), 'name "me"\r\n')
        wcommon = ['--dir', winst, '--cache', os.path.join(base, 'games5', 'cache'), '--web-url', wurl]
        wcache = os.path.join(base, 'games5', 'cache', 'web', 'files')
        Gated.seen = []
        updater(wcommon, cmd, 0, 'install from the web (the default source)')
        check(all(read(os.path.join(winst, r)) == d for r, d in game.items()), 'every game file installed byte for byte')
        check(read(os.path.join(winst, 'networking.ini')) == stock['networking.ini'] and
              read(os.path.join(winst, 'ts/tempdecal.wad')) == stock['ts/tempdecal.wad'], 'missing seeds put in')
        check(read(os.path.join(winst, 'ts/config.cfg')) == b'name "me"\r\n', 'the player\'s config.cfg untouched')
        got = [n for n, c, _r in Gated.seen if c == 200 and n != 'manifest.json']
        want = set(hashlib.sha256(d).hexdigest() for d in list(game.values()) + [stock['networking.ini'],
                                                                                 stock['ts/tempdecal.wad']] if d)
        check(len(got) == len(set(got)) and set(got) == want, 'each needed file downloaded once (an empty one not '
              'at all, and not the seed of the player\'s own config.cfg)')
        check(os.path.isfile(os.path.join(winst, 'ts/empty.cfg')) and not read(os.path.join(winst, 'ts/empty.cfg')),
              'an empty file is installed without a download')
        check(not os.path.isdir(wcache) or not os.listdir(wcache), 'the download cache emptied after the update')
        Gated.seen = []
        out = updater(wcommon, cmd, 0, 'second web run')
        check('up to date' in out and Gated.seen == [('manifest.json', 304, None)],
              'second run: manifest answered 304, nothing downloaded')

        print('web v2: one changed, one new, one removed')
        write(os.path.join(wstage, 'ts/liblist.gam'), b'game "TS" web2\r\n')
        write(os.path.join(wstage, 'ts/new.txt'), b'new in 2\r\n')
        os.remove(os.path.join(wstage, 'ts/gone.txt'))
        v1_gone = hashlib.sha256(game['ts/gone.txt']).hexdigest()
        publish('web-2')
        check(v1_gone in blobs() and os.path.isfile(os.path.join(wfiles, 'manifest.previous.json')),
              'the previous release\'s files stay published')
        Gated.seen = []
        out = updater(wcommon + ['--check'], cmd, 0, 'web check only')
        check([n for n, c, _r in Gated.seen if n != 'manifest.json'] == [] and read(
            os.path.join(winst, 'ts/liblist.gam')) == game['ts/liblist.gam'], 'check only: no file downloaded, none changed')
        Gated.seen = []
        updater(wcommon, cmd, 0, 'web update to 2')
        check(sorted(n for n, c, _r in Gated.seen if n != 'manifest.json') == sorted(
            [hashlib.sha256(b'game "TS" web2\r\n').hexdigest(), hashlib.sha256(b'new in 2\r\n').hexdigest()]),
            'only the changed and the new file downloaded')
        check(read(os.path.join(winst, 'ts/liblist.gam')) == b'game "TS" web2\r\n' and
              os.path.isfile(os.path.join(winst, 'ts/new.txt')) and not os.path.exists(os.path.join(winst, 'ts/gone.txt')),
              'changed file updated, new one added, removed one removed')

        print('web v3: a download cut short goes on from where it stopped')
        big3 = bytes(rnd.getrandbits(8) for _ in range(3 * 1048576))
        write(os.path.join(wstage, 'ts/maps/big.bsp'), big3)
        publish('web-3')
        check(v1_gone not in blobs(), 'files in neither the current nor the previous release are removed')
        sha3 = hashlib.sha256(big3).hexdigest()
        write(os.path.join(wcache, sha3 + '.part'), big3[:1048576])
        Gated.seen = []
        updater(wcommon, cmd, 0, 'web update to 3 over a part-downloaded file')
        check((sha3, 206, 'bytes=1048576-') in Gated.seen and read(os.path.join(winst, 'ts/maps/big.bsp')) == big3,
              'resumed with a Range request, and the file is whole')

        print('web v4: a damaged part is downloaded again')
        big4 = bytes(rnd.getrandbits(8) for _ in range(3 * 1048576))
        write(os.path.join(wstage, 'ts/maps/big.bsp'), big4)
        publish('web-4')
        sha4 = hashlib.sha256(big4).hexdigest()
        write(os.path.join(wcache, sha4 + '.part'), b'\0' * 1048576)
        Gated.seen = []
        updater(wcommon, cmd, 0, 'web update to 4 over a damaged part')
        check([c for n, c, _r in Gated.seen if n == sha4] == [206, 200] and
              read(os.path.join(winst, 'ts/maps/big.bsp')) == big4, 'the mismatch is caught, the file downloaded whole')
        updater(['--dir', winst, '--cache', os.path.join(base, 'games5', 'cache'), '--rollback'], cmd, 0, 'web rollback')
        check(read(os.path.join(winst, 'ts/maps/big.bsp')) == big3, 'rollback puts build 3\'s file back')

        print('web v5: a file the manifest names is missing on the site')
        write(os.path.join(wstage, 'ts/liblist.gam'), b'game "TS" web5\r\n')
        publish('web-5')
        os.remove(os.path.join(wfiles, hashlib.sha256(b'game "TS" web5\r\n').hexdigest()))
        out = updater(wcommon, cmd, 1, 'web update with a file missing')
        check('(404)' in out and read(os.path.join(winst, 'ts/liblist.gam')) == b'game "TS" web2\r\n',
              'stops with the 404, nothing changed')

        print('web: a manifest that names a path outside the folder')
        bad = os.path.join(base, 'web', 'bad')
        write(os.path.join(bad, 'manifest.json'), json.dumps({'format': 1, 'build': 'x', 'seeds': [], 'files': [
            {'path': '../evil.txt', 'size': 1, 'sha256': '0' * 64, 'mode': '0644'}]}))
        Gated.root = bad
        out = updater(wcommon, cmd, 1, 'web manifest with ../')
        check('refuses' in out and not os.path.exists(os.path.join(base, 'games5', 'evil.txt')), 'refused, nothing written')
    finally:
        srv.shutdown()

    print('account step against a stand-in for havoc9.org')
    approved = {'n': 0}

    class Site(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith('/api/link/start'):
                body = {'status': 'ok', 'userCode': 'WDJB-MJHT', 'deviceCode': 'D' * 43, 'interval': 1,
                        'expiresIn': 30, 'linkUrl': 'http://x/link/?code=WDJB-MJHT'}
                approved['start'] = self.path
            elif self.path.startswith('/api/link/poll'):
                approved['n'] += 1
                body = {'status': 'pending'} if approved['n'] < 2 else \
                    {'status': 'approved', 'playerId': 'e' * 32, 'account': 'tester', 'token': 'T' * 43}
            else:
                body = {}
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    h9link.webbrowser.open = lambda *x, **k: None
    linst = os.path.join(base, 'games3', 'H9XASH')
    # what the folder holds before: a plain id (enter_userid.cmd), its .bak, and another Windows
    # user's sealed record (made here with another key, so this user cannot open it)
    saved = h9link.ENTROPY
    h9link.ENTROPY = b'another user'
    other = h9link.protect(b'h9id=1\nid=' + b'f' * 32 + b'\n').hex()
    h9link.ENTROPY = saved
    write(os.path.join(linst, 'user_id.ini'), '[client]\r\nid=%s\r\nprotected=%s\r\n' % ('c' * 32, other))
    write(os.path.join(linst, 'user_id.ini.bak'), '[client]\r\nid=%s\r\n' % ('d' * 32))
    check(h9link.status(linst)[0] == 'not-linked', 'a plain id is not linked')
    lsite = 'http://127.0.0.1:%d' % srv.server_address[1]
    try:
        ok = h9link.link(linst, say=lambda s: None, site=lsite)
    finally:
        srv.shutdown()
    text = read(os.path.join(linst, 'user_id.ini'))
    check(ok and h9link.status(linst)[0] == 'linked', 'linked after the code is approved')
    check(b'e' * 32 not in text and b'c' * 32 not in text and b'\nid=' not in text, 'user_id.ini holds no plain id')
    check(not os.path.exists(os.path.join(linst, 'user_id.ini.bak')), 'the plain id\'s .bak is gone')
    check(text.count(b'protected=') == 2 and other.encode() in text, 'the other user\'s record is kept')
    check(text.startswith(b'; user_id.ini -- this install\'s client id.') and b'\r\n[client]\r\n' in text,
          'user_id.ini is laid out as the engine writes it')
    mine = h9link.read_store(linst)[0]
    check(mine and mine['id'] == mine['linked'] == 'e' * 32 and mine['account'] == 'tester', 'the record is the engine\'s')
    first = bytes.fromhex(h9link._client_values(text.decode().splitlines(), 'protected')[0])
    check(h9link.unprotect(first) == ('h9id=1\nid=%s\nlinked=%s\naccount=tester\ntoken=%s\nsite=%s\n'
                                      % ('e' * 32, 'e' * 32, 'T' * 43, lsite)).encode(),
          'the record, field for field in the engine\'s order, ends with site= the site the token came from')
    check(mine['site'] == lsite and h9link.status(linst)[1] == 'linked to %s account tester' % lsite[7:],
          'the link belongs to the local test site, and the status names it')

    print('the site a link belongs to (site=, as cl_h9link.c reads it)')
    sinst = os.path.join(base, 'games6', 'H9XASH')

    def sealed(record):
        write(os.path.join(sinst, 'user_id.ini'), '[client]\r\nprotected=%s\r\n' % h9link.protect(record).hex())
        return h9link.read_store(sinst)[0]
    base_rec = b'h9id=1\nid=' + b'e' * 32 + b'\nlinked=' + b'e' * 32 + b'\naccount=tester\ntoken=' + b'T' * 43 + b'\n'
    check(sealed(base_rec)['site'] == 'https://havoc9.org' and h9link.status(sinst)[0] == 'linked',
          'a linked record from before site= belongs to https://havoc9.org')
    check(sealed(base_rec + b'site=https://evil.example\n')['site'] == 'https://havoc9.org',
          'a site the game does not take counts as https://havoc9.org, as the engine reads it')
    check(sealed(base_rec + b'site=http://localhost:8090\n')['site'] == 'http://localhost:8090',
          'http://localhost:<port> is a local test site')
    check(sealed(b'h9id=1\nid=' + b'e' * 32 + b'\nsite=https://havoc9.org\n').get('linked') is None and
          h9link.status(sinst)[0] == 'not-linked', 'site= alone links nothing')
    nosite = os.path.join(base, 'games7', 'H9XASH')
    check(not h9link.link(nosite, say=lambda s: None, site='https://example.com') and not os.path.exists(nosite),
          'a site the game would not take is refused before anything is asked or written')
    dev = read(os.path.join(linst, 'device_id.ini')).decode()
    check(dev.startswith('[device]\nid=') and len(dev.strip().split('=')[1]) == 32, 'device_id.ini made in the engine form')
    check('device=' in approved.get('start', '') and 'os=' in approved.get('start', ''), 'start sends the device hash and os')
    blob = bytes.fromhex(h9link._client_values(text.decode().splitlines(), 'protected')[0])
    check(h9link.unprotect(blob) is not None, 'this Windows user opens the blob')
    down = os.path.join(base, 'games4', 'H9XASH')
    check(not h9link.link(down, say=lambda s: None, site='http://127.0.0.1:9') and not os.path.exists(
        os.path.join(down, 'device_id.ini')), 'site down: not linked, and no device_id.ini left behind')
    saved = h9link.ENTROPY
    h9link.ENTROPY = b'some other install'
    check(h9link.unprotect(blob) is None, 'the blob does not open with another key')
    h9link.ENTROPY = saved

    print()
    print('FAILED: %d' % len(FAILS) if FAILS else 'ALL PASSED')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
