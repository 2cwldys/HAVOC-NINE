// A female MSR trooper: female_merc's build, repuheavy's armour.
//
//     node make-repuheavy-fem-helm.mjs
//
// WHAT THIS IS, said plainly because it is not quite what the name suggests.
//
// Her SHAPE, his LOOK. repuheavy's armour is not reshaped to her -- that needs a vertex
// transform SMAK does not have, since graft's `move` and replaceMesh both APPEND points,
// and every route through the kit took his one submodel from 935 vertices to 2113 against
// the 2048 GoldSrc allows. Going the other way round costs nothing, so what moves across
// is the three things you can actually see:
//
//   * his HELMET, grafted whole, in place of her head
//   * his PAULDRONS, grafted whole, onto her shoulders
//   * his ARMOUR'S COLOUR, sampled off his surface and painted onto hers
//
// The two models wear one skeleton -- 22 bones, none missing either way, worst offset
// 0.020 at a foot -- so everything grafted lands where it sat on him with no fitting.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, clamp, POSE } from "./lib.mjs";
const { isEngineLayout } = await import("file:///D:/Downloads/TSM/smak/src/layout.mjs");

const OUT = join(process.cwd(), "..", "export-mdl");
const NAME = "repuheavy_fem";          // 13 characters; TS truncates the path at 22

const base = load("female_merc");
/*
 * THE DONOR IS THE VARIANT'S, NOT THE SCRIPT'S.
 *
 * This began as "female_merc wearing repuheavy", and the proletarian wants exactly the
 * same pipeline with a different man in it -- his surface sampled onto her, her arms
 * mirrored, her remappable sheet renamed, his stance copied. Making the donor a field of
 * the variant shares all of that by construction, where a second script would have been
 * a copy of nine hundred lines that stopped matching after the first correction.
 *
 * Cached because several variants share one: loading a 2MB model per variant is wasted.
 */
const DONORS = new Map();
function donorOf(name) {
  if (!DONORS.has(name)) {
    const mdl = load(name);
    DONORS.set(name, { mdl, md: K.readMdl(mdl), pose: K.poseAt(mdl, POSE.seq, POSE.frame) });
  }
  return DONORS.get(name);
}

/*
 * The helmet, by the ten textures only it wears. Taken by texture rather than by a box,
 * because the thing has a brow, a snout and a pair of vents, and any box tight enough to
 * miss the collar clips a corner off one of them.
 */
const HELMET_TEX = new Set([
  "00736CF9.bmp", "003C88FE.bmp", "00736CE7.bmp", "002C5D1F.bmp", "00736CEB.bmp",
  "00A14167.bmp", "00DF556C.bmp", "003C88F8.bmp", "001A6AC6.bmp", "00736CF1.bmp",
]);

/*
 * The pauldrons, as boxes on the two big body sheets they are painted on.
 *
 * Measured off him: the left plate is 44 triangles of 05.bmp about (1.44, 6.88, 26.53)
 * and the right 47 of 04.bmp about (1.97, -7.46, 26.22). They are NOT mirror images of
 * each other -- different counts, different extents -- which is why make-ins-proletarian
 * had to take one and reflect it to get a symmetric pair. Nothing of the sort is needed
 * here: she wears his skeleton, so his own pair goes across into his own positions, each
 * plate on its own shoulder, already symmetric because it already was on him.
 */
const PLATES = [
  { tex: "05.bmp", box: { x: [-3.6, 7.3], y: [3.6, 11.6], z: [24.0, 28.8] } },
  { tex: "04.bmp", box: { x: [-3.6, 7.3], y: [-11.9, -4.0], z: [23.6, 28.5] } },
];
/*
 * The shin plates -- which are what his blue "knee pads" actually are.
 *
 * Found by colour rather than by eye: of the 64 blue triangles on him, 44 are the
 * pauldrons and visor up at z 24..32 and the other 20 sit at z -23.9..-19.7 on 07.bmp,
 * across the front of both shins at x 2.1..5.6. There is nothing blue at the knee at all.
 *
 * Both legs come in one box, which is what is wanted: scaled about the centre line they
 * draw in together and stay a pair.
 */
const SHINS = { tex: "07.bmp", box: { x: [1.0, 7.0], y: [-11.0, 11.0], z: [-26.0, -18.0] } };
const SHIN_XSCALE = 0.95, SHIN_YSCALE = 0.92;

const inBox = (m, b) => m[0] >= b.x[0] && m[0] <= b.x[1]
  && m[1] >= b.y[0] && m[1] <= b.y[1]
  && m[2] >= b.z[0] && m[2] <= b.z[1];

/*
 * Her head, by texture AND by height, because neither alone is right.
 *
 * Measured off her: face.bmp is 197 triangles over z 27.30..34.79 and hair.bmp 99 over
 * z 29.77..37.85, and nothing else on the model uses either -- so those two sheets ARE
 * her head, and they go whole. But 2.bmp, her body sheet, reaches z 33.61: there is skull
 * geometry up there on the body texture, and a texture test leaves it inside the helmet
 * to poke through. The height cut takes that.
 *
 * 30.0 rather than lower on purpose. Everything kept below it stays as the NECK PLUG, and
 * the cut it leaves is an open ring you can see straight through if it gets anywhere near
 * daylight -- that is the bug reported on ins_prole_helm, where the wall behind the model
 * showed through its throat. The helmet's own skirt reaches down to z 24.06 and is wider
 * than her neck at every band (|y| to 5.31 against her 3.35), so a plug that stops at
 * 30.0 ends well inside it.
 */
const HEAD_Z = 30.0;
const HEAD_TEX = new Set(["face.bmp", "hair.bmp"]);

/*
 * Her braid, found as a connected piece rather than by a box.
 *
 * It is NOT on hair.bmp -- it is painted on 2.bmp, her body sheet, which is why taking
 * both head sheets left it hanging down her back under the helmet. pieces() groups
 * triangles that touch, so the braid is one group of its own and can go whole: on her
 * it runs z 15.8 to 33.8, barely 3 units across in y, and sits behind her. Nothing else
 * on that sheet is both that narrow and that tall.
 */
function braidPiece(src) {
  const found = K.pieces(src, POSE).list.filter((e) => e.tex === "2.bmp"
    && e.mx[1] - e.mn[1] <= 4.0           // narrow across
    && e.mx[2] - e.mn[2] >= 10.0          // and long down
    && e.mx[0] <= 2.5);                   // and behind her
  if (found.length !== 1) {
    throw new Error(`looking for her braid found ${found.length} pieces, not 1: `
      + found.map((e) => `#${e.id} ${e.tris} tris`).join(", "));
  }
  return found[0];
}

/*
 * ONE ARM MIRRORED ONTO THE OTHER, because she is not symmetric and he is.
 *
 * female_merc is built with a different sleeve on each arm: 320 triangles on her left
 * (SX, +y) against 358 on her right (DX, -y), and the two are different shapes, not the
 * same shape counted differently. That reads as a merc who dressed out of a bin, which is
 * what she is -- but armoured it reads as a fault, one shoulder swollen against the other.
 * It is geometry, so no amount of painting touches it.
 *
 * `MIRROR_FROM` is the arm that survives, and the other is built as its reflection: the
 * one on the LEFT of the renders, which is her own right, DX. Flip this to "SX" to keep
 * the other one instead -- that is the whole change, and nothing else needs touching.
 *
 * Done BEFORE the armour is painted on, which matters: the reflected arm reuses its
 * source's UVs, so both arms read the same pixels, and whatever is painted there is by
 * construction identical on the two of them. Mirroring afterwards would leave two arms
 * sampled at two different places on him and put the asymmetry straight back.
 */
const MIRROR_FROM_DEFAULT = "DX";

/*
 * WHICH ARM SURVIVES, and it is not the same answer for armour as for cloth.
 *
 * Measured on her, below and above the elbow:
 *
 *   DX   forearm 314 tris, upper arm  44   -- bare shoulder, CHUNKY BRACER on the forearm
 *   SX   forearm 228 tris, upper arm  92   -- sleeve over the shoulder, slim forearm
 *
 * Under repuheavy's armour the bracered one is right: it reads as a gauntlet, which is
 * what she is wearing. Under a suit jacket it is wrong -- it reads as a woman in a shirt
 * wearing bracers.
 */
const armFrom = (V) => V.mirrorFrom ?? MIRROR_FROM_DEFAULT;
const armTo = (V) => (armFrom(V) === "DX" ? "SX" : "DX");
/*
 * How gently the mirrored arm's own faces share normals.
 *
 * It is a mesh of its own, so it shares nothing with the body it is attached to and
 * brings a full set of normals with it. At 50 degrees that put the submodel at 2026 of
 * the 2048 GoldSrc allows -- legal, and twenty-two from a model that is refused. Her arm
 * is skin and cloth with no hard edges on it, so a wide angle costs nothing to look at
 * and buys back the room.
 */
const ARM_SMOOTH = 85;

/*
 * Wider still for the models carrying equipment, because they need the room.
 *
 * The mirrored arm is a mesh of its own and shares no normals with the body, so its
 * smoothing angle is the cheapest budget there is: widening it from 50 to 85 saved 148
 * normals on repuheavy_fem for no visible change. The geared insurgents came in 35 over
 * the 2048 GoldSrc allows, and this is what closes that without taking equipment off.
 *
 * 179 is fully smooth, which on a sleeve -- no hard edges to lose -- costs nothing to
 * look at, the same reason the gear itself is rebuilt at 179.
 */
const ARM_SMOOTH_WIDE = 179;


const ARM_BONES = (s) => [
  `Bip01 ${s} Clavicola`,
  `Bip01 ${s} Braccio superiore`,
  `Bip01 ${s} Avambraccio`,
  `Bip01 ${s} Mano`,
];

/*
 * The plug is painted down to shadow over its top band.
 *
 * Left as skin it reads as a bare throat inside a sealed helmet -- bright from the front
 * and much worse from below. Dark it reads as the inside of the collar, which is what is
 * actually there. Faded in rather than switched, so there is no line across her neck at
 * the height where the helmet starts to cover it.
 */
const SHADOW = [0.042, 0.039, 0.037];
const SHADOW_FROM = 27.2, SHADOW_FULL = 28.9;

// ===========================================================================
// HIS SURFACE, AS SOMETHING THAT CAN BE ASKED FOR A COLOUR AT A POINT
// ===========================================================================
/*
 * There is no "copy his texture onto her" in the kit, and there could not be: the two
 * models' pictures are laid out completely differently, so the same pixel means her hip
 * on one sheet and his elbow on the other. UVs cannot be matched up.
 *
 * What CAN be matched up is SPACE. Both stand in the same place on the same skeleton, so
 * for any point on her there is a point on him an inch or two away wearing the colour
 * that belongs there. So his surface is rebuilt here as triangles in model space, each
 * carrying its picture and the UVs to read it at, and paint asks it for the colour at
 * each of her pixels in turn.
 *
 * `spot()` in the kit is close to this and is not enough: it gives back a triangle's
 * middle, its normal and its texture's NAME, with no UV and no colour, so there is no way
 * to read the picture at the place it found.
 */
