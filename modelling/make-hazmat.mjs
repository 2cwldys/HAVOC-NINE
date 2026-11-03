// A gas-masked figure in a filthy quilted suit, from merc.mdl.
//
//     node make-hazmat.mjs            -> ../export-mdl/merc/merc.mdl
//
// Everything is painted BY BODY POSITION rather than on the texture sheets, so a mark
// crosses the seams between them: the hood, the suit and the trousers are one continuous
// rule over the posed body, and the blood runs downward in model space.
//
// merc is a good donor for this: 40 bones, 171 sequences, 20 hit boxes, 4 attachments,
// and only two textures -- head.bmp for the head, merc_512_black.bmp for everything else --
// so there is nothing to unpick before painting.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, checked, clamp, texturesLast, POSE, lineup } from "./lib.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");

// ── the body, measured ─────────────────────────────────────────────────────
// z -35.8 at the soles, 36.5 at the crown. x is depth and +x is IN FRONT of him --
// measured, not assumed: painting by the sign of n[0] and rendering it shows the whole
// front face blue for +x. y is across, + to his left.
const Z = { sole: -35.8, bootTop: -27.5, knee: -17, hip: -3, waist: 2, chest: 14, neck: 25, crown: 36.5 };
const FRONT = (n) => clamp(n[0]);                       // 1 facing us, 0 facing away
const UP = (n) => clamp(n[2]);

// fbm3 takes the POINT, then how tight the noise is, a seed, and how many octaves.
// Passing loose numbers gives NaN through every colour and a model that draws black.
const n3 = (p, k, s, oct = 4) => W.fbm3(p, k, s, oct);

// ── palettes ───────────────────────────────────────────────────────────────
const SUIT   = [0.60, 0.56, 0.41];     // dirty cream-khaki
const SUIT2  = [0.33, 0.30, 0.21];     // its shadowed side
const HOOD   = [0.17, 0.145, 0.12];    // dark rubberised canvas
const RUBBER = [0.13, 0.12, 0.11];
const STEEL  = [0.30, 0.29, 0.27];
const GLASS  = [0.20, 0.17, 0.10];
const CLOTH  = [0.30, 0.28, 0.24];     // the trousers
const LEATH  = [0.14, 0.13, 0.12];     // boots
const BLOOD  = [0.155, 0.034, 0.027];
const BLOOD2 = [0.105, 0.032, 0.026];  // older, darker, nearly brown
const GRIME  = [0.17, 0.16, 0.12];
const RUST   = [0.34, 0.17, 0.07];

// ── the mask's two ports, placed in model space ────────────────────────────
// One high on the brow, one over the mouth. Both on the front of the head and on the
// centre line, so they are found by distance in the y/z plane.
const BROW   = { z: 33.2, y: 0.0, r: 1.25 };
const FILTER = { z: 28.3, y: 0.0, r: 1.85 };
const ring = (p, c) => Math.hypot(p[1] - c.y, (p[2] - c.z) * 1.12) / c.r;   // 0 middle, 1 rim

// ── blood: where it starts and how far it has run ──────────────────────────
// Sources high on the chest and on both upper arms; each bleeds downward, so the reach
// is measured with the drop stretched and the spread across narrowed.
const SOURCES = [
  { y:  0.0, z: 19.0, s: 7.5 },     // the chest
  { y: -2.4, z: 16.0, s: 6.5 },
  { y:  3.2, z: 17.5, s: 5.5 },
  { y: -6.5, z: 11.0, s: 6.5 },     // down onto the belly
  { y:  5.0, z:  9.5, s: 6.0 },
  { y:-10.5, z: 15.0, s: 7.0 },     // and both arms, which the reference has soaked
  { y: 10.5, z: 14.0, s: 7.0 },
  { y:-11.5, z:  7.0, s: 7.0 },
  { y: 11.5, z:  6.0, s: 7.0 },
  { y: -4.0, z:  5.0, s: 7.5 },     // and well down the front, which is most of it
  { y:  2.5, z:  3.0, s: 7.0 },
  { y: -9.0, z:  2.0, s: 6.0 },
  { y:  8.0, z:  1.0, s: 6.0 },
];
function bleed(p, n) {
  let m = 0;
  for (const s of SOURCES) {
    const dy = (p[1] - s.y) / (s.s * 0.85);
    const dz = p[2] > s.z ? (p[2] - s.z) / (s.s * 0.45)     // barely rises above the wound
                          : (p[2] - s.z) / (s.s * 2.6);     // runs a long way down
    m = Math.max(m, 1 - Math.hypot(dy, dz));
  }
  // It came from the front. Without this the back wore the same stain as the chest,
  // because nothing in the measure above looks at which way the surface faces.
  //
  // The floor is high enough that an arm still soaks: the outside of a sleeve faces
  // sideways, so a strict front test leaves it clean while the chest beside it runs.
  const side = n ? 0.20 + 0.80 * FRONT(n) : 1;
  return clamp(m) * side;
}

