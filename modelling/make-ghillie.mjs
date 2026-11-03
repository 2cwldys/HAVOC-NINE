// repughillie: the MSR marksman -- forest green, flecktarn on the front, ghillie
// strands down the back.
//
//     node make-ghillie.mjs    -> ../export-mdl/repughillie/repughillie.mdl
//
// Built on `repuheavy`. A sniper seen from the front shows a camouflaged vest; from
// behind and above -- which is how a prone sniper is actually found -- the silhouette
// is broken up by strands. So the camo is painted and the strands are GEOMETRY,
// because paint cannot change an outline and the outline is the whole point.
//
// +x IS HIS FRONT on this donor. Measured, not assumed: painting the sign of the x
// normal and rendering shows the chest facing +x at yaw 0 and the back at yaw 180.
// merc agrees, the XCCP family does not, and repuheavy is a third family again --
// docs/PLAYER-MODELS.md records that the facing belongs to the donor.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, checked, clamp, texturesLast, POSE } from "./lib.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const base = load("repuheavy");

// ── the palette ────────────────────────────────────────────────────────────
// Forest green, and flecktarn's five: black, two greens, a red-brown and a pale
// grey-green. The pattern is clusters of small dots rather than big blobs, which is
// what separates flecktarn from every other camo at a glance.
const GREEN = [0.232, 0.300, 0.152], GREEN_LO = [0.082, 0.112, 0.060];
const FLK_BLACK = [0.042, 0.052, 0.036];
const FLK_DARK = [0.098, 0.138, 0.072];
const FLK_MID = [0.215, 0.268, 0.142];
const FLK_BROWN = [0.188, 0.142, 0.082];
const FLK_PALE = [0.330, 0.352, 0.252];

const STRAND_A = [0.118, 0.152, 0.080];
const STRAND_B = [0.205, 0.198, 0.112];
const STRAND_C = [0.078, 0.088, 0.052];

const lum = (c) => c[0] * 0.30 + c[1] * 0.60 + c[2] * 0.10;
const warm = (c) => c[0] - c[2];

// fbm3 takes a POINT ARRAY, not three numbers. Three numbers leave p[1] and p[2]
// undefined, every channel comes out NaN, and Math.round writes it as 0 -- a texture
// of pure black with nothing in the output to say why.
const n3 = (p, k, s, oct = 4) => W.fbm3(p, k, s, oct);

// ── 1. the uniform ─────────────────────────────────────────────────────────
// The donor is VERY dark -- its cloth sits at a median luminance of 0.078 and a
// ninetieth percentile of 0.176 -- so its folds live in a narrow band just above
// black and have to be stretched out of it. Mapping as though it ran 0..1 would
// flatten every crease in the model.
const fold = (rgb) => clamp((lum(rgb) - 0.02) / 0.20);

/**
 * Is this point inside the camouflage, yes or no.
 *
 * A HARD TEST, not a gradient. Fading the camo in over several units left every edge
 * of it a muddy half-green smear, and the model read as dirty rather than as
 * camouflaged -- the camo has to look like a garment with a hem, because that is what
 * it is.
 *
 * What it covers is what a ghillie actually covers: the vest front, the back, and the
 * upper arms. NOT the trousers, NOT the helmet, NOT the gloves or the boots -- a
 * ghillie goes ON OVER a uniform, and painting the lot of it green makes a soldier
 * look dipped rather than dressed.
 *
 *   torso        z 4..27   (hip to collar), front and back alike
 *   upper arms   z 14..25  shoulder to elbow, not the forearm
 */
function inCamo(p) {
  const y = Math.abs(p[1]);
  if (p[2] < 4.0 || p[2] > 27.0) {
    return false;
  }
  if (y < 8.0) {
    return true;
  }
  return (p[2] > 13.5 && p[2] < 25.5 && y < 12.0);
}

/**
 * Flecktarn: clusters of small dots in five colours.
 *
 * CALIBRATED TO WHAT fbm3 ACTUALLY RETURNS, which is nothing like 0..1 -- about
 * 0.28..0.76, and it shifts with k. Thresholds picked for a 0..1 range sit outside
 * the distribution almost everywhere and produce no pattern at all.
 *
 * Each colour is a separate high-frequency field with its own seed, laid down in
 * order so the darker ones end up on top. The frequencies sit close together on
 * purpose: flecktarn is one size of dot in several colours, not a hierarchy of blobs.
 */
