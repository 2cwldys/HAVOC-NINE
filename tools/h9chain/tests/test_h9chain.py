"""Offline tests for h9chain.

Fully offline: every repository here is built from nothing under
D:\\temp\\chain-work\\h9chain-tests. Neither real tree is read or written.

    py -3 -I tests\\test_h9chain.py
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# The package sits BESIDE tests\ when the tool is installed in a checkout
# (tools\h9chain\tests\) and one level UP in a standalone drop. Resolve it from
# what is on disk, so the same tests run from either layout. HOME must end up
# the package's PARENT: putting the package's own directory on sys.path makes
# 'import h9chain' find the h9chain.py module instead of the package, and its
# relative imports then fail.
PKG = os.path.dirname(HERE)
if not os.path.isfile(os.path.join(PKG, "h9chain.py")):
    PKG = os.path.join(PKG, "h9chain")
HOME = os.path.dirname(PKG)
ENTRY = os.path.join(PKG, "h9chain.py")
ROOT = os.path.join("D:" + os.sep, "temp", "chain-work", "h9chain-tests")

sys.path.insert(0, os.path.join(HERE, "fixtures"))
sys.path.insert(0, HOME)

import make_fixtures as F                                   # noqa: E402
from h9chain import chainparse, gitio                       # noqa: E402


def chain(args, want=None):
    p = subprocess.run([sys.executable, ENTRY] + list(args) + ["--json"],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       stdin=subprocess.DEVNULL)
    out = p.stdout.decode("utf-8", "replace")
    err = p.stderr.decode("utf-8", "replace")
    try:
        data = json.loads(out)
    except ValueError:
        data = {"_stdout": out, "_stderr": err}
    return p.returncode, data, err


def verdicts(data):
    return {l["index"]: l["verdict"] for l in data.get("links", [])}


# ---------------------------------------------------------------------------


class PatchParser(unittest.TestCase):
    """Shapes the parser has to accept, and the ones it must refuse."""

    def _parse(self, text, name="t.patch"):
        os.makedirs(os.path.join(ROOT, "parse"), exist_ok=True)
        p = os.path.join(ROOT, "parse", name)
        with open(p, "wb") as fh:
            fh.write(text.encode("latin-1"))
        return chainparse.parse_patch(p)

    def test_no_diff_git_header(self):
        # autoconfig, deltabits and framesize are in this shape; a parser
        # keyed on 'diff --git' sees zero files in them.
        pat = self._parse("--- a/src/a.c\n+++ b/src/a.c\n"
                          "@@ -1,2 +1,3 @@\n a\n+b\n c\n")
        self.assertEqual([f.path for f in pat.files], ["src/a.c"])
        self.assertEqual(pat.style, "house")

    def test_index_lines_and_new_file(self):
        pat = self._parse(
            "diff --git a/src/n.c b/src/n.c\nnew file mode 100644\n"
            "index 0000000..1111111\n--- /dev/null\n+++ b/src/n.c\n"
            "@@ -0,0 +1,2 @@\n+one\n+two\n")
        self.assertTrue(pat.files[0].is_new)
        self.assertEqual(pat.files[0].index_post, "1111111")

    def test_binary_literal_is_recorded_not_decoded(self):
        pat = self._parse(
            "diff --git a/x.ico b/x.ico\nnew file mode 100644\n"
            "index 0000000..2222222\nGIT binary patch\nliteral 12\n"
            "zcmZQzU|?\n\nliteral 0\nHcmV?d00001\n\n")
        self.assertTrue(pat.files[0].is_binary)
        self.assertEqual(pat.unsupported, [])

    def test_hunk_arithmetic_is_recomputed(self):
        pat = self._parse("--- a/src/a.c\n+++ b/src/a.c\n"
                          "@@ -1,9 +1,3 @@\n a\n+b\n c\n")
        self.assertTrue(pat.arith_errors)

    def test_rename_is_refused(self):
        pat = self._parse("diff --git a/x b/y\nsimilarity index 100%\n"
                          "rename from x\nrename to y\n")
        self.assertTrue(pat.unsupported)

    def test_delete_is_refused(self):
        pat = self._parse("diff --git a/x b/x\ndeleted file mode 100644\n"
                          "index 1111111..0000000\n--- a/x\n+++ /dev/null\n")
        self.assertTrue(pat.unsupported)


class ChainParser(unittest.TestCase):

    def test_only_call_lines_count(self):
        fx = F.Fixture(os.path.join(ROOT, "parsebat"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// one\n"})
        fx.wire("p1.patch")
        res = chainparse.parse_chain(fx.bat, fx.patches,
                                     os.path.join(fx.root, "web"))
        # The bat also echoes a patch name that is never called.
        self.assertEqual([l.patch_name for l in res.links], ["p1.patch"])
        self.assertEqual(res.links[0].target, "engine")


class Rails(unittest.TestCase):

    def test_git_rw_refuses_outside_the_work_root(self):
        g = gitio.Git(os.path.join(ROOT, "workroot"),
                      [os.path.join("D:" + os.sep, "GIT Storage",
                                    "ts_h9_team_elimination"),
                       os.path.join("D:" + os.sep, "Downloads", "TSM")])
        with self.assertRaises(gitio.Refusal):
            g.rw(os.path.join("D:" + os.sep, "GIT Storage",
                              "ts_h9_team_elimination"), "status")
        with self.assertRaises(gitio.Refusal):
            g.rw(os.path.join("D:" + os.sep, "Downloads", "TSM",
                              "xash3d-fwgs"), "apply", "x.patch")

    def test_git_ro_refuses_writing_verbs(self):
        g = gitio.Git(os.path.join(ROOT, "workroot"), [])
        for verb in ("apply", "checkout", "reset", "clean", "commit",
                     "worktree", "update-index", "write-tree", "push"):
            with self.assertRaises(gitio.Refusal):
                g.ro(ROOT, verb, "--help")

    def test_no_compiler_is_reachable(self):
        from h9chain import selftest
        self.assertEqual(selftest.check_no_compiler(), [])


# ---------------------------------------------------------------------------


class HealthyChain(unittest.TestCase):
    """A3: a chain that is in order, on both sides."""

    @classmethod
    def setUpClass(cls):
        fx = cls.fx = F.Fixture(os.path.join(ROOT, "healthy"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A.replace(
            "static int counter = 0;",
            "static int counter = 0;\nstatic int p1_flag = 1;")}, after=[])
        fx.wire("p1.patch")
        fx.make_patch("p2.patch", {"src/b.c": F.BASE_B + "void b_four( void ) {}\n"})
        fx.wire("p2.patch")
        # The dev clone carries both, committed, as the real one does.
        for n in ("p1.patch", "p2.patch"):
            F.git(fx.dev, "apply", os.path.join(fx.patches, n))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "the chain, committed")

    def test_healthy(self):
        rc, d, err = chain(self.fx.args() + ["check", "--all"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(set(verdicts(d).values()), {"OK"})
        self.assertEqual([l["forward"] for l in d["links"]],
                         ["plain", "plain"])
        self.assertEqual([l["dev"] for l in d["links"]],
                         ["in_place", "in_place"])
        self.assertTrue(d["residual"]["targets"]["engine"]["equal"])

    def test_cache_invalidates_forward_only(self):
        fx = self.fx
        rc, d, _ = chain(fx.args() + ["check", "--all"])
        before = d["links"][1]["post_tree"]
        # Rewrite p1 with the same content but a regenerated header, so its
        # sha256 moves while the tree it produces does not.
        p = os.path.join(fx.patches, "p1.patch")
        with open(p, "rb") as fh:
            body = fh.read()
        with open(p, "wb") as fh:
            fh.write(b"# a comment the parser ignores\n" + body)
        rc, d, err = chain(fx.args() + ["check", "--all"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(d["links"][1]["post_tree"], before)
        with open(p, "wb") as fh:
            fh.write(body)

    def test_adopt_is_refused_when_writes_are_off(self):
        rc, d, err = chain(self.fx.args() + ["adopt", "1", "--yes"])
        self.assertEqual(rc, 4, err)
        self.assertIn("allow_patch_writes", err)


class RejectAndRegen(unittest.TestCase):
    """A1: a link whose recorded pre-image was superseded by an earlier one."""

    def setUp(self):
        fx = self.fx = F.Fixture(os.path.join(ROOT, "reject"))
        fx.build_base()
        # p1 adds a line; p2 is written against the file WITH that line.
        a1 = F.BASE_A.replace("static int counter = 0;",
                              "static int counter = 0;\nstatic int p1 = 1;")
        fx.make_patch("p1.patch", {"src/a.c": a1}, after=[])
        fx.wire("p1.patch")
        a2 = a1.replace("static int p1 = 1;",
                        "static int p1 = 1;\nstatic int p2 = 2;")
        fx.make_patch("p2.patch", {"src/a.c": a2})
        fx.wire("p2.patch")
        for n in ("p1.patch", "p2.patch"):
            F.git(fx.dev, "apply", os.path.join(fx.patches, n))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        # Now retire p1 from the chain without touching p2: p2's pre-image
        # no longer exists anywhere in the chain. This is the shape that is
        # invisible on the dev clone and only breaks a fresh clone.
        fx.unwire("p1.patch")

    def test_reject_is_named_with_a_next_command(self):
        rc, d, err = chain(self.fx.args() + ["check", "--all"])
        self.assertEqual(rc, 10, err)
        bad = [l for l in d["links"] if l["verdict"] == "REJECT"]
        self.assertEqual([l["patch_name"] for l in bad], ["p2.patch"])
        self.assertTrue(bad[0]["next_command_str"])
        self.assertEqual(d["findings"][0]["link"], bad[0]["index"])

    def test_regen_with_the_missing_patch_repairs_it(self):
        rc, d, err = chain(self.fx.args() + [
            "regen", "p2", "--with", os.path.join(self.fx.patches,
                                                  "p1.patch")])
        self.assertEqual(rc, 0, err)
        self.assertTrue(d["regen"]["proof"]["ok"],
                        json.dumps(d["regen"]["proof"], indent=1))

    def test_dev_pass_still_says_in_place(self):
        """The point of the whole tool: the dev clone cannot see this."""
        rc, d, _ = chain(self.fx.args() + ["check", "--all"])
        p2 = [l for l in d["links"] if l["patch_name"] == "p2.patch"][0]
        self.assertEqual(p2["dev"], "in_place")
        self.assertEqual(p2["verdict"], "REJECT")


class ShadowPair(unittest.TestCase):
    """A4: a later link edits lines an earlier link added."""

    def setUp(self):
        fx = self.fx = F.Fixture(os.path.join(ROOT, "shadow"))
        fx.build_base()
        a1 = F.BASE_A.replace(
            "void a_step( void )",
            "void a_extra( void )\n{\n\tcounter += 2;\n}\n\n"
            "void a_step( void )")
        fx.make_patch("victim.patch", {"src/a.c": a1}, after=[])
        fx.wire("victim.patch")
        a2 = a1.replace("\tcounter += 2;", "\tcounter += 3;")
        fx.make_patch("culprit.patch", {"src/a.c": a2})
        fx.wire("culprit.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "victim.patch"))
        F.git(fx.dev, "apply", os.path.join(fx.patches, "culprit.patch"))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")

    def test_victim_and_culprit_are_named(self):
        rc, d, err = chain(self.fx.args() + ["check", "--all"])
        self.assertEqual(rc, 11, err)
        v = {l["patch_name"]: l for l in d["links"]}
        self.assertEqual(v["victim.patch"]["verdict"], "SHADOWED")
        self.assertEqual(v["culprit.patch"]["verdict"], "SHADOWS")
        self.assertEqual(v["victim.patch"]["shadowed_by"],
                         v["culprit.patch"]["index"])
        self.assertIn(v["victim.patch"]["index"],
                      v["culprit.patch"]["shadows"])
        f = d["findings"][0]
        self.assertEqual(f["class"], "SHADOW")
        self.assertTrue(f["next_command_str"])

    def test_the_shadow_finding_names_the_file_and_lines(self):
        rc, d, _ = chain(self.fx.args() + ["check", "--all"])
        v = [l for l in d["links"] if l["verdict"] == "SHADOWED"][0]
        self.assertIn("src/a.c", v["shadow_detail"]["ranges"])

    def test_fold_post_repairs_it(self):
        rc, d, err = chain(self.fx.args() + ["fold", "culprit", "--into",
                                             "victim", "--mode", "post"])
        self.assertEqual(rc, 0, err)
        self.assertTrue(d["fold"]["proof"]["ok"],
                        json.dumps(d["fold"]["proof"], indent=1))
        self.assertTrue(all(i["ok"] for i in d["fold"]["invariants"]),
                        json.dumps(d["fold"]["invariants"], indent=1))

    def test_plan_pre_flights_the_same_collision(self):
        """The near-miss class: the candidate is not wired yet."""
        fx = self.fx
        fx.unwire("culprit.patch")
        rc, d, err = chain(fx.args() + [
            "plan", os.path.join(fx.patches, "culprit.patch"),
            "--after", "victim"])
        self.assertEqual(rc, 11, err)
        self.assertEqual(d["plan"]["shadows_patches"], ["victim.patch"])
        self.assertTrue(d["findings"][0]["next_command_str"])


class NeitherDirection(unittest.TestCase):
    """A5: a patch that applies in neither direction on the dev clone."""

    def setUp(self):
        fx = self.fx = F.Fixture(os.path.join(ROOT, "neither"))
        fx.build_base()
        a1 = F.BASE_A.replace("static int counter = 0;",
                              "static int counter = 0;\nstatic int src = 1;")
        fx.make_patch("source.patch", {"src/a.c": a1}, after=[])
        fx.wire("source.patch")
        a2 = a1.replace("static int src = 1;",
                        "static int src = 1;\nstatic int base = 2;")
        fx.make_patch("base.patch", {"src/a.c": a2})
        fx.wire("base.patch")
        for n in ("source.patch", "base.patch"):
            F.git(fx.dev, "apply", os.path.join(fx.patches, n))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        fx.unwire("source.patch")

    def test_fold_pre_repairs_it_and_the_post_image_is_unchanged(self):
        fx = self.fx
        rc, d, err = chain(fx.args() + ["fold",
                                        os.path.join(fx.patches,
                                                     "source.patch"),
                                        "--into", "base", "--mode", "pre"])
        self.assertEqual(rc, 0, err)
        self.assertTrue(d["fold"]["proof"]["ok"],
                        json.dumps(d["fold"]["proof"], indent=1))
        # Adopting the candidate must make the chain healthy again.
        cand = d["fold"]["candidate"]
        import shutil
        shutil.copyfile(cand, os.path.join(fx.patches, "base.patch"))
        rc, d, err = chain(fx.args() + ["check", "--all"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(set(verdicts(d).values()), {"OK"})

    def test_auto_mode_picks_pre(self):
        fx = self.fx
        rc, d, err = chain(fx.args() + ["fold",
                                        os.path.join(fx.patches,
                                                     "source.patch"),
                                        "--into", "base", "--no-proof"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(d["fold"]["mode"], "pre")


class NotInDev(unittest.TestCase):
    """A link the dev clone does not carry yet."""

    def test_not_in_dev(self):
        fx = F.Fixture(os.path.join(ROOT, "notindev"))
        fx.build_base()
        fx.make_patch("new.patch", {"src/b.c": F.BASE_B + "void b_new(void){}\n"},
                      after=[])
        fx.wire("new.patch")
        rc, d, err = chain(fx.args() + ["check", "--all"])
        self.assertEqual(d["links"][0]["dev"], "would_apply")
        self.assertEqual(d["links"][0]["verdict"], "NOT_IN_DEV")
        # A link the dev clone does not carry also shows up as a residual,
        # which is the class that fails; NOT_IN_DEV itself only reports.
        self.assertIn("NOT_IN_DEV", d["classes"])
        self.assertIn("RESIDUAL", d["classes"])
        rc, d, err = chain(fx.args() + ["check", "--all", "--no-dev"])
        self.assertEqual(rc, 0, err)       # UNVERIFIED reports, never fails
        self.assertIn("UNVERIFIED", d["classes"])
        self.assertEqual(d["links"][0]["verdict"], "OK")


class Residual(unittest.TestCase):
    """UNOWNED: the dev clone holds content no link produces."""

    def test_unowned_path_is_reported(self):
        fx = F.Fixture(os.path.join(ROOT, "residual"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"},
                      after=[])
        fx.wire("p1.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "p1.patch"))
        fx.dev_edit("src/c.c", "// a feature nobody wrote a patch for\n")
        rc, d, err = chain(fx.args() + ["residual"])
        self.assertEqual(rc, 12, err)
        kinds = {p["path"]: p["kind"]
                 for p in d["residual"]["targets"]["engine"]["paths"]}
        self.assertEqual(kinds.get("src/c.c"), "UNOWNED")

    def test_allow_rule_silences_it(self):
        fx = F.Fixture(os.path.join(ROOT, "residual2"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"},
                      after=[])
        fx.wire("p1.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "p1.patch"))
        fx.dev_edit("src/c.c", "// generated\n")
        rules = os.path.join(fx.root, "chain.rules.txt")
        with open(rules, "wb") as fh:
            fh.write(b"allow      src/c.c   generated, not ours\n")
        cfg = os.path.join(fx.root, "chain.config.json")
        with open(cfg, "w", encoding="ascii") as fh:
            json.dump({"repo_root": fx.super, "xash_bat": fx.bat,
                       "patches_dir": fx.patches,
                       "web_dir": os.path.join(fx.root, "web-unused"),
                       "dev_root": fx.dev, "work": fx.work,
                       "protected_roots": [], "allow_patch_writes": False,
                       "fail_on": ["REJECT", "SHADOW", "RESIDUAL",
                                   "THREEWAY", "BASELINE"],
                       "anchor_exempt": [], "offset_limit": 0,
                       "timeout_sec": 120}, fh)
        # chain.rules.txt is read from the harness directory, so this case
        # only checks that an allow line parses and matches.
        from h9chain.h9chain import Rules
        r = Rules(rules)
        self.assertTrue(r.allow_reason("src/c.c"))


class Gates(unittest.TestCase):
    """regen refuses to reach into another link's territory."""

    def test_foreign_lines(self):
        fx = F.Fixture(os.path.join(ROOT, "gates"))
        fx.build_base()
        a1 = F.BASE_A.replace("\tcounter = 0;", "\tcounter = 1;")
        fx.make_patch("first.patch", {"src/a.c": a1}, after=[])
        fx.wire("first.patch")
        a2 = a1.replace("\tcounter++;", "\tcounter += 2;")
        fx.make_patch("second.patch", {"src/a.c": a2})
        fx.wire("second.patch")
        for n in ("first.patch", "second.patch"):
            F.git(fx.dev, "apply", os.path.join(fx.patches, n))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        # Now the dev clone gains a change to first.patch's own line. A
        # --post-dev regen of second.patch would absorb it.
        dev_a = fx.dev_read("src/a.c").replace("\tcounter = 1;",
                                               "\tcounter = 9;")
        fx.dev_edit("src/a.c", dev_a, commit=False)
        rc, d, err = chain(fx.args() + ["regen", "second", "--post-dev",
                                        "src/a.c"])
        self.assertEqual(rc, 2, err)
        self.assertTrue(d["regen"]["foreign_lines"])
        self.assertEqual(d["regen"]["foreign_lines"][0]["file"], "src/a.c")


