"""The transporter's teleport sound: sound/tsm_tpad/hum.wav -- a faint, slow, wavering hum (about 0.9 s, 22.05 kHz, mono, 16 bit), peak
about a third of full scale so it sits under gunfire. Played at the pad you leave and the pad you arrive at.

    python modelling/make-transporter-sound.py [output folder, default sound/tsm_tpad]
"""
import math, os, struct, sys, wave

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sound", "tsm_tpad")
os.makedirs(OUT, exist_ok=True)
RATE = 22050
SECS = 0.9
N = int(RATE * SECS)
frames = bytearray()
for i in range(N):
    t = i / RATE
    # a low base tone and a fifth above it, each waving slowly in pitch, and a slow tremolo
    wob = math.sin(2 * math.pi * 5.0 * t)
    f1 = 150.0 + 14.0 * wob
    f2 = 225.0 + 10.0 * math.sin(2 * math.pi * 3.5 * t + 1.0)
    ph1 = 2 * math.pi * (150.0 * t - 14.0 / (2 * math.pi * 5.0) * math.cos(2 * math.pi * 5.0 * t))
    ph2 = 2 * math.pi * (225.0 * t - 10.0 / (2 * math.pi * 3.5) * math.cos(2 * math.pi * 3.5 * t + 1.0))
    tone = 0.62 * math.sin(ph1) + 0.30 * math.sin(ph2) + 0.08 * math.sin(2 * ph1)
    trem = 0.80 + 0.20 * math.sin(2 * math.pi * 7.0 * t)
    # a soft rise and a longer fall, so nothing clicks at either end
    env = min(1.0, t / 0.12) * min(1.0, (SECS - t) / 0.45)
    env = env * env * (3 - 2 * env) if env < 1.0 else 1.0
    v = tone * trem * env * 0.34
    frames += struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
with wave.open(os.path.join(OUT, "hum.wav"), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(bytes(frames))
print("wrote", os.path.join(OUT, "hum.wav"), len(frames) + 44, "bytes")
