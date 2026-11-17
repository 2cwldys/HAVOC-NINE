"""The five passes and the verdict taxonomy.

forward  -- does each link apply to its reconstructed pre-tree
anchor   -- do the recorded 'index <pre>..<post>' blobs match reality
dev      -- what xash.bat would do against the dev clone's working tree
shadow   -- which link stops an earlier link reverse-checking, and why
residual -- does the replayed chain equal the dev clone's working tree
"""

import re
import time

from . import gitio
from .chainparse import TARGETS, parse_patch

OFFSET_RE = re.compile(
    r'Hunk #(\d+) succeeded at (\d+) \(offset (-?\d+) lines?\)')
CHECKING_RE = re.compile(r'^Checking patch (.+?)\.\.\.\s*$')

SEVERITY = [
    "PATCH_MISSING", "REJECT", "SHADOWS", "SHADOWED", "NOT_DETECTABLE",
    "THREEWAY", "HUNK_ARITH", "PATCH_UNSUPPORTED", "NOT_IN_DEV", "DRIFT",
    "SKIPPED", "OK",
]

# SKIPPED is not a health verdict and not a problem: it means this run did not
# examine the link. It exists because 'verdict' is the field an agent filters
# on, and a link that was never applied, never anchor-checked and never
# reverse-checked used to read "OK" there.
CLASS_OF_VERDICT = {
    "PATCH_MISSING": "CHAIN",
    "REJECT": "REJECT",
    "SHADOWS": "SHADOW",
    "SHADOWED": "SHADOW",
    "NOT_DETECTABLE": "SHADOW",
    "THREEWAY": "THREEWAY",
    "HUNK_ARITH": "DRIFT",
    "PATCH_UNSUPPORTED": "CHAIN",
    "NOT_IN_DEV": "NOT_IN_DEV",
    "DRIFT": "DRIFT",
    "SKIPPED": None,
    "OK": None,
}

EXIT_OF_CLASS = {
    "CHAIN": 19,
    "REJECT": 10, "SHADOW": 11, "RESIDUAL": 12, "THREEWAY": 13,
    "BASELINE": 14, "NOT_IN_DEV": 15, "DRIFT": 16, "LINT": 17,
    "UNVERIFIED": 18, "WORKTREE": 20,
}

# CHAIN comes first: if xash.bat cannot be parsed, or a patch it calls is not
# on disk, nothing further about the chain can be trusted.
CLASS_ORDER = ["CHAIN", "REJECT", "SHADOW", "RESIDUAL", "THREEWAY",
               "BASELINE", "NOT_IN_DEV", "WORKTREE", "DRIFT", "LINT",
               "UNVERIFIED"]


class LinkState(object):
    def __init__(self, link, patch):
        self.link = link
        self.patch = patch
        self.pre_tree = None
        self.post_tree = None
        self.cache_key = None
        self.cached = False
        self.forward = None          # plain | threeway | reject | skipped
        self.offsets = {"hunks_with_offset": 0, "max_abs": 0, "detail": []}
        self.anchor = {"state": "none", "files": []}
        self.dev = None              # in_place | would_apply | not_detectable
        self.shadows = []
        self.shadowed_by = None
        self.shadow_detail = None
        self.reject_detail = None
        self.superseded_by = None     # another link already produces this
        self.supersedes = []          # links whose content this one produces
        self.blocked_by = None        # it applies once that link is unwired
        self.blocks = []              # links that cannot apply while this is
        self.examined = False
        self.pre_tree_source = None   # replay | cache | base
        self.post_tree_source = None
        # SKIPPED until something actually looks at the link. decide() is the
        # only place that turns this into a health verdict.
        self.verdict = "SKIPPED"
        self.notes = []

    @property
    def index(self):
        return self.link.index

    @property
    def target(self):
        return self.link.target

    def as_dict(self, entry=None, cmdfmt=None):
        d = {
            "index": self.link.index,
            "xash_bat_line": self.link.line_no,
            "target": self.link.target,
            "patch": self.link.patch_path,
            "patch_name": self.link.patch_name,
            "sha256": self.patch.sha256,
            "bytes": self.patch.bytes,
            "files": [f.path for f in self.patch.files],
            "hunks": sum(len(f.hunks) for f in self.patch.files),
            "pre_tree": self.pre_tree,
            "post_tree": self.post_tree,
            "pre_tree_source": self.pre_tree_source,
            "post_tree_source": self.post_tree_source,
            "cache_key": self.cache_key,
            "cached": self.cached,
            "examined": bool(self.examined),
            "forward": self.forward,
            "offsets": self.offsets,
            "anchor": self.anchor,
            "dev": self.dev,
            "shadows": self.shadows,
            "shadowed_by": self.shadowed_by,
            "superseded_by": self.superseded_by,
            "supersedes": self.supersedes,
            "blocked_by": self.blocked_by,
            "blocks": self.blocks,
            "verdict": self.verdict,
            "notes": self.notes,
        }
        nc = next_command(self)
        d["next_command"] = nc
        d["next_command_str"] = cmdfmt(nc) if (nc and cmdfmt) else ""
        if self.reject_detail:
            d["reject_detail"] = self.reject_detail
        if self.shadow_detail:
            d["shadow_detail"] = self.shadow_detail
        return d


