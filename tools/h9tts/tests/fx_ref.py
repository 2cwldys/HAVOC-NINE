"""fx_ref.py -- the reference implementation (numpy) of the H9 text-to-speech effect chains (24 kHz, mono, float): reTS/cl_dll/h9_tts_fx.h is checked against it.

Every block here is something plain C++ does with a loop and <math.h>: RBJ biquads, one multiply per sample for ring
modulation / tremolo, a delay line, a tanh waveshaper, sample-and-hold plus rounding, a xorshift32 noise source, cubic
Hermite resampling, a gated RMS and a soft limiter. No FFT, no library. scipy.signal.lfilter is used for the biquads only
because it is the same direct-form difference equation in C (the C++ code in reTS/cl_dll/h9_tts_fx.h is checked against this file).

Chain text (one stage per word, parameters after '='):
    lowpass=1800,0.7071  peak=700,1.2,4*s  breath=200,320,-20,-44,500
A number written A/s is A / (1 + s); written A*s it is A * s (s = cl_h9_tts_muffle for a mask chain, 1 otherwise).

Stage reference (f = Hz, q = Q, db = dB; every filter is a biquad run on doubles, direct form):
    lowpass=f,q     highpass=f,q    bandpass=f,q (RBJ constant 0 dB peak gain)    peak=f,q,db
    lowshelf=f,db   highshelf=f,db  (RBJ shelves, slope S = 1)
    ringmod=hz,depth      y = x * ((1 - depth) + depth * sin(2 pi hz n / sr))           (carrier phase 0 at sample 0)
    tremolo=hz,depth      y = x * (1 - depth * (0.5 - 0.5 sin(2 pi hz n / sr)))
    bitcrush=bits,hold    y[n] = round(x[hold * floor(n / hold)] * 2^(bits-1)) / 2^(bits-1)
    saturate=drive        y = tanh(drive * x) / tanh(drive)
    comb=ms,fb            y[n] = x[n] + fb * y[n - D],  D = round(ms * sr / 1000)  (feedback comb; fb in -0.9..0.9)
    noise=db,follow       white noise (xorshift32), RMS = gated RMS of the line * 10^(db/20); follow 0 = constant,
                          1 = multiplied by the line's own 20 ms envelope (smoothed, peak 1)
    gain=db               y = x * 10^(db/20)
    breath=pre_ms,post_ms,burst_db,leak_db,center_hz
                          deterministic breathing around and under the line: see breath()
    clip=thr              y = clamp(x, -thr, +thr)   (hard clip, thr relative to full scale 1.0)
"""
import math

import numpy as np
from scipy.signal import lfilter

SR = 24000
TARGET_DB = -18.0       # loudness every spoken line is brought to (gated RMS, dBFS); SAPI's David and Zira measure -18.4 / -18.2 on the same lines
LIMIT_KNEE = 0.80       # soft limiter: linear below, tanh above, asymptote 1.0


# ---- parameters ---------------------------------------------------------------------------------------------------

def val(tok, s):
    """'1800/s' -> 1800 / (1 + s); '4*s' -> 4 * s; '700' -> 700."""
    tok = str(tok)
    if tok.endswith("/s"):
        return float(tok[:-2]) / (1.0 + s)
    if tok.endswith("*s"):
        return float(tok[:-2]) * s
    return float(tok)


def parse_chain(text):
    stages = []
    for word in text.split():
        if "=" in word:
            name, params = word.split("=", 1)
            stages.append((name, params.split(",")))
        else:
            stages.append((word, []))
    return stages


# ---- biquads ------------------------------------------------------------------------------------------------------

def _norm(b0, b1, b2, a0, a1, a2):
    return np.array([b0 / a0, b1 / a0, b2 / a0]), np.array([1.0, a1 / a0, a2 / a0])


def bq(kind, f, q=0.7071, db=0.0, sr=SR):
    f = min(max(f, 10.0), 0.45 * sr)
    w0 = 2.0 * math.pi * f / sr
    c, sn = math.cos(w0), math.sin(w0)
    if kind == "lowpass":
        al = sn / (2 * q)
        return _norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al)
    if kind == "highpass":
        al = sn / (2 * q)
        return _norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al)
    if kind == "bandpass":
        al = sn / (2 * q)
        return _norm(al, 0.0, -al, 1 + al, -2 * c, 1 - al)
    if kind == "peak":
        a = 10 ** (db / 40.0)
        al = sn / (2 * q)
        return _norm(1 + al * a, -2 * c, 1 - al * a, 1 + al / a, -2 * c, 1 - al / a)
    a = 10 ** (db / 40.0)
    al = sn / 2.0 * math.sqrt(2.0)          # shelf slope S = 1
    sa = 2 * math.sqrt(a) * al
    if kind == "lowshelf":
        return _norm(a * ((a + 1) - (a - 1) * c + sa), 2 * a * ((a - 1) - (a + 1) * c), a * ((a + 1) - (a - 1) * c - sa),
                     (a + 1) + (a - 1) * c + sa, -2 * ((a - 1) + (a + 1) * c), (a + 1) + (a - 1) * c - sa)
    if kind == "highshelf":
        return _norm(a * ((a + 1) + (a - 1) * c + sa), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - sa),
                     (a + 1) - (a - 1) * c + sa, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - sa)
    raise ValueError(kind)


