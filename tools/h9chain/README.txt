h9chain -- a harness for correcting the xash.bat engine patch chain
===================================================================

WHEN THE CHAIN BREAKS, THIS IS THE WHOLE JOB
--------------------------------------------
    tools\chain.cmd doctor            which link is wrong, and its fix
    tools\chain.cmd regen <N>         rebuild that one patch, with a proof
    tools\chain.cmd adopt <N> --yes   write it (open the gate below first)
    tools\chain.cmd check --all       confirm the chain is whole again

Measured on this chain: 15 s to name a broken link, about 100 s for the
whole find-repair-prove loop, under 2 s for one link once the cache is
warm. Exit 0 is healthy. Every other exit prints the exact command to run
next, with real paths, and "chain explain <code>" says what that code
means. Add --json to any command and the same answer comes back as one
object, for an agent.

This tool APPLIES PATCHES. IT NEVER COMPILES ANYTHING. No code path in it
can reach waf, msvc, gcc, build.bat, export.bat or xash.bat; "chain selftest"
checks that structurally and fails if it ever becomes untrue.

THE ONE SAFETY RULE
-------------------
Nothing outside the work area is ever written, with exactly one exception:
"chain adopt", which copies one patch file, needs --yes, and ships disabled.
To enable it, flip one line in chain.config.json:

    "allow_patch_writes": true

That line is the ONLY way to open it. H9CHAIN_ALLOW_PATCH_WRITES is read,
reported and ignored, because a gate an environment variable can open is not
a gate.

"D:\GIT Storage\ts_h9_team_elimination" and "D:\Downloads\TSM" are protected
roots: the tool refuses (exit 4) to write anything inside them, and refuses
to run "git apply" in any form -- including --check -- against either. Those
two are a floor. The config file and H9CHAIN_PROTECTED_ROOTS can ADD roots;
neither can remove one. A destination given through a flag rather than a
repository path (checkout-index --prefix=DIR) is validated the same way, and
"tree --worktree DIR" additionally refuses any DIR inside somebody else's
git repository, which --force does not waive.

Every apply happens in an index-only shared clone under the work area. The
pristine submodule's working tree is never read; everything comes from commit
trees. "git worktree add" is never used against anything real, because it
writes six files into the source .git.

ONE RUN PER WORK AREA
---------------------
A run holds <work>\run.lock while it works. Two runs sharing one work area
corrupt each other's index slots and cache, and the survivor then reports
failures that are not there, so the second run refuses to start (exit 3) and
says so. Give it its own area with --work DIR, or pass --break-lock if you
know the other run is dead. A lock older than three times --timeout is
treated as stale and broken automatically.

THE LOOP THIS EXISTS FOR
------------------------
    chain doctor --json              what is wrong, ranked, each with the
                                     exact next command         (warm 18 s)
    <run findings[0].next_command>   regen or fold, proof included  (28-47 s)
    chain adopt <N> --yes            writes the one patch file        (15 s)
    chain check --all --json         exit 0

Every command takes --json and then prints exactly one object on stdout and
nothing else -- INCLUDING every refusal and every error. "adopt" refused
because writes are off is the ordinary end of the loop, so it is a proper
object with exit_code 4, not an empty stdout. No command exits 1, and no
command can end in a traceback with nothing on stdout.

Every non-healthy verdict and every finding carries next_command (argv array)
and next_command_str (ready to paste, real paths filled in). Nothing is
interactive, nothing reads stdin, nothing waits.

An agent that meets a class or a verdict it does not recognise runs
"chain explain <it> --json" and gets {"class", "means", "do"} with no
repository access at all. Every verdict has commands, not only the exit
codes.