def next_command(st):
    v = st.verdict
    n = str(st.index)
    if v == "REJECT":
        if st.blocked_by is not None:
            # Proved, not guessed: this patch applies once that one is out of
            # the chain, so the two are one change wired twice. Folding the
            # blocker into this link is the repair that worked on 2026-11-17.
            return ["fold", str(st.blocked_by), "--into", n, "--mode", "pre"]
        if st.supersedes:
            return ["show", str(st.supersedes[0])]
        if st.superseded_by is not None:
            # Its content is already produced elsewhere in the chain, so
            # there is nothing to regenerate: the two become one patch.
            return ["fold", str(st.superseded_by), "--into", n, "--mode",
                    "pre"]
        return ["regen", n]
    if v == "SHADOWS":
        victim = st.shadows[0] if st.shadows else None
        if victim is not None:
            return ["fold", n, "--into", str(victim)]
        return ["show", n]
    if v == "SHADOWED":
        if st.shadowed_by is not None:
            return ["fold", str(st.shadowed_by), "--into", n]
        return ["show", n]
    if v == "NOT_DETECTABLE":
        # The verdict that cost a day. If another link already carries this
        # content, the fix is to unwire this one, and no command does that:
        # 'show' prints the xash.bat line to delete and the git mv to retired.
        if st.superseded_by is not None or st.blocks:
            return ["show", n]
        return ["regen", n, "--post-dev", ",".join(st.patch.paths())] \
            if st.patch.paths() else ["show", n]
    if v in ("THREEWAY", "HUNK_ARITH", "DRIFT"):
        return ["regen", n, "--refresh"]
    if v in ("PATCH_UNSUPPORTED", "PATCH_MISSING"):
        return ["show", n]
    if v == "NOT_IN_DEV":
        return ["regen", n, "--post-dev", ",".join(st.patch.paths())] \
            if st.patch.paths() else ["show", n]
    return None


class Result(object):
    def __init__(self):
        self.states = {}         # index -> LinkState
        self.order = []          # indices in chain order
        self.targets = []
        self.final_tree = {}
        self.dev_info = {}
        self.residual = {"ran": False, "ok": None, "targets": {}}
        self.classes = set()
        self.findings = []
        self.unverified = []
        self.timings = {}
        self.stopped_at = {}
        self.final_from_cache = {}
        self.worktree = {}
        self.examined = 0
        self.skipped = 0
        self.cache_hits = 0
        self.cache_misses = 0

    def selected(self, sel):
        return [self.states[i] for i in self.order if i in sel]


# ---------------------------------------------------------------------------
# forward + anchor
# ---------------------------------------------------------------------------

