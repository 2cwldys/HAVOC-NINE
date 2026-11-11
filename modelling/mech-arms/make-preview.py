"""The preview sheet of the Mech's arm-mounted weapons: SMAK renders composed with PIL.

    python make-preview.py <game folder shaped like H9XASH\\ts> <out.png> [scratch folder]

Row 1 the minigun, row 2 the rocket launcher (first person idle and firing with the crosshair marked, a close-up, what another
player sees, the floor model), row 3 the three side sets of both view models. The minigun has no p_ model: the stock M60's is
shown and labelled as such; its floor model is w_mechminigun.mdl.
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

GAME = sys.argv[1]
OUT = sys.argv[2]
TMP = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(OUT)), "preview_tmp")
STOCK = os.environ.get("MECH_STOCK", "D:/Downloads/TSM/H9XASH/ts/models")
SMAK = os.environ.get("SMAK_CLI", "D:/Downloads/TSM/smak/bin/smak.mjs")
os.makedirs(TMP, exist_ok=True)
env = dict(os.environ, TEMP="D:/temp/tmp", TMP="D:/temp/tmp")


def render(mdl, name, *args):
    out = os.path.join(TMP, name + ".png")
    subprocess.run(["node", SMAK, "render", mdl, "-o", out, *args], check=True, env=env, stdout=subprocess.DEVNULL)
    return out


M = lambda f: f"{GAME}/models/h9/{f}"
S = lambda side, f: f"{GAME}/models/matchmode/{side}/h9/{f}"
FIRST = ["--view", "first", "--width", "640", "--height", "480"]
ORBIT = ["--view", "orbit", "--yaw", "35", "--pitch", "12", "--width", "640", "--height", "480"]

tiles = {
    "mg_idle": render(M("v_mechminigun.mdl"), "mg_idle", *FIRST, "--seq", "idle"),
    "mg_shoot": render(M("v_mechminigun.mdl"), "mg_shoot", *FIRST, "--seq", "shoot", "--frame", "2"),
    "mg_close": render(M("v_mechminigun.mdl"), "mg_close", *ORBIT, "--zoom", "1.9", "--seq", "idle"),
    "mg_p": render(f"{STOCK}/p_m60.mdl", "mg_p", "--view", "side", "--pitch", "0", "--zoom", "1.2", "--width", "640", "--height", "480"),
    "mg_w": render(M("w_mechminigun.mdl"), "mg_w", *ORBIT),
    "rk_idle": render(M("v_mechrocket.mdl"), "rk_idle", *FIRST, "--seq", "idle"),
    "rk_shoot": render(M("v_mechrocket.mdl"), "rk_shoot", *FIRST, "--seq", "shoot", "--frame", "2"),
    "rk_close": render(M("v_mechrocket.mdl"), "rk_close", *ORBIT, "--zoom", "1.9", "--seq", "idle"),
    "rk_p": render(M("p_mechrocket.mdl"), "rk_p", "--view", "side", "--pitch", "0", "--zoom", "1.2", "--width", "640", "--height", "480"),
    "rk_w": render(M("w_mechrocket.mdl"), "rk_w", *ORBIT),
    "rk_proj": render(M("mechrocket.mdl") if os.path.exists(M("mechrocket.mdl")) else f"{STOCK}/h9/mechrocket.mdl", "rk_proj", "--view", "side", "--pitch", "0", "--width", "640", "--height", "480"),
}
BIG = ["--view", "first", "--seq", "idle", "--width", "1280", "--height", "960"]
for weapon, short in (("v_mechminigun.mdl", "mg"), ("v_mechrocket.mdl", "rk")):
    for side in ("msr", "insurgent", "default"):
        p = render(S(side, weapon), f"{short}_{side}_big", *BIG)
        # the lower right quarter of the view, where the arm is
        Image.open(p).convert("RGB").crop((640, 480, 1280, 960)).save(os.path.join(TMP, f"{short}_{side}.png"))
        tiles[f"{short}_{side}"] = os.path.join(TMP, f"{short}_{side}.png")

TILE_W, TILE_H, PAD, LABEL_H, TITLE_H, COLS = 480, 360, 14, 34, 64, 6
BG, PANEL, TXT, SUB = (22, 24, 31), (35, 38, 48), (232, 232, 240), (160, 164, 180)
ACC1, ACC2, ACC3 = (255, 170, 60), (255, 90, 80), (120, 170, 255)


def font(size, bold=False):
    for name in (("segoeuib.ttf" if bold else "segoeui.ttf"), "arialbd.ttf" if bold else "arial.ttf"):
        try:
            return ImageFont.truetype(os.path.join(r"C:\Windows\Fonts", name), size)
        except OSError:
            pass
    return ImageFont.load_default()


F_TITLE, F_SUB, F_LABEL, F_NOTE = font(30, True), font(16), font(17, True), font(14)

rows = [
    ("MECH MINIGUN  (v_mechminigun: a rotary cannon built into the Mech's arm)", ACC1, [
        ("mg_idle", "View model: idle", None, True),
        ("mg_shoot", "View model: firing", None, True),
        ("mg_close", "View model: close-up", None, False),
        ("mg_p", "In another player's hands (p_)", "stock M60: no model of its own", False),
        ("mg_w", "On the floor (w_)", None, False),
        (None, "", None, False),
    ]),
    ("MECH ROCKET LAUNCHER  (v_ p_ w_mechrocket: a four-tube pod on the Mech's arm)", ACC2, [
        ("rk_idle", "View model: idle", None, True),
        ("rk_shoot", "View model: firing (cage turned, arm kicked back)", None, True),
        ("rk_close", "View model: close-up", None, False),
        ("rk_p", "In another player's hands (p_)", None, False),
        ("rk_w", "On the floor (w_)", None, False),
        ("rk_proj", "The rocket in flight (unchanged)", None, False),
    ]),
    ("SIDE SETS  (the accent band on the forearm: msr blue, insurgent green, default hazard)", ACC3, [
        ("mg_msr", "Minigun: msr", "60,120,255", False),
        ("mg_insurgent", "Minigun: insurgent", "80,200,90", False),
        ("mg_default", "Minigun: default", "hazard yellow and black", False),
        ("rk_msr", "Rocket launcher: msr", "60,120,255", False),
        ("rk_insurgent", "Rocket launcher: insurgent", "80,200,90", False),
        ("rk_default", "Rocket launcher: default", "hazard yellow and black", False),
    ]),
]

W = PAD + COLS * (TILE_W + PAD)
H = PAD + len(rows) * (TITLE_H + TILE_H + LABEL_H + PAD) + 30
sheet = Image.new("RGB", (W, H), BG)
dr = ImageDraw.Draw(sheet)
y = PAD
for title, accent, row in rows:
    dr.rectangle([PAD, y, PAD + 8, y + TITLE_H - 18], fill=accent)
    dr.text((PAD + 20, y - 2), title, font=F_TITLE, fill=TXT)
    y += TITLE_H
    x = PAD
    for key, label, note, cross in row:
        dr.rectangle([x, y, x + TILE_W, y + TILE_H + LABEL_H], fill=PANEL)
        if key:
            im = Image.open(tiles[key]).convert("RGB").resize((TILE_W, TILE_H), Image.LANCZOS)
            sheet.paste(im, (x, y))
            if cross:  # the crosshair, to show the weapon stands clear of it
                cx, cy = x + TILE_W // 2, y + TILE_H // 2
                for a, b in (((cx - 9, cy), (cx - 3, cy)), ((cx + 3, cy), (cx + 9, cy)), ((cx, cy - 9), (cx, cy - 3)), ((cx, cy + 3), (cx, cy + 9))):
                    dr.line([a, b], fill=(255, 255, 255), width=1)
            dr.text((x + 10, y + TILE_H + 6), label, font=F_LABEL, fill=TXT)
            if note:
                tw = dr.textlength(note, font=F_NOTE)
                dr.text((x + TILE_W - tw - 10, y + TILE_H + 10), note, font=F_NOTE, fill=SUB)
        x += TILE_W + PAD
    y += TILE_H + LABEL_H + PAD
dr.text((PAD, H - 26), "Rendered with SMAK from the files in H9XASH\\ts\\models\\h9 and models\\matchmode (first person: 90 degree view, the crosshair marked; the side sets are the lower right of the view).",
        font=F_NOTE, fill=SUB)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
sheet.save(OUT, optimize=True)
print(OUT, sheet.size, os.path.getsize(OUT), "bytes")
