// The rifle for the game, as triangles: every part of the file kept, each brought down to a budget of its own
// (a part is never given a share that would collapse it: the file's optic mount and lens are a dozen triangles
// each), laid on one 512x512 picture made from the processed textures (v2_textures.py), standing with its muzzle
// along +x. Writes out2/gun_<lod>.json for the three models.
//
//   node v2-prep.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFbx, reduce, png, unpng, rgbOf, shrink } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
import { buildAtlas, remapUV } from "./atlas.mjs";

const SRC = "D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx";
const TEX = "D:/temp/lr/tex";
const OUT = "D:/Downloads/TSM/laserrifle/out2";
mkdirSync(OUT, { recursive: true });

// length of the finished rifle, in the game's units (the M4A1's is about 34)
const LENGTH = Number(process.env.LR_LENGTH ?? 34);
// how far the optic sits lower than the file has it (the file's mount, which the game's model does not have:
// a raised optic stands up into the player's view), in the file's units
const OPTIC_DROP = Number(process.env.LR_OPTIC_DROP ?? 4.4);

// triangles each part is brought down to, for [first person, another's hands, the floor]; null drops the part
const BUDGET = {
  "Rifle|RifleBodyTop": [2100, 650, 700],
  "Rifle|RifleBodyBottom": [1150, 350, 380],
  "Rifle|StockPad": [380, 100, 110],
  "Rifle|Barrel": [850, 250, 280],
  "Rifle|Handle": [1500, 360, 400],
  "Rifle|Handle.001": [320, 80, 90],
  "Rifle|Hinge": [280, 80, 90],
  "Rifle|Slide": [150, 50, 56],
  "Rifle|Ring": [170, 50, 56],
  "Rifle|InnerRing": [100, 30, 34],
  "Magazine|Magazine": [760, 250, 280],
  "Optic|Optic": [944, 450, 450],
  "Optic|OpticRest": null,
  "Optic|OpticLens": null, // the small hex light on the side: the two lens plates are enough
  "Optic.001|OpticLens": null,
  "Reticles|Material.007": null,
  "Optic|OpticGlass": [12, 12, 12],
  "Slide|Slide": [44, 44, 44],
  "Slide|SlideCover": [28, 28, 28],
  "Trigger|Trigger": [160, 60, 60],
  "Rifle|FlashlightBulb": null,
  "Rifle|FlashlightGlass": null,
};
const LODS = ["v", "p", "w"];
// The barrel's pieces (a long box, plates, a nose, the slots' insides, the muzzle pipe) come apart under the quadric
// reducer into loose fragments and needles. A barrel is one flat black colour, so its points are gathered into a
// grid instead: every point goes to the mean of the points in its cell, and what has become flat is dropped.
const BARREL_CELL = [3.2, 4.8, 4.8]; // the file's units
function cluster(tris, cell) {
  const at = new Map();
  const cellOf = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  for (const t of tris) for (const c of t) {
    const k = cellOf(c.p);
    const e = at.get(k) ?? { s: [0, 0, 0], n: 0 };
    for (let a = 0; a < 3; a++) e.s[a] += c.p[a];
    e.n++;
    at.set(k, e);
  }
  const rep = (c) => { const e = at.get(cellOf(c.p)); return e.s.map((v) => v / e.n); };
  const seen = new Set();
  const out = [];
  for (const t of tris) {
    const keys = t.map((c) => cellOf(c.p));
    if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2]) continue;
    const id = [...keys].sort().join("|");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(t.map((c) => ({ ...c, p: rep(c), uv: [0.5, 0.5] })));
  }
  return out;
}
const DROPPED = new Set(["Optic", "Optic.001", "Reticles"]); // the optic's objects, which move down
// the file shows the magazine out of the rifle (as its Sketchfab page does); it goes up into the magazine well this
// far, in the file's units
const MAG_LIFT = Number(process.env.LR_MAG_LIFT ?? 22);
// the optic's glass is one sided in the file (it is seen through the hex opening from the front); the game's
// engine draws one side only, so each glass triangle is given a back as well
const GLASS = (g) => g.material === "OpticGlass" || g.material === "OpticLens";