def _parse_offsets(stderr):
    """Hunk offsets out of 'git apply -v' stderr, each tagged with its file.

    git restarts hunk numbering at every file section, so 'hunk 1' three
    times in one patch is three different files. The file comes from the
    'Checking patch <path>...' line that precedes each section.
    """
    detail = []
    worst = 0
    cur = None
    for line in stderr.splitlines():
        mc = CHECKING_RE.match(line.strip())
        if mc:
            cur = mc.group(1).strip()
            continue
        m = OFFSET_RE.search(line)
        if not m:
            continue
        d = int(m.group(3))
        detail.append({"hunk": int(m.group(1)), "file": cur,
                       "at": int(m.group(2)), "offset": d})
        if abs(d) > abs(worst):
            worst = d
    return detail, worst


def _ls_tree_blobs(wa, target, tree, paths):
    """One ls-tree call for all of a patch's paths."""
    if not paths or not tree:
        return {}
    args = ["ls-tree", tree, "--"] + list(paths)
    rc, out, _ = wa.git.rw(wa.repo(target), *args)
    if rc != 0:
        return {}
    res = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        head, path = line.split("\t", 1)
        parts = head.split()
        if len(parts) >= 3:
            res[path.strip()] = (parts[0], parts[2])
    return res


def _anchor_for(wa, st, exempt):
    pat = st.patch
    sections = [f for f in pat.files if f.index_pre or f.index_post]
    if not sections or st.link.patch_name in exempt:
        st.anchor = {"state": "none", "files": []}
        return
    paths = [f.path for f in sections]
    pre_blobs = _ls_tree_blobs(wa, st.target, st.pre_tree, paths)
    post_blobs = _ls_tree_blobs(wa, st.target, st.post_tree, paths)
    files = []
    worst = "exact"
    rank = {"exact": 0, "newfile": 1, "none": 2, "stale": 3}
    for f in sections:
        got_pre = pre_blobs.get(f.path, (None, None))[1]
        got_post = post_blobs.get(f.path, (None, None))[1]
        if f.is_new or (f.index_pre and set(f.index_pre) == {"0"}):
            state = "newfile" if got_pre is None else "exact"
            if got_post and f.index_post and \
                    not got_post.startswith(f.index_post):
                state = "stale"
        else:
            ok_pre = bool(got_pre and f.index_pre
                          and got_pre.startswith(f.index_pre))
            ok_post = bool(got_post and f.index_post
                           and got_post.startswith(f.index_post))
            state = "exact" if (ok_pre and ok_post) else "stale"
        rec = {"path": f.path, "state": state,
               "recorded_pre": f.index_pre, "recorded_post": f.index_post,
               "actual_pre": got_pre, "actual_post": got_post}
        if state == "stale":
            rec["recorded_present_in_odb"] = _in_odb(wa, st.target,
                                                     f.index_pre)
        files.append(rec)
        if rank[state] > rank[worst]:
            worst = state
    st.anchor = {"state": worst, "files": files}


def _in_odb(wa, target, abbrev):
    if not abbrev or set(abbrev) == {"0"}:
        return False
    rc, out, _ = wa.git.rw(wa.repo(target), "cat-file", "-t", abbrev)
    return rc == 0 and out.strip() == "blob"


