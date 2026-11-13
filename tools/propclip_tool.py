"""propclip_tool.py -- the tool of ARP_PropClip (apollo-rp\\base\\addons\\amxmodx\\scripting\\ARP_PropClip.sma).

Reads a roleplay map's BSP (the entity lump) and the studio models its ts_model props use, works out the world-aligned box
each prop fills, and writes, lists or checks the lines of configs\\arp\\maps\\<map>\\propclip.ini.

    python -I propclip_tool.py lines  <map> [--model <substring>]... [--ent <n>]...     print the ini lines
    python -I propclip_tool.py write  <map> --out <propclip.ini> [--model ...] [--ent ...]  write the whole ini (header and lines)
    python -I propclip_tool.py check  <map> --ini <propclip.ini>                        prove every line against the map
    python -I propclip_tool.py audit  <map> [<map> ...] [--out <file>]                  every ts_model of the maps, by model

The box of a prop is the box around the vertices the model draws (body 0, sequence 0, frame 0: mdl_tool.extents), turned by the
prop's angles the way the studio renderer turns it (pitch is negated, as the renderer does) and then made world-aligned, because
a SOLID_BBOX entity is an axis-aligned box: a prop turned by a multiple of 90 degrees gets exactly the box it fills, any other
angle the box around the turned shape (the tool says so). Mins round down and maxs up to whole units. The header's own
bbmin and bbmax are not used: every model checked has them at zero.

The ini line:  box "x1 y1 z1" "x2 y2 z2" "<model>" "<ox oy oz>" "<ax ay az>"
  x1 y1 z1 / x2 y2 z2  the world box, two opposite corners;  <model> the prop's model, as the map names it;  ox oy oz and
  ax ay az the prop's origin and angles (pitch yaw roll), which the invisible box entity takes so that it lies exactly on
  the prop. Comment lines start with ';' in column 0.

Reads only the game files; writes only the file named by --out. ASCII only.
"""
import math
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mdl_tool  # noqa: E402

# the game files: H9XASH\ts of the tree this script sits in (tools\ of D:\Downloads\TSM), else of D:\Downloads\TSM, or the folder in PROPCLIP_ROOT
_HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.environ.get("PROPCLIP_ROOT") or (os.path.dirname(_HERE) if os.path.isdir(os.path.join(os.path.dirname(_HERE), "H9XASH")) else r"D:\Downloads\TSM")
MAPS_DIR = os.path.join(TREE, "H9XASH", "ts", "maps")
MODEL_ROOT = os.path.join(TREE, "H9XASH", "ts")
EPS = 1e-4


# ---------------------------------------------------------------------------------------------------------------- the map
def load_entities(mapname):
    path = os.path.join(MAPS_DIR, mapname + ".bsp")
    with open(path, "rb") as f:
        data = f.read()
    lumps = [struct.unpack_from("<ii", data, 4 + 8 * i) for i in range(15)]
    ofs, ln = lumps[0]
    text = data[ofs:ofs + ln].split(b"\x00")[0].decode("latin-1")
    kv = re.compile(r'^"([^"]*)"\s+"([^"]*)"')
    ents, cur = [], None
    for line in text.splitlines():
        s = line.strip()
        if s == "{":
            cur = {}
        elif s == "}":
            if cur is not None:
                cur["_n"] = len(ents)
                ents.append(cur)
            cur = None
        elif cur is not None and s.startswith('"'):
            m = kv.match(s)
            if m:
                cur[m.group(1)] = m.group(2)
    return ents


def vec(s, default=(0.0, 0.0, 0.0)):
    if not s:
        return default
    p = s.split()
    return tuple(float(x) for x in p[:3]) + (0.0,) * (3 - len(p))


