// Which textures light the three cities, read off the cities' own compiled maps, for the merged map's
// info_texlights.
//
// Each city was first compiled with a texture-light list (a lights.rad) that never shipped with it, so the
// merged map's compile, which has no such list, lights none of those textures and the rooms they lit come out
// black. An emitter shows in the original's light as faces lit at full brightness all over: a texture whose
// faces (at least 2, and at least 60% of them) have 90% of their always-on luxels at full brightness. Its
// colour is the 25th percentile of those luxels, channel by channel, scaled so the brightest channel is 255.
// Its brightness is the kit's calibrated value where the kit has the texture (M.TEXLIGHTS), otherwise a
// starting value for its kind times its SCALES entry, which calibrate.mjs measures from the merged compile.
//
//   node texlights.mjs          write texlights.json beside this file and list what it found
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { M } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The compile of the very source each city is merged from: its light is what the merged map is held to. A later
 * version of a city is lit differently, so its light is no measure of this one.
 */
export const ORIGINALS = {
  alexandria: "D:/SteamLibrary/steamapps/common/Half-Life/ts_downloads/maps/alexandria_msr_b4v3.bsp",
  paradise: "D:/Downloads/TSM/H9XASH/ts/maps/paradisecity_revival_final.bsp",
  xenon: "D:/GIT Storage/The-Specialists-Archive/map-resources/maps/xenoncity_true_b3v2.bsp",
};

const FULL = 250; // a luxel at or over this on its brightest channel is at full brightness
const FACE_SHARE = 0.9; // of a face's luxels, to count the face as lit at full
const TEXTURE_SHARE = 0.6; // of a texture's faces, to count the texture as an emitter
const SAMPLE_CAP = 40000; // luxels kept per texture for its colour

/** Starting brightness by what the name says the texture is, for one the kit has not calibrated. */
function startingValue(name) {
  const n = name.toUpperCase();
  if (/SIGN|LOGO|NEON|EXIT/.test(n)) return { kind: "sign", value: 1500 };
  if (/MONITOR|SCREEN|COMP|CRT|PANEL|TV|CONSOLE/.test(n)) return { kind: "screen", value: 1000 };
  if (/LIGHT|LGT|LITE|LAMP|SPOT|GRT|GRATE|BULB|GLOW/.test(n)) return { kind: "lamp", value: 3000 };
  return { kind: "other", value: 2000 };
}

/**
 * What a starting value is multiplied by, by texture: calibrate.mjs's measure of the light round it in the merged
 * compile against the original's, in raw (pre-gamma) light.
 */
export const SCALES = {
  "~light3d": 1, po_lightgrtora: 1.3, po_lightgrtyel: 1.69, ax_heavensent: 1, sign_kline: 0.97, sign_character: 0.88,
  sign_open: 0.88, sign_vintagebee: 1.51, ax_fsg: 0.9, jap_sign7: 1.41, sign_coffee1: 2.27, sign_24: 0.93,
  sign_ribs: 1.1, sign_steakhouse: 1.74, sign_christ: 2.34, logo_rekall1: 0.25, jap_sign16: 0.88, jap_sign6: 1.94,
  cg_pinshaside2: 0.83, sign_coffee2: 1.17, sign_devilopen: 0.82,
};

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/**
 * A texture's own average colour, brightest channel scaled to 255: the colour a face lit to white in the
 * original's light still says nothing about. Dark pixels (the fitting round a lamp) and holes are left out.
 * Null when the texture's pixels are not in the map.
 */
function textureColour(bsp, name) {
  const entry = bsp.textures.find((texture) => texture.name?.toLowerCase() === name.toLowerCase());
  if (!entry?.embedded) return null;
  const texture = M.readMiptex(bsp.bytes, entry.at);
  if (!texture) return null;
  const sum = [0, 0, 0];
  let count = 0;
  for (const index of texture.pixels) {
    if (texture.holes && index === 255) continue;
    const rgb = [texture.palette[index * 3], texture.palette[index * 3 + 1], texture.palette[index * 3 + 2]];
    if (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 24) continue;
    for (let c = 0; c < 3; c++) sum[c] += rgb[c];
    count++;
  }
  if (!count) return null;
  const top = Math.max(...sum, 1);
  return sum.map((v) => Math.round((v * 255) / top));
}