THE FIVE COMMANDS THAT MATTER
-----------------------------
    chain doctor            check --all, then residual, then lint, then an
                            ordered fix plan. The agent entry point.
    chain check [<sel>]     verdicts. With no argument: every link whose
                            patch moved since the last green run, plus the
                            later links on the same target. --all for all 64.
    chain show <sel>        everything about one link: files, hunks with
                            their offsets and the FILE each offset is in,
                            recorded anchors against computed ones, which
                            earlier links own regions in its files, which
                            later links write inside its post-image, its dev
                            verdict, whether another link duplicates it, and
                            the next command.
    chain regen <sel>       rebuild one patch between two trees and prove it.
                            Dry run is its ONLY behaviour.
    chain fold <src> --into <sel>
                            merge one patch into another, in the direction
                            the shape calls for, and prove it. Dry run only.

EVERY COMMAND
-------------
    list [--long]       the 64 links: index, xash.bat line, target, patch,
                        sha256, bytes, files, hunks, cache state. Under 0.4 s.
                        A 'call :patch' line it cannot parse, or a patch file
                        that is not on disk, is reported here AND in the exit
                        code (class CHAIN).
    check [<sel>|--all|--touched] [--no-dev] [--no-shadow] [--forward-only]
                        --forward-only really does only the forward pass: no
                        dev pass, no shadow pass, no residual (1.3 s against
                        2.4 s for the default single-link check).
    show <sel>
    tree <sel> [--post] [--worktree DIR] [--force]
                        materialize a link's pre-image (or --post) as
                        ordinary files, byte-faithful to the tree, so you or
                        an agent can edit them like source; then
                        "regen <sel> --from DIR" turns the edit back into a
                        correctly anchored patch. This is the fastest way to
                        change what a patch does.
    owns <path> [--regions] [--line N]
                        who put each line of that file there: the base
                        commit, or link N. The forbidden-region map.
    plan <candidate.patch> --after <sel> | --last
                        pre-flight a patch that is NOT wired yet: does it
                        apply at that slot, which earlier links it would
                        shadow and on which lines, the forbidden regions with
                        their owners, whether a wired link already produces
                        the same change (DUPLICATE OF / SUPERSEDED), and
                        every SAFE slot. A safe slot is one where the
                        candidate applies AND every later link still applies.
                        "it applies here" is not the same question, and both
                        are printed.
    residual            the replayed chain against the dev clone's working
                        tree, per target, with the UNOWNED list and what each
                        kind means. It does the residual and nothing else.
    regen <sel> [--refresh | --with P,.. | --post-dev <paths>
                 | --post-tree <id> | --from DIR]
                        --refresh   re-diff the patch against its own
                                    pre-tree: content-identical by
                                    construction, so it fixes DRIFT and
                                    cannot change behaviour.
                        --with P,.. A plus those patches and this one. The
                                    named patches are the missing
                                    predecessors and go first.
                        --post-dev <paths>
                                    A with those paths taken from the dev
                                    clone's working tree, every later
                                    toucher reversed out last to first.
                                    Refuses (REVERSE_BLOCKED) rather than
                                    absorb a neighbouring feature. Bare
                                    "regen <N>" on a REJECT link uses this
                                    over that patch's own paths.
                        --from DIR  the files from "tree <sel> --post
                                    --worktree DIR" after you edited them.
                                    Note: if the edit CHANGES what the
                                    patch does, the proof will report the
                                    link NOT_DETECTABLE and a residual --
                                    that is correct, and it means the dev
                                    clone does not carry the change yet.
                [--style auto|git|house] [--context N] [--out FILE]
                [--allow-foreign] [--no-proof]
    fold <source> --into <sel> [--mode auto|pre|post] [--out FILE]
    adopt <sel> [--from FILE] --yes
                        the one write. Refuses unless allow_patch_writes is
                        true, refuses without a proof record beside the
                        candidate (regen AND fold both write one), refuses if
                        the destination moved since the regen, refuses any
                        destination that is not <patches>\<name>.patch or
                        <web>\<name>.patch. It prints the PATCH_CHANGELOG.md
                        entry to paste, with the TRUE old sha256, and writes
                        neither the changelog nor xash.bat.
    bless [--force]     record this run as the baseline in CHAIN.lock.
    lint [--only RULE,..]
                        a rule name it does not know is exit 2 with the list,
                        not a silent "no findings".
    explain <code|class|verdict>
    schema              the JSON shape of every command's output.
    selftest [--deep]   read-only check against the real trees. --deep also
                        replays through a real worktree with plain
                        "git apply" and compares every tree id against the
                        index-only run.
    cache status | prune [--older-than 30d] | clear [--all]
                        status breaks the work area down by directory.
                        clear drops the cached trees, the index slots, the
                        scratch blobs AND the materialized arena, which is a
                        full checkout and the one thing that makes a work
                        area big (22.6 MB of 24.2 MB in a measured case).
                        --all takes the candidates and the shared clones too.

