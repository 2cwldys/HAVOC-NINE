"""h9chain -- a harness for correcting the xash.bat engine patch chain.

One entry point, subcommands, --json on everything, stable exit codes, and a
copy-pasteable next command on every non-healthy verdict. It applies patches;
it never compiles anything, and it never writes into a real repository except
through 'adopt', which ships disabled.
"""

import argparse
import json
import os
import sys
import time

if __name__ == "__main__" and (__package__ is None or __package__ == ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))
    __package__ = "h9chain"

from . import gitio, report, verdicts                       # noqa: E402
from .chainparse import TARGETS, parse_chain, parse_patch   # noqa: E402
from .errors import Environment, Internal, Usage            # noqa: E402
from .workarea import WorkArea                              # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
# chain.config.json and chain.rules.txt sit BESIDE the package when the tool is
# installed in a checkout (tools\h9chain\) and one level UP in a standalone
# drop. Take whichever directory actually holds the config, so the same source
# runs from either layout with no edit.
HOME = HERE if os.path.isfile(os.path.join(HERE, "chain.config.json")) \
    else os.path.dirname(HERE)

EXIT_OK, EXIT_USAGE, EXIT_ENV, EXIT_REFUSED, EXIT_INTERNAL = 0, 2, 3, 4, 5

# Keys an environment variable may NOT set. A rail that an environment
# variable can move is not a rail: H9CHAIN_PROTECTED_ROOTS pointed at a dummy
# directory used to unprotect the real trees outright, and
# H9CHAIN_ALLOW_PATCH_WRITES=1 opened the one write the tool ships disabled.
# protected_roots is additive only (see Config), and allow_patch_writes lives
# in the config file alone.
ENV_LOCKED = ("protected_roots", "allow_patch_writes")

DEFAULTS = {
    "repo_root": "D:\\GIT Storage\\ts_h9_team_elimination",
    "xash_bat": "",
    "patches_dir": "",
    "web_dir": "",
    "dev_root": "D:\\Downloads\\TSM\\xash3d-fwgs",
    "work": "D:\\temp\\chain-work\\h9chain",
    "lock": "",
    "protected_roots": ["D:\\GIT Storage\\ts_h9_team_elimination",
                        "D:\\Downloads\\TSM"],
    "allow_patch_writes": False,
    "fail_on": ["CHAIN", "REJECT", "SHADOW", "RESIDUAL", "THREEWAY",
                "BASELINE"],
    "anchor_exempt": ["engine.patch", "engine-mainui.patch",
                      "freevgui.patch", "engine-library_suffix.patch"],
    "offset_limit": 0,
    "timeout_sec": 120,
}


# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

