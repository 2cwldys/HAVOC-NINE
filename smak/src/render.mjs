// A model drawn into a picture, with nothing but arithmetic: no browser, no GPU. This is how whoever works on a model
// (an agent above all) sees what it has made before the game does.
//
//   render(src, options)  one view              -> { width, height, rgba }
//   sheet(src, options)   six views, labelled   -> the same
//   strip(src, options)   an animation, frame by frame
//   uvMap(src, which)     a texture with every triangle that wears it drawn over it
//
// The light is a plain stand-in for the engine's: shapes, proportions, seams, textures and poses are true, the
// brightness is not. A model faces +x; +y is its left, +z is up. One unit is about an inch.
import { readMdl, readMesh, restPose, poseAt, poseBetween, sequences, sequenceAt, skinFamilies, bodyOf, apply34 } from "./mdl.mjs";
import { sub, dot, cross, unit } from "./vec.mjs";
import { FRONT } from "./mesh.mjs";

/** The flags of a texture that change how its mesh is drawn. */
export const TEXTURE = { flat: 1, chrome: 2, fullbright: 4, additive: 32, masked: 64 };

/**
 * The model's triangles as it is shown: { seq (a name or a number; null: the bones at rest), frame (may fall between two),
 * pose (matrices of its own, instead), body, skin }. Each triangle: { tex, c: [{ p, n, u, v }] } in model space, u and v in pixels.
 */
export function posed(src, { seq = 0, frame = 0, pose, body = 0, skin = 0 } = {}) {
  const info = readMdl(src), seqs = sequences(src), q = seq === null ? -1 : sequenceAt(src, seq);
  if (seq !== null && q < 0 && seqs.length) throw new Error(`no animation ${seq}: it has ${seqs.map((s) => s.name).join(", ")}`);
  const P = pose ?? (q >= 0 && !seqs[q].group ? (Number.isInteger(frame) ? poseAt(src, q, Math.max(0, Math.min(frame, seqs[q].frames - 1))) : poseBetween(src, q, frame, seqs[q].loops)) : restPose(src));
  const fams = skinFamilies(src), fam = fams[skin] ?? fams[0] ?? [], pick = bodyOf(src, body), tris = [];
  info.bodyparts.forEach((bp, i) => {
    const m = bp.models[pick[i]]; if (!m) return;
    for (const x of m.meshes) {
      if (!x.numtris) continue;
      const tex = info.textures[fam[x.skinref]] ?? x.texture ?? null;
      for (const t of readMesh(src, m, x)) tris.push({ tex, c: t.map((c) => ({ p: apply34(P[c.bone], c.p), n: P[c.bone].map((r) => r[0] * c.n[0] + r[1] * c.n[1] + r[2] * c.n[2]), u: c.s, v: c.t })) });
    }
  });
  return { info, tris, pose: P };
}

/** The middle and the reach of the model over several poses ([options as posed takes them]): what `within` takes, so that they are all drawn to one scale. */
export function framing(src, list) {
  const points = list.flatMap((o) => posed(src, o).tris.flatMap((t) => t.c.map((c) => c.p)));
  if (!points.length) return { mid: [0, 0, 0], far: 1 };
  const mn = [0, 1, 2].map((a) => points.reduce((v, p) => Math.min(v, p[a]), Infinity)), mx = [0, 1, 2].map((a) => points.reduce((v, p) => Math.max(v, p[a]), -Infinity)), mid = mn.map((v, a) => (v + mx[a]) / 2);
  return { mid, far: points.reduce((v, p) => Math.max(v, Math.hypot(...sub(p, mid))), 1e-6) };
}
/**
 * One view of the model.
 *   view        "orbit" (from outside, no perspective: sizes can be compared) or "first" (as the player sees a view model:
 *               the eye at the model's origin looking along +x, `fov` degrees across)
 *   yaw, pitch  orbit: where the camera stands, in degrees. yaw 0 looks at the model's front, 90 at its left side,
 *               180 at its back; pitch 90 looks straight down on it
 *   zoom, target  orbit: closer or farther (1 fits the model), and the point looked at (the middle of the model unless told)
 *   within      orbit: { mid, far } to frame the picture by instead of this pose's own size (see framing): several pictures to one scale
 *   width, height, background [r, g, b], light (false: the texture as it is), cull (false: both sides of every triangle)
 *   seq, frame, pose, body, skin   as in posed
 * A triangle seen from behind is not drawn, as in the game: a hole in the picture is a triangle the wrong way round.
 */
