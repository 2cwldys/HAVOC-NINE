#!/usr/bin/env python3
"""make_g2p_data.py -- writes the files the helper's G2P reads, into <out>/g2p/:

    tokens.txt      "<id> <decimal code point>" a line: the phoneme symbols of Kokoro's vocabulary (from its config.json)
    en_us.h9lex     the American pronunciation lexicon (H9LX, made from misaki's gold and silver lists), copied as it is

usage: make_g2p_data.py --vocab <hf-kokoro-orig/config.json> --lexicon <en_us.h9lex> --out <h9tts folder>
"""
import argparse
import hashlib
import json
import os
import shutil


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocab", required=True)
    ap.add_argument("--lexicon", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    vocab = json.load(open(args.vocab, encoding="utf-8"))["vocab"]
    out = os.path.join(args.out, "g2p")
    os.makedirs(out, exist_ok=True)
    rows = []
    for sym, i in vocab.items():
        if len(sym) != 1:
            raise SystemExit("a vocabulary symbol of more than one code point: %r" % sym)
        rows.append((int(i), ord(sym)))
    rows.sort()
    with open(os.path.join(out, "tokens.txt"), "w", encoding="ascii", newline="\n") as f:
        f.write("# Kokoro phoneme symbols: <id> <code point>\n")
        for i, cp in rows:
            f.write("%d %d\n" % (i, cp))
    dst = os.path.join(out, "en_us.h9lex")
    shutil.copyfile(args.lexicon, dst)
    print("tokens.txt: %d symbols; en_us.h9lex: %d bytes, sha256 %s" % (len(rows), os.path.getsize(dst), hashlib.sha256(open(dst, "rb").read()).hexdigest()))


if __name__ == "__main__":
    main()
