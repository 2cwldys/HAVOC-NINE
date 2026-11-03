// Weathered repuheavy variants, for variety in the MSR assault pool.
//
//     node make-repuheavy-worn.mjs
//
// Five of them, each a different KIND of weathering rather than a different amount of
// it, so a squad looks like men who have been in different places rather than one man
// at three points of the same afternoon. Two are missing a shoulder plate.
//
// WHY THERE IS NO texturesLast HERE, unlike every other script in this folder.
//
// That helper is mine and it was written against SMAK 0.2. From 0.3 the kit lays every
// model it changes out the way the server reads it, and its own check refuses a file
// that is not -- so paint and dropTriangles already do the thing texturesLast was for.
// Calling it on top simply appends a second copy of the textures, which is what doubled
// the XCCPsgts files when it was used to repair them. The result is checked instead.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { K, W, load, clamp, POSE } from "./lib.mjs";
const { isEngineLayout } = await import("file:///D:/Downloads/TSM/smak/src/layout.mjs");

const OUT = join(process.cwd(), "..", "export-mdl");
/*
 * The donors. RepuHeavyM is a STRAIGHT RECOLOUR of repuheavy -- same 22 bones, same 27
 * texture names, same three bodyparts, same 935 vertices -- so every number in this
 * file applies to it unchanged: the layer rules, the six looks, the shoulder-plate
 * boxes and the lens texture. It needs a loop, not a second script.
 *
 * The folder is spelled RepuHeavyM on disk, which is the spelling used here. The config
 * happens to write it lowercase and Windows does not care, but a Linux server would.
 */
const DONORS = process.argv.length > 2
  ? process.argv.slice(2)
  : ["repuheavy", "RepuHeavyM", "RepuHeavyGld"];

const lum = (c) => 0.30 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const n3 = (p, k, s, oct = 4) => W.fbm3(p, k, s, oct);

/*
 * The donor is VERY dark: its armour sits at a median luminance under 0.10 and never
 * passes 0.30. Every colour below is picked against that rather than against what the
 * words suggest -- bare metal at 0.19 reads as a bright scratch on this model, while
 * steel asked for at its own natural brightness comes out looking like a white label,
 * which is exactly what it did on the proletarian's belt buckle.
 */
const BARE  = [0.190, 0.183, 0.174];     // metal under the paint
const DUST  = [0.330, 0.300, 0.238];     // pale, dry, settles on upward faces
const SOOT  = [0.022, 0.020, 0.019];
const MUD   = [0.105, 0.082, 0.052];
const RUST  = [0.135, 0.070, 0.038];
const DRIED = [0.112, 0.030, 0.024];     // old blood
const FRESH = [0.232, 0.044, 0.036];

/*
 * The layers: what the picture says about itself, worked out ONCE before the first pass
 * and readable in every one.
 *
 * This replaces the mask code these scripts used to carry. The one that matters is
 * `plate`, because `dist.plate` is a SIGNED DISTANCE IN PIXELS to its edge -- positive
 * inside, negative outside -- and armour wears at its edges. Scratching by noise alone
 * wears the middle of a panel as readily as its corner, which is why it never looked
 * like use.
 */
const layers = {
  // The emissive panels. Declared first so everything else can exclude them: they are
  // how a player is read at range and nothing here paints over them.
  blue: ({ rgb }) => rgb[2] > rgb[0] + 0.06 && rgb[2] > 0.12,

  // The armour shell: dark, not blue, and smooth rather than ridged or woven.
  plate: {
    fn: ({ rgb, busy, dist }) => dist.blue < -1 && lum(rgb) < 0.22 && busy(3) < 0.18,
    drop: 60,     // specks of shadow are not armour
    fill: 40,     // rivets and bolt holes are
    smooth: 2,    // so the rub line does not wander with the noise
  },
};

/** How exposed a point is: high, forward and outward-facing things get hit. */
const exposure = (p, n) => clamp(0.35 + 0.45 * n[2] + 0.35 * clamp((p[0] - 2.0) / 6));

