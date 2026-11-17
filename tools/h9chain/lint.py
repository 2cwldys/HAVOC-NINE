"""Static lint rules.

L1 and L2 are the two that have actually cost time, so they come first.
Nothing here needs a tree; everything is seconds, and lint never fails a run
on its own unless --strict or --fail-on says so.
"""

import json
import os
import re

CHANGELOG = "PATCH_CHANGELOG.md"
CMD_LINE_LIMIT = 8191

RULES = ["L1", "L2", "L7", "L8", "L9", "L10", "INDEX_LINE_STALE"]


def _finding(code, rule, message, ctx, cmd=None, **kw):
    f = {"id": "", "class": "LINT", "severity": "warning", "code": code,
         "rule": rule, "link": kw.pop("link", None), "message": message}
    f.update(kw)
    f["next_command"] = cmd or []
    f["next_command_str"] = ctx.cmdfmt(cmd) if cmd else ""
    return f


def _changelog_text(ctx):
    p = os.path.join(ctx.cfg.patches_dir, CHANGELOG)
    if not os.path.isfile(p):
        return None, p
    with open(p, "r", encoding="latin-1") as fh:
        return fh.read(), p


def _lock(ctx):
    from .h9chain import load_lock
    return load_lock(ctx)


def l1_changelog(ctx, res):
    """A patch's sha256 moved with no new dated changelog entry."""
    out = []
    lock = _lock(ctx)
    if not lock:
        return out
    text, path = _changelog_text(ctx)
    if text is None:
        return [_finding("LINT_NO_CHANGELOG", "L1",
                         "%s is missing" % path, ctx)]
    since = (lock.get("written_utc") or "")[:10]
    locklinks = {int(k): v for k, v in (lock.get("links") or {}).items()}
    heads = re.findall(r'^#{2,4}\s*(\d{4}-\d{2}-\d{2})([^\n]*)$', text,
                       re.M)
    for idx in res.order:
        st = res.states[idx]
        was = locklinks.get(idx)
        if not was or was.get("sha256") == st.patch.sha256:
            continue
        stem = st.link.patch_name
        logged = any(d >= since and (stem in rest or stem[:-6] in rest)
                     for d, rest in heads)
        if not logged:
            out.append(_finding(
                "LINT_PATCH_UNLOGGED", "L1",
                "#%d %s changed since the baseline (%s -> %s) with no dated "
                "%s entry on or after %s"
                % (idx, stem, (was.get("sha256") or "-")[:12],
                   (st.patch.sha256 or "-")[:12], CHANGELOG, since),
                ctx, link=idx))
    return out


def l2_hunk_arith(ctx, res):
    out = []
    for idx in res.order:
        st = res.states[idx]
        for msg in st.patch.arith_errors:
            out.append(_finding(
                "HUNK_ARITH", "L2",
                "#%d %s: %s" % (idx, st.link.patch_name, msg), ctx,
                ["regen", str(idx), "--refresh"], link=idx))
    return out


def l7_retired(ctx, res):
    out = []
    wired = {os.path.normcase(lk.patch_path) for lk in ctx.chain.links}
    if os.path.isdir(ctx.cfg.retired_dir):
        for fn in sorted(os.listdir(ctx.cfg.retired_dir)):
            if not fn.endswith(".patch"):
                continue
            full = os.path.normcase(os.path.join(ctx.cfg.retired_dir, fn))
            if full in wired:
                out.append(_finding(
                    "LINT_RETIRED_WIRED", "L7",
                    "xash.bat still calls retired\\%s" % fn, ctx))
    exp = os.path.join(ctx.cfg.repo_root, "export")
    if os.path.isdir(exp) and os.path.isdir(ctx.cfg.retired_dir):
        retired = {fn for fn in os.listdir(ctx.cfg.retired_dir)
                   if fn.endswith(".patch")}
        for dirpath, _d, files in os.walk(exp):
            for fn in files:
                if fn in retired:
                    out.append(_finding(
                        "LINT_RETIRED_EXPORTED", "L7",
                        "a retired patch still lingers in export: %s"
                        % os.path.join(dirpath, fn), ctx))
    return out


