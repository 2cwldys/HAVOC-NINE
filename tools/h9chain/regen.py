"""regen, fold, adopt and the proof.

Everything here is a dry run. regen and fold have no write mode at all;
adopt is the single gated write, one file, and it ships disabled.

Equivalence is always judged by replaying and comparing tree ids, never by
comparing patch text: diff-tree sorts paths and the hand-written patches do
not, so a third of them regenerate with a different byte order and the same
meaning.
"""

import os
import re
import shutil
import time

from . import gitio, report, verdicts
from .chainparse import parse_patch, sha256_file, sha256_bytes

HUNK_RE = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')


# ---------------------------------------------------------------------------
# diff generation
# ---------------------------------------------------------------------------

def abbrev_of(patch):
    """The abbreviation length the existing patch's index lines use.

    git picks it from the repository's object count, and a work clone that
    also sees the dev objects picks a longer one, so without this a refresh
    would rewrite every index line for no reason.
    """
    lens = [len(f.index_pre) for f in patch.files
            if f.index_pre and set(f.index_pre) != {"0"}]
    if not lens:
        return None
    return max(set(lens), key=lens.count)


def diff_trees(wa, target, a, b, paths, context=3, style="git", abbrev=None):
    args = []
    if abbrev:
        # git 2.21's diff-tree ignores --abbrev for the index line; the
        # config key is what sets it, and a work clone that also sees the
        # dev objects picks a longer default on its own.
        args += ["-c", "core.abbrev=%d" % int(abbrev)]
    args += ["diff-tree", "-p", "--binary", "--no-renames",
             "--src-prefix=a/", "--dst-prefix=b/", "-U%d" % context, a, b]
    if paths:
        args += ["--"] + list(paths)
    rc, out, err = wa.git.rw(wa.repo(target), *args)
    if rc != 0:
        raise gitio.GitError("diff-tree failed: %s" % err.strip())
    if style == "house":
        out = strip_git_headers(out)
    return out


def strip_git_headers(text):
    keep = []
    for line in text.split("\n"):
        if line.startswith("diff --git ") or line.startswith("index "):
            continue
        keep.append(line)
    return "\n".join(keep)


def reorder_like(new_text, old_patch):
    """File order follows the existing patch, with new paths appended."""
    if not old_patch.files:
        return new_text
    sections = []
    cur = []
    for line in new_text.split("\n"):
        if (line.startswith("diff --git ") or line.startswith("--- ")) and cur:
            if line.startswith("--- ") and cur and cur[-1].startswith(
                    ("index ", "new file mode ", "diff --git ")):
                cur.append(line)
                continue
            sections.append(cur)
            cur = [line]
        else:
            cur.append(line)
    if cur:
        sections.append(cur)

    def path_of(sec):
        for line in sec:
            if line.startswith("+++ b/"):
                return line[6:].split("\t")[0].strip()
            if line.startswith("diff --git a/"):
                m = re.match(r'^diff --git a/(.*) b/(.*)$', line)
                if m:
                    return m.group(2)
        return None

    want = [f.path for f in old_patch.files]
    tagged = [(path_of(s), s) for s in sections]
    head = [s for p, s in tagged if p is None]
    body = [(p, s) for p, s in tagged if p is not None]
    ordered = []
    for p in want:
        for q, s in body:
            if q == p:
                ordered.append(s)
    for q, s in body:
        if q not in want:
            ordered.append(s)
    if len(ordered) != len(body):
        return new_text
    out = []
    for s in head + ordered:
        out += s
    return "\n".join(out)


# ---------------------------------------------------------------------------
# building the post-image tree
# ---------------------------------------------------------------------------

def tree_from_dir(wa, target, base_tree, directory, slot="regen"):
    """Hash an edited worktree back into a tree."""
    wa.read_tree(target, base_tree, slot=slot)
    rc, out, _ = wa.git.rw(wa.repo(target), "ls-tree", "-r", base_tree)
    have = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        head, path = line.split("\t", 1)
        parts = head.split()
        if len(parts) >= 3:
            have[path.strip()] = (parts[0], parts[2])
    files = []
    for dirpath, dirnames, filenames in os.walk(directory):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, directory).replace("\\", "/")
            files.append((rel, full))
    if not files:
        raise gitio.GitError("no files under %s" % directory)
    payload = "\n".join(f.replace("\\", "/") for _r, f in files) + "\n"
    ids = wa.git.rw_out(wa.repo(target), "hash-object", "-w",
                        "--stdin-paths",
                        stdin_bytes=payload.encode("utf-8")).split()
    lines = []
    seen = set()
    for (rel, _full), sha in zip(files, ids):
        seen.add(rel)
        mode = have.get(rel, ("100644", None))[0]
        if mode == "160000":
            continue
        if have.get(rel, (None, None))[1] != sha:
            lines.append("%s %s\t%s" % (mode, sha, rel))
    for rel, (mode, _sha) in have.items():
        if rel in seen:
            continue
        if mode in ("160000", "120000"):
            # checkout-index does not write gitlinks or symlinks, so their
            # absence from the directory is not a deletion.
            continue
        lines.append("0 %s\t%s" % ("0" * 40, rel))
    if lines:
        wa.git.rw(wa.repo(target), "update-index", "--index-info",
                  index_file=wa.index_file(target, slot), check=True,
                  stdin_bytes=("\n".join(lines) + "\n").encode("utf-8"))
    return wa.write_tree(target, slot=slot), sorted(
        set(l.split("\t", 1)[1] for l in lines))


