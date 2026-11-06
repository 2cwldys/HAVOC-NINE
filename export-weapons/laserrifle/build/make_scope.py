"""The laser rifle's scope mask: the stock quarterscope.spr with the colour of its last palette entry changed.

quarterscope.spr is an index-alpha sprite (format 2): every pixel is painted in the colour of palette entry 255 and its
alpha is its own index, so changing that one entry recolours the whole mask. The client (cl_dll\\ts_scope.cpp) draws the
laser rifle's mask from this file and its side bars from the same file's solid corner, so the frame is one colour.

usage: py -3 make_scope.py <quarterscope.spr> <out laserscope.spr> [r g b]      (default 8 28 92)
"""
import struct
import sys

src, dst = sys.argv[1], sys.argv[2]
rgb = tuple(int(v) for v in sys.argv[3:6]) if len(sys.argv) >= 6 else (8, 28, 92)

b = bytearray(open(src, "rb").read())
ident, ver, typ, fmt = struct.unpack_from("<4sIii", b, 0)
assert ident == b"IDSP" and ver == 2 and fmt == 2, "not an index-alpha IDSP v2 sprite"
ncol = struct.unpack_from("<h", b, 40)[0]
assert ncol == 256
pal = 42                         # header 40 bytes, then the 16-bit colour count
b[pal + 3 * 255:pal + 3 * 255 + 3] = bytes(rgb)
open(dst, "wb").write(bytes(b))
print(f"{dst}: palette entry 255 = {rgb}")