function flecktarn(p, base_c) {
  let c = base_c;
  const dot = (k, seed, cut, col, amt) => {
    const v = clamp((n3(p, k, seed, 2) - cut) / 0.055);
    if (v > 0) c = W.mix(c, col, v * amt);
  };
  dot(2.6, 11, 0.496, FLK_MID, 0.90);
  dot(3.1, 23, 0.516, FLK_PALE, 0.55);
  dot(2.9, 37, 0.512, FLK_BROWN, 0.70);
  dot(3.4, 53, 0.520, FLK_DARK, 0.85);
  dot(4.2, 71, 0.536, FLK_BLACK, 0.80);
  return c;
}

const uniform = ({ p, n, rgb }) => {
  /*
   * ONE TEST DECIDES EVERYTHING: outside the garment, the donor is returned untouched.
   *
   * That keeps the trousers, the helmet, the gloves, the boots and every blue glowing
   * part exactly as they were, with no blending and no edge to go wrong -- rather
   * than painting the whole man and then trying to subtract the bits that should not
   * have been painted, which is what made this muddy.
   */
  if (!inCamo(p)) {
    return null;
  }

  // Skin, and the emissive blue -- the goggles, the shoulder flashes. Even inside the
  // garment these are left alone: the visor is what you read a player by at range.
  if (warm(rgb) > 0.10 && lum(rgb) > 0.25) {
    return null;
  }
  if (rgb[2] > rgb[0] + 0.06 && rgb[2] > 0.12) {
    return null;
  }

  // The donor is VERY dark -- its cloth sits at a median luminance of 0.078 -- so its
  // folds live in a narrow band just above black and have to be stretched out of it.
  const t = clamp(0.30 + 0.92 * fold(rgb));
  let c = W.mix(GREEN_LO, GREEN, t);

  // Flecktarn over the whole garment, front and back alike, at full strength.
  c = flecktarn(p, c);

  const grime = clamp((n3(p, 0.42, 91, 4) - 0.520) / 0.085);
  return W.mix(c, [0.082, 0.074, 0.052], grime * 0.30);
};

const { mdl: painted } = K.paint(base, uniform, { pose: POSE });
console.log("  uniform painted");

// ── 2. the ghillie strands ─────────────────────────────────────
// Rooted on the surface the model actually has, by collecting the points whose
// normals face BACKWARDS and thinning them, rather than by inventing positions on a
// guessed body shape. A strand that starts where the body is not looks exactly like
// what it is.
//
// The head is in range too, so strands sprout from the back of the skull as well as
// the back -- which is what stops the outline of a head reading as the outline of a
// head.
const roots = [];
K.paint(painted, ({ p, n }) => {
  // Back-facing, anywhere from the hip up.
  const back = n[0] < -0.26;

  /*
   * THE HELMET: top, back and sides, completely.
   *
   * Measured rather than guessed, because guessing got this wrong twice. Walking the
   * head by height and by normal direction says:
   *
   *     z 35..39   UP-facing, x -0.7..10.1    <- the crown, front to back
   *     z 29..35   FORWARD-facing, x 4.4..10.2 <- the face and the visor
   *
   * The crown reaches as far forward as the face does. So a rule that excluded
   * everything forward of x 5.5 at head height -- which is what was here -- deleted
   * the entire front half of the top of the helmet, and left it bare while the back
   * kept its strands. The two have to be told apart by WHICH WAY THEY FACE, not by
   * where they are.
   */
  const onHelmet = p[2] > 27.5 && (n[2] > 0.20 || Math.abs(n[1]) > 0.35 || n[0] < -0.20);

  /*
   * And the face is the forward-facing part at visor height, which is excluded at any
   * x: a strand rooted there hangs straight down over the one feature you identify a
   * player by.
   */
  if (n[0] > 0.30 && p[2] > 28.0 && p[2] < 36.0 && p[0] > 4.0) {
    return null;
  }

  /*
   * The FRONTS OF THE LEGS, which the backward test could never find.
   *
   * A real ghillie hangs off the thighs and shins as well as the back -- it is the
   * front of a man that has to disappear when he walks towards you. Boots are left
   * out: strands over the ankle catch on the stride and read as a mistake.
   */
  const legFront = n[0] > 0.26 && p[2] < 4.0 && p[2] > -26.0;

  if ((back || onHelmet || legFront) && p[2] > -26 && p[2] < 40 && Math.abs(p[1]) < 11) {
    roots.push({ p: [...p], n: [...n], crown: onHelmet });
  }
  return null;
}, { pose: POSE });