export function render(src, opts = {}) {
  const first = opts.view === "first", { width = first ? 640 : 512, height = first ? 480 : 512, yaw = 30, pitch = 15, fov = 90, zoom = 1, background = [58, 62, 70], light = true, cull = true } = opts;
  const { tris } = posed(src, opts), SS = 2, W = width * SS, Hh = height * SS, colour = new Float32Array(W * Hh * 3), depth = new Float32Array(W * Hh).fill(Infinity);
  for (let i = 0; i < W * Hh; i++) colour.set(background, i * 3);

  // the camera: `right`, `up` and `fwd` in model space, and where it stands (`eye`) or what it looks at (`mid`)
  const rad = Math.PI / 180, points = tris.flatMap((t) => t.c.map((c) => c.p));
  let right, up, fwd, eye = [0, 0, 0], mid = [0, 0, 0], scale = 1;
  if (first) { right = [0, -1, 0]; up = [0, 0, 1]; fwd = [1, 0, 0]; scale = W / 2 / Math.tan(fov * rad / 2); } else {
    const d = [Math.cos(pitch * rad) * Math.cos(yaw * rad), Math.cos(pitch * rad) * Math.sin(yaw * rad), Math.sin(pitch * rad)];
    fwd = d.map((v) => -v); right = unit(Math.abs(d[2]) > 0.999 ? [-Math.sin(yaw * rad), Math.cos(yaw * rad), 0] : cross(fwd, [0, 0, 1])); up = cross(right, fwd);
    if (points.length) { const mn = [0, 1, 2].map((a) => points.reduce((v, p) => Math.min(v, p[a]), Infinity)), mx = [0, 1, 2].map((a) => points.reduce((v, p) => Math.max(v, p[a]), -Infinity)); mid = mn.map((v, a) => (v + mx[a]) / 2); }
    let far = points.reduce((v, p) => Math.max(v, Math.hypot(...sub(p, mid))), 1e-6);
    if (opts.within) { mid = opts.within.mid; far = opts.within.far; }
    if (opts.target) mid = opts.target;
    scale = Math.min(W, Hh) * 0.46 / far * zoom;
  }
  const cam = (p) => { const d = sub(p, first ? eye : mid); return [dot(d, right), dot(d, up), dot(d, fwd)]; };
  const lamp = unit([0, 1, 2].map((a) => -fwd[a] * 0.7 + up[a] * 0.6 - right[a] * 0.35));

  const pictures = new Map(), pictureOf = (t) => { if (!pictures.has(t)) { const n = t.width * t.height; pictures.set(t, { pixels: src.subarray(t.index, t.index + n), palette: src.subarray(t.index + n, t.index + n + 768) }); } return pictures.get(t); };
  const NEAR = 1;
  const draw = (t, added) => {
    const tex = t.tex, flags = tex?.flags ?? 0, pic = tex ? pictureOf(tex) : null;
    // seen from behind?
    if (cull) { const n = cross(sub(t.c[1].p, t.c[0].p), sub(t.c[2].p, t.c[0].p)).map((v) => v * FRONT), to = first ? sub(eye, t.c[0].p) : fwd.map((v) => -v); if (dot(n, to) <= 0) return; }
    let poly = t.c.map((c) => {
      const [x, y, z] = cam(c.p), l = !light || flags & (TEXTURE.fullbright | TEXTURE.additive) ? 1 : 0.38 + 0.62 * (0.5 + 0.5 * dot(unit(c.n), lamp));
      const [u, v] = flags & TEXTURE.chrome && tex ? [(0.5 + 0.5 * dot(c.n, right)) * tex.width, (0.5 - 0.5 * dot(c.n, up)) * tex.height] : [c.u, c.v];
      return [x, y, z, u, v, l];
    });
    if (first) {
      // what is behind the eye is cut off at a plane just in front of it
      const cut = [];
      poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length]; if (a[2] >= NEAR) cut.push(a); if ((a[2] >= NEAR) !== (b[2] >= NEAR)) { const k = (NEAR - a[2]) / (b[2] - a[2]); cut.push(a.map((v, j) => v + (b[j] - v) * k)); } });
      poly = cut; if (poly.length < 3) return;
    }
    const s = poly.map(([x, y, z, u, v, l]) => { const w = first ? 1 / z : 1; return { x: W / 2 + x * scale * w, y: Hh / 2 - y * scale * w, z, w, u: u * w, v: v * w, l: l * w }; });
    for (let i = 1; i + 1 < s.length; i++) {
      const a = s[0], b = s[i], c = s[i + 1], area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x))), y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), y1 = Math.min(Hh - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5, wa = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / area, wb = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area, wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const w = wa * a.w + wb * b.w + wc * c.w, z = first ? 1 / w : wa * a.z + wb * b.z + wc * c.z, i2 = y * W + x;
        if (z >= depth[i2]) continue;
        let rgb = [150, 150, 150];
        if (pic) {
          const u = Math.floor((wa * a.u + wb * b.u + wc * c.u) / w), v = Math.floor((wa * a.v + wb * b.v + wc * c.v) / w);
          const p = pic.pixels[((v % tex.height + tex.height) % tex.height) * tex.width + (u % tex.width + tex.width) % tex.width];
          if (flags & TEXTURE.masked && p === 255) continue;
          rgb = [pic.palette[p * 3], pic.palette[p * 3 + 1], pic.palette[p * 3 + 2]];
        }
        const l = (wa * a.l + wb * b.l + wc * c.l) / w;
        if (added) for (let k = 0; k < 3; k++) colour[i2 * 3 + k] += rgb[k];
        else { depth[i2] = z; for (let k = 0; k < 3; k++) colour[i2 * 3 + k] = rgb[k] * l; }
      }
    }
  };
  // what is drawn additively (a glow) is added over the rest, and hides nothing
  for (const t of tris) if (!((t.tex?.flags ?? 0) & TEXTURE.additive)) draw(t, false);
  for (const t of tris) if ((t.tex?.flags ?? 0) & TEXTURE.additive) draw(t, true);

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    for (let k = 0; k < 3; k++) { let a = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) a += Math.min(255, colour[((y * SS + j) * W + x * SS + i) * 3 + k]); rgba[o + k] = Math.round(a / (SS * SS)); }
    rgba[o + 3] = 255;
  }
  return { width, height, rgba };
}

