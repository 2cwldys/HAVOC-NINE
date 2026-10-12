// Laying a new piece over the one it replaces: where the original sits in its model file,
// its own axes, and the placing that makes the new one follow it. Used by build.mjs
// (swapMesh) and by anything that has to measure a model before making a piece for it.
import { readMdl, readMesh, restPose, mul34, apply34, inverse34 } from "./mdl.mjs";
import { sub, dot, cross, box, out, into, uniq, mainAxes } from "./vec.mjs";

// The hands' own meshes, which a view model's submodel may hold next to the weapon.
export const HANDS = /hands|arms|body/i;

/**
 * One submodel's weapon, measured: the meshes `pick` chooses, the bone that carries most
 * of them, and their triangles in that bone's space. `body` is the number the item's
 * script gives; `what` names the file in the error.
 */
export function measure(src, body, pick, what = "") {
  const info = readMdl(src), bp = info.bodyparts[0], j = Math.floor(body / bp.base) % bp.models.length, model = bp.models[j];
  const meshes = model.meshes.map((mesh, k) => ({ mesh, k })).filter(({ mesh }) => pick(mesh));
  if (!meshes.length) throw new Error(`${what} ${model.name}: no mesh of the weapon`);
  // everything into the space of the bone that carries most of it
  const rest = restPose(src), corners = meshes.flatMap(({ mesh }) => readMesh(src, model, mesh).map((t) => t.map((c) => ({ ...c, mesh }))) ), tally = new Map();
  for (const c of corners.flat()) tally.set(c.bone, (tally.get(c.bone) ?? 0) + 1);
  const bone = [...tally].sort((a, b) => b[1] - a[1])[0][0], toMain = (b) => mul34(inverse34(rest[bone]), rest[b]);
  const original = corners.map((t) => t.map((c) => (c.bone === bone ? c : { ...c, p: apply34(toMain(c.bone), c.p), n: toMain(c.bone).map((r) => dot(r, c.n)) })));
  return { info, j, model, meshes, rest, bone, original };
}

// ── frames: a piece's own axes ─────────────────────────────────────────────
const samplesOf = (tris) => tris.flatMap((t) => {
  const [a, b, c] = t.map((q) => q.p), area = Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
  return area < 1e-9 ? [] : [a, b, c, [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3)].map((p) => [...p, area / 4]);
});
/** Principal axes weighed by area (the same shape with another mesh has to give the same axes), centred on its box. */
export function frameOf(tris) {
  const { X, Y, o } = mainAxes(samplesOf(tris)), f = { X, Y, Z: cross(X, Y), o };
  const b = box(uniq(tris).map((p) => into(f, p)));
  return { ...f, o: out(f, [0, 1, 2].map((a) => (b.mn[a] + b.mx[a]) / 2)) };
}
/** The sword's view model, as the lab did it: the bone's own axes, longest first; the tip is the end farther from the hand. */
export function frameOfBox(tris) {
  const { mn, mx } = box(uniq(tris)), size = sub(mx, mn), order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
  const axis = (k, s = 1) => [0, 1, 2].map((a) => (a === k ? s : 0));
  const X = axis(order[0], Math.abs(mx[order[0]]) > Math.abs(mn[order[0]]) ? 1 : -1), Y = axis(order[1]);
  return { X, Y, Z: cross(X, Y), o: [0, 0, 0] };
}
/** The sword's world placements: principal axes of its points; the guard, where it is widest, tells which end is the grip. */
export function frameOfGuard(tris) {
  const points = uniq(tris);
  let { X, Y, o } = mainAxes(points.map((p) => [...p, 1]));
  let widest = 0, guard = 0, lo = 1e9, hi = -1e9;
  for (const p of points) { const d = sub(p, o), a = dot(d, X), w = Math.abs(dot(d, Y)); lo = Math.min(lo, a); hi = Math.max(hi, a); if (w > widest) { widest = w; guard = a; } }
  if (guard - lo > hi - guard) X = X.map((t) => -t);
  return { X, Y, Z: cross(X, Y), o };
}

