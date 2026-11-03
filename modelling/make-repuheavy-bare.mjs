// Helmetless repuheavy: the armour, damaged, with a real head on it.
//
//     node make-repuheavy-bare.mjs
//
// The helmet comes off and a head goes on in its place, taken from agent and from
// laurence. The body keeps the soot-and-blood damage of repuheavy_soot_blood, so this
// reads as the same man with his helmet gone rather than as a different soldier.
//
// This is make-ins-prole-helm.mjs run backwards -- that one took a head off and put a
// helmet on -- so the awkward parts are already known:
//
//   * the helmet is 331 triangles riding Bip01 Testa across ten textures
//   * BOTH donors' Bip01 Testa sits 0.010 from repuheavy's, so a head held in bone
//     space needs no fitting at all, exactly as the pauldrons needed none
//   * each head is a single texture, so selecting it is a texture test and not a box
//   * the armoured collar is NOT part of the helmet: it lives on 05/06/04 and reaches
//     z 29.8, so taking the helmet off leaves no hole and the head comes up out of it
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, clamp, POSE } from "./lib.mjs";
const { isEngineLayout } = await import("file:///D:/Downloads/TSM/smak/src/layout.mjs");

const OUT = join(process.cwd(), "..", "export-mdl");

/*
 * The helmet, by the ten textures that are only ever worn by it, and by the one bone it
 * hangs from. Taken by bone AND texture rather than by a box: the thing has a brow, a
 * snout and vents, and any box tight enough to miss the collar clips a corner off it.
 */
const HELMET_TEX = new Set([
  "00736CF9.bmp", "003C88FE.bmp", "00736CE7.bmp", "002C5D1F.bmp", "00736CEB.bmp",
  "00A14167.bmp", "00DF556C.bmp", "003C88F8.bmp", "001A6AC6.bmp", "00736CF1.bmp",
]);

/** The heads on offer, each a single texture of its own donor. */
const HEADS = [
  { from: "agent",    tex: "agentface.bmp", as: "repuheavy_agentface" },
  { from: "laurence", tex: "morfyhead.bmp", as: "repuheavy_laurence" },
];

// ── the damage, as repuheavy_soot_blood wears it ───────────────────────────
// Lifted from make-repuheavy-worn.mjs rather than imported, because that script builds
// and writes as it loads; pulling it in here would rebuild all fourteen of those.
const lum = (c) => 0.30 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const n3 = (p, k, s, oct = 4) => W.fbm3(p, k, s, oct);

const BARE  = [0.190, 0.183, 0.174];
const SOOT  = [0.022, 0.020, 0.019];
const DRIED = [0.112, 0.030, 0.024];
const FRESH = [0.232, 0.044, 0.036];

const layers = {
  blue: ({ rgb }) => rgb[2] > rgb[0] + 0.06 && rgb[2] > 0.12,
  plate: {
    fn: ({ rgb, busy, dist }) => dist.blue < -1 && lum(rgb) < 0.22 && busy(3) < 0.18,
    drop: 60, fill: 40, smooth: 2,
  },
};
const rub = (dist) => (dist.plate > 0 && dist.plate < 2.6 ? clamp((2.6 - dist.plate) / 2.6) : 0);

const soot = ({ p, n, rgb, dist, busy }) => {
  if (dist.blue > -1) return W.times(rgb, 0.70);
  let c = rgb;
  const front = clamp((p[0] - 1.5) / 5.0);
  const up = clamp(n[2]);
  const smoke = front * clamp(1.0 - (p[2] - 4) / 34) * clamp((n3(p, 0.8, 403, 4) - 0.44) / 0.16);
  c = W.mix(c, SOOT, smoke * 0.80);
  c = W.mix(c, BARE, rub(dist) * front * 0.75);
  c = W.mix(c, BARE, clamp((busy(3) - 0.16) / 0.20) * front * up * 0.40);
  return c;
};

const blooded = ({ p, n, rgb, dist }) => {
  if (dist.blue > -1) return undefined;
  let c = rgb;
  const front = clamp((p[0] - 1.8) / 4.5);
  const faces = clamp((n[0] - 0.15) / 0.5);
  const chest = front * faces * clamp(1 - Math.abs(p[2] - 14) / 16);
  c = W.mix(c, DRIED, chest * clamp((n3(p, 1.2, 413, 4) - 0.52) / 0.085) * 0.80);
  c = W.mix(c, FRESH, chest * clamp((n3(p, 3.2, 415, 2) - 0.625) / 0.040) * 0.70);
  const arms = clamp((Math.abs(p[1]) - 7.0) / 3.0) * clamp(1 - Math.abs(p[2] - 6) / 12);
  c = W.mix(c, DRIED, arms * clamp((n3(p, 1.0, 417, 3) - 0.47) / 0.13) * 0.65);
  c = W.mix(c, BARE, rub(dist) * clamp((n3(p, 2.4, 419, 3) - 0.44) / 0.15) * 0.80);
  return c;
};

