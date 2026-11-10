// v_mechminigun.mdl: the Mech's minigun view model, an arm-mounted rotary cannon, in the three side sets.
//
//   node build-minigun.mjs <game folder>          (a folder shaped like H9XASH\ts; created if need be)
// writes <game>\models\h9\v_mechminigun.mdl (the default set) and <game>\models\matchmode\{msr,insurgent,default}\h9\v_mechminigun.mdl.
//
// The stock M60 view model supplies the skeleton, the animations (idle, draw, shoot, shoot2, reload, stock) with their
// events, and the attachments; none of its meshes or pictures is kept, so no hand or glove remains. The cannon's rotor is
// a bone added under m60 and turned by the two shoot animations.
import { mkdirSync, writeFileSync } from "node:fs";
import { K, STOCK_MODELS, loadStock, addBones, boneIndex, intoBone, onBones, writeModel, sideTextures } from "./common.mjs";
import { build, boneOf, AXIS, D } from "./minigun.mjs";
import { meleeThrust } from "./motion.mjs";

const GAME = process.argv[2] ?? "D:/temp/wf/mecharms/scratch/game";
mkdirSync(`${GAME}/models/h9`, { recursive: true });

const SIDE_NAMES = ["default", "msr", "insurgent"];
const BUILT = Object.fromEntries(SIDE_NAMES.map((s) => [s, build(s)]));
// the three sides' pictures differ only in the band's zone; they share one palette outside it (see sideTextures)
const TEXTURES = sideTextures(Object.fromEntries(SIDE_NAMES.map((s) => [s, BUILT[s].image])), BUILT.default.Z.BAND, "mecharm.bmp");

function make(side) {
  const stock = loadStock(`${STOCK_MODELS}/v_m60.mdl`);
  addBones(stock, [{ name: "rotor", parent: "m60", pos: intoBone(stock, "m60", [15.0, AXIS.y, AXIS.z]) }]);
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
  const muzzle = intoBone(stock, "m60", [D.muzzleX, AXIS.y, AXIS.z]);
  stock.attachments[0] = { ...stock.attachments[0], pos: muzzle };

  const made = BUILT[side];
  const byBone = onBones(stock, made.tris, boneOf);
  const group = (name) => (name === "m60" ? "arm" : name === "rotor" ? "rotor" : "cover");
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

for (const side of SIDE_NAMES) {
  const { mdl, tris } = make(side);
  const chk = K.check(mdl, "goldsrc");
  console.log(`${side}: ${tris} triangles, ${mdl.length} bytes, check ${chk.errors.length} errors, ${chk.warnings.length} warnings`);
  for (const w of chk.warnings) console.log("  WARN", w);
  for (const e of chk.errors) console.log("  ERROR", e);
  mkdirSync(`${GAME}/models/matchmode/${side}/h9`, { recursive: true });
  writeFileSync(`${GAME}/models/matchmode/${side}/h9/v_mechminigun.mdl`, mdl);
  if (side === "default") writeFileSync(`${GAME}/models/h9/v_mechminigun.mdl`, mdl);   // the base model is the default set
}
