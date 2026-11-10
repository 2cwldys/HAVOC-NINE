#!/usr/bin/env python3
# stage_h9xash_test.py -- checks stage_h9xash.py against stage-h9xash.ps1.
#
# Builds a small fake H9XASH (and fake native Linux builds) in a work folder, runs the PowerShell script and
# the Python port on the same fixtures, and compares what they leave behind:
#   - the exit codes and the files each wrote;
#   - the member list of every ZIP, its Unix modes, entry kinds and compression, and the bytes of every member;
#   - the staged folder (kept with -KeepStage) byte for byte, so the scrub is compared too;
#   - the report and the console output, after the run's own paths, time and hashes are normalised;
#   - the stop conditions (a Discord-looking token, a webhook, a private key, a cut-short .bsp, a Git LFS
#     pointer, no ts folder) and the Git LFS / cut-short-file check on a folder of good and bad files.
# It also checks the ZIPs against the rules on their own (modes, LF in .sh files, no Windows file in a native
# package ...), which is all that runs where PowerShell is not installed, and runs stage-h9xash.sh when bash and
# the file are there. Nothing is written outside the work folder; the game is never touched.
#
#   python stage_h9xash_test.py --work <folder> [--ps1 <stage-h9xash.ps1>] [--py <stage_h9xash.py>]
#                               [--here <repository root>] [--no-ps] [--tmp <folder>]
# --work is emptied at the start; it must be new, empty, or one this test made before.
# Exit code 0: every check passed.

import argparse
import difflib
import glob
import hashlib
import io
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import zipfile

sys.dont_write_bytecode = True
MY_DIR = os.path.dirname(os.path.abspath(__file__))


def beside(name):
    """name in the folder of this file, else in the folder above it (this file may sit in tools/)."""
    for d in (MY_DIR, os.path.dirname(MY_DIR)):
        if os.path.isfile(os.path.join(d, name)):
            return os.path.join(d, name)
    return os.path.join(MY_DIR, name)
ELF = b"\x7fELF" + b"\x01\x01\x01" + bytes(20)
MZ = b"MZ" + bytes(30)
FIXED = time.mktime((2024, 5, 6, 7, 8, 10, 0, 0, -1))
LFS_TEXT = b"version https://git-lfs.github.com/spec/v1\noid sha256:" + b"0" * 64 + b"\nsize 123456\n"

RESULTS = []
ENV = dict(os.environ)


# ---- reporting ------------------------------------------------------------------------

def check(ok, label, detail=""):
    RESULTS.append((bool(ok), label))
    print(("  PASS  " if ok else "  FAIL  ") + label)
    if not ok and detail:
        for line in str(detail).splitlines()[:40]:
            print("          " + line)
    return ok


def info(text):
    print("  info  " + text)


def heading(text):
    print("")
    print("== " + text)


# ---- the fixture ----------------------------------------------------------------------

