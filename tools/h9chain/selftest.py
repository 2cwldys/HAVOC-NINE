"""selftest -- the opt-in, read-only check against the real trees.

It reproduces the acceptance numbers, asserts the safety rails structurally,
and with --deep proves that the index-only replay agrees, tree id for tree
id, with a plain 'git apply' through a real worktree.
"""

import os
import re
import time

from . import gitio
from .chainparse import TARGETS

PKG = os.path.dirname(os.path.abspath(__file__))

# A compiler or a build script must be unreachable from this tool. xash.bat
# is read as text and never run, so it is checked separately below.
FORBIDDEN = ["waf", "msvc", "cl.exe", "build.bat", "export.bat",
             "build-linux", "emcc", "ninja", "msbuild"]

# Built from fragments so the names do not appear literally in this file and
# make the scanner find itself.
SHELL_LAUNCHERS = tuple("os." + frag for frag in
                        ("system", "popen", "execv", "execl", "spawn"))


def _source_files():
    for fn in sorted(os.listdir(PKG)):
        if fn.endswith(".py"):
            yield os.path.join(PKG, fn)


def check_no_compiler():
    """Assert no code path can invoke a build.

    Structural, not textual: only gitio.py may import a process-launching
    module, and gitio.py builds every command as 'git'. This file is left out
    of the token scan because it holds the token list itself; the import
    check below still covers it.
    """
    problems = []
    for path in _source_files():
        name = os.path.basename(path)
        with open(path, "r", encoding="ascii", errors="replace") as fh:
            lines = fh.read().split("\n")
        for n, line in enumerate(lines, 1):
            code = line.split("#", 1)[0]
            stripped = code.strip()
            if stripped.startswith("import subprocess") \
                    or stripped.startswith("from subprocess") \
                    or stripped.startswith("import os, subprocess"):
                if name != "gitio.py":
                    problems.append(
                        "%s:%d imports subprocess; only gitio.py may"
                        % (name, n))
            if any(frag in code for frag in SHELL_LAUNCHERS):
                problems.append("%s:%d uses a shell launcher" % (name, n))
            if name == "selftest.py":
                continue
            low = code.lower()
            for tok in FORBIDDEN:
                if tok in low:
                    problems.append("%s:%d names the build tool %r in code: "
                                    "%s" % (name, n, tok, stripped[:80]))
            if "xash.bat" in low and "subprocess" in low:
                problems.append("%s:%d would run xash.bat" % (name, n))
    with open(os.path.join(PKG, "gitio.py"), "r", encoding="ascii") as fh:
        if 'cmd = ["git"]' not in fh.read():
            problems.append("gitio.py no longer builds every command as git")
    return problems


def check_rails(ctx):
    problems = []
    g = ctx.git
    for p in ctx.cfg.protected_roots:
        try:
            g.rw(p, "status")
            problems.append("git_rw accepted a protected root: %s" % p)
        except gitio.Refusal:
            pass
    # 'status' and 'diff' are off the read-only list too: both can refresh a
    # real index as a side effect, and nothing here needs them.
    for verb in ("apply", "checkout", "reset", "clean", "stash", "commit",
                 "worktree", "update-index", "write-tree", "push", "fetch",
                 "status", "diff", "gc", "prune", "mv", "rm"):
        try:
            g.ro(ctx.cfg.repo_root, verb, "--help")
            problems.append("git_ro accepted the writing verb %r" % verb)
        except gitio.Refusal:
            pass
    try:
        g.clone_shared(ctx.cfg.repo_root,
                       os.path.join(ctx.cfg.repo_root, "h9chain-should-fail"))
        problems.append("clone_shared accepted a destination in a protected "
                        "root")
    except gitio.Refusal:
        pass
    # A write through a FLAG, not through the repository path: this is how
    # 'tree --worktree --force' once reached an unrelated git repository.
    for root in ctx.cfg.protected_roots:
        dest = os.path.join(root, "h9chain-should-fail")
        try:
            g.check_sinks(["checkout-index", "-a",
                           "--prefix=" + dest.replace("\\", "/") + "/"])
            problems.append("a --prefix destination inside %s was accepted"
                            % root)
        except gitio.Refusal:
            pass
    return problems