// ── the one rule ───────────────────────────────────────────────────────────
const src = load("merc");
const { mdl, shared } = K.paint(src, ({ p, n, tex }) => {
  const z = p[2], y = p[1];
  const f = FRONT(n);

  // ---- the head: a rubber hood with two ports --------------------------
  if (tex === "head.bmp" || z > Z.neck + 0.5) {
    let c = W.times(HOOD, 0.62 + 0.62 * n3(p, 0.75, 3, 6));              // worn, mottled

    // the dark lens band across the eyes
    const eye = W.bell(z - 31.2, 1.05) * clamp(1 - Math.abs(y) / 5.2) * f;
    c = W.mix(c, W.times(GLASS, 0.45 + 0.8 * n3(p, 1.4, 5, 3)), eye * 0.9);

    for (const [port, deep] of [[BROW, 0.5], [FILTER, 1.0]]) {
      const r = ring(p, port);
      if (r < 1.45 && f > 0.15) {
        const face = clamp(1 - r / 0.80);
        if (r < 0.80) {
          // concentric turned metal, darkest in the middle where the filter sits
          let m = W.times(STEEL, 0.70 + 0.55 * Math.abs(Math.cos(r * 7.0)) + 0.30 * n3(p, 3.2, 7, 4));
          m = W.mix(m, W.times(GLASS, 0.8), deep * clamp(1 - r / 0.45) * 0.85);
          const rust = clamp((n3(p, 2.2, 2, 5) - 0.48) * 5);
          c = W.mix(W.mix(c, m, clamp(face * 6)), RUST, rust * 0.5 * deep);
        }
        c = W.mix(c, W.times(RUBBER, 0.8), W.bell(r - 0.88, 0.11) * 0.95);   // the dark seating ring
        c = W.mix(c, W.times(STEEL, 1.5), W.bell(r - 1.06, 0.07) * 0.8);     // and a bright rim round it
      }
    }

    // a seam from the brow port down to the filter, as the reference has
    const seam = W.bell(y, 0.55) * clamp((z - FILTER.z) / 3.5) * clamp((BROW.z - z) / 3.5) * f;
    c = W.times(c, 1 - 0.45 * seam);

    const dirt = clamp((n3(p, 0.8, 8, 6) - 0.46) * 4) * clamp(1 - (z - Z.neck) / 11);
    return W.mix(c, GRIME, dirt * 0.5);
  }

  // ---- the boots -------------------------------------------------------
  if (z < Z.bootTop) {
    const t = clamp((z - Z.sole) / (Z.bootTop - Z.sole));
    let c = W.times(LEATH, 0.70 + 0.70 * n3(p, 1.4, 21, 5));
    c = W.mix(c, W.times(LEATH, 2.6), clamp((n3(p, 2.8, 6, 4) - 0.56) * 5) * 0.5);     // scuffs
    c = W.mix(c, [0.22, 0.19, 0.13], clamp(1 - t * 2.4) * 0.7);                        // caked at the sole
    return c;
  }

  // ---- the trousers ----------------------------------------------------
  // Rugged and slept in: coarse canvas, worn pale at the knees, filthy from the hem up.
  if (z < Z.waist) {
    const t = clamp((z - Z.bootTop) / (Z.waist - Z.bootTop));            // 0 hem, 1 waist
    const weave = 0.5 + 0.5 * Math.sin(y * 9.0) * Math.sin(z * 9.0);
    let c = W.times(CLOTH, 0.70 + 0.50 * n3(p, 0.6, 31, 5) + 0.10 * weave);

    // knees, rubbed through
    const knee = W.bell(z - Z.knee, 3.6) * clamp(1 - Math.abs(Math.abs(y) - 4.6) / 4.5) * f;
    c = W.mix(c, W.times(CLOTH, 1.8), knee * 0.55);
    const hole = clamp((n3(p, 2.0, 13, 3) - 0.60) * 6) * knee;
    c = W.mix(c, [0.07, 0.065, 0.06], hole * 0.85);                      // torn through to dark

    // grime, worst at the hem
    const filth = clamp(1 - t * 1.5) * clamp(0.35 + n3(p, 0.55, 17, 5));
    c = W.mix(c, GRIME, filth * 0.6);
    // a few long drip stains down the thigh
    const drip = clamp((n3(p, 0.9, 27, 3) - 0.58) * 7) * clamp((Z.waist - z) / 15);
    c = W.mix(c, W.times(GRIME, 0.6), drip * 0.5);

    return W.mix(c, BLOOD2, bleed(p, n) * 0.35);                         // a little has reached here
  }

  // ---- the suit --------------------------------------------------------
  // Quilted: a diamond grid, perturbed so it does not read as a printed pattern, with
  // the stitch lines darker and the pads catching the light.
  // Warped hard and on two scales, because an unperturbed grid reads as printed plaid
  // rather than as padding that has been slept in.
  const wy = n3(p, 0.40, 19, 4) * 3.4, wz = n3(p, 0.40, 61, 4) * 3.4;
  const quilt = Math.abs(Math.sin((y + wy) * 1.45) * Math.sin((z + wz) * 1.45));       // 0 at the stitches
  const fine = 0.5 + 0.5 * Math.sin((y - z) * 6.0 + wy * 3);                           // the weave inside each pad
  const pad = Math.pow(quilt, 0.42) * (0.84 + 0.16 * fine);

  let c = W.mix(SUIT2, SUIT, pad);
  c = W.times(c, 0.80 + 0.45 * n3(p, 0.62, 23, 5));                      // blotchy, unclean
  c = W.times(c, 0.72 + 0.50 * UP(n));                                   // top surfaces catch light
  c = W.mix(c, W.times(SUIT2, 0.55), clamp(1 - pad * 1.5) * 0.5);        // the stitch valleys

  // the zip, straight down his front
  const zip = W.bell(y, 0.8) * f * clamp((z - Z.hip) / 3) * clamp((Z.neck - z) / 3);
  c = W.mix(c, W.times(STEEL, 0.55 + 0.5 * Math.abs(Math.sin(z * 7.5))), zip * 0.7);

  // general filth, heavier low down and in the stitch valleys
  const dirt = clamp(0.20 + n3(p, 0.8, 29, 6)) * clamp(1 - (z - Z.hip) / 28) * (1.2 - pad * 0.5);
  c = W.mix(c, GRIME, dirt * 0.40);

  // ---- the blood -------------------------------------------------------
  const m = bleed(p, n);
  if (m > 0) {
    // Broken on three scales so it reads as cloth that has soaked and dried rather than
    // as a shape someone painted: a coarse field decides where it reached at all, a
    // middle one tears the edge up, a fine one mottles the body of it.
    // Three scales, and the middle one is what keeps the suit showing between the
    // patches: without it this covers the whole torso in one flat coat, which is the
    // one thing the reference is not -- there the cloth reads through everywhere.
    const coarse = n3(p, 0.26, 37, 4), middle = n3(p, 0.85, 43, 5), grain = n3(p, 2.8, 47, 3);
    const reach = clamp(m * (0.55 + 1.05 * coarse));
    const torn = clamp((reach - 0.40 + (middle - 0.5) * 0.85) * 2.4);
    if (torn > 0) {
      const deep = clamp((torn - 0.46) * 1.9) * (0.65 + 0.60 * grain);
      c = W.mix(c, W.times(BLOOD2, 0.75 + 0.55 * grain), clamp(torn) * 0.92);
      c = W.mix(c, BLOOD, clamp(deep) * 0.72);                           // still wet in the thick of it
      c = W.times(c, 1 - 0.34 * clamp(torn - 0.5));                      // and darker where it pooled
    }
    // thin runs continuing below the main stain, following the weave down
    const run = clamp((n3(p, 2.2, 41, 3) - 0.50) * 8) * clamp((reach + 0.34) * 1.6) * clamp((Z.chest - z) / 16);
    c = W.mix(c, W.times(BLOOD2, 0.75), run * 0.75);
  }
  return c;
}, { pose: POSE, only: ["merc_512_black.bmp"] });

