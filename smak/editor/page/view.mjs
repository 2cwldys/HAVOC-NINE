// The 3D picture: plain WebGL2, no library. The model's corners are moved to their bones in JavaScript (a view model
// is a few thousand of them) and drawn as smak's own renderer draws them, so the two pictures agree: the same camera
// for first person (the eye at the origin looking along +x; 90 degrees across a 4:3 picture, more across a wider one,
// as the game does), the same stand-in light, chrome by the normal, index 255 of a masked texture as a hole, an
// additive texture added over the rest.
const VS = `#version 300 es
in vec3 aP; in vec3 aN; in vec2 aUV;
uniform mat4 uP; uniform vec3 uRight, uUp, uLamp; uniform vec2 uSize; uniform float uChrome, uBright;
out vec2 vUV; out float vL;
void main() {
  vec3 n = normalize(aN);
  vL = mix(0.38 + 0.62 * (0.5 + 0.5 * dot(n, uLamp)), 1.0, uBright);
  vUV = mix(aUV, vec2((0.5 + 0.5 * dot(n, uRight)) * uSize.x, (0.5 - 0.5 * dot(n, uUp)) * uSize.y), uChrome) / uSize;
  gl_Position = uP * vec4(aP, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUV; in float vL; uniform sampler2D uT; uniform float uMask, uHas; uniform vec4 uTint; out vec4 o;
void main() {
  vec4 c = uHas > 0.5 ? texture(uT, vUV) : vec4(0.59, 0.59, 0.59, 1.0);
  if (uMask > 0.5 && c.a < 0.5) discard;
  o = uTint.a > 0.0 ? vec4(uTint.rgb * (0.6 + 0.4 * vL), uTint.a) : vec4(c.rgb * vL, 1.0);
}`;
const FLAG = { chrome: 2, fullbright: 4, additive: 32, masked: 64 };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

