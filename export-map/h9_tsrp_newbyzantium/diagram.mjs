// diagram.mjs: the MSR's network seen from above, one panel for each level it is on, from the plan beside the map
// (out\<name>.plan.json): the city's public ways in grey, homes and shops dark, the MSR's spaces purple, its
// tunnels bright, the checkpoints, precincts and cells red, the Nexus's headquarters gold, hidden places green.
//
//   node diagram.mjs      writes out\renders\msr-network.png
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { K } from "../lib.mjs";
import { PUBLIC_KINDS } from "./plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = "h9_tsrp_newbyzantium";
const plan = JSON.parse(readFileSync(join(HERE, "out", `${NAME}.plan.json`), "utf8"));
const LEVELS = [
  ["UNDERCITY -704: SEWER CHECKPOINTS, CORES", -704 + 40],
  ["TUNNELS -176: NEXUS TO THE PRECINCTS", -176 + 40],
  ["STREET 0: PRECINCTS, NEXUS UNDERCROFT AND JAIL", 0 + 40],
  ["HALL FLOOR 352: NEXUS LOBBY, GALLERIES", 352 + 40],
  ["WARD 704: RING, WINGS, CHECKPOINTS, NEXUS OPS", 704 + 40],
  ["MESE 1056: CHECKPOINTS, COMMAND FLOOR, OFFICE", 1056 + 40],
];
const X0 = -5200;
const Y1 = 5300;
const S = 12; // units to a pixel
const W = Math.ceil(10400 / S);
const H = Math.ceil(14000 / S);
const colourOf = (sp) => {
  const n = sp.name;
  if (/^(hq_|commander_)/.test(n)) return [240, 200, 80];
  if (/^(checkpoint_|cell_|jail_|gate_)/.test(n) || /^precinct_[a-z]+_(lobby|cell\d)$/.test(n)) return [235, 70, 70];
  if (/^tunnel_/.test(n)) return [200, 130, 255];
  if (sp.kind === "msr") return [140, 85, 215];
  if (sp.kind === "hidden") return [60, 200, 90];
  if (PUBLIC_KINDS.has(sp.kind)) return [95, 95, 105];
  if (/^(water|air|window)$/.test(sp.kind)) return null;
  return [45, 45, 52];
};
const panels = LEVELS.map(([title, z]) => {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([14, 14, 18, 255], i * 4);
  const img = { width: W, height: H, rgba };
  // the MSR's last, so it is drawn over what it passes
  const order = [...plan.spaces].sort((a, b) => (a.kind === "msr" ? 1 : 0) - (b.kind === "msr" ? 1 : 0));
  for (const sp of order) {
    if (!(sp.floor <= z && sp.ceiling > z)) continue;
    const c = colourOf(sp);
    if (!c) continue;
    const pts = sp.outline.map(([x, y]) => [(x - X0) / S, (Y1 - y) / S]);
    const ys = pts.map((p) => p[1]);
    for (let py = Math.max(0, Math.floor(Math.min(...ys))); py <= Math.min(H - 1, Math.ceil(Math.max(...ys))); py++) {
      // the span of a convex outline on this row
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= py + 0.5 && by > py + 0.5) || (by <= py + 0.5 && ay > py + 0.5)) xs.push(ax + ((py + 0.5 - ay) / (by - ay)) * (bx - ax));
      }
      if (xs.length < 2) continue;
      for (let px = Math.max(0, Math.round(Math.min(...xs))); px <= Math.min(W - 1, Math.round(Math.max(...xs))); px++) rgba.set([...c, 255], (py * W + px) * 4);
    }
  }
  K.label(img, title, 10, 10, 3);
  return img;
});
const cols = 3;
const rows = Math.ceil(panels.length / cols);
const out = { width: W * cols, height: H * rows, rgba: new Uint8Array(W * cols * H * rows * 4) };
panels.forEach((p, k) => {
  const ox = (k % cols) * W;
  const oy = Math.floor(k / cols) * H;
  for (let y = 0; y < H; y++) out.rgba.set(p.rgba.subarray(y * W * 4, (y + 1) * W * 4), ((oy + y) * W * cols + ox) * 4);
});
// the key, under the last panel's title
const key = [["PUBLIC WAYS", [95, 95, 105]], ["HOMES AND SHOPS", [45, 45, 52]], ["MSR", [140, 85, 215]], ["MSR TUNNELS", [200, 130, 255]], ["CHECKPOINTS, CELLS", [235, 70, 70]], ["NEXUS HQ", [240, 200, 80]], ["HIDDEN", [60, 200, 90]]];
key.forEach(([text, c], k) => K.label(out, text, 10, H * rows - 30 - (key.length - k) * 22, 3, c));
mkdirSync(join(HERE, "out", "renders"), { recursive: true });
writeFileSync(join(HERE, "out", "renders", "msr-network.png"), K.png(out.width, out.height, out.rgba));
console.log(`  wrote out\\renders\\msr-network.png (${out.width} x ${out.height})`);
