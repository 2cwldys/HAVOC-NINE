// ins_prole_helm: ins_proletarian with repuheavy's helmet in place of his head.
//
//     node make-ins-prole-helm.mjs
//
// The head comes off entirely rather than being hidden under the helmet, and the
// helmet is the donor's own geometry rather than something shaped to resemble it.
//
// This is a far smaller job than the shoulder plates in make-ins-proletarian.mjs, and
// it is worth saying why, because the difference is not obvious:
//
//   * Bip01 Testa is 0.010 apart between the two models. Same skeleton, same scale, so
//     geometry held in bone space lands where it belongs with no fitting at all.
//   * A HELMET DOES NOT HAVE TO SIT ON ANYTHING. Every problem the pauldrons had came
//     from seating a plate on a body surface that had changed shape underneath it.
//     There is no such surface here: the helmet replaces what it covers.
//   * It is bigger than the head in every direction, so it cannot leave a gap.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, checked, clamp, texturesLast, POSE } from "./lib.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const base = readFileSync(join(OUT, "ins_proletarian", "ins_proletarian.mdl"));

const SCRATCH = [0.185, 0.178, 0.170];     // bare metal under the paint
const SOOT = [0.030, 0.028, 0.026];
const RUST = [0.125, 0.065, 0.035];

// ── 1. take the head off ───────────────────────────────────────────────────
// All 335 of its triangles are on one texture, so this is a texture test rather than a
// bounding box. His hands live on suit.bmp beside the shoes, which is why they are not
// caught by it.
const HEAD_TEX = "agentface.bmp";
const PLATE_TEX = "ins_prole_pauldron.bmp";

/*
 * The shoulder plates are made bigger here, and ONLY here.
 *
 * Against a bare head the plates off ins_proletarian are the right size. Against this
 * helmet, which is a good deal wider and taller than the head it replaced, they read as
 * too small for the man wearing them. So they come off with the head and go back on
 * grown, which leaves ins_proletarian itself untouched.
 */
const PLATE_GROW = 1.35;

/*
 * THE NECK STAYS. Taking the whole of agentface.bmp off takes it with the head, and
 * what is left is a hole looking straight down into a hollow body -- from behind you
 * can see the wall through him.
 *
 * His collar tops out at z 28.3, so everything below that is inside the shirt and
 * cannot be seen from outside whatever it looks like. Cutting there keeps the neck
 * column, which plugs the hole, and takes the head from the jaw up.
 */
const NECK_KEEP = 28.0;

let removed = 0, kept = 0, plates = 0;
const { mdl: stripped } = K.dropTriangles(base, (t) => {
  if (t.tex === PLATE_TEX) { plates++; return true; }
  if (t.tex !== HEAD_TEX) { return false; }
  if (t.mid[2] < NECK_KEEP) { kept++; return false; }
  removed++;
  return true;
}, POSE);
console.log(`  head off: ${removed} triangles, ${kept} kept below z ${NECK_KEEP} to plug the neck`);
console.log(`  plates off: ${plates} triangles, to go back on at ${PLATE_GROW}x`);
if (!removed) {
  throw new Error(`found no head to remove -- nothing on this model uses ${HEAD_TEX}`);
}
if (!plates) {
  throw new Error(`found no shoulder plates -- nothing on this model uses ${PLATE_TEX}`);
}

// ── 2. the helmet, off repuheavy ───────────────────────────────────────────
const donor = load("repuheavy");
const donorMd = K.readMdl(donor);
const donorNames = K.bones(donor).map((b) => b.name);
const donorPose = K.poseAt(donor, POSE.seq, POSE.frame);

const names = K.bones(stripped).map((b) => b.name);
const need = (n) => {
  const i = names.indexOf(n);
  if (i < 0) throw new Error(`no bone "${n}" -- this model has: ${names.slice(0, 8).join(", ")}...`);
  return i;
};

