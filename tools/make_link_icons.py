r"""H9's scoreboard link icons (H9 originals, no game art): 64 x 64 32-bit TGA with alpha.

  h9_link.tga     a green connected chain, drawn here: a proven havoc9.org account on this server
  h9_unlink.tga   a red broken chain, drawn here: anyone else (no account, a game that did not
                  prove the id, Steam)
  h9_bot.tga      H9's helmet (the site's logo, havoc9.org\h9helmet.png) in grey: a bot, which
                  never gets a chain

client.dll's scoreboard (reTS cl_dll\vgui_ScorePanel.cpp) lays one over a corner of each row's avatar
cell, scaled to the row and semi-transparent; the main menu's account button can load the same files
(mainui reads TGA). They live in ts\gfx\vgui\ of every client: H9XASH (xash3d-h9-patches\overlay)
and the GoldSrc package (reTS\binaries\ts). docs\H9_PRESENCE.txt section 4b.

usage: python tools\make_link_icons.py [out_dir ...]   (default: the overlay, H9XASH and reTS's)
"""
import math
import os
import sys

from PIL import Image, ImageDraw

SIDE = 64
BIG = 512  # drawn at 8x, then scaled down
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = [
    os.path.join(ROOT, "xash3d-h9-patches", "overlay", "ts", "gfx", "vgui"),
    os.path.join(ROOT, "H9XASH", "ts", "gfx", "vgui"),
    os.path.join(ROOT, "reTS", "binaries", "ts", "gfx", "vgui"),
]


