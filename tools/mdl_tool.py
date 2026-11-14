"""mdl_tool.py -- reads the header and the geometry of GoldSrc studio models (.mdl, IDST version 10).

    python -I mdl_tool.py [--root <models root>] <model path or name> [...]
    python -I mdl_tool.py --header-only <model> ...

For each model it prints the header the engine reads (id, version, name, length, eyeposition, min and max (the hull the
model asks for), bbmin and bbmax (the clipping box), flags (bit 9, 512, is STUDIO_TRACE_HITBOX: hitboxes are the
collision shape of a SOLID_BBOX entity of that model), the counts), the hitboxes, the bounding box of sequence 0, and the
EXTENTS OF THE GEOMETRY: the vertices of the first submodel of every body part (body 0), moved by the bone matrices of
sequence 0 at frame 0, which is the shape that is drawn for a prop that sets no sequence, frame or body.

As a module: header(path) -> dict, extents(path, seq=0, frame=0, body=0) -> (mins, maxs, nverts).
Reads only. ASCII only.
"""
import math
import os
import struct
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_TREE = os.environ.get("PROPCLIP_ROOT") or (os.path.dirname(_HERE) if os.path.isdir(os.path.join(os.path.dirname(_HERE), "H9XASH")) else r"D:\Downloads\TSM")
DEFAULT_ROOT = os.path.join(_TREE, "H9XASH", "ts")
STUDIO_TRACE_HITBOX = 1 << 9


def resolve(path, root=DEFAULT_ROOT):
    """Finds a model file: a path under the game folder ("models/h9/x.mdl"), compared without regard to case."""
    p = path.replace("\\", "/")
    if os.path.isfile(p):
        return p
    parts = p.split("/")
    cur = root
    for part in parts:
        if not os.path.isdir(cur):
            return None
        hit = None
        for name in os.listdir(cur):
            if name.lower() == part.lower():
                hit = name
                break
        if hit is None:
            return None
        cur = os.path.join(cur, hit)
    return cur if os.path.isfile(cur) else None


def cstr(b):
    return b.split(b"\x00")[0].decode("latin-1")


def header(path):
    d = open(path, "rb").read()
    if len(d) < 244 or d[:4] != b"IDST":
        raise ValueError("%s: not an IDST studio model" % path)
    h = {"path": path, "size": len(d)}
    h["id"] = d[:4].decode("ascii")
    h["version"] = struct.unpack_from("<i", d, 4)[0]
    h["name"] = cstr(d[8:72])
    h["length"] = struct.unpack_from("<i", d, 72)[0]
    h["eyeposition"] = struct.unpack_from("<3f", d, 76)
    h["min"] = struct.unpack_from("<3f", d, 88)
    h["max"] = struct.unpack_from("<3f", d, 100)
    h["bbmin"] = struct.unpack_from("<3f", d, 112)
    h["bbmax"] = struct.unpack_from("<3f", d, 124)
    names = ["flags", "numbones", "boneindex", "numbonecontrollers", "bonecontrollerindex", "numhitboxes", "hitboxindex",
             "numseq", "seqindex", "numseqgroups", "seqgroupindex", "numtextures", "textureindex", "texturedataindex",
             "numskinref", "numskinfamilies", "skinindex", "numbodyparts", "bodypartindex", "numattachments",
             "attachmentindex", "soundtable", "soundindex", "soundgroups", "soundgroupindex", "numtransitions",
             "transitionindex"]
    vals = struct.unpack_from("<%di" % len(names), d, 136)
    h.update(dict(zip(names, vals)))
    h["_data"] = d
    return h


def bones(h):
    d = h["_data"]
    out = []
    for i in range(h["numbones"]):
        o = h["boneindex"] + 112 * i
        name = cstr(d[o:o + 32])
        parent, flags = struct.unpack_from("<2i", d, o + 32)
        ctl = struct.unpack_from("<6i", d, o + 40)
        value = struct.unpack_from("<6f", d, o + 64)
        scale = struct.unpack_from("<6f", d, o + 88)
        out.append({"name": name, "parent": parent, "ctl": ctl, "value": value, "scale": scale})
    return out


