import { readFileSync } from "node:fs";
import { readBsp } from "../smak/src/maps/bsp.mjs";
import { spaceOf, BODIES } from "../smak/src/maps/space.mjs";

const bsp = readBsp(readFileSync("../export-map/out/h9_te_neuropolis.bsp"));
const space = spaceOf(bsp);

const X = 3477, Y = 738;
const FEET_Z = 36;        // from tsm_loc: "origin 3477 738 36 (feet)"
const ICON_Z = FEET_Z + 36 + 52;   // player origin is hull-center (feet+36), then +tsm_icon_height(52)
const ORIGIN_Z = FEET_Z + 36;      // for reference, where pev_origin itself sits

console.log(`checking (${X}, ${Y}) -- tsm_loc said floor z=0 there, feet at z=${FEET_Z}`);
console.log();

const stretches = space.blocked(X, Y, BODIES.standing);
console.log("blocked (solid) height stretches for a standing body at this (x,y):");
for (const [from, to, kind] of stretches) {
  console.log(`  z ${from} .. ${to}  (${kind})`);
}
console.log();

// find the open gap the player is actually standing in
const under = stretches.filter((s) => s[1] <= FEET_Z + 1).at(-1);
const above = stretches.find((s) => s[0] >= FEET_Z);
console.log(`floor under feet: z=${under ? under[1] : "none found"}`);
console.log(`next solid above: z=${above ? above[0] : "none found (open to sky/void)"}`);
if (under && above) {
  console.log(`==> actual clearance at this spot: ${above[0] - under[1]} units`);
}
console.log();

console.log(`pev_origin.z would be:        ${ORIGIN_Z}`);
console.log(`icon origin.z (origin+52):    ${ICON_Z}`);
const iconInsideSolid = stretches.find((s) => ICON_Z > s[0] && ICON_Z < s[1]);
if (iconInsideSolid) {
  console.log(`==> ICON IS INSIDE SOLID GEOMETRY: z ${iconInsideSolid[0]}..${iconInsideSolid[1]} (${iconInsideSolid[2]})`);
} else {
  console.log("==> icon origin is NOT inside solid geometry at this exact point");
}