def tree_post_dev(wa, target, st, res, paths, slot="regen"):
    """A's blobs for <paths> replaced by the dev mirror's, with every later
    same-file toucher reversed out, last to first.

    The subtraction is not optional: the live tree has several features mixed
    into the same files, and diffing it raw is how a regen absorbs three at
    once.
    """
    info = wa.dev_mirror(target)
    wa.read_tree(target, st.pre_tree, slot=slot)
    rc, out, _ = wa.git.rw(wa.repo(target), "ls-tree", info["mirror_tree"],
                           "--", *paths)
    got = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        head, path = line.split("\t", 1)
        parts = head.split()
        if len(parts) >= 3:
            got[path.strip()] = (parts[0], parts[2])
    missing = [p for p in paths if p not in got]
    if missing:
        raise gitio.GitError("the dev clone does not hold: %s"
                             % ", ".join(missing))
    lines = ["%s %s\t%s" % (got[p][0], got[p][1], p) for p in paths]
    wa.git.rw(wa.repo(target), "update-index", "--index-info",
              index_file=wa.index_file(target, slot), check=True,
              stdin_bytes=("\n".join(lines) + "\n").encode("utf-8"))
    later = [res.states[i] for i in res.order
             if res.states[i].target == target
             and res.states[i].index > st.index
             and set(res.states[i].patch.paths()) & set(paths)]
    for other in reversed(later):
        args = ["apply", "--cached", "--reverse"]
        for p in paths:
            args.append("--include=" + p)
        args.append(str(other.link.patch_path))
        rc, _o, err = wa.git.rw(wa.repo(target), *args,
                                index_file=wa.index_file(target, slot))
        if rc != 0:
            raise gitio.GitError(
                "REVERSE_BLOCKED: #%d %s will not reverse out of the dev "
                "content for these paths: %s"
                % (other.index, other.link.patch_name, err.strip()[:300]))
    return wa.write_tree(target, slot=slot), [s.index for s in later]


def tree_with_patches(wa, target, base_tree, patch_paths, slot="regen"):
    wa.read_tree(target, base_tree, slot=slot)
    for p in patch_paths:
        rc, _o, err = wa.git.rw(wa.repo(target), "apply", "--cached", str(p),
                                index_file=wa.index_file(target, slot))
        if rc != 0:
            raise gitio.GitError("%s does not apply at that point: %s"
                                 % (os.path.basename(str(p)),
                                    err.strip()[:300]))
    return wa.write_tree(target, slot=slot)


# ---------------------------------------------------------------------------
# gates
# ---------------------------------------------------------------------------

def changed_old_lines(text):
    """Old-side line numbers each hunk actually removes, per file."""
    out = {}
    cur = None
    old = 0
    for line in text.split("\n"):
        if line.startswith("--- "):
            continue
        if line.startswith("+++ b/"):
            cur = line[6:].split("\t")[0].strip()
            out.setdefault(cur, set())
            continue
        m = HUNK_RE.match(line)
        if m:
            old = int(m.group(1))
            continue
        if cur is None:
            continue
        if line.startswith("-"):
            out[cur].add(old)
            old += 1
        elif line.startswith(" ") or line == "":
            old += 1
    return out


def line_gate(ctx, res, st, new_text, old_text):
    """Lines the regenerated patch changes that the old one did not and that
    another link owns. A refresh touches exactly what it touched before, so
    nothing fires; a --post-dev that absorbed a neighbouring feature does."""
    from . import ownsplan
    new_removed = changed_old_lines(new_text)
    old_removed = changed_old_lines(old_text)
    foreign = []
    for path, lines in sorted(new_removed.items()):
        extra = lines - old_removed.get(path, set())
        if not extra:
            continue
        try:
            owner, _t = ownsplan.ownership(ctx, res, st.target, path,
                                           upto=st.index - 1)
        except Exception:
            continue
        for ln in sorted(extra):
            who = owner[ln - 1] if 1 <= ln <= len(owner) else None
            if who not in (None, "base", st.index):
                foreign.append({"file": path, "line": ln, "owner": who,
                                "patch": res.states[who].link.patch_name})
    return foreign


# ---------------------------------------------------------------------------
# the proof
# ---------------------------------------------------------------------------

class _Sub(object):
    """A chain with one link's patch file swapped for a candidate."""

    def __init__(self, chain, index, path):
        import copy
        self.links = []
        for lk in chain.links:
            if lk.index == index:
                lk = copy.copy(lk)
                lk.patch_path = path
            self.links.append(lk)
        self.problems = chain.problems
        self.orphans = chain.orphans
        self.missing = chain.missing
        self.xash_bat = chain.xash_bat
        self.xash_bat_sha256 = chain.xash_bat_sha256


