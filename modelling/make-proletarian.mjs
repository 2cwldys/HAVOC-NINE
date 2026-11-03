// proletarian: a bald, mottled labourer in a worn navy work shirt.
//
//     node make-proletarian.mjs    -> ../export-mdl/proletarian/proletarian.mdl
//
// Built on `agent`, the Matrix model. It is a good donor for this: one bodypart, the
// same 171 animations as every other TS player model, and both its textures powers of
// two (512 and 256) so GoldSrc does not stretch them on load.
//
// It also has a full head of black hair painted across its crown, sides and the back of
// its skull, and that is the whole difficulty of the job.
//
// HOW THE HEAD IS COLOURED, AND WHY IT IS DONE THIS WAY
//
// The head's colour is GENERATED, from position and surface normal. The donor's head
// texture is never the source of it.
//
// The obvious approach is to recolour the donor's own art and convert the hair as you
// go. It does not work, and it fails in a way that wastes a great deal of time, because
// every way of saying "this texel is hair" is wrong:
//
//   - by brightness: the hair's highlights across the sides and back reach a luminance
//     of 0.80, which is brighter than much of his face. No threshold separates them.
//   - by brightness and hue together: the hair carries a brown tint, so it passes a
//     "dark and colourless" test and is painted as dark skin instead.
//   - by region: converting a marked-off region and keeping the donor elsewhere leaves
//     two areas coloured by different rules, and the join between those rules is itself
//     a hairline. Darker than the face and it reads as hair, lighter and it reads as
//     blond hair. Matching the two rules more carefully never closes it.
//
// Generating the whole head removes the question. There is no hair to find, no boundary
// to match and no second rule to join to. What the donor is still used for is his
// FEATURES -- eyes, nostrils, the line of his mouth -- taken as local darkness on the
// front of his face only, where the donor has no hair at all and never had.
//
// Axes on this donor: +x is his FRONT, +y is his LEFT, +z is up. Taken from the donor
// itself, since its lenses sit at x 9.3..10 and its earpiece behind the ear at x 4..4.9.
// The facing belongs to the donor and not to the skeleton: the XCCP family faces -x.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, checked, clamp, texturesLast, POSE } from "./lib.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const base = load("agent");

// ── 1. cut the sunglasses and the earpiece ─────────────────────────────────
// These are GEOMETRY on this donor, not paint, so no amount of texture work removes
// them. Found by where they are rather than by a hard-coded piece number: the numbering
// comes out of a flood fill over the triangles and a re-export renumbers it, after
// which a fixed list quietly cuts fifty triangles out of a face instead.
const P = K.pieces(base, POSE);
const within = (q, b) => q.mn[0] >= b[0] && q.mx[0] <= b[1] &&
                         q.mn[1] >= b[2] && q.mx[1] <= b[3] &&
                         q.mn[2] >= b[4] && q.mx[2] <= b[5];
const SHADES = [4.8, 10.2, -2.7, 3.3, 30.9, 32.3];      // arms, bridge and both lenses
const CORD = [3.8, 5.1, -2.9, -1.9, 26.8, 31.4];        // the coiled wire behind his ear

const cut = P.list.filter((q) => within(q, SHADES) || within(q, CORD));
if (cut.length !== 6) {
  throw new Error(`expected 6 pieces to cut, found ${cut.length}: ${cut.map((q) => `${q.id}(${q.tris})`).join(" ")}`);
}
const ids = cut.map((q) => q.id);
console.log(`  cut ${ids.length} pieces, ${cut.reduce((a, q) => a + q.tris, 0)} triangles: the shades and the earpiece`);
const { mdl: trimmed } = K.dropTriangles(base, (t) => ids.includes(P.of(t)), POSE);

// ── the palette ────────────────────────────────────────────────────────────
// Read off the reference: a warm tan gone dirty, blotched to almost black; a navy shirt
// that is blue-violet rather than true blue; trousers a shade darker and greyer.
const SKIN = [0.690, 0.512, 0.360], SKIN_LO = [0.248, 0.162, 0.108];
const BLOT = [0.098, 0.064, 0.046], BLOT_MID = [0.196, 0.126, 0.086];

