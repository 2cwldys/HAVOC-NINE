r"""Makes the Assault maps (and, for Neuropolis, an Uplink map, and for Drainage a Capture the Flag map) from maps that already play:
h9_as_lift from h9_up_lift, h9_as_drainage and h9_ctf_drainage from h9_up_drainage, and h9_up_neuropolis and h9_as_neuropolis from
h9_te_neuropolis.
Run it from anywhere: py -3 tools\make_assault_maps.py

What it copies, under the new name, every time it runs (so a rebuilt source map reaches its twins):
  the .bsp and .res (the .res's first-line comment renamed; Neuropolis has none), the bots' waypoints (.rcw, with the map name
  in its header renamed, in both rcbot folders) and their visibility table (.rcv2), and the map picture.
What it writes ONLY when the file is not there yet, because a person edits them afterwards:
  configs\tsm_spawns_<map>.cfg    the respawn points: the source map's own, which are the sides' bases (tier 0)
  configs\tsm_assault_<map>.cfg   the capture points (the ts_assault editor, amx_tsm_as_save, writes the same file)
  configs\tsm_uplink_<map>.cfg    an Uplink map's zones and uplink point (amx_tsm_uplink_save writes the same file)
  configs\tsm_ctf_<map>.cfg      a Capture the Flag map's two flag pads (amx_tsm_cf_save writes the same file)
  mapconfigs\<map>.cfg            what the map plays with (an Assault copy of an Uplink map: tsm_uplink_mode 0)

The sources are the game folder's H9XASH copies of the maps; where a map's generator keeps an out folder
(export-map\h9_siege_lift\out, export-map\h9_drainage\out) the copies go there too, where export.bat takes every map from.
The capture points of a map with none were proposed by  node tools/assault-spawns/cli.mjs <map> --suggest <n>  and are a
start to judge on the plan picture, not an answer; so were the flag pads, by  ... <map> --pads  (docs/ai_context/ASSAULT_SPAWNS.txt).
"""
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from map_title import retitled

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
GAME = os.path.join(ROOT, "H9XASH")
CFG = os.path.join(GAME, "ts", "addons", "amxmodx", "configs")

# n: the number of the point, x y z: where it is (the floor plus 16), radius: how far it reaches, what: a word for the comment.
MAPS = {
    "lift": {
        "from": "h9_up_lift",
        "outs": [os.path.join(ROOT, "export-map", "h9_siege_lift", "out")],
        "assault": {
            "title": "the skylift",
            "carries_uplink": True,  # the copy still carries the Uplink map's zones
            "roundtime": 720,
            "points": [
                (1, 317, 42, 16, 288, "the clamp bay"),
                (2, -50, 377, 368, 288, "the power room"),
                (3, -416, -55, 656, 288, "the drive room"),
                (4, -161, -388, 368, 288, "the mess"),
                (5, 693, -400, 368, 288, "the uplink room"),
            ],
        },
    },
    "drainage": {
        "from": "h9_up_drainage",
        "outs": [os.path.join(ROOT, "export-map", "h9_drainage", "out")],
        "ctf": {
            "title": "the drainage works",
            "carries_uplink": True,
            "roundtime": 600,
            # side: x, y, z (the floor under the flag), a word for the comment. Proposed by cli.mjs --pads: the rear of each base.
            "pads": [
                (1, 8.00, 1458.82, -11.82, "the rear of side 1's base, at the north end"),
                (2, 8.00, -1442.82, -11.82, "the rear of side 2's base, at the south end"),
            ],
        },
        "assault": {
            "title": "the drainage works",
            "carries_uplink": True,
            "roundtime": 720,
            "points": [
                (1, 0, 640, 0, 384, "the north culvert"),
                (2, -752, 0, 0, 384, "the filter room"),
                (3, 0, -640, 0, 384, "the south culvert"),
                (4, 752, 0, 0, 384, "the generator room"),
                (5, 160, 0, 16, 384, "the pump station"),
            ],
        },
    },
    "neuropolis": {
        "from": "h9_te_neuropolis",
        "outs": [],
        "uplink": {
            "title": "the city of Neuropolis",
            "roundtime": 600,
            "zones": [
                (1, -384, 384, 15, 128, "near MSR's end"),
                (2, 1664, -1024, 15, 128, "the middle, south"),
                (3, 1664, 384, 15, 128, "the middle, north"),
                (4, 3456, -512, 15, 128, "near the Insurgents' end"),
            ],
            "uplink_at": (1792, -384, 15),
        },
        "assault": {
            "title": "the city of Neuropolis",
            "carries_uplink": False,
            "roundtime": 900,
            "points": [
                (1, -384, 512, 15, 384, "the first crossing from MSR's end"),
                (2, 896, -1024, 15, 384, "the southern avenue"),
                (3, 1536, -1024, 15, 384, "the southern avenue, east"),
                (4, 1792, -384, 15, 384, "the middle"),
                (5, 1792, 384, 15, 384, "the middle, north"),
                (6, 2432, 256, 23, 384, "the east plaza"),
                (7, 3456, -512, 15, 384, "the last crossing before the Insurgents' end"),
            ],
        },
    },
}