GLOBAL FLAGS (before or after the subcommand, both work)
--------------------------------------------------------
    --json --quiet -v --work DIR --config FILE --repo-root DIR
    --xash-bat FILE --patches-dir DIR --web-dir DIR --dev-root DIR
    --lock FILE --no-dev --target T --no-cache --refresh-cache
    --fail-on A,B --strict --offset-limit N --timeout SEC --break-lock
    --version

<sel> is a chain index (14), a patch basename with or without .patch, or an
unambiguous substring; ranges (14-20) and lists (14,24,37) work. Anything
ambiguous is exit 2 with the candidates printed.

WHAT EACH VERDICT MEANS
-----------------------
Severity descending. One token per link.

    PATCH_MISSING   xash.bat calls this patch and the file is not on disk.
                    All three git calls fail and the real build stops here
                    with [ERROR]. It is NOT a rename, a deletion or a binary
                    delta, and it is not reported as one.
                    -> show <N>, which prints the file to restore and the
                       xash.bat line to delete.

    REJECT          The patch does not apply to its reconstructed pre-tree
                    at all. A FRESH CLONE CANNOT BE BUILT. This is the case
                    that is invisible on the dev clone, because there the
                    content is already committed so the patch reverses
                    cleanly and xash.bat skips it.
                    -> regen <N>   (it rebuilds the post-image from the dev
                       clone's working tree, with every later toucher
                       reversed out), or, when the report says another link
                       duplicates it, fold them instead: regenerating a link
                       against a state that will not exist cannot work.

    SHADOWS         After this link, an earlier link stops reverse-checking.
                    xash.bat will stop at that earlier link on the next
                    fresh build. The report names the victim, the file and
                    the line ranges.
                    -> fold <N> --into <victim>

    SHADOWED        This link stops reverse-checking on the final tree. The
                    report names the culprit, found by bisecting the cached
                    post-trees.
                    -> the same fold, from the other end.

    NOT_DETECTABLE  On the dev tree it neither reverse-checks nor
                    forward-applies. Only H9_SKIP_PATCH_VERIFY gets past it,
                    and a run under that switch proves nothing.
                    -> regen <N> --post-dev <paths>, or, when another link
                       already carries the content, show <N>, which prints
                       the fold AND the exact xash.bat line to delete plus
                       the git mv to retired\. Unwiring is not a command
                       here, so it is printed, never done.

    THREEWAY        Plain apply fails and --3way rescues it. The measured
                    baseline is 0 of 64, so any occurrence is drift, not
                    success.
                    -> regen <N> --refresh

    HUNK_ARITH      An @@ header disagrees with its own hunk body. Every
                    header is recomputed from the body on every parse,
                    because that arithmetic has been got wrong by hand
                    twice.
                    -> regen <N> --refresh

    PATCH_UNSUPPORTED
                    Rename, copy, delete, mode change, delta-form binary, or
                    "Binary files ... differ". None exist in the chain
                    today; the refusal is so that the day one appears the
                    tool says so instead of guessing.

    NOT_IN_DEV      Reverse fails but forward applies on the dev mirror: the
                    dev clone does not hold this content. Benign for a patch
                    added since the last build.
                    -> regen <N> --post-dev <paths> if it should be there.

    DRIFT           It applies, but a recorded "index <pre>..<post>" is
                    stale (code DRIFT_ANCHOR_STALE) or a hunk offset exceeds
                    --offset-limit (code DRIFT_HUNK_OFFSET). The build works
                    and the metadata lies.
                    -> regen <N> --refresh, which is content-identical by
                       construction and cannot change behaviour.

    SKIPPED         THIS RUN DID NOT EXAMINE THE LINK. It was outside the
                    selection, its trees came from the cache, or an earlier
                    link stopped that target's replay. It is not a health
                    verdict and it is NOT OK: a one-link check leaves 63
                    links SKIPPED, and the summary prints "examined 1 of 64".
                    -> check --all, or check <N> for that one link.

    OK              Examined on every axis this run ran: plain, anchors
                    exact or exempt, in place on the dev clone, neither
                    shadowed nor shadowing, and nothing else in the chain
                    duplicating it.

