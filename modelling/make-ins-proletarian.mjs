// ins_proletarian: the proletarian after he fell in with the insurgency.
//
//     node make-ins-proletarian.mjs
//
// Bandoliers crossed over the chest, holsters at both hips, a belt carrying equipment,
// heavier grime, and blood that belongs to other people.
//
// It starts from the FINISHED proletarian_dirty rather than from the agent donor, the
// way make-belt works off a built ins_medic. That model's look took a long time to
// settle and nothing here reaches back into it: this script reads it, paints over it
// and hangs gear on it, and make-proletarian.mjs is not touched at all.
//
// Axes on this donor, taken from what make-proletarian.mjs already proves rather than
// assumed: the shades it cuts sit at x 4.8..10.2 and its `front` is (x - 2.4) / 3.2, so
//     +x is his FRONT, +y is his LEFT, +z is up.
// The XCCP family faces the other way. The direction is a property of the donor, never
// of the skeleton, so it is established per model and never carried across.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, checked, clamp, texturesLast, POSE } from "./lib.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const base = readFileSync(join(OUT, "proletarian_dirty", "proletarian_dirty.mdl"));

const lum = (c) => c[0] * 0.30 + c[1] * 0.60 + c[2] * 0.10;
const warm = (c) => c[0] - c[2];
const n3 = (p, k, s, oct = 4) => W.fbm3(p, k, s, oct);

// ── the body, measured ─────────────────────────────────────────────────────
// waist.mjs does this job for the merc family, but it is wired to the ins_medic file at
// import time and make-belt depends on it, so the measurement is repeated here against
// this donor instead of changing a helper something else already relies on.
//
// THE TRUNK CUTOFF IS NOT 8.5 ON THIS MODEL. waist.mjs uses that to throw away the arms,
// and on the agent donor the arms hang INSIDE it: every radius comes back pegged at the
// cutoff itself, which is the tell. Measured band by band:
//
//     belt    trunkMax 8.5 -> max 8.4   pegged, those are his arms
//     belt    trunkMax 7.5 -> max 7.1   stable, that is his waist
//     chest   trunkMax 8.5 -> max 8.5   pegged
//     chest   trunkMax 6.5 -> max 6.3   stable
//
// Taking the default would build a belt a unit and a half off his body down both sides.
const surf = K.surface(base, POSE);
const RING = 16, WINDOW = 35 * Math.PI / 180;

/*
 * THE TORSO AXIS IS TAKEN ONCE AND HELD, not worked out band by band.
 *
 * waist.mjs derives a centre for each band it measures, which is right on the merc
 * family and falls apart here: this donor's torso carries so few vertices that the
 * box-centring latches onto his left arm around z 15 and puts the middle of him at
 * y 4.8 instead of 0.3, and around z 11 only two points survive the filter at all.
 * Radii measured about centres like that drive a belt a full unit sideways, and the
 * clearance check catches it as a 0.64 cut into his hip.
 *
 * Measured from a fixed axis, the two are cleanly separable and the cutoff is evidence
 * rather than a guess. Counting surface points by distance from it:
 *
 *     belt   z 2..6    radius 5:3  6:10  7:1  |  8:6  9:7  10:7 ...
 *     chest  z 13..17  radius 5:6  6:9   7:9  |  8:5  9:2  10:4 ...
 *
 * His torso ends at 7 and his arms begin at 8, at every height that has a torso at all.
 */
const TRUNK = 8.0;

const boxCentre = (ps) => {
  const span = (k) => { const v = ps.map((q) => q[k]); return [Math.min(...v), Math.max(...v)]; };
  const [x0, x1] = span(0), [y0, y1] = span(1);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
};

// Seeded on the lower torso, which is the densest part of him and almost all trunk,
// then settled over the whole torso so a single crowded band cannot drag it.
let [AXIS_X, AXIS_Y] = boxCentre(surf.filter((s) => s.p[2] >= 0 && s.p[2] < 8).map((s) => s.p));
for (let i = 0; i < 6; i++) {
  const t = surf
    .filter((s) => s.p[2] >= 0 && s.p[2] < 24 && Math.hypot(s.p[0] - AXIS_X, s.p[1] - AXIS_Y) < TRUNK)
    .map((s) => s.p);
  if (t.length < 20) break;
  [AXIS_X, AXIS_Y] = boxCentre(t);
}

/** The ring of radii across a band of z, measured about the fixed axis. */
function sectionAt(zc, half) {
  const trunk = surf
    .filter((s) => s.p[2] >= zc - half && s.p[2] < zc + half)
    .map((s) => ({
      a: Math.atan2(s.p[1] - AXIS_Y, s.p[0] - AXIS_X),
      r: Math.hypot(s.p[0] - AXIS_X, s.p[1] - AXIS_Y),
    }))
    .filter((t) => t.r < TRUNK);
  if (trunk.length < 5) return null;

  // The furthest point within a +/-35 degree window rather than a fixed bucket. A band
  // of z on this donor holds a dozen points, so fixed buckets come back mostly empty.
  // It rounds off real corners, which is what a band round the outside wants anyway.
  const ring = Array.from({ length: RING }, (_, k) => {
    const a0 = 2 * Math.PI * k / RING;
    let r = 0;
    for (const t of trunk) {
      let d = Math.abs(t.a - a0);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d <= WINDOW && t.r > r) r = t.r;
    }
    return r;
  });
  return { ring, n: trunk.length };
}

/** A radius(angle) at height `zc`, gaps filled and seams evened. */
function profileAt(zc, half = 2.2) {
  let s = sectionAt(zc, half);
  // Some heights have no torso surface at all -- between z 8 and 12 every point in the
  // band is arm. Widening before giving up borrows from the nearest real geometry.
  for (let grow = 1; !s && grow <= 3; grow++) s = sectionAt(zc, half + grow * 1.6);
  if (!s) return null;

  // A spoke with no vertex in its window reads 0, and a strap built on that collapses to
  // the body axis there, so the holes are filled from their neighbours first.
  const r = s.ring.slice();
  for (let pass = 0; pass < RING; pass++) {
    let settled = true;
    for (let k = 0; k < RING; k++) {
      if (r[k] > 0) continue;
      const a = r[(k + RING - 1) % RING], b = r[(k + 1) % RING];
      if (a > 0 && b > 0) r[k] = (a + b) / 2;
      else if (a > 0) r[k] = a;
      else if (b > 0) r[k] = b;
      else settled = false;
    }
    if (settled) break;
  }
  if (r.some((v) => v <= 0)) return null;

  // EVENING THE SEAMS MUST NEVER PULL A SPOKE IN. A plain average does exactly that:
  // where the body is widest its neighbours are narrower, so the peak gets shaved, and a
  // strap built on the shaved figure sits a tenth of a unit inside his shirt the whole
  // way round. Smoothing fills the dips only.
  const sm = r.map((_, k) => Math.max(r[k], (r[(k + RING - 1) % RING] + 2 * r[k] + r[(k + 1) % RING]) / 4));

  return {
    ring: sm, n: s.n,
    at(a) {
      const t = ((a / (2 * Math.PI) * RING) % RING + RING) % RING, i = Math.floor(t), f = t - i;
      return sm[i] * (1 - f) + sm[(i + 1) % RING] * f;
    },
  };
}

