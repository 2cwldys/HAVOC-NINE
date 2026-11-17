"""Prove the harness catches a break, on the real chain, without touching it.

The chain is copied into scratch, one patch is staleified THERE (a pre-image
line is rewritten so it no longer matches the tree the preceding links
produce), and the tool is run against the copy. It must:

  1. report the chain healthy before the break,
  2. name that exact link REJECT after it,
  3. print a regen command that repairs it,
  4. and the regen's proof must put the final tree ids back where they were.

Nothing is ever written into the real repository. Run it with:

    py -3 tests\break-test.py
"""

import json
import os
import shutil
import subprocess
import sys
import time

# The package sits BESIDE tests\ when installed in a checkout and one level up
# in a standalone drop; resolve it from what is on disk.
PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isfile(os.path.join(PKG, "h9chain.py")):
    PKG = os.path.join(PKG, "h9chain")
HOME = os.path.dirname(PKG)
ENTRY = os.path.join(PKG, "h9chain.py")
SCRATCH = os.path.join("D:" + os.sep, "temp", "chain-work", "breaktest")
REPO = os.path.join("D:" + os.sep, "GIT Storage", "ts_h9_team_elimination")
SRC_PATCHES = os.path.join(REPO, "xash3d-h9-patches", "patches")
SRC_WEB = os.path.join(REPO, "webassembly-patch")
SRC_BAT = os.path.join(REPO, "xash3d-h9-patches", "xash.bat")

# The link to break. engine-h9-cmdbuf.patch is one hunk in one file, early in
# the chain, so the break and the repair are both easy to read.
TARGET_PATCH = "engine-h9-cmdbuf.patch"


def run(args, expect=None):
    cmd = [sys.executable, ENTRY] + args
    t0 = time.time()
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       stdin=subprocess.DEVNULL)
    dt = time.time() - t0
    out = p.stdout.decode("utf-8", "replace")
    err = p.stderr.decode("utf-8", "replace")
    print("$ chain %s" % " ".join(a if " " not in a else '"%s"' % a
                                  for a in args))
    print("  -> exit %d in %.1fs" % (p.returncode, dt))
    if expect is not None and p.returncode != expect:
        print(out)
        print(err)
        raise SystemExit("expected exit %d, got %d" % (expect, p.returncode))
    return p.returncode, out, err


def jrun(args, expect=None):
    rc, out, err = run(args + ["--json"], expect)
    try:
        return rc, json.loads(out)
    except ValueError:
        print(out[-3000:])
        print(err[-3000:])
        raise SystemExit("output was not one JSON object")


def _rmtree(path):
    """Work repos hold read-only pack files, which plain rmtree chokes on."""
    import stat

    def onerror(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass
    for _ in range(3):
        if not os.path.isdir(path):
            return
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=lambda f, p, e: onerror(f, p, e))
        else:
            shutil.rmtree(path, onerror=onerror)
        time.sleep(0.2)


def setup():
    if os.path.isdir(SCRATCH):
        _rmtree(SCRATCH)
    os.makedirs(SCRATCH, exist_ok=True)
    shutil.copytree(SRC_PATCHES, os.path.join(SCRATCH, "patches"))
    shutil.copytree(SRC_WEB, os.path.join(SCRATCH, "web"))
    shutil.copyfile(SRC_BAT, os.path.join(SCRATCH, "xash.bat"))
    print("copied the chain into %s" % SCRATCH)


def common():
    return ["--repo-root", REPO,
            "--xash-bat", os.path.join(SCRATCH, "xash.bat"),
            "--patches-dir", os.path.join(SCRATCH, "patches"),
            "--web-dir", os.path.join(SCRATCH, "web"),
            "--work", os.path.join(SCRATCH, "work")]


def staleify(path):
    """Rewrite one pre-image context line so the patch no longer matches."""
    with open(path, "rb") as fh:
        text = fh.read().decode("latin-1")
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.startswith(" ") and len(line.strip()) > 12 \
                and not line.startswith(" @@"):
            before = line
            lines[i] = " " + "/* h9chain break test: this context line is a lie */"
            with open(path, "wb") as fh:
                fh.write("\n".join(lines).encode("latin-1"))
            return i + 1, before.strip()
    raise SystemExit("no context line to rewrite in %s" % path)


