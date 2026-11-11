"""client_fuzz.py -- the client's link to the helper (reTS/cl_dll/h9_tts_kokoro_link.cpp, through kokoro_lab fakeline) against a helper that misbehaves.

For every behaviour of fake_helper.exe (its header lists them) a data folder is made with the fake program at bin\\h9kokoro64.exe (and a manifest with its
checksum), the lab speaks one line, and what happened is compared with what must happen: a line that is made right is spoken; a bad frame, a piece of
another line, a wrong size, a helper that stops answering or ends all give a line that is not spoken (or only as far as it got), a helper that is
stopped and a state that says why, and never a crash or a hang. The tamper cases change the program or the manifest and must not start it at all.

usage: python -I client_fuzz.py <h9tts master folder> <kokoro_lab.exe> <fake_helper.exe> <work folder>
"""
import hashlib
import os
import shutil
import subprocess
import sys
import time

# mode: (expected state word in the last description, expected outcome or None when the line is not asked, expected pieces or None)
# outcomes: 0 spoken, 1 not available (the system voice takes it), 2 failed, 3 cancelled
CASES = [
    ("ok", "ready", 0, 2),
    ("lateready", "ready", 0, 2),
    ("garbage", "failed", None, None),
    ("wrongversion", "failed", None, None),
    ("wrongcrc", "failed", None, None),
    ("hugelen", "failed", 2, 0),
    ("unknowntype", "failed", 2, 0),
    ("wrongid", "failed", 2, 0),
    ("wrongseq", "failed", 2, 0),
    ("badrate", "failed", 2, 0),
    ("badsize", "failed", 2, 0),
    ("firstnotfirst", "failed", 2, 0),
    ("errordone", "ready", 2, 0),
    ("crashmid", "failed", 0, 1),
    ("nodone", "failed", 0, 2),
    ("silent", "failed", 1, 0),
    ("busy", "ready", 1, 0),
    ("noconnect", "failed", None, None),
]


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def make_stage(master, lab, fake, work, tamper=None):
    stage = os.path.join(work, "stage_fake")
    if os.path.exists(stage):
        shutil.rmtree(stage)
    data = os.path.join(stage, "ts", "h9tts")
    os.makedirs(os.path.join(data, "bin"))
    os.makedirs(os.path.join(stage, "ts", "cl_dlls"))
    for name in ("voices.txt", "chains.txt"):
        shutil.copyfile(os.path.join(master, name), os.path.join(data, name))
    shutil.copyfile(lab, os.path.join(stage, "ts", "cl_dlls", "kokoro_lab.exe"))
    exe = os.path.join(data, "bin", "h9kokoro64.exe")
    dll = os.path.join(data, "bin", "onnxruntime.dll")
    shutil.copyfile(fake, exe)
    shutil.copyfile(fake, dll)
    lines = ["sha256 %s bin/h9kokoro64.exe" % sha(exe), "sha256 %s bin/onnxruntime.dll" % sha(dll)]
    if tamper == "exe":
        with open(exe, "ab") as f:
            f.write(b"x")
    elif tamper == "manifest":
        lines[0] = "sha256 %s bin/h9kokoro64.exe" % ("0" * 64)
    elif tamper == "nomanifest":
        lines = []
    with open(os.path.join(data, "manifest.txt"), "w", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return os.path.join(stage, "ts", "cl_dlls", "kokoro_lab.exe")


def run_lab(lab, mode, extra=None, cmd="fakeline"):
    env = dict(os.environ)
    env["H9K_FAKE"] = mode
    t0 = time.time()
    r = subprocess.run([lab, cmd] + (extra or []), capture_output=True, text=True, timeout=180, env=env)
    return r.returncode, r.stdout, time.time() - t0


def main():
    master, lab, fake, work = sys.argv[1:5]
    os.makedirs(work, exist_ok=True)
    bad = 0
    for mode, want_state, want_outcome, want_pieces in CASES:
        lab_exe = make_stage(master, lab, fake, work)
        rc, out, secs = run_lab(lab_exe, mode)
        state = "ready" if "helper: ready" in out else ("failed" if "helper: failed" in out else "other")
        outcome = pieces = None
        for line in out.splitlines():
            if line.startswith("outcome "):
                parts = line.split()
                outcome, pieces = int(parts[1]), int(parts[3])
        ok = rc == 0 and state == want_state
        if want_outcome is not None:
            ok = ok and outcome == want_outcome and pieces == want_pieces
        else:
            ok = ok and outcome == -1
        reason = ""
        for line in out.splitlines():
            if line.startswith("kokoro helper:"):
                reason = line[:150]
        print("%-14s %s  state %s outcome %s pieces %s  (%.1f s)  %s" % (mode, "ok  " if ok else "FAIL", state, outcome, pieces, secs, reason if not ok else ""))
        bad += 0 if ok else 1
    # the cancel path: a line nobody wants any more is cancelled at the helper and ends as cancelled, the helper stays up
    lab_exe = make_stage(master, lab, fake, work)
    rc, out, secs = run_lab(lab_exe, "cancelaware", ["cancel"])
    ok = rc == 0 and "outcome 3 pieces 0" in out and "helper: ready" in out
    print("%-14s %s  %s (%.1f s)" % ("cancel", "ok  " if ok else "FAIL", [l for l in out.splitlines() if l.startswith("outcome")], secs))
    bad += 0 if ok else 1
    # a line whose first piece is late (the stand-in answers the first line after 4 s, the start budget is 3 s): the line is given up (outcome 1) and cancelled, the
    # helper is not killed, the line that comes while the helper is still on the cancelled one is given up at once, and the line after that is spoken whole
    lab_exe = make_stage(master, lab, fake, work)
    rc, out, secs = run_lab(lab_exe, "slowone", [], "fakeseq")
    ok = rc == 0 and "seq 1 1 0 pieces 0 0 2" in out and "helper: ready" in out
    print("%-14s %s  %s (%.1f s)" % ("late first", "ok  " if ok else "FAIL", [l for l in out.splitlines() if l.startswith("seq")], secs))
    bad += 0 if ok else 1
    # tampering: the program or the manifest changed, or no manifest: the helper must not start
    for tamper in ("exe", "manifest", "nomanifest"):
        lab_exe = make_stage(master, lab, fake, work, tamper)
        rc, out, secs = run_lab(lab_exe, "ok")
        started = "ready 1" in out
        reason = [l for l in out.splitlines() if l.startswith("kokoro helper:")]
        ok = rc == 0 and not started
        print("%-14s %s  helper started: %s  %s" % ("tamper " + tamper, "ok  " if ok else "FAIL", started, (reason[0][:140] if reason else "")))
        bad += 0 if ok else 1
    print("client_fuzz: %d failure(s)" % bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