class Rules(object):
    """chain.rules.txt -- hand written, never written by the tool."""

    def __init__(self, path=None):
        self.path = path
        self.allow = []       # (path, reason)
        self.temporary = []   # (patch name, marker text)
        self.folded = []      # (patch name, reason)
        if path and os.path.isfile(path):
            with open(path, "r", encoding="ascii", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split(None, 2)
                    if len(parts) < 2:
                        continue
                    kind = parts[0].lower()
                    if kind == "allow":
                        self.allow.append((parts[1],
                                           parts[2] if len(parts) > 2 else ""))
                    elif kind == "temporary":
                        self.temporary.append(
                            (parts[1], parts[2] if len(parts) > 2 else ""))
                    elif kind == "folded":
                        self.folded.append(
                            (parts[1], parts[2] if len(parts) > 2 else ""))

    def folded_names(self):
        return set(n for n, _ in self.folded)

    def allow_reason(self, path):
        for p, reason in self.allow:
            if p == path or path.endswith("/" + p):
                return reason or "allowed by chain.rules.txt"
        return None


class Config(object):
    def __init__(self, args):
        data = dict(DEFAULTS)
        cfgfile = args.config or os.path.join(HOME, "chain.config.json")
        self.config_file = cfgfile
        self.notes = []
        if os.path.isfile(cfgfile):
            with open(cfgfile, "r", encoding="ascii", errors="replace") as fh:
                data.update(json.load(fh))
        for key in list(DEFAULTS):
            envk = "H9CHAIN_" + key.upper()
            if envk not in os.environ or os.environ[envk] == "":
                continue
            v = os.environ[envk]
            if key in ENV_LOCKED:
                if key == "protected_roots":
                    # Additive: the environment can protect MORE, never less.
                    data[key] = list(data[key]) + [x for x in v.split(",")
                                                   if x]
                    self.notes.append(
                        "%s added protected root(s); the built-in ones cannot "
                        "be removed by any environment variable" % envk)
                else:
                    self.notes.append(
                        "%s is set and is IGNORED: only %s can enable the one "
                        "write this tool makes" % (envk, cfgfile))
                continue
            if isinstance(DEFAULTS[key], bool):
                v = v.lower() in ("1", "true", "yes", "on")
            elif isinstance(DEFAULTS[key], int):
                v = int(v)
            elif isinstance(DEFAULTS[key], list):
                v = [x for x in v.split(",") if x]
            data[key] = v
        # The built-in protected roots are a floor, whatever the config says.
        roots = list(data.get("protected_roots") or [])
        for p in DEFAULTS["protected_roots"]:
            if p not in roots:
                roots.append(p)
        data["protected_roots"] = roots
        for key, attr in (("repo_root", "repo_root"), ("work", "work"),
                          ("dev_root", "dev_root"), ("xash_bat", "xash_bat"),
                          ("patches_dir", "patches_dir"),
                          ("web_dir", "web_dir"), ("lock", "lock")):
            v = getattr(args, attr, None)
            if v:
                data[key] = v
        if getattr(args, "offset_limit", None) is not None:
            data["offset_limit"] = args.offset_limit
        if getattr(args, "timeout", None):
            data["timeout_sec"] = args.timeout

        self.repo_root = os.path.abspath(data["repo_root"])
        self.dev_root = os.path.abspath(data["dev_root"])
        self.work = os.path.abspath(data["work"])
        self.xash_bat = os.path.abspath(data["xash_bat"]) if data["xash_bat"] \
            else os.path.join(self.repo_root, "xash3d-h9-patches", "xash.bat")
        # The baseline is derived, per-machine state, and HOME can be inside a
        # checkout -- defaulting it there drops a 20 KB untracked file into
        # 'git status' and invites an accidental commit. It lives with the work
        # area instead; point --lock (or the config) at a tracked path to share
        # one, which is the decision that makes a moved tree visible to CI.
        self.lock = os.path.abspath(data["lock"]) if data["lock"] \
            else os.path.join(self.work, "CHAIN.lock")
        self.protected_roots = [os.path.abspath(p)
                                for p in data["protected_roots"]]
        self.allow_patch_writes = bool(data["allow_patch_writes"])
        self.anchor_exempt = list(data["anchor_exempt"])
        self.offset_limit = int(data["offset_limit"])
        self.timeout_sec = int(data["timeout_sec"])
        self.patches_dir = os.path.abspath(data["patches_dir"]) \
            if data.get("patches_dir") \
            else os.path.join(self.repo_root, "xash3d-h9-patches", "patches")
        self.retired_dir = os.path.join(self.patches_dir, "retired")
        self.web_dir = os.path.abspath(data["web_dir"]) \
            if data.get("web_dir") \
            else os.path.join(self.repo_root, "webassembly-patch")
        self.engine_root = os.path.join(self.repo_root, "xash3d-fwgs")
        self.rules = Rules(os.path.join(HOME, "chain.rules.txt"))
        self.entry = os.path.join(HOME, "chain.cmd")
        self.git_version = gitio.git_version()

        fail = list(data["fail_on"])
        if getattr(args, "strict", False):
            fail = list(verdicts.CLASS_ORDER)
        if getattr(args, "fail_on", None):
            fail = [x.strip().upper() for x in args.fail_on.split(",")
                    if x.strip()]
        self.fail_on = fail

    def pristine_worktree(self, target):
        if target == "engine":
            return self.engine_root
        return os.path.join(self.engine_root, "3rdparty", target)

    def dev_worktree(self, target):
        if target == "engine":
            return self.dev_root
        return os.path.join(self.dev_root, "3rdparty", target)

    def state_path(self):
        return os.path.join(self.work, "state.json")

    def last_path(self):
        return os.path.join(self.work, "last.json")


def preflight(cfg):
    v = gitio.version_tuple(cfg.git_version)
    if v < (2, 13, 0):
        raise Environment("git %s is too old; 2.13 or newer is required"
                          % cfg.git_version)
    for p in (cfg.repo_root, cfg.dev_root):
        if not os.path.isdir(p):
            raise Environment("path does not exist: %s" % p)
    if not os.path.isfile(cfg.xash_bat):
        raise Environment("xash.bat not found: %s" % cfg.xash_bat)
    for p in cfg.protected_roots:
        if gitio.is_under(cfg.work, p):
            raise gitio.Refusal(
                "the work root %s is inside protected root %s" % (cfg.work, p))
    try:
        os.makedirs(cfg.work, exist_ok=True)
    except OSError as exc:
        raise Environment("the work root %s is not usable: %s"
                          % (cfg.work, exc))
    if not os.path.isdir(cfg.work):
        raise Environment("the work root %s is not a directory" % cfg.work)
    unverified = []
    if "H9_SKIP_PATCH_VERIFY" in os.environ:
        unverified.append(
            "H9_SKIP_PATCH_VERIFY is set in the environment. xash.bat tests "
            "'if defined', so even H9_SKIP_PATCH_VERIFY=0 skips every patch. "
            "A run under that switch proves nothing.")
    return unverified


# ---------------------------------------------------------------------------
# selectors
# ---------------------------------------------------------------------------

def resolve_sel(chain, text):
    out = []
    for part in str(text).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part and all(x.strip().isdigit()
                               for x in part.split("-", 1)):
            a, b = part.split("-", 1)
            out += list(range(int(a), int(b) + 1))
            continue
        if part.isdigit():
            out.append(int(part))
            continue
        low = part.lower()
        exact = [lk.index for lk in chain.links
                 if lk.patch_name.lower() == low
                 or lk.patch_name.lower() == low + ".patch"]
        if len(exact) == 1:
            out.append(exact[0])
            continue
        if len(exact) > 1:
            raise Usage("'%s' matches links %s" % (part, exact))
        sub = [lk for lk in chain.links if low in lk.patch_name.lower()]
        if len(sub) == 1:
            out.append(sub[0].index)
            continue
        if not sub:
            raise Usage("no chain link matches '%s'" % part)
        raise Usage("'%s' is ambiguous: %s" % (
            part, ", ".join("#%d %s" % (lk.index, lk.patch_name)
                            for lk in sub)))
    valid = {lk.index for lk in chain.links}
    bad = [i for i in out if i not in valid]
    if bad:
        raise Usage("no such chain index: %s (the chain has %d links)"
                    % (bad, len(chain.links)))
    return sorted(set(out))


# ---------------------------------------------------------------------------
# context
# ---------------------------------------------------------------------------

class Ctx(object):
    def __init__(self, args):
        self.args = args
        self.started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.t0 = time.time()
        self.cfg = Config(args)
        self.out = report.Out(args.json, args.quiet, args.verbose)
        self.cmdfmt = report.make_cmdfmt(self.cfg.entry)
        self.unverified = preflight(self.cfg)
        for n in self.cfg.notes:
            self.out.note("NOTE: " + n)
        self.git = gitio.Git(self.cfg.work, self.cfg.protected_roots,
                             timeout=self.cfg.timeout_sec,
                             verbose=args.verbose, log=self.out.note)
        self.wa = WorkArea(self.cfg, self.git, log=self.out.note)
        # One run per work area. Two sharing one corrupt each other's indexes
        # and cache, and the survivor reports failures that are not there.
        if args.cmd not in ("explain", "schema"):
            note = self.wa.acquire_lock(getattr(args, "break_lock", False))
            if note:
                self.out.note("NOTE: " + note)
        self.chain = parse_chain(self.cfg.xash_bat, self.cfg.patches_dir,
                                 self.cfg.web_dir, self.cfg.retired_dir)
        # Only the targets this chain actually names have to be initialized.
        for t in sorted({lk.target for lk in self.chain.links}):
            wt = self.cfg.pristine_worktree(t)
            if not os.path.exists(os.path.join(wt, ".git")):
                raise Environment(
                    "xash.bat patches '%s' but it is not initialized at %s"
                    % (t, wt))

    def duration(self):
        return int((time.time() - self.t0) * 1000)

    def targets(self):
        if getattr(self.args, "target", None):
            bad = [t for t in self.args.target if t not in TARGETS]
            if bad:
                raise Usage("unknown target(s): %s; known: %s"
                            % (bad, ", ".join(TARGETS)))
            return list(self.args.target)
        return list(TARGETS)

    def finish(self, command, classes, extra, findings=None, ok_text=None):
        classes = set(classes)
        if self.unverified:
            classes.add("UNVERIFIED")
        sev, code = report.severity_and_exit(classes, self.cfg.fail_on)
        findings = findings or []
        env = report.envelope(
            self.cfg, command, self.args.argv, self.started,
            code == 0, code, sev, sorted(classes),
            duration_ms=self.duration(),
            unverified=list(self.unverified), **extra)
        env["findings"] = findings
        env["next_commands"] = [f["next_command_str"] for f in findings
                                if f.get("next_command_str")]
        if self.args.json:
            self.out.emit_json(env)
        return code


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_list(ctx):
    cache = ctx.wa.cache()
    rows = []
    ctx.out.say("%-4s %-6s %-14s %-32s %-13s %9s %5s %5s %s"
                % ("#", "line", "target", "patch", "sha256", "bytes",
                   "files", "hunks", "cache"))
    ctx.out.say("-" * 104)
    for lk in ctx.chain.links:
        pat = parse_patch(lk.patch_path)
        rows.append({
            "index": lk.index, "xash_bat_line": lk.line_no,
            "target": lk.target, "patch": lk.patch_path,
            "patch_name": lk.patch_name, "dir": lk.patch_dir_kind,
            "sha256": pat.sha256, "bytes": pat.bytes,
            "files": [f.path for f in pat.files],
            "hunks": sum(len(f.hunks) for f in pat.files),
            "style": pat.style, "exists": pat.exists,
        })
        name = lk.patch_name if len(lk.patch_name) <= 34 \
            else lk.patch_name[:31] + "..."
        ctx.out.say("%-4d %-6d %-14s %-32s %-13s %9d %5d %5d %s"
                    % (lk.index, lk.line_no, lk.target, name,
                       (pat.sha256 or "-")[:12], pat.bytes,
                       len(pat.files), sum(len(f.hunks) for f in pat.files),
                       "MISSING" if pat.missing else ""))
        if ctx.args.long:
            for f in pat.files:
                ctx.out.say("         %s%s" % (f.path,
                                               " [new]" if f.is_new else ""))
    ctx.out.say("")
    ctx.out.say("%d links; %d cached trees" % (len(rows), len(cache)))
    classes = set()
    if ctx.chain.orphans:
        classes.add("LINT")
        ctx.out.say("ORPHAN: %d patch file(s) on disk that xash.bat does not "
                    "reference:" % len(ctx.chain.orphans))
        for o in ctx.chain.orphans:
            ctx.out.say("  " + o)
    findings = []
    for code, msg in ctx.chain.problems:
        classes.add("CHAIN")
        ctx.out.say("%s: %s" % (code, msg))
        findings.append({
            "id": "", "class": "CHAIN", "severity": "error", "code": code,
            "link": None, "blocking": True, "message": msg,
            "next_command": ["list"],
            "next_command_str": ctx.cmdfmt(["list"])})
    for miss in ctx.chain.missing:
        classes.add("CHAIN")
        ctx.out.say("PATCH_MISSING: %s" % miss)
        findings.append({
            "id": "", "class": "CHAIN", "severity": "error",
            "code": "PATCH_MISSING", "link": None, "blocking": True,
            "message": "xash.bat calls %s and it is not on disk" % miss,
            "next_command": ["list"],
            "next_command_str": ctx.cmdfmt(["list"])})
    report.sort_findings(findings)
    return ctx.finish("list", classes, {
        "chain": {"links": len(rows),
                  "by_target": _by_target(ctx.chain),
                  "xash_bat_sha256": ctx.chain.xash_bat_sha256,
                  "orphans": ctx.chain.orphans,
                  "missing": ctx.chain.missing,
                  "problems": [{"code": c, "message": m}
                               for c, m in ctx.chain.problems]},
        "links": rows,
        "cache": {"entries": len(cache)},
    }, findings)


def _by_target(chain):
    d = {}
    for lk in chain.links:
        d[lk.target] = d.get(lk.target, 0) + 1
    return d


def _load(path):
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="ascii", errors="replace") as fh:
                return json.load(fh)
        except Exception:
            return None
    return None