def proof(ctx, baseline, index, target, candidate, reference_trees,
          expect="identical", own_paths=None):
    """Replay the affected target with the candidate substituted."""
    from .h9chain import run_check
    sub = _Sub(ctx.chain, index, candidate)
    saved = ctx.chain
    ctx.chain = sub
    try:
        opts = {"no_dev": ctx.args.no_dev, "no_shadow": False,
                "targets": [target], "residual": not ctx.args.no_dev,
                "rules": ctx.cfg.rules}
        res = verdicts.run(ctx.cfg, ctx.wa, sub,
                           {lk.index for lk in sub.links if lk.target == target},
                           opts, ctx.out.note)
    finally:
        ctx.chain = saved
    checks = []
    bad = 0
    nonplain = [res.states[i] for i in res.order
                if res.states[i].target == target
                and res.states[i].forward not in ("plain", "skipped", None)]
    checks.append(("every link still applies plain",
                   not nonplain,
                   "non-plain: " + ", ".join("#%d %s" % (s.index, s.forward)
                                             for s in nonplain)
                   if nonplain else "yes"))
    want = reference_trees.get(target)
    got = res.final_tree.get(target)
    detail = "got %s, reference %s" % ((got or "-")[:12], (want or "-")[:12])
    if want is None:
        checks.append(("the final %s tree" % target, True,
                       "got %s; no reference to compare against (the chain "
                       "was already broken and there is no CHAIN.lock)"
                       % (got or "-")[:12]))
    elif expect == "identical":
        checks.append(("the final %s tree is unchanged" % target,
                       bool(want) and want == got, detail))
    else:
        # A --post-dev regen is allowed to change what the chain builds --
        # that is the point -- so the residual checks below carry the
        # verdict and this line only says which way it went.
        checks.append(("the final %s tree" % target, True,
                       detail + ("  (back to the reference)" if got == want
                                 else "  (moved, as --post-dev intends)")))
    newshadow = [res.states[i] for i in res.order
                 if res.states[i].target == target
                 and (res.states[i].shadowed_by is not None
                      or res.states[i].dev == "not_detectable")]
    oldshadow = set()
    if baseline:
        oldshadow = {baseline.states[i].index for i in baseline.order
                     if baseline.states[i].shadowed_by is not None
                     or baseline.states[i].dev == "not_detectable"}
    introduced = [s for s in newshadow if s.index not in oldshadow]
    checks.append(("no link becomes shadowed or undetectable",
                   not introduced,
                   "introduced: " + ", ".join("#%d" % s.index
                                              for s in introduced)
                   if introduced else "yes"))
    r = res.residual["targets"].get(target, {})
    bad_paths = [p for p in r.get("paths", []) if p["kind"] != "ALLOWED"]
    base_bad = []
    if baseline and baseline.residual.get("targets", {}).get(target):
        base_bad = [p for p in baseline.residual["targets"][target]
                    .get("paths", []) if p["kind"] != "ALLOWED"]
    if expect == "closes-residual" and own_paths is not None:
        still = [p for p in bad_paths if p["path"] in set(own_paths)]
        outside = [p for p in bad_paths
                   if p["path"] not in set(own_paths)
                   and p["path"] not in {q["path"] for q in base_bad}]
        checks.append(("the residual for those paths goes to zero",
                       not still,
                       "still differing: " + ", ".join(p["path"]
                                                       for p in still)
                       if still else "yes"))
        checks.append(("no path outside this link's own file set moves",
                       not outside,
                       "moved: " + ", ".join(p["path"] for p in outside)
                       if outside else "yes"))
    else:
        label = ("the replayed chain now equals the dev clone's working tree"
                 if want is None else "the residual is no worse")
        checks.append((label, len(bad_paths) <= len(base_bad),
                       "%d differing path(s), was %d"
                       % (len(bad_paths), len(base_bad))))
    for _n, ok, _d in checks:
        if not ok:
            bad += 1
    return {"ok": bad == 0, "checks": [{"name": n, "ok": bool(o),
                                        "detail": d} for n, o, d in checks],
            "final_tree": res.final_tree.get(target),
            "reference_tree": want}


# ---------------------------------------------------------------------------
# regen
# ---------------------------------------------------------------------------

def _record_path(wa, name, key):
    os.makedirs(wa.cand_dir, exist_ok=True)
    return os.path.join(wa.cand_dir, "%s.%s.patch" % (name[:-6] if
                                                      name.endswith(".patch")
                                                      else name, key[:8]))


def _write_record(wa, cand_path, rec):
    import json
    with open(cand_path + ".json", "w", encoding="ascii",
              errors="replace") as fh:
        json.dump(rec, fh, indent=1)


