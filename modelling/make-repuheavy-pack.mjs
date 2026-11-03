// A military pack on the back of four of the heavies.
//
//     node make-repuheavy-pack.mjs                 all four
//     node make-repuheavy-pack.mjs repuheavy       just that one
//
// Black cordura, a lid, three stacked cargo compartments, two side pouches and the straps over the
// shoulders. Built as COPIES under new names, so the models already in the class pools are left
// exactly as they are and nothing has to be switched over before it has been looked at.
//
// THE NAMES ARE SHORT FOR A REASON. TS keeps a player model's path in a 64-byte buffer, so
// `models/player/<n>/<n>.mdl` has to come to 63 characters or fewer -- which caps the name at 22.
// Over that the server dies in Mod_NumForName with nothing in the AMXX log to say why.
//
// WHAT THE SHAPE IS MADE OF, and why it is boxes. Every face carries its own normal (`n` on the
// corner), and every box is axis-aligned, so all of them share the same six normals rather than
// each corner needing three of its own. That matters: the normal table is what the pack has to fit
// into, not the vertex table. See the budget printed for each donor below.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, IN, surface, boneIndex, checked, POSE } from "./lib.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");

/*
 * The four, and what each one is called when it is built.
 *
 * repuheavy_bfem does not exist on disk: only repuheavy_bfem_nhelm is installed, so the blonde
 * variant is built from that. Its name still comes out as the short one.
 */
const BUILDS = [
  { donor: "repuheavy", name: "repuheavy_pack" },
  { donor: "repuheavy_fem", name: "repuheavy_fem_pack" },
  { donor: "repuheavy_bfem_nhelm", name: "repuheavy_bfem_pack" },
  { donor: "repuheavyw", name: "repuheavyw_pack" },
];

const SPINE = "Dorso3";          // Bip01 Dorso3, the upper spine, which the whole pack hangs on
const SMOOTH = 40;               // unused for shading here, since every corner brings its own `n`

/* ---- the picture ---------------------------------------------------------------------------- */
const TW = 64;
const TH = 64;

/**
 * Black cordura: a weave too fine to see, lighter stitching, and the hardware.
 *
 * Drawn rather than photographed because the compartments are flat on the texture and not in the
 * geometry -- there is no vertex budget for a buckle. At player scale the seams and the lighter
 * strap webbing are what make it read as a pack rather than as a black box.
 */
function packTexture() {
  const rgb = Buffer.alloc(TW * TH * 3);
  const put = (x, y, r, g, b) => {
    const i = (y * TW + x) * 3;
    rgb[i] = Math.max(0, Math.min(255, Math.round(r)));
    rgb[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
    rgb[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
  };

  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      // the weave: a two-pixel checker at very low contrast, which is all cordura is up close
      const weave = ((x >> 1) + (y >> 1)) % 2 ? 3 : 0;
      let v = 22 + weave;

      // horizontal seams, where one compartment is stitched onto the next
      if (y % 21 === 0 || y % 21 === 1) v = 40;
      // the webbing ladder down each side, which is the only light thing on a black pack
      if ((x > 4 && x < 9) || (x > TW - 10 && x < TW - 5)) v = y % 6 < 3 ? 46 : 30;
      // stitching along the outside of the webbing
      if (x === 4 || x === 9 || x === TW - 10 || x === TW - 5) v = 52;
      // buckle hardware, a dull grey bar on each seam
      if (y % 21 === 11 && x > 24 && x < 40) v = 96;
      if (y % 21 === 12 && x > 24 && x < 40) v = 64;

      put(x, y, v * 1.0, v * 1.02, v * 1.08);   // a hair blue, so it is not dead neutral
    }
  }

  return K.indexed({ width: TW, height: TH, rgb }, "repupackt.bmp", 256);
}

/* ---- the shape ------------------------------------------------------------------------------ */
/*
 * The model faces +x, y is across him and z is up, so the pack sits at NEGATIVE x from the back.
 * `b` below is where that back actually IS, measured per donor -- the four differ by 4.4 units
 * across the shoulder blades, which is more than the lid is thick, so one fixed number would float
 * the pack off one of them and bury it in another.
 */
