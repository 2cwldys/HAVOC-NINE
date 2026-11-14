"""The pictures of Apollo RP's inventory that have no world model to be rendered from: drawn here, flat colours with a dark edge, on a
32 x 32 grid and eight times over (a 512 pixel canvas), then reduced. make_arpicons.py puts them, and the weapons rendered from their world
models (bake_final.mjs), into the sprite sheet.

A picture is a function of a Pen. Coordinates are the grid's: 0 to 32 across and down. A shape is drawn on a colour canvas and on a mask, so
the picture's edge is clean and its colour never runs into black.
"""
from PIL import Image, ImageDraw, ImageFont
import math

SIZE = 32
S = 16                      # the canvas is SIZE * S square
BG = (24, 18, 36)           # the colour of the window's tiles: edges are blended into it

OL = (22, 14, 36)           # the edge of a shape
WHITE = (240, 236, 246)
CREAM = (246, 232, 196)
SILV = (206, 210, 224)
GRAY = (160, 160, 178)
DGRAY = (96, 96, 116)
BLACK = (52, 48, 66)
RED = (214, 62, 62)
DRED = (150, 36, 46)
ORANGE = (238, 146, 52)
YEL = (246, 210, 74)
GOLD = (216, 172, 54)
GRN = (76, 178, 98)
DGRN = (44, 114, 68)
BLU = (80, 130, 218)
DBLU = (46, 78, 152)
LBLU = (160, 204, 242)
PUR = (152, 106, 214)
BRN = (158, 100, 58)
DBRN = (106, 64, 40)
TAN = (226, 182, 122)
PINK = (242, 154, 174)
AMBER = (204, 128, 42)
OLIVE = (112, 128, 84)

_FONT = None


def font(px):
    global _FONT
    try:
        return ImageFont.truetype(r"C:\Windows\Fonts\consolab.ttf", px)
    except Exception:
        try:
            return ImageFont.truetype("DejaVuSansMono-Bold.ttf", px)
        except Exception:
            return ImageFont.load_default()


class Pen:
    def __init__(self):
        n = SIZE * S
        self.rgb = Image.new("RGB", (n, n), BG)
        self.mask = Image.new("L", (n, n), 0)
        self.d = ImageDraw.Draw(self.rgb)
        self.m = ImageDraw.Draw(self.mask)

    def _w(self, w):
        return max(1, int(round(w * S)))

    def _pts(self, pts):
        return [(x * S, y * S) for x, y in pts]

    def poly(self, pts, fill, ol=OL, w=0.7):
        p = self._pts(pts)
        self.d.polygon(p, fill=fill)
        self.m.polygon(p, fill=255)
        if ol:
            self.d.line(p + [p[0]], fill=ol, width=self._w(w), joint="curve")
            self.m.line(p + [p[0]], fill=255, width=self._w(w), joint="curve")

    def rect(self, x0, y0, x1, y1, fill, r=0.0, ol=OL, w=0.7):
        box = [x0 * S, y0 * S, x1 * S, y1 * S]
        kw = dict(fill=fill)
        if ol:
            kw.update(outline=ol, width=self._w(w))
        if r > 0:
            self.d.rounded_rectangle(box, radius=r * S, **kw)
            self.m.rounded_rectangle(box, radius=r * S, fill=255, outline=255 if ol else None, width=self._w(w))
        else:
            self.d.rectangle(box, **kw)
            self.m.rectangle(box, fill=255, outline=255 if ol else None, width=self._w(w))

    def ell(self, x0, y0, x1, y1, fill, ol=OL, w=0.7):
        box = [x0 * S, y0 * S, x1 * S, y1 * S]
        kw = dict(fill=fill)
        if ol:
            kw.update(outline=ol, width=self._w(w))
        self.d.ellipse(box, **kw)
        self.m.ellipse(box, fill=255, outline=255 if ol else None, width=self._w(w))

    def ring(self, x0, y0, x1, y1, col, w):
        """An ellipse's line only."""
        box = [x0 * S, y0 * S, x1 * S, y1 * S]
        self.d.ellipse(box, outline=col, width=self._w(w))
        self.m.ellipse(box, outline=255, width=self._w(w))

    def hole(self, x0, y0, x1, y1):
        """An ellipse cut out of the picture (the tile shows through)."""
        box = [x0 * S, y0 * S, x1 * S, y1 * S]
        self.d.ellipse(box, fill=BG)
        self.m.ellipse(box, fill=0)

    def pie(self, x0, y0, x1, y1, a0, a1, fill, ol=OL, w=0.7):
        box = [x0 * S, y0 * S, x1 * S, y1 * S]
        self.d.pieslice(box, a0, a1, fill=fill, outline=ol, width=self._w(w))
        self.m.pieslice(box, a0, a1, fill=255, outline=255, width=self._w(w))

    def line(self, x0, y0, x1, y1, w, col):
        p = [(x0 * S, y0 * S), (x1 * S, y1 * S)]
        self.d.line(p, fill=col, width=self._w(w))
        self.m.line(p, fill=255, width=self._w(w))
        r = self._w(w) / 2.0
        for (x, y) in p:
            self.d.ellipse([x - r, y - r, x + r, y + r], fill=col)
            self.m.ellipse([x - r, y - r, x + r, y + r], fill=255)

    def path(self, pts, w, col):
        for a, b in zip(pts, pts[1:]):
            self.line(a[0], a[1], b[0], b[1], w, col)

    def text(self, x, y, s, col, px):
        """Text with its left top at x, y; px the height of a capital in grid units."""
        f = font(int(px * S * 1.4))
        self.d.text((x * S, y * S), s, font=f, fill=col)
        self.m.text((x * S, y * S), s, font=f, fill=255)

    def text_w(self, s, px):
        f = font(int(px * S * 1.4))
        return f.getlength(s) / S

    def done(self):
        """The 32 x 32 picture: (RGB image, alpha as a list of 0 or 255)."""
        rgb = self.rgb.resize((SIZE, SIZE), Image.LANCZOS)
        mk = self.mask.resize((SIZE, SIZE), Image.LANCZOS)
        a = mk.point(lambda v: 255 if v >= 128 else 0)
        return rgb, a


