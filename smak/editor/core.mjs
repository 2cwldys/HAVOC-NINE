// The editor's arithmetic, shared word for word by the page (in the browser) and by the server and the command line (in
// Node): what a project says an animation is, how its keys are interpolated into every-frame values, and every edit as
// a small patch on the project. Nothing here touches a file, a Buffer or the DOM.
//
//   a frame     for each bone, six numbers: x y z from its parent, then the turn about x, y, z in radians (as smak's)
//   a key       one bone's six numbers at one frame
//   ctx         what is known of the source model: { bones: [{ name, parent, pos, rot }], seqs: [{ name, fps, frames,
//               loops, events }], base(n): the source animation's frames }
//   a patch     { what, set: [{ path: [..], value }] }; a value of null removes what is at the path
export const FORMAT = "smakproj 1";
export const DEG = Math.PI / 180;
const R7 = (v) => Math.round(v * 1e7) / 1e7;
export const round = (values) => values.map(R7);

// ── quaternions [x, y, z, w], and the engine's angles (about x, then y, then z) ──
export function qOf(rx, ry, rz) {
  const sr = Math.sin(rx / 2), cr = Math.cos(rx / 2), sp = Math.sin(ry / 2), cp = Math.cos(ry / 2), sy = Math.sin(rz / 2), cy = Math.cos(rz / 2);
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}
export const qMul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
export const qUnit = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
export const qAxis = (axis, angle) => { const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; };
/** From one turn to another the short way round. */
export function slerp(a, b, t) {
  let d = qDot(a, b); const s = d < 0 ? -1 : 1; d = Math.abs(d);
  if (d > 0.9999995) return qUnit(a.map((v, i) => v + (s * b[i] - v) * t));
  const th = Math.acos(d), k = 1 / Math.sin(th), wa = Math.sin((1 - t) * th) * k, wb = Math.sin(t * th) * k * s;
  return a.map((v, i) => v * wa + b[i] * wb);
}
/** The angle between two turns, in radians. */
export const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(qDot(a, b))));
export function eulerOfQ(q) {
  const [x, y, z, w] = q, m20 = 2 * (x * z - w * y), m21 = 2 * (y * z + w * x), m22 = 1 - 2 * (x * x + y * y), m10 = 2 * (x * y + w * z), m00 = 1 - 2 * (y * y + z * z);
  if (Math.abs(m20) < 0.9999995) return [Math.atan2(m21, m22), Math.asin(-m20), Math.atan2(m10, m00)];
  return [Math.atan2(-2 * (y * z - w * x), 1 - 2 * (x * x + z * z)), m20 < 0 ? Math.PI / 2 : -Math.PI / 2, 0];
}

// ── matrices: 12 numbers, three rows of four, a bone's space to the model's ──
export function matOf(v) {
  const sx = Math.sin(v[3]), cx = Math.cos(v[3]), sy = Math.sin(v[4]), cy = Math.cos(v[4]), sz = Math.sin(v[5]), cz = Math.cos(v[5]);
  return [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz, v[0], cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz, v[1], -sy, sx * cy, cx * cy, v[2]];
}
export function mmul(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 12; r += 4) { for (let c = 0; c < 4; c++) o[r + c] = a[r] * b[c] + a[r + 1] * b[4 + c] + a[r + 2] * b[8 + c]; o[r + 3] += a[r + 3]; }
  return o;
}
export const minv = (m) => [m[0], m[4], m[8], -(m[0] * m[3] + m[4] * m[7] + m[8] * m[11]), m[1], m[5], m[9], -(m[1] * m[3] + m[5] * m[7] + m[9] * m[11]), m[2], m[6], m[10], -(m[2] * m[3] + m[6] * m[7] + m[10] * m[11])];
export const mpt = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
export function eulerOfMat(m) {
  if (Math.abs(m[8]) < 0.9999995) return [Math.atan2(m[9], m[10]), Math.asin(-m[8]), Math.atan2(m[4], m[0])];
  return [Math.atan2(-m[6], m[5]), m[8] < 0 ? Math.PI / 2 : -Math.PI / 2, 0];
}
export const qOfMat = (m) => qOf(...eulerOfMat(m));
/** Every bone's matrix for a frame's values. */
export function worldOf(bones, values) {
  const out = [];
  for (let i = 0; i < bones.length; i++) { const m = matOf(values[i]); out.push(bones[i].parent < 0 ? m : mmul(out[bones[i].parent], m)); }
  return out;
}
export const restValues = (bones) => bones.map((b) => [...b.pos, ...b.rot]);

