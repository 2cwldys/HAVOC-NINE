#!/usr/bin/env python3
"""Checks the item pictures of Apollo RP's inventory window against what the game and the plugins have.

    python check_arpicons.py [--strict] [--sprites <folder with h9_arpicons.spr and .txt>] [--scripting <folder with the ARP_*.sma>]

1. The sheet, sprites/h9_arpicons.spr, as the engine reads it (xash3d-fwgs engine/common/mod_sprite.c, Mod_SwapSprite, and cl_sprite.c, Mod_SpriteLoadTextures): IDSP, version 2, a
   palette of 256 colours with index 255 the transparent one, every frame a single frame of 32 x 32, and the file ending where its last frame does. The client reads the frame count
   from the header (offset 28) and so does the server's world icon (ARP_Core.sma, H9_ItemIconPrecache).
2. The list, sprites/h9_arpicons.txt, as the client reads it (reTS/cl_dll/h9_arpinv_icons.h, IconList::Parse): a name, a bar, a frame; no name of more than 32 characters, none twice
   with two frames, no frame the sheet does not have, no more than 256 names.
3. Every item name Apollo RP's plugins register on a roleplay server of The Specialists (ARP_Items, ARP_HungerMod, ARP_JailMod, ARP_TalkArea, ARP_TS: the literals of
   ARP_RegisterItem and the weapon table of ARP_TS) against the list. A name the list spells in another case is an ERROR (the client and the world icon would not find it by
   the client's exact comparison; the server's is not case-sensitive, the window's is). An item with no picture is only listed: its tile is a monogram, and no picture is made up for
   it. --strict makes that an error too.
The items of ARP_CS, ARP_TFC and ARP_BCompat are listed apart: those plugins are not loaded on a Specialists server.
Exit 0: nothing wrong (items without a picture are listed); 1: something is.
"""
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SIZE = 32


def arg(name, default):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


SPRITES = arg("--sprites", os.path.join(ROOT, "H9XASH", "ts", "sprites"))
SCRIPTING = arg("--scripting", os.path.join(ROOT, "apollo-rp", "base", "addons", "amxmodx", "scripting"))
STRICT = "--strict" in sys.argv

problems = []


def bad(text):
    problems.append(text)
    print("ERROR: " + text)


def check_sheet(path):
    b = open(path, "rb").read()
    print("sheet %s: %d bytes" % (path, len(b)))
    if len(b) < 42 or b[:4] != b"IDSP":
        bad("the sheet is not an IDSP sprite")
        return 0
    version, typ, fmt = struct.unpack("<iii", b[4:16])
    bw, bh, nframes = struct.unpack("<iii", b[20:32])
    print("  version %d, type %d (%s), texFormat %d (%s), bounds %d x %d, %d frame(s)" % (
        version, typ, {0: "VP_PARALLEL_UPRIGHT", 1: "FACING_UPRIGHT", 2: "VP_PARALLEL, faces the viewer", 3: "ORIENTED", 4: "VP_PARALLEL_ORIENTED"}.get(typ, "?"),
        fmt, {0: "normal", 1: "additive", 2: "index alpha", 3: "alpha test"}.get(fmt, "?"), bw, bh, nframes))
    if version != 2:
        bad("the sheet's version is %d, the loaders read 2" % version)
    if fmt != 3:
        bad("the sheet is not an alpha-test sprite: index 255 would not be transparent")
    if typ not in (0, 1, 2, 4):
        bad("the sheet's type %d is not one that faces the viewer, as the world icon needs" % typ)
    npal = struct.unpack("<h", b[40:42])[0]
    if npal != 256:
        bad("the palette has %d colours, the panels' reader wants 256" % npal)
        return 0
    key = tuple(b[42 + 255 * 3:42 + 255 * 3 + 3])
    print("  palette entry 255 (the transparent one) is %s" % (key,))
    off = 42 + npal * 3
    if nframes < 1 or nframes > 256:
        bad("%d frames: the list holds names for at most 256" % nframes)
    for f in range(nframes):
        if off + 20 > len(b):
            bad("frame %d is cut off by the end of the file" % f)
            return nframes
        t = struct.unpack("<i", b[off:off + 4])[0]
        ox, oy, w, h = struct.unpack("<iiii", b[off + 4:off + 20])
        if t != 0:
            bad("frame %d is not a single frame (type %d)" % (f, t))
        if (w, h) != (SIZE, SIZE):
            bad("frame %d is %d x %d, the window draws %d x %d" % (f, w, h, SIZE, SIZE))
        if off + 20 + w * h > len(b):
            bad("frame %d runs past the end of the file" % f)
            return nframes
        off += 20 + w * h
    if off != len(b):
        bad("the file is %d bytes and its %d frames end at %d" % (len(b), nframes, off))
    else:
        print("  the %d frames end where the file does: the engine's loader accepts it" % nframes)
    return nframes


