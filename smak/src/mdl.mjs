// GoldSrc studio models (.mdl, version 10) read and written directly, with no decompiler and no studiomdl.
//
// A change to a file is made by appending: new vertices, normals, triangles, textures, animations or tables go at the
// end and the file's own tables are pointed at them. Everything else (bones, the other submodels, what was not asked
// to change) is left byte for byte as it was. Every function that changes a model takes a Buffer and returns a new one.
//
//   reading     readMdl readMesh textureOf skinFamilies bodyOf bones boneParents sequences readSequence frameValues
//               events attachments hitboxes drawnCorners
//   posing      restPose poseAt poseBetween poseOf boneMatrices            (matrices: 3 rows of 4, bone space -> model space)
//   meshes      replaceMesh addMesh addModel emptyMesh filterMesh
//   pictures    retexture replaceTexture withTextures
//   animations  replaceSequence addSequence setEvents addBones
//   whole       writeMdl

const str = (b, o, n) => { const e = b.indexOf(0, o); return b.toString("latin1", o, e < 0 || e > o + n ? o + n : e); };
const i32 = (b, o) => b.readInt32LE(o);

// Header offsets (studiohdr_t)
const H = { length: 72, numbones: 140, boneindex: 144, numtextures: 180, textureindex: 184, numskinref: 192, numskinfamilies: 196, skinindex: 200, numbodyparts: 204, bodypartindex: 208 };
// mstudiomodel_t offsets
const M = { nummesh: 72, meshindex: 76, numverts: 80, vertinfoindex: 84, vertindex: 88, numnorms: 92, norminfoindex: 96, normindex: 100 };

/** The triangle commands of a mesh, as triangles of corners [vertex, normal, s, t]. */
function readTris(b, o) {
  const tris = [];
  for (;;) {
    let n = b.readInt16LE(o); o += 2;
    if (!n) break;
    const fan = n < 0; n = Math.abs(n);
    const c = []; for (let i = 0; i < n; i++, o += 8) c.push([b.readInt16LE(o), b.readInt16LE(o + 2), b.readInt16LE(o + 4), b.readInt16LE(o + 6)]);
    for (let i = 2; i < n; i++) tris.push(fan ? [c[0], c[i - 1], c[i]] : i % 2 ? [c[i - 1], c[i - 2], c[i]] : [c[i - 2], c[i - 1], c[i]]);
  }
  return { tris, end: o };
}

export function readMdl(b) {
  if (b.toString("latin1", 0, 4) !== "IDST" || i32(b, 4) !== 10) throw new Error("not a studio model, version 10");
  const bones = []; for (let i = 0; i < i32(b, H.numbones); i++) bones.push(str(b, i32(b, H.boneindex) + i * 112, 32));
  const textures = []; for (let i = 0; i < i32(b, H.numtextures); i++) { const o = i32(b, H.textureindex) + i * 80; textures.push({ name: str(b, o, 64), flags: i32(b, o + 64), width: i32(b, o + 68), height: i32(b, o + 72), index: i32(b, o + 76) }); }
  const bodyparts = [];
  for (let i = 0; i < i32(b, H.numbodyparts); i++) {
    const o = i32(b, H.bodypartindex) + i * 76, models = [];
    for (let j = 0; j < i32(b, o + 64); j++) {
      const m = i32(b, o + 72) + j * 112, meshes = [];
      for (let k = 0; k < i32(b, m + M.nummesh); k++) {
        const q = i32(b, m + M.meshindex) + k * 20;
        meshes.push({ at: q, numtris: i32(b, q), triindex: i32(b, q + 4), skinref: i32(b, q + 8), numnorms: i32(b, q + 12), texture: textures[b.readInt16LE(i32(b, H.skinindex) + i32(b, q + 8) * 2)] });
      }
      models.push({ at: m, name: str(b, m, 64), numverts: i32(b, m + M.numverts), numnorms: i32(b, m + M.numnorms), meshes });
    }
    bodyparts.push({ name: str(b, o, 64), base: i32(b, o + 68), models });
  }
  return { bones, textures, bodyparts };
}

/** One mesh, read out: its triangles with positions and normals in the space of each vertex's bone. */
export function readMesh(b, model, mesh) {
  const vi = i32(b, model.at + M.vertinfoindex), v = i32(b, model.at + M.vertindex), n = i32(b, model.at + M.normindex);
  const vec = (o, i) => [b.readFloatLE(o + i * 12), b.readFloatLE(o + i * 12 + 4), b.readFloatLE(o + i * 12 + 8)];
  return readTris(b, mesh.triindex).tris.map((t) => t.map(([iv, inn, s, tt]) => ({ p: vec(v, iv), n: vec(n, inn), bone: b[vi + iv], s, t: tt })));
}

/**
 * Returns a copy of the file with one mesh replaced.
 *   where:   { bodypart, model, mesh } (indices)
 *   mesh:    { bone, verts: [[x,y,z]], norms: [[x,y,z]], tris: [[[vert, norm, s, t] x3]] }, in the bone's space;
 *            vertBones and normBones (one bone each) when the piece hangs from more than one
 *   texture: { name, width, height, pixels (Uint8Array, one palette index each), palette (768 bytes), flags (the engine's; 32 draws it additively) }
 */
