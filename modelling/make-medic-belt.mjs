// A field surgeon's belt, added to ins_medic.
//
//     node make-medic-belt.mjs     -> ../export-mdl/ins_medic_belt/ins_medic_belt.mdl
//
// A strap round the waist with a scavenged buckle at the front, surgical tools hung
// along his front and left -- scalpels, shears, a syringe and a bone saw -- and the
// medic bag still on his right hip.
//
// All of it is GEOMETRY on Bip01 Bacino, the pelvis, so the whole rig turns with his
// hips through all 171 animations instead of floating. One mesh, one texture.
//
// It chains onto the ins_medic the other script writes, deliberately: the belt variant
// IS that model plus a rig, so rebuilding it from merc would mean repainting the suit.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, checked, clamp, texturesLast, POSE } from "./lib.mjs";
import { profile } from "./waist.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const base = readFileSync(join(OUT, "ins_medic", "ins_medic.mdl"));

// ── the waist, measured rather than guessed ────────────────────────────────
// A belt is a band round a body, so it needs the body's actual cross-section: merc's
// waist is a low-poly octagon, 4.8 deep at the back and 6.1 across the sides, centred
// at x 2.34 rather than on the model axis. Hard-coding a circle puts a quarter of the
// strap inside him and the rest hanging off.
//
// Axes on this model, proven by painting one and looking:
//     +x is his FRONT, +y is his LEFT, +z is up.
// (docs/PLAYER-MODELS.md records +x as behind, which holds for the XCCP family. merc
// faces the other way, so the direction is measured per donor, never assumed.)
const WAIST = profile(2, 7);

const BZ = 4.6;          // the belt line: just above the medic bag, whose top is z 3.5
const BH = 1.05;         // half its height
const PROUD = 0.42;      // how far the strap stands off the skin
const INNER = 0.62;      // and how far its back edge sits inside, so no gap shows

// The strap dips under the weight it carries, which all hangs front-left, and wanders
// a little because nothing about this belt was made in a factory.
const sag = (a) => -0.26 * Math.max(0, Math.cos(a - 1.15)) ** 2;
const wob = (a) => 0.07 * Math.sin(a * 5 + 1.3) + 0.045 * Math.sin(a * 9 + 0.4);
const lift = (a) => sag(a) + wob(a);

/**
 * A frame on the belt at `deg` round the waist: `(out, along, up)` in units, where
 * `out` is away from the body, `along` runs towards his left, and `up` is up.
 *
 * Everything hung on the belt is built in one of these, so a tool is positioned by
 * the angle it hangs at and never by working out where that lands in model space.
 */
const frameAt = (deg) => {
  const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const r = WAIST.at(a), dz = lift(a);
  const f = (out, along, up) => [
    WAIST.cx + (r + out) * ca - along * sa,
    WAIST.cy + (r + out) * sa + along * ca,
    BZ + dz + up,
  ];
  f.inside = (out = -2.5) => f(out, 0, 0);
  return f;
};

// ── the sheet ──────────────────────────────────────────────────────────────
const SIZE = 256;
const S = W.sheet(SIZE, SIZE, [0.10, 0.10, 0.09]);
const M = W.shape(SIZE, SIZE);

const CANVAS  = { x:   2, y:   2, w:  72, h: 60 };   // the bag
const FLAP    = { x:   2, y:  66, w:  72, h: 34 };   // its flap, with the cross
const TRIM    = { x:  78, y:   2, w:  20, h: 60 };   // webbing: straps and loops
const VIAL    = { x:  78, y:  66, w:  46, h: 34 };   // the two vials
const BELT    = { x:   2, y: 104, w: 190, h: 20 };   // the strap itself
const BUCKLE  = { x:   2, y: 128, w:  44, h: 30 };
const STEEL   = { x:  50, y: 128, w:  56, h: 30 };   // bright instrument steel
const GRIP    = { x: 110, y: 128, w:  40, h: 30 };   // taped and wooden handles
const LEATHER = { x: 154, y: 128, w:  56, h: 30 };   // sheaths and tool loops
// A hanging tool is TALL, so its zone is tall. A lathe's zone is wide whatever it
// makes, because a lathe runs its profile along the zone's width and its turn down
// the height. Getting this backwards stretches a 34-pixel strip over six units of
// blade and the detail painted into it -- teeth, a handle, a graduation -- smears
// into streaks.
const SAW     = { x:   2, y: 162, w:  44, h: 88 };   // the bone saw blade, teeth and all
const BLADE   = { x:  50, y: 162, w:  36, h: 88 };   // scalpels
const SHEARS  = { x:  90, y: 162, w:  40, h: 88 };
const GLASS   = { x: 134, y: 162, w:  90, h: 30 };   // the syringe barrel, turned