def w(base, rel, data, mtime=FIXED):
    p = os.path.join(base, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as fh:
        fh.write(data if isinstance(data, bytes) else data.encode("latin-1"))
    os.utime(p, (mtime, mtime))


def small_zip(name="x.txt", data=b"hello"):
    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w") as zf:
        zf.writestr(name, data)
    return bio.getvalue()


def mdl(length):
    return b"IDST" + bytes(68) + struct.pack("<i", length) + bytes(max(0, length - 76))


def bsp(version=30, lumps=None, size=204):
    head = struct.pack("<i", version)
    table = bytearray(120)
    for i, (off, ln) in (lumps or {}).items():
        struct.pack_into("<ii", table, i * 8, off, ln)
    data = head + bytes(table)
    return data + bytes(max(0, size - len(data)))


def make_base(T):
    """The fake H9XASH of the project's own fixture, with the files the scrub, skip and platform rules act on."""
    S = os.path.join(T, "H9XASH")
    O = os.path.join(T, "linux-native")
    V = os.path.join(T, "linux-server-only")
    N = os.path.join(T, "linux-noclient")

    # the Windows game, with the stock Linux files it carries
    w(S, "HAVOC 9.exe", MZ)
    w(S, "xash.dll", MZ)
    w(S, "xash.dll.patch", "note\r\n")
    w(S, "h9xash.bat", "@echo off\r\n")
    w(S, "h9_userid.ps1", "Write-Host 1\r\n")
    w(S, "h9xash.sh", "#!/bin/bash\r\necho wine\r\n")
    w(S, "h9_userid.sh", "#!/bin/bash\r\necho id\r\n")
    w(S, "README_LINUX.txt", "wine readme\r\n")
    w(S, "webview2/h9webview_extra.dll", MZ)
    w(S, "webview2/readme.txt", "x\r\n")
    w(S, "ts/liblist.gam", 'game "TS"\r\ngamedll "dlls\\mp.dll"\r\n')
    w(S, "ts/dlls/mp.dll", MZ)
    w(S, "ts/dlls/ts.so", ELF)
    w(S, "ts/dlls/ts_i386.so", ELF + b"stock")
    w(S, "ts/cl_dlls/client.dll", MZ)
    w(S, "ts/cl_dlls/client.so", ELF + b"stock")
    w(S, "ts/maps/h9_test.bsp", struct.pack("<i", 30) + bytes(200))
    w(S, "ts/addons/amxmodx/plugins/x.amxx", b"AMX" * 10)
    w(S, "ts/addons/metamod/plugins.ini",
      "win32 addons/amxmodx/dlls/amxmodx_mm.dll\r\nlinux addons/amxmodx/dlls/amxmodx_mm_i386.so\r\n")
    w(S, "ts/delta.lst", "x\r\n")
    w(S, "ts/gameinfo.txt", "x\r\n")
    w(S, "ts/autoexec.cfg", "echo hi\r\n")
    w(S, "ts/userconfig.cfg", "echo hi\r\n")
    w(S, "ts/addons/amxmodx/configs/plugins.ini", "x.amxx\r\n")
    w(S, "ts/addons/amxmodx/configs/amxx.cfg", "echo\r\n")
    os.makedirs(os.path.join(S, "ts", "addons", "amxmodx", "logs"), exist_ok=True)
    os.makedirs(os.path.join(S, "ts", "addons", "amxmodx", "data", "vault"), exist_ok=True)

    # a native build folder
    w(O, "xash3d", ELF + b"client")
    w(O, "xashds", ELF + b"server")
    w(O, "libxash.so", ELF + b"engine")
    w(O, "ts/dlls/ts_i386.so", ELF + b"reTS")
    w(O, "ts/cl_dlls/client.so", ELF + b"reTS-client")
    w(O, "ts/liblist.gam", 'game "TS"\ngamedll_linux "dlls/ts_i386.so"\n')
    w(O, "h9xash.sh", "#!/bin/bash\necho native\n")
    w(O, "README_LINUX.txt", "native readme\n")

    # a dedicated-server-only build folder
    w(V, "xashds", ELF + b"server")
    w(V, "ts/dlls/ts_i386.so", ELF + b"reTS")
    w(V, "h9xash.sh", "#!/bin/bash\necho server\n")

    # a folder that is not a build with a client
    w(N, "ts/dlls/lonely.so", ELF + b"x")
    w(N, "notes.txt", "x\n")

    # ---- the extras: what the rules act on
    # a player's own config: no stock copy beside H9XASH, so it is scrubbed and the name reset
    w(S, "ts/config.cfg",
      'name "RealPlayer"\r\nrcon_password "hunter2"\r\nsensitivity "3"\r\ncl_h9_userid "abc123"\r\n'
      'connect 8.8.8.8:27015\r\nsetinfo "_pw" "x"\r\nbind "x" "+use"\r\n')
    w(S, "networking.ini", "[net]\r\nserver=1.2.3.4\r\nport=27015\r\nlocal=192.168.1.5\r\n")
    w(S, "ts/tempdecal.wad", b"WAD3" + struct.pack("<ii", 0, 12))
    # kept, and scrubbed line by line
    w(S, "ts/extra.cfg",
      b'echo caf\xe9\r\nsv_password "secret"\r\nhostname "H"\r\nmaster 1.2.3.4\r\nmaster2 10.1.2.3\r\n'
      b'allowed 8.8.4.4\r\nver 1.2.3.4\r\necho a\rsv_password "p"\r\nsetinfo "h9_userid" "0"\r\nmy_token_x "abc"\r\n'
      b'tsm_ad_token "tok"\r\nlast "line"')
    w(S, "ts/server.cfg", 'sv_password "x"\nhostname "Test"\nip 10.0.0.1\nsv_pass "y"\nsv_pass2 "z"\n')
    w(S, "ts/addons/amxmodx/configs/core.ini",
      "; comment\r\n[main]\r\nversion=1.0.0.1\r\ndiscord_token = abc.def\r\napi_key=0\r\nmaster=9.9.9.9\r\n"
      "local=192.168.0.7\r\nbuild 5.6.7.8\r\nid=76561198000000000\r\n")
    w(S, "ts/addons/amxmodx/configs/users.ini", '"STEAM_0:1:1234567" "" "pw" "ce"\r\n"[U:1:123]" "" "" "a"\r\nkeep me\r\n')
    w(S, "presets/official-preset.json", '{"name": "official"}\n{"ip": "8.8.8.8"}\n')
    w(S, "ts/spawns.rc", "alias a \"b\"\nsecret_word \"w\"\n")
    w(S, "ts/mapcycle.lst", "h9_test\n")
    w(S, "ts/motd.txt", "Server 1.1.1.1 STEAM_0:0:1\nsee https://example.com\n")
    w(S, "ts/readme.md", "master 8.8.8.8 and 4.4.4.4 and 8.8.8.8\n")
    # every address class the IP rule decides on, and the SteamID, secret-name and ini forms
    ips = ["8.8.8.8", "100.64.1.1", "100.128.0.1", "172.15.0.1", "172.16.0.1", "172.31.255.1", "172.32.0.1",
           "192.168.5.5", "192.169.5.5", "169.254.1.1", "169.253.1.1", "10.9.9.9", "127.0.0.1", "0.1.2.3", "224.0.0.1",
           "223.1.1.1", "192.0.2.5", "198.51.100.1", "203.0.113.9", "203.0.114.9", "123.45.67.89", "255.255.255.255",
           "256.1.1.1", "1.2.3", "1.2.3.4.5", "x1.2.3.4", "9.9.9.9:27015", "09.1.1.1"]
    w(S, "ts/ips.cfg", "".join('addr%d "%s"\r\n' % (i, a) if i % 2 else "host%d %s\r\n" % (i, a) for i, a in enumerate(ips)))
    w(S, "ts/ips.txt", "\n".join(ips) + "\n")
    w(S, "ts/ids.cfg",
      'a "STEAM_0:1:123"\nb VALVE_0:0:5\nc "[U:1:12345]"\nd 76561198012345678\ne 176561198012345678\nf 7656119801234567\n'
      'g "7656119801234567890"\nh STEAM_9:1:1\ni steam_0:1:123\n')
    w(S, "ts/secrets.cfg",
      'password "x"\nPASSWORD "x"\nrcon_password "r"\nsv_password ""\nsv_password "0"\napi_key "k"\napikey "k"\nwebhook_url "u"\n'
      'private_key "p"\nsv_pass "p"\nsurpass "p"\ncompass "c"\nmy_pass "p"\nmypass "p"\npassword_hint "h"\nh9_clientid "i"\n'
      'device_id "d"\ncl_h9_userid ""\nh9_presence_key "0"\nh9_presence_key "abc"\nsetinfo "h9_deviceid" "dev"\n'
      '"token" "t"\n  secret   "s"\nBot_Token "t"\nh9_userid\t"tabbed"\ntsm_ad_token "t"\nname "RealName"\n')
    w(S, "ts/secrets.ini",
      "password=abc\nPassword = abc\nsecret=\ntoken = 0\ndiscord_token=xyz\n[sec]\nkey = value\nvalue \"quoted\"\n"
      "api_key = \"quoted\"\nname = RealName\n; password=commented\n#token=hash\n")
    # platform classification
    w(S, "ts/dlls/libfoo.so.1", ELF + b"foo")
    w(S, "ts/dlls/libfoo.so.1.patch", "note\n")
    w(S, "ts/dlls/mp.dll.patch", "note\r\n")
    w(S, "ts/dlls/UPPER.SO", ELF + b"upper")
    w(S, "ts/dlls/mp.pdb", MZ)
    w(S, "ts/dlls/thing.sox", "not a library\n")
    w(S, "ts/addons/amxmodx/scripting/compile.sh", "#!/bin/sh\r\necho compile\r\n")
    w(S, "ts/addons/amxmodx/scripting/lf.sh", "#!/bin/sh\necho lf\n")
    # whole game files the LFS check passes
    w(S, "ts/models/ok.mdl", mdl(100))
    w(S, "ts/ok.wad", b"WAD3" + struct.pack("<ii", 0, 12))
    w(S, "ts/addons/ok.zip", small_zip())
    w(S, "ts/addons/ok.pk3", small_zip("a.txt", b"pk3"))
    w(S, "ts/maps/bsp2.bsp", b"BSP2" + bytes(300))
    w(S, "ts/maps/caf\xe9.txt", "accented name\n")
    # left out by the skip rules
    for rel in ("logs/a.txt", "ts/logs/b.txt", "ts/save/x.sav", "ts/Save/y.dat", "ts/screenshots/s.tga",
                "ts/user_id.ini", "device_id.ini", "ts/h9_presence.cfg", "ts/h9_presence.key", "ts/listip.cfg",
                "ts/foo.cfg.bak_2", "ts/Foo.BAK", "ts/userconfig.cfg.bak", "ts/x_resolved.cfg", "ts/y.log",
                "ts/downloads/d.txt", ".gitattributes", "Thumbs.db", "system.reg", "drive_c/windows/x.txt",
                ".h9xash-updater/state.json", "webview2/data/cache.bin", "webview2/runtime/rt.dll",
                "presets/backup/old.json", "ts/addons/amxmodx/data/vault/v.dat", "ts/addons/amxmodx/logs/l.log",
                "ts/something.downloadstsm.txt", "ts/video.cfg", "ts/mail.env", "ts/a.env", "ts/k.key", "ts/m.dem",
                "ts/.xash_id", "ts/custom.hpk", "ts/PID.PID", "ts/node_modules/n.js", "ts/addons/ts_downloads/z.txt",
                "ts/userconfig.d/u.cfg", "ts/x.tmp", "ts/y.orig"):
        w(S, rel, "x\n")
    # not a backup by the rule (.bak must end the name or be followed by . _ or -): kept
    w(S, "ts/foo.cfg.bak2", "x\n")
    os.makedirs(os.path.join(S, "ts", "emptydir"), exist_ok=True)
    os.makedirs(os.path.join(S, "ts", "onlyskipped"), exist_ok=True)
    w(S, "ts/onlyskipped/config.cfg", "x\n")


def add_stock(T):
    """Stock files beside H9XASH, the overlay, and a VERSION.txt."""
    w(T, "VERSION.txt", "H9\nBuild: 1.59\nother\n")
    w(T, "reTS/game/ts/config.cfg",
      'name "Stock"\r\nrcon_password "stockpw"\r\nbind "z" "+jump"\r\nhost 5.5.5.5\r\n')
    w(T, "reTS/game/ts/tempdecal.wad", b"WAD3" + struct.pack("<ii", 0, 12))
    w(T, "xash3d-h9-patches/overlay/networking.ini", "[net]\r\nport=27015\r\n")
    w(T, "xash3d-h9-patches/overlay/h9xash.sh", "#!/bin/bash\r\necho overlay\r\n")
    w(T, "xash3d-h9-patches/overlay/h9_userid.sh", "#!/bin/bash\r\necho id\r\n")
    w(T, "xash3d-h9-patches/overlay/README_LINUX.txt", "overlay readme\r\n")
    # H9XASH has no h9_userid.sh yet: it comes from the overlay; h9xash.sh differs from the overlay's
    os.remove(os.path.join(T, "H9XASH", "h9_userid.sh"))


def remove_launchers(T):
    for lf in ("h9xash.sh", "h9_userid.sh", "README_LINUX.txt"):
        os.remove(os.path.join(T, "H9XASH", lf))


def make_fixtures(FX):
    base = os.path.join(FX, "base")
    make_base(base)
    out = {"base": base}

    def derive(name):
        dest = os.path.join(FX, name)
        shutil.copytree(base, dest)
        out[name] = dest
        return dest

    add_stock(derive("stock"))
    remove_launchers(derive("nolauncher"))

    d = derive("secrets")
    # built from pieces so that the test file itself holds no token-shaped text
    tok = "M" + "A" * 24 + "." + "abcdef" + "." + "B" * 30
    w(d, "H9XASH/ts/autoexec.cfg", "echo hi\r\necho " + tok + "\r\n")
    w(d, "H9XASH/ts/notes.txt", "https://discord" + ".com/api/webhooks/" + "1" * 18 + "/" + "x" * 20 + "\n")
    w(d, "H9XASH/ts/server_key.pem", "-----BEGIN RSA " + "PRIVATE KEY-----\nAAAA\n-----END RSA " + "PRIVATE KEY-----\n")

    d = derive("badbsp")
    w(d, "H9XASH/ts/maps/cut.bsp", bsp(30, {3: (1000, 500)}, size=200))
    d = derive("lfsptr")
    w(d, "H9XASH/ts/models/p.mdl", LFS_TEXT)
    d = os.path.join(FX, "nots")
    w(d, "H9XASH/readme.txt", "no ts folder here\n")
    out["nots"] = d

    # the LFS check on its own: good and bad files of every kind
    m = os.path.join(FX, "lfs-matrix")
    w(m, "good/ok.bsp", bsp(30, {0: (124, 50)}, size=200))
    w(m, "good/bsp2.bsp", b"BSP2" + bytes(300))
    w(m, "good/ok.mdl", mdl(100))
    w(m, "good/ok.wad", b"WAD3" + struct.pack("<ii", 0, 12))
    w(m, "good/ok.zip", small_zip())
    w(m, "good/ok.pk3", small_zip())
    w(m, "good/notes.txt", "x\n")
    w(m, "bad/short.bsp", bytes(50))
    w(m, "bad/badver.bsp", bsp(29))
    w(m, "bad/cut.bsp", bsp(30, {3: (1000, 500)}, size=200))
    w(m, "bad/short.mdl", bytes(40))
    w(m, "bad/badmagic.mdl", b"XXXX" + bytes(96))
    w(m, "bad/cut.mdl", mdl(5000)[:100])
    w(m, "bad/short.wad", bytes(5))
    w(m, "bad/badmagic.wad", b"JUNK" + bytes(16))
    w(m, "bad/cut.wad", b"WAD3" + struct.pack("<ii", 10, 100) + bytes(38))
    w(m, "bad/tiny.zip", bytes(10))
    w(m, "bad/cut.zip", small_zip()[:-30] + bytes(40))
    w(m, "bad/tiny.pk3", bytes(10))
    w(m, "bad/ptr.bsp", LFS_TEXT)
    w(m, "bad/ptr2.mdl", LFS_TEXT)
    w(m, "bad/ptr3.zip", LFS_TEXT)
    w(m, "bad/Upper.MDL", bytes(10))
    w(m, "bad/big_not_pointer.bsp", LFS_TEXT + bytes(2000))
    for i in range(20):
        w(m, "many/p%03d.bsp" % i, LFS_TEXT)
    out["lfs-matrix"] = m
    return out


def tree_digest(base):
    d = {}
    for root, dnames, fnames in os.walk(base):
        for f in fnames:
            p = os.path.join(root, f)
            with open(p, "rb") as fh:
                d[os.path.relpath(p, base).replace(os.sep, "/")] = hashlib.sha256(fh.read()).hexdigest()
        if not dnames and not fnames:
            d[os.path.relpath(root, base).replace(os.sep, "/") + "/"] = ""
    return d


# ---- running the two programs ---------------------------------------------------------

class Result(object):
    pass


def ps_env():
    """The environment for Windows PowerShell 5.1. A PSModulePath inherited from a PowerShell 7 session lists
    that session's modules first, and 5.1 then loads a Microsoft.PowerShell.Management and Utility that lack
    Get-FileHash; the stock 5.1 module path is set instead."""
    env = dict(ENV)
    if os.name == "nt":
        env["PSModulePath"] = ";".join([
            os.path.join(os.path.expanduser("~"), "Documents", "WindowsPowerShell", "Modules"),
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "WindowsPowerShell", "Modules"),
            os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "Modules")])
    return env