export function replaceMesh(src, where, mesh, texture) {
  const parts = [Buffer.from(src)]; let size = src.length;
  const head = parts[0];
  const add = (buf) => { const pad = (4 - size % 4) % 4; if (pad) { parts.push(Buffer.alloc(pad)); size += pad; } const at = size; parts.push(buf); size += buf.length; return at; };
  const info = readMdl(src), model = info.bodyparts[where.bodypart].models[where.model], old = model.meshes[where.mesh];
  const m = model.at;

  // The texture: a longer texture table and a longer skin table, both at the end of the file.
  // A texture of that name already there (an earlier call on the same file) is used as it is.
  const nt = info.textures.length, refs = i32(src, H.numskinref), fams = i32(src, H.numskinfamilies);
  let ref = info.textures.findIndex((t) => t.name === texture.name);
  if (ref >= 0) { const t = ref; ref = -1; for (let r = 0; r < refs; r++) if (src.readInt16LE(i32(src, H.skinindex) + r * 2) === t) ref = r; }
  if (ref < 0) {
    const entry = Buffer.alloc(80);
    entry.write(texture.name, 0, 63, "latin1"); entry.writeInt32LE(texture.flags ?? 0, 64); entry.writeInt32LE(texture.width, 68); entry.writeInt32LE(texture.height, 72);
    entry.writeInt32LE(add(Buffer.concat([Buffer.from(texture.pixels), Buffer.from(texture.palette)])), 76);
    head.writeInt32LE(add(Buffer.concat([src.subarray(i32(src, H.textureindex), i32(src, H.textureindex) + nt * 80), entry])), H.textureindex);
    head.writeInt32LE(nt + 1, H.numtextures);
    const skins = Buffer.alloc(fams * (refs + 1) * 2);
    for (let f = 0; f < fams; f++) { src.copy(skins, f * (refs + 1) * 2, i32(src, H.skinindex) + f * refs * 2, i32(src, H.skinindex) + (f + 1) * refs * 2); skins.writeInt16LE(nt, (f * (refs + 1) + refs) * 2); }
    head.writeInt32LE(add(skins), H.skinindex); head.writeInt32LE(refs + 1, H.numskinref);
    ref = refs;
  }

  // Vertices: the old ones stay (the other meshes use them), the new ones follow.
  const nv = model.numverts, floats = (list) => { const o = Buffer.alloc(list.length * 12); list.forEach((p, i) => { o.writeFloatLE(p[0], i * 12); o.writeFloatLE(p[1], i * 12 + 4); o.writeFloatLE(p[2], i * 12 + 8); }); return o; };
  const ofs = (k) => i32(src, m + k);
  head.writeInt32LE(add(Buffer.concat([src.subarray(ofs(M.vertinfoindex), ofs(M.vertinfoindex) + nv), Buffer.from(mesh.vertBones ?? new Array(mesh.verts.length).fill(mesh.bone))])), m + M.vertinfoindex);
  head.writeInt32LE(add(Buffer.concat([src.subarray(ofs(M.vertindex), ofs(M.vertindex) + nv * 12), floats(mesh.verts)])), m + M.vertindex);
  head.writeInt32LE(nv + mesh.verts.length, m + M.numverts);

  // Normals are lit mesh by mesh, in order, so each mesh's block has to stay where its turn comes.
  const before = model.meshes.slice(0, where.mesh).reduce((a, x) => a + x.numnorms, 0), after = model.numnorms - before - old.numnorms;
  const cut = (index, per) => [src.subarray(ofs(index), ofs(index) + before * per), src.subarray(ofs(index) + (before + old.numnorms) * per, ofs(index) + model.numnorms * per)];
  const [ia, ib] = cut(M.norminfoindex, 1), [na, nb] = cut(M.normindex, 12);
  head.writeInt32LE(add(Buffer.concat([ia, Buffer.from(mesh.normBones ?? new Array(mesh.norms.length).fill(mesh.bone)), ib])), m + M.norminfoindex);
  head.writeInt32LE(add(Buffer.concat([na, floats(mesh.norms), nb])), m + M.normindex);
  head.writeInt32LE(before + mesh.norms.length + after, m + M.numnorms);
  const shift = mesh.norms.length - old.numnorms;
  if (shift) for (const later of model.meshes.slice(where.mesh + 1)) {
    const end = readTris(src, later.triindex).end, cmds = Buffer.from(src.subarray(later.triindex, end));
    for (let o = 0; ;) { const n = Math.abs(cmds.readInt16LE(o)); o += 2; if (!n) break; for (let i = 0; i < n; i++, o += 8) cmds.writeInt16LE(cmds.readInt16LE(o + 2) + shift, o + 2); }
    head.writeInt32LE(add(cmds), later.at + 4);
  }

  // Triangles, each as a strip of three.
  const cmds = Buffer.alloc(mesh.tris.length * 26 + 2);
  mesh.tris.forEach((t, i) => { cmds.writeInt16LE(3, i * 26); t.forEach(([v, n, s, tt], c) => { const o = i * 26 + 2 + c * 8; cmds.writeInt16LE(nv + v, o); cmds.writeInt16LE(before + n, o + 2); cmds.writeInt16LE(s, o + 4); cmds.writeInt16LE(tt, o + 6); }); });
  head.writeInt32LE(mesh.tris.length, old.at); head.writeInt32LE(add(cmds), old.at + 4);
  head.writeInt32LE(ref, old.at + 8); head.writeInt32LE(mesh.norms.length, old.at + 12);

  head.writeInt32LE(size, H.length);
  return Buffer.concat(parts);
}

/**
 * Returns a copy of the file with one mesh wearing another texture: its points, normals and
 * triangles stay. `uvOf(triangle, corner)`, when given, says where a corner is in the new
 * picture ([u, v], 0..1); otherwise each corner keeps its place, scaled to the new size.
 */
export function retexture(src, where, texture, uvOf) {
  const parts = [Buffer.from(src)]; let size = src.length;
  const head = parts[0], add = (buf) => { const pad = (4 - size % 4) % 4; if (pad) { parts.push(Buffer.alloc(pad)); size += pad; } const at = size; parts.push(buf); size += buf.length; return at; };
  const info = readMdl(src), mesh = info.bodyparts[where.bodypart].models[where.model].meshes[where.mesh], old = mesh.texture;
  const nt = info.textures.length, refs = i32(src, H.numskinref), fams = i32(src, H.numskinfamilies);
  const entry = Buffer.alloc(80);
  entry.write(texture.name, 0, 63, "latin1"); entry.writeInt32LE(texture.flags ?? 0, 64); entry.writeInt32LE(texture.width, 68); entry.writeInt32LE(texture.height, 72);
  entry.writeInt32LE(add(Buffer.concat([Buffer.from(texture.pixels), Buffer.from(texture.palette)])), 76);
  head.writeInt32LE(add(Buffer.concat([src.subarray(i32(src, H.textureindex), i32(src, H.textureindex) + nt * 80), entry])), H.textureindex);
  head.writeInt32LE(nt + 1, H.numtextures);
  const skins = Buffer.alloc(fams * (refs + 1) * 2);
  for (let f = 0; f < fams; f++) { src.copy(skins, f * (refs + 1) * 2, i32(src, H.skinindex) + f * refs * 2, i32(src, H.skinindex) + (f + 1) * refs * 2); skins.writeInt16LE(nt, (f * (refs + 1) + refs) * 2); }
  head.writeInt32LE(add(skins), H.skinindex); head.writeInt32LE(refs + 1, H.numskinref);
  const tris = readTris(src, mesh.triindex).tris, cmds = Buffer.alloc(tris.length * 26 + 2);
  tris.forEach((t, i) => { cmds.writeInt16LE(3, i * 26); t.forEach(([v, n, s, tt], c) => {
    const o = i * 26 + 2 + c * 8, uv = uvOf ? uvOf(i, c) : [s / old.width, tt / old.height];
    cmds.writeInt16LE(v, o); cmds.writeInt16LE(n, o + 2); cmds.writeInt16LE(Math.round(uv[0] * texture.width), o + 4); cmds.writeInt16LE(Math.round(uv[1] * texture.height), o + 6);
  }); });
  head.writeInt32LE(tris.length, mesh.at); head.writeInt32LE(add(cmds), mesh.at + 4); head.writeInt32LE(refs, mesh.at + 8);
  head.writeInt32LE(size, H.length);
  return Buffer.concat(parts);
}

/**
 * Returns a copy of the file with one more mesh in a submodel, empty, after the ones it has: for a part
 * that needs a texture of its own (a glow) where the original had a single mesh. `where`: { bodypart, model }.
 * replaceMesh fills it.
 */