/** The rub line just inside a plate's edge, where paint goes first. */
const rub = (dist) => (dist.plate > 0 && dist.plate < 2.6 ? clamp((2.6 - dist.plate) / 2.6) : 0);

// ── the variants ───────────────────────────────────────────────────────────
/*
 * Each is a pass function. They are handed the kit's `place` object and return a colour,
 * or nothing to leave the pixel as it is -- which is how the blue panels survive: every
 * one of these returns early on them.
 */
const LOOKS = {
  /* Sun and grit. Paint chalked off the high faces, pale dust packed into the creases. */
  dust: ({ p, n, rgb, dist, busy, edge }) => {
    if (dist.blue > -1) return undefined;
    let c = rgb;
    const up = clamp(n[2]);

    // Bleached where the sun lands, which is the top of everything.
    c = W.mix(c, W.times(c, 1.55), up * 0.45);

    // Grit settles in the creases, and a crease is where the picture is busy.
    c = W.mix(c, DUST, clamp((busy(3) - 0.10) / 0.22) * (0.30 + 0.35 * up) * 0.75);

    // Scoured back to metal along every plate edge, heavily.
    const scratch = rub(dist) * clamp((n3(p, 2.2, 401, 3) - 0.46) / 0.14);
    c = W.mix(c, BARE, scratch * 0.85 * exposure(p, n));
    if (edge < 2) c = W.mix(c, BARE, 0.35);

    return c;
  },

  /* Close to a blast: scorched up the front, metal bared where the heat stripped it. */
  soot: ({ p, n, rgb, dist, busy }) => {
    if (dist.blue > -1) {
      // The one thing done to the panels anywhere: the blast dulled them, it did not
      // put them out. A dead visor is a model you cannot read at range.
      return W.times(rgb, 0.70);
    }
    let c = rgb;
    const front = clamp((p[0] - 1.5) / 5.0);
    const up = clamp(n[2]);

    // Soot climbs: heaviest low on the front and thinning as it rises.
    const smoke = front * clamp(1.0 - (p[2] - 4) / 34) * clamp((n3(p, 0.8, 403, 4) - 0.44) / 0.16);
    c = W.mix(c, SOOT, smoke * 0.80);

    // Heat took the paint off the leading edges rather than scratching them.
    c = W.mix(c, BARE, rub(dist) * front * 0.75);
    c = W.mix(c, BARE, clamp((busy(3) - 0.16) / 0.20) * front * up * 0.40);

    return c;
  },

  /* Wet work. Filth from the waist down, rust creeping out of every chip. */
  mud: ({ p, n, rgb, dist, busy }) => {
    if (dist.blue > -1) return undefined;
    let c = rgb;
    const low = clamp(1.0 - (p[2] + 30) / 34);          // 1 at the boots, 0 at the head
    const down = clamp(-n[2]);

    // Caked where it is thrown up, and underneath where it clings.
    const cake = low * clamp((n3(p, 0.9, 407, 4) - 0.42) / 0.18);
    c = W.mix(c, MUD, cake * (0.55 + 0.35 * down) * 0.85);

    // Drips, which run down and so are long in z and narrow in y.
    const drip = low * clamp((W.fbm(p[1] * 2.4, p[2] * 0.20, 409, 4) - 0.56) / 0.09);
    c = W.mix(c, MUD, drip * 0.55);

    // Rust out of the chips, and the chips are at the plate edges.
    const chip = rub(dist) * clamp((n3(p, 2.6, 411, 3) - 0.50) / 0.12);
    c = W.mix(c, BARE, chip * 0.55);
    c = W.mix(c, RUST, chip * 0.60 + clamp((busy(3) - 0.14) / 0.24) * low * 0.30);

    return c;
  },

  /* Armour sound, the man less so. Other people's blood, thrown forward. */
  blooded: ({ p, n, rgb, dist }) => {
    if (dist.blue > -1) return undefined;
    let c = rgb;
    const front = clamp((p[0] - 1.8) / 4.5);
    const faces = clamp((n[0] - 0.15) / 0.5);

    // Spatter where it would actually land: forward-facing surfaces at chest height.
    const chest = front * faces * clamp(1 - Math.abs(p[2] - 14) / 16);
    c = W.mix(c, DRIED, chest * clamp((n3(p, 1.2, 413, 4) - 0.52) / 0.085) * 0.80);
    c = W.mix(c, FRESH, chest * clamp((n3(p, 3.2, 415, 2) - 0.625) / 0.040) * 0.70);

    // Worn into the forearms rather than spattered on them.
    const arms = clamp((Math.abs(p[1]) - 7.0) / 3.0) * clamp(1 - Math.abs(p[2] - 6) / 12);
    c = W.mix(c, DRIED, arms * clamp((n3(p, 1.0, 417, 3) - 0.47) / 0.13) * 0.65);

    // And heavy scratching, because he has been close enough to get it on him.
    c = W.mix(c, BARE, rub(dist) * clamp((n3(p, 2.4, 419, 3) - 0.44) / 0.15) * 0.80);

    return c;
  },

  /* Armour gone or taken. What is left is webbing over a bare under-suit. */
  stripped: ({ p, n, rgb, dist, busy }) => {
    if (dist.blue > -1) return undefined;
    let c = rgb;

    // The plate that remains is worn through to metal over most of its area, not just
    // at the edges: this is kit that has been kept going rather than maintained.
    const worn = clamp((n3(p, 1.3, 421, 4) - 0.44) / 0.18);
    c = W.mix(c, BARE, worn * 0.45 * exposure(p, n));
    c = W.mix(c, BARE, rub(dist) * 0.70);

    // Grime everywhere, deepest where nothing rubs it off.
    c = W.mix(c, W.times(MUD, 0.7), clamp((busy(3) - 0.12) / 0.26) * 0.35);
    c = W.mix(c, RUST, clamp((n3(p, 1.9, 423, 3) - 0.56) / 0.10) * 0.30);

    return W.times(c, 0.92);
  },
};

