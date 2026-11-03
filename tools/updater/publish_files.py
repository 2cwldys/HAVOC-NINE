#!/usr/bin/env python3
# publish_files.py -- publishes a staged H9XASH folder for H9XASH-Updater's web source. The folder it
# writes is what the site serves as https://havoc9.org/files/:
#   manifest.json           the release: its build, and every file's path, size, SHA-256 and mode
#   manifest.previous.json  the release before it (kept here, never served: only its files are)
#   <sha256>                each distinct file once, named by its SHA-256, the previous
#                           release's included, so a player in the middle of an update finishes it
#   .htaccess               for an Apache host: anything but the updater gets 404, and no listing
# stage-h9xash.ps1 runs it on the tree it zips, so the web release is exactly the ZIP's. The files a
# new player starts from (stage-h9xash.ps1's stock config.cfg, networking.ini, tempdecal.wad) go in
# as "seeds", which the updater copies only into a folder that has none.
#
# A new file is written as <sha256>.part, checked, and renamed. Every file is in place before the
# manifest that names it; files neither manifest names are removed after the manifest is written.
# Copy the folder to the site's files/ the same way: rsync -a --delay-updates --delete-after, or
# robocopy /MIR (README_UPDATER.txt, section 3).
#
#   py -3 -I publish_files.py <staged H9XASH folder> <files folder> --build <build> [--seed <path>]...

import argparse
import hashlib
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from h9xash_updater import Rules  # noqa: E402  (the updater's own list of player files)

HEX64 = re.compile(r'^[0-9a-f]{64}$')
HTACCESS = """# H9XASH-Updater's files (tools/updater/README_UPDATER.txt in the HAVOC-NINE repository), written by
# publish_files.py at every publish. A request without the updater's X-H9-Updater header and
# User-Agent gets 404, and so does any name but a file's SHA-256 or manifest.json; there is no
# listing. This keeps the folder out of browsers and search engines. It is not access control:
# the files are the public game files, and anyone can send those two headers.
Options -Indexes
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{HTTP:X-H9-Updater} !^1$ [OR]
    RewriteCond %{HTTP_USER_AGENT} !^H9XASH-Updater/
    RewriteRule ^ - [R=404,L]
    RewriteRule !^([0-9a-f]{64}|manifest\\.json)$ - [R=404,L]
</IfModule>
<IfModule !mod_rewrite.c>
    Require all denied
</IfModule>
<IfModule mod_headers.c>
    Header append Vary "X-H9-Updater, User-Agent"
    <Files "manifest.json">
        Header set Cache-Control "no-cache"
    </Files>
    <FilesMatch "^[0-9a-f]{64}$">
        ForceType application/octet-stream
        Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>
</IfModule>
"""


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def walk(stage):
    for dirpath, dirs, files in os.walk(stage):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue
            yield os.path.relpath(full, stage).replace(os.sep, '/'), full


