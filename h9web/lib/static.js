// Local testing only: serves folders as the site (config.devStatic), so the pages, the API and
// the relay share one origin on 127.0.0.1 without nginx. On the VPS nginx serves the site and
// devStatic stays null. GET and HEAD only; dot files and backups are not served. A folder mounted
// as { dir, listing: true } is a plain file index instead, as the site's /downloads/files/ is on
// the VPS (havoc9.org/deploy/nginx-setup.sh): a listing of that folder, and in it only packages,
// their reports and checksums (.zip, .exe and .txt files), never a dot file, a subfolder or a
// link. No other folder is listed.

import fs from "node:fs";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
  ".png": "image/png", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".wasm": "application/wasm", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".zip": "application/zip",
};

// A part of the path that is never served: a dot file or folder, a backup or a zip, and the
// shapes Windows reads as another file than they look (a\b, name:stream, "name." and "name ",
// the short name NAME~1), which no address on the site has.
const BAD_PART = /^\.|[\\:~]|[. ]$|\.(bak[^/]*|zip)$/i;

// A name a listing shows and serves: a package, a report or the checksums. Not a dot file, and
// none of the shapes Windows reads as another file (name:stream, NAME~1); ending in .zip, .exe
// or .txt, it is never "name." or "name " either.
const PACKAGE = /^[^.\\/:~][^\\/:~]*\.(?:zip|exe|txt)$/i;

export function serveStatic(req, res, mounts) {
  if (!mounts || (req.method !== "GET" && req.method !== "HEAD")) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://h9web.invalid").pathname);
  } catch (e) {
    return false;
  }
  // a mounted folder's own address, without its last slash
  if (!pathname.endsWith("/") && Object.hasOwn(mounts, pathname + "/")) return redirect(res, pathname + "/");
  const prefix = Object.keys(mounts).filter((p) => pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  if (!prefix) return false;
  const mount = mounts[prefix];
  const rel = pathname.slice(prefix.length);
  if (rel.includes("\0")) return notFound(res);
  if (typeof mount !== "string") return serveListing(req, res, prefix, mount.dir, rel);
  const root = mount;
  if (rel.split("/").some((part) => BAD_PART.test(part))) return notFound(res);
  let file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return notFound(res);
  let stat;
  try {
    stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (!pathname.endsWith("/")) return redirect(res, pathname + "/");
      file = path.join(file, "index.html");
      stat = fs.statSync(file);
    }
  } catch (e) {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);
  return sendFile(req, res, file, stat);
}

// A listing mount: the folder's index at its own address, and a package in it by its name.
// Only regular files count (lstat): a link is neither listed nor followed.
function serveListing(req, res, prefix, dir, rel) {
  if (rel === "") return sendIndex(req, res, prefix, dir);
  if (!PACKAGE.test(rel)) return notFound(res);
  const file = path.join(dir, rel);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);
  return sendFile(req, res, file, stat);
}

function sendIndex(req, res, prefix, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return notFound(res);
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !PACKAGE.test(entry.name)) continue;
    try {
      const stat = fs.lstatSync(path.join(dir, entry.name));
      if (stat.isFile()) rows.push({ name: entry.name, size: stat.size, mtime: stat.mtime });
    } catch (e) {
      /* gone since the folder was read */
    }
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const title = "Index of " + escapeHtml(prefix);
  const html = "<!DOCTYPE html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><title>" + title + "</title></head>\n<body>\n" +
    "<h1>" + title + "</h1>\n<table>\n<tr><th>Name</th><th>Modified (UTC)</th><th>Bytes</th></tr>\n" +
    "<tr><td><a href=\"../\">../</a></td><td></td><td></td></tr>\n" +
    rows.map((r) => "<tr><td><a href=\"" + encodeURIComponent(r.name) + "\">" + escapeHtml(r.name) + "</a></td><td>" +
      r.mtime.toISOString().slice(0, 16).replace("T", " ") + "</td><td>" + r.size + "</td></tr>\n").join("") +
    "</table>\n</body>\n</html>\n";
  const body = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
}

function redirect(res, location) {
  res.writeHead(301, { Location: location });
  res.end();
  return true;
}

function sendFile(req, res, file, stat) {
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  return true;
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
  return true;
}
