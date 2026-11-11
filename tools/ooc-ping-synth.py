"""Three tech-sounding replacements for the ARP OOC ping, 22050 Hz mono (16-bit; the original ooc.wav is 8-bit, 0.485 s).
usage: python tools/ooc-ping-synth.py <outdir> [rms, default 0.05]   (writes ooc_tech_A_chirp.wav, ooc_tech_B_blip.wav, ooc_tech_C_sonar.wav and prints their stats)"""
import os
import sys
import wave

import numpy as np

SR = 22050
TARGET_RMS = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05
out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def tvec(sec):
    return np.arange(int(SR * sec)) / SR


def fade(x, a=0.003, b=0.012):
    n = len(x)
    na, nb = int(SR * a), int(SR * b)
    x = x.copy()
    x[:na] *= np.linspace(0.0, 1.0, na)
    x[n - nb:] *= np.linspace(1.0, 0.0, nb)
    return x


def env(t, attack, tau):
    e = np.where(t < attack, t / attack, np.exp(-(t - attack) / tau))
    return e


def sweep(sec, f0, f1, h3=0.25):
    """an exponential sweep f0 -> f1 with a little third harmonic (a triangle-ish, digital voice)"""
    t = tvec(sec)
    f = f0 * (f1 / f0) ** (t / sec)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) + h3 * np.sin(3 * ph)) / (1 + h3)


def place(buf, start, x):
    i = int(SR * start)
    buf[i:i + len(x)] += x[: len(buf) - i]


def hold(x, k):
    """sample-and-hold every k samples: the grit of a cheap converter"""
    y = x.copy()
    for i in range(0, len(y), k):
        y[i:i + k] = x[i]
    return y


def save(name, x):
    """16-bit, scaled to an RMS of TARGET_RMS (the original ooc.wav is 8-bit with a peak of 0.12 and an RMS of 0.026, a very quiet file)"""
    x = x / np.sqrt(np.mean(x ** 2)) * TARGET_RMS
    peak = float(np.max(np.abs(x)))
    if peak > 0.9:
        x = x * (0.9 / peak)
    pcm = np.round(np.clip(x, -1, 1) * 32767).astype("<i2")
    p = os.path.join(out, name)
    w = wave.open(p, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
    w.close()
    f = x.astype(np.float64)
    spec = np.abs(np.fft.rfft(f * np.hanning(len(f))))
    freq = np.fft.rfftfreq(len(f), 1.0 / SR)
    centroid = float((spec * freq).sum() / spec.sum())
    print("%-24s %5.3f s  peak %.2f  rms %.3f  centroid %4.0f Hz  first/last sample %d/%d" % (
        name, len(x) / SR, np.max(np.abs(x)), np.sqrt(np.mean(f ** 2)), centroid, pcm[0], pcm[-1]))


# A: a rising two-step digital chirp, then a high ping that rings out
buf = np.zeros(int(SR * 0.40))
b1 = hold(sweep(0.075, 900, 1500), 2) * env(tvec(0.075), 0.003, 0.05)
b2 = hold(sweep(0.075, 1350, 2250), 2) * env(tvec(0.075), 0.003, 0.05)
place(buf, 0.000, fade(b1, 0.002, 0.01) * 0.9)
place(buf, 0.080, fade(b2, 0.002, 0.01) * 0.9)
t = tvec(0.25)
ping = (np.sin(2 * np.pi * 2700 * t) + 0.35 * np.sin(2 * np.pi * 5400 * t) * np.exp(-t / 0.03)) * env(t, 0.002, 0.075)
place(buf, 0.158, fade(ping, 0.002, 0.03))
save("ooc_tech_A_chirp.wav", buf)

# B: a terminal's three-note acknowledgement, square voices (odd harmonics only), a little crushed
buf = np.zeros(int(SR * 0.36))


def square(freq, sec):
    t = tvec(sec)
    x = np.zeros_like(t)
    for k in (1, 3, 5, 7):
        x += np.sin(2 * np.pi * freq * k * t) / k
    return x


for i, f in enumerate((1046.5, 1568.0, 2093.0)):
    s = square(f, 0.05) * env(tvec(0.05), 0.002, 0.04)
    place(buf, 0.0 + i * 0.062, fade(s, 0.002, 0.008) * 0.7)
t = tvec(0.20)
place(buf, 0.19, fade(np.sin(2 * np.pi * 2093 * t) * env(t, 0.002, 0.06), 0.002, 0.03) * 0.8)
buf = np.round(buf * 40) / 40.0
save("ooc_tech_B_blip.wav", buf)

# C: a console sonar ping, a metallic partial series with a faint echo
buf = np.zeros(int(SR * 0.50))
t = tvec(0.38)
parts = [(1.0, 1.00, 0.20), (2.76, 0.50, 0.13), (5.40, 0.25, 0.08), (8.93, 0.12, 0.05)]
bell = sum(a * np.sin(2 * np.pi * 1760 * m * t) * env(t, 0.0015, d) for m, a, d in parts)
rng = np.random.RandomState(7)
click = rng.uniform(-1, 1, int(SR * 0.004)) * np.linspace(1, 0, int(SR * 0.004)) * 0.6
bell[: len(click)] += click
place(buf, 0.0, fade(bell, 0.001, 0.04))
place(buf, 0.115, fade(bell, 0.001, 0.04) * 0.35)
save("ooc_tech_C_sonar.wav", buf)