// ── laying the new piece over the original ─────────────────────────────────
/** Same length, starting at the same end, centred across the width and the thickness. Both in the original's axes. */
function overlay(points, onto) {
  const ob = box(onto), nb = box(points), k = (ob.mx[0] - ob.mn[0]) / (nb.mx[0] - nb.mn[0]);
  const move = [ob.mn[0] - nb.mn[0] * k, (ob.mx[1] + ob.mn[1]) / 2 - (nb.mx[1] + nb.mn[1]) / 2 * k, (ob.mx[2] + ob.mn[2]) / 2 - (nb.mx[2] + nb.mn[2]) / 2 * k];
  return { k, at: (p) => [0, 1, 2].map((a) => p[a] * k + move[a]) };
}
/** A piece's outline along x: in each of n stretches, how far it reaches in y and in z. */
function profile(tris, x0, x1, n = 24) {
  const t = Array.from({ length: n }, () => [Infinity, -Infinity, Infinity, -Infinity]);
  for (const tri of tris) for (let s = 0; s <= 4; s++) for (let r = 0; r <= 4 - s; r++) {
    const w = [s / 4, r / 4, 1 - (s + r) / 4], p = [0, 1, 2].map((k) => tri[0][k] * w[0] + tri[1][k] * w[1] + tri[2][k] * w[2]);
    const q = t[Math.min(n - 1, Math.max(0, Math.floor((p[0] - x0) / (x1 - x0) * n)))];
    q[0] = Math.min(q[0], p[1]); q[1] = Math.max(q[1], p[1]); q[2] = Math.min(q[2], p[2]); q[3] = Math.max(q[3], p[2]);
  }
  return t;
}
/**
 * The new piece on the original, both in their own axes: of the four ways of turning it
 * round, the one whose outline follows the original's best. Returns the placing and what
 * is left over between the two outlines, in units.
 */
export function bestTurn(piece, original, haft = false) {
  if (haft) { const fit = onHaft(piece, original); if (fit) return fit; }
  // what stands off a piece without being part of it (flames: `loose`) is not measured
  const solid = piece.some((t) => t.loose) ? piece.filter((t) => !t.loose) : piece;
  const own = frameOf(solid), mine = solid.map((t) => t.map((c) => into(own, c.p))), theirs = original.map((t) => t.map((c) => c.p));
  const ob = box(theirs.flat()), po = profile(theirs, ob.mn[0], ob.mx[0]);
  let best = null;
  for (const [name, turn] of [["as drawn", (p) => p], ["turned about x", (p) => [p[0], -p[1], -p[2]]], ["turned about y", (p) => [-p[0], p[1], -p[2]]], ["turned about z", (p) => [-p[0], -p[1], p[2]]]]) {
    const turned = mine.map((t) => t.map(turn)), o = overlay(turned.flat(), theirs.flat()), pn = profile(turned.map((t) => t.map(o.at)), ob.mn[0], ob.mx[0]);
    let sum = 0, bins = 0;
    po.forEach((a, i) => { const b = pn[i]; if (!isFinite(a[0]) || !isFinite(b[0])) return; bins++; for (let j = 0; j < 4; j++) sum += Math.abs(a[j] - b[j]) / 4; });
    const left = bins ? sum / bins : Infinity;
    if (!best || left < best.left) best = { left, name, k: o.k, at: (p) => o.at(turn(into(own, p))) };
  }
  return best;
}
/** The pieces of a mesh that do not touch one another. */
function pieces(tris) {
  const key = (p) => p.map((v) => v.toFixed(2)).join(), boss = new Map(), root = (k) => { while (boss.get(k) !== k) k = boss.get(k); return k; };
  for (const t of tris) for (const p of t) boss.set(key(p), key(p));
  for (const t of tris) for (const j of [1, 2]) boss.set(root(key(t[j])), root(key(t[0])));
  const all = new Map();
  for (const t of tris) { const k = root(key(t[0])); (all.get(k) ?? all.set(k, []).get(k)).push(t); }
  return [...all.values()];
}
/**
 * The line of the handle of a hafted weapon (an axe, a scythe), in the weapon's own axes:
 * the main axis of the longest, thinnest piece of its meshes (`groups`: its triangles, mesh by mesh). A head on one side pulls the
 * weapon's main axes off the handle, and the hand holds the handle. Null when no piece
 * of it looks like a handle.
 */
function haftLine(groups, length) {
  let best = null;
  for (const piece of groups.flatMap(pieces)) {
    const { X, Y, o } = mainAxes(samplesOf(piece.map((t) => t.map((p) => ({ p }))))), fr = { X, Y, Z: cross(X, Y), o }, b = box(piece.flat().map((p) => into(fr, p)));
    const long = b.mx[0] - b.mn[0], thick = Math.max(b.mx[1] - b.mn[1], b.mx[2] - b.mn[2], 1e-6);
    if (long < 0.3 * length || long / thick < 4) continue;
    if (!best || long / thick > best.score) best = { score: long / thick, X: X[0] < 0 ? X.map((v) => -v) : X, o: out(fr, [0, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2]) };
  }
  return best;
}
/**
 * A piece drawn with its handle on its own x axis, laid on the original's handle: same
 * length along it, and of the four ways of turning it round the one whose outline follows best.
 */
