"""Git process chokepoints.

Two functions reach git: git_ro (read-only verbs, any path) and git_rw
(anything, but only inside the work root). There is no third. No flag,
environment variable or config key relaxes this.

Both also validate the destination of any command that writes files through a
flag rather than through the repository path: 'checkout-index --prefix=DIR'
writes DIR, not the repo, so validating the repo alone is not enough (that was
how 'tree --worktree --force' reached an unrelated git repository).
"""

import os
import subprocess
import sys

TIMEOUT_DEFAULT = 120

# Verbs git_ro will run against a path outside the work root. Everything that
# can write an object, a ref, an index or a working tree is absent on purpose,
# and so is everything that can refresh a real index as a side effect:
# 'status' and 'diff' are safe here only because GIT_OPTIONAL_LOCKS=0 is set,
# which is a property of the environment and not of the rail, so neither is on
# this list. Nothing in the tool needs them.
RO_VERBS = frozenset([
    "rev-parse", "cat-file", "ls-files", "ls-tree", "diff-tree", "config",
    "var", "version",
])

# Flags that turn a read-only verb into a writing one.
RO_FORBIDDEN_FLAGS = frozenset([
    "-w", "--write", "--add", "--unset", "--unset-all", "--replace-all",
    "--edit", "--index", "--cached-write",
])

# Flags whose value is a path git WRITES, wherever the repository lives.
SINK_FLAGS = ("--prefix=", "--output=", "--output-directory=",
              "--separate-git-dir=")


class Refusal(Exception):
    """A safety rail fired. The caller turns this into exit 4."""


class GitError(Exception):
    """git failed where the caller required success."""


def norm(path):
    """realpath + normcase, the only form paths are compared in."""
    return os.path.normcase(os.path.realpath(os.path.abspath(str(path))))


def is_under(child, parent):
    c = norm(child)
    p = norm(parent)
    if c == p:
        return True
    if not p.endswith(os.sep):
        p = p + os.sep
    return c.startswith(p)