// ── several pictures in one, with their names ──────────────────────────────
// Letters of 3 by 5 dots, a row to three bits, the top row first.
const GLYPHS = {
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7], "3": [7, 1, 7, 1, 7], "4": [5, 5, 7, 1, 1], "5": [7, 4, 7, 1, 7], "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 1, 1], "8": [7, 5, 7, 5, 7], "9": [7, 5, 7, 1, 7],
  A: [7, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [7, 4, 4, 4, 7], D: [6, 5, 5, 5, 6], E: [7, 4, 7, 4, 7], F: [7, 4, 7, 4, 4], G: [7, 4, 5, 5, 7], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 7], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5],
  N: [6, 5, 5, 5, 5], O: [7, 5, 5, 5, 7], P: [7, 5, 7, 4, 4], Q: [7, 5, 5, 7, 1], R: [7, 5, 6, 5, 5], S: [7, 4, 7, 1, 7], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5], Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  "-": [0, 0, 7, 0, 0], ".": [0, 0, 0, 0, 2], _: [0, 0, 0, 0, 7], ":": [0, 2, 0, 2, 0], "/": [1, 1, 2, 4, 4], "=": [0, 7, 0, 7, 0], "+": [0, 2, 7, 2, 0], "(": [1, 2, 2, 2, 1], ")": [4, 2, 2, 2, 4], ",": [0, 0, 0, 2, 4],
};
/** Writes `text` into a picture at (x, y), each dot `k` pixels, light on a dark band. */
export function label(img, text, x, y, k = 2, colour = [235, 235, 235]) {
  const s = String(text).toUpperCase(), put = (px, py, c) => { if (px >= 0 && py >= 0 && px < img.width && py < img.height) img.rgba.set([...c, 255], (py * img.width + px) * 4); };
  for (let j = -k; j < 6 * k; j++) for (let i = -k; i < s.length * 4 * k; i++) put(x + i, y + j, [20, 22, 26]);
  [...s].forEach((ch, n) => (GLYPHS[ch] ?? [0, 0, 0, 0, 0]).forEach((row, r) => { for (let b = 0; b < 3; b++) if (row & (4 >> b)) for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) put(x + (n * 4 + b) * k + i, y + r * k + j, colour); }));
  return img;
}
/** Pictures of one size side by side, `cols` to a row, each with its name in its corner. */
export function tile(images, cols, names = []) {
  const w = images[0].width, h = images[0].height, rows = Math.ceil(images.length / cols), out = { width: w * cols, height: h * rows, rgba: new Uint8Array(w * cols * h * rows * 4).fill(255) };
  for (let i = 0; i < out.width * out.height; i++) out.rgba.set([20, 22, 26, 255], i * 4);
  images.forEach((img, n) => {
    const ox = (n % cols) * w, oy = Math.floor(n / cols) * h;
    for (let y = 0; y < h; y++) out.rgba.set(img.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * out.width + ox) * 4);
    if (names[n] !== undefined) label(out, names[n], ox + 6, oy + 6);
  });
  return out;
}
/**
 * Several models side by side to one scale, each from the same sides, named: for before and after.
 * `list`: [[name, model], ...]; the first sets the scale. { yaws ([20, 200]), pitch, zoom, width, height, cols, target, seq, frame, body, skin }.
 */