// ── keys and what lies between them ────────────────────────────────────────
/** A bone's keys ({ frame: six numbers }) laid out for evaluating: frames in order, values, and turns each on the side of the one before. */
export function trackOf(keys) {
  const f = Object.keys(keys).map(Number).sort((a, b) => a - b), v = f.map((k) => keys[k]), q = [];
  v.forEach((x, i) => { let c = qOf(x[3], x[4], x[5]); if (i && qDot(c, q[i - 1]) < 0) c = c.map((t) => -t); q.push(c); });
  return { f, v, q };
}
/** A track at a frame: { p, q, key (the key's number in the track when the frame is one, else -1) }. Before the first key and
 *  after the last it holds. `smooth`: a curve through the keys (Catmull-Rom by the keys' own spacing); otherwise straight. */
export function evalPQ(tr, x, smooth) {
  const n = tr.f.length, at = (i) => ({ p: tr.v[i].slice(0, 3), q: tr.q[i], key: i });
  if (x <= tr.f[0]) return at(0); if (x >= tr.f[n - 1]) return at(n - 1);
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr.f[mid] <= x) lo = mid; else hi = mid; }
  if (tr.f[lo] === x) return at(lo);
  const i = lo, j = lo + 1, h = tr.f[j] - tr.f[i], t = (x - tr.f[i]) / h;
  if (!smooth) return { p: [0, 1, 2].map((a) => tr.v[i][a] + (tr.v[j][a] - tr.v[i][a]) * t), q: slerp(tr.q[i], tr.q[j], t), key: -1 };
  const t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  const a0 = Math.max(i - 1, 0), b1 = Math.min(j + 1, n - 1), di = tr.f[j] - tr.f[a0], dj = tr.f[b1] - tr.f[i];
  const curve = (get) => { const pi = get(i), pj = get(j); return h00 * pi + h10 * h * (pj - get(a0)) / di + h01 * pj + h11 * h * (get(b1) - pi) / dj; };
  return { p: [0, 1, 2].map((a) => curve((k) => tr.v[k][a])), q: qUnit([0, 1, 2, 3].map((a) => curve((k) => tr.q[k][a]))), key: -1 };
}
/** The same as six numbers: a key's own, to the digit, at a key. */
export function evalTrack(tr, x, smooth) { const e = evalPQ(tr, x, smooth); return e.key >= 0 ? tr.v[e.key].slice() : [...e.p, ...eulerOfQ(e.q)]; }
/** Two frames' values of one bone mixed: what the engine shows between two frames. */
export function mix(a, b, k) {
  if (!k) return a;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, ...eulerOfQ(slerp(qOf(a[3], a[4], a[5]), qOf(b[3], b[4], b[5]), k))];
}