def build_cmd(kind, ctx, o):
    ps = kind == "ps"
    if ps:
        cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ctx.ps1,
               "-Source", o["source"], "-OutDir", o["out"], "-StageDir", o["stage"]]
        if o.get("keep", True):
            cmd += ["-KeepStage"]
    else:
        cmd = [sys.executable, "-I", ctx.py, "--source", o["source"], "--out-dir", o["out"], "--stage-dir", o["stage"],
               "--here", ctx.here]
        if o.get("keep", True):
            cmd += ["--keep-stage"]
    if o.get("name"):
        cmd += ["-Name" if ps else "--name", o["name"]]
    if o.get("native"):
        cmd += ["-LinuxNative" if ps else "--linux-native", o["native"]]
    if o.get("web"):
        cmd += ["-FilesDir" if ps else "--files-dir", o["files"]]
    else:
        cmd += ["-NoWebFiles" if ps else "--no-web-files"]
    if o.get("dry_run"):
        cmd += ["-DryRun" if ps else "--dry-run"]
    if o.get("no_linux"):
        cmd += ["-NoLinux" if ps else "--no-linux"]
    if o.get("allow_ip"):
        cmd += ["-AllowIp" if ps else "--allow-ip", o["allow_ip"]]
    if o.get("compression"):
        cmd += ["-Compression" if ps else "--compression", o["compression"]]
    return cmd


