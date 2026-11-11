"""Makes the Mech minigun's sounds from nothing but numpy: H9XASH/ts/sound/h9/mechminigun/fire.wav and start.wav.

The client plays a gun's fire sound once per shot on the shooter's weapon channel, and a new sound on a channel cuts the one still playing
(reTS cl_dll/ev_ts.cpp, EV_TSFire). The M60 shoots every 0.109 s. So each file is built to be cut:

  fire.wav   0.109 s of sustained fire (seven rounds, 64.2 Hz, a motor whine that is a whole number of cycles long) followed by a
             0.40 s tail (the whine winding down, a low rumble). While the trigger is held every new shot cuts the tail off at the
             0.109 s mark, so the burst is one continuous buzz; when the last shot has been fired the tail plays out: the
             spin-down comes for free.
  start.wav  the first shot of a burst: the same length, with the rounds arriving faster and faster and the whine rising from a
             low note to the sustained pitch, then the same tail.

Run: python tools/make-mechminigun-sound.py [out_dir] [--demo demo.wav]
Deterministic (fixed seeds). 22050 Hz, 16 bit, mono, like the game's own sounds. No third-party material is used.
"""
import math
import os
import sys
import wave

import numpy as np

SR = 22050
SHOT = 0.109                      # the M60's seconds between shots (CTSGun weapon table)
ROUNDS = 7                        # rounds in one sustained shot interval: 64.2 Hz, 3850 per minute
TAIL = 0.40                       # seconds of tail after the shot interval
PEAK = 0.95                       # the loudest sample, of full scale
DRIVE = 4.5                       # the soft clip that makes the rounds as loud as the game's own M60 sample (its first 109 ms have an rms of 0.73)
WHINE_HZ = 55.0 / SHOT            # 504.6 Hz: a whole number of cycles in one shot interval, so the cut is seamless
ROTATION_HZ = 1.0 / SHOT          # the barrels turn once per shot interval in the model of this sound


def biquad(x, kind, f, q=0.7071):
    """RBJ cookbook low-pass / high-pass / band-pass, direct form I, in plain Python (the files are short)."""
    w0 = 2.0 * math.pi * f / SR
    a = math.sin(w0) / (2.0 * q)
    c = math.cos(w0)
    if kind == "lp":
        b0, b1, b2 = (1 - c) / 2, 1 - c, (1 - c) / 2
    elif kind == "hp":
        b0, b1, b2 = (1 + c) / 2, -(1 + c), (1 + c) / 2
    else:  # band-pass, constant 0 dB peak gain
        b0, b1, b2 = a, 0.0, -a
    a0, a1, a2 = 1 + a, -2 * c, 1 - a
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(len(x)):
        xi = x[i]
        yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        y[i] = yi
        x2, x1 = x1, xi
        y2, y1 = y1, yi
    return y


class Rng:
    """A tiny deterministic generator so the files come out the same on every machine."""

    def __init__(self, seed):
        self.g = np.random.default_rng(seed)

    def noise(self, n):
        return self.g.standard_normal(n).astype(np.float64)

    def uniform(self, lo, hi):
        return float(self.g.uniform(lo, hi))


def one_round(rng, level):
    """One round going off: a thump, a crack and a body of mid noise, about 60 ms long."""
    n = int(0.060 * SR)
    t = np.arange(n) / SR
    # the thump: a sine falling from 170 to 55 Hz
    freq = 55.0 + (170.0 - 55.0) * np.exp(-t / 0.012)
    phase = 2 * math.pi * np.cumsum(freq) / SR
    thump = np.sin(phase) * np.exp(-t / 0.010)
    # the crack: noise between 1.4 and 6 kHz, gone in a few milliseconds
    crack = biquad(biquad(rng.noise(n), "hp", 1400.0), "lp", 6000.0) * np.exp(-t / 0.0035)
    # the body: noise between 250 and 1100 Hz
    body = biquad(rng.noise(n), "bp", 600.0, 0.8) * np.exp(-t / 0.012)
    shot = 1.00 * thump + 0.55 * crack / max(np.max(np.abs(crack)), 1e-9) + 0.45 * body / max(np.max(np.abs(body)), 1e-9)
    return shot * level


def place(out, snippet, at_seconds):
    start = int(round(at_seconds * SR))
    end = min(len(out), start + len(snippet))
    if start < len(out) and end > start:
        out[start:end] += snippet[: end - start]


def whine(n, f_start, f_end, amp_start, amp_end, fm_depth=0.8):
    """The motor and the turning barrels: a note with two overtones and a slow wobble once per rotation."""
    t = np.arange(n) / SR
    if f_start == f_end:
        f = np.full(n, f_start)
    else:
        f = f_start + (f_end - f_start) * (1.0 - np.exp(-t / (n / SR) * 3.0)) / (1.0 - math.exp(-3.0))
    phase = 2 * math.pi * np.cumsum(f) / SR
    wobble = fm_depth * np.sin(2 * math.pi * ROTATION_HZ * t)
    amp = amp_start + (amp_end - amp_start) * np.linspace(0.0, 1.0, n)
    sig = np.sin(phase + wobble) + 0.30 * np.sin(2 * phase + wobble) + 0.15 * np.sin(3 * phase + wobble)
    return sig * amp