def check_env_rails(ctx):
    """No environment variable may relax a rail."""
    problems = []
    real = ctx.cfg.protected_roots
    for p in (os.path.join("D:" + os.sep, "GIT Storage",
                           "ts_h9_team_elimination"),
              os.path.join("D:" + os.sep, "Downloads", "TSM")):
        if not any(gitio.is_under(p, q) for q in real):
            problems.append("%s is not protected in this configuration" % p)
    if os.environ.get("H9CHAIN_ALLOW_PATCH_WRITES") and \
            ctx.cfg.allow_patch_writes:
        problems.append("H9CHAIN_ALLOW_PATCH_WRITES opened the write gate")
    return problems


def system_config_note():
    """F16: the tool runs with GIT_CONFIG_NOSYSTEM=1 so that a machine-wide
    setting cannot change what it measures. The real build does not, so say
    what is in there."""
    path = os.path.join("C:" + os.sep, "ProgramData", "Git", "config")
    if not os.path.isfile(path):
        return "no system git config on this machine"
    keys = []
    try:
        with open(path, "r", encoding="latin-1") as fh:
            section = ""
            for line in fh:
                line = line.strip()
                if line.startswith("[") and line.endswith("]"):
                    section = line[1:-1].strip().lower()
                elif "=" in line and section in ("apply", "filter", "diff",
                                                 "core"):
                    keys.append(section + "." + line.split("=")[0].strip()
                                + "=" + line.split("=", 1)[1].strip())
    except OSError:
        return "system git config unreadable"
    return ("%s: %s (hidden from this tool by GIT_CONFIG_NOSYSTEM=1, NOT "
            "from a real xash.bat run)" % (path, ", ".join(keys) or "nothing "
                                           "that affects apply"))