export function addMesh(src, where) {
  const model = readMdl(src).bodyparts[where.bodypart].models[where.model], n = model.meshes.length, old = i32(src, model.at + M.meshindex);
  const pad = (4 - src.length % 4) % 4, table = Buffer.alloc(n * 20 + 20 + 4), at = src.length + pad;
  src.copy(table, 0, old, old + n * 20);
  table.writeInt32LE(at + n * 20 + 20, n * 20 + 4); // no triangles: its commands are the two zero bytes after the table
  const out = Buffer.concat([src, Buffer.alloc(pad), table]);
  out.writeInt32LE(n + 1, model.at + M.nummesh); out.writeInt32LE(at, model.at + M.meshindex); out.writeInt32LE(out.length, H.length);
  return out;
}

/**
 * Returns a copy of the file with one more submodel in a bodypart, after the ones it has, holding one
 * empty mesh: replaceMesh fills it. Its number is the old count. The bodypart's table of submodels is
 * written again at the end of the file; the old one stays where it was, unused.
 */
export function addModel(src, bodypart, name) {
  const bp = i32(src, H.bodypartindex) + bodypart * 76, n = i32(src, bp + 64), old = i32(src, bp + 72);
  const pad = (4 - src.length % 4) % 4, at = src.length + pad, table = Buffer.alloc((n + 1) * 112 + 20 + 4);
  src.copy(table, 0, old, old + n * 112);
  const e = n * 112, mesh = (n + 1) * 112;
  table.write(name, e, 63, "latin1"); table.writeFloatLE(64, e + 68); table.writeInt32LE(1, e + M.nummesh); table.writeInt32LE(at + mesh, e + M.meshindex);
  table.writeInt32LE(at + mesh + 20, mesh + 4); // no triangles yet: its commands are the zero after the mesh
  const out = Buffer.concat([src, Buffer.alloc(pad), table]);
  out.writeInt32LE(n + 1, bp + 64); out.writeInt32LE(at, bp + 72); out.writeInt32LE(out.length, H.length);
  return out;
}

/** Returns a copy of the file with one mesh left without triangles (its normals stay, so the others keep their turn). */
export function emptyMesh(src, where) {
  const mesh = readMdl(src).bodyparts[where.bodypart].models[where.model].meshes[where.mesh];
  const pad = (4 - src.length % 4) % 4, out = Buffer.concat([src, Buffer.alloc(pad + 4)]);
  out.writeInt32LE(0, mesh.at); out.writeInt32LE(src.length + pad, mesh.at + 4); out.writeInt32LE(out.length, H.length);
  return out;
}

/**
 * Returns a copy of the file with one mesh keeping only the triangles `keep` accepts; it is
 * given the bones of a triangle's three corners. Vertices and normals stay as they are.
 */
export function filterMesh(src, where, keep) {
  const model = readMdl(src).bodyparts[where.bodypart].models[where.model], mesh = model.meshes[where.mesh], vi = i32(src, model.at + M.vertinfoindex);
  const tris = readTris(src, mesh.triindex).tris.filter((t) => keep(t.map(([v]) => src[vi + v])));
  const cmds = Buffer.alloc(tris.length * 26 + 2);
  tris.forEach((t, i) => { cmds.writeInt16LE(3, i * 26); t.forEach((c, k) => c.forEach((v, n) => cmds.writeInt16LE(v, i * 26 + 2 + k * 8 + n * 2))); });
  const pad = (4 - src.length % 4) % 4, out = Buffer.concat([src, Buffer.alloc(pad), cmds]);
  out.writeInt32LE(tris.length, mesh.at); out.writeInt32LE(src.length + pad, mesh.at + 4); out.writeInt32LE(out.length, H.length);
  return out;
}

/**
 * How many corners the engine draws for each submodel: its meshes' triangle commands, corner by
 * corner. The renderer keeps them in a table of MAXSTUDIOVERTS (16384): one more and it writes past it.
 */
export const MAXSTUDIOVERTS = 16384;
export function drawnCorners(b) {
  const count = (o) => { let n = 0; for (;;) { const c = Math.abs(b.readInt16LE(o)); o += 2; if (!c) return n; n += c; o += c * 8; } };
  return readMdl(b).bodyparts.flatMap((bp) => bp.models.map((m) => ({ name: m.name, corners: m.meshes.reduce((a, x) => a + (x.numtris ? count(x.triindex) : 0), 0) })));
}

/** Each bone's parent (-1 for a root). */
export const boneParents = (b) => Array.from({ length: i32(b, H.numbones) }, (_, i) => i32(b, i32(b, H.boneindex) + i * 112 + 32));

/** Every bone's matrix (3 rows of 4) in the model's rest pose, from the bones' own default position and angles. */
export function restPose(b) {
  const out = [];
  for (let i = 0; i < i32(b, H.numbones); i++) {
    const o = i32(b, H.boneindex) + i * 112, parent = i32(b, o + 32), v = [0, 1, 2, 3, 4, 5].map((k) => b.readFloatLE(o + 64 + k * 4));
    const [sx, cx, sy, cy, sz, cz] = [v[3], v[4], v[5]].flatMap((a) => [Math.sin(a), Math.cos(a)]);
    // roll about x, then pitch about y, then yaw about z, as the engine's AngleQuaternion
    const m = [[cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz, v[0]], [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz, v[1]], [-sy, sx * cy, cx * cy, v[2]]];
    out.push(parent < 0 ? m : mul34(out[parent], m));
  }
  return out;
}
/** The model's animations: [{ name, fps, frames, loops, flags, motion, move, speed, blends, group }] (mstudioseqdesc_t, 176 bytes).
 *  `loops`: the sequence is marked looping (STUDIO_LOOPING). `move`: how far its root travels in one play of it
 *  (linearmovement), and `speed` the ground speed that makes (units a second): the engine plays a player's legs
 *  at the rate its real speed asks of that (StudioProcessGait). `motion`: which of the root's axes travel (STUDIO_LX 1, LY 2, LZ 4...).
 *  `group`: not 0 when the animation is kept in another file (poseAt cannot read it). */
export function sequences(b) {
  return Array.from({ length: i32(b, 164) }, (_, i) => {
    const s = i32(b, 168) + i * 176, fps = b.readFloatLE(s + 32), frames = i32(b, s + 56), flags = i32(b, s + 36), move = [76, 80, 84].map((o) => b.readFloatLE(s + o)), len = Math.hypot(...move);
    return { name: str(b, s, 32), fps, frames, loops: Boolean(flags & 1), flags, motion: i32(b, s + 68), move, speed: frames > 1 && len ? len / ((frames - 1) / fps) : 0, blends: i32(b, s + 120), group: i32(b, s + 156) };
  });
}
/** Every bone's matrix at a moment of an animation between its frames (`at` in frames, fractional), each matrix's
 *  numbers mixed between the two frames around it: near enough a turn for the small steps of one frame. With `loop`,
 *  past the last frame goes on to the first. */
