// The TSF machine: ed209_ts re-liveried as the Natural Selection marine mech.
//
//     node make-mech-msr.mjs            -> ../export-mdl/mech_msr/mech_msr.mdl
//
// THE WHOLE MACHINE IS ONE PICTURE. ed209_sheet0.bmp -- 512x512, 8-bit
// paletted -- carries every panel; the other two textures in the file are dead
// weight from the donor skeleton and wear no triangles. So the new livery is
// done at the palette: each of the 256 entries is classified by what it is and
// re-set -- the cold greys re-graded to blue steel, the reds (the lamps, the
// stripe rings on the thighs and knees) turned to the glowing blue, the hazard
// chevrons cooled to graphite. Then one painted pass by body position adds the
// machine's new features and the wear the reference has.
//
// MEASURED, NOT GUESSED (mech-probe.mjs and smak's own `layers`):
//   * he faces +x, his right is -y; soles z -35.9, dome top 47.5
//   * the dome, one dark mass, is z 39.5..48.5, |y| < 18.7
//   * the visor slot -- a black letterbox -- is z 33..36 across the front
//   * the chin band under the visor is z 25.5..31.8 flat at x 10..12 -- left
//     bare. NO LETTERING ANYWHERE: the first pass stencilled a name here and
//     it read as clutter. The machine carries no words.
//   * the chest vent with its two lamp squares is z 12..20, |y| < 8, and is
//     the only run of near-black facing forward there -- the bar grid trusts it
//
// Build every variant from the pristine original, never from the last output.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, checked, clamp, texturesLast, POSE, lineup } from "./lib.mjs";
import { addGear, STYLE_MSR } from "./mech-gear.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const NAME = "mech_msr_bot";
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

// blue steel: the same value, worn colder and a touch lighter at the top
const steel = (L) => {
  const k = 0.04 + 0.96 * L;
  return [k * 0.82, k * 0.92, Math.min(1, k * 1.18)];
};
// the lamps: deep navy blue up to a hot glow, following the old red's brightness
const glow = (t01) => W.mix([0.06, 0.22, 0.65], [0.45, 0.78, 1.0], t01);
const GRAPHITE = [0.10, 0.12, 0.16];

const pal = new Uint8Array(N * 3);
const counts = { steel: 0, glow: 0, graphite: 0 };
for (let i = 0; i < N; i++) {
  const [r, g, b] = at(i);
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  let c;
  if (sat < 0.10 || (b >= r - 0.02 && b >= g - 0.02)) {
    c = steel(lum([r, g, b])); counts.steel++;            // the grey the panels are drawn in
  } else if (g - b > 0.25) {
    c = GRAPHITE; counts.graphite++;                      // the hazard chevrons
  } else if (r - b > 0.15 || r - g > 0.12) {
    c = glow(clamp((r - 0.35) / 0.55)); counts.glow++;    // lamps and the limb rings
  } else {
    c = steel(lum([r, g, b])); counts.steel++;
  }
  for (let k = 0; k < 3; k++) pal[i * 3 + k] = Math.round(clamp(c[k]) * 255);
}
console.log(`palette ${N}: ${counts.steel} steel, ${counts.glow} glow, ${counts.graphite} graphite`);

const livery = K.replaceTexture(src, SHEET, { ...t0, palette: pal });

// ── the machine, and the wear, painted by body position ────────────────────
const GRIME = [0.16, 0.17, 0.19];
const DUST = [0.30, 0.32, 0.35];

