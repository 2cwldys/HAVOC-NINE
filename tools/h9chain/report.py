"""Output: the human table, the JSON envelope, explain text and the schema.

--json prints exactly one object on stdout and nothing else; every line of
progress goes to stderr; the exit code is identical with and without it.
"""

import json
import os
import sys
import time

from . import gitio
from .verdicts import CLASS_OF_VERDICT, CLASS_ORDER, EXIT_OF_CLASS

SCHEMA = "h9chain/1"
VERSION = "1.0.0"


def quote(s):
    s = str(s)
    if not s or any(c in s for c in ' \t"&|<>^()'):
        return '"' + s.replace('"', '\\"') + '"'
    return s


def make_cmdfmt(entry):
    def fmt(parts):
        if not parts:
            return ""
        return " ".join([quote(entry)] + [quote(p) for p in parts])
    return fmt


class Out(object):
    """Human text to stdout, progress to stderr; under --json, both go to
    stderr and the one object goes to stdout at the end."""

    def __init__(self, as_json=False, quiet=False, verbose=0):
        self.as_json = as_json
        self.quiet = quiet
        self.verbose = verbose
        self.lines = []

    def say(self, text=""):
        if self.as_json:
            return
        if self.quiet:
            return
        sys.stdout.write(text + "\n")

    def note(self, text):
        if self.quiet and self.verbose < 1:
            return
        sys.stderr.write(text + "\n")
        sys.stderr.flush()

    def emit_json(self, obj):
        sys.stdout.write(json.dumps(obj, indent=2, sort_keys=False) + "\n")


def error_envelope(argv, command, exit_code, severity, message,
                   next_commands=None, entry=None, paths=None):
    """The one object a refused or failed command prints on stdout.

    Every command emits exactly one machine-readable object, and that has to
    include the refusals: 'adopt' refused because writes are off is the normal
    end of the loop, and an agent parsing stdout could not tell it from a
    crash when the error paths printed nothing there at all.
    """
    return {
        "schema": SCHEMA,
        "tool": {"name": "h9chain", "version": VERSION,
                 "git": gitio.git_version_short(),
                 "python": "%d.%d.%d" % sys.version_info[:3]},
        "command": {"name": command or (argv[0] if argv else ""),
                    "argv": list(argv or []),
                    "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                 time.gmtime()),
                    "duration_ms": 0},
        "ok": False, "exit_code": int(exit_code), "severity": severity,
        "classes": [severity], "unverified": ["nothing was judged: " + severity],
        "paths": paths or {"entry": entry or ""},
        "base": {}, "dev": {}, "cache": {}, "chain": {}, "baseline": {},
        "links": [], "residual": {"ran": False, "ok": None, "targets": {}},
        "findings": [{
            "id": "F001", "class": severity, "severity": "error",
            "code": severity, "link": None, "message": str(message),
            "next_command": (next_commands or [[]])[0],
            "next_command_str": (make_cmdfmt(entry or "chain")(
                (next_commands or [[]])[0]) if next_commands else ""),
        }],
        "next_commands": [make_cmdfmt(entry or "chain")(c)
                          for c in (next_commands or [])],
        "timings_ms": {},
    }


def envelope(cfg, command, argv, started, ok, exit_code, severity, classes,
             **extra):
    env = {
        "schema": SCHEMA,
        "tool": {"name": "h9chain", "version": VERSION,
                 "git": gitio.git_version_short(cfg.git_version),
                 "python": "%d.%d.%d" % sys.version_info[:3]},
        "command": {"name": command, "argv": list(argv),
                    "started_utc": started,
                    "duration_ms": extra.pop("duration_ms", 0)},
        "ok": bool(ok),
        "exit_code": int(exit_code),
        "severity": severity,
        "classes": list(classes),
        "unverified": extra.pop("unverified", []),
        "paths": {
            "entry": cfg.entry, "repo_root": cfg.repo_root,
            "xash_bat": cfg.xash_bat, "patches_dir": cfg.patches_dir,
            "web_dir": cfg.web_dir, "dev_root": cfg.dev_root,
            "work": cfg.work, "lock": cfg.lock,
        },
        "base": {}, "dev": {}, "cache": {}, "chain": {}, "baseline": {},
        "links": [], "residual": {"ran": False, "ok": None, "targets": {}},
        "findings": [], "next_commands": [], "timings_ms": {},
    }
    env.update(extra)
    return env


