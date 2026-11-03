r"""H9's server browser icon for a server that takes havoc9.org accounts only (an H9 original, no game
art): gfx/shell/h9_account.tga, 16 x 16, RGB on black, the size and form of the browser's own lock
and favorite icons (mainui draws them additively, so black is see-through).

  A person, head and shoulders, in H9's purple (the console and menu purple, 190 140 255), with a
  light edge, as the lock's grey stands for a password. mainui shows it in the server browser's
  account column (mainui-h9-browser.patch) for a server whose info says "auth" 1
  (h9_require_account 1, engine-h9-serverinfo.patch).

usage: python tools\make_account_icon.py [out_dir ...]   (default: the overlay's ts\gfx\shell)
"""
import os
import sys

from PIL import Image, ImageDraw

SIDE = 16
BIG = 256  # drawn at 16x, then scaled down
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = [os.path.join(ROOT, "xash3d-h9-patches", "overlay", "ts", "gfx", "shell")]
PURPLE = (190, 140, 255)
LIGHT = (235, 220, 255)


def draw():
    img = Image.new("RGB", (BIG, BIG), (0, 0, 0))
    d = ImageDraw.Draw(img)
    s = BIG / 16.0
    # the light edge first, a little larger, then the purple body over it
    for grow, color in ((0.9, LIGHT), (0.0, PURPLE)):
        g = grow * s
        # head
        d.ellipse((5.0 * s - g, 1.5 * s - g, 11.0 * s + g, 7.5 * s + g), fill=color)
        # shoulders: a rounded block cut off at the bottom edge
        d.rounded_rectangle((2.0 * s - g, 8.5 * s - g, 14.0 * s + g, 17.0 * s + g), radius=5.0 * s + g, fill=color)
    # the gap between head and shoulders, so the two read apart
    d.rectangle((0, 7.5 * s + 0.2 * s, BIG, 8.0 * s + 0.3 * s), fill=(0, 0, 0))
    # nothing past the bottom row
    return img.resize((SIDE, SIDE), Image.LANCZOS)


def main(argv):
    outs = argv[1:] or DEFAULT_OUT
    img = draw()
    for out in outs:
        os.makedirs(out, exist_ok=True)
        path = os.path.join(out, "h9_account.tga")
        img.save(path, format="TGA")
        print("wrote", path)


if __name__ == "__main__":
    main(sys.argv)
