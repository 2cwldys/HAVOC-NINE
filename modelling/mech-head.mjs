// The head alone, for looking at: everything below z 32 dropped so the renderer
// frames the dome front instead of the whole machine. Original beside variant.
// Throwaway -- a looking glass, like mech-probe.mjs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { K, load, savePng, POSE, lineup } from "./lib.mjs";

const src = load("ed209_ts");
// mid is the triangle's middle: p is its three corners. Keep the central head
// block only -- below z 27 and outside |y| 21 (the cannons) dropped, so the
// renderer frames the visor at full size.
const central = ({ mid }) => mid[2] < 27 || Math.abs(mid[1]) > 21;
const { mdl: headA } = K.dropTriangles(src, central, POSE);
const msr = readFileSync(join(process.cwd(), "..", "export-mdl", "mech_msr", "mech_msr.mdl"));
const { mdl: headB } = K.dropTriangles(msr, central, POSE);
savePng("mech_probe/head_pair.png", lineup(
  [["ed209 head", headA], ["mech_msr head", headB]],
  { ...POSE, yaws: [0, 35], zoom: 1.5, width: 380, cols: 4 },
));
savePng("mech_probe/head_big.png", lineup(
  [["mech_msr face, large", headB]],
  { ...POSE, yaws: [0], zoom: 3.4, width: 740, cols: 1 },
));
console.log("wrote out/mech_probe/head_pair.png");
