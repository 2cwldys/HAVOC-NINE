"""g2p_parity.py -- the helper's C++ G2P (g2p_cli.exe) against the Python reference (tests/ref/g2p_port.py), line by line.

Both read the same lexicon; with no out-of-dictionary chain on either side the phoneme strings must be identical. The lines are a file of
UTF-8 text, one line each; --fuzz N adds N lines made from words of the lines, numbers, symbols and typographic characters, so that the number,
punctuation and tokenizer rules are exercised with combinations nobody wrote by hand.

With --oov <folder with lts_chain.py> the out-of-dictionary chain is on in both: the reference runs the training study's chain with the scikit-learn trees
(options lts,spell,clitic) and the C++ one the compact trees file en_us.h9lt of the g2p folder.

usage: python -I g2p_parity.py <g2p folder> <vocab config.json> <g2p_cli.exe> <lines.txt> [--fuzz N] [--seed S] [--oov <proto folder>]
"""
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def asc(text):
    """Text for a console that is not UTF-8: non-ASCII characters as escapes."""
    return text.encode("unicode_escape").decode("ascii")


def main():
    args = sys.argv[1:]
    fuzz, seed = 0, 1
    if "--fuzz" in args:
        i = args.index("--fuzz")
        fuzz = int(args[i + 1])
        del args[i:i + 2]
    oov_proto = ""
    if "--oov" in args:
        i = args.index("--oov")
        oov_proto = args[i + 1]
        del args[i:i + 2]
    if "--seed" in args:
        i = args.index("--seed")
        seed = int(args[i + 1])
        del args[i:i + 2]
    g2p_dir, vocab_json, exe, lines_path = args[:4]
    os.environ["H9_KOKORO_VOCAB_JSON"] = vocab_json
    sys.path.insert(0, os.path.join(HERE, "ref"))
    import g2p_port  # noqa: E402

    lines = [l.rstrip("\r\n") for l in open(lines_path, encoding="utf-8")]
    lines = [l.split("\t")[-1] if "\t" in l else l for l in lines]
    if fuzz:
        rnd = random.Random(seed)
        words = sorted({w for l in lines for w in l.split()})
        extras = ["0", "7", "10", "42", "1999", "2005", "1,000", "3.14", "$5", "$3.50", "5th", "21st", "100%", "50%", "a+b", "x=y", "a/b", "1/2",
                  "U.S.A.", "e.g.", "Dr.", "Mr.", "vs.", "...", "--", "-", "'", "''", "\"", "(", ")", "[x]", "{y}", "<z>", "*", "#1", "@home",
                  "www.example.com", "a@b.co", "it's", "don't", "'cause", "rock'n'roll", "xX_Slayer_Xx", "J4ck_Daniels", "BigDaddy69", "go2sleep",
                  "cl_realhud", "GG", "gg", "wtf", "brb", "lol", ":)", ":D", "<3", "xD", "caf\u00e9", "na\u00efve", "\u201cquoted\u201d", "it\u2019s",
                  "a\u2014b", "wait\u2026", "\u00a35", "\u20ac10", "\u00bd", "x\u00b2", "\u4e2d", "\U0001F600", "1.2.3", "192.168.0.1", "3rd", "100th"]
        for _ in range(fuzz):
            n = rnd.randint(1, 9)
            parts = []
            for _ in range(n):
                r = rnd.random()
                parts.append(rnd.choice(extras) if r < 0.35 else rnd.choice(words))
            sep = rnd.choice([" ", " ", " ", ", ", ". ", "! ", "? "])
            lines.append(sep.join(parts) if sep == " " else sep.join(parts).strip())
    lex = open(os.path.join(g2p_dir, "en_us.h9lex"), "rb").read()
    ref = g2p_port.G2P(lex, oov=None)
    if oov_proto:
        sys.path.insert(0, oov_proto)
        import lts_chain  # noqa: E402

        ref.oov = lts_chain.build(ref.port, "lts=A:4,spell,clitic").phonemize
    import h9lexicon as hl  # noqa: E402

    want = []
    for l in lines:
        try:
            want.append(ref.phonemize(l))
        except Exception as e:  # a line the reference itself cannot do is not a test
            want.append("<<reference error %s>>" % type(e).__name__)
    tmp = os.path.join(os.environ.get("TEMP", "."), "g2p_parity_lines.txt")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        for l in lines:
            f.write(l.replace("\n", " ") + "\n")
    r = subprocess.run([exe, g2p_dir, tmp] + (["oov"] if oov_proto else []), capture_output=True, timeout=1200)
    if r.returncode != 0:
        raise SystemExit("g2p_cli failed: %s" % r.stderr.decode("utf-8", "replace"))
    got = r.stdout.decode("utf-8").replace("\r\n", "\n").split("\n")
    got = got[: len(lines)]
    bad = skipped = 0
    shown = 0
    for l, w, g in zip(lines, want, got):
        if w.startswith("<<reference error"):
            skipped += 1
            continue
        if w != g:
            bad += 1
            if shown < 25:
                shown += 1
                print("DIFF  %s\n  want %s\n  got  %s" % (asc(l), asc(w), asc(g)))
    print("%d lines, %d identical, %d different, %d skipped (reference error)" % (len(lines), len(lines) - bad - skipped, bad, skipped))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