// A ladder of profiles up the torso, so a strap that climbs reads the body at the height
// it has reached rather than at one fixed band.
const LADDER = [];
for (let z = 1; z <= 23; z += 2) {
  const p = profileAt(z);
  if (p) LADDER.push({ z, p });
}
if (LADDER.length < 4) throw new Error("could not measure the torso: only " + LADDER.length + " bands came back");

/** Body radius at a height and an angle, read between the measured bands. */
function bodyAt(z, a) {
  if (z <= LADDER[0].z) return LADDER[0].p.at(a);
  if (z >= LADDER[LADDER.length - 1].z) return LADDER[LADDER.length - 1].p.at(a);
  for (let i = 0; i + 1 < LADDER.length; i++) {
    const lo = LADDER[i], hi = LADDER[i + 1];
    if (z >= lo.z && z <= hi.z) {
      const f = (z - lo.z) / (hi.z - lo.z);
      return lo.p.at(a) * (1 - f) + hi.p.at(a) * f;
    }
  }
  return LADDER[0].p.at(a);
}

console.log(`  torso axis x ${AXIS_X.toFixed(2)} y ${AXIS_Y.toFixed(2)}, ${LADDER.length} bands measured`);
console.log(`  radius at the belt ${bodyAt(4.4, 0).toFixed(2)} front, ${bodyAt(4.4, Math.PI / 2).toFixed(2)} left, ${bodyAt(4.4, Math.PI).toFixed(2)} back`);

// ── 1. blood and more grime ────────────────────────────────────────────────
// It is OTHER PEOPLE'S blood, so it lands where it lands on a man who deals it out
// rather than takes it: thrown forward onto his chest, worn into his hands and cuffs,
// and wiped off down one thigh. Nothing on his back and nothing above the collar.
//
// Two tones, because one red reads as paint. The dried layer goes down first and
// broadly; the fresh is confined to smaller, sharper marks on top of it.
const DRIED = [0.112, 0.030, 0.024];
const FRESH = [0.232, 0.044, 0.036];
const SOOT = [0.055, 0.050, 0.044];

// fbm3 on this kit returns about 0.28..0.76 and shifts with k, so every threshold below
// sits inside that range. Thresholds picked for a 0..1 distribution produce no pattern
// at all, which is a silent failure: the model builds and simply looks untouched.
function bloodied(p, n, c) {
  const y = Math.abs(p[1]);
  const front = clamp((p[0] - AXIS_X - 0.6) / 3.0);
  const faces = clamp((n[0] - 0.15) / 0.5);

  // Thrown forward onto the chest and belly, heaviest at the middle of him and only on
  // surfaces that actually point at whatever it came off.
  const chest = front * faces * clamp(1 - Math.abs(p[2] - 12) / 13);
  c = W.mix(c, DRIED, chest * clamp((n3(p, 1.15, 211, 4) - 0.520) / 0.085) * 0.80);
  c = W.mix(c, FRESH, chest * clamp((n3(p, 3.10, 213, 2) - 0.625) / 0.040) * 0.72);

  // Hands and cuffs, worn in rather than spattered: a broad stain with the grain of the
  // cloth rather than discrete marks.
  const cuff = clamp((y - 7.4) / 2.6) * clamp(1 - Math.abs(p[2] - 0.5) / 9);
  c = W.mix(c, DRIED, cuff * clamp((n3(p, 0.95, 217, 3) - 0.455) / 0.130) * 0.74);
  c = W.mix(c, FRESH, cuff * clamp((n3(p, 2.60, 219, 2) - 0.640) / 0.045) * 0.50);

  // Wiped down his right thigh, in streaks that run WITH the leg. A hand cleaned on
  // cloth leaves lines along the limb, not across it.
  const thigh = clamp(1 - Math.abs(p[2] + 8) / 10) * clamp((-p[1] - 1.2) / 3.0) * front;
  const streak = clamp((W.fbm(p[1] * 2.2, p[2] * 0.21, 223, 4) - 0.470) / 0.120);
  c = W.mix(c, DRIED, thigh * streak * 0.78);

  // Powder and smoke round the belt line and under where the bandoliers sit, which is
  // what carrying ammunition against a shirt all day actually does to it.
  const web = Math.max(clamp(1 - Math.abs(p[2] - 5) / 4), clamp(1 - Math.abs(p[2] - 14) / 7) * front);
  c = W.mix(c, SOOT, web * clamp((n3(p, 1.45, 227, 3) - 0.490) / 0.115) * 0.40);

  return c;
}

const { mdl: bloody } = K.paint(base, ({ p, n, rgb, tex }) => {
  // His face is left exactly as it was. Blood above the collar changes who the model is,
  // and the head on this donor took far too long to settle to disturb it now.
  if (tex === "agentface.bmp") return null;
  if (p[2] > 26.5) return null;
  return bloodied(p, n, rgb);
}, { pose: POSE });

// ── 2. the sheet the gear is painted on ────────────────────────────────────
const SIZE = 256;
const S = W.sheet(SIZE, SIZE, [0.09, 0.08, 0.07]);

const STRAP   = { x:   2, y:   2, w: 200, h:  22 };   // the belt itself, turned round him
const WEB     = { x:   2, y:  28, w: 200, h:  20 };   // bandolier webbing
const BRASS   = { x:   2, y:  52, w:  34, h:  44 };   // shell cases
const CANVAS  = { x:  40, y:  52, w:  56, h:  44 };   // pouches
const LEATHER = { x: 100, y:  52, w:  56, h:  44 };   // holsters and sheaths
const STEEL   = { x: 160, y:  52, w:  44, h:  44 };   // buckle, blade, clips
const GRIP    = { x:   2, y: 100, w:  44, h:  54 };   // pistol grips
const TIN     = { x:  50, y: 100, w:  44, h:  54 };   // the canteen
const BOMB    = { x:  98, y: 100, w:  44, h:  54 };   // grenade body

