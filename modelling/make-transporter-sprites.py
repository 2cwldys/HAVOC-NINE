"""The transporter pads' effect sprites, in each side's light (1 = MSR blue, 2 = Insurgent red):

  sprites/tsm_tpad_ring_<n>.spr    a flat ring that pulses inward and a turning arc, lying on the pad (oriented)
  sprites/tsm_tpad_col_<n>.spr     a column of light with streaks rising in it, turning to face the viewer about the upright
  (the direction arrow is a model: make-transporter-arrow.mjs)

    python modelling/make-transporter-sprites.py [output folder, default sprites]    (needs Pillow)

An IDSP version 2 sprite with an additive format and a palette that is the side's colour from black to full, so black is
clear. Placed in the game with the additive render mode and animated by an env_sprite.
"""
import math, os, struct, sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sprites")
os.makedirs(OUT, exist_ok=True)
SIDES = {1: (0, 170, 255), 2: (255, 60, 60)}
SS = 4  # supersampling


def write_spr(path, kind, frames, wide, tall, colour, origin_bottom=False):
    pal = b"".join(bytes((colour[0] * i // 255, colour[1] * i // 255, colour[2] * i // 255)) for i in range(256))
    radius = math.hypot(wide / 2, tall / 2)
    head = b"IDSP" + struct.pack("<iiif", 2, kind, 1, radius) + struct.pack("<iiifi", wide, tall, len(frames), 0.0, 0)
    body = struct.pack("<h", 256) + pal
    oy = tall if origin_bottom else tall // 2
    for im in frames:
        body += struct.pack("<iiiii", 0, -wide // 2, oy, wide, tall) + im.tobytes()
    open(path, "wb").write(head + body)


def canvas(w, h):
    return Image.new("L", (w * SS, h * SS), 0)


def finish(im, w, h):
    return im.resize((w, h), Image.LANCZOS)


def ring_frames(n=16, size=96):
    out = []
    for f in range(n):
        t = f / n
        im = canvas(size, size)
        d = ImageDraw.Draw(im)
        c = size * SS / 2
        # a ring shrinking inward, brighter as it arrives, and a faint standing outer ring
        r = (1.0 - t) * 44 * SS
        a = int(255 * (0.35 + 0.65 * t))
        d.ellipse([c - r, c - r, c + r, c + r], outline=a, width=3 * SS)
        r2 = 42 * SS
        d.ellipse([c - r2, c - r2, c + r2, c + r2], outline=110, width=2 * SS)
        # four arcs turning at the middle radius
        r3 = 30 * SS
        for k in range(4):
            a0 = 360 * t + k * 90
            d.arc([c - r3, c - r3, c + r3, c + r3], a0, a0 + 40, fill=255, width=3 * SS)
        out.append(finish(im, size, size))
    return out


def column_frames(n=16, w=32, h=48):
    out = []
    for f in range(n):
        t = f / n
        im = Image.new("L", (w, h), 0)
        px = im.load()
        for y in range(h):
            up = y / (h - 1)                # 0 at the top, 1 at the foot (the bottom row)
            fade = up ** 1.4               # fades to nothing at the top, no hard edge
            streak = 0.5 + 0.5 * math.sin(2 * math.pi * (up * 2.0 + t))
            for x in range(w):
                dx = abs(x - (w - 1) / 2) / (w / 2)
                side = max(0.0, 1.0 - dx) ** 1.4
                wob = 0.5 + 0.5 * math.sin(2 * math.pi * (x / 9.0 + t * 2 + up))
                v = side * fade * (0.35 + 0.45 * streak) * (0.8 + 0.2 * wob)
                px[x, y] = int(max(0, min(255, v * 255)))
        out.append(im)
    return out


def arrow_frames(n=12, size=64):
    out = []
    for f in range(n):
        t = f / n
        im = canvas(size, size)
        d = ImageDraw.Draw(im)
        cx = size * SS / 2
        # chevrons pointing toward the top of the picture, running up it
        for k in range(3):
            p = (k + t) / 3.0
            y = size * SS * (1.0 - p)
            life = math.sin(math.pi * p)
            a = int(255 * life)
            half = 16 * SS
            thick = 5 * SS
            d.line([(cx - half, y + half * 0.8), (cx, y), (cx + half, y + half * 0.8)], fill=a, width=thick, joint="curve")
        # a short stem under the chevrons
        d.line([(cx, size * SS * 0.95), (cx, size * SS * 0.7)], fill=120, width=3 * SS)
        out.append(finish(im, size, size))
    return out


for n, col in SIDES.items():
    write_spr(os.path.join(OUT, f"tsm_tpad_ring_{n}.spr"), 3, ring_frames(), 96, 96, col)
    write_spr(os.path.join(OUT, f"tsm_tpad_col_{n}.spr"), 0, column_frames(), 32, 48, col, origin_bottom=True)
    print("wrote side", n)

# a contact sheet to look at before the game does
sheet = Image.new("RGB", (16 * 96, 3 * 100), (20, 20, 24))
for row, frames in enumerate((ring_frames(), column_frames(), arrow_frames())):
    for i, im in enumerate(frames):
        rgb = Image.merge("RGB", [im.point(lambda v, k=k: v * SIDES[1][k] // 255) for k in range(3)])
        sheet.paste(rgb, (i * 96, row * 100))
os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"), exist_ok=True)
sheet.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "tpad_sprites_sheet.png"))