def replay_target(wa, target, states, need_check, log):
    """Index-only replay of one target's sub-chain.

    Returns (final_tree, stopped_at_or_None).
    """
    wa.ensure_repo(target)
    shas, keys = [], []
    for st in states:
        shas.append(st.patch.sha256 or ("missing:" + st.link.patch_name))
        keys.append(wa.cache_key(target, list(shas)))
    for i, st in enumerate(states):
        st.cache_key = keys[i]

    positions_needed = [i for i, st in enumerate(states)
                        if st.index in need_check]
    first_need = positions_needed[0] if positions_needed else len(states)
    last_need = positions_needed[-1] if positions_needed else -1
    cached = wa.cache_lookup_bulk(target, keys)

    start, pre = 0, None
    for p in range(min(first_need, len(states)), 0, -1):
        if p - 1 in cached:
            start, pre = p, cached[p - 1]
            break
    if pre is None:
        pre = wa.base_tree(target)

    base_tree = None
    from_cache = False
    for i in range(start):
        st = states[i]
        st.forward = "skipped"
        st.cached = True
        st.notes.append("not replayed: cached prefix")
        # Fill the trees from the cache anyway: 'owns', 'show' and 'plan'
        # need them, and they cost nothing once the keys have resolved.
        if i in cached:
            st.post_tree = cached[i]
            st.post_tree_source = "cache"
            from_cache = True
        if i == 0:
            if base_tree is None:
                base_tree = wa.base_tree(target)
            st.pre_tree = base_tree
            st.pre_tree_source = "base"
        elif i - 1 in cached:
            st.pre_tree = cached[i - 1]
            st.pre_tree_source = "cache"

    wa.read_tree(target, pre)
    stopped = None
    index_at = pre
    for p in range(start, len(states)):
        st = states[p]
        st.pre_tree = pre
        if st.pre_tree_source is None:
            st.pre_tree_source = ("base" if p == 0 and start == 0
                                  else ("cache" if p == start and start
                                        else "replay"))
        if p > last_need and p in cached:
            # Nothing after the last link under examination needs applying:
            # its post-tree is already in the cache, and the key says the
            # patches that produce it have not moved.
            st.post_tree = cached[p]
            st.post_tree_source = "cache"
            from_cache = True
            st.cached = True
            st.forward = "skipped"
            st.notes.append("not replayed: cached post-tree")
            pre = cached[p]
            continue
        if pre != index_at:
            wa.read_tree(target, pre)
            index_at = pre
        if st.patch.missing or st.patch.unsupported:
            st.forward = "missing" if st.patch.missing else "unsupported"
            st.examined = True
            st.post_tree = pre
            st.post_tree_source = "replay"
            stopped = st.index
            break
        if st.index in need_check:
            st.examined = True
            rc, _out, err = wa.apply_cached(target, st.link.patch_path,
                                            check=True, verbose=True)
            if rc == 0:
                st.forward = "plain"
                detail, worst = _parse_offsets(err)
                st.offsets = {"hunks_with_offset": len(detail),
                              "max_abs": abs(worst), "detail": detail}
            else:
                st.forward = None
                st.reject_detail = err.strip()[:4000]
        rc, _o, err = wa.apply_cached(target, st.link.patch_path)
        if rc == 0:
            if st.forward is None:
                st.forward = "plain"
        else:
            # Plain failed. xash.bat falls through to --3way, so probe it the
            # same way, in a disposable arena: --cached and --3way cannot be
            # used together.
            ok3 = _threeway_probe(wa, target, pre, st)
            if ok3 is None:
                st.forward = "reject"
                if not st.reject_detail:
                    st.reject_detail = err.strip()[:4000]
                st.post_tree = pre
                stopped = st.index
                break
            st.forward = "threeway"
            wa.read_tree(target, ok3)
        post = wa.write_tree(target)
        st.post_tree = post
        st.post_tree_source = "replay"
        pre = post
        index_at = post
        if not st.cached:
            try:
                wa.cache_put(keys[p], target, st.index, st.link.patch_name,
                             post)
            except Exception:
                pass
    wa.cache_derived[target] = from_cache
    return pre, stopped


def _threeway_probe(wa, target, pre_tree, st):
    """Return the resulting tree if --3way rescues the link, else None."""
    try:
        d = wa.arena(target, pre_tree)
    except Exception:
        return None
    rc, _o, _e = wa.git.rw(d, "apply", "--3way", str(st.link.patch_path))
    if rc != 0:
        return None
    wa.git.rw(d, "add", "-A")
    rc, out, _e = wa.git.rw(d, "write-tree")
    if rc != 0:
        return None
    return out.strip()


# ---------------------------------------------------------------------------
# dev pass
# ---------------------------------------------------------------------------

