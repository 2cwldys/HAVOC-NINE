// Which player models still stand in TS's default guard, and which stand like repuheavy.
//
//     node audit-idle.mjs
//
// make-idle-stance.mjs was pointed at a list picked by hand, which is a guess dressed as
// a decision. This measures instead: every model the class table actually uses, plus
// everything built in export-mdl, compared against repuheavy bone by bone at the first
// frame of standard_idle.
//
// The comparison is on the ARMS only. A whole-skeleton difference says nothing useful --
// every model differs somewhere -- whereas the thing being asked about is precisely where
// the hands are: TS's default idle holds them up in a guard, repuheavy's lets them hang.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { K, load, IN } from "./lib.mjs";

const CFG = join(process.cwd(), "..", "ts_matchmode.cfg");
const BUILT = join(process.cwd(), "..", "export-mdl");

// The bones that say where the arms are. Shoulders included: a guard raises the whole
// limb, not just the hand.
const ARM = ["Bip01 SX Braccio superiore", "Bip01 SX Avambraccio", "Bip01 SX Mano",
             "Bip01 DX Braccio superiore", "Bip01 DX Avambraccio", "Bip01 DX Mano"];

function armPose(mdl) {
  const i = K.sequenceAt(mdl, "standard_idle");
  if (i < 0) return null;
  const names = K.bones(mdl).map((b) => b.name);
  const P = K.poseAt(mdl, i, 0);
  const out = {};
  for (const b of ARM) {
    const j = names.indexOf(b);
    if (j < 0) return null;
    out[b] = K.apply34(P[j], [0, 0, 0]);
  }
  return out;
}

const donor = armPose(load("repuheavy"));
if (!donor) throw new Error("repuheavy has no standard_idle to compare against");

// Every model the class table names, both sides, plus whatever has been built.
const wanted = new Set();
for (const ln of readFileSync(CFG, "utf8").split(/\r?\n/)) {
  const m = ln.match(/^tsm_class\d+\s+"(.*)"\s*$/);
  if (!m) continue;
  const f = m[1].split(";");
  for (const side of (f[3] ?? "").split("|")) {
    for (const n of side.split(",")) if (n.trim()) wanted.add(n.trim());
  }
}
const fromCfg = new Set(wanted);
if (existsSync(BUILT)) {
  for (const e of readdirSync(BUILT, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(BUILT, e.name, `${e.name}.mdl`))) wanted.add(e.name);
  }
}

console.log(`  ${wanted.size} models to check (${fromCfg.size} of them named in ts_matchmode.cfg)\n`);

const rows = [];
for (const name of [...wanted].sort()) {
  let mdl;
  try { mdl = load(name); } catch { rows.push([name, "unreadable", 0, fromCfg.has(name)]); continue; }

  const mine = armPose(mdl);
  if (!mine) { rows.push([name, "no standard_idle / bones", 0, fromCfg.has(name)]); continue; }

  let worst = 0;
  for (const b of ARM) {
    worst = Math.max(worst, Math.hypot(
      mine[b][0] - donor[b][0], mine[b][1] - donor[b][1], mine[b][2] - donor[b][2]));
  }
  // A unit is roughly an inch. Under one the arms are where his are; over three they are
  // somewhere else entirely, which on this animation means up in a guard.
  rows.push([name, worst < 1.0 ? "his stance" : worst < 3.0 ? "close" : "TS default guard", worst, fromCfg.has(name)]);
}

const pad = Math.max(...rows.map((r) => r[0].length));
for (const [name, verdict, worst, inCfg] of rows) {
  console.log(`  ${inCfg ? "*" : " "} ${name.padEnd(pad)}  ${verdict.padEnd(24)} ${worst ? worst.toFixed(2) : ""}`);
}
const need = rows.filter((r) => r[1] === "TS default guard");
console.log(`\n  * = named in ts_matchmode.cfg`);
console.log(`  ${need.length} still standing in the default guard`
  + (need.length ? `: ${need.map((r) => r[0]).join(" ")}` : ""));
console.log(`  models directory: ${IN}`);
