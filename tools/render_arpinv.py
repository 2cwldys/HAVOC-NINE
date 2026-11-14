#!/usr/bin/env python3
"""Turns the drawing operations written by reTS/cl_dll/tests/render_arpinv.cpp into pictures (a PNG for each JSON file) and a contact sheet.

    python tools/render_arpinv.py <folder with the .json files> [<output folder>]

The text is drawn in a monospace font, eight pixels a character, as the preview's canvas measures it: the game's own HUD font is a little
different, so this shows the layout, the colours and what fits, not the glyphs.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont


def font():
    for p in (r"C:\Windows\Fonts\consolab.ttf", r"C:\Windows\Fonts\consola.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, 13)
    return ImageFont.load_default()


def render(path, out):
    d = json.load(open(path))
    w, h = d["w"], d["h"]
    img = Image.new("RGBA", (w, h), (20, 22, 30, 255))
    # a faint game picture behind the windows, so the transparency shows
    bg = ImageDraw.Draw(img)
    for y in range(0, h, 4):
        bg.line([(0, y), (w, y)], fill=(26 + (y * 7) % 14, 28 + (y * 5) % 12, 38 + (y * 3) % 10, 255))
    f = font()
    atlas = None
    for op in d["ops"]:
        if op[0] == "i":
            if atlas is None:
                atlas = Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "modelling", "arpicons", "h9_arpicons_atlas.png")).convert("RGBA")
            _, frame, x, y = op
            fr = atlas.crop(((frame % 16) * 32, (frame // 16) * 32, (frame % 16) * 32 + 32, (frame // 16) * 32 + 32))
            img.alpha_composite(fr, (x, y)) if x >= 0 and y >= 0 else None
        elif op[0] == "f":
            _, x, y, fw, fh, r, g, b, a = op
            if fw <= 0 or fh <= 0 or a == 0:
                continue
            x0, y0, x1, y1 = max(0, x), max(0, y), min(w, x + fw), min(h, y + fh)
            if x1 <= x0 or y1 <= y0:
                continue
            region = img.crop((x0, y0, x1, y1))
            layer = Image.new("RGBA", (x1 - x0, y1 - y0), (r, g, b, a))
            img.paste(Image.alpha_composite(region, layer), (x0, y0))
        else:
            _, x, y, text, r, g, b = op
            dr = ImageDraw.Draw(img)
            for i, ch in enumerate(text):
                dr.text((x + i * 8, y - 1), ch, font=f, fill=(r, g, b, 255))
    img.convert("RGB").save(out)
    return img.convert("RGB")


def main():
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else src
    os.makedirs(dst, exist_ok=True)
    names = sorted(n for n in os.listdir(src) if n.endswith(".json"))
    for n in names:
        render(os.path.join(src, n), os.path.join(dst, n[:-5] + ".png"))
        print("wrote", n[:-5] + ".png")


if __name__ == "__main__":
    main()
