#!/usr/bin/env python3
"""delta.py -- releases that upload only what changed (deploy-vps.ps1, vps\\windows\\receive-deploy.ps1).

A client ZIP, or the web client's package, is a list of files. The host keeps every file it has seen once, named by its SHA-256 (the
updater's files in site\\files, and a store of its own for the rest), so a release does not need to send a ZIP: it sends a RECIPE (the
list: path, mode, date, SHA-256) and only the files the host lacks, and the host builds the ZIP itself. Nothing is taken on trust:
every file is hashed when it arrives and again when it goes into a ZIP, and the finished list must hash to the recipe's tree.
The host's ZIP holds the same files in the same list as the one a PC would build, not the same bytes: a ZIP's bytes depend on the zlib
that compressed it.

The PC does not have to build the ZIP either. The stage can write a LIST instead (stage-h9xash.ps1 -Lists, make-vps-package.ps1
-WebClientList): the entries the package would hold, each with the file it comes from, and "plan --list" reads that. Reading a
1 GB ZIP back to hash it, and writing it in the first place, took longer than the rest of the stage.

On the host, a file that has gone into a ZIP leaves its deflate stream behind (store\\z\\xx\\<sha>.z6, with the file's CRC and a hash of
the stream), so the next ZIP copies the streams of the files it has had before and compresses only the new ones.

On the PC that builds (Python 3.8 or later, standard library only):
    delta.py plan --out-dir D --have FILE [--have FILE ...] (--zip NAME=PATH | --list NAME=PATH) ... [--max-mb 400]
        reads each ZIP (or list), writes D\\<NAME>.recipe.json and D\\blobs-<n>.tar (the files no --have file names, once each) and prints
        one line "PLAN <json>" with the trees and sizes.
On the host (C:\\havoc9\\delta.py, run by receive-deploy.ps1; the host's Python):
    delta.py have --store S --files F             the SHA-256 of every file the host holds, one per line
    delta.py ingest TAR [TAR ...] --store S       takes a blobs tar into the store (every name a SHA-256, every file hashed)
    delta.py assemble-zip RECIPE OUT --store S --files F   builds a ZIP from a recipe (and checks it; --no-verify skips that)
    delta.py assemble-dir RECIPE OUTDIR --store S --files F  lays a recipe out as a folder (--link: hard links, else copies)
    delta.py seed-zip ZIP [ZIP ...] --store S     files the ZIP holds into the store (a first run)
    delta.py seed-zcache ZIP [ZIP ...] --store S  keeps the deflate streams of the files a ZIP holds (a first run, or a ZIP from elsewhere)
    delta.py seed-dir DIR [DIR ...] --store S     the files of a folder, copied into the store
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import tarfile
import time
import zipfile
import zlib

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


_HASHED = {}


def entries_of_list(path):
    """The entries a list names (stage-h9xash.ps1 -Lists, make-vps-package.ps1 -WebClientList), as recipe_of_zip would have read them from the
    finished ZIP, with each file's SHA-256 and size read from the file the list names. Returns (entries, {entry path: file})."""
    with open(path, encoding="utf-8-sig") as f:
        doc = json.load(f)
    if doc.get("format") != 1 or not isinstance(doc.get("entries"), list) or len(doc["entries"]) > MAX_ENTRIES:
        die("not a list: " + path)
    entries = []
    srcs = {}
    for it in doc["entries"]:
        p = safe_path(it["path"])
        e = {"path": p, "time": [int(x) for x in it["time"]], "attr": int(it["attr"]), "system": int(it["system"]), "ct": int(it["ct"])}
        if it.get("dir"):
            e["dir"] = True
        else:
            src = it["src"]
            try:
                st = os.stat(src)
            except OSError:
                die("the list %s names %s, which is not there (the stage folder a list points into goes when a delivery is done): run the stage again" % (path, src))
            key = (src, st.st_size, st.st_mtime_ns)
            if key not in _HASHED:
                _HASHED[key] = sha_file(src)
            e["sha256"] = _HASHED[key]
            e["size"] = st.st_size
            srcs[p] = src
        e["mode"] = e["attr"]
        entries.append(e)
    return entries, srcs


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
    where = {}          # sha -> (zip path or file, entry path or None for a file, size)
    summary = {"sources": {}, "tars": []}
    sources = [("zip", s) for s in (a.zip or [])] + [("list", s) for s in (a.list or [])]
    if not sources:
        die("give --zip NAME=PATH or --list NAME=PATH")
    for kind, spec in sources:
        name, _, path = spec.partition("=")
        if not name or not path or not re.match(r"^[A-Za-z0-9._-]+$", name):
            die("--zip or --list NAME=PATH, NAME letters, digits, . _ -")
        srcs = None
        if kind == "zip":
            entries = recipe_of_zip(path)
        else:
            entries, srcs = entries_of_list(path)
        rec = {"format": 1, "name": name, "entries": entries, "tree": tree_of(entries)}
        with open(os.path.join(a.out_dir, name + ".recipe.json"), "w", encoding="ascii") as f:
            json.dump(rec, f, separators=(",", ":"))
        files = [e for e in entries if not e.get("dir")]
        for e in files:
            if srcs is None:
                where.setdefault(e["sha256"], (path, e["path"], e["size"]))
            else:
                where.setdefault(e["sha256"], (srcs[e["path"]], None, e["size"]))
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
            ti = tarfile.TarInfo(s)
            ti.size = size
            ti.mode = 0o644
            if epath is None:
                with open(zpath, "rb") as f:
                    tf.addfile(ti, f)
            else:
                zf = zips.get(zpath) or zips.setdefault(zpath, zipfile.ZipFile(zpath))
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