// Corners 0 and 1 of every face are its BOTTOM pair, so their v is the bottom of the
// zone. Painting them the other way up turns every hanging thing upside down, which is
// subtle on a strap and obvious on a grip.
const UVQ = [[0.03, 0.97], [0.97, 0.97], [0.97, 0.03], [0.03, 0.03]];

// Two shapes, because the two groups ride different bones and nothing good comes of
// deciding that per vertex across a boundary.
const MB = W.shape(SIZE, SIZE);   // belt, pouches, holsters: the pelvis
const MC = W.shape(SIZE, SIZE);   // bandoliers and shells: the spine

/**
 * A box in a frame, from its three ranges.
 *
 * `warp(out, along, up)` moves each corner before it is placed, which is how tapers and
 * leans are made: the frame itself does not rotate, so a thing that leans is a thing
 * whose corners lean.
 */
function slab(M, f, oR, tR, uR, zone, opt = {}) {
  const { warp = (o, t, u) => [o, t, u], uv = UVQ, inside = null } = opt;
  const pick = (r, s) => (s < 0 ? r[0] : r[1]);
  const mid = (r) => (r[0] + r[1]) / 2;
  const at = inside ?? f(...warp(mid(oR), mid(tR), mid(uR)));
  const FACES = [
    [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]],
    [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]],
    [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
    [[1, -1, -1], [-1, -1, -1], [-1, -1, 1], [1, -1, 1]],
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]],
  ];
  for (const face of FACES) {
    const vs = face.map((s, i) => M.V(
      f(...warp(pick(oR, s[0]), pick(tR, s[1]), pick(uR, s[2]))),
      [zone.x + zone.w * uv[i][0], zone.y + zone.h * uv[i][1]],
    ));
    M.quad(vs[0], vs[1], vs[2], vs[3], at);
  }
}

// ── 3. the belt ────────────────────────────────────────────────────────────
const BZ = 4.4;            // the belt line
const BH = 1.15;           // half its height
const PROUD = 0.44;        // how far the strap stands off him
const INNER = 0.62;        // and how far its back edge sits in, so no gap shows
const SEG = 20;

// It sags under what it carries and wanders a little, because nothing he owns was made
// in a factory.
const sag = (a) => -0.30 * Math.max(0, Math.cos(a - 0.9)) ** 2;
const wob = (a) => 0.07 * Math.sin(a * 5 + 1.3) + 0.045 * Math.sin(a * 9 + 0.4);
const lift = (a) => sag(a) + wob(a);
const thick = (a) => PROUD + 0.04 * Math.sin(a * 7 + 2.1);

const BODY_AXIS = [AXIS_X, AXIS_Y, BZ];

/**
 * A frame on the belt at `deg` round him: `(out, along, up)` in units, where `out` is
 * away from the body, `along` runs towards his left and `up` is up.
 *
 * Everything hung on the belt is built in one of these, so a thing is placed by the
 * angle it hangs at and never by working out where that lands in model space.
 */
const beltAt = (deg) => {
  const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const r = bodyAt(BZ, a), dz = lift(a);
  const f = (out, along, up) => [
    AXIS_X + (r + out) * ca - along * sa,
    AXIS_Y + (r + out) * sa + along * ca,
    BZ + dz + up,
  ];
  f.inside = (out = -2.5) => f(out, 0, 0);
  return f;
};

// The outer face, the top rim and the bottom rim. The inner face is left off: it is
// against him at every angle, so it is never drawn and would cost vertices for nothing.
{
  const ring = Array.from({ length: SEG + 1 }, (_, k) => {
    const a = 2 * Math.PI * k / SEG, ca = Math.cos(a), sa = Math.sin(a);
    const r = bodyAt(BZ, a), dz = lift(a);
    const p = (out, up) => [AXIS_X + (r + out) * ca, AXIS_Y + (r + out) * sa, BZ + dz + up];
    const u = STRAP.x + STRAP.w * (k / SEG);
    return {
      ot: MB.V(p(thick(a), BH), [u, STRAP.y + STRAP.h * 0.04]),
      ob: MB.V(p(thick(a), -BH), [u, STRAP.y + STRAP.h * 0.96]),
      it: MB.V(p(-INNER, BH * 0.86), [u, STRAP.y + STRAP.h * 0.30]),
      ib: MB.V(p(-INNER, -BH * 0.86), [u, STRAP.y + STRAP.h * 0.70]),
    };
  });
  for (let k = 0; k < SEG; k++) {
    const a = ring[k], b = ring[k + 1];
    MB.quad(a.ot, b.ot, b.ob, a.ob, BODY_AXIS);
    MB.quad(a.it, b.it, b.ot, a.ot, BODY_AXIS);
    MB.quad(a.ob, b.ob, b.ib, a.ib, BODY_AXIS);
  }
}

// ── does the belt actually clear him? ──────────────────────────────────────
// Looking at a render is not enough. A tenth of a unit of shirt through the leather is
// invisible in a small preview and plain in game, and it shows from angles a three-yaw
// preview does not include. So every body vertex the strap passes is measured.
//
// Against the strap's POLYGON, not the circle through its corners: a 20-sided ring dips
// inward between them, and that dip is the same size as the error being looked for.
{
  const beltR = (a) => {
    const k = Math.floor((((a / (2 * Math.PI)) * SEG) % SEG + SEG) % SEG);
    const corner = (j) => {
      const b = 2 * Math.PI * j / SEG, r = bodyAt(BZ, b) + thick(b);
      return [r * Math.cos(b), r * Math.sin(b)];
    };
    const A = corner(k), B = corner(k + 1);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const den = Math.cos(a) * dy - Math.sin(a) * dx;
    return Math.abs(den) < 1e-9 ? Infinity : (A[0] * dy - A[1] * dx) / den;
  };

  const lo = BZ - BH - 0.45, hi = BZ + BH + 0.45;
  let worst = Infinity, at = 0;
  for (const s of surf) {
    if (s.p[2] < lo || s.p[2] > hi) continue;
    const dx = s.p[0] - AXIS_X, dy = s.p[1] - AXIS_Y, r = Math.hypot(dx, dy);
    if (r > 8.2) continue;                       // his hands hang here, not his waist
    const gap = beltR(Math.atan2(dy, dx)) - r;
    if (gap < worst) { worst = gap; at = Math.atan2(dy, dx) * 180 / Math.PI; }
  }
  console.log(`  belt clears him by ${worst.toFixed(2)} at its tightest, ${at.toFixed(0)} degrees round`);
  if (worst < 0.05) {
    throw new Error(`the belt cuts ${(-worst).toFixed(2)} into him at ${at.toFixed(0)} degrees: raise PROUD, or widen the band the profile is measured over`);
  }
}