def _save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # newline="" keeps it LF on Windows: these files are read by machines.
    with open(path, "w", encoding="ascii", errors="replace",
              newline="") as fh:
        json.dump(obj, fh, indent=1)
        fh.write("\n")


def touched_selection(ctx):
    state = _load(ctx.cfg.state_path())
    if not state or "links" not in state:
        return {lk.index for lk in ctx.chain.links}, "no previous run"
    prev = {int(k): v for k, v in state["links"].items()}
    moved = set()
    for lk in ctx.chain.links:
        pat = parse_patch(lk.patch_path)
        if prev.get(lk.index) != pat.sha256:
            moved.add(lk.index)
    if state.get("xash_bat_sha256") != ctx.chain.xash_bat_sha256:
        return {lk.index for lk in ctx.chain.links}, "xash.bat changed"
    if not moved:
        return set(), "nothing touched since the last run"
    sel = set(moved)
    for lk in ctx.chain.links:
        if lk.index in moved:
            for l2 in ctx.chain.links:
                if l2.target == lk.target and l2.index > lk.index:
                    sel.add(l2.index)
    return sel, "%d patch(es) moved" % len(moved)


def run_check(ctx, selection, want_residual, show=None, no_dev=None,
              no_shadow=None, no_anchor=False, worktree_check=True):
    forward_only = getattr(ctx.args, "forward_only", False)
    opts = {"no_dev": (ctx.args.no_dev or forward_only) if no_dev is None
            else no_dev,
            "no_shadow": (getattr(ctx.args, "no_shadow", False)
                          or forward_only)
            if no_shadow is None else no_shadow,
            "no_anchor": no_anchor,
            "worktree_check": worktree_check,
            "targets": ctx.targets(),
            "residual": want_residual and not forward_only,
            "rules": ctx.cfg.rules}
    if forward_only:
        ctx.unverified.append(
            "--forward-only: the dev pass, the shadow pass and the residual "
            "were all skipped, so only 'does it apply to its reconstructed "
            "pre-tree' was judged")
    res = verdicts.run(ctx.cfg, ctx.wa, ctx.chain, selection, opts,
                       ctx.out.note)
    ctx.unverified += res.unverified
    return res


def load_lock(ctx):
    """CHAIN.lock, but only when it describes THIS chain.

    The lock records the base commits it was written against. A lock for a
    different base (another checkout, a fixture, a pin bump) describes a
    different chain, so it is ignored rather than compared against.
    """
    lock = _load(ctx.cfg.lock)
    if not lock:
        return None
    try:
        bases = ctx.wa.bases()
    except Exception:
        return None
    want = lock.get("base") or {}
    for t, commit in want.items():
        if t in bases and bases[t] != commit:
            return None
    if not want:
        return None
    return lock


def _baseline(ctx, res):
    """Compare this run against CHAIN.lock.

    A moved FINAL TREE is never explained away. It means the chain now builds
    something else, and the one operation that is meant to move a patch's
    sha256 (regen --refresh) is content-identical by construction and so must
    NOT move a tree: suppressing a tree move because some sha moved made that
    invariant unobservable and let a behaviour-changing patch edit read
    'baseline.matches: true' under --no-dev. A sha256 move on its own is
    reported, is attributed to its link, and does not fail the run; lint rule
    L1 is what catches one made without a changelog entry.
    """
    lock = load_lock(ctx)
    out = {"present": bool(lock), "matches": None, "moved": [],
           "unexplained": [], "detail": []}
    if not lock:
        return out, set()
    moved = []
    unexplained = []
    detail = []
    locklinks = {int(k): v for k, v in (lock.get("links") or {}).items()}
    sha_moved = {}
    for idx in res.order:
        st = res.states[idx]
        was = locklinks.get(idx)
        if not was:
            key = "link.%d.new" % idx
            moved.append(key)
            unexplained.append(key)
            detail.append({"what": key, "link": idx,
                           "message": "link #%d (%s) is not in the baseline"
                                      % (idx, st.link.patch_name)})
            continue
        if was.get("sha256") != st.patch.sha256:
            key = "link.%d.patch_sha256" % idx
            moved.append(key)
            sha_moved.setdefault(st.target, []).append(idx)
            detail.append({"what": key, "link": idx,
                           "message": "#%d %s changed on disk (%s -> %s)"
                                      % (idx, st.link.patch_name,
                                         (was.get("sha256") or "-")[:12],
                                         (st.patch.sha256 or "-")[:12])})
    for idx in sorted(locklinks):
        if idx not in res.states:
            key = "link.%d.removed" % idx
            moved.append(key)
            unexplained.append(key)
            detail.append({"what": key, "link": idx,
                           "message": "link #%d (%s) is in the baseline and "
                                      "not in xash.bat any more"
                                      % (idx, locklinks[idx].get("patch"))})
    for t in res.targets:
        want = (lock.get("final_tree") or {}).get(t)
        got = res.final_tree.get(t)
        if not (want and got) or want == got:
            continue
        key = "final_tree." + t
        moved.append(key)
        unexplained.append(key)
        suspects = sha_moved.get(t) or []
        shifted = len(res.order) != len(locklinks)
        if shifted:
            why = ("; the chain has %d links and the baseline had %d, so "
                   "every index after the change shifted: compare the chains, "
                   "not the links" % (len(res.order), len(locklinks)))
        elif suspects:
            why = ("; the patch(es) that changed on this target: "
                   + ", ".join("#%d" % i for i in suspects))
        else:
            why = ("; no patch on this target changed, so look at xash.bat "
                   "or the pin")
        detail.append({
            "what": key, "target": t,
            "link": None if shifted else (suspects[0] if suspects else None),
            "message": ("the %s chain now builds a different tree (%s, "
                        "baseline %s)%s" % (t, got[:12], want[:12], why))})
    out["matches"] = not moved
    out["moved"] = moved
    out["unexplained"] = unexplained
    out["detail"] = detail
    return out, ({"BASELINE"} if unexplained else set())


def _chain_findings(ctx, res, cmdfmt):
    """Problems with the chain itself, not with one link's content.

    An unparseable 'call :patch' line used to be visible only in 'chain list'
    and never reached check, doctor or the JSON at all, while the real build
    dies on it. A referenced patch that is not on disk is the same class of
    problem.
    """
    out = []
    for code, msg in ctx.chain.problems:
        out.append({
            "id": "", "class": "CHAIN", "severity": "error", "code": code,
            "link": None, "blocking": True,
            "message": msg + ". xash.bat runs this line verbatim: all three "
                             "git calls fail and the build stops with "
                             "[ERROR].",
            "next_command": ["list"], "next_command_str": cmdfmt(["list"])})
    for t, w in sorted((res.worktree or {}).items()):
        if not w.get("would_block"):
            continue
        out.append({
            "id": "", "class": "WORKTREE", "severity": "error",
            "code": "WORKTREE_UNTRACKED_BLOCKS_NEW_FILE", "link": None,
            "target": t, "paths": w["would_block"],
            "message": ("the pristine %s working tree already holds %d of "
                        "the file(s) the chain's new-file patches create "
                        "(%d untracked in all): %s. A literal xash.bat run "
                        "stops there with 'already exists in working "
                        "directory'. This harness reads commit trees only, "
                        "so nothing above is affected; whether those files "
                        "are work in progress or leftovers is not something "
                        "this tool can decide, which is why WORKTREE reports "
                        "and does not fail."
                        % (t, len(w["would_block"]), w.get("untracked", 0),
                           ", ".join(w["would_block"][:8]))),
            "next_command": ["explain", "WORKTREE"],
            "next_command_str": cmdfmt(["explain", "WORKTREE"])})
    return out