/*
 * THE VISOR, which is a texture of its own.
 *
 * 001A6AC6.bmp is 16x16, carries the blue, and is worn by glasses_Ref's sixteen
 * triangles and by nothing else on the model. That is what makes both of the things
 * below safe: a flag or a repaint here reaches the lenses and no armour.
 *
 * GLOWING is a texture flag, not geometry and not a light. The engines differ on which
 * flag, and the kit's own table is blunt about it:
 *
 *     Full bright   4    GoldSrc: not reliably, test it in the game   Xash: yes
 *     Additive      32   GoldSrc: yes                                 Xash: yes
 *
 * So ADDITIVE is the one that works here. This server is GoldSrc, where fullbright is
 * documented as unreliable -- setting it alone produces a model that looks right in a
 * previewer and is very likely unchanged in the game.
 *
 * Additive adds the texture to whatever is behind it instead of replacing it, which is
 * what a lamp does to a scene and why the kit calls it a glow. Its cost is that dark
 * pixels add nothing and so read as transparent: the lens frame drops away and the blue
 * floats in the visor opening. On a lens that is the look rather than a fault, but it IS
 * a visible change and not merely a brighter version of the donor.
 *
 * Fullbright is set alongside it, for Xash clients where it is honoured and harmless.
 */
const LENS = "001A6AC6.bmp";
const TEX_FULLBRIGHT = 4;
const TEX_ADDITIVE = 32;

/**
 * The lens again at four times the size, optionally broken.
 *
 * It is grown first because the original is sixteen pixels square: a crack drawn on
 * that is a staircase three pixels wide and reads as damage to the texture rather than
 * to the glass. replaceTexture moves the corners that wear it when the size changes.
 */
