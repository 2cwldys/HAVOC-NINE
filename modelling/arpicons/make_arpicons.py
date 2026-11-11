#!/usr/bin/env python3
"""Builds the pictures of Apollo RP's inventory window: sprites/h9_arpicons.spr (one 32 x 32 frame for each item) and
sprites/h9_arpicons.txt (one line for each: the item's name, a bar, the frame number), which the client reads (reTS\\cl_dll\\h9_arpinv.cpp).

    python modelling/arpicons/make_arpicons.py [--install] [item list, a tab separated file whose second column is an item's name, to check against]

The weapons are rendered from their world models in TS's models folder by SMAK (bake_final.mjs and weapons_final.json put them in baked/);
every other item has no world model (Apollo RP drops each as the one backpack), so it is drawn: arpicons_art.py. Each picture gets a thin
light edge so that a dark thing shows on the dark tile.

The sprite is HL's format, SPR_ALPHTEST (palette index 255 is transparent), as the class icons are (tools/make-class-icons.py).
The files are written to modelling/arpicons/out/. --install copies them into sprites/, which the build ships with the game: do that with
the client.dll that draws 32 x 32 frames with SPR_DrawHoles (the build of 2026-11-10 after 18:25); an older client centres its frames as
if they were 64 x 64 and draws them additively, and would show these misplaced.
An item that is not in the sheet is drawn by the window as a monogram: add it to arpicons_art.LATER (listed after every other picture, so that no frame
number moves) and run this again.
"""
import json
import os
import struct
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import arpicons_art as art  # noqa: E402
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "out")
SPR = os.path.join(OUT, "h9_arpicons.spr")
TXT = os.path.join(OUT, "h9_arpicons.txt")
INSTALL = os.path.join(ROOT, "sprites")
ATLAS = os.path.join(HERE, "h9_arpicons_atlas.png")
SHEET = os.path.join(HERE, "preview.png")
SIZE = art.SIZE
RIM = (132, 112, 182)
BRIGHTEN = 1.22      # the weapons' renders are dark: a little lift, the hue kept


def lifted(img):
    return img.point(lambda v: min(255, int(v * BRIGHTEN)))


def weapon_frames():
    spec = json.load(open(os.path.join(HERE, "weapons_final.json")))
    for i, it in enumerate(spec):
        im = Image.open(os.path.join(HERE, "baked", "%02d.png" % i)).convert("RGBA")
        if im.size != (SIZE, SIZE):
            im = im.resize((SIZE, SIZE), Image.LANCZOS)
        alpha = im.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
        ground = Image.new("RGBA", im.size, art.BG + (255,))
        rgb = lifted(Image.alpha_composite(ground, im).convert("RGB"))
        yield it["name"], rgb, alpha


def h9_weapon_frames():
    """H9's own weapons (the PPSh-41, the laser rifle): rendered from their world models in H9XASH\\ts\\models\\h9 (weapons_h9.json, baked_h9/).
    Listed after every other picture, so that adding one moves no frame number. An alias is another spelling of the name with the same frame."""
    spec = json.load(open(os.path.join(HERE, "weapons_h9.json")))
    for i, it in enumerate(spec):
        im = Image.open(os.path.join(HERE, "baked_h9", "%02d.png" % i)).convert("RGBA")
        if im.size != (SIZE, SIZE):
            im = im.resize((SIZE, SIZE), Image.LANCZOS)
        alpha = im.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
        ground = Image.new("RGBA", im.size, art.BG + (255,))
        rgb = lifted(Image.alpha_composite(ground, im).convert("RGB"))
        yield it["name"], rgb, alpha, it.get("aliases", [])


def with_rim(rgb, alpha):
    grown = alpha.filter(ImageFilter.MaxFilter(3))
    edge = ImageChops.subtract(grown, alpha)
    out = rgb.copy()
    out.paste(Image.new("RGB", rgb.size, RIM), mask=edge)
    return out, grown