def read(path):
    with open(path, "rb") as f:
        return f.read()


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    print("  copied ", os.path.relpath(dst, ROOT))


def make_once(path, text):
    if os.path.exists(path):
        print("  kept   ", os.path.relpath(path, ROOT), "(already there)")
        return
    write(path, text.replace("\n", "\r\n").encode("ascii"))
    print("  wrote  ", os.path.relpath(path, ROOT))


def rcw_renamed(data, old, new):
    # RCBot waypoint header: 8 bytes "RCBot", version, flags, count (4 each), then the 32-byte map name.
    at = 20
    field = data[at:at + 32]
    if not field.startswith(old.encode("ascii") + b"\0"):
        sys.exit("the waypoint file's map name is not %s: %r" % (old, field))
    return data[:at] + new.encode("ascii").ljust(32, b"\0") + data[at + 32:]


# The title of a copy (the worldspawn's "message", which the map list shows): a copy of an Uplink map says Capture the Uplink until it is
# given its own (tools\map_title.py does the writing). A map not named here keeps its source's title.
TITLES = {
    "h9_as_lift": "The Lift -- Assault",
    "h9_as_drainage": "Drainage -- Assault",
    "h9_as_neuropolis": "Neuropolis -- Assault",
    "h9_up_neuropolis": "Neuropolis -- Capture the Uplink",
    "h9_ctf_drainage": "Drainage -- Capture the Flag",
}


def copy_map(old, new, outs):
    """The map and what travels with it, under its new name."""
    maps = os.path.join(GAME, "ts", "maps")
    bsp = read(os.path.join(maps, old + ".bsp"))
    if new in TITLES:
        bsp = retitled(bsp, TITLES[new])
    write(os.path.join(maps, new + ".bsp"), bsp)
    dirs = [maps] + outs
    for base in outs:
        write(os.path.join(base, new + ".bsp"), bsp)
    res_src = os.path.join(maps, old + ".res")
    if os.path.exists(res_src):
        res = read(res_src).decode("latin-1").replace(old, new, 1).encode("latin-1")
        for base in dirs:
            write(os.path.join(base, new + ".res"), res)
    print("  copied ", os.path.join("H9XASH", "ts", "maps", new + ".bsp"), "+ .res" if os.path.exists(res_src) else "(it has no .res)")
    rcw = rcw_renamed(read(os.path.join(GAME, "rcbot", "waypoints", "ts", old + ".rcw")), old, new)
    for base in (os.path.join(GAME, "rcbot", "waypoints", "ts"), os.path.join(GAME, "ts", "addons", "rcbot", "waypoints", "ts")) + tuple(outs):
        write(os.path.join(base, new + ".rcw"), rcw)
    print("  copied the waypoints")
    rcv2 = os.path.join(GAME, "rcbot", "visibility", "ts", old + ".rcv2")
    if os.path.exists(rcv2):
        write(os.path.join(GAME, "rcbot", "visibility", "ts", new + ".rcv2"), read(rcv2))
        print("  copied the visibility table")
    pic = os.path.join(ROOT, "presence", "maps")
    copy(os.path.join(pic, old + ".png"), os.path.join(pic, new + ".png"))


def spawns_file(old, new, outs, what):
    spawns = read(os.path.join(CFG, "tsm_spawns_" + old + ".cfg")).decode("latin-1").replace("\r\n", "\n").replace(old, new, 1)
    first, rest = spawns.split("\n", 1)
    text = ("// ts_matchmode spawn points for %s -- the sides' bases of %s, tier 0%s\n%s" % (new, old, what, rest))
    for base in [CFG] + outs:
        make_once(os.path.join(base, "tsm_spawns_" + new + ".cfg"), text)


def assault_files(old, new, a):
    lines = [
        "// ts_assault capture points for %s -- a first pass from %s" % (new, old),
        "// tsm_as_zone <n> <x> <y> <z> <radius>   (point n's spawn set is tier n of the map's tsm_spawns file)",
    ]
    for n, x, y, z, r, what in a["points"]:
        lines.append("tsm_as_zone %d %.2f %.2f %.2f %.2f   // %s" % (n, x, y, z, r, what))
    make_once(os.path.join(CFG, "tsm_assault_" + new + ".cfg"), "\n".join(lines) + "\n")
    uplink = (
        "// %(old)s still carries that map's Uplink zones, so the Uplink mode is turned off here.\n" % {"old": old}
        if a["carries_uplink"] else "")
    conf = (
        "// h9_autoconfig map config for %(new)s: Assault on %(title)s.\n"
        "//\n"
        "// The assault mode takes this map by its capture points (configs/tsm_assault_%(new)s.cfg). The map is a copy of\n"
        "// %(old)s. %(uplink)sts_matchmode places each side on its base from configs/tsm_spawns_%(new)s.cfg, and its waves\n"
        "// land at the capture points a side holds. ts_matchmode.cfg sets these back on the next map.\n"
        "\n"
        "echo \"[h9_autoconfig] %(new)s.cfg applied\"\n"
        "\n"
        "%(off)stsm_respawns 1\n"
        "tsm_roundtime %(round)d\n"
    ) % {"new": new, "old": old, "title": a["title"], "round": a["roundtime"], "uplink": uplink.replace("// ", "", 1).rstrip("\n") + (" " if uplink else ""),
         "off": "tsm_uplink_mode 0\n" if a["carries_uplink"] else ""}
    make_once(os.path.join(GAME, "ts", "mapconfigs", new + ".cfg"), conf)