// Anything fastened to the strap starts outside its wandering face rather than at PROUD.
// Sharing a plane with it z-fights, and on a belt that flickers whenever the player turns.
const ON = PROUD + 0.11;

// ── 4. what hangs off the belt ─────────────────────────────────────────────
// The buckle, dead front.
{
  const f = beltAt(0);
  slab(MB, f, [ON, ON + 0.46], [-1.25, 1.25], [-BH - 0.12, BH + 0.12], STEEL);
  slab(MB, f, [ON, ON + 0.17], [-2.9, -1.9], [-BH - 2.2, BH * 0.6], STRAP,
       { warp: (o, t, u) => [o, t + 0.10 * u, u] });          // the loose tail, hanging
}

// Ammunition pouches across the front, where a man can reach them with either hand.
for (const [deg, wide] of [[36, 1.5], [62, 1.35], [-36, 1.5], [-62, 1.35]]) {
  const f = beltAt(deg);
  slab(MB, f, [ON, ON + 0.95], [-wide, wide], [-BH - 1.5, BH * 0.75], CANVAS);
  slab(MB, f, [ON - 0.05, ON + 1.02], [-wide - 0.07, wide + 0.07], [BH * 0.10, BH * 0.80], CANVAS,
       { warp: (o, t, u) => [o - 0.10 * (u - BH * 0.1), t, u] });   // the flap over it
}

// A canteen on his back left, out of the way of his hands.
{
  const f = beltAt(128);
  slab(MB, f, [ON, ON + 1.15], [-1.5, 1.5], [-BH - 2.0, BH * 0.5], TIN);
  slab(MB, f, [ON + 0.30, ON + 0.85], [-0.45, 0.45], [BH * 0.4, BH * 1.15], STEEL);   // its cap
}

// A knife, back right, hilt up where he can reach it.
{
  const f = beltAt(-150);
  slab(MB, f, [ON, ON + 0.40], [-0.70, 0.70], [-BH - 2.3, BH * 0.4], LEATHER);
  slab(MB, f, [ON + 0.06, ON + 0.34], [-0.34, 0.34], [BH * 0.35, BH * 1.9], GRIP);
}

// Two grenades clipped on, front right.
for (const deg of [-86, -108]) {
  const f = beltAt(deg);
  slab(MB, f, [ON, ON + 0.92], [-0.62, 0.62], [-BH - 1.0, BH * 0.3], BOMB);
  slab(MB, f, [ON + 0.22, ON + 0.70], [-0.26, 0.26], [BH * 0.25, BH * 1.0], STEEL);   // the spoon
}

// ── 5. the holsters ────────────────────────────────────────────────────────
// Low on both hips, hung off the belt by a short tab rather than floating beside it.
for (const side of [1, -1]) {
  const f = beltAt(side * 92);
  slab(MB, f, [ON, ON + 0.26], [-0.85, 0.85], [-BH - 0.9, BH * 0.9], LEATHER);        // the tab
  slab(MB, f, [ON, ON + 1.05], [-1.25, 1.25], [-BH - 4.6, -BH - 0.7], LEATHER, {
    warp: (o, t, u) => [o, t * (1 - 0.18 * clamp((-u - BH) / 4)), u],                 // tapering down
  });
  // the grip standing out of its mouth, leaning back the way a holstered pistol does
  slab(MB, f, [ON + 0.16, ON + 0.80], [-0.46, 0.46], [-BH - 1.3, BH + 0.9], GRIP, {
    warp: (o, t, u) => [o - 0.16 * clamp((u + BH) / 2.4), t, u],
  });
}

// ── 6. the bandoliers ──────────────────────────────────────────────────────
// A bandolier is a ring round the torso that is TILTED, high at one shoulder and low at
// the opposite hip. Two of them tilted opposite ways cross at the front and again at the
// back, which is the X it is supposed to read as, and it comes out of the same ring
// builder the belt uses rather than needing a path of its own.
/*
 * THE HIGH POINT HAS TO CLEAR THE SHOULDER, not stop inside it.
 *
 * At z 21 out at his side there is NO TORSO AT ALL: the nearest surface is his arm at
 * radius 8.8, and the trunk-filtered profile, finding nothing within its cutoff, invented
 * a radius of 7.7 by filling the gap from its neighbours. The strap went to 8.1 and sat
 * a clear 0.7 inside his deltoid, which is the strap disappearing into his shoulder.
 *
 * Carried up to z 24 it passes over the top of the shoulder instead, where the body is
 * real again at radius 5 to 7 and his arm has ended, so there is something to lie on.
 * The low end rises with it and now sits just above the belt rather than across it.
 */
const CZ = 15.5;           // where the two cross, front and back
const CAMP = 8.5;          // how far each end rises and falls from there
const CH = 0.92;           // half the strap's height
const CPROUD = 0.40;
const CSEG = 22;

const strapZ = (a, phase) => CZ + CAMP * Math.cos(a - phase);

/*
 * The body the strap actually lies on, sampled WHERE THE STRAP GOES rather than read off
 * a ring of fixed height.
 *
 * bodyAt answers "how wide is he at this height", which is the right question for a belt
 * and the wrong one for something that climbs: a strap crossing his chest diagonally
 * passes over a different part of him at every step, and the ladder of z-rings has
 * nothing to say about heights where the only thing in the band is an arm.
 *
 * Arms are still excluded. One hanging outside the strap is correct and is what the
 * reference photographs show; the strap goes under it, not around it.
 */