// Corners 0 and 1 of every face are its BOTTOM pair, so their v is the bottom of the
// zone. Painting them the other way up flips every hanging tool, which is subtle on a
// strap and glaring on a saw: the teeth come out along its spine.
const UVQ = [[0.03, 0.97], [0.97, 0.97], [0.97, 0.03], [0.03, 0.03]];

/**
 * A box in a belt frame, from its three ranges.
 *
 * `warp(out, along, up)` moves each corner before it is placed, which is how the
 * tapers and the crossed shear blades are made -- there is no rotation in the frame
 * itself, so a blade that leans is a blade whose corners lean.
 */
function slab(f, oR, tR, uR, zone, opt = {}) {
  const { warp = (o, t, u) => [o, t, u], uv = UVQ, inside = null } = opt;
  const pick = (r, s) => (s < 0 ? r[0] : r[1]);
  const mid = (r) => (r[0] + r[1]) / 2;
  const at = inside ?? f(...warp(mid(oR), mid(tR), mid(uR)));
  // the six faces, each with one coordinate pinned; quad() settles the winding itself
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

// The strap's own face wanders by +/-0.05, so anything fastened to it starts here
// rather than at PROUD. Sharing a plane with it would z-fight, and on a belt that
// flickers wherever the player turns.
const ON = PROUD + 0.11;

/** A tool loop: the short tab of webbing that holds a thing against the strap. */
const loopAt = (f, halfWide) => slab(f, [ON, ON + 0.26], [-halfWide, halfWide], [-BH * 0.95, BH * 0.95], LEATHER);

// ── the strap ──────────────────────────────────────────────────────────────
// Outer face, top rim and bottom rim. The inner face is left off: it is against his
// body at every angle, so it is never drawn and the vertices would be spent for nothing.
const SEG = 24;
const BODY_AXIS = [WAIST.cx, WAIST.cy, BZ];
const thick = (a) => PROUD + 0.04 * Math.sin(a * 7 + 2.1);     // hand-cut, not milled
{
  const ring = Array.from({ length: SEG + 1 }, (_, k) => {
    const a = 2 * Math.PI * k / SEG, ca = Math.cos(a), sa = Math.sin(a);
    const r = WAIST.at(a), dz = lift(a);
    const p = (out, up) => [WAIST.cx + (r + out) * ca, WAIST.cy + (r + out) * sa, BZ + dz + up];
    const u = BELT.x + BELT.w * (k / SEG);
    return {
      ot: M.V(p(thick(a), BH), [u, BELT.y + BELT.h * 0.04]),
      ob: M.V(p(thick(a), -BH), [u, BELT.y + BELT.h * 0.96]),
      it: M.V(p(-INNER, BH * 0.86), [u, BELT.y + BELT.h * 0.30]),
      ib: M.V(p(-INNER, -BH * 0.86), [u, BELT.y + BELT.h * 0.70]),
    };
  });
  for (let k = 0; k < SEG; k++) {
    const a = ring[k], b = ring[k + 1];
    M.quad(a.ot, b.ot, b.ob, a.ob, BODY_AXIS);        // the face you see
    M.quad(a.it, b.it, b.ot, a.ot, BODY_AXIS);        // top rim
    M.quad(a.ob, b.ob, b.ib, a.ib, BODY_AXIS);        // bottom rim
  }
}

// ── does the strap actually clear him? ─────────────────────────────────────
// Looking at a render is not enough. A tenth of a unit of shirt coming through the
// leather is invisible in a 400-pixel preview and plain in game, and it shows from
// the angles a preview of three yaws does not include -- which is how it was found:
// from behind. So every body vertex the strap passes is measured against it.
//
// Against the strap's POLYGON, not the circle through its corners: a 24-sided ring
// dips inward between them, and that dip is the same order as the error being hunted.
{
  const beltR = (a) => {
    const k = Math.floor((((a / (2 * Math.PI)) * SEG) % SEG + SEG) % SEG);
    const corner = (j) => {
      const b = 2 * Math.PI * j / SEG, r = WAIST.at(b) + thick(b);
      return [r * Math.cos(b), r * Math.sin(b)];
    };
    const A = corner(k), B = corner(k + 1);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const den = Math.cos(a) * dy - Math.sin(a) * dx;
    return Math.abs(den) < 1e-9 ? Infinity : (A[0] * dy - A[1] * dx) / den;
  };

  const lo = BZ - BH - 0.45, hi = BZ + BH + 0.45;
  let worst = Infinity, at = 0;
  for (const s of K.surface(base, POSE)) {
    if (s.p[2] < lo || s.p[2] > hi) continue;
    const dx = s.p[0] - WAIST.cx, dy = s.p[1] - WAIST.cy, r = Math.hypot(dx, dy);
    if (r > 8.5) continue;                            // his hands hang here, not his waist
    const gap = beltR(Math.atan2(dy, dx)) - r;
    if (gap < worst) { worst = gap; at = Math.atan2(dy, dx) * 180 / Math.PI; }
  }
  console.log(`  strap clears him by ${worst.toFixed(2)} at its tightest, ${at.toFixed(0)} degrees round`);
  if (worst < 0.05) {
    throw new Error(`the strap cuts ${(-worst).toFixed(2)} into him at ${at.toFixed(0)} degrees: raise PROUD, or widen the band profile() measures`);
  }
}

// ── the buckle, dead front ─────────────────────────────────────────────────
{
  const f = frameAt(0);
  slab(f, [ON, ON + 0.55], [-2.1, 2.1], [-BH - 0.35, BH + 0.35], BUCKLE);
  slab(f, [ON + 0.50, ON + 0.72], [-0.28, 0.28], [-BH - 0.6, BH + 0.6], STEEL);     // the prong
  // the loose tail of the strap, tucked through and hanging
  slab(f, [ON, ON + 0.18], [-3.0, -2.0], [-BH - 2.4, BH * 0.6], BELT,
       { warp: (o, t, u) => [o, t + 0.10 * u, u] });
}

// ── scalpels, front-left ───────────────────────────────────────────────────
{
  const f = frameAt(28);
  slab(f, [ON, ON + 0.24], [-1.95, 1.95], [-BH * 1.05, BH * 1.05], LEATHER);
  for (const t of [-1.15, 0, 1.15]) {
    // handle above the roll, blade below it, narrowing to the point
    slab(f, [ON + 0.20, ON + 0.46], [t - 0.30, t + 0.30], [-1.9, 1.4], BLADE, {
      warp: (o, tt, u) => [o, t + (tt - t) * (u < -1.0 ? 0.5 : 1), u],
    });
  }
}

// ── shears, hanging ────────────────────────────────────────────────────────
{
  const f = frameAt(56);
  loopAt(f, 0.75);
  // Two blades crossing: the same slab sheared opposite ways, which reads as a pivot.
  // Barely crossed on purpose -- opened to any angle worth seeing, a pair of shears
  // stops reading as a tool hanging shut and starts reading as a pale V.
  for (const k of [0.09, -0.09]) {
    slab(f, [ON + 0.18, ON + 0.42], [-0.34, 0.34], [-3.1, 1.2], SHEARS, {
      warp: (o, t, u) => [o, t + k * u, u],
    });
  }
}

// ── a syringe in a tube loop ───────────────────────────────────────────────
{
  const f = frameAt(84);
  loopAt(f, 0.72);
  const axis = (s, a, b) => f(ON + 0.56 + b, a, 1.0 - s);        // s runs down from the loop
  M.lathe([[0, 0], [0.12, 0.50], [2.7, 0.50], [2.82, 0.32]], GLASS, { sides: 7, px: 11, at: axis });
  M.lathe([[2.82, 0.10], [4.4, 0.05]], STEEL, { sides: 5, px: 9, at: axis });            // the needle
  slab(f, [ON + 0.32, ON + 0.80], [-0.56, 0.56], [0.95, 1.40], STEEL);                   // the plunger head
}

// ── a bone saw on his left hip ─────────────────────────────────────────────
{
  const f = frameAt(112);
  loopAt(f, 1.25);
  // the blade hangs flat against him, thin off the belt, its teeth on the forward edge
  slab(f, [ON + 0.16, ON + 0.34], [-0.95, 0.95], [-5.4, 0.6], SAW, {
    warp: (o, t, u) => [o, t * (u < -3.6 ? 0.58 : 1), u],
  });
  M.lathe([[-1.3, 0.50], [1.3, 0.50]], GRIP, {
    sides: 6, px: 9,
    at: (s, a, b) => f(ON + 0.25 + b, s, 1.35 + a),              // the grip, across the top
  });
}

// ── the medic bag, on his right hip ────────────────────────────────────────
// MEASURE THE TORSO, NOT THE BAND. The first version of this put the kit at y -12.3,
// taken from "the right hip reaches -12.2 over z -4..6" -- but the HANDS hang in that
// same band (Bip01 DX Mano is at x 3.9, y -10.5, z 1.3), so that figure was the hand.
// The kit ended up six units outboard of the hip, floating beside his wrist.
//
// The torso alone, which is what a belt sits on:
//
//     z   2.. 6   ymin -5.8   the hip
//     z  -2.. 2   ymin -6.1
//     z  -6..-2   ymin -8.5   the thigh, WIDER than the waist
//
// So the bag is pushed forward in x, onto the front of the hip rather than its side:
// anything deep enough to read as a satchel otherwise clips the thigh below or crowds
// the hand outboard. The waist runs x -2.4 (back) to 7.2 (front), so 3.3 is just
// forward of the middle, where a belt pouch rides.
//
// y is pushed further out than the hip surface alone suggests, because at -4.6 the
// inner face sat well inside the torso and the bag clipped through it. Out here only
// enough of it is buried to read as strapped on, and it still clears the right hand.
//
// Its top lands at z 3.5, right under the strap, so the belt passes behind it and the
// bag hangs off the belt rather than beside it.
const C = { x: 3.3, y: -6.6, z: 0.4 };
const D = { x: 2.5, y: 2.7, z: 4.0 };        // half depth, half width out, half height

const bulge = (sx, sy, sz) => [
  C.x + sx * D.x * (1 - 0.14 * Math.abs(sy) - 0.10 * Math.abs(sz)),
  C.y + sy * D.y * (1 - 0.12 * Math.abs(sx) - 0.10 * Math.abs(sz)),
  C.z + sz * D.z * (1 - 0.10 * Math.abs(sx) - 0.12 * Math.abs(sy)),
];
const uvBox = (zone, a, b) => [zone.x + zone.w * a, zone.y + zone.h * b];
const inside = [C.x, C.y, C.z];

// six faces, each a quad; `inside` tells quad() which way to wind
const FACES = [
  { c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },   // outer, away from him
  { c: [[1, 1, -1], [-1, 1, -1], [-1, 1, 1], [1, 1, 1]] },       // against his hip
  { c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },       // front
  { c: [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]] },   // back
  { c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },       // top
  { c: [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]] },   // bottom
];
for (const f of FACES) {
  const vs = f.c.map((s, i) => M.V(bulge(...s), uvBox(CANVAS, [0.02, 0.98, 0.98, 0.02][i], [0.02, 0.02, 0.98, 0.98][i])));
  M.quad(vs[0], vs[1], vs[2], vs[3], inside);
}