function lensPicture(donor, mode) {
  const src = K.textureOf(donor, LENS);
  const rgba = K.rgbaOf(src);
  const N = 64;
  const rgb = new Uint8Array(N * N * 3);

  // Impact points: one off-centre for a crack, two for a shattered lens.
  const hits = mode === "shatter" ? [[0.34, 0.40], [0.68, 0.58]] : [[0.58, 0.44]];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sx = Math.min(src.width - 1, (x * src.width / N) | 0);
      const sy = Math.min(src.height - 1, (y * src.height / N) | 0);
      const i = (sy * src.width + sx) * 4;
      let c = [rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255];

      /*
       * "smashed": the LEFT lens gone entirely, with an eye in the socket.
       *
       * There is nothing behind this visor to see -- everything on the far side of it
       * is the helmet's own interior, and no texture on this model is skin. Cutting a
       * real hole with the masked flag would show the inside of his helmet and then
       * straight through him, which reads as a hole in the model rather than as a man.
       * So the eye is PAINTED into the socket. At the size a visor is on screen there
       * is no difference, and it depends on no engine flag.
       *
       * Only one side goes, so the two lenses read as different and the damage is
       * obviously damage rather than a texture fault.
       */
      if (mode === "smashed") {
        /*
         * BOTH LENSES WEAR THIS, because both lenses are the same pixels.
         *
         * The first version split the sheet down the middle and broke only the left half,
         * on the assumption that the two lenses sat on different parts of it. They do not.
         * Measured on every donor, each lens covers u 0.00..0.75 and v 0.13..0.94 -- the
         * same footprint, the same texels. So a cut at u 0.5 does not separate left from
         * right, it slices ACROSS BOTH: each lens got a piece of socket and a piece of
         * clean glass, at whatever size the cut happened to leave, and the result was one
         * huge amber eye and one that was still blue.
         *
         * Breaking one lens and not the other needs the two to stop sharing texels, which
         * is a UV change and not a paint. Until then this is drawn ONCE, centred on the
         * footprint the lenses actually occupy, so each eye comes out the same size and
         * in the middle of its own lens.
         */
        const u = x / N, v = y / N;

        // The middle of what a lens actually covers, and how far it reaches, measured off
        // the models rather than assumed: u 0.00..0.75, v 0.13..0.94.
        const cx = 0.375, cy = 0.535;
        const RU = 0.375, RV = 0.405;

        const dx = (u - cx) / (RU * 0.88), dy = (v - cy) / (RV * 0.88);
        const r = Math.hypot(dx, dy) * (1 + 0.16 * Math.sin(Math.atan2(dy, dx) * 6));

        if (r < 1.0) {
          // Inside the socket: dark, with an eye in it.
          c = [0.030, 0.026, 0.024];

          // The eye fills a little over half the socket, which is what stops it reading
          // as a pinhole at one size and as a cartoon at another.
          const ex = (u - cx) / (RU * 0.52), ey = (v - cy) / (RV * 0.46);
          if (Math.hypot(ex, ey) < 1.0) {
            c = [0.62, 0.58, 0.54];                                        // sclera, not white
            const ir = Math.hypot((u - cx) / (RU * 0.24), (v - cy) / (RV * 0.26));
            if (ir < 1.0) c = [0.18, 0.15, 0.12];                          // iris
            if (ir < 0.45) c = [0.045, 0.040, 0.038];                      // pupil
            if (Math.hypot((u - cx + RU * 0.085) / (RU * 0.08),
                           (v - cy + RV * 0.090) / (RV * 0.08)) < 1.0) {
              c = [0.88, 0.88, 0.86];                                      // the catch-light
            }
            // The socket's rim shadows the top of it.
            c = W.times(c, 0.55 + 0.45 * clamp((ey + 1.0) / 1.2));
          }
          // Glass still in the rim, catching light.
          if (r > 0.86) c = W.mix(c, [0.55, 0.70, 0.85], (r - 0.86) / 0.14 * 0.5);
        } else if (r < 1.3) {
          // Crazed and bloodied just outside the break.
          c = W.mix(c, [0.020, 0.028, 0.045], clamp((1.3 - r) / 0.44) * 0.75);
          c = W.mix(c, [0.105, 0.028, 0.022], clamp((r - 1.0) / 0.30) * 0.45);
        }

        const o2 = (y * N + x) * 3;
        for (let k = 0; k < 3; k++) rgb[o2 + k] = Math.max(0, Math.min(255, c[k] * 255));
        continue;
      }

      if (mode !== "clean") {
        const u = x / N, v = y / N;
        let dark = 0, pale = 0;

        for (const [hx, hy] of hits) {
          const dx = u - hx, dy = v - hy;
          const r = Math.hypot(dx, dy);
          const a = Math.atan2(dy, dx);

          // Radial splits: a handful of lines out of the impact, wandering a little.
          const spokes = mode === "shatter" ? 9 : 5;
          const wobble = 0.22 * Math.sin(a * 7 + r * 22);
          const near = Math.abs(Math.sin(a * spokes / 2 + wobble));
          if (r > 0.04) dark = Math.max(dark, clamp((1 - near * 9)) * clamp(1 - r * 1.5));

          // The bruised ring right at the point of impact.
          pale = Math.max(pale, clamp(1 - r * 14));

          // Concentric rings, only on a shattered one.
          if (mode === "shatter") {
            const ring = Math.abs(Math.sin(r * 38)) < 0.16 ? clamp(1 - r * 2.2) : 0;
            dark = Math.max(dark, ring * 0.75);
          }
        }

        c = W.mix(c, [0.020, 0.028, 0.045], clamp(dark) * 0.85);       // the split itself
        c = W.mix(c, [0.62, 0.78, 0.92], clamp(pale) * 0.55);          // crazed glass, paler
      }

      const o = (y * N + x) * 3;
      for (let k = 0; k < 3; k++) rgb[o + k] = Math.max(0, Math.min(255, c[k] * 255));
    }
  }
  return { width: N, height: N, rgb };
}

