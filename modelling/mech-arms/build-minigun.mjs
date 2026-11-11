// The Mech's minigun models: v_mechminigun.mdl, the first-person cannon built into an armoured arm, in the three side sets, and
// w_mechminigun.mdl, the cannon on its own as it lies on the floor.
//
//   node build-minigun.mjs <game folder> [--quick]          (a folder shaped like H9XASH\ts; created if need be)
// writes <game>\models\h9\v_mechminigun.mdl (the default set), <game>\models\matchmode\{msr,insurgent,default}\h9\v_mechminigun.mdl
// and <game>\models\h9\w_mechminigun.mdl.
//
// The stock M60 view model supplies the skeleton, the animations (idle, draw, shoot, shoot2, reload, stock) with their
// events, and the attachments; none of its meshes or pictures is kept, so no hand or glove remains. The cannon's rotor is
// a bone added under m60 and turned by the two shoot animations; the ammunition belt is a bone added under m60 that the two
// shoot animations slide a pitch into the feed throat (belt.mjs). The world model has the stock w_m60's skeleton (one bone).
// The checks: the studio kit's (all models), check-solid.mjs (the default set and the world model: no hole), the same shape in
// the other two sets, and check-belt.mjs (the belt's feed, its length and its sets, over the written view models). Any of them
// failing leaves the exit status 1. --quick leaves out the last two (about a minute and a half) to try a change.
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { K, STOCK_MODELS, loadStock, addBones, boneIndex, intoBone, onBones, poses, writeModel, sideTextures } from "./common.mjs";
import { build, boneOf, AXIS, D, WORLD } from "./minigun.mjs";
import { BELT, mouthAt } from "./belt.mjs";
import { meleeThrust, slide, settle } from "./motion.mjs";
import { solidity, sameGeometry } from "./check-solid.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUICK = process.argv.includes("--quick");
const GAME = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "D:/temp/wf/mecharms/scratch/game";
mkdirSync(`${GAME}/models/h9`, { recursive: true });

const SIDE_NAMES = ["default", "msr", "insurgent"];
const BUILT = Object.fromEntries(SIDE_NAMES.map((s) => [s, build(s)]));
// the three sides' pictures differ only in the band's zone; they share one palette outside it (see sideTextures)
const TEXTURES = sideTextures(Object.fromEntries(SIDE_NAMES.map((s) => [s, BUILT[s].image])), BUILT.default.Z.BAND, "mecharm.bmp");

function make(side) {
  const stock = loadStock(`${STOCK_MODELS}/v_m60.mdl`);
  addBones(stock, [
    { name: "rotor", parent: "m60", pos: intoBone(stock, "m60", [15.0, AXIS.y, AXIS.z]) },
    { name: "belt", parent: "m60", pos: intoBone(stock, "m60", mouthAt(AXIS)) },
  ]);
  // the shoot animations turn the rotor: a sixth of a turn (60 degrees) is the same picture as none, six barrels being
  // alike, so each shot that restarts the animation leaves the barrels where they began; the turn slows after that and
  // ends on a whole turn at the last frame
  const rotor = boneIndex(stock, "rotor");
  const FIRST = (Math.PI / 180) * 16.667;
  for (const name of ["shoot", "shoot2"]) {
    const seq = stock.seqs.find((s) => s.name === name);
    const last = seq.frames.length - 1;
    const decel = (FIRST * last - 2 * Math.PI) / (last * last);
    seq.frames.forEach((frame, f) => { frame[rotor][4] = FIRST * f - decel * f * f; });
  }
  meleeThrust(stock);
  // the belt slides one pitch toward the gun in the first BELT.feedFrames frames of each shoot animation and rests there. Its rounds are all
  // alike, so that is the picture it started from, and the shot that restarts the animation (3.6 frames on at the M60's rate of fire) shows no jump
  slide(stock, ["shoot", "shoot2"], "belt", [0, BELT.toward[0], BELT.toward[1]], BELT.pitch, settle(BELT.feedFrames));
  const muzzle = intoBone(stock, "m60", [D.muzzleX, AXIS.y, AXIS.z]);
  stock.attachments[0] = { ...stock.attachments[0], pos: muzzle };

  const made = BUILT[side];
  const byBone = onBones(stock, made.tris, boneOf);
  const group = (name) => (name === "m60" ? "arm" : name === "rotor" ? "rotor" : name === "belt" ? "belt" : "cover");
  const parts = new Map();
  for (const [bone, tris] of byBone) {
    const g = group(bone);
    if (!parts.has(g)) parts.set(g, []);
    parts.get(g).push(...tris);
  }
  const texture = TEXTURES[side];
  const mdl = writeModel(stock, {
    name: "v_mechminigun.mdl",
    parts: [...parts].map(([name, tris]) => ({ name, tris })),
    texture,
    extraAttachments: stock.attachments,
  });
  return { mdl, made, texture, tris: made.tris.length };
}

