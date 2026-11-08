// One command for a safe static-site build: assemble site/ from the allowlist, then refuse to go on if anything could leak or break under
// the site's own security headers. Nothing is uploaded unless you ask for a draft deploy, and a production deploy needs a typed word.
//
//   node tools/netlify-build.mjs                build site/ and check it (the default)
//   node tools/netlify-build.mjs serve [port]   build, check, and serve site/ on 127.0.0.1 (default 8888) WITH netlify/_headers applied,
//                                               so the CSP can be tried in a browser; the API paths answer 404 (they live on the VPS)
//   node tools/netlify-build.mjs deploy         build, check, then a DRAFT deploy (a preview URL) with the Netlify CLI
//   node tools/netlify-build.mjs deploy --prod  the same to production; asks you to type PRODUCTION first
//
// The Netlify account is yours: the CLI takes its token from NETLIFY_AUTH_TOKEN and the site from NETLIFY_SITE_ID (environment only,
// never a file in this repository, never an argument). Exit 0 = every check passed, 1 = a problem (nothing was deployed).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const [cmd = "build", ...rest] = process.argv.slice(2);
let problems = 0;
const bad = (m) => { console.log("  PROBLEM  " + m); problems++; };
const warn = (m) => console.log("  note     " + m);
const ok = (m) => console.log("  ok       " + m);
const run = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", ...opts });

function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    if (fs.statSync(f).isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}
const rel = (f) => path.relative(SITE, f).replace(/\\/g, "/");

function build() {
  console.log("1. assemble site/ from the allowlist");
  if (run(["tools/build-site.mjs", "--out", "site"]).status !== 0) { bad("tools/build-site.mjs failed"); return false; }
  console.log("2. the build's own listing check");
  if (run(["tools/build-site.mjs", "--check"]).status !== 0) { bad("a forbidden file would be published"); return false; }
  console.log("3. secrets in what will be published");
  if (run(["tools/secret-scan.mjs", "site"]).status !== 0) { bad("tools/secret-scan.mjs found something in site/ (names above, no values)"); return false; }
  ok("no secret found");

  const files = walk(SITE);
  console.log("4. size and file kinds (" + files.length + " files)");
  let total = 0;
  for (const f of files) {
    const size = fs.statSync(f).size;
    total += size;
    if (size > 10 * 1024 * 1024) warn(rel(f) + " is " + (size / 1048576).toFixed(1) + " MB (Netlify supports files over ~10 MB poorly)");
    if (/\.(map|bak|orig|env|key|pem|sqlite|db|zip|sh|ps1|bat)$/i.test(f)) bad("a file kind that should never be published: " + rel(f));
  }
  ok((total / 1048576).toFixed(1) + " MB in all");

  console.log("5. pages against the security headers (netlify/_headers)");
  const headers = fs.existsSync(path.join(SITE, "_headers")) ? fs.readFileSync(path.join(SITE, "_headers"), "utf8") : "";
  if (!headers) bad("no _headers in site/");
  for (const need of ["Strict-Transport-Security", "X-Content-Type-Options", "Content-Security-Policy", "frame-ancestors", "Referrer-Policy"]) {
    if (!headers.includes(need)) bad("_headers has no " + need);
  }
  for (const f of files.filter((x) => /\.html$/i.test(x))) {
    const html = fs.readFileSync(f, "utf8");
    const name = rel(f);
    // script-src 'self': an inline script, an inline handler or a javascript: link would be refused by the browser
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/.test(m[1]) && m[2].trim() && !/type\s*=\s*["']application\/(ld\+)?json/i.test(m[1]));
    if (inline.length) bad(name + ": " + inline.length + " inline <script> (the CSP refuses it: move it to a .js file)");
    if (/\son[a-z]+\s*=\s*["']/i.test(html)) bad(name + ": an inline event handler such as onclick= or onerror= (the CSP refuses it)");
    if (/href\s*=\s*["']\s*javascript:/i.test(html)) bad(name + ": a javascript: link");
    for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:)?\/\/[^"']+/gi)) bad(name + ": a script from another site (" + m[0].slice(-40) + ")");
    for (const m of html.matchAll(/<(?:link|img|iframe|source)\b[^>]*\b(?:href|src)\s*=\s*["'](https?:)?\/\/([^/"']+)/gi)) {
      const host = m[2];
      if (!/(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(host) && !headers.includes(host)) warn(name + ": loads from " + host + ", which the CSP does not list");
    }
    if (/<form\b[^>]*\baction\s*=\s*["']https?:\/\//i.test(html)) bad(name + ": a form that posts to another site");
  }
  console.log(problems ? "\nNOT SAFE TO DEPLOY: " + problems + " problem(s) above" : "\nsite/ is ready: " + files.length + " files, every check passed");
  return problems === 0;
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm" };

// netlify/_headers as a server would apply it: a block's path pattern, then its header lines; "! Name" removes one set earlier
function parseHeaders(text) {
  const blocks = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) { cur = { pattern: raw.trim(), lines: [] }; blocks.push(cur); }
    else if (cur) cur.lines.push(raw.trim());
  }
  return blocks;
}
const matches = (pattern, p) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(p);

function serve(port) {
  const blocks = parseHeaders(fs.readFileSync(path.join(SITE, "_headers"), "utf8"));
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (/^\/(api|serverlist|downloads\/files)\//.test(p) || p === "/webclient/relay") { res.writeHead(404); res.end("on the VPS, not here"); return; }
    let file = path.join(SITE, path.normalize(p).replace(/^(\.\.[\\/])+/, ""));
    if (!file.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const found = fs.existsSync(file);
    if (!found) file = path.join(SITE, "404.html");
    const out = {};
    for (const b of blocks) if (matches(b.pattern, p)) for (const l of b.lines) {
      if (l.startsWith("!")) delete out[l.slice(1).trim().toLowerCase()];
      else { const i = l.indexOf(":"); out[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    }
    res.writeHead(found ? 200 : 404, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", ...out });
    fs.createReadStream(file).pipe(res);
  }).listen(port, "127.0.0.1", () => {
    console.log(`serving site/ at http://127.0.0.1:${port}/ with _headers applied (Ctrl+C stops). Open the browser console: a blocked script or`);
    console.log("style shows as a Content-Security-Policy error. Pages that need the API will say it is not answering: that is expected here.");
  });
}

function confirm(word) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Type ${word} to deploy to the live site: `, (a) => { rl.close(); resolve(a.trim() === word); });
  });
}

async function deploy(prod) {
  if (!process.env.NETLIFY_AUTH_TOKEN || !process.env.NETLIFY_SITE_ID) {
    console.log("set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID in this shell first (a personal access token from your Netlify user settings; the site's ID from its settings).");
    console.log("They are read from the environment only. Nothing was deployed.");
    process.exit(1);
  }
  if (prod && !(await confirm("PRODUCTION"))) { console.log("not confirmed: nothing was deployed"); process.exit(1); }
  const args = ["--yes", "netlify-cli@latest", "deploy", "--dir", "site", "--no-build", ...(prod ? ["--prod"] : [])];
  const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  process.exit(r.status || 0);
}

if (!["build", "serve", "deploy"].includes(cmd)) { console.log("usage: node tools/netlify-build.mjs [build | serve [port] | deploy [--prod]]"); process.exit(2); }
const good = build();
if (!good) process.exit(1);
if (cmd === "serve") serve(Number(rest[0]) || 8888);
else if (cmd === "deploy") await deploy(rest.includes("--prod"));