export function poseBetween(b, seq, at, loop = true) {
  const n = i32(b, i32(b, 168) + seq * 176 + 56), x = loop ? ((at % n) + n) % n : Math.max(0, Math.min(n - 1, at)), i = Math.floor(x), j = loop ? (i + 1) % n : Math.min(i + 1, n - 1), k = x - i;
  const A = poseAt(b, seq, i), B = k ? poseAt(b, seq, j) : A;
  return A.map((m, bone) => m.map((r, ri) => r.map((v, c) => v + (B[bone][ri][c] - v) * k)));
}
/** Every bone's matrix at one frame of an animation (its first blend, or the one asked for; the animation has to be in the model's own file). */
export function poseAt(b, seq, frame, blend = 0) {
  const s = i32(b, 168) + seq * 176, anim = i32(b, s + 124) + blend * i32(b, H.numbones) * 12, out = [];
  if (i32(b, s + 156)) throw new Error("an animation kept in another file");
  for (let i = 0; i < i32(b, H.numbones); i++) {
    const o = i32(b, H.boneindex) + i * 112, parent = i32(b, o + 32), pa = anim + i * 12;
    const v = [0, 1, 2, 3, 4, 5].map((j) => {
      const rest = b.readFloatLE(o + 64 + j * 4), off = b.readUInt16LE(pa + j * 2);
      if (!off) return rest;
      // runs of values: [how many are written, how many frames they cover], then the values; the last one holds to the end of its run
      let p = pa + off, k = frame;
      while (b[p + 1] <= k) { k -= b[p + 1]; p += (b[p] + 1) * 2; }
      return rest + b.readInt16LE(p + 2 * (b[p] > k ? k + 1 : b[p])) * b.readFloatLE(o + 88 + j * 4);
    });
    const [sx, cx, sy, cy, sz, cz] = [v[3], v[4], v[5]].flatMap((a) => [Math.sin(a), Math.cos(a)]);
    const m = [[cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz, v[0]], [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz, v[1]], [-sy, sx * cy, cx * cy, v[2]]];
    out.push(parent < 0 ? m : mul34(out[parent], m));
  }
  return out;
}
export const mul34 = (a, b) => a.map((r) => [0, 1, 2, 3].map((c) => r[0] * b[0][c] + r[1] * b[1][c] + r[2] * b[2][c] + (c === 3 ? r[3] : 0)));
export const apply34 = (m, p) => m.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]);
/** The inverse of a rigid matrix. */
export const inverse34 = (m) => [0, 1, 2].map((r) => [m[0][r], m[1][r], m[2][r], -(m[0][r] * m[0][3] + m[1][r] * m[1][3] + m[2][r] * m[2][3])]);

// ── bones and whole models written ─────────────────────────────────────────
// A bone is 112 bytes (mstudiobone_t): name[32], parent, flags, six bone controllers (-1: none), six rest values (x y z, then
// the angles about x y z) and six scales (what one step of an animation's stored value is worth). An animation is, for each
// blend, a table of six offsets a bone (mstudioanim_t, 12 bytes; 0: the bone rests on that channel), each offset counted from
// its own entry to runs of values: [how many are written, how many frames they cover], then the values, as 16 bit steps.
const BONE = 112, SEQ = 176;
/** Where a channel's runs end: they are read until they cover every frame. */
function runsEnd(b, at, frames) { let covered = 0; while (covered < frames) { covered += b[at + 1]; at += (b[at] + 1) * 2; } return at; }
function boneEntry(bone) {
  const e = Buffer.alloc(BONE); e.write(bone.name, 0, 31, "latin1"); e.writeInt32LE(bone.parent, 32);
  for (let k = 0; k < 6; k++) { e.writeInt32LE(-1, 40 + k * 4); e.writeFloatLE([...(bone.pos ?? [0, 0, 0]), ...(bone.rot ?? [0, 0, 0])][k], 64 + k * 4); e.writeFloatLE(bone.scale?.[k] ?? (k < 3 ? 1 / 256 : Math.PI / 32768), 88 + k * 4); }
  return e;
}
/**
 * Returns a copy of the file with more bones after the ones it has: [{ name, parent (a bone's number: one of the file's, or
 * of these, counted on from the file's), pos [x, y, z], rot [about x, y, z] }], each resting in every animation. The bones it
 * had keep their numbers, so its bone controllers, attachments, hit boxes and every corner's bone stay as they were. The bone
 * table and every animation are written again at the end of the file (an animation's table has an entry a bone, and its
 * offsets are counted from the entry, so the values move with it); the old ones stay where they were, unused.
 */
export function addBones(src, bones) {
  const n = i32(src, H.numbones), m = bones.length, parts = [Buffer.from(src)], head = parts[0]; let size = src.length;
  const add = (buf) => { const pad = (4 - size % 4) % 4; if (pad) { parts.push(Buffer.alloc(pad)); size += pad; } const at = size; parts.push(buf); size += buf.length; return at; };
  bones.forEach((bn, k) => { if (bn.parent >= n + k || bn.parent < -1) throw new Error(`the bone ${bn.name} hangs from a bone after it`); });
  head.writeInt32LE(add(Buffer.concat([src.subarray(i32(src, H.boneindex), i32(src, H.boneindex) + n * BONE), ...bones.map(boneEntry)])), H.boneindex);
  head.writeInt32LE(n + m, H.numbones);
  for (let q = 0; q < i32(src, 164); q++) {
    const s = i32(src, 168) + q * SEQ, frames = i32(src, s + 56), blends = i32(src, s + 120), old = i32(src, s + 124);
    if (i32(src, s + 156)) throw new Error(`the animation ${str(src, s, 32)} is kept in another file: its bones cannot be added to here`);
    // the tables of every blend first, then each channel's values, as the compiler lays them
    const table = Buffer.alloc(blends * (n + m) * 12), data = []; let at = table.length;
    for (let bl = 0; bl < blends; bl++) for (let i = 0; i < n; i++) for (let j = 0; j < 6; j++) {
      const entry = old + (bl * n + i) * 12, off = src.readUInt16LE(entry + j * 2); if (!off) continue;
      const from = entry + off, bytes = src.subarray(from, runsEnd(src, from, frames)), rel = at - (bl * (n + m) + i) * 12;
      if (rel > 65535) throw new Error(`the animation ${str(src, s, 32)} is too long to move`);
      table.writeUInt16LE(rel, (bl * (n + m) + i) * 12 + j * 2); data.push(bytes); at += bytes.length;
    }
    head.writeInt32LE(add(Buffer.concat([table, ...data])), s + 124);
  }
  head.writeInt32LE(size, H.length);
  return Buffer.concat(parts);
}