// the flap, folded over the top and down the outer face
const FL = [
  [[-1.02, 0.95, 1.06], [1.02, 0.95, 1.06], [1.02, -1.06, 1.06], [-1.02, -1.06, 1.06]],   // over the top
  [[-1.02, -1.06, 1.06], [1.02, -1.06, 1.06], [1.02, -1.08, 0.10], [-1.02, -1.08, 0.10]], // down the front of it
];
FL.forEach((q, k) => {
  const vs = q.map((s, i) => M.V(bulge(...s), uvBox(FLAP, [0.02, 0.98, 0.98, 0.02][i], k === 0 ? [0.02, 0.02, 0.5, 0.5][i] : [0.5, 0.5, 0.98, 0.98][i])));
  M.quad(vs[0], vs[1], vs[2], vs[3], inside);
});

// The loop that hangs it on the strap. This used to be a short post standing on the
// bag's top, which was buried inside the bag and never drew a pixel. It is now a tab
// on the OUTER face of the strap, bridging the belt down to the bag, which is the one
// place a viewer can actually see the join.
{
  const f = frameAt(-82);
  slab(f, [ON, ON + 0.20], [-1.1, 1.1], [-BH - 1.0, BH + 0.18], TRIM);
}

// two vials strapped to the front of the bag
for (const [i, dz] of [[0, 0.95], [1, 0.05]]) {
  M.lathe([[0, 0.42], [0.35, 0.52], [2.5, 0.52], [2.85, 0.40]], { ...VIAL, x: VIAL.x + i * 23, w: 23 }, {
    sides: 7, px: 7,
    at: (s, a, b) => [C.x + D.x * 1.06 + b * 0.9, C.y - D.y * 0.1 + a, C.z + dz - s],
  });
}