const scene = readFbx(readFileSync(SRC));
const keyOf = (g) => `${g.object}|${g.material}`;
// The optic's two lenses are made here: a hexagonal plate at each end, inside the opening (the file's own glass is a
// thin strip at the rear and, at the front, a plate the same size), drawn with one blue lens picture. A fan of six
// triangles round a middle point; the picture's corners are the box that holds the hexagon.
const plate = (x, y0, y1, yTop, zTop, zBottom, yBottom, zSide) => {
  const P = [[-y1, zSide], [-yTop, zTop], [yTop, zTop], [y1, zSide], [yBottom, zBottom], [-yBottom, zBottom]];
  const left = -y1, width = 2 * y1;
  const uvOf = ([y, z]) => [(y - left) / width, (zTop - z) / (zTop - zBottom)];
  const mid = [0, (zSide + zBottom) / 2 + 0.5];
  const tris = [];
  for (let i = 0; i < 6; i++) {
    const a = P[i], b = P[(i + 1) % 6];
    const c = (q) => ({ p: [typeof x === "function" ? x(q[1]) : x, q[0], q[1]], uv: uvOf(q), n: [1, 0, 0] });
    tris.push([c(mid), c(b), c(a)]);
  }
  return tris;
};
const GLASS_PLATES = [
  plate(47.2, 0, 0, 9.6, 63.4, 47.6, 8.3, 57.0), // the rear one: 12.2 either side of the middle at its widest
  plate(-12.0, 0, 0, 10.8, 64.2, 47.5, 7.9, 57.2),
];
GLASS_PLATES[0] = (() => { const t = plate(49.5, 0, 13.6, 10.6, 63.7, 47.2, 9.0, 57.4); return t; })();
// the front one lies on the optic's sloped nose (x = -11.8 at z 47.1 to -17.8 at 64.2), a little outside it
GLASS_PLATES[1] = (() => { const t = plate((z) => -11.8 - 0.351 * (z - 47.1) - 0.25, 0, 13.6, 10.8, 63.7, 47.4, 8.6, 57.4); return t; })();
const glassGroup = { object: "Optic", group: "OpticGlass", material: "OpticGlass", tris: GLASS_PLATES.flat() };
const groups = [...scene.groups.filter((g) => BUDGET[keyOf(g)] !== undefined && BUDGET[keyOf(g)] !== null), glassGroup];
for (const g of scene.groups) if (!(keyOf(g) in BUDGET)) console.log("NOT IN THE BUDGET:", keyOf(g), g.tris.length);

const box = (tris) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) for (const c of tri) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], c.p[a]); mx[a] = Math.max(mx[a], c.p[a]); }
  return { mn, mx };
};
const show = (b) => `${b.mn.map((v) => v.toFixed(1))} .. ${b.mx.map((v) => v.toFixed(1))}`;
for (const key of ["Rifle|RifleBodyTop", "Optic|Optic", "Optic|OpticRest", "Optic.001|OpticLens", "Optic|OpticLens", "Reticles|Material.007", "Trigger|Trigger", "Rifle|Handle", "Magazine|Magazine", "Rifle|Barrel"]) {
  const g = scene.groups.find((x) => keyOf(x) === key);
  if (g) console.log(key.padEnd(24), show(box(g.tris)));
}

// the points two parts share stay where they are in both, so that no crack opens between them
const keyP = (p) => `${p[0]},${p[1]},${p[2]}`;
const runsAt = new Map();
groups.forEach((g, nth) => {
  for (const tri of g.tris) for (const c of tri) {
    const k = keyP(c.p);
    (runsAt.get(k) ?? runsAt.set(k, new Set()).get(k)).add(nth);
  }
});
const keep = (p) => runsAt.get(keyP(p))?.size > 1;