def ctf_files(old, new, c):
    lines = [
        "// ts_ctf flag pads for %s -- a first pass from %s" % (new, old),
        "// tsm_cf_pad <side 1|2> <x> <y> <z>   (the floor where that side's flag stands and its carrier turns the enemy's in)",
    ]
    for side, x, y, z, what in c["pads"]:
        lines.append("tsm_cf_pad %d %.2f %.2f %.2f   // %s" % (side, x, y, z, what))
    make_once(os.path.join(CFG, "tsm_ctf_" + new + ".cfg"), "\n".join(lines) + "\n")
    uplink = (
        "%s still carries that map's Uplink zones, so the Uplink mode is turned off here. " % old
        if c["carries_uplink"] else "")
    conf = (
        "// h9_autoconfig map config for %(new)s: Capture the Flag on %(title)s.\n"
        "//\n"
        "// The flag mode takes this map by its two pads (configs/tsm_ctf_%(new)s.cfg). The map is a copy of %(old)s. %(uplink)s\n"
        "// ts_matchmode places each side on its base from configs/tsm_spawns_%(new)s.cfg. ts_matchmode.cfg sets these back on the next map.\n"
        "\n"
        "echo \"[h9_autoconfig] %(new)s.cfg applied\"\n"
        "\n"
        "%(off)stsm_respawns 1\n"
        "tsm_roundtime %(round)d\n"
    ) % {"new": new, "old": old, "title": c["title"], "round": c["roundtime"], "uplink": uplink.rstrip(),
         "off": "tsm_uplink_mode 0\n" if c["carries_uplink"] else ""}
    make_once(os.path.join(GAME, "ts", "mapconfigs", new + ".cfg"), conf)


def uplink_files(old, new, u):
    lines = [
        "// ts_uplink zones and uplink point for %s -- a first pass from %s" % (new, old),
        "// tsm_cap <n> <x> <y> <z> [radius]    tsm_uplink_at <x> <y> <z>",
    ]
    for n, x, y, z, r, what in u["zones"]:
        lines.append("tsm_cap %d %.2f %.2f %.2f %.2f   // %s" % (n, x, y, z, r, what))
    lines.append("tsm_uplink_at %.2f %.2f %.2f" % u["uplink_at"])
    make_once(os.path.join(CFG, "tsm_uplink_" + new + ".cfg"), "\n".join(lines) + "\n")
    conf = (
        "// h9_autoconfig map config for %(new)s: Capture the Uplink in %(title)s.\n"
        "//\n"
        "// The uplink mode takes this map by its zones (configs/tsm_uplink_%(new)s.cfg: four zones and the uplink's point), and\n"
        "// ts_matchmode places each side on its base from configs/tsm_spawns_%(new)s.cfg. The map is a copy of %(old)s,\n"
        "// which has none of either. ts_matchmode.cfg sets these back on the next map.\n"
        "\n"
        "echo \"[h9_autoconfig] %(new)s.cfg applied\"\n"
        "\n"
        "tsm_respawns 1\n"
        "tsm_roundtime %(round)d\n"
    ) % {"new": new, "old": old, "title": u["title"], "round": u["roundtime"]}
    make_once(os.path.join(GAME, "ts", "mapconfigs", new + ".cfg"), conf)


for key, info in MAPS.items():
    old = info["from"]
    for kind, prefix in (("uplink", "h9_up_"), ("assault", "h9_as_"), ("ctf", "h9_ctf_")):
        if kind not in info:
            continue
        new = prefix + key
        if new == old:
            continue
        print(new, "from", old)
        copy_map(old, new, info["outs"])
        spawns_file(old, new, info["outs"], "; forward sets are tiers 1 and up, one for each capture point (the set of point N is tier N)"
                    if kind == "assault" else "")
        {"assault": assault_files, "uplink": uplink_files, "ctf": ctf_files}[kind](old, new, info[kind])
print("done: now place each Assault map's respawn sets with  node tools/assault-spawns/cli.mjs <map> --plan <folder>  (docs/ai_context/ASSAULT_SPAWNS.txt)")
