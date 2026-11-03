// Local testing only: serves folders as the site (config.devStatic), so the pages, the API and
// the relay share one origin on 127.0.0.1 without nginx. On the VPS nginx serves the site and
// devStatic stays null. GET and HEAD only; no listings; dot files and backups are not served.

import fs from "node:fs";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
  ".png": "image/png", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".wasm": "application/wasm", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

// A part of the path that is never served: a dot file or folder, a backup or a zip, and the
// shapes Windows reads as another file than they look (a\b, name:stream, "name." and "name ",
// the short name NAME~1), which no address on the site has.
const BAD_PART = /^\.|[\\:~]|[. ]$|\.(bak[^/]*|zip)$/i;

export function serveStatic(req, res, mounts) {
  if (!mounts || (req.method !== "GET" && req.method !== "HEAD")) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://h9web.invalid").pathname);
  } catch (e) {
    return false;
  }
  const prefix = Object.keys(mounts).filter((p) => pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  if (!prefix) return false;
  const root = mounts[prefix];
  const rel = pathname.slice(prefix.length);
  if (rel.split("/").some((part) => BAD_PART.test(part)) || rel.includes("\0")) return notFound(res);
  let file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return notFound(res);
  let stat;
  try {
    stat = fs.statSync(file);
    if (stat.isDirectory()) {
      if (!pathname.endsWith("/")) {
        res.writeHead(301, { Location: pathname + "/" });
        res.end();
        return true;
      }
      file = path.join(file, "index.html");
      stat = fs.statSync(file);
    }
  } catch (e) {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);
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