def run_one(kind, ctx, case, source, o):
    d = os.path.join(ctx.work, case, kind)
    os.makedirs(d)
    opts = dict(o)
    opts.update({"source": source + os.sep if o.get("trailing_sep") else source, "out": os.path.join(d, "out"),
                 "stage": os.path.join(d, "stage"), "files": os.path.join(d, "files")})
    if o.get("preseed"):
        os.makedirs(opts["out"])
        with open(os.path.join(opts["out"], "H9XASH-linux-server.zip"), "wb") as fh:
            fh.write(b"old")
    r = Result()
    r.kind, r.dir, r.opts = kind, d, opts
    r.out, r.stage_dir, r.files = opts["out"], opts["stage"], opts["files"]
    before = tree_digest(os.path.dirname(source)) if o.get("guard", True) else None
    p = subprocess.run(build_cmd(kind, ctx, opts), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       env=ps_env() if kind == "ps" else ENV, cwd=d, timeout=900)
    r.rc = p.returncode
    r.text = p.stdout.decode("latin-1")
    r.unchanged = before is None or tree_digest(os.path.dirname(source)) == before
    stages = glob.glob(os.path.join(r.stage_dir, "h9xash-stage-*", "H9XASH"))
    r.stage = stages[0] if len(stages) == 1 else None
    r.zips = sorted(glob.glob(os.path.join(r.out, "*.zip")))
    r.report = os.path.join(r.out, (o.get("name") or "H9XASH") + ".report.txt")
    return r


def normalise(text, r, ctx, fx_root=None):
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    for p in (r.dir, ):
        t = t.replace(p, "<W>")
    t = re.sub(r"h9xash-stage-\d{8}-\d{4}-\d+", "h9xash-stage-<S>", t)
    t = re.sub(r"(build \S+), \d{4}-\d\d-\d\d \d\d:\d\d:\d\d", r"\1, <TIME>", t)
    t = re.sub(r"SHA-256 [0-9A-Fa-f]{64}", "SHA-256 <HASH>", t)
    t = re.sub(r"Python \d+\.\d+\.\d+", "Python <V>", t)
    t = re.sub(r"\d+ MB\b", "<N> MB", t)
    # the option names differ in the messages that name them
    t = re.sub(r"--no-linux|-NoLinux", "<NOLINUX>", t)
    t = re.sub(r"--linux-native|-LinuxNative", "<LINUXNATIVE>", t)
    t = re.sub(r"--source\b|-Source\b", "<SOURCE>", t)
    lines = t.split("\n")
    # Windows PowerShell appends its own error location and category after a thrown message
    for i, line in enumerate(lines):
        if re.match(r"^At .*\.ps1:\d+ char:\d+", line):
            lines = lines[:i]
            break
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def line_diff(a, b, na, nb):
    return "\n".join(list(difflib.unified_diff(a, b, na, nb, lineterm="", n=1))[:40])


# ---- ZIP reading and comparing --------------------------------------------------------

def read_zip(path):
    out = []
    with zipfile.ZipFile(path) as zf:
        for zi in zf.infolist():
            out.append({"name": zi.filename, "dir": zi.is_dir(), "sys": zi.create_system, "attr": zi.external_attr,
                        "comp": zi.compress_type, "flag": zi.flag_bits & 0x800, "date": zi.date_time,
                        "data": b"" if zi.is_dir() else zf.read(zi)})
    return out


def secs(dt):
    return time.mktime(tuple(dt) + (0, 0, -1))


def compare_zips(label, pa, pb, soft_order=False):
    a, b = read_zip(pa), read_zip(pb)
    na, nb = [m["name"] for m in a], [m["name"] for m in b]
    ok = check(sorted(na) == sorted(nb), label + ": same member list (%d members)" % len(na),
               line_diff(sorted(na), sorted(nb), "ps", "py"))
    if na != nb and sorted(na) == sorted(nb):
        if soft_order:
            info(label + ": member order differs from PowerShell's (list is equal)")
        else:
            check(False, label + ": same member order", line_diff(na, nb, "ps", "py"))
    elif na == nb:
        check(True, label + ": same member order")
    da, db = dict((m["name"], m) for m in a), dict((m["name"], m) for m in b)
    bad_attr, bad_data, bad_date, norm_only = [], [], [], []
    for n in sorted(set(da) & set(db)):
        x, y = da[n], db[n]
        if (x["dir"], x["sys"], x["attr"], x["comp"], x["flag"]) != (y["dir"], y["sys"], y["attr"], y["comp"], y["flag"]):
            bad_attr.append("%s: ps(dir=%s sys=%d attr=%08x comp=%d utf8=%d) py(dir=%s sys=%d attr=%08x comp=%d utf8=%d)" % (
                n, x["dir"], x["sys"], x["attr"], x["comp"], x["flag"], y["dir"], y["sys"], y["attr"], y["comp"], y["flag"]))
        if x["data"] != y["data"]:
            if x["data"].replace(b"\r\n", b"\n") == y["data"].replace(b"\r\n", b"\n"):
                norm_only.append(n)
            else:
                bad_data.append(n)
        tx, ty = secs(x["date"]), secs(y["date"])
        fixed = secs(time.localtime(FIXED)[:6])
        if tx == fixed or ty == fixed:
            if tx != ty:
                bad_date.append("%s: %s / %s" % (n, x["date"], y["date"]))
        elif abs(tx - ty) > 180:
            bad_date.append("%s: %s / %s" % (n, x["date"], y["date"]))
    check(not bad_attr, label + ": same entry kind, Unix mode/attributes, compression and name flag",
          "\n".join(bad_attr[:10]))
    check(not bad_data, label + ": same bytes in every member", "\n".join(bad_data[:10]))
    if norm_only:
        check(False, label + ": members equal only after line-end normalisation", "\n".join(norm_only[:10]))
    check(not bad_date, label + ": same entry times (files not rewritten keep the source time)", "\n".join(bad_date[:10]))
    return a, b