def _baseline_findings(ctx, base, cmdfmt):
    out = []
    bywhat = {d["what"]: d for d in base.get("detail", [])}
    for m in base.get("unexplained", []):
        d = bywhat.get(m, {})
        link = d.get("link")
        nc = ["show", str(link)] if link else ["residual"]
        out.append({
            "id": "", "class": "BASELINE", "severity": "error",
            "code": "BASELINE_MOVED", "link": link, "what": m,
            "message": ("CHAIN.lock: %s. If this change is intended, record "
                        "it with '%s'." % (d.get("message", m + " moved"),
                                           cmdfmt(["bless"]))),
            "next_command": nc, "next_command_str": cmdfmt(nc)})
    return out


def _emit_result(ctx, command, res, show, want_residual):
    report.table(ctx.out, res, show)
    report.summary(ctx.out, res, ctx.cfg)
    base, bclasses = _baseline(ctx, res)
    if show is None:
        classes = set(res.classes) | bclasses
    else:
        classes = set(bclasses)
        for i in show:
            c = verdicts.CLASS_OF_VERDICT.get(res.states[i].verdict)
            if c:
                classes.add(c)
        if res.residual.get("ran") and res.residual.get("ok") is False:
            classes.add("RESIDUAL")
        if ctx.unverified:
            classes.add("UNVERIFIED")
        if "WORKTREE" in res.classes:
            classes.add("WORKTREE")
    if ctx.chain.orphans:
        classes.add("LINT")
    findings = report.build_findings(res, ctx.cfg, ctx.cmdfmt, show)
    chainf = _chain_findings(ctx, res, ctx.cmdfmt)
    for f in chainf:
        classes.add(f["class"])
    findings = chainf + findings + _baseline_findings(ctx, base, ctx.cmdfmt)
    report.sort_findings(findings)
    sev, code = report.severity_and_exit(
        classes | ({"UNVERIFIED"} if ctx.unverified else set()),
        ctx.cfg.fail_on)
    report.findings_block(ctx.out, findings, code, sev, res, ctx.cmdfmt)
    if ctx.unverified:
        ctx.out.say("")
        ctx.out.say("UNVERIFIED:")
        for u in ctx.unverified:
            ctx.out.say("  " + u)

    links = [res.states[i].as_dict(cmdfmt=ctx.cmdfmt) for i in res.order]
    extra = {
        "base": {t: {"commit": ctx.wa.bases().get(t)} for t in res.targets},
        "dev": {t: res.dev_info.get(t, {}) for t in res.targets},
        "cache": {"entries": len(ctx.wa.cache()),
                  "problems": list(ctx.wa.cache_problems)},
        "chain": {"links": len(ctx.chain.links),
                  "by_target": _by_target(ctx.chain),
                  "xash_bat_sha256": ctx.chain.xash_bat_sha256,
                  "orphans": ctx.chain.orphans,
                  "missing": ctx.chain.missing,
                  "problems": [{"code": c, "message": m}
                               for c, m in ctx.chain.problems],
                  "examined": res.examined, "skipped": res.skipped},
        "baseline": base,
        "links": links,
        "residual": res.residual,
        "final_tree": res.final_tree,
        "final_tree_from_cache": res.final_from_cache,
        "worktree": res.worktree,
        "timings_ms": dict(res.timings, **ctx.wa.timings),
    }
    if code == 0 and not res.skipped:
        # Only a run that examined every link may say "this is the last green
        # state": recording it off a one-link check would make --touched skip
        # a patch that moved before it.
        state = {"xash_bat_sha256": ctx.chain.xash_bat_sha256,
                 "links": {str(res.states[i].index): res.states[i].patch.sha256
                           for i in res.order}}
        _save(ctx.cfg.state_path(), state)
    rc = ctx.finish(command, classes, extra, findings)
    try:
        _save(ctx.cfg.last_path(), {"command": command, "exit_code": rc,
                                    "classes": sorted(classes),
                                    "findings": findings})
    except Exception:
        pass
    return rc


def cmd_check(ctx):
    full = {lk.index for lk in ctx.chain.links}
    if ctx.args.all:
        sel = set(full)
        show = None
    elif ctx.args.sel:
        sel = set(resolve_sel(ctx.chain, ctx.args.sel))
        show = set(sel)
    else:
        sel, why = touched_selection(ctx)
        ctx.out.note("check --touched: " + why)
        if not sel:
            sel = set()
        show = set(sel) if sel else set()
    # The residual is a whole-chain property: on a selective run the final
    # tree is partly read from the cache, so comparing it against the dev
    # mirror would present a cache-derived verdict as a measurement. It also
    # costs most of the time a single-link check takes.
    want_residual = (not ctx.args.no_dev) and sel == full
    if sel != full and not ctx.args.no_dev:
        ctx.unverified.append(
            "the residual was not computed: it compares the WHOLE replayed "
            "chain against the dev clone's working tree, and this run "
            "replayed only part of it. Use 'check --all' or 'residual'.")
    res = run_check(ctx, sel, want_residual=want_residual)
    return _emit_result(ctx, "check", res, show, want_residual)


def cmd_residual(ctx):
    """The residual, and nothing else.

    It used to run the anchor, dev and shadow passes, print an empty link
    table and then 'FINDINGS: none' on a chain whose 'check --all' reports 23
    findings. What it owes the reader is the per-target comparison and the
    UNOWNED list.
    """
    sel = {lk.index for lk in ctx.chain.links}
    res = run_check(ctx, sel, want_residual=True, no_shadow=True,
                    no_anchor=True)
    o = ctx.out
    o.say("residual: the replayed chain against the dev clone's working tree")
    o.say("  dev root %s" % ctx.cfg.dev_root)
    o.say("")
    o.say("  %-14s %-14s %-14s %-9s %s"
          % ("target", "replayed", "dev mirror", "gitlinks", "verdict"))
    o.say("  " + "-" * 72)
    classes = set()
    total_bad = 0
    for t in res.targets:
        r = res.residual["targets"].get(t)
        if not r:
            o.say("  %-14s %s" % (t, "not computed (the replay stopped at "
                                  "link %s)" % res.stopped_at.get(t)))
            continue
        bad = [p for p in r.get("paths", []) if p["kind"] != "ALLOWED"]
        total_bad += len(bad)
        o.say("  %-14s %-14s %-14s %-9d %s"
              % (t, (r["replayed"] or "-")[:12], (r["mirror"] or "-")[:12],
                 r.get("gitlinks_differ", 0),
                 "equal" if r["equal"] else "%d file(s) differ" % len(bad)))
    for t in res.targets:
        r = res.residual["targets"].get(t) or {}
        rows = r.get("paths") or []
        if not rows:
            continue
        o.say("")
        o.say("  %s" % t)
        for p in rows:
            o.say("    %-9s %-58s %s"
                  % (p["kind"], p["path"], p.get("reason", "")))
    o.say("")
    o.say("  UNOWNED means the dev clone carries content no link produces: a "
          "feature")
    o.say("  nobody turned into a patch. PHANTOM means the replay produces a "
          "file the")
    o.say("  dev clone does not have. CONTENT means both have it and the "
          "bytes differ.")
    o.say("  ALLOWED is an 'allow' line in chain.rules.txt, reason echoed "
          "above.")
    if res.residual.get("ok") is False:
        classes.add("RESIDUAL")
    findings = [f for f in report.build_findings(res, ctx.cfg, ctx.cmdfmt)
                if f["class"] == "RESIDUAL"]
    report.sort_findings(findings)
    sev, code = report.severity_and_exit(
        classes | ({"UNVERIFIED"} if ctx.unverified else set()),
        ctx.cfg.fail_on)
    report.findings_block(ctx.out, findings, code, sev, res, ctx.cmdfmt)
    return ctx.finish("residual", classes, {
        "residual": res.residual, "final_tree": res.final_tree,
        "final_tree_from_cache": res.final_from_cache,
        "dev": {t: res.dev_info.get(t, {}) for t in res.targets},
        "timings_ms": dict(res.timings, **ctx.wa.timings),
    }, findings)