// ── what a project says an animation is ────────────────────────────────────
const boneAt = (ctx, bone) => { const b = typeof bone === "number" ? bone : ctx.bones.findIndex((x) => x.name.toLowerCase() === String(bone).toLowerCase()); if (!ctx.bones[b]) throw new Error(`no bone ${bone}`); return b; };
/** The animation's number for a number or a name (the project's added animations included), or an error. */
export function animAt(project, ctx, which) {
  const list = animList(project, ctx), n = /^\d+$/.test(String(which)) ? Number(which) : (list.find((a) => a.name.toLowerCase() === String(which).toLowerCase())?.n ?? -1);
  if (!list.some((a) => a.n === n)) throw new Error(`no animation ${which}: there are ${list.map((a) => `${a.n} ${a.name}`).join(", ")}`);
  return n;
}
/** Every animation the baked model will have, in order: the source's, then the project's added ones. */
export function animList(project, ctx) {
  const anims = project.anims ?? {}, out = ctx.seqs.map((s, n) => ({ n, name: s.name, fps: anims[n]?.fps ?? s.fps, frames: anims[n]?.frames ?? s.frames, loops: anims[n]?.loops ?? s.loops, added: false, outside: Boolean(s.group), edited: Boolean(anims[n]) }));
  for (const n of Object.keys(anims).map(Number).filter((k) => k >= ctx.seqs.length).sort((a, b) => a - b)) { const e = anims[n], s = ctx.seqs[e.copyOf]; if (s) out.push({ n, name: e.name, fps: e.fps ?? s.fps, frames: e.frames ?? s.frames, loops: e.loops ?? s.loops, added: true, outside: false, edited: true }); }
  return out;
}
/** One animation as the project has it: its settings, its keys by bone name, its events, and the source frames under it. */
export function animOf(project, ctx, n) {
  const e = project.anims?.[n] ?? {}, added = n >= ctx.seqs.length, baseN = added ? e.copyOf : n, src = ctx.seqs[baseN];
  if (!src) throw new Error(`no animation ${n}`);
  const base = ctx.base(baseN);
  return { n, name: e.name ?? src.name, added, baseN, base, fps: e.fps ?? src.fps, loops: e.loops ?? src.loops, count: e.frames ?? base.length, smooth: (e.interp ?? "smooth") !== "linear", keys: e.keys ?? {}, events: e.events ?? src.events ?? [], entry: project.anims?.[n] };
}
/** One bone of the source animation at a frame of the project's: the same frame, or, when the length was changed, the same moment. */
export function baseAt(a, f, b) {
  const S = a.base.length; if (a.count === S) return a.base[f][b];
  const t = a.count > 1 ? f * (S - 1) / (a.count - 1) : 0, i = Math.min(S - 1, Math.floor(t));
  return mix(a.base[i][b], a.base[Math.min(i + 1, S - 1)][b], t - i);
}
/** One bone's values at every frame: from its keys when it has any, else the source's. */
export function bakeBone(a, ctx, b) {
  const keys = a.keys[ctx.bones[b].name];
  if (!keys || !Object.keys(keys).length) return Array.from({ length: a.count }, (_, f) => baseAt(a, f, b).slice());
  const tr = trackOf(keys);
  return Array.from({ length: a.count }, (_, f) => evalTrack(tr, f, a.smooth));
}
/** The animation as the file wants it: frames[frame][bone] = six numbers. */
export function bakeAnim(a, ctx) {
  const cols = ctx.bones.map((_, b) => bakeBone(a, ctx, b));
  return Array.from({ length: a.count }, (_, f) => cols.map((c) => c[f]));
}
/** A bone that has no keys yet, given one at every frame: how an animation opens. */
export function denseKeys(a, ctx, b) { const col = bakeBone(a, ctx, b); return Object.fromEntries(col.map((v, f) => [f, round(v)])); }

/** The fewest keys that give a bone's every-frame values back within `rot` (radians) and `pos` (units), by the animation's
 *  own way of interpolating. The first and last frames always stay (a bone that does not move
 *  keeps those two: a key put between them later bends it there and lets it come back). */
export function thinTrack(dense, rot, pos, smooth) {
  const N = dense.length, Q = dense.map((v) => qOf(v[3], v[4], v[5])), eR = Math.max(rot, 1e-7), eP = Math.max(pos, 1e-7), keep = new Set([0, N - 1]);
  for (;;) {
    const f = [...keep].sort((a, b) => a - b), tr = trackOf(Object.fromEntries(f.map((k) => [k, dense[k]]))); let added = false;
    for (let s = 0; s + 1 < f.length; s++) {
      let worst = 1, at = -1;
      for (let x = f[s] + 1; x < f[s + 1]; x++) { const e = evalPQ(tr, x, smooth), err = Math.max(Math.hypot(e.p[0] - dense[x][0], e.p[1] - dense[x][1], e.p[2] - dense[x][2]) / eP, qAngle(e.q, Q[x]) / eR); if (err > worst) { worst = err; at = x; } }
      if (at >= 0) { keep.add(at); added = true; }
    }
    if (!added) break;
  }
  return Object.fromEntries([...keep].sort((a, b) => a - b).map((k) => [k, round(dense[k])]));
}
/** How far two versions of an animation are apart at their worst: { units (a bone's origin, in the model's space), degrees (a
 *  bone's turn, in the model's space), frame, bone }. Both have to have the same number of frames. */
