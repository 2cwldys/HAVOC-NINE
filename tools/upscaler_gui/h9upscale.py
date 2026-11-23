"""H9 Upscaler -- AI texture upscaling with a window, no agent and no command line.

    py -3 h9upscale.py                 the window
    py -3 h9upscale.py --model <.onnx> a different model
    py -3 h9upscale.py --check         say what it found and exit, for a build check

It needs the model beside it as model\\4xLSDIRplus.onnx, or wherever --model points. The model is
not in git: it is 64 MB and belongs to the build, not the source. tools/upscaler_gui/README.txt
says how to make it from the .pth.

Written for Python 3.10 or newer. The only dependencies are numpy, Pillow and
onnxruntime-directml, all of which PyInstaller bundles.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
# so the package imports work whether this is run as a script or from a bundle
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def default_model() -> Path:
    for p in (HERE / "model" / "4xLSDIRplus.onnx",
              HERE / "4xLSDIRplus.onnx",
              Path(r"D:\temp\texpack\model\4xLSDIRplus.onnx")):
        if p.is_file():
            return p
    return HERE / "model" / "4xLSDIRplus.onnx"


def main() -> int:
    ap = argparse.ArgumentParser(description="H9 Upscaler")
    ap.add_argument("--model", default=None)
    ap.add_argument("--check", action="store_true",
                    help="report what is present and exit, without opening a window")
    ap.add_argument("--selftest", action="store_true",
                    help="upscale one small picture and check the result, then exit. This is what"
                         " proves a built copy works: --check only says the imports resolved")
    args = ap.parse_args()

    model = Path(args.model) if args.model else default_model()

    if args.check:
        print("model      :", model, "FOUND" if model.is_file() else "MISSING")
        try:
            import onnxruntime as ort
            print("onnxruntime:", ort.__version__)
            print("providers  :", ", ".join(ort.get_available_providers()))
        except ImportError as e:
            print("onnxruntime: MISSING (%s)" % e)
            return 1
        try:
            import numpy, PIL
            print("numpy      :", numpy.__version__)
            print("Pillow     :", PIL.__version__)
        except ImportError as e:
            print("imaging    : MISSING (%s)" % e)
            return 1
        return 0 if model.is_file() else 1

    if not model.is_file():
        print("No model at %s" % model)
        print("See tools/upscaler_gui/README.txt for how to make it from the .pth.")
        return 1

    if args.selftest:
        import time

        import numpy as np

        from engine.runner import Upscaler, faithfulness

        # a picture with a hard edge, a gradient and a transparent corner, so a failure in the
        # tiling, the blend or the alpha shows up rather than passing quietly
        n = 64
        a = np.zeros((n, n, 4), dtype=np.uint8)
        a[:, :, 3] = 255
        a[: n // 2, :, 0] = 230
        a[n // 2:, :, 2] = 200
        a[:, :, 1] = np.tile(np.linspace(0, 255, n, dtype=np.uint8), (n, 1))
        a[:8, :8, 3] = 0

        u = Upscaler(model, tile=128)
        print("provider   :", u.provider)
        t0 = time.time()
        out = u.upscale(a, blend=1.0)
        took = time.time() - t0
        s = u.scale
        ok = out.shape == (n * s, n * s, 4)
        hard = set(np.unique(out[:, :, 3]).tolist()) <= {0, 255}
        drift = faithfulness(a, out)
        print("scale      : x%d  %dx%d -> %dx%d  in %.2fs" % (s, n, n, out.shape[1], out.shape[0], took))
        print("alpha      :", "hard-edged" if hard else "SOFTENED, which would bleed in game")
        print("drift      : %.2f" % drift)
        # a skybox: four sides cut from one wide picture, so they meet along their edges, and two plain caps. The
        # sides must be found in the order they were cut and joined into one strip, and every face must come back
        # at the model's scale. This is what proves core/skybox.py made it into a build.
        from core import skybox as sk

        side = 48
        xs = np.linspace(0.0, 2 * np.pi * 3, side * 4, dtype=np.float32)
        ys = np.linspace(0.0, 1.0, side, dtype=np.float32)[:, None]
        pano = np.zeros((side, side * 4, 3), dtype=np.uint8)
        pano[:, :, 0] = (127 + 120 * np.sin(xs)[None, :] * (1.0 - ys)).astype(np.uint8)
        pano[:, :, 1] = (255 * ys).astype(np.uint8)
        pano[:, :, 2] = (127 + 120 * np.cos(xs * 0.5)[None, :]).astype(np.uint8)
        faces = {s: np.ascontiguousarray(pano[:, i * side:(i + 1) * side]) for i, s in enumerate(("ft", "rt", "bk", "lf"))}
        faces["up"] = np.full((side, side, 3), 40, dtype=np.uint8)
        faces["dn"] = np.full((side, side, 3), 200, dtype=np.uint8)
        t1 = time.time()
        sky = sk.upscale_set(faces, lambda rgb: u._tiled(rgb), model_scale=s, blend=1.0)
        sky_ok = (sky.ring == ["ft", "rt", "bk", "lf"] and sky.ring_joined
                  and all(sky.faces[f].shape == (side * s, side * s, 3) for f in sk.SUFFIXES))
        print("sky        : ring %s %s, %d faces of %dpx in %.2fs -> %s"
              % ("-".join(sky.ring), "joined" if sky.ring_joined else "NOT joined", len(sky.faces), side * s,
                 time.time() - t1, "OK" if sky_ok else "FAILED"))

        good = ok and hard and drift < 40 and sky_ok
        print("result     :", "OK" if good else "FAILED")
        return 0 if good else 1

    from ui.app import run
    run(model)
    return 0


if __name__ == "__main__":
    sys.exit(main())
