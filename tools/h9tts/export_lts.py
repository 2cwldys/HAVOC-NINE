#!/usr/bin/env python3
"""export_lts.py -- writes en_us.h9lt, the letter-to-sound trees of the helper's out-of-dictionary chain (layout: tools/h9kokoro64/src/oov.h).

The trees are scikit-learn decision trees trained on the pronunciation lexicon itself (one tree for each letter, features: the letters around it, the
first and last letters, vowel groups to the left and right, the distance to the ends). This script turns a trained model file (the pickle the training
script writes) into the compact file, then reads the file back with an evaluator written like the C++ one and checks it predicts exactly what the
scikit-learn trees predict on the words of the lexicon.

usage: export_lts.py --models <lts_models_A.pkl> --leaf 4 --vocab <hf-kokoro-orig/config.json> --out <h9tts>/g2p/en_us.h9lt [--check-words N] [--proto <folder with lts_train.py>]
"""
import argparse
import json
import pickle
import struct
import sys
import zlib

import numpy as np

MAGIC = b"H9LT"
LEAF = 0xFFFF
VOWEL_CODES = frozenset(ord(c) - 97 for c in "aeiouy")


def feature_layout(win):
    n_letter = 2 * win * 27
    n_onehot = n_letter + 2 * 27 + 3 * 27
    therm = [7, 7, 14, 14]
    offs = [n_onehot]
    for t in therm[:-1]:
        offs.append(offs[-1] + t)
    return n_onehot, therm, offs, n_onehot + sum(therm)


def export(models, win, vocab):
    n_onehot, therm, offs, _ = feature_layout(win)
    all_nodes = []
    letter_info = []
    classes_all = []
    sys.setrecursionlimit(20000)
    for c in range(26):
        if c not in models:
            letter_info.append((len(all_nodes), 0, len(classes_all)))
            continue
        tree, classes = models[c]
        t = tree.tree_
        first_class = len(classes_all)
        for s in classes:
            classes_all.append(bytes(vocab[ch] for ch in s))

        def build(n):
            if t.children_left[n] == -1:
                return [(LEAF, int(t.value[n][0].argmax()))]
            lft = build(t.children_left[n])
            rgt = build(t.children_right[n])
            if len(lft) == 1 and len(rgt) == 1 and lft[0][0] == LEAF and rgt[0][0] == LEAF and lft[0][1] == rgt[0][1]:
                return lft
            f = int(t.feature[n])
            if f < n_onehot:
                fid = f
            else:
                j = f - n_onehot
                k = int(t.threshold[n]) + 1
                k = max(1, min(k, therm[j]))
                fid = offs[j] + (k - 1)
            return [(fid, 1 + len(lft))] + lft + rgt

        sub = build(0)
        assert all(aux < 65536 for _, aux in sub), "a right-child offset does not fit in 16 bits"
        letter_info.append((len(all_nodes), len(sub), first_class))
        all_nodes.extend(sub)
        assert len(classes) < 0xFFFE
    class_off = []
    blob = bytearray()
    for cb in classes_all:
        class_off.append(len(blob))
        blob.append(len(cb))
        blob += cb
    class_off.append(len(blob))
    parts = bytearray()
    for first_node, n_nodes, first_class in letter_info:
        parts += struct.pack("<III", first_node, n_nodes, first_class)
    parts += struct.pack("<I", len(classes_all))
    parts += b"".join(struct.pack("<I", o) for o in class_off)
    parts += bytes(blob)
    while len(parts) % 4:
        parts.append(0)
    node_bytes = b"".join(struct.pack("<HH", f, aux) for f, aux in all_nodes)
    body = bytes(parts) + node_bytes
    head = struct.pack("<4sHBBIII", MAGIC, 1, win, 0, len(all_nodes), len(blob), zlib.crc32(body) & 0xFFFFFFFF)
    return head + body