def supersede_pass(wa, target, states, final_tree):
    """For a link that does not apply, find the link that already carries it.

    A patch whose content some other link produces cannot be regenerated: it
    has no pre-image left anywhere in the chain. That is the shape that broke
    the master build on 2026-11-17 and the one case where the prescribed
    command has to be a fold (or an unwiring), not a regen. The test is a
    reverse check against every post-tree this run has, earliest first; the
    first tree the patch reverses out of is the one that produced it.
    """
    bad = [st for st in states
           if st.forward in ("reject",) or st.dev == "not_detectable"]
    if not bad:
        return
    # Only trees a link actually produced count. A link that rejected has its
    # post_tree set to its pre_tree so the rest of the run has something to
    # work with, and reverse-checking against that would "prove" that the
    # link before it carries the content, which is circular.
    trees = [(st.index, st.post_tree) for st in states
             if st.post_tree and st.forward in ("plain", "threeway",
                                                "skipped")]
    if final_tree:
        trees.append((None, final_tree))
    for st in bad:
        for idx, tree in trees:
            if idx == st.index:
                continue
            wa.read_tree(target, tree, slot="supersede")
            rc, _o, _e = wa.apply_cached(target, st.link.patch_path,
                                         slot="supersede", reverse=True,
                                         check=True)
            if rc == 0:
                st.superseded_by = idx
                st.notes.append(
                    "its content is already produced by %s, so there is no "
                    "pre-image left to regenerate against"
                    % ("link #%d" % idx if idx is not None
                       else "the end of the chain"))
                for other in states:
                    if other.index == idx:
                        other.supersedes.append(st.index)
                break


def conflict_pass(wa, target, states):
    """For a link that rejects, find the earlier link whose removal unblocks it.

    Two links that write the same change is the commonest way a chain breaks
    by hand: the second one then has no pre-image and goes REJECT, while the
    first reads green. The test is exact and cheap. Take the victim's
    pre-tree, reverse ONE earlier link that touches the same files out of it,
    and ask the victim to apply again. If it does, those two are one change
    wired twice, and the fix is a fold, not a regen.
    """
    victims = [st for st in states
               if st.forward in ("reject", "threeway") and st.pre_tree]
    if not victims:
        return
    pos = {st.index: i for i, st in enumerate(states)}
    for v in victims:
        files = set(v.patch.paths())
        earlier = [st for st in states
                   if pos[st.index] < pos[v.index] and st.pre_tree
                   and (set(st.patch.paths()) & files)]
        for p in reversed(earlier[-4:]):       # nearest first, bounded
            wa.read_tree(target, v.pre_tree, slot="conflict")
            rc, _o, _e = wa.apply_cached(target, p.link.patch_path,
                                         slot="conflict", reverse=True,
                                         check=True)
            if rc != 0:
                continue
            wa.apply_cached(target, p.link.patch_path, slot="conflict",
                            reverse=True)
            rc, _o, _e = wa.apply_cached(target, v.link.patch_path,
                                         slot="conflict", check=True)
            if rc != 0:
                continue
            v.blocked_by = p.index
            p.blocks.append(v.index)
            v.notes.append(
                "it applies cleanly once #%d (%s) is taken out of the chain: "
                "the two write the same change" % (p.index,
                                                   p.link.patch_name))
            p.notes.append(
                "#%d cannot apply while this link is wired: the two write "
                "the same change" % v.index)
            break


def dev_pass(wa, target, states, log, scope=None):
    info = wa.dev_mirror(target)
    wa.read_tree(target, info["mirror_tree"], slot="devsim")
    for st in states:
        if scope is not None and st.index not in scope:
            continue
        rc, _o, _e = wa.apply_cached(target, st.link.patch_path,
                                     slot="devsim", reverse=True, check=True)
        if rc == 0:
            st.dev = "in_place"
            continue
        rc, _o, _e = wa.apply_cached(target, st.link.patch_path,
                                     slot="devsim", check=True)
        if rc == 0:
            st.dev = "would_apply"
            wa.apply_cached(target, st.link.patch_path, slot="devsim")
            continue
        st.dev = "not_detectable"
    return info


# ---------------------------------------------------------------------------
# shadow pass
# ---------------------------------------------------------------------------

