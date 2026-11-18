"""texpack/upscale.py -- run the 4x model over the extracted textures, headless.

Reads the PNGs extract.mjs wrote, upscales each on the GPU, writes a 32-bit RLE TGA named by the
same sha256. Resumable: an output that already exists is skipped, so an interrupted run carries on
where it stopped.

It takes the project's heavy-job lock (D:\\temp\\HEAVY-JOB.lock, or H9_HEAVY_LOCK) for the whole
run and gives it back on the way out, including on Ctrl-C, so it will not overlap a map compile or
an engine build.

    py -3 upscale.py --sample 200      a stratified sample, for a real time estimate
    py -3 upscale.py                   the whole batch
    py -3 upscale.py --tile 256        smaller tiles if VRAM is tight

Masked textures (GoldSrc '{' and model alpha) keep a hard edge: the colour is bled into the
transparent area before upscaling so the model does not smear the key colour across the seam, and
the alpha is resized and re-thresholded afterwards.

Exit 0 = every image done, 3 = the heavy lock is held by someone else, 4 = no CUDA device.
"""
import argparse
import hashlib
import json
import os
import signal
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

LOCK = Path(os.environ.get("H9_HEAVY_LOCK", r"D:\temp\HEAVY-JOB.lock"))
HOLDER = "texpack upscale"

# The recipe: what an output was made WITH. Kept identical to tools/texpack/manifest.mjs, because
# the two have to agree on what "already done" means. Change either and both must change.
SCALE, FORMAT, COMPRESSION, BITS = 4, "tga", "rle", 32
# Deliberately unchanged when the threshold became conditional (threshold only a 1-bit alpha,
# keep a gradient smooth). The recipe id is a promise that an output can be vouched for, and the
# new rule is a strict superset of the old one: every source the old rule ever saw was either
# fully opaque or 1-bit, because nothing carried a gradient until extract.mjs was fixed to read
# decals and index-alpha sprites properly. On those inputs both rules produce identical bytes.
# Bumping it would mark all 6,203 outputs stale and spend hours of GPU time rewriting files that
# cannot differ.
ALPHA = "bleed4+bicubic+threshold128"


def recipe_id(model_path):
    model_sha = hashlib.sha256(Path(model_path).read_bytes()).hexdigest()
    parts = [model_sha, str(SCALE), FORMAT, COMPRESSION, str(BITS), ALPHA]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16], model_sha


def load_manifest(work):
    p = Path(work) / "manifest.json"
    if not p.exists():
        return {}, p
    try:
        return json.loads(p.read_text(encoding="utf8")).get("images", {}), p
    except (OSError, ValueError):
        return {}, p


# -- the heavy lock ---------------------------------------------------------
class HeavyLock:
    def __init__(self, path, holder):
        self.path = Path(path)
        self.holder = holder
        self.taken = False

    def __enter__(self):
        if self.path.exists():
            who = ""
            try:
                who = self.path.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                pass
            print(f"the heavy job lock is held by: {who or 'someone'}")
            print(f"  {self.path}")
            print("  wait for that job, or remove the file if it is dead")
            raise SystemExit(3)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(self.holder, encoding="ascii")
        self.taken = True
        print(f"heavy lock taken: {self.path} ({self.holder})")
        return self

    def release(self):
        if not self.taken:
            return
        try:
            if self.path.exists() and self.path.read_text(encoding="utf-8", errors="replace").strip() == self.holder:
                self.path.unlink()
                print("heavy lock released")
        except OSError as e:
            print(f"could not release the heavy lock: {e}")
        self.taken = False

    def __exit__(self, *_):
        self.release()
        return False


