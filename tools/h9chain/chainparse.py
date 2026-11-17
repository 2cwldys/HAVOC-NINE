"""Parsers: the chain out of xash.bat, and one .patch file.

Neither parser ever guesses. A shape it does not understand is reported as
PATCH_UNSUPPORTED so that the day one appears the tool says so.
"""

import hashlib
import os
import re

TARGETS = ("engine", "mainui", "freevgui", "library_suffix")

CALL_RE = re.compile(r'^[ \t]*call :patch[ \t]+(.*)$', re.IGNORECASE)
QUOTED_RE = re.compile(r'"([^"]*)"')
HUNK_RE = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$')
INDEX_RE = re.compile(r'^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?\s*$')
DIFFGIT_RE = re.compile(r'^diff --git a/(.*) b/(.*)$')


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# xash.bat
# ---------------------------------------------------------------------------

class Link(object):
    __slots__ = ("index", "line_no", "target", "target_raw", "patch_path",
                 "patch_name", "patch_dir_kind", "raw")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def as_dict(self):
        return {k: getattr(self, k) for k in self.__slots__ if k != "raw"}


class ChainParseResult(object):
    def __init__(self):
        self.links = []
        self.problems = []      # (code, message)
        self.xash_bat = None
        self.xash_bat_sha256 = None
        self.orphans = []
        self.missing = []


def _target_key(raw):
    s = raw.replace("/", "\\").rstrip("\\")
    low = s.lower()
    if low == "%fwgs%":
        return "engine"
    m = re.match(r'^%fwgs%\\3rdparty\\([a-z_0-9]+)$', low)
    if m and m.group(1) in TARGETS:
        return m.group(1)
    return None


def parse_chain(xash_bat, patches_dir, web_dir, retired_dir=None):
    """Read xash.bat and return the ordered chain.

    Only lines whose first non-blank text is 'call :patch ' count. The
    ENGINE.txt echo block and the five ':dllpatch' description strings also
    name patch files; a name-keyed grep picks up about 56 phantom entries,
    which is why the match is anchored on the call itself.
    """
    res = ChainParseResult()
    res.xash_bat = xash_bat
    with open(xash_bat, "rb") as fh:
        raw = fh.read()
    res.xash_bat_sha256 = sha256_bytes(raw)
    text = raw.decode("latin-1")

    idx = 0
    for n, line in enumerate(text.splitlines(), 1):
        m = CALL_RE.match(line)
        if not m:
            continue
        rest = m.group(1)
        quoted = QUOTED_RE.findall(rest)
        if len(quoted) < 2:
            res.problems.append(
                ("CHAIN_PARSE",
                 "xash.bat line %d: 'call :patch' without two quoted "
                 "arguments: %s" % (n, line.strip())))
            continue
        target_raw, patch_raw = quoted[0], quoted[1]
        tkey = _target_key(target_raw)
        if tkey is None:
            res.problems.append(
                ("CHAIN_TARGET",
                 "xash.bat line %d: unrecognised target %r" % (n, target_raw)))
            continue
        p = patch_raw.replace("/", "\\")
        kind = None
        if p.lower().startswith("%xash%\\patches\\"):
            kind = "patches"
            rel = p[len("%XASH%\\patches\\"):]
            full = os.path.join(patches_dir, rel)
        elif p.lower().startswith("%web%\\"):
            kind = "web"
            rel = p[len("%WEB%\\"):]
            full = os.path.join(web_dir, rel)
        else:
            res.problems.append(
                ("CHAIN_PATCHDIR",
                 "xash.bat line %d: unrecognised patch location %r"
                 % (n, patch_raw)))
            continue
        idx += 1
        res.links.append(Link(
            index=idx, line_no=n, target=tkey, target_raw=target_raw,
            patch_path=os.path.normpath(full),
            patch_name=os.path.basename(full),
            patch_dir_kind=kind, raw=line))

    referenced = set()
    for lk in res.links:
        referenced.add(os.path.normcase(os.path.normpath(lk.patch_path)))
        if not os.path.isfile(lk.patch_path):
            res.missing.append(lk.patch_path)

    for d in [x for x in (patches_dir, web_dir, retired_dir) if x]:
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.lower().endswith(".patch"):
                continue
            full = os.path.normcase(os.path.normpath(os.path.join(d, fn)))
            if full not in referenced:
                res.orphans.append(os.path.normpath(os.path.join(d, fn)))
    return res