const DONOR_HEAD = donorNames.indexOf("Bip01 Testa");
if (DONOR_HEAD < 0) throw new Error("the donor has no head bone");

/*
 * The helmet is everything riding the donor's head bone, which is ten meshes and ten
 * textures. Taken by BONE rather than by a box, because the box would have to be drawn
 * around a shape with a brow, a snout and a pair of vents and would either clip a corner
 * off it or take a slice of his collar with it.
 *
 * Some of it is skinned partly onto Dorso3 as well, which exists here too and is matched
 * the same way as everything else -- by name, because these models order the one
 * skeleton differently.
 */
/*
 * The neck plug is painted out to shadow.
 *
 * It is the only thing left on agentface.bmp once the head has gone, so the whole sheet
 * can go dark without touching anything else. Left as skin it reads as a bare throat
 * under a sealed helmet -- bright tan, obvious from the front and worse from below. Dark
 * it reads as the inside of the collar, which is what you would actually see there.
 */
const { mdl: shadowed } = K.paint(stripped, ({ tex }) => (
  tex === HEAD_TEX ? [0.042, 0.039, 0.037] : null
), { pose: POSE });

const P = K.poseAt(shadowed, POSE.seq, POSE.frame);

/*
 * The plates back on, bigger.
 *
 * graft is the supported way to move meshes between two models: it matches bones BY
 * NAME, carries the texture with them and settles the winding itself, which is the part
 * that went wrong by hand on the shoulder plates in the first place.
 *
 * Its `move` is handed each corner in ITS BONE'S space, so the point goes out to world,
 * is grown about the plate's own centre there, and comes back. Scaling in bone space
 * instead would grow the two plates about two different origins and pull them apart.
 *
 * The centres are the plates' own, measured off the model: they are symmetric at
 * (3.26, +/-5.89, 26.71), which is what the mirrored build in make-ins-proletarian.mjs
 * guarantees. Growing each about its own centre keeps them where they sit.
 */
const PLATE_AT = [3.26, 5.89, 26.71];
const stripNames = K.bones(shadowed).map((b) => b.name);
const srcMd = K.readMdl(base);

const withPlates = K.graft(
  shadowed, base,
  (mesh) => srcMd.textures[mesh.skinref]?.name === PLATE_TEX,
  { bodypart: 0, model: 0 },
  (p, boneName) => {
    const b = stripNames.indexOf(boneName);
    if (b < 0) return p;
    const w = K.apply34(P[b], p);
    const c = [PLATE_AT[0], w[1] > 0 ? PLATE_AT[1] : -PLATE_AT[1], PLATE_AT[2]];
    const g = [0, 1, 2].map((k) => c[k] + (w[k] - c[k]) * PLATE_GROW);
    return K.apply34(K.inverse34(P[b]), g);
  },
);
const INTO = new Map();
const into = (b) => {
  if (!INTO.has(b)) INTO.set(b, K.inverse34(P[b]));
  return INTO.get(b);
};

const pieces = [];
for (const bp of donorMd.bodyparts) {
  for (const mo of bp.models) {
    for (const me of mo.meshes) {
      const tex = donorMd.textures[me.skinref];
      if (!tex) continue;
      const onHead = K.readMesh(donor, mo, me).filter((t) => t.some((c) => c.bone === DONOR_HEAD));
      if (!onHead.length) continue;
      pieces.push({ tris: onHead, tex, name: tex.name });
    }
  }
}
if (!pieces.length) throw new Error("found no helmet on the donor: it has changed");

const total = pieces.reduce((a, p) => a + p.tris.length, 0);
console.log(`  helmet: ${total} triangles over ${pieces.length} textures (${pieces.map((p) => p.name.replace(".bmp", "")).join(", ")})`);

// ── 3. on to the model ─────────────────────────────────────────────────────
const where = { bodypart: 0, model: 0 };
let built = withPlates;

