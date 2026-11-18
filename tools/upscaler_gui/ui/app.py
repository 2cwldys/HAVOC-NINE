"""The window.

Four tabs, no modal dialogs. The fourth one is the point of the whole program: it shows the
before, a faithful Lanczos control, and the model's result side by side at 1:1, sorted so the
textures that drifted furthest from their source are at the top. The command-line pipeline had no
way to show a person that a mesh weave had turned into invented ribbing until it was ten
gigabytes deep.
"""
from __future__ import annotations

import queue
import sys
import threading
import traceback
from pathlib import Path

import tkinter as tk
from tkinter import filedialog, ttk

import numpy as np
from PIL import Image, ImageTk

from ui import theme
from ui.banner import Banner, asset
from core import images as im
from engine.runner import Upscaler, faithfulness

TITLE = "H9 UPSCALER"


class Item:
    __slots__ = ("path", "key", "src", "out", "state", "drift", "control", "w", "h")

    def __init__(self, path, src, key):
        self.path = path
        self.src = src            # RGBA uint8
        self.key = key            # sha256 of the pixels
        self.out = None           # RGBA uint8 once done
        self.control = None       # the Lanczos control, made on demand for the review
        self.state = "waiting"
        self.drift = None
        self.h, self.w = src.shape[:2]