def cmd_doctor(ctx):
    sel = {lk.index for lk in ctx.chain.links}
    res = run_check(ctx, sel, want_residual=not ctx.args.no_dev)
    from . import lint as lintmod
    lints = lintmod.run_all(ctx, res)
    classes = set(res.classes)
    if lints:
        classes.add("LINT")
    if ctx.chain.orphans:
        classes.add("LINT")
    report.table(ctx.out, res, None)
    report.summary(ctx.out, res, ctx.cfg)
    base, bclasses = _baseline(ctx, res)
    classes |= bclasses
    chainf = _chain_findings(ctx, res, ctx.cmdfmt)
    for f in chainf:
        classes.add(f["class"])
    findings = (chainf + report.build_findings(res, ctx.cfg, ctx.cmdfmt)
                + _baseline_findings(ctx, base, ctx.cmdfmt) + lints)
    report.sort_findings(findings)
    sev, code = report.severity_and_exit(
        classes | ({"UNVERIFIED"} if ctx.unverified else set()),
        ctx.cfg.fail_on)
    report.findings_block(ctx.out, findings, code, sev, res, ctx.cmdfmt)
    if ctx.unverified:
        ctx.out.say("")
        ctx.out.say("UNVERIFIED:")
        for u in ctx.unverified:
            ctx.out.say("  " + u)
    if findings:
        # One line per distinct command, in the order the findings raise it.
        # Two findings often name the same repair (a stale index line is both
        # a DRIFT and a LINT), and a plan that repeats it reads as two jobs.
        plan, seen_cmd = [], set()
        for f in findings:
            c = f.get("next_command_str")
            if c and c not in seen_cmd:
                seen_cmd.add(c)
                plan.append(c)
        if plan:
            ctx.out.say("")
            ctx.out.say("FIX PLAN (run these in order):")
            for c in plan:
                ctx.out.say("  " + c)
    links = [res.states[i].as_dict(cmdfmt=ctx.cmdfmt) for i in res.order]
    extra = {
        "base": {t: {"commit": ctx.wa.bases().get(t)} for t in res.targets},
        "dev": {t: res.dev_info.get(t, {}) for t in res.targets},
        "cache": {"entries": len(ctx.wa.cache())},
        "chain": {"links": len(ctx.chain.links),
                  "by_target": _by_target(ctx.chain),
                  "xash_bat_sha256": ctx.chain.xash_bat_sha256,
                  "orphans": ctx.chain.orphans},
        "baseline": base, "links": links, "residual": res.residual,
        "final_tree": res.final_tree,
        "final_tree_from_cache": res.final_from_cache,
        "worktree": res.worktree,
        "timings_ms": dict(res.timings, **ctx.wa.timings),
    }
    extra["chain"]["examined"] = res.examined
    extra["chain"]["skipped"] = res.skipped
    extra["chain"]["missing"] = ctx.chain.missing
    extra["chain"]["problems"] = [{"code": c, "message": m}
                                  for c, m in ctx.chain.problems]
    return ctx.finish("doctor", classes, extra, findings)


def cmd_show(ctx):
    from . import ownsplan
    sel = resolve_sel(ctx.chain, ctx.args.sel)
    if len(sel) != 1:
        raise Usage("show takes exactly one link, got %s" % sel)
    idx = sel[0]
    res = run_check(ctx, {idx}, want_residual=False)
    st = res.states[idx]
    d = st.as_dict(cmdfmt=ctx.cmdfmt)
    o = ctx.out
    o.say("#%d  %s" % (st.index, st.link.patch_name))
    o.say("  target        %s" % st.target)
    o.say("  xash.bat line %d" % st.link.line_no)
    o.say("  file          %s" % st.link.patch_path)
    o.say("  sha256        %s" % st.patch.sha256)
    o.say("  style         %s" % st.patch.style)
    o.say("  pre  tree     %s" % st.pre_tree)
    o.say("  post tree     %s" % st.post_tree)
    o.say("  forward       %s" % st.forward)
    o.say("  dev           %s" % st.dev)
    o.say("  verdict       %s" % st.verdict)
    o.say("")
    o.say("  files and hunks")
    for f in st.patch.files:
        o.say("    %s%s" % (f.path, "  [new file]" if f.is_new else ""))
        for h in f.hunks:
            o.say("      @@ -%d,%d +%d,%d @@%s"
                  % (h.old_start, h.old_count, h.new_start, h.new_count,
                     "" if h.arith_ok else "   [HUNK_ARITH]"))
    if st.offsets.get("detail"):
        o.say("")
        o.say("  hunk offsets")
        for h in st.offsets["detail"]:
            o.say("    %-46s hunk #%d at %d (offset %d)"
                  % (h.get("file") or "?", h["hunk"], h["at"], h["offset"]))
    o.say("")
    o.say("  anchors (%s)" % st.anchor.get("state"))
    for a in st.anchor.get("files", []):
        o.say("    %-50s %-7s recorded %s..%s  actual %s..%s"
              % (a["path"], a["state"], a["recorded_pre"], a["recorded_post"],
                 (a["actual_pre"] or "-")[:len(a["recorded_pre"] or "x")],
                 (a["actual_post"] or "-")[:len(a["recorded_post"] or "x")]))
    owners = ownsplan.owners_for(ctx, res, st)
    o.say("")
    o.say("  earlier links owning regions in these files")
    if not owners["earlier"]:
        o.say("    none")
    for rec in owners["earlier"]:
        o.say("    #%-3d %-36s %s %s" % (rec["link"], rec["patch"],
                                         rec["file"], rec["ranges"]))
    o.say("  later links inside this post-image")
    if not owners["later"]:
        o.say("    none")
    for rec in owners["later"]:
        o.say("    #%-3d %-36s %s %s" % (rec["link"], rec["patch"],
                                         rec["file"], rec["ranges"]))
    if st.blocks:
        o.say("")
        o.say("  DUPLICATE: link(s) %s cannot apply while this one is wired."
              % ", ".join("#%d" % i for i in st.blocks))
        o.say("  Measured: each of them applies cleanly once this patch is "
              "reversed out of its")
        o.say("  pre-tree, so they write the same change. Two options, both "
              "by hand after:")
        o.say("    " + ctx.cmdfmt(["fold", str(st.index), "--into",
                                   str(st.blocks[0]), "--mode", "pre"]))
        o.say("  or unwire this link, which no command here does:")
        o.say("    delete xash.bat line %d:" % st.link.line_no)
        o.say("      " + (st.link.raw or "").strip())
        o.say("    git mv \"%s\" \"%s\""
              % (st.link.patch_path,
                 os.path.join(ctx.cfg.retired_dir,
                              os.path.basename(st.link.patch_path))))
        o.say("  Wiring one change as two links is what broke the master "
              "build on 2026-11-17.")
    if st.superseded_by is not None:
        o.say("")
        o.say("  SUPERSEDED: link #%s already produces this content, so this "
              "patch has" % st.superseded_by)
        o.say("  no pre-image left anywhere in the chain. Regenerating it "
              "cannot work.")
        o.say("  Either fold the two into one patch:")
        o.say("    " + ctx.cmdfmt(["fold", str(st.index), "--into",
                                   str(st.superseded_by), "--mode", "pre"]))
        o.say("  or unwire this one, which no command here does. By hand, in "
              "the owner's tree:")
        o.say("    delete xash.bat line %d:" % st.link.line_no)
        o.say("      " + (st.link.raw or "").strip())
        o.say("    git mv \"%s\" \"%s\""
              % (st.link.patch_path,
                 os.path.join(ctx.cfg.retired_dir,
                              os.path.basename(st.link.patch_path))))
        o.say("  Wiring a superseded patch as its own link is what broke the "
              "master build")
        o.say("  on 2026-11-17: the result applies in neither direction.")
    if st.patch.missing:
        o.say("")
        o.say("  PATCH_MISSING: xash.bat line %d calls a file that is not on "
              "disk." % st.link.line_no)
        o.say("    %s" % st.link.patch_path)
        o.say("  The real build stops here. Either restore the file (it may "
              "be in")
        o.say("  patches\\retired\\ or in git history), or delete that "
              "xash.bat line:")
        o.say("      " + (st.link.raw or "").strip())
    o.say("")
    nxt = d["next_command_str"]
    if st.blocks:
        nxt = ctx.cmdfmt(["fold", str(st.index), "--into", str(st.blocks[0]),
                          "--mode", "pre"])
    elif st.superseded_by is not None:
        # 'show' is what the check prescribes for this verdict, so repeating
        # it here would be a loop: name the fold, with the unwiring spelled
        # out above as the other option.
        nxt = ctx.cmdfmt(["fold", str(st.index), "--into",
                          str(st.superseded_by), "--mode", "pre"])
    o.say("  NEXT: " + (nxt
                        or ("nothing; this link is OK" if st.verdict == "OK"
                            else "nothing prescribed for %s" % st.verdict)))
    classes = {verdicts.CLASS_OF_VERDICT.get(st.verdict)} - {None}
    return ctx.finish("show", classes, {"links": [d], "owners": owners,
                                        "next_command_str": nxt})