/*
 * Thinned to a minimum spacing, so they spread out instead of clumping wherever the
 * texture happens to be densest -- but the spacing is NOT UNIFORM.
 *
 * The shoulders, the pauldrons and the back of the neck get packed closer together,
 * because those are the parts that make a shape read as a ghillie rather than as a
 * cape: the outline anyone sees first is the one across the top of the shoulders.
 */
/*
 * Every strand belongs to a REGION, and each region has its own spacing and its own
 * share of the budget.
 *
 * A single sorted list truncated at the cap does not work, and failed exactly as you
 * would expect: sorting by density put the hood and the back first, those two filled
 * all 1006 between them, and the legs -- last in the order -- got nothing at all.
 * Quotas mean every part of him is covered whatever the others want.
 */
/*
 * Every strand belongs to a REGION, each with its own spacing and its own share of the
 * budget.
 *
 * THE BANDS ARE NARROW ON THE HEAD, AND THAT IS THE WHOLE POINT. Measuring the
 * candidate roots by height shows how lopsided they are:
 *
 *     z 27 .. 28.5   26,595 points   the collar
 *     z 28.5 .. 30   11,593          the nape
 *     z 30 .. 33      3,225          THE BACK AND SIDES OF THE HELMET
 *     z above 33      4,599          the dome
 *
 * A single quota covering the head walks that list in order, spends itself entirely on
 * the 26,595 at the collar, and never reaches the helmet at all -- which is why the
 * back of it kept coming out bare however large the number was. Narrow bands give the
 * small areas a share that the large ones cannot eat.
 */
const REGIONS = [
  { name: "nape",      space: 0.42, quota: 185, leaf: false },
  { name: "collar",    space: 0.58, quota: 125, leaf: false },
  { name: "shoulders", space: 0.66, quota: 150, leaf: false },
  { name: "back",      space: 0.76, quota: 290, leaf: false },
  { name: "legs",      space: 1.10, quota: 140, leaf: false },
];

function regionOf(q) {
  const y = Math.abs(q[1]);
  if (q[2] > 30.0) {
    return "none";            // the helmet itself is covered by the hood shell
  }
  if (q[2] > 28.5) {
    return "nape";
  }
  if (q[2] > 27.0) {
    return "collar";
  }
  if (q[2] < 4.0) {
    return "legs";
  }
  if (q[2] > 19.0 && y > 3.2) {
    return "shoulders";
  }
  return "back";
}

const picked = [];
for (const reg of REGIONS) {
  const mine = roots.filter((r) => regionOf(r.p) === reg.name);
  const taken = [];
  for (const r of mine) {
    if (taken.length >= reg.quota) {
      break;
    }
    let ok = true;
    for (const q of taken) {
      if (Math.hypot(r.p[0] - q.p[0], r.p[1] - q.p[1], r.p[2] - q.p[2]) < reg.space) { ok = false; break; }
    }
    if (ok) taken.push(r);
  }
  console.log("    " + reg.name.padEnd(10) + " " + String(taken.length).padStart(4) + " of " + reg.quota);
  for (const t of taken) picked.push({ ...t, leaf: reg.leaf });
}

/*
 * A last safety net on top of the quotas. GoldSrc allows 2048 vertices and 2048
 * normals per submodel and a strand costs four of each: `tengu2` has room for 230,
 * `xccpbody2` for 268 and `glasses_Ref`, all but empty, for 508. All three bodyparts
 * draw at once, so a strand looks identical whichever it lives on.
 */
