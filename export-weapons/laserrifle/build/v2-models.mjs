// The three game models from the rifle prepared by v2-prep.mjs: v_ (first person), p_ (another player's hands) and
// w_ (on the floor). They are TS's own M4A1 models with the gun's meshes swapped for the rifle's, so the hands, the
// bones and every animation (reload, draw, the shots, the gunbash "stock") are the M4A1's. A GoldSrc submodel
// holds 2048 points, so the gun goes in as several rigid pieces (putRigid), each on one bone.
//
//   node v2-models.mjs [outdir]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  readMdl, emptyMesh, clearModel, restPose, posed, apply34, inverse34, mul34, render, sheet, png, HANDS,
  setModelName, attachments, setAttachments,
} from "file:///D:/Downloads/TSM/smak/src/index.mjs";
import { putRigid } from "file:///D:/Downloads/TSM/smak/src/bodies.mjs";
import { indexed } from "file:///D:/Downloads/TSM/smak/src/image.mjs";

const OUT = process.argv[2] ?? "D:/Downloads/TSM/laserrifle/out2";
const TS = "D:/Downloads/TSM/H9XASH/ts/models/";
mkdirSync(OUT, { recursive: true });

const data = JSON.parse(readFileSync("D:/Downloads/TSM/laserrifle/out2/gun.json", "utf8"));
const num = (name, fallback) => (process.env[name] !== undefined ? Number(process.env[name]) : fallback);
// the view model's rifle sits this much (game units) away from where its trigger meets the M4A1's
const V_SHIFT = [num("LR_VX", 0), num("LR_VY", 0), num("LR_VZ", -0.7)];
// the first person optic is this much flatter than the file's, so that it does not stand up into the view
const V_OPTIC_FLAT = num("LR_OPTIC_FLAT", 0.6);

const texture = indexed(
  { width: data.texture.width, height: data.texture.height, rgb: new Uint8Array(Buffer.from(data.texture.rgb, "base64")) },
  "laser.bmp",
);
// the optic's lenses: a texture of their own with the fullbright flag, so that they glow whatever the map's light is
const lensTexture = indexed(
  { width: data.lens.width, height: data.lens.height, rgb: new Uint8Array(Buffer.from(data.lens.rgb, "base64")) },
  "lens.bmp",
);
lensTexture.flags = 4; // STUDIO_NF_FULLBRIGHT
const isGlass = (tri) => tri[0].mat === "OpticGlass";
console.log(`texture ${texture.width}x${texture.height}, lens ${lensTexture.width}x${lensTexture.height}`);

/** Points no triangle uses are dropped, and the rest numbered again (GoldSrc holds 2048 a submodel). */
function pruneVerts(src) {
  const buf = Buffer.from(src);
  const info = readMdl(buf);
  for (const bodypart of info.bodyparts)
    for (const model of bodypart.models) {
      const numverts = buf.readInt32LE(model.at + 80);
      if (!numverts) continue;
      const infoAt = buf.readInt32LE(model.at + 84);
      const vertAt = buf.readInt32LE(model.at + 88);
      const corners = [];
      const used = new Set();
      for (const mesh of model.meshes) {
        let at = mesh.triindex;
        for (;;) {
          const n = buf.readInt16LE(at);
          at += 2;
          if (n === 0) break;
          for (let i = 0; i < Math.abs(n); i++) {
            corners.push(at + i * 8);
            used.add(buf.readInt16LE(at + i * 8));
          }
          at += Math.abs(n) * 8;
        }
      }
      const keep = [...used].sort((a, b) => a - b);
      const renumber = new Map(keep.map((old, i) => [old, i]));
      const bones = Buffer.from(keep.map((old) => buf[infoAt + old]));
      const points = Buffer.concat(keep.map((old) => buf.subarray(vertAt + old * 12, vertAt + old * 12 + 12)));
      for (const at of corners) buf.writeInt16LE(renumber.get(buf.readInt16LE(at)), at);
      bones.copy(buf, infoAt);
      points.copy(buf, vertAt);
      buf.writeInt32LE(keep.length, model.at + 80);
    }
  return buf;
}