def main():
    frames = []   # (name, rgb, alpha)
    for name, rgb, alpha in weapon_frames():
        frames.append((name,) + with_rim(rgb, alpha))
    for name in art.ICONS:
        rgb, alpha = art.draw(name)
        frames.append((name,) + with_rim(rgb, alpha))
    aliases = []   # (spelling, frame)
    for name, rgb, alpha, others in h9_weapon_frames():
        aliases += [(o, len(frames)) for o in others]
        frames.append((name,) + with_rim(rgb, alpha))
    for name in art.LATER:
        rgb, alpha = art.draw(name)
        frames.append((name,) + with_rim(rgb, alpha))
    names = [f[0] for f in frames]
    assert len(set(names)) == len(names), "a name twice"
    assert len(frames) <= 256, "the client reads 256 names"

    # one palette of 255 colours for the sheet; index 255 is the transparent key
    mosaic = Image.new("RGB", (SIZE * len(frames), SIZE))
    for i, f in enumerate(frames):
        mosaic.paste(f[1], (i * SIZE, 0))
    pal_img = mosaic.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = bytearray(pal_img.getpalette()[:255 * 3])
    pal += bytes(255 * 3 - len(pal))
    pal += bytes((0, 0, 255))

    out = bytearray()
    out += b"IDSP"
    out += struct.pack("<i", 2)                   # version
    out += struct.pack("<i", 2)                   # type: VP_PARALLEL
    out += struct.pack("<i", 3)                   # texFormat: SPR_ALPHTEST
    out += struct.pack("<f", (SIZE * SIZE * 2) ** 0.5 / 2.0)
    out += struct.pack("<i", SIZE)
    out += struct.pack("<i", SIZE)
    out += struct.pack("<i", len(frames))
    out += struct.pack("<f", 0.0)                 # beam length
    out += struct.pack("<i", 0)                   # synch type
    out += struct.pack("<h", 256) + bytes(pal)
    for name, rgb, alpha in frames:
        idx = rgb.quantize(palette=pal_img, dither=Image.Dither.NONE)
        pix = bytearray(idx.tobytes())
        am = alpha.tobytes()
        for k in range(len(pix)):
            pix[k] = 255 if am[k] == 0 else min(pix[k], 254)
        out += struct.pack("<i", 0)               # a single frame
        out += struct.pack("<ii", -SIZE // 2, SIZE // 2)
        out += struct.pack("<ii", SIZE, SIZE)
        out += bytes(pix)
    os.makedirs(os.path.dirname(SPR), exist_ok=True)
    open(SPR, "wb").write(bytes(out))

    lines = ["# The pictures of Apollo RP's inventory window (sprites/h9_arpicons.spr): an item's name, a bar, its frame.",
             "# Made by modelling/arpicons/make_arpicons.py; an item that is not here is drawn as a monogram."]
    lines += ["%s|%d" % (n, i) for i, n in enumerate(names)]
    lines += ["%s|%d" % (a, f) for a, f in aliases]
    assert len(lines) - 2 <= 256, "the client reads 256 names"
    open(TXT, "wb").write(("\n".join(lines) + "\n").encode("ascii"))

    # the frames as one picture (the previews of the window use it), and a sheet to look at
    cols = 16
    rows = (len(frames) + cols - 1) // cols
    atlas = Image.new("RGBA", (cols * SIZE, rows * SIZE), (0, 0, 0, 0))
    for i, (name, rgb, alpha) in enumerate(frames):
        fr = rgb.convert("RGBA")
        fr.putalpha(alpha)
        atlas.paste(fr, ((i % cols) * SIZE, (i // cols) * SIZE))
    atlas.save(ATLAS)

    scale, cw, ch = 4, 40 * 4 + 4, 40 * 4 + 14
    ccols = 8
    crows = (len(frames) + ccols - 1) // ccols
    sheet = Image.new("RGB", (ccols * cw, crows * ch), (12, 9, 20))
    d = ImageDraw.Draw(sheet)
    for i, (name, rgb, alpha) in enumerate(frames):
        cx, cy = (i % ccols) * cw, (i // ccols) * ch
        tile = Image.new("RGBA", (SIZE, SIZE), art.BG + (255,))
        fr = rgb.convert("RGBA")
        fr.putalpha(alpha)
        tile.alpha_composite(fr)
        sheet.paste(tile.convert("RGB").resize((SIZE * scale, SIZE * scale), Image.NEAREST), (cx + 4, cy + 2))
        d.text((cx + 4, cy + SIZE * scale + 3), "%d %s" % (i, name[:24]), fill=(200, 190, 230))
    sheet.save(SHEET)

    print("%d pictures of %d x %d: %s (%d bytes), %s, %s" % (len(frames), SIZE, SIZE, SPR, len(out), TXT, SHEET))

    if "--install" in sys.argv:
        import shutil
        for src in (SPR, TXT):
            shutil.copy2(src, os.path.join(INSTALL, os.path.basename(src)))
        print("installed into", INSTALL)

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        have = set(names)
        missing = []
        for ln in open(args[0], encoding="utf-8").read().splitlines()[1:]:
            cols_ = ln.split("\t")
            if len(cols_) > 1 and cols_[1] not in have:
                missing.append(cols_[1])
        print("items without a picture: %d%s" % (len(missing), (": " + ", ".join(missing)) if missing else ""))


if __name__ == "__main__":
    main()