def cmd_tree(ctx):
    sel = resolve_sel(ctx.chain, ctx.args.sel)
    if len(sel) != 1:
        raise Usage("tree takes exactly one link")
    idx = sel[0]
    res = run_check(ctx, {idx}, want_residual=False)
    st = res.states[idx]
    tree = st.post_tree if ctx.args.post else st.pre_tree
    if not tree:
        raise Usage("link #%d has no %s tree (the replay stopped earlier)"
                    % (idx, "post" if ctx.args.post else "pre"))
    ctx.out.say(tree)
    src = st.post_tree_source if ctx.args.post else st.pre_tree_source
    if src == "cache":
        # Provenance, not doubt: the two cache witnesses agreed, but a tree
        # read back is not a tree this run computed, and whoever hands it on
        # should know which it has.
        ctx.out.note("note: this tree was read from the cache, not replayed "
                     "in this run; 'check --all' replays every link")
    dest = None
    if ctx.args.worktree:
        dest = os.path.abspath(ctx.args.worktree)
        ctx.wa.materialize_worktree(st.target, tree, dest, ctx.args.force)
        ctx.out.say("materialized %s at %s" % (tree[:12], dest))
        ctx.out.say("edit the files, then: " + ctx.cmdfmt(
            ["regen", str(idx), "--from", dest]))
    return ctx.finish("tree", set(), {
        "links": [{"index": idx, "target": st.target, "tree": tree,
                   "tree_source": src,
                   "post": bool(ctx.args.post), "worktree": dest}]})


def cmd_owns(ctx):
    from . import ownsplan
    return ownsplan.cmd_owns(ctx)


def cmd_plan(ctx):
    from . import ownsplan
    return ownsplan.cmd_plan(ctx)


def _blocked(ctx, name, exc):
    """A regen or fold that git would not build. Not an internal error: say
    what stopped it and what to try instead."""
    msg = str(exc)
    code = "REVERSE_BLOCKED" if "REVERSE_BLOCKED" in msg else "BLOCKED"
    ctx.out.say("%s: %s" % (code, msg))
    ctx.out.say("")
    ctx.out.say("  try naming the source of the post-image explicitly:")
    for c in (["regen", "<N>", "--post-dev", "<paths>"],
              ["regen", "<N>", "--with", "<patch>,..."],
              ["tree", "<N>", "--post", "--worktree", "<dir>"]):
        ctx.out.say("    " + ctx.cmdfmt(c))
    ctx.finish(name, set(), {name: {"ok": False, "code": code,
                                    "message": msg}})
    return EXIT_USAGE


def cmd_regen(ctx):
    from . import regen
    try:
        return regen.cmd_regen(ctx)
    except gitio.GitError as exc:
        return _blocked(ctx, "regen", exc)


def cmd_fold(ctx):
    from . import regen
    try:
        return regen.cmd_fold(ctx)
    except gitio.GitError as exc:
        return _blocked(ctx, "fold", exc)


def cmd_adopt(ctx):
    from . import regen
    return regen.cmd_adopt(ctx)


def cmd_lint(ctx):
    from . import lint as lintmod
    if ctx.args.only:
        want = [x.strip().upper() for x in ctx.args.only.split(",")
                if x.strip()]
        known = {r.upper() for r in lintmod.RULES}
        bad = [w for w in want if w not in known]
        if bad:
            # A mistyped rule name used to report 'no findings' and exit 0.
            raise Usage("no such lint rule(s): %s; known rules are %s"
                        % (", ".join(bad), ", ".join(lintmod.RULES)),
                        [["lint"]])
    res = run_check(ctx, set(), want_residual=False, no_dev=True,
                    no_shadow=True)
    lints = lintmod.run_all(ctx, res, only=ctx.args.only)
    if not lints:
        ctx.out.say("LINT: no findings")
    else:
        ctx.out.say("LINT (%d)" % len(lints))
        for f in lints:
            ctx.out.say("  [%s] %s" % (f["code"], f["message"]))
    classes = {"LINT"} if lints else set()
    return ctx.finish("lint", classes, {"findings": lints}, lints)


def cmd_bless(ctx):
    sel = {lk.index for lk in ctx.chain.links}
    res = run_check(ctx, sel, want_residual=not ctx.args.no_dev)
    classes = set(res.classes)
    sev, code = report.severity_and_exit(classes, ctx.cfg.fail_on)
    if code != 0 and not ctx.args.force:
        ctx.out.say("refusing to bless an unhealthy run (%s, exit %d); "
                    "pass --force to record it as accepted" % (sev, code))
        return ctx.finish("bless", classes, {"baseline": {"written": False}})
    lock = {
        "schema": report.SCHEMA,
        "written_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "git": ctx.cfg.git_version,
        "accepted_unhealthy": bool(code != 0),
        "accepted_classes": sorted(classes),
        "base": ctx.wa.bases(),
        "xash_bat_sha256": ctx.chain.xash_bat_sha256,
        "final_tree": res.final_tree,
        "dev_mirror": {t: res.dev_info.get(t, {}).get("mirror_tree")
                       for t in res.targets},
        "residual": {t: res.residual["targets"].get(t, {}).get("equal")
                     for t in res.targets},
        "links": {str(res.states[i].index): {
            "target": res.states[i].target,
            "patch": res.states[i].link.patch_name,
            "sha256": res.states[i].patch.sha256,
            "pre_tree": res.states[i].pre_tree,
            "post_tree": res.states[i].post_tree,
            "anchor": res.states[i].anchor.get("state"),
            "offset": res.states[i].offsets.get("max_abs", 0),
        } for i in res.order},
    }
    _save(ctx.cfg.lock, lock)
    ctx.out.say("baseline written to %s" % ctx.cfg.lock)
    ctx.out.say("  %d links, final trees: %s"
                % (len(res.order), ", ".join("%s=%s" % (t, (v or "-")[:12])
                                             for t, v in res.final_tree.items())))
    return ctx.finish("bless", set(), {"baseline": {"written": True,
                                                    "path": ctx.cfg.lock}})


def cmd_explain(ctx):
    key, val = report.explain(ctx.args.topic)
    if not val:
        raise Usage("nothing known about '%s'. Known keys: %s"
                    % (ctx.args.topic, ", ".join(report.explain_keys())),
                    [["schema"]])
    name, means, cmds = val
    ctx.out.say("%s  %s" % (key, name))
    ctx.out.say("  %s" % means)
    if cmds:
        ctx.out.say("  do:")
        for c in cmds:
            ctx.out.say("    " + ctx.cmdfmt(c))
    return ctx.finish("explain", set(), {
        "explain": {"key": key, "class": name, "means": means,
                    "do": [ctx.cmdfmt(c) for c in cmds]}})


