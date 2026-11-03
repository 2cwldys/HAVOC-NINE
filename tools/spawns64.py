"""Spawn points for 64 players, checked against the compiled map (BSP v30 or BSP2), read only.

python -I spawns64.py <map.bsp> <tsm_spawns cfg> --check [--want N]
python -I spawns64.py <map.bsp> <tsm_spawns cfg> <per side wanted> [--gap G] [--grid] [--write <out cfg>]

A point is a player origin (feet 36 below). It is valid only if, in the BSP:
  * hull     the standing hull fits: hull 1 (32x32x72) is not solid at the origin;
  * floor    it stands on a floor: hull 1 turns solid within 18 units below;
  * flat     the floor is level under the whole body: a point trace down from the middle and the four
             corners of its 32x32 footprint meets the floor within 4 units of its feet at all five, so it is
             not on stairs, a ramp or a ledge's edge;
  * dry      it is not in water, slime or lava (hull 0 contents at the origin and at the feet);
  * clear    the player box overlaps no trigger_hurt, trigger_teleport, func_ladder or solid brush entity
             (by the entity's own hull 1, as the engine touches it, where the entity has one);
  * spaced   it is at least 64 units (ts_matchmode's TSM_SPAWN_CLEARANCE) from every point that can be in
             use with it: the other side's, and its own side's of the same tier;
  * linked   hull 1 is clear on the straight line (sampled every 8 units) to another point of its side and
             tier within 640 units, so it is in the same room or yard as the rest of its set;
  * own side it is nearer its own side's points than the other side's (reported, not failed).

--check tests every point in the cfg and counts the valid ones per side and tier (a forward tier replaces
tier 0 for the respawns it serves, so each tier holds a whole side on its own). Exit status 1 if any point
fails, or a side's tier 0 has fewer valid points than --want.

With a number instead, it adds points to a cfg written by hand, up to that many a side: candidates on rings
round the side's tier-0 spawns (or, with --grid, every 16 units within 304 of them), nearest first, each
valid as above, at least --gap (default 96) from every other point, with a clear hull line back to the spawn
it came from and a drop from it under 18 units; each faces as that spawn does. --write saves the result.
"""
import math
import re
import struct
import sys

MIN_GAP = 96.0
CLEARANCE = 64.0
LINK = 640.0
RINGS = (112.0, 176.0, 240.0, 304.0)
ANGLES = 12
CONTENTS_SOLID = -2
LIQUID = (-3, -4, -5)  # water, slime, lava
SOLID_ENTS = ("func_wall", "func_door", "func_door_rotating", "func_breakable", "func_train", "func_plat",
              "func_rotating", "func_pushable", "func_button", "func_tracktrain", "func_conveyor",
              "func_water", "func_rot_button", "func_vehicle", "func_guntarget", "momentary_door")
KEEP_OUT = ("trigger_hurt", "trigger_teleport", "func_ladder") + SOLID_ENTS


class Bsp:
    """The parts of a Half-Life BSP the tests need: planes, the hull 0 and clip trees, models, entities."""

    def __init__(self, path):
        d = open(path, "rb").read()
        if d[:4] == b"BSP2":
            node, leaf, clip = ("<i2i", 44), ("<i", 44), ("<i2i", 12)
        elif struct.unpack_from("<i", d, 0)[0] == 30:
            node, leaf, clip = ("<i2h", 24), ("<i", 28), ("<i2h", 8)
        else:
            raise SystemExit("not a BSP v30 or BSP2 file")
        L = [struct.unpack_from("<ii", d, 4 + 8 * i) for i in range(15)]
        lump = lambda i: d[L[i][0]:L[i][0] + L[i][1]]
        self.ents = lump(0).decode("latin-1")
        pl = lump(1)
        self.planes = [struct.unpack_from("<4fi", pl, i) for i in range(0, len(pl), 20)]
        nd = lump(5)
        self.nodes = [struct.unpack_from(node[0], nd, i) for i in range(0, len(nd), node[1])]
        lf = lump(10)
        self.leafs = [struct.unpack_from(leaf[0], lf, i)[0] for i in range(0, len(lf), leaf[1])]
        cn = lump(9)
        self.clip = [struct.unpack_from(clip[0], cn, i) for i in range(0, len(cn), clip[1])]
        md = lump(14)
        self.models = []
        for i in range(0, len(md), 64):
            v = struct.unpack_from("<9f4i3i", md, i)
            self.models.append({"mins": v[0:3], "maxs": v[3:6], "head": v[9:13]})

    def _dist(self, pn, p):
        a, b, c, dist, t = self.planes[pn]
        if t < 3:
            return p[t] - dist
        return a * p[0] + b * p[1] + c * p[2] - dist

    def hull1(self, p):
        n = self.models[0]["head"][1]
        while n >= 0:
            pn, c0, c1 = self.clip[n]
            n = c0 if self._dist(pn, p) >= 0 else c1
        return n

    def hull0(self, p):
        n = self.models[0]["head"][0]
        while n >= 0:
            pn, c0, c1 = self.nodes[n]
            n = c0 if self._dist(pn, p) >= 0 else c1
        return self.leafs[-n - 1]

    def boxes(self):
        """The boxes a player must not start in, from the entity lump: hurt, teleport, ladder, solid brushes."""
        out = []
        for block in re.findall(r"\{([^}]*)\}", self.ents):
            kv = dict(re.findall(r'"([^"]*)"\s+"([^"]*)"', block))
            cls = kv.get("classname", "")
            mdl = kv.get("model", "")
            if not mdl.startswith("*") or cls not in KEEP_OUT:
                continue
            m = self.models[int(mdl[1:])]
            org = [float(x) for x in kv.get("origin", "0 0 0").split()]
            out.append((cls, [m["mins"][i] + org[i] for i in range(3)], [m["maxs"][i] + org[i] for i in range(3)],
                        m["head"][1], org))
        return out

    def model_hull1(self, head, p):
        """hull 1 contents of a brush entity's own tree at p (in its frame): solid where a body would touch it."""
        n = head
        while n >= 0:
            pn, c0, c1 = self.clip[n]
            n = c0 if self._dist(pn, p) >= 0 else c1
        return n


