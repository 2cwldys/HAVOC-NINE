// Pictures of the drainage works to look at without the game, drawn from the compiled map with its own baked
// light and its own sky by SMAK's renderer: a reel of stills, and a flythrough.
//
//   node preview.mjs            out\preview\h9_up_drainage-reel.png     the landmarks, captioned, in a grid
//                               out\preview\stills\*.png                  each still at its full size
//                               out\preview\h9_up_drainage-flythrough.mp4 (when ffmpeg is on the machine)
//                               out\preview\h9_up_drainage-flythrough.gif a smaller copy that plays anywhere
//   node preview.mjs --stills   the reel and the stills only
//   node preview.mjs --path     the flythrough's path alone, drawn nothing: where its eye is in solid
//
// THE FLYTHROUGH is one camera move through the works: down out of the street over the north basin, through
// the culvert, up through the pumping station onto its catwalk and out across the south deck, then up out of
// the canal toward the works on the horizon. The eye's keys are joined by a curve walked at an even speed
// (eased at its ends), and the point it looks at follows a curve of its own through each key's look, so the
// camera neither stops at a key nor snaps its turn there. A frame whose eye is in solid is counted and said.
//
// THE SOUNDTRACK is the map's own, heard from the eye as the engine hears it: every ambient_generic of the
// compiled map, its file looped from its cue point at its entity's volume and pitch, faded with distance by its
// radius's attenuation (small 2, medium 1.25, large 0.8, against the engine's 1000 units) and panned by the side
// of the eye it is on; and the distant city's shots, siren and jet fired when the map's own multi_managers fire
// them, from a moment SOUND_FROM seconds into the map. Room reverb (env_sound) is the client's and is not in it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GAME_DIR, K, M, SMAK } from "../lib.mjs";
import { SKY_FOLDER } from "./sky.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const PREVIEW = join(OUT, "preview");
const NAME = "h9_up_drainage";
const FOLDERS = [SKY_FOLDER, join(GAME_DIR, "ts"), join(GAME_DIR, "valve")];
const BRIGHTNESS = 1.6;

const kit = async (file) => import(pathToFileURL(join(SMAK, "src", file)).href);
const { encoder, hasFfmpeg } = await kit("video.mjs");
const { label, tile } = await kit("render.mjs");

const bspFile = join(OUT, `${NAME}.bsp`);
if (!existsSync(bspFile)) throw new Error(`no ${bspFile}: run node drainage.mjs --compile first`);
const bsp = M.readBsp(readFileSync(bspFile));
mkdirSync(join(PREVIEW, "stills"), { recursive: true });

/** The map from `from` looking at `to`, as the game would show it, its litter and its rain with it: no marks, no
 *  words. */
const view = (from, to, width, height, fov = 90) => M.drawMap(bsp, { from, to, fov, width, height, folders: FOLDERS, entities: "game", labels: false, models: true, brightness: BRIGHTNESS });

/** A picture `width` x `height` from a bigger one, each pixel the mean of the ones under it. */
function shrunk(picture, width, height) {
  const out = new Uint8Array(width * height * 4);
  const kx = picture.width / width;
  const ky = picture.height / height;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [x0, x1] = [Math.floor(x * kx), Math.max(Math.floor(x * kx) + 1, Math.floor((x + 1) * kx))];
      const [y0, y1] = [Math.floor(y * ky), Math.max(Math.floor(y * ky) + 1, Math.floor((y + 1) * ky))];
      const sum = [0, 0, 0];
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) for (let c = 0; c < 3; c++) sum[c] += picture.rgba[(sy * picture.width + sx) * 4 + c];
      const n = (x1 - x0) * (y1 - y0);
      out.set([sum[0] / n, sum[1] / n, sum[2] / n, 255], (y * width + x) * 4);
    }
  return { width, height, rgba: out };
}