def compare_stages(label, ra, rb):
    if not ra.opts.get("keep", True):
        check(ra.stage is None and rb.stage is None and os.path.isdir(ra.stage_dir) and os.path.isdir(rb.stage_dir)
              and not os.listdir(ra.stage_dir) and not os.listdir(rb.stage_dir),
              label + ": the stage is removed after a ZIP run and its parent folder stays, in both")
        return
    if ra.stage is None or rb.stage is None:
        check(ra.stage is None and rb.stage is None, label + ": both kept a staged folder (ps %s, py %s)" % (
            ra.stage is not None, rb.stage is not None))
        return
    da, db = tree_digest(ra.stage), tree_digest(rb.stage)
    check(sorted(da) == sorted(db), label + ": same staged files and empty folders (%d)" % len(da),
          line_diff(sorted(da), sorted(db), "ps", "py"))
    diff = [k for k in sorted(set(da) & set(db)) if da[k] != db[k]]
    check(not diff, label + ": same bytes in every staged file", "\n".join(diff[:10]))


def compare_runs(case, ra, rb):
    heading(case)
    check(ra.rc == rb.rc, "%s: same exit code (ps %s, py %s)" % (case, ra.rc, rb.rc),
          "ps output:\n" + ra.text[-1500:] + "\npy output:\n" + rb.text[-1500:])
    check(ra.unchanged and rb.unchanged, case + ": the fixture is unchanged after both runs")
    za = [os.path.basename(p) for p in ra.zips]
    zb = [os.path.basename(p) for p in rb.zips]
    check(za == zb, "%s: same ZIP files written (%s)" % (case, ", ".join(za) or "none"))
    check(os.path.isfile(ra.report) == os.path.isfile(rb.report), case + ": report written by both or neither")
    for name in sorted(set(za) & set(zb)):
        if ra.opts.get("preseed") and name == "H9XASH-linux-server.zip":
            continue
        try:
            compare_zips("%s %s" % (case, name), os.path.join(ra.out, name), os.path.join(rb.out, name),
                         soft_order=("-linux" not in name))
        except zipfile.BadZipFile as e:
            check(False, "%s %s: both ZIPs can be read" % (case, name), str(e))
    compare_stages(case + " stage", ra, rb)
    ca = normalise(ra.text, ra, None)
    cb = normalise(rb.text, rb, None)
    check(ca == cb, case + ": same console output (normalised)", line_diff(ca, cb, "ps", "py"))
    if os.path.isfile(ra.report) and os.path.isfile(rb.report):
        with open(ra.report, "rb") as fa, open(rb.report, "rb") as fb:
            ta, tb = fa.read().decode("latin-1"), fb.read().decode("latin-1")
        check(("\r\n" in ta) == ("\r\n" in tb), case + ": report uses the same line ends")
        pa, pb = normalise(ta, ra, None), normalise(tb, rb, None)
        check(pa == pb, case + ": same report (normalised)", line_diff(pa, pb, "ps", "py"))


# ---- rules checked on one program's output --------------------------------------------

WINDOWS_EXT = (".exe", ".dll", ".bat", ".cmd", ".ps1")


def mode_of(m):
    return (m["attr"] >> 16) & 0o777


def rules_windows_zip(label, path):
    ms = read_zip(path)
    names = [m["name"] for m in ms]
    check(all(n.startswith("H9XASH/") for n in names), label + ": everything under H9XASH/")
    check(not any("\\" in n for n in names), label + ": forward slashes only")
    leaves = [n.rsplit("/", 1)[-1].lower() for n in names if not n.endswith("/")]
    linux = [l for l in leaves if l in ("h9xash.sh", "h9_userid.sh", "readme_linux.txt") or re.search(r"\.so(\.\d+)*(\.patch)?$", l)]
    check(not linux, label + ": no Linux-only file", "\n".join(linux))
    check("H9XASH/ts/addons/amxmodx/data/vault/" in names and "H9XASH/ts/addons/amxmodx/logs/" in names,
          label + ": entries for the empty vault and logs folders")
    check("H9XASH/ts/dlls/thing.sox" in names, label + ": a .sox file is not taken for a library")
    check("H9XASH/HAVOC 9.exe" in names and "H9XASH/ts/dlls/mp.dll.patch" in names, label + ": Windows files present")
    return ms


def skipped_names_absent(label, ms):
    names = set(m["name"] for m in ms)
    leak_names = ("user_id.ini", "device_id.ini", "listip.cfg", "video.cfg", "mail.env", "thumbs.db", "system.reg",
                  ".gitattributes", ".xash_id", "custom.hpk", "h9_presence.cfg", "h9_presence.key", "x_resolved.cfg")
    leak_dirs = ("logs", "save", "screenshots", "downloads", "node_modules", "drive_c", "userconfig.d", ".h9xash-updater",
                 "ts_downloads")
    leak_ext = (".log", ".bak", ".bak_2", ".env", ".key", ".dem", ".sav", ".tmp", ".orig", ".pid")
    leaked = []
    for n in sorted(names):
        if n.endswith("/"):
            continue
        parts = n.lower().split("/")
        leaf = parts[-1]
        if leaf in leak_names or leaf.endswith(leak_ext) or "downloadstsm" in leaf or any(p in leak_dirs for p in parts[1:-1]) \
                or parts[1:3] in (["webview2", "data"], ["webview2", "runtime"], ["presets", "backup"]):
            leaked.append(n)
    if "H9XASH/ts/onlyskipped/config.cfg" in names:
        leaked.append("H9XASH/ts/onlyskipped/config.cfg")
    check(not leaked, label + ": no player, server or secret file in the ZIP", "\n".join(leaked[:10]))
    check("H9XASH/ts/emptydir/" in names, label + ": an empty folder of the source keeps an entry")


