"""The laser rifle's textures for a game that has no PBR: one colour picture a material from its base colour,
metallic, roughness and normal maps.

 - Painted metal is WHITE (the file's base colour paints it tan where it was never painted: any tan becomes white),
   the underside, grip, magazine and fittings are BLACK, the optic's lens is BLUE (the file's is red).
 - A metal texel's base colour is its reflection, not its colour: a game that has no reflections gets it dark.
 - The normal map is baked into the colour as light and shade, so that the panel lines, the hexagon grip and the
   slots show in a flat-lit model.

usage: py -3 v2_textures.py <textures dir> <out dir>
"""
import sys
import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
SIZE = 1024
LIGHT = np.array([-0.35, 0.50, 0.79], np.float32)
LIGHT /= np.linalg.norm(LIGHT)

# what each material is painted: white paint, black, or neutral steel (kept lighter)
WHITE = {"RifleBodyTop", "Optic"}
BLACK = {"RifleBodyBottom", "Handle", "Handle.001", "Magazine", "Hinge", "Slide", "Ring", "OpticRest", "Trigger", "Barrel"}
STEEL = {"InnerRing"}
PLATE = {"SlideCover"}


def load(name, kind, mode):
    try:
        im = Image.open(f"{src}/{name}_{kind}.png").convert(mode)
    except FileNotFoundError:
        return None
    if im.size != (SIZE, SIZE):
        im = im.resize((SIZE, SIZE), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def shade_of(normal):
    """Light and shade from a tangent space normal map: 1.0 on a flat face."""
    if normal is None:
        return 1.0
    n = normal * 2.0 - 1.0
    n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-4)
    d = n @ LIGHT
    return np.clip(1.0 + 1.1 * (d - LIGHT[2]), 0.55, 1.35)[..., None]


def process(name):
    base = load(name, "BaseColor", "RGB")
    if base is None:
        base = np.asarray(Image.open(f"{src}/{name}.png").convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)).astype(np.float32) / 255.0
    metal = load(name, "Metallic", "L")
    rough = load(name, "Roughness", "L")
    normal = load(name, "Normal", "RGB")
    metal = metal if metal is not None else np.zeros(base.shape[:2], np.float32)
    rough = rough if rough is not None else np.full(base.shape[:2], 0.5, np.float32)
    r, g, b = base[..., 0], base[..., 1], base[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    shade = shade_of(normal)
    grime = np.clip((rough - 0.35) / 0.6, 0.0, 1.0)
    if name in WHITE:
        # tan (red and green over blue) is paint that was never laid: white. Light grey is white paint, the grime
        # kept; dark grey or a metal texel is a black fitting.
        tan = np.clip((np.minimum(r, g) - b - 0.03) / 0.06, 0.0, 1.0)
        white = smoothstep(0.44, 0.56, lum)
        white = np.maximum(white, tan)
        white = np.where(metal > 0.5, 0.0, white)
        paint_white = np.clip(lum * 1.10 + 0.06, 0.55, 0.97)
        paint = paint_white + (0.94 - paint_white) * tan
        dark = 0.045 + 0.30 * lum
        level = dark + (paint - dark) * white
        col = np.stack([level * 0.985, level * 0.995, level * 1.0], axis=2)
    elif name in PLATE:
        # the chevron plate: dark grey, the chevrons a lighter grey (the file has the plate light and the chevrons dark)
        level = 0.17 + 0.34 * (1.0 - lum) ** 1.5
        col = np.stack([level, level, level * 1.03], axis=2)
    elif name in STEEL:
        level = 0.10 + 0.40 * lum
        col = np.stack([level, level, level * 1.02], axis=2)
    else:
        level = 0.028 + 0.20 * lum ** 1.1
        level = level * (1.0 + 0.5 * (1.0 - grime) * metal) # clean metal catches a little light
        col = np.stack([level, level, level * 1.04], axis=2)
    col = np.clip(col * shade, 0.0, 1.0)
    return col


def lens():
    """The optic's lens: the file's is red; this is the same picture in blue (red and blue swapped, brightened)."""
    im = np.asarray(Image.open(f"{src}/OpticLensDiffuse.png").convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)).astype(np.float32) / 255.0
    red = im[..., 0]
    blue = np.clip(red * 3.2, 0.0, 1.0)
    col = np.stack([0.10 * blue, 0.42 * blue + 0.05, 0.55 + 0.45 * blue], axis=2)
    return np.clip(col, 0.0, 1.0)