def hitboxes(h):
    d = h["_data"]
    out = []
    for i in range(h["numhitboxes"]):
        o = h["hitboxindex"] + 32 * i
        bone, group = struct.unpack_from("<2i", d, o)
        mn = struct.unpack_from("<3f", d, o + 8)
        mx = struct.unpack_from("<3f", d, o + 20)
        out.append({"bone": bone, "group": group, "bbmin": mn, "bbmax": mx})
    return out


def sequences(h):
    d = h["_data"]
    out = []
    for i in range(h["numseq"]):
        o = h["seqindex"] + 176 * i
        label = cstr(d[o:o + 32])
        fps = struct.unpack_from("<f", d, o + 32)[0]
        flags, activity, actweight, numevents, eventindex, numframes = struct.unpack_from("<6i", d, o + 36)
        mn = struct.unpack_from("<3f", d, o + 96)
        mx = struct.unpack_from("<3f", d, o + 108)
        numblends, animindex = struct.unpack_from("<2i", d, o + 120)
        seqgroup = struct.unpack_from("<i", d, o + 156)[0]
        out.append({"label": label, "fps": fps, "flags": flags, "numframes": numframes, "bbmin": mn, "bbmax": mx,
                    "numblends": numblends, "animindex": animindex, "seqgroup": seqgroup})
    return out


def _anim_value(d, anim_off, j, frame):
    """The raw run length coded value of one degree of freedom (0 when it has no data) at an integer frame."""
    off = struct.unpack_from("<H", d, anim_off + 2 * j)[0]
    if off == 0:
        return None
    p = anim_off + off
    k = frame
    total, valid = d[p + 1], d[p]
    if total < valid:
        k = 0
    while total <= k:
        k -= total
        p += 2 * (valid + 1)
        valid, total = d[p], d[p + 1]
        if total < valid:
            k = 0
    if valid > k:
        return struct.unpack_from("<h", d, p + 2 * (k + 1))[0]
    return struct.unpack_from("<h", d, p + 2 * valid)[0]


def _mat_mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)] + [sum(a[r][k] * b[k][3] for k in range(3)) + a[r][3]]
            for r in range(3)]


def _angle_matrix(ang):
    # the studio renderer's AngleQuaternion and QuaternionMatrix: ang = (x, y, z) in radians
    sy, cy = math.sin(ang[2] * 0.5), math.cos(ang[2] * 0.5)
    sp, cp = math.sin(ang[1] * 0.5), math.cos(ang[1] * 0.5)
    sr, cr = math.sin(ang[0] * 0.5), math.cos(ang[0] * 0.5)
    q0 = sr * cp * cy - cr * sp * sy
    q1 = cr * sp * cy + sr * cp * sy
    q2 = cr * cp * sy - sr * sp * cy
    q3 = cr * cp * cy + sr * sp * sy
    return [[1.0 - 2.0 * q1 * q1 - 2.0 * q2 * q2, 2.0 * q0 * q1 - 2.0 * q3 * q2, 2.0 * q0 * q2 + 2.0 * q3 * q1],
            [2.0 * q0 * q1 + 2.0 * q3 * q2, 1.0 - 2.0 * q0 * q0 - 2.0 * q2 * q2, 2.0 * q1 * q2 - 2.0 * q3 * q0],
            [2.0 * q0 * q2 - 2.0 * q3 * q1, 2.0 * q1 * q2 + 2.0 * q3 * q0, 1.0 - 2.0 * q0 * q0 - 2.0 * q1 * q1]]


def bone_transforms(h, seq=0, frame=0):
    """The world matrix (3 x 4) of every bone for one sequence at an integer frame (blend 0)."""
    d = h["_data"]
    bs = bones(h)
    sq = sequences(h)[seq]
    if sq["seqgroup"] != 0:
        raise ValueError("sequence %d lives in another file (sequence group %d)" % (seq, sq["seqgroup"]))
    out = []
    for i, b in enumerate(bs):
        anim_off = sq["animindex"] + 12 * i       # blend 0, bone i: six unsigned shorts
        v = []
        for j in range(6):
            raw = _anim_value(d, anim_off, j, frame)
            val = b["value"][j]
            if raw is not None:
                val += raw * b["scale"][j]
            v.append(val)
        m = _angle_matrix(v[3:6])
        local = [m[r] + [v[r]] for r in range(3)]
        if b["parent"] >= 0:
            local = _mat_mul(out[b["parent"]], local)
        out.append(local)
    return out


