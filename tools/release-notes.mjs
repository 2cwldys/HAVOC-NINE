#!/usr/bin/env node
/*
release-notes.mjs -- the patch notes for each release, read out of the commits that made it.

    node tools/release-notes.mjs                      every release the history knows, newest first
    node tools/release-notes.mjs --version 1.68       one release
    node tools/release-notes.mjs --since 1.66         everything after 1.66
    node tools/release-notes.mjs --unreleased         what has landed since the last bump
    node tools/release-notes.mjs --json               the body PUT /api/forum/patchnotes takes
    node tools/release-notes.mjs --markdown           for a post somewhere else
    node tools/release-notes.mjs --max-notes 40       at most this many lines a release (60)
    node tools/release-notes.mjs --verbose            say which commits were left out, and why

What a release IS, here: src/include/h9_release.inc holds the build number, and release-prepare
bumps it. So every commit that changes that number ENDS a release, and the commits between one
bump and the next are what went into it. Nothing else has to be tagged or remembered.

What a commit contributes: its subject line, under the area its paths belong to (AREAS below).
A commit whose body carries

    Release-Note: a line written for players

uses that line instead of the subject, as many times as it says it. A commit with

    Release-Note: skip

is left out. Merges are left out always. Neither trailer is required: without any, the subjects
are the notes, which is why they are worth writing in plain English.

This only READS the repository. Putting the notes on the site is a separate, deliberate step:
--json gives exactly what the admin panel's PATCH NOTES tab saves, so it can be pasted there or
sent with a session cookie.
*/
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = "src/include/h9_release.inc";
const VERSION_RE = /H9_RELEASE\s+"([^"]+)"/;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const VERBOSE = flag("verbose");

// Which area a changed path belongs to, first match winning. The order is the order the notes are
// written in: what a player sees first, then what a server owner sees, then the workshop.
// A folder's name with no slash is a submodule: git names a gitlink by the folder alone, so
// "SMAK/" would never match the commit that bumps it.
const AREAS = [
  ["The game", ["ts/", "reTS/", "AMXMODX/", "src/", "rcbot-patch/", "metamod-r/", "apollo-rp/", "EntMod4/"]],
  ["The client and the engine", ["xash3d-fwgs/", "xash3d-h9-patches/", "H9XASH/", "xash3d-fwgs"]],
  ["Maps", ["maps/", "export-map/", "mapsrc/", "export-map", "sdhlt"]],
  ["Models and sounds", ["modelling/", "SMAK/", "laserrifle/", "hyperframes/", "SMAK", "hyperframes"]],
  ["The website", ["havoc9.org/", "h9web/", "serverlist-bot/"]],
  ["Servers and hosting", ["vps/", "dockerfiles/", "presence/"]],
  ["Build and tools", ["tools/", "scripts/", "webclient-build/", ".github/", ".gitmodules",
    "ship.ps1", "deploy-vps.ps1", "packaging.ini", "build.bat", "export.bat", "xash.bat"]],
  ["Documentation", ["docs/", "README.md", "CONTEXT.md", "CLAUDE.md", "AGENTS.md"]],
];
const OTHER = "Other";
// the bump commit's own subject: "Build 1.68: the join screen and the Mech Warrior effects"
const BUMP_SUBJECT = /^Build\s+[0-9][A-Za-z0-9._-]*\s*[-:\u2014]\s*(.+)$/;

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + (r.stderr || "").trim());
  return r.stdout;
}

