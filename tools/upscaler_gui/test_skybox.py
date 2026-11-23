"""Checks core/skybox.py without a model, on a cube whose six faces are known exactly.

The faces are cut from one continuous picture of the sky (a sum of waves over the direction), so what
lies beyond each edge of a face is known: it is the neighbour's picture. The "model" is a plain
Lanczos 4x. That is enough to prove the geometry, because with the real neighbour's rows round it a
face comes out closer to the truth along its edges than it does when the padding is only reflected.
If the code put a neighbour on the wrong side or the wrong way round, it would come out worse.

    py -3 test_skybox.py            exit 0 when every check passes
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core import skybox as sk  # noqa: E402

N = 64
SCALE = 4
FAILS = []


def check(ok, what):
    print(("  ok    " if ok else "  FAIL  ") + what)
    if not ok:
        FAILS.append(what)


def sky_colour(d):
    """A smooth, detailed colour for each direction (unit vectors, ..., 3)."""
    waves = np.array([[1.3, 0.7, 2.1], [2.9, -1.4, 0.6], [-0.8, 2.2, 1.7], [3.7, 1.1, -2.6]])
    out = np.zeros(d.shape[:-1] + (3,))
    for c in range(3):
        v = np.zeros(d.shape[:-1])
        for k, w in enumerate(waves):
            v = v + np.sin(5.0 * (d @ w) + c * 1.7 + k) / (k + 1)
        out[..., c] = v
    # a fixed range (the waves' amplitudes sum to 2.08): a range taken from each face would colour the faces differently
    out = np.clip((out / 2.1 + 1.0) / 2.0, 0.0, 1.0)
    return (out * 255).astype(np.uint8)


def cube(n):
    """Faces by position round the ring (0..3), and the two caps, n pixels square."""
    t = (np.arange(n) + 0.5) / n * 2 - 1
    u, v = np.meshgrid(t, t)               # u across the columns, v down the rows
    z = np.array([0.0, 0.0, 1.0])
    faces = {}
    for k in range(4):
        th = np.deg2rad(90 * k)
        f = np.array([np.cos(th), np.sin(th), 0.0])
        r = np.array([-np.sin(th), np.cos(th), 0.0])
        d = f + u[..., None] * r - v[..., None] * z
        faces[k] = sky_colour(d / np.linalg.norm(d, axis=-1, keepdims=True))
    x, y = np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0])
    for name, sgn in (("up", 1.0), ("dn", -1.0)):
        d = sgn * z + u[..., None] * x + v[..., None] * y
        faces[name] = sky_colour(d / np.linalg.norm(d, axis=-1, keepdims=True))
    return faces


def named(faces_by_pos, mapping):
    """mapping: suffix -> ring position, for the four sides."""
    out = {s: faces_by_pos[k] for s, k in mapping.items()}
    out["up"], out["dn"] = faces_by_pos["up"], faces_by_pos["dn"]
    return out


def lanczos4(rgb):
    return sk._lanczos(rgb, (rgb.shape[0] * SCALE, rgb.shape[1] * SCALE))


def edge_error(a, b, band):
    """Mean absolute difference over the `band` pixels along the four borders."""
    d = np.abs(a.astype(np.float32) - b.astype(np.float32)).mean(axis=2)
    m = np.zeros(d.shape, dtype=bool)
    m[:band, :] = m[-band:, :] = m[:, :band] = m[:, -band:] = True
    return float(d[m].mean())


def test_ring_and_caps():
    print("the ring, the caps, the geometry")
    small, big = cube(N), cube(N * SCALE)
    for mapping in ({"ft": 0, "rt": 1, "bk": 2, "lf": 3}, {"ft": 2, "rt": 1, "bk": 0, "lf": 3}):
        faces, truth = named(small, mapping), named(big, mapping)
        res = sk.upscale_set(faces, lanczos4, model_scale=SCALE, pad=16)
        # the right neighbour of position k is k+1
        pos = [mapping[s] for s in res.ring]
        check(all(pos[(i + 1) % 4] == (pos[i] + 1) % 4 for i in range(4)),
              "ring found for %s: %s (cost %.2f, runner-up %.2f)" % (mapping, res.ring, res.ring_cost, res.ring_runner_up))
        check(res.ring_joined, "the sides were joined into one strip")
        check(res.caps_joined == {"up": True, "dn": True}, "both caps found their neighbours: %s" % res.caps_joined)
        check(all(res.faces[s].shape == (N * SCALE, N * SCALE, 3) for s in sk.SUFFIXES), "all six faces are %d px" % (N * SCALE))

        band = 6
        for s in sk.SUFFIXES:
            alone = edge_error(lanczos4(faces[s]), truth[s], band)
            joined = edge_error(res.faces[s], truth[s], band)
            check(joined < alone, "%s: edge error %.2f with neighbours, %.2f alone" % (s, joined, alone))

        # the cap's neighbours must beat reflected padding, or they are on the wrong side
        sides = {s: faces[s] for s in sk.SIDES}
        for cap, row in (("up", 0), ("dn", -1)):
            nb = sk.cap_neighbours(faces[cap], sides, row)
            pad = 16
            for label, nbr in (("neighbours", nb), ("reflected", {})):
                p = sk._pad_cap(faces[cap], sides, row, nbr, pad)
                got = lanczos4(p)[pad * SCALE:(pad + N) * SCALE, pad * SCALE:(pad + N) * SCALE]
                err = edge_error(got, truth[cap], band)
                if label == "neighbours":
                    e_nb = err
                else:
                    e_rf = err
            check(e_nb < e_rf, "%s: padded with its neighbours %.2f, reflected %.2f" % (cap, e_nb, e_rf))

        sr = sk.seam_report(faces, {s: res.faces[s] for s in sk.SUFFIXES}, res, SCALE)
        check(sr["result"] <= sr["lanczos"] * 1.5 + 0.5,
              "ring seam error: source %.2f, Lanczos %.2f, result %.2f" % (sr["source"], sr["lanczos"], sr["result"]))


def test_flat_and_noise():
    print("a flat sky, and a sky with no structure")
    flat = {s: np.full((N, N, 3), 90, dtype=np.uint8) for s in sk.SUFFIXES}
    res = sk.upscale_set(flat, lanczos4, model_scale=SCALE)
    check(res.ring_joined and all(res.faces[s].shape[0] == N * SCALE for s in sk.SUFFIXES), "one flat colour: done, strip joined")
    grad = np.tile(np.linspace(40, 200, N, dtype=np.uint8)[:, None, None], (1, N, 3))
    banded = {s: grad.copy() for s in sk.SIDES}
    banded["up"] = np.full((N, N, 3), 30, dtype=np.uint8)
    banded["dn"] = np.full((N, N, 3), 220, dtype=np.uint8)
    res = sk.upscale_set(banded, lanczos4, model_scale=SCALE)
    check(res.ring_joined and all(res.faces[s].shape[0] == N * SCALE for s in sk.SUFFIXES),
          "a vertical gradient round the sides, flat caps: done (caps joined: %s)" % res.caps_joined)
    rng = np.random.default_rng(3)
    noise = {s: rng.integers(0, 256, (N, N, 3), dtype=np.uint8) for s in sk.SUFFIXES}
    res = sk.upscale_set(noise, lanczos4, model_scale=SCALE)
    check(not res.ring_joined and res.caps_joined == {"up": False, "dn": False},
          "noise: nothing is believed, the faces are done one at a time (joined=%s caps=%s)" % (res.ring_joined, res.caps_joined))
    check(all(res.faces[s].shape == (N * SCALE, N * SCALE, 3) for s in sk.SUFFIXES), "noise: all six faces are the right size")
    steps = []
    sk.upscale_set(noise, lanczos4, model_scale=SCALE, on_step=lambda d, t, l: steps.append((d, t)))
    check(steps[-1] == (6, 6), "progress reaches 6 of 6 when the sides go one at a time: %s" % steps[-1:])


def test_scale_and_blend():
    print("a smaller scale, and the blend")
    faces = named(cube(N), {"ft": 0, "rt": 1, "bk": 2, "lf": 3})
    res = sk.upscale_set(faces, lanczos4, model_scale=SCALE, out_scale=2)
    check(all(res.faces[s].shape == (N * 2, N * 2, 3) for s in sk.SUFFIXES), "out_scale 2 gives %d px faces" % (N * 2))

    def sharp(rgb):
        big = lanczos4(rgb).astype(np.int16)
        return np.clip(big + 40, 0, 255).astype(np.uint8)       # a "model" that shifts every pixel

    full = sk.upscale_set(faces, sharp, model_scale=SCALE, blend=1.0)
    none = sk.upscale_set(faces, sharp, model_scale=SCALE, blend=0.0)
    lanc = sk.upscale_set(faces, lanczos4, model_scale=SCALE, blend=1.0)
    d_full = float(np.abs(full.faces["ft"].astype(int) - lanc.faces["ft"].astype(int)).mean())
    d_none = float(np.abs(none.faces["ft"].astype(int) - lanc.faces["ft"].astype(int)).mean())
    check(d_full > 20 and d_none < 1.0, "blend 1.0 keeps the model's result (%.1f off), blend 0.0 is Lanczos (%.2f off)" % (d_full, d_none))


def test_max_drift():
    print("a face the model would invent on is mixed back toward Lanczos")
    faces = named(cube(N), {"ft": 0, "rt": 1, "bk": 2, "lf": 3})
    rng = np.random.default_rng(5)

    def noisy(rgb):
        big = lanczos4(rgb).astype(np.int16)
        return np.clip(big + rng.integers(-90, 91, big.shape), 0, 255).astype(np.uint8)

    free = sk.upscale_set(faces, noisy, model_scale=SCALE, blend=1.0)
    held = sk.upscale_set(faces, noisy, model_scale=SCALE, blend=1.0, max_drift=4.0)
    check(min(free.drifts.values()) > 4.0 and all(w == 1.0 for w in free.blends.values()),
          "no limit: every face keeps the whole model, drifts %s" % {s: round(d, 1) for s, d in free.drifts.items()})
    check(all(d <= 4.0 * sk.SETTLE + 1e-6 for d in held.drifts.values()),
          "limit 4.0: every face is brought well inside it, to %.1f or less (%s)" % (4.0 * sk.SETTLE, {s: round(d, 1) for s, d in held.drifts.items()}))
    near = sk.upscale_set(faces, noisy, model_scale=SCALE, blend=1.0, max_drift=max(free.drifts.values()) + 1.0)
    check(all(w == 1.0 for w in near.blends.values()), "a limit above every face's drift changes nothing")
    check(all(held.blends[s] < 1.0 for s in sk.SUFFIXES), "limit 4.0: the model share came down (%s)" % held.blends)
    check(len({held.blends[s] for s in sk.SIDES}) == 1, "the four sides share one blend")


def test_find_and_write():
    print("finding sets, writing TGAs")
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        names = []
        for stem in ("neuro", "construct_", "3dm_bikini"):
            for suf, up in (("rt", "Rt"), ("bk", "bk"), ("lf", "LF"), ("ft", "ft"), ("up", "Up"), ("dn", "dn")):
                names.append(stem + (up if stem == "3dm_bikini" else suf) + ".tga")
        names += ["halfrt.tga", "halfbk.tga", "readme.txt", "wall.tga"]
        for n in names:
            (td / n).write_bytes(b"x")
        got, partial = sk.find_sets(sorted(td.iterdir()))
        check([s.stem for s in got] == ["3dm_bikini", "construct_", "neuro"], "complete sets: %s" % [s.stem for s in got])
        check([s.stem for s in partial] == ["half"], "incomplete sets are reported apart: %s" % [s.stem for s in partial])
        check(got[1].out_name("up") == "construct_up.tga", "an output keeps the stem and writes a lower-case suffix: %s" % got[1].out_name("up"))

        face = (np.random.default_rng(1).integers(0, 256, (32, 32, 3))).astype(np.uint8)
        p = td / "o" / "x.tga"
        sk.save_tga_rgb(p, face)
        head = p.read_bytes()[:18]
        check(head[2] == 10 and head[16] == 24, "TGA header: type %d (10 is RLE), %d bits" % (head[2], head[16]))
        check(np.array_equal(sk.load_rgb(p), face), "the TGA reads back to the same pixels")


if __name__ == "__main__":
    test_ring_and_caps()
    test_flat_and_noise()
    test_scale_and_blend()
    test_max_drift()
    test_find_and_write()
    print()
    print("FAILED: %d" % len(FAILS) if FAILS else "all checks passed")
    sys.exit(1 if FAILS else 0)