function strapSurface(z, a) {
  let r = 0, hits = 0;
  for (const p of surf) {
    if (Math.abs(p.p[2] - z) > 2.0) continue;
    const rr = Math.hypot(p.p[0] - AXIS_X, p.p[1] - AXIS_Y);
    if (rr > 8.6) continue;
    let d = Math.abs(Math.atan2(p.p[1] - AXIS_Y, p.p[0] - AXIS_X) - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > 26 * Math.PI / 180) continue;
    hits++;
    if (rr > r) r = rr;
  }
  return hits ? r : null;
}

/** The strap's radius round him, with the holes filled from along the strap itself. */
function strapRing(phase, n) {
  const raw = Array.from({ length: n }, (_, k) => {
    const a = 2 * Math.PI * k / n;
    return strapSurface(strapZ(a, phase), a);
  });
  // A sample with nothing under it borrows from its neighbours ROUND THE STRAP, which is
  // the only direction in which the next reading is of the same part of him.
  for (let pass = 0; pass < n; pass++) {
    let settled = true;
    for (let k = 0; k < n; k++) {
      if (raw[k] !== null) continue;
      const a = raw[(k + n - 1) % n], b = raw[(k + 1) % n];
      if (a !== null && b !== null) raw[k] = (a + b) / 2;
      else if (a !== null) raw[k] = a;
      else if (b !== null) raw[k] = b;
      else settled = false;
    }
    if (settled) break;
  }
  if (raw.some((v) => v === null)) throw new Error("the strap found no body to lie on anywhere");
  // Filling the dips only, never shaving the peaks, for the same reason the belt does.
  return raw.map((_, k) => Math.max(raw[k], (raw[(k + n - 1) % n] + 2 * raw[k] + raw[(k + 1) % n]) / 4));
}

function bandolier(phase, zone) {
  const measured = strapRing(phase, CSEG);
  const ring = Array.from({ length: CSEG + 1 }, (_, k) => {
    const a = 2 * Math.PI * k / CSEG, ca = Math.cos(a), sa = Math.sin(a);
    const z = strapZ(a, phase);
    const r = measured[k % CSEG] + CPROUD;
    const u = zone.x + zone.w * (k / CSEG);
    // The strap stays level across its own width, so its height is measured up and down
    // in z rather than along the tilt. A band that twisted with the tilt would stand on
    // its edge at the shoulders.
    const p = (out, up) => [AXIS_X + (r + out) * ca, AXIS_Y + (r + out) * sa, z + up];
    return {
      a, z,
      ot: MC.V(p(0, CH), [u, zone.y + zone.h * 0.05]),
      ob: MC.V(p(0, -CH), [u, zone.y + zone.h * 0.95]),
      it: MC.V(p(-CPROUD - 0.30, CH * 0.85), [u, zone.y + zone.h * 0.32]),
      ib: MC.V(p(-CPROUD - 0.30, -CH * 0.85), [u, zone.y + zone.h * 0.68]),
    };
  });
  for (let k = 0; k < CSEG; k++) {
    const a = ring[k], b = ring[k + 1];
    const inside = [AXIS_X, AXIS_Y, (a.z + b.z) / 2];
    MC.quad(a.ot, b.ot, b.ob, a.ob, inside);
    MC.quad(a.it, b.it, b.ot, a.ot, inside);
    MC.quad(a.ob, b.ob, b.ib, a.ib, inside);
  }
  return ring;
}

bandolier(Math.PI / 2, WEB);        // high at his left shoulder
bandolier(-Math.PI / 2, WEB);       // high at his right

// The shells. Only across his FRONT and the outer thirds of his back: a shell loop
// against the spine is hidden by his own arms from every angle it would be seen from,
// and they are the most expensive thing here per unit of silhouette.
for (const phase of [Math.PI / 2, -Math.PI / 2]) {
  for (let i = 0; i < 9; i++) {
    const a = (-0.95 + 1.9 * (i / 8)) + (phase > 0 ? 0 : Math.PI);
    const z = strapZ(a, phase);
    const r = (strapSurface(z, a) ?? bodyAt(z, a)) + CPROUD;
    const ca = Math.cos(a), sa = Math.sin(a);
    // A frame on the strap, so a shell is placed by where along it sits.
    const f = (out, along, up) => [
      AXIS_X + (r + out) * ca - along * sa,
      AXIS_Y + (r + out) * sa + along * ca,
      z + up,
    ];
    slab(MC, f, [0.02, 0.46], [-0.33, 0.33], [-CH * 0.55, CH * 1.25], BRASS);
  }
}

// -- the pauldrons, taken off a dead heavy ---------------------------------
/*
 * THE REAL GEOMETRY, LIFTED OFF repuheavy. Not a shape built to resemble it.
 *
 * Its pauldrons are two faceted plates with a vivid blue panel sunk into a near-black
 * shell, and an approximation of that is just a shoulder pad: the thing that makes them
 * read is the exact angular silhouette, which is 44 triangles on his left and 47 on his
 * right. Those are taken as they are.
 *
 * This works because BOTH MODELS WEAR THE SAME SKELETON AT THE SAME SCALE. repuheavy's
 * left clavicle sits at (2.28, 4.55, 23.50) and this donor's at (2.29, 4.55, 23.49), so
 * geometry held in bone space needs no scaling, no rotation and no fitting -- it is
 * reattached to the bones of the same name and lands where it belongs. Bones are matched
 * BY NAME rather than by index, because these models share one skeleton in two different
 * orders.
 *
 * The plates are skinned across the clavicle and Dorso3 on the donor, and stay that way
 * here, so they follow the shoulder exactly as they did on the model they came off.
 */
const donor = load("repuheavy");
const donorMd = K.readMdl(donor);
const donorNames = K.bones(donor).map((b) => b.name);
const donorPose = K.poseAt(donor, POSE.seq, POSE.frame);

// Which triangles: the blue plate on each side, found by where it sits in the world.
// Each side is on its own sheet of his, which is why they are taken one at a time.
/*
 * ONE PLATE IS TAKEN AND THE OTHER IS ITS MIRROR IMAGE.
 *
 * The donor carries a separate mesh on each shoulder, on a separate sheet, and the two
 * are not mirror images of each other -- different triangle counts, different extents
 * about their own centres. Ported one each they land in mirrored positions and still do
 * not match, because the shapes themselves differ.
 *
 * So his left plate is taken and reflected across to make the right. The pair are
 * identical by construction, and it costs one texture instead of two.
 */
const PAULDRONS = [
  { tex: "05.bmp", as: "ins_prole_pauldron.bmp", box: { x: [-3.6, 7.3], y: [3.6, 11.6], z: [24.0, 28.8] } },
];