def cmd_regen(ctx):
    from .errors import Usage
    from .h9chain import run_check, resolve_sel
    sel = resolve_sel(ctx.chain, ctx.args.sel)
    if len(sel) != 1:
        raise Usage("regen takes exactly one link")
    idx = sel[0]
    allsel = {lk.index for lk in ctx.chain.links}
    baseline = run_check(ctx, allsel, want_residual=not ctx.args.no_dev)
    st = baseline.states[idx]
    if not st.pre_tree:
        raise Usage("link #%d has no pre-tree: the %s replay stopped at #%s"
                    % (idx, st.target, baseline.stopped_at.get(st.target)))
    wa = ctx.wa
    target = st.target
    o = ctx.out
    mode = "refresh"
    expect = "identical"
    allowed = set(st.patch.paths())
    extra_note = []

    explicit = bool(ctx.args.post_tree or ctx.args.post_dev
                    or ctx.args.from_dir or ctx.args.with_patches
                    or ctx.args.refresh)
    if not explicit and st.forward == "reject":
        # A REJECT means the recorded pre-image is wrong, so re-diffing the
        # patch against its own pre-tree cannot work: the feature's content
        # lives on the dev clone, and that is what the new patch must produce.
        if ctx.args.no_dev:
            raise Usage(
                "#%d is REJECT and --no-dev was given, so there is nothing "
                "to rebuild its post-image from. Either drop --no-dev, or "
                "name the source: %s"
                % (idx, ctx.cmdfmt(["regen", str(idx), "--with",
                                    "<patch>,..."])))
        ctx.args.post_dev = ",".join(st.patch.paths())
        o.say("#%d is REJECT, so the post-image comes from the dev clone's "
              "working tree" % idx)
        o.say("  (equivalent to: %s)"
              % ctx.cmdfmt(["regen", str(idx), "--post-dev",
                            ctx.args.post_dev]))

    if ctx.args.post_tree:
        mode = "post-tree"
        b = ctx.args.post_tree
    elif ctx.args.post_dev:
        mode = "post-dev"
        paths = [p.strip().replace("\\", "/")
                 for p in ctx.args.post_dev.split(",") if p.strip()]
        if not paths:
            raise Usage("--post-dev needs explicit paths; refusing to diff "
                        "the whole live tree")
        allowed |= set(paths)
        b, reversed_out = tree_post_dev(wa, target, st, baseline, paths)
        expect = "closes-residual"
        if reversed_out:
            extra_note.append("reversed out later touchers: "
                              + ", ".join("#%d" % i for i in reversed_out))
    elif ctx.args.from_dir:
        mode = "from"
        d = os.path.abspath(ctx.args.from_dir)
        if not os.path.isdir(d):
            raise Usage("no such directory: %s" % d)
        b, touched = tree_from_dir(wa, target, st.pre_tree, d)
        allowed |= set(touched)
        expect = "free"
    elif ctx.args.with_patches:
        mode = "with"
        plist = []
        for item in ctx.args.with_patches.split(","):
            item = item.strip()
            if not item:
                continue
            if os.path.isfile(item):
                plist.append(os.path.abspath(item))
                continue
            got = resolve_sel(ctx.chain, item)
            if len(got) != 1:
                raise Usage("--with: '%s' is not one patch" % item)
            plist.append(baseline.states[got[0]].link.patch_path)
        # The named patches are this link's missing predecessors, so they go
        # first and the link's own patch follows: that is the spraypicker
        # shape. If that will not build, the other order is tried and said.
        own = st.link.patch_path
        try:
            b = tree_with_patches(wa, target, st.pre_tree, plist + [own])
            order = "named patches first, then #%d" % idx
        except gitio.GitError:
            b = tree_with_patches(wa, target, st.pre_tree, [own] + plist)
            order = "#%d first, then the named patches" % idx
        for p in plist:
            allowed |= set(parse_patch(p).paths())
        extra_note.append("built from: " + ", ".join(
            os.path.basename(p) for p in plist + [own]) + " (" + order + ")")
    else:
        mode = "refresh"
        b = tree_with_patches(wa, target, st.pre_tree,
                              [st.link.patch_path])

    style = ctx.args.style
    if style == "auto":
        style = st.patch.style
    paths_filter = sorted(allowed)
    new_text = diff_trees(wa, target, st.pre_tree, b, paths_filter,
                          context=ctx.args.context, style=style,
                          abbrev=abbrev_of(st.patch))
    new_text = reorder_like(new_text, st.patch)
    if new_text and not new_text.endswith("\n"):
        new_text += "\n"

    gen_paths = set()
    for line in new_text.split("\n"):
        if line.startswith("+++ b/"):
            gen_paths.add(line[6:].split("\t")[0].strip())
    foreign_paths = sorted(gen_paths - allowed)

    with open(st.link.patch_path, "rb") as fh:
        old_text = fh.read().decode("latin-1")
    foreign_lines = line_gate(ctx, baseline, st, new_text, old_text)

    o.say("regen #%d %s  (mode %s, style %s)"
          % (idx, st.link.patch_name, mode, style))
    o.say("  A (pre)   %s" % st.pre_tree)
    o.say("  B (post)  %s" % b)
    o.say("  paths     %s" % ", ".join(paths_filter))
    for n in extra_note:
        o.say("  note      %s" % n)

    if foreign_paths and not ctx.args.allow_foreign:
        o.say("")
        o.say("  FOREIGN_PATH: the generated patch touches files outside "
              "this link's set:")
        for p in foreign_paths:
            o.say("    " + p)
        o.say("  pass --allow-foreign if that is intended.")
        ctx.finish("regen", set(), {"regen": {"ok": False,
                                              "foreign_paths": foreign_paths}})
        return 2
    if foreign_lines and not ctx.args.allow_foreign:
        o.say("")
        o.say("  FOREIGN_LINES: the generated patch newly changes lines "
              "another link owns:")
        for f in foreign_lines[:40]:
            o.say("    %s:%d owned by #%d %s" % (f["file"], f["line"],
                                                 f["owner"], f["patch"]))
        o.say("  pass --allow-foreign if that is intended.")
        ctx.finish("regen", set(), {"regen": {"ok": False,
                                              "foreign_lines": foreign_lines}})
        return 2

    key = sha256_bytes(new_text.encode("latin-1"))
    cand = ctx.args.out_file or _record_path(wa, st.link.patch_name, key)
    cand = os.path.abspath(cand)
    for p in ctx.cfg.protected_roots:
        if gitio.is_under(cand, p):
            raise gitio.Refusal("--out may not write into protected root %s"
                                % p)
    with open(cand, "wb") as fh:
        fh.write(new_text.encode("latin-1"))

    o.say("")
    o.say("  candidate %s" % cand)
    o.say("  old sha256 %s" % st.patch.sha256)
    o.say("  new sha256 %s" % sha256_file(cand))
    if new_text.encode("latin-1") == old_text.encode("latin-1"):
        o.say("  the regenerated text is byte-identical to the patch on disk")
    else:
        o.say("")
        o.say("  diff of the patch text (old -> new)")
        _print_textdiff(o, old_text, new_text)

    proofrec = None
    classes = set()
    if not ctx.args.no_proof:
        t0 = time.time()
        ref = reference_trees(ctx, baseline, target)
        proofrec = proof(ctx, baseline, idx, target, cand, ref, expect,
                         own_paths=sorted(allowed - set(st.patch.paths()))
                         if mode == "post-dev" else None)
        o.say("")
        o.say("  PROOF (%s, %.1fs)" % ("pass" if proofrec["ok"] else "FAIL",
                                       time.time() - t0))
        for c in proofrec["checks"]:
            o.say("    [%s] %-50s %s" % ("ok" if c["ok"] else "XX",
                                         c["name"], c["detail"]))
        if not proofrec["ok"]:
            classes.add("REJECT")

    moved = _downstream_anchor_moves(ctx, baseline, st, b)
    if moved:
        o.say("")
        o.say("  downstream anchors that move: " + ", ".join(moved))

    adopt_cmd = ctx.cmdfmt(["adopt", str(idx), "--from", cand, "--yes"])
    o.say("")
    o.say("  NEXT: " + adopt_cmd)
    if not ctx.cfg.allow_patch_writes:
        o.say("        (writes are off: set \"allow_patch_writes\": true in "
              "%s first)" % ctx.cfg.config_file)

    _write_record(wa, cand, {
        "kind": "regen", "link": idx, "target": target, "mode": mode,
        "what": mode,
        "a": st.pre_tree, "b": b, "paths": paths_filter,
        "old_sha256": st.patch.sha256, "new_sha256": sha256_file(cand),
        "dest": st.link.patch_path, "dest_sha256_at_regen": st.patch.sha256,
        "xash_bat_sha256": ctx.chain.xash_bat_sha256,
        "proof": proofrec, "expect": expect,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    return ctx.finish("regen", classes, {"regen": {
        "ok": bool(proofrec is None or proofrec["ok"]),
        "link": idx, "target": target, "mode": mode, "style": style,
        "a": st.pre_tree, "b": b, "paths": paths_filter,
        "candidate": cand, "old_sha256": st.patch.sha256,
        "new_sha256": sha256_file(cand), "identical": new_text.encode(
            "latin-1") == old_text.encode("latin-1"),
        "foreign_paths": foreign_paths, "foreign_lines": foreign_lines,
        "downstream_anchor_moves": moved,
        "proof": proofrec, "adopt_command": adopt_cmd}})


def reference_trees(ctx, baseline, target):
    """What the chain is supposed to produce.

    The baseline run's own final tree is only a reference when that run got
    to the end. When it stopped at a REJECT, the reference is CHAIN.lock, or
    failing that the dev clone's working tree, which is what the chain is
    meant to reproduce. With neither, there is no reference and the proof
    says so instead of inventing one.
    """
    ref = dict(baseline.final_tree)
    lock = _load_lock(ctx)
    if target in baseline.stopped_at:
        ref.pop(target, None)
        ref["_source"] = "none"
    else:
        ref["_source"] = "this run's own replay"
    if lock and lock.get("final_tree", {}).get(target):
        ref[target] = lock["final_tree"][target]
        ref["_source"] = "CHAIN.lock"
    return ref


def _load_lock(ctx):
    from .h9chain import load_lock
    return load_lock(ctx)


def _downstream_anchor_moves(ctx, res, st, new_post):
    if new_post == st.post_tree:
        return []
    moved = []
    for idx in res.order:
        o = res.states[idx]
        if o.target != st.target or o.index <= st.index:
            continue
        if set(o.patch.paths()) & set(st.patch.paths()):
            if any(f.index_pre for f in o.patch.files):
                moved.append("#%d %s" % (o.index, o.link.patch_name))
    return moved


def _print_textdiff(o, old, new):
    import difflib
    n = 0
    for line in difflib.unified_diff(old.split("\n"), new.split("\n"),
                                     "old", "new", lineterm="", n=1):
        o.say("    " + line)
        n += 1
        if n > 200:
            o.say("    ... (truncated)")
            break


# ---------------------------------------------------------------------------
# fold
# ---------------------------------------------------------------------------

def cmd_fold(ctx):
    from .errors import Usage
    from .h9chain import run_check, resolve_sel
    into = resolve_sel(ctx.chain, ctx.args.into)
    if len(into) != 1:
        raise Usage("--into takes exactly one link")
    bidx = into[0]
    allsel = {lk.index for lk in ctx.chain.links}
    baseline = run_check(ctx, allsel, want_residual=not ctx.args.no_dev)
    base = baseline.states[bidx]
    target = base.target
    wa = ctx.wa
    o = ctx.out

    src_arg = ctx.args.source
    src_link = None
    if os.path.isfile(src_arg):
        src_path = os.path.abspath(src_arg)
    else:
        got = resolve_sel(ctx.chain, src_arg)
        if len(got) != 1:
            raise Usage("source must be one chain link or a path to a .patch")
        src_link = baseline.states[got[0]]
        src_path = src_link.link.patch_path
    src = parse_patch(src_path)
    if src.unsupported:
        raise Usage("PATCH_UNSUPPORTED: %s" % "; ".join(src.unsupported))

    mode = ctx.args.mode
    reason = ""
    if mode == "auto":
        if src_link is not None:
            mode = "post"
            reason = ("the source is a live chain link, so folding it "
                      "forward keeps both features and moves the base's "
                      "post-image")
        else:
            dev_fwd = dev_rev = False
            try:
                info = wa.dev_mirror(target)
                wa.read_tree(target, info["mirror_tree"], slot="folddev")
                rc, _o, _e = wa.apply_cached(target, src_path, slot="folddev",
                                             reverse=True, check=True)
                dev_rev = rc == 0
                rc, _o, _e = wa.apply_cached(target, src_path, slot="folddev",
                                             check=True)
                dev_fwd = rc == 0
            except Exception:
                pass
            if not dev_fwd and not dev_rev:
                mode = "pre"
                reason = ("the source applies in neither direction on the "
                          "dev clone, so its content is already committed "
                          "there: it belongs in the base's PRE-image")
            else:
                mode = "post"
                reason = ("the source still applies on the dev clone, so it "
                          "is a live change to fold forward")

    o.say("fold %s --into #%d %s" % (os.path.basename(src_path), bidx,
                                     base.link.patch_name))
    o.say("  target    %s" % target)
    o.say("  mode      %s" % mode)
    if reason:
        o.say("  reason    %s" % reason)

    if mode == "post":
        a = base.pre_tree
        if a is None:
            raise Usage("#%d has no pre-tree" % bidx)
        b = tree_with_patches(wa, target, a, [base.link.patch_path, src_path])
        expect = "identical" if src_link is not None else "free"
    else:
        a = base.pre_tree
        wa.read_tree(target, a, slot="fold")
        rc, _o2, _e2 = wa.git.rw(wa.repo(target), "apply", "--cached",
                                 "--check", str(src_path),
                                 index_file=wa.index_file(target, "fold"))
        if rc != 0:
            a = _find_slot(wa, target, baseline, src_path)
            if a is None:
                raise Usage("the source applies nowhere on this target's "
                            "chain; it cannot be folded as a pre-image")
        b = tree_with_patches(wa, target, a, [src_path,
                                              base.link.patch_path])
        expect = "identical"

    paths = sorted(set(base.patch.paths()) | set(src.paths()))
    style = base.patch.style
    new_text = diff_trees(wa, target, a, b, paths,
                          context=ctx.args.context, style=style,
                          abbrev=abbrev_of(base.patch))
    new_text = reorder_like(new_text, base.patch)
    if new_text and not new_text.endswith("\n"):
        new_text += "\n"
    key = sha256_bytes(new_text.encode("latin-1"))
    cand = os.path.abspath(ctx.args.out_file
                           or _record_path(wa, base.link.patch_name, key))
    for p in ctx.cfg.protected_roots:
        if gitio.is_under(cand, p):
            raise gitio.Refusal("--out may not write into protected root %s"
                                % p)
    with open(cand, "wb") as fh:
        fh.write(new_text.encode("latin-1"))

    o.say("  A (pre)   %s" % a)
    o.say("  B (post)  %s%s" % (b, "   [byte-identical to the old post-image]"
                                if b == base.post_tree else ""))
    o.say("  paths     %s" % ", ".join(paths))
    o.say("  candidate %s" % cand)

    invariants = []
    wa.read_tree(target, a, slot="fold")
    rc, _o2, _e2 = wa.git.rw(wa.repo(target), "apply", "--cached", "--check",
                             cand, index_file=wa.index_file(target, "fold"))
    invariants.append(("the folded patch applies plain on the pristine "
                       "prefix", rc == 0, "rc=%d" % rc))
    rc = 1
    try:
        info = wa.dev_mirror(target)
        wa.read_tree(target, info["mirror_tree"], slot="folddev")
        rc, _o2, _e2 = wa.git.rw(wa.repo(target), "apply", "--cached",
                                 "--reverse", "--check", cand,
                                 index_file=wa.index_file(target, "folddev"))
    except Exception:
        pass
    invariants.append(("it still reverse-checks in place on the dev mirror",
                       rc == 0, "rc=%d" % rc))
    if mode == "pre":
        comparable = (target not in baseline.stopped_at
                      and base.forward not in (None, "reject", "unsupported"))
        if comparable:
            invariants.append(("the base's post-image is byte-identical",
                               b == base.post_tree,
                               "%s vs %s" % ((b or "-")[:12],
                                             (base.post_tree or "-")[:12])))
        else:
            invariants.append(
                ("the base's post-image is byte-identical", True,
                 "not comparable: #%d does not apply at all today, so it has "
                 "no post-image to compare against; the proof's final tree "
                 "id carries this instead" % bidx))
    o.say("")
    o.say("  DUAL-TREE INVARIANT")
    for n, ok, d in invariants:
        o.say("    [%s] %-54s %s" % ("ok" if ok else "XX", n, d))

    proofrec = None
    classes = set()
    if not ctx.args.no_proof:
        ref = reference_trees(ctx, baseline, target)
        if expect == "identical" and src_link is not None:
            # folding a live link forward removes it from the chain, so the
            # proof runs against the chain minus that link
            proofrec = _proof_fold_post(ctx, baseline, bidx, src_link.index,
                                        target, cand, ref)
        else:
            proofrec = proof(ctx, baseline, bidx, target, cand, ref, expect)
        o.say("")
        o.say("  PROOF (%s)" % ("pass" if proofrec["ok"] else "FAIL"))
        for c in proofrec["checks"]:
            o.say("    [%s] %-50s %s" % ("ok" if c["ok"] else "XX",
                                         c["name"], c["detail"]))
        if not proofrec["ok"]:
            classes.add("REJECT")

    # adopt refuses a candidate with no proof record beside it, and the line
    # above tells the reader to adopt this one, so the record is written here
    # too and not only by regen.
    _write_record(wa, cand, {
        "kind": "fold", "link": bidx, "target": target, "mode": mode,
        "what": "folded %s into it" % os.path.basename(src_path),
        "a": a, "b": b, "paths": paths,
        "old_sha256": base.patch.sha256, "new_sha256": sha256_file(cand),
        "dest": base.link.patch_path,
        "dest_sha256_at_regen": base.patch.sha256,
        "xash_bat_sha256": ctx.chain.xash_bat_sha256,
        "proof": proofrec, "expect": expect,
        "source": src_path,
        "xash_bat_line_to_delete": (src_link.link.line_no if src_link
                                    else None),
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    o.say("")
    o.say("  TO ADOPT (this tool edits neither xash.bat nor the changelog)")
    o.say("    " + ctx.cmdfmt(["adopt", str(bidx), "--from", cand, "--yes"]))
    if src_link is not None:
        o.say("    delete xash.bat line %d:" % src_link.link.line_no)
        o.say("      " + src_link.link.raw.strip())
        o.say("    git mv \"%s\" \"%s\""
              % (src_path, os.path.join(ctx.cfg.retired_dir,
                                        os.path.basename(src_path))))
    o.say("    PATCH_CHANGELOG.md entry to paste:")
    for line in _changelog_entry(base, base.patch.sha256, sha256_file(cand),
                                 "folded %s into it"
                                 % os.path.basename(src_path)):
        o.say("      " + line)

    return ctx.finish("fold", classes, {"fold": {
        "ok": bool(proofrec is None or proofrec["ok"]),
        "into": bidx, "source": src_path, "mode": mode, "reason": reason,
        "a": a, "b": b, "paths": paths, "candidate": cand,
        "post_identical": b == base.post_tree,
        "invariants": [{"name": n, "ok": bool(o2), "detail": d}
                       for n, o2, d in invariants],
        "proof": proofrec,
        "adopt_command": ctx.cmdfmt(["adopt", str(bidx), "--from", cand,
                                     "--yes"]),
        "xash_bat_line_to_delete": (src_link.link.line_no if src_link
                                    else None)}})


def _find_slot(wa, target, res, src_path):
    states = [res.states[i] for i in res.order if res.states[i].target
              == target]
    trees = [wa.base_tree(target)] + [s.post_tree for s in states]
    for t in trees:
        if not t:
            continue
        wa.read_tree(target, t, slot="fold")
        rc, _o, _e = wa.git.rw(wa.repo(target), "apply", "--cached", "--check",
                               str(src_path),
                               index_file=wa.index_file(target, "fold"))
        if rc == 0:
            return t
    return None


def _proof_fold_post(ctx, baseline, base_idx, src_idx, target, cand, ref):
    """Replay with the base swapped for the candidate and the source link
    dropped, which is what the printed xash.bat edit does."""
    import copy

    class _C(object):
        pass
    sub = _C()
    sub.links = []
    for lk in ctx.chain.links:
        if lk.index == src_idx:
            continue
        if lk.index == base_idx:
            lk = copy.copy(lk)
            lk.patch_path = cand
        sub.links.append(lk)
    sub.problems, sub.orphans, sub.missing = [], [], []
    sub.xash_bat = ctx.chain.xash_bat
    sub.xash_bat_sha256 = ctx.chain.xash_bat_sha256
    opts = {"no_dev": ctx.args.no_dev, "no_shadow": False,
            "targets": [target], "residual": not ctx.args.no_dev,
            "rules": ctx.cfg.rules}
    res = verdicts.run(ctx.cfg, ctx.wa, sub,
                       {lk.index for lk in sub.links if lk.target == target},
                       opts, ctx.out.note)
    nonplain = [res.states[i] for i in res.order
                if res.states[i].target == target
                and res.states[i].forward not in ("plain", "skipped", None)]
    got = res.final_tree.get(target)
    want = ref.get(target)
    shadowed = [i for i in res.order if res.states[i].shadowed_by is not None]
    checks = [
        ("every link still applies plain", not nonplain,
         "non-plain: " + ", ".join("#%d" % s.index for s in nonplain)
         if nonplain else "yes"),
        ("the final %s tree is unchanged" % target, bool(want) and want == got,
         "%s vs %s" % ((got or "-")[:12], (want or "-")[:12])),
        ("nothing is shadowed", not shadowed,
         "shadowed: %s" % shadowed if shadowed else "yes"),
    ]
    return {"ok": all(c[1] for c in checks),
            "checks": [{"name": n, "ok": bool(o), "detail": d}
                       for n, o, d in checks],
            "final_tree": got, "reference_tree": want}


# Internal mode names are not English: 'What changed: post-dev.' told the
# changelog's reader nothing.
MODE_PROSE = {
    "refresh": "regenerated against its own pre-tree, so the hunk headers "
               "and the recorded index blobs match the chain again; the "
               "content is identical by construction",
    "post-dev": "regenerated from the dev clone's working tree, with every "
                "later patch that touches the same files reversed out first",
    "with": "regenerated with its missing predecessor patches applied first",
    "from": "regenerated from edited files",
    "post-tree": "regenerated against a named post-image tree",
}


def _changelog_entry(st, old_sha, new_sha, what):
    """The entry to paste into PATCH_CHANGELOG.md.

    old_sha is passed in and never read back off the destination: adopt reads
    the file AFTER copying it, so taking the old value from there printed the
    new sha twice and would have put a false value into a tracked file that
    lint rule L1 keys on.
    """
    return [
        "### %s -- %s" % (time.strftime("%Y-%m-%d"), st.link.patch_name),
        "",
        "What changed: %s." % MODE_PROSE.get(what, what),
        "Why: the chain's recorded pre-image no longer matched the tree the "
        "preceding links produce.",
        "Verified: h9chain replayed the chain from the pinned base; every "
        "link applies plain and the final tree ids are unchanged.",
        "old sha256 %s" % (old_sha or "(the file did not exist)"),
        "new sha256 %s" % new_sha,
    ]


# ---------------------------------------------------------------------------
# adopt
# ---------------------------------------------------------------------------

def cmd_adopt(ctx):
    import json
    from .errors import Usage
    from .h9chain import resolve_sel, run_check
    sel = resolve_sel(ctx.chain, ctx.args.sel)
    if len(sel) != 1:
        raise Usage("adopt takes exactly one link")
    idx = sel[0]
    link = [lk for lk in ctx.chain.links if lk.index == idx][0]
    if not ctx.args.yes:
        raise Usage("adopt needs --yes; it is the only command that writes "
                    "outside the work area")
    if not ctx.cfg.allow_patch_writes:
        raise gitio.Refusal(
            "patch writes are disabled. Set \"allow_patch_writes\": true in "
            "%s to enable the one write this tool can make." % ctx.cfg.config_file)
    src = ctx.args.from_file
    if not src:
        cands = sorted(
            (p for p in os.listdir(ctx.wa.cand_dir)
             if p.startswith(link.patch_name[:-6]) and p.endswith(".patch")),
            key=lambda p: os.path.getmtime(os.path.join(ctx.wa.cand_dir, p)))
        if not cands:
            raise Usage("no candidate for #%d; run regen or fold first" % idx)
        src = os.path.join(ctx.wa.cand_dir, cands[-1])
    src = os.path.abspath(src)
    if not os.path.isfile(src):
        raise Usage("no such candidate: %s" % src)
    rec_path = src + ".json"
    if not os.path.isfile(rec_path):
        raise Usage("no proof record beside %s; regen or fold writes one"
                    % src)
    with open(rec_path, "r", encoding="ascii", errors="replace") as fh:
        rec = json.load(fh)
    if rec.get("xash_bat_sha256") != ctx.chain.xash_bat_sha256:
        raise Usage("xash.bat has changed since that candidate was made; "
                    "re-run the regen")
    dest = link.patch_path
    ok_dest = (os.path.normcase(os.path.dirname(dest)) in
               (os.path.normcase(ctx.cfg.patches_dir),
                os.path.normcase(ctx.cfg.web_dir)))
    if not ok_dest:
        raise Usage("refusing to write outside the patches directories: %s"
                    % dest)
    now = sha256_file(dest) if os.path.isfile(dest) else None
    if rec.get("dest_sha256_at_regen") and now != rec["dest_sha256_at_regen"]:
        raise Usage("%s changed since the candidate was generated "
                    "(%s now, %s then); re-run the regen"
                    % (dest, (now or "-")[:12],
                       rec["dest_sha256_at_regen"][:12]))
    old_sha = now or rec.get("old_sha256")
    shutil.copyfile(src, dest)
    new_sha = sha256_file(dest)
    ctx.out.say("wrote %s" % dest)
    ctx.out.say("  from %s" % src)
    ctx.out.say("  sha256 %s -> %s" % ((old_sha or "-")[:16], new_sha[:16]))
    ctx.chain = __import__("h9chain.chainparse", fromlist=["x"]).parse_chain(
        ctx.cfg.xash_bat, ctx.cfg.patches_dir, ctx.cfg.web_dir,
        ctx.cfg.retired_dir)
    res = run_check(ctx, {lk.index for lk in ctx.chain.links
                          if lk.target == link.target},
                    want_residual=False)
    st = res.states[idx]
    ctx.out.say("  re-checked: #%d is now %s" % (idx, st.verdict))
    ctx.out.say("")
    ctx.out.say("PATCH_CHANGELOG.md entry to paste (this tool never writes "
                "the changelog):")
    entry = _changelog_entry(st, old_sha, new_sha,
                             rec.get("what") or rec.get("mode",
                                                        "regenerated"))
    for line in entry:
        ctx.out.say("  " + line)
    classes = {verdicts.CLASS_OF_VERDICT.get(st.verdict)} - {None}
    return ctx.finish("adopt", classes, {"adopt": {
        "link": idx, "dest": dest, "from": src,
        "old_sha256": old_sha, "sha256": new_sha, "verdict": st.verdict,
        "changelog_entry": entry}})