def glass():
    """The optic's lens: a hexagon of glowing blue glass, brightest in the middle, a bright rim, a hex reticle and faint
    scan lines. The picture is the rectangle that holds the hexagon (the lens plate's corners are laid on it)."""
    S = 256
    ys, xs = np.mgrid[0:S, 0:S].astype(np.float32)
    u = (xs + 0.5) / S
    v = (ys + 0.5) / S
    # the hexagon's corners in this picture: pointed left and right at 0.405 down, flat top and bottom
    hexa = np.array([[0.0, 0.405], [0.107, 0.0], [0.893, 0.0], [1.0, 0.405], [0.84, 1.0], [0.16, 1.0]], np.float32)

    def inside_distance(px, py):
        best = np.full(px.shape, 9.0, np.float32)
        for i in range(6):
            a, b = hexa[i], hexa[(i + 1) % 6]
            e = b - a
            n = np.array([-e[1], e[0]], np.float32) / np.linalg.norm(e)
            d = (px - a[0]) * n[0] + (py - a[1]) * n[1]
            best = np.minimum(best, d)
        return best
    d = inside_distance(u, v)
    # which way is inside: positive for the hexagon's own side
    if inside_distance(np.array([0.5], np.float32), np.array([0.45], np.float32))[0] < 0:
        d = -d
    inner = np.clip(d / 0.34, 0.0, 1.0)
    glow = smoothstep(0.0, 1.0, inner)
    base = np.stack([0.03 + 0.20 * glow, 0.12 + 0.52 * glow, 0.45 + 0.55 * glow], axis=2)
    rim = np.exp(-(((d - 0.045) / 0.020) ** 2))[..., None]
    base = base + rim * np.array([0.10, 0.55, 0.55], np.float32)
    # a hex reticle in the middle and a faint cross
    cu, cv = u - 0.5, v - 0.43
    r = np.maximum(np.abs(cu) * 0.9 + np.abs(cv) * 0.55, np.abs(cv) * 1.1)
    ret = np.exp(-(((r - 0.17) / 0.010) ** 2))[..., None]
    cross = (np.exp(-((cu / 0.006) ** 2)) * (np.abs(cv) < 0.30) + np.exp(-((cv / 0.006) ** 2)) * (np.abs(cu) < 0.30))[..., None] * 0.45
    base = base + (ret + cross) * np.array([0.35, 0.60, 0.60], np.float32)
    scan = 0.93 + 0.07 * np.sin(ys * 2 * np.pi / 6.0)[..., None]
    base = base * scan
    base = np.where((d < 0.0)[..., None], np.array([0.01, 0.04, 0.18], np.float32), base)
    return np.clip(base, 0.0, 1.0)


import os
os.makedirs(out, exist_ok=True)
names = ["Trigger", "RifleBodyBottom", "RifleBodyTop", "Barrel", "Handle", "Hinge", "Slide", "Ring", "InnerRing",
         "Handle.001", "Magazine", "OpticRest", "Optic", "SlideCover"]
sheet = Image.new("RGB", (256 * 5, 256 * 3), (60, 64, 72))
for i, n in enumerate(names):
    col = process(n)
    im = Image.fromarray((col * 255 + 0.5).astype(np.uint8), "RGB")
    im.save(f"{out}/{n}.png")
    sheet.paste(im.resize((256, 256), Image.LANCZOS), ((i % 5) * 256, (i // 5) * 256))
Image.fromarray((lens() * 255 + 0.5).astype(np.uint8), "RGB").save(f"{out}/OpticLens.png")
sheet.paste(Image.open(f"{out}/OpticLens.png").resize((256, 256), Image.LANCZOS), (4 * 256, 2 * 256))
Image.fromarray((glass() * 255 + 0.5).astype(np.uint8), "RGB").save(f"{out}/OpticGlass.png")
sheet.save(f"{out}/_sheet.png")
print("textures written to", out)