export function poseError(bones, A, B) {
  const worst = { units: 0, degrees: 0, frame: 0, bone: "" };
  for (let f = 0; f < Math.min(A.length, B.length); f++) {
    const wa = worldOf(bones, A[f]), wb = worldOf(bones, B[f]);
    for (let b = 0; b < bones.length; b++) {
      const d = Math.hypot(wa[b][3] - wb[b][3], wa[b][7] - wb[b][7], wa[b][11] - wb[b][11]), r = qAngle(qOfMat(wa[b]), qOfMat(wb[b])) / DEG;
      if (d > worst.units) { worst.units = d; worst.frame = f; worst.bone = bones[b].name; }
      if (r > worst.degrees) worst.degrees = r;
    }
  }
  return worst;
}

// ── left and right ─────────────────────────────────────────────────────────
const SIDES = [[/(^|[ _.])L([ _.]|$)/, "$1R$2", /(^|[ _.])R([ _.]|$)/, "$1L$2"], [/left/i, "right", /right/i, "left"]];
/** For each bone, the bone of the other side by its name (itself when it has none). */
export function mirrorMap(bones) {
  const at = new Map(bones.map((b, i) => [b.name.toLowerCase(), i]));
  return bones.map((b, i) => {
    for (const [l, toR, r, toL] of SIDES) for (const [from, to] of [[l, toR], [r, toL]]) if (from.test(b.name)) { const j = at.get(b.name.replace(from, to).toLowerCase()); if (j !== undefined && j !== i) return j; }
    return i;
  });
}
/** The plane the skeleton is alike on both sides of, from where its paired bones rest: { n, o, m (the reflection in it, as
 *  a matrix) }. With no pairs: the model's own middle, y = 0. */
export function mirrorPlane(bones) {
  const rest = worldOf(bones, restValues(bones)), pair = mirrorMap(bones); let n = [0, 0, 0], o = [0, 0, 0], count = 0;
  pair.forEach((j, i) => { if (j <= i) return; const a = [rest[i][3], rest[i][7], rest[i][11]], b = [rest[j][3], rest[j][7], rest[j][11]], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], s = d[0] * n[0] + d[1] * n[1] + d[2] * n[2] < 0 ? -1 : 1; n = n.map((v, k) => v + s * d[k]); o = o.map((v, k) => v + (a[k] + b[k]) / 2); count++; });
  const l = Math.hypot(...n); if (!count || l < 1e-6) { n = [0, 1, 0]; o = [0, 0, 0]; } else { n = n.map((v) => v / l); o = o.map((v) => v / count); }
  const d = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
  return { n, o, m: [0, 1, 2].flatMap((r) => [...[0, 1, 2].map((c) => (r === c ? 1 : 0) - 2 * n[r] * n[c]), 2 * d * n[r]]) };
}
/** A pose with left and right changed over: each bone takes the other side's motion from rest, mirrored in the skeleton's
 *  middle plane. A bone with no other side that hangs from one that has (a weapon in a hand) keeps its own values. */
export function mirrorPose(bones, values) {
  const rest = worldOf(bones, restValues(bones)), W = worldOf(bones, values), pair = mirrorMap(bones);
  const F = mirrorPlane(bones).m, flip = (m) => mmul(mmul(F, m), F);
  const under = bones.map((b) => { for (let p = b.parent; p >= 0; p = bones[p].parent) if (pair[p] !== p) return true; return false; });
  const out = [], now = [];
  bones.forEach((b, i) => {
    if (pair[i] === i && under[i]) { now.push(mmul(now[b.parent], matOf(values[i]))); out.push(values[i].slice()); return; }
    const j = pair[i], w = mmul(flip(mmul(W[j], minv(rest[j]))), rest[i]), local = b.parent < 0 ? w : mmul(minv(now[b.parent]), w);
    now.push(w); out.push(round([local[3], local[7], local[11], ...eulerOfMat(local)]));
  });
  return out;
}

