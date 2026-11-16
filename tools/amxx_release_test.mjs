// Tests of tools\amxx-release.mjs (the release a compiled plugin carries) and of the check release-check.mjs makes with it:
//   node tools\amxx_release_test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { amxxRelease } from "./amxx-release.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = (name, fn) => { fn(); n++; };

// a stand-in for an .amxx: 24 bytes of header, then a zlib image whose data holds literals as 4-byte cells
const cell = (s) => { const b = Buffer.alloc((s.length + 1) * 4); for (let i = 0; i < s.length; i++) b[i * 4] = s.charCodeAt(i); return b; };
const amxx = (...literals) => Buffer.concat([Buffer.alloc(24, 0x41), zlib.deflateSync(Buffer.concat([Buffer.alloc(64, 7), ...literals.map(cell), Buffer.alloc(32, 9)]))]);

ok("the literal after h9_plugin_release is the release", () => {
  assert.equal(amxxRelease(amxx("some text", "h9_plugin_release", "1.64", "next literal")), "1.64");
  assert.equal(amxxRelease(amxx("h9_plugin_release", "2026.11.10")), "2026.11.10");
  assert.equal(amxxRelease(amxx("h9_plugin_release", "")), "", "an empty release reads as none");
});

ok("a plugin without the cvar carries none, a file that is no .amxx cannot be read", () => {
  assert.equal(amxxRelease(amxx("only", "other", "literals")), "");
  assert.equal(amxxRelease(Buffer.from("this is not an amxx file at all, just text that is longer than the header")), null);
  assert.equal(amxxRelease(Buffer.alloc(10)), null);
});

ok("a cell that is no character makes the file unreadable, not a wrong answer", () => {
  const raw = Buffer.concat([Buffer.alloc(8, 7), cell("h9_plugin_release")]);
  const bad = Buffer.alloc(8);
  bad.writeUInt32LE(0x41424344, 0);
  assert.equal(amxxRelease(Buffer.concat([Buffer.alloc(24, 0x41), zlib.deflateSync(Buffer.concat([raw, bad]))])), null);
});

// the check on a fake tree
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amxx-release-test-"));
const tool = path.join(here, "release-check.mjs");
function tree(name, { build, release, plugin }) {
  const root = path.join(tmp, name);
  const put = (rel, data) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  put("ts_matchmode.sma", '#define VERSION "' + build + '"\r\n');
  put("xash3d-h9-patches/overlay/ts/h9_release.txt", release + "\n");
  put("H9XASH/ts/h9_release.txt", release + "\n");
  put("include/h9_release.inc", '#define H9_RELEASE "' + release + '"\r\n');
  if (plugin !== undefined) put("compiled/h9_presence.amxx", plugin);
  return root;
}
const check = (root) => spawnSync(process.execPath, [tool, "--root", root], { encoding: "utf8" });

ok("release-check: a plugin that carries the release passes", () => {
  const r = check(tree("good", { build: "1.64", release: "1.64", plugin: amxx("h9_plugin_release", "1.64") }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

ok("release-check: a plugin one build behind the gate fails, and says how to go on", () => {
  const r = check(tree("behind", { build: "1.65", release: "1.65", plugin: amxx("h9_plugin_release", "1.64") }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /compiled\/h9_presence\.amxx carries release 1\.64 and the release is 1\.65/);
  assert.match(r.stderr, /release-prepare\.mjs --bump/);
});

ok("release-check: a file that is no .amxx is a note, a tree without the plugin is not checked", () => {
  const r1 = check(tree("junk", { build: "1.64", release: "1.64", plugin: Buffer.from("not an amxx file, but longer than its header would be") }));
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /could not be read as an \.amxx/);
  const r2 = check(tree("none", { build: "1.64", release: "1.64" }));
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
});

// the real plugin of this tree (when there is one): what the join gate holds joiners to is what the game folder says
const real = path.join(here, "..", "H9XASH", "ts", "addons", "amxmodx", "plugins", "h9_presence.amxx");
const gate = path.join(here, "..", "H9XASH", "ts", "h9_release.txt");
if (fs.existsSync(real) && fs.existsSync(gate)) {
  ok("this tree's compiled h9_presence.amxx carries the release of its h9_release.txt", () => {
    const carried = amxxRelease(fs.readFileSync(real));
    assert.equal(carried, fs.readFileSync(gate, "latin1").trim().split(/\s+/)[0]);
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("amxx_release_test: " + n + " checks passed");