export function createView(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true });
  const sh = (type, text) => { const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
  const U = Object.fromEntries(["uP", "uRight", "uUp", "uLamp", "uSize", "uChrome", "uBright", "uT", "uMask", "uHas", "uTint"].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const A = Object.fromEntries(["aP", "aN", "aUV"].map((n) => [n, gl.getAttribLocation(prog, n)]));
  const V = { cam: { mode: "first", yaw: 30, pitch: 15, dist: 60, target: [12, 0, -4] }, meshes: [], textures: new Map(), linear: true, basis: null, width: 1, height: 1 };

  /** The shapes shown: [{ tex: { n, flags, width, height } or null, p, n, uv, bone }], corners in their bones' space. */
  V.setMeshes = (list) => {
    for (const m of V.meshes) { gl.deleteBuffer(m.bp); gl.deleteBuffer(m.bn); gl.deleteBuffer(m.buv); gl.deleteVertexArray(m.vao); }
    V.meshes = list.map((m) => {
      const count = m.bone.length, o = { ...m, count, src: Float32Array.from(m.p), srcN: Float32Array.from(m.n), P: new Float32Array(count * 3), N: new Float32Array(count * 3), G: new Float32Array(count * 3), GN: new Float32Array(count * 3), vao: gl.createVertexArray(), bp: gl.createBuffer(), bn: gl.createBuffer(), buv: gl.createBuffer() };
      gl.bindVertexArray(o.vao);
      for (const [buf, at, size, data] of [[o.bp, A.aP, 3, o.P], [o.bn, A.aN, 3, o.N], [o.buv, A.aUV, 2, Float32Array.from(m.uv)]]) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0); }
      return o;
    });
    gl.bindVertexArray(null);
  };
  /** A texture's picture (an Image that has loaded) for texture number `n`. Masked ones are never smoothed: their holes would fringe. */
  V.setTexture = (n, img, flags) => {
    const had = V.textures.get(n); if (had) gl.deleteTexture(had.t);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    V.textures.set(n, { t, flags });
  };
  const skin = (m, pose, P, N) => {
    const { src, srcN, bone } = m;
    for (let i = 0, o = 0; i < m.count; i++, o += 3) {
      const M = pose[bone[i]], x = src[o], y = src[o + 1], z = src[o + 2], a = srcN[o], b = srcN[o + 1], c = srcN[o + 2];
      P[o] = M[0] * x + M[1] * y + M[2] * z + M[3]; P[o + 1] = M[4] * x + M[5] * y + M[6] * z + M[7]; P[o + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
      N[o] = M[0] * a + M[1] * b + M[2] * c; N[o + 1] = M[4] * a + M[5] * b + M[6] * c; N[o + 2] = M[8] * a + M[9] * b + M[10] * c;
    }
  };
  /** The camera for the canvas as it is now: { right, up, fwd, eye, fx, fy, near, far, hfov }. */
  V.camera = () => {
    const aspect = V.width / V.height, c = V.cam;
    if (c.mode === "first") { const fy = aspect >= 4 / 3 ? 4 / 3 : aspect, fx = fy / aspect; return { right: [0, -1, 0], up: [0, 0, 1], fwd: [1, 0, 0], eye: [0, 0, 0], fx, fy, near: 1, far: 4096, hfov: 2 * Math.atan(1 / fx) * 180 / Math.PI }; }
    const r = Math.PI / 180, d = [Math.cos(c.pitch * r) * Math.cos(c.yaw * r), Math.cos(c.pitch * r) * Math.sin(c.yaw * r), Math.sin(c.pitch * r)], fwd = d.map((v) => -v);
    const right = unit(Math.abs(d[2]) > 0.999 ? [-Math.sin(c.yaw * r), Math.cos(c.yaw * r), 0] : cross(fwd, [0, 0, 1])), up = cross(right, fwd), fy = 1 / Math.tan(17.5 * r);
    return { right, up, fwd, eye: c.target.map((v, k) => v + d[k] * c.dist), fx: fy / aspect, fy, near: Math.max(0.5, c.dist / 50), far: c.dist * 20 + 2000, hfov: 0 };
  };
  /** A point of the model on the canvas, in CSS pixels: [x, y, depth], or null behind the eye. */
  V.project = (p) => {
    const b = V.basis, d = sub(p, b.eye), z = dot(d, b.fwd); if (z < b.near * 0.5) return null;
    return [(1 + dot(d, b.right) * b.fx / z) * V.cssW / 2, (1 - dot(d, b.up) * b.fy / z) * V.cssH / 2, z];
  };
  /** How many units of the model a CSS pixel is worth at a point. */
  V.unitsPerPixel = (p) => { const b = V.basis, z = Math.max(b.near, dot(sub(p, b.eye), b.fwd)); return 2 * z / (b.fx * V.cssW); };
  /** The ray under a point of the canvas (CSS pixels): { from, dir }. */
  V.ray = (x, y) => { const b = V.basis, nx = (2 * x / V.cssW - 1) / b.fx, ny = (1 - 2 * y / V.cssH) / b.fy; return { from: b.eye, dir: unit([0, 1, 2].map((k) => b.fwd[k] + b.right[k] * nx + b.up[k] * ny)) }; };
  /** The bone of the nearest corner of the triangle under a point of the canvas, or -1. */
  V.pick = (x, y) => {
    const { from, dir } = V.ray(x, y); let best = Infinity, bone = -1;
    for (const m of V.meshes) for (let i = 0; i < m.count; i += 3) {
      const P = m.P, a = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], e1 = [P[i * 3 + 3] - a[0], P[i * 3 + 4] - a[1], P[i * 3 + 5] - a[2]], e2 = [P[i * 3 + 6] - a[0], P[i * 3 + 7] - a[1], P[i * 3 + 8] - a[2]];
      const h = cross(dir, e2), det = dot(e1, h); if (Math.abs(det) < 1e-12) continue;
      const s = sub(from, a), u = dot(s, h) / det; if (u < 0 || u > 1) continue;
      const q = cross(s, e1), v = dot(dir, q) / det; if (v < 0 || u + v > 1) continue;
      const t = dot(e2, q) / det; if (t < V.basis.near * 0.5 || t >= best) continue;
      best = t; bone = m.bone[i + (u + v < 1 / 3 ? 0 : u > v ? 1 : 2)];
    }
    return bone;
  };
  /** Draws the model at a pose (12 numbers a bone), and before it, faintly, the `ghosts`: [{ pose, colour: [r, g, b, a] }]. */
  V.draw = (pose, ghosts = [], background = [58, 62, 70]) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    V.width = w; V.height = h; V.cssW = canvas.clientWidth || 1; V.cssH = canvas.clientHeight || 1;
    const b = V.basis = V.camera(), A1 = (b.far + b.near) / (b.far - b.near), B1 = -2 * b.far * b.near / (b.far - b.near), e = [dot(b.eye, b.right), dot(b.eye, b.up), dot(b.eye, b.fwd)];
    const rows = [[...b.right.map((v) => v * b.fx), -e[0] * b.fx], [...b.up.map((v) => v * b.fy), -e[1] * b.fy], [...b.fwd.map((v) => v * A1), -e[2] * A1 + B1], [...b.fwd, -e[2]]];
    gl.viewport(0, 0, w, h); gl.clearColor(background[0] / 255, background[1] / 255, background[2] / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog); gl.uniformMatrix4fv(U.uP, false, new Float32Array([0, 1, 2, 3].flatMap((c) => rows.map((r) => r[c]))));
    gl.uniform3fv(U.uRight, b.right); gl.uniform3fv(U.uUp, b.up); gl.uniform3fv(U.uLamp, unit([0, 1, 2].map((k) => -b.fwd[k] * 0.7 + b.up[k] * 0.6 - b.right[k] * 0.35)));
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.CULL_FACE); gl.frontFace(gl.CW); gl.cullFace(gl.BACK); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(U.uT, 0);
    const one = (m, P, N, tint) => {
      const tex = m.tex ? V.textures.get(m.tex.n) : null, flags = m.tex?.flags ?? 0;
      gl.bindVertexArray(m.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.bp); gl.bufferSubData(gl.ARRAY_BUFFER, 0, P); gl.bindBuffer(gl.ARRAY_BUFFER, m.bn); gl.bufferSubData(gl.ARRAY_BUFFER, 0, N);
      gl.uniform1f(U.uHas, tex ? 1 : 0); gl.uniform1f(U.uMask, flags & FLAG.masked ? 1 : 0); gl.uniform1f(U.uChrome, flags & FLAG.chrome && m.tex ? 1 : 0); gl.uniform1f(U.uBright, flags & (FLAG.fullbright | FLAG.additive) ? 1 : 0);
      gl.uniform2f(U.uSize, m.tex?.width ?? 1, m.tex?.height ?? 1); gl.uniform4fv(U.uTint, tint ?? [0, 0, 0, 0]);
      if (tex) { gl.bindTexture(gl.TEXTURE_2D, tex.t); const smooth = V.linear && !(flags & FLAG.masked); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, smooth ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST); }
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
    };
    const glow = (m) => (m.tex?.flags ?? 0) & FLAG.additive;
    for (const m of V.meshes) skin(m, pose, m.P, m.N);
    gl.disable(gl.BLEND); gl.depthMask(true);
    for (const m of V.meshes) if (!glow(m)) one(m, m.P, m.N);
    gl.enable(gl.BLEND); gl.depthMask(false);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (const m of V.meshes) if (glow(m)) one(m, m.P, m.N);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthFunc(gl.LESS);   // a ghost only where it is not the model itself
    for (const g of ghosts) for (const m of V.meshes) if (!glow(m)) { skin(m, g.pose, m.G, m.GN); one(m, m.G, m.GN, g.colour); }
    gl.depthMask(true); gl.disable(gl.BLEND); gl.bindVertexArray(null);
  };
  return V;
}