def main():
    print("=" * 78)
    print("h9chain break test")
    print("=" * 78)
    setup()
    base = common()

    print("\n-- 1. the copied chain, before the break " + "-" * 36)
    rc, d = jrun(base + ["check", "--all"])
    healthy_trees = dict(d["final_tree"])
    plain = sum(1 for l in d["links"] if l["forward"] == "plain")
    print("   %d links, %d apply plain, exit %d (%s)"
          % (d["chain"]["links"], plain, rc, d["severity"]))
    print("   final trees: %s" % {k: v[:12] for k, v in
                                  healthy_trees.items()})
    assert rc == 0, "the copied chain should be healthy"
    assert plain == d["chain"]["links"]

    print("\n-- 2. staleify one patch IN THE COPY " + "-" * 40)
    victim = os.path.join(SCRATCH, "patches", TARGET_PATCH)
    lineno, old = staleify(victim)
    print("   %s line %d" % (TARGET_PATCH, lineno))
    print("   was: %s" % old[:70])
    print("   now: /* h9chain break test: this context line is a lie */")

    print("\n-- 3. the tool on the broken copy " + "-" * 43)
    rc, d = jrun(base + ["check", "--all"], expect=10)
    bad = [l for l in d["links"] if l["verdict"] == "REJECT"]
    print("   exit %d (%s), classes %s" % (rc, d["severity"], d["classes"]))
    for l in bad:
        print("   REJECT  #%d %s" % (l["index"], l["patch_name"]))
        print("   next    %s" % l["next_command_str"])
    assert len(bad) == 1, "expected exactly one REJECT, got %d" % len(bad)
    assert bad[0]["patch_name"] == TARGET_PATCH
    assert d["findings"][0]["link"] == bad[0]["index"]
    assert d["findings"][0]["next_command_str"]
    broken_index = bad[0]["index"]
    fix = list(d["findings"][0]["next_command"])

    print("\n-- 4. doctor says the same thing, with a fix plan " + "-" * 27)
    rc, d = jrun(base + ["doctor"], expect=10)
    print("   exit %d, first next_command: %s"
          % (rc, d["next_commands"][0] if d["next_commands"] else "(none)"))
    assert d["next_commands"], "doctor must print a command to run"

    print("\n-- 5. run the command it printed, verbatim " + "-" * 34)
    rc, d = jrun(base + fix)
    r = d["regen"]
    print("   candidate %s" % r["candidate"])
    print("   proof     %s" % ("pass" if r["proof"]["ok"] else "FAIL"))
    for c in r["proof"]["checks"]:
        print("     [%s] %s  %s" % ("ok" if c["ok"] else "XX", c["name"],
                                    c["detail"]))
    assert r["proof"]["ok"], "the regen's proof must pass"

    print("\n-- 6. adopt it (writes are enabled for the SCRATCH copy only) "
          + "-" * 15)
    cfg = os.path.join(SCRATCH, "chain.config.json")
    with open(cfg, "w", encoding="ascii") as fh:
        json.dump({"repo_root": REPO,
                   "xash_bat": os.path.join(SCRATCH, "xash.bat"),
                   "patches_dir": os.path.join(SCRATCH, "patches"),
                   "web_dir": os.path.join(SCRATCH, "web"),
                   "work": os.path.join(SCRATCH, "work"),
                   "protected_roots": [REPO,
                                       os.path.join("D:" + os.sep,
                                                    "Downloads", "TSM")],
                   "allow_patch_writes": True,
                   "fail_on": ["CHAIN", "REJECT", "SHADOW", "RESIDUAL",
                               "THREEWAY", "BASELINE"],
                   "anchor_exempt": ["engine.patch", "engine-mainui.patch",
                                     "freevgui.patch",
                                     "engine-library_suffix.patch"],
                   "offset_limit": 0, "timeout_sec": 120}, fh, indent=1)
    rc, d = jrun(["--config", cfg, "adopt", str(broken_index),
                  "--from", r["candidate"], "--yes"])
    print("   wrote %s" % d["adopt"]["dest"])
    assert os.path.normcase(d["adopt"]["dest"]).startswith(
        os.path.normcase(SCRATCH)), "adopt wrote outside the scratch copy"

    print("\n-- 7. the copy is healthy again " + "-" * 45)
    rc, d = jrun(base + ["check", "--all"])
    now = dict(d["final_tree"])
    print("   exit %d (%s)" % (rc, d["severity"]))
    print("   final trees: %s" % {k: v[:12] for k, v in now.items()})
    assert rc == 0, "the repaired chain should be healthy again"
    assert now == healthy_trees, "the repair changed what the chain builds"

    print("\n-- 8. the real repository was never touched " + "-" * 33)
    rc, out, err = run(["adopt", "1", "--yes"], expect=4)
    print("   adopt against the real tree: %s" % err.strip().splitlines()[0])

    # ---- the regression cases the verifiers found ------------------------
    print("\n-- 9. a one-link check does not call the chain healthy " + "-" * 22)
    rc, d = jrun(base + ["check", str(broken_index)])
    vs = {}
    for l in d["links"]:
        vs[l["verdict"]] = vs.get(l["verdict"], 0) + 1
    print("   verdicts %s; examined %d, skipped %d"
          % (vs, d["chain"]["examined"], d["chain"]["skipped"]))
    assert vs.get("SKIPPED"), "unexamined links must read SKIPPED, not OK"
    assert vs.get("OK", 0) + vs.get("SKIPPED", 0) == d["chain"]["links"]
    assert d["chain"]["examined"] == 1, d["chain"]["examined"]
    assert not any(l["verdict"] == "OK" and l["forward"] == "skipped"
                   for l in d["links"]), "a skipped link reported OK"

    print("\n-- 10. bless, then an edit that changes what the chain builds "
          + "-" * 15)
    lock = os.path.join(SCRATCH, "chain.lock")
    rc, d = jrun(base + ["--lock", lock, "bless"])
    assert os.path.isfile(lock), "bless wrote no lock"
    victim2 = os.path.join(SCRATCH, "patches", "engine-h9-xray.patch")
    with open(victim2, "rb") as fh:
        text = fh.read().decode("latin-1")
    hit = None
    for ln in text.split("\n"):
        if ln.startswith("+") and not ln.startswith("+++") \
                and len(ln.strip()) > 20:
            hit = ln
            break
    assert hit, "no added line to edit"
    with open(victim2, "wb") as fh:
        fh.write(text.replace(hit, hit + "  /* h9chain: behaviour edit */",
                              1).encode("latin-1"))
    print("   edited an ADDED line in engine-h9-xray.patch (it still "
          "applies, and")
    print("   the engine tree it builds is now different)")
    rc, d = jrun(base + ["--lock", lock, "check", "--all", "--no-dev"],
                 expect=14)
    print("   --no-dev: exit %d (%s) classes %s"
          % (rc, d["severity"], d["classes"]))
    print("   baseline.matches %s, moved %s"
          % (d["baseline"]["matches"], d["baseline"]["moved"]))
    assert d["baseline"]["matches"] is False, \
        "baseline.matches must be false when anything moved"
    assert any(m.startswith("final_tree.")
               for m in d["baseline"]["unexplained"]), \
        "a moved final tree must never be explained away by a moved sha256"
    assert "BASELINE" in d["classes"]
    with open(victim2, "wb") as fh:
        fh.write(text.encode("latin-1"))

    print("\n-- 11. a patch file xash.bat calls that is not on disk " + "-" * 22)
    gone = os.path.join(SCRATCH, "patches", "engine-h9-chatmouse.patch")
    keep = gone + ".kept"
    os.rename(gone, keep)
    rc, d = jrun(base + ["check", "--all"], expect=19)
    f = d["findings"][0]
    print("   exit %d (%s); findings[0] %s %s"
          % (rc, d["severity"], f["class"], f["code"]))
    print("   %s" % f["message"][:150])
    assert f["class"] == "CHAIN", f["class"]
    assert "MISSING" in f["code"] or "missing" in f["message"]
    assert "rename" not in f["message"], \
        "a missing file must not be called a rename or a binary delta"
    rc, d = jrun(base + ["doctor"], expect=19)
    assert any(x["class"] == "CHAIN" for x in d["findings"]), \
        "doctor must see a chain-level problem"
    os.rename(keep, gone)

    print("\n-- 12. an unparseable 'call :patch' line " + "-" * 37)
    bat = os.path.join(SCRATCH, "xash.bat")
    with open(bat, "rb") as fh:
        btext = fh.read().decode("latin-1")
    lines = btext.split("\n")
    where = None
    for i, ln in enumerate(lines):
        if ln.lstrip().lower().startswith("call :patch"):
            where = i
            break
    # Drop the opening quote of the second argument, which is how a hand
    # edit of xash.bat goes wrong. The real build then fails all three git
    # calls on that line and stops.
    head, sep, tail = lines[where].partition('" "')
    assert sep, lines[where]
    lines[where] = head + '" ' + tail
    with open(bat, "wb") as fh:
        fh.write("\n".join(lines).encode("latin-1"))
    rc, d = jrun(base + ["check", "--all"], expect=19)
    print("   exit %d (%s); %s" % (rc, d["severity"],
                                   d["findings"][0]["message"][:120]))
    assert any(x["class"] == "CHAIN" for x in d["findings"]), \
        "an unparseable chain line must reach findings"
    assert d["chain"]["problems"], "and the JSON must carry it"
    rc, d = jrun(base + ["doctor"], expect=19)
    assert any(x["class"] == "CHAIN" for x in d["findings"])
    with open(bat, "wb") as fh:
        fh.write(btext.encode("latin-1"))

    print("\n-- 13. the copy is healthy once more " + "-" * 41)
    rc, d = jrun(base + ["check", "--all"])
    assert rc == 0, "the restored copy should be healthy"
    assert dict(d["final_tree"]) == healthy_trees

    print("\n" + "=" * 78)
    print("PASS: the break was caught, named, repaired and proved, and the "
          "verifiers'")
    print("      regressions (skipped verdicts, baseline tree moves, a "
          "missing patch,")
    print("      an unparseable chain line) are all caught too.")
    print("=" * 78)


if __name__ == "__main__":
    main()