def cmd_schema(ctx):
    doc = {
        "schema": report.SCHEMA,
        "envelope": {
            "schema": "string, bumped when a key changes meaning",
            "tool": {"name": "h9chain", "version": "string", "git": "string",
                     "python": "string"},
            "command": {"name": "string", "argv": ["string"],
                        "started_utc": "ISO 8601", "duration_ms": "int"},
            "ok": "bool", "exit_code": "int", "severity": "class or OK",
            "classes": ["class"], "unverified": ["string"],
            "paths": {"entry": "path", "repo_root": "path",
                      "xash_bat": "path", "patches_dir": "path",
                      "web_dir": "path", "dev_root": "path", "work": "path",
                      "lock": "path"},
            "base": {"<target>": {"commit": "40-hex"}},
            "dev": {"<target>": {"head": "40-hex", "modified": "int",
                                 "mirror_tree": "40-hex"}},
            "cache": {"entries": "int"},
            "chain": {"links": "int", "by_target": {"<target>": "int"},
                      "xash_bat_sha256": "hex", "orphans": ["path"]},
            "baseline": {"present": "bool", "matches": "bool|null",
                         "moved": ["string"]},
            "links": [{
                "index": "int", "xash_bat_line": "int", "target": "string",
                "patch": "path", "patch_name": "string", "sha256": "hex",
                "bytes": "int", "files": ["path"], "hunks": "int",
                "pre_tree": "40-hex|null", "post_tree": "40-hex|null",
                "cache_key": "hex", "cached": "bool",
                "forward": "plain|threeway|reject|skipped|null",
                "offsets": {"hunks_with_offset": "int", "max_abs": "int",
                            "detail": [{"hunk": "int", "at": "int",
                                        "offset": "int"}]},
                "anchor": {"state": "exact|stale|newfile|none",
                           "files": [{"path": "path", "state": "string"}]},
                "dev": "in_place|would_apply|not_detectable|null",
                "shadows": ["int"], "shadowed_by": "int|null",
                "verdict": "|".join(verdicts.SEVERITY),
                "next_command": ["string"], "next_command_str": "string"}],
            "residual": {"ran": "bool", "ok": "bool|null",
                         "targets": {"<target>": {
                             "replayed": "40-hex", "mirror": "40-hex",
                             "equal": "bool",
                             "paths": [{"path": "path",
                                        "kind": "UNOWNED|PHANTOM|CONTENT|ALLOWED"}]}}},
            "findings": [{"id": "Fnnn", "class": "class", "severity": "string",
                          "code": "string", "link": "int|null",
                          "message": "string", "next_command_str": "string"}],
            "next_commands": ["string"],
            "timings_ms": {"<phase>": "int"},
        },
        "exit_codes": {k: v[0] for k, v in sorted(report.EXPLAIN.items())
                       if k.isdigit()},
        "verdicts": verdicts.SEVERITY,
        "classes": verdicts.CLASS_ORDER,
    }
    if not ctx.args.json:
        ctx.out.say(json.dumps(doc, indent=2))
    return ctx.finish("schema", set(), {"schema_doc": doc})


def cmd_cache(ctx):
    sub = ctx.args.cachecmd
    if sub == "clear":
        before = ctx.wa.disk_usage()
        freed = ctx.wa.cache_clear(everything=ctx.args.all)
        ctx.out.say("cleared: cached trees, indexes, scratch blobs and "
                    "materialized arenas%s"
                    % (", candidates and shared clones" if ctx.args.all
                       else ""))
        ctx.out.say("  freed %.1f MB (arena held %.1f MB of it)"
                    % (freed / 1048576.0,
                       before.get("arena", 0) / 1048576.0))
        after = ctx.wa.disk_usage()
        ctx.out.say("  work area now %.1f MB" % (after["total"] / 1048576.0))
        if not ctx.args.all:
            ctx.out.say("  (candidates and the shared clones are kept; "
                        "'cache clear --all' takes those too)")
        return ctx.finish("cache", set(), {"cache": {
            "entries": 0, "freed_bytes": freed, "bytes": after["total"],
            "by_dir": after}})
    if sub == "prune":
        import datetime
        days = 30
        spec = (ctx.args.older_than or "30d").lower().rstrip("d")
        if spec.isdigit():
            days = int(spec)
        cut = (datetime.datetime.now(datetime.timezone.utc)
               .replace(tzinfo=None) - datetime.timedelta(days=days))
        keep = {}
        for k, rec in ctx.wa.cache().items():
            try:
                ts = datetime.datetime.strptime(rec["created_utc"],
                                                "%Y-%m-%dT%H:%M:%SZ")
            except Exception:
                ts = cut
            if ts >= cut:
                keep[k] = rec
        p = os.path.join(ctx.wa.cache_dir, "index.jsonl")
        os.makedirs(ctx.wa.cache_dir, exist_ok=True)
        with open(p, "w", encoding="ascii") as fh:
            for rec in keep.values():
                fh.write(json.dumps(rec) + "\n")
        ctx.out.say("kept %d of %d entries" % (len(keep),
                                               len(ctx.wa.cache())))
        return ctx.finish("cache", set(), {"cache": {"entries": len(keep)}})
    cache = ctx.wa.cache()
    per = {}
    for rec in cache.values():
        per[rec["target"]] = per.get(rec["target"], 0) + 1
    usage = ctx.wa.disk_usage()
    ctx.out.say("work area %s" % ctx.cfg.work)
    ctx.out.say("  cached trees %d  %s" % (len(cache), per))
    ctx.out.say("  on disk      %.1f MB" % (usage["total"] / 1048576.0))
    for k in ("repos", "cache", "idx", "arena", "candidates", "tmp", "other"):
        if usage.get(k):
            ctx.out.say("    %-12s %7.1f MB%s"
                        % (k, usage[k] / 1048576.0,
                           "   (a full checkout; 'cache clear' drops it)"
                           if k == "arena" else ""))
    for p in ctx.wa.cache_problems:
        ctx.out.say("  PROBLEM: " + p)
    return ctx.finish("cache", set(), {"cache": {"entries": len(cache),
                                                 "by_target": per,
                                                 "bytes": usage["total"],
                                                 "by_dir": usage,
                                                 "problems":
                                                 list(ctx.wa.cache_problems)}})


def cmd_selftest(ctx):
    from . import selftest
    return selftest.run(ctx)


# ---------------------------------------------------------------------------
# argv
# ---------------------------------------------------------------------------

GLOBAL_FLAGS = [
    (("--json",), {"action": "store_true"}),
    (("--quiet",), {"action": "store_true"}),
    (("-v", "--verbose"), {"action": "count", "default": 0}),
    (("--work",), {}),
    (("--config",), {}),
    (("--repo-root",), {"dest": "repo_root"}),
    (("--xash-bat",), {"dest": "xash_bat"}),
    (("--patches-dir",), {"dest": "patches_dir"}),
    (("--web-dir",), {"dest": "web_dir"}),
    (("--dev-root",), {"dest": "dev_root"}),
    (("--lock",), {}),
    (("--no-dev",), {"action": "store_true"}),
    (("--target",), {"action": "append"}),
    (("--no-cache",), {"action": "store_true"}),
    (("--refresh-cache",), {"action": "store_true"}),
    (("--fail-on",), {"dest": "fail_on"}),
    (("--strict",), {"action": "store_true"}),
    (("--offset-limit",), {"dest": "offset_limit", "type": int}),
    (("--timeout",), {"type": int}),
    (("--no-color",), {"action": "store_true"}),
    (("--break-lock",), {"dest": "break_lock", "action": "store_true"}),
    (("--version",), {"action": "store_true"}),
]


def _add_globals(parser, suppress):
    """The global flags work before or after the subcommand.

    The subparsers' copies default to SUPPRESS, so a flag given BEFORE the
    subcommand is not silently reset to its default when the subparser runs.
    """
    for names, kw in GLOBAL_FLAGS:
        kw = dict(kw)
        if suppress:
            kw["default"] = argparse.SUPPRESS
        parser.add_argument(*names, **kw)


