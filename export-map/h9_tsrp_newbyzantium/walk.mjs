// walk.mjs: the walk test on the plan New Byzantium was built from (out\<name>.plan.json): which space opens into
// which, and so what a player reaches from the street, and what the MSR reaches without the public's ways.
//
//   node walk.mjs          the summary: what is not reached, the MSR's network, the checkpoints by district and level
//   node walk.mjs --all    every space not reached, by name
//
// Two spaces open into each other when they overlap or touch along at least 32 units with a player's height of air
// in common, or when one stands on the other (a shaft over a room, a stair hall's floor cut into a street's). The
// bridges and tubes across the well are fittings, not spaces: they join the Mese and the ward ring to the Nexus by
// name. Doors are taken as open (a door is a way, not a wall); the MSR's doors are where the public meets the MSR.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { districtAt, PUBLIC_KINDS } from "./plan.mjs";
import { boundsOf } from "./geo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = "h9_tsrp_newbyzantium";
const ALL = process.argv.includes("--all");
const plan = JSON.parse(readFileSync(join(HERE, "out", `${NAME}.plan.json`), "utf8"));
const SKIP = new Set(["water", "air", "window"]);
const spaces = plan.spaces.filter((s) => !SKIP.has(s.kind)).map((s, i) => ({ ...s, i, box: boundsOf(s.outline) }));