/*
 * tengu2's share is cut right back because THE HOOD SHELL LIVES THERE TOO, and it is
 * not free: the shell and its fringe cost about 410 vertices, which is a hundred
 * strands' worth. Leaving the cap at its bare maximum put that submodel 203 points
 * over the limit and the build refused it outright -- which is the right failure, but
 * the arithmetic belongs here rather than in the error message.
 */
const CAP = [126, 268, 500];
const limit = CAP[0] + CAP[1] + CAP[2];
if (picked.length > limit) picked.length = limit;
console.log("  " + roots.length + " candidate points -> " + picked.length + " strands (ceiling " + limit + ")");

// The spine, the shoulders AND the head, so a strand follows the part of him it hangs
// from rather than the whole body swinging as one.
const names = K.bones(painted).map((b) => b.name);
const P = K.poseAt(painted, POSE.seq, POSE.frame);
/*
 * THE LEGS ARE IN THIS LIST, and leaving them out is why the strands down by his boots
 * used to stay put while he ran.
 *
 * Every strand hangs off whichever of these bones its root is nearest. With only the
 * spine here, a strand rooted on his shin had nothing closer than Dorso1 to hang from,
 * so it was welded to his chest: the leg swung through it and the ghillie stayed where
 * it was. The pelvis is in as well, so strands around the hip follow the hips rather
 * than being dragged by the ribs.
 *
 * The feet themselves are deliberately NOT here. A strand on the ankle whips through the
 * whole arc of a stride and reads as a glitch rather than as cloth.
 */
const CARRY = ["Bip01 Dorso1", "Bip01 Dorso2", "Bip01 Dorso3",
               "Bip01 SX Clavicola", "Bip01 DX Clavicola", "Bip01 Collo", "Bip01 Testa",
               "Bip01 Bacino",
               "Bip01 SX Coscia", "Bip01 SX Polpaccio",
               "Bip01 DX Coscia", "Bip01 DX Polpaccio"]
  .map((nm) => names.indexOf(nm))
  .filter((k) => k >= 0);
if (!CARRY.length) throw new Error("no spine bones found on this donor");

const CARRY_HEAD = names.indexOf("Bip01 Testa") >= 0 ? names.indexOf("Bip01 Testa") : CARRY[0];

