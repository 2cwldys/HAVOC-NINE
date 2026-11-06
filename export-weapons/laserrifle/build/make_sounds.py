"""The laser rifle's sounds, made here from nothing but arithmetic (no recording, so nothing to credit or license).

  h9/laserrifle/fire.wav      the blaster: a pitch that falls fast, a crackle, a thump and a tail
  h9/laserrifle/hit1..3.wav   a bolt landing: a fizz and a snap, three of them
  h9/laserrifle/reload.wav    an energy cell going in and out: release hiss, latch, charge whine, ready chime

TS plays a weapon's shot, and a bolt's landing here, at four times their speed (pitch 100 + 300 x the slow motion
factor: 400 at normal speed), so those are stored four times too slow as TS's own are: 22050 Hz, the sound twice as
many samples as it was made with (a windowed sinc), which the game's four times speed plays back as it was made. The
reload sound plays at its own speed (the game's pitch for it is 100 at normal speed) and is stored as made.

usage: py -3 make_sounds.py <out dir>
"""
import os
import sys
import wave
import numpy as np

out = sys.argv[1]
os.makedirs(f"{out}/h9/laserrifle", exist_ok=True)
SR = 44100
rng = np.random.default_rng(20261105)


def bandpass(x, lo, hi):
    """A brick wall band over a signal by the FFT: crude and enough for noise."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1.0 / SR)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))


def env_exp(t, tau, attack=0.0006):
    return np.exp(-t / tau) * (1.0 - np.exp(-t / attack))


def finish(x, tail_ms=40):
    """Peak to -1 dB, the last stretch faded to exact silence (no click), a little DC removed."""
    x = x - x.mean() * np.linspace(1, 0, len(x))
    fade = int(SR * tail_ms / 1000)
    x[-fade:] *= np.linspace(1.0, 0.0, fade) ** 2
    x[-1] = 0.0
    return x * ((10 ** (-1 / 20)) / np.max(np.abs(x)))


def echo(x, taps):
    y = x.copy()
    for delay, gain in taps:
        d = int(SR * delay)
        y[d:] += x[:-d] * gain
    return y


def store_slow(x):
    """The 4x slow form: the samples twice over (a windowed sinc), labelled 22050 Hz."""
    taps = 129
    n = np.arange(taps) - taps // 2
    h = 2.0 * np.sinc(n / 2.0) * np.kaiser(taps, 8.6)
    z = np.zeros(len(x) * 2)
    z[::2] = x
    y = np.convolve(z, h, mode="full")[taps // 2: taps // 2 + len(z)]
    y[-1] = 0.0
    y *= (10 ** (-1 / 20)) / np.max(np.abs(y))
    return y


def write(path, y, rate):
    pcm = np.round(np.clip(y, -1, 1) * 32767).astype("<i2")
    w = wave.open(path, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(pcm.tobytes())
    w.close()
    print(f"{path}: {rate} Hz, {len(pcm) / rate:.2f} s, peak {np.max(np.abs(pcm)) / 32767:.3f}")


# ---- the blaster
def blaster(seed=0, drop=0.045, top=2600.0, base=170.0, length=0.5):
    r = np.random.default_rng(1000 + seed)
    n = int(SR * length)
    t = np.arange(n) / SR
    f = base + top * np.exp(-t / drop)                     # the pitch falls fast
    phase = 2 * np.pi * np.cumsum(f) / SR
    tone = np.sin(phase) + 0.45 * np.sin(2 * phase + 0.7) + 0.22 * (((phase / np.pi) % 2.0) - 1.0)
    core = tone * env_exp(t, 0.10)
    crackle = bandpass(r.normal(size=n), 900, 7500) * env_exp(t, 0.045, 0.0003)
    thump = np.sin(2 * np.pi * (62 + 60 * np.exp(-t / 0.03)) * t) * env_exp(t, 0.07, 0.0008)
    wub = np.sin(2 * np.pi * 96 * t + 3.5 * np.sin(2 * np.pi * 31 * t)) * env_exp(t, 0.15, 0.004)
    zap = np.sin(2 * np.pi * 3300 * t) * np.sin(2 * np.pi * 51 * t) * env_exp(t, 0.08, 0.0008)
    click = np.zeros(n)
    k = int(SR * 0.0035)
    click[:k] = r.normal(size=k) * np.linspace(1.0, 0.0, k)
    mix = 0.55 * core + 0.50 * crackle + 0.75 * thump + 0.35 * wub + 0.22 * zap + 0.55 * click
    mix = np.tanh(1.9 * mix) / np.tanh(1.9)
    mix = echo(mix, [(0.031, 0.26), (0.067, 0.13)])
    return finish(mix)


# ---- a bolt landing: a quick downward chirp, a fizz of noise and a few pops
def hit(seed):
    r = np.random.default_rng(2000 + seed)
    n = int(SR * (0.30 + 0.04 * seed))
    t = np.arange(n) / SR
    f = 380 + (1500 + 260 * seed) * np.exp(-t / 0.035)
    chirp = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(t, 0.06, 0.0005)
    fizz = bandpass(r.normal(size=n), 2200 + 500 * seed, 9500) * env_exp(t, 0.11 + 0.02 * seed, 0.0008)
    pops = np.zeros(n)
    for _ in range(int(7 + 2 * seed)):
        at = int(r.uniform(0.01, 0.20) * SR)
        ln = int(SR * r.uniform(0.0008, 0.002))
        pops[at:at + ln] += r.normal(size=ln) * np.linspace(1, 0, ln) * r.uniform(0.4, 1.0)
    thud = np.sin(2 * np.pi * (110 - 30 * seed) * t) * env_exp(t, 0.05, 0.001)
    mix = 0.55 * chirp + 0.65 * fizz + 0.50 * pops + 0.55 * thud
    mix = np.tanh(1.6 * mix) / np.tanh(1.6)
    return finish(mix, 30)


# ---- the energy cell reload: the viewmodel's own clip out comes at 0.49 s, clip in at 1.37 s, the bolt at 2.34 s
def reload():
    n = int(SR * 2.7)
    x = np.zeros(n)

    def put(at, y, gain=1.0):
        i = int(SR * at)
        m = min(len(y), n - i)
        x[i:i + m] += y[:m] * gain

    def add(*ys):
        m = max(len(y) for y in ys)
        total = np.zeros(m)
        for y in ys:
            total[:len(y)] += y
        return total

    def ping(f, dur, tau, amp=1.0):
        t = np.arange(int(SR * dur)) / SR
        return np.sin(2 * np.pi * f * t) * np.exp(-t / tau) * amp

    def noise_burst(dur, lo, hi, tau, attack=0.002):
        t = np.arange(int(SR * dur)) / SR
        return bandpass(rng.normal(size=len(t)), lo, hi) * env_exp(t, tau, attack)

    # the cell released: a pneumatic hiss and a latch
    put(0.40, noise_burst(0.30, 2500, 9000, 0.09), 0.55)
    put(0.47, add(ping(1900, 0.2, 0.05, 0.5), ping(3100, 0.15, 0.03, 0.3)))
    put(0.47, noise_burst(0.03, 600, 6000, 0.008, 0.0004), 0.9)
    put(0.52, np.sin(2 * np.pi * 95 * np.arange(int(SR * 0.12)) / SR) * np.exp(-np.arange(int(SR * 0.12)) / SR / 0.04), 0.7)
    # the new cell slid in and locked
    put(1.28, noise_burst(0.14, 1200, 5500, 0.04, 0.003), 0.4)
    put(1.36, noise_burst(0.025, 500, 5000, 0.006, 0.0004), 1.0)
    put(1.36, add(ping(140, 0.16, 0.05, 0.9), ping(2300, 0.1, 0.02, 0.35)))
    # the charge: a whine that climbs, a flutter in it, and a hum under it
    dur = 0.80
    t = np.arange(int(SR * dur)) / SR
    f = 260 + 1900 * (t / dur) ** 1.7
    whine = np.sin(2 * np.pi * np.cumsum(f) / SR) * (0.5 + 0.5 * np.sin(2 * np.pi * (14 + 30 * t / dur) * t)) * np.minimum(t / 0.05, 1.0) * np.minimum((dur - t) / 0.08, 1.0)
    hum = np.sin(2 * np.pi * 60 * t) * np.minimum(t / 0.1, 1.0) * np.minimum((dur - t) / 0.2, 1.0)
    put(1.46, whine, 0.30)
    put(1.46, hum, 0.35)
    # ready: two soft tones
    put(2.30, ping(880, 0.35, 0.12, 0.38))
    put(2.37, ping(1320, 0.4, 0.15, 0.30))
    x = np.tanh(1.2 * x) / np.tanh(1.2)
    return finish(x, 60)


fire = blaster()
write(f"{out}/h9/laserrifle/fire.wav", store_slow(fire), SR // 2)
for i in range(3):
    write(f"{out}/h9/laserrifle/hit{i + 1}.wav", store_slow(hit(i)), SR // 2)
write(f"{out}/h9/laserrifle/reload.wav", reload(), SR)
# a look at the shot (the sound as it is heard at normal speed)
np.save(f"{out}/fire_heard.npy", fire)
