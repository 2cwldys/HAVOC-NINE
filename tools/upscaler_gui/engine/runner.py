"""The upscaler itself: ONNX Runtime, tiled, alpha-aware, with a fidelity blend.

Why ONNX and not torch. torch with CUDA is 2.5 GB and only runs on NVIDIA. The same model as
ONNX is 64 MB, and DirectML runs it on any DX12 card -- NVIDIA, AMD or Intel -- with a CPU
fallback. The conversion was checked against torch: the largest difference on any pixel was
0.000014, so nothing is lost by it.

Why the blend. The model is photo-trained. On a fine dithered weave it reads the dither as noise
and substitutes a plausible but WRONG pattern -- a mesh came back as diagonal ribbing on this
project's own armour textures. The fix is not a sharper model, it is less invention: mix the
result toward a Lanczos upscale, which invents nothing. 1.0 is the raw model, 0.25 restored that
weave, 0.0 is pure Lanczos.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

PROVIDERS = ["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]


class Upscaler:
    def __init__(self, model_path, providers=None, tile=256, overlap=16):
        import onnxruntime as ort

        want = providers or PROVIDERS
        have = set(ort.get_available_providers())
        chain = [p for p in want if p in have] or ["CPUExecutionProvider"]
        self.session = ort.InferenceSession(str(model_path), providers=chain)
        self.provider = self.session.get_providers()[0]
        self.input = self.session.get_inputs()[0].name
        self.tile = max(64, int(tile))
        self.overlap = max(0, int(overlap))
        self.scale = 4  # the shipped model; probe() corrects it on the first run
        self._probed = False

    # -- the model ---------------------------------------------------------
    def probe(self):
        """Ask the model what it actually does, rather than trusting a name."""
        if self._probed:
            return self.scale
        x = np.zeros((1, 3, 32, 32), dtype=np.float32)
        y = self.session.run(None, {self.input: x})[0]
        self.scale = int(y.shape[2] // 32)
        self._probed = True
        return self.scale

    def _run(self, rgb_f32):
        x = np.transpose(rgb_f32, (2, 0, 1))[None, ...]
        y = self.session.run(None, {self.input: x})[0]
        return np.clip(np.transpose(y[0], (1, 2, 0)), 0.0, 1.0)

    def _tiled(self, rgb_u8, on_tile=None):
        """Upscale RGB uint8 HxWx3. Tiled, so a card's memory does not cap texture size."""
        s = self.probe()
        h, w, _ = rgb_u8.shape
        out = np.zeros((h * s, w * s, 3), dtype=np.uint8)
        step = max(16, self.tile - self.overlap * 2)
        src = rgb_u8.astype(np.float32) / 255.0
        total = ((h + step - 1) // step) * ((w + step - 1) // step)
        n = 0
        for y in range(0, h, step):
            for x in range(0, w, step):
                y0, x0 = max(0, y - self.overlap), max(0, x - self.overlap)
                y1, x1 = min(h, y + step + self.overlap), min(w, x + step + self.overlap)
                piece = self._run(src[y0:y1, x0:x1])
                piece = (piece * 255.0).round().astype(np.uint8)
                ty, tx = (y - y0) * s, (x - x0) * s
                ey, ex = min(step, h - y) * s, min(step, w - x) * s
                out[y * s:y * s + ey, x * s:x * s + ex] = piece[ty:ty + ey, tx:tx + ex]
                n += 1
                if on_tile:
                    on_tile(n, total)
        return out

    # -- alpha -------------------------------------------------------------
    @staticmethod
    def _bleed(rgb, alpha, rounds=4):
        """Push opaque colour outward into the transparent area.

        A masked texture's see-through pixels still hold a colour, usually the key colour. Upscale
        without this and the model drags that key across the edge, leaving a halo.
        """
        out = rgb.copy()
        solid = alpha > 0
        for _ in range(rounds):
            if solid.all():
                break
            acc = np.zeros_like(out, dtype=np.uint32)
            cnt = np.zeros(solid.shape, dtype=np.uint16)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                shifted = np.roll(out, (dy, dx), axis=(0, 1))
                mask = np.roll(solid, (dy, dx), axis=(0, 1))
                acc[mask] += shifted[mask]
                cnt[mask] += 1
            take = (~solid) & (cnt > 0)
            out[take] = (acc[take] // cnt[take, None]).astype(np.uint8)
            solid = solid | take
        return out

    # -- the whole job -----------------------------------------------------
    def upscale(self, rgba_u8, blend=1.0, on_tile=None, out_scale=None):
        """RGBA uint8 in, RGBA uint8 out.

        `blend` mixes the model's result toward a Lanczos upscale of the same source: 1.0 all
        model, 0.0 all Lanczos. Alpha never goes through the model -- it is resized and
        re-thresholded, because a GoldSrc mask is hard-edged and a soft one bleeds in game.

        `out_scale` is the size you want, which need not be the model's. The model is a 4x one and
        cannot be asked for less, so a smaller target is reached by running it at 4x and bringing
        the result down. That is not the same as resizing the original by 2: the detail the model
        recovered survives the reduction, so a 2x made this way beats a plain 2x resize. It also
        costs a quarter of the bytes of a 4x, which is the difference between a 10 GB pack and a
        2.6 GB one.
        """
        rgb, alpha = rgba_u8[:, :, :3], rgba_u8[:, :, 3]
        masked = bool((alpha < 255).any())
        src = self._bleed(rgb, alpha) if masked else rgb

        big = self._tiled(src, on_tile=on_tile)
        s = self.scale

        if blend < 0.999:
            lanc = Image.fromarray(src).resize((big.shape[1], big.shape[0]), Image.LANCZOS)
            w = max(0.0, min(1.0, float(blend)))
            big = np.clip(big.astype(np.float32) * w
                          + np.asarray(lanc, dtype=np.float32) * (1.0 - w), 0, 255).astype(np.uint8)

        # bring it to the asked-for size, if that is not the model's own
        if out_scale and int(out_scale) != s:
            h, w = rgba_u8.shape[:2]
            tw, th = int(w * out_scale), int(h * out_scale)
            big = np.asarray(Image.fromarray(big).resize((tw, th), Image.LANCZOS), dtype=np.uint8)

        if masked:
            a = Image.fromarray(alpha, mode="L").resize((big.shape[1], big.shape[0]), Image.BICUBIC)
            a = ((np.asarray(a) >= 128).astype(np.uint8)) * 255
        else:
            a = np.full(big.shape[:2], 255, dtype=np.uint8)
        return np.dstack([big, a])


def faithfulness(source_rgba, result_rgba):
    """How far the result drifted from what it was given.

    Shrink the result back to the source's size and compare. An upscale that only adds plausible
    sharpness still contains the original; one that INVENTED structure does not. This is the check
    that catches a weave turning into ribbing, which an edge or sharpness score calls an
    improvement. Lower is more faithful; Lanczos scores near 2 and is the floor.
    """
    a = source_rgba[:, :, :3].astype(np.float32)
    h, w = a.shape[:2]
    back = Image.fromarray(result_rgba[:, :, :3]).resize((w, h), Image.BOX)
    return float(np.abs(np.asarray(back, dtype=np.float32) - a).mean())