export function lineup(list, { yaws = [20, 200], pitch = 6, zoom = 1.25, width = 300, height = 520, cols = null, target, ...pose } = {}) {
  const within = framing(list[0][1], [pose]), shots = [], names = [];
  for (const [name, mdl] of list) yaws.forEach((yaw, i) => { shots.push(render(mdl, { ...pose, yaw, pitch, width, height, zoom, within, target })); names.push(i ? "" : name); });
  return tile(shots, cols ?? Math.min(shots.length, yaws.length * 4), names);
}
/** Six views of the model in one picture: front, left side, back, right side, from above, and three quarters. */
export function sheet(src, opts = {}) {
  const views = [["front", 0, 0], ["left side", 90, 0], ["back", 180, 0], ["right side", 270, 0], ["top", 0, 90], ["three quarter", 35, 20]], size = opts.size ?? 384;
  const within = framing(src, [opts]);
  return tile(views.map(([, yaw, pitch]) => render(src, { ...opts, view: "orbit", within, yaw, pitch, width: size, height: size })), 3, views.map((v) => v[0]));
}
/**
 * An animation in one picture: `count` moments of it from its first frame to its last (every frame, when it has no more
 * than that), each with its frame's number. { seq, count (12), cols (4), from, to, view, ... as render }.
 */
export function strip(src, opts = {}) {
  const q = sequenceAt(src, opts.seq ?? 0), s = sequences(src)[q]; if (!s) throw new Error(`no animation ${opts.seq}`);
  const from = opts.from ?? 0, to = opts.to ?? s.frames - 1, count = Math.max(1, Math.min(opts.count ?? 12, to - from + 1)), first = opts.view === "first";
  const frames = Array.from({ length: count }, (_, i) => Math.round(from + (count > 1 ? i * (to - from) / (count - 1) : 0)));
  const size = { width: opts.width ?? (first ? 400 : 320), height: opts.height ?? (first ? 300 : 320) };
  const within = first ? undefined : framing(src, frames.map((frame) => ({ ...opts, seq: q, frame })));
  return tile(frames.map((frame) => render(src, { ...opts, ...size, within, seq: q, frame })), opts.cols ?? Math.min(4, count), frames.map((f) => `${s.name} ${f}/${s.frames - 1}`));
}

/**
 * One of the model's textures, enlarged, with every triangle that wears it drawn over it: where each part of the shape
 * takes its colour from. `which`: the texture's number or name. Returns the picture and `scale` (pixels a texture pixel).
 */
export function uvMap(src, which, { scale } = {}) {
  const info = readMdl(src), t = typeof which === "number" ? info.textures[which] : info.textures.find((x) => x.name.toLowerCase() === String(which).toLowerCase());
  if (!t) throw new Error(`no texture ${which}`);
  const k = scale ?? Math.max(1, Math.min(8, Math.floor(1024 / Math.max(t.width, t.height)))), W = t.width * k, Hh = t.height * k, rgba = new Uint8Array(W * Hh * 4), n = t.width * t.height;
  const pixels = src.subarray(t.index, t.index + n), palette = src.subarray(t.index + n, t.index + n + 768);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const p = pixels[Math.floor(y / k) * t.width + Math.floor(x / k)]; rgba.set([palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2], 255], (y * W + x) * 4); }
  const line = (a, b, c) => { const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])))); for (let i = 0; i <= steps; i++) { const x = Math.round(a[0] + (b[0] - a[0]) * i / steps), y = Math.round(a[1] + (b[1] - a[1]) * i / steps); if (x >= 0 && y >= 0 && x < W && y < Hh) rgba.set(c, (y * W + x) * 4); } };
  const inks = [[255, 230, 40, 255], [60, 230, 255, 255], [255, 110, 220, 255], [130, 255, 110, 255]]; let meshes = 0, count = 0;
  for (const bp of info.bodyparts) for (const m of bp.models) for (const x of m.meshes) {
    if (x.texture !== t || !x.numtris) continue;
    const ink = inks[meshes++ % inks.length];
    for (const tri of readMesh(src, m, x)) { count++; const q = tri.map((c) => [c.s * k, c.t * k]); line(q[0], q[1], ink); line(q[1], q[2], ink); line(q[2], q[0], ink); }
  }
  return { width: W, height: Hh, rgba, scale: k, meshes, triangles: count, texture: t };
}