def tail_part(rng, last_pulse_level):
    """After the shot interval: the whine winding down, a rumble that dies, one small clunk."""
    n = int(TAIL * SR)
    t = np.arange(n) / SR
    glide = WHINE_HZ * np.exp(-t / 0.26)
    phase0 = 0.0
    phase = 2 * math.pi * np.cumsum(glide) / SR + phase0
    amp = 0.12 * np.exp(-t / 0.17)
    wob = 0.8 * np.sin(2 * math.pi * ROTATION_HZ * t)
    w = (np.sin(phase + wob) + 0.30 * np.sin(2 * phase + wob) + 0.15 * np.sin(3 * phase + wob)) * amp
    rumble = biquad(rng.noise(n), "lp", 420.0) * np.exp(-t / 0.075) * 0.55 * last_pulse_level
    clunk_n = int(0.05 * SR)
    ct = np.arange(clunk_n) / SR
    clunk = biquad(rng.noise(clunk_n), "bp", 900.0, 1.4) * np.exp(-ct / 0.008) * 0.14
    tail = w + rumble
    place_at = int(0.16 * SR)
    tail[place_at:place_at + clunk_n] += clunk
    return tail


def build(kind):
    rng = Rng(7 if kind == "fire" else 11)
    n_shot = int(round(SHOT * SR))
    n_total = n_shot + int(TAIL * SR)
    out = np.zeros(n_total)
    period = SHOT / ROUNDS
    if kind == "fire":
        times = [k * period + (rng.uniform(-1.0, 1.0) * 0.0004 if k else 0.0) for k in range(ROUNDS)]
        levels = [rng.uniform(0.82, 1.0) for _ in range(ROUNDS)]
        w = whine(n_shot, WHINE_HZ, WHINE_HZ, 0.12, 0.12)
    else:
        # the rounds arrive faster and faster, the last interval equal to the sustained one
        times = [0.000, 0.034, 0.059, 0.078, 0.094]
        levels = [1.0, 0.95, 0.92, 0.90, 0.92]
        w = whine(n_shot, 80.0, WHINE_HZ, 0.05, 0.12)
        # a short motor start under the first round
        ramp_n = int(0.05 * SR)
        out[:ramp_n] += biquad(rng.noise(ramp_n), "lp", 700.0) * np.linspace(0.0, 0.10, ramp_n)
    for t0, lv in zip(times, levels):
        place(out, one_round(rng, lv), t0)
    out[:n_shot] += w[:n_shot]
    tail = tail_part(rng, 0.9)
    # the last round's own decay runs on into the tail: it is already part of `out` past n_shot (place() keeps it)
    out[n_shot:n_shot + len(tail)] += tail[: n_total - n_shot]
    # a little air under everything
    out += biquad(rng.noise(n_total), "lp", 3000.0) * 0.012
    # edges: start on zero, end on zero
    f_in = int(0.0008 * SR)
    f_out = int(0.030 * SR)
    out[:f_in] *= np.linspace(0, 1, f_in)
    out[-f_out:] *= np.linspace(1, 0, f_out)
    out = out - np.mean(out)
    out /= max(np.max(np.abs(out)), 1e-9)
    out = np.tanh(out * DRIVE) / math.tanh(DRIVE)
    out *= PEAK / max(np.max(np.abs(out)), 1e-9)
    return out


def write_wav(path, x):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    data = np.clip(np.round(x * 32767.0), -32768, 32767).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)


def burst(start, fire, shots, jitter_ms, seed=3):
    """What the game does: the first shot plays start.wav, each next shot plays fire.wav and cuts the previous one."""
    g = np.random.default_rng(seed)
    n = int((shots * SHOT + TAIL + 0.1) * SR)
    out = np.zeros(n)
    t = 0.0
    prev_end = None
    for k in range(shots):
        s = start if k == 0 else fire
        a = int(round(t * SR))
        if prev_end is not None:
            out[a:] = 0.0 if False else out[a:]
        # a new sound on the channel cuts the old one at the moment the new one starts
        out[a:] = 0.0
        end = min(n, a + len(s))
        out[a:end] = s[: end - a]
        t += SHOT + g.uniform(-jitter_ms, jitter_ms) / 1000.0
    return out


def main():
    out_dir = None
    demo = None
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--demo" and i + 1 < len(args):
            demo = args[i + 1]
            i += 2
        else:
            out_dir = args[i]
            i += 1
    if out_dir is None:
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "H9XASH", "ts", "sound", "h9", "mechminigun")
    fire = build("fire")
    start = build("start")
    write_wav(os.path.join(out_dir, "fire.wav"), fire)
    write_wav(os.path.join(out_dir, "start.wav"), start)
    print("wrote %s: fire %.3f s, start %.3f s" % (os.path.abspath(out_dir), len(fire) / SR, len(start) / SR))
    for name, x in (("fire", fire), ("start", start)):
        print("  %-5s rms %.3f  peak %.3f" % (name, float(np.sqrt(np.mean(x ** 2))), float(np.max(np.abs(x)))))
    if demo:
        d = burst(start, fire, 14, 8.0)
        d *= PEAK / max(np.max(np.abs(d)), 1e-9)
        write_wav(demo, d)
        print("demo burst (14 shots at 0.109 s, +-8 ms jitter, cut by each next shot): %s" % demo)


if __name__ == "__main__":
    main()