// ---- how two convex outlines meet: the length of what they share, 0 when they are apart --------------------------
const orient = (poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) a += poly[i][0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * poly[i][1];
  return Math.sign(a);
};
/** A convex outline cut to another grown by 1 unit; null when they do not meet. */
function meet(a, b) {
  const sb = orient(b);
  let p = a;
  for (let i = 0; i < b.length && p; i++) {
    const [x0, y0] = b[i];
    const [x1, y1] = b[(i + 1) % b.length];
    // the inside of edge i is to the left for an anticlockwise outline: keep points with cross >= -len
    const ex = x1 - x0;
    const ey = y1 - y0;
    const len = Math.hypot(ex, ey);
    const out = [];
    const side = (q) => (sb * (ex * (q[1] - y0) - ey * (q[0] - x0))) / len + 1;
    for (let k = 0; k < p.length; k++) {
      const q0 = p[k];
      const q1 = p[(k + 1) % p.length];
      const s0 = side(q0);
      const s1 = side(q1);
      if (s0 >= 0) out.push(q0);
      if ((s0 >= 0) !== (s1 >= 0)) {
        const t = s0 / (s0 - s1);
        out.push([q0[0] + (q1[0] - q0[0]) * t, q0[1] + (q1[1] - q0[1]) * t]);
      }
    }
    p = out.length >= 2 ? out : null;
  }
  if (!p) return 0;
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}
// ---- the graph ---------------------------------------------------------------------------------------------------
/** The heights a player stands at in a space: its floor, and its galleries' walkways. */
const floorsOf = (s) => s.levels ?? [s.floor];
/** Whether a space holds a way between heights: a stair hall, a core, a shaft with a ladder, a ramp tower. */
const climbs = (s) => s.kind === "stair" || s.kind === "shaft" || /(_core|_stair|_hatch|hq_stair_[a-z]+)$/.test(s.name) || /^(precinct_[a-z]+_core|hq_stair_(msr|commander)|checkpoint_mese_[nesw]_stair|well_stair_)/.test(s.name);
const CELL = 512;
const grid = new Map();
spaces.forEach((s) => {
  for (let i = Math.floor(s.box[0] / CELL); i <= Math.floor(s.box[2] / CELL); i++)
    for (let j = Math.floor(s.box[1] / CELL); j <= Math.floor(s.box[3] / CELL); j++) {
      const k = `${i},${j}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s.i);
    }
});
const byIndex = new Map(spaces.map((s) => [s.i, s]));
const links = new Map(spaces.map((s) => [s.i, new Set()]));
const link = (a, b) => {
  links.get(a.i).add(b.i);
  links.get(b.i).add(a.i);
};
for (const a of spaces) {
  const seen = new Set();
  for (let i = Math.floor(a.box[0] / CELL); i <= Math.floor(a.box[2] / CELL); i++)
    for (let j = Math.floor(a.box[1] / CELL); j <= Math.floor(a.box[3] / CELL); j++)
      for (const bi of grid.get(`${i},${j}`) ?? []) {
        if (bi <= a.i || seen.has(bi)) continue;
        seen.add(bi);
        const b = byIndex.get(bi);
        if (a.box[0] > b.box[2] + 1 || b.box[0] > a.box[2] + 1 || a.box[1] > b.box[3] + 1 || b.box[1] > a.box[3] + 1) continue;
        const air = Math.min(a.ceiling, b.ceiling) - Math.max(a.floor, b.floor);
        const stacked = Math.abs(a.ceiling - b.floor) < 0.5 || Math.abs(b.ceiling - a.floor) < 0.5;
        // a road is the street it is laid in
        const road = a.kind === "road" || b.kind === "road";
        if (air < 72 && !stacked && !(road && air > 0)) continue;
        // side by side, a player steps from one floor to the other: they share a floor height (a street's galleries
        // count as floors), or one of them holds a stair or a ladder that reaches the other's
        if (!stacked && !road && !climbs(a) && !climbs(b) && !floorsOf(a).some((za) => floorsOf(b).some((zb) => Math.abs(za - zb) <= 18))) continue;
        const shared = meet(a.outline, b.outline);
        if (shared >= 32) link(a, b);
      }
}
// the fittings across the well, by name: the Mese's bridges and the ward's tubes to the Nexus
const named = new Map(spaces.map((s) => [s.name, s]));
for (const d of ["n", "e", "s", "w"]) {
  for (const [p, q] of [[`mese_bridge_${d}`, `hq_bridge_${d}`], [`ward_bridge_${d}`, `hq_ward_${d}`]]) if (named.has(p) && named.has(q)) link(named.get(p), named.get(q));
}
// ---- the walks ---------------------------------------------------------------------------------------------------
const walk = (from, may = () => true) => {
  const got = new Set(from.map((s) => s.i));
  const todo = [...got];
  while (todo.length) {
    const i = todo.pop();
    for (const j of links.get(i)) {
      if (got.has(j) || !may(byIndex.get(j))) continue;
      got.add(j);
      todo.push(j);
    }
  }
  return got;
};
const street = spaces.filter((s) => s.kind === "avenue");
const fromStreet = walk(street);
const notReached = spaces.filter((s) => !fromStreet.has(s.i) && !/^(shaft)$/.test(s.kind));
const lines = [];
const out = (l) => {
  lines.push(l);
  console.log(l);
};
out(`walk test of ${NAME}: ${spaces.length} spaces, from the avenues`);
const kinds = {};
for (const s of notReached) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
out(`  not reached from the street: ${notReached.length} ${JSON.stringify(kinds)}`);
for (const s of notReached.slice(0, ALL ? Infinity : 20)) out(`    ${s.name} (${s.kind}) [${s.box.map(Math.round)}] ${s.floor}..${s.ceiling}`);
// the levels a player reaches from the street
const LEVELS = [["the cistern", -880], ["the undercity", -704], ["the street", 0], ["the galleries", 176], ["the upper gallery", 352], ["the ward level", 704], ["the Mese", 1056]];
for (const [label, z] of LEVELS) {
  const at = spaces.filter((s) => fromStreet.has(s.i) && PUBLIC_KINDS.has(s.kind) && s.floor === z);
  out(`  ${label} (${z}): ${at.length} public spaces reached`);
}
// the hidden places
const hidden = spaces.filter((s) => s.kind === "hidden" && !/_(door|in|out|j\d)$/.test(s.name));
out(`  hidden places: ${hidden.filter((s) => fromStreet.has(s.i)).length} of ${hidden.length} reached (${hidden.filter((s) => !fromStreet.has(s.i)).map((s) => s.name).join(", ") || "all"})`);
// the MSR's network: from the operations floor of the Nexus, through the MSR's own spaces only
const msr = (s) => s.kind === "msr";
const net = walk([named.get("hq_ops_0") ?? named.get("hq_ops")].filter(Boolean), msr);
const posts = spaces.filter((s) => /^checkpoint_[a-z]+_[a-z]+$/.test(s.name) || /^precinct_[a-z]+_lobby$/.test(s.name));
const offNet = posts.filter((s) => !net.has(s.i));
out(`  the MSR's network: ${net.size} spaces joined to the Nexus through the MSR's own; ${posts.length - offNet.length} of ${posts.length} checkpoints and precincts on it${offNet.length ? ` (off it: ${offNet.map((s) => s.name).join(", ")})` : ""}`);
for (const n of ["jail_hq_corridor", "commander_office_0", "hq_lobby_0", "hq_armory", "tunnel_n", "tunnel_e", "tunnel_s", "tunnel_w"]) if (named.has(n)) out(`    ${n}: ${net.has(named.get(n).i) ? "on the network" : "NOT on the network"}`);
// where the public meets the MSR: the MSR's spaces next to public ones
const gates = new Set();
for (const s of spaces.filter(msr)) for (const j of links.get(s.i)) if (PUBLIC_KINDS.has(byIndex.get(j).kind)) gates.add(s.name);
out(`  where the public meets the MSR: ${gates.size} openings (${[...gates].slice(0, ALL ? Infinity : 40).join(", ")})`);
// the checkpoints by district and level
const table = {};
for (const s of posts) {
  const [x0, y0, x1, y1] = s.box;
  const lvl = s.floor <= -700 ? "undercity" : s.floor >= 1000 ? "Mese" : s.floor >= 700 ? "ward" : "street";
  const dist = /^checkpoint_mese/.test(s.name) ? "the Mese" : districtAt((x0 + x1) / 2, (y0 + y1) / 2);
  table[dist] ??= {};
  table[dist][lvl] = (table[dist][lvl] ?? 0) + 1;
}
out("  checkpoints by district and level:");
for (const [dist, lv] of Object.entries(table)) out(`    ${dist.padEnd(10)} ${Object.entries(lv).map(([k, n]) => `${k} ${n}`).join(", ")}`);
writeFileSync(join(HERE, "out", "walk.txt"), lines.join("\n") + "\n");