A link that is green on every axis can still be the reason another link
cannot apply. That inversion (the victim fails, the culprit reads green) is
reported as its own finding, DUPLICATE_BLOCKS_LATER_LINK, and it is measured,
not guessed: the tool reverses the suspect out of the victim's pre-tree and
the victim then applies. Wiring one change as two links is what broke the
master build on 2026-11-17, and the finding for the CAUSE is printed before
the finding for the link it breaks.

Chain-level classes: CHAIN (xash.bat cannot be processed as it stands: an
unparseable "call :patch" line, or a patch file that is not there), RESIDUAL
(with UNOWNED / PHANTOM / CONTENT / ALLOWED), BASELINE (something in
CHAIN.lock moved), WORKTREE (see below), LINT, UNVERIFIED (--no-dev, a
skipped target, a selective run's partly cached final tree, a cache record
that was ignored, or H9_SKIP_PATCH_VERIFY set in the environment), ORPHAN (a
patch file on disk that xash.bat never calls).

EXIT CODES
----------
     0  OK
     2  USAGE          bad arguments, ambiguous selector, a refused regen
     3  ENVIRONMENT    git too old, a path missing, a target uninitialized,
                       the work root unusable, another run holds the lock
     4  REFUSED        a safety rail fired; nothing was written
     5  INTERNAL       a bug in h9chain (it still prints the object)
    10  REJECT
    11  SHADOW         SHADOWS, SHADOWED, NOT_DETECTABLE, or one link
                       blocking another
    12  RESIDUAL       includes UNOWNED and PHANTOM
    13  THREEWAY
    14  BASELINE
    15  NOT_IN_DEV
    16  DRIFT          includes HUNK_ARITH
    17  LINT
    18  UNVERIFIED
    19  CHAIN          xash.bat cannot be processed: an unparseable
                       'call :patch' line, a patch file that is not on disk,
                       or a shape this tool refuses to guess at
    20  WORKTREE       the pristine target's own working tree would stop a
                       literal xash.bat run (reported, not in fail_on)

