#!/usr/bin/env node
/*
release-check.mjs -- the places that state the build and the release, against the sources they come from.

    node tools\release-check.mjs                 check: exit 1 and say what is off
    node tools\release-check.mjs --write         rewrite what is generated: the download page's "Version x" notes
    node tools\release-check.mjs --root <dir>    another tree (the git copy); the default is this one

  build    VERSION in ts_matchmode.sma is the build: what the plugin registers (so what the site's list of a server's plugins
           shows for it), what export.bat writes into VERSION.txt (which names the server package) and what the site's download
           page says (havoc9.org/downloads/index.html: <p class="download-note">Version ...</p>). Bump it in the plugin and run
           this with --write; build.bat and export.bat do.
  release  the join gate's release (docs/H9_RELEASE.txt): the first word of xash3d-h9-patches/overlay/ts/h9_release.txt, the one
           file a release is bumped in. The game folder's copy (H9XASH/ts/h9_release.txt) and the plugins' (include/h9_release.inc,
           written by build.bat from that file) must carry the same word, or h9_presence logs PACKAGE MISMATCH and the server holds
           joiners to the plugins' release alone.

The GitHub workflow .github/workflows/preset-hash.yml runs this and tools/preset-check.mjs.
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const write = argv.includes("--write");
const root = path.resolve(opt("root", path.resolve(here, "..")));
const rel = (p) => path.relative(root, p).replace(/\\/g, "/");

const read = (p) => { try { return fs.readFileSync(p, "latin1"); } catch { return null; } };
const canOpen = (p) => { try { fs.closeSync(fs.openSync(p, "r")); return true; } catch { return false; } };
const first = (...candidates) => candidates.map((p) => path.join(root, p)).find((p) => canOpen(p)) || null;

const problems = [];
const notes = [];

// ---- the build
let build = "";
const sma = first("ts_matchmode.sma", "src/ts_matchmode.sma", "H9XASH/ts/addons/amxmodx/scripting/ts_matchmode.sma");
if (!sma) {
  problems.push("ts_matchmode.sma is not in " + root + " (looked in the root, src/ and H9XASH/ts/addons/amxmodx/scripting/)");
} else {
  const m = /^#define\s+VERSION\s+"([^"]+)"/m.exec(read(sma));
  if (!m) problems.push(rel(sma) + ": no #define VERSION \"...\" line");
  else build = m[1];
}

const page = path.join(root, "havoc9.org", "downloads", "index.html");
const noteRe = /(<p class="download-note">Version )([^<]*)(<\/p>)/g;
const html = build ? read(page) : null;
if (build && html !== null) {
  const seen = [...html.matchAll(noteRe)].map((m) => m[2]);
  if (!seen.length) {
    problems.push(rel(page) + ": no <p class=\"download-note\">Version ...</p> note to carry the build");
  } else if (write) {
    const out = html.replace(noteRe, (_all, a, _old, c) => a + build + c);
    if (out !== html) {
      fs.writeFileSync(page, out, "latin1");
      notes.push(rel(page) + ": " + seen.filter((v) => v !== build).length + " of " + seen.length + " notes now say Version " + build);
    }
  } else {
    for (const v of seen) if (v !== build) problems.push(rel(page) + ": a download note says Version " + v + " and the build is " + build);
  }
} else if (build) {
  notes.push("(no " + rel(page) + " in this tree: the download page is not checked)");
}

// ---- the release
const overlay = path.join(root, "xash3d-h9-patches", "overlay", "ts", "h9_release.txt");
const word = (text) => (text || "").trim().split(/\s+/)[0] || "";
let release = "";
if (fs.existsSync(overlay)) {
  release = word(read(overlay));
  if (!release) problems.push(rel(overlay) + " is empty");
  const game = path.join(root, "H9XASH", "ts", "h9_release.txt");
  if (release && fs.existsSync(game) && word(read(game)) !== release) {
    problems.push(rel(game) + " says " + word(read(game)) + " and the release is " + release + " (xash.bat's overlay lays the file in)");
  }
  const inc = first("include/h9_release.inc", "src/include/h9_release.inc");
  if (release && inc) {
    const m = /^#define\s+H9_RELEASE\s+"([^"]*)"/m.exec(read(inc));
    if (!m || m[1] !== release) problems.push(rel(inc) + " says " + (m ? m[1] : "nothing") + " and the release is " + release + " (build.bat writes it from the overlay's file)");
  }
} else {
  notes.push("(no " + rel(overlay) + " in this tree: the release is not checked)");
}

for (const n of notes) console.log(n);
if (problems.length) {
  for (const p of problems) console.error("release-check: " + p);
  console.error("\nBuild " + (build || "?") + ", release " + (release || "?") + ". Fix the sources (docs/H9_RELEASE.txt) and run build.bat, or: node tools/release-check.mjs --write");
  if (process.env.GITHUB_ACTIONS) {
    for (const p of problems) console.log("::error::" + p);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
          "### The build and the release do not agree", "", ...problems.map((p) => "- " + p), "",
          "**To fix it:** bump the build in `ts_matchmode.sma` (`#define VERSION`) and the release in `xash3d-h9-patches/overlay/ts/h9_release.txt` (`docs/H9_RELEASE.txt`), then run `build.bat` (it writes `include/h9_release.inc` and the download page's notes), or `node tools/release-check.mjs --write` for the download page alone.", "",
        ].join("\n"));
      } catch { /* the log has it */ }
    }
  }
  process.exit(1);
}
console.log("release-check: build " + build + (release ? ", release " + release : "") + ": the download page, the game folder and the plugins agree");