/** Resamples a donor texture down and beats it about, so the plate arrives wartorn. */
function wornCopy(src, name) {
  const t = K.textureOf(donor, src);
  const rgba = K.rgbaOf(t);
  const N = 256;
  const rgb = new Uint8Array(N * N * 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sx = Math.min(t.width - 1, Math.floor(x * t.width / N));
      const sy = Math.min(t.height - 1, Math.floor(y * t.height / N));
      const si = (sy * t.width + sx) * 4;
      let c = [rgba[si] / 255, rgba[si + 1] / 255, rgba[si + 2] / 255];

      /*
       * Wear goes on the PANEL, not over the whole plate. The blue is the only thing
       * anyone looks at, so chips and dead patches in it are what make the armour look
       * scavenged; dulling the shell as well just looks like bad lighting.
       */
      const isBlue = c[2] > c[0] + 0.08 && c[2] > 0.15;
      if (isBlue) {
        const chip = clamp((W.fbm(x / 7, y / 6, 131, 4) - 0.560) / 0.060);
        c = W.mix(c, W.steel(y / 5, x / 5, 0.30, 133, -0.30), chip * 0.55);
        const dead = clamp((W.fbm(x / 17, y / 15, 137, 3) - 0.545) / 0.070);
        c = W.mix(c, [0.060, 0.105, 0.150], dead * 0.45);
        c = W.mix(c, [0.145, 0.078, 0.042], clamp((W.fbm(x / 9, y / 8, 139, 4) - 0.610) / 0.050) * 0.35);
      }
      // Scrapes and grime over everything, shell included, but lightly.
      c = W.mix(c, [0.070, 0.066, 0.060], clamp((W.fbm(x / 3.5, y / 14, 143, 3) - 0.620) / 0.045) * 0.30);
      if (W.noise(x * 1.7, y * 5, 147) > 0.90) c = W.times(c, 0.74);

      const o = (y * N + x) * 3;
      for (let k = 0; k < 3; k++) rgb[o + k] = Math.max(0, Math.min(255, c[k] * 255));
    }
  }
  return K.indexed({ width: N, height: N, rgb }, name);
}

// Pulled out here and attached further down, with the rest of the rig.
const plateGroups = [];
for (const P2 of PAULDRONS) {
  let picked = null;
  for (const bp of donorMd.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
    if (donorMd.textures[me.skinref]?.name !== P2.tex) continue;
    const inBox = K.readMesh(donor, mo, me).filter((t) => {
      const c = [0, 1, 2].map((k) => t.reduce((a, q) => a + K.apply34(donorPose[q.bone], q.p)[k], 0) / 3);
      return c[0] >= P2.box.x[0] && c[0] <= P2.box.x[1]
          && c[1] >= P2.box.y[0] && c[1] <= P2.box.y[1]
          && c[2] >= P2.box.z[0] && c[2] <= P2.box.z[1];
    });
    if (inBox.length) picked = { tris: inBox, tex: donorMd.textures[me.skinref] };
  }
  if (!picked) throw new Error(`found no pauldron on ${P2.tex}: the donor has changed`);
  plateGroups.push({ ...picked, as: P2.as, src: P2.tex });
  console.log(`  pauldron off ${P2.tex}: ${picked.tris.length} triangles`);
}


// ── 7. the sheet ───────────────────────────────────────────────────────────
const dull = (c, k = 0.72) => W.times(c, k);
const grain = (u, v, s) => 0.9 + 0.2 * (W.fbm(u * 0.4, v * 0.9, s, 3) - 0.5) * 2;

S.zone(STRAP, (u, v) => {
  const d = clamp(v / STRAP.h);
  let c = W.leatherWrap(u / 26, d, 53, [[0.115, 0.076, 0.052], [0.205, 0.138, 0.090]]);
  c = W.times(c, 0.82 + 0.30 * Math.sin(Math.PI * d));            // rolled, light along the middle
  if (W.noise(u * 1.7, v * 9, 57) > 0.86) c = W.times(c, 0.70);   // scuffs
  return dull(c, 0.95);
});

S.zone(WEB, (u, v) => {
  const d = clamp(v / WEB.h);
  // Woven webbing: a weft across it and a warp along, both coarse enough to survive the
  // shrink GoldSrc puts a 256 sheet through.
  const weft = 0.86 + 0.14 * Math.sign(Math.sin(u * 2.3));
  const warp = 0.90 + 0.10 * Math.sign(Math.sin(v * 2.8));
  let c = W.times([0.148, 0.126, 0.086], weft * warp * grain(u, v, 61));
  c = W.times(c, 0.80 + 0.34 * Math.sin(Math.PI * d));
  c = W.mix(c, [0.052, 0.044, 0.036], clamp((W.fbm(u / 6, v / 3, 63, 4) - 0.56) * 3.4) * 0.5);
  return dull(c, 0.98);
});

S.zone(BRASS, (u, v) => {
  const d = clamp(v / BRASS.h), a = clamp(u / BRASS.w);
  // A case is a cylinder: bright down one side, with the rim darker at the bottom.
  let c = W.times([0.46, 0.33, 0.12], W.cylinderLight(a, 0.40) * grain(u, v, 67));
  if (d < 0.17) c = W.times(c, 0.62);                             // the rim
  if (d > 0.80) c = W.mix(c, [0.195, 0.150, 0.090], clamp((d - 0.80) / 0.20));
  return dull(c, 0.92);
});

S.zone(CANVAS, (u, v) => {
  const d = clamp(v / CANVAS.h);
  let c = W.times([0.150, 0.132, 0.094], grain(u, v, 71));
  c = W.times(c, 0.86 + 0.22 * Math.sin(Math.PI * clamp(u / CANVAS.w)));
  c = W.mix(c, [0.058, 0.050, 0.040], clamp((W.fbm(u / 5, v / 5, 73, 4) - 0.58) * 3) * 0.55);
  if (d > 0.88) c = W.times(c, 0.70);                             // shadow under the flap
  return dull(c, 0.96);
});

S.zone(LEATHER, (u, v) =>
  dull(W.times(W.leatherWrap(u / 22, clamp(v / LEATHER.h), 77, [[0.098, 0.064, 0.044], [0.175, 0.115, 0.075]]),
               grain(u, v, 79)), 0.98));