class Axis:
    """A line from a to b: points by their distance along it (t) and across it (s), for a long thing on the diagonal."""

    def __init__(self, a, b):
        self.a = a
        dx, dy = b[0] - a[0], b[1] - a[1]
        self.len = math.hypot(dx, dy)
        self.u = (dx / self.len, dy / self.len)
        self.n = (-self.u[1], self.u[0])

    def at(self, t, s=0.0):
        return (self.a[0] + self.u[0] * t + self.n[0] * s, self.a[1] + self.u[1] * t + self.n[1] * s)

    def band(self, p, t0, t1, s0, s1, fill, ol=OL, w=0.7):
        p.poly([self.at(t0, s0), self.at(t1, s0), self.at(t1, s1), self.at(t0, s1)], fill, ol, w)


def shade(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c)


# ---- drinks -----------------------------------------------------------------------------------------------------------

def can(p, body, stripe=WHITE, mark=None):
    p.rect(9, 6, 23, 28, body, r=1.6)
    p.ell(9, 4.2, 23, 8.2, SILV)
    p.ell(9, 25.5, 23, 29.5, body)
    p.rect(9, 8, 23, 27, body, r=0, ol=None)
    p.line(9, 8, 9, 27, 0.8, OL)
    p.line(23, 8, 23, 27, 0.8, OL)
    p.poly([(9, 14), (14, 12), (18, 15.5), (23, 13), (23, 19.5), (18, 22), (14, 18.5), (9, 21)], stripe, ol=None)
    p.line(11.5, 9.5, 11.5, 26, 0.9, shade(body, 1.35))
    p.ell(13.5, 4.8, 18.5, 6.6, GRAY, w=0.5)
    if mark:
        p.text(11.5, 14.2, mark, body, 4.0)


def bottle(p, body, label, cap, squat=False, mark=None, mark_col=None):
    if squat:
        p.rect(8, 12, 24, 29.5, body, r=3)
        p.rect(12, 6, 20, 13.5, body, r=1.2)
        p.rect(11.5, 3.5, 20.5, 7, cap, r=1)
        ly0, ly1 = 17, 26
    else:
        p.rect(10, 13, 22, 29.5, body, r=3.4)
        p.rect(13, 5.5, 19, 14, body, r=1.2)
        p.rect(12.4, 2.5, 19.6, 6.2, cap, r=1)
        ly0, ly1 = 18, 26.5
    p.rect(9.8 if not squat else 8, ly0, 22.2 if not squat else 24, ly1, label, ol=OL, w=0.6)
    p.line(12 if not squat else 10.5, 14.5, 12 if not squat else 10.5, 28, 0.9, shade(body, 1.4))
    if mark:
        p.text(11.3 if not squat else 10.6, ly0 + 0.8, mark, mark_col or body, 4.6)


def milk(p):
    p.poly([(9, 12.5), (23, 12.5), (23, 29), (9, 29)], WHITE)
    p.poly([(9, 12.5), (16, 4.5), (23, 12.5)], (210, 214, 232))
    p.line(16, 4.5, 16, 12.5, 0.7, OL)
    p.rect(9, 18, 23, 24, BLU, ol=OL)
    p.ell(13, 19, 19, 23.4, WHITE, ol=None)
    p.ell(14.5, 20, 17.5, 22.6, BLU, ol=None)


# ---- food ---------------------------------------------------------------------------------------------------------------

def pizza(p):
    p.poly([(3.5, 7), (28.5, 7), (16, 29.5)], YEL)
    p.poly([(2.5, 4.6), (29.5, 4.6), (29, 9), (3, 9)], TAN)
    for (x, y, r) in ((10, 12.2, 2.2), (19.6, 11.8, 2.2), (14.6, 18, 2.4), (13.2, 23.2, 1.6), (18.4, 22, 1.5)):
        p.ell(x - r, y - r, x + r, y + r, RED, w=0.5)
    p.ell(15.4, 12.8, 16.4, 13.8, ORANGE, ol=None)