def build_parser():
    gp = argparse.ArgumentParser(add_help=False)
    _add_globals(gp, False)
    gsub = argparse.ArgumentParser(add_help=False)
    _add_globals(gsub, True)

    p = argparse.ArgumentParser(prog="chain", parents=[gp],
                                description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd")
    gp = gsub

    s = sub.add_parser("list", parents=[gp])
    s.add_argument("--long", action="store_true")

    s = sub.add_parser("check", parents=[gp])
    s.add_argument("sel", nargs="?")
    s.add_argument("--all", action="store_true")
    s.add_argument("--touched", action="store_true")
    s.add_argument("--no-shadow", action="store_true")
    s.add_argument("--forward-only", dest="forward_only",
                   action="store_true")

    s = sub.add_parser("show", parents=[gp])
    s.add_argument("sel")

    s = sub.add_parser("tree", parents=[gp])
    s.add_argument("sel")
    s.add_argument("--post", action="store_true")
    s.add_argument("--print-id", action="store_true")
    s.add_argument("--worktree")
    s.add_argument("--files")
    s.add_argument("--force", action="store_true")

    s = sub.add_parser("owns", parents=[gp])
    s.add_argument("path")
    s.add_argument("--regions", action="store_true")
    s.add_argument("--line", type=int)

    s = sub.add_parser("plan", parents=[gp])
    s.add_argument("candidate")
    s.add_argument("--after")
    s.add_argument("--last", action="store_true")
    s.add_argument("--for-target", dest="for_target")

    sub.add_parser("residual", parents=[gp])

    s = sub.add_parser("regen", parents=[gp])
    s.add_argument("sel")
    s.add_argument("--refresh", action="store_true")
    s.add_argument("--with", dest="with_patches")
    s.add_argument("--post-dev", dest="post_dev")
    s.add_argument("--post-tree", dest="post_tree")
    s.add_argument("--from", dest="from_dir")
    s.add_argument("--style", choices=["auto", "git", "house"],
                   default="auto")
    s.add_argument("--context", type=int, default=3)
    s.add_argument("--out", dest="out_file")
    s.add_argument("--allow-foreign", action="store_true")
    s.add_argument("--no-proof", action="store_true")

    s = sub.add_parser("fold", parents=[gp])
    s.add_argument("source")
    s.add_argument("--into", required=True)
    s.add_argument("--mode", choices=["auto", "pre", "post"], default="auto")
    s.add_argument("--out", dest="out_file")
    s.add_argument("--context", type=int, default=3)
    s.add_argument("--no-proof", action="store_true")

    s = sub.add_parser("adopt", parents=[gp])
    s.add_argument("sel")
    s.add_argument("--from", dest="from_file")
    s.add_argument("--yes", action="store_true")

    s = sub.add_parser("bless", parents=[gp])
    s.add_argument("--force", action="store_true")

    s = sub.add_parser("lint", parents=[gp])
    s.add_argument("--only")

    sub.add_parser("doctor", parents=[gp])

    s = sub.add_parser("explain", parents=[gp])
    s.add_argument("topic")

    sub.add_parser("schema", parents=[gp])

    s = sub.add_parser("selftest", parents=[gp])
    s.add_argument("--deep", action="store_true")

    s = sub.add_parser("cache", parents=[gp])
    s.add_argument("cachecmd", nargs="?", default="status",
                   choices=["status", "prune", "clear"])
    s.add_argument("--older-than", dest="older_than")
    s.add_argument("--all", action="store_true")
    return p


DISPATCH = {
    "list": cmd_list, "check": cmd_check, "show": cmd_show,
    "tree": cmd_tree, "owns": cmd_owns, "plan": cmd_plan,
    "residual": cmd_residual, "regen": cmd_regen, "fold": cmd_fold,
    "adopt": cmd_adopt, "bless": cmd_bless, "lint": cmd_lint,
    "doctor": cmd_doctor, "explain": cmd_explain, "schema": cmd_schema,
    "selftest": cmd_selftest, "cache": cmd_cache,
}


def _fail(args, argv, severity, code, message, next_commands=None,
          ctx=None):
    """One exit path for every failure, and it always emits the object.

    Under --json the envelope goes to stdout even for a refusal: 'adopt'
    refused because writes are off is the ordinary end of the fix loop, and an
    agent reading stdout could not tell it from a crash when the error paths
    wrote nothing there. The English text still goes to stderr either way.
    """
    sys.stderr.write("%s: %s\n" % (severity, message))
    for c in (next_commands or []):
        sys.stderr.write("  next: %s\n" % c)
    if getattr(args, "json", False):
        entry = os.path.join(HOME, "chain.cmd")
        paths = None
        if ctx is not None:
            try:
                paths = {
                    "entry": ctx.cfg.entry, "repo_root": ctx.cfg.repo_root,
                    "xash_bat": ctx.cfg.xash_bat,
                    "patches_dir": ctx.cfg.patches_dir,
                    "web_dir": ctx.cfg.web_dir, "dev_root": ctx.cfg.dev_root,
                    "work": ctx.cfg.work, "lock": ctx.cfg.lock}
                entry = ctx.cfg.entry
            except Exception:
                paths = None
        env = report.error_envelope(
            argv, getattr(args, "cmd", None), code, severity, message,
            next_commands=[c if isinstance(c, list) else [c]
                           for c in (next_commands or [])],
            entry=entry, paths=paths)
        sys.stdout.write(json.dumps(env, indent=2) + "\n")
    return code


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code:
            fake = argparse.Namespace(json="--json" in argv, cmd=None)
            return _fail(fake, argv, "USAGE", EXIT_USAGE,
                         "argparse rejected these arguments; run with --help")
        return EXIT_OK
    args.argv = argv
    if args.version:
        sys.stdout.write("h9chain %s (git %s)\n"
                         % (report.VERSION, gitio.git_version_short()))
        return EXIT_OK
    if not args.cmd:
        if not args.json:
            parser.print_help()
        return _fail(args, argv, "USAGE", EXIT_USAGE,
                     "no subcommand; see --help", [["doctor", "--json"]])
    ctx = None
    try:
        ctx = Ctx(args)
    except gitio.Refusal as exc:
        return _fail(args, argv, "REFUSED", EXIT_REFUSED, exc)
    except Environment as exc:
        return _fail(args, argv, "ENVIRONMENT", EXIT_ENV, exc)
    except gitio.GitError as exc:
        return _fail(args, argv, "ENVIRONMENT", EXIT_ENV, exc)
    except Exception as exc:                        # noqa: BLE001
        return _fail(args, argv, "INTERNAL", EXIT_INTERNAL,
                     "%s: %s" % (type(exc).__name__, exc))
    try:
        if args.no_cache or args.refresh_cache:
            ctx.wa.cache_clear()
        return DISPATCH[args.cmd](ctx)
    except Usage as exc:
        return _fail(args, argv, "USAGE", EXIT_USAGE, exc,
                     [ctx.cmdfmt(c) for c in getattr(exc, "next_commands",
                                                     [])], ctx)
    except gitio.Refusal as exc:
        return _fail(args, argv, "REFUSED", EXIT_REFUSED, exc, None, ctx)
    except Environment as exc:
        return _fail(args, argv, "ENVIRONMENT", EXIT_ENV, exc, None, ctx)
    except gitio.GitError as exc:
        return _fail(args, argv, "INTERNAL", EXIT_INTERNAL,
                     "git failed: %s" % exc, None, ctx)
    except KeyboardInterrupt:
        return _fail(args, argv, "INTERNAL", EXIT_INTERNAL, "interrupted",
                     None, ctx)
    except Exception as exc:                        # noqa: BLE001
        # No command may exit 1 with an empty stdout. A traceback is a bug in
        # this tool, so it is exit 5 with the envelope and the type named.
        import traceback
        traceback.print_exc()
        return _fail(args, argv, "INTERNAL", EXIT_INTERNAL,
                     "%s: %s" % (type(exc).__name__, exc), None, ctx)
    finally:
        if ctx is not None:
            try:
                ctx.wa.release_lock()
            except Exception:
                pass


if __name__ == "__main__":
    # Hand over to the module under its package name so that there is exactly
    # ONE copy of it: 'from .h9chain import Usage' elsewhere must bind the
    # same class objects this main() catches.
    from h9chain import h9chain as _real
    sys.exit(_real.main())