# ---------------------------------------------------------------------------
# one .patch file
# ---------------------------------------------------------------------------

class Hunk(object):
    __slots__ = ("old_start", "old_count", "new_start", "new_count",
                 "heading", "lines", "arith_ok", "counted_old", "counted_new",
                 "first_line_no")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def added_lines(self):
        """Post-image line numbers this hunk writes (1-based)."""
        out = []
        pos = self.new_start
        for ln in self.lines:
            if not ln:
                continue
            c = ln[0]
            if c == " ":
                pos += 1
            elif c == "+":
                out.append(pos)
                pos += 1
            elif c == "-":
                pass
        return out

    def as_dict(self):
        return {
            "old_start": self.old_start, "old_count": self.old_count,
            "new_start": self.new_start, "new_count": self.new_count,
            "arith_ok": self.arith_ok,
            "counted_old": self.counted_old, "counted_new": self.counted_new,
        }


class FileSection(object):
    __slots__ = ("old_path", "new_path", "path", "is_new", "is_binary",
                 "index_pre", "index_post", "mode", "hunks", "has_diff_git",
                 "start_line")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))
        if self.hunks is None:
            self.hunks = []

    def as_dict(self):
        return {
            "path": self.path, "is_new": bool(self.is_new),
            "is_binary": bool(self.is_binary),
            "index_pre": self.index_pre, "index_post": self.index_post,
            "mode": self.mode, "hunks": len(self.hunks),
        }


class Patch(object):
    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
        self.sha256 = None
        self.bytes = 0
        self.files = []
        self.unsupported = []     # reasons -> PATCH_UNSUPPORTED
        self.missing = False      # -> PATCH_MISSING, its own verdict
        self.arith_errors = []    # -> HUNK_ARITH
        self.style = "git"        # git | house
        self.exists = False

    def paths(self):
        return [f.path for f in self.files]

    def as_dict(self):
        return {
            "name": self.name, "sha256": self.sha256, "bytes": self.bytes,
            "files": [f.as_dict() for f in self.files],
            "hunks": sum(len(f.hunks) for f in self.files),
            "style": self.style, "missing": bool(self.missing),
            "unsupported": list(self.unsupported),
            "arith_errors": list(self.arith_errors),
        }


def _p1(p):
    if p == "/dev/null":
        return None
    if p.startswith("a/") or p.startswith("b/"):
        return p[2:]
    return p