# -- image helpers ----------------------------------------------------------
def bleed(rgb, alpha, rounds=4):
    """Push opaque colour outward into the transparent area so a 4x pass does not drag the key
    colour across the edge. Only the colour moves; alpha is untouched."""
    out = rgb.copy()
    solid = alpha > 0
    for _ in range(rounds):
        if solid.all():
            break
        filled = solid.copy()
        acc = np.zeros_like(out, dtype=np.uint32)
        cnt = np.zeros(solid.shape, dtype=np.uint16)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(out, (dy, dx), axis=(0, 1))
            mask = np.roll(solid, (dy, dx), axis=(0, 1))
            acc[mask] += shifted[mask]
            cnt[mask] += 1
        take = (~solid) & (cnt > 0)
        out[take] = (acc[take] // cnt[take, None]).astype(np.uint8)
        filled |= take
        solid = filled
    return out


def load(path):
    im = Image.open(path)
    im = im.convert("RGBA")
    a = np.array(im, dtype=np.uint8)
    return a[:, :, :3], a[:, :, 3]


def save_tga(path, rgb, alpha, rle=True):
    arr = np.dstack([rgb, alpha])
    im = Image.fromarray(arr, mode="RGBA")
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, format="TGA", compression="tga_rle" if rle else None)


# -- the model --------------------------------------------------------------
def load_model(model_path, device):
    import torch
    from spandrel import ImageModelDescriptor, ModelLoader

    model = ModelLoader().load_from_file(str(model_path))
    if not isinstance(model, ImageModelDescriptor):
        raise SystemExit(f"{model_path.name} is not a single-image model")
    model.to(device).eval()
    if device == "cuda":
        model.model.half()
    print(f"model: {model_path.name}  scale x{model.scale}  {model.architecture.name}")
    return model


def run_tiled(model, rgb, device, tile, overlap=16):
    """RGB uint8 HxWx3 -> upscaled RGB uint8. Tiled so VRAM does not decide the texture size."""
    import torch

    scale = model.scale
    h, w, _ = rgb.shape
    out = np.zeros((h * scale, w * scale, 3), dtype=np.uint8)
    step = max(16, tile - overlap * 2)
    with torch.no_grad():
        for y in range(0, h, step):
            for x in range(0, w, step):
                y0, x0 = max(0, y - overlap), max(0, x - overlap)
                y1, x1 = min(h, y + step + overlap), min(w, x + step + overlap)
                patch = rgb[y0:y1, x0:x1]
                t = torch.from_numpy(patch).permute(2, 0, 1).unsqueeze(0).float().div_(255.0)
                t = t.to(device)
                if device == "cuda":
                    t = t.half()
                r = model(t)
                r = r.float().clamp_(0, 1).mul_(255.0).round_().byte()
                r = r.squeeze(0).permute(1, 2, 0).cpu().numpy()
                # drop the overlap margin, then place
                ty0 = (y - y0) * scale
                tx0 = (x - x0) * scale
                ey = min(step, h - y) * scale
                ex = min(step, w - x) * scale
                out[y * scale : y * scale + ey, x * scale : x * scale + ex] = r[ty0 : ty0 + ey, tx0 : tx0 + ex]
    return out


