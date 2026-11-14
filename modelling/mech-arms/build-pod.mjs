// The Mech's rocket launcher models: models/h9/v_mechrocket.mdl (first person, in the three side sets), p_mechrocket.mdl (in
// another player's arm) and w_mechrocket.mdl (on the floor), all from the stock M60's skeletons and animations.
//
//   node build-pod.mjs <game folder>          (a folder shaped like H9XASH/ts; created if need be)
// writes <game>/models/h9/{v,p,w}_mechrocket.mdl (v_ is the default set) and <game>/models/matchmode/{msr,insurgent,default}/h9/v_mechrocket.mdl.
import { mkdirSync, writeFileSync } from "node:fs";
import { K, STOCK_MODELS, loadStock, addBones, boneIndex, intoBone, onBones, writeModel, sideTextures } from "./common.mjs";
import { build, boneOf, AXIS, D } from "./pod.mjs";
import { meleeThrust, kick } from "./motion.mjs";

const GAME = process.argv[2] ?? "D:/temp/wf/mecharms/scratch/game";
mkdirSync(GAME + "/models/h9", { recursive: true });

const SIDE_NAMES = ["default", "msr", "insurgent"];
const BUILT = Object.fromEntries(SIDE_NAMES.map((s) => [s, build(s, { size: 512, kind: "v" })]));
// the three sides' pictures differ only in the band's zone; they share one palette outside it (see sideTextures)
const TEXTURES = sideTextures(Object.fromEntries(SIDE_NAMES.map((s) => [s, BUILT[s].image])), BUILT.default.Z.BAND, "mecharm.bmp");

function makeView(side) {
  const stock = loadStock(`${STOCK_MODELS}/v_m60.mdl`);
  addBones(stock, [{ name: "rotor", parent: "m60", pos: intoBone(stock, "m60", [14.9, AXIS.y, AXIS.z]) }]);
  // the cage turns a quarter at each shot, in the first moments of the animation, and rests there: four tubes in a square
  // are the same picture after a quarter turn, so the next shot starts from what looks like the beginning
  const rotor = boneIndex(stock, "rotor");
  for (const name of ["shoot", "shoot2"]) {
    const seq = stock.seqs.find((s) => s.name === name);
    seq.frames.forEach((frame, f) => {
      const t = Math.min(1, Math.max(0, (f - 3) / 10));
      frame[rotor][4] = (Math.PI / 2) * t * t * (3 - 2 * t);
    });
  }
  kick(stock, ["shoot", "shoot2"], 1.3);
  meleeThrust(stock);
  stock.attachments[0] = { ...stock.attachments[0], pos: intoBone(stock, "m60", [D.muzzleX, AXIS.y, AXIS.z]) };

  const made = BUILT[side];
  const byBone = onBones(stock, made.tris, boneOf);
  const parts = new Map();
  for (const [bone, tris] of byBone) {
    const g = bone === "m60" ? "arm" : bone === "rotor" ? "cage" : "hatch";
    if (!parts.has(g)) parts.set(g, []);
    parts.get(g).push(...tris);
  }
  const texture = TEXTURES[side];
  const mdl = writeModel(stock, { name: "v_mechrocket.mdl", parts: [...parts].map(([name, tris]) => ({ name, tris })), texture });
  return { mdl, tris: made.tris.length };
}

/** Another player's arm: the pod on the right hand, as the M60 sits in it; the floor: the pod on its side. */
const A = AXIS;
const placeP = (p) => [p[0] + 10, p[1] - A.y - 4.7, p[2] - A.z + 58.5];
const placeW = (p) => [-(p[1] - A.y) + 1.7, p[0] - 7, p[2] - A.z + 4.6];

function makeOther(file, name, kind, bone, place) {
  const stock = loadStock(`${STOCK_MODELS}/${file}`);
  const made = build("default", { size: 256, kind });
  const byBone = onBones(stock, made.tris, () => bone, place);
  const parts = [{ name: "pod", tris: [...byBone.values()].flat() }];
  const texture = K.indexed(made.image, "mecharm.bmp");
  const mdl = writeModel(stock, { name, parts, texture });
  return { mdl, tris: made.tris.length };
}

const report = (label, mdl, tris) => {
  const chk = K.check(mdl, "goldsrc");
  console.log(`${label}: ${tris} triangles, ${mdl.length} bytes, check ${chk.errors.length} errors, ${chk.warnings.length} warnings`);
  for (const w of chk.warnings) console.log("  WARN", w);
  for (const e of chk.errors) console.log("  ERROR", e);
};

for (const side of SIDE_NAMES) {
  const { mdl, tris } = makeView(side);
  report("v " + side, mdl, tris);
  mkdirSync(GAME + "/models/matchmode/" + side + "/h9", { recursive: true });
  writeFileSync(GAME + "/models/matchmode/" + side + "/h9/v_mechrocket.mdl", mdl);
  if (side === "default") writeFileSync(GAME + "/models/h9/v_mechrocket.mdl", mdl);   // the base model is the default set
}
{
  const { mdl, tris } = makeOther("p_m60.mdl", "p_mechrocket.mdl", "p", "Bip01 DX Mano", placeP);
  report("p", mdl, tris);
  writeFileSync(GAME + "/models/h9/p_mechrocket.mdl", mdl);
}
{
  const { mdl, tris } = makeOther("w_m60.mdl", "w_mechrocket.mdl", "w", "joint1", placeW);
  report("w", mdl, tris);
  writeFileSync(GAME + "/models/h9/w_mechrocket.mdl", mdl);
}