/*
 * The face gets its own, much lighter pass.
 *
 * The armour's rules are wrong on skin: `plate` does not match it, so none of the edge
 * scratching lands, and soot laid on at the body's strength makes a man look painted
 * rather than dirtied. What a face that has been close to a blast actually shows is
 * grime in the hollows and blood from a cut, so that is what this does -- and it leaves
 * the eyes alone, because darkening those is what turns a face into a skull.
 */
function grimyFace(tex) {
  return ({ p, n, rgb, u, v, tex: t, busy }) => {
    if (t !== tex) return undefined;
    let c = rgb;

    // Soot settles where a face is hollow, which is where the picture is busy: eye
    // sockets, the sides of the nose, under the jaw.
    const hollow = clamp((busy(3) - 0.12) / 0.26);
    c = W.mix(c, SOOT, hollow * 0.42);

    // Heavier on the side the blast came from, and down from the hairline.
    const side = clamp((p[1] - 0.5) / 3.0);
    c = W.mix(c, SOOT, side * clamp((n3(p, 1.6, 431, 4) - 0.50) / 0.14) * 0.38);

    // A cut above the brow, running down. Dried, not fresh: this happened a while ago.
    const run = clamp((n3(p, 2.1, 433, 3) - 0.585) / 0.055) * clamp(1 - Math.abs(p[2] - 32.5) / 5);
    c = W.mix(c, DRIED, run * 0.70);

    return W.times(c, 0.94);
  };
}

// ── build ──────────────────────────────────────────────────────────────────
const base = load("repuheavy");
const made = [];

for (const head of HEADS) {
  const t0 = Date.now();
  const donor = load(head.from);

  /*
   * Off with the helmet. Everything on one of its ten textures goes, which is the whole
   * shell including the visor, and nothing else on the model wears any of them.
   */
  let gone = 0;
  const { mdl: bare } = K.dropTriangles(base, (t) => {
    if (!HELMET_TEX.has(t.tex)) return false;
    gone++;
    return true;
  }, POSE);

  /*
   * On with the head. graft matches bones BY NAME, which is what makes this work across
   * two skeletons that are not the same size: agent and laurence carry 34 bones to
   * repuheavy's 22, the extra twelve being finger bones a head never touches.
   *
   * `missing: "ancestor"` is the safety net rather than the mechanism -- if some corner
   * does hang off a bone repuheavy lacks, it goes on the nearest bone above it instead
   * of throwing. The head itself rides only Dorso3 and Testa, which repuheavy has.
   */
  const donorMd = K.readMdl(donor);
  const withHead = K.graft(
    bare, donor,
    (mesh) => donorMd.textures[mesh.skinref]?.name === head.tex,
    { bodypart: 0, model: 0 },
    undefined,
    { missing: "ancestor" },
  );

  // The body takes the soot and blood; the face takes its own lighter version.
  const { mdl } = K.paint(withHead, [soot, blooded, grimyFace(head.tex)], { pose: POSE, layers, soft: 2 });

  const r = K.check(mdl, "goldsrc");
  const lay = isEngineLayout(mdl);
  const tex = K.readMdl(mdl).textures.length;
  console.log(`  ${head.as.padEnd(22)} -${gone} helmet tris, +${head.from} head  ${tex} textures  `
    + `check ${r.errors?.length ?? 0} errors  engineLayout ${lay}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.errors?.length) {
    for (const e of r.errors) console.log("      ERROR: " + e);
    throw new Error(`${head.as} did not come out sound`);
  }
  if (!lay) throw new Error(`${head.as} is not in engine layout`);

  mkdirSync(join(OUT, head.as), { recursive: true });
  writeFileSync(join(OUT, head.as, `${head.as}.mdl`), mdl);
  made.push([head.as, mdl]);
}

// ── look at them ───────────────────────────────────────────────────────────
const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };

put("repuheavy_bare.png", K.lineup([["repuheavy", base], ...made],
  { ...POSE, yaws: [40, 215], zoom: 1.5, width: 280, cols: 6 }));

/*
 * The head close, from every side and from below.
 *
 * Below is the one that matters: the head is grafted into an armoured collar that was
 * built to hold a helmet, so a jaw poking through the collar, or a gap between the two,
 * would show from under the chin and almost nowhere else.
 */
{
  const shots = [], labels = [];
  for (const [name, m] of made) {
    for (const [yaw, pitch, lbl] of [[0, 4, "front"], [55, 4, "left"], [180, 4, "back"], [0, -32, "below"]]) {
      shots.push(K.render(m, { ...POSE, yaw, pitch, zoom: 6.4, target: [2, 0, 31], width: 250, height: 290 }));
      labels.push(`${name.replace("repuheavy_", "")} ${lbl}`);
    }
  }
  put("repuheavy_bare_head.png", K.tile(shots, 4, labels));
}
