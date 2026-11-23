"""Skybox sets: finding them, and upscaling the six faces so the seams between them still meet.

A GoldSrc sky is six square pictures named <set>rt, <set>bk, <set>lf, <set>ft, <set>up, <set>dn
(Quake style puts an underscore before the suffix). The engine reads them from gfx/env/, and from
materials/gfx/env/ first when texture replacement is on (engine-h9-hdsky.patch).

Upscaling the six as six separate pictures makes a visible line along every edge of the cube. The
model sees a face with a border and invents detail that stops there, so the sharp detail on one side
of an edge does not continue on the other. Two things prevent that, both done here:

  * The four sides go round the cube in a ring. They are joined into one wide strip, with a few
    pixels of the far end wrapped round to each end, upscaled as one picture, and cut apart again.
    Every seam inside the strip is ordinary picture to the model.
  * The up and down faces are padded with the rows of the side faces that really sit beside them
    before they go to the model, and the padding is cut off afterwards.

Which side is beside which is not assumed. It is read from the pictures: the arrangement whose edges
agree best is the arrangement. When the pictures do not say (a flat colour, a sky with no detail
at the edge) the faces are done one at a time with reflected padding, and the result says so.

Nothing here knows about a model. The caller passes `run`, a function from an RGB picture to the
model's own enlargement of it, so the same code serves the ONNX runner in this program and the torch
runner in tools/texpack/skies.py.
"""
from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

SUFFIXES = ("rt", "bk", "lf", "ft", "up", "dn")
SIDES = ("ft", "rt", "bk", "lf")          # the four faces that go round, in the engine's own naming
SKY_RE = re.compile(r"^(?P<stem>.+?)(?P<suf>rt|bk|lf|ft|up|dn)$", re.IGNORECASE)
PICTURE_SUFFIXES = {".tga", ".png", ".bmp", ".jpg", ".jpeg"}
# the engine looks for a sky as dds, tga or bmp (ref_common.c CheckSkybox): TGA is what is written
OUT_SUFFIX = ".tga"
# an arrangement is believed when its cost is at most this fraction of the runner-up's ...
CONFIDENT = 0.85
# ... or when the edges are so alike (a sum of four mean differences below this) that no arrangement matters
FLAT = 2.0


@dataclass
class SkySet:
    stem: str                                   # "neuro", "construct_": everything before the face suffix
    paths: dict = field(default_factory=dict)   # suffix -> Path

    def complete(self) -> bool:
        return all(s in self.paths for s in SUFFIXES)

    def out_name(self, suffix: str) -> str:
        return self.stem + suffix + OUT_SUFFIX


def find_sets(paths) -> tuple[list[SkySet], list[SkySet]]:
    """Group pictures into sets by name. Returns (complete sets, incomplete ones)."""
    by_stem: dict[str, SkySet] = {}
    for p in paths:
        p = Path(p)
        if p.suffix.lower() not in PICTURE_SUFFIXES:
            continue
        m = SKY_RE.match(p.stem)
        if not m:
            continue
        stem = m.group("stem")
        suf = m.group("suf").lower()
        key = stem.lower()
        s = by_stem.setdefault(key, SkySet(stem))
        # a PNG beside a TGA of the same face: the TGA is the game's own, keep it
        if suf not in s.paths or p.suffix.lower() == ".tga":
            s.paths[suf] = p
    sets = sorted(by_stem.values(), key=lambda s: s.stem.lower())
    return [s for s in sets if s.complete()], [s for s in sets if not s.complete()]


def load_rgb(path) -> np.ndarray:
    with Image.open(path) as im:
        return np.asarray(im.convert("RGB"), dtype=np.uint8)


