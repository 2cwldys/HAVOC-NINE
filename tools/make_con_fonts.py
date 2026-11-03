"""
make_con_fonts.py - the console and chat fonts for H9XASH, drawn from a TrueType font.

The font and the row heights come from the "console" line of the overlay's
ts\\resource\\fonts\\fonts.txt (docs\\CUSTOM_FONT.txt):

    console SQR721B.TTF rows 15,18,22

xash.bat runs this on every assemble and assets run. A .ttf given on the command line is
used instead, with the same rows, to try a font without editing fonts.txt.

Writes font0_cp1252.fnt, font1_cp1252.fnt and font2_cp1252.fnt into
xash3d-h9-patches\\overlay\\ts (xash.bat copies the overlay into H9XASH; "deploy" copies them
into H9XASH\\ts now as well). With no fonts.wad in valve\\ and con_oldfont 0, Xash loads
font<N>_<con_charset>.fnt, the game folder's before extras.pk3's, and picks font0, 1 or 2
by screen width (<= 640, between, >= 1280); con_fontnum picks one by hand. A set is written for
each charset in CHARSETS: ts\\userconfig.cfg sets con_charset cp1252, FWGS's own default is
cp1251, and a character the font has no glyph for is left out rather than drawn as a box.

Each is a Half-Life 1.1 qfont (the layout of the fonts in FWGS's extras.pk3): a 256-pixel-wide
sheet of glyphs in rows, a 256-entry grey palette, index 255 see-through. A glyph is a light
core inside a dark one-pixel outline, its edges smoothed between the two, so the engine's text
colour (con_color, or the colour the game gives a line) tints it and it reads over any
background. Drawn at its own size: con_fontscale 1.0, or the engine's nearest-pixel scaling
makes the letters uneven.

  py -3 tools\\make_con_fonts.py [font.ttf] [deploy] [--preview file.png]
"""
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

TSM = Path(__file__).resolve().parent.parent
OUT = TSM / "xash3d-h9-patches" / "overlay" / "ts"
DEPLOY = TSM / "H9XASH" / "ts"
FONTS = OUT / "resource" / "fonts"

# row height of each font: font0 for small screens, font2 for 1280 and wider, unless fonts.txt says
ROWS = (15, 18, 22)
SHEET_WIDTH = 256           # the width field below is SHEET_WIDTH / QCHAR_WIDTH
QCHAR_WIDTH = 16
CORE = 236                  # a glyph's grey; the engine multiplies it by the text colour
EDGE = 32                   # the outline's grey
TRANSPARENT = 255
FIRST = 32                  # control characters stay empty
CHARSETS = ("cp1252", "cp1251")  # H9's con_charset, and FWGS's default


def missing_box(font: ImageFont.FreeTypeFont):
    """What the font draws for a character it has no glyph for, or None when that is blank."""
    box = font.getmask("\uffff")
    return bytes(box) if box.getbbox() else None