// WORN GUNMETAL, NOT CHROME. The rest of this sheet lives between 0.08 and 0.16, which
// is what sits right against trousers painted at 0.17 and boots at 0.10. Steel asked for
// at its own natural brightness came out near white and read as a blank label stuck on
// the front of the belt, because it was four times brighter than everything around it.
S.zone(STEEL, (u, v) => {
  let c = W.steel(v / 5, u / 5, 0.30, 83, -0.30);
  c = W.mix(c, [0.062, 0.054, 0.048], clamp((W.fbm(u / 4, v / 4, 85, 4) - 0.52) * 3.2) * 0.60);
  return dull(c, 0.80);
});

S.zone(GRIP, (u, v) => {
  const d = clamp(v / GRIP.h), a = clamp(u / GRIP.w);
  // Chequered, worn smooth where a hand goes.
  let c = W.times([0.072, 0.064, 0.058], W.cylinderLight(a, 0.26) * grain(u, v, 89));
  const chq = Math.sign(Math.sin(u * 2.1)) * Math.sign(Math.sin(v * 2.1));
  c = W.times(c, 0.90 + 0.14 * chq);
  if (d > 0.62) c = W.times(c, 1.12);                             // the back strap, brighter
  return dull(c, 0.96);
});

S.zone(TIN, (u, v) => {
  const a = clamp(u / TIN.w);
  let c = W.times([0.118, 0.124, 0.108], W.cylinderLight(a, 0.34) * grain(u, v, 91));
  c = W.mix(c, [0.168, 0.092, 0.052], clamp((W.fbm(u / 4, v / 6, 93, 4) - 0.60) * 3.6) * 0.55);  // rust
  return dull(c, 0.92);
});

S.zone(BOMB, (u, v) => {
  const a = clamp(u / BOMB.w);
  let c = W.times([0.088, 0.098, 0.074], W.cylinderLight(a, 0.30) * grain(u, v, 97));
  // the ribbing of an old fragmentation body
  c = W.times(c, 0.88 + 0.16 * Math.sign(Math.sin(v * 1.6)));
  return dull(c, 0.94);
});

// ── 8. on to the model ─────────────────────────────────────────────────────
const names = K.bones(base).map((b) => b.name);
const need = (n) => {
  const i = names.indexOf(n);
  if (i < 0) throw new Error(`no bone "${n}" -- this model has: ${names.slice(0, 8).join(", ")}...`);
  return i;
};

const PELVIS = need("Bip01 Bacino");
// The spine, for the bandoliers. Bound to the pelvis like the belt they would tear off
// his chest the moment he bends, which is the one thing a waist belt never has to care
// about.
const SPINE = ["Bip01 Dorso", "Bip01 Dorso1", "Bip01 Dorso2", "Bip01 Dorso3"].map(need);

const P = K.poseAt(base, POSE.seq, POSE.frame);
const INTO = new Map([PELVIS, ...SPINE].map((b) => [b, K.inverse34(P[b])]));