class Compact:
    """The evaluator written the way the C++ one is: flat tables, no dictionaries on the hot path."""

    def __init__(self, blob, vocab):
        magic, ver, win, _, nn, nblob, crc = struct.unpack_from("<4sHBBIII", blob, 0)
        assert magic == MAGIC and ver == 1 and zlib.crc32(blob[20:]) & 0xFFFFFFFF == crc
        self.win, self.blob = win, blob
        self.letters = [struct.unpack_from("<III", blob, 20 + 12 * c) for c in range(26)]
        p = 20 + 26 * 12
        ncls = struct.unpack_from("<I", blob, p)[0]
        p += 4
        self.cls_off = list(struct.unpack_from("<%dI" % (ncls + 1), blob, p))
        p += 4 * (ncls + 1)
        self.blob_start = p
        p = (p + nblob + 3) & ~3
        self.node_start = p
        self.id2sym = {v: k for k, v in vocab.items()}

    def predict(self, word):
        codes = [ord(c) - 97 for c in word]
        n = len(codes)
        out = []
        for i, c in enumerate(codes):
            first_node, nn, first_class = self.letters[c]
            if nn == 0:
                continue
            lets = [codes[i + o] if 0 <= i + o < n else 26 for o in list(range(-self.win, 0)) + list(range(1, self.win + 1))]
            first = [codes[0], codes[1] if n > 1 else 26]
            last = [codes[n - 1 - k] if n - 1 - k >= 0 else 26 for k in range(3)]

            def isv(k):
                return 0 <= k < n and codes[k] in VOWEL_CODES

            nvl = min(sum(1 for e in range(i) if isv(e) and not isv(e + 1)), 7)
            nvr = min(sum(1 for k in range(i + 1, n) if isv(k) and not isv(k - 1)), 7)
            vals = (nvl, nvr, min(i, 14), min(n - 1 - i, 14))
            node = 0
            while True:
                f, aux = struct.unpack_from("<HH", self.blob, self.node_start + 4 * (first_node + node))
                if f == LEAF:
                    k = first_class + aux
                    p = self.blob_start + self.cls_off[k]
                    ln = self.blob[p]
                    out.append("".join(self.id2sym[b] for b in self.blob[p + 1:p + 1 + ln]))
                    break
                node = node + aux if self.test(f, lets, first, last, vals) else node + 1
        return "".join(out)

    def test(self, f, lets, first, last, vals):
        n_letter = 2 * self.win * 27
        if f < n_letter:
            return lets[f // 27] == f % 27
        f -= n_letter
        if f < 54:
            return first[f // 27] == f % 27
        f -= 54
        if f < 81:
            return last[f // 27] == f % 27
        f -= 81
        for val, cnt in zip(vals, (7, 7, 14, 14)):
            if f < cnt:
                return val >= f + 1
            f -= cnt
        raise ValueError("bad feature")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--leaf", type=int, default=4)
    ap.add_argument("--vocab", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--check-words", type=int, default=300)
    ap.add_argument("--proto", default="", help="the folder with lts_train.py, for the check against the trees")
    args = ap.parse_args()
    vocab = json.load(open(args.vocab, encoding="utf-8"))["vocab"]
    d = pickle.load(open(args.models, "rb"))
    win, auto = d["feat"]
    if auto:
        raise SystemExit("trees with autoregressive features cannot be exported: the compact file has no previous-output questions")
    models = d["results"][args.leaf]
    blob = export(models, win, vocab)
    open(args.out, "wb").write(blob)
    print("wrote %s: %d bytes, window %d, %d letters" % (args.out, len(blob), win, len(models)))
    # the compact evaluator against the trees themselves, on random words (every branch is visited): the training script's own featurizer and
    # predictor (--proto, the folder with lts_train.py) give the scikit-learn answer
    if not args.proto:
        print("no --proto given: the compact file was not checked against the trees")
        return 0
    sys.path.insert(0, args.proto)
    import lts_train as lt  # noqa: E402

    comp = Compact(blob, vocab)
    rnd = np.random.RandomState(7)
    words = ["".join(chr(97 + int(x)) for x in rnd.randint(0, 26, size=int(rnd.randint(2, 11)))) for _ in range(args.check_words)]
    arr, lens = lt.encode(words)
    nvl, nvr = lt.word_features(arr, lens)
    pred = lt.predict_words(models, lt.Featurizer(win, auto), arr, lens, nvl, nvr, np.arange(len(words)), d["symid"])
    bad = sum(1 for w, p in zip(words, pred) if comp.predict(w) != "".join(p))
    print("compact evaluator against the scikit-learn trees: %d random words, %d different" % (len(words), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
