// A new piece in the place of one a model already shows: the model keeps its bones, its animations, its events and
// its hands, and the game goes on using it as it did. Here a fighting knife, made with the sword kit, replaces the
// weapon of one submodel of a first-person model.
//
//   node examples/02-swap-mesh.mjs <model.mdl> <body number> [output folder, default out] [texture name pattern]
//
// Find the body number with `smak info <model.mdl>`: it is the number beside the submodel that shows the weapon.
// The last argument narrows the meshes that are replaced to those whose texture's name matches it (a regular
// expression), for a submodel that holds more than the weapon; without it, every mesh but the hands' and arms' goes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { swapMesh, indexed, shrink, check, strip, render, tile, png, HANDS, sequences } from "../src/index.mjs";
import { sword, taper } from "../kits/swordkit.mjs";

const [file, body = "0", OUT = "out", only] = process.argv.slice(2);
if (!file) { console.error("usage: node examples/02-swap-mesh.mjs <model.mdl> <body number> [output folder] [texture name pattern]"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const src = readFileSync(file);

// ── the piece: drawn in its own axes (+x from the pommel to the tip, in units); swapMesh lays it over the old one ──
const piece = sword({
  seed: 11,
  pommel: { profile: [[0, 0.35], [0.4, 0.62], [0.9, 0.5]], metal: "gunmetal" },
  grip: { profile: [[0.8, 0.5], [2.2, 0.6], [4.4, 0.56], [5.2, 0.6]], flatten: 0.75, wrap: "cord", colour: [0.07, 0.08, 0.07] },
  guard: { x: 5.4, sections: [[-1.3, 0.2, 0.14], [-0.6, 0.3, 0.26], [0, 0.34, 0.3], [0.6, 0.3, 0.26], [1.3, 0.2, 0.14]], metal: "gunmetal" },
  blade: { x0: 5.7, x1: 17, half: taper(0.9, 0.8, 0.7, 0.9), section: "single", thick: 0.2, rust: -1 },
});
// the kit paints 1024 wide; a quarter of that is what a GoldSrc texture should be (512 at most, a power of two)
const texture = indexed(shrink(piece.image, 2), "knife_smak.bmp");

const pick = (mesh) => !HANDS.test(mesh.texture.name) && (!only || new RegExp(only, "i").test(mesh.texture.name));
// size "own": the knife was drawn in the game's units (17 long) and stays that long, held where the old piece was held.
// Without it the piece is stretched to the old one's length, which is right for a like-for-like replacement.
const { mdl, report } = swapMesh(src, { body: Number(body), pick, piece, texture, size: "own", name: basename(file) });
console.log(`${report.model}: ${report.was} -> ${report.now} triangles on ${report.bones.join(" + ")}, scale ${report.scale.toFixed(3)}, ${report.turn}, outline off by ${report.left.toFixed(2)} units`);

const result = check(mdl, "goldsrc");
for (const line of [...result.warnings.map((w) => `WARN ${w}`), ...result.errors.map((e) => `ERROR ${e}`)]) console.log(line);
const to = join(OUT, basename(file));
writeFileSync(to, mdl);

// before and after, as the player sees them, and the new one through its first animation
const o = { view: "first", body: Number(body), seq: 0, frame: sequences(src)[0]?.frames - 1 || 0, width: 480, height: 360 };
const both = tile([render(src, o), render(mdl, o)], 2, ["before", "after"]), anim = strip(mdl, { view: "first", body: Number(body), seq: 0, count: 8 });
writeFileSync(join(OUT, "swap_before_after.png"), png(both.width, both.height, both.rgba));
writeFileSync(join(OUT, "swap_strip.png"), png(anim.width, anim.height, anim.rgba));
console.log(`${to} (${src.length} -> ${mdl.length} bytes), swap_before_after.png, swap_strip.png`);