def glyph_images(font: ImageFont.FreeTypeFont, row: int, charset: str):
    """Each character as a grey 'L' image (0 = see-through) and its advance, outline included."""
    missing = missing_box(font)
    ascent, descent = font.getmetrics()
    # PIL places text by its ascender line: centring ascent + descent in the row fits
    # both the tallest letters and the descenders
    top = (row - ascent - descent) // 2
    glyphs = {}
    for code in range(FIRST, 256):
        if code == 127:                     # DEL: a control character too
            continue
        try:
            ch = bytes([code]).decode(charset)
        except UnicodeDecodeError:
            continue
        if missing is not None and not ch.isspace() and bytes(font.getmask(ch)) == missing:
            continue
        advance = round(font.getlength(ch))
        if advance <= 0:
            continue
        w = advance + 2                     # one pixel of outline each side; the outlines part the letters
        mask = Image.new("L", (w + 2, row), 0)
        ImageDraw.Draw(mask).text((1, top), ch, font=font, fill=255)
        outline = mask.filter(ImageFilter.MaxFilter(3))
        img = Image.new("L", mask.size, 0)
        mp, op, ip = mask.load(), outline.load(), img.load()
        for y in range(row):
            for x in range(mask.size[0]):
                m, o = mp[x, y], op[x, y]
                if o < 96:
                    continue
                ip[x, y] = max(1, (CORE * m + EDGE * (255 - m)) // 255)
        glyphs[code] = (img.crop((0, 0, w, row)), w)
    return glyphs


def fit_size(path: str, row: int) -> ImageFont.FreeTypeFont:
    """The largest point size whose letters and descenders fit the row with their outline."""
    size = row
    while size > 6:
        font = ImageFont.truetype(path, size)
        ascent, descent = font.getmetrics()
        if ascent + descent + 2 <= row:
            return font
        size -= 1
    return ImageFont.truetype(path, 6)


def make_font(path: str, row: int, charset: str) -> bytes:
    font = fit_size(path, row)
    glyphs = glyph_images(font, row, charset)
    # pack the glyphs into rows across the sheet
    placed = {}
    x = y = 0
    for code in sorted(glyphs):
        img, w = glyphs[code]
        if x + w > SHEET_WIDTH:
            x, y = 0, y + row
        placed[code] = (x, y)
        x += w
    height = y + row
    height = (height + 15) // 16 * 16
    if height > SHEET_WIDTH:
        raise SystemExit(f"rows of {row} px need a sheet {height} tall; the most is {SHEET_WIDTH}")
    sheet = bytearray([TRANSPARENT]) * (SHEET_WIDTH * height)
    for code, (gx, gy) in placed.items():
        img, w = glyphs[code]
        px = img.load()
        for yy in range(row):
            for xx in range(w):
                v = px[xx, yy]
                if v:
                    sheet[(gy + yy) * SHEET_WIDTH + gx + xx] = min(v, TRANSPARENT - 1)
    rows_used = height // row
    out = bytearray(struct.pack("<iiii", SHEET_WIDTH // QCHAR_WIDTH, height, rows_used, row))
    for code in range(256):
        if code in placed:
            gx, gy = placed[code]
            # Xash reads the offset as an unsigned short, so the sheet holds at most 256 rows of pixels
            out += struct.pack("<Hh", gy * SHEET_WIDTH + gx, glyphs[code][1])
        else:
            out += struct.pack("<hh", 0, 0)
    out += sheet
    # the palette: a grey ramp, 768 bytes after their count, then the 64 bytes the 1.1 layout ends with
    out += struct.pack("<H", 768)
    out += bytes(v for i in range(256) for v in (i, i, i))
    out += bytes(64)
    return bytes(out)


def preview(path: Path, fonts):
    """Each font's sheet, tinted purple on a dark ground, as a picture to look at."""
    tint = (190, 140, 255)
    pics = []
    for data in fonts:
        _w, h, _rows, _row = struct.unpack("<iiii", data[:16])
        sheet = data[1040:1040 + SHEET_WIDTH * h]
        img = Image.new("RGB", (SHEET_WIDTH, h), (24, 16, 30))
        p = img.load()
        for i, v in enumerate(sheet):
            if v != TRANSPARENT:
                p[i % SHEET_WIDTH, i // SHEET_WIDTH] = tuple(v * t // 255 for t in tint)
        pics.append(img.resize((SHEET_WIDTH * 2, h * 2), Image.NEAREST))
    out = Image.new("RGB", (sum(i.width for i in pics) + 20 * len(pics), max(i.height for i in pics)), (0, 0, 0))
    x = 0
    for i in pics:
        out.paste(i, (x, 0))
        x += i.width + 20
    out.save(path)


def console_line():
    """The font file and row heights the console line of fonts.txt names, or (None, ROWS)."""
    path = FONTS / "fonts.txt"
    if not path.is_file():
        return None, ROWS
    for line in path.read_text(encoding="ascii", errors="replace").splitlines():
        line = line.split("//", 1)[0].split()
        if len(line) < 2 or line[0].lower() != "console":
            continue
        rows = ROWS
        if "rows" in line[2:]:
            value = line[line.index("rows") + 1]
            rows = tuple(int(v) for v in value.split(","))
            if len(rows) != 3:
                raise SystemExit(f"fonts.txt: rows takes three heights, font0,font1,font2: {value}")
        return FONTS / line[1], rows
    return None, ROWS


def main() -> int:
    args = sys.argv[1:]
    if "-h" in args or "--help" in args:
        print(__doc__)
        return 0
    ttf, rows = console_line()
    given = [a for a in args if a.lower().endswith((".ttf", ".otf"))]
    if given:
        ttf = Path(given[0])
    if ttf is None:
        print(f"no console line in {FONTS / 'fonts.txt'}, and no font given")
        return 2
    if not ttf.is_file():
        print(f"no font file {ttf}")
        return 2
    print(f"  console font: {ttf.name}, rows {', '.join(map(str, rows))}")
    OUT.mkdir(parents=True, exist_ok=True)
    names = []
    for charset in CHARSETS:
        fonts = [make_font(str(ttf), row, charset) for row in rows]
        for n, data in enumerate(fonts):
            name = f"font{n}_{charset}.fnt"
            (OUT / name).write_bytes(data)
            names.append(name)
            _w, h, _rows, row = struct.unpack("<iiii", data[:16])
            print(f"  {name}: rows of {row} px, sheet {SHEET_WIDTH}x{h}, {len(data)} bytes")
        if charset == CHARSETS[0] and "--preview" in args:
            preview(Path(args[args.index("--preview") + 1]), fonts)
    if "deploy" in args:
        for name in names:
            (DEPLOY / name).write_bytes((OUT / name).read_bytes())
        print(f"  copied into {DEPLOY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
