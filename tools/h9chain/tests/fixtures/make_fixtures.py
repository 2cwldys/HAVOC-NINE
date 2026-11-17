"""Build synthetic repositories for the offline tests.

A fixture is a miniature of the real arrangement: a superproject whose HEAD
carries a gitlink for 'xash3d-fwgs', a pristine clone of that commit beside
it, a dev clone with the chain's content committed, a patches directory and
a synthetic xash.bat. Nothing here touches a real repository and nothing
here needs the network.
"""

import os
import shutil
import stat
import subprocess
import sys

ENV = dict(os.environ)
ENV.update({
    "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "echo", "GIT_PAGER": "cat",
    "GIT_CONFIG_NOSYSTEM": "1", "LC_ALL": "C",
    "GIT_AUTHOR_NAME": "h9chain tests", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "h9chain tests",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
    "GIT_AUTHOR_DATE": "2020-01-01T00:00:00+0000",
    "GIT_COMMITTER_DATE": "2020-01-01T00:00:00+0000",
})
ENV.pop("GIT_INDEX_FILE", None)


def git(repo, *args, **kw):
    p = subprocess.run(["git", "-C", str(repo)] + [str(a) for a in args],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       stdin=subprocess.DEVNULL, env=ENV)
    if kw.get("check", True) and p.returncode != 0:
        raise RuntimeError("git %s failed in %s: %s"
                           % (args[0], repo,
                              p.stderr.decode("utf-8", "replace")))
    return p.returncode, p.stdout.decode("utf-8", "replace")


def rmtree(path):
    def onerror(func, p, _exc):
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


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(text.encode("ascii"))


def init(repo):
    os.makedirs(repo, exist_ok=True)
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "h9chain tests")
    git(repo, "config", "user.email", "t@example.invalid")
    git(repo, "config", "core.autocrlf", "false")
    git(repo, "config", "core.eol", "lf")
    git(repo, "config", "commit.gpgsign", "false")
    return repo


BASE_A = "\n".join([
    "// base file a",
    "#include <stdio.h>",
    "",
    "static int counter = 0;",
    "",
    "void a_init( void )",
    "{",
    "\tcounter = 0;",
    "}",
    "",
    "void a_step( void )",
    "{",
    "\tcounter++;",
    "}",
    "",
    "int a_value( void )",
    "{",
    "\treturn counter;",
    "}",
    "",
]) + ""

BASE_B = "\n".join([
    "// base file b",
    "void b_one( void ) {}",
    "void b_two( void ) {}",
    "void b_three( void ) {}",
    "",
])


class Fixture(object):
    """One synthetic world under <root>."""

    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.super = os.path.join(self.root, "super")
        self.pristine_src = os.path.join(self.root, "pristine-src")
        self.engine = os.path.join(self.super, "xash3d-fwgs")
        self.dev = os.path.join(self.root, "dev", "xash3d-fwgs")
        self.patches = os.path.join(self.root, "patches")
        self.bat = os.path.join(self.root, "xash.bat")
        self.work = os.path.join(self.root, "work")
        self.links = []          # patch file names, in chain order

    # -- construction ---------------------------------------------------

    def build_base(self, files=None):
        rmtree(self.root)
        os.makedirs(self.root, exist_ok=True)
        init(self.pristine_src)
        files = files or {"src/a.c": BASE_A, "src/b.c": BASE_B}
        for rel, text in files.items():
            write(os.path.join(self.pristine_src, rel), text)
        git(self.pristine_src, "add", "-A")
        git(self.pristine_src, "commit", "-q", "-m", "base")
        _rc, out = git(self.pristine_src, "rev-parse", "HEAD")
        self.base_commit = out.strip()

        init(self.super)
        write(os.path.join(self.super, "README"), "superproject\n")
        git(self.super, "add", "-A")
        git(self.super, "commit", "-q", "-m", "super")
        # A gitlink, written by hand: the fixture needs the pointer, not the
        # whole submodule apparatus.
        git(self.super, "update-index", "--add", "--cacheinfo",
            "160000,%s,xash3d-fwgs" % self.base_commit)
        git(self.super, "commit", "-q", "-m", "pin the engine")

        git(self.root, "init", "-q", check=False)
        subprocess.run(["git", "clone", "-q", self.pristine_src, self.engine],
                       env=ENV, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        git(self.engine, "config", "core.autocrlf", "false")
        os.makedirs(os.path.dirname(self.dev), exist_ok=True)
        subprocess.run(["git", "clone", "-q", self.pristine_src, self.dev],
                       env=ENV, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        git(self.dev, "config", "core.autocrlf", "false")
        os.makedirs(self.patches, exist_ok=True)

    # -- the dev side ---------------------------------------------------

    def dev_edit(self, rel, text, commit=True, message="dev change"):
        write(os.path.join(self.dev, rel), text)
        if commit:
            git(self.dev, "add", "-A")
            git(self.dev, "commit", "-q", "-m", message)

    def dev_read(self, rel):
        with open(os.path.join(self.dev, rel), "rb") as fh:
            return fh.read().decode("ascii")

    # -- patches --------------------------------------------------------

    def make_patch(self, name, edits, after=None):
        """Generate a patch from the dev repo by applying <edits> to the
        state produced by the chain so far, then diffing."""
        scratch = os.path.join(self.root, "scratch")
        rmtree(scratch)
        subprocess.run(["git", "clone", "-q", self.pristine_src, scratch],
                       env=ENV, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        git(scratch, "config", "core.autocrlf", "false")
        for prev in (after if after is not None else self.links):
            git(scratch, "apply", os.path.join(self.patches, prev))
        git(scratch, "add", "-A")
        git(scratch, "commit", "-q", "-m", "prefix", check=False)
        for rel, text in edits.items():
            write(os.path.join(scratch, rel), text)
        git(scratch, "add", "-A")
        _rc, out = git(scratch, "-c", "core.abbrev=7", "diff", "--cached",
                       "--no-renames", "-U3")
        write(os.path.join(self.patches, name), out)
        rmtree(scratch)
        return os.path.join(self.patches, name)

    def wire(self, *names):
        for n in names:
            if n not in self.links:
                self.links.append(n)
        self.write_bat()

    def unwire(self, name):
        self.links = [n for n in self.links if n != name]
        self.write_bat()

    def write_bat(self):
        lines = [
            "@echo off",
            "REM synthetic xash.bat for the h9chain tests",
            'set "FWGS=%TSM%\\xash3d-fwgs"',
            'set "XASH=%TSM%\\xash3d-h9-patches"',
            'echo   engine-h9-decoy.patch is only mentioned here, never '
            'called',
            'if exist "%FWGS%\\.git" (',
        ]
        for n in self.links:
            lines.append('    call :patch "%%FWGS%%" "%%XASH%%\\patches\\%s"'
                         ' || exit /b 1' % n)
        lines += [")", "", ":patch", "exit /b 0", ""]
        write(self.bat, "\r\n".join(lines))

    def args(self):
        return ["--repo-root", self.super,
                "--xash-bat", self.bat,
                "--patches-dir", self.patches,
                "--web-dir", os.path.join(self.root, "web-unused"),
                "--dev-root", self.dev,
                "--work", self.work]
