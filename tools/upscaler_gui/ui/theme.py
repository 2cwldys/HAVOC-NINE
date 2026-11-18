"""The H9 look, taken from the game rather than guessed at.

Every colour below was sampled out of a frame of the main-menu background (ts\\media\\mainmenu_bg.avi)
and then lifted to full strength: the ground is that art's own darkest purple-black, the orange is
the hue of its brightest pixels, the purple is the hue the silhouettes sit in. That is why the
window and the banner across the top of it look like one picture instead of a theme laid over one.

ttk on Windows ignores most colour options under the native theme, so everything here starts by
switching to "clam", which does honour them. Without that line half of this silently does nothing
and the window comes out looking like Windows 98.

Orange is for the thing that moves or the thing you press. Purple is for what is selected or
focused.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

BG = "#15071B"        # the window: the menu art's own ground
SURFACE = "#1E0E26"   # panels, lists, entries
RAISED = "#2B1636"    # hover
LINE = "#3A2048"      # borders and separators
TEXT = "#F2E8F7"
MUTED = "#9A86A8"
ACCENT = "#FF5314"    # H9 orange: progress, primary action
ACCENT_DIM = "#A8380E"
ACCENT2 = "#C96BFF"   # purple: selection, focus
GOOD = "#5CFFA8"
WARN = "#FFC857"
BAD = "#FF5C7A"

MONO = ("Consolas", 9)
UI = ("Segoe UI", 9)
UI_BOLD = ("Segoe UI Semibold", 10)
TITLE = ("Segoe UI Semibold", 15)


def rgb(hex_colour: str) -> tuple:
    """'#RRGGBB' to (r, g, b). The banner composites against these."""
    h = hex_colour.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def apply(root: tk.Misc) -> ttk.Style:
    style = ttk.Style(root)
    # without this the colours below are ignored on Windows
    style.theme_use("clam")

    root.configure(bg=BG)
    style.configure(".", background=BG, foreground=TEXT, fieldbackground=SURFACE,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE, font=UI)

    style.configure("TFrame", background=BG)
    style.configure("Surface.TFrame", background=SURFACE)
    style.configure("TLabel", background=BG, foreground=TEXT)
    style.configure("Muted.TLabel", background=BG, foreground=MUTED)
    style.configure("Title.TLabel", background=BG, foreground=TEXT, font=TITLE)
    style.configure("Head.TLabel", background=BG, foreground=ACCENT, font=UI_BOLD)
    style.configure("Good.TLabel", background=BG, foreground=GOOD)
    style.configure("Warn.TLabel", background=BG, foreground=WARN)
    style.configure("Bad.TLabel", background=BG, foreground=BAD)
    style.configure("Mono.TLabel", background=BG, foreground=MUTED, font=MONO)

    style.configure("TButton", background=RAISED, foreground=TEXT, borderwidth=1,
                    focusthickness=1, focuscolor=ACCENT2, padding=(12, 6))
    style.map("TButton",
              background=[("active", LINE), ("disabled", SURFACE)],
              foreground=[("disabled", MUTED)])

    style.configure("Accent.TButton", background=ACCENT, foreground="#1A0E03",
                    font=UI_BOLD, padding=(16, 7))
    style.map("Accent.TButton",
              background=[("active", "#FF7A3C"), ("disabled", ACCENT_DIM)],
              foreground=[("disabled", "#6B4A20")])

    style.configure("TNotebook", background=BG, borderwidth=0, tabmargins=(2, 6, 2, 0))
    style.configure("TNotebook.Tab", background=SURFACE, foreground=MUTED,
                    padding=(16, 8), borderwidth=0)
    style.map("TNotebook.Tab",
              background=[("selected", BG)],
              foreground=[("selected", ACCENT), ("active", TEXT)])

    style.configure("TEntry", fieldbackground=SURFACE, foreground=TEXT,
                    insertcolor=ACCENT, borderwidth=1, padding=5)

    # A combobox is two things. The box is ttk and takes the styles below -- note the "readonly"
    # state, which is the one this program uses and which otherwise comes out grey with the text
    # drawn as a selection. The list that drops out of it is a plain tk Listbox that ttk does not
    # reach at all, so it is coloured through the option database, which has to be set on the root
    # before any combobox is built.
    style.configure("TCombobox", fieldbackground=SURFACE, background=RAISED, foreground=TEXT,
                    arrowcolor=ACCENT, borderwidth=1, padding=4,
                    selectbackground=SURFACE, selectforeground=TEXT)
    style.map("TCombobox",
              fieldbackground=[("readonly", SURFACE), ("disabled", BG)],
              foreground=[("readonly", TEXT), ("disabled", MUTED)],
              background=[("readonly", RAISED), ("active", LINE)],
              selectbackground=[("readonly", SURFACE)],
              selectforeground=[("readonly", TEXT)],
              arrowcolor=[("disabled", MUTED)])
    root.option_add("*TCombobox*Listbox.background", SURFACE)
    root.option_add("*TCombobox*Listbox.foreground", TEXT)
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT)
    root.option_add("*TCombobox*Listbox.selectForeground", "#1A0E03")
    root.option_add("*TCombobox*Listbox.font", UI)
    root.option_add("*TCombobox*Listbox.borderWidth", 0)

    style.configure("Horizontal.TProgressbar", background=ACCENT, troughcolor=SURFACE,
                    borderwidth=0, thickness=14)
    style.configure("TScale", background=BG, troughcolor=SURFACE)
    style.configure("TRadiobutton", background=BG, foreground=TEXT, focuscolor=ACCENT2)
    style.map("TRadiobutton", background=[("active", BG)],
              indicatorcolor=[("selected", ACCENT)])
    style.configure("TCheckbutton", background=BG, foreground=TEXT, focuscolor=ACCENT2)
    style.map("TCheckbutton", background=[("active", BG)], indicatorcolor=[("selected", ACCENT)])
    style.configure("TSeparator", background=LINE)

    style.configure("Treeview", background=SURFACE, fieldbackground=SURFACE, foreground=TEXT,
                    borderwidth=0, rowheight=22, font=UI)
    style.configure("Treeview.Heading", background=RAISED, foreground=MUTED,
                    borderwidth=0, padding=(8, 5), font=UI)
    style.map("Treeview",
              background=[("selected", ACCENT2)],
              foreground=[("selected", "#1A0724")])
    style.map("Treeview.Heading", background=[("active", LINE)])

    return style


def tag_colours(tree: ttk.Treeview) -> None:
    """Row colours a view can switch on by tag."""
    tree.tag_configure("ok", foreground=TEXT)
    tree.tag_configure("good", foreground=GOOD)
    tree.tag_configure("warn", foreground=WARN)
    tree.tag_configure("bad", foreground=BAD)
    tree.tag_configure("muted", foreground=MUTED)