def severity_and_exit(classes, fail_on):
    triggered = [c for c in CLASS_ORDER if c in classes]
    if not triggered:
        return "OK", 0
    failing = [c for c in triggered if c in fail_on]
    if not failing:
        return triggered[0], 0
    return failing[0], EXIT_OF_CLASS[failing[0]]


# ---------------------------------------------------------------------------
# findings
# ---------------------------------------------------------------------------

FINDING_TEXT = {
    "PATCH_MISSING": ("xash.bat calls this patch but the file is not on "
                      "disk; all three git calls fail and the real build "
                      "stops here with [ERROR]"),
    "REJECT": ("the patch does not apply to its reconstructed pre-tree at "
               "all; a fresh clone cannot be built"),
    "SHADOWS": ("after this link an earlier link stops reverse-checking; "
                "xash.bat will stop at that earlier link on the next build"),
    "SHADOWED": ("this link stops reverse-checking on the final tree"),
    "NOT_DETECTABLE": ("on the dev tree this neither reverse-checks nor "
                       "forward-applies; only H9_SKIP_PATCH_VERIFY gets past "
                       "it"),
    "THREEWAY": ("plain apply fails and --3way rescues it; the baseline is 0 "
                 "of 64, so this is drift, not success"),
    "HUNK_ARITH": "an @@ header disagrees with its own hunk body",
    "PATCH_UNSUPPORTED": ("rename, delete, mode change or delta binary; this "
                          "tool refuses to guess"),
    "NOT_IN_DEV": ("reverse fails but forward applies on the dev mirror; the "
                   "dev clone does not hold this content"),
    "DRIFT": ("it applies, but an anchor is stale or a hunk offset exceeds "
              "the limit: the build works and the metadata lies"),
}