def shadow_pass(wa, target, states, final_tree, log, selection=None):
    """Which links no longer reverse-check against the final tree.

    On a selective run only the links that share a file with a selected one
    can be its victim or its culprit, so the reverse checks are restricted to
    those: a link cannot shadow a file it does not touch.
    """
    if not final_tree:
        return
    scope = None
    if selection is not None:
        files = set()
        for st in states:
            if st.index in selection:
                files |= set(st.patch.paths())
        scope = {st.index for st in states
                 if st.index in selection or (set(st.patch.paths()) & files)}
    wa.read_tree(target, final_tree, slot="shadow")
    victims = []
    for st in states:
        if scope is not None and st.index not in scope:
            continue
        if st.forward in (None, "reject", "unsupported", "missing",
                          "skipped"):
            continue
        rc, _o, _e = wa.apply_cached(target, st.link.patch_path,
                                     slot="shadow", reverse=True, check=True)
        if rc != 0:
            victims.append(st)
    for st in victims:
        culprit = _bisect_culprit(wa, target, states, st)
        if culprit is None:
            st.notes.append("reverse-check fails on the final tree; the "
                            "culprit could not be isolated")
            continue
        st.shadowed_by = culprit.index
        culprit.shadows.append(st.index)
        st.shadow_detail = _attribute(wa, target, st, culprit)


def _bisect_culprit(wa, target, states, victim):
    pos = {st.index: i for i, st in enumerate(states)}
    v = pos[victim.index]
    later = [st for st in states[v + 1:] if st.post_tree]
    if not later:
        return None

    def reverses_at(st):
        wa.read_tree(target, st.post_tree, slot="bisect")
        rc, _o, _e = wa.apply_cached(target, victim.link.patch_path,
                                     slot="bisect", reverse=True, check=True)
        return rc == 0

    lo, hi = 0, len(later) - 1
    if reverses_at(later[hi]):
        return None
    while lo < hi:
        mid = (lo + hi) // 2
        if reverses_at(later[mid]):
            lo = mid + 1
        else:
            hi = mid
    return later[lo]


def _attribute(wa, target, victim, culprit):
    shared = sorted(set(victim.patch.paths()) & set(culprit.patch.paths()))
    if not shared:
        shared = sorted(set(culprit.patch.paths()))
    args = ["diff-tree", "-p", "-U0", "--no-renames",
            culprit.pre_tree, culprit.post_tree, "--"] + shared
    rc, out, _e = wa.git.rw(wa.repo(target), *args)
    ranges = {}
    if rc == 0:
        cur = None
        for line in out.splitlines():
            if line.startswith("+++ b/"):
                cur = line[6:].strip()
            elif line.startswith("@@") and cur:
                m = re.match(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@',
                             line)
                if m:
                    s = int(m.group(3))
                    c = int(m.group(4)) if m.group(4) is not None else 1
                    ranges.setdefault(cur, []).append([s, s + max(c, 1) - 1])
    return {"culprit": culprit.index, "culprit_patch": culprit.link.patch_name,
            "victim": victim.index, "victim_patch": victim.link.patch_name,
            "files": shared, "ranges": ranges}


# ---------------------------------------------------------------------------
# residual
# ---------------------------------------------------------------------------

def residual_pass(wa, target, states, final_tree, rules, log):
    info = wa.dev_mirror(target)
    mirror = info["mirror_tree"]
    out = {"replayed": final_tree, "mirror": mirror,
           "replayed_from_cache": bool(wa.cache_derived.get(target)),
           "equal": final_tree == mirror, "gitlinks_differ": 0, "paths": []}
    if final_tree == mirror or not final_tree:
        return out
    rc, diff, _e = wa.git.rw(wa.repo(target), "diff-tree", "-r",
                             "--no-renames", final_tree, mirror)
    if rc != 0:
        out["error"] = "diff-tree failed"
        return out
    owned = set()
    for st in states:
        owned |= set(st.patch.paths())
    for line in diff.splitlines():
        if not line.startswith(":"):
            continue
        head, path = line.split("\t", 1)
        parts = head[1:].split()
        if len(parts) < 5:
            continue
        mode_a, mode_b, _sha_a, _sha_b, status = parts[:5]
        if mode_a == "160000" or mode_b == "160000":
            out["gitlinks_differ"] += 1
            continue            # gitlinks are never patched
        path = path.strip()
        allowed = rules.allow_reason(path)
        if status == "A":
            kind = "UNOWNED"    # present in the mirror, produced by no link
        elif status == "D":
            kind = "PHANTOM"
        else:
            kind = "CONTENT" if path in owned else "UNOWNED"
        rec = {"path": path, "kind": kind, "status": status}
        if allowed:
            rec["kind"] = "ALLOWED"
            rec["reason"] = allowed
        out["paths"].append(rec)
    out["equal"] = not [p for p in out["paths"] if p["kind"] != "ALLOWED"]
    return out


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------

