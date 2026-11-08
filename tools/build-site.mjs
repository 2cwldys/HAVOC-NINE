// Assembles the static site for a static host (Netlify, or any CDN) from havoc9.org/ by an ALLOWLIST: only pages, styles, scripts, pictures and
// the web client's shell go in; deploy scripts, setup notes, the downloads folder's server-side files, archives and anything else never do.
// The backend (accounts, forum, relay, /serverlist, /downloads) is not part of it: those paths stay on the origin server.
//
//   node tools/build-site.mjs [--out site] [--check]
//
// --check builds into a temporary folder, lists what would be published and fails on anything outside the allowlist or on a forbidden name.
// Exit 0 = built (or clean), 1 = a forbidden file or an empty result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "havoc9.org");
const args = process.argv.slice(2);
const check = args.includes("--check");
const outArg = args.indexOf("--out");
const OUT = check ? fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), "h9site-")) : path.resolve(ROOT, outArg >= 0 ? args[outArg + 1] : "site");

// What may be published: by extension, and only below these folders or files.
const EXT = /\.(html|css|js|json|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|mp4|webm|txt|md)$/i;
// Never, wherever they sit.
const DENY = [
  /(^|\/)deploy\//i, /DEPLOY\.txt$/i, /(^|\/)\.htaccess$/i, /README\.md$/i, /MASTER_SERVER\.txt$/i,
  /\.(sh|ps1|bat|cmd|zip|7z|tar|gz|bak|log|pid|key|pem|db|sqlite)$/i, /(^|\/)downloads\/files\//i, /(^|\/)\./,
  /^webclient\/(engine|game)\//i, /^webclient\/(manifest|preload)\.json$/i,
];
// Of the .txt and .md files only these (the AI-context brief is offered for download on the join page).
const TEXT_OK = new Set(["join/HAVOC9-AI-CONTEXT.md"]);

function isLfsPointer(file) {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(40);
  const n = fs.readSync(fd, b, 0, 40, 0);
  fs.closeSync(fd);
  return b.slice(0, n).toString("latin1").startsWith("version https://git-lfs");
}

const published = [];
const refused = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(SRC, full).replace(/\\/g, "/");
    const st = fs.statSync(full);
    if (st.isDirectory()) { if (!DENY.some((rx) => rx.test(rel + "/"))) walk(full); else refused.push(rel + "/"); continue; }
    if (DENY.some((rx) => rx.test(rel)) || !EXT.test(name)) { refused.push(rel); continue; }
    if (/\.(txt|md)$/i.test(name) && !TEXT_OK.has(rel)) { refused.push(rel); continue; }
    if (isLfsPointer(full)) { refused.push(rel + " (an LFS pointer)"); continue; }
    published.push(rel);
  }
}
walk(SRC);

fs.rmSync(OUT, { recursive: true, force: true });
for (const rel of published) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), dest);
}
// the host's own files: headers, and a 404 and robots when the site has none
const HEADERS = path.join(ROOT, "netlify", "_headers");
if (fs.existsSync(HEADERS)) fs.copyFileSync(HEADERS, path.join(OUT, "_headers"));
if (!fs.existsSync(path.join(OUT, "robots.txt"))) fs.writeFileSync(path.join(OUT, "robots.txt"), "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\n");
if (!fs.existsSync(path.join(OUT, "404.html"))) {
  fs.writeFileSync(path.join(OUT, "404.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title></head><body style="font-family:sans-serif;background:#111;color:#ddd;text-align:center;padding-top:20vh"><h1>Not found</h1><p><a style="color:#9cf" href="/">HAVOC 9</a></p></body></html>\n');
}

// the checks the listing test makes
let bad = 0;
const all = [];
(function list(d) { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) list(f); else all.push(path.relative(OUT, f).replace(/\\/g, "/")); } })(OUT);
for (const rel of all) {
  if (rel === "_headers" || rel === "robots.txt" || rel === "404.html") continue;
  if (DENY.some((rx) => rx.test(rel))) { console.log("FORBIDDEN in the output: " + rel); bad++; }
}
if (!all.includes("index.html")) { console.log("no index.html in the output"); bad++; }
console.log(`${check ? "check" : "built " + OUT}: ${all.length} files published, ${refused.length} left out, ${bad} problem(s)`);
if (check) fs.rmSync(OUT, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