// ── and does what hangs off it clear him? ──────────────────────────────────
// The strap is a ring and can be checked against a ring. What hangs below it cannot:
// down there the body stops being one mass and becomes two thighs, which at z -3 reach
// 8.3 out against the waist's 6.1. So each hung corner is measured only against the
// body vertices actually near it, in height and in bearing both.
//
// It warns where the strap throws. One radius-per-bearing reads two legs as a solid
// drum, so a tool hanging in the gap between them is reported while sitting in clear
// air, and only the render tells the two apart.
{
  const body = K.surface(base, POSE)
    .map((s) => ({
      z: s.p[2],
      a: Math.atan2(s.p[1] - WAIST.cy, s.p[0] - WAIST.cx),
      r: Math.hypot(s.p[0] - WAIST.cx, s.p[1] - WAIST.cy),
    }))
    .filter((p) => p.r < 9.5);

  const bite = [];
  for (const t of M.tris) {
    for (const c of t) {
      const a = Math.atan2(c.p[1] - WAIST.cy, c.p[0] - WAIST.cx);
      // Skip the strap, which has its own check -- down to where it actually hangs at
      // this bearing, not to a flat BZ - BH. It sags a quarter of a unit under the
      // tools, and a flat cut leaves its inner rim below the line to be reported as
      // 0.62 inside him, which is exactly what INNER puts it there to be.
      if (c.p[2] > BZ + lift(a) - BH - 0.02) continue;
      const r = Math.hypot(c.p[0] - WAIST.cx, c.p[1] - WAIST.cy);
      let near = 0;
      for (const p of body) {
        if (Math.abs(p.z - c.p[2]) > 1.2) continue;
        let d = Math.abs(p.a - a);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d < 0.21 && p.r > near) near = p.r;        // twelve degrees either side
      }
      if (near && r < near) bite.push({ into: near - r, a: a * 180 / Math.PI, z: c.p[2] });
    }
  }
  // Reported by bearing, not as one worst number. The bag's inner face is buried on
  // purpose, so it is always the worst corner on the model and would hide everything
  // else behind it for ever.
  bite.sort((x, y) => y.into - x.into);
  const apart = (p, q) => Math.abs(((p - q + 540) % 360) - 180);
  const seen = [];
  for (const b of bite) {
    if (seen.some((s) => apart(s.a, b.a) < 25)) continue;
    seen.push(b);
    if (seen.length === 4) break;
  }
  if (!seen.length) {
    console.log("  everything hung on the strap clears him");
  } else {
    console.log(`  ${bite.length} hung corners read as inside him, worst by bearing:`);
    for (const b of seen) console.log(`     ${b.into.toFixed(2)} in at ${b.a.toFixed(0).padStart(4)} degrees, z ${b.z.toFixed(1)}`);
  }
}