def enclosing_git(path):
    """The nearest directory at or above <path> that holds a .git, or None.

    Used to refuse writing a materialized worktree on top of somebody else's
    repository: the destination being outside the protected roots is not
    enough, as an unrelated clone can sit anywhere.
    """
    cur = os.path.abspath(str(path))
    seen = set()
    while cur and cur not in seen:
        seen.add(cur)
        if os.path.exists(os.path.join(cur, ".git")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent
    return None


def base_env(index_file=None, extra=None):
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_ASKPASS"] = "echo"
    env["GIT_PAGER"] = "cat"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    # GIT_INDEX_FILE is set explicitly or removed; it is never inherited.
    env.pop("GIT_INDEX_FILE", None)
    if index_file:
        env["GIT_INDEX_FILE"] = str(index_file)
    if extra:
        env.update(extra)
    return env


class Git(object):
    """Holds the policy state the two chokepoints consult."""

    def __init__(self, work_root, protected_roots, timeout=TIMEOUT_DEFAULT,
                 verbose=0, log=None):
        self.work_root = norm(work_root)
        self.protected = [norm(p) for p in protected_roots]
        self.timeout = timeout
        self.verbose = verbose
        self.calls = 0
        self.log = log

    # -- the two chokepoints ------------------------------------------------

    # -- destination validation --------------------------------------------

    def check_sinks(self, args):
        """Refuse any --prefix=/--output= destination inside a protected root.

        git writes that path, not the repository path, so the repo check does
        not cover it.
        """
        for a in args:
            s = str(a)
            for flag in SINK_FLAGS:
                if not s.startswith(flag):
                    continue
                dest = s[len(flag):].strip('"')
                if not dest:
                    continue
                for p in self.protected:
                    if is_under(dest, p):
                        raise Refusal(
                            "refused: %s would write '%s', which is inside "
                            "protected root '%s'" % (flag.rstrip('='), dest, p))

    def ro(self, repo, *args, **kw):
        """Read-only git against any path, including a protected root."""
        if not args:
            raise Refusal("git_ro called with no verb")
        self.check_sinks(args)
        verb = args[0]
        if verb.startswith("--"):
            # Allow a leading --git-dir=/--work-tree= pair, then re-check.
            rest = [a for a in args if not a.startswith("--git-dir")
                    and not a.startswith("--work-tree")]
            verb = rest[0] if rest else ""
        if verb not in RO_VERBS:
            raise Refusal(
                "git_ro refuses verb '%s'; only %s may run outside the work "
                "root" % (verb, ",".join(sorted(RO_VERBS))))
        if verb == "config":
            if not any(a in ("--get", "--get-all", "--get-regexp", "--list")
                       for a in args):
                raise Refusal("git_ro refuses 'config' without --get/--list")
        for a in args[1:]:
            if a in RO_FORBIDDEN_FLAGS:
                raise Refusal("git_ro refuses flag '%s' on verb '%s'"
                              % (a, verb))
        return self._run(repo, args, **kw)

    def rw(self, repo, *args, **kw):
        """Any git verb, but the repository must live under the work root."""
        self.check_sinks(args)
        if not is_under(repo, self.work_root):
            raise Refusal(
                "git_rw refused: '%s' is not under the work root '%s'. "
                "Nothing outside the work area is ever written."
                % (repo, self.work_root))
        for p in self.protected:
            if is_under(repo, p):
                raise Refusal(
                    "git_rw refused: '%s' is inside protected root '%s'"
                    % (repo, p))
        return self._run(repo, args, **kw)

    # -- plumbing -----------------------------------------------------------

    def _run(self, repo, args, index_file=None, cwd=None, env_extra=None,
             check=False, timeout=None, stdin_bytes=None):
        cmd = ["git"]
        if repo is not None:
            cmd += ["-C", str(repo)]
        cmd += [str(a) for a in args]
        env = base_env(index_file, env_extra)
        self.calls += 1
        if self.verbose >= 2 and self.log:
            self.log("git " + " ".join(cmd[1:]))
        try:
            kw = {"input": stdin_bytes} if stdin_bytes is not None \
                else {"stdin": subprocess.DEVNULL}
            p = subprocess.run(
                cmd, cwd=cwd, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=timeout or self.timeout, **kw)
        except subprocess.TimeoutExpired:
            raise GitError("git timed out after %ss: %s"
                           % (timeout or self.timeout, " ".join(cmd[1:])))
        except FileNotFoundError:
            raise GitError("git is not on PATH")
        out = p.stdout.decode("utf-8", "replace")
        err = p.stderr.decode("utf-8", "replace")
        if check and p.returncode != 0:
            raise GitError("git %s failed (rc=%d)\n%s%s"
                           % (" ".join(str(a) for a in args), p.returncode,
                              out, err))
        return p.returncode, out, err

    def clone_shared(self, src, dst):
        """clone --shared --no-checkout; writes only into dst.

        'git worktree add' is never used against anything real: it writes six
        files into the source .git. clone --shared does not touch the source.
        """
        if not is_under(dst, self.work_root):
            raise Refusal("clone refused: destination '%s' is not under the "
                          "work root '%s'" % (dst, self.work_root))
        for p in self.protected:
            if is_under(dst, p):
                raise Refusal("clone refused: destination '%s' is inside "
                              "protected root '%s'" % (dst, p))
        return self._run(None, ["clone", "-q", "--shared", "--no-checkout",
                                str(src), str(dst)], check=True)

    # -- convenience --------------------------------------------------------

    def ro_out(self, repo, *args):
        rc, out, err = self.ro(repo, *args)
        if rc != 0:
            raise GitError("git %s failed in %s (rc=%d): %s"
                           % (args[0], repo, rc, err.strip()))
        return out

    def rw_out(self, repo, *args, **kw):
        rc, out, err = self.rw(repo, *args, **kw)
        if rc != 0:
            raise GitError("git %s failed in %s (rc=%d): %s"
                           % (args[0], repo, rc, err.strip()))
        return out


def git_version(timeout=30):
    try:
        p = subprocess.run(["git", "--version"], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout,
                           stdin=subprocess.DEVNULL, env=base_env())
    except Exception:
        return ""
    return p.stdout.decode("utf-8", "replace").strip()


def git_version_short(vstr=None):
    """Just the number, for display and the JSON envelope. The cache key
    keeps the raw string, so changing this does not invalidate it."""
    v = vstr if vstr is not None else git_version()
    return v.replace("git version", "").strip()


def version_tuple(vstr):
    parts = vstr.replace("git version", "").strip().split(".")
    out = []
    for p in parts[:3]:
        digits = ""
        for ch in p:
            if ch.isdigit():
                digits += ch
            else:
                break
        out.append(int(digits) if digits else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out)


def rmtree_force(path):
    """shutil.rmtree with the read-only pack-file retry Windows needs."""
    import shutil
    import stat

    def onerror(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass

    if os.path.isdir(path):
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=lambda f, p, e: onerror(f, p, e))
        else:
            shutil.rmtree(path, onerror=onerror)
