// The local site's downloads' file index (lib/static.js, a devStatic folder given as
// { dir, listing: true }): the listing and the packages in it, nothing else, read-only, as
// nginx-setup.sh and Caddyfile.template serve /downloads/files/ on a host.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { serveStatic } from "../lib/static.js";
import { resolveConfig } from "../lib/config.js";
import { startApp, request } from "./helpers.js";

// One request through serveStatic: { status, headers, text } (status 0: not handled).
function get(url, mounts, method = "GET") {
  return new Promise((resolve) => {
    const res = new PassThrough();
    let status = 0;
    let headers = {};
    const chunks = [];
    res.writeHead = (s, h) => { status = s; headers = h || {}; };
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status, headers, text: Buffer.concat(chunks).toString() }));
    if (!serveStatic({ method, url }, res, mounts)) resolve({ status: 0, headers: {}, text: "" });
  });
}

// A packages folder like dist\: packages, reports and checksums, and things that never show.
function packagesFolder(dir) {
  const files = path.join(dir, "dist");
  fs.mkdirSync(path.join(files, "files"), { recursive: true });
  fs.mkdirSync(path.join(files, ".stage"), { recursive: true });
  fs.writeFileSync(path.join(files, "H9XASH.zip"), "zip bytes");
  fs.writeFileSync(path.join(files, "H9XASH-Updater.exe"), "exe bytes");
  fs.writeFileSync(path.join(files, "H9XASH.report.txt"), "report");
  fs.writeFileSync(path.join(files, "SHA256SUMS.txt"), "sums");
  fs.writeFileSync(path.join(files, "a&b's #1.txt"), "odd name");
  fs.writeFileSync(path.join(files, ".htaccess"), "secret dot file");
  fs.writeFileSync(path.join(files, ".keep"), "");
  fs.writeFileSync(path.join(files, "notes.md"), "not a package");
  fs.writeFileSync(path.join(files, "setup.sh"), "a script");
  fs.writeFileSync(path.join(files, "old.zip.bak"), "a backup");
  fs.writeFileSync(path.join(files, "files", "manifest.json"), "the updater's");
  fs.writeFileSync(path.join(files, "files", "inner.zip"), "in a subfolder");
  fs.writeFileSync(path.join(dir, "outside.txt"), "outside");
  let linked = false;
  try {
    fs.symlinkSync(path.join(dir, "outside.txt"), path.join(files, "link.txt"));
    linked = true;
  } catch (e) {
    /* Windows without the symlink privilege: the link case is left out */
  }
  return { files, linked };
}