const SHIRT = [0.248, 0.262, 0.360], SHIRT_LO = [0.102, 0.112, 0.166], SHIRT_HI = [0.405, 0.420, 0.505];
const TROUS = [0.166, 0.170, 0.190], TROUS_LO = [0.070, 0.072, 0.084];
const BOOT = [0.104, 0.092, 0.082];
const GREASE = [0.085, 0.073, 0.058];

// Set per build: the clean model and the dirty one differ only by this flag.
let dirty = false;

/*
 * healthy leaves HIS SKIN ENTIRELY ALONE, so only the clothes are this model's.
 *
 * The proletarian's face is generated from position and normal rather than sampled from
 * the donor, which is what makes him bald and mottled and sunburnt. Set this and that
 * whole pass is skipped: every skin texel is returned untouched, so the face, the scalp
 * and the hands are the agent's own, and the only thing that has changed from the donor
 * is what he is wearing.
 *
 * It is a separate flag from `dirty` because the two are independent -- healthy skin
 * under a clean shirt is the variant that was asked for, but nothing stops the pair
 * being combined later.
 */
let healthy = false;

const lum = (c) => c[0] * 0.30 + c[1] * 0.60 + c[2] * 0.10;
const warm = (c) => c[0] - c[2];

// fbm3 takes a POINT ARRAY, not three numbers. Three numbers leave p[1] and p[2]
// undefined, every channel comes out NaN, and Math.round writes it as 0 -- a texture
// of pure black, with nothing in the output to say why.
const n3 = (p, k, s, oct = 4) => W.fbm3(p, k, s, oct);

// Light from above and a little in front.
const LIGHT = [0.34, 0.16, 0.93];
const lit = (n) => clamp(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);

// ── 2. the skin ────────────────────────────────────────────────────────────
// Tone comes from the surface normal and NOTHING ELSE, over the whole head and the
// hands alike. One rule everywhere is the point of it: with a single source there is no
// boundary anywhere on him for a hairline to live on.
//
// Its range is narrow on purpose. The donor's own face is painted with flat light, so
// a scalp shaded hard from the normal would stand out against the features composited
// into it further down.
const tone = (n) => 0.60 + 0.26 * lit(n);

// Blotching, in two sizes. CALIBRATED TO WHAT fbm3 ACTUALLY RETURNS, which is nothing
// like 0..1 and shifts with k: measured over this head it runs about 0.28..0.76 at low
// k and 0.16..0.81 at high, with the quartiles near 0.43 and 0.56 either way.
// Thresholds chosen for a 0..1 range sit outside the distribution almost everywhere and
// produce no mottling at all. Each cut below sits on its own median.
//
// The ramps are wide. A narrow cut welds neighbouring specks into solid blobs with hard
// sides, and the result reads as digital camouflage rather than as damaged skin -- and
// it makes this donor's UV mirroring obvious, since a high-contrast pattern repeated
// across the back of a skull is plainly a repeat while a soft one is not.
const blotch = (p) => clamp(
  clamp((n3(p, 3.4, 29, 3) - 0.472) / 0.105) * 0.74 +
  clamp((n3(p, 7.2, 53, 2) - 0.498) / 0.080) * 0.40,
);

// Where it gathers. Deliberately almost flat: concentrating it over the crown draws a
// dark cap with an edge, and a dark cap with an edge on a bald head is read as hair.
const spread = (p) => {
  const y = Math.abs(p[1]);
  let d = 0.74;
  d += 0.12 * W.step(1.4, 3.2, y);                                  // out towards the ears
  d -= 0.24 * W.step(7.6, 9.4, p[0]) * W.step(3.0, 1.0, y);         // clear down nose and cheek
  return clamp(d, 0, 1.1);
};

// His features, and the only thing the donor's head texture is read for.
//
// Taken as LOCAL DARKNESS on the front of his face, where the donor is all skin and
// never had any hair: his eyes, his nostrils, the line of his mouth and the shadow
// under his lip are all much darker than the 0.64 his face sits at. Nowhere near his
// crown, his temples or the back of his head, so no hair can arrive with them.
const facing = (p) => W.step(7.2, 8.5, p[0]) * W.step(33.0, 32.2, p[2]);
const feature = (rgb) => clamp((0.50 - lum(rgb)) / 0.30);

