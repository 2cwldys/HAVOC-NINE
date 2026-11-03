// The insurgent machine: ed209_ts re-liveried as the battered rebel mech.
//
//     node make-mech-ins.mjs            -> ../export-mdl/mech_ins/mech_ins.mdl
//
// Same anatomy as make-mech-msr.mjs, read the same way (see that file's header
// for the measurements). The livery is done at the palette first: the greys
// re-graded to olive drab, the reds (lamps, limb rings) kept RED, the hazard
// chevrons to worn ochre. Then one painted pass by body position: a flecktarn
// camo of green, dark green, tan, brown and near-black blobs over the drab,
// scavenged mismatched panels, rust running from the ledges and down the
// panels, mud on the feet. NO LETTERING ANYWHERE -- the customer asked for
// clean chests.
//
// Build every variant from the pristine original, never from the last output.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, checked, clamp, texturesLast, POSE, lineup } from "./lib.mjs";
import { addGear, STYLE_INS } from "./mech-gear.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const NAME = "mech_ins_bot";
const SHEET = "ed209_sheet0.bmp";
const src = load("ed209_ts");

// ── the palette, entry by entry ────────────────────────────────────────────
const t0 = K.textureOf(src, SHEET);
const flat = typeof t0.palette[0] === "number";
const at = (i) => flat
  ? [t0.palette[i * 3] / 255, t0.palette[i * 3 + 1] / 255, t0.palette[i * 3 + 2] / 255]
  : [t0.palette[i][0] / 255, t0.palette[i][1] / 255, t0.palette[i][2] / 255];
const N = flat ? t0.palette.length / 3 : t0.palette.length;
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
// per-channel colour multiply: workshop.times takes one factor, and handing it
// an array writes NaN, which lands on the sheet as black
const shade = (c, k) => [c[0] * k[0], c[1] * k[1], c[2] * k[2]];

// olive drab: shadowed green under half, dusty khaki over it. The dark end
// sits at charcoal, not black: pure black beside olive reads as holes, not
// painted metal.
const drab = (L) => L <= 0.5
  ? W.mix([0.085, 0.09, 0.075], [0.32, 0.33, 0.24], L / 0.5)
  : W.mix([0.32, 0.33, 0.24], [0.56, 0.57, 0.46], (L - 0.5) / 0.5);
// the lamps and limb rings: worn RED, following the old red's brightness --
// the insurgent keeps the red of the machine's markings
const red = (t01) => W.mix([0.36, 0.06, 0.05], [0.78, 0.19, 0.12], t01);
// the hazard chevrons: ochre, dust beaten into it
const ochre = (t01) => W.mix([0.28, 0.24, 0.08], [0.58, 0.50, 0.16], t01);

const pal = new Uint8Array(N * 3);
const counts = { drab: 0, rust: 0, ochre: 0 };
for (let i = 0; i < N; i++) {
  const [r, g, b] = at(i);
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  let c;
  if (sat < 0.10 || (b >= r - 0.02 && b >= g - 0.02)) {
    c = drab(lum([r, g, b])); counts.drab++;
  } else if (g - b > 0.25) {
    c = ochre(clamp((g - 0.45) / 0.45)); counts.ochre++;
  } else if (r - b > 0.15 || r - g > 0.12) {
    c = red(clamp((r - 0.35) / 0.55)); counts.rust++;
  } else {
    c = drab(lum([r, g, b])); counts.drab++;
  }
  for (let k = 0; k < 3; k++) pal[i * 3 + k] = Math.round(clamp(c[k]) * 255);
}
console.log(`palette ${N}: ${counts.drab} drab, ${counts.rust} rust, ${counts.ochre} ochre`);

const livery = K.replaceTexture(src, SHEET, { ...t0, palette: pal });

// ── the machine, and the weather it has lived through ──────────────────────
const RUST = [0.30, 0.16, 0.07];
const MUD = [0.22, 0.20, 0.14];
const SOOT = [0.13, 0.13, 0.10];