function onHaft(piece, original) {
  const theirs = original.map((t) => t.map((c) => c.p)), ob = box(theirs.flat()), byMesh = new Map();
  for (const t of original) (byMesh.get(t[0].mesh) ?? byMesh.set(t[0].mesh, []).get(t[0].mesh)).push(t.map((c) => c.p));
  const line = haftLine([...byMesh.values()], ob.mx[0] - ob.mn[0]);
  if (!line) return null;
  const norm = (v) => { const l = Math.hypot(...v); return v.map((t) => t / l); };
  const X = norm(line.X), Z = norm(sub([0, 0, 1], X.map((t) => t * X[2]))), Y = cross(Z, X), p0 = line.o;
  const along = theirs.flat().map((p) => dot(sub(p, p0), X)), s0 = Math.min(...along), s1 = Math.max(...along), po = profile(theirs, ob.mn[0], ob.mx[0]);
  let best = null;
  for (const [name, turn] of [["on its handle", (p) => p], ["on its handle, turned about x", (p) => [p[0], -p[1], -p[2]]], ["on its handle, turned about y", (p) => [-p[0], p[1], -p[2]]], ["on its handle, turned about z", (p) => [-p[0], -p[1], p[2]]]]) {
    const xs = piece.flatMap((t) => t.map((c) => turn(c.p)[0])), a = Math.min(...xs), k = (s1 - s0) / (Math.max(...xs) - a);
    const at = (p) => { const q = turn(p), s = s0 + (q[0] - a) * k; return [0, 1, 2].map((i) => p0[i] + X[i] * s + Y[i] * q[1] * k + Z[i] * q[2] * k); };
    const pn = profile(piece.map((t) => t.map((c) => at(c.p))), ob.mn[0], ob.mx[0]);
    let sum = 0, bins = 0;
    po.forEach((u, i) => { const v = pn[i]; if (!isFinite(u[0]) || !isFinite(v[0])) return; bins++; for (let j = 0; j < 4; j++) sum += Math.abs(u[j] - v[j]) / 4; });
    const left = bins ? sum / bins : Infinity;
    if (!best || left < best.left) best = { left, name, k, at };
  }
  return best;
}
export const straight = (piece, original) => overlay(uniq(piece), original.flat().map((c) => c.p));

// ── shields ────────────────────────────────────────────────────────────────
/**
 * A shield, measured for a new one to be made to it: its body and the straps on its back,
 * told apart as the pieces of the mesh that do not touch (the body is the largest).
 * Returns its frame (+x along its length towards the point, +z out of its face, the origin
 * in the middle of the body and on the plane of its back) and, in that frame, what a new
 * shield has to keep for the arm of this model to carry it the same: the body's length,
 * width and depth, and each strap's place `{ x0, x1, y, width, reach }` (`reach`: how far
 * it stands off the back).
 */
export function shieldFit(original) {
  const key = (p) => p.map((v) => v.toFixed(2)).join(), boss = new Map(), root = (k) => { while (boss.get(k) !== k) k = boss.get(k); return k; };
  for (const c of original.flat()) boss.set(key(c.p), key(c.p));
  for (const t of original) for (const j of [1, 2]) boss.set(root(key(t[j].p)), root(key(t[0].p)));
  const pieces = new Map();
  for (const t of original) { const k = root(key(t[0].p)); (pieces.get(k) ?? pieces.set(k, []).get(k)).push(t); }
  const [body, ...straps] = [...pieces.values()].sort((a, b) => b.length - a.length);
  if (!straps.length) throw new Error("a shield without straps");
  let { X, Y, o } = frameOf(body), Z = cross(X, Y);
  const centre = (tris) => { const b = box(uniq(tris)); return [0, 1, 2].map((a) => (b.mn[a] + b.mx[a]) / 2); };
  // the straps are on the back
  if (dot(sub(centre(straps.flat()), o), Z) > 0) Z = Z.map((v) => -v);
  // the point is the end where the body is narrow
  const along = uniq(body).map((p) => [dot(sub(p, o), X), dot(sub(p, o), Y)]), far = Math.max(...along.map((q) => Math.abs(q[0])));
  const widthAt = (s) => { const ys = along.filter((q) => q[0] * s > far * 0.8).map((q) => q[1]); return Math.max(...ys) - Math.min(...ys); };
  if (widthAt(-1) < widthAt(1)) X = X.map((v) => -v);
  Y = cross(Z, X);
  let frame = { X, Y, Z, o };
  const bb = box(uniq(body).map((p) => into(frame, p)));
  frame = { ...frame, o: out(frame, [(bb.mn[0] + bb.mx[0]) / 2, (bb.mn[1] + bb.mx[1]) / 2, bb.mn[2]]) };
  const p = {
    length: bb.mx[0] - bb.mn[0], width: bb.mx[1] - bb.mn[1], depth: bb.mx[2] - bb.mn[2],
    straps: straps.map((s) => { const b = box(uniq(s).map((q) => into(frame, q))); return { x0: b.mn[0], x1: b.mx[0], y: (b.mn[1] + b.mx[1]) / 2, width: b.mx[1] - b.mn[1], reach: -b.mn[2] }; }).sort((a, b) => a.y - b.y),
  };
  return { frame, p };
}
