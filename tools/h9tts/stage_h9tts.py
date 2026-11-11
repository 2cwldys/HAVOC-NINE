#!/usr/bin/env python3
"""stage_h9tts.py -- assembles the folder h9tts that goes into the game's ts folder (ts\\h9tts), from the masters in the repository's h9tts folder and the
built parts. Nothing is deployed: the output goes where --out says, and the build that packs the game copies it from there.

  <out>\\h9tts\\voices.txt chains.txt NOTICE.txt LICENSE-*.txt manifest.txt README.txt     (masters; the manifest is made here)
  <out>\\h9tts\\bin\\h9kokoro64.exe onnxruntime.dll onnxruntime_providers_shared.dll LICENSE-onnxruntime-mit.txt ThirdPartyNotices-onnxruntime.txt
  <out>\\h9tts\\model\\model_quantized.onnx                                       (checked against the pinned size and SHA-256)
  <out>\\h9tts\\voices\\<the style files voices.txt names>.bin
  <out>\\h9tts\\g2p\\tokens.txt en_us.h9lex en_us.h9lt
  <out>\\h9tts\\lines\\lines.h9pk

usage: stage_h9tts.py --out <folder> --helper <h9kokoro64.exe> --ort <folder with the two ONNX Runtime DLLs> --model <model_quantized.onnx>
                      --voices <folder with the style .bin files> --g2p <folder with tokens.txt, en_us.h9lex, en_us.h9lt> --pack <lines.h9pk>
"""
import argparse
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_manifest import sha256_file, write_manifest  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MASTERS = os.path.join(REPO, "h9tts")
ORT_NOTICES = os.path.join(REPO, "tools", "h9kokoro64", "third_party", "onnxruntime")
MODEL_BYTES = 92361116
MODEL_SHA256 = "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478"


def voices_named(catalogue):
    names = []
    for raw in open(catalogue, encoding="ascii"):
        t = raw.split("//", 1)[0].split()
        if t and t[0] == "variant":
            for part in t[5].split("+"):
                n = part.split(":")[0]
                if n not in names:
                    names.append(n)
    return names


def put(src, dst_root, rel):
    dst = os.path.join(dst_root, *rel.split("/"))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    return dst


def main():
    ap = argparse.ArgumentParser()
    for a in ("out", "helper", "ort", "model", "voices", "g2p", "pack"):
        ap.add_argument("--" + a, required=True)
    args = ap.parse_args()
    root = os.path.join(args.out, "h9tts")
    if os.path.exists(root):
        shutil.rmtree(root)
    os.makedirs(root)
    for name in sorted(os.listdir(MASTERS)):
        if name.endswith(".txt"):
            put(os.path.join(MASTERS, name), root, name)
    put(args.helper, root, "bin/h9kokoro64.exe")
    for dll in ("onnxruntime.dll", "onnxruntime_providers_shared.dll"):
        put(os.path.join(args.ort, dll), root, "bin/" + dll)
    put(os.path.join(ORT_NOTICES, "LICENSE.txt"), root, "bin/LICENSE-onnxruntime-mit.txt")
    put(os.path.join(ORT_NOTICES, "ThirdPartyNotices.txt"), root, "bin/ThirdPartyNotices-onnxruntime.txt")
    if os.path.getsize(args.model) != MODEL_BYTES or sha256_file(args.model) != MODEL_SHA256:
        raise SystemExit("the model file is not the pinned one (%d bytes, sha256 %s)" % (MODEL_BYTES, MODEL_SHA256))
    put(args.model, root, "model/model_quantized.onnx")
    for v in voices_named(os.path.join(MASTERS, "voices.txt")):
        src = os.path.join(args.voices, v + ".bin")
        if not os.path.exists(src):
            raise SystemExit("the catalogue names the voice %s and %s is missing" % (v, src))
        put(src, root, "voices/%s.bin" % v)
    for name in ("tokens.txt", "en_us.h9lex", "en_us.h9lt"):
        put(os.path.join(args.g2p, name), root, "g2p/" + name)
    put(args.pack, root, "lines/lines.h9pk")

    write_manifest(root)

    total = 0
    print("%-48s %12s" % ("file", "bytes"))
    for dirpath, _, files in os.walk(root):
        for name in sorted(files):
            p = os.path.join(dirpath, name)
            total += os.path.getsize(p)
            print("%-48s %12d" % (os.path.relpath(p, root).replace("\\", "/"), os.path.getsize(p)))
    print("%-48s %12d  (%.1f MB)" % ("total", total, total / 1048576.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