const skin = ({ p, n, rgb }) => {
  const t = tone(n);
  let c = W.mix(SKIN_LO, SKIN, t);

  const b = clamp(blotch(p) * spread(p));
  c = W.mix(c, W.times(BLOT_MID, 0.58 + 0.72 * t), b * 0.86);
  c = W.mix(c, W.times(BLOT, 0.48 + 0.66 * t), clamp((b - 0.58) * 2.2) * 0.72);

  // and his face put back over the top
  const f = feature(rgb) * facing(p);
  if (f > 0) c = W.mix(c, W.times(c, 0.22), f * 0.92);
  return c;
};

// ── 3. the clothes, painted by where they are on him ───────────────────────
// The donor's art here is a black suit with lapels, a white shirt and a tie, and none
// of that survives. Its FOLDS do: the luminance painted into the cloth is the only
// record of how this mesh creases, so it is stretched back out rather than discarded.
const TORSO = [2.3, 0];
const Z_HEM = 0.8, Z_COLLAR = 24.8, Z_COLLAR_TOP = 28.4, Z_BOOT = -33.2;

const weave = (p) => {
  // Coarse woven cloth: a vertical rib with the weft crossing it. The rib is counted
  // ROUND him rather than across him, so it does not smear where the torso turns away.
  const a = Math.atan2(p[1] - TORSO[1], p[0] - TORSO[0]);
  const rib = 0.5 + 0.5 * Math.sin(a * 44 + 0.4);
  const weft = 0.5 + 0.5 * Math.sin(p[2] * 7.4);
  return (rib * 0.72 + weft * 0.28) * clamp(1 - Math.abs(p[2] - 14) / 34);
};

const cloth = ({ p, n, rgb }) => {
  // The suit is DARK -- half its texels under 0.075 and nine in ten under 0.171 -- so
  // its creases live in a narrow band just above black and have to be stretched out of
  // it. Above 0.33 is not a crease but the donor's WHITE SHIRT and collar, which run to
  // 1.0; passed through as brightness it paints a white band across his throat, so it
  // is flattened to ordinary cloth instead.
  const raw = lum(rgb);
  const fold = raw > 0.33 ? 0.55 : clamp((raw - 0.03) / 0.17);
  const t = clamp(0.10 + 0.55 * fold + 0.50 * (lit(n) - 0.10));
  const grime = clamp((n3(p, 0.30, 53, 4) - 0.520) / 0.085);

  if (p[2] < Z_BOOT) {
    const c = W.mix(W.times(BOOT, 0.45), BOOT, t);
    return W.mix(c, [0.045, 0.040, 0.036], clamp((n3(p, 0.9, 61, 3) - 0.50) * 3) * 0.5);
  }

  if (p[2] < Z_HEM) {
    let c = W.mix(TROUS_LO, TROUS, t);
    const knee = clamp(1 - Math.abs(p[2] + 13) / 5) * clamp(p[0] / 6);
    c = W.mix(c, W.times(TROUS, 1.55), knee * 0.30 * clamp(grime + 0.4));
    return W.mix(c, GREASE, grime * 0.34 * clamp(0.45 + (Z_HEM - p[2]) / 26));
  }

  let c = W.mix(SHIRT_LO, SHIRT, clamp(t * 1.2));
  if (t > 0.74) c = W.mix(c, SHIRT_HI, clamp((t - 0.74) * 2.2));
  c = W.times(c, 0.885 + 0.205 * weave(p));

  const front = p[0] > TORSO[0] + 1.6, mid = Math.abs(p[1] - TORSO[1]);

  // the centre placket, a doubled strip of cloth, and its buttons
  if (front && mid < 1.05) {
    c = W.times(c, 1.13);
    if (mid < 0.30) c = W.times(c, 0.80);
    for (const bz of [23.0, 19.3, 15.6, 11.9, 8.2, 4.5]) {
      const d = Math.hypot((p[2] - bz) / 0.46, mid / 0.42);
      if (d < 1) c = W.mix([0.055, 0.050, 0.058], c, clamp(d * 0.55));
    }
  }

  // Two chest pockets. The reference shows one, but suit.bmp is 17% mirrored, so a
  // single pocket painted by position comes out as a pair whatever is intended -- and a
  // pair is what a work shirt usually has anyway.
  if (front && mid > 1.9 && mid < 5.7 && p[2] > 13.2 && p[2] < 19.8) {
    const edge = Math.min(mid - 1.9, 5.7 - mid, p[2] - 13.2, 19.8 - p[2]);
    c = W.times(c, edge < 0.34 ? 0.74 : 1.05);
    if (p[2] > 19.0) c = W.times(c, 0.86);
  }

  // the collar, standing at the neck and open at the throat
  if (p[2] > Z_COLLAR) {
    const up = clamp((p[2] - Z_COLLAR) / (Z_COLLAR_TOP - Z_COLLAR));
    c = W.times(c, 1.0 + 0.22 * up);
    if (front && mid < 1.9 && up > 0.45) c = W.times(c, 0.62);
  }

  // worn pale where it rubs, then grease and dirt last
  const elbow = clamp(1 - Math.abs(p[2] - 9) / 4) * clamp((Math.abs(p[1]) - 7.5) / 2.5);
  const shoulder = clamp((p[2] - 20) / 5) * clamp((Math.abs(p[1]) - 4.5) / 3.5);
  c = W.mix(c, SHIRT_HI, clamp(elbow + shoulder * 0.7) * 0.34 * clamp(0.35 + grime));
  const low = clamp(1 - (p[2] - Z_HEM) / 9) * 0.8 + clamp((Math.abs(p[1]) - 7.8) / 3) * 0.7;
  c = W.mix(c, GREASE, grime * 0.30 * clamp(0.30 + low));

  return dirty ? filthy(p, c) : c;
};

