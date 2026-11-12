// Tests of the parts of tools\release-prepare.mjs that have no files in them, and a dry run on a fake tree:
//   node tools\release_prepare_test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, diffHashes, hashMap, nextBuild, parseBuild, withBuild } from "./release-prepare.mjs";

let n = 0;
const ok = (name, fn) => { fn(); n++; };

ok("nextBuild", () => {
  assert.equal(nextBuild("1.60"), "1.61");
  assert.equal(nextBuild("1.09"), "1.10");
  assert.equal(nextBuild("1.99"), "1.100");
  assert.equal(nextBuild("1.59b"), "1.60");
  assert.equal(nextBuild("0.7"), "0.8");
  assert.equal(nextBuild("2.9"), "2.10");
  assert.throws(() => nextBuild("abc"));
  assert.throws(() => nextBuild("1.60.1"));
});

ok("parseBuild and withBuild keep every other byte", () => {
  const text = '/* head */\r\n#define PLUGIN  "TSM"\r\n#define VERSION "1.60"\r\n#define AUTHOR "x"\r\n';
  assert.equal(parseBuild(text), "1.60");
  assert.equal(withBuild(text, "1.61"), '/* head */\r\n#define PLUGIN  "TSM"\r\n#define VERSION "1.61"\r\n#define AUTHOR "x"\r\n');
  assert.equal(parseBuild("// #define VERSION \"9.9\"\n"), null);
  assert.throws(() => withBuild("no version here\n", "1.61"));
});

const pre = (rows) => ({ entries: rows.map(([kind, file, sha256]) => ({ kind, file, sha256 })) });
const base = hashMap(pre([["amxx", "a.amxx", "aa"], ["amxx", "b.amxx", "bb"], ["module", "m.dll", "mm"]]));

ok("hashMap and diffHashes", () => {
  assert.deepEqual(base, { "amxx:a.amxx": "aa", "amxx:b.amxx": "bb", "module:m.dll": "mm" });
  const d = diffHashes(base, hashMap(pre([["amxx", "a.amxx", "AA"], ["amxx", "c.amxx", "cc"], ["module", "m.dll", "mm"]])));
  assert.deepEqual(d.changed, ["amxx:a.amxx"]);
  assert.deepEqual(d.added, ["amxx:c.amxx"]);
  assert.deepEqual(d.removed, ["amxx:b.amxx"]);
  assert.equal(d.same, false);
  assert.equal(diffHashes(base, { ...base }).same, true);
});

ok("decide", () => {
  assert.equal(decide(null, "1.60", base).bump, true);
  assert.equal(decide({ build: "1.60", hashes: base }, "1.60", { ...base }).bump, false);
  assert.equal(decide({ build: "1.60", hashes: base }, "1.60", { ...base, "amxx:a.amxx": "x" }).bump, true);
  assert.equal(decide({ build: "1.60", hashes: base }, "1.60", { ...base, "amxx:new.amxx": "x" }).bump, true);
  // someone bumped the build by hand since the last package: it is not bumped again
  const d = decide({ build: "1.60", hashes: base }, "1.61", { ...base, "amxx:a.amxx": "x" });
  assert.equal(d.bump, false);
  assert.match(d.why, /already a new one/);
});

// ---- a fake tree: a dry run changes nothing, a record writes the state, a second dry run then keeps the build
const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-prepare.mjs");
const root = fs.mkdtempSync(path.join(process.env.H9_LOGDIR || (fs.existsSync("D:/temp") ? "D:/temp" : os.tmpdir()), "rp-test-"));
try {
  fs.mkdirSync(path.join(root, "H9XASH", "presets"), { recursive: true });
  fs.mkdirSync(path.join(root, "xash3d-h9-patches", "overlay", "ts"), { recursive: true });
  const smaText = '#define VERSION "1.60"\r\n';
  fs.writeFileSync(path.join(root, "ts_matchmode.sma"), smaText);
  fs.writeFileSync(path.join(root, "build.bat"), "@echo off\r\n");   // a dry run never runs them, it only needs to find them
  fs.writeFileSync(path.join(root, "export.bat"), "@echo off\r\n");
  fs.writeFileSync(path.join(root, "xash3d-h9-patches", "overlay", "ts", "h9_release.txt"), "2026.11.05\n");
  fs.writeFileSync(path.join(root, "H9XASH", "presets", "official-preset.json"), JSON.stringify({ mode: "all", entries: pre([["amxx", "a.amxx", "aa"]]).entries }));
  const state = path.join(root, "state.json");
  const run = (...a) => spawnSync(process.execPath, [tool, "--root", root, "--state", state, "--no-write-presets", ...a], { encoding: "utf8" });

  let r = run("--auto", "--dry");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /a new build is needed \(no earlier staged package is recorded\)/);
  assert.match(r.stdout, /would write build 1\.61/);
  assert.equal(fs.readFileSync(path.join(root, "ts_matchmode.sma"), "latin1"), smaText, "a dry run changes nothing");

  r = run("--record");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.equal(rec.build, "1.60");
  assert.equal(rec.release, "2026.11.05");
  assert.deepEqual(rec.hashes, { "amxx:a.amxx": "aa" });

  r = run("--auto", "--dry");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /kept \(the plugins and modules are those of build 1\.60\)/);

  fs.writeFileSync(path.join(root, "H9XASH", "presets", "official-preset.json"), JSON.stringify({ mode: "all", entries: pre([["amxx", "a.amxx", "AA"], ["amxx", "n.amxx", "nn"]]).entries }));
  r = run("--auto", "--dry");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /a new build is needed \(1 changed, 1 added and 0 no longer shipped since build 1\.60\)/);
  assert.match(r.stdout, /changed amxx:a\.amxx/);
  assert.match(r.stdout, /new amxx:n\.amxx/);

  // a tree that cannot build says so, in a dry run too, instead of promising a build
  fs.rmSync(path.join(root, "build.bat"));
  r = run("--auto", "--dry");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /there is no build\.bat and export\.bat/);
  fs.writeFileSync(path.join(root, "build.bat"), "@echo off\r\n");

  // --no-build writes the new build into the plugin and stops (the presets are not written: this tree has no preset tool of its own, so only the plugin is looked at)
  r = run("--auto", "--no-build");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(root, "ts_matchmode.sma"), "latin1"), '#define VERSION "1.61"\r\n');
  r = run("--auto", "--dry");
  assert.match(r.stdout, /already a new one/);
  n += 6;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("release_prepare_test: " + n + " groups of checks passed");
