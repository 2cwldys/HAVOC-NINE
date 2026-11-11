#!/usr/bin/env python3
"""prerender_lines.py -- renders the lines of H9's text to speech that are known ahead of time, with Kokoro, for the line pack.

For every (voice variant, line) the raw trimmed Kokoro line (24 kHz mono float32) is written to <work>/raw/<id>.f32 and one row to
<work>/manifest.tsv:   voice key <TAB> cleaned text <TAB> path.   The h9pk tool then packs the manifest into h9tts/lines/lines.h9pk.
The work folder is a cache: a clip that exists is not rendered again, so the job can be stopped and started again (--max-seconds
stops it cleanly after that much work, for a job that must hand the PC back to others in turns).

What the client does with a line is in reTS/cl_dll/h9_tts_kokoro.cpp: it looks the line up by its voice key and its text, so both are
built here exactly as the client builds them (voice_key = h9fx::VoiceKey, clean_text = CleanText of h9_tts.cpp). Every voice gets the
American phonemes, as the helper process does (the British voices are fed American phonemes in the game: docs\\TEXT_TO_SPEECH.txt).

usage
  prerender_lines.py --catalogue h9tts/voices.txt --chains h9tts/chains.txt --model <model.onnx> --voices <voices dir> --vocab <config.json>
                     --work <folder> --variants man:1-2,woman:1-2,mech:1,bot:1,droid:1
                     --source rcbot:H9XASH/rcbot/bot_chat.ini --source file:h9tts/lines_extra.txt [--source botsay:H9XASH/ts/bot_say.txt]
                     [--threads 3] [--max-seconds 480] [--limit N]

Needs: numpy, onnxruntime, misaki[en] with its espeak-ng loader and spaCy's en_core_web_sm (the voice study's environment).
"""
import argparse
import hashlib
import os
import sys
import time

import numpy as np

SR = 24000


def clean_text(s):
    """CleanText of h9_tts.cpp: a control character is a space, a run of spaces is one, the ends are trimmed."""
    out = []
    space = True
    for ch in s:
        c = ord(ch)
        if c < 32 or c == 127:
            ch = " "
        if ch == " ":
            if not space:
                out.append(" ")
                space = True
            continue
        space = False
        out.append(ch)
    while out and out[-1] == " ":
        out.pop()
    return "".join(out)


def speakable(s):
    """A line with a letter, a digit or a non-ASCII character in it (h9_tts.cpp CleanText)."""
    return any(("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9") or ord(ch) >= 128 for ch in s)


def read_source(kind, path, max_chars):
    """The fixed lines of a source: lines with a % in them (a name is put in at run time) are not known ahead."""
    lines = []
    with open(path, encoding="latin-1") as f:
        block_first = True
        for raw in f:
            t = raw.rstrip("\r\n")
            if kind == "rcbot":
                if not t.strip() or t.startswith("#") or t.startswith("["):
                    continue
            elif kind == "botsay":
                if not t.strip():
                    block_first = True
                    continue
                if block_first:  # the first line of a block is its category
                    block_first = False
                    continue
            elif kind == "file":
                if not t.strip() or t.startswith("//") or t.startswith("#"):
                    continue
            else:
                raise SystemExit("unknown source kind " + kind)
            t = clean_text(t)
            if "%" in t or not speakable(t) or t[:1] in ("/", ".", "!", "@") or len(t) > max_chars:
                continue
            lines.append(t)
    return lines


def parse_blend(text):
    out = []
    for part in text.split("+"):
        if ":" in part:
            n, w = part.split(":", 1)
            out.append((n, float(w)))
        else:
            out.append((part, 1.0))
    return out


def voice_key(blend, speed):
    """h9fx::VoiceKey of h9_tts_catalogue.h."""
    total = float(sum(w for _, w in blend))
    if len(blend) == 1:
        name = blend[0][0]
    else:
        name = "+".join("%s:%.2f" % (n, w / total) for n, w in blend)
    return "%s@%.2f" % (name, speed)


def load_catalogue(path):
    kinds = {}
    with open(path, encoding="ascii") as f:
        for n, raw in enumerate(f, 1):
            line = raw.split("//", 1)[0].strip()
            if not line:
                continue
            t = line.split()
            if t[0] == "variant":
                kinds.setdefault(t[1], []).append(
                    dict(kind=t[1], index=int(t[2]), name=t[3], lang=t[4], blend=parse_blend(t[5]), speed=float(t[6])))
    return kinds


def parse_variants(spec, kinds):
    """'man:1-2,woman:1-2,mech:1' -> [(kind, index)]."""
    out = []
    for part in spec.split(","):
        kind, rng = part.split(":")
        a, _, b = rng.partition("-")
        for i in range(int(a), int(b or a) + 1):
            if kind not in kinds or i < 1 or i > len(kinds[kind]):
                raise SystemExit("no variant %s %d in the catalogue" % (kind, i))
            out.append((kind, i))
    return out


def read_consts(path):
    consts = {}
    with open(path, encoding="ascii") as f:
        for raw in f:
            line = raw.split("//", 1)[0].split()
            if len(line) >= 3 and line[0] == "const":
                consts[line[1]] = float(line[2])
    return consts


