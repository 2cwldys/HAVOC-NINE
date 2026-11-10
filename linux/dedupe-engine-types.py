#!/usr/bin/env python3
"""Leaves the named top-level typedefs (enum, struct or union) out of AMX Mod X's public/engine_strucs.h, in the copy of the
file that linux/build-linux.sh builds from.

AMX Mod X carries its own copy of the engine's server structures (it was written for the ReHLDS API), and Metamod-R's header
set, which the build uses as the HL SDK, defines some of the same types in headers the modules include as well: such a module
stops at "multiple definition". The SDK's definition stays; the copy in engine_strucs.h goes. Only the types that really
collide are named by the caller: a type the SDK defines in a header the module does not include must stay.

usage: dedupe-engine-types.py <engine_strucs.h> <typedef name>...
"""
import re
import sys

path, names = sys.argv[1], set(sys.argv[2:])
text = open(path, encoding="latin-1").read()
out = []
pos = 0
removed = []
for m in re.finditer(r"typedef\s+(?:enum|struct|union)\b[^{;]*\{", text):
    if m.start() < pos:
        continue
    depth = 1
    j = m.end()
    while j < len(text) and depth:
        depth += (text[j] == "{") - (text[j] == "}")
        j += 1
    tail = re.match(r"\s*(\w+)\s*;", text[j:])
    if tail and tail.group(1) in names:
        out.append(text[pos:m.start()])
        pos = j + tail.end()
        removed.append(tail.group(1))
out.append(text[pos:])
open(path, "w", encoding="latin-1", newline="").write("".join(out))
missing = sorted(names - set(removed))
print("engine_strucs.h: left out %s%s" % (", ".join(removed) or "nothing", "; not found: " + ", ".join(missing) if missing else ""))