/**
 * The cannon on the floor: the stock w_m60's skeleton (one bone), the cannon drawn in the view model's space and placed by WORLD (scale, its
 * length along +y, its left on -x, the bottom of its pads on z = 0). The model's bounds and its one hit box are the cannon's own.
 */
const placeW = (p) => [-(p[1] - AXIS.y) * WORLD.scale, (p[0] - WORLD.centreX) * WORLD.scale, (p[2] - WORLD.floor) * WORLD.scale];
function makeWorld() {
  const stock = loadStock(`${STOCK_MODELS}/w_m60.mdl`);
  const made = build("default", { kind: "w", size: 256 });
  const byBone = onBones(stock, made.tris, () => "joint1", placeW);
  const tris = [...byBone.values()].flat();
  const box = (points) => {
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const p of points) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); }
    return { mn: mn.map((v) => Math.floor(v * 100) / 100), mx: mx.map((v) => Math.ceil(v * 100) / 100) };
  };
  const world = box(made.tris.flat().map((c) => placeW(c.p)));
  const inv = K.inverse34(poses(stock).idle[0]);
  const local = box(made.tris.flat().map((c) => K.apply34(inv, placeW(c.p))));
  stock.boxes = { ...stock.boxes, min: world.mn, max: world.mx, bbmin: world.mn, bbmax: world.mx };
  stock.hitboxes = [{ bone: 0, group: 0, min: local.mn, max: local.mx }];
  const mdl = writeModel(stock, { name: "w_mechminigun.mdl", parts: [{ name: "gun", tris }], texture: K.indexed(made.image, "mecharm.bmp") });
  return { mdl, tris: made.tris.length, world };
}

// the three sets are one shape with three pictures: the default set is checked for holes (check-solid.mjs), the others
// against it, so a hole can neither be in one set alone nor come back unseen
let defaultModel = null;
for (const side of SIDE_NAMES) {
  const { mdl, tris } = make(side);
  const chk = K.check(mdl, "goldsrc");
  console.log(`${side}: ${tris} triangles, ${mdl.length} bytes, check ${chk.errors.length} errors, ${chk.warnings.length} warnings`);
  for (const w of chk.warnings) console.log("  WARN", w);
  for (const e of chk.errors) console.log("  ERROR", e);
  if (chk.errors.length) process.exitCode = 1;
  if (side === "default") {
    defaultModel = mdl;
    if (!QUICK) {
      const solid = solidity(mdl);
      console.log(`  solid: ${solid.errors.length ? "FAIL" : "PASS"}  ${solid.notes.join("; ")}`);
      for (const e of solid.errors) console.log("  ERROR", e);
      if (solid.errors.length) process.exitCode = 1;
    }
  } else {
    const differs = sameGeometry(defaultModel, mdl);
    console.log(`  same shape as the default set, only the picture differs: ${differs ? `NO, ${differs}` : "yes"}`);
    if (differs) process.exitCode = 1;
  }
  mkdirSync(`${GAME}/models/matchmode/${side}/h9`, { recursive: true });
  writeFileSync(`${GAME}/models/matchmode/${side}/h9/v_mechminigun.mdl`, mdl);
  if (side === "default") writeFileSync(`${GAME}/models/h9/v_mechminigun.mdl`, mdl);   // the base model is the default set
}

{
  const { mdl, tris, world } = makeWorld();
  const chk = K.check(mdl, "goldsrc");
  console.log(`world: ${tris} triangles, ${mdl.length} bytes, check ${chk.errors.length} errors, ${chk.warnings.length} warnings; extent ${world.mn.join(" ")} to ${world.mx.join(" ")}`);
  for (const w of chk.warnings) console.log("  WARN", w);
  for (const e of chk.errors) console.log("  ERROR", e);
  if (chk.errors.length) process.exitCode = 1;
  if (!QUICK) {
    const solid = solidity(mdl, { viewmodel: false });
    console.log(`  solid: ${solid.errors.length ? "FAIL" : "PASS"}  ${solid.notes.join("; ")}`);
    for (const e of solid.errors) console.log("  ERROR", e);
    if (solid.errors.length) process.exitCode = 1;
  }
  writeFileSync(`${GAME}/models/h9/w_mechminigun.mdl`, mdl);
}

// the belt, measured in the written files: its feed, its length at wide fields of view, and that the sets carry the same belt
if (!QUICK) {
  const files = [`${GAME}/models/h9/v_mechminigun.mdl`, ...SIDE_NAMES.map((s) => `${GAME}/models/matchmode/${s}/h9/v_mechminigun.mdl`)];
  const run = spawnSync(process.execPath, [`${HERE}/check-belt.mjs`, ...files, "--quiet"], { stdio: "inherit" });
  if (run.status !== 0) process.exitCode = 1;
}