def capsule(size, length, thick, stroke, angle, center, color, outline):
    """A chain link: a capsule's outline (a stroke around a slot), rotated, as an RGBA layer."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = size / 2, size / 2
    box = (cx - length / 2, cy - thick / 2, cx + length / 2, cy + thick / 2)
    r = thick / 2
    # the dark edge first, a little wider, then the colour
    d.rounded_rectangle(box, radius=r, outline=outline, width=int(stroke + size * 0.035))
    inset = size * 0.0175
    d.rounded_rectangle((box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset), radius=r - inset, outline=color, width=int(stroke))
    layer = layer.rotate(angle, resample=Image.BICUBIC, center=(cx, cy))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.alpha_composite(layer, (int(center[0] - cx), int(center[1] - cy)))
    return out


def open_link(size, length, thick, stroke, angle, center, color, outline, gap_side):
    """A broken link: a capsule with a gap cut through one end."""
    link = capsule(size, length, thick, stroke, 0, (size / 2, size / 2), color, outline)
    cut = Image.new("L", (size, size), 255)
    dc = ImageDraw.Draw(cut)
    cx = size / 2
    w = size * 0.11
    # everything past the cut goes: the link is a U, open toward the other half
    if gap_side > 0:
        dc.rectangle((cx + length / 2 - thick * 0.45 - w / 2, 0, size, size), fill=0)
    else:
        dc.rectangle((0, 0, cx - length / 2 + thick * 0.45 + w / 2, size), fill=0)
    a = link.getchannel("A")
    link.putalpha(Image.composite(a, Image.new("L", (size, size), 0), cut))
    link = link.rotate(angle, resample=Image.BICUBIC, center=(size / 2, size / 2))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.alpha_composite(link, (int(center[0] - size / 2), int(center[1] - size / 2)))
    return out


def chain_linked():
    s = BIG
    green, edge = (54, 209, 107, 255), (10, 52, 26, 255)
    length, thick, stroke = s * 0.56, s * 0.30, s * 0.085
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    a = capsule(s, length, thick, stroke, 45, (s * 0.37, s * 0.63), green, edge)
    b = capsule(s, length, thick, stroke, 45, (s * 0.63, s * 0.37), green, edge)
    img.alpha_composite(a)
    img.alpha_composite(b)
    # the weave: a's upper end over b again, so they read as linked, not stacked
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse((s * 0.43, s * 0.43, s * 0.57, s * 0.57), fill=255)
    over = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    over.paste(a, (0, 0), mask)
    img.alpha_composite(over)
    return img


def chain_broken():
    s = BIG
    red, edge = (255, 69, 69, 255), (74, 12, 12, 255)
    length, thick, stroke = s * 0.50, s * 0.30, s * 0.085
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.alpha_composite(open_link(s, length, thick, stroke, 45, (s * 0.31, s * 0.69), red, edge, +1))
    img.alpha_composite(open_link(s, length, thick, stroke, 45, (s * 0.69, s * 0.31), red, edge, -1))
    # the break: two short sparks across the gap
    d = ImageDraw.Draw(img)
    for (x0, y0, x1, y1) in ((0.44, 0.40, 0.36, 0.32), (0.56, 0.60, 0.64, 0.68)):
        d.line((s * x0, s * y0, s * x1, s * y1), fill=edge, width=int(s * 0.075))
        d.line((s * x0, s * y0, s * x1, s * y1), fill=red, width=int(s * 0.045))
    return img


HELMET = os.path.join(ROOT, "havoc9.org", "h9helmet.png")


def helmet_grey():
    """H9's helmet in greys: its orange light, its black dark, the shape and the alpha kept."""
    src = Image.open(HELMET).convert("RGBA")
    # square, then to the drawing size (it is pixel art: the box filter keeps its blocks even)
    side = max(src.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.alpha_composite(src, ((side - src.width) // 2, (side - src.height) // 2))
    big = sq.resize((BIG, BIG), Image.BOX)
    out = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    px, po = big.load(), out.load()
    for y in range(BIG):
        for x in range(BIG):
            r, g, b, a = px[x, y]
            if not a:
                continue
            lum = (r * 299 + g * 587 + b * 114) // 1000
            v = min(255, 70 + lum * 130 // 255 + (40 if lum > 60 else 0))
            po[x, y] = (v, v, min(255, v + 6), a)
    return out


def robot_head():
    s = BIG
    body, edge, eye = (188, 200, 218, 255), (24, 30, 44, 255), (63, 208, 255, 255)
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # antenna
    d.line((s * 0.5, s * 0.30, s * 0.5, s * 0.13), fill=edge, width=int(s * 0.075))
    d.line((s * 0.5, s * 0.30, s * 0.5, s * 0.13), fill=body, width=int(s * 0.04))
    d.ellipse((s * 0.41, s * 0.05, s * 0.59, s * 0.23), fill=eye, outline=edge, width=int(s * 0.03))
    # ears
    for x in (0.08, 0.84):
        d.rounded_rectangle((s * x, s * 0.46, s * (x + 0.08), s * 0.70), radius=s * 0.03, fill=body, outline=edge, width=int(s * 0.03))
    # head
    d.rounded_rectangle((s * 0.15, s * 0.28, s * 0.85, s * 0.90), radius=s * 0.12, fill=body, outline=edge, width=int(s * 0.04))
    # eyes
    for x in (0.27, 0.57):
        d.rounded_rectangle((s * x, s * 0.43, s * (x + 0.16), s * 0.59), radius=s * 0.04, fill=eye, outline=edge, width=int(s * 0.025))
    # mouth grille
    d.rounded_rectangle((s * 0.30, s * 0.70, s * 0.70, s * 0.80), radius=s * 0.03, fill=edge)
    for x in (0.40, 0.50, 0.60):
        d.line((s * x, s * 0.71, s * x, s * 0.79), fill=body, width=int(s * 0.02))
    return img


def save_tga(img, path):
    small = img.resize((SIDE, SIDE), Image.LANCZOS)
    # straight alpha, nothing left where it is fully clear
    px = small.load()
    for y in range(SIDE):
        for x in range(SIDE):
            r, g, b, a = px[x, y]
            if a == 0:
                px[x, y] = (0, 0, 0, 0)
    small.save(path, format="TGA", compression=None)


def main():
    outs = sys.argv[1:] or DEFAULT_OUT
    icons = {"h9_link.tga": chain_linked(), "h9_unlink.tga": chain_broken(), "h9_bot.tga": helmet_grey()}
    for out in outs:
        os.makedirs(out, exist_ok=True)
        for name, img in icons.items():
            save_tga(img, os.path.join(out, name))
            print("wrote", os.path.join(out, name))


if __name__ == "__main__":
    main()