def load(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def entries_of(manifest):
    if not manifest:
        return []
    return list(manifest.get('files') or []) + list(manifest.get('seeds') or [])


def write_manifest(path, manifest):
    head = {k: v for k, v in manifest.items() if k not in ('files', 'seeds')}
    out = ['{']
    for k in sorted(head):
        out.append(' %s: %s,' % (json.dumps(k), json.dumps(head[k])))
    for key in ('files', 'seeds'):
        out.append(' %s: [' % json.dumps(key))
        rows = [json.dumps(e, separators=(', ', ': '), sort_keys=True) for e in manifest[key]]
        out.append(',\n'.join('  ' + r for r in rows))
        out.append(' ],' if key == 'files' else ' ]')
    out.append('}')
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out) + '\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description='Publishes a staged H9XASH folder for H9XASH-Updater\'s web source.')
    ap.add_argument('stage', help='the staged H9XASH folder (what the ZIP holds)')
    ap.add_argument('out', help='the files folder (the site serves it as /files/)')
    ap.add_argument('--build', required=True, help='the build, from VERSION.txt')
    ap.add_argument('--name', default='H9XASH')
    ap.add_argument('--seed', action='append', default=[],
                    help='a file a new player starts from (installed only where there is none); repeatable')
    ap.add_argument('--verify', action='store_true', help='check the SHA-256 of the files already published too')
    a = ap.parse_args()
    stage, out = os.path.abspath(a.stage), os.path.abspath(a.out)
    if not os.path.isdir(os.path.join(stage, 'ts')):
        print('STOPPED: %s has no ts folder' % stage)
        return 1
    os.makedirs(out, exist_ok=True)
    seeds = set(s.replace('\\', '/').lower() for s in a.seed)
    rules = Rules()

    files, seed_rows, problems = [], [], []
    sources = {}
    for rel, full in walk(stage):
        size = os.path.getsize(full)
        sha = sha256_of(full)
        row = {'path': rel, 'size': size, 'sha256': sha, 'mode': '0755' if rel.lower().endswith('.sh') else '0644'}
        sources.setdefault(sha, full)
        if rel.lower() in seeds:
            seed_rows.append(row)
        elif rules.skip_reason(rel):
            problems.append('%s (%s)' % (rel, rules.skip_reason(rel)))
        else:
            files.append(row)
    if problems:
        print('STOPPED: the stage holds files that belong to a player or a server, so nothing was published:')
        for p in problems[:20]:
            print('  ' + p)
        return 1

    # every file in place before the manifest that names it
    new_blobs = new_bytes = 0
    for sha, full in sorted(sources.items()):
        dest = os.path.join(out, sha)
        size = os.path.getsize(full)
        if os.path.isfile(dest) and os.path.getsize(dest) == size and (not a.verify or sha256_of(dest) == sha):
            continue
        part = dest + '.part'
        h = hashlib.sha256()
        with open(full, 'rb') as fi, open(part, 'wb') as fo:
            while True:
                b = fi.read(1 << 20)
                if not b:
                    break
                fo.write(b)
                h.update(b)
            fo.flush()
            os.fsync(fo.fileno())
        if h.hexdigest() != sha:
            os.remove(part)
            print('STOPPED: %s changed while it was copied' % full)
            return 1
        os.replace(part, dest)
        new_blobs += 1
        new_bytes += size

    manifest_path = os.path.join(out, 'manifest.json')
    previous_path = os.path.join(out, 'manifest.previous.json')
    current = load(manifest_path)
    manifest = {'format': 1, 'name': a.name, 'build': a.build,
                'published': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'count': len(files), 'bytes': sum(r['size'] for r in files), 'files': files, 'seeds': seed_rows}
    same = current is not None and current.get('files') == files and current.get('seeds') == seed_rows \
        and current.get('build') == a.build
    if same:
        print('  the release is the one already published: manifest.json left as it was')
    else:
        if current is not None and (current.get('files') != files or current.get('seeds') != seed_rows):
            write_manifest(previous_path, current)
        write_manifest(manifest_path, manifest)

    # files neither manifest names go, after the manifest
    keep = set(e.get('sha256') for e in entries_of(load(manifest_path)) + entries_of(load(previous_path)))
    pruned = 0
    for name in os.listdir(out):
        if name.endswith('.part') or name.endswith('.tmp') or (HEX64.match(name) and name not in keep):
            os.remove(os.path.join(out, name))
            pruned += HEX64.match(name) is not None
    hpath = os.path.join(out, '.htaccess')
    try:
        with open(hpath, 'r', encoding='ascii') as f:
            old = f.read()
    except OSError:
        old = None
    if old != HTACCESS:
        with open(hpath, 'w', encoding='ascii', newline='\n') as f:
            f.write(HTACCESS)
    blobs = sum(1 for n in os.listdir(out) if HEX64.match(n))
    print('  %d files and %d seeds of build %s; %d distinct files in %s, %d new (%.0f MB), %d removed'
          % (len(files), len(seed_rows), a.build, blobs, out, new_blobs, new_bytes / 1048576.0, pruned))
    print('  manifest.json SHA-256 %s' % sha256_of(manifest_path))
    return 0


if __name__ == '__main__':
    sys.exit(main())