function surfaceSampler(mdl, pose, skip, HER_AXIS_Y, PUSH = 1.8, SKIP_SKIN = false) {
  // `skip(tex, mid)` leaves a triangle of his out of the surface entirely.
  //
  // PUSH is how far out along her own normal the question is asked, and it belongs to the
  // DONOR rather than to the method. repuheavy is a slab at 7.0 half-width everywhere and
  // needs 1.8 to reach the outer shell of his armour; the proletarian sits within a unit
  // of her at most bands and wants far less, or the lookup steps clean past him.
  const md = K.readMdl(mdl);
  const P = K.poseAt(mdl, pose.seq, pose.frame);
  const rot = (b, v) => [0, 1, 2].map((r) => P[b][r][0] * v[0] + P[b][r][1] * v[1] + P[b][r][2] * v[2]);

  const img = new Map();
  const tris = [];
  for (const bp of md.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
    const tex = md.textures[me.skinref];
    if (!tex) continue;
    if (!img.has(tex.name)) img.set(tex.name, K.textureOf(mdl, tex.name));
    const im0 = img.get(tex.name);
    for (const t of K.readMesh(mdl, mo, me)) {
      const p = t.map((c) => K.apply34(P[c.bone], c.p));
      const mid = [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3);
      if (skip(tex.name, mid)) continue;

      /*
       * HIS BARE SKIN IS NOT CLOTHING, and must not be offered as any.
       *
       * The proletarian's hands are painted on suit.bmp with the rest of him -- 82
       * triangles of warm tan, mean rgb(107,77,54), against the suit's rgb(34,35,45) --
       * and they sit at hip height, which is exactly where her gauntlets are. So her
       * forearms were sampling his knuckles and coming out speckled with flesh under the
       * sleeve. Found by colour and not by box, because a box round a hand at his side
       * takes his trouser with it.
       */
      /*
       * ONLY WHERE THE DONOR ACTUALLY HAS BARE SKIN.
       *
       * This finds skin by colour -- warm and not dark -- which is exact on the
       * proletarian, whose hands are 80 triangles of tan against a navy suit. It is
       * CATASTROPHIC on a donor dressed in tan: on ins_medic_belt it rejected 488 of his
       * 592 body triangles, his whole olive shirt, so there was almost nothing left for
       * her to sample and she kept her own bare flesh under the medic's rig.
       *
       * So it is per-variant, and off for any donor whose hands are gloved.
       */
      if (SKIP_SKIN) {
        let r = 0, g = 0, b = 0;
        for (const c of t) {
          const x = Math.max(0, Math.min(im0.width - 1, Math.round(c.s)));
          const y = Math.max(0, Math.min(im0.height - 1, Math.round(c.t)));
          const i = im0.pixels[y * im0.width + x] * 3;
          r += im0.palette[i] / 765; g += im0.palette[i + 1] / 765; b += im0.palette[i + 2] / 765;
        }
        void g;
        if (r > b + 0.06 && r > 0.22) continue;
      }
      // The face's normal is the mean of its corners' rather than the cross product of
      // its edges: the winding convention differs between models and a flipped normal
      // would make every lookup pick the surface on the far side of him.
      const n = [0, 1, 2].map((k) => t.reduce((a, c) => a + rot(c.bone, c.n)[k], 0) / 3);
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      tris.push({ p, n: n.map((v) => v / len), uv: t.map((c) => [c.s, c.t]), tex: tex.name });
    }
  }

  // A plain uniform grid. Nearest-triangle is asked about a hundred thousand times, and
  // walking all 3300 of them each time is a quarter of an hour; this is a few seconds.
  const CELL = 4;
  const key = (a, b, c) => `${a},${b},${c}`;
  const grid = new Map();
  tris.forEach((t, i) => {
    const mn = [0, 1, 2].map((k) => Math.floor(Math.min(t.p[0][k], t.p[1][k], t.p[2][k]) / CELL));
    const mx = [0, 1, 2].map((k) => Math.floor(Math.max(t.p[0][k], t.p[1][k], t.p[2][k]) / CELL));
    for (let a = mn[0]; a <= mx[0]; a++) for (let b = mn[1]; b <= mx[1]; b++) for (let c = mn[2]; c <= mx[2]; c++) {
      const k = key(a, b, c);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  });

  // The point of a triangle nearest q, by the usual region test on its plane.
  function nearestOn(t, q) {
    const [a, b, c] = t.p;
    const ab = [0, 1, 2].map((k) => b[k] - a[k]);
    const ac = [0, 1, 2].map((k) => c[k] - a[k]);
    const aq = [0, 1, 2].map((k) => q[k] - a[k]);
    const d1 = ab[0] * aq[0] + ab[1] * aq[1] + ab[2] * aq[2];
    const d2 = ac[0] * aq[0] + ac[1] * aq[1] + ac[2] * aq[2];
    if (d1 <= 0 && d2 <= 0) return { w: [1, 0, 0], p: a };
    const bq = [0, 1, 2].map((k) => q[k] - b[k]);
    const d3 = ab[0] * bq[0] + ab[1] * bq[1] + ab[2] * bq[2];
    const d4 = ac[0] * bq[0] + ac[1] * bq[1] + ac[2] * bq[2];
    if (d3 >= 0 && d4 <= d3) return { w: [0, 1, 0], p: b };
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      return { w: [1 - v, v, 0], p: [0, 1, 2].map((k) => a[k] + ab[k] * v) };
    }
    const cq = [0, 1, 2].map((k) => q[k] - c[k]);
    const d5 = ab[0] * cq[0] + ab[1] * cq[1] + ab[2] * cq[2];
    const d6 = ac[0] * cq[0] + ac[1] * cq[1] + ac[2] * cq[2];
    if (d6 >= 0 && d5 <= d6) return { w: [0, 0, 1], p: c };
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const v = d2 / (d2 - d6);
      return { w: [1 - v, 0, v], p: [0, 1, 2].map((k) => a[k] + ac[k] * v) };
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const v = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return { w: [0, 1 - v, v], p: [0, 1, 2].map((k) => b[k] + (c[k] - b[k]) * v) };
    }
    const den = 1 / (va + vb + vc);
    const v = vb * den, w2 = vc * den;
    return { w: [1 - v - w2, v, w2], p: [0, 1, 2].map((k) => a[k] + ab[k] * v + ac[k] * w2) };
  }

  const colourOf = (t, w) => {
    const im = img.get(t.tex);
    let u = 0, v = 0;
    for (let i = 0; i < 3; i++) { u += t.uv[i][0] * w[i]; v += t.uv[i][1] * w[i]; }
    const x = Math.max(0, Math.min(im.width - 1, Math.round(u)));
    const y = Math.max(0, Math.min(im.height - 1, Math.round(v)));
    const idx = im.pixels[y * im.width + x] * 3;
    return [im.palette[idx] / 255, im.palette[idx + 1] / 255, im.palette[idx + 2] / 255];
  };

  const REACH = 14;            // how far off him a point of her may look, in units
  function nearest(q, nq) {
    let best = null, bestD = REACH * REACH;
    const c0 = [0, 1, 2].map((k) => Math.floor(q[k] / CELL));
    for (let r = 0; r <= Math.ceil(REACH / CELL); r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) {
        // Only the new shell each round, so no cell is walked twice.
        if (r > 0 && Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== r) continue;
        const bucket = grid.get(key(c0[0] + a, c0[1] + b, c0[2] + c));
        if (!bucket) continue;
        for (const i of bucket) {
          const t = tris[i];
          /*
           * Facing the same way as she does there, and the better the agreement the
           * further away it is allowed to be.
           *
           * The test alone is what stops a point on her chest taking the colour of the
           * INSIDE of his back plate, which is black. The WEIGHT is what stops her coming
           * out in patches: where her arm hangs near her ribs, his sleeve and his webbing
           * are both within a inch and the nearest of the two flickers from pixel to
           * pixel, so a seam that is on neither of them gets drawn across her. Scoring a
           * square-on surface as if it were nearer makes that choice hold still.
           */
          const face = nq ? t.n[0] * nq[0] + t.n[1] * nq[1] + t.n[2] * nq[2] : 1;
          if (face < 0.30) continue;
          const got = nearestOn(t, q);
          const d = (got.p[0] - q[0]) ** 2 + (got.p[1] - q[1]) ** 2 + (got.p[2] - q[2]) ** 2;
          const score = d * (1.6 - 0.6 * face);
          if (score < bestD) { bestD = score; best = { t, w: got.w, d: score }; }
        }
      }
      // Found something inside the shell already walked: nothing further out can beat it.
      if (best && bestD <= (r * CELL) ** 2) break;
    }
    return best;
  }

  /*
   * Asked at the point and at its reflection, and the better answer wins.
   *
   * He is symmetric and so is she, but the POSE is not: this frame has her weight on one
   * leg and her arms at different angles from his, so her left knee is an inch from his
   * and her right is four. Sampled one-sided that put his blue knee plate on one of her
   * shins and nothing on the other, which reads as damage rather than as armour. His
   * colour at the mirrored point is the same colour, so taking whichever side answers
   * better gives her a matching pair. Reflected about HER centre line at y 0.203 rather
   * than about zero, or the mirrored question is asked a fifth of a unit off every time.
   */
  /*
   * The point is pushed OUT along her own normal before he is asked about it.
   *
   * She stands inside his silhouette everywhere: measured band by band his legs are 1 to
   * 2 units wider than hers and up to 5 deeper from front to back, and his shoulders 2.6
   * wider. Asked from where her surface actually is, a thin shin finds the RIM of his
   * knee plate rather than its face -- which is why the plate arrived on her as a broken
   * blue scribble down the front of a shin instead of as a knee pad. Stepping out first
   * puts the question where his armour's outer shell is, so a face of it answers instead
   * of an edge.
   */
  return function look(q0, nq) {
    const q = nq ? [0, 1, 2].map((k) => q0[k] + nq[k] * PUSH) : q0;
    const a = nearest(q, nq);
    const m = [q[0], 2 * HER_AXIS_Y - q[1], q[2]];
    const mn = nq ? [nq[0], -nq[1], nq[2]] : nq;
    const b = nearest(m, mn);
    const pick = !a ? b : !b ? a : (b.d < a.d ? b : a);
    return pick ? colourOf(pick.t, pick.w) : null;
  };
}

// ===========================================================================
// BUILD
// ===========================================================================

// ===========================================================================
// ONE BUILD, RUN ONCE PER VARIANT
// ===========================================================================
/*
 * The two models differ in three decisions and share everything else -- the arm mirror,
 * the armour transfer, the remap rename, the pauldrons, the stance. Kept as one function
 * taken twice rather than as two scripts, because the helmeted one has been through a
 * dozen corrections and a copy of it would have stopped matching after the first.
 */