// ── the paint ──────────────────────────────────────────────────────────────
S.zone(CANVAS, (u, v) => {
  const n = W.fbm(u / 5, v / 5, 3, 6), weave = 0.5 + 0.5 * Math.sin(u * 2.2) * Math.sin(v * 2.2);
  let c = W.times([0.22, 0.215, 0.17], 0.70 + 0.55 * n + 0.14 * weave);            // filthy canvas
  const wear = clamp((W.fbm(u / 9 + 4, v / 9, 5, 5) - 0.56) * 5);
  c = W.mix(c, W.times([0.34, 0.33, 0.27], 1), wear * 0.5);                        // rubbed pale
  const stain = clamp((W.fbm(u / 7 + 11, v / 4, 2, 5) - 0.52) * 4) * clamp(v / CANVAS.h + 0.2);
  return W.mix(c, [0.085, 0.028, 0.022], stain * 0.55);                            // and bloodied
});

S.zone(FLAP, (u, v) => {
  const n = W.fbm(u / 5 + 20, v / 5, 7, 6);
  let c = W.times([0.19, 0.185, 0.15], 0.70 + 0.55 * n);
  // the cross: faded, flaking, off true -- it has been through something
  const cx = FLAP.w * 0.5 + 1.5, cy = FLAP.h * 0.52, A = 11.5, B = 3.6;
  const inCross = (Math.abs(u - cx) < A && Math.abs(v - cy) < B) || (Math.abs(u - cx) < B && Math.abs(v - cy) < A);
  if (inCross) {
    const flake = clamp((W.fbm(u / 2.2 + 3, v / 2.2, 9, 4) - 0.44) * 3.4);
    c = W.mix(c, W.times([0.46, 0.085, 0.07], 0.75 + 0.5 * n), 0.92 - flake * 0.75);
  }
  const scuff = clamp((W.fbm(u / 8 + 31, v / 8, 4, 5) - 0.58) * 5);
  c = W.mix(c, W.times([0.30, 0.29, 0.24], 1), scuff * 0.45);
  return W.mix(c, [0.08, 0.026, 0.02], clamp((W.fbm(u / 6 + 2, v / 3, 6, 5) - 0.56) * 4) * 0.5);
});

