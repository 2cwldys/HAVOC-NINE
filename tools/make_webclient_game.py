"""
make_webclient_game.py - the files the H9 web client's engine reads, laid out for a web server.

The browser build of the engine sees one folder as its disk. This script lays that folder out
from H9XASH and the browser builds, and lists it for the page (havoc9.org\\webclient\\client.js):

    <out>\\game\\           the engine's disk: ts\\ and valve\\ from H9XASH, the engine's side
                            modules, the browser build of the client library, a gameinfo.txt for
                            the browser and the stock TS 3.0 config.cfg
    <out>\\engine\\         xash.js and xash.wasm, when an engine build is given
    <out>\\manifest.json    every file under game\\: path, size, and the start of its SHA-1; and the
                            fonts the page registers for VGUI text, from the game's fonts.txt
    <out>\\preload.json     the files the page fetches before the engine starts

Only what a player's client reads is taken from H9XASH\\ts. Left out: the server side (addons\\,
which holds ts_advertise.cfg and its Discord bot token, dlls\\, mapconfigs\\, the server's
configs), the Windows and Linux client libraries, and the files that belong to one player
(config.cfg, video.cfg, the *_resolved.cfg files h9xash.bat writes, ids, logs, the spray).
Nothing is written if a file that must never be served would be copied.

H9XASH\\valve is H9's own (valve\\REPLACEMENTS.md). Files in H9XASH that are byte for byte
Half-Life's own are left out by the list beside this script, webclient_leave_out.txt (SHA-1 and path
of each): a listed file stays out while it still has that SHA-1, and goes in once H9 replaces it.
No Half-Life install is needed. --hl-valve compares with Half-Life's own folder instead, and
--write-leave-out rewrites the list from that comparison.

The main menu's video (ts\\menu_bg_videos.txt names files in ts\\media) is decoded in the browser by
the page, which reads Motion-JPEG AVIs (each frame a whole JPEG). A listed video in another codec is
re-encoded to a Motion-JPEG AVI for the package with ffmpeg (--ffmpeg, or ffmpeg on PATH); without
ffmpeg the run says the browser will not show it. H9XASH's own copy is never changed.

VGUI text in the browser is drawn through a canvas with the fonts the page has registered
(freevgui's platform\\emscripten\\font.cpp), not through Windows. The manifest's "fonts" list does
there what freevgui-h9-fonts.patch does on Windows: each "font <asked> = <face> [size] [weight]"
line of ts\\resource\\fonts\\fonts.txt (valve's when the game has none) registers the font files
of <face>, found by the family name in each file, under the name the game asks for; with weight,
the file nearest that weight serves every weight, as Windows picks the nearest; without, each file
serves the weights nearer to it than to the next. A size other than 100 is not applied in the
browser (the canvas fits each glyph to the height VGUI asks for); the run says so.

Usage, on Windows or Linux, from TSM or from a clone of the repository:
    py -3 tools\\make_webclient_game.py [options]        (python3 tools/make_webclient_game.py)

    With no options everything is found from the folder this script is in, whose parent is <root>:

    --h9xash <dir>         the game (default: <root>\\H9XASH)
    --out <dir>            where the package goes (default: <root>\\webclient-build\\stage)
    --stock-config <cfg>   the config.cfg a new player starts with (default: TS 3.0's own, which
                           <root>\\reTS\\game\\ts\\config.cfg is, else <root>\\ts3.0\\ts\\config.cfg)
    --engine-build <dir>   an emscripten build of xash3d-fwgs, waf's out folder or the same layout
                           (default: <root>\\webclient-bin, the tracked builds, when it is there)
    --client <wasm>        client_emscripten_wasm32.wasm, reTS's client built for the browser
                           (default: <root>\\webclient-bin\\cl_dll\\, when it is there)
    --hl-valve <dir>       Half-Life's valve folder, read instead of webclient_leave_out.txt
    --write-leave-out      with --hl-valve: rewrite webclient_leave_out.txt from what it finds
    --ffmpeg <exe>         re-encodes a menu video that is not Motion-JPEG (default: ffmpeg on PATH)
    --dry-run              check and list, write nothing
    --replace              remove what an earlier run wrote into <out> first
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# Half-Life's own files in H9XASH, by SHA-1 (see the help text)
LEAVE_OUT = os.path.join(HERE, "webclient_leave_out.txt")

# the mod folder inside the client folder; WEB_GAMEDIR names another for a project other than H9
GAMEDIR = os.environ.get("WEB_GAMEDIR") or "ts"

# Never served, whatever the rules below say: the run stops before writing if one is selected.
NEVER_NAMES = {"ts_advertise.cfg", "user_id.ini", "userid_resolved.cfg", "bot.pid", "mail.env",
               "accounts.json", ".xash_id", "networking.ini"}
NEVER_EXT = (".key", ".env", ".pem")

# Under ts\ and valve\: folders that are the server's, a player's own (saves, the engine's font
# cache of the PC's Windows fonts), or replaced by the browser build.
TS_SKIP_DIRS = {"addons", "dlls", "cl_dlls", "mapconfigs", "logs", "save", "screenshots",
                "ts_downloads", "vault", ".fontcache", "userconfig.d", "downloads"}
SKIP_NAMES = {"config.cfg", "video.cfg", "opengl.cfg", "vfs.cfg", "server.cfg", "listenserver.cfg",
              "game.cfg", "liblist.gam", "gameinfo.txt", "console_history.txt", "custom.hpk",
              "voice_ban.dt", "tsstats.dat", "vault.ini", "xashcomm.lst", "mapcycle.txt", "motd.txt",
              "bots.txt", "bot_say.txt", "steam_appid.txt", "tempdecal.wad", ".xash_id",
              "history_servers.lst", "favorite_servers.lst"}
SKIP_EXT = (".exe", ".dll", ".so", ".dylib", ".pdb", ".bat", ".cmd", ".ps1", ".py", ".log", ".fgd",
            ".zip", ".tmp", ".new", ".md")

# What an emscripten build of xash3d-fwgs makes (in waf's out folder), and where each goes.
ENGINE_FILES = [
    ("engine/xash.js", "engine/xash.js"),
    ("engine/xash.wasm", "engine/xash.wasm"),
    ("filesystem/filesystem_stdio.wasm", "game/filesystem_stdio.wasm"),
    ("ref/gl/libref_webgl2.wasm", "game/libref_webgl2.wasm"),
    ("3rdparty/mainui/libmenu.wasm", "game/" + GAMEDIR + "/cl_dlls/menu_emscripten_wasm32.wasm"),
    ("3rdparty/extras/extras.pk3", "game/valve/extras.pk3"),
]
CLIENT_AT = "game/" + GAMEDIR + "/cl_dlls/client_emscripten_wasm32.wasm"


def skip_reason(rel):
    """Why a file under the game root stays out, or None when it goes in."""
    parts = rel.split("/")
    name = parts[-1].lower()
    if parts[0] in (GAMEDIR, "valve") and len(parts) > 2 and parts[1].lower() in TS_SKIP_DIRS:
        return "server side, client binaries or a player's own folder (" + parts[1] + ")"
    if name in SKIP_NAMES:
        return "server setting or a player's own file"
    if name.endswith("_resolved.cfg"):
        return "written by h9xash.bat for one player"
    if ".bak" in name:
        return "backup"
    if name.endswith(SKIP_EXT):
        return "program, script, log, archive or document"
    return None


LFS_POINTER = b"version https://git-lfs.github.com/spec/v1"


def not_whole(path):
    """Why a file is not whole, or None: a Git LFS pointer (a clone made without Git LFS has one in
    place of each map, model and archive), or a .bsp, .mdl, .wad, .pk3 or .zip shorter than its own
    header says, as a download cut short leaves it. tools\\check-lfs.ps1 checks the same."""
    size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()
    with open(path, "rb") as f:
        head = f.read(124)
        if size < 1024 and head.startswith(LFS_POINTER):
            return "a Git LFS pointer, not the file"
        if ext == ".bsp":
            if size < 124:
                return "a .bsp of %d bytes" % size
            if struct.unpack("<i", head[:4])[0] != 30 and head[:4] not in (b"BSP2", b"2PSB"):
                return "not a GoldSrc or BSP2 map"
            lumps = struct.unpack("<30i", head[4:124])
            need = max(lumps[i * 2] + lumps[i * 2 + 1] for i in range(15))
        elif ext == ".mdl":
            if size < 76 or head[:4] not in (b"IDST", b"IDSQ"):
                return "not a studio model"
            need = struct.unpack("<i", head[72:76])[0]
        elif ext == ".wad":
            if size < 12 or head[:4] not in (b"WAD2", b"WAD3"):
                return "not a WAD"
            count, offset = struct.unpack("<ii", head[4:12])
            need = offset + count * 32
        elif ext in (".pk3", ".zip"):
            tail = min(size, 65557)
            f.seek(size - tail)
            return None if f.read(tail).rfind(b"PK\x05\x06") >= 0 else "no end-of-archive record: cut short"
        else:
            return None
    return "its header says %d bytes, the file has %d" % (need, size) if need > size else None


def never(rel):
    name = rel.split("/")[-1].lower()
    return name in NEVER_NAMES or name.endswith(NEVER_EXT)


def walk(root, top):
    """(path from the game root with forward slashes, full path) of every file under root\\top."""
    for d, dirs, names in os.walk(os.path.join(root, top)):
        dirs.sort()
        here = os.path.relpath(d, root).replace(os.sep, "/")
        for n in sorted(names):
            yield here + "/" + n, os.path.join(d, n)


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def valve_sizes(hl):
    """Half-Life's files by size, to find a byte-identical copy without hashing everything."""
    by_size = {}
    for d, _, names in os.walk(hl):
        for n in names:
            p = os.path.join(d, n)
            by_size.setdefault(os.path.getsize(p), []).append(p)
    return by_size


