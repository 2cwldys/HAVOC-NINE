#!/usr/bin/env python3
"""delta_test.py -- tests of vps/windows/delta.py: plans from lists, ZIPs written from recipes, the kept deflate streams.

    python tools/delta_test.py [--delta PATH-TO-delta.py] [--work FOLDER]

Everything is made in a work folder (emptied first when this test made it; default: a new folder in the temp folder). Standard library
only; Python 3.8 or later. It runs on the PC that builds and on the host (copy delta.py and this file over, run with the host's Python).
"""
import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
FAILS = []
CHECKS = [0]


def check(ok, label, detail=""):
    CHECKS[0] += 1
    if ok:
        print("  [PASS] " + label)
    else:
        FAILS.append(label)
        print("  [FAIL] " + label + ((" -- " + str(detail)) if detail else ""))


def heading(t):
    print("")
    print("== " + t)


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def run_delta(delta_path, *args):
    p = subprocess.run([sys.executable, "-I", delta_path] + [str(a) for a in args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.decode("utf-8", "replace")


def load_delta(path):
    spec = importlib.util.spec_from_file_location("delta_under_test", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def prng_bytes(seed, n):
    # a cheap deterministic stream that does not compress (xorshift), n bytes
    out = bytearray(n)
    x = seed or 1
    for i in range(0, n, 8):
        x ^= (x << 13) & 0xFFFFFFFFFFFFFFFF
        x ^= x >> 7
        x ^= (x << 17) & 0xFFFFFFFFFFFFFFFF
        out[i:i + 8] = struct.pack("<Q", x)[: min(8, n - i)]
    return bytes(out)


def make_sources(root):
    """The files of the fake package, as {relative path: bytes}."""
    text = b"".join(b"line %d of a config file\r\n" % i for i in range(40000))
    files = {
        "ts/readme.txt": b"hello\n" * 10,
        "ts/empty.bin": b"",
        "ts/random.bin": prng_bytes(11, 3 * 1024 * 1024 + 5),
        "ts/text.cfg": text,
        "ts/maps/b.bsp": prng_bytes(12, 700000),
        "ts/sound/caf\u00e9.wav": prng_bytes(13, 90000),
        "xash.dll": prng_bytes(14, 1500000),
        "h9xash.sh": b"#!/bin/bash\necho hi\n",
        "dup/readme-again.txt": b"hello\n" * 10,
    }
    for rel, data in files.items():
        p = os.path.join(root, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
    return files


def make_list(path, root, files, system, top="H9XASH"):
    """A list as the stage writes it: folders first, then the files in order, each with where it comes from."""
    entries = []
    when = [2026, 11, 15, 23, 40, 22]
    dirs = set([""])
    for rel in files:
        parts = rel.split("/")[:-1]
        for n in range(1, len(parts) + 1):
            dirs.add("/".join(parts[:n]))
    dirs.add("emptyfolder")
    for d in sorted(dirs):
        attr = 0 if system == 0 else (((stat.S_IFDIR | 0o755) << 16) | 0x10)
        entries.append({"path": top + "/" + d + "/" if d else top + "/", "time": when, "attr": attr, "system": system, "ct": 0, "dir": True})
    for rel in sorted(files):
        attr = 0 if system == 0 else ((stat.S_IFREG | (0o755 if rel.endswith(".sh") else 0o644)) << 16)
        entries.append({"path": top + "/" + rel, "src": os.path.join(root, rel.replace("/", os.sep)), "time": when, "attr": attr, "system": system, "ct": 8})
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"format": 1, "entries": entries}, f)
    return entries


def reference_zip(path, entries):
    """What the stage writes today: zipfile, level 6, one entry after the other."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, allowZip64=True, compresslevel=6) as zf:
        for e in entries:
            zi = zipfile.ZipInfo(e["path"], tuple(e["time"]))
            zi.create_system = e["system"]
            zi.external_attr = e["attr"]
            if e.get("dir"):
                zf.writestr(zi, b"")
                zf.filelist[-1].external_attr = e["attr"]
            else:
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi._compresslevel = 6
                with open(e["src"], "rb") as fh, zf.open(zi, "w") as dst:
                    shutil.copyfileobj(fh, dst, 1 << 20)
                zf.filelist[-1].external_attr = e["attr"]


def read_zip(path):
    out = []
    with zipfile.ZipFile(path) as zf:
        for i in zf.infolist():
            out.append((i.filename, i.date_time, i.external_attr, i.create_system, i.compress_type, i.CRC, i.file_size,
                        None if i.is_dir() else sha_bytes(zf.read(i))))
    return out


def main():
    ap = argparse.ArgumentParser(description="tests of delta.py")
    ap.add_argument("--delta", default=None, help="delta.py (default: vps/windows/delta.py of this checkout, or beside this file)")
    ap.add_argument("--work", default=None, help="the work folder")
    a = ap.parse_args()
    cands = [a.delta] if a.delta else [os.path.join(HERE, "..", "vps", "windows", "delta.py"), os.path.join(HERE, "delta.py")]
    delta_path = next((os.path.abspath(c) for c in cands if c and os.path.isfile(c)), None)
    if not delta_path:
        print("no delta.py found; give --delta")
        return 2
    delta = load_delta(delta_path)
    work = os.path.abspath(a.work) if a.work else tempfile.mkdtemp(prefix="delta-test-")
    marker = os.path.join(work, ".delta_test_work")
    if os.path.isdir(work) and os.listdir(work):
        if not os.path.isfile(marker):
            print("refusing to empty %s: it is not empty and was not made by this test" % work)
            return 2
        shutil.rmtree(work)
    os.makedirs(work, exist_ok=True)
    with open(marker, "w") as f:
        f.write("made by delta_test.py\n")
    print("delta.py: %s (Python %s, zlib %s)" % (delta_path, sys.version.split()[0], zlib.ZLIB_RUNTIME_VERSION))
    print("work:     " + work)

    src = os.path.join(work, "src")
    files = make_sources(src)
    win_list = os.path.join(work, "win.list.json")
    lin_list = os.path.join(work, "lin.list.json")
    win_entries = make_list(win_list, src, files, 0)
    lin_entries = make_list(lin_list, src, files, 3)

    heading("a list reads as the ZIP of the same entries would")
    ref_win = os.path.join(work, "ref-win.zip")
    ref_lin = os.path.join(work, "ref-lin.zip")
    reference_zip(ref_win, win_entries)
    reference_zip(ref_lin, lin_entries)
    for name, lst, ref in (("Windows", win_list, ref_win), ("Linux", lin_list, ref_lin)):
        from_list, _srcs = delta.entries_of_list(lst)
        from_zip = delta.recipe_of_zip(ref)
        norm = lambda es: [dict(e, time=e["time"][:5] + [e["time"][5] // 2 * 2]) for e in es]
        check(norm(from_list) == norm(from_zip), "%s: entries_of_list == recipe_of_zip(the ZIP zipfile writes)" % name,
              [(x, y) for x, y in zip(norm(from_list), norm(from_zip)) if x != y][:1])
        check(delta.tree_of(from_list) == delta.tree_of(from_zip), "%s: the same tree, so a delta from a list and from a ZIP agree" % name)

    heading("plan --list")
    have_file = os.path.join(work, "have.txt")
    readme_sha = sha_bytes(files["ts/readme.txt"])
    with open(have_file, "w") as f:
        f.write(readme_sha + "\n")
    out = os.path.join(work, "plan")
    rc, text = run_delta(delta_path, "plan", "--out-dir", out, "--have", have_file, "--list", "H9XASH.zip=" + win_list,
                         "--list", "H9XASH-linux.zip=" + lin_list)
    check(rc == 0 and "PLAN " in text, "plan --list succeeds", text[-300:])
    plan = json.loads([l for l in text.splitlines() if l.startswith("PLAN ")][-1][5:])
    uniq = set(sha_bytes(d) for d in files.values())
    check(plan["new_files"] == len(uniq) - 1, "every file the host lacks is named once (%d of %d distinct, one already there)" % (plan["new_files"], len(uniq)),
          plan["new_files"])
    tars = sorted(f for f in os.listdir(out) if f.startswith("blobs-"))
    names = []
    for t in tars:
        with tarfile.open(os.path.join(out, t)) as tf:
            for m in tf:
                names.append(m.name)
    check(sorted(names) == sorted(uniq - set([readme_sha])), "the blobs are exactly the files not already on the host")
    rc2, text2 = run_delta(delta_path, "plan", "--out-dir", os.path.join(work, "plan2"), "--have", have_file, "--list", "H9XASH.zip=" + win_list,
                           "--list", "H9XASH-linux.zip=" + lin_list)
    same = all(open(os.path.join(out, f), "rb").read() == open(os.path.join(work, "plan2", f), "rb").read() for f in ("H9XASH.zip.recipe.json", "H9XASH-linux.zip.recipe.json"))
    check(rc2 == 0 and same, "the same list gives the same recipe")
    rc3, text3 = run_delta(delta_path, "plan", "--out-dir", os.path.join(work, "plan3"), "--have", have_file, "--zip", "H9XASH.zip=" + ref_win)
    r3 = json.load(open(os.path.join(work, "plan3", "H9XASH.zip.recipe.json")))
    r1 = json.load(open(os.path.join(out, "H9XASH.zip.recipe.json")))
    check(rc3 == 0 and r3["tree"] == r1["tree"], "plan --zip still works, and its tree is the list's")
    bad = os.path.join(work, "bad.list.json")
    with open(bad, "w") as f:
        json.dump({"format": 1, "entries": [{"path": "../x", "time": [2026, 1, 1, 0, 0, 0], "attr": 0, "system": 0, "ct": 8, "src": win_list}]}, f)
    rc4, text4 = run_delta(delta_path, "plan", "--out-dir", os.path.join(work, "plan4"), "--have", have_file, "--list", "x.zip=" + bad)
    check(rc4 != 0 and "climbs out" in text4, "a list with a path that climbs out of its folder is refused")

    heading("the host: ingest, then a ZIP from each recipe")
    store = os.path.join(work, "store")
    fdir = os.path.join(work, "files")
    os.makedirs(fdir)
    rc, text = run_delta(delta_path, "seed-dir", os.path.join(src, "ts"), "--store", store)
    check(rc == 0, "the host's own files seeded", text)
    rc, text = run_delta(delta_path, "ingest", *[os.path.join(out, t) for t in tars], "--store", store)
    check(rc == 0 and "ingested" in text, "the blobs ingested: " + text.strip(), text)
    rec_win = os.path.join(out, "H9XASH.zip.recipe.json")
    rec_lin = os.path.join(out, "H9XASH-linux.zip.recipe.json")

    def expect_like(label, zpath, recpath):
        rec = json.load(open(recpath))
        got = read_zip(zpath)
        want = []
        for e in rec["entries"]:
            t = tuple(e["time"][:5]) + (e["time"][5] // 2 * 2,)
            want.append((e["path"], t, e["attr"], e["system"], e["ct"], None, e.get("size", 0), e.get("sha256")))
        ok = len(got) == len(want)
        for g, w in zip(got, want):
            if (g[0], g[1], g[2], g[3], g[4], g[6], g[7]) != (w[0], w[1], w[2], w[3], w[4], w[6], w[7]):
                ok = False
                print("      differs: %r vs %r" % (g[:5], w[:5]))
                break
        check(ok, label)

    z1 = os.path.join(work, "out1.zip")
    rc, text = run_delta(delta_path, "assemble-zip", rec_win, z1, "--store", store, "--files", fdir)
    check(rc == 0 and "assembled" in text, "assemble-zip (no kept streams yet): " + text.strip()[:160], text)
    expect_like("the ZIP holds the recipe's entries: names, dates, attributes, systems, sizes, contents", z1, rec_win)
    with zipfile.ZipFile(z1) as zf:
        check(zf.testzip() is None, "zipfile reads every entry back (CRC)")
        names1 = zf.namelist()
        check(any(ord(c) > 127 for n in names1 for c in n), "a name with a non-ASCII character is in it", names1)
    z2 = os.path.join(work, "out2.zip")
    rc, text = run_delta(delta_path, "assemble-zip", rec_win, z2, "--store", store, "--files", fdir)
    check(rc == 0 and ", 0 compressed now" in text, "the second ZIP compresses nothing: " + text.strip()[-100:], text)
    check(open(z1, "rb").read() == open(z2, "rb").read(), "and is the same bytes as the first")

    # a damaged kept stream, a missing one, one with a broken header
    zdir = os.path.join(store, "z")
    kept = sorted(os.path.join(dp, f) for dp, _dn, fn in os.walk(zdir) for f in fn if f.endswith(".z6"))
    check(len(kept) >= 6, "streams are kept in store\\z (%d)" % len(kept))
    big = max(kept, key=os.path.getsize)
    data = bytearray(open(big, "rb").read())
    data[ZHEAD() + 100] ^= 0xFF
    open(big, "wb").write(bytes(data))
    victims = [p for p in kept if p != big]
    os.remove(victims[0])
    h = bytearray(open(victims[1], "rb").read())
    h[0:4] = b"XXXX"
    open(victims[1], "wb").write(bytes(h))
    z3 = os.path.join(work, "out3.zip")
    rc, text = run_delta(delta_path, "assemble-zip", rec_win, z3, "--store", store, "--files", fdir)
    check(rc == 0 and "damaged" in text, "a damaged stream is noticed and made again: " + text.strip()[-110:], text)
    check(open(z1, "rb").read() == open(z3, "rb").read(), "the ZIP is the same bytes as before the damage")

    z4 = os.path.join(work, "out4.zip")
    rc, text = run_delta(delta_path, "assemble-zip", rec_lin, z4, "--store", store, "--files", fdir, "--no-verify")
    check(rc == 0, "the Linux recipe too (--no-verify)", text)
    expect_like("the Linux ZIP holds its recipe's entries, with the Unix modes", z4, rec_lin)
    with zipfile.ZipFile(z4) as zf:
        sh = zf.getinfo("H9XASH/h9xash.sh")
        check(((sh.external_attr >> 16) & 0o777) == 0o755 and sh.create_system == 3, "h9xash.sh is a Unix entry at 0755")

    heading("the kept streams of a ZIP made elsewhere (seed-zcache)")
    store2 = os.path.join(work, "store2")
    rc, _ = run_delta(delta_path, "seed-dir", os.path.join(src, "ts"), "--store", store2)
    rc, _ = run_delta(delta_path, "ingest", *[os.path.join(out, t) for t in tars], "--store", store2)
    rc, text = run_delta(delta_path, "seed-zcache", ref_win, "--store", store2)
    check(rc == 0 and "kept" in text, "seed-zcache: " + text.strip(), text)
    z5 = os.path.join(work, "out5.zip")
    rc, text = run_delta(delta_path, "assemble-zip", rec_win, z5, "--store", store2, "--files", fdir)
    check(rc == 0 and ", 0 compressed now" in text, "a ZIP from streams zipfile made compresses nothing: " + text.strip()[-90:], text)
    expect_like("and is the recipe's ZIP", z5, rec_win)

    heading("a ZIP the fast writer will not do (ZIP64 limits lowered): zipfile does it")
    delta.FAST_MAX_ENTRIES = 5
    ns = argparse.Namespace(recipe=rec_win, out=os.path.join(work, "out6.zip"), store=store, files=fdir, no_verify=False)
    import io
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        delta.cmd_assemble_zip(ns)
    finally:
        sys.stdout = old
        delta.FAST_MAX_ENTRIES = 0xFFFF
    check("streams kept" not in buf.getvalue() and os.path.isfile(ns.out), "the slow writer was used: " + buf.getvalue().strip()[:100])
    expect_like("and its ZIP is the recipe's", ns.out, rec_win)

    heading("assemble-dir")
    d1 = os.path.join(work, "dir1")
    rc, text = run_delta(delta_path, "assemble-dir", rec_win, d1, "--store", store, "--files", fdir, "--link")
    check(rc == 0 and "laid out" in text, "assemble-dir --link: " + text.strip(), text)
    p = os.path.join(d1, "H9XASH", "ts", "random.bin")
    check(os.path.isfile(p) and sha_bytes(open(p, "rb").read()) == sha_bytes(files["ts/random.bin"]), "a file is laid out whole")
    sp = os.path.join(store, sha_bytes(files["ts/random.bin"])[:2], sha_bytes(files["ts/random.bin"]))
    check(abs(os.stat(p).st_mtime - os.stat(sp).st_mtime) < 2, "it keeps the date of the stored file (a mirror then copies only what changed)")
    d2 = os.path.join(work, "dir2")
    rc, text = run_delta(delta_path, "assemble-dir", rec_win, d2, "--store", store, "--files", fdir)
    check(rc == 0 and abs(os.stat(os.path.join(d2, "H9XASH", "ts", "random.bin")).st_mtime - os.stat(sp).st_mtime) < 2, "a copy keeps the date too")

    print("")
    print("%d checks, %d failed" % (CHECKS[0], len(FAILS)))
    for f in FAILS:
        print("  FAILED: " + f)
    if not a.work:
        shutil.rmtree(work, ignore_errors=True)
    return 1 if FAILS else 0


def ZHEAD():
    return 48


if __name__ == "__main__":
    sys.exit(main())
