"""The game's own menu art across the top of the window.

A tk widget is an opaque rectangle; there is no way to make a ttk frame or label see through to a
picture behind it. So the art is not laid under the whole window, where every panel would simply
cover it -- it gets a band of its own at the top, with the title drawn straight onto the canvas so
it sits on the picture rather than on a grey box over it.

Two things are done to the frame before it is drawn, both so text stays readable without a slab
behind it: the bottom edge is faded into the window colour, so the band ends rather than stops,
and the left third is darkened under the title. Both are computed only when the window is resized.
"""
from __future__ import annotations

from pathlib import Path

import tkinter as tk

import numpy as np
from PIL import Image, ImageTk

from ui import theme

HEIGHT = 132
FADE = 52          # how much of the bottom edge melts into the window
WASH = 460         # how far the darkening under the title reaches


class Banner(tk.Canvas):
    def __init__(self, master, image_path, title):
        super().__init__(master, height=HEIGHT, highlightthickness=0, bd=0, bg=theme.BG)
        self.title_text = title
        self.sub_text = ""
        self.right_text = ""
        self._photo = None
        self._width = 0
        try:
            self._src = Image.open(image_path).convert("RGB") if image_path else None
        except Exception:
            self._src = None      # a missing picture is not a reason to refuse to start
        self.bind("<Configure>", self._on_resize)

    # ------------------------------------------------------------------ text
    def set_right(self, text):
        self.right_text = text
        self._draw_text()

    def set_sub(self, text):
        self.sub_text = text
        self._draw_text()

    # ----------------------------------------------------------------- paint
    def _on_resize(self, event):
        if event.width == self._width or event.width < 2:
            return
        self._width = event.width
        self._draw()

    def _draw(self):
        self.delete("all")
        if self._src is not None:
            self._photo = ImageTk.PhotoImage(self._compose(self._width))
            self.create_image(0, 0, image=self._photo, anchor="nw")
        self._draw_text()

    def _compose(self, width):
        """Cover the band with the frame, then fade it where text has to sit."""
        src = self._src
        scale = max(width / src.width, HEIGHT / src.height)
        big = src.resize((max(1, round(src.width * scale)),
                          max(1, round(src.height * scale))), Image.LANCZOS)
        left = max(0, (big.width - width) // 2)
        # a little above centre: that is where the lights and the banners are
        top = max(0, round((big.height - HEIGHT) * 0.38))
        a = np.asarray(big.crop((left, top, left + width, top + HEIGHT)), dtype=np.float32)

        ground = np.asarray(theme.rgb(theme.BG), dtype=np.float32)

        # the bottom edge melts into the window, so the band ends instead of stopping
        down = np.ones((HEIGHT, 1, 1), dtype=np.float32)
        n = min(FADE, HEIGHT)
        down[HEIGHT - n:, 0, 0] = np.linspace(1.0, 0.0, n) ** 1.4

        # and the left side goes dark under the title
        across = np.ones((1, width, 1), dtype=np.float32)
        m = min(WASH, width)
        across[0, :m, 0] = np.linspace(0.30, 1.0, m) ** 0.8

        k = (down * across) * 0.86
        return Image.fromarray(np.clip(a * k + ground * (1.0 - k), 0, 255).astype(np.uint8))

    def _draw_text(self):
        self.delete("txt")
        self.create_text(18, 26, text=self.title_text, anchor="nw", tags="txt",
                         fill=theme.TEXT, font=theme.TITLE)
        self.create_text(20, 54, text=self.sub_text, anchor="nw", tags="txt",
                         fill=theme.ACCENT, font=theme.UI)
        if self.right_text:
            # down in the faded edge: the top right of the frame is the brightest part of it
            self.create_text(max(0, self._width) - 16, HEIGHT - 26, text=self.right_text,
                             anchor="ne", tags="txt", fill=theme.TEXT, font=theme.MONO)
        # a thin orange rule, the one piece of chrome that is not from the picture
        self.create_line(0, HEIGHT - 1, max(0, self._width), HEIGHT - 1,
                         fill=theme.ACCENT_DIM, tags="txt")


def asset(name):
    """Beside the program, or inside the bundle at its root. None if it is not there."""
    import sys
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    p = here / name
    return p if p.is_file() else None