S.zone(TRIM, (u, v) => {
  const light = W.cylinderLight(u / TRIM.w, 0.45), n = W.fbm(u / 3, v / 3, 8, 5);
  return W.times([0.14, 0.125, 0.10], light * (0.75 + 0.5 * n));                   // webbing strap
});

S.zone(VIAL, (u, v) => {
  const light = W.cylinderLight(v / VIAL.h, 0.5), n = W.fbm(u / 3 + 7, v / 3, 10, 5);
  const cap = u % 23 < 5.5;
  const body = cap ? [0.26, 0.25, 0.23] : [0.34, 0.37, 0.30];                      // dull glass, metal cap
  let c = W.times(body, light * (0.78 + 0.42 * n));
  if (!cap) c = W.mix(c, [0.17, 0.16, 0.09], clamp((W.fbm(u / 2, v / 2, 12, 4) - 0.5) * 3) * 0.5);
  return c;
});

// The strap. v runs across its width, u the whole way round him, so the stitching and
// the rivets are laid out in u and the rounding of the leather is painted in v.
S.zone(BELT, (u, v) => {
  const t = clamp(v / BELT.h);
  const n = W.fbm(u / 7, v / 4, 61, 5);
  let c = W.times([0.185, 0.125, 0.082], 0.70 + 0.58 * n);
  c = W.times(c, 0.58 + 0.46 * Math.sin(Math.PI * t) ** 0.5);                      // rounded, dark at the edges
  const scuff = clamp((W.fbm(u / 4 + 9, v / 2.6, 66, 5) - 0.55) * 4.5);
  c = W.mix(c, [0.33, 0.27, 0.20], scuff * 0.55);                                  // rubbed through to the pale side
  const crack = clamp((W.fbm(u / 1.6 + 40, v / 1.2, 69, 3) - 0.63) * 6);
  c = W.times(c, 1 - crack * 0.5);                                                 // dried and split
  for (const row of [0.21, 0.79]) {
    const d = Math.abs(t - row) * BELT.h;
    if (d < 1.0 && u % 5 < 2.7) c = W.mix(c, [0.40, 0.36, 0.28], 0.5 * (1 - d));    // stitching, coming loose
  }
  const r = W.rivet(u % 38, v, 19, BELT.h / 2, 2.3);
  if (r) c = r.light ? W.times([0.30, 0.28, 0.25], r.light) : W.times(c, 1 - r.shadow);
  return c;
});