def hamburger(p):
    p.ell(4.5, 4.5, 27.5, 17.5, TAN)
    for (x, y) in ((11, 8), (16, 6.8), (21, 8.4), (14, 11.4), (19.6, 11.6)):
        p.ell(x - 0.9, y - 0.5, x + 0.9, y + 0.5, CREAM, ol=None)
    p.poly([(3.5, 15), (6, 17), (9, 15.5), (12, 17.5), (16, 15.8), (20, 17.6), (23, 15.6), (26, 17.2), (28.5, 15), (28.5, 19), (3.5, 19)], GRN)
    p.poly([(5, 19), (27, 19), (24, 22), (8, 22)], YEL, ol=OL)
    p.rect(4, 19.5, 28, 23.5, DBRN, r=1.6)
    p.rect(5, 23.5, 27, 28.5, TAN, r=2.2)


def hotdog(p):
    p.rect(3, 12, 29, 26, TAN, r=5.5)
    p.rect(1.5, 10.5, 30.5, 18.5, (196, 78, 58), r=4)
    p.path([(4, 14.6), (7, 12.6), (10, 14.8), (13, 12.6), (16, 14.8), (19, 12.6), (22, 14.8), (25, 12.6), (28, 14.6)], 1.3, YEL)
    p.rect(3, 17, 29, 26, TAN, r=5)
    p.line(7, 21.5, 25, 21.5, 0.7, shade(TAN, 0.8))


def fries(p):
    for (x, top) in ((8.5, 6), (11.6, 4), (14.7, 5.5), (17.8, 3.5), (20.9, 5), (24, 7)):
        p.rect(x, top, x + 2.8, 18, (250, 216, 96), r=0.8, w=0.6)
    p.poly([(7, 15.5), (25, 15.5), (23.5, 29.5), (8.5, 29.5)], RED)
    p.poly([(10, 19.5), (22, 19.5), (21.2, 25.8), (10.8, 25.8)], YEL, ol=None)
    p.text(12.8, 20, "M", RED, 4.4)


def pasta(p):
    p.ell(2, 13, 30, 30, WHITE)
    p.ell(5, 15.2, 27, 27.6, (226, 222, 238), ol=None)
    p.ell(8, 12, 24, 25, (240, 198, 84))
    for k in range(4):
        p.ring(9.5 + k * 0.6, 13.6 + k * 0.5, 22.5 - k * 0.6, 23.4 - k * 0.4, ORANGE, 0.7)
    p.ell(12.5, 11, 19.5, 17.5, RED)
    p.ell(14, 12.2, 16.2, 14, (250, 130, 110), ol=None)


def steak(p):
    p.poly([(3.5, 13), (10, 6), (21, 5.5), (29, 12), (28, 21), (20, 28), (9.5, 27), (3.5, 20)], (246, 226, 206))
    p.poly([(6, 13.4), (11, 8.4), (20.4, 8), (26.4, 13), (25.6, 20), (19.6, 25.4), (10.4, 24.6), (6, 19.4)], (196, 66, 66), ol=None)
    p.ell(8.5, 15.5, 13.5, 21, WHITE)
    for k in range(3):
        p.line(14 + k * 3, 10.4, 18 + k * 3, 23.6, 0.9, (120, 40, 40))


# ---- medical, documents, communications -----------------------------------------------------------------------------------------

def first_aid(p):
    p.rect(11.5, 4.4, 20.5, 9.8, GRAY, r=1.6)
    p.rect(13.4, 6, 18.6, 8.4, BG, r=0.8, ol=None)
    p.rect(3.5, 8.5, 28.5, 28, WHITE, r=2.6)
    p.rect(14, 12.2, 18, 24.4, RED, ol=None)
    p.rect(9.6, 16.4, 22.4, 20.2, RED, ol=None)


def card(p, fill, band=None, chip=False, mark=None, mark_col=WHITE, stripe=None):
    p.rect(2.5, 7.5, 29.5, 25.5, fill, r=2.4)
    if stripe:
        p.rect(2.5, 11, 29.5, 14.6, stripe, ol=None)
    if band:
        p.rect(2.5, 7.5, 29.5, 11.4, band, r=2.4, ol=None)
        p.rect(2.5, 9.2, 29.5, 11.4, band, ol=None)
        p.line(2.5, 11.4, 29.5, 11.4, 0.7, OL)
    if chip:
        p.rect(5.5, 12, 11.6, 18.6, GOLD, r=1.2)
        p.line(5.5, 15.3, 11.6, 15.3, 0.5, OL)
    if mark:
        w = p.text_w(mark, 4.6)
        p.text(29 - w - 0.5, 19.6, mark, mark_col, 4.6)