ZMAGIC = b"H9Z2"
ZHEAD = 48          # magic 4, the file's CRC-32 4, its size 8, the SHA-256 of the stream 32
LOCAL = "<IHHHHHIIIHH"
CENTRAL = "<IHHHHHHIIIHHHHHII"
END = "<IHHHHIIH"
FAST_MAX_ENTRIES = 0xFFFF         # more entries than this, or an offset or a file this big, needs ZIP64: the slow writer does that
FAST_MAX_BYTES = 0xFFFFFFFF


class NeedZip64(Exception):
    pass


def zc_path(store, sha):
    return os.path.join(store, "z", sha[:2], sha + ".z6")


def zc_info(store, sha):
    """(path, CRC-32, size, stream size, stream hash) of the deflate stream kept for a file, or None."""
    p = zc_path(store, sha)
    try:
        with open(p, "rb") as f:
            head = f.read(ZHEAD)
        total = os.path.getsize(p)
    except OSError:
        return None
    if len(head) != ZHEAD or head[:4] != ZMAGIC:
        return None
    crc, size = struct.unpack("<IQ", head[4:16])
    return p, crc, size, total - ZHEAD, head[16:48]


def zc_put(src, sha, store):
    """Compresses a file of the store and keeps the stream: raw deflate at level 6, what zipfile makes. The file is hashed on the way, so it
    must be the one its name says."""
    dst = zc_path(store, sha)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    part = dst + ".part"
    h = hashlib.sha256()
    hz = hashlib.sha256()
    crc = 0
    n = 0
    co = zlib.compressobj(6, zlib.DEFLATED, -15)
    with open(src, "rb") as fi, open(part, "wb") as fo:
        fo.write(b"\0" * ZHEAD)
        while True:
            b = fi.read(CHUNK)
            if not b:
                break
            h.update(b)
            crc = zlib.crc32(b, crc)
            n += len(b)
            c = co.compress(b)
            if c:
                fo.write(c)
                hz.update(c)
        c = co.flush()
        if c:
            fo.write(c)
            hz.update(c)
        fo.seek(0)
        fo.write(ZMAGIC + struct.pack("<IQ", crc & 0xFFFFFFFF, n) + hz.digest())
    if h.hexdigest() != sha:
        os.remove(part)
        die("the file for %s is not the one its name says" % sha)
    os.replace(part, dst)


def copy_stream(info, out):
    """The kept stream into the ZIP; False when it is not what was kept (the disk changed it)."""
    p, _crc, _size, cs, want = info
    h = hashlib.sha256()
    left = cs
    with open(p, "rb") as f:
        f.seek(ZHEAD)
        while left > 0:
            b = f.read(min(CHUNK, left))
            if not b:
                return False
            h.update(b)
            out.write(b)
            left -= len(b)
    return h.digest() == want


def name_bytes(path):
    try:
        return path.encode("ascii"), 0
    except UnicodeEncodeError:
        return path.encode("utf-8"), 0x800