S.zone(BUCKLE, (u, v) => {
  const light = 1.04 + 0.30 * Math.cos(Math.PI * (v / BUCKLE.h - 0.32));
  // steel rather than iron: a buckle is the one bright thing on him, and iron came out
  // so dark that the whole front of the belt read as another patch of leather
  let c = W.steel(u / 3.5, v / 3.5, light, 71, 0.30);
  // the hollow of the frame, painted rather than cut: at the size this is seen a real
  // hole would cost four more quads and read the same
  const f = 7;
  if (u > f && u < BUCKLE.w - f && v > f * 0.8 && v < BUCKLE.h - f * 0.8) {
    c = W.times(c, 0.26 + 0.10 * W.fbm(u / 2, v / 2, 73, 3));
  }
  return c;
});

// Instrument steel, knocked back. At its natural value it comes out brighter than
// anything else he wears -- a white stick against an olive shirt, which is what the
// first build looked like -- so every metal on this belt is dulled into the model's
// own range before it goes on.
const dull = (c, k = 0.58) => W.times(c, k);

S.zone(STEEL, (u, v) => dull(W.steel(u / 4, v / 4, W.cylinderLight(v / STEEL.h, 0.40), 77, -0.20), 0.66));

S.zone(GRIP, (u, v) => {
  const light = W.cylinderLight(v / GRIP.h, 0.46);
  let c = W.wood(u / 3, v / 3, light, 83, [[0.21, 0.14, 0.08], [0.35, 0.25, 0.15]]);
  // bound with tape where the wood split
  if (u % 17 < 7) c = W.mix(c, W.times([0.16, 0.15, 0.13], light * (0.8 + 0.4 * W.fbm(u / 2, v / 2, 85, 3))), 0.8);
  return W.mix(c, [0.09, 0.03, 0.025], clamp((W.fbm(u / 5 + 3, v / 3, 87, 4) - 0.58) * 4) * 0.45);
});

S.zone(LEATHER, (u, v) => {
  const c = W.leatherWrap(u / 9, v / LEATHER.h, 91, [0.17, 0.11, 0.07]);
  return W.mix(c, [0.26, 0.22, 0.17], clamp((W.fbm(u / 4 + 6, v / 3, 93, 4) - 0.58) * 4) * 0.5);
});

// The saw, hanging: v runs DOWN the blade and u across it, so the teeth are cut into
// one long edge and the spine thickens along the other.
S.zone(SAW, (u, v) => {
  const a = clamp(u / SAW.w);
  let c = W.steel(v / 6, u / 5, 0.96 + 0.20 * Math.cos(Math.PI * (a - 0.4)), 97, -0.10);
  const tooth = 0.5 + 0.5 * Math.sin(v * 1.45);
  if (a < 0.18) {
    const bite = (0.18 - a) / 0.18;
    c = bite > tooth * 0.85 ? [0.06, 0.055, 0.05] : W.times(c, 0.78 + 0.55 * tooth);  // the set of the teeth
  }
  if (a > 0.86) c = W.times(c, 0.58);                                                 // the thicker spine
  const dirt = clamp((W.fbm(v / 6 + 15, u / 4, 99, 5) - 0.54) * 3.5);
  return dull(W.mix(c, [0.11, 0.04, 0.03], dirt * 0.45), 0.70);                       // and what it was used on
});

S.zone(GLASS, (u, v) => {
  const light = W.cylinderLight(v / GLASS.h, 0.52);
  let c = W.times([0.40, 0.43, 0.38], light * (0.80 + 0.35 * W.fbm(u / 3, v / 3, 101, 4)));
  if (u % 9 < 1.6) c = W.times(c, 0.62);                                            // graduations
  const dose = clamp((u - GLASS.w * 0.45) / 3);
  c = W.mix(c, W.times([0.30, 0.26, 0.09], light), dose * 0.7);                      // something amber left in it
  return c;
});