def build_findings(res, cfg, cmdfmt, scope=None):
    out = []
    n = 0
    stoppers = set(res.stopped_at.values())
    for idx in res.order:
        st = res.states[idx]
        if st.verdict in ("OK", "SKIPPED") and not st.blocks:
            continue
        if scope is not None and idx not in scope:
            continue
        n += 1
        if st.verdict in ("OK", "SKIPPED"):
            # The victim/culprit inversion: this link is green on every axis
            # and is the reason another one cannot apply. Nothing else in the
            # report would mention it.
            out.append({
                "id": "F%03d" % n, "class": "SHADOW", "severity": "error",
                "code": "DUPLICATE_BLOCKS_LATER_LINK", "link": st.index,
                "patch": st.link.patch_name, "blocking": True,
                "order_hint": 0, "blocks": list(st.blocks),
                "message": ("#%d %s applies cleanly and link(s) %s cannot "
                            "apply while it is wired: measured by reversing "
                            "this patch out of their pre-tree, after which "
                            "they apply. The two write the same change. "
                            "Either fold them into one patch, or delete "
                            "xash.bat line %d and retire this file."
                            % (st.index, st.link.patch_name,
                               ", ".join("#%d" % i for i in st.blocks),
                               st.link.line_no)),
                "next_command": ["show", str(st.index)],
                "next_command_str": cmdfmt(["show", str(st.index)])})
            continue
        f = {
            "id": "F%03d" % n,
            "class": CLASS_OF_VERDICT.get(st.verdict) or st.verdict,
            "severity": "error" if st.verdict in (
                "PATCH_MISSING", "PATCH_UNSUPPORTED", "REJECT", "SHADOWS",
                "SHADOWED", "NOT_DETECTABLE", "THREEWAY") else "warning",
            "code": st.verdict,
            "link": st.index,
            "patch": st.link.patch_name,
            "blocking": st.index in stoppers,
            "message": "#%d %s: %s" % (st.index, st.link.patch_name,
                                       FINDING_TEXT.get(st.verdict, "")),
        }
        if st.verdict == "DRIFT":
            # Two different causes, so two codes and two sentences: an agent
            # can tell a lying index line from a hunk that merely moved, and
            # 'regen --refresh' is the fix for either.
            stale = [a["path"] for a in st.anchor.get("files", [])
                     if a["state"] == "stale"]
            off = st.offsets.get("max_abs", 0)
            bits = []
            if stale:
                bits.append("the recorded 'index <pre>..<post>' does not "
                            "match the tree the chain produces for "
                            + ", ".join(stale))
            if off > cfg.offset_limit:
                bits.append("a hunk lands %d line(s) from where its @@ "
                            "header says (limit %d)" % (off,
                                                        cfg.offset_limit))
            f["code"] = ("DRIFT_ANCHOR_STALE" if stale
                         else "DRIFT_HUNK_OFFSET")
            f["message"] = ("#%d %s: it applies, and the metadata lies: %s. "
                            "The build works; regen --refresh is "
                            "content-identical by construction."
                            % (st.index, st.link.patch_name,
                               "; ".join(bits)))
        if st.verdict == "PATCH_MISSING":
            f["message"] += (". Either restore %s, or delete xash.bat line "
                             "%d" % (st.link.patch_path, st.link.line_no))
        if st.superseded_by is not None:
            f["superseded_by"] = st.superseded_by
            # The duplicate is the CAUSE, so it is reported before the link
            # it breaks: regenerating the victim first cannot work.
            f["order_hint"] = 0
            f["blocking"] = True
            f["message"] += (
                "; its content is already produced by link #%s, so there is "
                "no pre-image to regenerate against. Either fold the two, or "
                "delete xash.bat line %d and retire the file."
                % (st.superseded_by, st.link.line_no))
        if st.supersedes:
            f["caused_by"] = st.supersedes[0]
            f["message"] += (
                "; link #%s duplicates content this patch produces, which is "
                "why there is no pre-image left here. Deal with #%s first: "
                "regenerating this one cannot work while both are wired."
                % (st.supersedes[0], st.supersedes[0]))
        if st.blocked_by is not None:
            f["caused_by"] = st.blocked_by
            f["message"] += (
                "; measured: it applies cleanly once #%s is out of the chain, "
                "so those two write the same change. Fold them, or unwire "
                "#%s. Regenerating this link while both are wired produces a "
                "patch for a state that will not exist."
                % (st.blocked_by, st.blocked_by))
        if st.blocks:
            f["blocks"] = st.blocks
            f["order_hint"] = 0
            f["blocking"] = True
            f["message"] += (
                "; and link(s) %s cannot apply while this one is wired: they "
                "write the same change. Either fold them into one patch, or "
                "delete xash.bat line %d and retire this file."
                % (", ".join("#%d" % i for i in st.blocks), st.link.line_no))
        if st.index in stoppers:
            f["message"] += (" THIS LINK STOPPED THE %s REPLAY: every later "
                             "link on that target is unexamined."
                             % st.target.upper())
        if st.shadow_detail:
            f["victim_link"] = st.shadow_detail["victim"]
            files = st.shadow_detail["ranges"]
            if files:
                first = sorted(files)[0]
                f["file"] = first
                f["lines"] = files[first]
        nc = st.as_dict(cmdfmt=cmdfmt)["next_command"]
        f["next_command"] = nc
        f["next_command_str"] = cmdfmt(nc) if nc else ""
        out.append(f)

    for t, r in sorted(res.residual.get("targets", {}).items()):
        bad = [p for p in r.get("paths", []) if p["kind"] != "ALLOWED"]
        if not bad:
            continue
        n += 1
        out.append({
            "id": "F%03d" % n, "class": "RESIDUAL", "severity": "error",
            "code": "RESIDUAL_" + bad[0]["kind"], "link": None,
            "target": t,
            "paths": [p["path"] for p in bad],
            "message": ("%s: the replayed chain and the dev clone's working "
                        "tree differ in %d file(s): %s"
                        % (t, len(bad),
                           ", ".join(p["path"] + " [" + p["kind"] + "]"
                                     for p in bad[:8]))),
            "next_command": ["residual", "--json"],
            "next_command_str": cmdfmt(["residual", "--json"]),
        })

    sort_findings(out)
    return out


def sort_findings(out):
    """Rank by what blocks a build, not by link number.

    A link that stopped a replay comes first whatever its class, then the
    classes in CLASS_ORDER, then severity, then the link index. The order
    matters because the documented agent loop is 'run findings[0]', and with
    23 pre-existing DRIFT findings on today's chain a blocker that sorted on
    its link number landed fourth.
    """
    sev = {"error": 0, "warning": 1, "info": 2}
    order = {c: i for i, c in enumerate(CLASS_ORDER)}
    out.sort(key=lambda f: (f.get("order_hint", 1),
                            0 if f.get("blocking") else 1,
                            order.get(f.get("class"), 99),
                            sev.get(f.get("severity"), 3),
                            f.get("link") or 0))
    for i, f in enumerate(out, 1):
        f["id"] = "F%03d" % i
    return out