// ── the dirty variant ──────────────────────────────────────────────────────
// A second coat, over the clean one, for proletarian_dirty. Everything above runs
// exactly as it does for the clean model, so that one comes out byte for byte the same
// -- the only difference between the two files is what this function adds.
//
// It is laid out by where a working man actually gets filthy rather than by noise
// alone, which is the difference between a dirty shirt and a shirt someone has spilled
// noise on: hands are wiped down the front of the thighs, machinery is leaned into with
// the belly, cuffs drag through everything, and dust climbs the legs from the floor.
const OIL = [0.052, 0.046, 0.038];          // near black, faintly warm
const DUST = [0.315, 0.272, 0.212];         // pale, dry, settles low
const RUSTY = [0.168, 0.092, 0.052];        // the brown of old iron, in streaks

function filthy(p, c) {
  const y = Math.abs(p[1]), front = clamp((p[0] - 2.4) / 3.2);

  // Hands wiped down the front of the thighs, over and over, in streaks that run with
  // the leg rather than across it.
  const thigh = clamp(1 - Math.abs(p[2] + 7) / 11) * front;
  const streak = clamp((W.fbm(p[1] * 1.9, p[2] * 0.24, 91, 4) - 0.44) / 0.14);
  c = W.mix(c, OIL, thigh * streak * 0.72);

  // The belly and the lower front of the shirt, from leaning on things.
  const belly = clamp(1 - Math.abs(p[2] - 7) / 8) * front;
  c = W.mix(c, OIL, belly * clamp((n3(p, 0.62, 97, 4) - 0.48) / 0.095) * 0.58);

  // Cuffs and the ends of the sleeves, which drag through all of it.
  const cuff = clamp((y - 8.2) / 2.2) * clamp(1 - Math.abs(p[2] - 1.5) / 7);
  c = W.mix(c, OIL, cuff * clamp((n3(p, 1.3, 101, 3) - 0.47) / 0.12) * 0.62);

  // Oil caught in splashes -- on his FRONT and around chest height, where something
  // being worked on would actually throw it. Spattered evenly over the whole garment,
  // back and shoulders included, it stops reading as oil and starts reading as confetti.
  const caught = front * clamp(1 - Math.abs(p[2] - 6) / 16);
  c = W.mix(c, OIL, caught * clamp((n3(p, 2.3, 103, 2) - 0.610) / 0.045) * 0.66);

  // Rust and old iron smeared where he carries things: forearms, hip, shoulder.
  const carry = Math.max(clamp((y - 7.0) / 3.0) * clamp(1 - Math.abs(p[2] - 4) / 9),
                         clamp((p[2] - 19) / 6) * clamp((y - 4.0) / 4.0));
  c = W.mix(c, RUSTY, carry * clamp((n3(p, 0.95, 107, 3) - 0.525) / 0.070) * 0.40);

  // Dust off the floor, climbing the legs and heaviest at the hem.
  const up = clamp(1 - (p[2] + 33) / 26);
  c = W.mix(c, DUST, up * clamp((n3(p, 1.1, 109, 3) - 0.470) / 0.120) * 0.52);

  return c;
}

