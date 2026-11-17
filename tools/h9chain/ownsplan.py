"""Line ownership, and pre-flighting a patch that is not wired yet.

'owns' answers the question seven near-misses were worked out by hand: which
link put this line here. 'plan' answers it before the patch exists in the
chain, which is the whole near-miss class.
"""

import os
import re

from . import gitio, report, verdicts
from .chainparse import TARGETS, parse_patch

HUNK_RE = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')


def _file_lines(wa, target, tree, path):
    rc, out, _ = wa.git.rw(wa.repo(target), "cat-file", "-p",
                           "%s:%s" % (tree, path))
    if rc != 0:
        return 0
    n = out.count("\n")
    if out and not out.endswith("\n"):
        n += 1
    return n


def _hunks(wa, target, pre, post, path):
    rc, out, _ = wa.git.rw(wa.repo(target), "diff-tree", "-p", "-U0",
                           "--no-renames", pre, post, "--", path)
    if rc != 0:
        return []
    hs = []
    for line in out.splitlines():
        m = HUNK_RE.match(line)
        if m:
            a = int(m.group(1))
            b = int(m.group(2)) if m.group(2) is not None else 1
            c = int(m.group(3))
            d = int(m.group(4)) if m.group(4) is not None else 1
            hs.append((a, b, c, d))
    return hs


def ownership(ctx, res, target, path, upto=None):
    """Owner of every line of <path> as the chain leaves it.

    Walks the links of this target in chain order and replays each one's own
    -U0 diff onto an owner array, so a later link shifting an earlier one's
    lines cannot confuse the map.
    """
    wa = ctx.wa
    base = wa.base_tree(target)
    owner = ["base"] * _file_lines(wa, target, base, path)
    touched = []
    for idx in res.order:
        st = res.states[idx]
        if st.target != target:
            continue
        if upto is not None and st.index > upto:
            continue
        if path not in st.patch.paths():
            continue
        if not st.pre_tree or not st.post_tree:
            continue
        touched.append(st)
        delta = 0
        for a, b, _c, d in _hunks(wa, target, st.pre_tree, st.post_tree, path):
            start = (a - 1 if b else a) + delta
            start = max(start, 0)
            owner[start:start + b] = [st.index] * d
            delta += d - b
    return owner, touched


def regions(owner):
    out = []
    i = 0
    n = len(owner)
    while i < n:
        j = i
        while j + 1 < n and owner[j + 1] == owner[i]:
            j += 1
        out.append((owner[i], i + 1, j + 1))
        i = j + 1
    return out


def _target_for_path(ctx, res, path, explicit=None):
    if explicit:
        return explicit
    for idx in res.order:
        st = res.states[idx]
        if path in st.patch.paths():
            return st.target
    for t in TARGETS:
        try:
            tree = ctx.wa.base_tree(t)
        except Exception:
            continue
        rc, _o, _e = ctx.wa.git.rw(ctx.wa.repo(t), "cat-file", "-e",
                                   "%s:%s" % (tree, path))
        if rc == 0:
            return t
    return None


def cmd_owns(ctx):
    from .errors import Usage
    from .h9chain import run_check
    path = ctx.args.path.replace("\\", "/")
    # Ownership needs only the trees, so nothing is applied or judged here.
    res = run_check(ctx, set(), want_residual=False, no_dev=True,
                    no_shadow=True)
    explicit = (ctx.args.target or [None])[0] if ctx.args.target else None
    target = _target_for_path(ctx, res, path, explicit)
    if not target:
        raise Usage("no target holds '%s'; name one with --target" % path)
    owner, touched = ownership(ctx, res, target, path)
    regs = regions(owner)
    names = {res.states[i].index: res.states[i].link.patch_name
             for i in res.order}
    o = ctx.out
    o.say("%s  (%s, %d lines, %d link(s) touch it)"
          % (path, target, len(owner), len(touched)))
    if ctx.args.line:
        ln = ctx.args.line
        who = owner[ln - 1] if 1 <= ln <= len(owner) else None
        o.say("  line %d: %s" % (ln, "base" if who == "base" else
                                 ("#%s %s" % (who, names.get(who, "?")))
                                 if who is not None else "out of range"))
    if ctx.args.regions or not ctx.args.line:
        o.say("")
        o.say("  %-10s %-10s %s" % ("lines", "owner", "patch"))
        for who, a, b in regs:
            if who == "base":
                continue
            o.say("  %-10s %-10s %s" % ("%d-%d" % (a, b), "#%s" % who,
                                        names.get(who, "?")))
    base_lines = sum(b - a + 1 for who, a, b in regs if who == "base")
    o.say("")
    o.say("  %d line(s) from the base commit, %d from the chain"
          % (base_lines, len(owner) - base_lines))
    data = {"path": path, "target": target, "lines": len(owner),
            "regions": [{"owner": ("base" if w == "base" else w),
                         "patch": (None if w == "base" else names.get(w)),
                         "start": a, "end": b} for w, a, b in regs],
            "touchers": [t.index for t in touched]}
    return ctx.finish("owns", set(), {"owns": data})