/** The model with its visor repainted, relit, or both. */
function withLens(src, { mode = "clean", glow = false } = {}) {
  if (mode === "clean" && !glow) return src;
  /*
   * A DONOR MAY HAVE NO VISOR AT ALL.
   *
   * The helmetless female models have a face where the others have a lens, so 001A6AC6
   * is simply not among their textures -- and textureOf throws on a name a model does
   * not carry. Their damage is the body's, which is the whole of it for a bare head.
   */
  if (!K.readMdl(src).textures.some((t) => t.name === LENS)) return src;
  const tex = K.indexed(lensPicture(src, mode), LENS);
  tex.flags = glow ? (TEX_ADDITIVE | TEX_FULLBRIGHT) : 0;
  return K.replaceTexture(src, LENS, tex, { quiet: true });
}

/*
 * The shoulder plates, by where they sit in the world.
 *
 * Measured off this exact donor while the proletarian's pauldrons were being ported, so
 * these boxes are known to take the plate and nothing of the arm or collar under it.
 * Taking one away leaves the shoulder bare, which is the whole point of the look.
 */
const PLATES = {
  left:  { tex: "05.bmp", x: [-3.6, 7.3], y: [3.6, 11.6], z: [24.0, 28.8] },
  right: { tex: "04.bmp", x: [-3.6, 7.3], y: [-11.9, -4.0], z: [23.6, 28.5] },
};

