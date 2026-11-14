// A small software renderer for checks: the engine's view of a posed model (back faces culled, nearest wins) with an item buffer, in
// SMAK's own cameras (the first person camera with the eye at the origin looking along +x, fov degrees across the picture; and an
// orbit camera without perspective). check-belt.mjs uses it to measure what shows in the picture; it shares no code with check-solid.mjs.
import { K } from "./common.mjs";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const FRONT = -1;   // the engine draws a triangle clockwise seen from outside: (b - a) x (c - a) looks inwards

/** Every triangle of one pose as { tris (the kit's, with `where`), pts: Float64Array(9 n), pose, n }. `opts` are K.posed's: { seq, frame, pose }. */
export function posedTriangles(mdl, opts = {}) {
  const P = K.posed(mdl, opts);
  const pts = new Float64Array(P.tris.length * 9);
  P.tris.forEach((t, i) => t.c.forEach((c, k) => { pts[i * 9 + k * 3] = c.p[0]; pts[i * 9 + k * 3 + 1] = c.p[1]; pts[i * 9 + k * 3 + 2] = c.p[2]; }));
  return { tris: P.tris, pts, pose: P.pose, n: P.tris.length };
}

/**
 * A camera. orbit: { yaw, pitch, mid, scale, w, h } looks from `mid` + (cos pitch cos yaw, cos pitch sin yaw, sin pitch) at `mid` with no
 * perspective (the kit's orbit view); first: { first: true, fov, w, h }, the eye at the origin looking along +x.
 */
export function cameraOf(o) {
  const w = o.w, h = o.h;
  if (o.first) return { first: true, w, h, right: [0, -1, 0], up: [0, 0, 1], forward: [1, 0, 0], eye: [0, 0, 0], scale: w / 2 / Math.tan((o.fov * Math.PI) / 360), near: o.near ?? 1 };
  const d = Math.PI / 180;
  const back = [Math.cos(o.pitch * d) * Math.cos(o.yaw * d), Math.cos(o.pitch * d) * Math.sin(o.yaw * d), Math.sin(o.pitch * d)];
  const forward = back.map((v) => -v);
  const right = unit(Math.abs(back[2]) > 0.999 ? [-Math.sin(o.yaw * d), Math.cos(o.yaw * d), 0] : cross(forward, [0, 0, 1]));
  return { first: false, w, h, right, up: cross(right, forward), forward, mid: o.mid, scale: o.scale };
}

/**
 * The nearest surface of the triangles that face the camera (`facing` 1: the ones the engine draws, -1: the ones it culls) at every
 * pixel's middle, as a depth buffer (distance along the view; Infinity where nothing is). With `ids` (an Int32Array of the picture's size)
 * the number of the nearest triangle is kept there (-1 for none). `only(i)` leaves triangles out.
 */
export function drawDepth(pts, n, cam, facing, ids = null, only = null) {
  const { w, h } = cam;
  const depth = new Float32Array(w * h).fill(Infinity);
  if (ids) ids.fill(-1);
  const poly = [];
  for (let i = 0; i < n; i++) {
    if (only && !only(i)) continue;
    const P = [0, 1, 2].map((k) => {
      const p = [pts[i * 9 + k * 3], pts[i * 9 + k * 3 + 1], pts[i * 9 + k * 3 + 2]];
      const d = cam.first ? sub(p, cam.eye) : sub(p, cam.mid);
      return [dot(d, cam.right), dot(d, cam.up), dot(d, cam.forward)];
    });
    const a = [pts[i * 9], pts[i * 9 + 1], pts[i * 9 + 2]], b = [pts[i * 9 + 3], pts[i * 9 + 4], pts[i * 9 + 5]], c = [pts[i * 9 + 6], pts[i * 9 + 7], pts[i * 9 + 8]];
    const nrm = cross(sub(b, a), sub(c, a)).map((v) => v * FRONT);
    if (Math.hypot(...nrm) < 1e-12) continue;
    const toEye = cam.first ? sub(cam.eye, a) : cam.forward.map((v) => -v);
    if ((dot(nrm, toEye) > 0 ? 1 : -1) !== facing) continue;
    poly.length = 0;
    if (cam.first) {
      // what is nearer than `near` is cut off, as the engine does
      for (let k = 0; k < 3; k++) {
        const p = P[k], q = P[(k + 1) % 3];
        if (p[2] >= cam.near) poly.push(p);
        if (p[2] >= cam.near !== q[2] >= cam.near) {
          const t = (cam.near - p[2]) / (q[2] - p[2]);
          poly.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, cam.near]);
        }
      }
      if (poly.length < 3) continue;
    } else poly.push(P[0], P[1], P[2]);
    const S = poly.map(([x, y, z]) => (cam.first ? { x: w / 2 + (x * cam.scale) / z, y: h / 2 - (y * cam.scale) / z, wv: 1 / z } : { x: w / 2 + x * cam.scale, y: h / 2 - y * cam.scale, wv: z }));
    for (let k = 1; k + 1 < S.length; k++) {
      const A = S[0], B = S[k], C = S[k + 1];
      const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x))), x1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
      const y0 = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y))), y1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const la = ((B.x - px) * (C.y - py) - (C.x - px) * (B.y - py)) / area;
          const lb = ((C.x - px) * (A.y - py) - (A.x - px) * (C.y - py)) / area;
          const lc = 1 - la - lb;
          if (la < -1e-9 || lb < -1e-9 || lc < -1e-9) continue;
          const v = la * A.wv + lb * B.wv + lc * C.wv;
          const z = cam.first ? 1 / v : v;
          const at = y * w + x;
          if (z < depth[at]) { depth[at] = z; if (ids) ids[at] = i; }
        }
    }
  }
  return depth;
}

/** The point of the model that pixel (x, y) of a camera shows at depth z. */
export function unproject(cam, x, y, z) {
  const sx = x + 0.5 - cam.w / 2, sy = cam.h / 2 - (y + 0.5);
  if (cam.first) return [0, 1, 2].map((k) => cam.eye[k] + cam.forward[k] * z + cam.right[k] * ((sx * z) / cam.scale) + cam.up[k] * ((sy * z) / cam.scale));
  return [0, 1, 2].map((k) => cam.mid[k] + cam.forward[k] * z + cam.right[k] * (sx / cam.scale) + cam.up[k] * (sy / cam.scale));
}

/** n directions spread evenly over the sphere (Fibonacci), as [yaw, pitch] in degrees. */
export function sphereViews(n) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) out.push([(((i * golden * 180) / Math.PI) % 360), (Math.asin(1 - (2 * (i + 0.5)) / n) * 180) / Math.PI]);
  return out;
}
