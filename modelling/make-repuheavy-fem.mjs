// Female repuheavy: the armour taken in, and two helmetless versions with a real head.
//
//     node make-repuheavy-fem.mjs
//
// WHAT THIS CAN AND CANNOT DO, said plainly because it sets what to expect.
//
// repuheavy's bulk is ARMOUR, not body. Measured against the two female models that
// share its skeleton, it is a slab -- 7.7 to 7.9 half-width at every band and 14 to 15.6
// deep throughout -- where female_merc narrows to 5.1 at the shoulder and is barely half
// as deep at the waist. Armour cannot shrink to bare-body proportions, so the reshape
// below aims at a believable armoured figure and not at those numbers. Helmeted, it is
// likely to read as a slimmer soldier rather than as a woman; the helmet hides the one
// cue that is unambiguous. The two helmetless builds are there to compare against.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, load, clamp, POSE } from "./lib.mjs";
const { isEngineLayout } = await import("file:///D:/Downloads/TSM/smak/src/layout.mjs");

const OUT = join(process.cwd(), "..", "export-mdl");
const base = load("repuheavy");
const md = K.readMdl(base);
const names = K.bones(base).map((b) => b.name);
const P = K.poseAt(base, POSE.seq, POSE.frame);

const INV = new Map();
const inv = (b) => {
  if (!INV.has(b)) INV.set(b, K.inverse34(P[b]));
  return INV.get(b);
};

const AXIS_Y = 0.3;    // the body's own centre line, measured off this donor
const AXIS_X = 2.5;

/*
 * The taper, by height.
 *
 * Read between the bands rather than stepped: a step would shear the plates straight
 * across wherever two bands met, and on a figure made of hard panels that reads as a
 * broken model rather than as a shape.
 *
 * `across` works on y and `depth` on x, both relative to the body's own axis.
 */
const BANDS = [
  { z: -36, across: 0.95, depth: 0.97 },   // feet: so the stance does not end abruptly
  { z:   0, across: 1.03, depth: 1.00 },   // hips, very slightly out
  { z:   6, across: 1.03, depth: 1.00 },
  { z:  12, across: 0.86, depth: 0.90 },   // the waist nip that makes the hips read
  { z:  20, across: 0.92, depth: 0.96 },   // chest: a taper, not a shape, under plate
  { z:  26, across: 0.86, depth: 0.94 },   // shoulders: the clearest single cue
  { z:  40, across: 0.86, depth: 0.94 },
];

function taperAt(z) {
  if (z <= BANDS[0].z) return BANDS[0];
  if (z >= BANDS[BANDS.length - 1].z) return BANDS[BANDS.length - 1];
  for (let i = 0; i + 1 < BANDS.length; i++) {
    const a = BANDS[i], b = BANDS[i + 1];
    if (z >= a.z && z <= b.z) {
      const t = (z - a.z) / (b.z - a.z);
      return {
        across: a.across + (b.across - a.across) * t,
        depth: a.depth + (b.depth - a.depth) * t,
      };
    }
  }
  return BANDS[0];
}

/*
 * THE ARMS ARE LEFT ALONE.
 *
 * They hang outside the trunk, so scaling them towards the body axis pulls them INTO
 * it -- the taper that nips a waist drags a forearm through the hip. Anything far enough
 * out to be an arm keeps its position, and the two are blended across so the shoulder
 * does not tear away from the sleeve.
 */
const ARM_IN = 7.0, ARM_OUT = 9.5;

const move = (p, boneName) => {
  const b = names.indexOf(boneName);
  if (b < 0) return p;

  const w = K.apply34(P[b], p);
  const dy = w[1] - AXIS_Y, dx = w[0] - AXIS_X;
  const out = Math.hypot(dy, dx);

  // 1 on the trunk, falling to 0 out where the arms hang.
  const trunk = 1 - clamp((out - ARM_IN) / (ARM_OUT - ARM_IN));
  if (trunk <= 0) return p;

  const t = taperAt(w[2]);
  const ay = 1 + (t.across - 1) * trunk;
  const ax = 1 + (t.depth - 1) * trunk;

  return K.apply34(inv(b), [AXIS_X + dx * ax, AXIS_Y + dy * ay, w[2]]);
};