def web_gameinfo(native):
    """H9XASH's ts\\gameinfo.txt for the browser: no server library is loaded, VGUI is the client's."""
    kept = []
    with open(native, encoding="latin-1") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("//"):
                continue
            if s.split()[0].lower() in ("gamedll", "gamedll_linux", "gamedll_osx", "internal_vgui_support"):
                continue
            kept.append(s)
    head = ["// HAVOC 9 in a browser: The Specialists 3.0 with the H9TE client, on Xash3D FWGS built for",
            "// WebAssembly. Made by tools\\make_webclient_game.py from H9XASH\\ts\\gameinfo.txt. The page",
            "// joins servers and starts none, so the server library named here is never loaded; the",
            "// client library carries VGUI inside it (internal_vgui_support)."]
    tail = ['gamedll\t\t"dlls/mp.dll"', "internal_vgui_support\t1"]
    return ("\r\n".join(head + kept + tail) + "\r\n").encode("ascii", "replace")


def font_names(path):
    """(family, weight, italic) of a TrueType/OpenType file as Windows knows it: name 1 of the name
    table (Windows platform, US English), usWeightClass and fsSelection's italic bit of OS/2. None
    when the file cannot be read as one."""
    try:
        with open(path, "rb") as f:
            d = f.read()
        tables = {}
        for i in range(struct.unpack(">H", d[4:6])[0]):
            tag, _, off, _ = struct.unpack(">4sIII", d[12 + 16 * i:28 + 16 * i])
            tables[tag] = off
        off = tables[b"name"]
        _, count, strings = struct.unpack(">HHH", d[off:off + 6])
        family = None
        for i in range(count):
            pid, eid, lang, nid, length, at = struct.unpack(">6H", d[off + 6 + 12 * i:off + 18 + 12 * i])
            if pid == 3 and eid in (0, 1) and lang == 0x409 and nid == 1:
                family = d[off + strings + at:off + strings + at + length].decode("utf-16-be")
        os2 = tables[b"OS/2"]
        weight = struct.unpack(">H", d[os2 + 4:os2 + 6])[0]
        italic = bool(struct.unpack(">H", d[os2 + 62:os2 + 64])[0] & 1)
        return (family, weight, italic) if family else None
    except (OSError, KeyError, struct.error, UnicodeDecodeError):
        return None


