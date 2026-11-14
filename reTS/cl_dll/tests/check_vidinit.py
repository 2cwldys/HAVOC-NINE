#!/usr/bin/env python3
"""Lists the H9 HUD elements whose VidInit nothing calls.

    python check_vidinit.py [--strict]

CHud::VidInit (hud.cpp) calls the VidInit of each of its members by name. It does not walk the list of HUD elements, as Think, Draw and InitHUDData are walked, so an element
that registers itself with gHUD.AddHudElem and overrides VidInit gets that call only if CHud::VidInit names it. Each H9 element is a class in its own h9_*.cpp with a hook
H9<Name>_Init, and the call it needs is H9<Name>_VidInit(); in CHud::VidInit.
A VidInit that only returns true needs no call. For every other one this prints OK (called) or GAP (nothing calls it: what it does, it never does). Exit 0, unless --strict is given
and there is a gap. tests\\test_arpinv.cpp checks the inventory's call by itself.
"""
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CL = os.path.abspath(os.path.join(HERE, ".."))
STRICT = "--strict" in sys.argv


def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"//[^\n]*", "", s)


def block(text, start):
    """The text from the first { at or after start to its matching }, braces of strings and characters ignored."""
    i = text.index("{", start)
    depth = 0
    j = i
    while j < len(text):
        c = text[j]
        if c == '"' or c == "'":
            q = c
            j += 1
            while j < len(text) and text[j] != q:
                j += 2 if text[j] == "\\" else 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[i + 1:j]
        j += 1
    return text[i + 1:]


def main():
    hud = strip_comments(open(os.path.join(CL, "hud.cpp"), "rb").read().decode("utf-8", "replace"))
    m = re.search(r"void\s+CHud::VidInit\s*\(\s*\)", hud)
    if not m:
        print("ERROR: CHud::VidInit not found in hud.cpp")
        return 1
    body = block(hud, m.end())
    gaps = 0
    for path in sorted(glob.glob(os.path.join(CL, "h9_*.cpp"))):
        src = strip_comments(open(path, "rb").read().decode("utf-8", "replace"))
        name = os.path.basename(path)
        for cm in re.finditer(r"class\s+(\w+)\s*:\s*public\s+CHudBase", src):
            cls = block(src, cm.end())
            vm = re.search(r"bool\s+VidInit\s*\(\s*\)\s*override", cls)
            if not vm:
                continue
            vbody = block(cls, vm.end()).strip()
            if re.fullmatch(r"return\s+true\s*;", vbody):
                print("OK    %-22s %s: VidInit does nothing, so it needs no call" % (name, cm.group(1)))
                continue
            init = re.search(r"void\s+(H9\w+)_Init\s*\(", src)
            call = (init.group(1) + "_VidInit") if init else None
            if call and re.search(r"\b" + call + r"\s*\(\s*\)\s*;", body):
                print("OK    %-22s %s: VidInit is called by CHud::VidInit (%s)" % (name, cm.group(1), call))
            else:
                gaps += 1
                print("GAP   %-22s %s: VidInit does something (%d line(s)) and nothing calls it%s" % (
                    name, cm.group(1), vbody.count(";"), (" -- CHud::VidInit would need %s();" % call) if call else ""))
    print("%d gap(s)" % gaps)
    return 1 if (STRICT and gaps) else 0


if __name__ == "__main__":
    sys.exit(main())