/**
 * The rifle as `putRigid` pieces, each wholly on one bone. `worldOf` places a corner in the model's space at the
 * animation's first frame; `boneOf` says which bone moves that triangle. Points go into each bone's own space
 * (putRigid's `space: "bone"`). Triangles are given counter-clockwise (the file's are) and come out clockwise in the
 * game's file, which putRigid does.
 */
function piecesOf(gun, bones, pose, rest, carrying, worldOf, boneOf) {
  const carry = bones.indexOf(carrying);
  if (carry < 0) throw new Error(`piecesOf: no bone ${carrying}`);
  const groups = new Map();
  for (const tri of gun) {
    const boneName = boneOf(tri);
    const bone = bones.indexOf(boneName);
    if (bone < 0) throw new Error(`piecesOf: no bone ${boneName}`);
    const key = `${boneName}|${tri[0].part}|${tri[0].mat}`;
    const group = groups.get(key) ?? { bone: boneName, name: key, tris: [] };
    const to = bone === carry ? null : mul34(inverse34(rest[bone]), rest[carry]);
    const p = tri.map((c) => {
      const inCarry = apply34(inverse34(pose[carry]), worldOf(c));
      return to ? apply34(to, inCarry) : inCarry;
    });
    group.tris.push(p.map((pt, i) => ({ p: pt, uv: tri[i].uv })));
    groups.set(key, group);
  }
  // each run of triangles that share a point is a piece: a piece's faces are smoothed among themselves only, and
  // putRigid needs each piece under 2048 points and normals
  const out = [];
  for (const group of groups.values())
    for (const [i, tris] of componentsOf(group.tris).entries())
      out.push({ bone: group.bone, name: `${group.name}#${i}`, tris });
  return out;
}

/** The runs of triangles that share a point, largest first. */
function componentsOf(tris) {
  const key = (p) => p.map((v) => v.toFixed(4)).join();
  const leader = new Map();
  const root = (k) => {
    let at = k;
    while (leader.get(at) !== at) at = leader.get(at);
    leader.set(k, at);
    return at;
  };
  for (const tri of tris) for (const c of tri) leader.set(key(c.p), key(c.p));
  for (const tri of tris) for (const j of [1, 2]) leader.set(root(key(tri[j].p)), root(key(tri[0].p)));
  const groups = new Map();
  for (const tri of tris) {
    const k = root(key(tri[0].p));
    (groups.get(k) ?? groups.set(k, []).get(k)).push(tri);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** A model's triangles as the renderer poses them: { tex, c: [{ p, bone }] } at the first frame. */
const modelTris = (src) => posed(src, { seq: 0, frame: 0 }).tris;
const boxOf = (points) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); }
  return { mn, mx };
};
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The gun meshes of a donor's first submodel: all but the arms. */
function gunMeshes(src) {
  const info = readMdl(src);
  const model = info.bodyparts[0].models[0];
  return model.meshes.map((mesh, k) => ({ mesh, k })).filter(({ mesh }) => mesh.numtris && !HANDS.test(mesh.texture.name));
}

/** Where the rifle's trigger is, in the rifle's own space, and its other landmarks. */
const landmark = (lod, key) => data.lods[lod].centroids[key];