def owners_for(ctx, res, st):
    """Earlier links owning regions in this link's files, and later links
    that write inside its post-image."""
    earlier, later = [], []
    names = {res.states[i].index: res.states[i].link.patch_name
             for i in res.order}
    for path in st.patch.paths():
        try:
            owner, _t = ownership(ctx, res, st.target, path, upto=st.index - 1)
        except Exception:
            continue
        for who, a, b in regions(owner):
            if who == "base":
                continue
            earlier.append({"link": who, "patch": names.get(who, "?"),
                            "file": path, "ranges": "%d-%d" % (a, b)})
    for idx in res.order:
        o = res.states[idx]
        if o.target != st.target or o.index <= st.index:
            continue
        shared = sorted(set(o.patch.paths()) & set(st.patch.paths()))
        for path in shared:
            if not (o.pre_tree and o.post_tree):
                continue
            hs = _hunks(ctx.wa, st.target, o.pre_tree, o.post_tree, path)
            rng = ", ".join("%d-%d" % (c, c + max(d, 1) - 1)
                            for _a, _b, c, d in hs)
            later.append({"link": o.index, "patch": o.link.patch_name,
                          "file": path, "ranges": rng})
    return {"earlier": earlier, "later": later}


# ---------------------------------------------------------------------------
# plan
# ---------------------------------------------------------------------------

