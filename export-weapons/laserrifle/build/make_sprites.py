"""The laser rifle's sprites, drawn here and written as GoldSrc .spr files (additive: black is clear).

  sprites/laserrifle_muzzle.spr   the muzzle flash: a green energy flash, four frames (a frame is picked at random for
                                  each shot and the sprite turned a random way)
  sprites/laserrifle_trail.spr    the plasma bolt's trail: a ribbon, bright down its middle, green
  sprites/laserrifle_bolt.spr     the head of a bolt: a round glow
  sprites/laserrifle_hit.spr      where a bolt lands: a flare of green light
  sprites/weapons/laserrifle.spr  the weapon's picture for the weapon select bar and the buy menu (grey: the hud
                                  paints it in its own colour, as it does every weapon's)

usage: py -3 make_sprites.py <out dir> <icon source png (the gun on black, bright)>
"""
import math
import struct
import sys
import os
import numpy as np
from PIL import Image, ImageFilter

out = sys.argv[1]
icon_src = sys.argv[2] if len(sys.argv) > 2 else None
os.makedirs(f"{out}/sprites/weapons", exist_ok=True)

# the plasma's colour ramp: black, deep green, green, mint, white (index = brightness)
RAMP = [(0.0, (0, 0, 0)), (0.22, (0, 56, 24)), (0.5, (18, 200, 88)), (0.78, (110, 255, 185)), (1.0, (236, 255, 246))]


def ramp_palette():
    pal = np.zeros((256, 3), np.uint8)
    for i in range(256):
        t = i / 255.0
        for (t0, c0), (t1, c1) in zip(RAMP, RAMP[1:]):
            if t0 <= t <= t1:
                k = (t - t0) / (t1 - t0)
                pal[i] = [round(c0[a] + (c1[a] - c0[a]) * k) for a in range(3)]
                break
    return pal.tobytes()


def grey_palette():
    return bytes(v for i in range(256) for v in (i, i, i))