/** The emitters of one compiled map: [{ name, rgb, faces, lit }]. */
export function emittersOf(bsp) {
  const byTexture = new Map();
  for (let index = 0; index < bsp.faces.length; index++) {
    const face = bsp.faces[index];
    const info = bsp.texinfo[face.texinfo];
    const texture = info && bsp.textures[info.texture];
    if (!texture?.name) continue;
    const light = M.faceLightmap(bsp, index);
    const base = light?.styles.find((style) => style.style === 0);
    if (!base) continue;
    const name = texture.name;
    const entry = byTexture.get(name) ?? { name, faces: 0, lit: 0, r: [], g: [], b: [] };
    byTexture.set(name, entry);
    entry.faces++;
    const samples = base.rgb.length / 3;
    let full = 0;
    for (let s = 0; s < samples; s++) if (Math.max(base.rgb[s * 3], base.rgb[s * 3 + 1], base.rgb[s * 3 + 2]) >= FULL) full++;
    if (!samples || full / samples < FACE_SHARE) continue;
    entry.lit++;
    for (let s = 0; s < samples && entry.r.length < SAMPLE_CAP; s++) {
      entry.r.push(base.rgb[s * 3]);
      entry.g.push(base.rgb[s * 3 + 1]);
      entry.b.push(base.rgb[s * 3 + 2]);
    }
  }
  const emitters = [];
  for (const entry of byTexture.values()) {
    if (entry.faces < 2 || entry.lit / entry.faces < TEXTURE_SHARE) continue;
    const raw = [entry.r, entry.g, entry.b].map((channel) => percentile(channel, 0.25));
    const top = Math.max(...raw, 1);
    const fromLight = raw.map((v) => Math.round((v * 255) / top));
    // lit to white on every channel, the light hides the hue: the texture's own colour is the better guess
    const white = Math.min(...raw) >= FULL;
    const rgb = (white && textureColour(bsp, entry.name)) || fromLight;
    emitters.push({ name: entry.name, rgb, colour: white && rgb !== fromLight ? "texture" : "light", faces: entry.faces, lit: entry.lit });
  }
  return emitters.sort((a, b) => b.faces - a.faces);
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  const calibrated = new Map(M.TEXLIGHTS.map((light) => [light.name.toLowerCase(), light]));
  const notEmitters = new Set(M.NOT_EMITTERS.map((light) => light.name.toLowerCase()));
  const out = [];
  for (const [city, path] of Object.entries(ORIGINALS)) {
    if (!existsSync(path)) throw new Error(`no ${path}`);
    const found = emittersOf(M.readBsp(readFileSync(path)));
    console.log(`${city} (${basename(path)}): ${found.length} emitters`);
    for (const emitter of found) {
      const key = emitter.name.toLowerCase();
      if (notEmitters.has(key)) continue;
      const kit = calibrated.get(key);
      const start = kit ? { kind: "kit", value: kit.value } : startingValue(emitter.name);
      const scale = kit ? 1 : (SCALES[key] ?? 1);
      const value = Math.round((start.value * scale) / 100) * 100;
      const rgb = kit ? kit.rgb : emitter.rgb;
      const colour = kit ? "kit" : emitter.colour;
      out.push({ city, name: emitter.name, rgb, colour, value, kind: start.kind, scale, faces: emitter.faces, lit: emitter.lit });
      console.log(`  ${emitter.name.padEnd(20)} ${String(emitter.lit).padStart(4)}/${String(emitter.faces).padEnd(4)} faces lit   rgb ${rgb.join(" ").padEnd(12)} (${colour}) ${start.kind} ${value}${scale !== 1 ? ` (${start.value} x${scale})` : ""}`);
    }
  }
  writeFileSync(join(HERE, "texlights.json"), `${JSON.stringify({ originals: ORIGINALS, emitters: out }, null, 1)}\n`);
  console.log(`wrote texlights.json (${out.length} emitters)`);
}