def extents(path_or_header, seq=0, frame=0, body=0):
    """(mins, maxs, number of vertices): the box around the drawn vertices, in the model's own space."""
    h = path_or_header if isinstance(path_or_header, dict) else header(path_or_header)
    d = h["_data"]
    bt = bone_transforms(h, seq, frame)
    mn = [1e30] * 3
    mx = [-1e30] * 3
    n = 0
    for bp in range(h["numbodyparts"]):
        o = h["bodypartindex"] + 76 * bp
        nummodels, base, modelindex = struct.unpack_from("<3i", d, o + 64)
        idx = (body // base) % nummodels if nummodels else 0
        mo = modelindex + 112 * idx
        numverts, vertinfoindex, vertindex = struct.unpack_from("<3i", d, mo + 80)
        for v in range(numverts):
            x, y, z = struct.unpack_from("<3f", d, vertindex + 12 * v)
            bone = d[vertinfoindex + v]
            m = bt[bone]
            p = [m[r][0] * x + m[r][1] * y + m[r][2] * z + m[r][3] for r in range(3)]
            for a in range(3):
                mn[a] = min(mn[a], p[a])
                mx[a] = max(mx[a], p[a])
            n += 1
    return tuple(mn), tuple(mx), n


def fmt(v):
    return "(%s)" % ", ".join("%.2f" % x for x in v)


def report(path, root, header_only=False):
    real = resolve(path, root)
    if real is None:
        print("%s: NOT FOUND under %s" % (path, root))
        return None
    h = header(real)
    print("== %s  (%s, %d bytes)" % (path, real, h["size"]))
    print("   id %s  version %d  name %r  length %d" % (h["id"], h["version"], h["name"], h["length"]))
    print("   eyeposition %s" % fmt(h["eyeposition"]))
    print("   min    %s   max   %s   (the hull the model asks for)" % (fmt(h["min"]), fmt(h["max"])))
    print("   bbmin  %s   bbmax %s   (the clipping box)" % (fmt(h["bbmin"]), fmt(h["bbmax"])))
    print("   flags %d%s   bones %d  hitboxes %d  sequences %d (groups %d)  bodyparts %d  textures %d  skins %d" % (
        h["flags"], "  STUDIO_TRACE_HITBOX" if h["flags"] & STUDIO_TRACE_HITBOX else "", h["numbones"], h["numhitboxes"],
        h["numseq"], h["numseqgroups"], h["numbodyparts"], h["numtextures"], h["numskinfamilies"]))
    if header_only:
        return h
    hb = hitboxes(h)
    for i, b in enumerate(hb[:8]):
        print("   hitbox %d: bone %d group %d  %s .. %s" % (i, b["bone"], b["group"], fmt(b["bbmin"]), fmt(b["bbmax"])))
    if len(hb) > 8:
        print("   ... %d more hitboxes" % (len(hb) - 8))
    sq = sequences(h)
    if sq:
        s0 = sq[0]
        print("   sequence 0 %r: %d frames, fps %.1f, bbmin %s bbmax %s" % (s0["label"], s0["numframes"], s0["fps"], fmt(s0["bbmin"]), fmt(s0["bbmax"])))
    try:
        mn, mx, n = extents(h)
        print("   GEOMETRY (body 0, sequence 0, frame 0): %d vertices, %s .. %s   size %s" % (
            n, fmt(mn), fmt(mx), fmt([mx[i] - mn[i] for i in range(3)])))
    except Exception as e:  # noqa: BLE001
        print("   GEOMETRY: not read (%s)" % e)
    return h


if __name__ == "__main__":
    args = sys.argv[1:]
    root = DEFAULT_ROOT
    ho = False
    models = []
    i = 0
    while i < len(args):
        if args[i] == "--root":
            root = args[i + 1]
            i += 2
        elif args[i] == "--header-only":
            ho = True
            i += 1
        else:
            models.append(args[i])
            i += 1
    for m in models:
        report(m, root, ho)
