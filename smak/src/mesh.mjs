// Triangles into what a studio model stores: shared points, normals of their own, and the bone each hangs from.
import { sub, dot, cross, unit } from "./vec.mjs";

/**
 * Triangles placed in a bone's space, as what replaceMesh takes. A corner is { p, uv } and,
 * for a piece on several bones, { bone, to } too: the bone it hangs from and the matrix
 * that takes it there from the space `p` is in. `original` is the mesh being replaced:
 * which way round the game's triangles go is read off it, its stored normals against its faces (null: FRONT).
 * `smooth`: faces that meet at a point at less than this many degrees share a normal there.
 */
/** Which way round a compiled model's triangles go: the sign of (b - a) x (c - a) against the normal that looks out of the surface. */
export const FRONT = -1;
export function meshOf(original, tris, tex, bone, smooth = 40) {
  const face = (t) => cross(sub(t[1].p, t[0].p), sub(t[2].p, t[0].p));
  // with no original to read it off (a model made from nothing): as the compiler leaves them, clockwise seen from outside
  const sign = original?.length ? Math.sign(original.reduce((a, t) => a + Math.sign(dot(face(t), t[0].n)), 0)) || 1 : FRONT;
  // the generators' triangles face outwards counter-clockwise
  if (sign < 0) tris = tris.map((t) => [t[0], t[2], t[1]]);

  // Normals: faces that meet at a point at less than 40 degrees share one (grips and shafts are round).
  const key = (p) => p.map((v) => v.toFixed(4)).join(), at = new Map();
  tris.forEach((t) => { const n = face(t).map((v) => v * sign); for (const c of t) { const e = at.get(key(c.p)) ?? []; e.push(n); at.set(key(c.p), e); } });
  const verts = [], vi = new Map(), norms = [], ni = new Map(), vertBones = [], normBones = [], cos = Math.cos(smooth * Math.PI / 180);
  const index = (list, bones, map, v, b) => { const k = b + ":" + key(v); if (!map.has(k)) { map.set(k, list.length); list.push(v); bones.push(b); } return map.get(k); };
  const corners = tris.map((t) => {
    const f = unit(face(t).map((v) => v * sign));
    return t.map((c) => {
      const n = unit(at.get(key(c.p)).filter((g) => dot(unit(g), f) > cos).reduce((a, g) => [a[0] + g[0], a[1] + g[1], a[2] + g[2]], [0, 0, 0]));
      const b = c.bone ?? bone, p = c.to ? c.to.map((r) => dot(r, c.p) + r[3]) : c.p, nn = c.to ? c.to.map((r) => dot(r, n)) : n;
      return [index(verts, vertBones, vi, p, b), index(norms, normBones, ni, nn, b), Math.round(c.uv[0] * tex.width), Math.round(c.uv[1] * tex.height)];
    });
  });
  return { bone, verts, norms, vertBones, normBones, tris: corners };
}