const { mdl: worn, shared } = K.paint(livery, ({ p, n, rgb }) => {
  let c = rgb;
  const bl = c[0] * 0.3 + c[1] * 0.6 + c[2] * 0.1;

  // the dome, one dark mass, takes olive paint like the rest
  if (p[2] > 39.5 && Math.abs(p[1]) < 21 && bl < 0.35) c = W.mix(c, [0.42, 0.43, 0.33], 0.60);
  // what counts as a plate: the rubber seals, slot interiors and the slung
  // shadow areas stay unpainted -- repairs and chips on a seal read as grime
  const plate = clamp((c[0] * 0.3 + c[1] * 0.6 + c[2] * 0.1 - 0.16) / 0.12);

  // flecktarn: the machine's own paint -- blobs of green, dark green, tan,
  // brown and near-black speckle over the drab, under the repairs and rust
  const F = {
    base: [0.24, 0.28, 0.15], dark: [0.13, 0.17, 0.085], black: [0.085, 0.095, 0.07],
    tan: [0.40, 0.34, 0.19], brown: [0.27, 0.15, 0.075],
  };
  const bs = W.fbm(p[1] * 0.30 + 3, p[2] * 0.30, 7, 41);
  const fs = W.fbm(p[0] * 0.5 + 8, p[1] * 0.5, 3, 55);
  let k = F.base;
  if (bs > 0.56) k = fs > 0.52 ? F.dark : F.black;
  else if (bs < 0.40) k = fs > 0.56 ? F.tan : F.brown;
  else if (fs > 0.68) k = F.dark;
  c = W.mix(c, k, 0.80 * plate);

  // scavenged repairs: whole panels came off a different machine
  const patch = W.fbm(p[1] * 0.14 + 3, p[2] * 0.14, 3, 21);
  if (patch > 0.62) c = W.mix(c, shade(c, [1.12, 1.02, 0.78]), 0.35 * plate);
  if (patch < 0.38) c = W.mix(c, shade(c, [0.78, 0.82, 0.90]), 0.30 * plate);

  // rust: runs down the panels, heaviest low, and drips off the flat ledges
  const rs = W.fbm(p[1] * 0.5 + 13, p[2] * 0.09, 3, 33);
  const low = clamp((8 - p[2]) / 50);
  c = W.mix(c, RUST, clamp((rs - 0.52) * 6) * (0.25 + 0.55 * low) * 0.50);
  const drip = W.fbm(p[0] * 0.4 + 5, p[1] * 0.4, 2, 44);
  c = W.mix(c, [0.28, 0.14, 0.06], clamp((drip - 0.55) * 4) * Math.max(0, n[2]) * 0.35);

  // dust and soot, and mud on the feet
  const dirt = W.fbm(p[0] * 0.28 + 7, p[1] * 0.3, 2, 4);
  c = W.mix(c, SOOT, clamp((dirt - 0.42) * 3) * 0.35);
  const mud = clamp((-p[2] - 16) / 16) * clamp((W.fbm(p[0] * 0.5, p[1] * 0.5 + 44, 2, 6) - 0.35) * 2.5);
  c = W.mix(c, MUD, mud * 0.60);

  // worn pale chips, plates only
  const sc = W.fbm(p[1] * 1.4 + 3, p[2] * 1.4, 2, 13);
  c = W.mix(c, [0.52, 0.52, 0.42], clamp((sc - 0.70) * 8) * Math.max(0, n[2]) * 0.25 * plate);

  return c;
}, { pose: POSE, only: [SHEET] });

for (const [t, s] of Object.entries(shared)) {
  console.log(`  ${t}: ${(s * 100).toFixed(0)}% of its pixels are worn by two places at once`);
}

// ── the kit: gun housing, drum, pauldrons, cables, wires, straps ───────────
const { mdl: geared, texture: gearTex } = addGear(worn, STYLE_INS);

// ── out ────────────────────────────────────────────────────────────────────
mkdirSync(join(OUT, NAME), { recursive: true });
writeFileSync(join(OUT, NAME, NAME + ".mdl"), checked(NAME, texturesLast(geared)));
console.log(`  wrote export-mdl/${NAME}/${NAME}.mdl`);

const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };

put("mech_ins_bot_preview.png", lineup([["ed209 (from)", src], ["mech_ins_bot", geared]], { ...POSE, yaws: [0, 120, 215], zoom: 1.4, width: 300, cols: 6 }));
put("mech_ins_bot_sheet.png", K.sheet(geared, { ...POSE, size: 420 }));
const tw = K.textureOf(geared, SHEET);
put("mech_ins_bot_texture.png", { width: tw.width, height: tw.height, rgba: K.rgbaOf(tw) });

// the kit itself: right arm from two bearings, and the rear for the cables
put("mech_ins_bot_gear.png", lineup([["ed209 arm", src], ["mech_ins_bot kit", geared]], { ...POSE, yaws: [55, 130], zoom: 2.0, width: 360, cols: 4, target: [4, -28, 30] }));
put("mech_ins_bot_back.png", lineup([["ed209 back", src], ["mech_ins_bot cables", geared]], { ...POSE, yaws: [180, 218], zoom: 1.8, width: 360, cols: 4, target: [-4, 0, 6] }));
put("mech_ins_bot_geartex.png", { width: gearTex.width, height: gearTex.height, rgba: K.rgbaOf(gearTex) });

// head only, original beside it: below z 27 and outside |y| 21 dropped
const central = ({ mid }) => mid[2] < 27 || Math.abs(mid[1]) > 21;
const { mdl: faceA } = K.dropTriangles(src, central, POSE);
const { mdl: faceB } = K.dropTriangles(geared, central, POSE);
put("mech_ins_bot_face.png", lineup([["ed209 face", faceA], ["mech_ins_bot face", faceB]], { ...POSE, yaws: [0, 35], zoom: 1.5, width: 380, cols: 4 }));
