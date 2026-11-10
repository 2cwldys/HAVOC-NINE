#!/usr/bin/env node
/*
status-check.mjs -- every check this repository has, in one run, before a commit (docs\STATUS_CHECK.txt).

    node tools/status-check.mjs                 the working tree against HEAD (changed and untracked files)
    node tools/status-check.mjs --staged        only what is staged (what a commit would hold); this is what the hook runs
    node tools/status-check.mjs --fast          skip the test suites and the mirror check (seconds, not a minute)
    node tools/status-check.mjs --all           run the test suites whether or not their folders changed
    node tools/status-check.mjs --only hygiene,patch-notes     only these checks (names are in the table it prints)
    node tools/status-check.mjs --strict        a warning fails as well
    node tools/status-check.mjs --install-hook  put a git pre-commit hook in .git/hooks that runs --staged --fast

It never edits anything. Exit 0: nothing failed. Exit 1: something failed (the lines under it say what and where).

The checks:
  git-state       branch, how many files are modified, staged, untracked (information)
  hygiene         the faults of the files themselves: control bytes (a stray tab or BEL in a script), non-ASCII in plugin sources and
                  configs, line endings flipped against HEAD (git apply and some editors do it), merge markers, a binary replaced by a
                  git-lfs stub, scratch files (.bak, .tmp)
  secrets         private keys, webhook URLs, access tokens in the files (what the CI's secret scan looks for)
  cvar-docs       a cvar or command a changed plugin/client source registers that docs\COMMANDS.txt does not mention
  patch-notes     tools/patch-notes-check.mjs: a source or binary changed without its .patch note (docs\PATCH_NOTES_CHECK.txt)
  preset          tools/preset-check.mjs: the official preset files hold the hash of every plugin, module and Metamod plugin
  release         tools/release-check.mjs: the build, release and download page agree
  mirror          tools/mirror-check.ps1: the master tree (TSM) and this copy are in step (only where the master exists)
  h9web-tests     node --test in h9web (when h9web changed)
  serverlist-tests  the serverlist bot's unit tests (when it changed)
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const staged = flag("staged");
const fast = flag("fast");
const strict = flag("strict");
const only = opt("only", "") ? opt("only", "").split(",").map((s) => s.trim()) : null;
const MASTER = process.env.H9_MASTER || "D:\\Downloads\\TSM";

// ---- git helpers ----------------------------------------------------------------------------------------------------
function git(args, o = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, ...o });
  return r;
}
const gitText = (args) => { const r = git(args, { encoding: "utf8" }); if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + String(r.stderr).trim()); return r.stdout; };
const lines = (s) => s.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);

// ---- install the hook -----------------------------------------------------------------------------------------------
if (flag("install-hook")) {
  const dir = gitText(["rev-parse", "--git-path", "hooks"]).trim();
  const file = path.resolve(ROOT, dir, "pre-commit");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n# written by tools/status-check.mjs --install-hook: the checks of a commit, before it is made\nnode tools/status-check.mjs --staged --fast || { echo; echo \"status-check failed: fix what it names, or commit with --no-verify\"; exit 1; }\n", { mode: 0o755 });
  console.log("installed " + file + "\nit runs: node tools/status-check.mjs --staged --fast   (git commit --no-verify skips it)");
  process.exit(0);
}

// ---- the files this run looks at ------------------------------------------------------------------------------------
let changed;
let untracked = [];
if (staged) {
  changed = lines(gitText(["diff", "--cached", "--name-only", "--no-renames"]));
} else {
  const tracked = lines(gitText(["diff", "--name-only", "--no-renames", "HEAD"]));
  untracked = lines(gitText(["ls-files", "--others", "--exclude-standard"]));
  changed = [...new Set([...tracked, ...untracked])];
}
const deletedSet = new Set(lines(gitText(staged ? ["diff", "--cached", "--name-only", "--diff-filter=D"] : ["diff", "--name-only", "--diff-filter=D", "HEAD"])));
const files = changed.filter((f) => !deletedSet.has(f));
const untrackedSet = new Set(untracked);

function readNow(f) {
  if (staged) {
    const r = git(["show", ":" + f]);
    return r.status === 0 ? r.stdout : null;
  }
  try { return fs.readFileSync(path.join(ROOT, f)); } catch { return null; }
}
function readHead(f) {
  const r = git(["show", "HEAD:" + f]);
  return r.status === 0 ? r.stdout : null;
}

const TEXT_EXT = new Set([".txt", ".md", ".cfg", ".ini", ".sma", ".inc", ".cpp", ".c", ".h", ".hpp", ".mjs", ".js", ".json", ".py", ".ps1", ".bat", ".cmd", ".sh", ".yml", ".yaml", ".html", ".css", ".sql", ".cmake", ".rc", ".gitignore", ".gitattributes", ".toml", ".url", ".java", ".patch"]);
const isText = (f) => { const e = path.extname(f).toLowerCase(); return TEXT_EXT.has(e) || /(^|\/)(CMakeLists\.txt|README|LICENSE|Dockerfile|Caddyfile\.template)$/i.test(f); };
// Apollo RP's own files (the upstream's bytes, Latin-1 in places, and mixed line endings) in the apollo-rp folder and in every copy of it
const isArp = (f) => /^apollo-rp\//.test(f) || /(^|\/)configs\/arp\//.test(f) || /(^|\/)(ARP_[A-Za-z0-9]+\.sma|ApolloRP[A-Za-z_]*\.inc)$/.test(f);
const eolOf = (b) => { let crlf = 0, lf = 0; for (let i = 0; i < b.length; i++) if (b[i] === 10) { if (i > 0 && b[i - 1] === 13) crlf++; else lf++; } return { crlf, lf, kind: crlf && !lf ? "CRLF" : (lf && !crlf ? "LF" : (!crlf && !lf ? "none" : "mixed")) }; };

// ---- the checks -----------------------------------------------------------------------------------------------------
const results = [];
function add(name, status, summary, detail = []) { results.push({ name, status, summary, detail }); }
const wanted = (name) => !only || only.includes(name);

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...o });
  return { code: r.status === null ? 2 : r.status, out: (r.stdout || "") + (r.stderr || ""), err: r.error };
}
const tail = (s, n = 14) => s.split(/\r?\n/).filter((l) => l.trim() && !/^wrote /.test(l)).slice(-n);

// git-state
if (wanted("git-state")) {
  const branch = (() => { try { return gitText(["rev-parse", "--abbrev-ref", "HEAD"]).trim(); } catch { return "?"; } })();
  const mod = staged ? 0 : lines(gitText(["diff", "--name-only", "--no-renames", "HEAD"])).length;
  const stagedN = lines(gitText(["diff", "--cached", "--name-only", "--no-renames"])).length;
  add("git-state", "pass", `branch ${branch}: ${staged ? "" : mod + " changed, "}${stagedN} staged, ${untracked.length} untracked, ${files.length} file(s) looked at`);
}

// hygiene
if (wanted("hygiene")) {
  const fails = [], warns = [];
  for (const f of files) {
    const buf = readNow(f);
    if (!buf) continue;
    const ext = path.extname(f).toLowerCase();
    // a binary replaced by a git-lfs stub
    if (/\.(dll|exe|amxx|so|wasm|avi|spr)$/i.test(f) && buf.length < 400 && buf.toString("latin1").startsWith("version https://git-lfs")) {
      fails.push(f + ": a git-lfs stub where a binary should be");
      continue;
    }
    if (/\.(bak|tmp|orig|rej)$|\.bak_|~$/i.test(f) && !/\.(dll|exe|amxx)\.bak/i.test(f)) warns.push(f + ": a scratch file (a text file's backup is git's job)");
    if (buf.length > 25 * 1024 * 1024 && !/\.(bsp|mdl|wad|zip|7z|rar|ztmp|wasm|data|avi|exe|dll|pdb|lib)$/i.test(f)) warns.push(f + ": " + Math.round(buf.length / 1048576) + " MB and not an LFS type");
    if (!isText(f) || buf.indexOf(0) >= 0 && buf.indexOf(0) < 8192) continue;
    const isPatch = ext === ".patch";
    // control bytes other than tab, CR, LF (a BEL or a tab where a backslash sequence was meant)
    let bad = -1;
    for (let i = 0; i < buf.length; i++) { const c = buf[i]; if (c < 32 && c !== 9 && c !== 10 && c !== 13 && !(isPatch && c === 12)) { bad = i; break; } }
    if (bad >= 0) {
      const line = buf.slice(0, bad).toString("latin1").split("\n").length;
      fails.push(`${f}:${line}: control byte 0x${buf[bad].toString(16).padStart(2, "0")} (a backslash sequence turned into a control character?)`);
    }
    // plugin sources and configs are ASCII (the compiler and the config reader read them byte by byte); Apollo RP's own sources are as upstream left them
    if (/\.(sma|inc|cfg)$/i.test(f) && !isArp(f)) {
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 127) { fails.push(`${f}:${buf.slice(0, i).toString("latin1").split("\n").length}: a non-ASCII byte (plugin sources and configs are ASCII)`); break; }
      }
    }
    // merge markers
    const text = buf.toString("latin1");
    if (!isPatch && /^(<{7} |>{7} |={7}$)/m.test(text) && /^<{7} /m.test(text) && /^>{7} /m.test(text)) fails.push(f + ": a merge conflict marker");
    // line endings flipped: a change git itself sees, that is gone when line endings are ignored (core.autocrlf is respected,
    // because it is git that decides what a change is)
    if (!isPatch) {
      if (!untrackedSet.has(f)) {
        const base = staged ? ["diff", "--cached", "--numstat"] : ["diff", "--numstat"];
        const count = (extra) => {
          const r = git([...base, ...extra, ...(staged ? [] : ["HEAD"]), "--", f], { encoding: "utf8" });
          const m = /^(\d+)\s+(\d+)\s/.exec(String(r.stdout || ""));
          return m ? Number(m[1]) + Number(m[2]) : 0;
        };
        const all = count([]);
        if (all > 0) {
          const real = count(["--ignore-cr-at-eol"]);
          if (real === 0) fails.push(`${f}: the whole change (${all} lines) is line endings: git apply, an editor or autocrlf flipped them`);
          else if (all >= 40 && real * 2 < all) warns.push(`${f}: ${all - real} of ${all} changed lines are line endings only`);
        }
      }
      if (!isArp(f) && eolOf(buf).kind === "mixed" && (untrackedSet.has(f) || !readHead(f) || eolOf(readHead(f)).kind !== "mixed")) warns.push(f + ": line endings are mixed");
    }
  }
  const detail = [...fails.map((s) => "FAIL " + s), ...warns.map((s) => "warn " + s)];
  add("hygiene", fails.length ? "fail" : (warns.length ? "warn" : "pass"), fails.length ? fails.length + " fault(s)" : (warns.length ? warns.length + " warning(s)" : "no control bytes, flipped line endings, stubs or scratch files"), detail);
}

// secrets
if (wanted("secrets")) {
  const hard = [
    [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "a private key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
    [/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{15,}\/[\w-]{30,}/, "a Discord webhook URL"],
    [/\bxox[baprs]-[0-9A-Za-z-]{10,}/, "a Slack token"],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "a GitHub token"],
  ];
  const soft = /\b(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["'][^"'\s<>{}$]{14,}["']/i;
  const fails = [], warns = [];
  for (const f of files) {
    if (!isText(f) || /^(docs|h9web\/test|tools\/status-check)/.test(f) && false) continue;
    const buf = readNow(f);
    if (!buf || buf.length > 8 * 1024 * 1024 || (buf.indexOf(0) >= 0 && buf.indexOf(0) < 8192)) continue;
    const text = buf.toString("latin1");
    for (const [re, what] of hard) { const m = re.exec(text); if (m) fails.push(`${f}:${text.slice(0, m.index).split("\n").length}: ${what}`); }
    const m = soft.exec(text);
    if (m && !/example|placeholder|changeme|your[_-]|xxxx/i.test(m[0])) warns.push(`${f}:${text.slice(0, m.index).split("\n").length}: a quoted value after ${m[0].split(/[:=]/)[0].trim()} (a secret? the file is not printed here)`);
  }
  add("secrets", fails.length ? "fail" : (warns.length ? "warn" : "pass"), fails.length ? fails.length + " secret(s) found" : (warns.length ? warns.length + " to look at" : "none of the usual kinds"), [...fails.map((s) => "FAIL " + s), ...warns.map((s) => "warn " + s)]);
}

// cvar-docs: a cvar or command a changed source registers that COMMANDS.txt does not mention
if (wanted("cvar-docs")) {
  let commands = "";
  try { commands = fs.readFileSync(path.join(ROOT, "docs", "COMMANDS.txt"), "latin1"); } catch { try { commands = fs.readFileSync(path.join(ROOT, "COMMANDS.txt"), "latin1"); } catch { /* none */ } }
  const missing = [];
  if (commands) {
    for (const f of files) {
      if (!(/^src\/[^/]+\.sma$/i.test(f) || /^[^/]+\.sma$/i.test(f) || /^reTS\/cl_dll\/[^/]+\.cpp$/i.test(f)) || isArp(f)) continue;
      const buf = readNow(f);
      if (!buf) continue;
      const text = buf.toString("latin1");
      const names = new Set();
      for (const m of text.matchAll(/register_cvar\s*\(\s*"([A-Za-z0-9_]+)"/g)) names.add(m[1]);
      for (const m of text.matchAll(/CVAR_CREATE\s*\(\s*"([A-Za-z0-9_]+)"/g)) names.add(m[1]);
      for (const m of text.matchAll(/pfnAddCommand\s*\(\s*"([A-Za-z0-9_]+)"/g)) names.add(m[1]);
      for (const m of text.matchAll(/register_[cs]\w*cmd\s*\(\s*"([A-Za-z0-9_]+)"/g)) names.add(m[1]);
      for (const n of names) if (!n.startsWith("_") && /^(h9_|tsm_|cl_h9_|arp_|ts_|h9)/.test(n) && !commands.includes(n)) missing.push(`${f}: ${n}`);
    }
  }
  add("cvar-docs", missing.length ? "warn" : "pass", missing.length ? missing.length + " cvar(s) or command(s) not in COMMANDS.txt" : "every cvar and command a changed source registers is in COMMANDS.txt", missing.map((s) => "warn " + s));
}

// the repository's own checkers
function tool(name, label, args, extra = {}) {
  if (!wanted(label)) return;
  const file = path.join(ROOT, "tools", name);
  if (!fs.existsSync(file)) { add(label, "skip", "tools/" + name + " is not here"); return; }
  const r = run(process.execPath, [file, ...args], extra);
  add(label, r.code === 0 ? "pass" : "fail", r.code === 0 ? tail(r.out, 1)[0] || "ok" : "failed (exit " + r.code + ")", r.code === 0 ? [] : tail(r.out));
}
if (!staged) {
  tool("patch-notes-check.mjs", "patch-notes", ["--worktree"]);
} else {
  // a staged commit: the notes must be staged too
  if (wanted("patch-notes") && fs.existsSync(path.join(ROOT, "tools", "patch-notes-check.mjs"))) {
    const r = run(process.execPath, [path.join(ROOT, "tools", "patch-notes-check.mjs"), "--base", "HEAD", "--head", "HEAD"], { env: { ...process.env } });
    // an empty range says nothing: ask the index instead, through a temporary tree
    const tree = run("git", ["write-tree"]);
    if (tree.code === 0) {
      const r2 = run(process.execPath, [path.join(ROOT, "tools", "patch-notes-check.mjs"), "--base", "HEAD", "--head", tree.out.trim()]);
      add("patch-notes", r2.code === 0 ? "pass" : "fail", r2.code === 0 ? tail(r2.out, 1)[0] || "ok" : "failed (exit " + r2.code + ")", r2.code === 0 ? [] : tail(r2.out));
    } else add("patch-notes", "skip", "could not write a tree of the index: " + (r.out || "").slice(0, 80));
  }
}
tool("preset-check.mjs", "preset", []);
tool("release-check.mjs", "release", []);

// the master tree and this copy
if (wanted("mirror") && !fast) {
  const script = path.join(ROOT, "tools", "mirror-check.ps1");
  if (!fs.existsSync(MASTER) || !fs.existsSync(script)) add("mirror", "skip", "the master tree (" + MASTER + ") or tools/mirror-check.ps1 is not here");
  else {
    let r = run("pwsh", ["-NoProfile", "-File", script]);
    if (r.err) r = run("powershell", ["-NoProfile", "-File", script]);
    const last = tail(r.out, 1)[0] || "";
    add("mirror", r.code === 0 ? "pass" : "fail", r.code === 0 ? last.trim() : "the copy and the master differ", r.code === 0 ? [] : tail(r.out, 12));
  }
} else if (wanted("mirror")) add("mirror", "skip", "--fast");

// the test suites, when their folders changed (or --all)
if (wanted("h9web-tests")) {
  const touched = flag("all") || files.some((f) => f.startsWith("h9web/") || f.startsWith("havoc9.org/"));
  if (fast || !touched) add("h9web-tests", "skip", fast ? "--fast" : "h9web did not change");
  else {
    const dir = path.join(ROOT, "h9web", "test");
    const tests = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".test.js")).map((n) => path.join("test", n)) : [];
    const r = run(process.execPath, ["--test", "--test-timeout=30000", ...tests], { cwd: path.join(ROOT, "h9web") });
    const pass = /# pass (\d+)/.exec(r.out) || /ℹ pass (\d+)/.exec(r.out);
    const fail = /# fail (\d+)/.exec(r.out) || /ℹ fail (\d+)/.exec(r.out);
    add("h9web-tests", r.code === 0 ? "pass" : "fail", r.code === 0 ? (pass ? pass[1] + " tests pass" : "ok") : "failed" + (fail ? " (" + fail[1] + " failing)" : ""), r.code === 0 ? [] : tail(r.out, 14));
  }
}
if (wanted("serverlist-tests")) {
  const touched = flag("all") || files.some((f) => f.startsWith("serverlist-bot/"));
  if (fast || !touched) add("serverlist-tests", "skip", fast ? "--fast" : "serverlist-bot did not change");
  else {
    let r = run("python", ["-m", "unittest", "discover", "-s", "serverlist-bot", "-p", "test_*.py"]);
    if (r.err) r = run("py", ["-3", "-m", "unittest", "discover", "-s", "serverlist-bot", "-p", "test_*.py"]);
    add("serverlist-tests", r.code === 0 ? "pass" : "fail", r.code === 0 ? (/Ran (\d+) tests?/.exec(r.out) || [0, "?"])[0] + " ok" : "failed", r.code === 0 ? [] : tail(r.out, 12));
  }
}

// ---- the report -----------------------------------------------------------------------------------------------------
const mark = { pass: "[ ok ]", fail: "[FAIL]", warn: "[warn]", skip: "[skip]" };
const out = [];
out.push("status-check: " + (staged ? "the staged files" : "the working tree against HEAD") + (fast ? " (fast)" : ""));
for (const r of results) {
  out.push(`  ${mark[r.status]} ${r.name.padEnd(17)} ${r.summary}`);
  for (const d of r.detail.slice(0, 30)) out.push("           " + d);
  if (r.detail.length > 30) out.push(`           ... ${r.detail.length - 30} more`);
}
const nFail = results.filter((r) => r.status === "fail").length;
const nWarn = results.filter((r) => r.status === "warn").length;
out.push("");
out.push(nFail ? `${nFail} check(s) FAILED${nWarn ? ", " + nWarn + " with warnings" : ""}: fix what is named above before committing.` : (nWarn ? `nothing failed; ${nWarn} check(s) have warnings.` : "everything passed."));
console.log(out.join("\n"));

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ["### Status check", "", "| | check | result |", "|---|---|---|", ...results.map((r) => `| ${r.status} | ${r.name} | ${r.summary.replace(/\|/g, "/")} |`)];
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n"); } catch { /* the log has it */ }
}
process.exit(nFail || (strict && nWarn) ? 1 : 0);