/**
 * A whole model written from nothing (version 10, its textures inside it):
 *   name       what the file calls itself
 *   bones      [{ name, parent (-1 for a root), pos, rot }], a parent before its children
 *   sequences  [{ name, fps, loops, frames: [ for each frame, for each bone, [x, y, z, about x, about y, about z] ] }]
 *   textures   [{ name, width, height, pixels (one palette index each), palette (768 bytes), flags (64: its last colour is a hole) }]
 *   skins      the families: for each, which texture each mesh's `skin` number means (default: one family, as numbered)
 *   bodyparts  [{ name, models: [{ name, verts: [[x, y, z]] in their bones' space, vertBones, meshes: [{ skin, norms, normBones,
 *                tris: [[[vert, norm (of this mesh's), s, t] x3]] }] }] }]
 * No hit boxes, bone controllers, attachments or events: what a worn thing drawn on a player's bones needs, and no more.
 */
export function writeMdl({ name, bones, sequences, textures, skins = null, bodyparts }) {
  const parts = [Buffer.alloc(244)], head = parts[0]; let size = 244;
  const add = (buf) => { const pad = (4 - size % 4) % 4; if (pad) { parts.push(Buffer.alloc(pad)); size += pad; } const at = size; parts.push(buf); size += buf.length; return at; };
  const floats = (list) => { const o = Buffer.alloc(list.length * 12); list.forEach((p, i) => { o.writeFloatLE(p[0], i * 12); o.writeFloatLE(p[1], i * 12 + 4); o.writeFloatLE(p[2], i * 12 + 8); }); return o; };
  head.write("IDST", 0, "latin1"); head.writeInt32LE(10, 4); head.write(name, 8, 63, "latin1");
  // each channel's scale is the least that holds its widest swing in 16 bits, so nothing is lost that need not be
  const rest = bones.map((b) => [...(b.pos ?? [0, 0, 0]), ...(b.rot ?? [0, 0, 0])]), scale = bones.map((_, i) => [0, 1, 2, 3, 4, 5].map((j) => { let w = 0; for (const sq of sequences) for (const f of sq.frames) w = Math.max(w, Math.abs(f[i][j] - rest[i][j])); return w ? w / 32000 : (j < 3 ? 1 / 256 : Math.PI / 32768); }));
  head.writeInt32LE(bones.length, H.numbones); head.writeInt32LE(add(Buffer.concat(bones.map((b, i) => boneEntry({ ...b, scale: scale[i] })))), H.boneindex);
  const nowhere = add(Buffer.alloc(4)); for (const o of [152, 160, 216, 224, 232, 240]) head.writeInt32LE(nowhere, o); // tables with nothing in them
  // the animations
  const seqs = Buffer.alloc(sequences.length * SEQ), all = sequences.flatMap((sq) => sq.frames.flat()), mn = [0, 1, 2].map((a) => all.reduce((v, f) => Math.min(v, f[a]), -16)), mx = [0, 1, 2].map((a) => all.reduce((v, f) => Math.max(v, f[a]), 16));
  sequences.forEach((sq, q) => {
    const n = bones.length, F = sq.frames.length, table = Buffer.alloc(n * 12), data = []; let at = table.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < 6; j++) {
      const v = sq.frames.map((f) => Math.round((f[i][j] - rest[i][j]) / scale[i][j])); if (v.every((x) => !x)) continue;
      const runs = []; for (let f0 = 0; f0 < F; f0 += 255) { const c = Math.min(255, F - f0), r = Buffer.alloc(2 + c * 2); r[0] = c; r[1] = c; for (let k = 0; k < c; k++) r.writeInt16LE(v[f0 + k], 2 + k * 2); runs.push(r); }
      const bytes = Buffer.concat(runs), rel = at - i * 12; if (rel > 65535) throw new Error(`the animation ${sq.name} is too long`);
      table.writeUInt16LE(rel, i * 12 + j * 2); data.push(bytes); at += bytes.length;
    }
    const e = q * SEQ; seqs.write(sq.name, e, 31, "latin1"); seqs.writeFloatLE(sq.fps, e + 32); seqs.writeInt32LE(sq.loops ? 1 : 0, e + 36); seqs.writeInt32LE(F, e + 56);
    [...mn, ...mx].forEach((v, k) => seqs.writeFloatLE(v, e + 96 + k * 4)); seqs.writeInt32LE(1, e + 120); seqs.writeInt32LE(add(Buffer.concat([table, ...data])), e + 124);
  });
  head.writeInt32LE(sequences.length, 164); head.writeInt32LE(add(seqs), 168);
  const group = Buffer.alloc(104); group.write("default", 0, "latin1"); head.writeInt32LE(1, 172); head.writeInt32LE(add(group), 176);
  [...mn, ...mx, ...mn, ...mx].forEach((v, k) => head.writeFloatLE(v, 88 + k * 4));
  // the shapes: each model's corners, then mesh by mesh its normals and triangles (each triangle a strip of three)
  const bps = Buffer.alloc(bodyparts.length * 76); let base = 1;
  bodyparts.forEach((bp, b) => {
    const models = Buffer.alloc(bp.models.length * 112);
    bp.models.forEach((md, k) => {
      const e = k * 112, norms = md.meshes.flatMap((x) => x.norms), normBones = md.meshes.flatMap((x) => x.normBones), meshes = Buffer.alloc(md.meshes.length * 20); let before = 0;
      md.meshes.forEach((x, q) => {
        const cmds = Buffer.alloc(x.tris.length * 26 + 2);
        x.tris.forEach((t, i) => { cmds.writeInt16LE(3, i * 26); t.forEach(([v, nn, s, tt], c) => { const o = i * 26 + 2 + c * 8; cmds.writeInt16LE(v, o); cmds.writeInt16LE(before + nn, o + 2); cmds.writeInt16LE(s, o + 4); cmds.writeInt16LE(tt, o + 6); }); });
        meshes.writeInt32LE(x.tris.length, q * 20); meshes.writeInt32LE(add(cmds), q * 20 + 4); meshes.writeInt32LE(x.skin ?? 0, q * 20 + 8); meshes.writeInt32LE(x.norms.length, q * 20 + 12); before += x.norms.length;
      });
      models.write(md.name, e, 63, "latin1"); models.writeFloatLE(64, e + 68); models.writeInt32LE(md.meshes.length, e + M.nummesh); models.writeInt32LE(add(meshes), e + M.meshindex);
      models.writeInt32LE(md.verts.length, e + M.numverts); models.writeInt32LE(add(Buffer.from(md.vertBones)), e + M.vertinfoindex); models.writeInt32LE(add(floats(md.verts)), e + M.vertindex);
      models.writeInt32LE(norms.length, e + M.numnorms); models.writeInt32LE(add(Buffer.from(normBones)), e + M.norminfoindex); models.writeInt32LE(add(floats(norms)), e + M.normindex);
    });
    bps.write(bp.name, b * 76, 63, "latin1"); bps.writeInt32LE(bp.models.length, b * 76 + 64); bps.writeInt32LE(base, b * 76 + 68); bps.writeInt32LE(add(models), b * 76 + 72); base *= bp.models.length;
  });
  head.writeInt32LE(bodyparts.length, H.numbodyparts); head.writeInt32LE(add(bps), H.bodypartindex);
  // the pictures: the table, the families, then each picture's dots and its palette
  const refs = skins ? skins[0].length : textures.length, fams = skins ?? [textures.map((_, i) => i)], skin = Buffer.alloc(fams.length * refs * 2); fams.forEach((f, a) => f.forEach((t, r) => skin.writeInt16LE(t, (a * refs + r) * 2)));
  const table = Buffer.alloc(textures.length * 80), tex = add(table); head.writeInt32LE(textures.length, H.numtextures); head.writeInt32LE(tex, H.textureindex);
  head.writeInt32LE(refs, H.numskinref); head.writeInt32LE(fams.length, H.numskinfamilies); head.writeInt32LE(add(skin), H.skinindex);
  textures.forEach((t, i) => { const e = i * 80; table.write(t.name, e, 63, "latin1"); table.writeInt32LE(t.flags ?? 0, e + 64); table.writeInt32LE(t.width, e + 68); table.writeInt32LE(t.height, e + 72); const at = add(Buffer.concat([Buffer.from(t.pixels), Buffer.from(t.palette)])); table.writeInt32LE(at, e + 76); if (!i) head.writeInt32LE(at, 188); });
  head.writeInt32LE(size, H.length);
  return Buffer.concat(parts);
}