test("static listing: the index shows only the packages, reports and checksums, as links", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-listing-"));
  try {
    const { files } = packagesFolder(dir);
    const mounts = { "/downloads/files/": { dir: files, listing: true } };
    const r = await get("/downloads/files/", mounts);
    assert.equal(r.status, 200);
    assert.equal(r.headers["Content-Type"], "text/html; charset=utf-8");
    assert.equal(r.headers["Content-Security-Policy"], "default-src 'none'");
    assert.equal(r.headers["Content-Length"], Buffer.byteLength(r.text));
    assert.match(r.text, /<title>Index of \/downloads\/files\/<\/title>/);
    const links = [...r.text.matchAll(/<a href="([^"]*)">/g)].map((m) => m[1]);
    assert.deepEqual(links, ["../", "H9XASH-Updater.exe", "H9XASH.report.txt", "H9XASH.zip", "SHA256SUMS.txt", "a%26b's%20%231.txt"]);
    assert.ok(r.text.includes(">a&amp;b&#39;s #1.txt</a>"), "a name is escaped in the page");
    assert.ok(r.text.includes("<td>9</td>"), "the size in bytes");
    for (const hidden of [".htaccess", ".keep", ".stage", "notes.md", "setup.sh", "old.zip.bak", "manifest.json", "inner.zip", "outside", "link.txt"]) {
      assert.ok(!r.text.includes(hidden), hidden + " is not listed");
    }
    const head = await get("/downloads/files/", mounts, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
    assert.equal(head.headers["Content-Length"], Buffer.byteLength(r.text));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("static listing: a package by name; a dot file, a subfolder, a link or any other name is a 404", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-listing-"));
  try {
    const { files, linked } = packagesFolder(dir);
    const mounts = { "/": path.join(dir, "site"), "/downloads/files/": { dir: files, listing: true } };
    fs.mkdirSync(mounts["/"]);
    fs.writeFileSync(path.join(mounts["/"], "page.zip"), "zip");
    const zip = await get("/downloads/files/H9XASH.zip", mounts);
    assert.deepEqual([zip.status, zip.text, zip.headers["Content-Type"]], [200, "zip bytes", "application/zip"]);
    const exe = await get("/downloads/files/H9XASH-Updater.exe", mounts);
    assert.deepEqual([exe.status, exe.text, exe.headers["Content-Type"]], [200, "exe bytes", "application/octet-stream"]);
    const txt = await get("/downloads/files/SHA256SUMS.txt?x=1", mounts);
    assert.deepEqual([txt.status, txt.text], [200, "sums"]);
    assert.equal((await get("/downloads/files/a%26b's%20%231.txt", mounts)).text, "odd name");
    const head = await get("/downloads/files/H9XASH.zip", mounts, "HEAD");
    assert.deepEqual([head.status, head.text, head.headers["Content-Length"]], [200, "", 9]);
    for (const url of ["/downloads/files/.htaccess", "/downloads/files/%2ehtaccess", "/downloads/files/.keep", "/downloads/files/.stage/",
      "/downloads/files/notes.md", "/downloads/files/setup.sh", "/downloads/files/old.zip.bak", "/downloads/files/files/manifest.json",
      "/downloads/files/files/inner.zip", "/downloads/files/files/", "/downloads/files/files", "/downloads/files/..%2foutside.txt",
      "/downloads/files/%2e%2e/outside.txt", "/downloads/files/x%5c..%5c..%5coutside.txt", "/downloads/files/H9XASH.zip.",
      "/downloads/files/H9XASH.zip%20", "/downloads/files/H9XASH.zip%3a%3a%24DATA", "/downloads/files/H9XASH~1.ZIP",
      "/downloads/files/missing.zip", "/downloads/files/link.txt", "/downloads/files/H9XASH.zip%00", "/page.zip"]) {
      const r = await get(url, mounts);
      assert.equal(r.status, 404, url);
      assert.ok(!/secret|the updater's|in a subfolder|outside|a script|a backup|not a package/.test(r.text), url);
    }
    if (linked) assert.equal((await get("/downloads/files/link.txt", mounts)).status, 404, "a link is not followed");
    // the index's own address without its slash, and the methods
    const bare = await get("/downloads/files", mounts);
    assert.deepEqual([bare.status, bare.headers.Location], [301, "/downloads/files/"]);
    assert.equal((await get("/downloads/files/H9XASH.zip", mounts, "POST")).status, 0, "GET and HEAD only");
    // a missing packages folder is a 404, not an error
    assert.equal((await get("/downloads/files/", { "/downloads/files/": { dir: path.join(dir, "none"), listing: true } })).status, 404);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: a listing mount is { dir, listing: true }, and the data folder may not be inside it", () => {
  const c = resolveConfig({ dataDir: "/var/lib/h9web", devStatic: { "/": "/srv/site", "/downloads/files/": { dir: "/srv/dist", listing: true } } }, "/");
  assert.equal(c.devStatic["/"], path.resolve("/srv/site"));
  assert.deepEqual(c.devStatic["/downloads/files/"], { dir: path.resolve("/srv/dist"), listing: true });
  assert.throws(() => resolveConfig({ devStatic: { "/downloads/files/": { dir: "/srv/dist" } } }, "/"), /must be a folder, or/);
  assert.throws(() => resolveConfig({ devStatic: { "/downloads/files/": { dir: 12, listing: true } } }, "/"), /must be a folder, or/);
  assert.throws(() => resolveConfig({ devStatic: { "/downloads/files": { dir: "/srv/dist", listing: true } } }, "/"), /must start and end with \//);
  assert.throws(() => resolveConfig({ dataDir: "/srv/dist/data", devStatic: { "/downloads/files/": { dir: "/srv/dist", listing: true } } }, "/"),
    /dataDir is inside the served folder/);
});

test("static listing through the service: the index and a package over HTTP, the site's own rules elsewhere", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h9web-listing-app-"));
  const { files } = packagesFolder(dir);
  const site = path.join(dir, "site");
  fs.mkdirSync(path.join(site, "downloads"), { recursive: true });
  fs.writeFileSync(path.join(site, "downloads", "index.html"), "<p>downloads</p>");
  fs.writeFileSync(path.join(site, "downloads", "H9XASH.zip"), "zip");
  const s = await startApp({ devStatic: { "/": site, "/downloads/files/": { dir: files, listing: true } } });
  t.after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const index = await request(s.base, "GET", "/downloads/files/");
  assert.equal(index.status, 200);
  assert.match(index.text, /<a href="H9XASH\.zip">H9XASH\.zip<\/a>/);
  assert.ok(!index.text.includes(".htaccess"));
  const zip = await request(s.base, "GET", "/downloads/files/H9XASH.zip");
  assert.deepEqual([zip.status, zip.text, zip.headers["content-type"]], [200, "zip bytes", "application/zip"]);
  assert.equal((await request(s.base, "GET", "/downloads/files/.htaccess")).status, 404);
  const bare = await request(s.base, "GET", "/downloads/files");
  assert.deepEqual([bare.status, bare.headers.location], [301, "/downloads/files/"]);
  assert.equal((await request(s.base, "GET", "/downloads/")).text, "<p>downloads</p>", "the page beside it, from the site");
  assert.equal((await request(s.base, "GET", "/downloads/H9XASH.zip")).status, 404, "the site folder's own rules: no zips");
});