def dos_stamp(t):
    """A ZIP's date and time words from (year, month, day, hour, minute, second), as zipfile writes them."""
    y, mo, d, h, mi, s = [int(x) for x in t]
    if y < 1980 or y > 2107:
        y, mo, d, h, mi, s = 1980, 1, 1, 0, 0, 0
    return ((y - 1980) << 9) | (mo << 5) | d, (h << 11) | (mi << 5) | (s // 2)


def assemble_fast(rec, out_path, a):
    """A recipe's ZIP written here, not by zipfile: a file's deflate stream is the one kept from the last time it went into a ZIP, so only files
    new to the host are compressed. Raises NeedZip64 when the ZIP would need ZIP64 (the slow way builds that one)."""
    entries = rec["entries"]
    if len(entries) >= FAST_MAX_ENTRIES:
        raise NeedZip64()
    stats = {"hit": 0, "miss": 0, "bad": 0, "new_bytes": 0}
    central = []
    off = 0
    with open(out_path, "wb") as out:
        for e in entries:
            nb, flag = name_bytes(e["path"])
            date, tm = dos_stamp(e["time"])
            hoff = off
            if e.get("dir"):
                head = struct.pack(LOCAL, 0x04034B50, 20, flag, 0, tm, date, 0, 0, 0, len(nb), 0)
                out.write(head)
                out.write(nb)
                central.append((nb, flag, 0, tm, date, 0, 0, 0, hoff, e))
                off += len(head) + len(nb)
                continue
            sha, us = e["sha256"], e["size"]
            if us >= FAST_MAX_BYTES:
                raise NeedZip64()
            src = blob_path(sha, a.store, a.files)
            for attempt in range(3):
                if e["ct"] == zipfile.ZIP_DEFLATED:
                    info = zc_info(a.store, sha)
                    if info is None or info[2] != us:
                        zc_put(src, sha, a.store)
                        info = zc_info(a.store, sha)
                        stats["miss"] += 1
                        stats["new_bytes"] += us
                    elif attempt == 0:
                        stats["hit"] += 1
                    method, crc, cs = 8, info[1], info[3]
                elif e["ct"] == zipfile.ZIP_STORED:
                    h = hashlib.sha256()
                    crc = 0
                    n = 0
                    with open(src, "rb") as f:
                        while True:
                            b = f.read(CHUNK)
                            if not b:
                                break
                            h.update(b)
                            crc = zlib.crc32(b, crc)
                            n += len(b)
                    if h.hexdigest() != sha or n != us:
                        die("the file for %s is not the one the recipe names" % e["path"])
                    method, crc, cs, info = 0, crc & 0xFFFFFFFF, n, None
                else:
                    die("%s: a compression this does not write (%r)" % (e["path"], e["ct"]))
                if off + 30 + len(nb) + cs >= FAST_MAX_BYTES:
                    raise NeedZip64()
                head = struct.pack(LOCAL, 0x04034B50, 20, flag, method, tm, date, crc, cs, us, len(nb), 0)
                if attempt:
                    out.seek(hoff)
                    out.truncate()
                out.write(head)
                out.write(nb)
                if method == 8:
                    ok = copy_stream(info, out)
                else:
                    ok = True
                    with open(src, "rb") as f:
                        shutil.copyfileobj(f, out, CHUNK)
                if ok:
                    break
                # the kept stream is not what was kept: out of the way, made again from the stored file
                stats["bad"] += 1
                try:
                    os.remove(info[0])
                except OSError:
                    pass
            else:
                die("could not write %s" % e["path"])
            central.append((nb, flag, method, tm, date, crc, cs, us, hoff, e))
            off += len(head) + len(nb) + cs
        cd_off = off
        for nb, flag, method, tm, date, crc, cs, us, hoff, e in central:
            out.write(struct.pack(CENTRAL, 0x02014B50, ((e["system"] & 0xFF) << 8) | 20, 20, flag, method, tm, date, crc, cs, us, len(nb), 0, 0, 0, 0,
                                  e["attr"] & 0xFFFFFFFF, hoff))
            out.write(nb)
        cd_size = out.tell() - cd_off
        if cd_off + cd_size >= FAST_MAX_BYTES:
            raise NeedZip64()
        out.write(struct.pack(END, 0x06054B50, 0, 0, len(central), len(central), cd_size, cd_off, 0))
    return stats


def verify_zip(path, rec):
    """The finished ZIP read back: its list is the recipe's, and every file in it unpacks to the CRC it was written with."""
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        ents = rec["entries"]
        if len(infos) != len(ents):
            die("%d entries read back, %d in the recipe" % (len(infos), len(ents)))
        for i, e in zip(infos, ents):
            if i.filename != e["path"] or i.external_attr != (e["attr"] & 0xFFFFFFFF) or i.create_system != e["system"] or i.compress_type != e["ct"]:
                die("an entry read back differs from the recipe: %s" % e["path"])
            if not e.get("dir") and i.file_size != e["size"]:
                die("an entry read back has another size than the recipe's: %s" % e["path"])
        bad = zf.testzip()
        if bad:
            die("a damaged entry in the ZIP just written: %s" % bad)


def cmd_assemble_zip(a):
    t0 = time.time()
    rec = load_recipe(a.recipe)
    missing = sorted({e["sha256"] for e in rec["entries"] if not e.get("dir") and not blob_path(e["sha256"], a.store, a.files)})
    if missing:
        die("%d files the recipe names are not on this host (first: %s)" % (len(missing), missing[0]))
    tmp = a.out + ".part"
    stats = None
    try:
        stats = assemble_fast(rec, tmp, a)
    except NeedZip64:
        if os.path.exists(tmp):
            os.remove(tmp)
    if stats is None:
        assemble_slow(rec, tmp, a)
    elif not a.no_verify:
        verify_zip(tmp, rec)
    os.replace(tmp, a.out)
    extra = ""
    if stats is not None:
        extra = "; %d streams kept, %d compressed now (%.0f MB)%s" % (stats["hit"], stats["miss"], stats["new_bytes"] / 1e6,
                                                                       ("; %d kept streams were damaged and made again" % stats["bad"]) if stats["bad"] else "")
    print("assembled %s: %d entries, %.0f MB, tree %s, %.0f s%s" % (os.path.basename(a.out), len(rec["entries"]), os.path.getsize(a.out) / 1e6,
                                                                    rec["tree"][:12], time.time() - t0, extra))


def assemble_slow(rec, tmp, a):
    """The ZIP of a recipe by zipfile, compressing every file: what a ZIP too big for the fast writer needs (ZIP64)."""
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
                shutil.copy2(src, dst)
        else:
            shutil.copy2(src, dst)
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


def cmd_seed_zcache(a):
    """Keeps the deflate streams of the files ZIPs hold (each file's SHA-256 is read from the unpacked stream)."""
    tmp = os.path.join(a.store, ".incoming")
    os.makedirs(tmp, exist_ok=True)
    n = 0
    seen = 0
    for z in a.zip:
        with zipfile.ZipFile(z) as zf, open(z, "rb") as raw:
            for i in zf.infolist():
                if i.is_dir() or i.compress_type != zipfile.ZIP_DEFLATED or i.file_size >= 0xFFFFFFFF or i.compress_size >= 0xFFFFFFFF:
                    continue
                seen += 1
                raw.seek(i.header_offset)
                lh = raw.read(30)
                if len(lh) != 30 or lh[:4] != b"PK\x03\x04":
                    die("%s: no entry header at %d for %s" % (z, i.header_offset, i.filename))
                nlen, elen = struct.unpack("<HH", lh[26:30])
                raw.seek(i.header_offset + 30 + nlen + elen)
                part = os.path.join(tmp, "seed.z.part")
                d = zlib.decompressobj(-15)
                hs = hashlib.sha256()
                hz = hashlib.sha256()
                crc = 0
                size = 0
                left = i.compress_size
                with open(part, "wb") as fo:
                    fo.write(b"\0" * ZHEAD)
                    while left > 0:
                        b = raw.read(min(CHUNK, left))
                        if not b:
                            break
                        left -= len(b)
                        fo.write(b)
                        hz.update(b)
                        u = d.decompress(b)
                        hs.update(u)
                        crc = zlib.crc32(u, crc)
                        size += len(u)
                    u = d.flush()
                    hs.update(u)
                    crc = zlib.crc32(u, crc)
                    size += len(u)
                    fo.seek(0)
                    fo.write(ZMAGIC + struct.pack("<IQ", crc & 0xFFFFFFFF, size) + hz.digest())
                sha = hs.hexdigest()
                if left or (crc & 0xFFFFFFFF) != i.CRC or size != i.file_size or zc_info(a.store, sha):
                    os.remove(part)
                    continue
                dst = zc_path(a.store, sha)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                os.replace(part, dst)
                n += 1
    print("kept %d new deflate streams (of %d files in the ZIPs)" % (n, seen))


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
    s.add_argument("--zip", action="append")
    s.add_argument("--list", action="append")
    s.add_argument("--max-mb", type=float, default=400)
    s.set_defaults(f=cmd_plan)
    for name, f, pos in (("have", cmd_have, []), ("ingest", cmd_ingest, [("tar", "+")]), ("assemble-zip", cmd_assemble_zip, [("recipe", None), ("out", None)]),
                         ("assemble-dir", cmd_assemble_dir, [("recipe", None), ("out", None)]), ("seed-zip", cmd_seed_zip, [("zip", "+")]),
                         ("seed-zcache", cmd_seed_zcache, [("zip", "+")]),
                         ("seed-dir", cmd_seed_dir, [("dir", "+")])):
        s = sub.add_parser(name)
        for n, nargs in pos:
            s.add_argument(n, nargs=nargs) if nargs else s.add_argument(n)
        s.add_argument("--store", required=True)
        s.add_argument("--files", default="")
        s.add_argument("--link", action="store_true")
        s.add_argument("--no-verify", action="store_true")
        s.set_defaults(f=f)
    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