def license_card(p, band, ok):
    card(p, WHITE, band=band)
    p.rect(5, 13, 12, 22.5, (156, 188, 226), ol=OL)
    p.ell(6.6, 14.2, 10.4, 18, (236, 204, 170), w=0.5)
    p.poly([(5.6, 22), (7, 19.4), (10, 19.4), (11.4, 22)], (90, 110, 160), ol=None)
    p.line(14, 15, 22, 15, 0.9, GRAY)
    p.line(14, 18, 20, 18, 0.9, GRAY)
    cx, cy = 24.6, 20.2
    p.ell(cx - 3, cy - 3, cx + 3, cy + 3, GRN if ok else RED)
    if ok:
        p.path([(cx - 1.6, cy), (cx - 0.4, cy + 1.4), (cx + 1.8, cy - 1.5)], 1.0, WHITE)
    else:
        p.line(cx - 1.4, cy - 1.4, cx + 1.4, cy + 1.4, 1.0, WHITE)
        p.line(cx - 1.4, cy + 1.4, cx + 1.4, cy - 1.4, 1.0, WHITE)


def phone(p, body, screen, accent=None, keys=SILV, flip=False):
    p.rect(9.5, 2.5, 22.5, 29.5, body, r=3)
    p.rect(11, 5, 21, 12.6, screen, r=1.0)
    p.line(12, 6.2, 16.5, 6.2, 0.6, shade(screen, 1.5))
    if accent:
        p.rect(9.5, 15.2, 22.5, 16.8, accent, ol=None)
    if flip:
        p.line(9.5, 13.8, 22.5, 13.8, 0.7, OL)
    for r_ in range(3):
        for c_ in range(3):
            p.rect(11.4 + c_ * 3.6, 18 + r_ * 3.4, 13.6 + c_ * 3.6, 20 + r_ * 3.4, keys, r=0.5, w=0.4)


def candybar(p):
    p.rect(8.5, 2.5, 23.5, 29.5, (74, 96, 140), r=4)
    p.rect(10.4, 5.2, 21.6, 13.4, (158, 206, 156), r=1.0)
    p.line(11.6, 7, 16, 7, 0.6, (90, 150, 96))
    p.ell(12.6, 14.8, 19.4, 20.4, GRAY)
    p.ell(14.4, 16.4, 17.6, 18.8, SILV, w=0.5)
    for c_ in range(3):
        p.rect(10.8 + c_ * 3.6, 22, 13.4 + c_ * 3.6, 24.2, SILV, r=0.6, w=0.4)
        p.rect(10.8 + c_ * 3.6, 25.4, 13.4 + c_ * 3.6, 27.4, SILV, r=0.6, w=0.4)


def bug(p):
    p.line(11, 14, 9, 4.6, 1.2, SILV)
    p.ell(7.4, 2.4, 11.6, 6.4, RED)
    p.rect(6, 13.4, 26, 27, DGRAY, r=2.4)
    for k in range(4):
        p.line(9 + k * 2.4, 17, 9 + k * 2.4, 23.6, 0.8, BLACK)
    p.ell(20.6, 16.4, 23.8, 19.6, RED, w=0.5)
    p.ell(21.2, 17, 22.2, 18, (255, 170, 160), ol=None)


def scanner(p):
    p.line(22, 10.6, 26.6, 2.6, 1.3, SILV)
    p.rect(6.5, 10, 25.5, 29.5, DGRAY, r=2.6)
    p.rect(8.6, 12.4, 23.4, 21, (22, 66, 46), r=1.0)
    p.path([(9.6, 17), (12, 17), (13, 14), (15, 19.6), (17, 15), (18.6, 17), (22.4, 17)], 0.8, (110, 255, 150))
    p.ell(9, 23.4, 12.6, 27, YEL, w=0.5)
    p.ell(14, 23.4, 17.6, 27, RED, w=0.5)
    p.ell(19, 23.4, 22.6, 27, GRN, w=0.5)


def sim_card(p):
    p.poly([(7.5, 3), (20, 3), (25.5, 8.5), (25.5, 29), (7.5, 29)], (96, 118, 170))
    p.rect(10.5, 11.6, 22.5, 24, GOLD, r=1.6)
    p.line(10.5, 15.6, 22.5, 15.6, 0.5, OL)
    p.line(10.5, 20, 22.5, 20, 0.5, OL)
    p.line(16.5, 11.6, 16.5, 24, 0.5, OL)


def prepaid(p):
    card(p, (62, 162, 112), band=(40, 120, 80))
    p.rect(17, 13.4, 24.6, 22.6, WHITE, r=1.2)
    p.rect(18.6, 14.8, 23, 18, (90, 130, 190), ol=None)
    p.ell(19.8, 19.4, 21.8, 21.2, GRAY, ol=None)
    p.text(5, 14.4, "10", WHITE, 6.0)


# ---- restraints, security -----------------------------------------------------------------------------------------------------------

def chlorofoam(p):
    p.rect(8.5, 13, 21, 29.5, (118, 206, 120), r=2.8)
    p.rect(12, 8.6, 17.6, 13.6, (118, 206, 120), r=1)
    p.rect(10.5, 3.6, 24, 8.8, DGRAY, r=1.4)
    p.rect(22.4, 4.8, 28.6, 7, GRAY, r=0.6, w=0.5)
    p.rect(9.2, 17.4, 20.4, 26.4, YEL, ol=OL, w=0.6)
    p.text(13.2, 18, "!", BLACK, 6.4)