// ---- the stills ----------------------------------------------------------------------------------
const STILLS = [
  ["north basin", [200, 1520, 156], [0, 960, 160]],
  ["down the canal from the deck", [0, 416, 352], [0, 3200, 1500]],
  ["the catwalk over the culvert", [-560, 1200, 352], [0, 1008, 328]],
  ["north culvert", [-150, 920, 60], [60, 360, 40]],
  ["culvert, toward the basin", [150, 360, 60], [-50, 960, 60]],
  ["the station's face", [0, 936, 352], [0, 352, 448]],
  ["pumping station", [-40, -300, 120], [40, 320, 200]],
  ["the station's catwalk", [-200, 288, 352], [200, -280, 100]],
  ["service gallery", [-512, -856, 64], [-512, 0, 64]],
  ["filter room (zone 2)", [-624, -168, 80], [-864, 160, 40]],
  ["generator room (zone 4)", [624, 168, 80], [864, -160, 40]],
  ["south deck, toward the works", [0, -416, 352], [0, -3200, 1200]],
  ["looking up out of the basin", [-420, 1300, 64], [500, 1100, 1000]],
  ["the elevated line", [-760, 1460, 620], [-300, 1280, 610]],
  ["a train on the bridge", [-260, 1560, 640], [60, 1280, 610]],
  ["south basin", [-200, -1520, 156], [0, -960, 160]],
  ["the works from above", [-2100, -2700, 2300], [0, 0, 0]],
];

const pictures = [];
for (const [caption, from, to] of process.argv.includes("--path") ? [] : STILLS) {
  const picture = view(from, to, 960, 540);
  writeFileSync(join(PREVIEW, "stills", `${caption.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.png`), K.png(picture.width, picture.height, picture.rgba));
  pictures.push(shrunk(picture, 480, 270));
}
if (pictures.length) {
  const reel = tile(pictures, 3, STILLS.map(([caption]) => caption));
  writeFileSync(join(PREVIEW, `${NAME}-reel.png`), K.png(reel.width, reel.height, reel.rgba));
  console.log(`\n  ${STILLS.length} stills into ${join(PREVIEW, "stills")}; the reel: ${join(PREVIEW, `${NAME}-reel.png`)}`);
}
if (process.argv.includes("--stills")) process.exit(0);

// ---- the flythrough ------------------------------------------------------------------------------
/** The eye's keys, each with what it looks at and what the frames from it are captioned. */
const KEYS = [
  { at: [0, 1850, 1250], look: [0, 600, 200], caption: "the street, over the north basin" },
  { at: [0, 1470, 820], look: [0, 900, 200], caption: "north basin" },
  { at: [0, 1450, 300], look: [0, 900, 120], caption: "north basin, under the line" },
  { at: [0, 1080, 150], look: [0, 700, 100], caption: "the culvert's mouth" },
  { at: [40, 760, 110], look: [0, 400, 100], caption: "north culvert" },
  { at: [0, 460, 110], look: [0, 200, 130], caption: "north culvert" },
  { at: [0, 120, 170], look: [0, -200, 220], caption: "pumping station" },
  { at: [0, -150, 300], look: [0, -420, 360], caption: "pumping station" },
  { at: [0, -300, 350], look: [0, -700, 370], caption: "the station's catwalk" },
  { at: [0, -560, 380], look: [0, -1000, 420], caption: "south deck" },
  { at: [0, -1000, 520], look: [0, -2200, 800], caption: "south basin" },
  { at: [0, -1500, 950], look: [0, -3500, 1300], caption: "the works" },
  { at: [200, -1750, 1150], look: [0, 1000, 900], caption: "the spire, down the canal" },
];
const FPS = 24;
const SPEED = 170; // units a second along the eye's curve
const [W, H] = [854, 480];
const [GW, GH, GIF_EVERY] = [400, 225, 2];

/** A uniform Catmull-Rom curve through points, as (segment, share of it) -> point. */
function track(points) {
  const ends = [points[0].map((v, i) => 2 * v - points[1][i]), ...points, points.at(-1).map((v, i) => 2 * v - points.at(-2)[i])];
  return (seg, u) => {
    const [p0, p1, p2, p3] = ends.slice(seg, seg + 4);
    return p1.map((_, i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * u + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u * u + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u * u * u));
  };
}
const eyeAt = track(KEYS.map((k) => k.at));
const lookAt = track(KEYS.map((k) => k.look));
// the eye's curve measured, so it is walked at an even speed
const STEPS = 64;
const table = [{ seg: 0, u: 0, d: 0 }];
for (let seg = 0; seg + 1 < KEYS.length; seg++)
  for (let k = 1; k <= STEPS; k++) {
    const [a, b] = [eyeAt(seg, (k - 1) / STEPS), eyeAt(seg, k / STEPS)];
    table.push({ seg, u: k / STEPS, d: table.at(-1).d + Math.hypot(...a.map((v, i) => v - b[i])) });
  }
