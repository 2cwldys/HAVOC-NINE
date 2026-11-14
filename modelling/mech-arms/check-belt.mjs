// The ammunition belt of a Mech minigun view model, measured in the file (not in the generator): that it slides one pitch into the
// feed throat on every shot and comes back to the picture it started from, that its far end is out of the picture at every field of
// view in every frame of every animation, that no round shows above the throat's mouth, and that the sets carry the same belt.
//
//   node check-belt.mjs <model.mdl> [<other.mdl> ...]        (the first is measured; every other one is compared with it)
//        --fov 90,100,110,120   --margin 1.0 (pitches the far end must be clear of the picture by)   --detail   --quiet   --only slide,pop,far,mouth,sets
// Exit status 1 when anything is found.
//
//   bone      the file has a bone `belt` and a bodypart `belt` whose every point is on that bone
//   lattice   the belt's rounds (the connected pieces with the most triangles) stand a pitch apart along one line
//   slide     on shoot and shoot2 the belt bone's travel (in the idle pose's space) is along the lattice, toward the gun, grows to exactly one
//             pitch within a few frames and rests there; on idle, draw, reload and stock it does not move
//   pop       the whole model drawn in the first person camera with the gun held at its idle pose, at the start of a shoot animation and at
//             every frame from the end of the slide on, at each fov: the same picture to the pixel, so the shot that restarts the animation
//             shows no jump; and the same from 12 directions round the gun
//   far end   the belt's front faces in the first person camera in every frame of every animation, at each fov, on 4:3, 5:4, 16:10 and 16:9
//             pictures, the fov taken as the engine takes it (engineFov below): how far along the belt (in pitches) the farthest triangle
//             that touches the picture is from the belt's end
//   mouth     the model seen from 60 directions and in the first person camera with the belt at 21 places of its slide: nothing of the belt
//             shows higher along the belt than the highest place that shows at rest (what is above is inside the throat, behind its walls)
//   sets      with more files: the bones, the animation tables and values, and every triangle are equal (only the picture may differ)
// What it cannot see: the engine's own interpolation between stored frames (the slide is linear between them, which this reads), the game's
// view bob, and any camera of the game's but its field of view and aspect.
import { readFileSync } from "node:fs";
import { K } from "./common.mjs";
import { posedTriangles, cameraOf, drawDepth, unproject, sphereViews } from "./render-lib.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args[i + 1]; };
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--fov", "--margin", "--only"].includes(args[i - 1])));
if (!files.length) { console.error("usage: node check-belt.mjs <model.mdl> [<other.mdl> ...] [--fov 90,110,120] [--margin 1.0] [--detail] [--quiet]"); process.exit(2); }
const FOVS = opt("fov", "90,100,110,120").split(",").map(Number);
const MARGIN = Number(opt("margin", 1.0));
const detail = args.includes("--detail");
const quiet = args.includes("--quiet");
const only = opt("only", "slide,pop,far,mouth,sets").split(",");   // sections to run (each takes 5 to 25 seconds)
const want = (name) => only.includes(name);
let problems = 0;
const say = (s) => console.log(s);
const bad = (s) => { problems++; say(`  FOUND ${s}`); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

/** What a file says about its belt. */
function inspect(file) {
  const mdl = readFileSync(file);
  const info = K.readMdl(mdl);
  const bones = K.bones(mdl);
  return { file, mdl, info, bones, belt: bones.findIndex((b) => b.name === "belt"), part: info.bodyparts.findIndex((b) => b.name === "belt"), seqs: K.sequences(mdl) };
}

/** Bone matrices with every bone at its first idle frame but the belt, which takes the values `row`. */
function idleWithBelt(m, row) {
  const values = K.frameValues(m.mdl, 0, 0).map((v) => [...v]);
  values[m.belt] = row;
  return K.boneMatrices(m.bones, values);
}
const beltRow = (m, q, f) => [...K.frameValues(m.mdl, q, f)[m.belt]];

/** The belt's rounds in the idle pose: the line through them, the order along it, and for each triangle of the belt bodypart its farthest point along it. */
function lattice(m) {
  const all = posedTriangles(m.mdl, { seq: 0, frame: 0 });
  const ids = [];
  all.tris.forEach((t, i) => { if (t.where.bodypart === m.part) ids.push(i); });
  const pts = new Float64Array(ids.length * 9);
  ids.forEach((id, i) => pts.set(all.pts.subarray(id * 9, id * 9 + 9), i * 9));
  const key = (k) => `${Math.round(pts[k] * 1000)},${Math.round(pts[k + 1] * 1000)},${Math.round(pts[k + 2] * 1000)}`;
  const parent = ids.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const first = new Map();
  ids.forEach((_, i) => { for (let c = 0; c < 3; c++) { const k = key(i * 9 + c * 3); if (first.has(k)) parent[find(i)] = find(first.get(k)); else first.set(k, i); } });
  const by = new Map();
  ids.forEach((_, i) => { const r = find(i); (by.get(r) ?? by.set(r, []).get(r)).push(i); });
  const pieces = [...by.values()].map((list) => {
    const c = [0, 0, 0];
    for (const i of list) for (let q = 0; q < 9; q++) c[q % 3] += pts[i * 9 + q] / (list.length * 3);
    return { tris: list.length, centre: c };
  });
  const biggest = Math.max(...pieces.map((p) => p.tris));
  const rounds = pieces.filter((p) => p.tris === biggest).map((p) => p.centre);
  let axis = [0, 0, 0], far = 0;
  for (const a of rounds) for (const b of rounds) { const d = Math.hypot(...sub(a, b)); if (d > far) { far = d; axis = unit(sub(b, a)); } }
  if (axis[2] > 0) axis = axis.map((v) => -v);   // the belt hangs down from the throat: its far end is the low one
  const origin = rounds.reduce((best, c) => (dot(c, axis) < dot(best, axis) ? c : best), rounds[0]);
  const s = rounds.map((c) => dot(sub(c, origin), axis)).sort((a, b) => a - b);
  const triS = ids.map((_, i) => { let hi = -1e9; for (let c = 0; c < 3; c++) hi = Math.max(hi, dot(sub([pts[i * 9 + c * 3], pts[i * 9 + c * 3 + 1], pts[i * 9 + c * 3 + 2]], origin), axis)); return hi; });
  return { rounds: s.length, axis, origin, s, triS, pieces: pieces.length };
}

const ASPECTS = [[640, 480, "4:3"], [640, 512, "5:4"], [704, 440, "16:10"], [848, 477, "16:9"]];

/**
 * The horizontal field of view (degrees) the engine draws a w by h picture with when the player's fov is `fov` (Xash3D's V_AdjustFov): a 4:3
 * or 5:4 picture takes it as it is; a wider one keeps the vertical field of view a 4:3 picture would have and widens the horizontal one. So
 * what a wide picture shows above and below the gun is what 4:3 shows, and 5:4 (the tallest) shows the most.
 */
function engineFov(fov, w, h) {
  if (w * 3 === 4 * h || w * 4 === 5 * h) return fov;
  const rad = Math.PI / 180;
  const vertical = 2 * Math.atan((Math.tan((fov * rad) / 2) * 3) / 4);
  const across = 2 * Math.atan(Math.tan(vertical / 2) * (w / h));
  return Math.max(across / rad, fov);
}

const first = inspect(files[0]);
say(`${files[0]}`);
say(`  ${first.bones.length} bones, ${first.seqs.length} animations (${first.seqs.map((s) => `${s.name} ${s.frames}`).join(", ")}), bodyparts ${first.info.bodyparts.map((b) => b.name).join("/")}`);
if (first.belt < 0 || first.part < 0) { bad("no bone `belt` or no bodypart `belt`"); say("  RESULT: problems"); process.exit(1); }
{
  const m = first;
  const L = lattice(m);
  // every point of the belt bodypart is on the belt bone
  const onBones = new Set();
  m.info.bodyparts[m.part].models.forEach((mo) => mo.meshes.forEach((me) => K.readMesh(m.mdl, mo, me).forEach((tri) => tri.forEach((c) => onBones.add(c.bone)))));
  if (onBones.size !== 1 || !onBones.has(m.belt)) bad(`the belt bodypart has points on bones ${[...onBones].join(",")} (only bone ${m.belt}, belt, is allowed)`);
  const gaps = L.s.slice(1).map((v, i) => v - L.s[i]);
  const pitch = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const spread = Math.max(...gaps.map((g) => Math.abs(g - pitch)));
  say(`  lattice: ${L.rounds} rounds on a line (${L.axis.map((v) => v.toFixed(4)).join(", ")}), pitch ${pitch.toFixed(5)}, largest deviation from it ${spread.toExponential(1)}, the far end ${L.s.at(-1).toFixed(2)} from the first round`);
  if (spread > 2e-3) bad(`the rounds are not a pitch apart everywhere (deviation ${spread})`);

  // ---- slide: the belt bone's travel in the idle pose's space, frame by frame
  const idleM = K.boneMatrices(m.bones, K.frameValues(m.mdl, 0, 0));
  let feedEnd = 0;
  m.seqs.forEach((s, q) => {
    const T = [];
    for (let f = 0; f < s.frames; f++) { const p = idleWithBelt(m, beltRow(m, q, f))[m.belt]; T.push([p[0][3] - idleM[m.belt][0][3], p[1][3] - idleM[m.belt][1][3], p[2][3] - idleM[m.belt][2][3]]); }
    const d = T.map((p) => Math.hypot(...p));
    const along = T.map((p) => dot(p, L.axis));
    const last = d.at(-1);
    if (/^shoot/.test(s.name)) {
      const end = d.findIndex((v) => Math.abs(v - last) < 2e-4);
      feedEnd = Math.max(feedEnd, end);
      say(`  slide ${s.name}: travel by frame, in pitches: ${d.slice(0, Math.min(8, d.length)).map((v) => (v / pitch).toFixed(3)).join(" ")} ... ${(last / pitch).toFixed(3)} at the last frame; it reaches that at frame ${end} and rests; ${along.at(-1) < 0 ? "toward the gun" : "AWAY from the gun"}`);
      if (Math.abs(last - pitch) > 2e-3) bad(`${s.name}: the belt travels ${last} and a pitch is ${pitch}`);
      if (!d.every((v, i) => i === 0 || v >= d[i - 1] - 1e-5) || !d.slice(end).every((v) => Math.abs(v - last) < 2e-4)) bad(`${s.name}: the slide is not a rise to one value and a rest`);
      if (Math.abs(Math.abs(along.at(-1)) - last) > 2e-4) bad(`${s.name}: the belt does not slide along its line`);
      if (along.at(-1) >= 0) bad(`${s.name}: the belt slides away from the gun`);
      if (d[0] > 1e-4) bad(`${s.name}: the belt is not at rest in frame 0`);
    } else if (d.some((v) => v > 1e-4)) bad(`${s.name}: the belt moves in an animation it should not move in (largest ${Math.max(...d).toFixed(4)})`);
    else say(`  ${s.name}: the belt does not move (${s.frames} frames)`);
  });

  // ---- pop: the whole picture, gun at idle, after the slide against before it
  if (want("pop")) {
    // every frame from the end of the slide on has the very values the end of the slide has: the belt does not move again
    let held = 0, frames = 0;
    for (const [q, s] of m.seqs.entries()) {
      if (!/^shoot/.test(s.name)) continue;
      const end = beltRow(m, q, feedEnd);
      for (let f = feedEnd; f < s.frames; f++) { beltRow(m, q, f).forEach((v, i) => { held = Math.max(held, Math.abs(v - end[i])); }); frames++; }
    }
    say(`  pop: ${frames} frames from the end of the slide on hold the belt bone's values of that frame to within ${held}`);
    if (held > 0) bad(`the belt moves after the slide (${held})`);
    // the picture at the end of the slide and at the last frame is the picture of frame 0
    for (const fov of FOVS) {
      let worst = 0, compared = 0;
      for (const [q, s] of m.seqs.entries()) {
        if (!/^shoot/.test(s.name)) continue;
        const draw = (f) => K.render(m.mdl, { view: "first", fov, width: 640, height: 480, seq: 0, frame: 0, pose: idleWithBelt(m, beltRow(m, q, f)), background: [0, 0, 0] });
        const ref = draw(0);
        for (const f of [feedEnd, feedEnd + 1, 10, s.frames - 1]) {
          const img = draw(f);
          for (let i = 0; i < ref.rgba.length; i++) worst = Math.max(worst, Math.abs(ref.rgba[i] - img.rgba[i]));
          compared++;
        }
      }
      say(`  pop, first person fov ${fov} (640x480, whole model, gun at idle): ${compared} frames (the end of the slide, the next, 10, the last of each shoot animation) against frame 0: largest difference of any pixel channel ${worst} of 255`);
      if (worst > 2) bad(`pop at fov ${fov}: the picture after the slide is not the picture before it (difference ${worst})`);
    }
    // 12 directions round the throat (orthographic, 28 pixels a unit); only what lies within 6 units of the mouth is compared, the far end being where the belt really moved
    let worst = 0, views = 0, pixels = 0;
    for (const [yaw, pitchDeg] of sphereViews(12)) {
      const cam = cameraOf({ yaw, pitch: pitchDeg, mid: L.origin, scale: 28, w: 640, h: 480 });
      const shot = (f) => {
        const P = posedTriangles(m.mdl, { seq: 0, frame: 0, pose: idleWithBelt(m, beltRow(m, 2, f)) });
        return drawDepth(P.pts, P.n, cam, 1);
      };
      const x = shot(0), y = shot(feedEnd);
      // a pixel counts when what is nearest in it, in either picture, is within 6 units of the mouth (and nothing nearer is farther: looking along the belt from below, its far end is)
      const far = (d, i) => d !== Infinity && Math.hypot(...sub(unproject(cam, i % cam.w, (i / cam.w) | 0, d), L.origin)) >= 6;
      for (let i = 0; i < x.length; i++) {
        if (x[i] === Infinity && y[i] === Infinity) continue;
        if (far(x[i], i) || far(y[i], i)) continue;
        pixels++;
        worst = Math.max(worst, Math.abs((x[i] === Infinity ? 1e3 : x[i]) - (y[i] === Infinity ? 1e3 : y[i])));
      }
      views++;
    }
    say(`  pop, ${views} directions round the throat (${pixels} pixels whose nearest surface is within 6 units of the mouth): largest difference of the nearest surface's depth, belt at frame ${feedEnd} against frame 0: ${worst.toExponential(1)} units`);
    if (worst > 0.02) bad(`the model looks different after the slide from some direction (depth differs by ${worst})`);
  }

  // ---- far end
  const cams = [];
  if (want("far")) {
  for (const fov of FOVS) for (const [w, h, name] of ASPECTS) cams.push({ fov, name, w, h, cam: cameraOf({ first: true, fov: engineFov(fov, w, h), w, h }), worstS: -1e9, where: "", bySeq: {} });
  let poses = 0;
  m.seqs.forEach((s, q) => {
    for (let f = 0; f < s.frames; f++) {
      const P = posedTriangles(m.mdl, { seq: q, frame: f });
      poses++;
      let firstBelt = -1, lastBelt = -1;
      P.tris.forEach((t, i) => { if (t.where.bodypart === m.part) { if (firstBelt < 0) firstBelt = i; lastBelt = i; } });
      for (const c of cams) {
        const ids = new Int32Array(c.w * c.h);
        drawDepth(P.pts, P.n, c.cam, 1, ids, (i) => i >= firstBelt && i <= lastBelt);
        const seen = new Set();
        for (let k = 0; k < ids.length; k++) if (ids[k] >= 0) seen.add(ids[k]);
        for (const id of seen) {
          const v = L.triS[id - firstBelt];
          if (v > c.worstS) { c.worstS = v; c.where = `${s.name} ${f}`; }
          if (v > (c.bySeq[s.name] ?? -1e9)) c.bySeq[s.name] = v;
        }
      }
    }
  });
  say(`  far end: the belt's front faces that touch the picture in ${poses} poses (every frame of every animation) at ${cams.length} cameras; margin = pitches between the farthest such point and the belt's end (${(L.s.at(-1) + 0.32).toFixed(2)})`);
  for (const c of cams) {
    const margin = (L.s.at(-1) + 0.32 - c.worstS) / pitch;
    if (!quiet || margin < MARGIN * 3) say(`    fov ${String(c.fov).padEnd(3)} ${c.name.padEnd(5)} margin ${margin.toFixed(1).padStart(5)} pitches (the worst pose: ${c.where})`);
    if (detail) say(`        by animation: ${Object.entries(c.bySeq).map(([n, v]) => `${n} ${((L.s.at(-1) + 0.32 - v) / pitch).toFixed(1)}`).join("  ")}`);
    if (margin < MARGIN) bad(`far end at fov ${c.fov} on ${c.name}: only ${margin.toFixed(2)} pitches clear of the picture`);
  }
  }

  // ---- mouth: nothing of the belt shows higher along the belt than the highest place that shows at rest
  if (want("mouth")) {
  const up = L.axis.map((v) => -v);
  const row0 = beltRow(m, 2, 0), rowEnd = beltRow(m, 2, feedEnd);
  const cameras = sphereViews(60).map(([yaw, pitchDeg]) => cameraOf({ yaw, pitch: pitchDeg, mid: L.origin, scale: 22, w: 640, h: 480 }));
  for (const fov of FOVS) cameras.push(cameraOf({ first: true, fov, w: 640, h: 480 }));
  const highest = [];
  for (let k = 0; k <= 20; k++) {
    const t = k / 20;
    const pose = idleWithBelt(m, row0.map((v, i) => v + (rowEnd[i] - v) * t));
    const P = posedTriangles(m.mdl, { seq: 0, frame: 0, pose });
    let firstBelt = -1, lastBelt = -1;
    P.tris.forEach((tr, i) => { if (tr.where.bodypart === m.part) { if (firstBelt < 0) firstBelt = i; lastBelt = i; } });
    let top = -1e9;
    for (const cam of cameras) {
      const ids = new Int32Array(cam.w * cam.h);
      const depth = drawDepth(P.pts, P.n, cam, 1, ids);
      for (let at = 0; at < ids.length; at++) {
        if (ids[at] < firstBelt || ids[at] > lastBelt) continue;
        const u = dot(sub(unproject(cam, at % cam.w, (at / cam.w) | 0, depth[at]), L.origin), up);
        if (u > top) top = u;
      }
    }
    highest.push(top);
  }
  const rest = highest[0];
  const worst = Math.max(...highest.map((v) => v - rest));
  say(`  mouth: highest visible point of the belt along the belt (from the first round, toward the gun): at rest ${rest.toFixed(3)}; at the 21 places of the slide the most above that is ${worst.toFixed(3)} units (${cameras.length} cameras each)`);
  if (detail) say(`        by place: ${highest.map((v) => v.toFixed(2)).join(" ")}`);
  if (worst > 0.12) bad(`a round shows ${worst.toFixed(3)} above the mouth during the slide (it comes through the throat's wall or roof)`);
  }
}

if (want("sets")) for (const other of files.slice(1)) {
  const a = first, b = inspect(other);
  say(`${other} against ${files[0]}`);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  if (!same(a.bones.map((q) => [q.name, q.parent, q.pos, q.rot]), b.bones.map((q) => [q.name, q.parent, q.pos, q.rot]))) bad("the bones differ");
  if (!same(a.seqs.map((s) => [s.name, s.fps, s.frames, s.bbmin, s.bbmax]), b.seqs.map((s) => [s.name, s.fps, s.frames, s.bbmin, s.bbmax]))) bad("the animation tables differ");
  let animDiff = 0, values = 0;
  a.seqs.forEach((s, q) => { for (let f = 0; f < s.frames; f++) { const x = K.frameValues(a.mdl, q, f), y = K.frameValues(b.mdl, q, f); x.forEach((v, i) => v.forEach((n, j) => { animDiff = Math.max(animDiff, Math.abs(n - y[i][j])); values++; })); } });
  say(`  ${values} bone values (every bone, every frame, every animation): largest difference ${animDiff}`);
  if (animDiff > 0) bad(`the animations differ (${animDiff})`);
  const ta = posedTriangles(a.mdl, { seq: 0, frame: 0 }), tb = posedTriangles(b.mdl, { seq: 0, frame: 0 });
  let geom = ta.n === tb.n ? 0 : 1e9;
  if (ta.n === tb.n) for (let i = 0; i < ta.pts.length; i++) geom = Math.max(geom, Math.abs(ta.pts[i] - tb.pts[i]));
  say(`  ${ta.n} / ${tb.n} triangles, largest difference of any corner ${geom}`);
  if (geom > 0) bad(`the geometry differs (${geom})`);
  const ia = a.info.bodyparts.map((p) => `${p.name}:${p.models.map((mo) => `${mo.numverts}p/${mo.numnorms}n`).join("+")}`).join(" ");
  const ib = b.info.bodyparts.map((p) => `${p.name}:${p.models.map((mo) => `${mo.numverts}p/${mo.numnorms}n`).join("+")}`).join(" ");
  say(`  submodel sizes ${ia === ib ? "equal: " + ia : "DIFFER: " + ia + " / " + ib}`);
  if (ia !== ib) bad("the submodels differ in size");
}
say(problems ? `  RESULT: ${problems} problems` : "  RESULT: belt ok");
process.exit(problems ? 1 : 0);