// ── first person ─────────────────────────────────────────────────────────────────────────────────────
function viewModel() {
  const src = readFileSync(`${TS}v_m4.mdl`);
  const model = readMdl(src);
  const rest = restPose(src);
  const { pose } = posed(src, { seq: 0, frame: 0 });
  const grill = model.bones.indexOf("grill");
  const trigger = landmark("v", "Trigger|Trigger");
  const T = [
    pose[grill][0][3] - trigger[0] + V_SHIFT[0],
    pose[grill][1][3] - trigger[1] + V_SHIFT[1],
    pose[grill][2][3] - trigger[2] + V_SHIFT[2],
  ];
  // the optic is flattened against the receiver: about the lowest point of its own body
  let opticBase = Infinity;
  for (const tri of data.lods.v.tris) if (tri[0].part === "Optic") for (const c of tri) opticBase = Math.min(opticBase, c.p[2]);
  const flat = (c) => (["Optic", "Optic.001", "Reticles"].includes(c.part) ? opticBase + (c.p[2] - opticBase) * V_OPTIC_FLAT : c.p[2]);
  const partBone = { Magazine: "car", Trigger: "grill", Slide: "ott" };
  const place = (c) => [c.p[0] + T[0], c.p[1] + T[1], flat(c) + T[2]];
  const boneFor = (tri) => partBone[tri[0].part] ?? "m4";
  const pieces = piecesOf(data.lods.v.tris.filter((t) => !isGlass(t)), model.bones, pose, rest, "m4", place, boneFor);
  const glass = piecesOf(data.lods.v.tris.filter(isGlass), model.bones, pose, rest, "m4", place, boneFor);

  // the M4A1's gun meshes go; its arms stay. Its silencer, flash hider, laser and scope bodies are emptied too: this
  // rifle has no attachments and its own optic.
  let bare = src;
  for (const { k } of gunMeshes(src)) bare = emptyMesh(bare, { bodypart: 0, model: 0, mesh: k });
  for (let bp = 1; bp < model.bodyparts.length; bp++)
    for (let m = 1; m < model.bodyparts[bp].models.length; m++) bare = clearModel(bare, { bodypart: bp, model: m });
  bare = pruneVerts(bare);
  const first = putRigid(bare, { pieces, texture, space: "bone", name: "laser", smooth: 40 });
  const { mdl, bodyparts, report } = putRigid(first.mdl, { pieces: glass, texture: lensTexture, space: "bone", name: "lens", smooth: 40 });
  console.log("v_ bodyparts:", first.bodyparts.length + bodyparts.length, JSON.stringify(report));
  return mdl;
}

// ── in another player's hands ─────────────────────────────────────────────────────────────────────────
let P_T = null;
function playerModel() {
  const src = readFileSync(`${TS}p_m4.mdl`);
  const model = readMdl(src);
  const rest = restPose(src);
  const { pose } = posed(src, { seq: 0, frame: 0 });
  // where the M4A1's trigger is in this model: its place in the first person model's frame, carried over to this
  // model's frame (the two models' frames are one mesh)
  const vsrc = readFileSync(`${TS}v_m4.mdl`);
  const vinfo = readMdl(vsrc);
  const vTris = modelTris(vsrc).filter((t) => /m4frame/i.test(t.tex?.name ?? t.tex));
  const vFrame = boxOf(vTris.flatMap((t) => t.c.map((c) => c.p)));
  const vgrill = posed(vsrc, { seq: 0, frame: 0 }).pose[vinfo.bones.indexOf("grill")];
  const rel = sub3([vgrill[0][3], vgrill[1][3], vgrill[2][3]], vFrame.mn);
  const pFrame = boxOf(modelTris(src).filter((t) => /m4frame/i.test(t.tex?.name ?? t.tex)).flatMap((t) => t.c.map((c) => c.p)));
  const trigWorld = add3(pFrame.mn, rel);
  const trigger = landmark("p", "Trigger|Trigger");
  const T = sub3(trigWorld, trigger);
  P_T = T;
  const place = (c) => [c.p[0] + T[0], c.p[1] + T[1], c.p[2] + T[2]];
  const hand = () => "Bip01 DX Mano";
  const pieces = piecesOf(data.lods.p.tris.filter((t) => !isGlass(t)), model.bones, pose, rest, "Bip01 DX Mano", place, hand);
  const glass = piecesOf(data.lods.p.tris.filter(isGlass), model.bones, pose, rest, "Bip01 DX Mano", place, hand);
  const bare = clearModel(src, { bodypart: 0, model: 0 });
  const first = putRigid(bare, { pieces, texture, space: "bone", name: "laser", smooth: 40 });
  const { mdl, bodyparts, report } = putRigid(first.mdl, { pieces: glass, texture: lensTexture, space: "bone", name: "lens", smooth: 40 });
  console.log("p_ bodyparts:", first.bodyparts.length + bodyparts.length, JSON.stringify(report));
  return mdl;
}