def rules_unix_zip(label, path, native=False, expect_over=()):
    ms = read_zip(path)
    names = [m["name"] for m in ms]
    check(all(n.startswith("H9XASH/") for n in names), label + ": everything under H9XASH/")
    check(all(m["sys"] == 3 for m in ms), label + ": every entry is a Unix entry")
    bad = []
    for m in ms:
        if m["dir"]:
            if mode_of(m) != 0o755:
                bad.append("dir %s mode %o" % (m["name"], mode_of(m)))
            continue
        want = 0o755 if (m["name"].lower().endswith(".sh") or m["data"][:4] == b"\x7fELF") else 0o644
        if mode_of(m) != want:
            bad.append("%s mode %o, wanted %o" % (m["name"], mode_of(m), want))
        if m["name"].lower().endswith(".sh") and b"\r" in m["data"]:
            bad.append("%s has a CR" % m["name"])
    check(not bad, label + ": modes (.sh and ELF 0755, the rest 0644, folders 0755) and LF in .sh files", "\n".join(bad[:10]))
    check("H9XASH/ts/addons/amxmodx/data/vault/" in names and "H9XASH/ts/addons/amxmodx/logs/" in names,
          label + ": entries for the empty vault and logs folders")
    low = [n.lower() for n in names]
    if native:
        check(not any(x.endswith(WINDOWS_EXT) for x in low), label + ": no .exe .dll .bat .cmd .ps1 in a native package")
        check(not any(x.startswith("h9xash/webview2/") for x in low), label + ": no webview2 folder in a native package")
        d = dict((m["name"], m) for m in ms)
        for rel, data in expect_over:
            check(d.get("H9XASH/" + rel, {}).get("data") == data, label + ": %s comes from the native build" % rel)
        check("H9XASH/ts/dlls/ts.so" not in d and "H9XASH/ts/dlls/libfoo.so.1" not in d,
              label + ": H9XASH's own stock .so files stay out")
    else:
        check("H9XASH/HAVOC 9.exe" in names and "H9XASH/h9xash.sh" in names and "H9XASH/ts/dlls/ts.so" in names,
              label + ": Wine package holds the Windows game and the Linux files")
    return ms