// The build number as that commit left it, or "" when the file is not there yet.
function versionAt(rev) {
  const r = spawnSync("git", ["show", rev + ":" + VERSION_FILE], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return "";
  const m = VERSION_RE.exec(r.stdout || "");
  return m ? m[1].trim() : "";
}

// Every commit that CHANGED the build number, oldest first: each one ends the release it names.
function boundaries() {
  const out = [];
  const lines = git(["log", "--reverse", "--format=%H%x00%aI", "--", VERSION_FILE]).split("\n").filter(Boolean);
  for (const line of lines) {
    const [sha, when] = line.split("\0");
    const version = versionAt(sha);
    if (!version) continue;
    const parents = git(["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).slice(1);
    const before = parents.length ? versionAt(parents[0]) : "";
    if (version === before) continue; // the file was touched, the number was not
    out.push({ sha, version, date: when.slice(0, 10) });
  }
  return out;
}

// A commit's Release-Note: lines, or null when it says to skip it.
function trailers(body) {
  const notes = [];
  for (const raw of (body || "").split("\n")) {
    const m = /^\s*Release-Note:\s*(.+?)\s*$/i.exec(raw);
    if (!m) continue;
    if (/^skip\b/i.test(m[1])) return null;
    notes.push(m[1]);
  }
  return notes;
}

// The area a commit belongs to, from the paths it touched. A commit that spreads over several
// goes under the first one it hits, so one commit is never counted twice.
function areaOf(paths) {
  for (const [name, prefixes] of AREAS) {
    if (paths.some((p) => prefixes.some((pre) => (pre.endsWith("/") ? p.startsWith(pre) : p === pre)))) return name;
  }
  return OTHER;
}

const SEP = "\u0001";

// Every commit in (from, to], as { sha, subject, note, area }, newest first.
function commits(from, to) {
  const range = from ? from + ".." + to : to;
  const raw = git(["log", "--no-merges", "--name-only", "--format=" + SEP + "%H%x00%s%x00%b%x00", range]);
  const out = [];
  for (const chunk of raw.split(SEP).slice(1)) {
    const [sha, subject, body, rest] = chunk.split("\0");
    const paths = (rest || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const notes = trailers(body);
    if (notes === null) {
      if (VERBOSE) console.error("  skipped (Release-Note: skip) " + sha.slice(0, 8) + " " + subject);
      continue;
    }
    if (!paths.length) {
      if (VERBOSE) console.error("  skipped (no files)          " + sha.slice(0, 8) + " " + subject);
      continue;
    }
    const area = areaOf(paths);
    for (const line of notes.length ? notes : [subject]) out.push({ sha, area, line: line.trim() });
  }
  return out;
}

// The body of one entry, in the forum's markup: an area a paragraph, one note a line. A release
// with more notes than --max-notes keeps the newest and SAYS how many it left out, so a trimmed
// release never reads as a complete one.
function bodyOf(list, max) {
  const kept = list.slice(0, max);
  const dropped = list.length - kept.length;
  const byArea = new Map();
  for (const c of kept) {
    if (!c.line) continue;
    if (!byArea.has(c.area)) byArea.set(c.area, []);
    const lines = byArea.get(c.area);
    if (!lines.includes(c.line)) lines.push(c.line); // the same note twice reads as a mistake
  }
  const order = [...AREAS.map(([n]) => n), OTHER];
  const parts = [];
  for (const name of order) {
    const lines = byArea.get(name);
    if (!lines || !lines.length) continue;
    parts.push("**" + name + "**\n" + lines.map((l) => "- " + l).join("\n"));
  }
  if (dropped > 0) parts.push("_and " + dropped + " more change" + (dropped === 1 ? "" : "s") + " not listed here._");
  return parts.join("\n\n");
}

function releases() {
  const marks = boundaries();
  if (!marks.length) throw new Error("no release in the history of " + VERSION_FILE);
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const from = i > 0 ? marks[i - 1].sha : "";
    const list = commits(from, m.sha);
    // The bump commit usually summarises the release in its own subject. That is the headline,
    // so it is lifted out rather than left among the notes saying the same thing twice.
    let title = "";
    const head = list.find((c) => c.sha === m.sha);
    const bump = head ? BUMP_SUBJECT.exec(head.line) : null;
    if (bump) {
      title = bump[1].trim();
      const at = list.indexOf(head);
      list.splice(at, 1);
    }
    out.push({ version: m.version, date: m.date, kind: "release", title, list });
  }
  if (flag("unreleased")) {
    const head = git(["rev-parse", "HEAD"]).trim();
    const last = marks[marks.length - 1];
    if (head !== last.sha) {
      const list = commits(last.sha, head);
      // Always "next", never the number in the file: nothing has bumped it yet, so it still names
      // the release that already went out, and two entries with one version is a page the site
      // refuses.
      if (list.length) out.push({ version: "next", date: "", kind: "preview", title: "Not released yet", list });
    }
  }
  out.reverse(); // newest first, the order the page reads in
  return out;
}

function main() {
  let all = releases();
  const one = opt("version", "");
  const since = opt("since", "");
  const names = all.map((r) => r.version);
  if (one) {
    all = all.filter((r) => r.version === one);
    if (!all.length) throw new Error("no release " + one + " (the history has " + names.join(", ") + ")");
  } else if (since) {
    const at = names.indexOf(since);
    if (at < 0) throw new Error("no release " + since + " (the history has " + names.join(", ") + ")");
    all = all.slice(0, at); // newest first, so everything before it in the list came after it in time
  }

  const max = Math.max(1, parseInt(opt("max-notes", "60"), 10) || 60);
  const entries = all.map((r) => ({ version: r.version, date: r.date, kind: r.kind, title: r.title, body: bodyOf(r.list, max) }));
  for (const [i, e] of entries.entries()) {
    if (all[i].list.length > max) console.error("release-notes: " + e.version + " has " + all[i].list.length + " changes; " + max + " are listed (--max-notes raises it)");
    if (e.body.length > 20000) console.error("release-notes: " + e.version + "'s body is " + e.body.length + " characters, over the 20000 the site takes -- lower --max-notes");
  }

  if (flag("json")) {
    const page = {
      title: "Patch notes",
      intro: "What changed in each release of H9XASH, newest first.",
      entries,
    };
    console.log(JSON.stringify(page, null, 2));
    return;
  }
  if (flag("markdown")) {
    for (const e of entries) {
      console.log("## HAVOC 9 " + e.version + (e.date ? "  (" + e.date + ")" : ""));
      console.log("");
      console.log(e.body || "_No notes._");
      console.log("");
    }
    return;
  }
  for (const e of entries) {
    console.log("== " + e.version + (e.date ? "   " + e.date : "") + (e.kind === "release" ? "" : "   [" + e.kind + "]"));
    if (e.title) console.log("   " + e.title);
    console.log(e.body ? e.body.replace(/\*\*/g, "") : "  (nothing)");
    console.log("");
  }
  console.error(entries.length + " release" + (entries.length === 1 ? "" : "s") + ". --json gives what the PATCH NOTES tab saves.");
}

try {
  if (!fs.existsSync(path.join(ROOT, VERSION_FILE))) throw new Error("no " + VERSION_FILE + " -- run this inside the repository");
  main();
} catch (e) {
  console.error("release-notes: " + e.message);
  process.exit(1);
}
