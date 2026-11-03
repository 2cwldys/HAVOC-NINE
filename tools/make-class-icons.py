"""
Builds sprites/tsm_class.spr -- one 64x64 frame per match class.

HL sprite format, written by hand because the icons do not exist in TS and there is
nothing in its 159 installed sprites to borrow a frame from.

  type       2  VP_PARALLEL   -- always faces the viewer, so an icon above a head
                                reads the same from any angle
  texFormat  3  SPR_ALPHTEST  -- palette index 255 is transparent, giving a crisp
                                edge rather than the additive wash a glow sprite has
"""
import struct, os

W = H = 64
SCALE = 8          # 5x7 glyph -> 40x56, centred in 64x64
OX, OY = (W - 5 * SCALE) // 2, (H - 7 * SCALE) // 2

# 5x7 glyphs. One per class, in class order.
GLYPHS = [
    ("A", ["01110","10001","10001","11111","10001","10001","10001"]),  # 1 Assault
    ("E", ["11111","10000","10000","11110","10000","10000","11111"]),  # 2 Combat Engineer
    ("M", ["10001","11011","10101","10101","10001","10001","10001"]),  # 3 Marksman
    ("H", ["10001","10001","10001","11111","10001","10001","10001"]),  # 4 Heavy
    ("B", ["11110","10001","10001","11110","10001","10001","11110"]),  # 5 Breacher
    ("+", ["00000","00100","00100","11111","00100","00100","00000"]),  # 6 Medic
    ("O", ["01110","10001","10001","10001","10001","10001","01110"]),  # 7 Officer
]

IDX_EDGE, IDX_FILL, IDX_CLEAR = 1, 2, 255

pal = bytearray(256 * 3)
pal[IDX_EDGE * 3: IDX_EDGE * 3 + 3] = bytes((0, 0, 0))          # outline
pal[IDX_FILL * 3: IDX_FILL * 3 + 3] = bytes((255, 255, 255))    # glyph
pal[IDX_CLEAR * 3: IDX_CLEAR * 3 + 3] = bytes((0, 0, 255))      # transparent key

def render(rows):
    px = bytearray([IDX_CLEAR] * (W * H))
    # fill
    for gy, row in enumerate(rows):
        for gx, c in enumerate(row):
            if c != "1":
                continue
            for y in range(OY + gy * SCALE, OY + (gy + 1) * SCALE):
                for x in range(OX + gx * SCALE, OX + (gx + 1) * SCALE):
                    px[y * W + x] = IDX_FILL
    # 2px outline, so the icon reads against a bright skybox as well as a dark wall
    for _ in range(2):
        edge = []
        for y in range(H):
            for x in range(W):
                if px[y * W + x] != IDX_CLEAR:
                    continue
                for dx, dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and px[ny * W + nx] == IDX_FILL:
                        edge.append(y * W + x)
                        break
        for i in edge:
            px[i] = IDX_EDGE
    return bytes(px)

out = bytearray()
out += b"IDSP"
out += struct.pack("<i", 2)              # version
out += struct.pack("<i", 2)              # type: VP_PARALLEL
out += struct.pack("<i", 3)              # texFormat: SPR_ALPHTEST
out += struct.pack("<f", (W * W + H * H) ** 0.5 / 2.0)   # boundingradius
out += struct.pack("<i", W)
out += struct.pack("<i", H)
out += struct.pack("<i", len(GLYPHS))    # numframes
out += struct.pack("<f", 0.0)            # beamlength
out += struct.pack("<i", 0)              # synctype
out += struct.pack("<h", 256) + bytes(pal)

for name, rows in GLYPHS:
    out += struct.pack("<i", 0)                      # SPR_SINGLE
    out += struct.pack("<ii", -W // 2, H // 2)       # origin
    out += struct.pack("<ii", W, H)
    out += render(rows)

dst = "D:/SteamLibrary/steamapps/common/Half-Life/ts/sprites/tsm_class.spr"
open(dst, "wb").write(bytes(out))
print("wrote %s  (%d bytes, %d frames)" % (dst, len(out), len(GLYPHS)))

# read it back through the same scanner logic as a sanity check
h = open(dst, "rb").read(36)
assert h[:4] == b"IDSP", "bad magic"
ver, typ, fmt = struct.unpack("<iii", h[4:16])
mw, mh, nf = struct.unpack("<iii", h[20:32])
print("verify: version=%d type=%d texFormat=%d %dx%d frames=%d" % (ver, typ, fmt, mw, mh, nf))
print("glyph order: " + ", ".join("%d=%s" % (i + 1, g[0]) for i, g in enumerate(GLYPHS)))