// ── the mask, painted on the head's own sheet ──────────────────────────────
// head.bmp is a FACE-ON PROJECTION: the face sits in the middle of the sheet, the
// sides of the head run off to its edges, the crown is along the top and the neck
// along the bottom. The map from a height on the body to a row on that sheet is not
// linear, so a feature placed by model z lands nowhere near where it was meant to --
// which is exactly what happened. The mask's three features are placed in PIXELS,
// read off the uv render, and the body keeps the by-position rule.
const H = K.textureOf(mdl, "head.bmp");
const HS = W.sheet(H.width, H.height, HOOD);
const CX = H.width * 0.5;
const BROW_PX = { x: CX, y: H.height * 0.20, r: H.width * 0.052 };
const GRILLE  = { x: CX, y: H.height * 0.345, w: H.width * 0.140, h: H.height * 0.080 };
const FILT_PX = { x: CX, y: H.height * 0.570, r: H.width * 0.108 };

HS.zone({ x: 0, y: 0, w: H.width, h: H.height }, (u, v) => {
  const n = W.fbm(u / 7, v / 7, 3, 6), fine = W.fbm(u / 2.4, v / 2.4, 9, 4);

  // the hood: rough rubberised leather, darker towards the neck
  let c = W.times(HOOD, 0.55 + 0.95 * n + 0.22 * fine);
  c = W.times(c, 1 - 0.25 * clamp((v - H.height * 0.72) / (H.height * 0.3)));
  const rust = clamp((W.fbm(u / 11 + 5, v / 11, 2, 5) - 0.56) * 5);
  c = W.mix(c, W.times(RUST, 0.7 + 0.6 * fine), rust * 0.35);

  // the grille over the eyes: a sunken rusty rectangle, barred across
  const inG = Math.max(Math.abs(u - GRILLE.x) / GRILLE.w, Math.abs(v - GRILLE.y) / GRILLE.h);
  if (inG < 1.25) {
    const bar = 0.5 + 0.5 * Math.cos((v - GRILLE.y) * 2.6);
    const mesh = W.mix(W.times(RUST, 0.40), W.times(RUST, 1.05), bar * (0.6 + 0.5 * fine));
    c = W.mix(c, W.times(mesh, 0.70 + 0.5 * n), clamp((1 - inG) * 4) * 0.95);
    c = W.mix(c, W.times(RUBBER, 0.7), W.bell(inG - 1.06, 0.10) * 0.9);
  }

  // the port high on the brow: a pale disc seated in dark rubber
  const br = Math.hypot(u - BROW_PX.x, (v - BROW_PX.y) * 1.05) / BROW_PX.r;
  if (br < 1.5) {
    let disc = W.times([0.80, 0.78, 0.72], 0.70 + 0.32 * Math.cos(br * 4.2) + 0.25 * fine);
    disc = W.mix(disc, W.times(RUST, 1.1), clamp((W.fbm(u / 3, v / 3, 7, 4) - 0.5) * 3) * 0.5);
    c = W.mix(c, disc, clamp((0.78 - br) * 5));
    c = W.mix(c, W.times(RUBBER, 0.55), W.bell(br - 0.92, 0.17) * 0.95);
  }

  // the filter over the mouth: a big pale canister, turned in rings
  const fr = Math.hypot(u - FILT_PX.x, (v - FILT_PX.y) * 1.02) / FILT_PX.r;
  if (fr < 1.45) {
    const rings = 0.60 + 0.40 * Math.abs(Math.cos(fr * 9.0));
    let face = W.times([0.76, 0.75, 0.70], rings * (0.78 + 0.34 * fine));
    face = W.mix(face, [0.26, 0.24, 0.21], clamp(1 - fr / 0.30) * 0.8);          // its dark mouth
    face = W.mix(face, W.times(RUST, 0.9), clamp((W.fbm(u / 4 + 9, v / 4, 6, 5) - 0.52) * 5) * 0.45);
    c = W.mix(c, face, clamp((0.95 - fr) * 6));
    c = W.mix(c, W.times(RUBBER, 0.6), W.bell(fr - 1.06, 0.13) * 0.95);          // the rubber collar
  }

  // the seam from the grille down past the filter to the throat
  const seam = W.bell(u - CX, 2.6) * clamp((v - GRILLE.y) / 14) * clamp((H.height * 0.92 - v) / 20);
  if (fr > 1.1) c = W.times(c, 1 - 0.40 * seam);

  const dirt = clamp((W.fbm(u / 9 + 13, v / 9, 4, 6) - 0.46) * 4) * clamp(v / H.height + 0.15);
  return W.mix(c, GRIME, dirt * 0.45);
});