// ── patches ────────────────────────────────────────────────────────────────
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
/** A project with a patch's changes made: { project (a new one), inverse (the `set` that puts back what was there) }. */
export function applyPatch(project, set) {
  const out = clone(project), inverse = [];
  for (const { path, value } of set) {
    let o = out; const last = String(path[path.length - 1]);
    for (const k of path.slice(0, -1)) { if (o[k] === null || typeof o[k] !== "object") { if (value === null || value === undefined) { o = null; break; } o[k] = {}; } o = o[k]; }
    if (!o) { inverse.unshift({ path, value: null }); continue; }
    inverse.unshift({ path, value: clone(o[last]) });
    if (value === null || value === undefined) delete o[last]; else o[last] = clone(value);
  }
  return { project: out, inverse };
}
/** What every patch on an animation starts with: its name written down the first time it is touched. */
const head = (project, a) => (project.anims?.[a.n] ? [] : [{ path: ["anims", a.n, "name"], value: a.name }]);
const frameIn = (a, frame) => { if (!Number.isInteger(frame) || frame < 0 || frame >= a.count) throw new Error(`${a.name} has frames 0 to ${a.count - 1}, not ${frame}`); };

/** A key for a bone at a frame. `spread` (frames): the same change, fading out, on the bone's other keys within that many
 *  frames either side, so that a change made where every frame is a key is carried through the frames about it. */