def l8_dllpatch_line(ctx, res):
    out = []
    with open(ctx.cfg.xash_bat, "rb") as fh:
        lines = fh.read().decode("latin-1").split("\n")
    for n, line in enumerate(lines, 1):
        if not line.lstrip().lower().startswith("call :dllpatch"):
            continue
        ln = len(line.rstrip("\r"))
        if ln > CMD_LINE_LIMIT - 64:
            sev = "error" if ln >= CMD_LINE_LIMIT else "warning"
            f = _finding(
                "LINT_CMD_LINE_LIMIT", "L8",
                "xash.bat line %d is %d characters; cmd's limit is %d, so "
                "%d left. One more patch name there breaks the build at the "
                "parse level." % (n, ln, CMD_LINE_LIMIT, CMD_LINE_LIMIT - ln),
                ctx)
            f["severity"] = sev
            out.append(f)
    return out


def l9_changelog_table(ctx, res):
    out = []
    text, path = _changelog_text(ctx)
    if text is None:
        return out
    rows = re.findall(r'^\|[^|\n]*\|\s*`([^`]+\.patch)`', text, re.M)
    want = [lk.patch_name for lk in ctx.chain.links]
    seen = []
    for r in rows:
        nm = os.path.basename(r)
        if nm not in seen:
            seen.append(nm)
    missing = [w for w in want if w not in seen]
    # A row for a patch xash.bat deliberately stopped calling is a record, not
    # rot: chain.rules.txt declares those by name so the rule still catches a
    # 'call :patch' line that went missing by accident.
    folded = ctx.cfg.rules.folded_names()
    extra = [s for s in seen if s not in want and s not in folded]
    if missing:
        out.append(_finding(
            "LINT_CHANGELOG_TABLE_MISSING", "L9",
            "%s's patch table has no row for: %s"
            % (CHANGELOG, ", ".join(missing)), ctx))
    if extra:
        out.append(_finding(
            "LINT_CHANGELOG_TABLE_EXTRA", "L9",
            "%s's patch table names patches xash.bat does not call: %s"
            % (CHANGELOG, ", ".join(extra)), ctx))
    common = [s for s in seen if s in want]
    expect = [w for w in want if w in common]
    if common != expect:
        where = ""
        for i, (a, b) in enumerate(zip(common, expect)):
            if a != b:
                where = (" -- first divergence at table row %d: %s where "
                         "xash.bat has %s" % (i + 1, a, b))
                break
        out.append(_finding(
            "LINT_CHANGELOG_TABLE_ORDER", "L9",
            "%s's patch table is not in xash.bat apply order%s"
            % (CHANGELOG, where), ctx))
    return out


def l10_temporary(ctx, res):
    out = []
    for name, marker in ctx.cfg.rules.temporary:
        for idx in res.order:
            st = res.states[idx]
            if st.link.patch_name != name:
                continue
            try:
                with open(st.link.patch_path, "rb") as fh:
                    body = fh.read().decode("latin-1")
            except OSError:
                continue
            if marker and marker in body:
                out.append(_finding(
                    "LINT_TEMPORARY_STILL_PRESENT", "L10",
                    "#%d %s still carries the line chain.rules.txt marks "
                    "temporary: %r" % (idx, name, marker), ctx, link=idx))
    return out


def index_line_stale(ctx, res):
    out = []
    for idx in res.order:
        st = res.states[idx]
        if st.anchor.get("state") != "stale":
            continue
        bad = [a for a in st.anchor["files"] if a["state"] == "stale"]
        out.append(_finding(
            "INDEX_LINE_STALE", "INDEX_LINE_STALE",
            "#%d %s: the recorded index line does not match the tree the "
            "chain produces for %s"
            % (idx, st.link.patch_name, ", ".join(a["path"] for a in bad)),
            ctx, ["regen", str(idx), "--refresh"], link=idx))
    return out


ALL = [("L1", l1_changelog), ("L2", l2_hunk_arith), ("L7", l7_retired),
       ("L8", l8_dllpatch_line), ("L9", l9_changelog_table),
       ("L10", l10_temporary),
       ("INDEX_LINE_STALE", index_line_stale)]


def run_all(ctx, res, only=None):
    want = None
    if only:
        want = {x.strip().upper() for x in only.split(",") if x.strip()}
    out = []
    for name, fn in ALL:
        if want and name.upper() not in want:
            continue
        try:
            out += fn(ctx, res)
        except Exception as exc:
            out.append(_finding("LINT_RULE_FAILED", name,
                                "%s raised %s" % (name, exc), ctx))
    for i, f in enumerate(out, 1):
        f["id"] = "L%03d" % i
    return out