def write_spr(path, frames, palette, sprite_type=2, fmt=1, sync=1):
    """IDSP version 2. type 2 = parallel (faces the view), fmt 1 = additive. frames: list of uint8 arrays (h, w)."""
    h, w = frames[0].shape
    radius = math.hypot(w / 2.0, h / 2.0)
    data = b"IDSP" + struct.pack("<iiifiiifi", 2, sprite_type, fmt, radius, w, h, len(frames), 0.0, sync)
    data += struct.pack("<h", 256) + palette
    for f in frames:
        data += struct.pack("<iiiii", 0, -w // 2, h // 2, w, h) + f.astype(np.uint8).tobytes()
    open(path, "wb").write(data)
    print(f"{path}: {w}x{h}, {len(frames)} frame(s), {len(data)} bytes")


def grid(n):
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (xs + 0.5) / n * 2 - 1
    y = (ys + 0.5) / n * 2 - 1
    return x, y


def to_index(v):
    return np.clip(v * 255.0 + 0.5, 0, 255).astype(np.uint8)


def rays(x, y, angles, width, length, falloff):
    r = np.hypot(x, y)
    th = np.arctan2(y, x)
    total = np.zeros_like(x)
    for a, wdt, ln in zip(angles, width, length):
        d = np.abs(((th - a + math.pi) % (2 * math.pi)) - math.pi)
        # thinner the further out: a needle
        w = wdt * (0.35 + 0.65 * np.exp(-r / ln))
        total += np.exp(-((d / np.maximum(w, 1e-3)) ** 2)) * np.exp(-((r / ln) ** 2) * 0.9) * (r > 0.04)
    return total


rng = np.random.default_rng(1105)
pal = ramp_palette()

# ---- the muzzle flash: four frames of a green flash
N = 64
x, y = grid(N)
r = np.hypot(x, y)
frames = []
for i in range(4):
    k = 1.0 - i * 0.08
    core = np.exp(-((r / (0.17 * k)) ** 2))
    halo = np.exp(-((r / (0.55 * k)) ** 2)) * 0.42
    count = 5 + (i % 3)
    ang = rng.uniform(0, 2 * math.pi) + np.arange(count) * (2 * math.pi / count) + rng.normal(0, 0.18, count)
    ray = rays(x, y, ang, rng.uniform(0.05, 0.09, count), rng.uniform(0.55, 0.95, count) * k, None)
    v = core * 1.1 + halo + ray * 0.8
    # a hot white-green middle
    v = np.clip(v, 0, 1)
    frames.append(to_index(v))
write_spr(f"{out}/sprites/laserrifle_muzzle.spr", frames, pal)

# ---- the trail: across the ribbon a bright core and a soft glow, the same all along it
W, H = 32, 16
u = (np.arange(W, dtype=np.float32) + 0.5) / W * 2 - 1
prof = np.exp(-((u / 0.55) ** 2)) * 0.55 + np.exp(-((u / 0.17) ** 2)) * 0.75
prof = np.clip(prof, 0, 1)
tile = np.tile(prof[None, :], (H, 1))
write_spr(f"{out}/sprites/laserrifle_trail.spr", [to_index(tile)], pal)

# ---- the head of a bolt
N = 32
x, y = grid(N)
r = np.hypot(x, y)
head = np.exp(-((r / 0.26) ** 2)) * 1.1 + np.exp(-((r / 0.7) ** 2)) * 0.5
head += (np.exp(-((x / 0.05) ** 2)) * np.exp(-((r / 0.9) ** 2)) + np.exp(-((y / 0.05) ** 2)) * np.exp(-((r / 0.9) ** 2))) * 0.35
write_spr(f"{out}/sprites/laserrifle_bolt.spr", [to_index(np.clip(head, 0, 1))], pal)

# ---- where a bolt lands: a flare with eight rays and a thin ring
N = 64
x, y = grid(N)
r = np.hypot(x, y)
ang = np.arange(8) * (math.pi / 4) + 0.2
ray = rays(x, y, ang, [0.07] * 8, [0.8, 0.5] * 4, None)
ring = np.exp(-(((r - 0.56) / 0.05) ** 2)) * 0.55
hit = np.exp(-((r / 0.2) ** 2)) * 1.1 + np.exp(-((r / 0.6) ** 2)) * 0.35 + ray * 0.75 + ring
write_spr(f"{out}/sprites/laserrifle_hit.spr", [to_index(np.clip(hit, 0, 1))], pal)

# ---- the weapon's picture, 128 x 48, as TS's own: bright on black, fitted with a margin
if icon_src:
    src = Image.open(icon_src).convert("RGB")
    a = np.asarray(src).astype(np.float32)
    lum = a @ np.array([0.30, 0.59, 0.11], np.float32)
    mask = lum > 3
    ys, xs = np.where(mask)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    crop = Image.fromarray(a[y0:y1, x0:x1].astype(np.uint8), "RGB")
    Wd, Hd, M = 128, 48, 4
    scale = min((Wd - 2 * M) / crop.width, (Hd - 2 * M) / crop.height)
    nw, nh = max(1, round(crop.width * scale)), max(1, round(crop.height * scale))
    small = crop.resize((nw, nh), Image.LANCZOS)
    g = np.asarray(small).astype(np.float32) @ np.array([0.30, 0.59, 0.11], np.float32)
    # the gun is white above and black below: the black half is lifted so that the whole gun reads
    cover = np.asarray(small.convert("L")).astype(np.float32)
    g = np.where(g < 14, 0.0, g)
    hi = np.percentile(g[g > 6], 99) if (g > 6).any() else 255.0
    g = np.clip(g / max(hi, 1.0), 0, 1) ** 0.8 * 250.0
    canvas = np.zeros((Hd, Wd), np.float32)
    ox, oy = (Wd - nw) // 2, (Hd - nh) // 2
    canvas[oy:oy + nh, ox:ox + nw] = g
    o = np.clip(canvas + 0.5, 0, 255).astype(np.uint8)
    o = np.asarray(Image.fromarray(o, "L").filter(ImageFilter.UnsharpMask(radius=1.2, percent=140, threshold=2)))
    write_spr(f"{out}/sprites/weapons/laserrifle.spr", [o], grey_palette())
    Image.fromarray(o, "L").resize((Wd * 4, Hd * 4), Image.NEAREST).save(f"{out}/laserrifle_icon_x4.png")

# previews
def preview(name, frames, palette):
    pal3 = np.frombuffer(palette, np.uint8).reshape(256, 3)
    tiles = [pal3[f] for f in frames]
    h = max(t.shape[0] for t in tiles)
    sheet = np.zeros((h, sum(t.shape[1] for t in tiles) + 4 * len(tiles), 3), np.uint8)
    x0 = 0
    for t in tiles:
        sheet[:t.shape[0], x0:x0 + t.shape[1]] = t
        x0 += t.shape[1] + 4
    Image.fromarray(sheet).resize((sheet.shape[1] * 3, sheet.shape[0] * 3), Image.NEAREST).save(f"{out}/{name}_preview.png")


preview("muzzle", frames, pal)