/*
 * The reshape itself.
 *
 * SMAK has no vertex transform: the only thing that moves points is graft's `move`. So
 * the body is stripped to a shell and grafted back onto itself through it.
 *
 * ONE GRAFT PER BODYPART, into that bodypart's own submodel. Grafting the lot into one
 * submodel is the obvious way and it is wrong: all 3310 triangles land together, 3161
 * vertices against the 2048 GoldSrc allows, and the model is refused. Per bodypart the
 * distribution is kept exactly as the donor had it.
 *
 * Textures and UVs ride along with their meshes, so carryPicture is not needed -- each
 * mesh keeps its own picture and only the points have moved.
 */
function reshape(src) {
  const { mdl: shell } = K.dropTriangles(src, () => true, POSE);
  let out = shell;
  K.readMdl(src).bodyparts.forEach((bp, bi) => {
    // pick is handed the bodypart OBJECT, not its index. Comparing it to a number is
    // always false, which grafts nothing and leaves a model of 27 meshes and no
    // triangles -- one that passes check, reports the right vertex counts and draws
    // absolutely nothing. Matched by name instead, since graft reads its own copy of
    // the source and the objects are not the same ones.
    out = K.graft(out, src,
      (mesh, model, bodypart) => bodypart.name === bp.name,
      { bodypart: bi, model: 0 }, move, { missing: "ancestor" });
  });
  return out;
}

// ── the helmet, and the heads that replace it ──────────────────────────────
const HELMET_TEX = new Set([
  "00736CF9.bmp", "003C88FE.bmp", "00736CE7.bmp", "002C5D1F.bmp", "00736CEB.bmp",
  "00A14167.bmp", "00DF556C.bmp", "003C88F8.bmp", "001A6AC6.bmp", "00736CF1.bmp",
]);

/** Each head is one texture of its own donor, so selecting it is a texture test. */
const HEADS = [
  { from: "TPS_Masked_Female", as: "repuheavy_fem_mask" },
  { from: "lady",              as: "repuheavy_fem_lady" },
];

/*
 * The head, selected BY HEIGHT rather than by texture.
 *
 * Texture was the obvious choice and is wrong for these donors. agent and laurence each
 * keep their face on a sheet of its own, so a texture test found it exactly; these two
 * do not. TPS_Masked_Female spreads its head across four sheets -- mask, face, hair and
 * a body sheet -- so a texture test misses parts of it, and lady keeps head and body
 * together on lady1a.bmp, so a texture test drags her torso across with it. That is what
 * put 630 triangles into a submodel and took it to 2154 of the 2048 GoldSrc allows.
 *
 * Cutting by height takes the head and nothing else from either, whatever sheets it is
 * spread over. 28.5 keeps the jaw: repuheavy's armoured collar reaches 29.8, so a little
 * neck below the cut is hidden inside it rather than showing.
 */
const HEAD_Z = 28.5;

function headOnly(donor) {
  let kept = 0;
  const { mdl } = K.dropTriangles(donor, (t) => {
    if (t.mid[2] >= HEAD_Z) { kept++; return false; }
    return true;
  }, POSE);
  return { mdl, kept };
}

/*
 * Which submodel the head goes into: whichever has the most room.
 *
 * Every bodypart is drawn at once, so where a head lives makes no visual difference --
 * but tengu2 already carries 935 vertices of armour and will not take a head of several
 * hundred triangles, while glasses_Ref holds sixteen and has the whole budget free.
 * Choosing by headroom rather than defaulting to bodypart 0 is what keeps this inside
 * the limit.
 */
function roomiest(mdl) {
  let best = { bodypart: 0, model: 0 }, most = -1;
  K.readMdl(mdl).bodyparts.forEach((bp, bi) => {
    bp.models.forEach((mo, mi) => {
      const room = 2048 - Math.max(mo.numverts, mo.numnorms);
      if (room > most) { most = room; best = { bodypart: bi, model: mi }; }
    });
  });
  return { where: best, room: most };
}