/*
 * WHERE THE BACK IS, measured off each donor between z 9 and 26.
 *
 * Measured and not written down, because the four do not agree: his shoulder blades stand at
 * x -5.5 and hers at -1.4, which is more than the pack is thick. One fixed number floats it off
 * one of them and buries it in another.
 *
 * It is the 20th PERCENTILE of the back's x and not its minimum. The minimum is whatever sticks
 * out furthest -- a shoulder blade, a strap boss -- and hanging the pack off that leaves it clear
 * of the back everywhere else, which is what made it look bolted to the air behind them. A fifth
 * of the way in is the surface the pack would actually rest against.
 */
function backOf(src) {
  const pts = surface(src, POSE).filter((s) => s.p[2] > PACK_Z[0] && s.p[2] < PACK_Z[1] && Math.abs(s.p[1]) < 6);
  if (!pts.length) throw new Error(`found no back surface between z ${PACK_Z[0]} and ${PACK_Z[1]}`);
  const xs = pts.map((s) => s.p[0]).sort((a, b) => a - b);
  return xs[Math.floor(xs.length * 0.2)];
}

/*
 * HOW BIG IT IS, against the body it goes on rather than against nothing.
 *
 * These models stand from z -36 to z 38: the shoulders are at about 26, the head begins near 31,
 * and the waist is around 8. So a pack belongs between 9 and 26 -- shoulder blades to the small of
 * the back. Built to z 33 it reached past the top of the helmet, which is how it came out looking
 * like a wardrobe rather than something a man is carrying.
 *
 * Depth is 8 all in. At the eleven it started as, it stood further off the back than the chest is
 * deep, and on the two women -- whose backs are nearly flat where his is not -- that read as a
 * crate following them around.
 */
const PACK_Z = [9, 26];

const BOXES = (b) => [
  // the body of the pack, biting 1 into the back so no gap can open between them
  { lo: [b - 5.5, -6.4, 9.0], hi: [b + 1.0, 6.4, 26.0] },
  // three cargo compartments down its back, each proud of the body
  { lo: [b - 6.9, -5.3, 10.0], hi: [b - 5.5, 5.3, 14.4] },
  { lo: [b - 7.3, -5.3, 15.2], hi: [b - 5.5, 5.3, 19.6] },
  { lo: [b - 6.9, -5.3, 20.4], hi: [b - 5.5, 5.3, 24.4] },
  // a pouch on each side
  { lo: [b - 5.0, -8.1, 12.0], hi: [b - 1.0, -6.4, 20.5] },
  { lo: [b - 5.0, 6.4, 12.0], hi: [b - 1.0, 8.1, 20.5] },
  // the roll across the top, which is what gives it a silhouette from the side
  { lo: [b - 6.2, -6.0, 26.0], hi: [b - 0.5, 6.0, 28.4] },
  // the straps over the shoulders
  { lo: [b - 0.5, -5.2, 23.0], hi: [b + 3.6, -2.6, 29.2] },
  { lo: [b - 0.5, 2.6, 23.0], hi: [b + 3.6, 5.2, 29.2] },
];

/** The six faces of a box, each with its own outward normal, wound as the format expects. */
function boxTris(mesh, lo, hi) {
  const [x0, y0, z0] = lo;
  const [x1, y1, z1] = hi;
  // each face: its four corners anticlockwise seen from outside, and the way it looks
  const faces = [
    { n: [-1, 0, 0], p: [[x0, y1, z1], [x0, y0, z1], [x0, y0, z0], [x0, y1, z0]] },
    { n: [1, 0, 0], p: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]] },
    { n: [0, -1, 0], p: [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]] },
    { n: [0, 1, 0], p: [[x1, y1, z1], [x0, y1, z1], [x0, y1, z0], [x1, y1, z0]] },
    { n: [0, 0, -1], p: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]] },
    { n: [0, 0, 1], p: [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]] },
  ];

  /*
   * The picture is wrapped by WORLD position rather than per face, so the webbing runs unbroken
   * down the sides of the pack and over the pouches instead of restarting on every box.
   */
  const uv = (p) => [
    Math.round((((p[1] - (-9)) / 18) * (TW - 1) + TW) % (TW - 1)),
    Math.round((((28.4 - p[2]) / 19.4) * (TH - 1) + TH) % (TH - 1)),
  ];

  for (const f of faces) {
    const v = f.p.map((p) => ({ ...mesh.V(p, uv(p), 0), n: f.n }));
    // quad() turns the face away from the point given last, so that point goes behind the face
    mesh.quad(v[0], v[1], v[2], v[3], [
      (x0 + x1) / 2 - f.n[0] * 20,
      (y0 + y1) / 2 - f.n[1] * 20,
      (z0 + z1) / 2 - f.n[2] * 20,
    ]);
  }
}

