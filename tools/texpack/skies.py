"""texpack/skies.py -- upscale the game's sky sets and place them where the engine looks for HD art.

The mod's skies are 25 sets of six loose TGAs in H9XASH\\ts\\gfx\\env (name + rt, bk, lf, ft, up, dn).
The engine reads them by worldspawn's skyname, not through a wad, a map or a model, so extract.mjs and
place.mjs never see them. With texture replacement on, engine-h9-hdsky.patch looks for the same
names under materials\\gfx\\env first, which is where this writes:

    H9XASH\\ts\\materials\\gfx\\env\\<set><suffix>.tga     24-bit, run-length encoded

A set is used whole or not at all: five faces here and one missing and the game falls back to the
original set. This writes all six or none.

Cube edges. The faces are not upscaled one by one, which leaves a line along every edge of the cube.
The four sides go through the model as one wrapped strip and the up and down faces are padded with
the real rows of the sides beside them. core/skybox.py in tools/upscaler_gui does that, and is the
same code the window uses, so a sky made in the window and a sky made here meet at their edges the
same way. Which face is beside which is read from the pictures, not assumed.

    py -3 skies.py --list                    what is there, and what is already current
    py -3 skies.py --only neuro              one set
    py -3 skies.py                           every set that is not current
    py -3 skies.py --blend 0.5               use at most half the model (1.0 all model, 0.0 all Lanczos)
    py -3 skies.py --max-drift 5             a tighter ceiling on how far a face may move from its source
    py -3 skies.py --preview D:\\temp\\sky    also write a contact sheet and 1:1 crops per set

Resumable and a delta: a set whose pictures, model and settings have not changed since it was made is
skipped. It takes the project's heavy-job lock for the run, like upscale.py.

Exit 0 = done, 2 = nothing found, 3 = the heavy lock is held, 4 = no CUDA device.

The files this makes are part of the HD pack. publish_files.py walks all of ts/materials, so they
publish as ts/materials/gfx/env/... with every other HD texture, and the updater's --hd installs
them from that manifest with the rest. Nothing about them is special to the pipeline.
"""
import argparse
import hashlib
import json
import signal
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "tools" / "upscaler_gui"))

from upscale import HeavyLock, load_model, run_tiled, LOCK  # noqa: E402
from core import skybox as sk  # noqa: E402

HOLDER = "texpack skies"
# bump when the way a set is made changes, so every set is made again
ALGORITHM = "sky1"
# the default ceiling for a face's drift from its source (see core/skybox.py _choose). Looked at in
# the 25 sets: crisp dots, skylines and clouds sit at 2 to 6.5 and look right; a grainy ground came
# back as dark veins at 17 and a noisy floor as crackle at 9.
DRIFT_LIMIT = 6.5


def recipe_of(model_path, args):
    model_sha = hashlib.sha256(Path(model_path).read_bytes()).hexdigest()
    parts = [model_sha, ALGORITHM, str(args.scale), "%.3f" % args.blend, str(args.pad), "%.2f" % (args.max_drift or 0), "tga24rle"]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16], model_sha


def source_key(faces):
    h = hashlib.sha256()
    for s in sk.SUFFIXES:
        h.update(faces[s].tobytes())
        h.update(str(faces[s].shape).encode())
    return h.hexdigest()