for (const piece of pieces) {
  const tris = piece.tris.map((t) => t.map((c) => {
    const b = need(donorNames[c.bone]);
    return {
      // Already in that bone's space, so it is carried through this model's pose for the
      // bone of the same name and comes back out unchanged. No scaling, no seating.
      p: K.apply34(P[b], c.p),
      uv: [c.s / piece.tex.width, c.t / piece.tex.height],
      bone: b, to: into(b),
    };
  }));

  /*
   * REVERSED, because geometry comes across from this donor inside out.
   *
   * meshOf decides which way a model winds its faces by comparing them with their stored
   * normals, and between these two that answer comes out backwards. It cost a long time
   * on the shoulder plates, because an inside-out plate does not read as a hole -- it
   * reads as a correctly made plate belonging to the other shoulder. A helmet gets it
   * worse: inside out you see the inner wall of the back of it through where the face
   * should be.
   */
  const facing = tris.map((t) => [t[0], t[2], t[1]]);

  // The donor's textures are carried over as they are. They are tiny -- the largest is
  // 128x64 and all ten together are under 30 KB -- so there is nothing to gain by
  // repacking them into an atlas, and the UVs stay exactly as the donor wrote them.
  const src = K.textureOf(donor, piece.name);
  const tex = K.indexed({ width: src.width, height: src.height, rgb: wornCopy(src) }, piece.name);
  const at = K.readMdl(built).bodyparts[0].models[0].meshes.length;
  built = K.replaceMesh(
    K.addMesh(built, where), { ...where, mesh: at },
    K.meshOf(piece.tris, facing, tex, need("Bip01 Testa"), 50), tex,
  );
}

/*
 * THE HELMET, BEATEN ABOUT.
 *
 * Calibrated to what the donor's armour actually is rather than to what "metal" sounds
 * like. Measured, nine of its ten sheets sit at a median luminance between 0.059 and
 * 0.102 and never pass 0.30 -- this is very dark armour. Bare metal showing through a
 * scratch therefore lands around 0.18: clearly lighter than the paint but nowhere near
 * white. Asking for steel at its own natural brightness is what put a blank white label
 * on the front of his belt earlier in this model.
 *
 * THE VISOR IS LEFT READABLE. One of the ten, 001A6AC6, is 72% blue with a median of
 * 0.367 -- that is the lenses, and it is what you identify a player by at range. It gets
 * scuffs round the rim and nothing across the glass.
 *
 * Noise runs in NORMALISED uv rather than pixels, because these sheets range from 16x16
 * to 128x64 and a frequency that gives a 128-wide strip a few scratches would turn a
 * 16-wide one to mush.
 */
function wornCopy(tex) {
  const rgba = K.rgbaOf(tex);
  const rgb = new Uint8Array(tex.width * tex.height * 3);
  const visor = isVisor(rgba);

  for (let y = 0; y < tex.height; y++) {
    for (let x = 0; x < tex.width; x++) {
      const i = (y * tex.width + x) * 4;
      let c = [rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255];
      const u = x / tex.width, v = y / tex.height;

      if (visor) {
        // Only the dark rim of the lens sheet is touched; the blue itself is left alone.
        if (!(c[2] > c[0] + 0.08 && c[2] > 0.15)) {
          c = W.mix(c, SCRATCH, clamp((W.fbm(u * 9, v * 9, 311, 3) - 0.56) / 0.09) * 0.45);
        }
      } else {
        // Scratches: stretched along the sheet so they read as drags rather than blotches.
        const drag = clamp((W.fbm(u * 3.0, v * 17, 307, 4) - 0.600) / 0.045);
        c = W.mix(c, SCRATCH, drag * 0.70);

        // Chips knocked out of the paint, and rust creeping from them.
        const chip = clamp((W.fbm(u * 7, v * 7, 313, 4) - 0.595) / 0.050);
        c = W.mix(c, SCRATCH, chip * 0.55);
        c = W.mix(c, RUST, clamp((W.fbm(u * 5, v * 6, 317, 3) - 0.605) / 0.055) * 0.45);

        // Soot and grime, heavier low down the sheet where it would collect.
        c = W.mix(c, SOOT, clamp((W.fbm(u * 4, v * 4, 319, 4) - 0.520) / 0.100) * (0.25 + 0.30 * v));

        // The odd dead pixel of grit.
        if (W.noise(u * 40, v * 40, 323) > 0.90) c = W.times(c, 0.72);
      }

      const o = (y * tex.width + x) * 3;
      for (let k = 0; k < 3; k++) rgb[o + k] = Math.max(0, Math.min(255, c[k] * 255));
    }
  }
  return rgb;
}