def face_maps(text):
    """fonts.txt's "font <asked> = <face> [size <percent>] [weight <n>]" lines, read the way
    freevgui-h9-fonts.patch reads them: [(asked, face, size, weight)]; the first line for a name wins."""
    maps, seen = [], set()
    for line in text.splitlines():
        line = line.split("//", 1)[0].strip()
        if line[:5].lower() != "font " or "=" not in line:
            continue
        asked, rest = line[5:].split("=", 1)
        asked = asked.strip()
        face, size, weight = [], 100, 0
        words = rest.split()
        i = 0
        while i < len(words):
            w = words[i]
            if w.lower() in ("size", "weight"):
                value = words[i + 1] if i + 1 < len(words) else None
                i += 2
                digits = "".join(c for c in (value or "").split(".")[0] if c.isdigit())
                if value is not None and w.lower() == "size":
                    size = int(digits or 0)
                elif value is not None:
                    weight = int(digits or 0)
                continue
            face.append(w)
            i += 1
        face = " ".join(face)
        if asked and face and size > 0 and asked.lower() not in seen:
            seen.add(asked.lower())
            maps.append((asked, face, size, weight))
    return maps


def web_fonts(files):
    """The page's font list from fonts.txt and the font files in the package: [{family, file, weight,
    style}], file as the manifest names it, weight a CSS range. Also the lines it could not follow."""
    faces = []
    texts = {}
    for at, src in files:
        rel = at[len("game/"):]
        p = rel.lower().split("/")
        if len(p) != 4 or p[0] not in (GAMEDIR, "valve") or p[1:3] != ["resource", "fonts"]:
            continue
        if p[3] == "fonts.txt":
            with open(src, encoding="latin-1") as f:
                texts[p[0]] = f.read()
        elif p[3].endswith((".ttf", ".otf")):
            names = font_names(src)
            if names:
                faces.append((names[0].lower(), names[1], names[2], rel))
    text = texts.get(GAMEDIR, texts.get("valve", ""))
    fonts, notes = [], []
    for asked, face, size, weight in face_maps(text):
        if size != 100:
            notes.append("font %s = %s: size %d is not applied in the browser" % (asked, face, size))
        found = False
        for italic in (False, True):
            by_weight = {}
            for fam, w, it, rel in faces:
                if fam == face.lower() and it == italic:
                    by_weight.setdefault(w, rel)
            cands = sorted(by_weight.items())
            if not cands:
                continue
            found = True
            style = "italic" if italic else "normal"
            if weight:
                w, rel = min(cands, key=lambda c: (abs(c[0] - weight), c[0]))
                fonts.append({"family": asked, "file": rel, "weight": "1 1000", "style": style})
                continue
            for i, (w, rel) in enumerate(cands):
                lo = 1 if i == 0 else (cands[i - 1][0] + w) // 2 + 1
                hi = 1000 if i == len(cands) - 1 else (w + cands[i + 1][0]) // 2
                fonts.append({"family": asked, "file": rel, "weight": "%d %d" % (lo, hi), "style": style})
        if not found:
            notes.append("font %s = %s: no font file in resource\\fonts has that family" % (asked, face))
    return fonts, notes


