"""The work area: shared clones, the index-only replay, the cache, the dev
mirror and the disposable three-way arena.

Nothing here reads a real working tree except the dev clone, and that only
through ls-files and plain file reads. Everything else comes from commit
trees, so line endings stop being a variable: blobs leave the ODB as LF and
nothing is smudged.
"""

import hashlib
import json
import os
import time

from . import gitio
from .chainparse import TARGETS, sha256_file
from .errors import Environment

NULL_SHA = "0" * 40
CACHE_VERSION = "h9chain-pre-v1"

# A run holds this file for as long as it is working. Two runs sharing a work
# area corrupt each other: the index slots are fixed paths, the work repos are
# shared, and cache/index.jsonl is appended to. One of the two used to die on
# index.lock contention and the survivor reported fabricated THREEWAY and
# REJECT verdicts on a healthy chain.
LOCK_NAME = "run.lock"


class WorkArea(object):

    def __init__(self, cfg, git, log=None):
        self.cfg = cfg
        self.git = git
        self.log = log or (lambda *_a, **_k: None)
        self.root = cfg.work
        self.repos_dir = os.path.join(self.root, "repos")
        self.idx_dir = os.path.join(self.root, "idx")
        self.cache_dir = os.path.join(self.root, "cache")
        self.arena_dir = os.path.join(self.root, "arena")
        self.cand_dir = os.path.join(self.root, "candidates")
        self.tmp_dir = os.path.join(self.root, "tmp")
        self._ready = set()
        self._cache = None
        self._base = None
        self._dev_mirror = {}
        self._git_version = gitio.git_version()
        self.timings = {}
        self.cache_problems = []
        self._lock_fd = None
        self._lock_path = os.path.join(self.root, LOCK_NAME)
        self.cache_derived = {}

    # -- the run lock -------------------------------------------------------

    def lock_stale_after(self):
        # Three times the git timeout: no single command in this tool runs
        # longer, so anything older than that is a crashed run.
        return max(180, int(self.cfg.timeout_sec) * 3)

    def acquire_lock(self, break_lock=False):
        """One run per work area. Returns a note, or raises Environment."""
        os.makedirs(self.root, exist_ok=True)
        payload = json.dumps({
            "pid": os.getpid(),
            "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "epoch": int(time.time()),
        }).encode("ascii")
        note = None
        for attempt in (0, 1):
            try:
                fd = os.open(self._lock_path,
                             os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, payload)
                os.close(fd)
                self._lock_fd = True
                return note
            except FileExistsError:
                pass
            held = {}
            try:
                with open(self._lock_path, "rb") as fh:
                    held = json.loads(fh.read().decode("ascii", "replace"))
            except Exception:
                held = {}
            age = int(time.time()) - int(held.get("epoch") or 0)
            stale = age > self.lock_stale_after() or not held
            if attempt == 0 and (stale or break_lock):
                note = ("broke a %s lock held by pid %s for %ds"
                        % ("stale" if stale else "live", held.get("pid"), age))
                try:
                    os.remove(self._lock_path)
                except OSError:
                    pass
                continue
            raise Environment(
                "another h9chain run is using this work area (pid %s, held "
                "%ds, %s). Two runs sharing one work area corrupt each "
                "other's indexes and cache, so this one will not start. Wait "
                "for it, give this run its own area with --work DIR, or pass "
                "--break-lock if you know that run is dead."
                % (held.get("pid"), age, self._lock_path))
        return note

    def release_lock(self):
        if not self._lock_fd:
            return
        self._lock_fd = None
        try:
            os.remove(self._lock_path)
        except OSError:
            pass

    # -- paths --------------------------------------------------------------

    def repo(self, target):
        return os.path.join(self.repos_dir, target)

    def index_file(self, target, slot="replay"):
        d = os.path.join(self.idx_dir, target)
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, slot + ".idx")

    # -- base commits (derived, never configured) ---------------------------

    def bases(self):
        if self._base is not None:
            return self._base
        g = self.git
        root = self.cfg.repo_root
        out = g.ro_out(root, "ls-tree", "HEAD", "xash3d-fwgs")
        engine_commit = None
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0] == "160000":
                engine_commit = parts[2]
        if not engine_commit:
            raise gitio.GitError(
                "no gitlink for xash3d-fwgs in %s HEAD" % root)
        eng_dir = self.pristine_gitdir("engine")
        res = {"engine": engine_commit}
        sub = g.ro_out(eng_dir, "ls-tree", engine_commit, "3rdparty/")
        want = {"3rdparty/mainui": "mainui",
                "3rdparty/freevgui": "freevgui",
                "3rdparty/library_suffix": "library_suffix"}
        for line in sub.splitlines():
            if not line.startswith("160000"):
                continue
            head, path = line.split("\t", 1)
            parts = head.split()
            if path.strip() in want:
                res[want[path.strip()]] = parts[2]
        self._base = res
        return res

    def pristine_gitdir(self, target):
        wt = self.cfg.pristine_worktree(target)
        return self.git.ro_out(wt, "rev-parse", "--absolute-git-dir").strip()

    def dev_gitdir(self, target):
        wt = self.cfg.dev_worktree(target)
        return self.git.ro_out(wt, "rev-parse", "--absolute-git-dir").strip()

    def dev_head(self, target):
        return self.git.ro_out(self.cfg.dev_worktree(target),
                               "rev-parse", "HEAD").strip()

    # -- materialize --------------------------------------------------------

    def ensure_repo(self, target):
        if target in self._ready:
            return self.repo(target)
        dst = self.repo(target)
        t0 = time.time()
        if not os.path.isdir(os.path.join(dst, ".git")):
            gitio.rmtree_force(dst)
            os.makedirs(self.repos_dir, exist_ok=True)
            src = self.pristine_gitdir(target)
            self.git.clone_shared(src, dst)
            alt = os.path.join(dst, ".git", "objects", "info", "alternates")
            dev_objs = os.path.join(self.dev_gitdir(target), "objects")
            # Binary mode: text mode turns the newline into CRLF on Windows
            # and git then reports the object directory missing.
            with open(alt, "ab") as fh:
                fh.write((dev_objs.replace("\\", "/") + "\n").encode("ascii"))
            self.git.rw(dst, "remote", "remove", "origin")
            for k, v in (("core.autocrlf", "false"), ("core.eol", "lf"),
                         ("gc.auto", "0"), ("gc.pruneExpire", "never"),
                         ("core.fileMode", "false")):
                self.git.rw(dst, "config", k, v)
        rc, _, _ = self.git.rw(dst, "rev-parse", "--git-dir")
        if rc != 0:
            raise gitio.GitError("work repo %s is not a git repository" % dst)
        self._ready.add(target)
        self.timings["materialize"] = self.timings.get("materialize", 0) + \
            int((time.time() - t0) * 1000)
        return dst

    def base_tree(self, target):
        self.ensure_repo(target)
        bases = self.bases()
        if target not in bases:
            raise gitio.GitError(
                "no base commit for target '%s': the superproject's HEAD has "
                "no gitlink for it" % target)
        c = bases[target]
        return self.git.rw_out(self.repo(target), "rev-parse",
                               c + "^{tree}").strip()

    # -- cache --------------------------------------------------------------

    def _cache_path(self):
        os.makedirs(self.cache_dir, exist_ok=True)
        return os.path.join(self.cache_dir, "index.jsonl")

    def cache(self):
        """Load cache/index.jsonl, dropping any key that is not self-consistent.

        The file is append-only and last-line-wins, so a hand-edited or
        half-written line could override a key with a tree the chain does not
        produce at that position, and the selective path would then judge a
        link against the wrong pre-image and report OK. Two defences:

        1. a key that appears twice with two different trees is not trusted at
           all (that is what a crashed or concurrent run leaves behind), and
        2. cache_put also writes refs/h9chain/pre/<key>, so the ref is a
           second copy of the mapping; cache_get_checked compares them.
        """
        if self._cache is not None:
            return self._cache
        self._cache = {}
        self.cache_problems = []
        conflict = {}
        p = self._cache_path()
        if os.path.isfile(p):
            with open(p, "r", encoding="ascii", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    key = rec.get("key")
                    if not key:
                        continue
                    was = self._cache.get(key)
                    if was and was.get("tree") != rec.get("tree"):
                        conflict[key] = (was.get("tree"), rec.get("tree"),
                                         rec.get("target"),
                                         rec.get("patch_name"))
                    self._cache[key] = rec
        for key, (a, b, target, name) in sorted(conflict.items()):
            self._cache.pop(key, None)
            self.cache_problems.append(
                "cache key %s (%s, %s) maps to two different trees (%s and "
                "%s); it is being ignored and recomputed"
                % (key[:12], target, name, (a or "-")[:12], (b or "-")[:12]))
        return self._cache

    def cache_key(self, target, patch_shas):
        h = hashlib.sha256()
        h.update((CACHE_VERSION + "\n").encode("ascii"))
        h.update(("git=" + self._git_version + "\n").encode("ascii"))
        h.update(("target=" + target + "\n").encode("ascii"))
        h.update(("base=" + self.bases()[target] + "\n").encode("ascii"))
        for s in patch_shas:
            h.update(("p=" + s + "\n").encode("ascii"))
        return h.hexdigest()

    def cache_get(self, key):
        rec = self.cache().get(key)
        if not rec:
            return None
        tree = rec.get("tree")
        target = rec.get("target")
        if not tree or not target:
            return None
        witness = self.cache_refs(target).get(key)
        if witness and witness != tree:
            return None
        try:
            self.ensure_repo(target)
        except Exception:
            return None
        rc, out, _ = self.git.rw(self.repo(target), "cat-file", "-t", tree)
        if rc != 0 or out.strip() != "tree":
            return None          # a missing object is a silent miss
        return tree

    def cache_refs(self, target):
        """The refs/h9chain/pre/* mapping, which cache_put writes alongside
        the jsonl line. It is the second witness for every cached tree."""
        attr = "_refs_" + target
        got = getattr(self, attr, None)
        if got is not None:
            return got
        out = {}
        # One for-each-ref covers the whole namespace.
        try:
            self.ensure_repo(target)
            text = self.git.rw_out(self.repo(target), "for-each-ref",
                                   "--format=%(refname)|%(objectname)",
                                   "refs/h9chain/pre/")
            for line in text.splitlines():
                if "|" not in line:
                    continue
                ref, oid = line.rsplit("|", 1)
                out[ref.strip().rsplit("/", 1)[-1]] = oid.strip()
        except Exception:
            out = {}
        setattr(self, attr, out)
        return out

    def cache_lookup_bulk(self, target, keys):
        """Resolve many cache keys at once.

        One 'cat-file --batch-check' confirms every tree id still exists, so
        a warm run costs one subprocess instead of one per position. A record
        whose ref disagrees with its jsonl line is dropped and reported: that
        is a poisoned or half-written cache, not a hit.
        """
        cand = {}
        refs = self.cache_refs(target)
        for i, k in enumerate(keys):
            rec = self.cache().get(k)
            if not rec or not rec.get("tree"):
                continue
            witness = refs.get(k)
            if witness and witness != rec["tree"]:
                self.cache_problems.append(
                    "cache key %s disagrees with refs/h9chain/pre/%s (%s in "
                    "the index, %s in the ref); it is being ignored and "
                    "recomputed" % (k[:12], k[:12], rec["tree"][:12],
                                    witness[:12]))
                continue
            cand[i] = rec["tree"]
        if not cand:
            return {}
        self.ensure_repo(target)
        order = sorted(cand)
        payload = "\n".join(cand[i] for i in order) + "\n"
        rc, out, _ = self.git.rw(self.repo(target), "cat-file",
                                 "--batch-check",
                                 stdin_bytes=payload.encode("ascii"))
        if rc != 0:
            return {}
        res = {}
        for i, line in zip(order, out.splitlines()):
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "tree":
                res[i] = cand[i]
        return res

    def cache_put(self, key, target, link_index, patch_name, tree):
        self.cache()[key] = {
            "key": key, "target": target, "link_index": link_index,
            "patch_name": patch_name, "tree": tree,
            "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        # The ref goes first: it is the witness the loader checks the jsonl
        # line against, and a ref written after a crash between the two is a
        # harmless orphan, while a jsonl line without one is not.
        self.git.rw(self.repo(target), "update-ref",
                    "refs/h9chain/pre/" + key, tree)
        refs = getattr(self, "_refs_" + target, None)
        if refs is not None:
            refs[key] = tree
        with open(self._cache_path(), "a", encoding="ascii") as fh:
            fh.write(json.dumps(self.cache()[key]) + "\n")

    def disk_usage(self):
        """Bytes under each part of the work area, for 'cache status'."""
        out = {}
        for name, path in (("cache", self.cache_dir), ("repos", self.repos_dir),
                           ("idx", self.idx_dir), ("arena", self.arena_dir),
                           ("candidates", self.cand_dir),
                           ("tmp", self.tmp_dir)):
            size = 0
            for dirpath, _d, files in os.walk(path):
                for fn in files:
                    try:
                        size += os.path.getsize(os.path.join(dirpath, fn))
                    except OSError:
                        pass
            out[name] = size
        total = 0
        for dirpath, _d, files in os.walk(self.root):
            for fn in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, fn))
                except OSError:
                    pass
        out["other"] = max(0, total - sum(v for k, v in out.items()))
        out["total"] = total
        return out

    def cache_clear(self, everything=False):
        """Free disk. 'cache' alone leaves the biggest consumer behind: a
        materialized arena is a full checkout (about 22 MB for the engine),
        and nothing else prunes one, so the cached trees, the indexes, the
        scratch blobs and the arenas all go. The generated candidates and the
        shared clones stay unless everything is asked for."""
        before = self.disk_usage()["total"]
        for d in (self.cache_dir, self.arena_dir, self.tmp_dir, self.idx_dir):
            gitio.rmtree_force(d)
        if everything:
            for d in (self.cand_dir, self.repos_dir):
                gitio.rmtree_force(d)
            self._ready = set()
        self._cache = None
        self._dev_mirror = {}
        for t in TARGETS:
            if hasattr(self, "_refs_" + t):
                delattr(self, "_refs_" + t)
        after = self.disk_usage()["total"]
        return max(0, before - after)

    # -- index helpers ------------------------------------------------------

    def read_tree(self, target, tree, slot="replay"):
        idx = self.index_file(target, slot)
        if os.path.isfile(idx):
            os.remove(idx)
        self.git.rw(self.repo(target), "read-tree", tree, index_file=idx,
                    check=True)
        return idx

    def write_tree(self, target, slot="replay"):
        idx = self.index_file(target, slot)
        return self.git.rw_out(self.repo(target), "write-tree",
                               index_file=idx).strip()

    def apply_cached(self, target, patch_path, slot="replay", reverse=False,
                     check=False, verbose=False):
        args = ["apply", "--cached"]
        if reverse:
            args.append("--reverse")
        if check:
            args.append("--check")
        if verbose:
            args.append("-v")
        args.append(str(patch_path))
        return self.git.rw(self.repo(target), *args,
                           index_file=self.index_file(target, slot))

    def blob_at(self, target, tree, path):
        rc, out, _ = self.git.rw(self.repo(target), "rev-parse",
                                 "%s:%s" % (tree, path))
        if rc != 0:
            return None
        return out.strip()

    # -- the dev mirror -----------------------------------------------------

    def _dev_key(self, target, dev, head):
        """Key the dev mirror on HEAD plus every uncommitted path's identity.

        Always recomputed, never assumed: the dev clone's working tree is
        deliberately dirty and changes under us.
        """
        g = self.git
        changed = []
        rc, out, _ = g.ro(dev, "ls-files", "-m")
        if rc == 0:
            changed += [l.strip() for l in out.splitlines() if l.strip()]
        rc, out, _ = g.ro(dev, "ls-files", "-o", "--exclude-standard")
        if rc == 0:
            changed += [l.strip() for l in out.splitlines() if l.strip()]
        deleted = []
        rc, out, _ = g.ro(dev, "ls-files", "-d")
        if rc == 0:
            deleted = [l.strip() for l in out.splitlines() if l.strip()]
        h = hashlib.sha256()
        h.update(("h9chain-dev-v1\n" + target + "\n" + head + "\n")
                 .encode("ascii"))
        for rel in sorted(set(changed)):
            full = os.path.join(dev, rel.replace("/", os.sep))
            try:
                stt = os.stat(full)
                h.update(("%s\t%d\t%d\t%o\n"
                          % (rel, stt.st_size, stt.st_mtime_ns, stt.st_mode))
                         .encode("utf-8"))
            except OSError:
                h.update(("%s\tmissing\n" % rel).encode("utf-8"))
        for rel in sorted(set(deleted)):
            h.update(("D\t%s\n" % rel).encode("utf-8"))
        return h.hexdigest(), {"changed": changed,
                               "deleted_paths": deleted,
                               "modified": len(set(changed)),
                               "deleted": len(deleted)}

    def dev_mirror(self, target):
        """The dev clone's WORKING TREE, reproduced as a tree in the work ODB.

        This is the only way to judge the reverse axis and the residual
        without ever running git apply against the dev clone.
        """
        if target in self._dev_mirror:
            return self._dev_mirror[target]
        t0 = time.time()
        self.ensure_repo(target)
        g = self.git
        dev = self.cfg.dev_worktree(target)
        head = self.dev_head(target)
        key, listing = self._dev_key(target, dev, head)
        hit = self.cache_lookup_bulk(target, [key])
        if 0 in hit:
            info = {"head": head, "modified": listing["modified"],
                    "deleted": listing["deleted"], "mirror_tree": hit[0],
                    "cached": True}
            self._dev_mirror[target] = info
            self.timings["dev_mirror"] = self.timings.get("dev_mirror", 0) + \
                int((time.time() - t0) * 1000)
            return info
        idx = self.index_file(target, "dev")
        if os.path.isfile(idx):
            os.remove(idx)
        g.rw(self.repo(target), "read-tree", head + "^{tree}",
             index_file=idx, check=True)

        eol = {}
        rc, out, _ = g.ro(dev, "ls-files", "--eol")
        if rc == 0:
            for line in out.splitlines():
                if "\t" not in line:
                    continue
                attrs, path = line.split("\t", 1)
                for tok in attrs.split():
                    if tok.startswith("i/"):
                        eol[path.strip()] = tok[2:]
        modes = {}
        rc, out, _ = g.ro(dev, "ls-files", "-s")
        if rc == 0:
            for line in out.splitlines():
                if "\t" not in line:
                    continue
                head_part, path = line.split("\t", 1)
                parts = head_part.split()
                if len(parts) >= 3:
                    modes[path.strip()] = parts[0]

        changed = list(listing["changed"])
        deleted = list(listing["deleted_paths"])
        deleted_set = set(deleted)

        os.makedirs(self.tmp_dir, exist_ok=True)
        staged = []
        tmp_paths = []
        seen = set()
        for rel in changed:
            rel = rel.strip()
            if not rel or rel in deleted_set or rel in seen:
                continue
            seen.add(rel)
            full = os.path.join(dev, rel.replace("/", os.sep))
            if not os.path.isfile(full):
                continue
            with open(full, "rb") as fh:
                data = fh.read()
            want_lf = eol.get(rel)
            if want_lf is None:
                # Untracked: the machine checks in with core.autocrlf=true,
                # so normalize unless the content is binary.
                normalize = b"\x00" not in data[:8000]
            else:
                normalize = (want_lf == "lf" and b"\x00" not in data[:8000])
            if normalize:
                data = data.replace(b"\r\n", b"\n")
            tp = os.path.join(self.tmp_dir, "m%06d.blob" % len(tmp_paths))
            with open(tp, "wb") as fh:
                fh.write(data)
            tmp_paths.append(tp)
            staged.append((modes.get(rel, "100644"), tp, rel))

        shas = []
        if tmp_paths:
            payload = "\n".join(p.replace("\\", "/") for p in tmp_paths) + "\n"
            out = g.rw_out(self.repo(target), "hash-object", "-w",
                           "--stdin-paths", stdin_bytes=payload.encode("utf-8"))
            shas = [l.strip() for l in out.splitlines() if l.strip()]
        if len(shas) != len(staged):
            raise gitio.GitError("hash-object returned %d ids for %d files"
                                 % (len(shas), len(staged)))

        lines = []
        for (mode, _tp, rel), sha in zip(staged, shas):
            lines.append("%s %s\t%s" % (mode, sha, rel))
        for rel in deleted:
            lines.append("%s %s\t%s" % ("0", NULL_SHA, rel.strip()))
        if lines:
            g.rw(self.repo(target), "update-index", "--index-info",
                 index_file=idx, check=True,
                 stdin_bytes=("\n".join(lines) + "\n").encode("utf-8"))
        for tp in tmp_paths:
            try:
                os.remove(tp)
            except OSError:
                pass

        tree = g.rw_out(self.repo(target), "write-tree",
                        index_file=idx).strip()
        info = {"head": head, "modified": len(staged),
                "deleted": len(deleted), "mirror_tree": tree,
                "cached": False}
        try:
            self.cache_put(key, target, -1, "dev-mirror", tree)
        except Exception:
            pass
        self._dev_mirror[target] = info
        self.timings["dev_mirror"] = self.timings.get("dev_mirror", 0) + \
            int((time.time() - t0) * 1000)
        return info

    # -- what the harness does NOT look at ----------------------------------

    def pristine_untracked(self, target):
        """Untracked files sitting in the PRISTINE target's working tree.

        The harness reads commit trees only, so these cannot affect any
        verdict it computes -- but a literal 'xash.bat' run does touch that
        working tree, and 'git apply' stops with 'already exists in working
        directory' on the first new-file patch whose file is already there.
        Reporting them is how the tool says what it did not look at.
        """
        wt = self.cfg.pristine_worktree(target)
        try:
            rc, out, _ = self.git.ro(wt, "ls-files", "-o",
                                     "--exclude-standard")
        except Exception:
            return None
        if rc != 0:
            return None
        return [l.strip() for l in out.splitlines() if l.strip()]

    # -- the three-way arena ------------------------------------------------

    def arena(self, target, tree):
        """A real worktree at <tree>, for the one probe that needs one.

        git apply --cached --3way is refused outright ('cannot be used
        together', rc 128), so the three-way probe needs files on disk. It is
        lazy: only a link that fails plain ever builds one.
        """
        self.ensure_repo(target)
        d = os.path.join(self.arena_dir, target)
        if not os.path.isdir(os.path.join(d, ".git")):
            gitio.rmtree_force(d)
            os.makedirs(self.arena_dir, exist_ok=True)
            self.git.clone_shared(self.repo(target), d)
            alt = os.path.join(d, ".git", "objects", "info", "alternates")
            with open(alt, "ab") as fh:
                fh.write((os.path.join(self.repo(target), ".git", "objects")
                          .replace("\\", "/") + "\n").encode("ascii"))
            self.git.rw(d, "remote", "remove", "origin")
            for k, v in (("core.autocrlf", "false"), ("core.eol", "lf"),
                         ("gc.auto", "0"), ("core.fileMode", "false")):
                self.git.rw(d, "config", k, v)
        self.git.rw(d, "read-tree", "--reset", "-u", tree, check=True)
        self.git.rw(d, "checkout-index", "-a", "-f")
        self.git.rw(d, "update-index", "-q", "--refresh")
        return d

    def materialize_worktree(self, target, tree, dest, force=False):
        """Write a tree out as ordinary files for a human or an agent.

        Three refusals, and --force waives only the first:
          - the destination is not empty (that is what --force is for),
          - it is inside a protected root,
          - it is inside SOMEBODY ELSE'S git repository.
        The third is the one --force used to get past: 718 files written over
        an unrelated clone, a tracked file overwritten, 94 dirty entries. A
        destination under the work area is exempt, because that is ours.
        """
        dest = os.path.abspath(dest)
        for p in self.cfg.protected_roots:
            if gitio.is_under(dest, p):
                raise gitio.Refusal(
                    "refusing to write a worktree inside protected root '%s'"
                    % p)
        if not gitio.is_under(dest, self.root):
            owner = gitio.enclosing_git(dest)
            if owner and not gitio.is_under(owner, self.root):
                raise gitio.Refusal(
                    "refusing to write a worktree into '%s': it is inside the "
                    "git repository at '%s', and checking files out over "
                    "somebody else's working tree is not something --force "
                    "covers. Name a directory that is not in a repository, or "
                    "one under the work area '%s'."
                    % (dest, owner, self.root))
        if os.path.isdir(dest) and os.listdir(dest) and not force:
            raise gitio.Refusal(
                "%s is not empty; pass --force to overwrite it" % dest)
        os.makedirs(dest, exist_ok=True)
        idx = os.path.join(self.tmp_dir, "mat-%s.idx" % target)
        os.makedirs(self.tmp_dir, exist_ok=True)
        if os.path.isfile(idx):
            os.remove(idx)
        self.git.rw(self.repo(target), "read-tree", tree, index_file=idx,
                    check=True)
        self.git.rw(self.repo(target), "checkout-index", "-a", "-f",
                    "--prefix=" + dest.replace("\\", "/").rstrip("/") + "/",
                    index_file=idx, check=True)
        return dest
