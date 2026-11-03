// How the merged compile lights the surfaces round each texture light texlights.mjs started from a guess, against
// the city's original compile: the scale that texture's value wants, for texlights.mjs's SCALES.
//
// For each such texture: the median brightness (brightest channel, style 0) of every surface luxel within NEAR
// of one of its own luxels, in the original, in the merged compile, and in a merged compile made without
// texture lights. hlrad's light is linear before its output gamma, so in raw light the texture's own share is
// the merged compile less the one without, and the scale is what the original wants of that share.
//
//   node calibrate.mjs <merged.bsp> <merged-without-texlights.bsp>
//
// Reads v30 and BSP2 alike: the kit's reader takes v30 only, and the merged map is BSP2.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGINALS, SCALES } from "./texlights.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NEAR = 160;
const GAMMA = 0.55; // hlrad's default output gamma
const MIN_SAMPLES = 1000; // surface luxels round a texture, each side, before its scale is trusted
const MIN_SHARE = 0.1; // the texture's own part of the merged light round it, before its scale is trusted
export const SCALE_RANGE = [0.25, 2.5];
const BANDS = { alexandria: [-4040, -1488], paradise: [-1488, 411], xenon: [411, 4040] }; // merged z

/** Every lit luxel of a compiled map: where it is, the texture it is on, its brightest style-0 channel. */
function luxelsOf(file, band) {
  const buf = readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const bsp2 = buf.toString("latin1", 0, 4) === "BSP2";
  if (!bsp2 && dv.getInt32(0, true) !== 30) throw new Error(`${file}: neither a v30 BSP nor a BSP2`);
  const lump = (i) => ({ ofs: dv.getInt32(4 + i * 8, true), len: dv.getInt32(8 + i * 8, true) });
  const [, PLANES, TEXTURES, VERTS, , , TEXINFO, FACES, LIGHT, , , , EDGES, SURFEDGES] = Array.from({ length: 15 }, (_, i) => lump(i));
  const FACE = bsp2 ? 28 : 20;
  const EDGE = bsp2 ? 8 : 4;
  const f32 = (o) => dv.getFloat32(o, true);
  const nTex = dv.getInt32(TEXTURES.ofs, true);
  const texName = (m) => {
    if (m < 0 || m >= nTex) return "";
    const at = dv.getInt32(TEXTURES.ofs + 4 + m * 4, true);
    if (at < 0) return "";
    let s = "";
    for (let k = 0; k < 16 && buf[TEXTURES.ofs + at + k]; k++) s += String.fromCharCode(buf[TEXTURES.ofs + at + k]);
    return s.toLowerCase();
  };
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const out = [];
  for (let i = 0; i < FACES.len / FACE; i++) {
    const o = FACES.ofs + i * FACE;
    const planenum = bsp2 ? dv.getInt32(o, true) : dv.getUint16(o, true);
    const firstedge = dv.getInt32(o + (bsp2 ? 8 : 4), true);
    const numedges = bsp2 ? dv.getInt32(o + 12, true) : dv.getUint16(o + 8, true);
    const ti = TEXINFO.ofs + (bsp2 ? dv.getInt32(o + 16, true) : dv.getUint16(o + 10, true)) * 40;
    const lightofs = dv.getInt32(o + (bsp2 ? 24 : 16), true);
    if (lightofs < 0 || buf[o + (bsp2 ? 20 : 12)] === 255 || dv.getInt32(ti + 36, true) & 1) continue;
    const S = [f32(ti), f32(ti + 4), f32(ti + 8), f32(ti + 12)];
    const T = [f32(ti + 16), f32(ti + 20), f32(ti + 24), f32(ti + 28)];
    const points = [];
    for (let k = 0; k < numedges; k++) {
      const e = dv.getInt32(SURFEDGES.ofs + (firstedge + k) * 4, true);
      const eo = EDGES.ofs + Math.abs(e) * EDGE;
      const v = e >= 0 ? (bsp2 ? dv.getUint32(eo, true) : dv.getUint16(eo, true)) : bsp2 ? dv.getUint32(eo + 4, true) : dv.getUint16(eo + 2, true);
      points.push([f32(VERTS.ofs + v * 12), f32(VERTS.ofs + v * 12 + 4), f32(VERTS.ofs + v * 12 + 8)]);
    }
    if (band && points.every((p) => p[2] < band[0] || p[2] > band[1])) continue;
    const st = points.map((p) => [S, T].map((v) => p[0] * v[0] + p[1] * v[1] + p[2] * v[2] + v[3]));
    const low = [0, 1].map((a) => Math.floor(Math.min(...st.map((x) => x[a])) / 16));
    const w = Math.ceil(Math.max(...st.map((x) => x[0])) / 16) - low[0] + 1;
    const h = Math.ceil(Math.max(...st.map((x) => x[1])) / 16) - low[1] + 1;
    // a luxel's place: the point of the face's plane at its texture coordinates
    const p = PLANES.ofs + planenum * 20;
    const A = [S.slice(0, 3), T.slice(0, 3), [f32(p), f32(p + 4), f32(p + 8)]];
    const D = det3(A);
    if (Math.abs(D) < 1e-9) continue;
    const texture = texName(dv.getInt32(ti + 32, true));
    for (let j = 0; j < h; j++)
      for (let k = 0; k < w; k++) {
        const b = [(low[0] + k) * 16 - S[3], (low[1] + j) * 16 - T[3], f32(p + 12)];
        const at = [0, 1, 2].map((c) => det3(A.map((row, r) => row.map((x, cc) => (cc === c ? b[r] : x)))) / D);
        const lo = LIGHT.ofs + lightofs + (j * w + k) * 3;
        out.push({ at, texture, value: Math.max(buf[lo], buf[lo + 1], buf[lo + 2]) });
      }
  }
  return out;
}