// ── pictures read and changed ──────────────────────────────────────────────
const textureAt = (b, which) => { const list = readMdl(b).textures, i = typeof which === "number" ? which : list.findIndex((t) => t.name.toLowerCase() === String(which).toLowerCase()); if (!list[i]) throw new Error(`no texture ${which}`); return i; };
/** One of the file's textures, copied out: { name, flags, width, height, pixels, palette }. `which`: its number or its name. */
export function textureOf(b, which) {
  const t = readMdl(b).textures[textureAt(b, which)], n = t.width * t.height;
  return { name: t.name, flags: t.flags, width: t.width, height: t.height, pixels: Uint8Array.from(b.subarray(t.index, t.index + n)), palette: Uint8Array.from(b.subarray(t.index + n, t.index + n + 768)) };
}
/**
 * Returns a copy of the file with one of its textures holding another picture: { width, height, pixels, palette } and, when
 * given, `name` and `flags`. Every mesh that wears it goes on wearing it. A picture of another size is written at the end of
 * the file and the corners of those meshes, which are kept in pixels, are moved to the same place in the new one.
 */
export function replaceTexture(src, which, texture) {
  const i = textureAt(src, which), info = readMdl(src), old = info.textures[i], e = i32(src, H.textureindex) + i * 80, n = texture.width * texture.height;
  if (texture.pixels.length !== n || texture.palette.length !== 768) throw new Error(`${old.name}: ${texture.width}x${texture.height} needs ${n} pixels and 768 bytes of palette`);
  const data = Buffer.concat([Buffer.from(texture.pixels), Buffer.from(texture.palette)]), same = texture.width === old.width && texture.height === old.height;
  const pad = same ? 0 : (4 - src.length % 4) % 4, out = same ? Buffer.from(src) : Buffer.concat([src, Buffer.alloc(pad), data]);
  if (same) data.copy(out, old.index);
  else {
    out.writeInt32LE(texture.width, e + 68); out.writeInt32LE(texture.height, e + 72); out.writeInt32LE(src.length + pad, e + 76); out.writeInt32LE(out.length, H.length);
    const kx = texture.width / old.width, ky = texture.height / old.height;
    for (const bp of info.bodyparts) for (const m of bp.models) for (const x of m.meshes) {
      if (x.texture !== old || !x.numtris) continue;
      for (let o = x.triindex; ;) { const c = Math.abs(out.readInt16LE(o)); o += 2; if (!c) break; for (let k = 0; k < c; k++, o += 8) { out.writeInt16LE(Math.round(out.readInt16LE(o + 4) * kx), o + 4); out.writeInt16LE(Math.round(out.readInt16LE(o + 6) * ky), o + 6); } }
    }
  }
  if (texture.name !== undefined && texture.name !== old.name) { out.fill(0, e, e + 64); out.write(texture.name, e, 63, "latin1"); }
  if (texture.flags !== undefined) out.writeInt32LE(texture.flags, e + 64);
  return out;
}
/**
 * A model whose textures are kept in a file of their own (`name`t.mdl beside `name`.mdl: the model itself says it has none),
 * with them put inside it: returns a copy of `src` holding the textures and the skin table of `tfile`.
 */
export function withTextures(src, tfile) {
  if (i32(src, H.numtextures)) return src;
  const parts = [Buffer.from(src)], head = parts[0]; let size = src.length;
  const add = (buf) => { const pad = (4 - size % 4) % 4; if (pad) { parts.push(Buffer.alloc(pad)); size += pad; } const at = size; parts.push(buf); size += buf.length; return at; };
  const n = i32(tfile, H.numtextures), table = Buffer.from(tfile.subarray(i32(tfile, H.textureindex), i32(tfile, H.textureindex) + n * 80));
  for (let i = 0; i < n; i++) { const o = i * 80, len = table.readInt32LE(o + 68) * table.readInt32LE(o + 72) + 768, at = table.readInt32LE(o + 76); table.writeInt32LE(add(tfile.subarray(at, at + len)), o + 76); if (!i) head.writeInt32LE(table.readInt32LE(76), 188); }
  head.writeInt32LE(n, H.numtextures); head.writeInt32LE(add(table), H.textureindex);
  const refs = i32(tfile, H.numskinref), fams = i32(tfile, H.numskinfamilies);
  head.writeInt32LE(refs, H.numskinref); head.writeInt32LE(fams, H.numskinfamilies); head.writeInt32LE(add(tfile.subarray(i32(tfile, H.skinindex), i32(tfile, H.skinindex) + refs * fams * 2)), H.skinindex);
  head.writeInt32LE(size, H.length);
  return Buffer.concat(parts);
}
/** The skin families: for each, which texture (its number) each mesh's `skinref` means. A model shown with `skin` n wears family n. */
export function skinFamilies(b) {
  const refs = i32(b, H.numskinref), o = i32(b, H.skinindex);
  return Array.from({ length: i32(b, H.numskinfamilies) }, (_, f) => Array.from({ length: refs }, (_, r) => b.readInt16LE(o + (f * refs + r) * 2)));
}
/** Which submodel of each bodypart a `body` number shows, as the engine works it out. */
export const bodyOf = (b, body = 0) => readMdl(b).bodyparts.map((bp) => (bp.models.length ? Math.floor(body / bp.base) % bp.models.length : 0));