def load_manifest(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf8"))
    except (OSError, ValueError):
        return {"sets": {}}


def save_manifest(path, man):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    tmp = str(path) + ".tmp"
    Path(tmp).write_text(json.dumps(man, indent=1, sort_keys=True), encoding="utf8")
    Path(tmp).replace(path)


def current(man, s, rid, key, dest_dir):
    row = man.get("sets", {}).get(s.stem.lower())
    if not row or row.get("recipe") != rid or row.get("source") != key:
        return False
    return all((dest_dir / s.out_name(suf)).is_file() for suf in sk.SUFFIXES)


def contact_sheet(src, res, big_scale):
    """The sides in ring order at half size, so a seam shows, then up and down."""
    half = []
    for suf in res.ring:
        im = Image.fromarray(res.faces[suf])
        half.append(im.resize((im.width // 2, im.height // 2), Image.LANCZOS))
    w = sum(i.width for i in half)
    h = half[0].height
    sheet = Image.new("RGB", (w, h + h // 2 + 8), (12, 12, 16))
    x = 0
    for i in half:
        sheet.paste(i, (x, 0))
        x += i.width
    for k, cap in enumerate(("up", "dn")):
        im = Image.fromarray(res.faces[cap]).resize((h // 2, h // 2), Image.LANCZOS)
        sheet.paste(im, (k * (h // 2 + 8), h + 8))
    return sheet


def crops(src, res, scale, side=384):
    """1:1 crops of the face with the most detail: original (nearest), Lanczos, result."""
    best = max(sk.SUFFIXES, key=lambda s: float(np.abs(np.diff(src[s].astype(np.int16), axis=1)).mean()))
    big = res.faces[best]
    n = big.shape[0]
    c = min(side, n)
    y0 = x0 = (n - c) // 2
    nearest = np.asarray(Image.fromarray(src[best]).resize((n, n), Image.NEAREST))
    lanc = sk._lanczos(src[best], (n, n))
    row = np.concatenate([a[y0:y0 + c, x0:x0 + c] for a in (nearest, lanc, big)], axis=1)
    return best, Image.fromarray(row)


def main():
    ap = argparse.ArgumentParser(description="Upscale the game's sky sets for the HD pack")
    ap.add_argument("--src", default=str(REPO / "H9XASH" / "ts" / "gfx" / "env"))
    ap.add_argument("--dest", default=str(REPO / "H9XASH" / "ts" / "materials"),
                    help="the materials folder; the sets go in <dest>\\gfx\\env")
    ap.add_argument("--work", default=r"D:\temp\texpack")
    ap.add_argument("--model", default=r"D:\temp\texpack\model\4xLSDIRplus.pth")
    ap.add_argument("--only", default="", help="comma-separated set names, e.g. neuro,blue")
    ap.add_argument("--scale", type=int, default=4, choices=(2, 3, 4),
                    help="size of the result against the original; the model is 4x, a smaller one comes down from it")
    ap.add_argument("--blend", type=float, default=1.0,
                    help="the most of the model to use against a plain Lanczos enlargement: 1.0 all model, 0.0 all Lanczos;"
                         " --max-drift lowers it for a face that needs it")
    ap.add_argument("--max-drift", type=float, default=DRIFT_LIMIT,
                    help="a face that would move further than this from its source (shrunk back and compared) has its"
                         " model share lowered until it does not; 0 turns the limit off")
    ap.add_argument("--pad", type=int, default=16, help="pixels of neighbouring face round each one")
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--redo", action="store_true", help="make the sets again even when they are current")
    ap.add_argument("--list", action="store_true", help="say what is there and exit")
    ap.add_argument("--preview", default="", help="a folder for a contact sheet and a 1:1 crop of each set")
    ap.add_argument("--no-lock", action="store_true")
    args = ap.parse_args()
    args.max_drift = args.max_drift or None

    src_dir = Path(args.src)
    dest_dir = Path(args.dest) / "gfx" / "env"
    files = sorted(p for p in src_dir.glob("*") if p.is_file())
    sets, partial = sk.find_sets(files)
    if args.only:
        want = {w.strip().lower() for w in args.only.split(",") if w.strip()}
        sets = [s for s in sets if s.stem.lower().rstrip("_") in want or s.stem.lower() in want]
    for p in partial:
        print("incomplete set, left alone: %s (%s)" % (p.stem, ",".join(sorted(p.paths))))
    if not sets:
        print("no complete sky set in %s" % src_dir)
        return 2

    model_path = Path(args.model)
    if not model_path.is_file():
        print("no model at %s" % model_path)
        return 2
    rid, model_sha = recipe_of(model_path, args)
    man_path = Path(args.work) / "sky-manifest.json"
    man = load_manifest(man_path)
    print("recipe %s (model %s...), %d set(s), into %s" % (rid, model_sha[:12], len(sets), dest_dir))

    todo = []
    for s in sets:
        faces = {suf: sk.load_rgb(s.paths[suf]) for suf in sk.SUFFIXES}
        sizes = sorted({f.shape[:2] for f in faces.values()})
        key = source_key(faces)
        state = "current" if (not args.redo and current(man, s, rid, key, dest_dir)) else "to do"
        print("  %-14s %s  %s" % (s.stem, "x".join(map(str, sizes[0])) if len(sizes) == 1 else "MIXED %s" % sizes, state))
        if state == "to do":
            todo.append((s, faces, key))
    if args.list or not todo:
        print("nothing to do." if not todo else "%d set(s) to do." % len(todo))
        return 0

    import torch
    if not torch.cuda.is_available():
        print("no CUDA device")
        return 4
    device = "cuda"
    print("device: %s" % torch.cuda.get_device_name(0))

    lock = HeavyLock(LOCK, HOLDER)
    if not args.no_lock:
        lock.__enter__()
        signal.signal(signal.SIGINT, lambda *_: (lock.release(), sys.exit(130)))
    try:
        model = load_model(model_path, device)

        def run(rgb):
            return run_tiled(model, rgb, device, args.tile)

        preview = Path(args.preview) if args.preview else None
        if preview:
            preview.mkdir(parents=True, exist_ok=True)
        for s, faces, key in todo:
            t0 = time.time()
            try:
                res = sk.upscale_set(faces, run, model_scale=model.scale, blend=args.blend,
                                     out_scale=args.scale, pad=args.pad, max_drift=args.max_drift)
            except ValueError as e:
                print("  %-14s SKIPPED: %s" % (s.stem, e))
                continue
            rows = {}
            for suf in sk.SUFFIXES:
                path = dest_dir / s.out_name(suf)
                sk.save_tga_rgb(path, res.faces[suf])
                rows[suf] = {"file": path.name, "drift": round(res.drifts[suf], 2), "blend": res.blends[suf],
                             "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            sr = sk.seam_report(faces, res.faces, res, args.scale)
            n = res.faces["rt"].shape[0]
            lowered = ["%s %.1f" % (suf, res.blends[suf]) for suf in ("up", "dn") if res.blends[suf] < args.blend - 1e-6]
            if res.blends[res.ring[0]] < args.blend - 1e-6:
                lowered.insert(0, "sides %.1f" % res.blends[res.ring[0]])
            print("  %-14s %dx%d  ring %s %s  caps %s  drift %.1f%s  seams: source %.2f result %.2f  %.1fs"
                  % (s.stem, n, n, "-".join(res.ring), "(joined)" if res.ring_joined else "(NOT joined: the edges did not say)",
                     "joined" if all(res.caps_joined.values()) else "partly" if any(res.caps_joined.values()) else "reflected",
                     max(res.drifts.values()), ("  model share lowered: " + ", ".join(lowered)) if lowered else "",
                     sr["source"], sr["result"], time.time() - t0))
            man.setdefault("sets", {})[s.stem.lower()] = {
                "recipe": rid, "source": key, "faces": rows, "ring": res.ring,
                "ring_joined": res.ring_joined, "caps_joined": res.caps_joined,
                "blends": res.blends}
            save_manifest(man_path, man)
            if preview:
                contact_sheet(faces, res, args.scale).save(preview / ("%s_sheet.png" % s.stem.rstrip("_")))
                best, im = crops(faces, res, args.scale)
                im.save(preview / ("%s_%s_crops.png" % (s.stem.rstrip("_"), best)))
    finally:
        lock.release()
    print("done. The files are in %s (never in a package: they ride with the HD pack)." % dest_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