def decide(st, offset_limit):
    if st.patch.missing:
        st.verdict = "PATCH_MISSING"
        return
    if st.patch.unsupported:
        st.verdict = "PATCH_UNSUPPORTED"
        return
    if st.forward == "reject":
        st.verdict = "REJECT"
        return
    if st.shadows:
        st.verdict = "SHADOWS"
        return
    if st.shadowed_by is not None:
        st.verdict = "SHADOWED"
        return
    if st.dev == "not_detectable":
        st.verdict = "NOT_DETECTABLE"
        return
    if st.forward == "threeway":
        st.verdict = "THREEWAY"
        return
    if st.patch.arith_errors:
        st.verdict = "HUNK_ARITH"
        return
    if st.dev == "would_apply":
        st.verdict = "NOT_IN_DEV"
        return
    drift = (st.anchor.get("state") == "stale"
             or st.offsets.get("max_abs", 0) > offset_limit)
    st.verdict = "DRIFT" if drift else "OK"


def run(cfg, wa, chain, selection, opts, log):
    """Run the passes over the chain. selection is a set of link indices."""
    res = Result()
    t_all = time.time()
    states = []
    for lk in chain.links:
        st = LinkState(lk, parse_patch(lk.patch_path))
        states.append(st)
        res.states[lk.index] = st
        res.order.append(lk.index)

    targets = opts.get("targets") or TARGETS
    by_target = {}
    for st in states:
        by_target.setdefault(st.target, []).append(st)
    res.targets = [t for t in TARGETS if t in by_target and t in targets]
    skipped_targets = [t for t in sorted(by_target) if t not in res.targets]
    for t in skipped_targets:
        res.unverified.append(
            "target '%s' (%d link(s)) was not judged: --target did not name it"
            % (t, len(by_target[t])))

    t0 = time.time()
    for t in res.targets:
        final, stopped = replay_target(wa, t, by_target[t], selection, log)
        res.final_tree[t] = final
        res.final_from_cache[t] = bool(wa.cache_derived.get(t))
        if stopped is not None:
            res.stopped_at[t] = stopped
    res.timings["replay"] = int((time.time() - t0) * 1000)
    for problem in wa.cache_problems:
        res.unverified.append("cache: " + problem)
    for t in res.targets:
        if res.final_from_cache.get(t) and t not in res.stopped_at:
            res.unverified.append(
                "the final %s tree is partly read from the cache rather than "
                "replayed, because this run examined only some links; "
                "'check --all' replays every link from the pinned base" % t)

    t0 = time.time()
    if not opts.get("no_anchor"):
        for t in res.targets:
            for st in by_target[t]:
                if st.index in selection and st.pre_tree and st.post_tree:
                    _anchor_for(wa, st, set(cfg.anchor_exempt))
    res.timings["anchor"] = int((time.time() - t0) * 1000)

    if not opts.get("no_dev"):
        t0 = time.time()
        partial = len(selection) < len(chain.links)
        for t in res.targets:
            try:
                res.dev_info[t] = dev_pass(wa, t, by_target[t], log,
                                           selection if partial else None)
            except Exception as exc:
                res.unverified.append("dev pass for %s: %s" % (t, exc))
        if partial and selection:
            res.unverified.append(
                "the dev pass judged only the selected links; run "
                "'check --all' for the whole xash.bat simulation")
        res.timings["dev"] = int((time.time() - t0) * 1000)
    elif selection:
        # With an empty selection no link was going to be judged on any axis,
        # so saying the reverse axis was not judged is noise ('owns', 'plan'
        # and 'lint' want the trees, not the verdicts).
        res.unverified.append("--no-dev: the reverse axis was not judged")

    if not opts.get("no_shadow"):
        t0 = time.time()
        for t in res.targets:
            if t in res.stopped_at:
                res.unverified.append(
                    "shadow pass for %s: the replay stopped at link %d"
                    % (t, res.stopped_at[t]))
                continue
            scope = None if len(selection) >= len(chain.links) else selection
            shadow_pass(wa, t, by_target[t], res.final_tree.get(t), log,
                        scope)
        res.timings["shadow"] = int((time.time() - t0) * 1000)

    t0 = time.time()
    for t in res.targets:
        try:
            supersede_pass(wa, t, by_target[t], res.final_tree.get(t))
            conflict_pass(wa, t, by_target[t])
        except Exception as exc:
            res.unverified.append("supersede pass for %s: %s" % (t, exc))
    res.timings["supersede"] = int((time.time() - t0) * 1000)

    if opts.get("residual") and not opts.get("no_dev"):
        t0 = time.time()
        res.residual["ran"] = True
        allok = True
        for t in res.targets:
            if t in res.stopped_at:
                res.unverified.append(
                    "residual for %s: the replay stopped at link %d"
                    % (t, res.stopped_at[t]))
                allok = False
                continue
            r = residual_pass(wa, t, by_target[t], res.final_tree.get(t),
                              opts["rules"], log)
            res.residual["targets"][t] = r
            allok = allok and r["equal"]
        res.residual["ok"] = allok
        res.timings["residual"] = int((time.time() - t0) * 1000)

    # Only a link this run actually examined gets a health verdict. Every
    # other one keeps SKIPPED, because 'verdict' is the field an agent filters
    # on and "not looked at" is not "OK".
    for st in states:
        if st.examined or (st.index in selection
                           and st.forward not in (None, "skipped")):
            decide(st, cfg.offset_limit)

    for t in res.targets:
        if t in res.stopped_at:
            for st in by_target[t]:
                if st.verdict == "SKIPPED" and st.forward is None \
                        and st.post_tree is None:
                    st.notes.append(
                        "not replayed: link %d stopped this target"
                        % res.stopped_at[t])
                    res.unverified.append(
                        "link %d (%s) was not verified: link %d stopped the "
                        "%s replay" % (st.index, st.link.patch_name,
                                       res.stopped_at[t], t))

    # What the harness structurally does not look at: the pristine target's
    # own working tree. It cannot change a verdict here (everything comes
    # from commit trees) but a literal xash.bat run applies into it, and a
    # new-file patch stops with 'already exists in working directory'.
    if opts.get("worktree_check", True):
        t0 = time.time()
        for t in res.targets:
            orphans = wa.pristine_untracked(t)
            if orphans is None:
                continue
            created = set()
            for st in by_target[t]:
                for f in st.patch.files:
                    if f.is_new and f.path:
                        created.add(f.path)
            clash = sorted(set(orphans) & created)
            res.worktree[t] = {"untracked": len(orphans),
                               "would_block": clash}
            if clash:
                res.classes.add("WORKTREE")
        res.timings["worktree"] = int((time.time() - t0) * 1000)

    for st in states:
        c = CLASS_OF_VERDICT.get(st.verdict)
        if c:
            res.classes.add(c)
        if st.blocks:
            # A link that is green on every axis and stops another one from
            # applying belongs to the shadow family, whatever its own
            # verdict: that inversion is the case the tool exists to expose.
            res.classes.add("SHADOW")
    if res.residual["ran"] and res.residual["ok"] is False:
        res.classes.add("RESIDUAL")
    if res.unverified:
        res.classes.add("UNVERIFIED")
    res.examined = sum(1 for st in states if st.verdict != "SKIPPED")
    res.skipped = len(states) - res.examined
    res.timings["total"] = int((time.time() - t_all) * 1000)
    return res