export function opKey(project, ctx, which, bone, frame, values, spread = 0) {
  const n = animAt(project, ctx, which), a = animOf(project, ctx, n), b = boneAt(ctx, bone), name = ctx.bones[b].name, had = a.keys[name] && Object.keys(a.keys[name]).length; frameIn(a, frame);
  const keys = had ? { ...a.keys[name] } : denseKeys(a, ctx, b), set = head(project, a);
  if (spread > 0) {
    const tr = trackOf(keys), old = evalTrack(tr, frame, a.smooth), dq = qMul(qOf(values[3], values[4], values[5]), qInv(qOf(old[3], old[4], old[5]))), dp = [0, 1, 2].map((k) => values[k] - old[k]);
    for (const g of tr.f) {
      const d = Math.abs(g - frame); if (!d || d >= spread) continue;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * d / spread), k = keys[g];
      keys[g] = round([k[0] + dp[0] * w, k[1] + dp[1] * w, k[2] + dp[2] * w, ...eulerOfQ(qMul(slerp([0, 0, 0, 1], dq, w), qOf(k[3], k[4], k[5])))]);
    }
  }
  keys[frame] = round(values);
  set.push(had && !spread ? { path: ["anims", n, "keys", name, String(frame)], value: keys[frame] } : { path: ["anims", n, "keys", name], value: keys });
  return { what: `key: ${a.name} / ${name} / frame ${frame}${spread ? ` (spread ${spread})` : ""}`, set };
}
/** A bone's values at a frame, as the project has them now. */
export function valuesAt(project, ctx, which, bone, frame) {
  const a = animOf(project, ctx, animAt(project, ctx, which)), b = boneAt(ctx, bone), keys = a.keys[ctx.bones[b].name];
  return keys && Object.keys(keys).length ? evalTrack(trackOf(keys), frame, a.smooth) : baseAt(a, frame, b).slice();
}
/** The key a turn about the bone's own axes (degrees, the engine's order) and a move (units, in its parent's space) from where it is make. */
export function opNudge(project, ctx, which, bone, frame, { rot = [0, 0, 0], move = [0, 0, 0] } = {}, spread = 0) {
  const v = valuesAt(project, ctx, which, bone, frame), q = qMul(qOf(v[3], v[4], v[5]), qOf(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG));
  return opKey(project, ctx, which, bone, frame, [v[0] + move[0], v[1] + move[1], v[2] + move[2], ...eulerOfQ(q)], spread);
}
/** One key less (the bone is interpolated there instead); `frame` "all": the bone goes back to the source's frames. */
export function opDeleteKey(project, ctx, which, bone, frame) {
  const n = animAt(project, ctx, which), a = animOf(project, ctx, n), b = boneAt(ctx, bone), name = ctx.bones[b].name;
  if (frame === "all") return { what: `bone back to the source: ${a.name} / ${name}`, set: a.keys[name] ? [{ path: ["anims", n, "keys", name], value: null }] : [] };
  frameIn(a, frame);
  const had = a.keys[name] && Object.keys(a.keys[name]).length, keys = had ? a.keys[name] : denseKeys(a, ctx, b);
  if (!(frame in keys)) throw new Error(`${name} has no key at frame ${frame} of ${a.name}`);
  if (Object.keys(keys).length < 2) throw new Error(`${name} has one key left in ${a.name}: remove them all ("all") to give the bone back to the source`);
  if (had) return { what: `key removed: ${a.name} / ${name} / frame ${frame}`, set: [{ path: ["anims", n, "keys", name, String(frame)], value: null }] };
  const rest = { ...keys }; delete rest[frame];
  return { what: `key removed: ${a.name} / ${name} / frame ${frame}`, set: [...head(project, a), { path: ["anims", n, "keys", name], value: rest }] };
}
/** A key taken to another frame (whatever key was there is replaced). */
export function opMoveKey(project, ctx, which, bone, from, to) {
  const n = animAt(project, ctx, which), a = animOf(project, ctx, n), b = boneAt(ctx, bone), name = ctx.bones[b].name; frameIn(a, from); frameIn(a, to);
  const keys = a.keys[name] && Object.keys(a.keys[name]).length ? { ...a.keys[name] } : denseKeys(a, ctx, b);
  if (!(from in keys)) throw new Error(`${name} has no key at frame ${from} of ${a.name}`);
  keys[to] = keys[from]; if (to !== from) delete keys[from];
  return { what: `key moved: ${a.name} / ${name} / frame ${from} to ${to}`, set: [...head(project, a), { path: ["anims", n, "keys", name], value: keys }] };
}
/** A whole pose (six numbers a bone) put at a frame: a key for every bone it changes, and none for those it leaves as they are. */
export function opPaste(project, ctx, which, frame, pose, spread = 0) {
  const n = animAt(project, ctx, which), a = animOf(project, ctx, n); let work = project, count = 0; const set = [];
  ctx.bones.forEach((bn, b) => {
    const cur = valuesAt(work, ctx, n, b, frame); if (cur.every((v, k) => Math.abs(v - pose[b][k]) < 1e-6)) return;
    const op = opKey(work, ctx, n, b, frame, pose[b], spread); set.push(...op.set); work = applyPatch(work, op.set).project; count++;
  });
  return { what: `pose pasted: ${a.name} / frame ${frame} (${count} bones)`, set };
}
/** Keys thinned: each bone (or those named) keeps the fewest keys that give its present motion back within `rot` degrees and `pos` units. */
export function opThin(project, ctx, which, { rot = 0.5, pos = 0.02, bones: only } = {}) {
  const n = animAt(project, ctx, which), a = animOf(project, ctx, n), set = head(project, a), names = only?.map((x) => ctx.bones[boneAt(ctx, x)].name); let before = 0, after = 0;
  ctx.bones.forEach((bn, b) => {
    if (names && !names.includes(bn.name)) return;
    const keys = thinTrack(bakeBone(a, ctx, b), rot * DEG, pos, a.smooth), had = a.keys[bn.name];
    before += had && Object.keys(had).length ? Object.keys(had).length : a.count; after += Object.keys(keys).length;
    set.push({ path: ["anims", n, "keys", bn.name], value: keys });
  });
  return { what: `keys thinned: ${a.name} within ${rot} degrees and ${pos} units, ${before} keys to ${after}`, set, before, after };
}
/** The animation's length (its keys and events keep their moment: the whole of it is stretched), rate, looping, and way of interpolating. */
export function opSettings(project, ctx, which, { frames, fps, loops, interp } = {}) {
  const n = animAt(project, ctx, which), a = animOf(project, ctx, n), set = head(project, a), said = [];
  if (frames !== undefined && frames !== a.count) {
    if (!Number.isInteger(frames) || frames < 1 || frames > 2000) throw new Error("frames: a whole number from 1 to 2000");
    const k = (frames - 1) / Math.max(1, a.count - 1);
    for (const [name, keys] of Object.entries(a.keys)) { const moved = {}; for (const f of Object.keys(keys).map(Number).sort((x, y) => x - y)) { const g = Math.round(f * k); if (!(g in moved)) moved[g] = keys[f]; } set.push({ path: ["anims", n, "keys", name], value: moved }); }
    if (a.events.length) set.push({ path: ["anims", n, "events"], value: a.events.map((e) => ({ ...e, frame: Math.round(e.frame * k) })) });
    set.push({ path: ["anims", n, "frames"], value: frames }); said.push(`${a.count} frames to ${frames}`);
  }
  if (fps !== undefined && fps !== a.fps) { if (!(fps > 0 && fps <= 1000)) throw new Error("fps: a number above 0"); set.push({ path: ["anims", n, "fps"], value: fps }); said.push(`${a.fps} fps to ${fps}`); }
  if (loops !== undefined && Boolean(loops) !== a.loops) { set.push({ path: ["anims", n, "loops"], value: Boolean(loops) }); said.push(loops ? "loops" : "plays once"); }
  if (interp !== undefined && (interp !== "linear") !== a.smooth) { set.push({ path: ["anims", n, "interp"], value: interp === "linear" ? "linear" : "smooth" }); said.push(interp === "linear" ? "straight between keys" : "curved through keys"); }
  return { what: `${a.name}: ${said.join(", ") || "nothing changed"}`, set: said.length ? set : [] };
}
/** The animation again under another name, after the last one: its number is the returned `n`. */
export function opDuplicate(project, ctx, which, name) {
  const from = animAt(project, ctx, which), a = animOf(project, ctx, from), list = animList(project, ctx), n = list[list.length - 1].n + 1;
  name = String(name ?? "").trim(); if (!name || name.length > 31) throw new Error("the new animation needs a name of 1 to 31 letters");
  if (list.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is an animation called ${name} already`);
  const entry = { name, copyOf: a.baseN, fps: a.fps, loops: a.loops, interp: a.smooth ? "smooth" : "linear", keys: clone(a.keys), events: clone(a.events) };
  if (a.count !== a.base.length) entry.frames = a.count;
  return { what: `${a.name} duplicated as ${name} (animation ${n})`, set: [{ path: ["anims", n], value: entry }], n };
}
/** The animation's events, all of them: [{ frame, event, options, type }]. */
export function opEvents(project, ctx, which, list) {
  const n = animAt(project, ctx, which), a = animOf(project, ctx, n);
  const events = list.map((e) => ({ frame: Math.max(0, Math.min(a.count - 1, Math.round(Number(e.frame) || 0))), event: Math.round(Number(e.event) || 0), type: Math.round(Number(e.type) || 0), options: String(e.options ?? "").slice(0, 63) })).sort((x, y) => x.frame - y.frame);
  return { what: `events of ${a.name}: ${events.length ? events.map((e) => `${e.frame}:${e.event} ${e.options}`).join(", ") : "none"}`, set: [...head(project, a), { path: ["anims", n, "events"], value: events }] };
}

// ── a texture's colours changed through its palette ────────────────────────
/** { brightness, contrast, saturation (each -100 to 100), hue (degrees), tint [r, g, b] (multiplied in), tintAmount (0 to 100) } on 768 bytes
 *  of palette; with `masked`, the last colour (the hole's) is left alone. */
export function adjustPalette(palette, { brightness = 0, contrast = 0, saturation = 0, hue = 0, tint = [255, 255, 255], tintAmount = 0 } = {}, masked = false) {
  const out = Uint8Array.from(palette), c = Math.tan((Math.max(-99, Math.min(99, contrast)) + 100) / 200 * Math.PI / 2), sat = 1 + saturation / 100, h = hue * DEG, ch = Math.cos(h), sh = Math.sin(h), ta = tintAmount / 100;
  for (let i = 0; i < (masked ? 255 : 256); i++) {
    let [r, g, b] = [palette[i * 3] / 255, palette[i * 3 + 1] / 255, palette[i * 3 + 2] / 255];
    if (hue) { const s3 = Math.sqrt(1 / 3); [r, g, b] = [r * (ch + (1 - ch) / 3) + g * ((1 - ch) / 3 - s3 * sh) + b * ((1 - ch) / 3 + s3 * sh), r * ((1 - ch) / 3 + s3 * sh) + g * (ch + (1 - ch) / 3) + b * ((1 - ch) / 3 - s3 * sh), r * ((1 - ch) / 3 - s3 * sh) + g * ((1 - ch) / 3 + s3 * sh) + b * (ch + (1 - ch) / 3)]; }
    const grey = 0.299 * r + 0.587 * g + 0.114 * b;
    [r, g, b] = [r, g, b].map((v, k) => { v = grey + (v - grey) * sat; v = (v - 0.5) * c + 0.5 + brightness / 200; return v * (1 - ta + ta * tint[k] / 255); });
    out[i * 3] = Math.max(0, Math.min(255, Math.round(r * 255))); out[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(g * 255))); out[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
  }
  return out;
}
