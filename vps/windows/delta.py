#!/usr/bin/env python3
"""delta.py -- releases that upload only what changed (deploy-vps.ps1, vps\\windows\\receive-deploy.ps1).

A client ZIP, or the web client's package, is a list of files. The host keeps every file it has seen once, named by its SHA-256 (the
updater's files in site\\files, and a store of its own for the rest), so a release does not need to send a ZIP: it sends a RECIPE (the
list: path, mode, date, SHA-256) and only the files the host lacks, and the host builds the ZIP itself. Nothing is taken on trust:
every file is hashed when it arrives and again when it goes into a ZIP, and the finished list must hash to the recipe's tree.

On the PC that builds (Python 3.8 or later, standard library only):
    delta.py plan --out-dir D --have FILE [--have FILE ...] --zip NAME=PATH [--zip NAME=PATH ...] [--max-mb 400]
        reads each ZIP, writes D\\<NAME>.recipe.json and D\\blobs-<n>.tar (the files no --have file names, once each) and prints one
        line "PLAN <json>" with the trees and sizes.
On the host (C:\\havoc9\\delta.py, run by receive-deploy.ps1; the host's Python):
    delta.py have --store S --files F             the SHA-256 of every file the host holds, one per line
    delta.py ingest TAR [TAR ...] --store S       takes a blobs tar into the store (every name a SHA-256, every file hashed)
    delta.py assemble-zip RECIPE OUT --store S --files F   builds a ZIP from a recipe
    delta.py assemble-dir RECIPE OUTDIR --store S --files F  lays a recipe out as a folder (copies; --link makes hard links)
    delta.py seed-zip ZIP [ZIP ...] --store S     files the ZIP holds into the store (a first run)
    delta.py seed-dir DIR [DIR ...] --store S     the files of a folder, copied into the store
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import zipfile

SHA = re.compile(r"^[0-9a-f]{64}$")
CHUNK = 1024 * 1024
MAX_ENTRIES = 200000


def die(msg):
    sys.stderr.write("delta.py: %s\n" % msg)
    sys.exit(1)


def safe_path(p):
    q = p.replace("\\", "/")
    if not q or q.startswith("/") or re.match(r"^[A-Za-z]:", q) or "\x00" in q:
        die("a path that is not relative: %r" % p)
    if any(part == ".." for part in q.split("/")):
        die("a path that climbs out of its folder: %r" % p)
    return q


def tree_of(entries):
    h = hashlib.sha256()
    for e in entries:
        h.update(("%s\t%s\t%s\n" % (e["path"], e.get("mode", 0), e.get("sha256", "dir"))).encode("utf-8"))
    return h.hexdigest()


def blob_path(sha, store, files):
    for base, sub in ((files, False), (store, True)):
        if not base:
            continue
        p = os.path.join(base, sha[:2], sha) if sub else os.path.join(base, sha)
        if os.path.isfile(p):
            return p
    return None


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(CHUNK)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


# ---- the PC that builds ------------------------------------------------------------------------------------------------------------------

def recipe_of_zip(zip_path):
    entries = []
    with zipfile.ZipFile(zip_path) as zf:
        for i in zf.infolist():
            if len(entries) >= MAX_ENTRIES:
                die("too many entries in " + zip_path)
            path = safe_path(i.filename)
            e = {"path": path, "time": list(i.date_time), "attr": i.external_attr, "system": i.create_system, "ct": i.compress_type}
            if i.is_dir():
                e["dir"] = True
            else:
                h = hashlib.sha256()
                with zf.open(i) as f:
                    while True:
                        b = f.read(CHUNK)
                        if not b:
                            break
                        h.update(b)
                e["sha256"] = h.hexdigest()
                e["size"] = i.file_size
            e["mode"] = i.external_attr
            entries.append(e)
    return entries


def cmd_plan(a):
    have = set()
    for hf in a.have or []:
        for line in open(hf, encoding="ascii", errors="replace"):
            m = re.search(r"\b([0-9a-f]{64})\b", line)
            if m:
                have.add(m.group(1))
    os.makedirs(a.out_dir, exist_ok=True)
    for f in os.listdir(a.out_dir):
        if f.endswith(".recipe.json") or re.match(r"^blobs-\d+\.tar$", f):
            os.remove(os.path.join(a.out_dir, f))
    where = {}          # sha -> (zip path, entry path)
    summary = {"sources": {}, "tars": []}
    for spec in a.zip:
        name, _, path = spec.partition("=")
        if not name or not path or not re.match(r"^[A-Za-z0-9._-]+$", name):
            die("--zip NAME=PATH, NAME letters, digits, . _ -")
        entries = recipe_of_zip(path)
        rec = {"format": 1, "name": name, "entries": entries, "tree": tree_of(entries)}
        with open(os.path.join(a.out_dir, name + ".recipe.json"), "w", encoding="ascii") as f:
            json.dump(rec, f, separators=(",", ":"))
        files = [e for e in entries if not e.get("dir")]
        for e in files:
            where.setdefault(e["sha256"], (path, e["path"], e["size"]))
        summary["sources"][name] = {"tree": rec["tree"], "files": len(files), "bytes": sum(e["size"] for e in files)}
    need = [s for s in where if s not in have]
    need.sort(key=lambda s: -where[s][2])
    maxb = int(a.max_mb * 1024 * 1024)
    zips = {}
    n, cur, cur_size, tf = 0, None, 0, None
    try:
        for s in need:
            zpath, epath, size = where[s]
            if tf is None or (cur_size and cur_size + size > maxb):
                if tf:
                    tf.close()
                n += 1
                cur = os.path.join(a.out_dir, "blobs-%d.tar" % n)
                tf = tarfile.open(cur, "w", format=tarfile.USTAR_FORMAT)
                cur_size = 0
                summary["tars"].append(os.path.basename(cur))
            zf = zips.get(zpath) or zips.setdefault(zpath, zipfile.ZipFile(zpath))
            ti = tarfile.TarInfo(s)
            ti.size = size
            ti.mode = 0o644
            with zf.open(epath) as f:
                tf.addfile(ti, f)
            cur_size += size
    finally:
        if tf:
            tf.close()
        for z in zips.values():
            z.close()
    summary["new_files"] = len(need)
    summary["new_bytes"] = sum(where[s][2] for s in need)
    print("PLAN " + json.dumps(summary))


# ---- the host ----------------------------------------------------------------------------------------------------------------------------

def cmd_have(a):
    seen = set()
    if a.files and os.path.isdir(a.files):
        for n in os.listdir(a.files):
            if SHA.match(n):
                seen.add(n)
    if a.store and os.path.isdir(a.store):
        for d in os.listdir(a.store):
            p = os.path.join(a.store, d)
            if len(d) == 2 and os.path.isdir(p):
                for n in os.listdir(p):
                    if SHA.match(n):
                        seen.add(n)
    for s in sorted(seen):
        print("have " + s)


def store_put(src, sha, store, move):
    dst_dir = os.path.join(store, sha[:2])
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, sha)
    if os.path.isfile(dst):
        if move:
            os.remove(src)
        return
    if move:
        os.replace(src, dst)
    else:
        # a copy, never a hard link: a live file that is rewritten in place (robocopy does that) would change the stored one with it
        shutil.copyfile(src, dst)


def cmd_ingest(a):
    os.makedirs(a.store, exist_ok=True)
    tmp = os.path.join(a.store, ".incoming")
    os.makedirs(tmp, exist_ok=True)
    total = 0
    for tar in a.tar:
        with tarfile.open(tar, "r") as tf:
            for m in tf:
                if not m.isreg() or not SHA.match(m.name):
                    die("%s holds something that is not a file named by a SHA-256: %r" % (os.path.basename(tar), m.name))
                part = os.path.join(tmp, m.name)
                h = hashlib.sha256()
                with tf.extractfile(m) as src, open(part, "wb") as out:
                    while True:
                        b = src.read(CHUNK)
                        if not b:
                            break
                        h.update(b)
                        out.write(b)
                if h.hexdigest() != m.name:
                    os.remove(part)
                    die("%s: the file %s is not what its name says" % (os.path.basename(tar), m.name))
                store_put(part, m.name, a.store, True)
                total += 1
    print("ingested %d files" % total)


def load_recipe(path):
    rec = json.load(open(path, encoding="ascii"))
    if rec.get("format") != 1 or not isinstance(rec.get("entries"), list) or len(rec["entries"]) > MAX_ENTRIES:
        die("not a recipe: " + path)
    for e in rec["entries"]:
        safe_path(e["path"])
        if not e.get("dir") and not SHA.match(e.get("sha256", "")):
            die("a recipe entry without a SHA-256: %r" % e.get("path"))
    if tree_of(rec["entries"]) != rec.get("tree"):
        die("the recipe does not hash to its own tree: " + path)
    return rec


def cmd_assemble_zip(a):
    rec = load_recipe(a.recipe)
    missing = sorted({e["sha256"] for e in rec["entries"] if not e.get("dir") and not blob_path(e["sha256"], a.store, a.files)})
    if missing:
        die("%d files the recipe names are not on this host (first: %s)" % (len(missing), missing[0]))
    tmp = a.out + ".part"
    got = []
    with zipfile.ZipFile(tmp, "w", allowZip64=True) as zf:
        for e in rec["entries"]:
            zi = zipfile.ZipInfo(e["path"], tuple(e["time"]))
            zi.create_system = e["system"]
            zi.external_attr = e["attr"]
            zi.compress_type = e["ct"]
            if e.get("dir"):
                zf.writestr(zi, b"")
                zf.filelist[-1].external_attr = e["attr"]       # the writer sets its own for a folder
                got.append(e)
                continue
            h = hashlib.sha256()
            with open(blob_path(e["sha256"], a.store, a.files), "rb") as src, zf.open(zi, "w", force_zip64=e["size"] > (1 << 30)) as dst:
                while True:
                    b = src.read(CHUNK)
                    if not b:
                        break
                    h.update(b)
                    dst.write(b)
            if h.hexdigest() != e["sha256"]:
                zf.close()
                os.remove(tmp)
                die("the file for %s is not the one the recipe names" % e["path"])
            zf.filelist[-1].external_attr = e["attr"]           # the writer sets its own when the recorded one is 0
            got.append(e)
    os.replace(tmp, a.out)
    print("assembled %s: %d entries, %.0f MB, tree %s" % (os.path.basename(a.out), len(got), os.path.getsize(a.out) / 1e6, rec["tree"][:12]))


def cmd_assemble_dir(a):
    rec = load_recipe(a.recipe)
    n = 0
    for e in rec["entries"]:
        if e.get("dir"):
            continue
        src = blob_path(e["sha256"], a.store, a.files)
        if not src:
            die("a file the recipe names is not on this host: " + e["sha256"])
        dst = os.path.join(a.out, *e["path"].split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            os.remove(dst)
        if a.link:
            try:
                os.link(src, dst)
            except OSError:
                shutil.copyfile(src, dst)
        else:
            shutil.copyfile(src, dst)
        if sha_file(dst) != e["sha256"]:
            die("the file for %s is not the one the recipe names" % e["path"])
        n += 1
    print("laid out %d files in %s, tree %s" % (n, a.out, rec["tree"][:12]))


def cmd_seed_zip(a):
    os.makedirs(a.store, exist_ok=True)
    tmp = os.path.join(a.store, ".incoming")
    os.makedirs(tmp, exist_ok=True)
    n = 0
    for z in a.zip:
        with zipfile.ZipFile(z) as zf:
            for i in zf.infolist():
                if i.is_dir():
                    continue
                part = os.path.join(tmp, "seed.part")
                h = hashlib.sha256()
                with zf.open(i) as src, open(part, "wb") as out:
                    while True:
                        b = src.read(CHUNK)
                        if not b:
                            break
                        h.update(b)
                        out.write(b)
                s = h.hexdigest()
                if blob_path(s, a.store, a.files):
                    os.remove(part)
                else:
                    store_put(part, s, a.store, True)
                    n += 1
    print("seeded %d new files" % n)


def cmd_seed_dir(a):
    os.makedirs(a.store, exist_ok=True)
    n = 0
    for root in a.dir:
        for base, _, names in os.walk(root):
            for name in names:
                path = os.path.join(base, name)
                s = sha_file(path)
                if not blob_path(s, a.store, a.files):
                    store_put(path, s, a.store, False)
                    n += 1
    print("seeded %d new files" % n)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("plan")
    s.add_argument("--out-dir", required=True)
    s.add_argument("--have", action="append")
    s.add_argument("--zip", action="append", required=True)
    s.add_argument("--max-mb", type=float, default=400)
    s.set_defaults(f=cmd_plan)
    for name, f, pos in (("have", cmd_have, []), ("ingest", cmd_ingest, [("tar", "+")]), ("assemble-zip", cmd_assemble_zip, [("recipe", None), ("out", None)]),
                         ("assemble-dir", cmd_assemble_dir, [("recipe", None), ("out", None)]), ("seed-zip", cmd_seed_zip, [("zip", "+")]),
                         ("seed-dir", cmd_seed_dir, [("dir", "+")])):
        s = sub.add_parser(name)
        for n, nargs in pos:
            s.add_argument(n, nargs=nargs) if nargs else s.add_argument(n)
        s.add_argument("--store", required=True)
        s.add_argument("--files", default="")
        s.add_argument("--link", action="store_true")
        s.set_defaults(f=f)
    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