def parse_patch(path):
    """Parse one patch file.

    Accepts both shapes present in the tree: sections beginning
    'diff --git a/X b/Y', and sections beginning directly at '--- a/X' with
    no 'diff --git' at all (autoconfig, deltabits and framesize are in the
    second shape; a parser keyed on 'diff --git' sees zero files in them).
    """
    pat = Patch(path)
    if not os.path.isfile(path):
        # Its own condition, not an unsupported shape: a file that is not
        # there is not a rename, a deletion or a binary delta, and saying so
        # sent a reader looking for the wrong thing.
        pat.missing = True
        return pat
    with open(path, "rb") as fh:
        raw = fh.read()
    pat.exists = True
    pat.bytes = len(raw)
    pat.sha256 = sha256_bytes(raw)
    lines = raw.decode("latin-1").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    lines = [l[:-1] if l.endswith("\r") else l for l in lines]

    cur = None
    hunk = None
    seen_diff_git = False
    pending = {}
    i = 0
    n = len(lines)

    def close_hunk():
        if hunk is None:
            return
        co = sum(1 for l in hunk.lines if l[:1] in (" ", "-") or l == "")
        cn = sum(1 for l in hunk.lines if l[:1] in (" ", "+") or l == "")
        hunk.counted_old = co
        hunk.counted_new = cn
        hunk.arith_ok = (co == hunk.old_count and cn == hunk.new_count)
        if not hunk.arith_ok:
            pat.arith_errors.append(
                "%s hunk at @@ -%d,%d +%d,%d @@ (line %d): body counts "
                "%d old / %d new"
                % (cur.path if cur else "?", hunk.old_start, hunk.old_count,
                   hunk.new_start, hunk.new_count, hunk.first_line_no,
                   co, cn))

    def close_file():
        close_hunk()

    while i < n:
        line = lines[i]
        m = DIFFGIT_RE.match(line)
        if m:
            close_file()
            hunk = None
            seen_diff_git = True
            cur = FileSection(old_path=_p1(m.group(1)),
                              new_path=_p1(m.group(2)),
                              path=_p1(m.group(2)), has_diff_git=True,
                              start_line=i + 1, hunks=[])
            pat.files.append(cur)
            pending = {}
            i += 1
            continue
        if line.startswith("old mode ") or line.startswith("new mode "):
            pat.unsupported.append("mode change at line %d" % (i + 1))
            i += 1
            continue
        if (line.startswith("rename from ") or line.startswith("rename to ")
                or line.startswith("copy from ") or line.startswith("copy to ")
                or line.startswith("similarity index ")
                or line.startswith("dissimilarity index ")):
            pat.unsupported.append("rename/copy at line %d" % (i + 1))
            i += 1
            continue
        if line.startswith("deleted file mode"):
            pat.unsupported.append("file deletion at line %d" % (i + 1))
            i += 1
            continue
        if line.startswith("new file mode "):
            if cur is not None:
                cur.is_new = True
                cur.mode = line.split()[-1]
            else:
                pending["is_new"] = True
                pending["mode"] = line.split()[-1]
            i += 1
            continue
        mi = INDEX_RE.match(line)
        if mi:
            if cur is not None:
                cur.index_pre = mi.group(1)
                cur.index_post = mi.group(2)
                if mi.group(3):
                    cur.mode = mi.group(3)
            else:
                pending["index_pre"] = mi.group(1)
                pending["index_post"] = mi.group(2)
                if mi.group(3):
                    pending["mode"] = mi.group(3)
            i += 1
            continue
        if line.startswith("Binary files ") and line.rstrip().endswith("differ"):
            pat.unsupported.append("'Binary files ... differ' at line %d"
                                   % (i + 1))
            if cur is not None:
                cur.is_binary = True
            i += 1
            continue
        if line.startswith("GIT binary patch"):
            if cur is not None:
                cur.is_binary = True
            j = i + 1
            while j < n and not lines[j].startswith("literal ") \
                    and not lines[j].startswith("delta "):
                j += 1
            if j < n and lines[j].startswith("delta "):
                pat.unsupported.append("delta-form binary hunk at line %d"
                                       % (j + 1))
            # Recorded, never decoded. git applies it; diff-tree --binary
            # regenerates it.
            while j < n and not DIFFGIT_RE.match(lines[j]) \
                    and not lines[j].startswith("--- "):
                j += 1
            i = j
            continue
        if line.startswith("--- "):
            close_hunk()
            hunk = None
            src = line[4:].split("\t")[0].strip()
            if not seen_diff_git or cur is None or cur.hunks:
                cur = FileSection(old_path=_p1(src), has_diff_git=False,
                                  start_line=i + 1, hunks=[])
                for k, v in pending.items():
                    setattr(cur, k, v)
                pending = {}
                pat.files.append(cur)
            else:
                cur.old_path = _p1(src)
            if src == "/dev/null":
                cur.is_new = True
            i += 1
            continue
        if line.startswith("+++ "):
            dst = line[4:].split("\t")[0].strip()
            if dst == "/dev/null":
                pat.unsupported.append("file deletion (+++ /dev/null) at "
                                       "line %d" % (i + 1))
            if cur is not None:
                cur.new_path = _p1(dst)
                cur.path = _p1(dst) or cur.old_path
            i += 1
            continue
        mh = HUNK_RE.match(line)
        if mh and cur is not None:
            close_hunk()
            hunk = Hunk(old_start=int(mh.group(1)),
                        old_count=int(mh.group(2)) if mh.group(2) is not None
                        else 1,
                        new_start=int(mh.group(3)),
                        new_count=int(mh.group(4)) if mh.group(4) is not None
                        else 1,
                        heading=mh.group(5), lines=[], first_line_no=i + 1)
            cur.hunks.append(hunk)
            i += 1
            continue
        if hunk is not None:
            if line.startswith("\\"):
                i += 1
                continue
            if line[:1] in (" ", "+", "-") or line == "":
                hunk.lines.append(line if line else " ")
                i += 1
                continue
            close_hunk()
            hunk = None
            i += 1
            continue
        i += 1

    close_file()
    # Sections that never got a path (stray text) are dropped.
    pat.files = [f for f in pat.files if f.path]
    pat.style = "git" if any(f.has_diff_git for f in pat.files) else "house"
    return pat
