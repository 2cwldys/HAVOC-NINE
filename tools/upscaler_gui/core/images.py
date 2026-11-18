"""Reading and writing the picture formats, and the key every texture is known by.

A texture is identified by the sha256 of its PIXELS, not its name or its file. Two maps sharing a
wall texture are one image and one upscale. A map recompiled without touching its art hashes the
same and is not redone. That is the whole of the dedupe, and the whole of the delta.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
from PIL import Image

# what the GUI will open directly
IMAGE_SUFFIXES = {".png", ".bmp", ".tga", ".jpg", ".jpeg", ".gif"}


def load_rgba(path) -> np.ndarray:
    """Any supported picture as RGBA uint8."""
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA"), dtype=np.uint8)


def save_tga(path, rgba: np.ndarray, rle: bool = True) -> None:
    """32-bit TGA, run-length encoded by default.

    The engine reads image_type 2 (plain) and 10 (RLE) at 24 or 32 bits -- see
    engine/common/imagelib/img_tga.c. RLE roughly halves a game texture, so there is no reason to
    ship plain.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(
        path, format="TGA", compression="tga_rle" if rle else None)


def save_png(path, rgba: np.ndarray, level: int = 6) -> None:
    """32-bit PNG, which the engine prefers over a TGA of the same name.

    Level 6 rather than 9: measured over this project's whole texture store the two are within
    a point of each other on size, 6 encodes four times faster, and the level makes no
    measurable difference to how fast the engine decodes the result.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(path, format="PNG", compress_level=level)


def pixel_key(rgba: np.ndarray) -> str:
    """The sha256 of the pixels themselves."""
    return hashlib.sha256(np.ascontiguousarray(rgba).tobytes()).hexdigest()


def file_sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def lanczos(rgba: np.ndarray, scale: int) -> np.ndarray:
    """A faithful upscale that invents nothing: the control the model is judged against."""
    h, w = rgba.shape[:2]
    return np.asarray(
        Image.fromarray(rgba, mode="RGBA").resize((w * scale, h * scale), Image.LANCZOS),
        dtype=np.uint8)


def thumbnail(rgba: np.ndarray, side: int = 128) -> Image.Image:
    im = Image.fromarray(rgba, mode="RGBA")
    im.thumbnail((side, side), Image.NEAREST)   # NEAREST: show the real pixels, not a guess
    return im


def crop_centre(rgba: np.ndarray, size: int) -> np.ndarray:
    h, w = rgba.shape[:2]
    cw, ch = min(size, w), min(size, h)
    x, y = (w - cw) // 2, (h - ch) // 2
    return rgba[y:y + ch, x:x + cw]
