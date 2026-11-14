"""Makes the picture of the Mech minigun's bullet trail: H9XASH/ts/sprites/h9_bullet_trail.spr (and a PNG of the same pixels).

The plugin (ts_matchmode.sma, turret_trail) flies a Mech's M60 bullet in slow motion and draws the trail behind it with the engine's follow
beam (TE_BEAMFOLLOW). The engine puts a ribbon of this sprite along the bullet's path: the sprite's x runs ACROSS the ribbon, its y runs along it
(the whole picture is stretched over each stretch of the trail), and the ribbon is drawn additively, its colour being the sprite's pixel times the
beam's r, g, b and brightness times a fade that runs from 1 at the bullet to 0 at the oldest point of the trail.

The picture has the shape of TS's own bullet trail (sprites/bullet_trail.spr: a soft bell across the ribbon, the same all along it, a neutral
grey), at the brightness a trail is meant to be seen at: TS's file peaks at 24 of 255 and a beam can only dim a sprite, never raise it, so a ribbon
of TS's file is a line nobody sees. Here the bell peaks at 255 (white) and falls to nothing at both sides, a raised cosine to the fourth power, so
there is no hard edge and the line is 0.37 of the ribbon across at half height. The colour is left to the beam: the plugin tints it a warm white.

  64 x 16, one frame, additive (black is clear), a neutral grey palette whose index is its brightness.

Run: python tools/make-mechminigun-trail.py [out_dir]     writes <out_dir>/sprites/h9_bullet_trail.spr and <out_dir>/h9_bullet_trail.png
Deterministic. Nothing but the standard library is used and no third-party material.
"""
import math
import os
import struct
import sys
import zlib

W = 64                  # across the ribbon
H = 16                  # along it (the picture does not change along its length)
POWER = 4               # cos(pi u / 2) to this power across the ribbon, u from -1 to 1


def column(x):
    """Brightness index (0 to 255) of the picture's column x."""
    u = (x + 0.5) / W * 2.0 - 1.0
    return int(round(255.0 * math.cos(math.pi * u / 2.0) ** POWER))


def pixels():
    row = bytes(column(x) for x in range(W))
    return row * H


def spr_bytes(px):
    """IDSP version 2, type 2 (parallel), format 1 (additive), one frame, a grey palette."""
    radius = math.hypot(W / 2.0, H / 2.0)
    data = b"IDSP" + struct.pack("<iiifiiifi", 2, 2, 1, radius, W, H, 1, 0.0, 1)
    data += struct.pack("<h", 256) + bytes(v for i in range(256) for v in (i, i, i))
    data += struct.pack("<iiiii", 0, -W // 2, H // 2, W, H) + px
    return data


def png_bytes(px):
    """An 8-bit grey PNG of the same pixels."""
    def chunk(kind, body):
        crc = zlib.crc32(kind + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)
    raw = b"".join(b"\x00" + px[y * W:(y + 1) * W] for y in range(H))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(os.path.join(out, "sprites"), exist_ok=True)
    px = pixels()
    spr = os.path.join(out, "sprites", "h9_bullet_trail.spr")
    with open(spr, "wb") as f:
        f.write(spr_bytes(px))
    with open(os.path.join(out, "h9_bullet_trail.png"), "wb") as f:
        f.write(png_bytes(px))
    print("%s: %dx%d, 1 frame, additive, peak %d" % (spr, W, H, max(px)))


if __name__ == "__main__":
    main()