# ---------------------------------------------------------------------------
# human table
# ---------------------------------------------------------------------------

VCOL = {"OK": "OK", "DRIFT": "DRIFT", "REJECT": "REJECT",
        "SHADOWS": "SHADOWS", "SHADOWED": "SHADOWED",
        "NOT_DETECTABLE": "NOT-DET", "THREEWAY": "3WAY",
        "HUNK_ARITH": "ARITH", "PATCH_UNSUPPORTED": "UNSUPP",
        "PATCH_MISSING": "MISSING", "SKIPPED": "skipped",
        "NOT_IN_DEV": "NOT-DEV"}


def table(out, res, show):
    out.say("%-4s %-14s %-34s %-6s %5s %-7s %-10s %s"
            % ("#", "target", "patch", "fwd", "off", "anchor", "dev",
               "verdict"))
    out.say("-" * 100)
    for idx in res.order:
        st = res.states[idx]
        if show is not None and idx not in show:
            continue
        name = st.link.patch_name
        if len(name) > 34:
            name = name[:31] + "..."
        out.say("%-4d %-14s %-34s %-6s %5s %-7s %-10s %s"
                % (idx, st.target, name, (st.forward or "-")[:6],
                   st.offsets.get("max_abs", 0),
                   (st.anchor.get("state") or "-")[:7],
                   (st.dev or "-")[:10], VCOL.get(st.verdict, st.verdict)))


def summary(out, res, cfg):
    fwd = {}
    dev = {}
    for idx in res.order:
        st = res.states[idx]
        fwd[st.forward or "none"] = fwd.get(st.forward or "none", 0) + 1
        dev[st.dev or "none"] = dev.get(st.dev or "none", 0) + 1
    out.say("")
    out.say("examined: %d of %d link(s); %d skipped (verdict SKIPPED, not OK)"
            % (res.examined, len(res.order), res.skipped))
    out.say("forward : " + ", ".join("%s=%d" % kv for kv in sorted(fwd.items())))
    out.say("dev     : " + ", ".join("%s=%d" % kv for kv in sorted(dev.items())))
    shadowed = sum(1 for i in res.order if res.states[i].shadowed_by
                   is not None)
    out.say("shadow  : %d shadowed" % shadowed)
    out.say("final   : " + ", ".join(
        "%s=%s%s" % (t, (res.final_tree.get(t) or "-")[:12],
                     " (part cache)" if res.final_from_cache.get(t) else "")
        for t in res.targets))
    for t in res.targets:
        w = res.worktree.get(t) or {}
        if w.get("would_block"):
            out.say("worktree: %s has %d untracked file(s) in the PRISTINE "
                    "working tree, %d of which a new-file patch creates: a "
                    "literal xash.bat run stops there (this harness reads "
                    "commit trees only, so no verdict above is affected)"
                    % (t, w.get("untracked", 0), len(w["would_block"])))
            out.say("          " + ", ".join(w["would_block"][:6])
                    + (" ..." if len(w["would_block"]) > 6 else ""))
    if res.residual.get("ran"):
        for t in res.targets:
            r = res.residual["targets"].get(t)
            if not r:
                continue
            bad = [p for p in r.get("paths", []) if p["kind"] != "ALLOWED"]
            gl = r.get("gitlinks_differ", 0)
            if r["equal"]:
                verdict = "equal" + (" (%d gitlink(s) aside)" % gl if gl
                                     else "")
            else:
                verdict = "%d file(s) differ" % len(bad)
            out.say("residual %-14s %-28s (replay %s / dev %s)"
                    % (t, verdict, (r["replayed"] or "-")[:12],
                       (r["mirror"] or "-")[:12]))
    out.say("timings : " + ", ".join("%s=%dms" % kv
                                     for kv in sorted(res.timings.items())))