Codes 2 to 5 exit immediately. Otherwise the process exits with the most
severe triggered class THAT IS IN fail_on (shipped: CHAIN, REJECT, SHADOW,
RESIDUAL, THREEWAY, BASELINE -- the six that mean a build will break, a
feature is missing, or the chain's output changed without anyone saying so).
Every triggered class always appears in classes[] in the JSON whatever
fail_on says, so policy never costs an agent information. --strict puts every
class in fail_on; --fail-on A,B overrides.

Today's chain carries 23 DRIFT findings, 2 WORKTREE findings and 4 LINT
findings. They are reported and do not fail a run, because a tool that cries
on first contact gets ignored. The DRIFT findings are not noise suppressed
away either: findings are ranked by what blocks a build, so a blocker is
findings[0] even with 23 DRIFT findings in the same report.

WHAT THIS HARNESS DOES NOT LOOK AT
----------------------------------
It replays commit trees in an index. It does not read, and cannot judge, the
pristine submodule's own WORKING TREE -- and a literal xash.bat run applies
into exactly that. Today that working tree holds 22 untracked files in the
engine and 1 in freevgui which are precisely the files the chain's new-file
patches create, so a real xash.bat run there stops at the first of them with
"already exists in working directory". The tool says so (class WORKTREE, with
the list) on every check, and does not fail on it: whether those files are
work in progress or leftovers is the owner's call, not the tool's.

It also runs every git call with GIT_CONFIG_NOSYSTEM=1, so that a
machine-wide setting cannot change what it measures. The real build does not.
"chain selftest" prints what is in C:\ProgramData\Git\config (today:
core.autocrlf=true, core.symlinks=false, core.fscache=true -- none of which
affects an apply) so that the difference is on the record rather than
discovered later.

HOW IT WORKS, IN FIVE LINES
---------------------------
1. Parse the 64 "call :patch" lines out of xash.bat. The line order IS the
   chain order; there is no manifest, no globbing and no sorting.
2. Stand up index-only "git clone --shared --no-checkout" clones of the four
   engine repos under the work area, each with the dev clone's object store
   added as an alternate, so one ODB holds the base, the replay and the dev
   mirror.
3. Replay each target's sub-chain with "git apply --cached", taking a
   "git write-tree" checkpoint after every link. Working in the index means
   line endings stop being a variable: blobs leave the ODB as LF and nothing
   is smudged, so the engine's .gitattributes and the nested submodules'
   lack of one stop mattering.
4. Judge six axes: forward (does it apply to its reconstructed pre-tree),
   anchor (do the recorded index blobs match), dev (what xash.bat would
   actually do against the dev clone's working tree), shadow (which link
   stops an earlier one reverse-checking, and on which lines), duplicate
   (which link stops a LATER one applying, measured by reversing it out),
   residual (does the replayed chain equal the dev clone's working tree,
   file for file, gitlinks aside).
5. Fix one link with "git diff-tree -p --binary" between two cached trees,
   and prove it by replaying and comparing tree ids. Equivalence is NEVER
   judged by comparing patch text: diff-tree sorts paths and the
   hand-written patches do not.

Base commits are derived, never configured: the engine base is the gitlink
in the superproject's HEAD, the three nested bases are the gitlinks inside
that commit's tree. A pin bump is followed automatically and reported as
"the base moved", not as 64 failures.

CACHE
-----
The post-tree of every link is cached under
  <work>\cache\index.jsonl  and  refs/h9chain/pre/<key>
keyed on the git version, the target, the base commit and the sha256 of
every patch up to that position. Invalidation is a property of the key, not
a procedure: editing patch P invalidates every position after P on P's
target and nothing else. There is no invalidate command in any workflow.

The jsonl file and the ref are TWO WITNESSES for the same mapping, and the
loader trusts a record only when they agree. A key that appears twice with
two different trees is not trusted at all, and either way the entry is
ignored, recomputed and REPORTED (cache.problems in the JSON, and an
UNVERIFIED line). That is what makes a hand-edited or half-written cache
file harmless instead of silently authoritative.

A selective run (check <N>) reads the suffix of each target's final tree
from the cache rather than replaying it, so it says so in unverified[] and
does not compute a residual off it. "check --all" replays every link from
the pinned base; that is the run whose tree ids are a measurement.

A check-only work area is about 2.5 MB. One materialized arena (a full
checkout, built lazily for a three-way probe or a regen) adds about 22.6 MB,
and "cache clear" is what drops it.

BASELINE (CHAIN.lock)
---------------------
"chain bless" records this run: the four base commits, the xash.bat sha256,
every link's patch sha256 and trees, the four final tree ids, the dev mirror
ids and the residual. Every later check compares against it.

A moved FINAL TREE is never explained away. It means the chain now builds
something else, whoever edited what, and it is class BASELINE with the
link(s) whose patch moved on that target named beside it. A patch sha256 that
moved with NO tree move is what "regen --refresh" does, so it is reported and
does not fail; lint rule L1 is what catches one made with no changelog entry.
baseline.matches is false whenever anything moved at all.

FILES HERE
----------
    chain.cmd            entry point (Windows)
    chain.sh             entry point (POSIX shell)
    chain.config.json    paths and policy. Ships allow_patch_writes false.
    chain.rules.txt      hand written, tool-read-only: residual allowlist
                         and temporary-line markers.
    CHAIN.lock           the baseline, written by "chain bless". It lives
                         here, not in the owner's tree; point --lock at a
                         tracked path when that is wanted.
    SPEC.md              the specification this was built from.
    HANDOFF.txt          where each file goes if and when this is committed.
    h9chain\             the program.
    tests\run-tests.cmd  the offline test suite (42 tests). It builds its
                         own repositories and reads neither real tree.
    tests\break-test.py  copies the real chain into scratch, breaks it THERE
                         four different ways, and proves the tool names each
                         one, repairs the first and puts the four tree ids
                         back.

MEASURED ON THIS MACHINE (git 2.21.0.windows.1, py 3.12.4)
----------------------------------------------------------
    list                                  0.34 s
    explain / schema                      0.26 s
    check --all, cold (no clones, no cache)  26.6 s
    check --all, warm                     18.1 s
    check --all --no-dev                  15.3 s
    check <N>, warm, default flags         2.4 s
    check <N> --forward-only               1.3 s
    check (--touched, nothing moved)       2.2 s
    show <N>                               4.2 s
    owns <path>                            1.9 s
    tree <N> --post --worktree            3.3 s   (710 files)
    residual                              12.8 s
    lint                                   1.2 s
    doctor                                18.2 s
    plan                               6.6-22.0 s
    regen --refresh with proof            32.4 s  (18.7 s with --no-proof)
    adopt                                 15.2 s
    selftest / --deep                 19.8 / 30.6 s
    tests\run-tests.cmd                  115 s, 42 tests
    tests\break-test.py                  ~4 min, 13 steps

Three of the specification's acceptance budgets are still missed, and they
are reported rather than quietly dropped: a warm single-link check is 2.4 s
against a 2 s target (the dev pass and the shadow pass are most of it; use
--forward-only for 1.3 s when the reverse axis does not matter), "regen" with
its proof is 32 s against 20 s (the proof replays the whole affected target,
which is the point of it), and a work area that has built an arena is 24 MB
against 5 MB ("cache clear" takes it back to 0.2 MB). The cold full run now
meets its budget at 26.6 s against 35 s.

NOT IN THIS VERSION
-------------------
No reimplementation of git apply's hunk matching -- real git does the
applying. No binary hunk decoding: a "GIT binary patch / literal" section is
recorded and passed through, git applies it and diff-tree --binary
regenerates it. No editing of xash.bat and no writing of
PATCH_CHANGELOG.md: both are printed ready to paste. Re-wiring a superseded
patch as a separate chain link is not a command and cannot be requested; it
was tried on 2026-11-17, produced a patch applicable in neither direction,
and broke the master build.

offset_limit ships at 0, so every hunk that lands away from its @@ header is
reported. That is deliberate: a moved hunk is drift, and --offset-limit 80
silences the offset half of it in one flag. The fix for the noise was to rank
findings by what blocks a build, not to stop measuring.

tools\submodule-engine-build-scan.sh and its CI workflow are untouched and
out of scope. (If the harness is ever wanted there, "chain check --no-dev
--json" is the form that needs no dev clone. That is a possibility, not a
goal.)
