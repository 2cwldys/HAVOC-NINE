#!/usr/bin/env python3
"""
wad2png - Export the images in GoldSrc WAD3 and Quake WAD2 archives as PNG files.

Usage:
  python wad2png.py file.wad
  python wad2png.py file1.wad file2.wad -o exported
  python wad2png.py *.wad --overwrite
  python wad2png.py gfx.wad --palette palette.lmp

The default output directory is "exported" beside this script.

Each lump is decoded by its directory type:
  0x43 MIPTEX   in-game textures with four mip levels (the base level is exported)
  0x42 QPIC     menu and HUD pictures (gfx.wad: LAMBDA, PAUSED, BACKTILE, ...)
  0x46 FONT     the console and credits fonts (CONCHARS, CREDITSFONT)
  0x40 PALETTE  a 256-colour palette, exported as a 16x16 swatch
WAD3 lumps carry their own palette. WAD2 (Quake) pictures and textures do not:
they use --palette, or else a PALETTE lump in the same WAD. Palette index 255 is
written as transparent where the engine draws it so: fonts, pictures that use it,
and textures whose names start with "{".
"""
from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

WAD_HEADER = struct.Struct("<4sii")
# WAD2/WAD3 directory entry:
# filepos (4), disksize (4), size (4), type (1),
# compression (1), padding (2), name (16) = 32 bytes.
LUMP_ENTRY = struct.Struct("<iiiBBH16s")
MIPTEX_HEADER = struct.Struct("<16sII4I")
QPIC_HEADER = struct.Struct("<ii")
# qfont_t: width, height, rowcount, rowheight, then 256 x (startoffset, charwidth).
FONT_HEADER = struct.Struct("<iiii")
FONT_GLYPHS_SIZE = 256 * 4
FONT_DATA = FONT_HEADER.size + FONT_GLYPHS_SIZE
QCHAR_WIDTH = 16

TYP_PALETTE = 0x40
TYP_QPIC = 0x42
TYP_MIPTEX = 0x43
TYP_WAD2_MIPTEX = 0x44  # Quake's miptex type ('D'); in WAD3 0x44 is a script
TYP_FONT = 0x46

TYPE_NAMES = {
    0x40: "palette",
    0x41: "DDS texture",
    0x42: "picture",
    0x43: "mip texture",
    0x44: "script",
    0x45: "colormap",
    0x46: "font",
}

TRANSPARENT = 255
MAX_SIDE = 16384


class WadError(Exception):
    pass


def png_chunk(kind: bytes, data: bytes) -> bytes:
    payload = kind + data
    return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)


def write_indexed_png(path: Path, width: int, height: int, pixels: bytes, palette: bytes,
                      transparent: bool = False) -> None:
    if len(pixels) != width * height:
        raise ValueError("pixel data size does not match image dimensions")
    if len(palette) < 768:
        raise ValueError("palette must contain 256 RGB colors")
    # PNG indexed-color image (bit depth 8, color type 3), with no row filters.
    scanlines = b"".join(b"\x00" + pixels[y * width:(y + 1) * width] for y in range(height))
    chunks = [
        png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0)),
        png_chunk(b"PLTE", palette[:768]),
    ]
    if transparent:
        # Every entry opaque except the last, which the engine draws as see-through.
        chunks.append(png_chunk(b"tRNS", b"\xff" * TRANSPARENT + b"\x00"))
    chunks.append(png_chunk(b"IDAT", zlib.compress(scanlines, 9)))
    chunks.append(png_chunk(b"IEND", b""))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"".join(chunks))


def safe_name(raw: bytes | str) -> str:
    if isinstance(raw, bytes):
        raw = raw.split(b"\0", 1)[0].decode("latin-1", errors="replace")
    # Keep GoldSrc's name characters ({ + ~ # ...), which say what a texture is, and replace
    # only what a Windows file name cannot hold, so no path traversal or nested output.
    name = "".join("_" if c in '/\\:*?"<>|' or ord(c) < 32 else c for c in raw).strip(" .")
    return name or "unnamed_texture"


def parse_wad(path: Path):
    data = path.read_bytes()

    if len(data) < WAD_HEADER.size:
        raise WadError("file is too small to be a WAD archive")

    magic, lump_count, directory_offset = WAD_HEADER.unpack_from(data, 0)

    if magic not in (b"WAD2", b"WAD3"):
        raise WadError(
            f"unsupported WAD signature {magic!r}; expected WAD2 or WAD3"
        )

    if lump_count < 0 or lump_count > 1_000_000:
        raise WadError(f"invalid lump count: {lump_count}")

    if directory_offset < WAD_HEADER.size:
        raise WadError("WAD directory offset is invalid")

    if directory_offset + lump_count * LUMP_ENTRY.size > len(data):
        raise WadError("WAD directory is outside the file")

    # Each entry: (raw name, lump bytes or None, problem or None, directory type).
    entries = []

    for i in range(lump_count):
        pos = directory_offset + i * LUMP_ENTRY.size
        filepos, disksize, _size, lump_type, compression, _padding, raw_name = LUMP_ENTRY.unpack_from(data, pos)

        if filepos < 0 or disksize < 0:
            entries.append((raw_name, None, "negative lump offset or size", lump_type))
        elif filepos + disksize > len(data):
            entries.append((raw_name, None, "lump data is outside the file", lump_type))
        elif compression != 0:
            entries.append((raw_name, None, f"compressed lump type is unsupported ({compression})", lump_type))
        else:
            entries.append((raw_name, data[filepos:filepos + disksize], None, lump_type))

    return magic.decode("ascii"), entries