def findings_block(out, findings, exit_code, severity, res=None,
                   cmdfmt=None):
    out.say("")
    if not findings:
        out.say("FINDINGS: none")
    else:
        out.say("FINDINGS (%d)" % len(findings))
        for f in findings:
            out.say("  [%s] %-8s %s" % (f["id"], f["class"], f["message"]))
            if f.get("file"):
                rng = ", ".join("%d-%d" % (a, b) for a, b in f.get("lines", []))
                out.say("        %s lines %s" % (f["file"], rng))
            if f.get("next_command_str"):
                out.say("        next: " + f["next_command_str"])
    out.say("")
    nxt = [f["next_command_str"] for f in findings if f.get("next_command_str")]
    if nxt:
        out.say("NEXT: " + nxt[0])
    elif res is not None and res.skipped:
        # Never "the chain is healthy" off a run that looked at some of it.
        out.say("NEXT: nothing for the %d link(s) this run examined. %d of "
                "%d were NOT examined (verdict SKIPPED)%s"
                % (res.examined, res.skipped, len(res.order),
                   "; for the whole chain: " + cmdfmt(["check", "--all"])
                   if cmdfmt else ""))
    else:
        out.say("NEXT: nothing; the chain is healthy")
    out.say("exit %d (%s)" % (exit_code, severity))


# ---------------------------------------------------------------------------
# explain
# ---------------------------------------------------------------------------

EXPLAIN = {
    "0": ("OK", "the chain is healthy", []),
    "19": ("CHAIN",
           "the chain as xash.bat spells it cannot be applied at all: a "
           "'call :patch' line the parser cannot read, a patch file that is "
           "not on disk, or a shape this tool refuses to guess at. The real "
           "build stops with [ERROR] on that line.",
           [["list"], ["show", "<N>"]]),
    "20": ("WORKTREE",
           "the PRISTINE target's own working tree already holds files the "
           "chain's new-file patches create, so a literal xash.bat run stops "
           "with 'already exists in working directory'. No verdict here is "
           "affected: this harness reads commit trees only. Clearing those "
           "files is the owner's call, which is why this class reports and "
           "does not fail.",
           [["check", "--all"]]),
    "2": ("USAGE", "bad arguments or an ambiguous selector", [["list"]]),
    "3": ("ENVIRONMENT",
          "git too old, a path missing, a submodule uninitialized, or the "
          "work root is not writable", [["selftest"]]),
    "4": ("REFUSED", "a safety rail fired; nothing was written", []),
    "5": ("INTERNAL", "a bug in h9chain", [["selftest"]]),
    "10": ("REJECT", FINDING_TEXT["REJECT"], [["regen", "<N>"]]),
    "11": ("SHADOW",
           "SHADOWS, SHADOWED or NOT_DETECTABLE: one link's change sits on "
           "lines another link owns",
           [["show", "<N>"], ["fold", "<culprit>", "--into", "<victim>"]]),
    "12": ("RESIDUAL",
           "the replayed chain and the dev clone's working tree differ; "
           "UNOWNED means the dev tree has content no patch produces",
           [["residual", "--json"]]),
    "13": ("THREEWAY", FINDING_TEXT["THREEWAY"], [["regen", "<N>",
                                                   "--refresh"]]),
    "14": ("BASELINE",
           "something recorded in CHAIN.lock moved: a final tree id, a link "
           "that appeared or went away, or a patch whose sha256 changed. A "
           "sha256 move with no tree move is what 'regen --refresh' does and "
           "is reported but not failed; a TREE move means the chain now "
           "builds something else, whoever edited what.",
           [["show", "<N>"], ["residual"], ["bless"]]),
    "15": ("NOT_IN_DEV", FINDING_TEXT["NOT_IN_DEV"],
           [["regen", "<N>", "--post-dev", "<paths>"], ["show", "<N>"]]),
    "16": ("DRIFT", FINDING_TEXT["DRIFT"], [["regen", "<N>", "--refresh"]]),
    "17": ("LINT", "a static rule fired", [["lint"]]),
    "18": ("UNVERIFIED",
           "something was not judged: --no-dev, a skipped target, or "
           "H9_SKIP_PATCH_VERIFY set in the environment", [["check", "--all"]]),
}
# Per-verdict commands. 'explain <exit code>' used to carry these while
# 'explain <verdict>' returned an empty list, and links[].verdict is what an
# agent reads, so it always hit the empty half.
VERDICT_DO = {
    "REJECT": [["regen", "<N>"],
               ["fold", "<N+k>", "--into", "<N>", "--mode", "pre"],
               ["show", "<N>"]],
    "SHADOWS": [["fold", "<N>", "--into", "<victim>"], ["show", "<N>"]],
    "SHADOWED": [["fold", "<culprit>", "--into", "<N>"], ["show", "<N>"]],
    "NOT_DETECTABLE": [["regen", "<N>", "--post-dev", "<paths>"],
                       ["fold", "<N>", "--into", "<carrier>", "--mode",
                        "pre"],
                       ["show", "<N>"]],
    "THREEWAY": [["regen", "<N>", "--refresh"]],
    "HUNK_ARITH": [["regen", "<N>", "--refresh"]],
    "PATCH_UNSUPPORTED": [["show", "<N>"]],
    "PATCH_MISSING": [["show", "<N>"], ["list"]],
    "NOT_IN_DEV": [["regen", "<N>", "--post-dev", "<paths>"],
                   ["show", "<N>"]],
    "DRIFT": [["regen", "<N>", "--refresh"]],
    "SKIPPED": [["check", "--all"], ["check", "<N>"]],
    "OK": [],
}

