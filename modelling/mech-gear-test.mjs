// Scratch: how many normals each gear group costs against the 2048-a-submodel
// ceiling (the body already spends 1710). No body repaint, so it loops fast.
import { K, load } from "./lib.mjs";
import { addGear, STYLE_MSR, STYLE_INS } from "./mech-gear.mjs";

for (const [name, ST] of [["msr", STYLE_MSR], ["ins", STYLE_INS]]) {
  console.log(`-- ${name}`);
  const m = load("ed209_ts");
  const r = addGear(m, ST);
  const res = K.check(r.mdl, "goldsrc");
  console.log(`  ${name}: ${res.errors.length} errors, ${res.warnings.length} warnings`);
  for (const e of res.errors) console.log(`    ${e}`);
}