class Tests:
    def __init__(self, bsp):
        self.bsp = bsp
        self.boxes = bsp.boxes()

    def box_hit(self, p):
        lo = (p[0] - 16, p[1] - 16, p[2] - 36)
        hi = (p[0] + 16, p[1] + 16, p[2] + 36)
        for cls, mn, mx, head, org in self.boxes:
            if not all(lo[i] < mx[i] and hi[i] > mn[i] for i in range(3)):
                continue
            # inside the box: the entity's own hull 1 says whether the body really touches its brushes (a curved
            # pane's box takes in the room it bows round); with no hull 1 tree, the box decides
            if head < 0 or self.bsp.model_hull1(head, [p[i] - org[i] for i in range(3)]) == CONTENTS_SOLID:
                return cls
        return None

    def floor_at(self, x, y, z_from):
        """origin z of a player standing on the first floor at or below z_from, or None."""
        if self.bsp.hull1((x, y, z_from)) == CONTENTS_SOLID:
            return None
        for dz in range(0, 19):
            if self.bsp.hull1((x, y, z_from - dz - 1)) == CONTENTS_SOLID:
                return z_from - dz
        return None

    def line_clear(self, a, b):
        d = math.dist(a, b)
        steps = max(1, int(d // 8))
        for s in range(steps + 1):
            t = s / steps
            p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
            if self.bsp.hull1(p) == CONTENTS_SOLID:
                return False
        return True

    def flat(self, p):
        """True when a point trace down from the footprint's middle and corners meets a floor 0-4 below the feet."""
        feet = p[2] - 36
        for ox, oy in ((0, 0), (-14, -14), (14, -14), (-14, 14), (14, 14)):
            x, y = p[0] + ox, p[1] + oy
            depth = None
            for dz in range(-1, 25):
                if self.bsp.hull0((x, y, feet - dz - 0.5)) == CONTENTS_SOLID:
                    depth = dz + 0.5
                    break
            if depth is None or depth > 4.5:
                return False
        return True

    def faults(self, p):
        """What is wrong with a player origin p, standing on its own: [] when it is fine."""
        bsp = self.bsp
        if bsp.hull1(p) == CONTENTS_SOLID:
            return ["hull"]
        out = []
        if all(bsp.hull1((p[0], p[1], p[2] - dz)) != CONTENTS_SOLID for dz in range(1, 20)):
            out.append("floor")
        elif not self.flat(p):
            out.append("flat")
        if bsp.hull0(p) in LIQUID or bsp.hull0((p[0], p[1], p[2] - 34)) in LIQUID:
            out.append("dry")
        hit = self.box_hit(p)
        if hit:
            out.append("clear(%s)" % hit)
        return out


def read_cfg(path):
    raw = open(path, "rb").read()
    spawns = []
    for line in raw.decode("latin-1").splitlines():
        m = re.match(r"\s*tsm_spawn\s+([12])\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\d+))?", line)
        if m:
            spawns.append({"team": int(m.group(1)), "o": [float(m.group(i)) for i in (2, 3, 4)],
                           "pitch": float(m.group(5)), "yaw": float(m.group(6)), "tier": int(m.group(7) or 0)})
    return raw, spawns


def together(a, b):
    """Whether two points can be in use at once: different sides, or one side's same tier."""
    return a["team"] != b["team"] or a["tier"] == b["tier"]


def check(tests, spawns, want):
    bad = 0
    for i, s in enumerate(spawns):
        p = tuple(s["o"])
        f = tests.faults(p)
        if "hull" not in f:
            near = [q for j, q in enumerate(spawns) if j != i and together(s, q)]
            gap = min((math.dist(p, q["o"]) for q in near), default=1e9)
            s["gap"] = gap
            if gap < CLEARANCE:
                f.append("spaced(%.0f)" % gap)
            mates = [q for j, q in enumerate(spawns) if j != i and q["team"] == s["team"] and q["tier"] == s["tier"]]
            if mates and not any(math.dist(p, q["o"]) <= LINK and tests.line_clear(p, tuple(q["o"])) for q in mates):
                f.append("linked")
            own = min((math.dist(p, q["o"]) for q in spawns if q is not s and q["team"] == s["team"]), default=1e9)
            other = min((math.dist(p, q["o"]) for q in spawns if q["team"] != s["team"]), default=1e9)
            s["far_side"] = other <= own
        s["faults"] = f
        if f:
            bad += 1
            print("  FAIL team %d tier %d  %.2f %.2f %.2f  %s" % (s["team"], s["tier"], p[0], p[1], p[2], " ".join(f)))
    short = False
    for team in (1, 2):
        tiers = sorted({s["tier"] for s in spawns if s["team"] == team})
        for tier in tiers:
            set_ = [s for s in spawns if s["team"] == team and s["tier"] == tier]
            ok = [s for s in set_ if not s["faults"]]
            gaps = [s["gap"] for s in ok if "gap" in s]
            far = len([s for s in set_ if s.get("far_side")])
            print("team %d tier %d: %d points, %d valid, closest %s%s" % (
                team, tier, len(set_), len(ok), ("%.0f" % min(gaps)) if gaps else "-",
                (", %d nearer the other side" % far) if far else ""))
        valid0 = len([s for s in spawns if s["team"] == team and s["tier"] == 0 and not s["faults"]])
        if want and valid0 < want:
            short = True
        if not tiers:
            print("team %d: no points" % team)
            short = short or bool(want)
    print("%d of %d points fail" % (bad, len(spawns)))
    return 1 if bad or short else 0


def add(tests, spawns, want, gap, grid):
    bsp = tests.bsp
    added = []
    for team in (1, 2):
        own = [s for s in spawns if s["team"] == team and s["tier"] == 0]
        other = [s for s in spawns if s["team"] != team]
        have = len(own)
        if have >= want or not own:
            continue
        cands = []
        for src in own:
            if grid:
                R = RINGS[-1]
                for ix in range(-int(R // 16), int(R // 16) + 1):
                    for iy in range(-int(R // 16), int(R // 16) + 1):
                        r = math.hypot(ix * 16, iy * 16)
                        if 0 < r <= R:
                            cands.append((r, src, src["o"][0] + ix * 16, src["o"][1] + iy * 16))
            else:
                for r in RINGS:
                    for k in range(ANGLES):
                        ang = 2 * math.pi * k / ANGLES
                        cands.append((r, src, src["o"][0] + r * math.cos(ang), src["o"][1] + r * math.sin(ang)))
        cands.sort(key=lambda c: c[0])
        placed = []
        for r, src, x, y in cands:
            if have + len(placed) >= want:
                break
            z = tests.floor_at(x, y, src["o"][2] + 17)
            if z is None:
                continue
            z += 1.0
            if abs(z - src["o"][2]) > 18:
                continue
            p = (x, y, z)
            if tests.faults(p):
                continue
            allp = [s["o"] for s in spawns] + [q["o"] for q in added] + [q["o"] for q in placed]
            if any(math.dist(p[:2], q[:2]) < gap and abs(p[2] - q[2]) < 72 for q in allp):
                continue
            d_own = min(math.dist(p, s["o"]) for s in own)
            d_other = min((math.dist(p, s["o"]) for s in other), default=1e9)
            if d_other <= d_own:
                continue
            if not tests.line_clear(tuple(src["o"]), p):
                continue
            placed.append({"team": team, "o": list(p), "pitch": 0.0, "yaw": src["yaw"], "tier": 0})
        added += placed
        print("team %d: had %d, added %d, now %d (wanted %d)" % (team, have, len(placed), have + len(placed), want))
    return added


def main():
    args = sys.argv[1:]
    bsp_path, cfg_path = args[0], args[1]
    tests = Tests(Bsp(bsp_path))
    raw, spawns = read_cfg(cfg_path)
    if "--check" in args:
        want = int(args[args.index("--want") + 1]) if "--want" in args else 0
        sys.exit(check(tests, spawns, want))

    want = int(args[2])
    gap = float(args[args.index("--gap") + 1]) if "--gap" in args else MIN_GAP
    out_path = args[args.index("--write") + 1] if "--write" in args else None
    added = add(tests, spawns, want, gap, "--grid" in args)
    if out_path:
        crlf = b"\r\n" in raw
        nl = "\r\n" if crlf else "\n"
        text = raw.decode("latin-1")
        if not text.endswith(("\n", "\r\n")):
            text += nl
        lines = ["// added for 64 players (docs\\PLAYER_LIMIT_128.txt): each checked against the compiled",
                 "// map by tools\\spawns64.py -- standing hull clear, on a level floor, dry, clear of",
                 "// trigger_hurt and solid brush entities, a clear line back to an existing spawn of the",
                 "// side, at least %d units from every other spawn" % gap]
        for q in added:
            lines.append("tsm_spawn %d %.2f %.2f %.2f %.2f %.2f" % (q["team"], q["o"][0], q["o"][1], q["o"][2],
                                                                  q["pitch"], q["yaw"]))
        text += nl.join(lines) + nl
        open(out_path, "wb").write(text.encode("ascii"))
        print("wrote", out_path)


main()