def rope(p):
    col = (214, 168, 98)
    for k, (x0, y0, x1, y1) in enumerate(((3.5, 8, 28.5, 27.5), (6.5, 10.6, 25.5, 24.9), (9.5, 13.2, 22.5, 22.3))):
        p.ring(x0, y0, x1, y1, shade(col, 0.55), 3.4)
        p.ring(x0, y0, x1, y1, col, 2.5)
    p.path([(22, 25), (26, 27.5), (28.5, 30.2)], 2.4, shade(col, 0.55))
    p.path([(22, 25), (26, 27.5), (28.5, 30.2)], 1.6, col)
    for (x, y) in ((8.8, 11.4), (24.5, 12.6), (17, 8.4)):
        p.line(x - 0.6, y - 0.6, x + 0.6, y + 0.6, 0.6, shade(col, 0.5))


def tape(p):
    p.ell(3.5, 5.5, 28.5, 28.5, GRAY)
    p.ell(5.8, 7.8, 26.2, 26.2, SILV, ol=None)
    p.hole(11, 12.6, 21, 21.4)
    p.ring(11, 12.6, 21, 21.4, OL, 0.7)
    p.poly([(21, 25.6), (30, 27.4), (24, 21.6)], GRAY)
    p.line(7, 16, 9, 11, 0.8, WHITE)


def cuffs(p):
    """Handcuffs: two cuffs on a diagonal and a chain of three links between them (the rings come over its ends)."""
    a, b = (10.2, 10.2), (21.8, 21.8)
    ax = Axis(a, b)
    dark = shade(GRAY, 0.5)
    for (cx, cy, w, h) in ((14.1, 14.1, 5.4, 3.6), (16.0, 16.0, 3.6, 5.4), (17.9, 17.9, 5.4, 3.6)):
        p.ring(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, dark, 3.6)
        p.ring(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, SILV, 2.4)
    for (cx, cy), out in ((a, -1.0), (b, 1.0)):
        # the lock block on the outer side of the ring, with a keyhole
        t0, t1 = (5.6, 9.0) if out > 0 else (-9.0, -5.6)
        if out > 0:
            t0, t1 = t0 + ax.len, t1 + ax.len
        ax.band(p, t0, t1, -2.8, 2.8, (124, 124, 146))
        tc = (t0 + t1) / 2.0
        kx, ky = ax.at(tc, 0.0)
        p.ell(kx - 0.9, ky - 0.9, kx + 0.9, ky + 0.9, OL, ol=None)
        # the ring: a dark shadow under a bright band, the hole cut out
        p.ell(cx - 6.2, cy - 6.2, cx + 6.2, cy + 6.2, GRAY)
        p.ell(cx - 5.6, cy - 5.7, cx + 5.5, cy + 5.4, SILV, ol=None)
        p.hole(cx - 3.0, cy - 3.0, cx + 3.0, cy + 3.0)
        p.ring(cx - 3.0, cy - 3.0, cx + 3.0, cy + 3.0, OL, 0.8)
        p.path([(cx - 4.4, cy - 0.8), (cx - 3.9, cy - 2.8), (cx - 2.3, cy - 4.1)], 0.9, WHITE)


def knife(p):
    ax = Axis((4.5, 28), (28, 4))
    ax.band(p, 0, 8.5, -1.7, 1.7, BLACK)
    ax.band(p, 8.5, 10, -3.6, 3.6, DGRAY)
    p.poly([ax.at(10, -2.4), ax.at(10, 2.4), ax.at(30, 1.4), ax.at(34, 0)], SILV)
    p.line(*ax.at(11, 0.6), *ax.at(30, 0.4), 0.7, WHITE)


def flashbang(p):
    p.rect(9.5, 8.6, 22.5, 29.5, (112, 116, 132), r=2.2)
    p.rect(9.5, 14.4, 22.5, 20, YEL, ol=OL)
    p.rect(11, 4.6, 21, 9.4, DGRAY, r=1.2)
    p.poly([(19.6, 5.4), (24.6, 9), (25.8, 15.6), (23.6, 15.4), (22.6, 10.6), (19, 8.4)], GRAY)
    p.ring(21.6, 1.6, 27.4, 7.4, GOLD, 1.2)


def tazer(p):
    p.rect(3.5, 11.5, 22.5, 21.5, YEL, r=2.4)
    p.rect(8, 20, 15.4, 30, BLACK, r=1.6)
    p.line(22.5, 14.4, 27.4, 13.6, 1.1, SILV)
    p.line(22.5, 19, 27.4, 19.8, 1.1, SILV)
    p.path([(27.6, 13.6), (30.2, 15.6), (27.2, 17.2), (30, 19), (27.6, 19.8)], 0.9, (140, 216, 255))
    p.ell(6, 14.6, 9.4, 18, RED, w=0.5)


# ---- tobacco and drugs --------------------------------------------------------------------------------------------------------------