def trim(x, thr_db, pad_s):
    """h9fx::Trim: the near-silence around the line goes; pad_s is kept on each side and a 10 ms raised-cosine fade closes both ends."""
    x = np.asarray(x, dtype=np.float32)
    win, hop = int(0.010 * SR), int(0.005 * SR)
    n = (len(x) - win) // hop + 1
    if n <= 0:
        return x
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    env = np.sqrt(np.mean(x[idx].astype(np.float64) ** 2, axis=1))
    thr = env.max() * 10 ** (thr_db / 20.0)
    above = np.nonzero(env >= thr)[0]
    if len(above) == 0:
        return x
    a = max(0, above[0] * hop - int(pad_s * SR))
    b = min(len(x), above[-1] * hop + win + int(pad_s * SR))
    y = x[a:b].copy()
    f = min(int(0.010 * SR), len(y) // 2)
    if f > 1:
        ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(f) / f)
        y[:f] *= ramp
        y[-f:] *= ramp[::-1]
    return y


class Synth:
    def __init__(self, model, voices_dir, vocab_json, threads):
        import json

        import onnxruntime as ort
        from misaki import en, espeak

        self.vocab = json.load(open(vocab_json, encoding="utf-8"))["vocab"]
        self.voices_dir = voices_dir
        self.packs = {}
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        so.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self.sess = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
        self.g2p = en.G2P(trf=False, british=False, fallback=espeak.EspeakFallback(british=False), unk="")

    def pack(self, name):
        if name not in self.packs:
            raw = np.fromfile(os.path.join(self.voices_dir, name + ".bin"), dtype=np.float32)
            self.packs[name] = raw.reshape(-1, 1, 256)
        return self.packs[name]

    def say(self, text, blend, speed):
        ps = self.g2p(text)[0]
        ids = [self.vocab[c] for c in ps if c in self.vocab]
        if not ids or len(ids) > 510:
            return None, ps
        total = float(sum(w for _, w in blend))
        acc = np.zeros(256, dtype=np.float64)
        for name, w in blend:
            acc += self.pack(name)[len(ids) - 1, 0, :].astype(np.float64) * (w / total)
        feeds = {
            "input_ids": np.array([[0, *ids, 0]], dtype=np.int64),
            "style": acc.astype(np.float32).reshape(1, 256),
            "speed": np.array([speed], dtype=np.float32),
        }
        return np.asarray(self.sess.run(None, feeds)[0]).astype(np.float32).ravel(), ps


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalogue", required=True)
    ap.add_argument("--chains", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--voices", required=True)
    ap.add_argument("--vocab", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--variants", default="man:1-2,woman:1-2,mech:1,bot:1,droid:1")
    ap.add_argument("--source", action="append", default=[])
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--max-seconds", type=float, default=0)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-chars", type=int, default=96)
    args = ap.parse_args()

    kinds = load_catalogue(args.catalogue)
    variants = parse_variants(args.variants, kinds)
    consts = read_consts(args.chains)
    thr_db, pad_s = consts.get("trim_db", -46.0), consts.get("trim_pad_ms", 50.0) / 1000.0

    lines = []
    for src in args.source:
        kind, _, path = src.partition(":")
        got = read_source(kind, path, args.max_chars)
        print("source %s: %d fixed lines" % (src, len(got)))
        lines.extend(got)
    lines = sorted(set(lines))
    if args.limit:
        lines = lines[: args.limit]
    print("%d unique lines x %d variants = %d clips" % (len(lines), len(variants), len(lines) * len(variants)))

    raw_dir = os.path.join(args.work, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    manifest_path = os.path.join(args.work, "manifest.tsv")
    have = {}
    if os.path.exists(manifest_path):
        for row in open(manifest_path, encoding="utf-8"):
            parts = row.rstrip("\n").split("\t")
            if len(parts) == 3:
                have[(parts[0], parts[1])] = parts[2]

    synth = None
    start = time.time()
    done = skipped = failed = 0
    audio_s = 0.0
    with open(manifest_path, "a", encoding="utf-8") as man:
        for kind, index in variants:
            v = kinds[kind][index - 1]
            key = voice_key(v["blend"], v["speed"])
            for text in lines:
                if (key, text) in have and os.path.exists(have[(key, text)]):
                    skipped += 1
                    continue
                if args.max_seconds and time.time() - start > args.max_seconds:
                    print("stopped after %.0f s: %d rendered, %d already there, %d failed" % (time.time() - start, done, skipped, failed))
                    return 0
                if synth is None:
                    synth = Synth(args.model, args.voices, args.vocab, args.threads)
                wav, ps = synth.say(text, v["blend"], v["speed"])
                if wav is None:
                    print("FAILED (no phonemes or too long): %r -> %r" % (text, ps))
                    failed += 1
                    continue
                wav = trim(wav, thr_db, pad_s)
                name = hashlib.sha1((key + "\n" + text).encode("utf-8")).hexdigest()[:20] + ".f32"
                path = os.path.join(raw_dir, name)
                wav.astype("<f4").tofile(path)
                man.write("%s\t%s\t%s\n" % (key, text, path))
                man.flush()
                done += 1
                audio_s += len(wav) / SR
                if done % 20 == 0:
                    print("%d rendered, %.0f s of audio, %.0f s of work" % (done, audio_s, time.time() - start), flush=True)
    print("finished: %d rendered (%.0f s of audio), %d already there, %d failed, %.0f s" % (done, audio_s, skipped, failed, time.time() - start))
    return 0


if __name__ == "__main__":
    sys.exit(main())