// Scalpels, slotted into the roll: v runs DOWN, so the taped handle is the top third
// and the blade the rest. It is the one thing on this belt he keeps clean.
S.zone(BLADE, (u, v) => {
  const d = clamp(v / BLADE.h), a = clamp(u / BLADE.w);
  const grip = d < 0.52;                                        // the top half is taped handle
  let c = W.steel(v / 4, u / 4, 0.99 + 0.24 * Math.cos(Math.PI * (a - 0.3)), 103, grip ? 0.25 : -0.55);
  if (grip) return W.times(W.mix(c, [0.12, 0.11, 0.10], 0.78), 0.9 + 0.3 * W.fbm(v / 2, u / 2, 105, 3));
  return dull(c, 0.62);
});

// Shears, hanging handles up: the finger rings are painted into the top of the zone
// because two real holes would cost a dozen quads and read the same at this size.
S.zone(SHEARS, (u, v) => {
  const d = clamp(v / SHEARS.h), a = clamp(u / SHEARS.w);
  let c = W.steel(v / 5, u / 5, 0.95 + 0.24 * Math.cos(Math.PI * (a - 0.3)), 107, -0.25);
  for (const cy of [0.09, 0.23]) {
    const dd = Math.hypot((a - 0.5) / 0.44, (d - cy) / 0.072);
    if (dd < 1) c = W.times(c, 0.26 + 0.30 * dd);
  }
  if (d > 0.55) c = W.times(c, 1.07);                                                 // the blades, brighter
  return dull(W.mix(c, [0.10, 0.035, 0.028], clamp((W.fbm(v / 5 + 21, u / 3, 109, 4) - 0.60) * 4) * 0.40), 0.60);
});

// ── on to the model ────────────────────────────────────────────────────────
const names = K.bones(base).map((b) => b.name);
const bone = names.indexOf("Bip01 Bacino");
if (bone < 0) throw new Error(`no pelvis bone -- this model has: ${names.slice(0, 6).join(", ")}...`);

const texture = K.indexed(S.image(), "ins_medkit.bmp");
const P = K.poseAt(base, POSE.seq, POSE.frame);
const to = K.inverse34(P[bone]);

// merc has ONE bodypart, unlike the XCCP family's two, so the rig goes in bodypart 0.
// ts-trial's hang() hard-codes bodypart 1 because it only ever targeted XCCPsgts.
const where = { bodypart: 0, model: 0 };
const mesh = K.readMdl(base).bodyparts[0].models[0].meshes.length;
const tris = M.tris.map((t) => t.map((c) => ({ ...c, bone, to })));

// texturesLast is not optional: the mesh goes on the end of the file, and without it
// the textures are no longer last and the whole model draws as nothing.
const out = texturesLast(K.replaceMesh(
  K.addMesh(base, where), { ...where, mesh },
  K.meshOf(null, tris, texture, bone, 55), texture,
));

console.log(`  rig: ${M.tris.length} triangles on ${names[bone]}`);
const r = K.check(out, "goldsrc");
console.log(`  ${r.facts ? r.facts.join("\n  ") : ""}`);

mkdirSync(join(OUT, "ins_medic_belt"), { recursive: true });
writeFileSync(join(OUT, "ins_medic_belt", "ins_medic_belt.mdl"), checked("ins_medic_belt", out));
console.log("  wrote export-mdl/ins_medic_belt/ins_medic_belt.mdl");

const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };
put("belt_preview.png", K.lineup([["ins_medic", base], ["ins_medic_belt", out]], { ...POSE, yaws: [40, 140, 230], zoom: 1.5, width: 320, cols: 6 }));
put("belt_sheet.png", { width: SIZE, height: SIZE, rgba: K.rgbaOf(texture) });
// A run, because a thing fastened to one bone shows its mistakes in motion, not in a pose.
put("belt_run.png", K.strip(out, { seq: "run2", count: 6, cols: 6, width: 280, height: 400, yaw: 215 }));