def read_leave_out(path):
    """{path under the game root, lower case: SHA-1} from webclient_leave_out.txt."""
    listed = {}
    with open(path, encoding="ascii") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            digest, rel = s.split(None, 1)
            listed[rel.strip().lower()] = digest.lower()
    return listed


def write_leave_out(path, hits):
    """webclient_leave_out.txt from an --hl-valve comparison: hits are (path under the game root,
    SHA-1)."""
    lines = ["# Files in H9XASH that are byte for byte Half-Life's own, left out of the web client's package",
             "# by tools/make_webclient_game.py: <SHA-1> <path under the game root>. A listed file goes into",
             "# the package again once H9 replaces it, as its SHA-1 then differs. Written by",
             "# make_webclient_game.py --hl-valve <Half-Life's valve folder> --write-leave-out."]
    for rel, digest in sorted(hits, key=lambda h: h[0].lower()):
        lines.append("%s %s" % (digest, rel))
    with open(path, "w", encoding="ascii", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def avi_frames(path):
    """(width, height, frames, frames that are whole JPEG pictures) of an AVI, read the way the page
    reads it (client.js, pageVideo), or None when the file is not an AVI."""
    with open(path, "rb") as f:
        d = f.read()
    if len(d) < 12 or d[:4] != b"RIFF" or d[8:12] != b"AVI ":
        return None
    info = {"w": 0, "h": 0, "frames": 0, "jpeg": 0}

    def walk(start, end):
        o = start
        while o + 8 <= end:
            cid = d[o:o + 4]
            size = struct.unpack("<I", d[o + 4:o + 8])[0]
            body = o + 8
            if body + size > end:
                break
            if cid == b"LIST":
                walk(body + 4, body + size)
            elif cid == b"avih" and size >= 40:
                info["w"], info["h"] = struct.unpack("<II", d[body + 32:body + 40])
            elif re.match(rb"\d\dd[cb]$", cid) and size > 4:
                info["frames"] += 1
                if d[body:body + 2] == b"\xff\xd8":
                    info["jpeg"] += 1
            o = body + size + (size & 1)

    walk(12, len(d))
    return info["w"], info["h"], info["frames"], info["jpeg"]


def menu_videos(h9):
    """The names in <game>\\menu_bg_videos.txt, as h9xash.bat reads them."""
    p = os.path.join(h9, GAMEDIR, "menu_bg_videos.txt")
    if not os.path.isfile(p):
        return []
    with open(p, encoding="latin-1") as f:
        return [s.strip() for s in f if s.strip() and not s.strip().startswith("#")]


def preloaded(rel):
    """Fetched before the engine starts: what every start reads, kept small."""
    p = rel.lower().split("/")
    if len(p) == 1 or p[0] == "valve":
        return True
    if p[0] != GAMEDIR:
        return False
    if len(p) == 2:
        return p[1].endswith((".wad", ".txt", ".scr", ".lst", ".fnt", ".cfg", ".tga"))
    if p[1] in ("cl_dlls", "resource", "events"):
        return True
    return (p[1] == "gfx" and p[2] == "shell") or (p[1] == "sprites" and len(p) == 3 and p[2].endswith(".txt"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    ap.add_argument("--h9xash")
    ap.add_argument("--out")
    ap.add_argument("--stock-config")
    ap.add_argument("--engine-build")
    ap.add_argument("--client")
    ap.add_argument("--hl-valve")
    ap.add_argument("--write-leave-out", action="store_true")
    ap.add_argument("--ffmpeg")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--replace", action="store_true")
    a = ap.parse_args()

    h9 = os.path.abspath(a.h9xash or os.path.join(ROOT, "H9XASH"))
    out = os.path.abspath(a.out or os.path.join(ROOT, "webclient-build", "stage"))
    tracked = os.path.join(ROOT, "webclient-bin")
    if os.path.isdir(tracked):
        a.engine_build = a.engine_build or tracked
        a.client = a.client or os.path.join(tracked, "cl_dll", "client_emscripten_wasm32.wasm")
    if a.write_leave_out and not a.hl_valve:
        sys.exit("--write-leave-out needs --hl-valve")
    if not a.hl_valve and not os.path.isfile(LEAVE_OUT):
        sys.exit("no %s and no --hl-valve: Half-Life's own files could not be told apart" % LEAVE_OUT)
    if not os.path.isfile(os.path.join(h9, GAMEDIR, "gameinfo.txt")) or not os.path.isdir(os.path.join(h9, "valve")):
        sys.exit("no %s\\gameinfo.txt or valve\\ in %s" % (GAMEDIR, h9))
    try:
        inside = os.path.commonpath([h9, out]) == h9
    except ValueError:  # on another drive
        inside = False
    if inside:
        sys.exit("--out must not be inside H9XASH")
    stock = a.stock_config
    if not stock:
        candidates = [os.path.join(os.path.dirname(h9), "reTS", "game", GAMEDIR, "config.cfg"),
                      os.path.join(os.path.dirname(h9), "ts3.0", GAMEDIR, "config.cfg")]
        stock = next((c for c in candidates if os.path.isfile(c)), candidates[0])
    if not os.path.isfile(stock):
        sys.exit("no starting config.cfg at %s (give one with --stock-config)" % stock)

    # (path under <out>, source file or bytes)
    files = []
    skipped = {}
    for top in (GAMEDIR, "valve"):
        for rel, full in walk(h9, top):
            why = skip_reason(rel)
            if why:
                skipped.setdefault(why, []).append(rel)
            else:
                files.append(("game/" + rel, full))

    made = {"game/%s/gameinfo.txt" % GAMEDIR: web_gameinfo(os.path.join(h9, GAMEDIR, "gameinfo.txt"))}
    files.append(("game/%s/config.cfg" % GAMEDIR, stock))

    missing = []
    if a.engine_build:
        built = {at: os.path.join(a.engine_build, src.replace("/", os.sep)) for src, at in ENGINE_FILES}
        missing += [p for p in built.values() if not os.path.isfile(p)]
        files = [f for f in files if f[0] not in built]
        files += sorted(built.items())
    if a.client:
        if not os.path.isfile(a.client):
            missing.append(a.client)
        files.append((CLIENT_AT, a.client))
    if missing:
        sys.exit("missing build output:\n  " + "\n  ".join(missing))

    bad = [at for at, _ in files if never(at)]
    if bad:
        sys.exit("refusing: these must never be served:\n  " + "\n  ".join(bad))

    broken = [(at, why) for at, why in ((at, not_whole(src)) for at, src in files) if why]
    if broken:
        lfs = any(why.startswith("a Git LFS pointer") for _, why in broken)
        sys.exit("refusing: %d files are not whole:\n  %s%s\n%s" % (
            len(broken), "\n  ".join("%s -- %s" % b for b in broken[:25]),
            "\n  ... and %d more" % (len(broken) - 25) if len(broken) > 25 else "",
            "This clone was made without Git LFS. Install Git LFS, then in the checkout run\n"
            "  git lfs install\n  git lfs pull\nand run this again." if lfs else
            "Get these files again (git lfs pull, or git checkout -- <file>) and run this again."))

    # Byte-identical copies of Half-Life's own files stay out.
    valve_hits = []
    if a.hl_valve:
        by_size = valve_sizes(a.hl_valve)
        known = {}
        kept = []
        for at, src in files:
            size = os.path.getsize(src)
            hit = None
            if size and size in by_size:
                mine = sha1(src)
                for theirs in by_size[size]:
                    if theirs not in known:
                        known[theirs] = sha1(theirs)
                    if known[theirs] == mine:
                        hit = theirs
                        break
            if hit:
                valve_hits.append((at, hit, mine))
            else:
                kept.append((at, src))
        files = kept
        if a.write_leave_out:
            write_leave_out(LEAVE_OUT, [(at[len("game/"):], digest) for at, _, digest in valve_hits])
    else:
        listed = read_leave_out(LEAVE_OUT)
        kept = []
        for at, src in files:
            rel = at[len("game/"):].lower()
            if rel in listed and sha1(src) == listed[rel]:
                valve_hits.append((at, "listed in " + os.path.basename(LEAVE_OUT), listed[rel]))
            else:
                kept.append((at, src))
        files = kept

    # The main menu's videos: the page shows Motion-JPEG AVIs; another codec is re-encoded for the package.
    video_notes = []
    for name in menu_videos(h9):
        rel = "%s/media/%s" % (GAMEDIR, name)
        idx = next((i for i, (at, _) in enumerate(files) if at[len("game/"):].lower() == rel.lower()), None)
        if idx is None:
            video_notes.append("%s is in menu_bg_videos.txt but not in the package" % rel)
            continue
        at, src = files[idx]
        info = avi_frames(src)
        if info and info[2] and info[3] == info[2]:
            video_notes.append("%s: Motion-JPEG, %dx%d, %d frames, shown as it is" % (rel, info[0], info[1], info[2]))
            continue
        ffmpeg = a.ffmpeg or shutil.which("ffmpeg")
        if not ffmpeg:
            video_notes.append("%s: not Motion-JPEG, so the browser will not show it: give --ffmpeg, or "
                               "make it an MJPEG AVI" % rel)
            continue
        if a.dry_run:
            video_notes.append("%s: not Motion-JPEG, would be re-encoded with %s" % (rel, ffmpeg))
            continue
        dst = os.path.join(os.path.dirname(out), "transcoded", rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", src, "-an", "-c:v", "mjpeg", "-q:v", "3",
                        "-pix_fmt", "yuvj420p", dst], check=True)
        files[idx] = (at, dst)
        video_notes.append("%s: re-encoded to Motion-JPEG for the browser (%s)" % (rel, dst))

    entries = []
    for at, src in files:
        if not at.startswith("game/"):
            continue
        size = os.path.getsize(src)
        entries.append({"path": at[len("game/"):], "size": size, "hash": None if a.dry_run else sha1(src)[:12]})
    for at, data in made.items():
        entries.append({"path": at[len("game/"):], "size": len(data), "hash": hashlib.sha1(data).hexdigest()[:12]})
    entries.sort(key=lambda e: e["path"].lower())
    preload = [e["path"] for e in entries if preloaded(e["path"])]
    fonts, font_notes = web_fonts(files)

    total = sum(e["size"] for e in entries)
    by_top = {}
    for e in entries:
        top = e["path"].split("/")[0] if "/" in e["path"] else "(root)"
        n, s = by_top.get(top, (0, 0))
        by_top[top] = (n + 1, s + e["size"])
    print("game files: %d, %.1f MB" % (len(entries), total / 1e6))
    for top, (n, s) in sorted(by_top.items()):
        print("  %-8s %6d files %9.1f MB" % (top, n, s / 1e6))
    print("preload: %d files, %.1f MB" % (len(preload), sum(e["size"] for e in entries if preloaded(e["path"])) / 1e6))
    print("left out:")
    for why, rels in sorted(skipped.items()):
        print("  %5d  %s, e.g. %s" % (len(rels), why, ", ".join(rels[:3])))
    print("fonts for VGUI text, from fonts.txt: %d" % len(fonts))
    for x in fonts:
        print("  %-10s %-7s %-9s %s" % (x["family"], x["style"], x["weight"], x["file"]))
    for n in font_notes:
        print("  [note] " + n)
    print("byte-identical to Half-Life's own files, left out: %d (%s)" % (
        len(valve_hits), "compared with " + a.hl_valve if a.hl_valve else os.path.basename(LEAVE_OUT)))
    for at, theirs, _ in valve_hits:
        print("  %s  (= %s)" % (at, theirs))
    if a.write_leave_out:
        print("written: %s" % LEAVE_OUT)
    print("the main menu's video:")
    for n in video_notes or ["no menu_bg_videos.txt"]:
        print("  " + n)
    if not a.engine_build:
        print("no --engine-build: engine\\ and the engine's side modules are not in this package")
    if not a.client:
        print("no --client: %s is not in this package" % CLIENT_AT)
    if a.dry_run:
        print("dry run: nothing written")
        return

    targets = [os.path.join(out, "game"), os.path.join(out, "engine"),
               os.path.join(out, "manifest.json"), os.path.join(out, "preload.json")]
    there = [t for t in targets if os.path.exists(t)]
    if there and not a.replace:
        sys.exit("already in %s (run again with --replace):\n  %s" % (out, "\n  ".join(there)))
    for t in there:
        shutil.rmtree(t) if os.path.isdir(t) else os.remove(t)

    for at, src in files:
        dst = os.path.join(out, at.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
    for at, data in made.items():
        dst = os.path.join(out, at.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(data)

    manifest = {"version": 1, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "gamedir": GAMEDIR, "fonts": fonts, "files": entries}
    with open(os.path.join(out, "manifest.json"), "w", encoding="ascii") as f:
        json.dump(manifest, f, separators=(",", ":"))
    with open(os.path.join(out, "preload.json"), "w", encoding="ascii") as f:
        json.dump(preload, f, separators=(",", ":"))
    print("written: %s" % out)


if __name__ == "__main__":
    main()