/*
 * NOT EVERY DONOR WEARS repuheavy's PAULDRONS, and the boxes above only find his.
 *
 * repuheavy, repuheavyw and repughillie share his body, so the boxes land on all three.
 * reputengu does not: searched for blue above the waist it has SIXTEEN triangles and all
 * of them are its visor -- where repuheavy has fourteen a side on 04 and 05.bmp. Its
 * shoulders are its own, on 00DFEF77.bmp, and the boxes pass straight over them. That is
 * why its stripped and soot variants came out reporting "-0 tris": nothing was removed,
 * and the variant was the base model with a cracked lens.
 *
 * His plates cannot be taken as a PIECE, because they are part of the big body sheets
 * that carry his whole torso and touch it -- which is why they are a box in the first
 * place. The tengu's can: its pauldron is a connected group of its own, 28 triangles on a
 * sheet nothing else at that height uses. So the two are found two different ways, and
 * the donor says which.
 *
 * Keyed on what the piece IS -- its texture, its side, its height -- and not on the id
 * pieces() happens to give it, because those renumber whenever anything else changes.
 */
/*
 * Donors whose plate TEXTURE is the plate and nothing else.
 *
 * The female models wear repuheavy's pauldrons as grafted meshes, so 05.bmp carries their
 * 44 left-plate triangles and 04.bmp their 47 right-plate ones, and not one triangle more
 * -- her body is on her own sheets. The boxes would work too, but only after being moved,
 * because the plates were dropped 1.2 and tilted on their way onto her narrower shoulders
 * and no longer sit where his do. Selecting by texture needs no such tuning and cannot
 * drift when the fitting is adjusted again.
 */
const PLATE_TEX_ONLY = {
  repuheavy_fem:        { left: "05.bmp", right: "04.bmp" },
  repuheavy_fem_nhelm:  { left: "05.bmp", right: "04.bmp" },
  repuheavy_bfem_nhelm: { left: "05.bmp", right: "04.bmp" },
};

/*
 * Shorter names for donors whose own name leaves no room for a suffix.
 *
 * TS truncates a model path at 63 characters, which caps a NAME at 22, and
 * "repuheavy_bfem_nhelm" is already 20 -- so every variant of it would be fatal. The
 * variants take a short base instead. It is only a filename: the model is still hers.
 */
const NAME_BASE = {
  repuheavy_fem_nhelm:  "fem_nh",
  repuheavy_bfem_nhelm: "bfem_nh",
  repuheavy_agentface:  "rh_agent",
  repuheavy_laurence:   "rh_laur",
};

const SHOULDERS = {
  reputengu: {
    /*
     * 002EFF7A AND NOT 00DFEF77, which is what the first attempt took.
     *
     * Its shoulder is TWO LAYERS over each other, 28 triangles a side on 00DFEF77 and 40
     * on 002EFF7A, and the triangle counts give no clue which is which. Rendered with
     * each removed in turn, dropping 00DFEF77 changes almost nothing -- it is the under
     * layer -- while dropping 002EFF7A takes the spiked pad off and leaves a bare
     * shoulder. So the pad is 002EFF7A, and taking the other one off was work that
     * reported "-28 tris" and looked exactly like the base model.
     */
    tex: "002EFF7A.bmp",
    z: [20.0, 31.0],
    sign: { left: 1, right: -1 },
  },
};

function stripPlates(src, which, donorName) {
  if (!which.length) return { mdl: src, gone: 0 };
  const own = SHOULDERS[donorName];
  const byTex = PLATE_TEX_ONLY[donorName];
  let out = src, gone = 0;

  for (const side of which) {
    let r;
    if (byTex) {
      r = K.dropTriangles(out, (t) => t.tex === byTex[side], POSE);
    } else if (own) {
      // Its own shoulder, as a connected piece. pieces() is recomputed each time round
      // because the ids move as soon as anything is dropped.
      const pc = K.pieces(out, POSE);
      const want = new Set(pc.list
        .filter((e) => e.tex === own.tex
          && e.mid[2] >= own.z[0] && e.mid[2] <= own.z[1]
          && Math.sign(e.mid[1]) === own.sign[side])
        .map((e) => e.id));
      if (!want.size) continue;
      r = K.dropTriangles(out, (t) => want.has(pc.of(t)), POSE);
    } else {
      const b = PLATES[side];
      r = K.dropTriangles(out, (t) => (
        t.tex === b.tex
        && t.mid[0] >= b.x[0] && t.mid[0] <= b.x[1]
        && t.mid[1] >= b.y[0] && t.mid[1] <= b.y[1]
        && t.mid[2] >= b.z[0] && t.mid[2] <= b.z[1]
      ), POSE);
    }
    out = r.mdl;
    gone += r.gone?.length ?? r.gone ?? 0;
  }

  /*
   * A variant that was asked to lose a pauldron and lost nothing is not a variant -- it
   * is the base model under another name, taking up a slot in the class pool. Said out
   * loud rather than left in the log, because "-0 tris" scrolled past unnoticed once.
   */
  if (!gone) {
    console.log(`      [none] ${donorName} has nothing to strip at ${which.join(" and ")}: `
      + "this variant will be the base model with a damaged lens");
  }
  return { mdl: out, gone };
}