function build(V) {
  const D = donorOf(V.donor ?? "repuheavy");
  const donor = D.mdl, donorMd = D.md, donorPose = D.pose;
  const donorNames = K.bones(donor).map((b) => b.name);
  // -- 1. her head, and her braid, off ----------------------------------------
  const braid = braidPiece(base);
  const pieceOf = K.pieces(base, POSE).of;

  /*
   * WHAT RIDES HER HEAD BONE, which the texture test does not catch.
   *
   * face.bmp and hair.bmp are hers alone and go whole, but her head bone also carries 78
   * triangles of 2.bmp -- her jaw, her scalp and the braid, all painted on the body sheet.
   * Under a sealed helmet none of that shows and it never mattered. With a real head
   * grafted on it does: the jaw survived the cut, took the armour colour with the rest of
   * her body, and sat in front of lady's chin as a black mask across the bottom of her
   * face.
   *
   * dropTriangles is handed a triangle's middle and its texture and not its corners'
   * bones, so the head's triangles are picked out here, where the corners are in hand, and
   * matched back by where their middles are. The braid is spared when the variant keeps it.
   */
  const headBone = K.bones(base).map((b) => b.name).indexOf("Bip01 Testa");
  const BP0 = K.poseAt(base, POSE.seq, POSE.frame);
  const baseMd0 = K.readMdl(base);
  const onHead = new Set();
  for (const bp of baseMd0.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
    for (const t of K.readMesh(base, mo, me)) {
      if (!t.some((c) => c.bone === headBone)) continue;
      const mid = [0, 1, 2].map((k) => t.reduce((a, c) => a + K.apply34(BP0[c.bone], c.p)[k], 0) / 3);
      onHead.add(mid.map((v) => v.toFixed(3)).join(","));
    }
  }
  const ridesHead = (t) => onHead.has(t.mid.map((v) => v.toFixed(3)).join(","));
  let byTex = 0, byZ = 0, tail = 0, plug = 0;
  const { mdl: bare } = K.dropTriangles(base, (t) => {
    // NOTHING of her head comes off unless a helmet is going on in its place. The bare
    // one keeps her own face, her own hair and her own braid -- it is her head, and it
    // fits her, because it is the one the model was built with.
    if (!V.helmet && !V.dropHead) {
      if (t.mid[2] >= SHADOW_FROM) { plug++; }
      return false;
    }
    /*
     * The braid may outlive the head. Under a sealed helmet it has to go -- it came out
     * through the shell. Under a GASMASK it should not: a ponytail out the back of the
     * mask is what the model wants, and without it a blonde version has no hair to be
     * blonde.
     */
    if (pieceOf(t) === braid.id) {
      // Kept or dropped, it is decided HERE and nowhere else. The braid rides the head
      // bone, so falling through to the ridesHead test below took it away again even when
      // the variant asked to keep it.
      if (V.keepBraid) { return false; }
      tail++; return true;
    }
    if (HEAD_TEX.has(t.tex)) { byTex++; return true; }
    if (ridesHead(t)) { byZ++; return true; }
    if (t.mid[2] >= HEAD_Z) { byZ++; return true; }
    if (t.mid[2] >= SHADOW_FROM) { plug++; }
    return false;
  }, POSE);
  console.log((V.helmet || V.dropHead)
    ? `  head off: ${byTex} by texture, ${byZ} on the head bone or above z ${HEAD_Z}, `
      + `${tail} of braid; ${plug} left above z ${SHADOW_FROM} as the neck plug`
    : `  head kept: her own face, hair and braid, untouched`);
  if ((V.helmet || V.dropHead) && !byTex) throw new Error("found no face or hair on female_merc: the model has changed");
  if ((V.helmet || V.dropHead) && !V.keepBraid && !tail) throw new Error("found no braid to take off");
  if (!plug) throw new Error("nothing left above the collar line at all");

  // -- 2. one arm mirrored onto the other -------------------------------------
  /*
   * graft cannot do this. It matches bones BY NAME, so a corner held against "Bip01 DX
   * Mano" lands on "Bip01 DX Mano" however its position is moved -- the reflected arm would
   * hang on the right side of the skeleton while sitting on the left of the body, and swing
   * with the wrong shoulder the moment she moved. The corners have to change bone, which
   * means building the mesh by hand, the way the mirrored pauldron was built for
   * ins_proletarian.
   */
  const baseNames = K.bones(base).map((b) => b.name);
  const BP = K.poseAt(base, POSE.seq, POSE.frame);
  const baseMd = K.readMdl(base);

  const bonesOf = (s) => new Set(ARM_BONES(s).map((n) => {
    const i = baseNames.indexOf(n);
    if (i < 0) throw new Error(`no bone "${n}": this is not the skeleton these models shared`);
    return i;
  }));
  const FROM_B = bonesOf(armFrom(V)), TO_B = bonesOf(armTo(V));
  const mirrorBone = (b) => {
    const want = baseNames[b].replace(` ${armFrom(V)} `, ` ${armTo(V)} `);
    const i = baseNames.indexOf(want);
    return i >= 0 ? i : b;
  };

  // The arm that stays, taken off the ORIGINAL rather than off the cut model: the cut has
  // already lost her head and braid, and readMesh would have to be walked over a model
  // whose meshes no longer line up with the ones measured here.
  const armPieces = new Map();        // texture name -> triangles
  let armN = 0;
  for (const bp of baseMd.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
    const tex = baseMd.textures[me.skinref];
    if (!tex) continue;
    for (const t of K.readMesh(base, mo, me)) {
      if (!t.some((c) => FROM_B.has(c.bone))) continue;
      // Outboard of the join only: the shoulder and the armpit stay as they are.
      if (!armPieces.has(tex.name)) armPieces.set(tex.name, { tex, tris: [] });
      armPieces.get(tex.name).tris.push(t);
      armN++;
    }
  }
  if (!armN) throw new Error(`found no ${armFrom(V)} arm to mirror`);

  /*
   * The other arm off, so the reflection is not laid on top of it.
   *
   * This has to go by BONE, and dropTriangles is handed a triangle's middle and its texture
   * rather than its corners' bones -- so the arm is picked out here, where the corners are
   * in hand, and matched back to the triangles by where their middles are.
   */
  const toDrop = new Set();
  for (const bp of baseMd.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
    for (const t of K.readMesh(base, mo, me)) {
      /*
       * EVERY corner on the arm, not any of them -- and this is what the hole in the upper arm was.
       *
       * A triangle with one corner on the shoulder and two on the arm is the BRIDGE between the two:
       * it is part of the torso's surface as much as the arm's. Dropping those with `some` took the
       * torso's shoulder cap away with the arm, and the mirrored arm that replaced it is a mesh of
       * its own sharing no vertices with her body -- so where the two met there was nothing but two
       * free boundaries a fraction apart, which you see straight through.
       *
       * Measured: 33 open edges on the mirrored upper arm against 4 on the arm that was kept.
       *
       * With `every` only the arm proper comes off, the bridge stays and the torso stays closed. The
       * mirrored arm is laid over it, and the pauldron sits on top of both.
       */
      if (!t.every((c) => TO_B.has(c.bone))) continue;
      const mid = [0, 1, 2].map((k) => t.reduce((a, c) => a + K.apply34(BP[c.bone], c.p)[k], 0) / 3);
      toDrop.add(mid.map((v) => v.toFixed(3)).join(","));
    }
  }
  let offN = 0;
  const { mdl: stripped } = K.dropTriangles(bare, (t) => {
    if (!toDrop.has(t.mid.map((v) => v.toFixed(3)).join(","))) return false;
    offN++;
    return true;
  }, POSE);
  if (!offN) throw new Error(`found no ${armTo(V)} arm to take off`);

  /*
   * The reflection. Each corner goes out to the world both models stand in, across the
   * centre line, and is handed over with the SAME BONE ON THE OTHER SIDE -- so it bends
   * with the shoulder it now sits on.
   *
   * `p` IS GIVEN IN MODEL SPACE, NOT IN THE BONE'S. That is what `to` is for: meshOf takes
   * the matrix on each corner and does the conversion itself. Converting here as well
   * applies it twice, and the second one is nonsense -- the arm came out as a crumpled heap
   * at her pelvis, 5 units tall where it should be 30, which from the front reads as an arm
   * that is simply not there.
   *
   * Reflecting turns a mesh inside out, so the winding is reversed with it.
   */
  /*
   * Her centre line, which is NOT y = 0.
   *
   * Measured off her own skeleton, bone against matching bone: the two clavicles average
   * 0.309, the upper arms 0.242, the thighs 0.260, and over the seven pairs 0.203. She is
   * built a fifth of a unit to one side of the origin, so reflecting an arm about y = 0
   * lands it 0.4 inboard of where its own shoulder is -- a gap at one armpit and an
   * overlap at the other.
   */
  const AXIS_Y = 0.203;

  const INTO = new Map();
  const into = (b) => {
    if (!INTO.has(b)) INTO.set(b, K.inverse34(BP[b]));
    return INTO.get(b);
  };

  let armed = stripped;
  let madeN = 0;
  for (const [, piece] of armPieces) {
    const tris = piece.tris.map((t) => {
      const made = t.map((c) => {
        const b = mirrorBone(c.bone);
        const w = K.apply34(BP[c.bone], c.p);
        return {
          p: [w[0], 2 * AXIS_Y - w[1], w[2]],
          uv: [c.s / piece.tex.width, c.t / piece.tex.height],
          bone: b, to: into(b),
        };
      });
      /*
       * THE WINDING IS LEFT ALONE, and this is the third time round on it.
       *
       * Reflecting a mesh does turn it inside out, so reversing each triangle here looks
       * obviously right -- but meshOf is ALSO handed the source triangles as its winding
       * reference, and settling the winding against them is exactly what it does with
       * that. Doing both corrects it twice and the arm comes out inverted: solid from
       * inside, see-through from outside.
       *
       * It was taken out once before and the arm vanished, which seemed to settle the
       * question -- but that test was confounded. The corners were being converted to
       * bone space twice at the same time, so the arm was a crumpled heap at her pelvis
       * for a different reason entirely, and the reversal took the blame.
       *
       * Measured properly -- the share of an arm's normals pointing away from that arm's
       * OWN long axis -- her untouched arms are 93% and 94%, and the mirrored one was 6%.
       * An earlier check compared against the BODY's axis, where any tube reads about half
       * whichever way round it is, so it could never have caught this.
       */
      return made;
    });

    const where = { bodypart: 0, model: 0 };
    const at = K.readMdl(armed).bodyparts[0].models[0].meshes.length;
    const tex = K.textureOf(armed, piece.tex.name);
    // The SOURCE triangles are handed in as the winding reference. Told nothing, meshOf
    // assumes the generators' convention, which is the opposite of this model's -- that is
    // what turned the pauldrons inside out on ins_proletarian and read, maddeningly, as a
    // correctly made plate belonging to the other shoulder.
    armed = K.replaceMesh(
      K.addMesh(armed, where), { ...where, mesh: at },
      K.meshOf(piece.tris, tris, tex, mirrorBone([...FROM_B][0]), V.armSmooth ?? ARM_SMOOTH), tex,
    );
    madeN += tris.length;
  }
  console.log(`  arms: ${armFrom(V)} kept (${armN} triangles), ${armTo(V)} off (${offN}), `
    + `${madeN} mirrored back on over ${armPieces.size} textures`);

  // -- 3. his armour's colour onto her ----------------------------------------
  /*
   * Her own shading is kept and his colour laid over it.
   *
   * A straight copy of his colour is flat: his armour is mostly one dark grey, so every
   * fold and seam she has disappears and she reads as a silhouette cut out of card. What
   * carries her form is how each pixel sits against its NEIGHBOURS, so that is measured on
   * her picture -- the pixel over the blur of the pixels around it -- and his colour is
   * multiplied by it. His webbing and panels arrive; her shape still shows through them.
   *
   * Kept to a FIFTH either way, which is less than it first was. Her midriff is bare skin,
   * painted with the deep shading a bare stomach needs, and carried over at full strength
   * that came through his armour as a six-pack picked out in black -- her lighting drawn on
   * his plate. A light touch keeps the hollow of her back and the line of her ribs without
   * stamping her anatomy through the suit.
   */
  /*
   * WHAT OF HIM IS LEFT OUT OF THE SURFACE SHE IS SAMPLED FROM.
   *
   * Anything that comes across as real geometry has to go, or she gets it twice: once as
   * the part itself and once more painted on the body underneath it. That showed up on the
   * shoulders as a SECOND PAULDRON -- a blue plate painted flat on her deltoid, sitting
   * just inboard of the real one standing proud above it, which reads as a soldier wearing
   * two of them.
   *
   * The helmet goes by texture, since it has ten of its own. The pauldrons cannot: they are
   * a region of two big sheets that also carry his whole torso, so they go by the same
   * boxes that pick them up for grafting.
   */
  const SKIP = (tex, mid) => (V.skipTex ?? []).includes(tex)
    || (V.plates && HELMET_TEX.has(tex))
    || (V.plates && PLATES.some((pl) => pl.tex === tex && inBox(mid, pl.box)))
    || (V.plates && SHINS.tex === tex && inBox(mid, SHINS.box));
  const look = surfaceSampler(donor, POSE, SKIP, AXIS_Y, V.push ?? 1.8, V.skipSkin ?? false);
  const HER_TEX = ["2.bmp", "remapm_001_255_255.bmp", "legs.bmp"];

  let asked = 0, missed = 0;
  /*
   * ON THE BARE ONE THE ARMOUR STOPS AT THE COLLAR.
   *
   * Her face and hair are on sheets of their own and were never painted, but her JAW and
   * her THROAT are on 2.bmp along with the rest of her body -- so painting that sheet
   * right up gives her an armour-coloured chin above a bare face. Faded out between z
   * 25.5 and 27.0, where a collar sits, so the armour ends at a neckline and not at a
   * hard stripe across her throat.
   *
   * The helmeted one wants none of this: all of that is inside the helmet, and the darker
   * it goes the better it reads as the inside of a collar.
   */
  const PAINT_FADE = V.paintFade ?? [25.5, 27.0];

  /*
   * HOW MUCH OF HER OWN SHADING SURVIVES, which belongs to the DONOR.
   *
   * Armour is panelled and catching light, and carrying a fifth of her shading through it
   * keeps the hollow of her back and the line of her ribs rather than leaving a silhouette
   * cut out of card. Cloth is not: a suit is flat fabric, and the same fifth carried her
   * BARE ARMS and her CAMO TROUSERS straight through it -- skin showing in the sleeve and
   * a camouflage pattern under black slacks, which is what "the flesh bleeds through the
   * clothes" is. At 0 she simply wears what he wears, which is the whole request.
   */
  const SHADE = V.shade ?? 0.25;

  const armour = (place) => {
    const { p, n, rgb, blur, island } = place;
    if (!V.helmet && p[2] >= PAINT_FADE[1]) return undefined;
    if (braidIslands.has(island)) return undefined;        // her hair is not his jacket
    asked++;
    const his = look(p, n);
    if (!his) { missed++; return undefined; }

    // Her own light and shade, as a ratio about 1. Held in range so a black seam of hers
    // does not black his colour out altogether.
    let k = 1;
    if (SHADE > 0) {
      const soft = blur(3);
      const mine = (0.30 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]);
      const flat = (0.30 * soft[0] + 0.59 * soft[1] + 0.11 * soft[2]);
      k = flat > 0.02 ? clamp((1 - SHADE) + SHADE * (mine / flat), 1 - SHADE, 1 + SHADE) : 1;
    }

    const out = [0, 1, 2].map((c) => clamp(his[c] * k));
    if (V.helmet) return out;
    return W.mix(rgb, out, clamp((PAINT_FADE[1] - p[2]) / (PAINT_FADE[1] - PAINT_FADE[0])));
  };

  /*
   * Only under a sealed helmet. On the bare one there is a real throat up there with a
   * real head on top of it, and darkening it does not read as the inside of a collar --
   * it reads as a bruise round her neck.
   */
  const neckShadow = ({ p, rgb }) => {
    if (!V.helmet) return undefined;
    if (p[2] < SHADOW_FROM) return undefined;
    return W.mix(rgb, SHADOW, clamp((p[2] - SHADOW_FROM) / (SHADOW_FULL - SHADOW_FROM)));
  };

  console.log("  sampling his surface onto her, which takes a minute...");
  const t0 = Date.now();
  /*
   * BLONDE, for the variant that asks for it.
   *
   * Her hair is nearly black -- hair.bmp averages rgb (13, 6, 2), with three quarters of
   * its drawn pixels under 0.04 luminance -- so this cannot be a tint. Tinting something
   * that dark gives dark hair with a yellow cast. The shading is read off instead and
   * replayed onto a blonde ramp, with a square root opening up the shadow end so the bulk
   * of the hair lands in the middle of the ramp rather than piling up at the dark end.
   *
   * It has to reach the BRAID as well, and the braid is not on hair.bmp -- it is painted
   * on 2.bmp with the rest of her body. A box will not separate it either: it runs x -5.8
   * to 1.9, and her own back is inside that.
   *
   * So it is found as a UV ISLAND, by the same shape that identifies it as a piece: on
   * 2.bmp, barely three units across, a dozen or more long, and behind her. An island and
   * not a piece because paint hands its function `island` already worked out, whereas
   * pieces().of keys on a triangle's THREE corner points and paint has only the one point
   * the pixel colours -- so it throws on every pixel it is asked about.
   */
  const BLONDE = [[0.22, 0.15, 0.06], [0.58, 0.44, 0.19], [0.88, 0.78, 0.50]];
  const BLONDE_TOP = 0.35;

  /*
   * HER BRAID, FOUND FOR EVERY VARIANT AND NOT ONLY THE BLONDE ONE.
   *
   * It is painted on 2.bmp with the rest of her body, which puts it squarely in the sheets
   * the donor's colour is laid over -- so her hair was being painted the colour of his
   * clothes. On the armoured pair that went unnoticed because armour is dark and so is her
   * hair; against a navy suit it is a navy ponytail.
   *
   * So the body pass skips it, and the blonde pass claims it. An island rather than a box:
   * it runs x -5.8 to 1.9 and her own back is inside that.
   */
  const braidIslands = new Set();
  {
    for (const e of K.uvIslands(armed, POSE).list) {
      if (e.tex !== "2.bmp") continue;
      if (e.mx[1] - e.mn[1] > 4.0) continue;
      if (e.mx[2] - e.mn[2] < 10.0) continue;
      if (e.mx[0] > 2.5) continue;
      braidIslands.add(e.id);
    }
    // The helmeted one had its braid taken off with the head, so finding none there is
    // correct. Finding none on a variant that KEPT it means the search is broken, and the
    // first thing that would show is navy hair.
    if (!braidIslands.size && !V.helmet && !(V.dropHead && !V.keepBraid)) {
      throw new Error("found no braid island on her, but this variant keeps its braid");
    }
  }

  let blondeN = 0;
  /*
   * THE SCALP IS ON face.bmp, WITH HER FACE.
   *
   * hair.bmp is only the strands. The scalp under them -- the parting, the hairline, the
   * crown -- is painted on face.bmp, 16 of its triangles sitting above z 33, and 14 more
   * on the body sheet. Recolouring hair.bmp alone left brown skin showing between blonde
   * strands at the hairline, which reads as a bad dye job rather than as blonde hair.
   *
   * The whole sheet cannot go: it is her face. So those pixels are picked out by BEING
   * HAIR-COLOURED and BEING HIGH ON HER HEAD at once. Dark and warm (red above blue) finds
   * hair and eyebrows while leaving skin, which is pale, and leaving her eyes, which are
   * not warm. The height test keeps it off anything at face level that happens to be dark.
   *
   * Eyebrows going blonde with it is correct and not a side effect: dark brows under
   * blonde hair are what a dyed head looks like.
   */
  const SCALP_Z = 32.4;
  const scalpish = ({ p, rgb, tex }) => (tex === "face.bmp" || tex === "2.bmp")
    && p[2] >= SCALP_Z
    && (0.30 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]) < 0.30
    && rgb[0] >= rgb[2];

  const blonde = (place) => {
    const { rgb, tex, island } = place;
    const onHair = tex === "hair.bmp"
      || (tex === "2.bmp" && braidIslands.has(island))
      || scalpish(place);
    if (!onHair) return undefined;
    blondeN++;
    const l = 0.30 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];
    const t = Math.sqrt(clamp(l / BLONDE_TOP));
    return t < 0.5
      ? W.mix(BLONDE[0], BLONDE[1], t * 2)
      : W.mix(BLONDE[1], BLONDE[2], (t - 0.5) * 2);
  };

  // hair.bmp is not in HER_TEX, so the blonde pass brings its own texture list with it.
  /*
   * A BALACLAVA, PAINTED RATHER THAN GRAFTED.
   *
   * A masked head is geometry: TPS_Masked_Female is 696 triangles and would cost about
   * 500 normals on a model already within a few dozen of the ceiling. Painted it costs
   * NOTHING, and on a face this size at the distance a player is seen, a drawn mask and a
   * modelled one are the same picture.
   *
   * Her face is on face.bmp, her own sheet, so it can be addressed without touching
   * anything else. The cut runs below the eyes and follows the cheekbone down, so the
   * eyes and brow are left -- a mask over the whole face reads as a blank, and what makes
   * it read as a person in a mask is the eyes above it.
   */
  const MASK = [0.055, 0.056, 0.060];
  const MASK_TOP = 32.6;          // just under the eyes, which sit about 33
  const MASK_FADE = 0.5;

  let maskN = 0;
  const masked = ({ p, rgb, tex }) => {
    if (tex !== "face.bmp") return undefined;
    if (p[2] >= MASK_TOP) return undefined;
    maskN++;
    // Her own shading kept underneath, so the cloth creases where her jaw does.
    const lum = 0.30 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];
    const k = clamp(0.75 + 0.5 * lum, 0.7, 1.35);
    const c = [0, 1, 2].map((i) => clamp(MASK[i] * k + 0.02));
    return W.mix(rgb, c, clamp((MASK_TOP - p[2]) / MASK_FADE));
  };

  const passes = [armour, neckShadow];
  if (V.blonde) passes.push({ fn: blonde, only: [...HER_TEX, "hair.bmp", "face.bmp"] });
  if (V.mask) passes.push({ fn: masked, only: [...HER_TEX, "face.bmp"] });

  const { mdl: painted } = K.paint(armed, passes, { pose: POSE, only: HER_TEX });
  if (V.mask) {
    console.log(`  mask: ${maskN} pixels of face.bmp below z ${MASK_TOP} covered`);
    if (!maskN) throw new Error("the mask pass matched nothing: her face came out bare");
  }
  if (V.blonde) {
    console.log(`  blonde: ${blondeN} pixels recoloured over ${braidIslands.size} braid island(s) and hair.bmp`);
    if (!blondeN) throw new Error("the blonde pass matched nothing: her hair came out unchanged");
  }
  console.log(`  armour painted: ${asked} points asked, ${missed} found nothing within reach `
    + `(${(100 * missed / Math.max(1, asked)).toFixed(1)}%)  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (missed > asked * 0.25) {
    throw new Error(`${(100 * missed / asked).toFixed(0)}% of her found no armour to copy: `
      + "the two are not standing in the same place and the transfer is meaningless");
  }

  // -- 4. off the team remap --------------------------------------------------
  /*
   * Her main sheet is called remapm_001_255_255.bmp, and TS reads that name: it recolours
   * the sheet to the team's colour at runtime. Leave it and the armour just painted on is
   * thrown away and replaced with flat team paint, which is the whole request undone.
   * repuheavy has no remappable texture at all -- nor does any other model wired into these
   * class pools -- so renaming it both fixes this and matches what she is standing next to.
   */
  const REMAP_WAS = "remapm_001_255_255.bmp", REMAP_NOW = V.plates ? "fem_armour.bmp" : (V.donor ? "fem_cloth.bmp" : "fem_armour.bmp");
  const old = K.textureOf(painted, REMAP_WAS);
  const unmapped = K.replaceTexture(painted, REMAP_WAS, { ...old, name: REMAP_NOW });
  console.log(`  ${REMAP_WAS} renamed to ${REMAP_NOW}, so TS stops repainting it team colour`);

  // -- 5. his helmet and his pauldrons on -------------------------------------
  /*
   * graft matches bones BY NAME, which is why none of this needs fitting: both models carry
   * the same 22 Bip01 bones in the same places, so a corner held against "Bip01 Testa" over
   * there lands against "Bip01 Testa" here, and the piece sits where it sat.
   *
   * It also settles the winding itself, which is the part that went wrong by hand on these
   * same pauldrons in make-ins-proletarian -- they came across inside out and read as a
   * tidy plate belonging to the OTHER shoulder, which is why it took so long to see.
   *
   * The plates are a region of two big body sheets rather than meshes of their own, and
   * graft picks whole meshes -- so each sheet is first cut down to nothing but its plate,
   * and the mesh that is left to pick is the plate.
   */
  function only(mdl, keep) {
    let n = 0;
    const { mdl: cut } = K.dropTriangles(mdl, (t) => {
      if (keep(t)) { n++; return false; }
      return true;
    }, POSE);
    return { mdl: cut, n };
  }

  /*
   * THE HELMET AND THE COLLAR MOVE AS ONE PIECE.
   *
   * They interlock on him: the helmet's rear skirt is built to come down INSIDE the cuff of
   * his vest, and the two are cut to each other. Taking one in and leaving the other alone
   * breaks that join and they stick through one another -- which is exactly what happened
   * when the collar was first fitted to her on its own.
   *
   * So one transform is worked out here and handed to BOTH grafts, about the middle of the
   * two of them together. Whatever it does, it does to the pair, and their join survives it.
   *
   * Gentler than the pauldrons' 0.78, deliberately. A pauldron is a slab that can be taken
   * in hard without anyone noticing; the helmet is a recognisable shape and squashing it
   * that far reads as a dented one. 0.86 across and 0.90 wide is enough to bring the rear
   * skirt in off her back without the thing looking crushed.
   */
  const HEAD_XSCALE = 0.86, HEAD_YSCALE = 0.90, HEAD_FWD = 0.40;

  /*
   * The cuff is ONE sheet's worth, and that is the whole lesson of the first attempt.
   *
   * Taken as "everything above z 27.5 inside |y| 5.5" it came to 69 triangles over FIVE
   * textures -- 55 of them the cuff on 05.bmp, and the other 14 odd scraps of the top of his
   * vest on four more sheets. Those scraps are not a ring round anything; they are torn
   * corners of a chest plate, and brought across on their own they stood out of her collar
   * as black shards and crossed the pauldrons.
   *
   * So the cuff is the ring on 05.bmp and nothing else, pulled in to |y| 4.5 to sit against
   * a neck rather than a shoulder.
   */
  const COLLAR_Z = 27.5, COLLAR_Y = 4.5, COLLAR_TEX = "05.bmp";
  const isCollar = (t) => t.tex === COLLAR_TEX
    && t.mid[2] >= COLLAR_Z && Math.abs(t.mid[1]) <= COLLAR_Y
    && !PLATES.some((pl) => pl.tex === t.tex && inBox(t.mid, pl.box));
  const isHeadGear = (t) => HELMET_TEX.has(t.tex) || isCollar(t);

  // The middle of the two together, which is what they are taken in about.
  let hx = 0, hy = 0, hz = 0, hn = 0;
  K.dropTriangles(donor, (t) => {
    if (!isHeadGear(t)) return false;
    hx += t.mid[0]; hy += t.mid[1]; hz += t.mid[2]; hn++;
    return false;
  }, POSE);
  const headCentre = [hx / hn, hy / hn, hz / hn];

  const headNames = K.bones(unmapped).map((b) => b.name);
  const HTP = K.poseAt(unmapped, POSE.seq, POSE.frame);
  const HINTO = new Map();
  const headMove = (pp, boneName) => {
    const b = headNames.indexOf(boneName);
    if (b < 0) return pp;
    if (!HINTO.has(b)) HINTO.set(b, K.inverse34(HTP[b]));
    const w = K.apply34(HTP[b], pp);
    const q = [
      headCentre[0] + (w[0] - headCentre[0]) * HEAD_XSCALE + HEAD_FWD,
      headCentre[1] + (w[1] - headCentre[1]) * HEAD_YSCALE,
      w[2],
    ];
    return K.apply34(HINTO.get(b), q);
  };

  let built = unmapped;

  // Shared by the gear block below: her bone names, and each bone's inverse, worked out
  // once rather than per corner.
  const targetNames2 = K.bones(unmapped).map((b) => b.name);
  const GTP = K.poseAt(unmapped, POSE.seq, POSE.frame);
  const GINTO = new Map();
  const gearInto = (b) => {
    if (!GINTO.has(b)) GINTO.set(b, K.inverse34(GTP[b]));
    return GINTO.get(b);
  };

  if (V.helmet) {
    const { mdl: helmetOnly, n: helmetN } = only(donor, (t) => HELMET_TEX.has(t.tex));
    built = K.graft(built, helmetOnly,
      (mesh) => HELMET_TEX.has(donorMd.textures[mesh.skinref]?.name),
      { bodypart: 0, model: 0 }, headMove, { missing: "ancestor" });
    console.log(`  helmet on: ${helmetN} triangles over ${HELMET_TEX.size} textures, `
      + `taken to ${HEAD_XSCALE}x deep / ${HEAD_YSCALE}x wide about (${headCentre.map((v) => v.toFixed(1)).join(", ")})`);
  }

  /*
   * THE PLATES ARE DROPPED AND TILTED ONTO HER SHOULDER. THEY ARE NOT SHRUNK.
   *
   * Shrinking was tried first, in the way that finally worked for ins_proletarian -- scale
   * about the plate's own centre, rest it on the surface beneath -- and it made them worse.
   * The premise does not hold here. On that donor the plate had nothing underneath it at
   * all; on her it has: the nearest point of her body to the left plate's middle is 0.8
   * units away and to the right plate's 0.6. Scaling them about their centres only pulled
   * two small fins up off her arms.
   *
   * What is actually wrong is the SLOPE. Measured band by band with the plates taken off,
   * the top of his shoulder runs 28.6, 28.1, 26.7, 26.0, 26.1, 25.4, 24.3 as |y| goes 5 to
   * 11, and hers runs 27.6, 25.6, 25.7, 24.2, 25.1, 24.6, 21.6 -- lower at every band, by
   * one unit inboard growing to nearly three at the outer end. Over the span that is -46.5
   * degrees on him against -52.2 on her. His armoured shoulder is a broad shelf and hers
   * falls away, so a plate built flat for him stands off her back like a tray.
   *
   * So each plate drops by the height difference and tilts by the slope difference, about
   * its own centre and about the FORWARD axis, which is the one the shoulder slopes across.
   * Nothing is scaled: the ask is for them to take in more of her shoulder, not less, and
   * tilting the outboard end down is what wraps them around it.
   */
  const PLATE_DROP = 1.2;     // units down, from the height difference at the shoulder
  const PLATE_TILT = 6.0;     // degrees, outboard end down: -52.2 on her against -46.5 on him

  /*
   * And taken in FRONT TO BACK, which is the measurement that explains the rear view.
   *
   * She is far shallower than he is through the chest: at shoulder height his trunk runs
   * x -4.7..7.8 and hers -1.1..6.8, so her back is three and a half units in front of his.
   * The plate spans x -3.5..6.6, built to reach his back -- so its rear corner hung two and
   * a half units out in open air behind her, which is what made the thing read as a tray
   * bolted to her shoulder rather than as armour on it.
   *
   * The two numbers are solved for rather than picked: scaling the plate's span about its
   * own centre by s and shifting it forward by f, asking the back corner to land on her
   * back and the front corner on her front gives s = 0.78 and f = 1.30.
   */
  const PLATE_XSCALE = 0.78;
  const PLATE_FWD = 1.30;

  for (const plate of (V.plates ? PLATES : [])) {
    const { mdl: plateOnly, n } = only(donor, (t) => t.tex === plate.tex && inBox(t.mid, plate.box));
    if (!n) throw new Error(`found no pauldron on ${plate.tex}: the donor has changed`);

    // The plate's own centre, in the world both models stand in: what it turns about.
    let cx = 0, cy = 0, cz = 0, c = 0;
    K.dropTriangles(donor, (t) => {
      if (t.tex !== plate.tex || !inBox(t.mid, plate.box)) return false;
      cx += t.mid[0]; cy += t.mid[1]; cz += t.mid[2]; c++;
      return false;
    }, POSE);
    const centre = [cx / c, cy / c, cz / c];

    // Turned so the OUTBOARD end goes down, whichever side this plate is on.
    const th = (centre[1] > 0 ? -1 : 1) * PLATE_TILT * Math.PI / 180;
    const cs = Math.cos(th), sn = Math.sin(th);

    const targetNames = K.bones(built).map((b) => b.name);
    const TP = K.poseAt(built, POSE.seq, POSE.frame);
    const INTO = new Map();

    built = K.graft(built, plateOnly,
      (mesh) => donorMd.textures[mesh.skinref]?.name === plate.tex,
      { bodypart: 0, model: 0 },
      (p, boneName) => {
        const b = targetNames.indexOf(boneName);
        if (b < 0) return p;
        if (!INTO.has(b)) INTO.set(b, K.inverse34(TP[b]));
        const w = K.apply34(TP[b], p);
        const d = [0, 1, 2].map((k) => w[k] - centre[k]);
        const q = [
          centre[0] + d[0] * PLATE_XSCALE + PLATE_FWD,
          centre[1] + d[1] * cs - d[2] * sn,
          centre[2] + d[1] * sn + d[2] * cs - PLATE_DROP,
        ];
        return K.apply34(INTO.get(b), q);
      },
      { missing: "ancestor" });

    console.log(`  pauldron on: ${n} triangles off ${plate.tex}, `
      + `centre (${centre.map((v) => v.toFixed(1)).join(", ")}) dropped ${PLATE_DROP}, tilted ${(th * 180 / Math.PI).toFixed(1)} deg, `
      + `taken to ${PLATE_XSCALE}x deep and moved ${PLATE_FWD} forward`);
  }

  if (V.plates) {
    // The shins. Her legs run about a unit narrower than his at that height and half a unit
    // shallower, so they come in by that much and no more -- a shin plate that is taken in
    // hard stops reaching round the leg and turns into a stripe down the front of it.
    {
      const { mdl: shinOnly, n } = only(donor, (t) => t.tex === SHINS.tex && inBox(t.mid, SHINS.box));
      if (!n) throw new Error(`found no shin plates on ${SHINS.tex}: the donor has changed`);

      let cx = 0, c = 0;
      K.dropTriangles(donor, (t) => {
        if (t.tex === SHINS.tex && inBox(t.mid, SHINS.box)) { cx += t.mid[0]; c++; }
        return false;
      }, POSE);
      const cxm = cx / c;

      const names2 = K.bones(built).map((bb) => bb.name);
      const TP2 = K.poseAt(built, POSE.seq, POSE.frame);
      const I2 = new Map();
      built = K.graft(built, shinOnly,
        (mesh) => donorMd.textures[mesh.skinref]?.name === SHINS.tex,
        { bodypart: 0, model: 0 },
        (pp, boneName) => {
          const bi = names2.indexOf(boneName);
          if (bi < 0) return pp;
          if (!I2.has(bi)) I2.set(bi, K.inverse34(TP2[bi]));
          const w = K.apply34(TP2[bi], pp);
          return K.apply34(I2.get(bi), [
            cxm + (w[0] - cxm) * SHIN_XSCALE,
            AXIS_Y + (w[1] - AXIS_Y) * SHIN_YSCALE,
            w[2],
          ]);
        },
        { missing: "ancestor" });
      console.log(`  shin plates on: ${n} triangles off ${SHINS.tex}, `
        + `taken to ${SHIN_XSCALE}x deep / ${SHIN_YSCALE}x wide`);
    }
  }

  // -- 6. the neck cuff: NOT grafted, and why --------------------------------
  /*
   * HIS COLLAR CANNOT BE CUT OUT OF HIM AS A CLEAN RING, so she does not get one.
   *
   * It was tried twice. Taken wide -- everything above z 27.5 inside |y| 5.5 -- it came to
   * 69 triangles over five sheets, of which only 55 were cuff and the rest torn corners of
   * his chest plate; brought across they stood out of her collar as black shards and crossed
   * the pauldrons. Taken narrow -- the 52 on 05.bmp alone, inside |y| 4.5 -- it was no
   * better, because what looks like a cuff on him is not a separate ring at all. It is the
   * top of a vest that runs on into his shoulder straps, so every box tight enough to miss
   * the straps cuts straight through them and leaves the sliced edges facing out. There is
   * no box that takes a cuff and nothing else, because there is no cuff to take.
   *
   * Doing it properly means building a collar rather than borrowing one -- a ring of new
   * geometry round her neck, textured off his vest. That is real work and worth doing on
   * purpose, not smuggled in behind a graft.
   *
   * What the rear view actually needed was the HELMET taken in, and that is done above: the
   * skirt no longer flares out past her back, and the neck plug underneath it is painted
   * down to shadow so what you see up inside the helmet reads as the inside of a collar --
   * which is what it did before any of this was attempted.
   */

  // -- 6b. his EQUIPMENT, as real geometry -------------------------------------
  /*
   * THE GEAR COMES ACROSS THROUGH meshOf AND NOT THROUGH graft, AND THAT IS THE WHOLE
   * REASON IT FITS.
   *
   * GoldSrc holds 2048 normals a submodel and she has exactly one. Measured from her at
   * 1325/1435, with the insurgent belt, bandoliers and pauldrons:
   *
   *     graft,  gear + pauldrons        1997 / 2172   -- 124 over, refused
   *     graft,  gear alone              1917 / 2060   --  12 over, refused
   *     meshOf at 179, gear             1917 / 2000   --  fits
   *
   * graft carries the donor's normals across unchanged. meshOf works them out again and
   * merges any that meet inside the smoothing angle, which on a belt full of pouches is
   * most of them -- 565 normals against graft's 737, for identical geometry.
   *
   * Culling the part of her the rig hides was tried first and frees NOTHING: 400 of her
   * triangles sit inside the rig's footprint, and dropping 179, 278, 386 or 496 of them
   * left the model at 1997/2172 every time. dropTriangles removes triangles but does not
   * compact the vertex and normal tables, so hidden geometry costs its budget whether it
   * is drawn or not.
   */
  const GEAR_SMOOTH = 179;

  /*
   * THE GEAR IS SHRINK-WRAPPED ONTO HER, NOT COPIED ONTO HER.
   *
   * It was built around a man and it does not fit a different body just because the
   * skeleton matches: his pauldrons sat where her shoulders are not, his bandoliers passed
   * through her chest, and his belt pouches hung off her hips in the air.
   *
   * A single scale cannot fix that, and the measurements say so plainly -- asked band by
   * band how much narrower she is, the answer ranges from 0.41 to 1.66 depending on the
   * height, because the two models do not distribute their geometry the same way. There
   * is no one number.
   *
   * So each point of the gear is re-seated instead. Every vertex is asked how far it
   * stands PROUD of the body it was built for, measured along that body's own surface
   * normal -- a buckle lying on the belt is half a unit out, a bandolier crossing the
   * chest is one and a half. It is then placed that same distance off the matching point
   * of HER surface. A belt that hugged him hugs her; a pouch that stood out from him
   * stands out the same from her.
   *
   * The two surfaces are matched by nearest point, which is sound here because both are
   * humanoids standing in the same place on the same skeleton -- the same reason the
   * colour transfer works at all.
   */
  function bodyPoints(mdl, skipTexes) {
    const md = K.readMdl(mdl);
    const BP = K.poseAt(mdl, POSE.seq, POSE.frame);
    const rot = (b, v) => [0, 1, 2].map((r) => BP[b][r][0] * v[0] + BP[b][r][1] * v[1] + BP[b][r][2] * v[2]);
    const out = [];
    for (const bp of md.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
      const tex = md.textures[me.skinref]?.name;
      if (skipTexes.includes(tex)) continue;
      for (const t of K.readMesh(mdl, mo, me)) {
        const w = t.map((c) => K.apply34(BP[c.bone], c.p));
        const n = [0, 1, 2].map((k) => t.reduce((a, c) => a + rot(c.bone, c.n)[k], 0) / 3);
        const L = Math.hypot(n[0], n[1], n[2]) || 1;
        out.push({
          p: [0, 1, 2].map((k) => (w[0][k] + w[1][k] + w[2][k]) / 3),
          n: n.map((v) => v / L),
        });
      }
    }
    return out;
  }

  const nearestOf = (cloud, q) => {
    let best = null, bd = Infinity;
    for (const e of cloud) {
      const d = (e.p[0] - q[0]) ** 2 + (e.p[1] - q[1]) ** 2 + (e.p[2] - q[2]) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };

  /*
   * THE GEAR GOES ON WHERE IT SAT, WITH ONE EXPLICIT NUDGE PER PIECE.
   *
   * Three automatic fits were tried and every one made it worse, so the measurement that
   * settled it is recorded here instead:
   *
   *     the pauldron sits at |y| 9.3 on him
   *     HIS shoulder surface reaches |y| 9.8 and 8.7
   *     HER shoulder surface reaches |y| 11.1 and 10.7
   *
   * SHE IS WIDER AT THE SHOULDER THAN HE IS -- her arms hang further out. So the plate was
   * never too big for her, it was sitting INSIDE her arm, which is exactly what "the
   * pauldrons sink into the shoulders" is. Every fit that scaled toward the body axis, or
   * preserved a standoff from a narrower donor, moved it further in and buried it deeper.
   *
   * What was tried, so it is not tried again:
   *   nearest-point shrink-wrap -- discontinuous, came out lumpy, and lumpy stops meshOf
   *     merging normals: 2256 against 1940, over the limit, for a worse belt.
   *   radial take-in about the axis -- she is not uniformly smaller, so it pushed gear
   *     into her wherever she is not, and she has a bust where he is flat.
   *   cylindrical standoff by radius map -- the map mixes her arm and her torso at
   *     shoulder height, so it read her as narrow where she is wide.
   *
   * A nudge per piece, in numbers that can be read and argued with, is both simpler and
   * better. `out` moves a piece away from the centre line; `drop` lowers it; `flip`
   * reverses its winding.
   */
  /*
   * EVERY PIECE IS FLIPPED, because the winding convention differs between these donors
   * and this base -- not just for one piece of it.
   *
   * Measured, as the share of each piece's triangles whose normal points away from the
   * body, on the donor against this build before the fix:
   *
   *     pauldron   75% on him   77% here   -- right, it was already flipped
   *     bandolier  69% on him   28% here   -- inside out
   *     medkit     54% on him   34% here   -- inside out
   *     gasmask    95% on him    5% here   -- inside out, completely
   *
   * An inside-out mesh is not invisible and does not read as a hole. You see its FAR
   * side: the bandolier showed as a smear that did not cross the chest, and the gasmask
   * showed as the inside of itself, which looks exactly like a face that has been taken
   * off. That is why neither was obvious and why the first fix only caught the plate.
   */
  const GEAR_FIT = {
    "ins_prole_pauldron.bmp": { out: 1.9, drop: 0.4, flip: true, bust: 0 },
    "ins_prole_gear.bmp":     { out: 0.15, drop: 0.0, flip: true, bust: 0, conform: true },
    "ins_medkit.bmp":         { out: 0.15, drop: 0.0, flip: true, bust: 0, conform: true },
    "head.bmp":               { out: 0.0,  drop: 0.0, flip: true, bust: 0 },
  };

  /*
   * `bust` is a FORWARD push, and only over the height where it is needed.
   *
   * Measured front-to-back, how far each chest reaches forward:
   *
   *     z 13-17   him 7.8   her 7.2    -- she is BEHIND him at the waist
   *     z 17-21   him 7.7   her 9.2    -- and 1.5 in front of him at the bust
   *     z 21-25   him 7.2   her 8.7
   *
   * A bandolier lying flat on his chest therefore passes straight through hers, which is
   * what sank the straps. A uniform forward push is no good either -- it would lift the
   * belt off her waist, where she is the one further back. So it is applied over the band
   * where she projects and faded out above and below it.
   */
  const BUST_LO = 15.0, BUST_IN = 18.0, BUST_OUT = 25.0, BUST_HI = 27.5;

  const fitGear = (w, texName) => {
    const f = GEAR_FIT[texName] ?? { out: 0, drop: 0, bust: 0 };
    const dy = w[1] - AXIS_Y;
    const push = (f.out ?? 0) * (dy >= 0 ? 1 : -1);

    let fwd = 0;
    if (f.bust) {
      const z = w[2];
      const t = z <= BUST_LO || z >= BUST_HI ? 0
        : z < BUST_IN ? (z - BUST_LO) / (BUST_IN - BUST_LO)
        : z <= BUST_OUT ? 1
        : (BUST_HI - z) / (BUST_HI - BUST_OUT);
      // Only what is on the FRONT of her: a strap round her back must not be pushed
      // through it.
      const onFront = clamp((w[0] - 1.0) / 3.0);
      fwd = f.bust * t * onFront;
    }

    return [w[0] + fwd, w[1] + push, w[2] - (f.drop ?? 0)];
  };

  /*
   * CONFORMING A STRAP TO HER, which the nudges above cannot do.
   *
   * `out` and `bust` move a whole piece rigidly, which is right for a pauldron -- a rigid
   * plate that sits ON a shoulder -- and wrong for a bandolier, which is webbing that
   * LIES ALONG a chest. Moved rigidly it stays the shape of his chest and floats over
   * hers, which is what looks ugly.
   *
   * So each point of a conforming piece is put back where it belongs: the distance it
   * stood proud of HIS body, off the matching point of HERS.
   *
   * THE DISPLACEMENT IS THEN SMOOTHED, and that is the part that was missing when this
   * was tried before. Matching by nearest point is discontinuous -- the nearest point
   * JUMPS as a vertex crosses between her chest and her arm -- so the raw field has steps
   * in it, the strap came out lumpy, and because meshOf merges normals by the angle
   * between faces a lumpy strap also stopped merging: 2256 normals against 1940, over the
   * limit, for a worse belt. Averaging each displacement with its neighbours' removes the
   * steps while leaving the overall move intact, so the strap bends to her without
   * breaking up.
   *
   * Worked out per unique POSITION rather than per corner, or triangles that share a
   * vertex would pull apart and tear the mesh open.
   */
  const CONFORM_R = 3.2;        // how far a displacement is averaged over, in units
  const CONFORM_LIFT = 0.25;    // extra clearance off her, so webbing does not cut in

  /*
   * AND MORE OF IT AT THE BACK, because that is where it was actually cutting in.
   *
   * Measured on the finished medic: 62 of the rig's 481 triangles were sunk INTO her, 41
   * of them behind x 1.5, the deepest by 1.63 units. Her back is not his -- a flatter
   * spine, different shoulderblades -- so preserving the standoff he gave it is not enough
   * there, while a lift big enough for the back would float the pouches off her hips.
   *
   * So it is ramped: nothing at the front, rising to clear the deepest bite at the rear.
   */
  const CONFORM_REAR = 1.7;
  const REAR_FROM = 4.0, REAR_FULL = 1.0;

  function bodyCloud(mdl, skipTexes) {
    const md = K.readMdl(mdl);
    const BP = K.poseAt(mdl, POSE.seq, POSE.frame);
    const rot = (b, v) => [0, 1, 2].map((r) => BP[b][r][0] * v[0] + BP[b][r][1] * v[1] + BP[b][r][2] * v[2]);
    const out = [];
    for (const bp of md.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
      const tex = md.textures[me.skinref]?.name;
      if (skipTexes.includes(tex)) continue;
      for (const t of K.readMesh(mdl, mo, me)) {
        const w = t.map((c) => K.apply34(BP[c.bone], c.p));
        const n = [0, 1, 2].map((k) => t.reduce((a, c) => a + rot(c.bone, c.n)[k], 0) / 3);
        const L = Math.hypot(n[0], n[1], n[2]) || 1;
        out.push({ p: [0, 1, 2].map((k) => (w[0][k] + w[1][k] + w[2][k]) / 3), n: n.map((v) => v / L) });
      }
    }
    return out;
  }

  const nearestIn = (cloud, q) => {
    let best = null, bd = Infinity;
    for (const e of cloud) {
      const d = (e.p[0] - q[0]) ** 2 + (e.p[1] - q[1]) ** 2 + (e.p[2] - q[2]) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };

  const needConform = (V.gear ?? []).some((t) => GEAR_FIT[t]?.conform);
  const hisCloud = needConform ? bodyCloud(donor, [...(V.gear ?? []), ...(V.skipTex ?? [])]) : null;
  const herCloud = needConform ? bodyCloud(built, []) : null;

  /** The smoothed displacement for every unique vertex of one conforming piece. */
  function conformMap(texName) {
    const key = (w) => w.map((v) => v.toFixed(3)).join(",");
    const seen = new Map();
    K.dropTriangles(donor, () => false, POSE);          // keeps POSE warm; no-op
    for (const bp of donorMd.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
      if (donorMd.textures[me.skinref]?.name !== texName) continue;
      for (const t of K.readMesh(donor, mo, me)) {
        for (const c of t) {
          const w = K.apply34(donorPose[c.bone], c.p);
          const k = key(w);
          if (!seen.has(k)) seen.set(k, { w, d: null });
        }
      }
    }
    const list = [...seen.values()];
    // raw target displacement
    for (const e of list) {
      const h = nearestIn(hisCloud, e.w);
      const f = nearestIn(herCloud, h ? h.p : e.w);
      if (!h || !f) { e.d = [0, 0, 0]; continue; }
      /*
       * A little MORE clearance than it had on him.
       *
       * The standoff is preserved exactly, which is right in principle and leaves the
       * webbing grazing her at the back, where her spine and shoulderblades are shaped
       * differently from his and a strap that merely touched him cuts into her. A quarter
       * of a unit is below what anyone sees as a gap and above what shows as clipping.
       */
      const rear = CONFORM_REAR * clamp((REAR_FROM - e.w[0]) / (REAR_FROM - REAR_FULL));
      const stand = CONFORM_LIFT + rear
        + (e.w[0] - h.p[0]) * h.n[0] + (e.w[1] - h.p[1]) * h.n[1] + (e.w[2] - h.p[2]) * h.n[2];
      const target = [0, 1, 2].map((k2) => f.p[k2] + f.n[k2] * stand);
      e.d = [0, 1, 2].map((k2) => target[k2] - e.w[k2]);
    }
    // smoothed, so the steps where the nearest point jumped do not survive
    const sm = new Map();
    for (const e of list) {
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const o of list) {
        const d2 = (o.w[0] - e.w[0]) ** 2 + (o.w[1] - e.w[1]) ** 2 + (o.w[2] - e.w[2]) ** 2;
        if (d2 > CONFORM_R * CONFORM_R) continue;
        sx += o.d[0]; sy += o.d[1]; sz += o.d[2]; n++;
      }
      sm.set(key(e.w), n ? [sx / n, sy / n, sz / n] : e.d);
    }
    return sm;
  }

  for (const texName of (V.gear ?? [])) {
    const conform = GEAR_FIT[texName]?.conform ? conformMap(texName) : null;
    const ckey = (w) => w.map((v) => v.toFixed(3)).join(",");
    const src = [], tris = [];
    for (const bp of donorMd.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
      const tex = donorMd.textures[me.skinref];
      if (tex?.name !== texName) continue;
      for (const t of K.readMesh(donor, mo, me)) {
        src.push(t);
        /*
         * Bones BY NAME, because these donors are not on her skeleton: the insurgents
         * carry 34 and 40 bones to her 22, the extras being finger bones and a row of
         * dummies. A belt hangs from none of them, so anything she lacks falls back to
         * the spine -- which is where a chest rig belongs anyway.
         */
        tris.push(t.map((c) => {
          const want = donorNames[c.bone];
          let bi = targetNames2.indexOf(want);
          if (bi < 0) { bi = targetNames2.indexOf("Bip01 Dorso3"); }
          if (bi < 0) { bi = 0; }
          return {
            p: (() => {
              const w = K.apply34(donorPose[c.bone], c.p);
              if (!conform) return fitGear(w, texName);
              const d = conform.get(ckey(w)) ?? [0, 0, 0];
              return fitGear([w[0] + d[0], w[1] + d[1], w[2] + d[2]], texName);
            })(),
            uv: [c.s / tex.width, c.t / tex.height],
            bone: bi, to: gearInto(bi),
          };
        }));
        /*
         * Reversed where the piece needs it. meshOf settles winding against the reference
         * triangles it is given, and between THESE two models that answer comes out
         * backwards for the plates -- which does not read as a hole, it reads as a tidy
         * plate belonging to the other shoulder, which is why it is so easy to miss.
         */
        if (GEAR_FIT[texName]?.flip) {
          const t2 = tris[tris.length - 1];
          tris[tris.length - 1] = [t2[0], t2[2], t2[1]];
        }
      }
    }
    if (!tris.length) throw new Error(`found no ${texName} on ${V.donor}: the donor has changed`);

    const tex = K.textureOf(donor, texName);
    const where = { bodypart: 0, model: 0 };
    const at = K.readMdl(built).bodyparts[0].models[0].meshes.length;
    /*
     * The SOURCE triangles are handed in as meshOf's winding reference. Told nothing it
     * assumes the generators' convention, which is the opposite of these donors' -- and
     * an inside-out belt does not read as a hole, it reads as a correctly made belt
     * belonging to somebody facing the other way, which is what made it so hard to see
     * the last two times.
     */
    built = K.replaceMesh(
      K.addMesh(built, where), { ...where, mesh: at },
      K.meshOf(src, tris, tex, tris[0][0].bone, GEAR_SMOOTH), tex,
    );
    const m0 = K.readMdl(built).bodyparts[0].models[0];
    console.log(`  gear on: ${tris.length} triangles off ${texName}  -> ${m0.numverts}/${m0.numnorms}`);
  }

  // -- 7. his stance ----------------------------------------------------------
  /*
   * HIS IDLE ANIMATIONS, COPIED ONTO HER.
   *
   * This is only possible because the two files agree exactly where they have to: 171
   * sequences each, the same names in the same order, the same 22 bones in the same order,
   * and not one animation kept in another file. replaceSequence writes every animation of
   * the file again, so a single sequence held elsewhere would fail the lot.
   *
   * Only the idles are taken. Her walk and run stay hers, because that is what was asked
   * for -- widen IDLE_ONLY to false and the whole 171 come across instead, which the lists
   * matching makes a one-line change rather than a project.
   */
  const IDLE_ONLY = true;
  {
    const mine = K.sequences(built);
    const wanted = mine
      .map((sq, i) => ({ sq, i }))
      .filter(({ sq }) => !IDLE_ONLY || /idle/i.test(sq.name));

    /*
     * THE BONES ARE MATCHED BY NAME, not taken in order.
     *
     * Frames are indexed BY BONE NUMBER, and a donor need not carry her skeleton. The
     * proletarian has 34 bones to her 22 -- the extra twelve are finger bones from
     * "Bip01 Dito mano SX0" onwards -- so copied straight across, bone 18 would take his
     * right clavicle's motion onto a finger and the model would fold inside out, with
     * check() reporting nothing wrong because nothing is.
     *
     * So each of her bones takes the motion of HIS bone of the same name, and any bone he
     * does not have keeps the motion it already had. Against repuheavy, whose skeleton is
     * hers exactly, this resolves to the straight copy it replaced.
     */
    const herBones = K.bones(built).map((b) => b.name);
    const hisBones = K.bones(donor).map((b) => b.name);
    const fromHim = herBones.map((b) => hisBones.indexOf(b));
    const missing = fromHim.filter((i) => i < 0).length;
    if (missing) {
      throw new Error(`${V.donor ?? "repuheavy"} is missing ${missing} of her bones, `
        + "so his stance cannot be put on her whole");
    }

    let done = 0;
    for (const { sq, i } of wanted) {
      const j = K.sequenceAt(donor, sq.name);
      if (j < 0) continue;
      // Every blend of the animation, not just the first: a sequence with two is aimed by
      // the engine between them, and replacing one of a pair leaves it aiming at hers.
      const blends = [];
      for (let b = 0; b < Math.max(1, sq.blends ?? 1); b++) {
        const his = K.readSequence(donor, j, b).frames;
        blends.push(his.map((hf) => herBones.map((_, bi) => hf[fromHim[bi]])));
      }
      built = K.replaceSequence(built, i, blends.length > 1
        ? { frames: blends[0], blends }
        : { frames: blends[0] });
      done++;
    }
    console.log(`  stance: ${done} of his animations copied onto her${IDLE_ONLY ? " (the idles)" : ""}`);
  }

  // -- 8. check and write -----------------------------------------------------
  const r = K.check(built, "goldsrc");
  const lay = isEngineLayout(built);
  const m = K.readMdl(built);

  let tris = 0;
  for (const bp of m.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) tris += me.numtris;
  // A model can hold its meshes and its vertex counts and still carry no triangles at all:
  // it passes check, reports the right numbers and draws nothing. That is what a graft
  // whose pick never matched produced on the reshape, and nothing else noticed.
  if (tris < 1) throw new Error(`${V.name} has ${tris} triangles: it would draw nothing`);

  const worst = Math.max(...m.bodyparts.flatMap((bp) => bp.models.map((mo) => Math.max(mo.numverts, mo.numnorms))));
  const per = m.bodyparts.flatMap((bp) => bp.models.map((mo) => `${mo.numverts}/${mo.numnorms}`)).join("  ");
  console.log(`  ${V.name}  ${per}  worst ${worst}/2048  ${tris} tris  ${m.textures.length} textures  `
    + `check ${r.errors?.length ?? 0} errors  engineLayout ${lay}`);
  for (const e of (r.errors ?? [])) console.log("      ERROR: " + e);
  if (r.errors?.length) throw new Error(`${V.name} did not come out sound`);
  if (!lay) throw new Error(`${V.name} is not in engine layout: a dedicated server dies on it at a change of level`);
  if (V.name.length > 22) throw new Error(`${V.name} is ${V.name.length} characters: TS truncates at 22`);

  mkdirSync(join(OUT, V.name), { recursive: true });
  writeFileSync(join(OUT, V.name, `${V.name}.mdl`), built);

  return built;
}

// ===========================================================================
// THE TWO OF THEM
// ===========================================================================
/*
 * `braid: "off"` because the helmet covers the back of her head and the braid came out
 * through it; the bare one keeps it, which is the point of asking for the bare one.
 *
 * Both names are inside the 22 characters TS truncates a model path at -- 13 and 18 --
 * and that limit is fatal rather than cosmetic: over it the server dies at Mod_NumForName
 * with nothing in the log.
 */
const VARIANTS = [
  // --- female_merc wearing repuheavy -------------------------------------------------
  { name: "repuheavy_fem",        helmet: true,  plates: true },
  { name: "repuheavy_fem_nhelm",  helmet: false, plates: true },
  // 20 characters, inside the 22 TS truncates a model path at.
  { name: "repuheavy_bfem_nhelm", helmet: false, plates: true, blonde: true },

  /*
   * --- female_merc wearing the proletarian -------------------------------------------
   *
   * `plates: false` because he has none: no helmet, no pauldrons, no shin plates. Only
   * his COLOUR moves, which is the whole of the look -- a navy suit jacket over black
   * trousers. Nothing is grafted, so his twelve extra finger bones never come up.
   *
   * `push: 0.6` and not repuheavy's 1.8. That number is how far out along her own normal
   * the donor is asked, and it exists because repuheavy is a slab -- 7.0 half-width at
   * every band -- so a question asked at her surface finds the RIM of his armour rather
   * than its face. The proletarian measures 6.5 to 6.9 against her 5.7 to 6.9, within a
   * unit at most bands, and 1.8 would step clean past him.
   *
   * `skipTex` keeps his FACE out of the surface. agentface.bmp is his head, z 25.9..36.2,
   * and she keeps her own -- without this her shoulders would sample his jaw.
   *
   * `paintFade` is the armoured pair's [25.5, 27.0] after all. His jacket reaches z 28, so
   * the first attempt faded out at [26.5, 28.0] to match it -- and that painted her throat
   * to the jaw, leaving no neck at all and reading as a collar that had swallowed her chin.
   * A collar sits where a collar sits, armoured or not; what reaches z 28 on him is the
   * jacket standing off a thicker neck than hers.
   *
   * Short names on purpose. "proletarian_fem" would fit at 15, but
   * "proletarian_fem_soot_blood" is 26 and the 22-character cap is fatal --
   * "prole_fem_soot_blood" is 20, so damaged variants stay possible without a rename.
   */
  { name: "prole_fem",  helmet: false, plates: false, donor: "proletarian",
    push: 0.6, skipTex: ["agentface.bmp"], paintFade: [25.5, 27.0], shade: 0, skipSkin: true, mirrorFrom: "SX" },
  { name: "prole_bfem", helmet: false, plates: false, donor: "proletarian", blonde: true,
    push: 0.6, skipTex: ["agentface.bmp"], paintFade: [25.5, 27.0], shade: 0, skipSkin: true, mirrorFrom: "SX" },

  /*
   * --- female_merc as an INSURGENT -----------------------------------------------------
   *
   * The same cloth transfer as the proletarian pair, plus the EQUIPMENT as real geometry.
   * The gear sits on textures of its own on these donors -- 888 triangles of belt and
   * bandoliers, 88 of pauldron, 481 of medic rig -- so naming the texture selects it
   * exactly, the way 05.bmp and 04.bmp select repuheavy's plates on her.
   *
   * `skipTex` keeps the gear OUT of the sampled surface as well as naming it for the
   * graft. Anything that arrives as geometry must not also be painted on the body
   * underneath it, or she wears it twice -- that is the second pauldron that appeared on
   * her deltoid, and a flat bandolier painted under a real one would read the same way.
   * Their faces go with it, since she keeps her own head.
   */
  { name: "ins_prole_fem",  helmet: false, plates: false, donor: "ins_proletarian",
    gear: ["ins_prole_gear.bmp", "ins_prole_pauldron.bmp"],
    push: 0.6, shade: 0, skipSkin: true, mirrorFrom: "SX", armSmooth: ARM_SMOOTH_WIDE,
    paintFade: [25.5, 27.0],
    skipTex: ["agentface.bmp", "ins_prole_gear.bmp", "ins_prole_pauldron.bmp"] },

  { name: "ins_prole_bfem", helmet: false, plates: false, donor: "ins_proletarian", blonde: true,
    gear: ["ins_prole_gear.bmp", "ins_prole_pauldron.bmp"],
    push: 0.6, shade: 0, skipSkin: true, mirrorFrom: "SX", armSmooth: ARM_SMOOTH_WIDE,
    paintFade: [25.5, 27.0],
    skipTex: ["agentface.bmp", "ins_prole_gear.bmp", "ins_prole_pauldron.bmp"] },

  /*
   * Masked rather than helmeted, so there is no bare-faced version of her to build. The
   * mask is PAINTED -- see the pass for why a grafted head cannot be afforded here.
   */
  /*
   * HIS GASMASK, GRAFTED -- not a balaclava painted on her own face.
   *
   * The painted version read as a missing face rather than as a mask, and it threw away
   * the thing that makes this model what it is: ins_medic wears a GASMASK, with a filter
   * and lenses, and that is geometry.
   *
   * It was ruled out on cost at first, and that was the wrong head to cost it against --
   * TPS_Masked_Female is 696 triangles, but ins_medic's OWN head is 281, and this model
   * sits at 1655/1576 with over four hundred normals to spare. It fits with room left.
   *
   * It takes no `out` or `bust` nudge: head.bmp has no entry in GEAR_FIT, so it transfers
   * exactly where it sat. The head bone is the same bone on both, so that is where her
   * head is.
   */
  { name: "ins_medic_fem",  helmet: false, plates: false, donor: "ins_medic_belt", dropHead: true,
    gear: ["ins_medkit.bmp", "head.bmp"],
    push: 0.6, shade: 0, skipSkin: false, mirrorFrom: "SX", armSmooth: ARM_SMOOTH_WIDE,
    paintFade: [25.5, 27.0],
    skipTex: ["head.bmp", "ins_medkit.bmp"] },

  /*
   * There is no ins_medic_bfem, and there should not be. The gasmask covers her head and
   * the ponytail is gone with it, so a blonde version differs from the brown one in not
   * one visible pixel -- it would be the same model under a second name, taking a slot in
   * a class pool and a place in the precache table for nothing.
   */

  /*
   * ins_prole_fem_helm IS NOT BUILT, and the number is the reason.
   *
   * Helmet and full gear together come to 2274 VERTICES against the 2048 GoldSrc allows.
   * Normals are not the problem -- routing the helmet through meshOf at 179 like the gear
   * brought those down to 2217 -- it is the vertex table, and meshOf already shares every
   * position it can.
   *
   * The 226 it is over is almost exactly her own head, which the helmet replaces.
   * dropTriangles takes the head's TRIANGLES out and leaves its VERTICES in the table, so
   * taking her face off pays for nothing. The only thing that reclaims them is rebuilding
   * the body through putBody, which compacts -- a full mesh rebuild with its own bones and
   * UVs, and real work rather than a constant.
   *
   * Dropping the pauldrons saves 80 and leaves it 146 over, so it is not close enough to
   * trim into. Reported rather than shipped quietly in some reduced form.
   */
];

const made = [];
for (const V of VARIANTS) {
  console.log(`
  ${V.name}:`);
  made.push([V.name, build(V)]);
}

// -- look at them -----------------------------------------------------------
const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };

// Beside both parents: whether this reads as his soldier is judged against him, and
// whether it still reads as her is judged against her.
put("repuheavy_fem.png", K.lineup(
  [["female_merc", base], ["repuheavy", donorOf("repuheavy").mdl], ...made],
  { ...POSE, yaws: [0, 90, 180], zoom: 1.5, width: 280, cols: 6 }));

/*
 * The head, from every side and from below.
 *
 * Below is the one that matters on the helmeted one. The helmet was built to sit on an
 * armoured collar and she has none, so a gap between the skirt and her neck, or a jaw left
 * poking out of it, shows from under the chin and almost nowhere else.
 */
for (const [name, mdl] of made) {
  const shots = [], labels = [];
  for (const [yaw, pitch, lbl] of [[0, 4, "front"], [55, 4, "left"], [125, 4, "right"], [180, 4, "back"], [0, -34, "below"], [0, 40, "above"]]) {
    shots.push(K.render(mdl, { ...POSE, yaw, pitch, zoom: 6.0, target: [2, 0, 30], width: 250, height: 290 }));
    labels.push(lbl);
  }
  put(`${name}_head.png`, K.tile(shots, 3, labels));
}

// The shoulders close, his beside theirs: the plates are the one piece that had to be
// fitted rather than simply dropped, and a plate sunk into a shoulder or floating off it
// shows from in front and from above and nowhere else.
{
  const shots = [], labels = [];
  for (const [name, mdl] of [["repuheavy", donorOf("repuheavy").mdl], ...made]) {
    for (const [yaw, pitch, lbl] of [[0, 10, "front"], [90, 10, "side"], [0, 55, "above"]]) {
      shots.push(K.render(mdl, { ...POSE, yaw, pitch, zoom: 3.4, target: [2, 0, 24], width: 250, height: 310 }));
      labels.push(`${name.replace("repuheavy", "rh")} ${lbl}`);
    }
  }
  put("repuheavy_fem_shoulder.png", K.tile(shots, 3, labels));
}

// A run, because the helmet and the plates ride bones that turn in motion where they do
// not in a pose -- if a plate is going to swing clear of her shoulder, it does it there.
for (const [name, mdl] of made) {
  put(`${name}_run.png`, K.strip(mdl, { seq: "run2", count: 6, cols: 6, width: 260, height: 400, yaw: 200 }));
}