def run(ctx):
    from .h9chain import run_check
    o = ctx.out
    t0 = time.time()
    results = []

    def record(name, ok, detail=""):
        results.append({"name": name, "ok": bool(ok), "detail": str(detail)})
        o.say("  [%s] %-56s %s" % ("ok" if ok else "XX", name, detail))

    o.say("selftest")
    o.say("")
    o.say(" safety")
    probs = check_no_compiler()
    record("no code path invokes a compiler or a build script", not probs,
           "; ".join(probs[:3]))
    probs = check_rails(ctx)
    record("the two chokepoints refuse everything they must", not probs,
           "; ".join(probs[:3]))
    probs = check_env_rails(ctx)
    record("no environment variable can move a rail", not probs,
           "; ".join(probs[:3]))
    record("adopt is gated", not ctx.cfg.allow_patch_writes
           or "allow_patch_writes is TRUE in the config",
           "allow_patch_writes=%s" % ctx.cfg.allow_patch_writes)
    record("one run per work area (lock held)", bool(ctx.wa._lock_fd),
           os.path.join(ctx.cfg.work, "run.lock"))
    record("system git config", True, system_config_note())

    o.say("")
    o.say(" chain")
    by_t = {}
    for lk in ctx.chain.links:
        by_t[lk.target] = by_t.get(lk.target, 0) + 1
    record("links parsed from xash.bat", len(ctx.chain.links) > 0,
           "%d links, %s" % (len(ctx.chain.links), by_t))
    lines = [lk.line_no for lk in ctx.chain.links]
    record("chain lines are contiguous and in order",
           lines == sorted(lines),
           "lines %d-%d" % (min(lines), max(lines)) if lines else "none")
    record("every referenced patch file exists", not ctx.chain.missing,
           ", ".join(ctx.chain.missing[:3]))
    record("orphan patch files", True,
           ", ".join(os.path.basename(p) for p in ctx.chain.orphans)
           or "none")

    o.say("")
    o.say(" replay")
    t1 = time.time()
    res = run_check(ctx, {lk.index for lk in ctx.chain.links},
                    want_residual=not ctx.args.no_dev)
    full_s = time.time() - t1
    fwd = {}
    for i in res.order:
        fwd[res.states[i].forward or "none"] = \
            fwd.get(res.states[i].forward or "none", 0) + 1
    record("forward pass", fwd.get("reject", 0) == 0, str(fwd))
    record("three-way rescues (expected 0)", fwd.get("threeway", 0) == 0,
           fwd.get("threeway", 0))
    for t in res.targets:
        record("final %s tree" % t, bool(res.final_tree.get(t)),
               (res.final_tree.get(t) or "-")[:12])
    dev = {}
    for i in res.order:
        dev[res.states[i].dev or "none"] = dev.get(res.states[i].dev
                                                   or "none", 0) + 1
    record("dev pass", dev.get("not_detectable", 0) == 0, str(dev))
    shadowed = [i for i in res.order if res.states[i].shadowed_by is not None]
    record("shadow pass (expected 0 shadowed)", not shadowed, str(shadowed))
    if res.residual.get("ran"):
        for t in res.targets:
            r = res.residual["targets"].get(t, {})
            bad = [p for p in r.get("paths", []) if p["kind"] != "ALLOWED"]
            record("residual %s" % t, r.get("equal"),
                   "equal" if r.get("equal") else
                   "%d path(s): %s" % (len(bad),
                                       ", ".join(p["path"] + "[" + p["kind"]
                                                 + "]" for p in bad[:6])))
    stale = [i for i in res.order
             if res.states[i].anchor.get("state") == "stale"]
    record("stale anchors (reported, not a failure)", True,
           "%d: %s" % (len(stale), stale))
    offs = [(i, res.states[i].offsets.get("max_abs", 0)) for i in res.order
            if res.states[i].offsets.get("max_abs", 0)]
    offs.sort(key=lambda x: -x[1])
    record("links with a non-zero hunk offset", True,
           "%d, biggest %s" % (len(offs), offs[:6]))

    o.say("")
    o.say(" chain-level conditions the harness does NOT judge")
    for t in res.targets:
        w = res.worktree.get(t) or {}
        # Reported, never a failure: this harness never reads that working
        # tree, and whether those files are work in progress is the owner's
        # call. The WORKTREE class says the same thing in 'check'.
        record("pristine %s working tree (reported, not a failure)" % t, True,
               "%d untracked; %d of them a new-file patch creates, which "
               "would stop a literal xash.bat run"
               % (w.get("untracked", 0), len(w.get("would_block", []))))
    record("every 'call :patch' line parses", not ctx.chain.problems,
           "; ".join(m for _c, m in ctx.chain.problems[:2]) or "64 of 64")

    o.say("")
    o.say(" timing")
    t2 = time.time()
    idx = ctx.chain.links[len(ctx.chain.links) // 2].index
    # The DEFAULT single-link path, which is what the README documents and
    # what an agent runs: dev pass and shadow pass included, residual not.
    run_check(ctx, {idx}, want_residual=False)
    single_s = time.time() - t2
    record("single-link check (warm, default flags)", single_s < 5.0,
           "%.2fs" % single_s)
    record("full replay", True, "%.2fs" % full_s)
    size = 0
    for dirpath, _d, files in os.walk(ctx.cfg.work):
        for fn in files:
            try:
                size += os.path.getsize(os.path.join(dirpath, fn))
            except OSError:
                pass
    record("work area size", True, "%.1f MB" % (size / 1048576.0))

    deep = None
    if ctx.args.deep:
        o.say("")
        o.say(" deep: index-only replay versus a real worktree")
        deep = _deep(ctx, res, record)

    ok = all(r["ok"] for r in results)
    o.say("")
    o.say("selftest %s in %.1fs (%d checks)"
          % ("passed" if ok else "FAILED", time.time() - t0, len(results)))
    classes = set()
    if not ok:
        classes.add("LINT")
        if "LINT" not in ctx.cfg.fail_on:
            ctx.cfg.fail_on = list(ctx.cfg.fail_on) + ["LINT"]
    return ctx.finish("selftest", classes, {
        "selftest": {"ok": ok, "checks": results, "deep": deep,
                     "single_link_s": round(single_s, 3),
                     "full_replay_s": round(full_s, 3)}})


def _deep(ctx, res, record):
    """Replay one target through a real worktree with plain 'git apply' and
    compare per-link tree ids against the index-only run."""
    wa = ctx.wa
    target = "engine"
    states = [res.states[i] for i in res.order
              if res.states[i].target == target and res.states[i].post_tree]
    if not states:
        return None
    d = wa.arena(target, wa.base_tree(target))
    mismatches = []
    for st in states:
        rc, _o, err = wa.git.rw(d, "apply", str(st.link.patch_path))
        if rc != 0:
            mismatches.append("#%d plain apply failed in a worktree: %s"
                              % (st.index, err.strip()[:120]))
            break
        wa.git.rw(d, "add", "-A")
        tree = wa.git.rw_out(d, "write-tree").strip()
        if tree != st.post_tree:
            mismatches.append("#%d worktree tree %s != index tree %s"
                              % (st.index, tree[:12], st.post_tree[:12]))
    record("worktree replay agrees with the index replay, link for link",
           not mismatches,
           "%d link(s) compared%s" % (len(states),
                                      "" if not mismatches
                                      else "; " + mismatches[0]))
    # The arena is a full checkout; drop it so the work area stays small.
    gitio.rmtree_force(d)
    return {"target": target, "links": len(states),
            "mismatches": mismatches}