const check = (name, mdl) => {
  const r = K.check(mdl, "goldsrc");
  const lay = isEngineLayout(mdl);
  const m = K.readMdl(mdl);
  const per = m.bodyparts.flatMap((bp) => bp.models.map((mo) => `${mo.numverts}/${mo.numnorms}`)).join("  ");

  /*
   * TRIANGLES ARE COUNTED, not just vertices.
   *
   * A model can carry its meshes and its vertex counts and still hold no triangles at
   * all: it passes check, reports the right numbers and draws nothing. That is exactly
   * what a graft whose pick never matched produced here, and nothing else noticed.
   */
  let tris = 0;
  for (const bp of m.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) tris += me.numtris;
  if (tris < 1) {
    throw new Error(`${name} has ${tris} triangles: it would draw nothing`);
  }
  console.log(`  ${name.padEnd(20)} ${per.padEnd(30)} ${String(tris).padStart(4)} tris  check ${r.errors?.length ?? 0} errors  engineLayout ${lay}`);
  for (const e of (r.errors ?? [])) console.log("      ERROR: " + e);
  if (r.errors?.length) throw new Error(`${name} did not come out sound`);
  if (!lay) throw new Error(`${name} is not in engine layout`);
  if (name.length > 22) throw new Error(`${name} is ${name.length} characters: TS truncates at 22`);
  mkdirSync(join(OUT, name), { recursive: true });
  writeFileSync(join(OUT, name, `${name}.mdl`), mdl);
  return mdl;
};

console.log("  donor per-submodel verts/norms, for comparison:");
console.log("    " + md.bodyparts.flatMap((bp) => bp.models.map((mo) => `${mo.numverts}/${mo.numnorms}`)).join("  "));

const made = [];
made.push(["repuheavy_fem", check("repuheavy_fem", reshape(base))]);

for (const h of HEADS) {
  const donor = load(h.from);
  const { mdl: headDonor, kept } = headOnly(donor);

  let gone = 0;
  const { mdl: bare } = K.dropTriangles(base, (t) => {
    if (!HELMET_TEX.has(t.tex)) return false;
    gone++;
    return true;
  }, POSE);

  const { where, room } = roomiest(bare);
  const withHead = K.graft(
    bare, headDonor,
    () => true,
    where,
    undefined,
    { missing: "ancestor" },
  );

  console.log(`  ${h.as}: -${gone} helmet tris, +${kept} head tris from ${h.from} `
    + `into bodypart ${where.bodypart} (${room} spare)`);
  made.push([h.as, check(h.as, reshape(withHead))]);
}

// ── look at them ───────────────────────────────────────────────────────────
const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };

// Beside the donor, front and back: the outline is the whole question, and an outline is
// judged against the one it is meant to differ from rather than on its own.
put("repuheavy_fem.png", K.lineup([["repuheavy", base], ...made],
  { ...POSE, yaws: [0, 180], zoom: 1.5, width: 280, cols: 8 }));

{
  const shots = [], labels = [];
  for (const [name, m] of [["repuheavy", base], ...made]) {
    shots.push(K.render(m, { ...POSE, yaw: 0, pitch: 6, zoom: 2.1, target: [0, 0, 6], width: 250, height: 420 }));
    labels.push(name.replace("repuheavy", "rh"));
  }
  put("repuheavy_fem_front.png", K.tile(shots, 4, labels));
}
{
  const shots = [], labels = [];
  for (const [name, m] of [["repuheavy", base], ...made]) {
    shots.push(K.render(m, { ...POSE, yaw: 55, pitch: 10, zoom: 3.2, target: [2, 0, 20], width: 250, height: 330 }));
    labels.push(name.replace("repuheavy", "rh") + " torso");
  }
  put("repuheavy_fem_torso.png", K.tile(shots, 4, labels));
}

// A run, because a reshaped body still rides the original skeleton and a taper that
// looks fine in a pose can pull a plate through an arm in motion.
put("repuheavy_fem_run.png", K.strip(made[0][1], { seq: "run2", count: 6, cols: 6, width: 260, height: 400, yaw: 200 }));