def stratified(paths, n):
    """n images spread across the size range, so a sample times like the whole batch."""
    sized = []
    for p in paths:
        try:
            with Image.open(p) as im:
                sized.append((max(im.size), p))
        except OSError:
            continue
    sized.sort()
    if n >= len(sized):
        return [p for _, p in sized]
    stride = len(sized) / n
    return [sized[int(i * stride)][1] for i in range(n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default=r"D:\temp\texpack\source")
    ap.add_argument("--out", dest="dst", default=r"D:\temp\texpack\out")
    ap.add_argument("--model", default=r"D:\temp\texpack\model\4xLSDIRplus.pth")
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--no-rle", action="store_true")
    ap.add_argument("--no-lock", action="store_true", help="for a sample run while nothing heavy is going on")
    args = ap.parse_args()

    src, dst = Path(args.src), Path(args.dst)
    paths = sorted(src.glob("*.png"))
    if not paths:
        raise SystemExit(f"no PNGs in {src}; run extract.mjs first")
    if args.sample:
        paths = stratified(paths, args.sample)
    print(f"{len(paths)} image(s) to consider")

    # the delta: an existing output is only reusable when the manifest says THIS recipe made it
    rid, model_sha = recipe_id(args.model)
    manifest, manifest_path = load_manifest(Path(args.src).parent)
    vouched = {sha for sha, e in manifest.items() if e.get("recipe") == rid}
    print(f"recipe {rid} (model {model_sha[:12]}...), manifest vouches for {len(vouched)}")

    import torch

    if not torch.cuda.is_available():
        print("no CUDA device: this would take days on the CPU")
        raise SystemExit(4)
    device = "cuda"
    print(f"device: {torch.cuda.get_device_name(0)}")

    lock = HeavyLock(LOCK, HOLDER)
    if not args.no_lock:
        lock.__enter__()
    signal.signal(signal.SIGINT, lambda *_: (lock.release(), sys.exit(130)))

    try:
        model = load_model(Path(args.model), device)
        done = skipped = 0
        px_in = px_out = 0
        t0 = time.time()
        for i, p in enumerate(paths, 1):
            out = dst / (p.stem + ".tga")
            # With no manifest yet this is the first run, so what is on disk is taken on trust and
            # stamped afterwards by manifest.mjs --write. Once a manifest exists it is the
            # authority: an output it cannot vouch for was made by another recipe and is redone.
            if out.exists() and (not manifest or p.stem in vouched):
                skipped += 1
                continue
            rgb, alpha = load(p)
            masked = bool((alpha < 255).any())
            if masked:
                rgb = bleed(rgb, alpha)
            up = run_tiled(model, rgb, device, args.tile)
            if masked:
                a = Image.fromarray(alpha, mode="L").resize(
                    (up.shape[1], up.shape[0]), Image.BICUBIC
                )
                # Two kinds of transparency reach this point and they must not be treated alike.
                #
                # A CUTOUT -- a '{' texture with a blue palette base, a SPR_ALPHTEST sprite, a
                # model skin flagged STUDIO_NF_MASKED -- is 1-bit by construction: every pixel is
                # either clear or solid. Resizing softens its edge, so it is thresholded back to a
                # hard edge, which is what the engine draws.
                #
                # A GRADIENT -- a classic decal, a SPR_INDEXALPHA sprite -- carries a smooth ramp
                # where the palette index IS the alpha. Thresholding that turns a soft crack,
                # stain or puff of smoke into a hard blob. It has to stay smooth.
                #
                # The source says which it is without any extra bookkeeping: a cutout's alpha
                # only ever holds 0 and 255.
                hard = bool(np.isin(alpha, (0, 255)).all())
                a = np.array(a)
                if hard:
                    a = (a >= 128).astype(np.uint8) * 255
                else:
                    a = a.astype(np.uint8)
            else:
                a = np.full(up.shape[:2], 255, dtype=np.uint8)
            save_tga(out, up, a, rle=not args.no_rle)
            done += 1
            px_in += rgb.shape[0] * rgb.shape[1]
            px_out += up.shape[0] * up.shape[1]
            if done % 25 == 0 or i == len(paths):
                el = time.time() - t0
                rate = done / el if el else 0
                print(f"  {i}/{len(paths)}  done={done} skipped={skipped}  "
                      f"{rate:.2f} img/s  {px_out/1e6:.0f} Mpx out  {el:.0f}s")
        el = time.time() - t0
        print("")
        print(f"upscaled {done}, skipped {skipped}, in {el:.0f}s")
        if done:
            print(f"  {done/el:.2f} images/s, {px_out/1e6/el:.2f} Mpx/s of output")
            size = sum(f.stat().st_size for f in dst.glob("*.tga"))
            print(f"  output so far: {size/1073741824:.2f} GiB over {len(list(dst.glob('*.tga')))} file(s)")
            if args.sample:
                whole = len(list(src.glob("*.png")))
                print(f"  at this rate the whole {whole} would take "
                      f"{whole/ (done/el) / 60:.0f} min and about "
                      f"{size/done*whole/1073741824:.2f} GiB")
    finally:
        lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