def check_list(path, frames):
    names = {}
    order = []
    n = 0
    for raw in open(path, "rb").read().decode("latin-1").replace("\r", "\n").split("\n"):
        line = raw[:95]
        if "|" not in line or line[:1] in ("#", "/"):
            continue
        name, _, rest = line.partition("|")
        m = re.match(r"\s*(-?\d+)", rest)
        frame = int(m.group(1)) if m else 0
        n += 1
        if len(name) > 32:
            bad("name longer than 32 characters (the client cuts it): %r" % name)
        if frame < 0 or (frames and frame >= frames):
            bad("%r names frame %d, the sheet has %d" % (name, frame, frames))
        if name in names and names[name] != frame:
            bad("%r has two frames, %d and %d" % (name, names[name], frame))
        if name not in names:
            order.append(name)
        names[name] = frame
    if n > 256:
        bad("the list has %d names, the client reads 256" % n)
    print("list %s: %d names (%d distinct), %d frames named" % (path, n, len(names), len(set(names.values()))))
    return names


def unescape(s):
    return s.replace('^"', '"').replace("^^", "^")


def registered(path, with_table):
    text = open(path, "rb").read().decode("latin-1")
    found = []
    for m in re.finditer(r'ARP_RegisterItem\(\s*"((?:[^"^]|\^.)*)"', text):
        found.append(unescape(m.group(1)))
    if with_table:
        # the weapon table: new <Name>WeaponNames[...] = { {"name","kind"}, ... } up to the loop that registers it (an #if 0 block is another mod's)
        for tbl in re.finditer(r"new\s+(\w+)WeaponNames\[[^\]]*\]\[2\]\[\]\s*=\s*\{(.*?)\n\s*\}\s*\n", text, re.S):
            start = text.rfind("\n#if 0", 0, tbl.start())
            end = text.find("#endif", start) if start >= 0 else -1
            if start >= 0 and end > tbl.start():
                continue
            for e in re.finditer(r'\{\s*"((?:[^"^]|\^.)*)"\s*,', tbl.group(2)):
                nm = unescape(e.group(1))
                if nm:
                    found.append(nm)
    return found


def main():
    sheet = os.path.join(SPRITES, "h9_arpicons.spr")
    lst = os.path.join(SPRITES, "h9_arpicons.txt")
    if not os.path.exists(sheet) or not os.path.exists(lst):
        bad("sprites/h9_arpicons.spr or .txt not found in %s" % SPRITES)
        return 1
    frames = check_sheet(sheet)
    names = check_list(lst, frames)
    lower = {}
    for nm in names:
        lower.setdefault(nm.lower(), nm)

    groups = [("a Specialists server", ["ARP_Items.sma", "ARP_HungerMod.sma", "ARP_JailMod.sma", "ARP_TalkArea.sma", "ARP_TS.sma"], True),
              ("not loaded on a Specialists server", ["ARP_CS.sma", "ARP_TFC.sma", "ARP_BCompat.sma"], True)]
    nopic = []
    otherplugins = []
    seen = set()
    for label, files, table in groups:
        for fn in files:
            p = os.path.join(SCRIPTING, fn)
            if not os.path.exists(p):
                continue
            for nm in registered(p, table):
                if label.startswith("not"):
                    if nm not in names and nm not in otherplugins:
                        otherplugins.append(nm)
                    continue
                if nm in seen:
                    continue
                seen.add(nm)
                if nm in names:
                    continue
                if nm.lower() in lower:
                    bad("%s registers %r (%s) and the list spells it %r: the names are compared exactly" % (fn, nm, label, lower[nm.lower()]))
                else:
                    nopic.append((nm, fn))
    print("")
    print("items registered by the plugins of a Specialists server: %d; with a picture: %d; without: %d" % (len(seen), len(seen) - len(nopic), len(nopic)))
    for nm, fn in nopic:
        print("  no picture (a monogram): %s  [%s]" % (nm, fn))
    if otherplugins:
        print("items of plugins that are not loaded on a Specialists server, with no picture: %s" % ", ".join(otherplugins))
    extra = [nm for nm in names if nm not in seen]
    if extra:
        print("names in the list that no Specialists plugin registers (spellings of H9's weapons, or items of other mods): %s" % ", ".join(extra))
    if STRICT and nopic:
        bad("--strict: %d item(s) have no picture" % len(nopic))
    print("")
    print("%d problem(s)" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
