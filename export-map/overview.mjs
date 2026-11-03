// The map from above with a coordinate grid over it, so a place can be NAMED.
//
//     node overview.mjs              the whole map
//     node overview.mjs -500         a cut at that height (a storey's floor plan)
//
// WHY. Pointing at a screenshot and saying "this hallway" has cost several rounds of me guessing
// at the wrong staircase. A plan with coordinates written on it turns "here" into a number, and a
// number can be built against.
//
// Reads out/base.bsp -- the compiled base map -- and writes out/overview.png.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { K, M, OUT } from "./lib.mjs";

const STEP = 512;          // how far apart the grid lines are, in units
const bsp = M.readBsp(readFileSync(join(OUT, "base.bsp")));
const world = bsp.models[0];

const cut = Number(process.argv[2]);
const plan = M.planOf(bsp, {
  width: 1400,
  heights: true,
  entities: true,
  ...(Number.isFinite(cut) ? { z: cut } : {}),
});

const { width: W, height: H, rgba } = plan;

/*
 * planOf draws +x to the right and +y UP the picture, and fits the world's bounds to the image. So
 * a world point maps linearly onto the picture, and the only thing to be careful of is that the y
 * axis runs the other way.
 */
const x0 = world.mins[0];
const x1 = world.maxs[0];
const y0 = world.mins[1];
const y1 = world.maxs[1];
const toPx = (x, y) => [((x - x0) / (x1 - x0)) * (W - 1), (1 - (y - y0) / (y1 - y0)) * (H - 1)];

const put = (px, py, r, g, b, a = 150) => {
  const x = Math.round(px);
  const y = Math.round(py);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  rgba[i] = Math.round(rgba[i] * (1 - a / 255) + r * (a / 255));
  rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a / 255) + g * (a / 255));
  rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a / 255) + b * (a / 255));
};

// the grid itself: every STEP, brighter on the thousands so the eye can count
for (let x = Math.ceil(x0 / STEP) * STEP; x <= x1; x += STEP) {
  const [px] = toPx(x, 0);
  const major = x % 1024 === 0;
  for (let py = 0; py < H; py++) put(px, py, 90, 210, 255, major ? 110 : 55);
}
for (let y = Math.ceil(y0 / STEP) * STEP; y <= y1; y += STEP) {
  const [, py] = toPx(0, y);
  const major = y % 1024 === 0;
  for (let px = 0; px < W; px++) put(px, py, 90, 210, 255, major ? 110 : 55);
}

/* ---- the numbers, in a 3x5 stencil so no font is needed --------------------------------------- */
const GLYPH = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
  "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001",
  "8": "111101111101111", "9": "111101111001111", "-": "000000111000000", " ": "000000000000000",
};
const text = (s, px, py, r = 255, g = 255, b = 255) => {
  let cx = Math.round(px);
  for (const ch of s) {
    const g5 = GLYPH[ch] ?? GLYPH[" "];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (g5[gy * 3 + gx] === "1") {
          put(cx + gx * 2, py + gy * 2, r, g, b, 255);
          put(cx + gx * 2 + 1, py + gy * 2, r, g, b, 255);
          put(cx + gx * 2, py + gy * 2 + 1, r, g, b, 255);
          put(cx + gx * 2 + 1, py + gy * 2 + 1, r, g, b, 255);
        }
      }
    }
    cx += 8;
  }
};

for (let x = Math.ceil(x0 / 1024) * 1024; x <= x1; x += 1024) {
  const [px] = toPx(x, 0);
  text(String(x), px + 3, 4, 140, 230, 255);
}
for (let y = Math.ceil(y0 / 1024) * 1024; y <= y1; y += 1024) {
  const [, py] = toPx(0, y);
  text(String(y), 4, py + 3, 140, 230, 255);
}

const to = join(OUT, "overview.png");
writeFileSync(to, K.png(W, H, rgba));
console.log(`\n  world runs x ${x0}..${x1}, y ${y0}..${y1}, z ${world.mins[2]}..${world.maxs[2]}`);
console.log(`  grid every ${STEP}, numbered every 1024`);
console.log(`  ${to}\n`);