// ── build ──────────────────────────────────────────────────────────────────
/*
 * `look` is a LIST, so a variant can wear more than one.
 *
 * paint takes several passes and each sees what the one before left, so stacking soot
 * and blood is simply naming both: the scorching goes down, then the blood goes on top
 * of it, which is the right order -- he was burned and then bled on, and blood over
 * soot reads differently from soot over blood.
 */
const VARIANTS = [
  { suffix: "_dust",       look: ["dust"],              strip: [],                lens: "clean" },
  { suffix: "_soot",       look: ["soot"],              strip: ["right"],         lens: "crack" },
  { suffix: "_mud",        look: ["mud"],               strip: [],                lens: "clean" },
  { suffix: "_blooded",    look: ["blooded"],           strip: [],                lens: "shatter" },
  { suffix: "_stripped",   look: ["stripped"],          strip: ["left", "right"], lens: "crack" },
  { suffix: "_soot_blood", short: "_sootbld", look: ["soot", "blooded"],   strip: ["right"],         lens: "shatter" },
  { suffix: "_smashed",    look: ["soot", "blooded"],   strip: ["right"],         lens: "smashed" },
];

/*
 * TSM_ONLY picks which variants to build, by suffix.
 *
 *     TSM_ONLY=_smashed node make-repuheavy-worn.mjs repughillie RepuHeavyM
 *
 * A change to one look should not cost a rebuild of all seven. Correcting the smashed
 * visor touched nothing but that one lens mode, and rebuilding every donor's dust, soot,
 * mud, blood and stripped alongside it was twenty minutes of work to redeliver files that
 * came out byte for byte the same.
 */