// ── 4. paint ───────────────────────────────────────────────────────────────
// The hands live on suit.bmp beside the shoes, so they are picked out by being WARM
// rather than by a box: the suit is black and grey with r and b within a hair of each
// other, and nothing else on that sheet is skin.
function build(name) {
  // Returning null leaves a texel exactly as the donor had it, which is how `healthy`
  // keeps the agent's own face and hands while the cloth is still repainted.
  const { mdl: painted } = K.paint(trimmed, (t) => (
    t.tex === "agentface.bmp" || warm(t.rgb) > 0.10
      ? (healthy ? null : skin(t))
      : cloth(t)
  ), { pose: POSE });

  // texturesLast is not optional. dropTriangles rewrites the meshes and paint appends a
  // replacement for every texture, which leaves geometry sitting after the texture block
  // -- and a GoldSrc model whose textures are not last draws as NOTHING, silently, with
  // check() reporting no errors at all.
  const mdl = texturesLast(painted);

  mkdirSync(join(OUT, name), { recursive: true });
  writeFileSync(join(OUT, name, `${name}.mdl`), checked(name, mdl));
  console.log(`  wrote export-mdl/${name}/${name}.mdl`);
  return mdl;
}

// `dirty` gates the second coat and nothing else, so this one is unchanged by its
// existence -- it is the same file it was before the variant was added.
dirty = false;
const out = build("proletarian");
dirty = true;
const grubby = build("proletarian_dirty");

// The same clothes on a man who has not been weathered: the agent's face and hands,
// untouched, under the proletarian's shirt and trousers.
dirty = false;
healthy = true;
const well = build("proletarian_healthy");
healthy = false;

const r = K.check(out, "goldsrc");
console.log(`  ${r.facts ? r.facts.join("\n  ") : ""}`);

const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };
put("proletarian_preview.png", K.lineup([["proletarian", out], ["proletarian_dirty", grubby], ["proletarian_healthy", well]], { ...POSE, yaws: [40, 140, 230], zoom: 1.5, width: 320, cols: 6 }));

// The head, close, from six sides. Two of them look DOWN on him, because the crown is
// where the donor's hair was and is the one place a hairline can hide from a preview.
const shots = [], names = [];
for (const [label, m] of [["proletarian", out], ["proletarian_dirty", grubby], ["proletarian_healthy", well]]) {
  for (const [yaw, pitch] of [[0, 4], [55, 4], [125, 4], [180, 4], [25, 52], [160, 52]]) {
    shots.push(K.render(m, { ...POSE, yaw, pitch, zoom: 7.2, target: [0, 0, 31.5], width: 240, height: 280 }));
    names.push(yaw === 0 ? label : "");
  }
}
put("proletarian_face.png", K.tile(shots, 6, names));
for (const [nm, m] of [["proletarian", out], ["proletarian_dirty", grubby]]) {
  for (const t of K.readMdl(m).textures) {
    const tex = K.textureOf(m, t.name);
    put(`${nm}_${t.name.replace(".bmp", "")}.png`, { width: tex.width, height: tex.height, rgba: K.rgbaOf(tex) });
  }
}