def acid(p):
    p.rect(4, 6, 28, 27, WHITE, r=1.2)
    for k in range(1, 4):
        p.line(4 + k * 6, 6, 4 + k * 6, 27, 0.5, GRAY)
    for k in range(1, 3):
        p.line(4, 6 + k * 7, 28, 6 + k * 7, 0.5, GRAY)
    for (x, y, c) in ((7, 9.5, PUR), (19, 9.5, PUR), (13, 16.5, PINK), (25, 16.5, PUR), (7, 23.5, PINK), (19, 23.5, PUR)):
        p.ell(x - 1.5, y - 1.5, x + 1.5, y + 1.5, c, w=0.4)
    p.poly([(28, 22), (28, 27), (23, 27)], GRAY)


def cigarette(p):
    ax = Axis((3.5, 28.5), (26, 6))
    ax.band(p, 0, 9, -1.8, 1.8, ORANGE)
    ax.band(p, 9, 29, -1.8, 1.8, WHITE)
    ax.band(p, 29, 31.8, -1.8, 1.8, (240, 90, 50))
    p.path([(26.6, 5), (24.4, 2.4), (27.2, 1)], 0.8, GRAY)


def cocaine(p):
    p.poly([(8, 7), (24, 7), (26.4, 28), (5.6, 28)], (214, 228, 246), w=0.7)
    p.poly([(5.6, 28), (11, 18), (14.5, 21), (18.5, 14.8), (22, 20), (26.4, 28)], WHITE)
    p.rect(8, 7, 24, 10.4, LBLU, ol=OL)
    p.line(9, 8.7, 23, 8.7, 0.6, WHITE)


def crack(p):
    p.rect(10.5, 10, 21.5, 29.5, (176, 208, 230), r=2.6)
    p.rect(9.4, 4.4, 22.6, 10.6, RED, r=1.2)
    for pts in (((12.6, 26.6), (14, 22.8), (17, 23.6), (17.4, 27.4)), ((16.6, 21.4), (19.4, 19.6), (21, 23), (18.4, 24))):
        p.poly([q for q in pts], (236, 226, 196), w=0.5)
    p.line(12, 12.4, 12, 22, 0.8, WHITE)


def cigar(p):
    ax = Axis((3.2, 28), (27, 5.4))
    ax.band(p, 0, 32, -2.5, 2.5, (150, 92, 42))
    ax.band(p, 20, 23, -2.5, 2.5, RED)
    ax.band(p, 23, 24.4, -2.5, 2.5, GOLD)
    ax.band(p, 32, 33.6, -2.5, 2.5, (150, 150, 160))
    p.line(*ax.at(2, 1.2), *ax.at(18, 1.2), 0.6, (196, 134, 72))


def syringe(p):
    ax = Axis((3.6, 28.4), (27.6, 4.4))
    ax.band(p, 3, 6.6, -3.6, 3.6, SILV)
    ax.band(p, 0.2, 3, -0.8, 0.8, GRAY)
    ax.band(p, 6.6, 24.6, -2.5, 2.5, (226, 238, 248))
    ax.band(p, 9, 19, -1.6, 1.6, (194, 124, 56), ol=None)
    ax.band(p, 24.6, 26.2, -3.8, 3.8, SILV)
    ax.band(p, 26.2, 33, -0.7, 0.7, GRAY, w=0.5)
    p.line(*ax.at(0, 0), *ax.at(-3, 0), 0.5, SILV)


def lighter(p):
    p.poly([(16, 1.6), (19.6, 6), (18.8, 9), (13.2, 9), (12.4, 6)], ORANGE)
    p.poly([(16, 4.4), (18, 7), (17.4, 9), (14.6, 9), (14, 7)], YEL, ol=None)
    p.rect(10.4, 9, 21.6, 13.4, SILV, r=1)
    p.rect(9.6, 13, 22.4, 29.5, (58, 164, 196), r=2.4)
    p.line(12, 15, 12, 28, 0.9, (150, 224, 244))


def mushroom(p):
    p.rect(12, 14, 20, 29.5, CREAM, r=2.4)
    p.pie(4, 3.4, 28, 29, 180, 360, RED)
    p.line(4.4, 16.2, 27.6, 16.2, 0.8, OL)
    for (x, y, r) in ((10, 11, 1.8), (17, 8, 2.1), (22, 12, 1.6), (14, 13, 1.1)):
        p.ell(x - r, y - r, x + r, y + r, WHITE, ol=None)


def pcp(p):
    p.rect(8.8, 9.6, 23.2, 29.5, ORANGE, r=2.4)
    p.rect(8, 4.6, 24, 10.4, WHITE, r=1.2)
    p.rect(9, 15, 23, 25, WHITE, ol=OL, w=0.6)
    p.text(10, 16, "PCP", RED, 4.2)
    p.line(10.6, 12, 10.6, 28, 0.8, (255, 190, 120))


