#!/usr/bin/env node
/*
patch-notes-check.mjs -- a change to source or to a shipped binary needs its .patch note changed with it (docs\PATCH_NOTES_CHECK.txt).

    node tools/patch-notes-check.mjs --base <rev> --head <rev>   the changes between two commits (what the GitHub workflow does)
    node tools/patch-notes-check.mjs --base <rev> --merge-base   the changes a branch made since it left <rev> (a pull request)
    node tools/patch-notes-check.mjs --worktree                  the working tree against HEAD, untracked files too (before a commit)
    node tools/patch-notes-check.mjs --strict                    warnings fail as well
    node tools/patch-notes-check.mjs --list                      print the rules (tools/patch-notes-map.json)

What it asks, from tools/patch-notes-map.json:
  1. A source a rule names changed: at least one of that rule's notes must be changed in the same set of changes. Which notes is the
     point: reTS\cl_dll asks for client.dll.patch, reTS\dlls for mp.dll.patch, an AMX Mod X module for its own module's note, and so on.
  2. A patch of xash3d-h9-patches\patches changed: the paths its diff touches say which engine binaries it lands in (ref\gl is
     ref_gl.dll, filesystem is filesystem_stdio.dll, 3rdparty\mainui is menu.dll, 3rdparty\freevgui is vgui.dll, game_launch is the
     launcher, the rest is xash.dll; the lists xash.bat's :dllpatch calls hold), and each of those binaries' notes must change too.
  3. A binary that carries a note changed: its note must change, whatever the sources did.
Any change to the note passes: this checks that the note was touched, not what it says. Two warnings besides (an error with --strict):
a note that records a SHA256 which is not the binary's, and a binary or note changed without the other.

A commit in the range that says  Patch-Notes: skip <the reason>  on a line of its own (a refactor, a comment, a rename) passes the
range with the reason in the log. The workflow only reads and reports; it never edits anything.
*/
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

const map = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "patch-notes-map.json"), "utf8"));

// ---- globs: * stays in a folder, ** crosses folders, ? is one character ----------------------------------------------
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
const matcher = (globs) => { const res = (globs || []).map(globToRegExp); return (p) => res.some((r) => r.test(p)); };

// ---- git ------------------------------------------------------------------------------------------------------------
function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + (r.stderr || "").trim());
  return r.stdout;
}
const lines = (s) => s.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);

function changedFiles() {
  if (flag("worktree")) {
    const tracked = lines(git(["diff", "--name-only", "--no-renames", "HEAD"]));
    const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
    return { files: [...new Set([...tracked, ...untracked])], range: "the working tree against HEAD", base: null, head: null };
  }
  const head = opt("head", "HEAD");
  let base = opt("base", "");
  if (!base || /^0+$/.test(base)) base = head + "^";
  const spec = flag("merge-base") ? base + "..." + head : base + ".." + head;
  return { files: lines(git(["diff", "--name-only", "--no-renames", spec])), range: spec, base, head };
}