/** For each of the named textures, the brightness of the surface luxels within NEAR of one of its luxels. */
function around(file, names, band) {
  const luxels = luxelsOf(file, band);
  const cellOf = (at) => at.map((v) => Math.floor(v / NEAR));
  const grid = new Map();
  for (const l of luxels) {
    if (!names.has(l.texture)) continue;
    const key = cellOf(l.at).join();
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(l);
  }
  const out = new Map([...names].map((name) => [name, []]));
  for (const l of luxels) {
    if (names.has(l.texture)) continue;
    const c = cellOf(l.at);
    const hit = new Set();
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++)
      for (const e of grid.get([c[0] + x, c[1] + y, c[2] + z].join()) ?? [])
        if (!hit.has(e.texture) && Math.hypot(e.at[0] - l.at[0], e.at[1] - l.at[1], e.at[2] - l.at[2]) <= NEAR) hit.add(e.texture);
    for (const name of hit) out.get(name).push(l.value);
  }
  return out;
}

const median = (values) => (values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : NaN);
const raw = (v) => Math.pow(v / 256, 1 / GAMMA);

/** The texture lights the merged map's info_texlights carries, by name: what hlrad was given. */
function carried(mapFile) {
  const text = readFileSync(mapFile, "latin1");
  const at = text.indexOf('"classname" "info_texlights"');
  if (at < 0) throw new Error(`${mapFile} has no info_texlights`);
  const body = text.slice(text.lastIndexOf("{", at), text.indexOf("}", at));
  return new Map([...body.matchAll(/"([^"]+)" "([^"]+)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  const [merged, without] = process.argv.slice(2);
  if (!merged || !without) throw new Error("usage: node calibrate.mjs <merged.bsp> <merged-without-texlights.bsp>");
  const lights = JSON.parse(readFileSync(join(HERE, "texlights.json"), "utf8")).emitters;
  const given = carried(join(HERE, "out", "h9_tsrp_hive.map"));
  const suggested = {};
  for (const city of Object.keys(ORIGINALS)) {
    // a texture the cities' own lists name keeps their value, so only the started ones are this file's to scale
    const started = lights.filter((l) => l.city === city && l.kind !== "kit" && given.get(l.name.toLowerCase()) === [...l.rgb, l.value].join(" "));
    if (!started.length) continue;
    const names = new Set(started.map((l) => l.name.toLowerCase()));
    const original = around(ORIGINALS[city], names, null);
    const after = around(merged, names, BANDS[city]);
    const before = around(without, names, BANDS[city]);
    console.log(`${city}: ${started.length} texture lights from a starting value`);
    for (const light of started) {
      const key = light.name.toLowerCase();
      const [o, n, b] = [original, after, before].map((m) => median(m.get(key)));
      const samples = Math.min(original.get(key).length, after.get(key).length);
      const own = raw(n) - raw(b);
      const trusted = samples >= MIN_SAMPLES && own >= MIN_SHARE * raw(n) && o > b;
      const scale = trusted ? Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], (raw(o) - raw(b)) / own)) : null;
      const had = SCALES[key] ?? 1;
      if (scale !== null) suggested[key] = Math.round(had * scale * 100) / 100;
      console.log(`  ${light.name.padEnd(18)} ${String(light.value).padStart(6)}  original ${String(o).padStart(3)}  merged ${String(n).padStart(3)}  without ${String(b).padStart(3)}  (${samples} luxels)  ${scale === null ? "not trusted" : `x${scale.toFixed(2)}`}`);
    }
  }
  console.log(`\nSCALES = ${JSON.stringify(suggested)}`);
}