/** The lens sheet, told apart by being mostly blue rather than by its name. */
function isVisor(rgba) {
  let blue = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    n++;
    if (rgba[i + 2] / 255 > rgba[i] / 255 + 0.08 && rgba[i + 2] / 255 > 0.15) blue++;
  }
  return n > 0 && blue / n > 0.4;
}

/**
 * A texture's pixels as plain rgb, for handing back to K.indexed.
 *
 * It has to be read with textureOf: the record hanging off readMdl is the table entry,
 * which carries the size and where the pixels live but not the pixels themselves.
 */
function rgbOf(tex) {
  const rgba = K.rgbaOf(tex);
  const rgb = new Uint8Array(tex.width * tex.height * 3);
  for (let i = 0, o = 0; o < rgb.length; i += 4, o += 3) {
    rgb[o] = rgba[i];
    rgb[o + 1] = rgba[i + 1];
    rgb[o + 2] = rgba[i + 2];
  }
  return rgb;
}

// texturesLast is not optional. Dropping the head rewrote the meshes and every helmet
// piece appends another, so without it the texture block is no longer last -- and a
// GoldSrc model whose textures are not last draws as NOTHING, silently, with check()
// reporting no errors at all.
const out = texturesLast(built);

const r = K.check(out, "goldsrc");
console.log(`  ${r.facts ? r.facts.join("\n  ") : ""}`);
if (r.warnings?.length) console.log(`  ${r.warnings.join("\n  ")}`);

mkdirSync(join(OUT, "ins_prole_helm"), { recursive: true });
writeFileSync(join(OUT, "ins_prole_helm", "ins_prole_helm.mdl"), checked("ins_prole_helm", out));
console.log("  wrote export-mdl/ins_prole_helm/ins_prole_helm.mdl");

// ── 4. look at it ──────────────────────────────────────────────────────────
const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };
put("ins_prole_helm_preview.png", K.lineup([["ins_proletarian", base], ["ins_prole_helm", out]],
  { ...POSE, yaws: [0, 90, 180, 270], zoom: 1.5, width: 300, cols: 8 }));

/*
 * The head close, from below and from behind as well as the obvious angles.
 *
 * Those two are the ones that matter: a face left behind inside the helmet shows through
 * the visor from in front and under the jaw from below, and an inside-out helmet looks
 * almost right from the front and hollow from the back.
 */
{
  const shots = [], labels = [];
  for (const [yaw, pitch, label] of [
    [0, 4, "front"], [55, 4, "front-left"], [125, 4, "back-left"], [180, 4, "back"],
    [0, -34, "from below"], [30, 50, "from above"],
  ]) {
    shots.push(K.render(out, { ...POSE, yaw, pitch, zoom: 7.0, target: [2, 0, 31], width: 260, height: 300 }));
    labels.push(label);
  }
  put("ins_prole_helm_head.png", K.tile(shots, 6, labels));
}

// A run, because the helmet rides one bone and that shows in motion rather than in a pose.
put("ins_prole_helm_run.png", K.strip(out, { seq: "run2", count: 6, cols: 6, width: 280, height: 400, yaw: 215 }));
