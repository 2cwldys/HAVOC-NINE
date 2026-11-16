#!/usr/bin/env python3
"""preset_bundle.py -- the official plugin list of a build, as one file a release sends to the host.

    python tools/preset_bundle.py --h9xash H9XASH [--linux H9XASH-linux] --out dist/preset-bundle.json

The host judges a server's plugins against the site's official list (h9web, docs/H9_PRESENCE.txt section 4d), and that list is only
as new as the last import. A release that rebuilds a plugin changes its hash, so a release that does not bring its list leaves the
servers it was built for reading "not authenticated". deploy-vps.ps1 runs this and sends the file; the host's receive-deploy.ps1
imports it with h9web's preset-seed.js --import-bundle.

What goes in, per game mode (the tags of presets\\plugins.<tag>.ini): that mode's plugins, every module and every Metamod plugin
of the Windows build (H9XASH) and, with --linux, of the native Linux build (its .so files; its plugins are the same .amxx files).
On the shared list every mode accepts: the plugins configs\\plugins.ini switches on, the build's own default set (--live), which no
preset names in full: the Apollo RP plugins, the P2P helper, the stats and prop plugins. Only files of the build, never of the PC.
It copies the files preset-seed.js reads into a scratch folder first, so the Linux build needs no presets folder of its own.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SEED_CANDIDATES = [
    os.path.join(HERE, "..", "h9web", "modules", "presence", "bin", "preset-seed.js"),
    r"D:\GIT Storage\ts_h9_team_elimination\h9web\modules\presence\bin\preset-seed.js",
]


def die(msg):
    sys.stderr.write("preset_bundle.py: %s\n" % msg)
    sys.exit(1)


def skeleton(root, presets_from, plugins_from, out):
    """The files preset-seed.js reads from a build: the presets, the plugins, the modules, Metamod's list and what it names."""
    def put(rel, src):
        dst = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)

    for f in sorted(os.listdir(os.path.join(presets_from, "presets"))):
        if re.match(r"^plugins\.[^.]+\.ini$", f, re.I):
            put(os.path.join("presets", f), os.path.join(presets_from, "presets", f))
    amx = os.path.join("ts", "addons", "amxmodx")
    plug_src = plugins_from if os.path.isdir(os.path.join(plugins_from, amx, "plugins")) else presets_from
    for f in os.listdir(os.path.join(plug_src, amx, "plugins")):
        if f.lower().endswith(".amxx"):
            put(os.path.join(amx, "plugins", f), os.path.join(plug_src, amx, "plugins", f))
    live = os.path.join(plug_src, amx, "configs", "plugins.ini")
    if os.path.exists(live):
        put(os.path.join(amx, "configs", "plugins.ini"), live)
    mods = os.path.join(root, amx, "modules")
    if os.path.isdir(mods):
        for f in os.listdir(mods):
            if re.search(r"_amxx(_i386)?\.(dll|so)$", f, re.I):
                put(os.path.join(amx, "modules", f), os.path.join(mods, f))
    meta = os.path.join("ts", "addons", "metamod", "plugins.ini")
    if os.path.exists(os.path.join(root, meta)):
        put(meta, os.path.join(root, meta))
        for line in open(os.path.join(root, meta), encoding="utf-8", errors="replace"):
            m = re.match(r"^\s*(win32|linux)\s+(\S+)", re.sub(r";.*$", "", line), re.I)
            if not m:
                continue
            rel = os.path.normpath(os.path.join("ts", m.group(2).replace("\\", "/")))
            if os.path.exists(os.path.join(root, rel)):
                put(rel, os.path.join(root, rel))


def seed(node, seed_js, folder, out, live):
    args = [node, seed_js, "--h9xash", folder, "--bundle", out] + (["--live"] if live else [])
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        die("preset-seed.js failed:\n" + r.stderr)
    sys.stderr.write("  " + r.stderr.strip().splitlines()[0] + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--h9xash", required=True, help="the Windows build's folder (H9XASH)")
    ap.add_argument("--linux", help="the native Linux build's folder (H9XASH-linux)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--node", default="node")
    ap.add_argument("--seed")
    a = ap.parse_args()
    seed_js = a.seed or next((p for p in SEED_CANDIDATES if os.path.exists(p)), None)
    if not seed_js:
        die("no preset-seed.js (h9web\\modules\\presence\\bin): pass --seed")
    win = os.path.abspath(a.h9xash)
    if not os.path.isdir(os.path.join(win, "presets")):
        die("%s has no presets folder" % win)
    work = tempfile.mkdtemp(prefix="h9bundle-")
    try:
        parts = []
        sk = os.path.join(work, "win")
        skeleton(win, win, win, sk)
        p = os.path.join(work, "win.json")
        sys.stderr.write("Windows build:\n")
        seed(a.node, seed_js, sk, p, True)
        parts.append(p)
        if a.linux and os.path.isdir(a.linux):
            lk = os.path.join(work, "linux")
            skeleton(os.path.abspath(a.linux), win, win, lk)
            p = os.path.join(work, "linux.json")
            sys.stderr.write("Linux build:\n")
            seed(a.node, seed_js, lk, p, False)
            parts.append(p)
        merged = {}
        for p in parts:
            for l in json.load(open(p, encoding="utf-8"))["lists"]:
                m = merged.setdefault(l["gameMode"], {})
                for e in l["entries"]:
                    m[(e["kind"], e["file"].lower(), e["sha256"])] = e
        lists = [{"gameMode": gm, "entries": sorted(m.values(), key=lambda e: (e["kind"], e["file"]))} for gm, m in sorted(merged.items())]
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "w", encoding="ascii", newline="\n") as f:
            json.dump({"format": 1, "lists": lists}, f, indent=1)
            f.write("\n")
        sys.stderr.write("wrote %s: %s\n" % (a.out, ", ".join("%s %d" % ("shared" if l["gameMode"] == "*" else l["gameMode"], len(l["entries"])) for l in lists)))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
