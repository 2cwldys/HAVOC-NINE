"""shape_parity.py -- the client's shaping of a Kokoro line (reTS/cl_dll/h9_tts_kokoro.cpp, through the lab) against a numpy reference.

A raw clip is packed under the voice key of EVERY variant of the catalogue, the lab speaks it as every kind and variant, with and without a
gas mask (three strengths) or the robot sound, at three depths, and the reference does the same from the clip as the pack decodes it:
    one resample by chain ratio * depth_step ^ (variant depth + speaker depth), the level, the chain's stages, the level
(fx_ref.py). The lab runs at the model's 24 kHz so no resample to the mixer's rate is in the way: the two must agree to the last bit
of the 16-bit sample, give or take its rounding.

usage: python -I shape_parity.py <h9tts master folder> <stage folder> <h9pk.exe> <kokoro_lab.exe> <raw clip.f32> [workdir]
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402

import fx_ref as fx  # noqa: E402

TEXT = "Parity check one two three."
MACHINES = ("mech", "bot", "droid")


def parse_blend(text):
    out = []
    for part in text.split("+"):
        n, _, w = part.partition(":")
        out.append((n, float(w) if w else 1.0))
    return out


def voice_key(blend, speed):
    total = float(sum(w for _, w in blend))
    name = blend[0][0] if len(blend) == 1 else "+".join("%s:%.2f" % (n, w / total) for n, w in blend)
    return "%s@%.2f" % (name, speed)


def load_catalogue(path):
    kinds = {}
    for raw in open(path, encoding="ascii"):
        t = raw.split("//", 1)[0].split()
        if t and t[0] == "variant":
            kinds.setdefault(t[1], []).append(dict(blend=parse_blend(t[5]), speed=float(t[6]), depth=int(t[7]), chain=t[8], mask=t[9]))
    return kinds


def load_chains(path):
    const, chains = {}, {}
    for raw in open(path, encoding="ascii"):
        t = raw.split("//", 1)[0].split()
        if not t:
            continue
        if t[0] == "const":
            const[t[1]] = float(t[2])
        elif t[0] == "chain":
            ratio = 1.0
            stages = []
            for w in t[2:]:
                if w.startswith("resample="):
                    ratio = float(w.split("=", 1)[1])
                else:
                    stages.append(w)
            chains[t[1]] = (ratio, " ".join(stages))
    return const, chains


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise SystemExit("%s failed (%d): %s%s" % (cmd[0], r.returncode, r.stdout, r.stderr))
    return r.stdout


def main():
    master, stage, h9pk, lab, clip = sys.argv[1:6]
    work = sys.argv[6] if len(sys.argv) > 6 else os.path.join(stage, "work")
    os.makedirs(work, exist_ok=True)
    data = os.path.join(stage, "ts", "h9tts")
    os.makedirs(os.path.join(data, "lines"), exist_ok=True)
    for name in ("voices.txt", "chains.txt"):
        open(os.path.join(data, name), "wb").write(open(os.path.join(master, name), "rb").read())
    kinds = load_catalogue(os.path.join(master, "voices.txt"))
    const, chains = load_chains(os.path.join(master, "chains.txt"))

    manifest = os.path.join(work, "parity_manifest.tsv")
    with open(manifest, "w", encoding="utf-8") as m:
        for kind, vs in kinds.items():
            for v in vs:
                m.write("%s\t%s\t%s\n" % (voice_key(v["blend"], v["speed"]), TEXT, clip))
    print(run([h9pk, "build", manifest, os.path.join(data, "lines", "lines.h9pk")]).strip())
    first = kinds["man"][0]
    decoded = os.path.join(work, "decoded.f32")
    run([h9pk, "extract", os.path.join(data, "lines", "lines.h9pk"), voice_key(first["blend"], first["speed"]), TEXT, decoded])
    wav = np.fromfile(decoded, dtype="<f4").astype(np.float64)

    cases = os.path.join(work, "cases")
    os.makedirs(cases, exist_ok=True)
    print(run([lab, "matrix", cases, "24000", TEXT]).strip())

    worst, n, bad = 0.0, 0, 0
    for row in open(os.path.join(cases, "cases.tsv"), encoding="ascii"):
        name, kind, variant, muffled, muffle, robot, depth, samples = row.rstrip("\n").split("\t")
        variant, muffled, muffle, robot, depth, samples = int(variant), int(muffled), float(muffle), int(robot), int(depth), int(samples)
        e = kinds[kind][variant - 1]
        machine = kind in MACHINES
        mask = (not machine) and muffled and muffle > 0.01
        if machine:
            chain_id, apply_stages, s = e["chain"], bool(robot), 1.0
        elif mask:
            chain_id, apply_stages, s = e["mask"], True, min(2.0, muffle)
        else:
            chain_id, apply_stages, s = None, False, 1.0
        total = max(-12, min(12, e["depth"] + depth))
        ratio, text = chains[chain_id] if chain_id else (1.0, "")
        if not apply_stages:
            text = ""
        ratio = ratio * const.get("depth_step", 1.025) ** total
        ref = fx.pipeline(wav, text, s, ratio, True, True)
        got = np.fromfile(os.path.join(cases, name), dtype="<i2").astype(np.float64)
        if len(got) != len(ref):
            print("LENGTH MISMATCH %s %s %d mask %d robot %d depth %d: %d vs %d" % (name, kind, variant, muffled, robot, depth, len(got), len(ref)))
            bad += 1
            continue
        refq = np.clip(np.round(ref * 32767.0), -32768, 32767)
        d = float(np.abs(got - refq).max())
        worst = max(worst, d)
        n += 1
        if d > 1.0:
            bad += 1
            print("DIFF %.1f LSB: %s %s %d muffled %d (%.1f) robot %d depth %+d" % (d, name, kind, variant, muffled, muffle, robot, depth))
    print("%d cases compared, worst difference %.1f LSB of 16 bit, %d outside 1 LSB or the wrong length" % (n, worst, bad))
    return 1 if bad or n == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