# ---------------------------------------------------------------------------------------------------------------- the box
def angle_matrix(angles, studio=True):
    """world = M * local for an entity with these angles (pitch, yaw, roll in degrees); the studio renderer negates pitch."""
    pitch = -angles[0] if studio else angles[0]
    yaw, roll = angles[1], angles[2]
    sy, cy = math.sin(math.radians(yaw)), math.cos(math.radians(yaw))
    sp, cp = math.sin(math.radians(pitch)), math.cos(math.radians(pitch))
    sr, cr = math.sin(math.radians(roll)), math.cos(math.radians(roll))
    return [[cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
            [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
            [-sp, sr * cp, cr * cp]]


def is_quarter_turn(angles):
    return all(abs(a / 90.0 - round(a / 90.0)) < 1e-6 for a in angles)


def world_box(local_min, local_max, origin, angles):
    """The world-aligned box of a local box turned by the prop's angles, as (mins, maxs, exact): rounded outward to whole units."""
    m = angle_matrix(angles)
    lo = [1e30] * 3
    hi = [-1e30] * 3
    for x in (local_min[0], local_max[0]):
        for y in (local_min[1], local_max[1]):
            for z in (local_min[2], local_max[2]):
                p = [m[r][0] * x + m[r][1] * y + m[r][2] * z + origin[r] for r in range(3)]
                for a in range(3):
                    lo[a] = min(lo[a], p[a])
                    hi[a] = max(hi[a], p[a])
    mins = tuple(int(math.floor(lo[a] + EPS)) for a in range(3))
    maxs = tuple(int(math.ceil(hi[a] - EPS)) for a in range(3))
    return mins, maxs, is_quarter_turn(angles)


_ext_cache = {}


def model_extents(model):
    key = model.lower()
    if key not in _ext_cache:
        path = mdl_tool.resolve(model, MODEL_ROOT)
        if path is None:
            _ext_cache[key] = None
        else:
            h = mdl_tool.header(path)
            try:
                mn, mx, n = mdl_tool.extents(h)
            except Exception as e:  # noqa: BLE001
                mn = mx = None
                n = 0
                err = str(e)
            else:
                err = ""
            _ext_cache[key] = {"path": path, "h": h, "min": mn, "max": mx, "verts": n, "err": err,
                               "hitboxes": h["numhitboxes"], "flags": h["flags"],
                               "trace_hitbox": bool(h["flags"] & mdl_tool.STUDIO_TRACE_HITBOX)}
    return _ext_cache[key]


def prop_box(e):
    """(mins, maxs, quarter) of one ts_model entity, or None when its model cannot be read."""
    info = model_extents(e.get("model", ""))
    if not info or info["min"] is None:
        return None
    return world_box(info["min"], info["max"], vec(e.get("origin")), vec(e.get("angles")))


def num(v):
    return str(int(v)) if float(v) == int(v) else ("%.4f" % v).rstrip("0").rstrip(".")


def ini_line(e):
    mins, maxs, _ = prop_box(e)
    o = vec(e.get("origin"))
    a = vec(e.get("angles"))
    return 'box "%d %d %d" "%d %d %d" "%s" "%s %s %s" "%s %s %s"' % (
        mins + maxs + (e["model"],) + tuple(num(v) for v in o) + tuple(num(v) for v in a))


HEADER = """\
; propclip.ini -- ARP_PropClip: invisible solid boxes for props that have no collision of their own.
;
; A ts_model prop (a bookshelf, a couch) is a point to the game: players and bots walk through it. Each box
; line below puts an invisible solid box on one prop. ARP_PropClip reads this file when arp_h9_propclip is 1,
; on the map it belongs to (docs\\APOLLO_RP.txt, section 12).
;
; One line makes one box. Comment lines start with ';' in column 0. The tool makes the lines (see below).
;   box "x1 y1 z1" "x2 y2 z2" "<model>" "<ox oy oz>" "<ax ay az>"
;     x1 y1 z1, x2 y2 z2   two opposite corners of the box, in world coordinates
;     <model>              the model of the prop, as the map names it (some prop of the map uses it)
;     ox oy oz, ax ay az   the prop's origin and angles (pitch yaw roll); the box entity lies on the prop
; The box stops players and bots, and most bullets, and is not drawn. A player standing in a box when it is
; made is not trapped: the box waits until he has left it.
;
; To add a prop, run   python tools\\propclip_tool.py lines <map> --model "<part of the model's name>"
; (or --ent <the entity's number in the map>): it prints one line for each prop that uses the model, ready
; to paste here. It works out each box from the vertices the model draws and the prop's angles.
;   python tools\\propclip_tool.py check <map> --ini <this file>   proves every line against the map.
"""


def write_ini(mapname, ents, path):
    lines = [HEADER.replace("\\\\", "\\")]
    for e in ents:
        info = model_extents(e["model"])
        lines.append("; entity %d %s at %s yaw %s%s" % (e["_n"], e["model"], e.get("origin", "0 0 0"), num(vec(e.get("angles"))[1]),
                                                       "" if is_quarter_turn(vec(e.get("angles"))) else " (not a quarter turn: the box is the hull of the turned shape)"))
        lines.append(ini_line(e))
    text = "\r\n".join(l.rstrip("\n") for l in "\n".join(lines).split("\n")) + "\r\n"
    open(path, "wb").write(text.encode("ascii"))
    return text


# ---------------------------------------------------------------------------------------------------------------- selection
def select(ents, models, nums):
    out = []
    for e in ents:
        if e.get("classname") != "ts_model":
            continue
        if nums and e["_n"] in nums:
            out.append(e)
        elif models and any(m.lower() in e.get("model", "").lower() for m in models):
            out.append(e)
    return out


# ---------------------------------------------------------------------------------------------------------------- check
LINE = re.compile(r'^box\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"\s*$')


def check_ini(mapname, ini_path):
    ents = load_entities(mapname)
    props = [e for e in ents if e.get("classname") == "ts_model"]
    results = []
    n = 0
    raw = open(ini_path, "rb").read()
    results.append(("ASCII only", all(b < 128 for b in raw), ""))
    results.append(("CRLF line ends throughout", raw.count(b"\n") == raw.count(b"\r\n"), ""))
    for no, line in enumerate(raw.decode("ascii").replace("\r\n", "\n").split("\n"), 1):
        if not line.strip():
            continue
        results.append(("line %d under 120 characters" % no, len(line) < 120, "%d" % len(line)))
        if line.startswith(";"):
            continue
        m = LINE.match(line)
        if not m:
            results.append(("line %d is a box line" % no, False, line[:60]))
            continue
        n += 1
        c1, c2 = vec(m.group(1)), vec(m.group(2))
        model, org, ang = m.group(3), vec(m.group(4)), vec(m.group(5))
        hits = [e for e in props if e.get("model", "").lower() == model.lower()
                and max(abs(a - b) for a, b in zip(vec(e.get("origin")), org)) < EPS
                and max(abs(a - b) for a, b in zip(vec(e.get("angles")), ang)) < EPS]
        results.append(("line %d: a ts_model of the map has this model, origin and angles" % no, len(hits) == 1,
                        "%d entities" % len(hits)))
        if len(hits) == 1:
            mins, maxs, _ = prop_box(hits[0])
            want = (mins, maxs)
            got = (tuple(int(min(c1[i], c2[i])) for i in range(3)), tuple(int(max(c1[i], c2[i])) for i in range(3)))
            results.append(("line %d: the box is the one the tool works out (entity %d)" % (no, hits[0]["_n"]), want == got,
                            "tool %s, line %s" % (want, got)))
    results.append(("at least one box line", n >= 1, "%d" % n))
    return results


# ---------------------------------------------------------------------------------------------------------------- audit
# What a player expects to be solid, judged one model at a time from its name and its drawn size (the models are not looked at:
# look at one in the map before adding it). yes: a player expects to be stopped by it; maybe: optional, see the text; no: leave it.
JUDGE = {
    "bookcase": ("yes", "bookcase: the owner's request; box every one (a map needs a propclip.ini for it)"),
    "cc_pr_libbookshelf_1": ("yes", "library shelf: the owner's request; boxed"),
    "cafe_bar1": ("yes", "a cafe counter 185 long: the biggest thing here a player will try to walk through; box it"),
    "d3_conf_table": ("yes", "conference table: box it"),
    "d3_maincontrol": ("yes", "a control console 192 long: a machine, box it"),
    "cc_station_art22m": ("yes", "a machine or monument 90 high: box it"),
    "f3_crate": ("yes", "a crate 157 x 96 x 100: box it"),
    "couch_leather-black": ("yes", "couch, 171 long: box it (the commonest large piece of the hive)"),
    "couch1": ("yes", "couch: box it (low, 39: a player can still step or jump onto it)"),
    "3dm_sofa_antro": ("yes", "sofa: box it"),
    "bed1": ("yes", "bed: box it (41 high: can be stepped or jumped onto)"),
    "bed2": ("yes", "bed with a head 89 high: box it"),
    "dubbelsang3": ("yes", "double bed: box it"),
    "tablechairdining": ("yes", "a dining table with its chairs, 120 x 120: box it"),
    "sg_table2": ("yes", "table 72 x 72: box it (40 high: can be jumped onto)"),
    "bench3": ("yes", "bench 107 long: box it"),
    "refr2": ("yes", "refrigerator 70 high: box it"),
    "fountain2": ("yes", "fountain 120 x 120: box it"),
    "statue": ("yes", "statue: box it"),
    "sentry": ("yes", "a sentry gun prop 89 x 76 x 86: box it"),
    "1wall5": ("yes", "a wall piece 24 x 128 x 128: it is architecture, box it (check a doorway is not behind it)"),
    "kotel": ("maybe", "a boiler 110 x 18 x 60 against a wall: box it if it stands where players walk"),
    "grammo": ("maybe", "a gramophone 41 x 36 x 44, probably on a table: the table blocks, the box would be a second one"),
    "cg_box01": ("maybe", "a crate 42 x 40 x 40: box the ones that stand in a street; every box is one edict"),
    "cg_box02": ("maybe", "a crate 42 x 40 x 40: see cg_box01"),
    "cg_box03": ("maybe", "a crate 46 x 84 x 80: see cg_box01"),
    "gpc_pallets": ("maybe", "a stack of pallets 29 high: can be jumped onto; box only the ones that block a lane"),
    "gpc_pallet": ("no", "one pallet 7 high: a player steps over it"),
    "seat1": ("maybe", "a big seat 51 x 63 x 53: box it if it blocks a row"),
    "s_leather_chair": ("maybe", "an armchair 35 x 34 x 62: box it where it blocks"),
    "geo_clon_kreslo2": ("maybe", "an armchair 30 x 51 x 63: box it where it blocks"),
    "scr_stol_1": ("maybe", "a long seat 40 x 72 x 34: box it where it blocks"),
    "matsalsstol": ("no", "a dining chair 28 x 24 x 46: there are dozens, a box on each makes rooms hard to walk"),
    "3dm_chair": ("no", "a chair 38 x 44 x 48: leave it"),
    "e4g1e_stul": ("no", "a chair 18 x 26 x 42: leave it"),
    "chair1": ("no", "a chair 25 x 22 x 52: leave it"),
    "sg_chair": ("no", "a chair 28 x 28 x 52: leave it"),
    "blackmesachair": ("no", "a chair 31 x 35 x 52: leave it"),
    "barstool": ("no", "a stool 20 x 20 x 31: leave it"),
    "toilette": ("maybe", "a toilet 32 x 23 x 38: box it only if a stall is meant to be shut"),
    "3d_paradisepc": ("no", "a computer on a desk: the desk blocks"),
    "3d_paradisepc2": ("no", "a computer on a desk (one of them is tilted 11 degrees: entity 826): the desk blocks"),
    "qk_trash": ("maybe", "a heap of rubbish 101 x 177 x 38: many, one edict each; box none unless one blocks a way"),
    "gpc_envtrash2": ("maybe", "a heap of rubbish 101 x 177 x 38: see qk_trash"),
    "xen_trashcanb": ("maybe", "a bin 41 x 94 x 55: box the ones in a street"),
    "cg_radio01": ("no", "a radio 42 x 10 x 30: leave it"),
    "re_dirt": ("no", "a flat patch of dirt 11 high: a player walks over it"),
    "arc_flower": ("maybe", "flowers 60 x 56 x 48: only a planter that blocks a path"),
    "vts_kitchen_plates": ("no", "plates, 2 high: leave them"),
    "vts_kitchen_kastrulya": ("no", "pots 9 high: leave them"),
    "bier": ("no", "a bottle 5 x 4 x 19: leave it"),
    "xen_plant2": ("no", "a small plant 41 x 35 x 67: leave it"),
    "cemtree1": ("no", "a tree: the box round its leaves is 316 x 309 x 331, far too big; a trunk needs a hand-made box"),
    "cemtree2": ("no", "a tree: see cemtree1"),
    "pi_treeb": ("no", "a tree: see cemtree1"),
    "heavytengu": ("no", "a player model standing as a decoration: leave it"),
}


def verdict(model, info, count):
    """(class, text): a one-line recommendation for one model."""
    if info is None or info["min"] is None:
        return ("?", "model not read: %s" % (info["err"] if info else "file not found"))
    key = os.path.splitext(os.path.basename(model.replace("\\", "/")))[0].lower()
    if key in JUDGE:
        return JUDGE[key]
    sz = [info["max"][i] - info["min"][i] for i in range(3)]
    if max(sz[0], sz[1]) < 30 and sz[2] < 40:
        return ("no", "small (%d x %d x %d): not judged by name; leave it" % tuple(round(v) for v in sz))
    return ("maybe", "not judged by name (%d x %d x %d): look at it in the map" % tuple(round(v) for v in sz))


def audit(mapnames):
    out = []
    out.append("PROP AUDIT -- every ts_model of the maps, by model (made by propclip_tool.py audit; sizes are the box around the model's drawn")
    out.append("vertices, in game units; 'hitboxes' and 'flags' are the model's own, read from its header)")
    out.append("")
    all_models = {}
    for mp in mapnames:
        ents = load_entities(mp)
        props = [e for e in ents if e.get("classname") == "ts_model"]
        out.append("=" * 118)
        out.append("MAP %s: %d entities in the map, %d ts_model entities, %d different models" % (
            mp, len(ents), len(props), len({e.get("model", "").lower() for e in props})))
        out.append("=" * 118)
        by = {}
        for e in props:
            by.setdefault(e.get("model", ""), []).append(e)
        out.append("%-44s %4s  %-17s %3s %5s  %-5s  recommendation" % ("model", "n", "size x y z", "hbx", "flags", "solid"))
        for model, lst in sorted(by.items(), key=lambda kv: (-len(kv[1]), kv[0].lower())):
            info = model_extents(model)
            cls, text = verdict(model, info, len(lst))
            if info and info["min"] is not None:
                sz = "%d x %d x %d" % tuple(round(info["max"][i] - info["min"][i]) for i in range(3))
                hb, fl = str(info["hitboxes"]), str(info["flags"]) + ("!" if info["trace_hitbox"] else "")
            else:
                sz, hb, fl = "?", "?", "?"
            out.append("%-44s %4d  %-17s %3s %5s  %-5s  %s" % (model, len(lst), sz, hb, fl, cls, text))
            all_models.setdefault(model.lower(), (cls, mp))
        out.append("")
        out.append("the entities, by model (entity number: origin, angles; the box they would fill):")
        for model, lst in sorted(by.items(), key=lambda kv: kv[0].lower()):
            out.append("  %s" % model)
            for e in lst:
                pb = prop_box(e)
                box = ("(%d %d %d)..(%d %d %d)" % (pb[0] + pb[1])) if pb else "-"
                turned = "" if (pb is None or pb[2]) else "  NOT A QUARTER TURN"
                out.append("    #%-5d %-26s ang %-12s box %s%s" % (e["_n"], e.get("origin", ""), e.get("angles", "0 0 0"), box, turned))
        out.append("")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------------------------------------------- main
def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[0]
    maps = []
    models, nums = [], []
    ini = outp = None
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--model":
            models.append(argv[i + 1])
            i += 2
        elif a == "--ent":
            nums.append(int(argv[i + 1]))
            i += 2
        elif a == "--ini":
            ini = argv[i + 1]
            i += 2
        elif a == "--out":
            outp = argv[i + 1]
            i += 2
        else:
            maps.append(a)
            i += 1
    if cmd == "audit":
        text = audit(maps)
        if outp:
            open(outp, "wb").write(text.encode("ascii"))
        else:
            sys.stdout.write(text)
        return 0
    mp = maps[0]
    ents = load_entities(mp)
    if cmd in ("lines", "write"):
        sel = select(ents, models, set(nums))
        if not sel:
            print("no ts_model matches")
            return 1
        if cmd == "lines":
            for e in sel:
                print("; entity %d" % e["_n"])
                print(ini_line(e))
        else:
            write_ini(mp, sel, outp)
            print("wrote %d box lines to %s" % (len(sel), outp))
        return 0
    if cmd == "check":
        res = check_ini(mp, ini)
        bad = 0
        for name, ok, detail in res:
            print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "   <-- " + detail))
            bad += 0 if ok else 1
        print("%d checks, %d failed" % (len(res), bad))
        return 1 if bad else 0
    print("unknown command " + cmd)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