def check_size(width: int, height: int, what: str) -> None:
    if width <= 0 or height <= 0 or width > MAX_SIDE or height > MAX_SIDE:
        raise WadError(f"invalid {what} dimensions {width}x{height}")


def embedded_palette(lump: bytes, pos: int):
    """A palette stored as a 16-bit colour count and RGB triples at pos, or None."""
    if pos + 2 > len(lump):
        return None
    count = struct.unpack_from("<H", lump, pos)[0]
    start = pos + 2
    if count >= 256 and start + 768 <= len(lump):
        return lump[start:start + 768]
    return None


def need_palette(palette, external, what: str) -> bytes:
    if palette is not None:
        return palette
    if external is not None:
        return external
    raise WadError(f"{what} has no palette of its own (WAD2); pass --palette or use a WAD with a PALETTE lump")


def decode_miptex(lump: bytes, external=None):
    if len(lump) < MIPTEX_HEADER.size:
        raise WadError("lump is too small for a mip texture header")
    raw_name, width, height, o0, o1, o2, o3 = MIPTEX_HEADER.unpack_from(lump, 0)
    name = safe_name(raw_name)

    check_size(width, height, "texture")
    if width % 16 != 0 or height % 16 != 0:
        raise WadError(f"texture dimensions {width}x{height} are not multiples of 16")

    mip_sizes = [
        width * height,
        (width // 2) * (height // 2),
        (width // 4) * (height // 4),
        (width // 8) * (height // 8),
    ]
    for index, (offset, mip_size) in enumerate(zip((o0, o1, o2, o3), mip_sizes)):
        if offset < MIPTEX_HEADER.size or offset + mip_size > len(lump):
            raise WadError(f"mip level {index} is outside the lump")

    pixels = lump[o0:o0 + width * height]

    # WAD3 stores a colour count and the palette right after the smallest mip level.
    palette = embedded_palette(lump, o3 + mip_sizes[3])
    palette = need_palette(palette, external, "texture")
    return name, width, height, pixels, palette, name.startswith("{")


def decode_qpic(lump: bytes, external=None, name: str = ""):
    if len(lump) < QPIC_HEADER.size:
        raise WadError("lump is too small for a picture header")
    width, height = QPIC_HEADER.unpack_from(lump, 0)
    check_size(width, height, "picture")
    start = QPIC_HEADER.size
    if start + width * height > len(lump):
        raise WadError(f"picture data ({width}x{height}) is outside the lump")
    pixels = lump[start:start + width * height]
    palette = need_palette(embedded_palette(lump, start + width * height), external, "picture")
    # The engine masks index 255 in any picture that uses it, except the console background.
    transparent = TRANSPARENT in pixels and "conback" not in name.lower()
    return width, height, pixels, palette, transparent


def decode_font(lump: bytes):
    if len(lump) < FONT_DATA:
        raise WadError("lump is too small for a font header")
    cell_width, height, _rows, _row_height = FONT_HEADER.unpack_from(lump, 0)
    check_size(1, height, "font")
    # The Half-Life 1.1 layout is width * 16 pixels across, and its size says so exactly;
    # the older CONCHARS / CREDITSFONT layout is always 256 across.
    width = 256
    if cell_width > 0 and FONT_DATA + cell_width * QCHAR_WIDTH * height + 2 + 768 + 64 == len(lump):
        width = cell_width * QCHAR_WIDTH
    if FONT_DATA + width * height > len(lump):
        raise WadError(f"font data ({width}x{height}) is outside the lump")
    pixels = lump[FONT_DATA:FONT_DATA + width * height]
    palette = embedded_palette(lump, FONT_DATA + width * height)
    if palette is None:
        raise WadError("font has no 256-colour palette after its pixels")
    return width, height, pixels, palette, True


def decode_palette(lump: bytes):
    if len(lump) < 768:
        raise WadError("palette lump is shorter than 768 bytes")
    return 16, 16, bytes(range(256)), lump[:768], False


def decode_raw_conchars(lump: bytes, external=None):
    # Quake's gfx.wad keeps CONCHARS as bare 128x128 pixels, with no header.
    return 128, 128, lump, need_palette(None, external, "font"), True


def read_palette_file(path: Path) -> bytes:
    """A 768-byte palette: a raw .lmp/.pal, or the PALETTE lump of a WAD."""
    data = path.read_bytes()
    if data[:4] in (b"WAD2", b"WAD3"):
        _magic, entries = parse_wad(path)
        for raw_name, lump, issue, lump_type in entries:
            if not issue and lump_type == TYP_PALETTE and len(lump) >= 768:
                return lump[:768]
        raise WadError(f"{path} has no PALETTE lump")
    if len(data) < 768:
        raise WadError(f"{path} is shorter than a 768-byte palette")
    return data[:768]


def unique_path(directory: Path, stem: str, overwrite: bool) -> Path:
    candidate = directory / f"{stem}.png"
    if overwrite or not candidate.exists():
        return candidate
    n = 2
    while True:
        candidate = directory / f"{stem}_{n}.png"
        if not candidate.exists():
            return candidate
        n += 1


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="wad2png",
        description="Export the textures, pictures, fonts and palettes in GoldSrc WAD3 and Quake WAD2 archives as PNG files."
    )
    parser.add_argument("wads", nargs="+", help="WAD file(s) to convert")
    parser.add_argument("-o", "--output", help="output folder (default: exported beside this script)")
    parser.add_argument("--overwrite", action="store_true", help="overwrite existing PNGs with matching names")
    parser.add_argument("--recursive", action="store_true", help="when an input is a directory, search it recursively for WAD files")
    parser.add_argument("--palette", help="palette for WAD2 lumps that carry none: a 768-byte .lmp/.pal, or a WAD with a PALETTE lump")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    output_dir = Path(args.output).expanduser() if args.output else script_dir / "exported"

    if not output_dir.is_absolute():
        output_dir = Path.cwd() / output_dir

    output_dir.mkdir(parents=True, exist_ok=True)

    user_palette = None
    if args.palette:
        try:
            user_palette = read_palette_file(Path(args.palette).expanduser())
        except (OSError, WadError) as exc:
            print(f"wad2png: error: --palette: {exc}", file=sys.stderr)
            return 2

    inputs = []

    for item in args.wads:
        p = Path(item).expanduser()

        if p.is_dir():
            iterator = p.rglob("*") if args.recursive else p.glob("*")
            inputs.extend(
                x for x in iterator
                if x.is_file() and x.suffix.lower() == ".wad"
            )
        elif any(ch in item for ch in "*?[]"):
            inputs.extend(Path.cwd().glob(item))
        else:
            inputs.append(p)

    inputs = [p for p in inputs if p.is_file()]

    if not inputs:
        print("wad2png: error: no input WAD files found", file=sys.stderr)
        return 2

    converted = 0
    skipped = 0
    failed = 0

    for wad_path in inputs:
        print(f"\n[{wad_path}]")

        try:
            wad_type, entries = parse_wad(wad_path)
        except (OSError, WadError) as exc:
            print(f"  ERROR: {exc}")
            failed += 1
            continue

        print(f"  Format: {wad_type} | lumps: {len(entries)}")

        # WAD2 lumps take the user's palette, or else the archive's own PALETTE lump.
        external = user_palette
        if external is None:
            for _raw, lump, issue, lump_type in entries:
                if not issue and lump_type == TYP_PALETTE and len(lump) >= 768:
                    external = lump[:768]
                    break

        for raw_name, lump, issue, lump_type in entries:
            lump_name = safe_name(raw_name)

            if issue:
                print(f"  SKIP {lump_name}: {issue}")
                skipped += 1
                continue

            try:
                if lump_type == TYP_MIPTEX or (wad_type == "WAD2" and lump_type == TYP_WAD2_MIPTEX):
                    if wad_type == "WAD2" and lump_name.lower() == "conchars" and len(lump) == 128 * 128:
                        width, height, pixels, palette, transparent = decode_raw_conchars(lump, external)
                        kind = "font"
                    else:
                        name, width, height, pixels, palette, transparent = decode_miptex(lump, external)
                        lump_name = name
                        kind = "texture"
                elif lump_type == TYP_QPIC:
                    width, height, pixels, palette, transparent = decode_qpic(lump, external, lump_name)
                    kind = "picture"
                elif lump_type == TYP_FONT:
                    width, height, pixels, palette, transparent = decode_font(lump)
                    kind = "font"
                elif lump_type == TYP_PALETTE:
                    width, height, pixels, palette, transparent = decode_palette(lump)
                    kind = "palette"
                else:
                    what = TYPE_NAMES.get(lump_type, "unknown")
                    print(f"  SKIP {lump_name}: not an image (type 0x{lump_type:02X}, {what})")
                    skipped += 1
                    continue

                # Prefix with WAD stem to avoid collisions between archives.
                stem = safe_name(wad_path.stem) + "_" + lump_name
                out_path = unique_path(output_dir, stem, args.overwrite)
                write_indexed_png(out_path, width, height, pixels, palette, transparent)

                print(f"  OK   {lump_name} ({kind}, {width}x{height}) -> {out_path.name}")
                converted += 1

            except (WadError, ValueError, struct.error) as exc:
                print(f"  SKIP {lump_name}: {exc}")
                skipped += 1

    print("\n----------------------------------------")
    print(f"Converted: {converted}")
    print(f"Skipped:   {skipped}")
    print(f"Failed WADs: {failed}")
    print(f"Output:    {output_dir}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