def cmd_plan(ctx):
    from .errors import Usage
    from .h9chain import run_check, resolve_sel
    cand_path = os.path.abspath(ctx.args.candidate)
    if not os.path.isfile(cand_path):
        raise Usage("no such patch: %s" % cand_path)
    cand = parse_patch(cand_path)
    if cand.unsupported:
        raise Usage("PATCH_UNSUPPORTED: %s" % "; ".join(cand.unsupported))
    res = run_check(ctx, set(), want_residual=False, no_dev=True,
                    no_shadow=True)

    target = ctx.args.for_target
    if not target:
        for p in cand.paths():
            target = _target_for_path(ctx, res, p)
            if target:
                break
    if not target:
        raise Usage("could not tell which target this patch belongs to; "
                    "name it with --for-target")
    states = [res.states[i] for i in res.order
              if res.states[i].target == target]

    if ctx.args.last or not ctx.args.after:
        after_idx = states[-1].index
        pos = len(states)
    else:
        a = resolve_sel(ctx.chain, ctx.args.after)
        if len(a) != 1:
            raise Usage("--after takes exactly one link")
        after_idx = a[0]
        pos = None
        for i, st in enumerate(states):
            if st.index == after_idx:
                pos = i + 1
        if pos is None:
            raise Usage("link #%d is not on target '%s'" % (after_idx, target))

    wa = ctx.wa
    slot_tree = states[pos - 1].post_tree if pos else wa.base_tree(target)
    if not slot_tree:
        raise Usage("the tree at that slot is not available; run 'check "
                    "--all' first")

    o = ctx.out
    o.say("plan %s" % cand_path)
    o.say("  target        %s" % target)
    o.say("  slot          after #%d (%s), chain position %d of %d"
          % (after_idx, states[pos - 1].link.patch_name if pos else "base",
             pos, len(states)))
    o.say("  files         %s" % ", ".join(cand.paths()))

    wa.read_tree(target, slot_tree, slot="plan")
    rc, _out, err = wa.apply_cached(target, cand_path, slot="plan",
                                    check=True, verbose=True)
    applies = rc == 0
    o.say("  applies here  %s" % ("yes" if applies else "NO"))
    if not applies:
        o.say("    " + (err.strip().splitlines() or ["(no detail)"])[0])

    shadows = []
    broken = []
    after_tree = None
    if applies:
        wa.apply_cached(target, cand_path, slot="plan")
        after_tree = wa.write_tree(target, slot="plan")
        for st in states[:pos]:
            rc, _o2, _e2 = wa.apply_cached(target, st.link.patch_path,
                                           slot="plan", reverse=True,
                                           check=True)
            if rc != 0:
                shadows.append(st)
        for st in states[pos:]:
            rc, _o2, _e2 = wa.apply_cached(target, st.link.patch_path,
                                           slot="plan", check=True)
            if rc != 0:
                broken.append(st)
            else:
                wa.apply_cached(target, st.link.patch_path, slot="plan")

    o.say("")
    if shadows:
        o.say("  SHADOWS %d earlier link(s):" % len(shadows))
        for st in shadows:
            detail = verdicts._attribute(
                wa, target,
                st,
                _FakeCulprit(cand_path, cand, slot_tree, after_tree))
            rng = "; ".join("%s %s" % (f, ", ".join("%d-%d" % (a, b)
                                                    for a, b in v))
                            for f, v in sorted(detail["ranges"].items()))
            o.say("    #%-3d %-36s %s" % (st.index, st.link.patch_name, rng))
            o.say("         xash.bat would stop at #%d on the next fresh "
                  "build; the fix is to fold this candidate into it"
                  % st.index)
    else:
        o.say("  SHADOWS none")
    if broken:
        o.say("  would break %d later link(s): %s"
              % (len(broken), ", ".join("#%d %s" % (s.index,
                                                    s.link.patch_name)
                                        for s in broken)))

    o.say("")
    o.say("  forbidden regions in the files this candidate touches")
    forbidden = []
    for path in cand.paths():
        owner, _t = ownership(ctx, res, target, path, upto=after_idx)
        for who, a, b in regions(owner):
            if who == "base":
                continue
            nm = res.states[who].link.patch_name
            forbidden.append({"file": path, "link": who, "patch": nm,
                              "start": a, "end": b})
            o.say("    %-44s %-9s #%-3d %s"
                  % (path, "%d-%d" % (a, b), who, nm))
    if not forbidden:
        o.say("    none")

    # Where it applies, and -- separately -- where it is SAFE. Those are not
    # the same question: reporting "legal slots 0-7" for a candidate that was
    # condemned two lines earlier for breaking the link at position 7 is how
    # an agent reintroduces the 2026-11-17 break.
    applies_at = []
    superseded_at = None
    sharers = [i for i, st in enumerate(states)
               if set(st.patch.paths()) & set(cand.paths())]
    for p in range(0, len(states) + 1):
        t = wa.base_tree(target) if p == 0 else states[p - 1].post_tree
        if not t:
            continue
        wa.read_tree(target, t, slot="plan2")
        rc, _o2, _e2 = wa.apply_cached(target, cand_path, slot="plan2",
                                       check=True)
        if rc == 0:
            applies_at.append(p)
        if superseded_at is None and p > 0:
            rc, _o2, _e2 = wa.apply_cached(target, cand_path, slot="plan2",
                                           reverse=True, check=True)
            if rc == 0:
                superseded_at = p
    safe = []
    breaks = {}
    for p in applies_at:
        t = wa.base_tree(target) if p == 0 else states[p - 1].post_tree
        wa.read_tree(target, t, slot="plan3")
        wa.apply_cached(target, cand_path, slot="plan3")
        hurt = []
        # Only a link touching one of the candidate's own files can be broken
        # by it, so this stays a handful of checks per slot.
        for i in sharers:
            if i < p:
                continue
            rc, _o2, _e2 = wa.apply_cached(target, states[i].link.patch_path,
                                           slot="plan3", check=True)
            if rc != 0:
                hurt.append(states[i].index)
            else:
                wa.apply_cached(target, states[i].link.patch_path,
                                slot="plan3")
        if hurt:
            breaks[p] = hurt
        else:
            safe.append(p)

    carrier = states[superseded_at - 1] if superseded_at else None
    if carrier is not None:
        o.say("")
        o.say("  SUPERSEDED: from chain position %d onward this candidate "
              "reverse-checks," % superseded_at)
        o.say("  so its content is already produced by #%d %s."
              % (carrier.index, carrier.link.patch_name))
        if applies_at:
            o.say("  It does still apply at position(s) %s, but wiring it "
                  "there leaves two"
                  % ", ".join(str(p) for p in applies_at))
            o.say("  links producing one change: the later one then has no "
                  "pre-image left and")
            o.say("  goes REJECT. That is exactly what happened on "
                  "2026-11-17.")
        else:
            o.say("  It applies nowhere, so wiring it as a separate link "
                  "gives a patch")
            o.say("  applicable in neither direction: the state that broke "
                  "the master build.")
        o.say("  The fix is one patch, not two:")
        o.say("    " + ctx.cmdfmt(["fold", cand_path, "--into",
                                   str(carrier.index), "--mode", "pre"]))
    o.say("")
    if safe:
        o.say("  SAFE slots    positions %s: it applies there AND every "
              "later link still applies"
              % ", ".join(str(p) for p in safe))
        o.say("                (after #%s .. after #%s)"
              % ("base" if safe[0] == 0 else states[safe[0] - 1].index,
                 "base" if safe[-1] == 0 else states[safe[-1] - 1].index))
    else:
        o.say("  SAFE slots    NONE: there is no position where this "
              "candidate both applies")
        o.say("                and leaves every later link applying.")
    if breaks:
        o.say("  applies but BREAKS a later link at: %s"
              % "; ".join("position %d -> %s"
                          % (p, ", ".join("#%d" % i for i in v))
                          for p, v in sorted(breaks.items())))
    if carrier is not None and safe:
        o.say("  NOTE: a safe slot is still the wrong answer while "
              "SUPERSEDED stands above.")

    classes = set()
    if shadows or carrier is not None:
        classes.add("SHADOW")
    findings = []
    if carrier is not None:
        findings.append({
            "id": "", "class": "SHADOW", "severity": "error",
            "code": "PLAN_SUPERSEDED", "blocking": True,
            "link": carrier.index, "patch": carrier.link.patch_name,
            "message": ("#%d %s already produces this candidate's content, "
                        "so there is no slot for it as a separate link"
                        % (carrier.index, carrier.link.patch_name)),
            "next_command": ["fold", cand_path, "--into",
                             str(carrier.index), "--mode", "pre"],
            "next_command_str": ctx.cmdfmt(["fold", cand_path, "--into",
                                            str(carrier.index), "--mode",
                                            "pre"])})
    # A later link that shares a file with the candidate and cannot apply
    # once the candidate is in is not merely "broken": the two write the same
    # change. That is the 2026-11-17 shape, and the repair is a fold, so say
    # so rather than leaving the reader with a slot number.
    dup = set()
    for p, hurt in sorted(breaks.items()):
        for i in hurt:
            if set(res.states[i].patch.paths()) & set(cand.paths()):
                dup.add(i)
    for i in sorted(dup):
        nm = res.states[i].link.patch_name
        o.say("  DUPLICATE OF #%d %s: it touches the same file(s) and cannot "
              "apply once this" % (i, nm))
        o.say("  candidate is in. These are one patch, not two:")
        o.say("    " + ctx.cmdfmt(["fold", cand_path, "--into", str(i),
                                   "--mode", "pre"]))
        findings.append({
            "id": "", "class": "SHADOW", "severity": "error",
            "code": "PLAN_DUPLICATE_OF", "link": i, "patch": nm,
            "blocking": True, "order_hint": 0,
            "message": ("#%d %s writes the same change as this candidate: it "
                        "cannot apply once the candidate is wired. Wiring "
                        "both is what broke the master build on 2026-11-17."
                        % (i, nm)),
            "next_command": ["fold", cand_path, "--into", str(i), "--mode",
                             "pre"],
            "next_command_str": ctx.cmdfmt(["fold", cand_path, "--into",
                                            str(i), "--mode", "pre"])})
        classes.add("SHADOW")
    for p, hurt in sorted(breaks.items()):
        rest = [i for i in hurt if i not in dup]
        if not rest:
            continue
        classes.add("REJECT")
        findings.append({
            "id": "", "class": "REJECT", "severity": "error",
            "code": "PLAN_WOULD_BREAK_LATER_LINK", "link": rest[0],
            "message": ("at chain position %d this candidate leaves %s "
                        "unable to apply"
                        % (p, ", ".join("#%d" % i for i in rest))),
            "next_command": ["show", str(rest[0])],
            "next_command_str": ctx.cmdfmt(["show", str(rest[0])])})
    for st in shadows:
        findings.append({
            "id": "", "class": "SHADOW", "blocking": True,
            "severity": "error", "code": "PLAN_WOULD_SHADOW",
            "link": st.index, "patch": st.link.patch_name,
            "message": "the candidate shadows #%d %s" % (st.index,
                                                         st.link.patch_name),
            "next_command": ["fold", cand_path, "--into", str(st.index)],
            "next_command_str": ctx.cmdfmt(["fold", cand_path, "--into",
                                            str(st.index)])})
    report.sort_findings(findings)
    o.say("")
    if findings:
        o.say("  NEXT: " + findings[0]["next_command_str"])
    else:
        o.say("  NEXT: nothing is in the way; wire it at one of the safe "
              "slots above")
    return ctx.finish("plan", classes, {
        "plan": {"candidate": cand_path, "target": target,
                 "after": after_idx, "position": pos,
                 "applies": applies, "slot_tree": slot_tree,
                 "shadows": [s.index for s in shadows],
                 "shadows_patches": [s.link.patch_name for s in shadows],
                 "would_break": [s.index for s in broken],
                 "forbidden": forbidden,
                 "applies_at_positions": applies_at,
                 "safe_positions": safe,
                 "breaks_at_positions": {str(k): v
                                         for k, v in sorted(breaks.items())},
                 "superseded_at_position": superseded_at,
                 "superseded_by_link": (carrier.index if carrier else None)}},
        findings)


class _FakeCulprit(object):
    """Enough of a LinkState for verdicts._attribute to describe a candidate
    that is not wired into the chain yet."""

    def __init__(self, path, patch, pre, post):
        self.patch = patch
        self.pre_tree = pre
        self.post_tree = post
        self.index = -1

        class _L(object):
            pass
        self.link = _L()
        self.link.patch_name = os.path.basename(path)
        self.link.patch_path = path