const masked = K.replaceTexture(mdl, "head.bmp", {
  ...K.indexed(HS.image(), "head.bmp"), name: "head.bmp", flags: H.flags,
});

// ── out ────────────────────────────────────────────────────────────────────
for (const [t, s] of Object.entries(shared)) {
  console.log(`  ${t}: ${(s * 100).toFixed(0)}% of its pixels are worn by two places at once`);
}

mkdirSync(join(OUT, "ins_medic"), { recursive: true });
writeFileSync(join(OUT, "ins_medic", "ins_medic.mdl"), checked("hazmat", texturesLast(masked)));
console.log(`  wrote export-mdl/ins_medic/ins_medic.mdl`);

const put = (name, img) => { writeFileSync(join(OUT, name), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${name}`); };

put("preview.png", lineup([["merc (from)", src], ["hazmat", masked]], { yaws: [0, 180], zoom: 1.5, width: 340, cols: 4 }));
put("preview_sheet.png", K.sheet(masked, { ...POSE, size: 400 }));

// The renderer frames on the whole body, so the mask is small in every view. The painted
// sheets show it at full size instead.
const tree = K.readMdl(masked);
for (let i = 0; i < tree.textures.length; i++) {
  const t = K.textureOf(masked, i);
  put(`texture_${t.name.replace(/\.bmp$/i, "")}.png`, { width: t.width, height: t.height, rgba: K.rgbaOf(t) });
}