// ── animations read whole and written into a file ──────────────────────────
// A frame is, for every bone, six numbers: where it is from its parent (x y z) and how it is turned (about x y z, radians).
const matrixOf = (v) => {
  const [sx, cx, sy, cy, sz, cz] = [v[3], v[4], v[5]].flatMap((a) => [Math.sin(a), Math.cos(a)]);
  return [[cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz, v[0]], [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz, v[1]], [-sy, sx * cy, cx * cy, v[2]]];
};
/** Every bone's matrix for a frame given as numbers ([for each bone, [x, y, z, about x, about y, about z]]): what poseAt gives for a frame of the file. */
export function poseOf(b, values) {
  const parents = boneParents(b), out = [];
  values.forEach((v, i) => { const m = matrixOf(v); out.push(parents[i] < 0 ? m : mul34(out[parents[i]], m)); });
  return out;
}
/** The bones as they rest: [{ name, parent, pos [x, y, z], rot [about x, y, z], scale (what one stored step of each of the six is worth) }]. */
export function bones(b) {
  return Array.from({ length: i32(b, H.numbones) }, (_, i) => { const o = i32(b, H.boneindex) + i * BONE, f = (k) => b.readFloatLE(o + k); return { name: str(b, o, 32), parent: i32(b, o + 32), pos: [f(64), f(68), f(72)], rot: [f(76), f(80), f(84)], scale: [0, 1, 2, 3, 4, 5].map((k) => f(88 + k * 4)) }; });
}
/** One frame of an animation as numbers: for each bone, [x, y, z, about x, about y, about z]. */
export function frameValues(b, seq, frame, blend = 0) {
  const s = i32(b, 168) + seq * SEQ, n = i32(b, H.numbones), anim = i32(b, s + 124) + blend * n * 12;
  if (i32(b, s + 156)) throw new Error("an animation kept in another file");
  return Array.from({ length: n }, (_, i) => {
    const o = i32(b, H.boneindex) + i * BONE, pa = anim + i * 12;
    return [0, 1, 2, 3, 4, 5].map((j) => {
      const rest = b.readFloatLE(o + 64 + j * 4), off = b.readUInt16LE(pa + j * 2);
      if (!off) return rest;
      let p = pa + off, k = frame;
      while (b[p + 1] <= k) { if (!b[p + 1]) throw new Error(`the animation's values for ${str(b, o, 32)} end before frame ${frame}`); k -= b[p + 1]; p += (b[p] + 1) * 2; }
      return rest + b.readInt16LE(p + 2 * (b[p] > k ? k + 1 : b[p])) * b.readFloatLE(o + 88 + j * 4);
    });
  });
}
/** An animation whole: what sequences() tells of it and `frames` (see frameValues), of its first blend or the one asked for. */
export function readSequence(b, which, blend = 0) {
  const q = sequenceAt(b, which), s = sequences(b)[q]; if (!s) throw new Error(`no animation ${which}`);
  return { ...s, index: q, frames: Array.from({ length: s.frames }, (_, f) => frameValues(b, q, f, blend)) };
}
/** The number of the animation of that name (or the number itself), or -1. */
export const sequenceAt = (b, which) => (typeof which === "number" ? (which >= 0 && which < i32(b, 164) ? which : -1) : sequences(b).findIndex((s) => s.name.toLowerCase() === String(which).toLowerCase()));

/** A channel's values as runs: [how many are written, how many frames they cover], the values; three or more alike are held, not written. */
function runsOf(v) {
  const parts = [];
  for (let i = 0; i < v.length;) {
    const vals = [v[i++]]; let held = 0;
    while (i < v.length && vals.length < 255) {
      let j = i; while (j < v.length && v[j] === vals[vals.length - 1] && vals.length + (j - i) < 255) j++;
      if (j - i >= 3 || (j > i && j === v.length)) { held = j - i; i = j; break; }
      vals.push(v[i++]);
    }
    const r = Buffer.alloc(2 + vals.length * 2); r[0] = vals.length; r[1] = vals.length + held; vals.forEach((x, k) => r.writeInt16LE(x, 2 + k * 2)); parts.push(r);
  }
  return Buffer.concat(parts);
}
const TURN = 2 * Math.PI, nearTurn = (d) => d - TURN * Math.round(d / TURN);
/** How far a frame's number is from the bone's rest, as it is stored: a turn is taken the short way round. */
const awayFrom = (rest, v, j) => (j < 3 ? v - rest : nearTurn(v - rest));
/** An animation's blends ([for each blend, its frames]) as the file keeps them, by the bones' own rest and scale in `b`. */
function animOf(b, blends, name) {
  const all = bones(b), n = all.length, table = Buffer.alloc(blends.length * n * 12), data = []; let at = table.length;
  blends.forEach((frames, bl) => {
    for (const f of frames) if (f.length !== n) throw new Error(`${name}: a frame of ${f.length} bones for a model of ${n}`);
    for (let i = 0; i < n; i++) for (let j = 0; j < 6; j++) {
      const rest = j < 3 ? all[i].pos[j] : all[i].rot[j - 3], scale = all[i].scale[j], v = frames.map((f) => (scale ? Math.round(awayFrom(rest, f[i][j], j) / scale) : 0));
      if (v.every((x) => !x)) continue;
      if (v.some((x) => x > 32767 || x < -32768)) throw new Error(`${name}: ${all[i].name} moves further than its scale holds`);
      const bytes = runsOf(v), rel = at - (bl * n + i) * 12; if (rel > 65535) throw new Error(`${name}: too long for one animation (its values pass 64 KB): fewer frames, or cut it in two`);
      table.writeUInt16LE(rel, (bl * n + i) * 12 + j * 2); data.push(bytes); at += bytes.length;
    }
  });
  // the engine reads one value past a frame to blend towards it: four bytes of nothing after the last
  return Buffer.concat([table, ...data, Buffer.alloc(4)]);
}
/**
 * Returns a copy of the file whose bones can hold `blends` (frames a blend): where a bone would move further from its rest
 * than its scale reaches in 16 bits, the scale is made larger and every animation of the file written again by it (a little
 * coarser in that bone, nothing else changed). The file itself when nothing needs it.
 */
function roomFor(src, blends, name) {
  const all = bones(src), want = all.map(() => [0, 0, 0, 0, 0, 0]);
  for (const frames of blends) for (const f of frames) { if (f.length !== all.length) throw new Error(`${name}: a frame of ${f.length} bones for a model of ${all.length}`); f.forEach((v, i) => { for (let j = 0; j < 6; j++) { const d = awayFrom(j < 3 ? all[i].pos[j] : all[i].rot[j - 3], v[j], j); want[i][j] = Math.max(want[i][j], d > 0 ? d / 32767 : -d / 32768); } }); }
  // `want`: the least scale that holds each bone's widest swing in 16 bits
  const wider = all.map((bn, i) => bn.scale.map((s, j) => (want[i][j] > s * 1.00001 ? want[i][j] * 1.02 : s)));
  if (wider.every((w, i) => w.every((s, j) => s === all[i].scale[j]))) return src;
  const seqs = sequences(src), kept = seqs.map((s, q) => { if (s.group) throw new Error(`${name}: needs a wider scale, and ${s.name} is kept in another file`); return Array.from({ length: s.blends }, (_, bl) => readSequence(src, q, bl).frames); });
  const parts = [Buffer.from(src)], head = parts[0]; let size = src.length;
  wider.forEach((w, i) => w.forEach((s, j) => head.writeFloatLE(s, i32(src, H.boneindex) + i * BONE + 88 + j * 4)));
  kept.forEach((bl, q) => { const pad = (4 - size % 4) % 4, buf = animOf(head, bl, seqs[q].name); parts.push(Buffer.alloc(pad), buf); head.writeInt32LE(size + pad, i32(src, 168) + q * SEQ + 124); size += pad + buf.length; });
  head.writeInt32LE(size, H.length);
  return Buffer.concat(parts);
}
/**
 * Returns a copy of the file with one animation played from other frames: { frames (see frameValues) or blends: [frames, ...],
 * fps, loops }; what is not given stays. Its place in the list stays, and so does everything else it says (its events, its
 * activity, how far it travels): game code that asks for an animation by its number goes on getting this one.
 * Given `frames`, an animation that had several blends is left with one.
 */