// the processed pictures, and the flat colours of the parts that have none. A part that is all one dark colour in
// the picture (a hinge, a ring) is given its mean colour and no picture, so that the reducer has no seams of a
// picture to keep and its triangles can come down.
const FLAT = { StockPad: [0.03, 0.03, 0.035], "Material.007": [0.22, 0.52, 1.0] };
const FLATTEN = new Set(["Barrel", "Hinge", "Slide", "Ring", "InnerRing", "Handle.001", "Trigger"]);
for (const name of FLATTEN) {
  const im = rgbOf(unpng(readFileSync(`${TEX}/${name}.png`)));
  const sum = [0, 0, 0];
  for (let i = 0; i < im.width * im.height; i++) for (let c = 0; c < 3; c++) sum[c] += im.rgb[i * 3 + c];
  FLAT[name] = sum.map((v) => v / (im.width * im.height) / 255);
  console.log("flat colour", name, FLAT[name].map((v) => v.toFixed(3)).join(" "));
}
const have = new Map();
const pictures = [];
const materials = [];
for (const g of groups) {
  if (have.has(g.material)) continue;
  have.set(g.material, true);
  if (FLAT[g.material]) materials.push({ name: g.material, colour: FLAT[g.material] });
  else {
    pictures.push({ bytes: readFileSync(`${TEX}/${g.material}.png`) });
    materials.push({ name: g.material, image: pictures.length - 1 });
  }
}
const picScene = { images: pictures, materials };

// the small lens of the file has all its corners at one point of the picture; it is given the brightest part of the
// blue lens picture
const LENS_UV = (() => {
  const im = rgbOf(unpng(readFileSync(`${TEX}/OpticLens.png`)));
  const B = 32, n = im.width / B;
  let best = -1, at = [0.5, 0.5];
  for (let by = 2; by < n - 2; by++) for (let bx = 2; bx < n - 2; bx++) {
    let sum = 0;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const i = ((by * B + y) * im.width + bx * B + x) * 3; sum += im.rgb[i + 1] + im.rgb[i + 2]; }
    if (sum > best) { best = sum; at = [(bx + 0.5) / n, (by + 0.5) / n]; }
  }
  console.log("lens bright spot at", at.map((v) => v.toFixed(3)).join(","));
  return at;
})();

const outputs = {};
for (let lod = 0; lod < 3; lod++) {
  const reduced = [];
  for (const g of groups) {
    const budget = BUDGET[keyOf(g)][lod];
    if (budget === null || budget === undefined) continue;
    const flat = FLATTEN.has(g.material);
    let tris = g.tris.filter((tri) => {
      // the small white hex that sticks out of the optic's rear face (the file's x runs to the stock), over the lens
      if (g.object === "Optic" && g.material === "Optic" && Math.max(tri[0].p[0], tri[1].p[0], tri[2].p[0]) > 49.45) return false;
      const [a, b, c] = tri.map((corner) => corner.p);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) > 1e-9;
    });
    if (flat) tris = tris.map((tri) => tri.map((c) => ({ ...c, uv: [0.5, 0.5] })));
    if (g.material === "Barrel") {
      tris = cluster(tris, BARREL_CELL[lod]);
    } else if (tris.length > budget) {
      let r = reduce(tris, { target: budget, creaseAngle: 30, keep });
      tris = r.tris;
      // stopped short: go on with the creases let go (the edges of a box are still kept by its borders and its corners);
      // not for the barrel, whose reduction then leaves long needles across the gun
      for (const angle of g.material === "Barrel" ? [] : [55, 80]) {
        if (tris.length <= budget * 1.12) break;
        r = reduce(tris, { target: budget, creaseAngle: angle, keep });
        tris = r.tris;
      }
    }
    if (flat) tris = tris.map((tri) => tri.map((c) => ({ ...c, uv: [0.5, 0.5] })));
    if (g.object === "Optic" && g.material === "OpticLens") tris = tris.map((tri) => tri.map((c) => ({ ...c, uv: LENS_UV })));
    if (GLASS(g)) tris = tris.concat(tris.map((tri) => [tri[0], tri[2], tri[1]]));
    reduced.push({ ...g, tris });
    console.log(`  lod ${LODS[lod]} ${keyOf(g).padEnd(24)} ${String(g.tris.length).padStart(6)} -> ${tris.length}`);
  }
  const total = reduced.reduce((s, g) => s + g.tris.length, 0);
  console.log(`lod ${LODS[lod]}: ${total} triangles`);
  outputs[LODS[lod]] = reduced;
}