# ---- the cases ------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="stage_h9xash.py against stage-h9xash.ps1")
    ap.add_argument("--work", required=True, help="the work folder (emptied first)")
    ap.add_argument("--ps1", default=None, help="stage-h9xash.ps1 (default: beside this file or one folder up)")
    ap.add_argument("--py", default=None, help="stage_h9xash.py (default: beside this file)")
    ap.add_argument("--sh", default=None, help="stage-h9xash.sh (default: beside this file)")
    ap.add_argument("--here", default=None, help="the repository root given to the port (default: the ps1's folder)")
    ap.add_argument("--no-ps", action="store_true", help="skip the PowerShell comparison")
    ap.add_argument("--tmp", default=None, help="TEMP and TMP for the programs run")
    a = ap.parse_args()

    ctx = Result()
    ctx.work = os.path.abspath(a.work)
    ctx.py = os.path.abspath(a.py or beside("stage_h9xash.py"))
    ps1 = a.ps1
    if not ps1:
        c = beside("stage-h9xash.ps1")
        if os.path.isfile(c):
            ps1 = c
    ctx.ps1 = os.path.abspath(ps1) if ps1 else None
    ctx.here = os.path.abspath(a.here) if a.here else (os.path.dirname(ctx.ps1) if ctx.ps1 else MY_DIR)
    use_ps = (not a.no_ps) and ctx.ps1 and os.path.isfile(ctx.ps1) and shutil.which("powershell.exe") is not None
    if a.tmp:
        os.makedirs(a.tmp, exist_ok=True)
        ENV["TEMP"] = ENV["TMP"] = os.path.abspath(a.tmp)

    marker = os.path.join(ctx.work, ".stage_h9xash_test_work")
    if os.path.isdir(ctx.work) and os.listdir(ctx.work):
        if not os.path.isfile(marker):
            print("refusing to empty %s: it is not empty and was not made by this test" % ctx.work)
            return 2
        shutil.rmtree(ctx.work)
    os.makedirs(ctx.work, exist_ok=True)
    with open(marker, "w") as fh:
        fh.write("made by stage_h9xash_test.py\n")

    print("port:       " + ctx.py)
    print("powershell: " + (ctx.ps1 if use_ps else "not used (--no-ps, no powershell.exe, or no stage-h9xash.ps1)"))
    print("work:       " + ctx.work)
    FX = os.path.join(ctx.work, "fixtures")
    fx = make_fixtures(FX)

    def src(name):
        return os.path.join(fx[name], "H9XASH")

    def nat(name, which="linux-native"):
        return os.path.join(fx[name], which)

    cases = [
        # name, fixture, options
        ("native", "base", {"native": nat("base"), "allow_ip": "8.8.4.4"}),
        ("wine-no-build", "base", {"native": os.path.join(fx["base"], "no-such-build"), "compression": "Fastest",
                                   "preseed": True}),
        ("wine-no-client", "base", {"native": nat("base", "linux-noclient")}),
        ("server-only", "base", {"native": nat("base", "linux-server-only")}),
        ("dry-run", "base", {"native": nat("base"), "dry_run": True, "trailing_sep": True}),
        ("no-linux", "base", {"native": nat("base"), "no_linux": True, "name": "H9TEST", "keep": False}),
        ("stock-and-overlay", "stock", {"native": nat("stock")}),
        ("stock-wine", "stock", {"native": os.path.join(fx["stock"], "no-such-build")}),
        ("no-launchers", "nolauncher", {"native": nat("nolauncher")}),
        ("web-files", "stock", {"native": nat("stock"), "web": True}),
        ("stop-secrets", "secrets", {"native": nat("secrets")}),
        ("stop-bad-bsp", "badbsp", {"native": nat("badbsp")}),
        ("stop-lfs-pointer", "lfsptr", {"native": nat("lfsptr")}),
    ]
    runs = {}
    for case, fxname, o in cases:
        pair = {}
        for kind in (["ps"] if use_ps else []) + ["py"]:
            pair[kind] = run_one(kind, ctx, case, src(fxname), o)
        runs[case] = pair
        if use_ps:
            compare_runs(case, pair["ps"], pair["py"])

    # ---- the rules on the port's own output (also on PowerShell's, to prove the checks themselves)
    kinds = (["ps"] if use_ps else []) + ["py"]
    for kind in kinds:
        tag = "[" + kind + "] "

        r = runs["native"][kind]
        heading(tag + "native client build")
        check(r.rc == 0, tag + "exit 0")
        check([os.path.basename(p) for p in r.zips] == ["H9XASH-linux.zip", "H9XASH.zip"], tag + "two ZIPs written")
        ms = rules_windows_zip(tag + "H9XASH.zip", os.path.join(r.out, "H9XASH.zip"))
        skipped_names_absent(tag + "H9XASH.zip", ms)
        d = dict((m["name"], m) for m in ms)
        check(b"RealPlayer" not in d["H9XASH/ts/config.cfg"]["data"] and b'name "Player"' in d["H9XASH/ts/config.cfg"]["data"]
              and b"hunter2" not in d["H9XASH/ts/config.cfg"]["data"] and b"8.8.8.8" not in d["H9XASH/ts/config.cfg"]["data"],
              tag + "ts/config.cfg is the player's own, scrubbed, name reset")
        ex = d["H9XASH/ts/extra.cfg"]["data"]
        check(b"secret" not in ex and b"master 1.2.3.4" not in ex and b"tok" not in ex and b"my_token_x" not in ex
              and b"8.8.4.4" in ex and b"10.1.2.3" in ex and b"ver 1.2.3.4" in ex and b'"h9_userid" "0"' in ex
              and b"caf\xe9" in ex and ex.endswith(b'\r\nlast "line"'),
              tag + "extra.cfg: secrets and public IPs gone; allowed, private, version-line and zero-valued lines, the "
              "Latin-1 byte and the missing last line end kept", ex)
        check(b"STEAM_" not in d["H9XASH/ts/addons/amxmodx/configs/users.ini"]["data"]
              and b"keep me" in d["H9XASH/ts/addons/amxmodx/configs/users.ini"]["data"], tag + "SteamID lines removed")
        check(b"\r" not in d["H9XASH/ts/addons/amxmodx/scripting/compile.sh"]["data"], tag + "a .sh file kept in the Windows ZIP has LF")
        rules_unix_zip(tag + "H9XASH-linux.zip", os.path.join(r.out, "H9XASH-linux.zip"), native=True,
                       expect_over=[("ts/dlls/ts_i386.so", ELF + b"reTS"), ("h9xash.sh", b"#!/bin/bash\necho native\n"),
                                    ("xash3d", ELF + b"client")])

        r = runs["wine-no-build"][kind]
        heading(tag + "no native build: Wine/Proton package")
        check(r.rc == 0, tag + "exit 0")
        names = sorted(os.path.basename(p) for p in r.zips)
        check(names == ["H9XASH-linux-server.zip", "H9XASH-linux.zip", "H9XASH.zip"], tag + "Linux and Windows ZIPs written, "
              "the pre-seeded old server ZIP still there", str(names))
        check(os.path.getsize(os.path.join(r.out, "H9XASH-linux-server.zip")) == 3, tag + "the old server ZIP was not replaced")
        check("an older" in r.text and "no dedicated server package" in r.text, tag + "warns about the older server ZIP")
        check("Wine/Proton" in r.text, tag + "warns that the Linux ZIP is the Wine/Proton package")
        rules_unix_zip(tag + "H9XASH-linux.zip", os.path.join(r.out, "H9XASH-linux.zip"), native=False)
        rules_windows_zip(tag + "H9XASH.zip", os.path.join(r.out, "H9XASH.zip"))

        r = runs["server-only"][kind]
        heading(tag + "server-only native build")
        names = sorted(os.path.basename(p) for p in r.zips)
        check(names == ["H9XASH-linux-server.zip", "H9XASH-linux.zip", "H9XASH.zip"], tag + "three ZIPs written", str(names))
        rules_unix_zip(tag + "H9XASH-linux.zip", os.path.join(r.out, "H9XASH-linux.zip"), native=False)
        rules_unix_zip(tag + "H9XASH-linux-server.zip", os.path.join(r.out, "H9XASH-linux-server.zip"), native=True,
                       expect_over=[("xashds", ELF + b"server"), ("ts/dlls/ts_i386.so", ELF + b"reTS")])

        r = runs["dry-run"][kind]
        heading(tag + "dry run")
        check(r.rc == 0 and not r.zips and os.path.isfile(r.report) and r.stage is not None,
              tag + "no ZIP, a report, the stage kept")
        check("Dry run: no ZIP." in r.text, tag + "says so")

        r = runs["no-linux"][kind]
        heading(tag + "no Linux package")
        check(r.rc == 0 and [os.path.basename(p) for p in r.zips] == ["H9TEST.zip"] and os.path.isfile(r.report),
              tag + "the Windows ZIP only, named by --name, with its report")
        if os.path.isfile(os.path.join(ctx.here, "havoc9.org", "downloads", "index.html")):
            check('has no href="H9TEST.zip"' in r.text, tag + "the downloads page check uses the name")

        r = runs["stock-and-overlay"][kind]
        heading(tag + "stock files and overlay")
        ms = read_zip(os.path.join(r.out, "H9XASH.zip"))
        d = dict((m["name"], m) for m in ms)
        cfg = d["H9XASH/ts/config.cfg"]["data"]
        check(b"Stock" in cfg and b"stockpw" not in cfg and b"5.5.5.5" not in cfg and b"+jump" in cfg,
              tag + "ts/config.cfg is the stock one, scrubbed")
        check(d["H9XASH/networking.ini"]["data"] == b"[net]\r\nport=27015\r\n", tag + "networking.ini is the overlay template")
        check("H9XASH/ts/tempdecal.wad" in d, tag + "tempdecal.wad comes from the stock copy")
        check(r.stage is not None and os.path.isfile(os.path.join(r.stage, "h9_userid.sh"))
              and open(os.path.join(r.stage, "h9_userid.sh"), "rb").read() == b"#!/bin/bash\necho id\n",
              tag + "h9_userid.sh filled from the overlay into the stage, LF")
        check("differs from the overlay" in r.text, tag + "warns that H9XASH's h9xash.sh differs from the overlay's")
        check("build 1.59" in r.text, tag + "build read from VERSION.txt")

        r = runs["stock-wine"][kind]
        heading(tag + "stock files, overlay and a Wine package")
        lz = dict((m["name"], m) for m in read_zip(os.path.join(r.out, "H9XASH-linux.zip")))
        check(lz["H9XASH/h9_userid.sh"]["data"] == b"#!/bin/bash\necho id\n", tag + "the Wine package holds the overlay's h9_userid.sh, LF")
        check(lz["H9XASH/h9xash.sh"]["data"] == b"#!/bin/bash\necho wine\n", tag + "H9XASH's own h9xash.sh goes out (LF), not the overlay's")
        rules_unix_zip(tag + "H9XASH-linux.zip", os.path.join(r.out, "H9XASH-linux.zip"), native=False)

        r = runs["no-launchers"][kind]
        heading(tag + "no Linux launcher files anywhere")
        check(r.rc == 0 and [os.path.basename(p) for p in r.zips] == ["H9XASH.zip"], tag + "the Windows ZIP only")
        check("is in neither H9XASH nor the overlay" in r.text, tag + "warns")

        for case, phrase in (("stop-secrets", "STOPPED, nothing was zipped"), ("stop-bad-bsp", "STOP:"),
                             ("stop-lfs-pointer", "Git LFS pointer")):
            r = runs[case][kind]
            heading(tag + case)
            check(r.rc == 1 and not r.zips, tag + "exit 1 and no ZIP written")
            check(phrase in r.text, tag + "says: " + phrase)
        r = runs["stop-secrets"][kind]
        check("Discord bot token" in r.text and "Discord webhook URL" in r.text and "private key" in r.text,
              tag + "names all three hard stops")
        check(os.path.isfile(r.report) and "STOPPED" in open(r.report, "rb").read().decode("latin-1"),
              tag + "the report is written with the stop")
        check(r.stage is not None, tag + "the stage is kept for a look")

    # ---- the stops that need no fixture of their own
    heading("no ts folder")
    pair = {}
    for kind in kinds:
        pair[kind] = run_one(kind, ctx, "stop-no-ts", os.path.join(fx["nots"], "H9XASH"), {"guard": True})
    for kind in kinds:
        check(pair[kind].rc == 1 and not pair[kind].zips, "[%s] exit 1 and no ZIP when the source has no ts folder" % kind)
    if use_ps:
        check(pair["ps"].rc == pair["py"].rc, "same exit code for a source without a ts folder")

    # ---- the Git LFS / cut-short-file check on its own
    heading("check-lfs on a folder of good and bad files")
    m = fx["lfs-matrix"]
    pyr = subprocess.run([sys.executable, "-I", ctx.py, "--check-lfs", m], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=ENV)
    pyt = pyr.stdout.decode("latin-1")
    check(pyr.returncode == 1, "port: exit 1 on the matrix folder")
    check("STOP: 37 of the files this needs are not whole (23 of them Git LFS pointers):" in pyt and "... and 12 more" in pyt,
          "port: counts 37 problems (23 pointers), lists 25 and counts the rest", pyt[:600])
    check((os.sep + "good" + os.sep) not in pyt, "port: names no good file")
    pyr2 = subprocess.run([sys.executable, "-I", ctx.py, "--check-lfs", os.path.join(m, "good")], stdout=subprocess.PIPE, env=ENV)
    check(pyr2.returncode == 0 and b"no Git LFS pointer" in pyr2.stdout, "port: exit 0 on the good files alone")
    if use_ps:
        lfs_ps = os.path.join(os.path.dirname(ctx.ps1), "tools", "check-lfs.ps1")
        if os.path.isfile(lfs_ps):
            for label, target in (("matrix", m), ("good files", os.path.join(m, "good")), ("fixture H9XASH", src("base"))):
                p = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", lfs_ps, "-Path", target],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=ps_env())
                q = subprocess.run([sys.executable, "-I", ctx.py, "--check-lfs", target], stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, env=ENV)
                ta = p.stdout.decode("latin-1").replace("\r\n", "\n").split("\n")
                tb = q.stdout.decode("latin-1").replace("\r\n", "\n").split("\n")
                check(p.returncode == q.returncode, "check-lfs %s: same exit code (ps %d, py %d)" % (label, p.returncode, q.returncode))
                check(ta == tb, "check-lfs %s: same output, line for line" % label, line_diff(ta, tb, "ps", "py"))
        else:
            info("tools/check-lfs.ps1 not found beside the ps1; the check was not compared")

    # ---- the web files
    if use_ps:
        heading("web files for H9XASH-Updater")
        ra, rb = runs["web-files"]["ps"], runs["web-files"]["py"]
        check(os.path.isfile(os.path.join(ra.files, "manifest.json")) and os.path.isfile(os.path.join(rb.files, "manifest.json")),
              "both published a manifest (ps %s, py %s)" % (os.path.isfile(os.path.join(ra.files, "manifest.json")),
                                                            os.path.isfile(os.path.join(rb.files, "manifest.json"))),
              "ps:\n" + ra.text[-800:] + "\npy:\n" + rb.text[-800:])
        if os.path.isfile(os.path.join(ra.files, "manifest.json")) and os.path.isfile(os.path.join(rb.files, "manifest.json")):
            def manifest(p):
                t = open(os.path.join(p, "manifest.json"), "rb").read().decode("utf-8")
                return [l for l in t.split("\n") if '"published"' not in l]
            ma, mb = manifest(ra.files), manifest(rb.files)
            check(ma == mb, "same manifest (published time apart)", line_diff(ma, mb, "ps", "py"))
            check(sorted(os.listdir(ra.files)) == sorted(os.listdir(rb.files)), "same files in the files folder")

    # ---- the shell wrapper
    heading("stage-h9xash.sh")
    sh = os.path.abspath(a.sh or beside("stage-h9xash.sh"))
    bash = None
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and os.path.isfile(c):
            bash = c
            break
    if bash and os.path.isfile(sh) and (os.name != "nt" or "WindowsApps" not in bash):
        arg = sh.replace("\\", "/")
        p = subprocess.run([bash, arg, "--check-lfs", src("base").replace("\\", "/")], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, env=ENV, timeout=120)
        check(p.returncode == 0 and b"no Git LFS pointer" in p.stdout, "the wrapper finds Python and passes the arguments",
              p.stdout.decode("latin-1"))
        o = os.path.join(ctx.work, "wrapper-out").replace("\\", "/")
        p = subprocess.run([bash, arg, "--source", src("base").replace("\\", "/"), "--out-dir", o, "--stage-dir",
                            o + "/stage", "--no-web-files", "--dry-run", "--here", ctx.here.replace("\\", "/")],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=ENV, timeout=300)
        check(p.returncode == 0 and b"Dry run: no ZIP." in p.stdout, "the wrapper runs a dry run", p.stdout.decode("latin-1")[-600:])
    else:
        info("bash or stage-h9xash.sh not available: the wrapper was not run")

    # ---- Python-only helpers that have no PowerShell twin
    heading("helpers")
    sys.path.insert(0, os.path.dirname(ctx.py))
    import importlib
    mod = importlib.import_module(os.path.splitext(os.path.basename(ctx.py))[0])
    check(mod.get_extension(".gitattributes") == ".gitattributes" and mod.get_extension("a.") == "" and mod.get_extension("a.b.C") == ".C"
          and mod.get_extension("noext") == "", "get_extension follows Path.GetExtension")
    check(mod.get_skip_reason("Logs/x.txt", False) == "folder logs" and mod.get_skip_reason("ts/Addons/AMXModX/Data/Vault/x", False)
          == "folder " + mod.native("ts/addons/amxmodx/data/vault"), "skip rules ignore case")
    check(mod.split_lines("a\rb\r\nc") == ["a\rb\r\n", "c"] and mod.split_lines("a\n") == ["a\n"], "lines end at LF only")
    names = mod.processes_running_from(os.path.dirname(os.path.realpath(sys.executable)))
    check(len(names) > 0, "the process check sees this Python running from its own folder (%s)" % ", ".join(names))

    # ---- summary
    heading("summary")
    failed = [label for ok, label in RESULTS if not ok]
    print("%d checks, %d passed, %d failed" % (len(RESULTS), len(RESULTS) - len(failed), len(failed)))
    for label in failed:
        print("  FAILED: " + label)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