def run_bq(x, ba):
    return lfilter(ba[0], ba[1], x)


# ---- level --------------------------------------------------------------------------------------------------------

def frame_energy(x, sr=SR):
    win, hop = int(0.020 * sr), int(0.010 * sr)
    n = (len(x) - win) // hop + 1
    if n <= 0:
        return np.array([float(np.mean(np.square(x))) + 1e-20])
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    return np.mean(np.square(x[idx]), axis=1) + 1e-20


def gated_rms(x, sr=SR, gate_db=-20.0):
    e = frame_energy(x, sr)
    return float(np.sqrt(np.mean(e[e >= e.max() * 10 ** (gate_db / 10.0)])))


def soft_limit(x, knee=LIMIT_KNEE):
    a = np.abs(x)
    over = a > knee
    y = x.copy()
    y[over] = np.sign(x[over]) * (knee + (1 - knee) * np.tanh((a[over] - knee) / (1 - knee)))
    return y


def normalize(x, target_db=TARGET_DB, sr=SR):
    """Scale to the target gated RMS, then soft-limit. Returns (y, fraction of samples the limiter touched)."""
    g = 10 ** (target_db / 20.0) / max(gated_rms(x, sr), 1e-9)
    y = x * g
    touched = float(np.mean(np.abs(y) > LIMIT_KNEE))
    return soft_limit(y), touched


# ---- resampling ---------------------------------------------------------------------------------------------------

def resample(x, speed):
    """Play x speed times as fast (pitch and tempo move together): cubic Hermite (Catmull-Rom) interpolation.
    New length = floor(len / speed); out[i] reads x at position i * speed; indices are clamped at both ends."""
    n = int(len(x) / speed)
    if n < 2:
        return x
    pos = np.arange(n) * speed
    i1 = np.floor(pos).astype(np.int64)
    t = pos - i1
    last = len(x) - 1
    p0 = x[np.clip(i1 - 1, 0, last)]
    p1 = x[np.clip(i1, 0, last)]
    p2 = x[np.clip(i1 + 1, 0, last)]
    p3 = x[np.clip(i1 + 2, 0, last)]
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))


# ---- noise --------------------------------------------------------------------------------------------------------

def xorshift_noise(n, seed=2463534242):
    """White noise in [-1, 1) from xorshift32 (the C++ loop is three shifts and three xors per sample)."""
    out = np.empty(n)
    st = seed & 0xFFFFFFFF
    for i in range(n):
        st ^= (st << 13) & 0xFFFFFFFF
        st ^= st >> 17
        st ^= (st << 5) & 0xFFFFFFFF
        out[i] = st / 2147483648.0 - 1.0
    return out


# ---- stages -------------------------------------------------------------------------------------------------------

def env_follow(x, sr=SR):
    """The line's envelope, peak 1: |x| smoothed by a one-pole low-pass (time constant 20 ms), then divided by its maximum."""
    a = math.exp(-1.0 / (0.020 * sr))
    e = lfilter([1 - a], [1, -a], np.abs(x))
    return e / max(e.max(), 1e-12)