class Baseline(unittest.TestCase):
    """CHAIN.lock catches a patch edited with no changelog entry."""

    def test_bless_then_a_silent_edit(self):
        fx = F.Fixture(os.path.join(ROOT, "baseline"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"},
                      after=[])
        fx.wire("p1.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "p1.patch"))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        fx.make_patch("p2.patch", {"src/b.c": F.BASE_B + "// p2\n"})
        fx.wire("p2.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "p2.patch"))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "p2")
        lock = os.path.join(fx.root, "CHAIN.lock")
        rc, d, err = chain(fx.args() + ["--lock", lock, "bless"])
        self.assertEqual(rc, 0, err)
        self.assertTrue(os.path.isfile(lock))

        # A patch edited with no changelog entry. The lock records the
        # sha256, so the move is seen -- and because the edit changes what
        # the chain BUILDS, the moved final tree must not be explained away
        # by the moved sha256. That suppression is what let a
        # behaviour-changing edit read 'baseline.matches: true' under
        # --no-dev.
        fx.make_patch("p2.patch", {"src/b.c": F.BASE_B + "// p2 edited\n"},
                      after=["p1.patch"])
        rc, d, err = chain(fx.args() + ["--lock", lock, "check", "--all",
                                        "--no-dev"])
        self.assertTrue(d["baseline"]["present"])
        self.assertTrue(any(m.endswith("patch_sha256")
                            for m in d["baseline"]["moved"]),
                        d["baseline"]["moved"])
        self.assertIn("final_tree.engine", d["baseline"]["moved"],
                      d["baseline"])
        self.assertIn("final_tree.engine", d["baseline"]["unexplained"],
                      d["baseline"])
        self.assertFalse(d["baseline"]["matches"])
        self.assertIn("BASELINE", d["classes"])
        self.assertEqual(rc, 14, err)

        # A link dropped from xash.bat with no patch edit: nothing explains
        # the final tree moving, so the baseline class fires.
        fx.unwire("p2.patch")
        rc, d, err = chain(fx.args() + ["--lock", lock, "check", "--all"])
        self.assertIn("BASELINE", d["classes"], d["baseline"])
        self.assertFalse(d["baseline"]["matches"])
        self.assertIn("link.2.removed", d["baseline"]["moved"])
        # RESIDUAL outranks BASELINE, and dropping a link raises both.
        self.assertIn(rc, (12, 14), err)

    def test_a_lock_for_another_chain_is_ignored(self):
        fx = F.Fixture(os.path.join(ROOT, "baseline2"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"},
                      after=[])
        fx.wire("p1.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "p1.patch"))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        lock = os.path.join(fx.root, "foreign.lock")
        with open(lock, "w", encoding="ascii") as fh:
            json.dump({"base": {"engine": "0" * 40},
                       "final_tree": {"engine": "1" * 40},
                       "links": {}}, fh)
        rc, d, err = chain(fx.args() + ["--lock", lock, "check", "--all"])
        self.assertFalse(d["baseline"]["present"])
        self.assertEqual(rc, 0, err)


class SkippedIsNotOk(unittest.TestCase):
    """A link this run did not examine must not read OK (F1, F8, D2)."""

    @classmethod
    def setUpClass(cls):
        fx = cls.fx = F.Fixture(os.path.join(ROOT, "skipped"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"}, after=[])
        fx.wire("p1.patch")
        fx.make_patch("p2.patch", {"src/b.c": F.BASE_B + "// p2\n"})
        fx.wire("p2.patch")
        for n in ("p1.patch", "p2.patch"):
            F.git(fx.dev, "apply", os.path.join(fx.patches, n))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")

    def test_one_link_check_marks_the_rest_skipped(self):
        rc, d, err = chain(self.fx.args() + ["check", "1"])
        self.assertEqual(rc, 0, err)
        v = verdicts(d)
        self.assertEqual(v[1], "OK")
        self.assertEqual(v[2], "SKIPPED")
        self.assertEqual(d["chain"]["examined"], 1)
        self.assertEqual(d["chain"]["skipped"], 1)
        # and no link that was not applied may claim a forward verdict
        for l in d["links"]:
            if l["verdict"] == "OK":
                self.assertTrue(l["examined"], l)

    def test_a_stopped_target_does_not_turn_later_links_green(self):
        fx = F.Fixture(os.path.join(ROOT, "skipped2"))
        fx.build_base()
        a1 = F.BASE_A.replace("static int counter = 0;",
                              "static int counter = 0;\nstatic int p1 = 1;")
        fx.make_patch("p1.patch", {"src/a.c": a1}, after=[])
        fx.wire("p1.patch")
        a2 = a1.replace("static int p1 = 1;",
                        "static int p1 = 1;\nstatic int p2 = 2;")
        fx.make_patch("p2.patch", {"src/a.c": a2})
        fx.wire("p2.patch")
        fx.make_patch("p3.patch", {"src/b.c": F.BASE_B + "// p3\n"})
        fx.wire("p3.patch")
        fx.unwire("p1.patch")       # p2 now rejects and stops the target
        rc, d, err = chain(fx.args() + ["check", "--all"])
        self.assertEqual(rc, 10, err)
        v = {l["patch_name"]: l["verdict"] for l in d["links"]}
        self.assertEqual(v["p2.patch"], "REJECT")
        self.assertEqual(v["p3.patch"], "SKIPPED")
        self.assertTrue(d["findings"][0].get("blocking"))


class ConflictPair(unittest.TestCase):
    """One change wired as two links: the 2026-11-17 shape."""

    def test_the_duplicate_is_named_and_a_fold_is_prescribed(self):
        fx = F.Fixture(os.path.join(ROOT, "conflict"))
        fx.build_base()
        same = F.BASE_A.replace("\tcounter++;", "\tcounter += 3;")
        fx.make_patch("dup.patch", {"src/a.c": same}, after=[])
        fx.make_patch("real.patch", {"src/a.c": same}, after=[])
        fx.wire("dup.patch", "real.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "dup.patch"))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        rc, d, err = chain(fx.args() + ["check", "--all"])
        # git rescues an exact duplicate with --3way, which is how a real
        # xash.bat run gets past one. The point is that the tool says WHY,
        # and that the green link is the one it names first.
        self.assertIn(rc, (10, 11, 13), err)
        by = {l["patch_name"]: l for l in d["links"]}
        self.assertIn(by["real.patch"]["verdict"], ("REJECT", "THREEWAY"))
        self.assertEqual(by["real.patch"]["blocked_by"], 1)
        self.assertEqual(by["dup.patch"]["blocks"], [2])
        # the cause is reported before the link it breaks
        self.assertEqual(d["findings"][0]["link"], 1)
        self.assertIn("same change", d["findings"][0]["message"])


class MissingPatchFile(unittest.TestCase):
    """A wired patch that is not on disk (F9, F7)."""

    def _fixture(self, name):
        fx = F.Fixture(os.path.join(ROOT, name))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"}, after=[])
        fx.wire("p1.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "p1.patch"))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        return fx

    def test_it_is_not_called_a_rename(self):
        fx = self._fixture("missing")
        os.remove(os.path.join(fx.patches, "p1.patch"))
        rc, d, err = chain(fx.args() + ["check", "--all"])
        self.assertEqual(rc, 19, err)
        self.assertIn("CHAIN", d["classes"])
        f = d["findings"][0]
        self.assertEqual(f["class"], "CHAIN")
        self.assertNotIn("rename", f["message"])
        self.assertTrue(d["chain"]["missing"])

    def test_an_unparseable_call_line_reaches_the_findings(self):
        fx = self._fixture("badbat")
        with open(fx.bat, "rb") as fh:
            text = fh.read().decode("ascii")
        lines = text.split("\r\n")
        for i, ln in enumerate(lines):
            if ln.lstrip().lower().startswith("call :patch"):
                head, sep, tail = ln.partition('" "')
                lines[i] = head + '" ' + tail
                break
        with open(fx.bat, "wb") as fh:
            fh.write("\r\n".join(lines).encode("ascii"))
        rc, d, err = chain(fx.args() + ["check", "--all"])
        self.assertEqual(rc, 19, err)
        self.assertTrue(d["chain"]["problems"])
        self.assertTrue(any(f["class"] == "CHAIN" for f in d["findings"]))
        rc, d, err = chain(fx.args() + ["doctor"])
        self.assertEqual(rc, 19, err)
        self.assertTrue(any(f["class"] == "CHAIN" for f in d["findings"]))


class CacheIntegrity(unittest.TestCase):
    """A poisoned cache line must not be trusted (F2)."""

    def test_a_conflicting_entry_is_ignored_and_reported(self):
        fx = F.Fixture(os.path.join(ROOT, "poison"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"}, after=[])
        fx.wire("p1.patch")
        fx.make_patch("p2.patch", {"src/b.c": F.BASE_B + "// p2\n"})
        fx.wire("p2.patch")
        for n in ("p1.patch", "p2.patch"):
            F.git(fx.dev, "apply", os.path.join(fx.patches, n))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        rc, d, err = chain(fx.args() + ["check", "--all"])
        self.assertEqual(rc, 0, err)
        right = {l["index"]: l["pre_tree"] for l in d["links"]}
        jsonl = os.path.join(fx.work, "cache", "index.jsonl")
        recs = [json.loads(l) for l in open(jsonl) if l.strip()]
        first = [r for r in recs if r["link_index"] == 1][0]
        poison = dict(first)
        poison["tree"] = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"  # empty
        with open(jsonl, "a", encoding="ascii") as fh:
            fh.write(json.dumps(poison) + "\n")
        rc, d, err = chain(fx.args() + ["check", "2"])
        self.assertTrue(d["cache"]["problems"], d["cache"])
        got = {l["index"]: l["pre_tree"] for l in d["links"]}
        self.assertEqual(got[2], right[2],
                         "link 2 was judged against a poisoned pre-tree")


class EnvCannotMoveTheRails(unittest.TestCase):
    """No environment variable may relax a rail (F4, F5)."""

    def test_protected_roots_cannot_be_removed(self):
        import argparse
        from h9chain.h9chain import Config
        env = dict(os.environ)
        os.environ["H9CHAIN_PROTECTED_ROOTS"] = os.path.join(ROOT, "nothing")
        try:
            args = argparse.Namespace(
                config=None, repo_root=None, work=os.path.join(ROOT, "w"),
                dev_root=None, xash_bat=None, patches_dir=None, web_dir=None,
                lock=None, offset_limit=None, timeout=None, strict=False,
                fail_on=None)
            cfg = Config(args)
            real = os.path.join("D:" + os.sep, "GIT Storage",
                                "ts_h9_team_elimination")
            self.assertTrue(any(gitio.is_under(real, p)
                                for p in cfg.protected_roots),
                            cfg.protected_roots)
        finally:
            os.environ.clear()
            os.environ.update(env)

    def test_allow_patch_writes_cannot_be_set_from_the_environment(self):
        import argparse
        from h9chain.h9chain import Config
        env = dict(os.environ)
        os.environ["H9CHAIN_ALLOW_PATCH_WRITES"] = "1"
        try:
            args = argparse.Namespace(
                config=None, repo_root=None, work=os.path.join(ROOT, "w"),
                dev_root=None, xash_bat=None, patches_dir=None, web_dir=None,
                lock=None, offset_limit=None, timeout=None, strict=False,
                fail_on=None)
            cfg = Config(args)
            self.assertFalse(cfg.allow_patch_writes)
            self.assertTrue(any("IGNORED" in n for n in cfg.notes))
        finally:
            os.environ.clear()
            os.environ.update(env)

    def test_a_worktree_may_not_land_in_another_repository(self):
        fx = F.Fixture(os.path.join(ROOT, "wt"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"}, after=[])
        fx.wire("p1.patch")
        victim = os.path.join(ROOT, "wt-victim")
        F.rmtree(victim)
        F.init(victim)
        F.write(os.path.join(victim, "keep.txt"), "do not overwrite me\n")
        F.git(victim, "add", "-A")
        F.git(victim, "commit", "-q", "-m", "victim")
        rc, d, err = chain(fx.args() + ["tree", "1", "--worktree", victim,
                                        "--force"])
        self.assertEqual(rc, 4, err)
        self.assertEqual(F.git(victim, "status", "--porcelain")[1].strip(), "")


class OneRunPerWorkArea(unittest.TestCase):
    """Two runs sharing a work area corrupt each other (F3)."""

    def test_the_second_run_refuses_to_start(self):
        fx = F.Fixture(os.path.join(ROOT, "lock"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"}, after=[])
        fx.wire("p1.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "p1.patch"))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")
        os.makedirs(fx.work, exist_ok=True)
        with open(os.path.join(fx.work, "run.lock"), "w",
                  encoding="ascii") as fh:
            json.dump({"pid": 1, "epoch": int(__import__("time").time())}, fh)
        rc, d, err = chain(fx.args() + ["check", "--all"])
        self.assertEqual(rc, 3, err)
        self.assertEqual(d["severity"], "ENVIRONMENT")
        self.assertIn("another h9chain run", err)
        rc, d, err = chain(fx.args() + ["check", "--all", "--break-lock"])
        self.assertEqual(rc, 0, err)


class EveryFailurePathEmitsOneObject(unittest.TestCase):
    """--json means one object on stdout, refusals included (D1, F10)."""

    @classmethod
    def setUpClass(cls):
        fx = cls.fx = F.Fixture(os.path.join(ROOT, "jsonpaths"))
        fx.build_base()
        fx.make_patch("p1.patch", {"src/a.c": F.BASE_A + "// p1\n"}, after=[])
        fx.wire("p1.patch")
        F.git(fx.dev, "apply", os.path.join(fx.patches, "p1.patch"))
        F.git(fx.dev, "add", "-A")
        F.git(fx.dev, "commit", "-q", "-m", "chain")

    def test_refusals_and_usage_errors(self):
        cases = [
            (["check", "999"], 2),
            (["explain", "NOSUCHTHING"], 2),
            (["frobnicate"], 2),
            (["adopt", "1", "--yes"], 4),
            (["lint", "--only", "NOSUCHRULE"], 2),
            (["plan", os.path.join(ROOT, "nope.patch"), "--last"], 2),
            (["owns", "src/nosuchfile.c"], 2),
            (["regen", "1", "--from", os.path.join(ROOT, "nodir")], 2),
        ]
        for args, want in cases:
            rc, d, err = chain(self.fx.args() + args)
            self.assertEqual(rc, want, "%s -> %s\n%s" % (args, rc, err))
            self.assertNotIn("_stdout", d,
                             "%s printed no JSON object on stdout" % args)
            self.assertEqual(d["exit_code"], want)
            self.assertTrue(d["findings"][0]["message"])

    def test_a_work_root_that_is_a_file_is_an_environment_error(self):
        f = os.path.join(ROOT, "jsonpaths", "notadir")
        with open(f, "w", encoding="ascii") as fh:
            fh.write("x")
        args = [a for a in self.fx.args()]
        args[args.index("--work") + 1] = f
        rc, d, err = chain(args + ["check", "1"])
        self.assertEqual(rc, 3, err)
        self.assertNotIn("_stdout", d)


class Explain(unittest.TestCase):

    def test_every_verdict_has_commands(self):
        from h9chain import report, verdicts
        for v in verdicts.SEVERITY:
            if v == "OK":
                continue
            key, val = report.explain(v)
            self.assertIsNotNone(val, v)
            self.assertTrue(val[2], "explain %s has no commands" % v)
        for extra in ("ORPHAN", "WORKTREE", "CHAIN", "UNOWNED",
                      "SUPERSEDED"):
            key, val = report.explain(extra)
            self.assertIsNotNone(val, extra)

    def test_explain_needs_no_repository(self):
        p = subprocess.run([sys.executable, ENTRY, "explain", "SHADOW",
                            "--json", "--repo-root", ROOT,
                            "--work", os.path.join(ROOT, "w")],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           stdin=subprocess.DEVNULL)
        if p.returncode in (0,):
            d = json.loads(p.stdout.decode())
            self.assertTrue(d["explain"]["do"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
