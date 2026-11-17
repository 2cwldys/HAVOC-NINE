# JUDGMENT AND THE SPECIFICATION TO BUILD

This is the contract h9chain was built from, saved as delivered. Where the
built tool deviates, it is listed at the end under "Deviations as built".

Verified on this machine (git 2.21.0.windows.1, py -3 = 3.12.4), scratch in
`D:\temp\chain-work\judge`, nothing written to either real tree:

- `git apply --cached --3way` -> `error: --cached and --3way cannot be used together.` rc=128. Design A's M1 confirmed: the index-only path cannot classify NEEDS_3WAY by itself.
- `git apply --cached --check -v` -> rc=0, prints `Hunk #1 succeeded at 4 (offset 2 lines).` **on stderr**, and `write-tree` is byte-identical before and after. One read-only call gives verdict AND per-hunk offsets.
- `git apply --cached --reverse --check` works against an index (rc=0 after a `--cached` apply; rc=1 before). **The reverse / in-place axis needs no working tree.** Neither design says this outright; it is the fact that makes the whole fast path worktree-free.
- `git apply --cached --check` on an already-applied index fails with `patch does not apply` -- the two directions are cleanly separable in the index.
- `GIT_INDEX_FILE` isolation works (read-tree/write-tree against an alternate index).
- `xash.bat` holds exactly 64 `call :patch` lines.
- Gitdir pointers are asymmetric, as Design B says: mainui -> `modules/xash3d-fwgs/modules/mainui`, freevgui and library_suffix -> `modules/xash3d-fwgs/modules/3rdparty/<name>`. Resolve, never construct.

---

## PART 1 -- SCORES

Convention: 10 is best. For (5) and (7) that means lowest cost and lowest risk.

| # | criterion | sketch | A | B |
|---|---|---|---|---|
| 1 | single-link fix avoids replaying the chain | 7 | 9 | 10 |
| 2 | break caught at the moment it is introduced | 3 | 8 | 9 |
| 3 | invisible cases made visible (neither-forward-nor-reverse) | 5 | 9 | 10 |
| 4 | structurally cannot write a real tree | 6 | 9 | 8 |
| 5 | cost to a human adding or editing a patch | 9 | 8 | 6 |
| 6 | speed of the common case | 6 | 7 | 9 |
| 7 | how little can go wrong in implementation | 8 | 8 | 4 |
| | total | 44 | 58 | 56 |

**Maintainer's sketch**
1. **7** -- the content-keyed `tree <link>` cache is the sketch's one great idea and is stated exactly right, but `regen` still rebuilds trees and `check` has no incremental default.
2. **3** -- nothing fires unless a person remembers to run `check`; no baseline, no sha tripwire, no default-incremental mode, so the discovery latency stays "next full rebuild".
3. **5** -- it names NOT_DETECTABLE, which is the right class, but defines it only as "neither direction on the dev tree" and has no notion of the victim/culprit inversion that made chatraise cost three days.
4. **6** -- "refuse to run if asked to target a real tree" is a policy an implementer can forget, not a structure, though mutation-in-temp-only is stated plainly.
5. **9** -- adds no obligation whatsoever: same patches, same xash.bat, nothing new to commit or merge.
6. **6** -- caching makes it fast in principle, but the sketched common case is still a whole-chain `check` over materialized trees.
7. **8** -- small surface, everything delegated to git, nothing novel; the vagueness sits in the spec, not in the hard parts.

**Design A**
1. **9** -- content-keyed pre-tree cache, nearest-ancestor rebuild, regen is one `diff-tree -p` at 0.12 s; only the optional proof replays, and that is deliberate.
2. **8** -- `check` defaults to `--touched` off a recorded last-green state plus the shadow pass for that target; still needs somebody to run it, and a patch edited with no changelog entry leaves no trace.
3. **9** -- SHADOWS / SHADOWED / NOT_DETECTABLE as distinct verdicts with culprit bisection over cached checkpoints, and it settled the open 63/64 question by measurement instead of argument.
4. **9** -- two chokepoints (`git_rw` asserts work-root containment, `git_ro` carries a verb allowlist), `origin` removed from every work clone, exactly one gated write, shipped `allow_patch_writes:false`.
5. **8** -- no new tracked artifact and no new standing obligation; the author gains a printed changelog entry but still picks hook sites by hand, because there is no `plan`.
6. **7** -- 27 s cold, 2-5 s warm, single link under 2 s; the 7.5 s dev mirror is a standing tax on every run that touches the reverse axis.
7. **8** -- almost entirely shelling to git, with ten measured recipes for the awkward bits; `owns` is the only real algorithm in it.

**Design B**
1. **10** -- per-file factorization is correct and decisive: a link's fix touches only that link's files and their touchers, with no tree, no clone and no index.
2. **9** -- a committed anchor baseline turns any unintended change into a loud ANCHOR_STALE at the next run; it is the only mechanism in the three that catches "patch edited, no changelog entry" (the C1 class).
3. **10** -- computes the in-place predicate directly, attributes SHADOWED_BY to a named later link, and adds `plan` to pre-flight a candidate before it is ever wired, which is the entire near-miss class.
4. **8** -- strictest rails on paper (it refuses even `apply --check` against a real tree), but the largest write surface: a new tracked file in the owner's patches directory plus an opt-in `--rewire` that edits xash.bat, with no shipped global off switch.
5. **6** -- honest about the one new standing obligation (`anchor --write`, commit ANCHORS.tsv, a merge surface on every patch edit); `plan` and `owns` repay it, but the daily cost is real and lands on the person least likely to want it.
6. **9** -- under 2 s for a whole-chain static check with residual and no clone, the best common case of the three, conditional on the matcher being faithful.
7. **4** -- it reimplements `git apply` hunk placement, git blob and tree hashing, base85/zlib binary hunks, and reverse-subtraction of later touchers; it admits this, and that is four novel things that can be subtly and silently wrong.

**Verdict.** Build **Design A's execution model with Design B's analysis layer and baseline discipline.** A is right that real git must do the applying; B is right about what must be computed and about pre-flighting a patch before it is wired. My measurements above collapse the gap between them: because `--cached --check -v` and `--cached --reverse --check` both work in the index, B's four best features (in-place predicate, shadow attribution, ownership regions, `plan`) are reachable with zero reimplementation of git -- which was B's only serious weakness. B's ANCHORS.tsv does not survive: it is chain-global derived state, so derive it every run, and keep only the part that is genuinely worth storing -- a **baseline lock file**, which in version one lives in the harness directory and not in the owner's tree.

---

## PART 2 -- THE SPECIFICATION TO BUILD

### 2.0 What is being built, in one paragraph