const length = table.at(-1).d;
const count = Math.round((length / SPEED) * FPS) + 1;
/** Where along the curve the eye is at a distance: its segment and the share of it. */
function placeAt(d) {
  let [lo, hi] = [0, table.length - 1];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid].d < d) lo = mid;
    else hi = mid;
  }
  const [a, b] = [table[lo], table[hi]];
  const k = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
  if (b.seg !== a.seg) return { seg: b.seg, u: k / STEPS };
  return { seg: a.seg, u: a.u + (b.u - a.u) * k };
}
const ease = (s) => s * s * (3 - 2 * s);

if (process.argv.includes("--path")) {
  // the path alone: each run of frames whose eye is in solid, where, and between which keys
  let run = null;
  for (let n = 0; n <= count; n++) {
    const place = n < count ? placeAt(length * ease(n / (count - 1))) : null;
    const eye = place ? eyeAt(place.seg, place.u) : null;
    const inSolid = eye && M.contentsAt(bsp, eye) === -2;
    if (inSolid && !run) run = { from: n, eye, seg: place.seg };
    if (!inSolid && run) {
      console.log(`  frames ${run.from}..${n - 1} in solid from ${run.eye.map(Math.round).join(" ")}, between keys ${run.seg} and ${run.seg + 1}`);
      run = null;
    }
  }
  process.exit(0);
}

const mp4 = hasFfmpeg() ? encoder({ width: W, height: H, fps: FPS, format: "mp4" }) : null;
const gif = encoder({ width: GW, height: GH, fps: FPS / GIF_EVERY, format: "gif" });
let solid = 0;
const started = Date.now();
const ears = []; // the eye and its yaw at each frame, for the soundtrack
console.log(`  the flythrough: ${count} frames at ${FPS} a second (${(count / FPS).toFixed(1)} s), ${Math.round(length)} units${mp4 ? "" : " (no ffmpeg: the GIF only)"}`);
for (let n = 0; n < count; n++) {
  const { seg, u } = placeAt(length * ease(n / (count - 1)));
  const eye = eyeAt(seg, u);
  const look = lookAt(seg, u);
  ears.push({ eye, yaw: Math.atan2(look[1] - eye[1], look[0] - eye[0]) });
  if (M.contentsAt(bsp, eye) === -2) solid++;
  const picture = view(eye, look, W, H);
  label(picture, NAME, 14, 14);
  label(picture, KEYS[u < 0.5 ? seg : seg + 1].caption, 14, H - 30);
  if (mp4) await mp4.push(picture);
  if (n % GIF_EVERY === 0) await gif.push(shrunk(picture, GW, GH));
  if (n % 48 === 0) console.log(`    frame ${n} of ${count}, ${Math.round((Date.now() - started) / 1000)} s`);
}

// ---- the soundtrack --------------------------------------------------------------------------------
const RATE = 22050;
const SOUND_FROM = 58; // seconds into the map: the city's schedule from here has shots, a mortar and the siren
const ATTENUATION = { 1: 0, 2: 2, 4: 1.25, 8: 0.8 }; // ambient_generic's radius flag -> the engine's attenuation
const things = bsp.entities.map((pairs) => Object.fromEntries(pairs));
const named = (name) => things.filter((e) => e.targetname === name);

/** A sound file of the game's, as numbers from -1 to 1, its rate, and where its loop starts (its first cue point,
 *  as the engine reads it; -1 for none). */