const nearestBone = (q) => {
  let best = CARRY[0], bd = 1e9;
  for (const b of CARRY) {
    const d = Math.hypot(P[b][0][3] - q[0], P[b][1][3] - q[1], P[b][2][3] - q[2]);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
};

const SIZE = 128;
const S = W.sheet(SIZE, SIZE, [0.09, 0.11, 0.06]);
const ZONE = { x: 4, y: 4, w: 120, h: 120 };
const SHAPES = [W.shape(SIZE, SIZE), W.shape(SIZE, SIZE), W.shape(SIZE, SIZE)];

/*
 * THE HOOD: one continuous shell over the helmet, not a scattering of leaves.
 *
 * Covering a dome with separate pieces and hoping they meet does not work, and took
 * several goes to stop trying: strands hang off the curve and leave the top bare,
 * leaves lie on it but need enough of them to tile a sphere by luck, and both spend
 * the whole vertex budget doing it. A shell simply covers it -- 231 vertices against
 * the 1,160 the leaves were using, and no gaps possible.
 *
 * Fitted to the helmet as measured, centre (3.9, -0.1) and radius falling from 6.0
 * about the temples to 2.0 at the crown, plus a little clearance so it sits ON the
 * helmet rather than inside it.
 *
 * IT IS OPEN AT THE FRONT. Below the brow the segments within sixty degrees of
 * straight ahead are skipped, which is what makes it a hood and not a bucket -- the
 * visor has to stay visible.
 */
function buildHood(M) {
  const CX = 3.9, CY = -0.1;
  // [z, radius] up the helmet, from the flare at the shoulders to the apex
  /*
   * MEASURED RADIUS PLUS A QUARTER UNIT, no more.
   *
   * The first profile ran half to three quarters of a unit wide of the helmet, and the
   * result was a visible gap down both sides of the face -- the hood stood off the head
   * like a lampshade instead of sitting on it. These are the helmet's own radii, band
   * by band, with just enough clearance not to z-fight.
   */
  const PROFILE = [
    [27.6, 8.2], [29.0, 7.4], [30.0, 6.6], [31.0, 6.3], [32.0, 6.3],
    [33.0, 6.7], [34.0, 6.3], [35.0, 6.1], [36.0, 5.2], [37.0, 4.3],
    [38.0, 2.3], [38.6, 0.5],
  ];
  const SEG = 20;
  // Narrower than it was: at sixty degrees the opening reached past the cheeks and
  // left the gap open round the sides rather than framing the visor.
  const OPEN = 44 * Math.PI / 180;      // half-angle of the face opening
  const BROW = 35.2;                    // above this the hood closes over the forehead

  const bone = CARRY_HEAD;
  const to = K.inverse34(P[bone]);
  const ring = (zi) => {
    const [z, rad] = PROFILE[zi];
    return Array.from({ length: SEG + 1 }, (_, k) => {
      const a = 2 * Math.PI * k / SEG;
      return { a, p: [CX + rad * Math.cos(a), CY + rad * Math.sin(a), z] };
    });
  };

  let made = 0;
  for (let i = 0; i + 1 < PROFILE.length; i++) {
    const lo = ring(i), hi = ring(i + 1);
    for (let k = 0; k < SEG; k++) {
      const mid = (lo[k].a + lo[k + 1].a) / 2;
      const front = Math.abs(Math.atan2(Math.sin(mid), Math.cos(mid)));
      // open at the face, but only below the brow
      if (front < OPEN && PROFILE[i][0] < BROW) {
        continue;
      }
      const u = ZONE.x + ZONE.w * (k / SEG);
      const uw = ZONE.w / SEG;
      const v0 = ZONE.y + ZONE.h * (i / (PROFILE.length - 1));
      const vh = ZONE.h / (PROFILE.length - 1);
      const a = M.V(lo[k].p, [u, v0 + vh]);
      const b = M.V(lo[k + 1].p, [u + uw, v0 + vh]);
      const c = M.V(hi[k + 1].p, [u + uw, v0]);
      const d = M.V(hi[k].p, [u, v0]);
      M.quad(a, b, c, d, [CX, CY, 32.0]);     // inside the head, so it faces outward
      made += 2;
      for (const t of M.tris.slice(-2)) {
        for (const corner of t) { corner.bone = bone; corner.to = to; }
      }
    }
  }
  /*
   * And the fringe that hangs off its edge.
   *
   * A hood with a clean hem reads as a cowl, not as a ghillie. These are rooted on the
   * shell's own lower rim rather than on the body, so they hang from the garment the
   * way the real thing does -- and they are skipped across the face opening.
   */
  const rim = ring(0);
  let fringe = 0;
  for (let k = 0; k < SEG; k++) {
    const a = rim[k].a;
    const front = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
    if (front < OPEN) {
      continue;
    }
    for (let rep = 0; rep < 3; rep++) {
      const jit = (rep - 1) * 0.055;
      const aa = a + jit;
      const rad = PROFILE[0][1] - 0.1;
      const root = [CX + rad * Math.cos(aa), CY + rad * Math.sin(aa), PROFILE[0][0]];
      const dx = Math.cos(aa), dy = Math.sin(aa);
      const len = 3.4 + rnd() * 3.6;
      const wide = 0.62 + rnd() * 0.5;
      const at = (along, side) => [
        root[0] + dx * 0.35 * along + side * -dy * 0.7,
        root[1] + dy * 0.35 * along + side * dx * 0.7,
        root[2] - len * along,
      ];
      const u = ZONE.x + ZONE.w * rnd(), uw = 5 + rnd() * 7;
      const fa = M.V(at(0, -wide), [u, ZONE.y + 2]);
      const fb = M.V(at(0, wide), [u + uw, ZONE.y + 2]);
      const fc = M.V(at(1, wide * 0.3), [u + uw, ZONE.y + ZONE.h - 2]);
      const fd = M.V(at(1, -wide * 0.3), [u, ZONE.y + ZONE.h - 2]);
      M.quad(fa, fb, fc, fd, [CX, CY, root[2]]);
      fringe += 2;
      for (const t of M.tris.slice(-2)) {
        for (const corner of t) { corner.bone = bone; corner.to = to; }
      }
    }
  }

  console.log("    hood shell " + made + " triangles, fringe " + fringe);
}

const rnd = W.seeded(1337);
buildHood(SHAPES[0]);

picked.forEach((r, idx) => {
  const M = SHAPES[idx < CAP[0] ? 0 : (idx < CAP[0] + CAP[1] ? 1 : 2)];
  const bone = nearestBone(r.p);
  const to = K.inverse34(P[bone]);
  const nx = r.n[0], ny = r.n[1], nz = r.n[2];
  const u0 = ZONE.x + ZONE.w * rnd();
  const uw = 5 + rnd() * 7;

  /*
   * ON THE HELMET IT IS A LEAF, not a strand.
   *
   * A strand hangs OFF a surface, so on a dome it drops below the curve within half a
   * unit and the top is left bare with a fringe round the edge -- which is exactly
   * what it kept looking like, however many were added. A leaf LIES ON the surface
   * instead, a flat quad in the tangent plane held a little clear of it, so a few
   * hundred overlapping ones cover the helmet completely. It is also what the real
   * thing is: leaves sewn onto a hood.
   */
  if (r.leaf) {
    // A tangent frame from the normal. The reference axis is swapped near vertical,
    // because crossing a vector with one almost parallel to it gives nearly nothing
    // and the frame collapses -- which on a dome is every strand on the very top.
    const ref = Math.abs(nz) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    let t1 = [ny * ref[2] - nz * ref[1], nz * ref[0] - nx * ref[2], nx * ref[1] - ny * ref[0]];
    const l1 = Math.hypot(t1[0], t1[1], t1[2]) || 1;
    t1 = [t1[0] / l1, t1[1] / l1, t1[2] / l1];
    const t2 = [ny * t1[2] - nz * t1[1], nz * t1[0] - nx * t1[2], nx * t1[1] - ny * t1[0]];

    const size = 1.15 + rnd() * 1.25;
    const ang = rnd() * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const lift = 0.22 + rnd() * 0.30;

    // Corners in the tangent plane, rotated so the leaves do not all lie the same way.
    const leaf = (su, sv) => {
      const au = su * size * (0.75 + rnd() * 0.0);
      const av = sv * size * 0.62;
      const ru = au * ca - av * sa, rv = au * sa + av * ca;
      return [
        r.p[0] + nx * lift + t1[0] * ru + t2[0] * rv,
        r.p[1] + ny * lift + t1[1] * ru + t2[1] * rv,
        r.p[2] + nz * lift + t1[2] * ru + t2[2] * rv,
      ];
    };

    const la = M.V(leaf(-1, -1), [u0, ZONE.y + 2]);
    const lb = M.V(leaf(1, -1), [u0 + uw, ZONE.y + 2]);
    const lc = M.V(leaf(1, 1), [u0 + uw, ZONE.y + ZONE.h - 2]);
    const ld = M.V(leaf(-1, 1), [u0, ZONE.y + ZONE.h - 2]);
    M.quad(la, lb, lc, ld, [r.p[0] - nx * 2, r.p[1] - ny * 2, r.p[2] - nz * 2]);

    for (const t of M.tris.slice(-2)) {
      for (const corner of t) { corner.bone = bone; corner.to = to; }
    }
    return;
  }

  // Everywhere else a strand, which hangs. THICKER than a frond: at the range players
  // are actually seen a thin one is a single pixel of noise, and hundreds of those
  // read as dirt on the lens rather than as a ghillie.
  const len = 4.8 + rnd() * 5.4;
  const wide = 0.78 + rnd() * 0.62;
  const out = 1.15 + rnd() * 0.95;
  const sway = (rnd() - 0.5) * 1.1;

  const at = (along, side) => [
    r.p[0] + nx * out * (0.80 + 0.45 * along) + side * ny * 0.7,
    r.p[1] + ny * out * (0.80 + 0.45 * along) - side * nx * 0.7 + sway * along,
    r.p[2] - len * along,
  ];

  const a2 = M.V(at(0, -wide), [u0, ZONE.y + 2]);
  const b2 = M.V(at(0, wide), [u0 + uw, ZONE.y + 2]);
  const c2 = M.V(at(1, wide * 0.3), [u0 + uw, ZONE.y + ZONE.h - 2]);
  const d2 = M.V(at(1, -wide * 0.3), [u0, ZONE.y + ZONE.h - 2]);
  M.quad(a2, b2, c2, d2, [r.p[0] - nx * 2, r.p[1] - ny * 2, r.p[2]]);

  for (const t of M.tris.slice(-2)) {
    for (const corner of t) { corner.bone = bone; corner.to = to; }
  }
});

// ── 3. their paint ─────────────────────────────────────────────────────────
// Vertical streaks, because a strand is read along its length and a blotchy one looks
// like a leaf rather than a frond.
S.zone(ZONE, (u, v) => {
  // Streaked along their length, because a strand is read lengthways -- a blotchy one
  // looks like a leaf rather than a frond -- and then flecktarned like the garment, so
  // the ghillie and the vest are plainly the same kit.
  const along = v / ZONE.h;
  const n = W.fbm(u / 2.2, v / 14, 7, 5);
  let c = W.mix(STRAND_A, STRAND_B, clamp((n - 0.38) * 2.4));
  c = W.mix(c, STRAND_C, clamp((W.fbm(u / 1.4 + 9, v / 9, 19, 4) - 0.52) * 3.6) * 0.8);

  const dot = (k, seed, cut, col, amt) => {
    const v2 = clamp((W.fbm(u / k, v / k, seed, 3) - cut) / 0.08);
    if (v2 > 0) c = W.mix(c, col, v2 * amt);
  };
  dot(3.0, 11, 0.50, FLK_MID, 0.55);
  dot(2.4, 37, 0.52, FLK_BROWN, 0.45);
  dot(2.0, 71, 0.54, FLK_BLACK, 0.55);

  // darker towards the tips, where a real one is in its own shadow
  return W.times(c, 0.72 + 0.42 * (1 - along));
});

const texture = K.indexed(S.image(), "ghillie.bmp");

let out = painted;
let added = 0;
SHAPES.forEach((M, bp) => {
  if (!M.tris.length) {
    return;
  }
  const where = { bodypart: bp, model: 0 };
  const mesh = K.readMdl(out).bodyparts[bp].models[0].meshes.length;
  // The sheet is only appended once: replaceMesh reuses a texture of the same name
  // that the file already has, so the second bodypart shares the first's.
  out = K.replaceMesh(
    K.addMesh(out, where), { ...where, mesh },
    K.meshOf(null, M.tris, texture, CARRY[0], 50), texture,
  );
  added += M.tris.length;
});

// texturesLast is not optional. The strands are an appended mesh, and a GoldSrc model
// whose texture block is not last draws as NOTHING -- silently, with check() reporting
// no errors at all.
out = texturesLast(out);

console.log("  " + added + " triangles of ghillie on " + CARRY.length + " bones, over " + SHAPES.filter((m) => m.tris.length).length + " bodyparts");
const r = K.check(out, "goldsrc");
console.log(`  ${r.facts ? r.facts.join("\n  ") : ""}`);
if (r.warnings.length) console.log(`  ${r.warnings.join("\n  ")}`);

mkdirSync(join(OUT, "repughillie"), { recursive: true });
writeFileSync(join(OUT, "repughillie", "repughillie.mdl"), checked("repughillie", out));
console.log("  wrote export-mdl/repughillie/repughillie.mdl");

const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };
put("ghillie_preview.png", K.lineup([["repuheavy", base], ["repughillie", out]], { ...POSE, yaws: [0, 120, 215], zoom: 1.5, width: 320, cols: 6 }));
// A run, because strands hang off bones and that only shows in motion.
put("ghillie_run.png", K.strip(out, { seq: "run2", count: 6, cols: 6, width: 280, height: 420, yaw: 200 }));
put("ghillie_sheet.png", { width: SIZE, height: SIZE, rgba: K.rgbaOf(texture) });