def pipe(p):
    ax = Axis((13, 16), (28, 25))
    ax.band(p, 0, 17, -1.4, 1.4, BLACK)
    p.poly([(4, 8), (13.4, 7.4), (14, 17.6), (7, 20), (3.6, 15)], BRN)
    p.ell(4.4, 5.6, 13.2, 9.4, DBRN)
    p.ell(5.8, 6.4, 11.8, 8.6, (36, 22, 18), ol=None)
    p.path([(8.6, 4), (10.2, 2), (8.4, 0.8)], 0.7, GRAY)


def zippo(p):
    p.poly([(16.4, 0.8), (19.8, 4.6), (19, 7.6), (13.6, 7.6), (12.8, 4.6)], ORANGE)
    p.poly([(16.4, 3.4), (18.2, 5.6), (17.6, 7.6), (15, 7.6), (14.6, 5.6)], YEL, ol=None)
    p.poly([(9.4, 9.6), (22.6, 9.6), (23.4, 15.6), (8.6, 15.6)], GRAY)
    p.rect(8.6, 15.6, 23.4, 29.5, SILV, r=1.4)
    p.line(10.6, 17.5, 10.6, 28, 0.9, WHITE)
    p.line(8.6, 15.6, 23.4, 15.6, 0.7, OL)


# ---- tools ----------------------------------------------------------------------------------------------------------------------------

def door_c2(p):
    p.rect(3.5, 12.5, 21.5, 27.5, OLIVE, r=1.6)
    p.line(3.5, 20, 21.5, 20, 0.6, shade(OLIVE, 0.7))
    p.rect(21, 8, 29.4, 15.4, BLACK, r=1.2)
    p.ell(23.2, 9.6, 25.4, 11.8, RED, w=0.5)
    p.path([(10, 12.5), (10, 8), (14, 6), (21, 9.6)], 0.9, RED)
    p.path([(14.6, 12.5), (14.6, 9.4), (17.6, 9.4), (21, 12)], 0.9, BLU)


def e_lockpick(p):
    p.rect(3.5, 10.5, 21, 20.5, (236, 172, 52), r=2.4)
    p.rect(7.4, 19.2, 14.6, 29.5, DGRAY, r=1.6)
    p.line(21, 15.4, 28, 15.4, 0.9, SILV)
    p.path([(28, 15.4), (29.6, 13.8)], 0.9, SILV)
    p.path([(23.4, 7.6), (25.4, 10), (23.6, 11.4), (26, 13.6)], 0.9, (140, 216, 255))
    p.ell(6, 13, 9.4, 16.6, RED, w=0.5)


def flashlight(p):
    ax = Axis((3.6, 28.6), (20, 12))
    ax.band(p, 0, 10, -2.5, 2.5, DGRAY)
    for k in (2.4, 4.4, 6.4):
        ax.band(p, k, k + 0.6, -2.5, 2.5, BLACK, ol=None)
    p.poly([ax.at(10, -2.5), ax.at(10, 2.5), ax.at(14.4, 4.4), ax.at(14.4, -4.4)], GRAY)
    p.poly([ax.at(14.4, -4.4), ax.at(14.4, 4.4), ax.at(16, 4), ax.at(16, -4)], YEL)
    for s in (-3.6, 0, 3.6):
        p.line(*ax.at(17.4, s * 0.6), *ax.at(27.6, s * 2.2), 0.8, (252, 236, 150))


def lockpick(p):
    p.path([(4, 28), (20, 12), (24.4, 12.4), (25, 9)], 1.4, SILV)
    p.path([(8, 29), (22, 17)], 1.2, GRAY)
    p.line(4, 28, 7.4, 24.6, 3.0, DGRAY)
    p.path([(8, 29), (7, 25.6), (11, 25)], 1.0, GRAY)


def spray_can(p):
    p.rect(9.4, 11, 22.6, 29.5, BLACK, r=2)
    p.rect(9.4, 18, 22.6, 24, GRN, ol=None)
    p.rect(11, 7.6, 21, 11.6, GRAY, r=1.2)
    p.rect(14, 3.6, 18.2, 8, RED, r=0.8)
    for (x, y) in ((11, 5.4), (8.4, 3.4), (7.6, 6.6), (4.6, 4.6), (5, 8.4)):
        p.ell(x - 0.8, y - 0.8, x + 0.8, y + 0.8, LBLU, ol=None)
    p.line(11.4, 13, 11.4, 28, 0.8, (110, 104, 130))


def axe(p):
    ax = Axis((4.4, 28.6), (24, 8))
    ax.band(p, 0, 23, -1.5, 1.5, BRN)
    p.poly([(15, 7.6), (24.6, 3), (29.4, 7.6), (28.4, 15.2), (23, 15.6), (19.6, 12.8)], SILV)
    p.poly([(24.6, 3), (29.4, 7.6), (28.4, 15.2), (26.6, 9)], (240, 242, 250), ol=None)
    p.line(19.6, 12.8, 23, 15.6, 0.8, OL)


# ---- ammunition ---------------------------------------------------------------------------------------------------------------------------

