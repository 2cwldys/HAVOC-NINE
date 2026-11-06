r"""Sets a map's title: the "message" key of its worldspawn, which the game's map list shows beside the map's name.

    py -3 tools\map_title.py <map.bsp> "<title>"           the compiled map, in place
    py -3 tools\map_title.py --src <map.map> "<title>"     the .map source's worldspawn, so a recompile keeps it
    py -3 tools\map_title.py --list [<folder>]             every map's title in a folder (default H9XASH\ts\maps), those without one marked

H9's own maps are titled "<Name> -- <Mode>" (Drainage -- Wave Survival, The Lift -- Siege). A copy of a map made for another mode (tools\make_assault_maps.py)
sets its own with retitled(). A bsp's entity lump is rewritten where it lies when the new text fits, else appended to the end of the file and the header
pointed at it (the lump table is at byte 4 of a version 30 bsp and of a BSP2 one alike).
"""
import os
import re
import struct
import sys


def worldspawn_title(data):
    """The worldspawn's "message" in a bsp, "" when it has none."""
    ofs, length = struct.unpack_from("<ii", data, 4)
    text = data[ofs:ofs + length].decode("latin-1")
    for blk in re.finditer(r"\{[^}]*\}", text):
        if re.search(r'"classname"\s+"worldspawn"', blk.group(0)):
            m = re.search(r'"message"\s+"([^"]*)"', blk.group(0))
            return m.group(1) if m else ""
    return ""


def _with_title(block, title):
    """A worldspawn block's text with its "message" set to title (added after the classname when it has none)."""
    new, n = re.subn(r'("message"\s+")[^"]*(")', lambda m: m.group(1) + title + m.group(2), block, count=1)
    if n:
        return new
    return re.sub(r'("classname"\s+"worldspawn"[ \t]*\r?\n)', lambda m: m.group(1) + '"message" "' + title + '"\n', block, count=1)


def retitled(data, title):
    """The bsp with its worldspawn "message" set to title (data unchanged when it has no worldspawn)."""
    ofs, length = struct.unpack_from("<ii", data, 4)
    text = data[ofs:ofs + length].decode("latin-1")
    for blk in re.finditer(r"\{[^}]*\}", text):
        if not re.search(r'"classname"\s+"worldspawn"', blk.group(0)):
            continue
        raw = (text[:blk.start()] + _with_title(blk.group(0), title) + text[blk.end():]).encode("latin-1")
        if not raw.endswith(b"\0"):
            raw += b"\0"
        out = bytearray(data)
        if len(raw) <= length:
            out[ofs:ofs + length] = raw.ljust(length, b"\0")
        else:
            at = (len(out) + 3) & ~3
            out += b"\0" * (at - len(out)) + raw
            struct.pack_into("<ii", out, 4, at, len(raw))
        return bytes(out)
    return data


def retitled_source(text, title):
    """A .map source with its first entity (the worldspawn) titled."""
    m = re.search(r'"classname"\s+"worldspawn"', text)
    if not m:
        return text
    start = text.rfind("{", 0, m.start())
    end = text.find("\n{", m.end())   # the first brush of the worldspawn: its keys all come before it
    end = len(text) if end < 0 else end
    return text[:start] + _with_title(text[start:end], title) + text[end:]


def _list(folder):
    n = 0
    for name in sorted(os.listdir(folder)):
        if name.lower().endswith(".bsp"):
            with open(os.path.join(folder, name), "rb") as f:
                t = worldspawn_title(f.read())
            n += 0 if t else 1
            print("%-30s %s" % (name[:-4], t or "<<< no title"))
    print(n, "without a title")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--list":
        _list(args[1] if len(args) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "H9XASH", "ts", "maps"))
    elif len(args) == 3 and args[0] == "--src":
        with open(args[1], "rb") as f:
            src = f.read().decode("latin-1")
        crlf = "\r\n" in src[:2000]
        src = src.replace("\r\n", "\n")
        out = retitled_source(src, args[2])
        with open(args[1], "wb") as f:
            f.write((out.replace("\n", "\r\n") if crlf else out).encode("latin-1"))
        print("titled", args[1], "->", args[2])
    elif len(args) == 2:
        with open(args[0], "rb") as f:
            data = f.read()
        out = retitled(data, args[1])
        if out == data:
            print("unchanged (no worldspawn, or already so):", args[0])
        else:
            with open(args[0], "wb") as f:
                f.write(out)
            print("titled", args[0], "->", args[1], "(%d -> %d bytes)" % (len(data), len(out)))
    else:
        print(__doc__)
        sys.exit(2)