export function replaceSequence(src, which, { frames, blends = frames && [frames], fps, loops } = {}) {
  const q = sequenceAt(src, which); if (q < 0) throw new Error(`no animation ${which}`);
  let out = Buffer.from(src); const s = i32(src, 168) + q * SEQ, name = str(src, s, 32);
  if (blends) {
    if (i32(src, s + 156)) throw new Error(`${name} is kept in another file`);
    if (!blends[0]?.length || blends.some((f) => f.length !== blends[0].length)) throw new Error(`${name}: every blend needs the same number of frames, and one at least`);
    out = Buffer.from(roomFor(out, blends, name));
    const pad = (4 - out.length % 4) % 4, buf = animOf(out, blends, name), at = out.length + pad;
    out = Buffer.concat([out, Buffer.alloc(pad), buf]);
    out.writeInt32LE(at, s + 124); out.writeInt32LE(blends.length, s + 120); out.writeInt32LE(blends[0].length, s + 56); out.writeInt32LE(out.length, H.length);
  }
  if (fps !== undefined) out.writeFloatLE(fps, s + 32);
  if (loops !== undefined) out.writeInt32LE(loops ? i32(out, s + 36) | 1 : i32(out, s + 36) & ~1, s + 36);
  return out;
}
/**
 * Returns a copy of the file with one more animation after the ones it has (its number is the old count, so the ones the game
 * knows by number stay where they were): { name, fps, loops, frames, activity, events }. The box it is drawn within is taken from
 * the animation `like` (0 unless told). The table of animations is written again at the end of the file.
 */
export function addSequence(src, { name, fps = 30, loops = false, frames, blends, activity = 0, events: evs, like = 0 }) {
  // after the table, one frame of every bone at rest: what the new animation is until its frames are written
  const n = i32(src, 164), old = i32(src, 168), pad = (4 - src.length % 4) % 4, at = src.length + pad, table = Buffer.alloc((n + 1) * SEQ + i32(src, H.numbones) * 12 + 4), e = n * SEQ;
  if (n) src.copy(table, 0, old, old + n * SEQ);
  table.write(name, e, 31, "latin1"); table.writeFloatLE(fps, e + 32); table.writeInt32LE(activity, e + 40); table.writeInt32LE(activity ? 1 : 0, e + 44); table.writeInt32LE(1, e + 56); table.writeInt32LE(1, e + 120); table.writeInt32LE(at + (n + 1) * SEQ, e + 124);
  if (n) src.copy(table, e + 96, old + Math.min(like, n - 1) * SEQ + 96, old + Math.min(like, n - 1) * SEQ + 120);
  let out = Buffer.concat([src, Buffer.alloc(pad), table]);
  out.writeInt32LE(n + 1, 164); out.writeInt32LE(at, 168); out.writeInt32LE(out.length, H.length);
  out = replaceSequence(out, n, { frames, blends, loops });
  return evs?.length ? setEvents(out, n, evs) : out;
}

// ── what an animation sets off, and where things are fastened ──────────────
/** An animation's events: [{ frame, event (the number the game's code knows: 5004 plays a sound in the client, 5001 a muzzle flash...), options (its text: the sound's file), type }]. */
export function events(b, which) {
  const q = sequenceAt(b, which); if (q < 0) throw new Error(`no animation ${which}`);
  const s = i32(b, 168) + q * SEQ, at = i32(b, s + 52);
  return Array.from({ length: i32(b, s + 48) }, (_, i) => ({ frame: i32(b, at + i * 76), event: i32(b, at + i * 76 + 4), type: i32(b, at + i * 76 + 8), options: str(b, at + i * 76 + 12, 64) }));
}
/** Returns a copy of the file with one animation setting off these events and no others: [{ frame, event, options, type }]. */
export function setEvents(src, which, list) {
  const q = sequenceAt(src, which); if (q < 0) throw new Error(`no animation ${which}`);
  const pad = (4 - src.length % 4) % 4, table = Buffer.alloc(list.length * 76 + 4), s = i32(src, 168) + q * SEQ;
  [...list].sort((a, b) => a.frame - b.frame).forEach((ev, i) => { table.writeInt32LE(ev.frame, i * 76); table.writeInt32LE(ev.event, i * 76 + 4); table.writeInt32LE(ev.type ?? 0, i * 76 + 8); table.write(String(ev.options ?? ""), i * 76 + 12, 63, "latin1"); });
  const out = Buffer.concat([src, Buffer.alloc(pad), table]);
  out.writeInt32LE(list.length, s + 48); out.writeInt32LE(src.length + pad, s + 52); out.writeInt32LE(out.length, H.length);
  return out;
}
/** The model's attachments: [{ name, bone (its number), pos [x, y, z] in that bone's space }]: where a muzzle flash, a shell or a held thing goes. */
export function attachments(b) {
  const at = i32(b, 216);
  return Array.from({ length: i32(b, 212) }, (_, i) => ({ name: str(b, at + i * 88, 32), bone: i32(b, at + i * 88 + 36), pos: [40, 44, 48].map((o) => b.readFloatLE(at + i * 88 + o)) }));
}
/** The hit boxes: [{ bone, group, min, max }], each in its bone's space. */
export function hitboxes(b) {
  const at = i32(b, 160);
  return Array.from({ length: i32(b, 156) }, (_, i) => ({ bone: i32(b, at + i * 32), group: i32(b, at + i * 32 + 4), min: [8, 12, 16].map((o) => b.readFloatLE(at + i * 32 + o)), max: [20, 24, 28].map((o) => b.readFloatLE(at + i * 32 + o)) }));
}
/** Every bone's matrix for a list of bones that is not in a file yet ([{ parent, pos, rot }], a parent before its children), as they rest or at `values`. */
export function boneMatrices(list, values = list.map((bn) => [...(bn.pos ?? [0, 0, 0]), ...(bn.rot ?? [0, 0, 0])])) {
  const out = [];
  list.forEach((bn, i) => { const m = matrixOf(values[i]); out.push(bn.parent < 0 ? m : mul34(out[bn.parent], m)); });
  return out;
}