const ONLY = (process.env.TSM_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const made = [];
for (const donorName of DONORS) {
const base = load(donorName);
for (const v of VARIANTS) {
  if (ONLY.length && !ONLY.includes(v.suffix) && !ONLY.includes(v.short ?? "")) continue;
  /*
   * TS BUILDS models/player/<name>/<name>.mdl IN 64 BYTES AND DOES NOT CHECK IT.
   *
   * 19 characters of fixed text plus the name twice has to fit in 63, so a name may be
   * 22 at most. Longer is not cosmetic: the path is cut mid-word and the engine takes
   * the whole server down with Mod_NumForName, with nothing in the AMXX log. A model
   * called XCCPsgts_wrecked_gear_lost did exactly that.
   *
   * RepuHeavyGld is a long prefix, and "RepuHeavyGld_soot_blood" is 23. So a variant may
   * carry a short form of its name for donors where the full one will not fit, and if
   * even that is too long the build STOPS rather than writing a model that would kill a
   * server the first time somebody wore it.
   */
  const stem = NAME_BASE[donorName] ?? donorName;
  let name = stem + v.suffix;
  if (name.length > 22 && v.short) {
    name = stem + v.short;
  }
  if (name.length > 22) {
    throw new Error(`${name} is ${name.length} characters: TS truncates at 22 and the server dies on it. Give this variant a shorter 'short'.`);
  }
  const t0 = Date.now();
  const { mdl: cut, gone } = stripPlates(base, v.strip, donorName);

  // soft 2 rather than 3: this donor carries six sheets of about a quarter of a million
  // pixels each, and every step of soft multiplies the calls by its square.
  const { mdl: painted } = K.paint(cut, v.look.map((k) => LOOKS[k]), { pose: POSE, layers, soft: 2 });
  const mdl = withLens(painted, { mode: v.lens });

  const r = K.check(mdl, "goldsrc");
  const lay = isEngineLayout(mdl);
  console.log(`  ${name.padEnd(23)} ${v.look.join("+").padEnd(14)} ${v.strip.length ? `-${gone} tris` : "all plates"} lens ${v.lens.padEnd(7)}`
    + `  check ${r.errors?.length ?? 0} errors  engineLayout ${lay}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.errors?.length) {
    for (const e of r.errors) console.log("      ERROR: " + e);
    throw new Error(`${name} did not come out sound`);
  }
  if (!lay) throw new Error(`${name} is not in engine layout: a server would die on the next level change`);

  mkdirSync(join(OUT, name), { recursive: true });
  writeFileSync(join(OUT, name, `${name}.mdl`), mdl);
  made.push([name, mdl]);
}
}

/*
 * A straight copy of repuheavy whose visor is LIT.
 *
 * Nothing is weathered and no geometry moves: the only difference from the donor is the
 * fullbright flag on the lens texture, so in a dark corner of a map his eyes stay blue
 * while the rest of him goes to shadow. It is listed apart from the five because it is
 * not damage, it is the same soldier with the lights on.
 */
{
  const name = "repuheavy_glow";
  const mdl = withLens(load("repuheavy"), { mode: "clean", glow: true });
  const r = K.check(mdl, "goldsrc");
  const lay = isEngineLayout(mdl);
  const flags = K.readMdl(mdl).textures.find((t) => t.name === LENS)?.flags;
  console.log(`  ${name.padEnd(20)} visor flags ${flags} (additive+fullbright)  check ${r.errors?.length ?? 0} errors  engineLayout ${lay}`);
  if (r.errors?.length) { for (const e of r.errors) console.log("      ERROR: " + e); throw new Error(`${name} is not sound`); }
  if (!lay) throw new Error(`${name} is not in engine layout`);
  mkdirSync(join(OUT, name), { recursive: true });
  writeFileSync(join(OUT, name, `${name}.mdl`), mdl);
  made.push([name, mdl]);
}

// ── look at them ───────────────────────────────────────────────────────────
const put = (f, img) => { writeFileSync(join(OUT, f), K.png(img.width, img.height, img.rgba)); console.log(`  wrote export-mdl/${f}`); };

const donor0 = load(DONORS[0]);
put("repuheavy_worn.png", K.lineup([[DONORS[0], donor0], ...made], { ...POSE, yaws: [40, 215], zoom: 1.5, width: 260, cols: 4 }));

// The torso close, because wear that reads at 300 pixels can vanish at the distance a
// player is actually seen from, and because a missing plate has to be checked from the
// side it was taken off -- a hole into the body would show there and nowhere else.
{
  const shots = [], labels = [];
  for (const [name, m] of [[DONORS[0], donor0], ...made]) {
    shots.push(K.render(m, { ...POSE, yaw: 55, pitch: 12, zoom: 3.4, target: [2, 0, 14], width: 260, height: 320 }));
    labels.push(name);
  }
  put("repuheavy_worn_close.png", K.tile(shots, 6, labels));
}
{
  const shots = [], labels = [];
  for (const [name, m] of [[DONORS[0], donor0], ...made]) {
    shots.push(K.render(m, { ...POSE, yaw: -75, pitch: 16, zoom: 4.6, target: [2, 0, 24], width: 260, height: 300 }));
    labels.push(name + " R shoulder");
  }
  put("repuheavy_worn_shoulder.png", K.tile(shots, 6, labels));
}