def ammo(p, label, case=GOLD, tip=(206, 116, 64), shell=False):
    p.rect(4, 16.4, 28, 29.5, (98, 114, 72), r=1.6)
    p.rect(4, 16.4, 28, 19.6, (74, 88, 52), ol=OL, w=0.6)
    for k in range(3):
        x = 8 + k * 6.2
        if shell:
            p.rect(x, 6, x + 4.4, 17, RED, r=0.8, w=0.6)
            p.rect(x, 13.4, x + 4.4, 17, GOLD, ol=OL, w=0.5)
        else:
            p.rect(x, 9.4, x + 4.4, 17, case, r=0.8, w=0.6)
            p.poly([(x, 9.6), (x + 4.4, 9.6), (x + 2.2, 4.4)], tip, w=0.6)
    p.rect(7, 21, 25, 28, (232, 228, 202), ol=OL, w=0.5)
    w = p.text_w(label, 4.0)
    p.text(16 - w / 2.0, 21.8, label, BLACK, 4.0)


ICONS = {
    # Ammunition
    ".22 Hornet Ammo": lambda p: ammo(p, ".22"),
    ".32 ACP Ammo": lambda p: ammo(p, ".32"),
    ".45 ACP Ammo": lambda p: ammo(p, ".45"),
    ".454 Casull Ammo": lambda p: ammo(p, ".454", tip=(190, 190, 200)),
    ".50 AE Ammo": lambda p: ammo(p, ".50AE"),
    ".50 BMG Ammo": lambda p: ammo(p, ".50", tip=(120, 124, 140)),
    "10mm Auto Ammo": lambda p: ammo(p, "10mm"),
    "12 Gauge Shells Ammo": lambda p: ammo(p, "12GA", shell=True),
    "5.56mm NATO Ammo": lambda p: ammo(p, "5.56", tip=(190, 190, 200)),
    "5.7mm FN Ammo": lambda p: ammo(p, "5.7"),
    "7.62mm NATO Ammo": lambda p: ammo(p, "7.62", tip=(190, 190, 200)),
    "7.62mm Soviet Ammo": lambda p: ammo(p, "7.62S", tip=(206, 116, 64)),
    "9mm Parabellum Ammo": lambda p: ammo(p, "9mm"),
    # Communications
    "Bug": bug,
    "Bug Scanner": scanner,
    "Motorola RAZR": lambda p: phone(p, SILV, (74, 116, 170), keys=DGRAY, flip=True),
    "Nokia 6820": candybar,
    "Phone Prepaid Card": prepaid,
    "Phone Subscription": sim_card,
    "Sony Ericsson": lambda p: phone(p, BLACK, (96, 156, 214), accent=ORANGE, keys=GRAY),
    # Documents
    "ATM Card": lambda p: card(p, (74, 116, 196), stripe=BLACK, mark="ATM", mark_col=YEL),
    "Debit Card": lambda p: card(p, (60, 162, 112), chip=True, mark="DB", mark_col=WHITE),
    "Permitted License": lambda p: license_card(p, GRN, True),
    "Restricted License": lambda p: license_card(p, RED, False),
    # Food and drink
    "Beer": lambda p: bottle(p, AMBER, CREAM, GOLD),
    "Fries": fries,
    "Gin": lambda p: bottle(p, (128, 206, 196), WHITE, SILV, mark="G", mark_col=(40, 120, 110)),
    "Hamburger": hamburger,
    "Hawk Miller Light": lambda p: can(p, (96, 148, 226), WHITE, mark="L"),
    "Hotdog": hotdog,
    "Milk": milk,
    "Pasta": pasta,
    "Pizza": pizza,
    "Soda": lambda p: can(p, (204, 46, 46), WHITE),
    "Steak": steak,
    "Vodka": lambda p: bottle(p, (176, 206, 238), WHITE, BLU, mark="V", mark_col=DBLU),
    "Whiskey": lambda p: bottle(p, (196, 122, 40), CREAM, DBRN, squat=True, mark="W", mark_col=DBRN),
    # Medical
    "First Aid Kit": first_aid,
    # Restraints
    "Chlorofoam": chlorofoam,
    "Rope": rope,
    "Tape": tape,
    # Security
    "Assassin Knife": knife,
    "Flashbang": flashbang,
    "Tazer": tazer,
    # Tobacco and drugs
    "Acid": acid,
    "Cigarette": cigarette,
    "Cocaine": cocaine,
    "Crack": crack,
    "Cuban Cigar": cigar,
    "Heroin": syringe,
    "Lighter": lighter,
    "Mushroom": mushroom,
    "PCP": pcp,
    "Tobacco Pipe": pipe,
    "Zippo Lighter": zippo,
    # Tools
    "Door C2": door_c2,
    "Electric Lockpick": e_lockpick,
    "Flashlight": flashlight,
    "Lockpick": lockpick,
    "Spray Can": spray_can,
    "Steel Axe": axe,
}


# Drawn pictures added after the first sheet were made. make_arpicons.py puts them after every other picture (the weapons of H9's reTS too), so that
# adding one moves no frame number.
LATER = {
    # Restraints (ARP_JailMod's item)
    "Cuffs": cuffs,
}


def draw(name):
    p = Pen()
    (ICONS[name] if name in ICONS else LATER[name])(p)
    return p.done()