def breath(x, pre_ms, post_ms, burst_db, leak_db, center_hz, s, sr=SR):
    """Breathing through a respirator, deterministic.

    n = pre + len(x) + post samples. Noise: xorshift32 white -> bandpass(center_hz, Q 0.7) -> lowpass(1800 Hz, Q 0.7071),
    scaled to RMS 1 over the whole run. Reference level L = gated RMS of the voice x.
      leak   = noise * L * 10^(leak_db/20) * s                 over the whole output (constant air leak)
      inhale = noise * L * 10^(burst_db/20) * s * e_in(t)      in the first pre samples,  e_in = sin^2(pi/2 * t/T)
      exhale = noise * L * 10^(burst_db/20) * s * e_out(t)     in the last post samples, e_out = (1-t/T)^1.5 after a 10 ms ramp
    The voice sits between them untouched. burst_db is the burst's peak level below the voice RMS, leak_db the constant level."""
    pre, post = int(round(pre_ms * sr / 1000.0)), int(round(post_ms * sr / 1000.0))
    n = pre + len(x) + post
    nz = xorshift_noise(n)
    nz = run_bq(nz, bq("bandpass", center_hz, 0.7, sr=sr))
    nz = run_bq(nz, bq("lowpass", 1800.0, 0.7071, sr=sr))
    nz = nz / max(math.sqrt(float(np.mean(nz ** 2))), 1e-12)
    L = gated_rms(x, sr)
    burst = L * 10 ** (burst_db / 20.0) * s
    leak = L * 10 ** (leak_db / 20.0) * s
    env = np.zeros(n)
    if pre > 0:
        t = np.arange(pre) / pre
        env[:pre] = np.sin(0.5 * math.pi * t) ** 2
    if post > 0:
        t = np.arange(post) / post
        ramp = np.minimum(1.0, np.arange(post) / max(1.0, 0.010 * sr))
        env[pre + len(x):] = (1 - t) ** 1.5 * ramp
    out = nz * (leak + burst * env)
    out[pre:pre + len(x)] += x
    return out


def stage(x, name, p, s, sr=SR):
    v = [val(t, s) for t in p]
    if name in ("lowpass", "highpass", "bandpass"):
        return run_bq(x, bq(name, v[0], v[1], sr=sr))
    if name == "peak":
        return run_bq(x, bq("peak", v[0], v[1], v[2], sr=sr))
    if name in ("lowshelf", "highshelf"):
        return run_bq(x, bq(name, v[0], db=v[1], sr=sr))
    if name == "ringmod":
        n = np.arange(len(x))
        return x * ((1 - v[1]) + v[1] * np.sin(2 * math.pi * v[0] * n / sr))
    if name == "tremolo":
        n = np.arange(len(x))
        return x * (1 - v[1] * (0.5 - 0.5 * np.sin(2 * math.pi * v[0] * n / sr)))
    if name == "bitcrush":
        bits, hold = int(round(v[0])), max(1, int(round(v[1])))
        y = x[(np.arange(len(x)) // hold) * hold]
        q = 2.0 ** (bits - 1)
        return np.round(y * q) / q
    if name == "saturate":
        return np.tanh(v[0] * x) / math.tanh(v[0])
    if name == "clip":
        return np.clip(x, -v[0], v[0])
    if name == "comb":
        d = max(1, int(round(v[0] * sr / 1000.0)))
        a = np.zeros(d + 1)
        a[0] = 1.0
        a[d] = -v[1]
        return lfilter([1.0], a, x)
    if name == "noise":
        nz = xorshift_noise(len(x))
        nz = nz / max(math.sqrt(float(np.mean(nz ** 2))), 1e-12)
        amp = gated_rms(x, sr) * 10 ** (v[0] / 20.0)
        shape = (1 - v[1]) + v[1] * env_follow(x, sr)
        return x + nz * amp * shape
    if name == "gain":
        return x * 10 ** (v[0] / 20.0)
    if name == "breath":
        return breath(x, v[0], v[1], v[2], v[3], v[4], s, sr)
    raise ValueError("unknown stage " + name)


def run_chain(x, chain, s=1.0, sr=SR):
    """chain: a text such as 'lowpass=1800/s,0.7071 peak=700,1.2,4*s' or the parsed list."""
    stages = parse_chain(chain) if isinstance(chain, str) else chain
    y = np.asarray(x, dtype=np.float64)
    for name, p in stages:
        y = stage(y, name, p, s, sr)
    return y


# ---- the end of a line: volume and pan ------------------------------------------------------------------------------

def pan_gains(pan, volume=1.0, pan_range=0.85, headroom=0.6, pan_gain=1.2):
    """Constant-power pan as h9_tts_win.cpp does it today: theta = (pan * range + 1) * pi/4, left = cos, right = sin."""
    pan = max(-1.0, min(1.0, pan))
    th = (pan * pan_range + 1.0) * math.pi / 4.0
    g = volume * headroom * pan_gain
    return g * math.cos(th), g * math.sin(th)


def pipeline(x, chain, s=1.0, speed=1.0, norm_before=True, norm_after=True, sr=SR):
    """Resample, normalise, chain, normalise: the order the game uses (see chains.txt). x float32/float64 mono."""
    y = np.asarray(x, dtype=np.float32).astype(np.float64)
    if speed != 1.0:
        y = resample(y, speed)
    if norm_before:
        y, _ = normalize(y, sr=sr)
    y = run_chain(y, chain, s, sr)
    if norm_after:
        y, _ = normalize(y, sr=sr)
    return y