`chain` is one Python 3 program with subcommands, driven from `D:\temp\wf\chainharness`. It parses the 64-link chain out of `xash.bat`, stands up index-only shared clones of the four engine repos, replays the chain with `git apply --cached`, and produces a per-link verdict in both directions plus a residual against the dev clone's working tree. It fixes one link with `git diff-tree -p --binary` between two cached trees, and proves the fix by replaying the whole chain and comparing four tree ids. It never writes into a real repository except through one command that ships disabled, it never checks files out unless asked, and it never compiles anything. `tools\submodule-engine-build-scan.sh` and its workflow are untouched and out of scope.

### 2.1 Measured mechanics this specification rests on

These are verified, not assumed. An implementation that contradicts one of them is wrong.

1. `git apply --cached --check -v <patch>` is read-only (write-tree identical before and after), returns rc 0/1 as the verdict, and prints `Hunk #N succeeded at L (offset D lines).` on **stderr**. This single call is the forward probe.
2. `git apply --cached --reverse --check <patch>` works against an index. The in-place predicate needs no worktree.
3. `git apply --cached --3way` is refused outright (`cannot be used together`, rc 128). The three-way probe therefore needs a real worktree and runs lazily, only for a link that fails plain.
4. `--3way` additionally needs the pre-image blob present in the ODB and needs the worktree to match the index (`git update-index -q --refresh` after `checkout-index`), so the probe arena must be a `--shared` clone, never an archive or a copy.
5. Working in the index removes line endings as a variable entirely: blobs come out of the ODB as LF and nothing is smudged. `.gitattributes` differences between the engine and the three nested submodules stop mattering.
6. `git clone --shared --no-checkout` writes only to the destination (about 1 MB, under 0.4 s per repo). `git worktree add` writes six files into the source `.git` and is therefore banned against anything real.
7. Submodule gitdirs are asymmetric. Resolve each by reading the `.git` pointer file or with `git -C <worktree> rev-parse --absolute-git-dir`. Never construct the path.
8. `git write-tree` on the 720-entry engine index costs about 0.06 s, so every link gets a checkpoint and there is no checkpoint strategy to design.
9. Writing `objects/info/alternates` in Python text mode on Windows corrupts it (`\n` becomes `\r\n` and git reports the object directory missing). Every file git reads is written in binary mode.
10. The pristine submodule's **working tree** currently holds 18 orphan files and a modified `3rdparty/freevgui` gitlink from earlier scan runs. It is never read. Everything comes from commit trees.

### 2.2 The loop this exists to make fast

```
chain doctor --json              what is wrong, ranked, each with the exact next command   (cold 25 s, warm 3 s)
<run findings[0].next_command>   regen or fold, proof included                             (12-17 s)
chain adopt <N> --yes            writes the one patch file (when writes are enabled)       (3 s)
chain doctor --json              exit 0
```

Budget, which the implementer treats as an acceptance target: `list` under 0.3 s; warm `check <N>` under 2 s; cold `check --all` under 30 s; `regen` dry run including the proof under 20 s; `tree <N>` cached under 0.3 s.

### 2.3 File layout to create under `D:\temp\wf\chainharness`

```
D:\temp\wf\chainharness\
  README.txt                  CRLF, ASCII. The agent loop, the five commands that matter,
                              the exit-code table, the one safety rule, the one line to flip
                              to enable writes, and the sentence "this tool never compiles anything".
  SPEC.md                     this specification, saved verbatim as the implementer's contract.
  chain.cmd                   @py -3 "%~dp0h9chain\h9chain.py" %*
  chain.sh                    exec py -3 "$(dirname "$0")/h9chain/h9chain.py" "$@"   (falls back to python)
  chain.config.json           paths and policy (section 2.4). Ships allow_patch_writes false.
  chain.rules.txt             hand-written, tool-read-only: residual allowlist and temporary markers.
  CHAIN.lock                  absent on delivery. Written by `chain bless`. Never in the owner's tree in v1.
  h9chain\
    h9chain.py                argv, config resolution, dispatch, exit codes, the JSON envelope
    gitio.py                  git_ro / git_rw chokepoints, environment, subprocess, timeouts
    chainparse.py             xash.bat chain parser; patch parser (files, hunks, index lines,
                              binary literal, arithmetic recomputation, unsupported-shape refusal)
    workarea.py               materialize, replay, cache, write-tree checkpoints, dev mirror, arenas
    verdicts.py               forward / anchor / dev / shadow passes, residual, the taxonomy
    regen.py                  regen, fold, adopt, the proof
    ownsplan.py               ownership intervals, owns, plan
    lint.py                   the v1 static lints
    report.py                 human table, JSON envelope, explain text, schema
  tests\
    run-tests.cmd             the one test entry point: py -3 -I tests\test_h9chain.py
    test_h9chain.py           stdlib unittest, fully offline, builds synthetic repos
    fixtures\make_fixtures.py constructs the incident fixtures listed in section 2.16
```

No third-party packages. No network. `py -3` is the interpreter. Every file in the deliverable is ASCII; `.py`, `.sh` and `chain.rules.txt` are LF, `.cmd` and `README.txt` are CRLF.

### 2.4 Configuration

`chain.config.json`, every key overridable by a flag, then by `H9CHAIN_<NAME>`, then this file:

```json
{
  "repo_root":        "D:\\GIT Storage\\ts_h9_team_elimination",
  "xash_bat":         "",
  "dev_root":         "D:\\Downloads\\TSM\\xash3d-fwgs",
  "work":             "D:\\temp\\chain-work\\h9chain",
  "lock":             "",
  "protected_roots":  ["D:\\GIT Storage\\ts_h9_team_elimination", "D:\\Downloads\\TSM"],
  "allow_patch_writes": false,
  "fail_on":          ["REJECT","SHADOW","RESIDUAL","THREEWAY","BASELINE"],
  "anchor_exempt":    ["engine.patch","engine-mainui.patch","freevgui.patch","engine-library_suffix.patch"],
  "offset_limit":     0,
  "timeout_sec":      120
}
```

Empty `xash_bat` resolves to `<repo_root>\xash3d-h9-patches\xash.bat`; empty `lock` to `<harness dir>\CHAIN.lock`. `anchor_exempt` holds the four `webassembly-patch` patches: they were written against a different FWGS revision, they are not ours to re-anchor, and without the exemption they are permanent noise.

Base commits are **derived, never configured**: engine base = the gitlink in the superproject's HEAD (`git -C <repo_root> ls-tree HEAD xash3d-fwgs`); the three nested bases = the gitlinks inside that commit's tree. A pin bump is then followed automatically and reported as "the base moved", not as 64 failures.

`chain.rules.txt`, hand-written, never written by the tool, ASCII, LF, `#` comments:

```
allow      3rdparty/extras/xash-extras/cacert.pem   self-regenerating Mozilla CA bundle
temporary  mainui-h9-sprayui.patch   CLogosListModel::Update: %d entr
```

### 2.5 Parsing the chain

Select lines matching `^[ \t]*call :patch `. First quoted string is the target, second is the patch, trailing `|| exit /b 1` stripped. Line order is chain order; there is no sorting, globbing or manifest. Substitutions: `%FWGS%` and its three `3rdparty\<name>` forms to the four targets, `%XASH%\patches\<n>` to the patches dir, `%WEB%\<n>` to the webassembly dir. The engine root is a parameter, never derived from xash.bat's location, so the same parse serves an arena.

Traps that must be handled: patch names also appear in the ENGINE.txt echo block (lines 233-268) and in five `call :dllpatch` description strings (lines 275-280), so a name-keyed grep picks up roughly 56 phantom entries; the bare `:patch` label at line 342 must not match; all 64 lines sit inside `if exist "%FWGS%\.git" (`, so an arena without a `.git` silently skips the entire chain and the tool must assert the arena is a git repo; delayed expansion is on but no chain line uses it; nothing is commented out.

Reported, never fatal: a patch file on disk not referenced (`ORPHAN`, today the two in `retired\`), a referenced file that is missing, a target string the parser does not recognise.

### 2.6 Parsing a patch

Accept both shapes present in the tree: sections beginning `diff --git a/X b/Y`, and sections beginning directly at `--- a/X` with no `diff --git` at all (three patches: autoconfig, deltabits, framesize -- a parser keyed on `diff --git` sees zero files in them). Path from `+++ b/<path>` at p1; a new file is `--- /dev/null`. Handle `new file mode`, `index <pre>..<post>[ <mode>]`, `@@ -a[,b] +c[,d] @@`, body lines prefixed by space, `-` or `+`, `\ No newline at end of file`, and `GIT binary patch` / `literal <n>` (recorded, not decoded -- see 2.19).

Recompute every hunk header from its body on every parse: `b == count(' ') + count('-')` and `d == count(' ') + count('+')`. Disagreement is `HUNK_ARITH`. This is the one place the record says outright "got that arithmetic wrong twice -- do not trust it".

Refuse with `PATCH_UNSUPPORTED` on rename, copy, delete, mode change, delta-form binary, or `Binary files ... differ`. None exist today; the refusal is so that the day one appears, the tool says so instead of guessing.

### 2.7 Work area and materialization

Per target, once per work root:

```
git clone -q --shared --no-checkout <pristine target gitdir> <work>\<target>
append "<dev target gitdir>/objects\n" to <work>\<target>\.git\objects\info\alternates   (BINARY mode)
git -C <work>\<target> remote remove origin
git -C <work>\<target> config core.autocrlf false
git -C <work>\<target> config core.eol lf
git -C <work>\<target> config gc.auto 0
git -C <work>\<target> config gc.pruneExpire never
```

The dev alternate is what lets one ODB hold base, replay and dev mirror, so residual becomes one comparison. `origin` is removed so no code path leads back to the real repos. Local config, not one-shot `-c`: the one-shot form does not survive later commands in the same repo, which is the bug in the existing scan script's LF handling.

Replay is `git apply --cached` down the target's sub-chain with `GIT_INDEX_FILE` naming a per-position index inside the work repo, and `git write-tree` after every link. Layout:

```
<work>\
  repos\<target>\            index-only shared clone
  idx\<target>\<n>.idx       per-position index files
  cache\index.jsonl          one record per cached tree
  arena\<id>\                a materialized worktree, only on request or for a 3-way probe
  candidates\                regen and fold output
  state.json                 last run summary, for `check --touched`
  last.json                  the last run's full JSON, for `explain` and run-to-run diffing
```

### 2.8 Cache

One keyspace. The post-tree of link N is the pre-tree of the next same-target link, so both are the same kind of entry.

```
key = sha256( "h9chain-pre-v1\n"
            + "git="    + <git --version output> + "\n"
            + "target=" + <engine|mainui|freevgui|library_suffix> + "\n"
            + "base="   + <40-hex base commit> + "\n"
            + for each link of this target up to and including the position, in chain order:
                "p=" + sha256(patch file bytes) + "\n" )
```

Value is a tree id, anchored as `refs/h9chain/pre/<key>` in that target's work repo so gc cannot reach it, plus a line in `cache\index.jsonl` carrying `{key, target, link_index, patch_name, tree, created_utc}`.

Invalidation is a property of the key, not a procedure, and there is no invalidation command in any workflow:

| change | invalidates | keeps |
|---|---|---|
| edit patch P | every position after P **on P's target** | everything before P on that target, and all three other targets |
| add / remove / reorder a `call :patch` line | every position whose preceding same-target sequence changed | everything before the first change, and the other targets |
| bump the engine pin | all engine entries | the three nested targets |
| bump a nested pin | that target only | the rest |
| different git version | everything | nothing |
| any edit in the dev working tree | the dev mirror entry only | every pre-tree |

A rebuild starts from the nearest cached same-target ancestor and applies forward; worst case is the base. Every entry is verified with `git cat-file -t <tree>` before use, and a missing object is a silent miss, never an error. `cache clear` and `cache prune --older-than 30d` exist for disk only. Expected size of a full work area: 1-3 MB.

Dev mirror key: `sha256("h9chain-dev-v1" + <dev HEAD per target> + sorted (path, size, mtime_ns, mode) over ls-files -m / -o --exclude-standard / -d)`. Always recomputed, never assumed; recomputation costs about 0.3 s.

### 2.9 The dev mirror

The dev clone's working tree reproduced as a tree inside the work repo. This is the only way to judge the reverse axis and the residual without ever running `git apply` against the dev clone.

```
read-tree <dev target HEAD> into <work>\idx\<target>\dev.idx
one   git -C <dev> ls-files --eol        -> per-path index eol
one   git -C <dev> ls-files -s           -> per-path mode (carry it: staging 100644 over a 100755 file invents a residual)
      git -C <dev> ls-files -m / -o --exclude-standard / -d
for each modified or untracked path:
      read bytes with open(), normalize CRLF->LF iff (index eol is lf and no NUL in the first 8000 bytes)
      git -C <work>\repos\<target> hash-object -w <tmp>        (writes into the WORK repo only)
      git update-index --add --cacheinfo <mode>,<sha>,<path>
for each deleted path: git update-index --force-remove <path>
write-tree -> the dev mirror tree id
```

Untracked files absent from `--eol` default to normalize-unless-binary, matching the machine's `core.autocrlf=true` check-in behaviour. Cost about 7.5 s for four targets, cached.

### 2.10 The five passes

**Forward.** For each link, against its reconstructed pre-tree index: `git apply --cached --check -v`. rc 0 -> `PLAIN`, and parse stderr for `Hunk #N succeeded at L (offset D lines).`. rc non-zero -> the lazy three-way probe: in a disposable arena for that target, `read-tree <pre-tree>`, `checkout-index -a -f`, `update-index -q --refresh`, then `git apply --3way --check` (not `--cached`). rc 0 -> `THREEWAY`, else `REJECT` with the rejecting hunks captured from stderr.

**Anchor.** For each file section carrying an `index <pre>..<post>`, compare the recorded pre against the pre-tree's blob at that path and the recorded post against the post-tree's, **as prefixes** (the tree holds 7-hex and 8-hex abbreviations side by side). Per file: `EXACT`, `STALE`, `NEWFILE`, `NONE`. Link state is the worst, with `anchor_exempt` forcing `NONE`. A `STALE` entry also records `recorded_present_in_odb`, which separates "written against another revision" from "written against a state this chain no longer produces". Seventeen patches carry no index line anywhere; their state is `NONE` and that is not a finding.

**Dev (the xash.bat simulation).** Per target, against a copy of the dev mirror index, in chain order, reproducing `:patch` exactly:
- `apply --cached --reverse --check` rc 0 -> `IN_PLACE`, do not apply, continue (this is the skip that hides rot).
- else `apply --cached --check` rc 0 -> `WOULD_APPLY`; **apply it to the mirror index** so later links are judged on the tree xash.bat would actually have, and record the link as `NOT_IN_DEV`.
- else -> `NOT_DETECTABLE`. Record "xash.bat would stop here", then continue (unlike xash.bat) so one bad link does not hide the rest.

**Shadow.** After the full replay, for every link, `apply --cached --reverse --check` against its target's **final** tree index. Failure -> that link is `SHADOWED`. Find the culprit by bisecting cached post-trees for the smallest M > L at which the reverse check stops passing -- about six checks, under a second -- and mark M `SHADOWS`. Attribute the lines with `git diff-tree -p -U0 pre(M) post(M) -- <shared files>` intersected with L's added intervals, so the report prints the file and line range. This is the chatraise shape, where the victim fails and the culprit is green, and nothing in the project computes it today. The shadow pass runs against the replayed final tree so it still works under `--no-dev`.

**Residual.** Per target, compare the replayed final tree id against the dev mirror tree id. Equal -> done in one comparison. Otherwise `git diff-tree -r --no-renames <replayed> <mirror>`, discarding any entry whose mode is 160000 on either side (gitlinks are never patched and would otherwise make the engine differ forever by three), then classify each path: `UNOWNED` (in dev, no link produces it), `PHANTOM` (in the replay, not in dev), `CONTENT` (both, differing), `ALLOWED` (matched `chain.rules.txt`, reason echoed). `UNOWNED` is the class-B detector that would have fired on day one for presence, the `bots` key, the mainui hand edit and the native menubgvideo delta.

### 2.11 Verdicts, classes, exit codes

Per-link verdict, severity descending, one token per link:

| verdict | means | the next command |
|---|---|---|
| `REJECT` | does not apply to its reconstructed pre-tree at all; a fresh clone cannot be built | `regen <N>`, or `fold` if an earlier link supersedes its pre-image |
| `SHADOWS` | after this link an earlier link stops reverse-checking; xash.bat will stop at that earlier link on the next build | `fold <N> --into <victim>` |
| `SHADOWED` | this link stops reverse-checking on the final tree; the report names the culprit | the same fold, from the other end |
| `NOT_DETECTABLE` | on the dev tree it neither reverse-checks nor forward-applies; only `H9_SKIP_PATCH_VERIFY` gets past it | `fold <X> --into <N> --mode pre`, or `regen <N> --post-dev <paths>` |
| `THREEWAY` | plain fails, `--3way` rescues; measured 0 of 64, so any occurrence is drift, not success | `regen <N> --refresh` |
| `HUNK_ARITH` | an `@@` header disagrees with its own hunk body | `regen <N> --refresh` |
| `PATCH_UNSUPPORTED` | rename, delete, mode change or delta binary | hand decision |
| `NOT_IN_DEV` | reverse fails but forward applies on the dev mirror; the dev clone does not hold this content | benign for a patch added since the last build; otherwise `regen <N> --post-dev <paths>` |
| `DRIFT` | applies plain, but an anchor is stale or an offset exceeds `offset_limit`; the build works and the metadata lies | `regen <N> --refresh` |
| `OK` | plain, anchors exact or exempt, in place on dev, neither shadowed nor shadowing | nothing |

Chain-level classes: `RESIDUAL` (with `UNOWNED` / `PHANTOM` / `CONTENT`), `BASELINE` (something in `CHAIN.lock` moved -- section 2.15), `LINT`, `UNVERIFIED` (`--no-dev`, a skipped target, or `H9_SKIP_PATCH_VERIFY` set in the environment), `ORPHAN`.

Exit codes, stable and documented in README.txt and in `chain explain`:

```
 0  OK
 2  USAGE          bad arguments, ambiguous selector
 3  ENVIRONMENT    git too old, a path missing, a submodule uninitialized, work root unwritable
 4  REFUSED        a safety rail fired
 5  INTERNAL
10  REJECT
11  SHADOW         SHADOWS, SHADOWED or NOT_DETECTABLE
12  RESIDUAL       includes UNOWNED and PHANTOM
13  THREEWAY
14  BASELINE
15  NOT_IN_DEV
16  DRIFT          includes HUNK_ARITH and PATCH_UNSUPPORTED
17  LINT
18  UNVERIFIED
```

Codes 2 to 5 short-circuit and exit immediately. Otherwise the process exits with the code of the most severe triggered class **that is in `fail_on`**, in the order above; every triggered class always appears in `classes[]` in the JSON regardless of `fail_on`, so policy never costs an agent information. Shipped `fail_on` is `REJECT, SHADOW, RESIDUAL, THREEWAY, BASELINE` -- the five that mean a build will break, a feature is missing, or the chain's output changed without anyone saying so. `DRIFT`, `NOT_IN_DEV` and `LINT` report without failing, because today's chain carries roughly ten DRIFT links and a tool that cries on first contact gets ignored. `--strict` puts every class in `fail_on`; `--fail-on A,B` overrides.

### 2.12 Command surface

Global flags, accepted by every subcommand: `--json`, `--quiet`, `-v`, `--work DIR`, `--config FILE`, `--repo-root DIR`, `--xash-bat FILE`, `--dev-root DIR`, `--lock FILE`, `--no-dev`, `--target T` (repeatable), `--no-cache`, `--refresh-cache`, `--fail-on A,B`, `--strict`, `--offset-limit N`, `--timeout SEC`, `--no-color`, `--version`.

`<sel>` is a chain index (`14`), a patch basename with or without `.patch`, or an unambiguous substring; ranges (`14-20`) and lists (`14,24,37`) are accepted. Ambiguity is exit 2 with the candidates printed.

```
chain list [--long]
      index, xash.bat line, target, patch path, sha256, bytes, files, hunks, cache state.
      No trees. Under 0.3 s.

chain check [<sel> | --all | --touched] [--no-dev] [--no-shadow] [--forward-only]
      Default with no argument is --touched: every link whose patch sha256 moved since the last
      green run in state.json, plus every later link on the same target, plus that target's
      shadow pass. --all is the full 64. Produces the verdict table of section 2.14.

chain show <sel>
      Everything about one link: files, hunks with offsets, anchors recorded against computed,
      every earlier link owning regions in its files, every later link inside its post-image,
      its dev verdict, and the next command.

chain tree <sel> [--post] [--print-id] [--worktree DIR] [--files a,b]
      Materialize the pre-tree (or --post) of a link. Default prints the tree id only.
      --worktree writes files for a human or an agent to edit, LF forced; refuses a protected
      root, refuses a non-empty directory without --force.

chain owns <path> [--regions] [--line N]
      Line ownership of the file as the chain leaves it: base, or link N, per line.
      --regions prints each link's spans. This is the forbidden-region map that seven near-misses
      were worked out by hand.

chain plan <candidate.patch> --after <sel> | --last
      Pre-flight for a patch not yet wired: does it apply at that slot, which earlier links it
      would shadow and on which lines, the forbidden regions with owners, and the legal slot range.

chain residual [--json]
      Section 2.10 in full, with the UNOWNED list.

chain regen <sel> [--refresh | --with P,.. | --post-dev <paths> | --post-tree <id> | --from DIR]
                  [--style auto|git|house] [--context N] [--out FILE] [--allow-foreign] [--no-proof]
      Section 2.13. Dry run is its only behaviour; it has no write mode.

chain fold <source> --into <sel> [--mode auto|pre|post] [--out FILE]
      Section 2.13. source may be a chain link, an index, or a path to any .patch, including
      patches\retired\. Dry run only.

chain adopt <sel> [--from FILE] --yes
      The only command that writes outside the work area, one file, gated off in the shipped config.

chain bless [--force]
      Record the current run as the baseline in CHAIN.lock. Section 2.15.

chain lint [--only RULE,..]
      Section 2.14's rule set. Static, seconds, never fatal on its own.

chain doctor
      check --all, then residual, then lint, then an ordered fix plan: one line per finding with
      the exact command, in the order to run them. The agent entry point.

chain explain <code | class | verdict>
      What it means and the commands that resolve it. Offline, no repo access, no trees.

chain schema
      The JSON schema of every command's output object.

chain selftest [--deep]
      Section 2.17. --deep additionally replays through a real worktree with plain `git apply`
      and compares per-link write-tree ids against the index-only run.

chain cache status | prune [--older-than 30d] | clear
```

Nothing is interactive, nothing reads stdin, nothing pages, nothing waits. Every git call runs with `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GIT_PAGER=cat`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, and `GIT_INDEX_FILE` either set explicitly or removed from the environment.

There is no `check --deep`. In this design the fast path already is real git, so adjudication is not a separate mode; `--deep` exists only on `selftest`, where it means the worktree-versus-index equivalence proof.

### 2.13 Fixing one link

**regen.** `A` = the pre-tree of the link, from cache or rebuilt from the nearest ancestor. `B` = the intended post-image tree:

- `--refresh` (default): `A` plus this link's own patch. Content identical by construction; only the hunk headers, the `index` blobs and the recorded coordinates change. **This is the DRIFT fix and it cannot alter behaviour**, which the proof then asserts.
- `--with P1,P2`: `A` plus those patches applied in chain order. This is the spraypicker shape.
- `--post-dev <paths>`: `A` with exactly those paths replaced by the dev mirror's blobs, **with every later same-file toucher reversed out, last to first**. The subtraction is not optional: the record says plainly that the live tree has userid, menubg and presence mixed into the same two files, and diffing it raw is how a regen absorbs three features at once. If a later toucher will not reverse cleanly, refuse with `REVERSE_BLOCKED` naming it. `--post dev` with no explicit paths is refused outright.
- `--post-tree <id>`: that tree, the escape hatch.
- `--from DIR`: the files in an arena someone edited (from `tree <sel> --post --worktree`). **This is the agent workflow and the single biggest ergonomic win in the tool**: materialize, edit files like ordinary source, turn the edit back into a correctly anchored patch.

Then `new text = git diff-tree -p --binary --no-renames --src-prefix=a/ --dst-prefix=b/ -U<context> A B -- <paths>`, with `<paths>` restricted to the paths the existing patch already touches plus those named by `--post-dev` or introduced by `--with`. That path filter is how "strip to this feature's hunks, remove the other patch's hunk from the shared file's section" stops being a hand edit.

Three gates, all before anything is written:

- **Path gate.** A generated path outside the allowed set is `FOREIGN_PATH`: listed, exit 2, unless `--allow-foreign`.
- **Line gate.** A hunk whose changed lines are owned by another link (section 2.12 `owns`) is `FOREIGN_LINES`: listed with the owning link and its range, exit 2, unless `--allow-foreign`.
- **Proof** (on by default, `--no-proof` to skip): copy the chain's patch set into `work\candidates\<id>\`, substitute the candidate, replay all four targets from their bases, and assert that every link is still `PLAIN`, that the four final tree ids equal the baseline's, that no link becomes `SHADOWED` or `NOT_DETECTABLE` that was not before, and that the residual is no worse. `--post-dev` changes the expectation to `closes-residual`: the residual for those paths goes to zero and **no path outside this link's own file set moves**.

Equivalence is judged by replaying and comparing tree ids, **never by comparing patch text**: 31 of 64 patches regenerate byte-identically and 33 differ cosmetically, because `diff-tree` sorts paths and the originals do not.

`--style`: `house` drops `diff --git` and `index` lines (the format autoconfig, deltabits, framesize and fourteen others use), `git` keeps them, `auto` matches whatever the existing file does. File order follows the existing patch, with new paths appended. A hunk header is never computed by arithmetic anywhere in this tool; git emits them.

Output: the candidate at `work\candidates\<patch-name>.<8 hex of key>.patch`, a unified diff of old patch text against new, the proof verdict with the four tree ids, the list of downstream anchors that moved, and the exact `chain adopt` line.

**fold.** Two modes, auto-detected, with the reason printed:

- `--mode post` (the chatraise shape: both are live tracked patches). New base = `diff(pre(base), pre(base) + base + source)`, restricted to the union of their paths. The base's post-image changes, so downstream anchors move and are listed.
- `--mode pre` (the spraywad shape: the source's content is already committed on the dev clone and the source applies in neither direction). New base = `diff(pre(source), pre(source) + source + base)`. **The base's post-image must come out byte-identical**, so nothing downstream moves at all. Both halves are asserted and printed.

Dual-tree invariant, asserted before anything is offered: the folded base applies `PLAIN` on the pristine prefix **and** still reverse-checks `IN_PLACE` on the dev mirror, and the four final tree ids are unchanged. Re-wiring a superseded patch as a separate chain link is not a command and cannot be requested: it was tried on 2026-11-17, produced a patch applicable in neither direction, and broke the master build. `fold` prints the candidate, the adopt command, the xash.bat line number to delete, the `git mv` to `retired\` as text, and the changelog entry. It edits neither file.

**adopt.** One `copyfile`, nothing else. Refuses with exit 4 unless `allow_patch_writes` is true; refuses with exit 2 if the proof record is missing or its chain fingerprint no longer matches, if the destination's sha256 moved since the regen, or if the destination is not exactly `<patches>\<name>.patch` or `<web>\<name>.patch`. After copying it re-runs `check --target T` and **prints** the `PATCH_CHANGELOG.md` entry to paste, in the file's own required format (`### YYYY-MM-DD -- <patch name>`, what changed, why, what was verified, old and new sha256). It never writes the changelog and never edits xash.bat: both live in the tree that must not be touched.

### 2.14 Output

Human first, `--json` for machines. The human table is one line per link: index, target, patch, forward, max offset, anchor, dev, verdict; then the four summary lines (forward counts, reverse counts and shadow count, residual with the four tree ids, timings); then a `FINDINGS` block where every finding carries a one-line cause and the exact next command with real absolute paths already substituted; then one `NEXT:` line and the exit code. A `REJECT` additionally prints the rejecting hunks, the recorded pre-image and the blob actually found. A `SHADOW` additionally prints the victim, the file, the line ranges, the symptom in xash.bat's own words, and how the culprit was found.

`--json` prints exactly one object on stdout and nothing else; all progress goes to stderr; the exit code is identical with and without `--json`. Keys are stable; new keys may be added in a minor version, existing keys never change meaning, and the `schema` string changes if they would. Envelope, identical in shape for every subcommand, with irrelevant sections present but empty rather than absent:

```json
{
  "schema": "h9chain/1",
  "tool":    {"name":"h9chain","version":"1.0.0","git":"2.21.0.windows.1","python":"3.12.4"},
  "command": {"name":"check","argv":["check","--all"],"started_utc":"...","duration_ms":0},
  "ok": false, "exit_code": 11, "severity": "SHADOW",
  "classes": ["SHADOW","DRIFT"], "unverified": [],
  "paths":   {"entry":"D:\\temp\\wf\\chainharness\\chain.cmd","repo_root":"...","xash_bat":"...",
              "patches_dir":"...","web_dir":"...","dev_root":"...","work":"...","lock":"..."},
  "base":    {"engine":{"commit":"...","odb":"..."},"mainui":{},"freevgui":{},"library_suffix":{}},
  "dev":     {"engine":{"head":"...","modified":0,"untracked":0,"mirror_tree":"..."}},
  "cache":   {"hits":0,"misses":0,"invalidated_from":{"engine":24}},
  "chain":   {"links":64,"by_target":{},"xash_bat_sha256":"..."},
  "baseline":{"present":true,"matches":false,"moved":["final_tree.engine"]},
  "links":   [{"index":24,"xash_bat_line":131,"target":"engine","patch":"...","patch_name":"...",
               "sha256":"...","bytes":0,"files":[],"hunks":0,
               "pre_tree":"...","post_tree":"...","cache_key":"...","cached":true,
               "forward":"plain","offsets":{"hunks_with_offset":0,"max_abs":0,"detail":[]},
               "anchor":{"state":"exact","files":[]},
               "dev":"in_place","shadows":[],"shadowed_by":58,
               "verdict":"SHADOWED",
               "next_command":["fold","58","--into","24"],
               "next_command_str":"D:\\temp\\wf\\chainharness\\chain.cmd fold 58 --into 24"}],
  "residual":{"ran":false,"ok":null,"targets":{}},
  "findings":[{"id":"F001","class":"SHADOW","severity":"error","code":"SHADOW_LATER_EDITS_ADDED_LINES",
               "link":58,"victim_link":24,"file":"engine/client/console.c","lines":[[912,927]],
               "message":"...","next_command_str":"..."}],
  "next_commands":["..."],
  "timings_ms":{"materialize":0,"dev_mirror":0,"replay":0,"reverse":0,"shadow":0,"residual":0}
}
```

`next_command_str` is fully quoted for the host shell with `paths.entry` as argv[0], so an agent runs it verbatim. Every non-OK verdict and every finding carries one. An agent that does not recognise a class runs `chain explain <class> --json` and gets `{"class":..,"means":..,"do":[commands]}` with no repo access.

**Lint rules in v1** (each individually named so `--only` works, each with a stable code):
`L1` a patch's sha256 moved with no new dated `PATCH_CHANGELOG.md` entry; `L2` every `@@` header recomputed from its body; `L7` nothing in `patches\retired\` is wired in xash.bat and no retired file lingers in `export\`; `L8` the `:dllpatch` description line counted against cmd's 8,191-character limit (currently tracked by a human counting characters, and one more patch name breaks the build at the parse level); `L9` the changelog's patch table has exactly one row per `call :patch` line, in order; `L10` a patch still carrying a line `chain.rules.txt` marks temporary; plus `INDEX_LINE_STALE` surfaced from the anchor pass. L1 and L2 are the two that have actually cost time; build them first.

### 2.15 CHAIN.lock -- the baseline, and the answer to "caught when introduced"

`chain bless` writes `CHAIN.lock` in the harness directory from a run: schema, timestamp, git version, the four base commits, the xash.bat sha256, every link's (index, target, patch name, patch sha256, pre tree, post tree), the four final tree ids, the dev mirror tree ids, the residual summary, and the stale-anchor and offset sets accepted as known. `bless` refuses a run that is not healthy unless `--force`, and `--force` records the unhealthy state explicitly as accepted.

Every later `check` compares against it and raises class `BASELINE` on anything that moved and is not explained by a patch sha256 that also moved. That is the mechanism Design B was reaching for with ANCHORS.tsv, minus its costs: no new tracked artifact in the owner's tree while he is pushing, no per-patch re-anchoring obligation, no merge surface, and it catches the C1 class (a patch edited on 2026-10-26 with no log entry and nothing noticing) because the patch's sha256 is in the lock. The lock moves into the repo later, at the owner's word, by pointing `--lock` at a tracked path; nothing else changes.

### 2.16 Safety rails

1. **Two chokepoints, no third.** `git_rw(repo, *args)` asserts `realpath(normcase(repo))` is under the work root or raises `Refusal` -> exit 4. `git_ro(repo, *args)` accepts, against any path, only: `rev-parse`, `cat-file`, `ls-files`, `ls-tree`, `merge-base`, `rev-list`, `log`, `show`, `diff`, `status --porcelain`, `config --get`, `var`, `symbolic-ref --short`. `apply`, `checkout`, `reset`, `clean`, `stash`, `add`, `commit`, `worktree`, `gc`, `prune`, `update-index`, `read-tree`, `write-tree`, `update-ref`, `fetch`, `push`, `mv`, `rm` and `hash-object -w` are reachable only through `git_rw`. No flag, environment variable or config key relaxes this. `--force` affects work-area directories only.
2. **No `git apply` of any form, including `--check`, against a real repository.** Every apply runs in a work clone. The constraint names `git apply`; this tool does not get to reinterpret it, and because the dev mirror lives in the work ODB nothing is lost by obeying.
3. **Protected roots** default to the git copy root and `D:\Downloads\TSM` entire. The tool refuses to start (exit 4) if the work root, a `--worktree DIR` or an `--out FILE` resolves inside one.
4. **One write outside the work area, ever:** `adopt`, one file, destination pattern-validated, gated by `allow_patch_writes` (shipped `false`) and `--yes`. `regen` and `fold` have no write mode at all -- dry run is not their default, it is their only behaviour.
5. **No remote** in any work repo, removed at clone time, so there is no path back even by accident.
6. **`git worktree add` is never used against a real repository.** It writes six files into the source `.git`. `clone --shared --no-checkout` is the only materialization primitive.
7. **The pristine working tree is never read**, only base commit trees; the dev clone is read only through `ls-files` and plain file reads.
8. **No compiler, ever.** No code path invokes waf, msvc, gcc, `build.bat`, `export.bat` or `xash.bat`. `selftest` greps the tool's own source to assert this and fails if it finds one.
9. **Preflight:** git present and at least 2.13; both protected roots exist and are git repos; the four targets resolve; the work root is writable and outside the protected roots; `H9_SKIP_PATCH_VERIFY` unset -- if it is set, every result is tagged `UNVERIFIED` and class 18 is raised, because a run under that switch proves nothing, and the warning states that xash.bat tests `if defined`, so even `H9_SKIP_PATCH_VERIFY=0` skips.
10. **Windows:** `objects/info/alternates` and every other file git reads are written in binary mode; `shutil.rmtree` over a work repo uses an `onerror` hook that chmods read-only pack files and retries.

### 2.17 Tests

`tests\run-tests.cmd` runs `py -3 -I tests\test_h9chain.py` (stdlib `unittest`), **fully offline**: it builds synthetic repos under `D:\temp\chain-work\h9chain-tests` and never needs either real tree. Required fixtures, each reproducing a recorded incident:

- A1, a link whose recorded pre-image was superseded by an earlier link -> `REJECT`, and `regen --with` fixes it.
- A4, the shadow pair -> victim `SHADOWED`, culprit `SHADOWS`, culprit named by bisection, `fold --mode post` fixes it and the final tree id is unchanged.
- A5, a patch applicable in neither direction -> `NOT_DETECTABLE`, `fold --mode pre` fixes it and the base's post-image is byte-identical.
- `NOT_IN_DEV`: a link the dev mirror does not carry.
- `THREEWAY`: a link that fails plain and is rescued by the worktree probe.
- Patch shapes: a `GIT binary patch / literal` hunk, a patch with no `index` lines, a patch with no `diff --git` line, and a patch with a corrupted `@@` count (`HUNK_ARITH`).
- Gates: `FOREIGN_PATH` and `FOREIGN_LINES` refusals from `regen`; `adopt` refused with `allow_patch_writes:false`; `git_rw` raising for a path under a protected root; `selftest`'s no-compiler grep.
- Cache: editing a mid-chain patch invalidates that target from that link onward and nothing else; a wiped work area is a silent miss.

`chain selftest` is the separate, opt-in, read-only check against the real trees and reproduces section 2.18.

### 2.18 Acceptance -- expected first-run numbers

Report these; treat the two marked CONTESTED as measurements, not as pass conditions.

1. 64 links parsed from xash.bat lines 108-171, split engine 50 / mainui 10 / freevgui 3 / library_suffix 1, 60 from `patches\` and 4 from `webassembly-patch\`, with both files in `retired\` reported `ORPHAN`.
2. Forward: 64 plain, 0 three-way, 0 reject.
3. Final tree ids: engine `1d3b2b36fb4e`, mainui `b20aba4533e1`, freevgui `713ad34b70d2`, library_suffix `e6a43e63397c`. Two independent measurements agree on these; treat them as the oracle, and a disagreement means the harness is wrong, not the chain.
4. Dev pass: expect 64 `IN_PLACE`, 0 `NOT_DETECTABLE`. This settles the open question about links 63 and 64 (whether `engine-h9-menubgvideo.patch` breaks `engine-h9-userinfo-client.patch`'s reverse check) and whether anything in today's chain still needs `H9_SKIP_PATCH_VERIFY`.
5. Shadow pass: expect 0 shadowed.
6. **CONTESTED -- residual.** Design A measured 0 differing files by tree id with gitlinks excluded; the mechanical survey measured 48 by comparing materialized worktrees, all inside files the dev clone has uncommitted edits to. The tree-id method in one ODB is the sound one and is what this spec requires. Whatever the first run measures, `bless` records it, and every differing path is triaged on the spot into `regen --post-dev`, a new patch (class B), or an allowlist line with a reason. **Do not hardcode either number as a pass condition.**
7. **CONTESTED by one -- stale anchors.** Expect 12 to 13 links, of which 3 to 4 are `anchor_exempt` web patches, leaving 9 or 10 H9-owned DRIFT links among #14, #24, #37, #44, #45, #46, #47, #51, #59, #63. The two surveys disagree only about #24. Report the measured set; `regen --refresh` clears them all and cannot change behaviour.
8. Offsets: expect roughly 20 links with a non-zero hunk offset, maxima 74 at #63, 62 at #28, 17 at #46, 16 at #14, 10 at #2, 9 at #37.
9. Timing on this machine: cold full run under 35 s, warm single-link check under 2 s, `regen --refresh` dry run with proof under 20 s, work area under 5 MB.
10. `plan patches\retired\engine-h9-chatraise.patch --after engine-h9-chatinput` must report `SHADOWS engine-h9-chatinput.patch` with the console.c line range. That is the known-good regression test for the whole near-miss class, reproducing the failure that cost three days.
11. `fold patches\retired\engine-h9-spraywad.patch --into engine-h9-spraypicker --mode pre`, run against the pre-fold spraypicker, must reproduce the 2026-11-17 result: spraypicker's pre-image becomes the 16 upstream lines, its post-image is byte-identical, all four final tree ids unchanged. That is the two-hour job, and reproducing it in a dry run is the proof the harness does what it was built for.

### 2.19 Deliberately out of version one

- **A reimplementation of `git apply`'s hunk matching** (Design B's static engine). Real git does the applying. This is the single largest risk removed, and because `--cached --check -v` and `--cached --reverse --check` both work in the index, almost nothing is lost by dropping it.
- **ANCHORS.tsv as a tracked artifact in the owner's patches directory**, and the standing `anchor --write` obligation it creates. Replaced by `CHAIN.lock` in the harness directory.
- **Binary hunk decoding.** A `GIT binary patch / literal` section is recorded and passed through; `git apply` applies it and `diff-tree -p --binary` regenerates it. The tool never decodes base85 or zlib itself.
- **Rename, copy, delete, mode-change and delta-binary patch shapes.** Detected and refused as `PATCH_UNSUPPORTED`. None exist today.
- **Editing `xash.bat` (`--rewire`) and writing `PATCH_CHANGELOG.md`.** Both are printed ready to paste, never written.
- **Lint rules that check prose claims** -- "applies after #N", "needs #N for <symbol>", "independent of every other patch", tail-patch ordering. They need a hand-maintained claims file; `chain.rules.txt` ships with only `allow` and `temporary` lines in v1.
- **CI.** `tools\submodule-engine-build-scan.sh` and its workflow are untouched; if the harness is ever wanted there, `chain check --no-dev --json` is the form that needs no dev clone, and that is a possibility, not a goal.
- **Webassembly parity, `WEB_PARITY.json`, `webclient-sync.mjs`.** Out of scope; the four webassembly patches are chain links like any other and are anchor-exempt.
- **Any compiling, ever.**

### 2.20 Build order

Phase 1, through `check --all --no-dev`: chain parser, patch parser, materialization, replay, forward pass, anchor pass, cache, human table, JSON envelope, exit codes. Phase 2: dev mirror, dev pass, shadow pass with bisection, residual, `bless` and the baseline comparison. Phase 3: `regen`, the proof, `fold` in both modes, `adopt`. Phase 4: `owns`, `plan`, `lint`, `explain`, `schema`, `doctor`, `selftest`. Tests land with each phase, not after.

---

## Deviations as built, 2026-11-17

Each of these is a measured reason, not a shortcut.

1. **Checkpoints are tree ids, not per-position index files.** 2.7's layout names `idx\<target>\<n>.idx`. The post-tree of every link is written to the cache and `read-tree` restores any of them in 0.06 s, so one index file per target per operation (`replay`, `dev`, `devsim`, `shadow`, `bisect`, `plan`, `fold`, `regen`) does the same job without 64 files per target.

2. **The dev mirror is cached on disk, under the dev-mirror key 2.8 already defines.** 2.9 says "cached"; without persisting it, every process paid 4 s. The key is recomputed from `ls-files` on every run, so a dirty-tree change still invalidates it.

3. **A selective run narrows three passes.** `check <N>` restricts the anchor pass to the selected links, the shadow pass to links sharing a file with one of them (a link cannot shadow a file it does not touch), and the dev simulation to the selected links, which it states in `unverified`. Without this a single-link check cost 9.8 s instead of 1.9 s.

4. **`--with` applies the link's own patch as well.** 2.13 says "`A` plus those patches". The spraypicker shape needs `A + spraywad + spraypicker`, so the named patches go first as the missing predecessors and the link's own patch follows; if that will not build, the other order is tried and the order used is printed.

5. **Bare `regen <N>` on a `REJECT` link uses `--post-dev` over that patch's own paths.** A REJECT means the recorded pre-image is wrong, so re-diffing the patch against its own pre-tree cannot work. It prints the equivalent explicit command.

6. **The line gate fires on newly-changed owned lines only.** Lines the regenerated patch changes that the old one also changed are not foreign: a `--refresh` touches exactly what it touched before, so it stays silent, while a `--post-dev` that absorbed a neighbouring feature does not.

7. **The proof replays the affected target only.** The other three targets' patch sets are untouched by construction, so their final tree ids cannot move. This is what keeps a regen's proof inside the 20 s budget.

8. **`CHAIN.lock` is keyed to the base commits it was written against,** and a lock for a different base is ignored rather than compared against. Without this, the real chain's lock in the harness directory became the reference for every fixture and scratch run.

9. **The index-line abbreviation is taken from the patch being regenerated** (`-c core.abbrev=N`), because a work clone that also sees the dev objects picks a longer default and would otherwise rewrite every `index` line for no reason. git 2.21's `diff-tree` ignores `--abbrev` for that line; the config key is what sets it.

10. **`--patches-dir` and `--web-dir` were added** so the chain can be copied into scratch, broken there and fixed there. The break test and the spraywad reproduction both need it, and nothing else gives a way to exercise the tool without touching a real tree.

11. **A `--post-dev` proof does not assert that the final tree moved.** When the reference is a healthy baseline, a REJECT repair restores the tree rather than moving it; the two residual checks carry the verdict and the tree line says which way it went.

12. **Only the targets xash.bat actually names must be initialized,** so a chain that patches one repo does not require all four.

13. **`plan` reports `SUPERSEDED`.** When a candidate applies at no position but reverse-checks from position M onward, its content is already produced by that link. Acceptance item 10 lands here: `engine-h9-chatraise.patch` is today carried by `#24 engine-h9-chatinput.patch`, so `plan` names #24 and the console.c regions rather than printing SHADOWS, and says that wiring it separately is the state that broke the master build.

14. **`CHAIN.lock` is present on delivery**, against 2.3. It holds today's measured healthy baseline for the current pin, which is what makes the first real `regen` or `fold` able to assert "the final tree is unchanged". `chain bless` rewrites it and a lock for another base is ignored.

15. **Acceptance item 11 reproduces with a one-character difference.** The regenerated `engine-h9-spraypicker.patch` is identical to the file made by hand on 2026-11-17 except that its `index` line abbreviates to 8 hex where the hand-made one uses 7. The hunks, the context and the content are byte-identical, and the proof asserts the final engine tree is `1d3b2b36fb4e` either way. Per 2.13, equivalence is judged by tree ids, never by patch text.