/* ---- building one --------------------------------------------------------------------------- */
function build({ donor, name }) {
  const base = join(IN, donor, `${donor}.mdl`);
  const src = K.withTextures
    ? readFileSync(base)
    : readFileSync(base);
  const whole = (() => {
    const t = join(IN, donor, `${donor}t.mdl`);
    try {
      return K.withTextures(src, readFileSync(t));
    } catch {
      return src;
    }
  })();

  const before = K.readMdl(whole).bodyparts[0].models[0];
  const b = backOf(whole);
  const bone = boneIndex(whole)(SPINE);

  const mesh = K.workshop.shape(TW, TH);
  for (const box of BOXES(b)) boxTris(mesh, box.lo, box.hi);

  /*
   * THE CORNERS ARE IN MODEL SPACE AND THE BONE IS NOT, which is what `to` is for.
   *
   * Handing meshOf a model-space point with a bone and nothing else makes it read the point as
   * though it were already in that bone's space. Bip01 Dorso3 stands turned and offset from the
   * model's own axes, so the whole pack came out rotated a quarter turn and hanging off his left
   * hip -- the right shape, built correctly, in the wrong frame.
   *
   * `to` is the matrix that takes a model-space point INTO the bone's space. meshOf applies it
   * itself, so the conversion must not also be done here or it lands twice.
   */
  const to = K.inverse34(K.poseAt(whole, POSE.seq, POSE.frame)[bone]);
  const tris = mesh.tris.map((tri) => tri.map((c) => ({ ...c, bone, to })));

  const tex = packTexture();
  const where = { bodypart: 0, model: 0 };
  const at = K.readMdl(whole).bodyparts[0].models[0].meshes.length;
  const built = K.replaceMesh(
    K.addMesh(whole, where), { ...where, mesh: at },
    K.meshOf(null, tris, tex, bone, SMOOTH), tex,
  );

  const after = K.readMdl(built).bodyparts[0].models[0];
  console.log(
    `  ${name}: back at x ${b.toFixed(1)}, bone ${bone}, ${tris.length} triangles` +
      `  verts ${before.numverts} -> ${after.numverts}/2048` +
      `  norms ${before.numnorms} -> ${after.numnorms}/2048`,
  );
  if (after.numverts > 2048 || after.numnorms > 2048) {
    throw new Error(`${name} is over a submodel's 2048: it would be corrupt in game`);
  }

  mkdirSync(join(OUT, name), { recursive: true });
  const file = join(OUT, name, `${name}.mdl`);
  writeFileSync(file, checked(name, built));
  return { name, file, mdl: built };
}

/* ---- all of them, and a look at each --------------------------------------------------------- */
const want = process.argv.slice(2);
const list = want.length ? BUILDS.filter((v) => want.includes(v.donor) || want.includes(v.name)) : BUILDS;
if (!list.length) throw new Error(`nothing matches ${want.join(" ")}`);

console.log("");
const done = [];
for (const v of list) {
  try {
    done.push(build(v));
  } catch (e) {
    console.log(`  ${v.name}: FAILED -- ${e.stack}`);
  }
}

/*
 * A look at each from four sides, because a model that passes check() can still be inside out or
 * facing backwards and neither shows up in a byte count.
 */
if (done.length) {
  const img = K.lineup(done.map((d) => [d.name, d.mdl]), {
    ...POSE,
    // from behind first, since that is the only side the pack is on
    yaws: [200, 160, 270, 20],
    zoom: 1.6,
    width: 300,
    cols: 4,
  });
  const png = join(OUT, "repuheavy-pack.png");
  writeFileSync(png, K.png(img.width, img.height, img.rgba));
  console.log(`
  ${png}`);
}
console.log("");
