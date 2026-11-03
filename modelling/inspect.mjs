import { K, load, checked, POSE, boneIndex, surface, IN } from "./lib.mjs";

console.log(`models from: ${IN}\n`);
const name = process.argv[2] ?? "XCCPsgts";
const mdl = load(name);
const r = K.check(mdl, "goldsrc");
const tree = K.readMdl(mdl);
const bone = boneIndex(mdl);

console.log(`${name}: ${mdl.length} bytes`);
console.log(`  bones      ${tree.bones.length}`);
console.log(`  bodyparts  ${tree.bodyparts.map((b) => `${b.name}(${b.models.length})`).join(" ")}`);
console.log(`  textures   ${tree.textures.map((t) => `${t.name} ${t.width}x${t.height}`).join(", ")}`);
console.log(`  sequences  ${K.sequences(mdl).length}  [0]=${K.sequences(mdl)[0].name} [1]=${K.sequences(mdl)[1].name}`);
console.log(`  hitboxes   ${K.hitboxes(mdl).length}   attachments ${K.attachments(mdl).length}`);
console.log(`  check      ${r.errors.length} errors, ${r.warnings.length} warnings`);
if (r.warnings.length) console.log(`             ${r.warnings.join("\n             ")}`);
console.log(`  Bip01 Testa -> bone ${bone("Testa")},  SX Coscia -> ${bone("SX Coscia")}`);
const surf = surface(mdl);
console.log(`  surface    ${surf.length} points in pose ${JSON.stringify(POSE)}`);
