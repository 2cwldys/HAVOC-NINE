// The safest variant there is: a new colour from the palette alone.
//
// No pixel moves, so nothing can land out of place, and a same-size texture is written
// in place rather than appended -- the one SMAK edit that does not grow the file.
//
//   node modelling/example-recolour.mjs [model] [desert|woodland|arctic|green]
//
// Reads the game's own models, writes to modelling/out. Never touches the original.
import { K, load, save, savePng, checked, lineup, clamp } from "./lib.mjs";

const name = process.argv[2] ?? "XCCPsgts";
const scheme = process.argv[3] ?? "desert";

// ── colour helpers ─────────────────────────────────────────────────────────
const toHsv = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, mx ? d / mx : 0, mx];
};
const toRgb = (h, s, v) => {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};

// Five luminance stops. Cloth greys are remapped through these, which is what turns a
// uniform into camouflage without touching the shading painted into it.
const RAMPS = {
  desert:   [[42, 34, 24], [96, 78, 52], [150, 128, 88], [191, 170, 126], [224, 210, 176]],
  woodland: [[24, 28, 18], [48, 62, 34], [82, 96, 52], [120, 128, 78], [168, 172, 128]],
  arctic:   [[40, 44, 50], [92, 100, 110], [150, 160, 172], [200, 208, 218], [236, 240, 246]],
  green:    [[20, 30, 20], [44, 70, 40], [70, 110, 60], [110, 150, 96], [170, 200, 150]],
};

const ramp = RAMPS[scheme];
if (!ramp) {
  console.error(`unknown scheme "${scheme}" -- try: ${Object.keys(RAMPS).join(", ")}`);
  process.exit(1);
}

const at = (t) => {                       // sample the ramp at 0..1
  const x = clamp(t) * (ramp.length - 1), i = Math.floor(x), f = x - i;
  const a = ramp[i], b = ramp[Math.min(i + 1, ramp.length - 1)];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
};

// ── the edit ───────────────────────────────────────────────────────────────
const src = load(name);
let out = src;
let touched = 0;

for (let i = 0; i < K.readMdl(src).textures.length; i++) {
  const tex = K.textureOf(out, i);
  const pal = Uint8Array.from(tex.palette);

  // On a masked texture the LAST palette entry is the transparency key, so leave it be.
  const last = tex.flags & 64 ? 255 : 256;
  let changed = 0;

  for (let c = 0; c < last; c++) {
    const [r, g, b] = [pal[c * 3], pal[c * 3 + 1], pal[c * 3 + 2]];
    const [, s, v] = toHsv(r, g, b);

    if (s < 0.22) {
      // Near-grey: cloth and webbing. Remap its brightness through the ramp, which
      // keeps the painted shading and only changes the hue it is shaded in.
      const [nr, ng, nb] = at(v);
      pal[c * 3] = nr; pal[c * 3 + 1] = ng; pal[c * 3 + 2] = nb;
    } else {
      // Saturated: a unit colour, a patch, a light. Push its hue toward the ramp's and
      // leave its saturation alone, so insignia stay legible.
      const [th] = toHsv(...at(0.6));
      const [nr, ng, nb] = toRgb(th, s * 0.85, v);
      pal[c * 3] = nr; pal[c * 3 + 1] = ng; pal[c * 3 + 2] = nb;
    }
    changed++;
  }

  if (changed) {
    out = K.replaceTexture(out, i, { ...tex, palette: pal });
    touched++;
  }
}

console.log(`${name}: ${touched} texture(s) repalettised as ${scheme}`);
console.log(`  ${src.length} bytes in, ${out.length} bytes out  (same size means written in place)`);

const file = `recolour/${name}_${scheme}.mdl`;
save(file, checked(`${name} ${scheme}`, out));
savePng(`recolour/${name}_${scheme}.png`, lineup(
  [[`${name} (from)`, src], [scheme, out]],
  { yaws: [20, 200], zoom: 1.4, width: 320, cols: 4 },
));

console.log(`  wrote out/${file}`);
console.log(`  wrote out/recolour/${name}_${scheme}.png  -- look at it before anything else`);
