#!/usr/bin/env python3
"""make_manifest.py -- writes <h9tts folder>/manifest.txt: the SHA-256 of the helper's program files, which the client checks before it starts them.

    sha256 <64 hex digits> <path relative to the h9tts folder, with forward slashes>

usage: make_manifest.py <h9tts folder>     (run it after every build of the helper and whenever onnxruntime.dll is replaced;
                                            stage_h9tts.py calls write_manifest itself)
"""
import hashlib
import os
import sys

FILES = ["bin/h9kokoro64.exe", "bin/onnxruntime.dll", "bin/onnxruntime_providers_shared.dll"]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_manifest(root):
    lines = ["# SHA-256 of the Kokoro helper's program files (written by tools/h9tts/make_manifest.py); client.dll refuses to start a helper that differs."]
    for rel in FILES:
        path = os.path.join(root, *rel.split("/"))
        if not os.path.exists(path):
            raise SystemExit("missing: " + path)
        lines.append("sha256 %s %s" % (sha256_file(path), rel))
    with open(os.path.join(root, "manifest.txt"), "w", encoding="ascii", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return lines


def main():
    print("\n".join(write_manifest(sys.argv[1])))


if __name__ == "__main__":
    main()