// one picture for the three: the atlas holds every material's used part
// the optic's lenses wear a picture of their own (a texture of the model with the fullbright flag: they glow whatever the map's light), so the atlas does not hold them
const atlasScene = { ...picScene, groups: outputs.v.filter((g) => g.material !== "OpticGlass").map((g) => ({ ...g })) };
const { image, cells, said } = buildAtlas(atlasScene, { size: 512, boost: { OpticGlass: 7, Optic: 2.4, Handle: 1.5, RifleBodyTop: 1.4, RifleBodyBottom: 1.1, Magazine: 1.2, StockPad: 0.03, Barrel: 0.03, Hinge: 0.03, Slide: 0.03, Ring: 0.03, InnerRing: 0.03, 'Handle.001': 0.03, Trigger: 0.03 } });
console.log("atlas:", said);
{
  const rgba = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    rgba[i * 4] = image.rgb[i * 3];
    rgba[i * 4 + 1] = image.rgb[i * 3 + 1];
    rgba[i * 4 + 2] = image.rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  writeFileSync(`${OUT}/atlas.png`, png(image.width, image.height, rgba));
}

// into the game's space: the muzzle along +x (the file's own x and y are turned half a turn), its longest side
// LENGTH, centred across and along, standing on z = 0
const all = outputs.v.flatMap((g) => g.tris);
let lo = Infinity, hi = -Infinity;
for (const tri of all) for (const c of tri) { lo = Math.min(lo, -c.p[0]); hi = Math.max(hi, -c.p[0]); }
const scale = LENGTH / (hi - lo);
console.log("file length", (hi - lo).toFixed(1), "scale", scale.toFixed(5));
const placeFor = (tris) => tris.map((tri) =>
  tri.map((c) => ({ p: [-c.p[0] * scale, -c.p[1] * scale, c.p[2] * scale], uv: c.uv, part: "", mat: "" })));
// the centre is taken from the first person set and used for all three
const stood = placeFor(all);
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (const tri of stood) for (const c of tri) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], c.p[a]); mx[a] = Math.max(mx[a], c.p[a]); }
const move = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]];

const result = {};
for (const lodName of LODS) {
  const tris = [];
  const centroids = {};
  for (const g of outputs[lodName]) {
    const drop = DROPPED.has(g.object) ? OPTIC_DROP : 0;
    const lift = g.object === "Magazine" ? MAG_LIFT : 0;
    const sum = [0, 0, 0];
    let n = 0;
    for (const tri of g.tris) {
      const corners = tri.map((c) => {
        const p = [-c.p[0] * scale - move[0], -c.p[1] * scale - move[1], (c.p[2] - drop + lift) * scale - move[2]];
        sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; n++;
        return { p, uv: g.material === "OpticGlass" ? c.uv : remapUV(c, cells.get(g.material), image.width), part: g.object, mat: g.material };
      });
      tris.push(corners);
    }
    centroids[keyOf(g)] = sum.map((v) => v / Math.max(1, n));
  }
  result[lodName] = { tris, centroids };
  const b = box(tris);
  console.log(`lod ${lodName}: ${tris.length} triangles, box ${show(b)}`);
}
const lensImage = shrink(rgbOf(unpng(readFileSync(`${TEX}/OpticGlass.png`))), 2);
writeFileSync(
  `${OUT}/gun.json`,
  JSON.stringify({
    texture: { width: image.width, height: image.height, rgb: Buffer.from(image.rgb).toString("base64") },
    lens: { width: lensImage.width, height: lensImage.height, rgb: Buffer.from(lensImage.rgb).toString("base64") },
    lods: result,
    scale,
  }),
);
console.log("wrote", `${OUT}/gun.json`);
