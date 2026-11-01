r"""
make_webclient_bin.py - gathers the H9 web client's browser builds into one folder, with a
BUILDINFO.txt that says what each file is and what it was built from.

The builds are what a clone of the repository cannot make by itself: the engine and its side
modules (xash3d-fwgs with H9's patches, built with emsdk) and the game's client library (reTS,
built with emsdk). make_webclient_game.py takes them from this folder, so the package can be laid
out from the repository alone, on Windows or on Linux. The folder keeps waf's out-folder layout,
which is what make_webclient_game.py's --engine-build reads, plus cl_dll\ for the client library.

Usage, on the build PC, after the builds of havoc9.org\webclient\DEPLOY.txt section 3:
    py -3 tools\make_webclient_bin.py [options]

    --engine-build <dir>  waf's out folder (default: <root>\webclient-build\xash3d-fwgs\build-web)
    --client <wasm>       reTS's client (default: <root>\webclient-build\reTS-wasm\cl_dll\client_emscripten_wasm32.wasm)
    --out <dir>           the folder (default: <root>\webclient-bin)
    --fwgs <dir>          the engine source the build was made from (default: <root>\xash3d-fwgs)
    --patches <dir>       xash3d-h9-patches, for xash.bat's patch list (default: <root>\xash3d-h9-patches)
    --emsdk <dir>         the emsdk the builds used (default: <root>\emsdk)
    --rets <dir>          reTS's source (default: <root>\reTS)

<root> is the parent of the folder this script is in (TSM).
"""
import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# (path in waf's out folder, what it is); the folder keeps these paths
ENGINE_FILES = [
    ("engine/xash.js", "the engine's loader (Emscripten's JavaScript, MODULARIZE, Xash3D())"),
    ("engine/xash.wasm", "the engine (main module)"),
    ("filesystem/filesystem_stdio.wasm", "the engine's file system (side module)"),
    ("ref/gl/libref_webgl2.wasm", "the renderer, WebGL 2 through gl2_shim (side module)"),
    ("3rdparty/mainui/libmenu.wasm", "the main menu, mainui with H9's patches (side module)"),
    ("3rdparty/extras/extras.pk3", "FWGS's extras package (not a build: made by the engine build)"),
]
CLIENT_AT = "cl_dll/client_emscripten_wasm32.wasm"


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git(repo, *args):
    try:
        return subprocess.run(["git", "-C", repo] + list(args), capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def patch_chain(patches_dir):
    """xash.bat's patches in its order: (repository, patch file)."""
    bat = os.path.join(patches_dir, "xash.bat")
    root = os.path.dirname(patches_dir)
    names = {"%FWGS%": os.path.join(root, "xash3d-fwgs"), "%XASH%": patches_dir,
             "%WEB%": os.path.join(root, "webassembly-patch")}
    chain = []
    with open(bat, encoding="latin-1") as f:
        for line in f:
            m = re.match(r'\s*call :patch "([^"]+)" "([^"]+)"', line)
            if not m:
                continue
            repo, patch = m.group(1), m.group(2)
            for k, v in names.items():
                repo = repo.replace(k, v)
                patch = patch.replace(k, v)
            chain.append((repo.replace("\\", os.sep), patch.replace("\\", os.sep)))
    return chain


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    ap.add_argument("--engine-build", default=os.path.join(ROOT, "webclient-build", "xash3d-fwgs", "build-web"))
    ap.add_argument("--client", default=os.path.join(ROOT, "webclient-build", "reTS-wasm", "cl_dll", "client_emscripten_wasm32.wasm"))
    ap.add_argument("--out", default=os.path.join(ROOT, "webclient-bin"))
    ap.add_argument("--fwgs", default=os.path.join(ROOT, "xash3d-fwgs"))
    ap.add_argument("--patches", default=os.path.join(ROOT, "xash3d-h9-patches"))
    ap.add_argument("--emsdk", default=os.path.join(ROOT, "emsdk"))
    ap.add_argument("--rets", default=os.path.join(ROOT, "reTS"))
    a = ap.parse_args()

    sources = [(rel, os.path.join(a.engine_build, rel.replace("/", os.sep))) for rel, _ in ENGINE_FILES]
    sources.append((CLIENT_AT, a.client))
    missing = [src for _, src in sources if not os.path.isfile(src)]
    if missing:
        sys.exit("missing build output:\n  " + "\n  ".join(missing))

    for rel, src in sources:
        dst = os.path.join(a.out, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)

    version_file = os.path.join(a.emsdk, "upstream", "emscripten", "emscripten-version.txt")
    revision_file = os.path.join(a.emsdk, "upstream", ".emsdk_version")
    emsdk = open(version_file).read().strip().strip('"') if os.path.isfile(version_file) else "unknown"
    release = open(revision_file).read().strip() if os.path.isfile(revision_file) else "unknown"

    head = git(a.fwgs, "log", "-1", "--format=%h %s")
    branch = git(a.fwgs, "rev-parse", "--abbrev-ref", "HEAD")
    dirty = [l for l in git(a.fwgs, "status", "--short").splitlines() if l.strip()]
    subs = []
    for sub in ("3rdparty/freevgui", "3rdparty/mainui", "3rdparty/library_suffix"):
        sub_head = git(os.path.join(a.fwgs, sub.replace("/", os.sep)), "log", "-1", "--format=%h %s")
        sub_dirty = len([l for l in git(os.path.join(a.fwgs, sub.replace("/", os.sep)), "status", "--short").splitlines() if l.strip()])
        subs.append("    %-24s %s (working tree: %d changed)" % (sub, sub_head or "unknown", sub_dirty))
    chain = patch_chain(a.patches)
    cmake = os.path.join(a.rets, "cl_dll", "CMakeLists.txt")

    what = dict(ENGINE_FILES)
    what[CLIENT_AT] = "the game's client library, reTS's cl_dll with freevgui inside (side module)"
    lines = [
        "H9 web client builds -- what each file in this folder is, and what it was built from",
        "",
        "Written by tools/make_webclient_bin.py, " + time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()) + ".",
        "tools/make_webclient_game.py takes these files from this folder (havoc9.org/webclient/DEPLOY.txt,",
        "section 3). Only the builds are here: the game's files come from the repository's H9XASH.",
        "",
        "Toolchain",
        "    emsdk %s (%s)" % (emsdk, release),
        "",
        "Engine: xash3d-fwgs (https://github.com/FWGS/xash3d-fwgs, GPL-3.0), branch %s at %s," % (branch or "unknown", head or "unknown"),
        "with the working tree as xash3d-h9-patches\\xash.bat leaves it: %d paths changed or added" % len(dirty),
        "(the patches below, and the uncommitted menu-video work), and its submodules:",
    ] + subs + [
        "    python waf configure --emscripten -T release -o build-web",
        "    python waf build",
        "",
        "Patches applied, in xash.bat's order (SHA-1 of each patch file):",
    ]
    for repo, patch in chain:
        rel_repo = os.path.relpath(repo, a.fwgs).replace(os.sep, "/")
        rel_repo = "" if rel_repo == "." else " in " + rel_repo
        digest = sha1(patch) if os.path.isfile(patch) else "missing"
        lines.append("    %s  %s%s" % (digest[:12], os.path.basename(patch), rel_repo))
    lines += [
        "",
        "Client library: reTS (the reconstruction of TS 3.0's client and server, CMake), as in TSM\\reTS,",
        "its cl_dll/CMakeLists.txt with the block marked \"H9 web client\" (SHA-1 %s), which compiles"
        % (sha1(cmake)[:12] if os.path.isfile(cmake) else "missing"),
        "xash3d-fwgs/3rdparty/freevgui into the client (VGUI with H9's scheme, the browser font backend).",
        "    emcmake cmake -S reTS -B reTS-wasm -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=<dir>/ts",
        "    cmake --build reTS-wasm --target client",
        "",
        "Files (bytes, SHA-1):",
    ]
    for rel, _ in sources:
        dst = os.path.join(a.out, rel.replace("/", os.sep))
        lines.append("    %-38s %10d  %s" % (rel, os.path.getsize(dst), sha1(dst)))
        lines.append("        " + what[rel])
    with open(os.path.join(a.out, "BUILDINFO.txt"), "w", encoding="ascii", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print("written: %s (%d files and BUILDINFO.txt)" % (a.out, len(sources)))


if __name__ == "__main__":
    main()