function readAtHead(p, head) {
  if (!head) { try { return fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { return null; } }
  const r = spawnSync("git", ["show", head + ":" + p], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// the paths a patch file touches: its "diff --git a/<path> b/<path>" lines
function patchPaths(p, head) {
  const text = readAtHead(p, head);
  if (text === null) return null;
  const out = [];
  for (const l of text.split("\n")) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(l);
    if (m) out.push(m[2]);
  }
  return out;
}

// ---- the checks -----------------------------------------------------------------------------------------------------
const { files, range, base, head } = changedFiles();
const changed = new Set(files);
const fails = [];
const warns = [];
const passed = [];

function needNotes(rule, trigger, notes) {
  const touched = notes.filter((n) => changed.has(n));
  if (touched.length) passed.push({ rule, trigger, note: touched[0] });
  else fails.push({ rule, trigger, notes });
}

// 1. the rules: a source changed -> one of its notes changed
for (const rule of map.rules) {
  const isSource = matcher(rule.sources);
  const isIgnored = matcher(rule.ignore);
  const hit = files.filter((f) => isSource(f) && !isIgnored(f));
  if (hit.length) needNotes(rule.name, hit, rule.notes);
  // 3. a binary that carries a note changed -> the note changed
  for (const bin of rule.binaries || []) {
    if (changed.has(bin) && !(rule.notes || []).some((n) => changed.has(n))) {
      fails.push({ rule: rule.name + " (the binary itself)", trigger: [bin], notes: rule.notes });
    }
  }
}

// 2. the engine patches: each one's diff says which binaries it lands in
const eng = map.engine;
const isEnginePatch = matcher(eng.patches);
const isEngineIgnored = matcher(eng.ignore);
const byNote = new Map();
for (const f of files) {
  if (!isEnginePatch(f) || isEngineIgnored(f)) continue;
  const touched = patchPaths(f, head);
  if (touched === null) continue; // deleted in this range: nothing to say about it
  const targets = new Set();
  for (const t of touched) {
    const hitBin = eng.binaries.find((b) => b.paths.some((pre) => t.startsWith(pre)));
    targets.add((hitBin || eng.default).note);
  }
  if (!targets.size) targets.add(eng.default.note);
  for (const note of targets) {
    if (!byNote.has(note)) byNote.set(note, []);
    byNote.get(note).push(f);
  }
}
for (const [note, patches] of byNote) needNotes("engine patch -> " + path.basename(note), patches, [note]);
for (const b of [...eng.binaries, eng.default]) {
  if (changed.has(b.binary) && !changed.has(b.note)) fails.push({ rule: "engine binary " + path.basename(b.binary) + " (the binary itself)", trigger: [b.binary], notes: [b.note] });
}

// warnings: a note that records a SHA256 of a binary this tree holds, which is another
const allBinaries = [...map.rules.flatMap((r) => (r.binaries || []).map((b) => [b, r.notes])), ...[...eng.binaries, eng.default].map((b) => [b.binary, [b.note]])];
for (const [bin, notes] of allBinaries) {
  if (!changed.has(bin) && !notes.some((n) => changed.has(n))) continue;
  const file = path.join(ROOT, bin);
  if (!fs.existsSync(file)) continue;
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
  for (const n of notes) {
    const text = readAtHead(n, null);
    if (text === null) continue;
    const recorded = [...text.matchAll(/SHA256\s*:\s*([0-9A-Fa-f]{64})/g)].map((m) => m[1].toUpperCase());
    if (recorded.length && !recorded.includes(actual)) {
      warns.push({ what: path.basename(n) + " records " + recorded.map((r) => r.slice(0, 12)).join(" / ") + " but " + path.basename(bin) + " is " + actual.slice(0, 12), file: n });
    }
    break;
  }
}

// ---- the escape ----------------------------------------------------------------------------------------------------
let skipReason = null;
if (base && head) {
  let log = "";
  try { log = git(["log", "--format=%B", base + ".." + head]); } catch { /* a range git cannot read has no log */ }
  const m = /^Patch-Notes:\s*skip\b[ \t]*(.*)$/im.exec(log);
  if (m) skipReason = m[1].trim() || "(no reason given)";
}

// ---- the report ----------------------------------------------------------------------------------------------------
const out = [];
out.push("patch-notes-check: " + files.length + " changed file(s), " + range);
for (const p of passed) out.push("  ok    " + p.rule + ": " + p.note + " changed");
for (const f of fails) out.push((skipReason !== null ? "  waived  " : "  FAIL  ") + f.rule + ": " + f.trigger.slice(0, 3).join(", ") + (f.trigger.length > 3 ? " (+" + (f.trigger.length - 3) + ")" : "") + " changed, none of " + f.notes.join(" | ") + " did");
for (const w of warns) out.push("  warn  " + w.what);
if (!passed.length && !fails.length && !warns.length) out.push("  nothing in this range needs a patch note");
if (skipReason !== null && fails.length) out.push("  a commit in the range says Patch-Notes: skip " + skipReason);
console.log(out.join("\n"));

if (process.env.GITHUB_ACTIONS) {
  for (const f of fails) console.log("::" + (skipReason !== null ? "warning" : "error") + " title=patch note missing::" + f.rule + ": change one of " + f.notes.join(", ") + " (the note says what changed in the binary), or say Patch-Notes: skip <reason> in a commit message");
  for (const w of warns) console.log("::warning file=" + w.file + " title=patch note hash::" + w.what);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ["### Patch notes", "", "| | rule | changed | note |", "|---|---|---|---|"];
  for (const p of passed) md.push("| ok | " + p.rule + " | " + p.trigger.length + " file(s) | `" + p.note + "` |");
  for (const f of fails) md.push("| **missing** | " + f.rule + " | `" + f.trigger.slice(0, 2).join("`, `") + "` | " + f.notes.map((n) => "`" + n + "`").join(" or ") + " |");
  for (const w of warns) md.push("| warn | " + w.what + " | | |");
  if (skipReason !== null) md.push("", "A commit in the range says `Patch-Notes: skip " + skipReason + "`.");
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n"); } catch { /* the log has it */ }
}

if (flag("list")) {
  console.log("\nrules:");
  for (const r of map.rules) console.log("  " + r.name + "\n    sources " + r.sources.join(", ") + "\n    notes   " + r.notes.join(", "));
}
const failed = (fails.length && skipReason === null) || (flag("strict") && warns.length);
process.exit(failed ? 1 : 0);