EXTRA_EXPLAIN = {
    "SKIPPED": ("SKIPPED",
                "this run did not examine the link: it was outside the "
                "selection, its trees came from the cache, or an earlier "
                "link stopped that target's replay. It is not a health "
                "verdict and it is not OK.",
                VERDICT_DO["SKIPPED"]),
    "ORPHAN": ("ORPHAN",
               "a .patch file on disk that no 'call :patch' line references. "
               "Today the two in patches\\retired\\ are the expected ones. "
               "It is reported, never fatal.",
               [["list"]]),
    "UNOWNED": ("RESIDUAL",
                "the dev clone's working tree holds content no link in the "
                "chain produces: a feature that was never turned into a "
                "patch. Either write one, or allow the path in "
                "chain.rules.txt with a reason.",
                [["residual"], ["regen", "<N>", "--post-dev", "<paths>"]]),
    "PHANTOM": ("RESIDUAL",
                "the replayed chain produces a file the dev clone does not "
                "have.",
                [["residual"]]),
    "CONTENT": ("RESIDUAL",
                "both trees have the file and the bytes differ.",
                [["residual"], ["regen", "<N>", "--post-dev", "<paths>"]]),
    "ALLOWED": ("RESIDUAL",
                "a residual path matched an 'allow' line in "
                "chain.rules.txt; the reason is echoed in the report.",
                [["residual"]]),
    "FOREIGN_PATH": ("USAGE",
                     "a regen would have produced a hunk for a file outside "
                     "this link's own set. Pass --allow-foreign if that is "
                     "intended.",
                     [["regen", "<N>", "--allow-foreign"]]),
    "FOREIGN_LINES": ("USAGE",
                      "a regen would have changed lines another link owns. "
                      "'owns <path> --regions' prints the map.",
                      [["owns", "<path>", "--regions"],
                       ["regen", "<N>", "--allow-foreign"]]),
    "REVERSE_BLOCKED": ("USAGE",
                        "a --post-dev regen could not reverse a later "
                        "toucher out of the file, so the new patch would "
                        "absorb that other feature. The named link has to be "
                        "dealt with first.",
                        [["show", "<N>"], ["owns", "<path>", "--regions"]]),
    "SUPERSEDED": ("SHADOW",
                   "the candidate's content is already produced by a link in "
                   "the chain, so it applies nowhere and reverses everywhere "
                   "after that link. Wiring it as a separate link gives a "
                   "patch applicable in neither direction, which is what "
                   "broke the master build on 2026-11-17.",
                   [["fold", "<candidate>", "--into", "<carrier>", "--mode",
                     "pre"]]),
}

for _v, _t in list(FINDING_TEXT.items()):
    EXPLAIN.setdefault(_v, (CLASS_OF_VERDICT.get(_v) or _v, _t,
                            VERDICT_DO.get(_v, [])))
EXPLAIN.update(EXTRA_EXPLAIN)
EXPLAIN.setdefault("OK", ("OK", "nothing to do", []))
# Codes that carry a per-verdict command list as well.
for _k in ("DRIFT_ANCHOR_STALE", "DRIFT_HUNK_OFFSET"):
    EXPLAIN[_k] = ("DRIFT", FINDING_TEXT["DRIFT"], VERDICT_DO["DRIFT"])


def explain_keys():
    return sorted(EXPLAIN)


def explain(topic):
    key = str(topic).strip().upper()
    if key in EXPLAIN:
        return key, EXPLAIN[key]
    if str(topic).strip() in EXPLAIN:
        return str(topic).strip(), EXPLAIN[str(topic).strip()]
    for k, v in EXPLAIN.items():
        if v[0].upper() == key:
            return k, v
    return None, None