// ── lying in the world ───────────────────────────────────────────────────────────────────────────────
function worldModel() {
  const src = readFileSync(`${TS}w_m4.mdl`);
  const model = readMdl(src);
  const rest = restPose(src);
  const { pose } = posed(src, { seq: 0, frame: 0 });
  // the M4A1 lies on its side, its top to -y: the rifle is turned on to its side the same way
  const turn = (c) => [c.p[0], -c.p[2], c.p[1]];
  const mine = boxOf(data.lods.w.tris.flatMap((tri) => tri.map(turn)));
  const donor = boxOf(modelTris(src).flatMap((t) => t.c.map((c) => c.p)));
  const T = [
    (donor.mn[0] + donor.mx[0]) / 2 - (mine.mn[0] + mine.mx[0]) / 2,
    donor.mx[1] - mine.mx[1],
    donor.mn[2] - mine.mn[2],
  ];
  const place = (c) => add3(turn(c), T);
  const joint = () => "joint1";
  const pieces = piecesOf(data.lods.w.tris.filter((t) => !isGlass(t)), model.bones, pose, rest, "joint1", place, joint);
  const glass = piecesOf(data.lods.w.tris.filter(isGlass), model.bones, pose, rest, "joint1", place, joint);
  const bare = clearModel(src, { bodypart: 0, model: 0 });
  const first = putRigid(bare, { pieces, texture, space: "bone", name: "laser", smooth: 40 });
  const { mdl, bodyparts, report } = putRigid(first.mdl, { pieces: glass, texture: lensTexture, space: "bone", name: "lens", smooth: 40 });
  console.log("w_ bodyparts:", first.bodyparts.length + bodyparts.length, JSON.stringify(report));
  return mdl;
}

/** The muzzle: the attachments the donor has (muzzle, shell port, ...) keep their numbers; the muzzle's place is the rifle's. */
function withMuzzle(mdl, name, world) {
  const info = readMdl(mdl);
  const { pose } = posed(mdl, { seq: 0, frame: 0 });
  const list = attachments(mdl);
  if (!list.length) return mdl;
  const first = list[0];
  const inBone = apply34(inverse34(pose[first.bone]), world);
  list[0] = { ...first, pos: inBone };
  console.log(`  ${name} muzzle attachment 0 on ${info.bones[first.bone]}: ${first.pos.map((v) => v.toFixed(2))} -> ${inBone.map((v) => v.toFixed(2))}`);
  return setAttachments(mdl, list);
}

/** The point on the rifle that is its muzzle, in the model's space: the front of the barrel's mid height and width. */
function muzzleOf(lod, place) {
  const pts = data.lods[lod].tris.flatMap((tri) => tri.map((c) => c.p));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const front = pts.filter((p) => p[0] > maxX - 0.6);
  const mean = (a) => front.reduce((s, p) => s + p[a], 0) / front.length;
  return place([maxX, mean(1), mean(2)]);
}

let v = viewModel();
let p = playerModel();
let w = worldModel();
// the attachments: the muzzle of the first person and the third person models
{
  const vsrc = readFileSync(`${TS}v_m4.mdl`);
  const vinfo = readMdl(vsrc);
  const grill = posed(vsrc, { seq: 0, frame: 0 }).pose[vinfo.bones.indexOf("grill")];
  const trigV = landmark("v", "Trigger|Trigger");
  const TV = [grill[0][3] - trigV[0] + V_SHIFT[0], grill[1][3] - trigV[1] + V_SHIFT[1], grill[2][3] - trigV[2] + V_SHIFT[2]];
  v = withMuzzle(v, "v_", muzzleOf("v", (m) => add3(m, TV)));
}
p = withMuzzle(p, "p_", muzzleOf("p", (m) => add3(m, P_T)));
v = setModelName(v, "v_laserrifle.mdl");
p = setModelName(p, "p_laserrifle.mdl");
w = setModelName(w, "w_laserrifle.mdl");
writeFileSync(`${OUT}/v_laserrifle.mdl`, v);
writeFileSync(`${OUT}/p_laserrifle.mdl`, p);
writeFileSync(`${OUT}/w_laserrifle.mdl`, w);
console.log("sizes", v.length, p.length, w.length);
const save = (name, img) => writeFileSync(`${OUT}/${name}`, png(img.width, img.height, img.rgba));
save("v_idle.png", render(v, { view: "first", seq: 0, frame: 0, width: 900, height: 650 }));
save("v_shoot.png", render(v, { view: "first", seq: 3, frame: 8, width: 900, height: 650 }));
save("v_stock.png", render(v, { view: "first", seq: 15, frame: 12, width: 900, height: 650 }));
save("p_side.png", render(p, { view: "side", pitch: 0, seq: 0, frame: 0, width: 900, height: 600, zoom: 1.2 }));
save("w_sheet.png", sheet(w, { size: 480 }));
console.log("done");