const { mdl: worn, shared } = K.paint(livery, ({ p, n, rgb }) => {
  let c = rgb;
  // what the pixel was before any wear: the black rubber and the recesses are
  // never given paint chips, only the plates
  const bl = c[0] * 0.3 + c[1] * 0.6 + c[2] * 0.1;

  // the dome, one dark mass, takes paint ...
  if (p[2] > 39.5 && Math.abs(p[1]) < 21 && bl < 0.35) c = W.mix(c, [0.56, 0.62, 0.73], 0.72);
  // ... and the visor slot lights, the scanner every TSF machine has
  if (p[2] > 32.8 && p[2] < 36.3 && Math.abs(p[1]) < 15.5 && n[0] > 0.3 && bl < 0.2) c = [0.22, 0.52, 1.0];

  // grime: streaks that run down the body, heaviest low
  const streak = W.fbm(p[1] * 0.55 + 31, p[2] * 0.11, 3, 9);
  const low = clamp((10 - p[2]) / 46);
  c = W.mix(c, W.times(GRIME, 0.9 + 0.2 * streak), clamp((streak - 0.52) * 6) * (0.18 + 0.5 * low) * 0.55);

  // soot settles on the flat tops
  const soot = W.fbm(p[0] * 0.3 + 7, p[1] * 0.3, 2, 4);
  c = W.mix(c, W.times(GRIME, 0.8), clamp((soot - 0.45) * 3) * Math.max(0, n[2]) * 0.25);

  // the feet, dusted
  const dust = clamp((-p[2] - 16) / 16) * clamp((W.fbm(p[0] * 0.5, p[1] * 0.5 + 44, 2, 6) - 0.4) * 2.5);
  c = W.mix(c, DUST, dust * 0.45);

  // pale scuffs, upper faces only, and only where the plate was pale to
  // begin with -- chipped paint on a lamp or a rubber seal reads as noise
  const sc = W.fbm(p[1] * 1.4 + 3, p[2] * 1.4, 2, 13);
  c = W.mix(c, [0.55, 0.62, 0.72], clamp((sc - 0.68) * 8) * Math.max(0, n[2]) * 0.30 * clamp((bl - 0.30) / 0.25));

  // the chest vent: the dark pixels inside its window take the bar grid, which
  // is what turns a black grille into the lit intake the reference has
  const lg = c[0] * 0.3 + c[1] * 0.6 + c[2] * 0.1;
  if (p[2] > 12 && p[2] < 20 && Math.abs(p[1]) < 8 && n[0] > 0.35 && lg < 0.16) {
    const phase = ((p[1] + 8) % 2.9) / 2.9;
    if (phase < 0.42) {
      const shade = 0.85 + 0.25 * Math.max(0, n[2]);
      c = [0.10 * shade, 0.42 * shade, shade];
    }
  }
  return c;
}, { pose: POSE, only: [SHEET] });

for (const [t, s] of Object.entries(shared)) {
  console.log(`  ${t}: ${(s * 100).toFixed(0)}% of its pixels are worn by two places at once`);
}

// ── the kit: gun housing, drum, pauldrons, cables, wires, antenna ──────────
const { mdl: geared, texture: gearTex } = addGear(worn, STYLE_MSR);

// ── out ────────────────────────────────────────────────────────────────────
mkdirSync(join(OUT, NAME), { recursive: true });
writeFileSync(join(OUT, NAME, NAME + ".mdl"), checked(NAME, texturesLast(geared)));
console.log(`  wrote export-mdl/${NAME}/${NAME}.mdl`);

const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };

put("mech_msr_bot_preview.png", lineup([["ed209 (from)", src], ["mech_msr_bot", geared]], { ...POSE, yaws: [0, 120, 215], zoom: 1.4, width: 300, cols: 6 }));
put("mech_msr_bot_sheet.png", K.sheet(geared, { ...POSE, size: 420 }));
const tw = K.textureOf(geared, SHEET);
put("mech_msr_bot_texture.png", { width: tw.width, height: tw.height, rgba: K.rgbaOf(tw) });

// the kit itself: right arm from two bearings, and the rear for the cables
put("mech_msr_bot_gear.png", lineup([["ed209 arm", src], ["mech_msr_bot kit", geared]], { ...POSE, yaws: [55, 130], zoom: 2.0, width: 360, cols: 4, target: [4, -28, 30] }));
put("mech_msr_bot_back.png", lineup([["ed209 back", src], ["mech_msr_bot cables", geared]], { ...POSE, yaws: [180, 218], zoom: 1.8, width: 360, cols: 4, target: [-4, 0, 6] }));
put("mech_msr_bot_geartex.png", { width: gearTex.width, height: gearTex.height, rgba: K.rgbaOf(gearTex) });

// The renderer frames the whole machine, so the face is small in every view.
// Head only, original beside it: below z 27 and outside |y| 21 dropped.
const central = ({ mid }) => mid[2] < 27 || Math.abs(mid[1]) > 21;
const { mdl: faceA } = K.dropTriangles(src, central, POSE);
const { mdl: faceB } = K.dropTriangles(worn, central, POSE);
put("mech_msr_bot_face.png", lineup([["ed209 face", faceA], ["mech_msr_bot face", faceB]], { ...POSE, yaws: [0, 35], zoom: 1.5, width: 380, cols: 4 }));