const wavs = new Map();
function wavOf(path) {
  if (wavs.has(path)) return wavs.get(path);
  const file = [join(GAME_DIR, "ts", "sound", path), join(GAME_DIR, "valve", "sound", path)].find(existsSync);
  if (!file) throw new Error(`no sound/${path} in ts or valve`);
  const b = readFileSync(file);
  let at = 12;
  let [rate, bits, channels, data, loopStart] = [11025, 8, 1, null, -1];
  while (at + 8 <= b.length) {
    const id = b.toString("latin1", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt ") [channels, rate, bits] = [b.readUInt16LE(at + 10), b.readUInt32LE(at + 12), b.readUInt16LE(at + 22)];
    else if (id === "data") data = b.subarray(at + 8, at + 8 + size);
    else if (id === "cue ") loopStart = b.readUInt32LE(at + 32);
    at += 8 + size + (size & 1);
  }
  const step = (bits / 8) * channels;
  const samples = Float32Array.from({ length: Math.floor(data.length / step) }, (_, i) => (bits === 8 ? (data[i * step] - 128) / 128 : data.readInt16LE(i * step) / 32768));
  const made = { rate, samples, loopStart: loopStart < samples.length ? loopStart : -1 };
  wavs.set(path, made);
  return made;
}

/** What the city's managers fire from SOUND_FROM on, for as long as the film runs: [{ at (in the film), name }]. */
function cityEvents(seconds) {
  const fired = [];
  const until = SOUND_FROM + seconds;
  const run = (name, at, depth = 0) => {
    if (at > until || depth > 64) return;
    for (const e of named(name)) {
      if (e.classname === "multi_manager") {
        for (const [key, value] of Object.entries(e)) {
          if (["classname", "targetname", "origin", "spawnflags", "angles"].includes(key)) continue;
          run(key.replace(/#.*$/, ""), at + Number(value), depth + 1);
        }
      } else if (e.classname === "ambient_generic" && at >= SOUND_FROM) fired.push({ at: at - SOUND_FROM, name, entity: e });
    }
  };
  for (const e of things.filter((t) => t.classname === "trigger_auto")) run(e.target, Number(e.delay ?? 0));
  return fired.sort((a, b) => a.at - b.at);
}

/** The gain of a sound at `origin` for the eye, left and right, as the engine spatialises it. */
function gainsAt(origin, volume, attenuation, { eye, yaw }) {
  const d = origin.map((v, i) => v - eye[i]);
  const far = Math.hypot(...d);
  const scale = Math.max(0, 1 - (far * attenuation) / 1000);
  const dot = far > 1 ? (d[0] * Math.sin(yaw) - d[1] * Math.cos(yaw)) / far : 0;
  return [volume * scale * (1 - dot), volume * scale * (1 + dot)];
}

const seconds = count / FPS;
const total = Math.ceil(seconds * RATE);
const left = new Float32Array(total);
const right = new Float32Array(total);
/** Mixes `wav` in from `from` to `to` (samples of the film), at `pitch`, looping if it loops and `looped`, its
 *  gains given for each frame of the film (interpolated between frames), `into` samples already played. */
function mixIn(wav, pitch, from, to, looped, gains, into = 0) {
  const step = (wav.rate * pitch) / 100 / RATE;
  const loops = looped && wav.loopStart >= 0;
  for (let n = from, k = into; n < Math.min(to, total); n++, k++) {
    let s = k * step;
    if (s >= wav.samples.length - 1) {
      if (!loops) break;
      s = wav.loopStart + ((s - wav.loopStart) % (wav.samples.length - 1 - wav.loopStart));
    }
    const i = Math.floor(s);
    const v = wav.samples[i] + (wav.samples[i + 1] - wav.samples[i]) * (s - i);
    const f = Math.min(gains.length - 1, (n / RATE) * FPS);
    const [a, b] = [gains[Math.floor(f)], gains[Math.min(gains.length - 1, Math.floor(f) + 1)]];
    const t = f - Math.floor(f);
    left[n] += v * (a[0] + (b[0] - a[0]) * t);
    right[n] += v * (a[1] + (b[1] - a[1]) * t);
  }
}
const START_SILENT = 16;
const ONCE = 32;
let mixed = 0;
for (const e of things.filter((t) => t.classname === "ambient_generic" && !(Number(t.spawnflags) & START_SILENT))) {
  const origin = String(e.origin).split(/\s+/).map(Number);
  const attenuation = ATTENUATION[Number(e.spawnflags) & 15] ?? 1.25;
  const gains = ears.map((ear) => gainsAt(origin, Number(e.health ?? 10) / 10, attenuation, ear));
  if (gains.every(([a, b]) => a + b < 1e-4)) continue;
  // a loop has been running since the map began: it is SOUND_FROM seconds into itself when the film starts
  mixIn(wavOf(e.message), Number(e.pitch ?? 100), 0, total, true, gains, Math.round(SOUND_FROM * RATE));
  mixed++;
}
// the city: each fired sound from its moment; the siren's file loops, so its first firing starts it and the
// next stops it
const sirens = new Map();
for (const { at, name, entity } of cityEvents(seconds)) {
  const origin = String(entity.origin).split(/\s+/).map(Number);
  const gains = ears.map((ear) => gainsAt(origin, Number(entity.health ?? 10) / 10, 0, ear));
  const from = Math.round(at * RATE);
  if (Number(entity.spawnflags) & ONCE) mixIn(wavOf(entity.message), Number(entity.pitch ?? 100), from, total, false, gains);
  else if (sirens.has(name)) {
    mixIn(wavOf(entity.message), Number(entity.pitch ?? 100), sirens.get(name), from, true, gains);
    sirens.delete(name);
  } else sirens.set(name, from);
  console.log(`    the city at ${at.toFixed(1)} s: ${name} (${entity.message})`);
}
for (const [name, from] of sirens) {
  const entity = named(name)[0];
  mixIn(wavOf(entity.message), Number(entity.pitch ?? 100), from, total, true, ears.map((ear) => gainsAt(String(entity.origin).split(/\s+/).map(Number), Number(entity.health ?? 10) / 10, 0, ear)));
}
// the engine's mix, brought in under full scale and softly limited
const MASTER = 0.55;
const pcm = Buffer.alloc(total * 4);
for (let n = 0; n < total; n++) {
  pcm.writeInt16LE(Math.round(32767 * Math.tanh(left[n] * MASTER)), n * 4);
  pcm.writeInt16LE(Math.round(32767 * Math.tanh(right[n] * MASTER)), n * 4 + 2);
}
const head = Buffer.alloc(44);
head.write("RIFF", 0, "latin1");
head.writeUInt32LE(36 + pcm.length, 4);
head.write("WAVEfmt ", 8, "latin1");
head.writeUInt32LE(16, 16);
head.writeUInt16LE(1, 20);
head.writeUInt16LE(2, 22);
head.writeUInt32LE(RATE, 24);
head.writeUInt32LE(RATE * 4, 28);
head.writeUInt16LE(4, 32);
head.writeUInt16LE(16, 34);
head.write("data", 36, "latin1");
head.writeUInt32LE(pcm.length, 40);
const soundFile = join(PREVIEW, `${NAME}-soundscape.wav`);
writeFileSync(soundFile, Buffer.concat([head, pcm]));
console.log(`  the soundtrack: ${mixed} looping sounds within reach of the eye, the city's schedule from ${SOUND_FROM} s; ${soundFile}`);

if (mp4) {
  const silent = join(PREVIEW, `${NAME}-flythrough-silent.mp4`);
  writeFileSync(silent, await mp4.finish());
  const out = join(PREVIEW, `${NAME}-flythrough.mp4`);
  const muxed = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", silent, "-i", soundFile, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", out], { stdio: ["ignore", "inherit", "inherit"] });
  if (muxed.status !== 0) throw new Error("ffmpeg could not put the soundtrack under the film");
  rmSync(silent);
  console.log(`  ${out}: ${(readFileSync(out).length / 1048576).toFixed(1)} MB, with its sound`);
}
const gifBytes = await gif.finish();
writeFileSync(join(PREVIEW, `${NAME}-flythrough.gif`), gifBytes);
console.log(`  ${join(PREVIEW, `${NAME}-flythrough.gif`)}: ${(gifBytes.length / 1048576).toFixed(1)} MB`);
console.log(`  ${solid ? `${solid} frame(s) with the eye in solid` : "no frame has the eye in solid"}; ${Math.round((Date.now() - started) / 1000)} s`);