const nearestSpine = (q) => {
  let best = SPINE[0], bd = Infinity;
  for (const b of SPINE) {
    const d = Math.hypot(P[b][0][3] - q[0], P[b][1][3] - q[1], P[b][2][3] - q[2]);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
};

/*
 * The plates ride the CLAVICLE, not the spine.
 *
 * A bandolier lies on the chest and is right to follow it. A pauldron sits on the
 * deltoid, and on the chest bone it would hold still while the shoulder swings out from
 * under it every stride -- which on this donor's run is a long way.
 */
const CLAV = ["Bip01 SX Clavicola", "Bip01 DX Clavicola"].map(need);
for (const b of CLAV) INTO.set(b, K.inverse34(P[b]));

const beltTris = MB.tris.map((t) => t.map((c) => ({ ...c, bone: PELVIS, to: INTO.get(PELVIS) })));
/*
 * The donor's own triangles, reattached bone for bone.
 *
 * Each corner keeps the bone it had on repuheavy, looked up BY NAME here because the two
 * models order the same skeleton differently. Its position is already in that bone's
 * space, so it is carried through this model's pose for the bone of the same name and
 * comes back out unchanged -- which is what puts the plate on the shoulder without a
 * single fitted number.
 */
/*
 * THE PLATES ARE SCALED ABOUT THEMSELVES AND SEATED ON HIS SHOULDER.
 *
 * The transfer itself is exact and needs nothing: both models wear the same skeleton
 * with the same bone matrices, so a plate held in bone space lands within a hundredth of
 * a unit of where it sat on the man it came off. That was never the problem.
 *
 * The problem is that it is a SHELL BUILT TO WRAP A SUIT OF ARMOUR. repuheavy's shoulder
 * rises to z 31.8; this donor's reaches 26.5, and the plate occupies 23.8 to 28.9 -- so
 * its whole upper half has nothing underneath it and hangs in the air, and the dark
 * underside that is hidden against armour on the donor is what you end up looking at.
 *
 * Every rigid placement was tried and none of them can work, because the plate is the
 * wrong SHAPE for this shoulder rather than in the wrong place: dropped onto him it is
 * swallowed, left alone it floats, tipped or squashed it does both in different places.
 * Shrink-wrapping it to the surface flattens it until it disappears.
 *
 * What does work is scaling it about ITS OWN CENTRE rather than about the shoulder
 * joint. Every earlier attempt scaled about the joint, which sits well inboard by his
 * neck, so shrinking the plate also dragged it inboard and down into his collar. Scaled
 * where it stands and then seated on the shoulder beneath it, it stays a plate -- the
 * donor's plate, with its panel and its frame -- just one cut down to a man this size.
 */
const PLATE_SCALE = 0.75;   // of the donor's, about the plate's own centre
const PLATE_SEAT = 0.5;     // how far it rests off the shoulder it sits on

/** The same bone on the other side of him, for the reflected plate. */
const mirrorOf = (b) => {
  const nm = donorNames ? names[b] : names[b];
  const other = nm.includes(" SX ") ? nm.replace(" SX ", " DX ") : nm.replace(" DX ", " SX ");
  const i = names.indexOf(other);
  return i >= 0 ? i : b;
};

const plateTris = [];
const groupOf = [];
{
  const g = plateGroups[0];
  const joint = need("Bip01 SX Clavicola");
  const mirrorJoint = need("Bip01 DX Clavicola");

  const flat = g.tris.flat();
  const world = flat.map((c) => K.apply34(P[need(donorNames[c.bone])], c.p));
  const centre = [0, 1, 2].map((k) => world.reduce((a, w) => a + w[k], 0) / world.length);

  let seat = null, best = Infinity;
  for (const q of surf) {
    const d = Math.hypot(q.p[0] - centre[0], q.p[1] - centre[1], q.p[2] - centre[2]);
    if (d < best) { best = d; seat = q; }
  }
  const rest = [0, 1, 2].map((k) => seat.p[k] + seat.n[k] * PLATE_SEAT);
  console.log(`  plate seated at y ${rest[1].toFixed(2)}, z ${rest[2].toFixed(2)}, mirrored to ${(-rest[1]).toFixed(2)}`);

  // The left shoulder, then the same plate reflected across y for the right. Reflecting
  // turns a mesh inside out, so the mirrored copy is wound back the other way.
  for (const side of [1, -1]) {
    const b0 = side > 0 ? joint : mirrorJoint;
    if (!INTO.has(b0)) INTO.set(b0, K.inverse34(P[b0]));
    let n = 0;
    for (const t of g.tris) {
      groupOf.push(side > 0 ? 0 : 1);
      const made = t.map((c) => {
        const b = side > 0 ? need(donorNames[c.bone]) : mirrorOf(need(donorNames[c.bone]));
        if (!INTO.has(b)) INTO.set(b, K.inverse34(P[b]));
        const w = world[n++];
        const q = [0, 1, 2].map((k) => rest[k] + (w[k] - centre[k]) * PLATE_SCALE);
        return {
          p: [q[0], side > 0 ? q[1] : -q[1], q[2]],
          uv: [c.s / g.tex.width, c.t / g.tex.height],
          bone: b, to: INTO.get(b),
        };
      });
      plateTris.push(side > 0 ? made : [made[0], made[2], made[1]]);
    }
  }
}
const chestTris = MC.tris.map((t) => t.map((c) => {
  const b = nearestSpine(c.p);
  return { ...c, bone: b, to: INTO.get(b) };
}));
const tris = [...beltTris, ...chestTris];

const texture = K.indexed(S.image(), "ins_prole_gear.bmp");

// This donor has ONE bodypart, so the rig goes in bodypart 0.
const where = { bodypart: 0, model: 0 };
const mesh = K.readMdl(bloody).bodyparts[0].models[0].meshes.length;

// texturesLast is not optional. The gear is an appended mesh and the paint above has
// already replaced every texture, so without it the texture block is no longer last --
// and a GoldSrc model whose textures are not last draws as NOTHING, silently, with
// check() reporting no errors at all. That is exactly why ins_medic_belt was invisible.
let built = K.replaceMesh(
  K.addMesh(bloody, where), { ...where, mesh },
  K.meshOf(null, tris, texture, PELVIS, 50), texture,
);

// Each plate keeps the donor's own sheet, resampled and worn, because its UVs are spread
// right across that sheet rather than sitting in one rectangle that could be cut out.
plateGroups.forEach((g, i) => {
  const tex = wornCopy(g.src, g.as);
  const at = K.readMdl(built).bodyparts[0].models[0].meshes.length;
  /*
   * REVERSED, because the plates come across inside out.
   *
   * meshOf works out which way a model winds its faces by comparing them with their
   * stored normals, and between this donor and repuheavy that answer comes out backwards:
   * the plates were built facing in, so what was drawn was the inside of each one. An
   * inside-out shoulder plate does not look like a hole, it looks like a correctly made
   * plate belonging to the OTHER shoulder, which is the whole reason this was so hard to
   * see -- from the left it read as a tidy right pauldron and the blue panel was behind
   * the geometry instead of on it.
   */
  // Both shoulders, since they are now one plate and its reflection off the same sheet.
  const got = plateTris.map((t) => [t[0], t[2], t[1]]);
  built = K.replaceMesh(
    K.addMesh(built, where), { ...where, mesh: at },
    // The DONOR'S OWN triangles are handed in as the reference, not null. meshOf works
    // out which way round a model winds its faces by comparing them against their stored
    // normals, and told nothing it assumes the generators' convention -- which is the
    // opposite of this donor's, so every plate rendered inside out and read as a black
    // shard lying on his shoulder.
    K.meshOf(g.tris, got, tex, CLAV[i], 50), tex,
  );
});

const out = texturesLast(built);

const spine = new Set(chestTris.flatMap((t) => t.map((c) => c.bone)));
console.log(`  rig: ${beltTris.length} triangles on the pelvis, ${chestTris.length} over ${spine.size} spine bones, ${plateTris.length} transplanted onto the shoulders`);

const r = K.check(out, "goldsrc");
console.log(`  ${r.facts ? r.facts.join("\n  ") : ""}`);
if (r.warnings?.length) console.log(`  ${r.warnings.join("\n  ")}`);

mkdirSync(join(OUT, "ins_proletarian"), { recursive: true });
writeFileSync(join(OUT, "ins_proletarian", "ins_proletarian.mdl"), checked("ins_proletarian", out));
console.log("  wrote export-mdl/ins_proletarian/ins_proletarian.mdl");

const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };
put("ins_prole_preview.png", K.lineup([["proletarian_dirty", base], ["ins_proletarian", out]],
  { ...POSE, yaws: [0, 90, 180, 270], zoom: 1.5, width: 300, cols: 8 }));
put("ins_prole_sheet.png", { width: SIZE, height: SIZE, rgba: K.rgbaOf(texture) });
// A run, because gear fastened to bones shows its mistakes in motion rather than in a
// pose: specifically whether his upper arms swing through the bandoliers, which a belt
// down at the waist never had to answer for.
put("ins_prole_run.png", K.strip(out, { seq: "run2", count: 6, cols: 6, width: 280, height: 400, yaw: 215 }));

// The torso close, because the gear is small and its worst failure is a texture that
// comes out at the wrong brightness: steel asked for at its own natural value rendered
// four times lighter than the sheet around it and read as a blank label on his belt.
// That is invisible in a full-figure preview and obvious here.
{
  const shots = [], labels = [];
  for (const [yaw, label] of [[0, "front"], [40, "front-left"], [-40, "front-right"], [90, "left"], [180, "back"]]) {
    shots.push(K.render(out, { ...POSE, yaw, pitch: 8, zoom: 2.9, target: [0, 0, 15], width: 300, height: 400 }));
    labels.push(label);
  }
  put("ins_prole_close.png", K.tile(shots, 5, labels));
}