def save_tga_rgb(path, rgb: np.ndarray, rle: bool = True) -> None:
    """24-bit TGA, run-length encoded. A sky has no alpha, and the engine reads type 2 and 10."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, mode="RGB").save(path, format="TGA", compression="tga_rle" if rle else None)


# ------------------------------------------------------------------ which face is beside which
def _l1(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(a.astype(np.float32) - b.astype(np.float32)).mean())


def ring_order(faces: dict) -> tuple[list[str], float, float]:
    """The four sides in the order they stand round the cube, left to right.

    Returns (order, cost, runner_up_cost). order[i]'s right edge meets order[i+1]'s left edge, and the
    last meets the first. The cost of an arrangement is how far apart the pixel columns on each side
    of its four seams are; the best arrangement wins, and the runner-up says how clear the win was.
    """
    first, rest = SIDES[0], SIDES[1:]
    costs = []
    for perm in itertools.permutations(rest):
        order = [first, *perm]
        c = 0.0
        for i in range(4):
            a, b = order[i], order[(i + 1) % 4]
            c += _l1(faces[a][:, -1], faces[b][:, 0])
        costs.append((c, order))
    costs.sort(key=lambda t: t[0])
    return costs[0][1], costs[0][0], costs[1][0]


def _cap_edges(cap: np.ndarray) -> dict:
    return {"top": cap[0, :], "bottom": cap[-1, :], "left": cap[:, 0], "right": cap[:, -1]}


def cap_neighbours(cap: np.ndarray, sides: dict, row: int) -> dict:
    """For one of up/dn, which side sits against each of its four edges, and the right way round.

    `row` is the row of a side face that touches the cap: 0 for up, -1 for dn. Returns
    {edge: (side suffix, reversed)} for the arrangement of all four whose edges agree best, or an
    empty dict when no arrangement beats a plain one by enough to be believed.
    """
    edges = _cap_edges(cap)
    names = list(edges)
    best = None
    scores = []
    for perm in itertools.permutations(SIDES):
        for flips in itertools.product((False, True), repeat=4):
            c = 0.0
            for e, s, f in zip(names, perm, flips):
                line = sides[s][row, :]
                c += _l1(edges[e], line[::-1] if f else line)
            scores.append(c)
            if best is None or c < best[0]:
                best = (c, perm, flips)
    scores.sort()
    if not (scores[0] < FLAT or scores[0] <= CONFIDENT * scores[1]):
        return {}
    return {e: (s, f) for e, s, f in zip(names, best[1], best[2])}


# ---------------------------------------------------------------------------------- padding
def _wrap_strip(order_faces: list[np.ndarray], pad: int) -> np.ndarray:
    strip = np.concatenate(order_faces, axis=1)
    last, first = order_faces[-1], order_faces[0]
    return np.concatenate([last[:, last.shape[1] - pad:], strip, first[:, :pad]], axis=1)


def _pad_cap(cap: np.ndarray, sides: dict, row: int, nb: dict, pad: int) -> np.ndarray:
    """The cap with `pad` pixels round it: its neighbours' rows where known, reflected otherwise."""
    n = cap.shape[0]
    out = np.pad(cap, ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
    for edge, (s, rev) in nb.items():
        face = sides[s]
        near = face[:pad] if row == 0 else face[-pad:][::-1]       # row 0 of `near` touches the cap
        if rev:
            near = near[:, ::-1]
        if edge == "top":
            out[:pad, pad:pad + n] = near[::-1]
        elif edge == "bottom":
            out[pad + n:, pad:pad + n] = near
        elif edge == "left":
            out[pad:pad + n, :pad] = np.transpose(near[::-1], (1, 0, 2))
        else:
            out[pad:pad + n, pad + n:] = np.transpose(near, (1, 0, 2))
    return out


def _lanczos(rgb: np.ndarray, size) -> np.ndarray:
    return np.asarray(Image.fromarray(rgb).resize((size[1], size[0]), Image.LANCZOS), dtype=np.uint8)


def _prepare(padded: np.ndarray, run, model_scale: int, out_scale: int | None):
    """The model's enlargement of a padded picture, and a Lanczos one, both at the size wanted."""
    raw = run(padded)
    size = raw.shape[:2]
    if out_scale and int(out_scale) != model_scale:
        size = (padded.shape[0] * int(out_scale), padded.shape[1] * int(out_scale))
        raw = _lanczos(raw, size)
    return raw, _lanczos(padded, size)


def _mix(raw: np.ndarray, lanc: np.ndarray, w: float) -> np.ndarray:
    """w of the model's result and the rest of a Lanczos enlargement (1.0 all model, 0.0 all Lanczos)."""
    if w >= 0.999:
        return raw
    if w <= 0.001:
        return lanc
    return np.clip(raw.astype(np.float32) * w + lanc.astype(np.float32) * (1.0 - w), 0, 255).astype(np.uint8)


BLEND_STEPS = (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0)


# a face over the limit is brought to this fraction of it, not to its edge: at the edge the invention is
# still plainly there (a noisy floor that passed at 6.2 of a 6.5 limit still looked like chain mail)
SETTLE = 0.65


def _choose(raw, lanc, src, blend: float, max_drift):
    """The model share to use for one face: `blend` unless the model invented on it.

    The model reads grain and dither as detail and substitutes something sharper and wrong (a grassy
    ground came back as dark veins). A face whose result moves further than `max_drift` from its source
    (shrunk back and compared: see drift) is one of those, and is mixed back toward Lanczos, which
    invents nothing, until it is well inside the limit. A face within the limit keeps `blend` exactly, so
    crisp art the model improves is not touched. With no limit, `blend` is used as it is.
    """
    first = _mix(raw, lanc, blend)
    d = drift(src, first)
    if max_drift is None or d <= max_drift:
        return first, blend, d
    res, w = first, blend
    for w in [s for s in BLEND_STEPS if s < blend - 1e-6]:
        res = _mix(raw, lanc, w)
        d = drift(src, res)
        if d <= max_drift * SETTLE:
            break
    return res, w, d


# ------------------------------------------------------------------------------- the whole set
@dataclass
class SetResult:
    faces: dict                 # suffix -> upscaled RGB
    ring: list                  # the order the sides were joined in
    ring_cost: float
    ring_runner_up: float
    ring_joined: bool           # False: the sides were done one at a time
    caps_joined: dict           # {"up": bool, "dn": bool}
    blends: dict = field(default_factory=dict)   # suffix -> the model share each face ended up with
    drifts: dict = field(default_factory=dict)   # suffix -> its drift from the source


def upscale_set(faces: dict, run, model_scale: int = 4, blend: float = 1.0, out_scale: int | None = None,
                pad: int = 16, max_drift: float | None = None, on_step=None) -> SetResult:
    """Upscale the six RGB faces of one sky.

    `run` takes an RGB uint8 picture and returns the model's enlargement of it (model_scale times
    bigger each way). `blend` is the model's share against Lanczos (1.0 all model). `max_drift`, when
    given, lowers that share for any face that would move further than that from its source (see
    _choose); the four sides keep one share, the lowest any of them needed, so the seams between them
    stay alike. `out_scale` is the scale wanted when it is not the model's. `on_step(done, total,
    label)` is called after each run of the model.
    """
    sizes = {faces[s].shape for s in SUFFIXES}
    if len(sizes) != 1 or faces["rt"].shape[0] != faces["rt"].shape[1]:
        raise ValueError("the six faces are not all the same square size: %s" % sorted(sizes))
    n = faces["rt"].shape[0]
    pad = max(0, min(pad, n // 2))
    scale = out_scale or model_scale
    out: dict = {}
    blends: dict = {}
    drifts: dict = {}

    order, cost, runner = ring_order(faces)
    joined = cost < FLAT or cost <= CONFIDENT * runner
    total = 3 if joined else 6
    done = 0

    def step(label):
        nonlocal done
        done += 1
        if on_step:
            on_step(done, total, label)

    def cut(a, i):
        left = pad * scale
        return a[:, left + i * n * scale: left + (i + 1) * n * scale]

    def inner(a):
        return a[pad * scale:(pad + n) * scale, pad * scale:(pad + n) * scale]

    if joined:
        strip = _wrap_strip([faces[s] for s in order], pad)
        raw, lanc = _prepare(strip, run, model_scale, out_scale)
        picks = {s: _choose(cut(raw, i), cut(lanc, i), faces[s], blend, max_drift) for i, s in enumerate(order)}
        w = min(p[1] for p in picks.values())
        for i, s in enumerate(order):
            out[s] = cut(raw, i) if w >= 0.999 else _mix(cut(raw, i), cut(lanc, i), w)
            blends[s] = w
            drifts[s] = drift(faces[s], out[s])
        step("sides")
    else:
        for s in SIDES:
            padded = np.pad(faces[s], ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
            raw, lanc = _prepare(padded, run, model_scale, out_scale)
            out[s], blends[s], drifts[s] = _choose(inner(raw), inner(lanc), faces[s], blend, max_drift)
            step(s)

    sides = {s: faces[s] for s in SIDES}
    caps_joined = {}
    for cap, row in (("up", 0), ("dn", -1)):
        nb = cap_neighbours(faces[cap], sides, row)
        caps_joined[cap] = bool(nb)
        padded = _pad_cap(faces[cap], sides, row, nb, pad)
        raw, lanc = _prepare(padded, run, model_scale, out_scale)
        out[cap], blends[cap], drifts[cap] = _choose(inner(raw), inner(lanc), faces[cap], blend, max_drift)
        step(cap)

    return SetResult({s: np.ascontiguousarray(out[s]) for s in SUFFIXES}, order, cost, runner, joined,
                     caps_joined, blends, drifts)


# ---------------------------------------------------------------------------------- checking
def drift(src_rgb: np.ndarray, big_rgb: np.ndarray) -> float:
    """How far the enlargement moved from its source when shrunk back (lower is more faithful)."""
    h, w = src_rgb.shape[:2]
    back = Image.fromarray(big_rgb).resize((w, h), Image.BOX)
    return float(np.abs(np.asarray(back, dtype=np.float32) - src_rgb.astype(np.float32)).mean())


def seam_error(faces: dict, order: list) -> float:
    """Mean difference across the four seams of the ring: small when the sides still meet."""
    return sum(_l1(faces[order[i]][:, -1], faces[order[(i + 1) % 4]][:, 0]) for i in range(4)) / 4.0


def seam_report(src: dict, big: dict, result: SetResult, model_scale: int = 4) -> dict:
    """The ring's seam error in the source, in a plain Lanczos enlargement, and in the result.

    The result is fine when it is not much worse than the Lanczos one: Lanczos invents nothing, so it
    is as continuous across an edge as the original was.
    """
    out_n = next(iter(big.values())).shape[0]
    lanc = {s: _lanczos(src[s], (out_n, out_n)) for s in SIDES}
    return {"source": seam_error(src, result.ring), "lanczos": seam_error(lanc, result.ring),
            "result": seam_error(big, result.ring)}