class App(ttk.Frame):
    def __init__(self, master, model_path):
        super().__init__(master)
        self.pack(fill="both", expand=True)
        self.model_path = Path(model_path)
        self.items: list[Item] = []
        self.by_id: dict[str, Item] = {}
        self.events: queue.Queue = queue.Queue()
        self.worker = None
        self.stopping = threading.Event()
        self.upscaler = None
        self._previews = []       # keep PhotoImage alive

        self._build()
        self.after(80, self._drain)

    # ---------------------------------------------------------------- layout
    def _build(self):
        self.banner = Banner(self, asset("h9bg.jpg"), TITLE)
        self.banner.pack(fill="x")
        self.banner.set_sub("texture upscaling")
        # The model is 64 MB and takes a few seconds to come up on the GPU, so it is not loaded
        # until there is work for it. Say which one is waiting rather than "none loaded", which
        # reads like something is wrong.
        if self.model_path.is_file():
            self.banner.set_right("%s  -  loads on the first run"
                                  % self.model_path.name)
        else:
            self.banner.set_right("no model at %s" % self.model_path.name)

        self.tabs = ttk.Notebook(self)
        self.tabs.pack(fill="both", expand=True, padx=12, pady=(8, 8))
        self.tab_source = ttk.Frame(self.tabs, padding=12)
        self.tab_run = ttk.Frame(self.tabs, padding=12)
        self.tab_review = ttk.Frame(self.tabs, padding=12)
        self.tabs.add(self.tab_source, text="  Source  ")
        self.tabs.add(self.tab_run, text="  Run  ")
        self.tabs.add(self.tab_review, text="  Review  ")

        self._build_source()
        self._build_run()
        self._build_review()

        bar = ttk.Frame(self, padding=(16, 0, 16, 10))
        bar.pack(fill="x")
        self.status = ttk.Label(bar, text="Add a folder or some images to begin.",
                                style="Muted.TLabel")
        self.status.pack(side="left")

    def _build_source(self):
        t = self.tab_source
        row = ttk.Frame(t)
        row.pack(fill="x", pady=(0, 10))
        ttk.Button(row, text="Add folder...", command=self.add_folder).pack(side="left")
        ttk.Button(row, text="Add images...", command=self.add_files).pack(side="left", padx=6)
        ttk.Button(row, text="Clear", command=self.clear).pack(side="left")
        ttk.Label(row, text="png, bmp, tga, jpg. Game formats come in a later version.",
                  style="Muted.TLabel").pack(side="right")

        cols = ("size", "state")
        self.src_tree = ttk.Treeview(t, columns=cols, show="tree headings", height=14)
        self.src_tree.heading("#0", text="texture")
        self.src_tree.heading("size", text="size")
        self.src_tree.heading("state", text="state")
        self.src_tree.column("#0", width=430, anchor="w")
        self.src_tree.column("size", width=110, anchor="center")
        self.src_tree.column("state", width=110, anchor="center")
        theme.tag_colours(self.src_tree)
        self.src_tree.pack(fill="both", expand=True)

    def _build_run(self):
        t = self.tab_run
        opts = ttk.Frame(t)
        opts.pack(fill="x", pady=(0, 12))

        ttk.Label(opts, text="Fidelity", style="Head.TLabel").grid(row=0, column=0, sticky="w")
        self.blend = tk.DoubleVar(value=1.0)
        ttk.Scale(opts, from_=0.0, to=1.0, variable=self.blend, length=260,
                  command=lambda _=None: self._blend_text()).grid(row=0, column=1, padx=10)
        self.blend_lbl = ttk.Label(opts, text="", style="Mono.TLabel")
        self.blend_lbl.grid(row=0, column=2, sticky="w")
        ttk.Label(opts, text="Lower keeps more of the original and invents less.",
                  style="Muted.TLabel").grid(row=1, column=1, columnspan=2, sticky="w", padx=10)
        self._blend_text()

        ttk.Label(opts, text="Scale", style="Head.TLabel").grid(row=2, column=0, sticky="w", pady=(10, 0))
        self.scale_to = tk.IntVar(value=4)
        sf = ttk.Frame(opts)
        sf.grid(row=2, column=1, sticky="w", padx=10, pady=(10, 0))
        for v in (2, 3, 4):
            ttk.Radiobutton(sf, text="%dx" % v, value=v, variable=self.scale_to).pack(side="left", padx=(0, 10))
        ttk.Label(opts, text="The model is a 4x one; 2x and 3x come down from it, which beats a plain resize.",
                  style="Muted.TLabel").grid(row=2, column=2, sticky="w", pady=(10, 0))

        ttk.Label(opts, text="Tile", style="Head.TLabel").grid(row=3, column=0, sticky="w", pady=(10, 0))
        self.tile = tk.IntVar(value=256)
        self.tile_box = ttk.Combobox(opts, textvariable=self.tile, values=(128, 192, 256, 384, 512),
                                     width=8, state="readonly")
        self.tile_box.grid(row=3, column=1, sticky="w", padx=10, pady=(10, 0))
        ttk.Label(opts, text="Smaller uses less video memory.",
                  style="Muted.TLabel").grid(row=3, column=2, sticky="w", pady=(10, 0))

        ttk.Label(opts, text="Format", style="Head.TLabel").grid(row=4, column=0, sticky="w", pady=(10, 0))
        self.out_format = tk.StringVar(value="png")
        ff = ttk.Frame(opts)
        ff.grid(row=4, column=1, sticky="w", padx=10, pady=(10, 0))
        for value, label in (("png", "PNG"), ("tga", "TGA")):
            ttk.Radiobutton(ff, text=label, value=value,
                            variable=self.out_format).pack(side="left", padx=(0, 10))
        ttk.Label(opts, text="The same pixels either way. PNG is about 43 percent of the bytes; TGA decodes faster in game.",
                  style="Muted.TLabel").grid(row=4, column=2, sticky="w", pady=(10, 0))

        run = ttk.Frame(t)
        run.pack(fill="x", pady=(0, 10))
        self.go = ttk.Button(run, text="Upscale", style="Accent.TButton", command=self.start)
        self.go.pack(side="left")
        self.stop_btn = ttk.Button(run, text="Stop", command=self.stop, state="disabled")
        self.stop_btn.pack(side="left", padx=8)
        self.progress = ttk.Progressbar(run, mode="determinate", length=380)
        self.progress.pack(side="left", padx=14, fill="x", expand=True)
        self.count = ttk.Label(run, text="", style="Mono.TLabel")
        self.count.pack(side="right")

        self.log = tk.Text(t, height=14, bg=theme.SURFACE, fg=theme.MUTED,
                           insertbackground=theme.ACCENT, relief="flat",
                           font=theme.MONO, wrap="none", padx=10, pady=8)
        self.log.pack(fill="both", expand=True)

    def _build_review(self):
        t = self.tab_review
        top = ttk.Frame(t)
        top.pack(fill="x", pady=(0, 8))
        ttk.Label(top, text="Worst drift first", style="Head.TLabel").pack(side="left")
        ttk.Label(top, text="   drift is how far the result moved from the source when shrunk "
                           "back. Lanczos scores about 2; much higher means invented detail.",
                  style="Muted.TLabel").pack(side="left")
        ttk.Button(top, text="Save all as TGA...", command=self.save_all).pack(side="right")

        split = ttk.Frame(t)
        split.pack(fill="both", expand=True)
        self.rev_tree = ttk.Treeview(split, columns=("drift", "size"), show="tree headings",
                                     height=18, selectmode="browse")
        self.rev_tree.heading("#0", text="texture")
        self.rev_tree.heading("drift", text="drift")
        self.rev_tree.heading("size", text="size")
        self.rev_tree.column("#0", width=250)
        self.rev_tree.column("drift", width=70, anchor="center")
        self.rev_tree.column("size", width=100, anchor="center")
        theme.tag_colours(self.rev_tree)
        self.rev_tree.pack(side="left", fill="y")
        self.rev_tree.bind("<<TreeviewSelect>>", self._show_selected)

        self.canvas = tk.Canvas(split, bg=theme.BG, highlightthickness=0)
        self.canvas.pack(side="left", fill="both", expand=True, padx=(12, 0))
        # the same art, far darker, so the empty half of this tab is not a black slab
        self._bd_src = None
        bd = asset("h9bg_dark.jpg")
        if bd is not None:
            try:
                self._bd_src = Image.open(bd).convert("RGB")
            except Exception:
                pass
        self._bd_photo = None
        self._bd_size = (0, 0)
        self.canvas.bind("<Configure>", lambda e: self._backdrop(e.width, e.height))

    def _backdrop(self, w, h):
        if self._bd_src is None or w < 2 or h < 2 or (w, h) == self._bd_size:
            return
        self._bd_size = (w, h)
        self.canvas.delete("bd")
        s = max(w / self._bd_src.width, h / self._bd_src.height)
        big = self._bd_src.resize((max(1, round(self._bd_src.width * s)),
                                   max(1, round(self._bd_src.height * s))), Image.LANCZOS)
        self._bd_photo = ImageTk.PhotoImage(big.crop((0, 0, w, h)))
        self.canvas.create_image(0, 0, image=self._bd_photo, anchor="nw", tags="bd")
        self.canvas.tag_lower("bd")

    def _blend_text(self):
        v = self.blend.get()
        word = "all model" if v > 0.99 else ("all Lanczos" if v < 0.01 else "mixed")
        self.blend_lbl.configure(text="%.2f  %s" % (v, word))

    # ------------------------------------------------------------- sources
    def add_folder(self):
        d = filedialog.askdirectory(title="Folder of textures")
        if d:
            paths = [p for p in sorted(Path(d).rglob("*"))
                     if p.suffix.lower() in im.IMAGE_SUFFIXES]
            self._add(paths)

    def add_files(self):
        fs = filedialog.askopenfilenames(
            title="Textures",
            filetypes=[("Images", "*.png *.bmp *.tga *.jpg *.jpeg *.gif"), ("All", "*.*")])
        self._add([Path(f) for f in fs])

    def _add(self, paths):
        added = skipped = 0
        for p in paths:
            try:
                rgba = im.load_rgba(p)
            except Exception:
                skipped += 1
                continue
            key = im.pixel_key(rgba)
            if key in self.by_id:          # the same pixels under another name
                skipped += 1
                continue
            it = Item(p, rgba, key)
            self.items.append(it)
            self.by_id[key] = it
            self.src_tree.insert("", "end", iid=key, text=p.name,
                                 values=("%dx%d" % (it.w, it.h), "waiting"), tags=("muted",))
            added += 1
        self.status.configure(
            text="%d texture(s) ready%s" % (len(self.items),
                                            ", %d skipped as duplicates or unreadable" % skipped if skipped else ""))

    def clear(self):
        self.items.clear()
        self.by_id.clear()
        self.src_tree.delete(*self.src_tree.get_children())
        self.rev_tree.delete(*self.rev_tree.get_children())
        self.canvas.delete("pane")
        self.status.configure(text="Cleared.")

    # ----------------------------------------------------------------- run
    def start(self):
        todo = [i for i in self.items if i.state in ("waiting", "failed")]
        if not todo:
            self.status.configure(text="Nothing to do.")
            return
        self.stopping.clear()
        self.go.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.progress.configure(maximum=len(todo), value=0)
        self.tabs.select(self.tab_run)
        self.worker = threading.Thread(target=self._work, args=(todo, float(self.blend.get()),
                                                                int(self.tile.get()), int(self.scale_to.get())), daemon=True)
        self.worker.start()

    def stop(self):
        self.stopping.set()
        self._say("stopping after the texture in flight...")

    def _work(self, todo, blend, tile, out_scale):
        try:
            if self.upscaler is None or self.upscaler.tile != tile:
                self.events.put(("say", "loading the model..."))
                self.upscaler = Upscaler(self.model_path, tile=tile)
                s = self.upscaler.probe()
                self.events.put(("provider", "%s   x%d" % (self.upscaler.provider, s)))
            done = 0
            for it in todo:
                if self.stopping.is_set():
                    break
                self.events.put(("state", (it.key, "working")))
                out = self.upscaler.upscale(it.src, blend=blend, out_scale=out_scale)
                it.out = out
                it.drift = faithfulness(it.src, out)
                it.state = "done"
                done += 1
                self.events.put(("done", (it.key, done)))
            self.events.put(("finished", done))
        except Exception:
            self.events.put(("error", traceback.format_exc(limit=4)))

    def _drain(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "say":
                    self._say(payload)
                elif kind == "provider":
                    self.banner.set_right(payload)
                    self._say("running on %s" % payload)
                elif kind == "state":
                    key, st = payload
                    self.src_tree.set(key, "state", st)
                elif kind == "done":
                    key, n = payload
                    it = self.by_id[key]
                    self.src_tree.set(key, "state", "done")
                    self.src_tree.item(key, tags=("good",))
                    self.progress.configure(value=n)
                    self.count.configure(text="%d / %d" % (n, self.progress["maximum"]))
                    self._say("  %-42s %dx%d -> %dx%d   drift %.2f"
                              % (it.path.name, it.w, it.h,
                                 it.out.shape[1], it.out.shape[0], it.drift))
                elif kind == "finished":
                    self._finish(payload)
                elif kind == "error":
                    self._say(payload)
                    self._finish(0)
        except queue.Empty:
            pass
        self.after(80, self._drain)

    def _finish(self, n):
        self.go.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.status.configure(text="%d texture(s) done. Look at Review before saving." % n)
        self._fill_review()
        if n:
            self.tabs.select(self.tab_review)

    def _say(self, text):
        self.log.insert("end", text + "\n")
        self.log.see("end")

    # -------------------------------------------------------------- review
    def _fill_review(self):
        self.rev_tree.delete(*self.rev_tree.get_children())
        done = [i for i in self.items if i.state == "done"]
        done.sort(key=lambda i: -(i.drift or 0))
        for it in done:
            tag = "bad" if it.drift and it.drift > 6 else ("warn" if it.drift and it.drift > 4 else "good")
            self.rev_tree.insert("", "end", iid=it.key, text=it.path.name,
                                 values=("%.2f" % (it.drift or 0), "%dx%d" % (it.w, it.h)),
                                 tags=(tag,))
        if done:
            self.rev_tree.selection_set(done[0].key)

    def _show_selected(self, _event=None):
        sel = self.rev_tree.selection()
        if not sel:
            return
        it = self.by_id.get(sel[0])
        if not it or it.out is None:
            return
        scale = it.out.shape[0] // it.h
        if it.control is None:
            it.control = im.lanczos(it.src, scale)

        side = 300
        nearest = np.asarray(Image.fromarray(it.src, "RGBA").resize(
            (it.w * scale, it.h * scale), Image.NEAREST), dtype=np.uint8)
        panes = [("ORIGINAL", nearest, theme.BAD),
                 ("LANCZOS", it.control, theme.ACCENT2),
                 ("MODEL", it.out, theme.GOOD)]

        self.canvas.delete("pane")
        self._previews.clear()
        x = 8
        for name, arr, colour in panes:
            crop = im.crop_centre(arr, side)
            photo = ImageTk.PhotoImage(Image.fromarray(crop, "RGBA"))
            self._previews.append(photo)
            self.canvas.create_text(x + 2, 6, text=name, anchor="nw", tags="pane",
                                    fill=colour, font=theme.MONO)
            self.canvas.create_image(x, 24, image=photo, anchor="nw", tags="pane")
            x += crop.shape[1] + 10
        self.canvas.create_text(8, 24 + side + 12, anchor="nw", tags="pane",
                                fill=theme.MUTED, font=theme.MONO,
                                text="%s   %dx%d -> %dx%d   drift %.2f   (1:1 crop, no shrinking)"
                                     % (it.path.name, it.w, it.h,
                                        it.out.shape[1], it.out.shape[0], it.drift or 0))

    def save_all(self):
        done = [i for i in self.items if i.state == "done"]
        if not done:
            self.status.configure(text="Nothing done yet.")
            return
        fmt = self.out_format.get()
        d = filedialog.askdirectory(title="Where to save the %s files" % fmt.upper())
        if not d:
            return
        out = Path(d)
        for it in done:
            target = out / (it.path.stem + "." + fmt)
            if fmt == "png":
                im.save_png(target, it.out)
            else:
                im.save_tga(target, it.out)
        self.status.configure(
            text="Saved %d %s file(s) to %s" % (len(done), fmt.upper(), out))


def _own_the_taskbar_button():
    """Ask Windows to treat this as its own program rather than as Python.

    Without this the taskbar button shows pythonw.exe's icon no matter what the window itself is
    set to, because Windows groups and labels buttons by the process's application id and Python
    ships with one of its own. It has to happen before the first window exists.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("havoc9.upscaler")
    except Exception:
        pass   # an ordinary taskbar icon is not worth failing to start over


def run(model_path):
    _own_the_taskbar_button()
    root = tk.Tk()
    root.title("H9 Upscaler")
    # the icon sits beside the program, and inside the bundle at its root
    ico = asset("h9.ico")
    if ico is not None:
        try:
            root.iconbitmap(default=str(ico))   # title bar, alt-tab and every later window
        except tk.TclError:
            pass   # a window without its icon is still a working window
    root.geometry("1180x760")
    root.minsize(980, 640)
    theme.apply(root)
    App(root, model_path)
    root.mainloop()
