"""Makes sprites/h9_cuffed.spr: the handcuff symbol that floats over the head of a handcuffed player (ARP_JailMod, arp_h9_cuffsprite).

    python make_cuffed_sprite.py [--install]

The picture is the Cuffs drawing of the icon sheet (arpicons_art.py) with the sheet's thin light rim. The sprite is a world sprite: type
SPR_FACING_UPRIGHT (it turns to the viewer around the vertical and stays upright), SPR_ALPHTEST (palette index 255 is transparent), one
frame. A sprite that follows a player (MOVETYPE_FOLLOW) is drawn at the player's origin, whatever offset the server gives it, so the height
is in the frame: the frame's origin puts its bottom edge BASE_UNITS over the entity's origin when the entity's scale is ENTITY_SCALE (the
plugin sets that scale). A standing player's head is 36 units over his origin.
With --install the file is copied into ..\\..\\sprites\\, which the build ships with the game."""
import os
import shutil
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import arpicons_art as art  # noqa: E402
import make_arpicons as mk  # noqa: E402
from PIL import Image  # noqa: E402

SIZE = 32
ENTITY_SCALE = 0.7   # ARP_JailMod sets this on the entity
BASE_UNITS = 46.0    # the bottom edge of the picture, over the entity's origin
OUT = os.path.join(HERE, "out", "h9_cuffed.spr")
SPRITES = os.path.normpath(os.path.join(HERE, "..", "..", "sprites"))

SPR_FACING_UPRIGHT = 1
SPR_ALPHTEST = 3


def build():
    rgb, alpha = art.draw("Cuffs")
    rgb, alpha = mk.with_rim(rgb, alpha)
    pal_img = rgb.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = bytearray(pal_img.getpalette()[:255 * 3])
    pal += bytes(255 * 3 - len(pal))
    pal += bytes((0, 0, 255))
    pix = bytearray(rgb.quantize(palette=pal_img, dither=Image.Dither.NONE).tobytes())
    am = alpha.tobytes()
    for k in range(len(pix)):
        pix[k] = 255 if am[k] == 0 else min(pix[k], 254)

    bottom = int(round(BASE_UNITS / ENTITY_SCALE))
    top = bottom + SIZE
    radius = float(((SIZE / 2) ** 2 + top ** 2) ** 0.5)

    out = bytearray()
    out += b"IDSP"
    out += struct.pack("<i", 2)                     # version
    out += struct.pack("<i", SPR_FACING_UPRIGHT)    # type
    out += struct.pack("<i", SPR_ALPHTEST)          # texFormat
    out += struct.pack("<f", radius)                # bounding radius: covers the lifted picture
    out += struct.pack("<i", SIZE)
    out += struct.pack("<i", SIZE)
    out += struct.pack("<i", 1)                     # one frame
    out += struct.pack("<f", 0.0)                   # beam length
    out += struct.pack("<i", 0)                     # synch type
    out += struct.pack("<h", 256) + bytes(pal)
    out += struct.pack("<i", 0)                     # a single frame
    out += struct.pack("<ii", -SIZE // 2, top)      # the frame's left edge and top edge, from the entity's origin
    out += struct.pack("<ii", SIZE, SIZE)
    out += bytes(pix)
    return bytes(out), bottom, top


def main():
    data, bottom, top = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "wb").write(data)
    print("%s: %d bytes, frame %d x %d, bottom edge %d px (%.1f units at scale %.2f), top edge %d px" % (
        OUT, len(data), SIZE, SIZE, bottom, bottom * ENTITY_SCALE, ENTITY_SCALE, top))
    if "--install" in sys.argv:
        os.makedirs(SPRITES, exist_ok=True)
        shutil.copyfile(OUT, os.path.join(SPRITES, "h9_cuffed.spr"))
        print("installed into", SPRITES)


if __name__ == "__main__":
    main()
