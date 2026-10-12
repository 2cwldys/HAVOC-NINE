// SMAK checked against itself, with no game files:   node test/selftest.mjs      (npm test)
// A model is made from nothing, then read, changed in every way the kit can change one, checked and drawn.
// Run it first on a new machine: if it passes, Node is new enough and the kit is whole.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as S from "../src/index.mjs";
import { sword, taper } from "../kits/swordkit.mjs";
import { axe } from "../kits/axekit.mjs";
import { blunt } from "../kits/bluntkit.mjs";
import { bow } from "../kits/bowkit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), tmp = mkdtempSync(join(tmpdir(), "smak-"));
let passed = 0; const failed = [];
const test = (name, fn) => { try { fn(); passed++; console.log(`ok    ${name}`); } catch (e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const sure = (cond, what) => { if (!cond) throw new Error(what); };
const near = (a, b, eps, what) => sure(Math.abs(a - b) <= eps, `${what}: ${a} against ${b}`);
const poseGap = (A, B) => { let d = 0; A.forEach((m, i) => m.forEach((r, j) => r.forEach((v, k) => { d = Math.max(d, Math.abs(v - B[i][j][k])); }))); return d; };

// ── a model from nothing: a knife on a hand bone, with an arm bone before it ──
const piece = sword({ seed: 3, pommel: { profile: [[0, 0.3], [0.5, 0.6], [1, 0.45]] }, grip: { profile: [[0.9, 0.5], [5, 0.55]] }, guard: { x: 5.2, sections: [[-1.2, 0.2, 0.15], [0, 0.3, 0.3], [1.2, 0.2, 0.15]] }, blade: { x0: 5.5, x1: 16, half: taper(0.9, 0.8), section: "single" } });
const texture = S.indexed(S.shrink(piece.image, 4), "knife.bmp");
const bones = [{ name: "arm", parent: -1, pos: [0, 0, 10] }, { name: "hand", parent: 0, pos: [8, 0, 0], rot: [0, 0, 0.3] }];
const still = bones.map((b) => [...b.pos, ...(b.rot ?? [0, 0, 0])]);
const wave = Array.from({ length: 12 }, (_, f) => [still[0], [8, 0, 0, 0, 0.4 * Math.sin(f / 11 * Math.PI), 0.3]]);
let mdl;
test("buildMdl writes a model that reads back", () => {
  mdl = S.buildMdl({ name: "knife.mdl", bones, bodyparts: [{ name: "body", models: [{ name: "knife", meshes: [{ tris: piece.tris.map((t) => t.map((c) => ({ ...c, bone: "hand" }))), texture }] }] }], sequences: [{ name: "idle", fps: 10, loops: true, frames: [still] }, { name: "wave", fps: 24, loops: false, frames: wave }] });
  const info = S.readMdl(mdl), seqs = S.sequences(mdl);
  sure(info.bones.join() === "arm,hand", "bones"); sure(info.textures[0].width === 256 && info.textures[0].name === "knife.bmp", "texture");
  sure(info.bodyparts[0].models[0].meshes[0].numtris === piece.tris.length, "triangles"); sure(seqs.length === 2 && seqs[1].frames === 12 && seqs[1].fps === 24 && seqs[0].loops, "animations");
});
test("check passes it for both engines", () => { for (const e of ["goldsrc", "xash"]) { const r = S.check(mdl, e); sure(!r.errors.length, r.errors.join("; ")); sure(!r.warnings.length, r.warnings.join("; ")); } });
test("check refuses a broken one", () => { sure(S.check(mdl.subarray(0, mdl.length - 40)).errors.length > 0, "a cut file passed"); sure(S.check(Buffer.from("not a model at all")).errors.length > 0, "junk passed"); });
test("a pose read back is the pose written", () => {
  near(poseGap(S.poseAt(mdl, 1, 5), S.boneMatrices(bones, wave[5])), 0, 1e-3, "frame 5"); near(poseGap(S.poseOf(mdl, wave[7]), S.boneMatrices(bones, wave[7])), 0, 1e-6, "poseOf");
  near(S.readSequence(mdl, "wave").frames[5][1][4], wave[5][1][4], 1e-4, "frameValues");
});
test("the mesh is where it was put, facing outwards", () => {
  const m = S.readMdl(mdl).bodyparts[0].models[0], tris = S.readMesh(mdl, m, m.meshes[0]), rest = S.restPose(mdl);
  const xs = tris.flat().map((c) => S.apply34(rest[c.bone], c.p)[0]); near(Math.max(...xs) - Math.min(...xs), 16, 0.01, "its length");
  const out = tris.filter((t) => S.dot(S.cross(S.sub(t[1].p, t[0].p), S.sub(t[2].p, t[0].p)), t[0].n) * S.FRONT > 0).length; sure(out > tris.length * 0.95, `${out} of ${tris.length} face outwards`);
});

// ── pictures ──
test("PNG and BMP files go out and come back", () => {
  const rgba = S.rgbaOf(texture), back = S.unpng(S.png(texture.width, texture.height, rgba)); sure(Buffer.from(back.rgba).equals(Buffer.from(rgba)), "png");
  const b = S.unbmp(S.bmp(texture)); sure(Buffer.from(b.pixels).equals(Buffer.from(texture.pixels)) && Buffer.from(b.palette).equals(Buffer.from(texture.palette)), "bmp");
  const t = S.textureFrom(S.bmp(texture), "x.bmp"); sure(Buffer.from(t.pixels).equals(Buffer.from(texture.pixels)), "an 8-bit BMP keeps its palette");
});
test("a picture with holes becomes a masked texture", () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(200); for (let i = 0; i < 64; i++) rgba[i * 4 + 3] = 0;
  const t = S.masked({ width: 16, height: 16, rgba }, "holes.bmp"); sure(t.flags === 64 && t.pixels[0] === 255 && t.pixels[200] !== 255, "holes");
});
test("replaceTexture: same size in place, another size at the end", () => {
  const old = S.textureOf(mdl, "knife.bmp"); sure(S.replaceTexture(mdl, 0, old).equals(mdl), "the same picture changed the file");
  const half = S.indexed(S.shrink(piece.image, 8), "knife.bmp"), out = S.replaceTexture(mdl, 0, half), info = S.readMdl(out);
  sure(info.textures[0].width === 128, "size"); sure(!S.check(out).errors.length, S.check(out).errors.join("; "));
  const m = info.bodyparts[0].models[0], uv = S.readMesh(out, m, m.meshes[0]).flat(); sure(Math.max(...uv.map((c) => c.s)) <= 128, "corners were not moved to the smaller picture");
});

// ── meshes ──
test("swapMesh lays a new piece over the old one", () => {
  const club = blunt({ seed: 5, haft: { profile: [[0, 0.6], [14, 0.7]] }, parts: [{ profile: [[13, 0.7], [14, 1.6], [18, 1.6], [19, 0.6]], metal: "steel" }] });
  const { mdl: out, report } = S.swapMesh(mdl, { body: 0, piece: club, texture: S.indexed(S.shrink(club.image, 4), "club.bmp") });
  sure(report.now === club.tris.length && report.bone === "hand", JSON.stringify(report)); near(report.scale, 16 / 19, 0.02, "stretched to the old length");
  sure(!S.check(out).errors.length, S.check(out).errors.join("; ")); sure(S.readMdl(out).textures.length === 2, "its texture was added");
  const own = S.swapMesh(mdl, { body: 0, piece: club, texture: S.indexed(S.shrink(club.image, 4), "club.bmp"), size: "own" }).report; near(own.scale, 1, 1e-9, "kept its own size");
});
test("addModel, addMesh, emptyMesh, filterMesh, retexture, addBones", () => {
  let out = S.addModel(mdl, 0, "second"); sure(S.readMdl(out).bodyparts[0].models.length === 2, "addModel");
  out = S.addMesh(out, { bodypart: 0, model: 0 }); sure(S.readMdl(out).bodyparts[0].models[0].meshes.length === 2, "addMesh");
  out = S.retexture(out, { bodypart: 0, model: 0, mesh: 0 }, { ...texture, name: "other.bmp" }); sure(S.readMdl(out).textures.length === 2, "retexture");
  out = S.filterMesh(out, { bodypart: 0, model: 0, mesh: 0 }, (b) => b[0] === 1); out = S.addBones(out, [{ name: "tip", parent: 1, pos: [16, 0, 0] }]);
  sure(S.bones(out).length === 3 && S.bones(out)[2].name === "tip", "addBones"); near(poseGap(S.poseAt(out, 1, 5).slice(0, 2), S.poseAt(mdl, 1, 5)), 0, 1e-6, "the old bones moved");
  sure(!S.check(out).errors.length, S.check(out).errors.join("; "));
  sure(S.readMdl(S.emptyMesh(out, { bodypart: 0, model: 0, mesh: 0 })).bodyparts[0].models[0].meshes[0].numtris === 0, "emptyMesh");
});

// ── animations ──
test("replaceSequence keeps the others, and widens a bone's scale when it must", () => {
  const same = S.replaceSequence(mdl, "wave", { frames: S.readSequence(mdl, "wave").frames }); near(poseGap(S.poseAt(same, 1, 9), S.poseAt(mdl, 1, 9)), 0, 0, "the same frames");
  const far = wave.map((f, t) => [f[0], [8 + 400 * t, 0, 0, 0, f[1][4] + 2, 0.3]]), out = S.replaceSequence(mdl, 1, { frames: far, fps: 15, loops: true }), s = S.sequences(out)[1];
  sure(s.fps === 15 && s.loops && s.frames === 12, "fps, loops, frames"); near(poseGap(S.poseAt(out, 1, 11), S.boneMatrices(bones, far[11])), 0, 0.2, "a long way off"); near(poseGap(S.poseAt(out, 0, 0), S.poseAt(mdl, 0, 0)), 0, 0.2, "idle after the scale widened");
  sure(!S.check(out).errors.length, S.check(out).errors.join("; "));
});
test("addSequence goes after the others, with its events", () => {
  const out = S.addSequence(mdl, { name: "stab", fps: 30, frames: wave.slice().reverse(), events: [{ frame: 3, event: 5004, options: "weapons/knife.wav" }] }), seqs = S.sequences(out);
  sure(seqs.map((s) => s.name).join() === "idle,wave,stab", "order"); near(poseGap(S.poseAt(out, 2, 0), S.poseAt(mdl, 1, 11)), 0, 1e-6, "its frames"); near(poseGap(S.poseAt(out, 1, 4), S.poseAt(mdl, 1, 4)), 0, 0, "the others");
  const ev = S.events(out, "stab"); sure(ev.length === 1 && ev[0].frame === 3 && ev[0].options === "weapons/knife.wav", "events"); sure(!S.check(out).errors.length, S.check(out).errors.join("; "));
  sure(S.events(S.setEvents(out, "stab", []), "stab").length === 0, "setEvents to none");
});
test("a long animation of many frames packs and reads back", () => {
  const long = Array.from({ length: 700 }, (_, f) => [still[0], [8, 0, f < 300 ? 0 : 1, 0, Math.sin(f / 20), 0.3]]), out = S.addSequence(mdl, { name: "long", frames: long });
  for (const f of [0, 254, 255, 299, 300, 511, 699]) near(poseGap(S.poseAt(out, 2, f), S.boneMatrices(bones, long[f])), 0, 2e-3, `frame ${f}`);
});
test("textures kept in another file are put inside", () => {
  const bare = Buffer.from(mdl); bare.writeInt32LE(0, 180);
  const out = S.withTextures(bare, mdl), a = S.textureOf(out, 0), b = S.textureOf(mdl, 0); sure(Buffer.from(a.pixels).equals(Buffer.from(b.pixels)) && a.name === b.name, "the picture"); sure(!S.check(out).errors.length, S.check(out).errors.join("; "));
});

// ── drawing ──
const inked = (img, bg = [58, 62, 70]) => { let n = 0; for (let i = 0; i < img.width * img.height; i++) if (img.rgba[i * 4] !== bg[0] || img.rgba[i * 4 + 1] !== bg[1] || img.rgba[i * 4 + 2] !== bg[2]) n++; return n / (img.width * img.height); };
test("render, sheet, strip and uvMap draw something", () => {
  const one = S.render(mdl, { seq: "wave", frame: 6 }); sure(one.width === 512 && inked(one) > 0.01, `render drew ${inked(one)}`);
  const top = S.render(mdl, { pitch: 90 }); sure(inked(top) > 0.005, "from above");
  sure(inked(S.render(mdl, { view: "first", pose: S.boneMatrices([{ parent: -1, pos: [30, 0, -6] }, { parent: 0 }]) })) > 0.001, "first person");
  const six = S.sheet(mdl, { size: 128 }); sure(six.width === 384 && six.height === 256, "sheet"); const st = S.strip(mdl, { seq: 1, count: 4, width: 96, height: 96 }); sure(st.width === 384, "strip");
  const uv = S.uvMap(mdl, 0); sure(uv.triangles === piece.tris.length && uv.width === 256 * uv.scale, "uvMap");
});
test("the kits make pieces", () => {
  const a = axe({ seed: 2, haft: { profile: [[0, 0.5], [20, 0.5]] }, bits: [{ x0: 15, x1: 19, edges: (k) => [0.4, 3 + k], thick: 0.4 }] }); sure(a.tris.length > 50 && a.haft && a.image.width === 1024, "axe");
  const b = bow({ seed: 1, L: 20, centre: (x) => 3 - x * x / 130, thick: () => 0.4, wide: () => 0.5, paint: (q) => [0.4 * q.light, 0.3 * q.light, 0.2 * q.light], string: { x: 19, drop: 0.2 } }); sure(b.tris.length > 50 && b.rig === "nearest", "bow");
});
// ── by place ──
test("paint colours the model by place, and says what is shared", () => {
  const surf = S.surface(mdl); sure(surf.length === piece.tris.length && Math.abs(Math.hypot(...surf[0].n) - 1) < 1e-6, "surface");
  const far = surf.reduce((m, q) => Math.max(m, q.p[0]), -1e9), tip = S.spot(surf, [far + 5, 0, 10]); sure(tip && tip.p[0] > far - 1.5, "spot");
  let calls = 0; const { mdl: red, shared } = S.paint(mdl, ({ p, rgb }) => { calls++; return p[0] > far - 3 ? [1, 0, 0] : rgb; });
  sure(calls > 500 && "knife.bmp" in shared, `${calls} pixels`); sure(red.length === mdl.length, "same size: written in place"); sure(!S.check(red).errors.length, "check");
  const reds = (b) => { const t = S.textureOf(b, 0); let n = 0; for (const i of t.pixels) if (t.palette[i * 3] > 200 && t.palette[i * 3 + 1] < 60) n++; return n; };
  sure(reds(red) > 20 && reds(mdl) === 0, `${reds(red)} red pixels`);
  sure(S.paint(mdl, () => undefined).mdl.equals(mdl), "nothing returned changes nothing");
  near(S.workshop.fbm3([1, 2, 3], 0.5, 4), S.workshop.fbm3([1, 2, 3], 0.5, 4), 0, "fbm3"); const r = S.workshop.seeded(5), r2 = S.workshop.seeded(5); sure(r() === r2() && r() < 1, "seeded");
});
test("pieces finds the loose parts and dropTriangles takes one off", () => {
  const P = S.pieces(mdl); sure(P.list.length >= 3 && P.list.reduce((n, q) => n + q.tris, 0) === piece.tris.length, `${P.list.length} pieces`);
  const big = P.list.reduce((m, q) => (q.tris > m.tris ? q : m)), { mdl: cut, gone } = S.dropTriangles(mdl, (t) => P.of(t) === big.id);
  sure(gone === big.tris && S.posed(cut).tris.length === piece.tris.length - big.tris, `${gone} gone`); sure(!S.check(cut).errors.length, "check");
  sure(S.dropTriangles(mdl, () => false).gone === 0, "none");
  near(poseGap(S.poseAt(cut, 1, 6), S.poseAt(mdl, 1, 6)), 0, 1e-9, "the animation is untouched");
});
test("graft moves a mesh to another model by its bones' names", () => {
  // the same bones under other numbers, with a small thing on the hand
  const M = S.workshop.shape(64, 64); M.lathe([[9, 0.6], [11, 0.6]], { x: 2, y: 2, w: 60, h: 60 }, { sides: 5, caps: [true, true] });
  const ring = S.indexed({ width: 64, height: 64, rgb: new Uint8Array(64 * 64 * 3).fill(200) }, "ring.bmp");
  const other = S.buildMdl({ name: "ring.mdl", bones: [{ name: "spare", parent: -1 }, { name: "arm", parent: -1, pos: [0, 0, 10] }, { name: "hand", parent: 1, pos: [8, 0, 0], rot: [0, 0, 0.3] }], bodyparts: [{ name: "body", models: [{ name: "ring", meshes: [{ tris: M.tris.map((t) => t.map((c) => ({ ...c, bone: "hand" }))), texture: ring }] }] }] });
  const both = S.graft(mdl, other, (me) => me.texture.name === "ring.bmp"), info = S.readMdl(both);
  sure(info.textures.length === 2 && info.bodyparts[0].models[0].meshes.length === 2, "one more mesh and texture"); sure(!S.check(both).errors.length, S.check(both).errors.join("; "));
  const added = S.readMesh(both, info.bodyparts[0].models[0], info.bodyparts[0].models[0].meshes[1]); sure(added.length === M.tris.length && added.every((t) => t.every((c) => c.bone === 1)), "on the bone called hand");
  const where = (b) => S.box(S.posed(b, { seq: null }).tris.filter((t) => t.tex.name === "ring.bmp").flatMap((t) => t.c.map((c) => c.p))); near(where(both).mx[2], where(other).mx[2], 1e-3, "in the same place");
  let threw = false; try { S.graft(S.buildMdl({ name: "x.mdl", bodyparts: [{ name: "b", models: [{ name: "m", meshes: [{ tris: piece.tris, texture }] }] }] }), other, () => true); } catch { threw = true; } sure(threw, "a missing bone is refused");
  const two = S.lineup([["a", mdl], ["b", both]], { width: 80, height: 100 }); sure(two.width === 320 && two.height === 100, "lineup");
});
// ── a picture's islands: a sheet that stands alone, and a box whose six faces each have their own patch of the picture ──
const M2 = S.workshop.shape(128, 64), corner = (i) => [i & 1 ? 26 : 20, i & 2 ? 3 : -3, i & 4 ? 6 : 0];
M2.quad(M2.V([0, -5, 0], [2, 2]), M2.V([0, 5, 0], [42, 2]), M2.V([0, 5, 10], [42, 42]), M2.V([0, -5, 10], [2, 42]), [-1, 0, 5]);
[[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]].forEach((f, n) => { const x = 50 + (n % 3) * 20, y = 2 + Math.floor(n / 3) * 20; M2.quad(M2.V(corner(f[0]), [x, y]), M2.V(corner(f[1]), [x + 16, y]), M2.V(corner(f[2]), [x + 16, y + 16]), M2.V(corner(f[3]), [x, y + 16]), [23, 0, 3]); });
// its picture: a chequer of single dots under the sheet (white where x + y is even), red everywhere else
const chequer = new Uint8Array(128 * 64 * 3); for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) chequer.set(x >= 43 ? [255, 0, 0] : (x + y) % 2 ? [0, 0, 0] : [255, 255, 255], (y * 128 + x) * 3);
const flat = S.buildMdl({ name: "flat.mdl", bodyparts: [{ name: "body", models: [{ name: "flat", meshes: [{ tris: M2.tris, texture: S.indexed({ width: 128, height: 64, rgb: chequer }, "flat.bmp") }] }] }] });
const dotOf = (b, x, y, name = "flat.bmp") => { const t = S.textureOf(b, name), i = t.pixels[y * t.width + x]; return [...t.palette.subarray(i * 3, i * 3 + 3)]; };
let sheetIsland = -1, faceIslands = [];
test("uvIslands finds a picture's islands, their borders and which of them are open", () => {
  const I = S.uvIslands(flat), sheet = I.list.find((e) => e.box[0] === 2); sure(I.list.length === 7 && sheet, `${I.list.length} islands`); sheetIsland = sheet.id; faceIslands = I.list.filter((e) => e !== sheet).map((e) => e.id);
  sure(sheet.tris === 2 && sheet.box.join() === "2,2,42,42" && sheet.tex === "flat.bmp" && sheet.bones.join() === "root" && sheet.uses.length === 1 && sheet.uses[0].body === 0 && sheet.uses[0].name === "flat", JSON.stringify(sheet));
  sure(sheet.border === 160 && sheet.open === 160, `the sheet's border is ${sheet.border}, ${sheet.open} of it open`); sure(sheet.n[0] > 0.99 && sheet.mid.join() === "0,0,5", `it faces ${sheet.n} at ${sheet.mid}`);
  for (const e of I.list) if (e !== sheet) sure(e.tris === 2 && e.border === 64 && e.open === 0, `a face of the box: border ${e.border}, open ${e.open}`);
  const tris = S.posed(flat).tris; sure(tris.every((t) => I.of(t) !== undefined) && I.of(tris[0]) === sheet.id && new Set(tris.map((t) => I.of(t))).size === 7, "of");
  const K = S.uvIslands(mdl); sure(K.list.length >= 3 && K.list.reduce((n, e) => n + e.tris, 0) === piece.tris.length && K.list.every((e) => e.bones.join() === "hand"), `the knife: ${K.list.length} islands`);
  const map = S.islandMap(flat, "flat.bmp"); sure(map.width === 128 * map.scale && map.islands.length === 7, "islandMap"); sure(S.islandMap(flat, 0, { body: 0, scale: 2 }).width === 256, "islandMap of one body");
  sure(S.dropTriangles(flat, (t) => I.of(t) === sheet.id).gone === 2, "dropTriangles by island");
});
test("paint tells its function where it is, and paints only the islands it is told", () => {
  const I = S.uvIslands(flat), seen = new Map(); let bad = "", deep = 0;
  S.paint(flat, (q) => {
    seen.set(q.island, (seen.get(q.island) ?? 0) + 1); const e = I.list[q.island];
    if (q.bone !== "root" || q.boneIndex !== 0 || q.body !== 0 || q.where.mesh !== 0 || q.tex !== "flat.bmp" || I.of(q) !== q.island) bad = "bone, body, where, tri or island";
    if (q.u < e.box[0] - 2 || q.u > e.box[2] + 2 || q.v < e.box[1] - 2 || q.v > e.box[3] + 2 || q.u % 1 !== 0.5) bad = `u, v: ${q.u} ${q.v} in island ${q.island}`;
    if (q.island === sheetIsland) { deep = Math.max(deep, q.edge); if (q.open !== q.edge || Math.abs(q.per - 0.25) > 1e-6) bad = `the sheet: edge ${q.edge}, open ${q.open}, ${q.per} units a pixel`; } else if (q.open !== Infinity || !(q.edge >= 0 && q.edge < 10)) bad = `the box: edge ${q.edge}, open ${q.open}`;
  });
  sure(!bad, bad); sure(seen.size === 7 && seen.get(sheetIsland) > 1600, `${seen.size} islands seen`); near(deep, 19.5, 1e-9, "the middle of the sheet from its border");
  let calls = 0; const one = S.paint(flat, ({ island, edge }) => { calls++; if (island !== sheetIsland) throw new Error("another island was painted"); return edge < 3 ? [0, 0, 1] : [0, 1, 0]; }, { islands: [sheetIsland] }).mdl;
  sure(calls === seen.get(sheetIsland), `${calls} calls`); sure(dotOf(one, 3, 20).join() === "0,0,255" && dotOf(one, 20, 20).join() === "0,255,0" && dotOf(one, 60, 10).join() === "255,0,0", `a line inside the border: ${dotOf(one, 3, 20)}, ${dotOf(one, 20, 20)}, and the box ${dotOf(one, 60, 10)}`);
  sure(S.paint(flat, () => [0, 0, 0], { islands: [] }).mdl.equals(flat), "no islands, nothing painted");
});
test("paint softens an edge, and several passes are cut to 256 colours once", () => {
  const hard = ({ u }) => (u > 20.25 ? [0, 0, 1] : undefined), plain = S.paint(flat, hard, { islands: [sheetIsland] }).mdl, soft = S.paint(flat, hard, { islands: [sheetIsland], soft: 4 }).mdl;
  sure(dotOf(plain, 20, 10).join() === "0,0,255" && dotOf(plain, 19, 10).join() === "0,0,0", "the staircase"); sure(dotOf(soft, 20, 10).join() === "64,64,255" && dotOf(soft, 19, 10).join() === "0,0,0" && dotOf(soft, 21, 10).join() === "0,0,255", `three quarters of the dot painted: ${dotOf(soft, 20, 10)}`);
  const many = ({ u, v }) => [u / 128, v / 64, ((u * v) % 7) / 7], count = (set) => ({ rgb }) => { set.add(rgb.join()); }, full = new Set(), cut = new Set();
  const both = S.paint(flat, [many, count(full)]), first = S.paint(flat, many); S.paint(first.mdl, count(cut));
  sure(full.size > 1000 && cut.size <= 256, `the second pass saw ${full.size} colours, and ${cut.size} when the first was cut before it`); sure(both.mdl.equals(first.mdl) && "flat.bmp" in both.shared, "a pass that changes nothing changed the result");
  const two = S.paint(flat, [{ fn: () => [0, 1, 0], islands: [sheetIsland] }, { fn: ({ rgb }) => [rgb[1], 0, 1], islands: faceIslands.slice(0, 1), soft: 2 }, ({ rgb, island }) => (island === sheetIsland ? [rgb[0], rgb[1], 1] : undefined)]).mdl;
  sure(dotOf(two, 20, 20).join() === "0,255,255" && dotOf(two, 58, 10).join() === "0,0,255" && dotOf(two, 78, 10).join() === "255,0,0", `each pass its own islands: ${dotOf(two, 20, 20)}, ${dotOf(two, 58, 10)}, ${dotOf(two, 78, 10)}`);
});
test("a pass reads the picture as it was before it, and blurs within an island", () => {
  let bad = 0; const moved = S.paint(flat, ({ u, v, at, rgb }) => { if (at(u, v).join() !== rgb.join()) bad++; return at(u + 1, v); }, { islands: [sheetIsland] }).mdl;
  sure(!bad && dotOf(moved, 10, 10).join() === "0,0,0" && dotOf(moved, 11, 10).join() === "255,255,255", "at");
  const smooth = S.paint(flat, ({ blur }) => blur(3), { islands: [sheetIsland] }).mdl, mid = dotOf(smooth, 20, 20), rim = dotOf(smooth, 41, 20);
  sure(Math.abs(mid[0] - 127) < 12 && mid[0] === mid[2], `the chequer smoothed to ${mid}`); sure(Math.abs(rim[0] - 127) < 25 && Math.abs(rim[0] - rim[2]) < 3, `at its rim, beside the red: ${rim}`);
  const twice = S.paint(flat, [({ island }) => (island === sheetIsland ? [1, 1, 1] : undefined), ({ blur, island }) => (island === sheetIsland ? blur(2) : undefined)]).mdl; sure(dotOf(twice, 20, 20).join() === "255,255,255", "a later pass blurs what the one before left");
});
test("copyBody: a body again, as a new body, wearing another texture", () => {
  const other = { ...texture, name: "second.bmp", palette: texture.palette.map((v) => 255 - v) }, out = S.copyBody(mdl, "knife", "knife2", other), info = S.readMdl(out), was = S.posed(mdl).tris, now = S.posed(out, { body: 1 }).tris;
  sure(info.bodyparts[0].models.map((m) => m.name).join() === "knife,knife2" && info.textures.map((t) => t.name).join() === "knife.bmp,second.bmp", "the new body and its texture"); sure(!S.check(out).errors.length, S.check(out).errors.join("; "));
  let gap = 0; was.forEach((t, i) => t.c.forEach((c, k) => { gap = Math.max(gap, Math.hypot(...S.sub(c.p, now[i].c[k].p)), Math.abs(c.u - now[i].c[k].u), Math.abs(c.v - now[i].c[k].v)); }));
  sure(now.length === was.length && gap < 1e-6 && now.every((t) => t.tex.name === "second.bmp") && S.posed(out).tris.every((t) => t.tex.name === "knife.bmp"), `the same shape in the other texture (${gap} apart)`);
  near(poseGap(S.poseAt(out, 1, 6), S.poseAt(mdl, 1, 6)), 0, 1e-9, "the animation is untouched");
  const same = S.copyBody(mdl, 0, "again", "knife.bmp"); sure(S.readMdl(same).textures.length === 1 && S.posed(same, { body: 1 }).tris.every((t) => t.tex.name === "knife.bmp"), "by number, in a texture the file has");
  const small = S.copyBody(mdl, 0, "small", { name: "small.bmp", ...S.shrink(piece.image, 8) }), uv = S.posed(small, { body: 1 }).tris.flatMap((t) => t.c); sure(S.readMdl(small).textures[1].width === 128 && Math.max(...uv.map((c) => c.u)) <= 128, "an image of another size: the corners follow");
  sure(S.uvIslands(out).list.filter((e) => e.tex === "knife.bmp").every((e, i) => e.id === S.uvIslands(mdl).list[i].id && e.tris === S.uvIslands(mdl).list[i].tris), "the islands of the old body keep their ids");
  let threw = false; try { S.copyBody(mdl, "nothing", "x", "knife.bmp"); } catch { threw = true; } sure(threw, "a body that is not there is refused");
});
test("the command line lists the islands, and the pieces of one body", () => {
  const file = join(tmp, "two.mdl"), cli = join(HERE, "../bin/smak.mjs"), run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: "utf8" }), count = (text) => Number(/^(\d+) (pieces|islands)/m.exec(text)[1]);
  writeFileSync(file, S.copyBody(mdl, 0, "again", { ...texture, name: "second.bmp" }));
  const all = count(run("pieces", file)), one = run("pieces", file, "--body", "1"); sure(/pieces of body 1,/.test(one) && count(one) * 2 === all && /second\.bmp/.test(one) && !/knife\.bmp/.test(one), `${count(one)} pieces of body 1, ${all} in all`);
  const isl = run("islands", file, "-o", join(tmp, "isl")); sure(count(isl) === S.uvIslands(mdl).list.length * 2 && existsSync(join(tmp, "isl/islands_knife.png")) && existsSync(join(tmp, "isl/islands_second.png")), "islands");
  sure(count(run("islands", file, "--body", "1")) * 2 === count(isl) && count(run("islands", file, "--texture", "knife.bmp")) * 2 === count(isl), "islands of one body, and of one texture");
});
test("the command line runs", () => {
  const file = join(tmp, "knife.mdl"), cli = join(HERE, "../bin/smak.mjs"), run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: "utf8" });
  writeFileSync(file, mdl);
  sure(/ANIMATIONS \(2\)/.test(run("info", file)), "info"); sure(/fit for goldsrc/.test(run("check", file)), "check"); sure(JSON.parse(run("info", file, "--json")).bones.length === 2, "info --json");
  run("sheet", file, "-o", join(tmp, "sheet.png")); run("strip", file, "--seq", "wave", "-o", join(tmp, "strip.png")); run("textures", file, "-o", join(tmp, "tex")); run("uv", file, "-o", join(tmp, "uv"));
  sure(existsSync(join(tmp, "sheet.png")) && existsSync(join(tmp, "tex/00_knife.png")) && existsSync(join(tmp, "uv/uv_knife.png")), "pictures");
  run("retexture", file, "knife.bmp", join(tmp, "tex/00_knife.png"), "-o", join(tmp, "re.mdl")); sure(S.readMdl(readFileSync(join(tmp, "re.mdl"))).textures[0].width === 256, "retexture");
  sure(/pieces,/.test(run("pieces", file)), "pieces"); run("sequence", file, "wave", "-o", join(tmp, "wave.json")); run("sequence-set", file, "wave", join(tmp, "wave.json"), "-o", join(tmp, "set.mdl")); near(poseGap(S.poseAt(readFileSync(join(tmp, "set.mdl")), 1, 6), S.poseAt(mdl, 1, 6)), 0, 1e-3, "sequence-set");
});

// ── the viewer ──
try {
  const { view } = await import("../viewer/serve.mjs"), quiet = console.log; writeFileSync(join(tmp, "knife.mdl"), mdl); writeFileSync(join(tmp, "knifet.mdl"), mdl); writeFileSync(join(tmp, "desert.mdl"), mdl);
  console.log = () => {}; const server = await view([tmp], 0); console.log = quiet;
  const at = `http://127.0.0.1:${server.address().port}`, get = (p) => fetch(at + p);
  const list = await (await get("/api/models")).json(); sure(list.some((m) => m.name === "desert") && !list.some((m) => m.name === "knifet"), "a name ending in t is listed, another model's texture file is not");
  const id = encodeURIComponent(list.find((m) => m.name === "knife").id);
  const one = await (await get(`/api/model?id=${id}`)).json(), fr = new Float32Array(await (await get(`/api/frame?id=${id}&seq=1&frame=3`)).arrayBuffer());
  const pic = Buffer.from(await (await get(`/api/texture?id=${id}&n=0`)).arrayBuffer()), page = await (await get("/")).text();
  server.close();
  sure(one.triangles === piece.tris.length && one.sequences.length === 2 && one.uv.length === one.triangles * 6, "the model"); sure(fr.length === one.triangles * 18, "a frame"); sure(S.unpng(pic).width === 256, "a texture"); sure(/<canvas/.test(page), "the page");
  passed++; console.log("ok    the viewer serves the models it is given");
} catch (e) { failed.push("the viewer"); console.log(`FAIL  the viewer serves the models it is given\n      ${e.message}`); }

// ── the editor ──
try {
  const { serve } = await import("../editor/serve.mjs"), quiet = console.log, dir = join(tmp, "edit"), work = join(tmp, "edit-work"), proj = join(work, "knife.smakproj.json");
  mkdirSync(dir); writeFileSync(join(dir, "knife.mdl"), mdl); writeFileSync(join(dir, "v_knife.mdl"), mdl); writeFileSync(join(dir, "aim.mdl"), S.replaceSequence(mdl, 1, { blends: [wave, wave] }));
  console.log = () => {}; const server = await serve(dir, { port: 0, work }); console.log = quiet;
  const at = `http://127.0.0.1:${server.address().port}`, cli = (...a) => execFileSync(process.execPath, [join(HERE, "../editor/cli.mjs"), ...a], { encoding: "utf8" });
  const call = async (name, q, body) => { const j = await (await fetch(`${at}/api/${name}?${new URLSearchParams(q)}`, body ? { method: "POST", body: JSON.stringify(body) } : {})).json(); if (j.error) throw new Error(j.error); return j; };
  try {
    const list = await call("models", {}), one = await call("open", { model: "knife.mdl" }), held = await call("open", { model: "v_knife.mdl" });
    sure(list.models.length === 3 && one.seqs.length === 2 && one.project.engine === "goldsrc", "the models and a project for one"); sure(held.viewModel && !one.viewModel, "v_<name>.mdl is seen from the eye, another from outside");
    // the agent keys a bone from the command line, the page's server bakes it: the same project file
    cli("new", join(dir, "knife.mdl"), proj, "--engine", "goldsrc"); cli(proj, "key", "wave", "hand", "6", "--rot", "0,30,0", "--spread", "0");
    const saved = await call("bake", { model: "knife.mdl" }, {}), out = readFileSync(saved.out);
    sure(!saved.errors.length, saved.errors.join("; ")); sure(poseGap(S.poseAt(out, 1, 6), S.poseAt(mdl, 1, 6)) > 0.05, "the key moved nothing"); near(poseGap(S.poseAt(out, 1, 0), S.poseAt(mdl, 1, 0)), 0, 1e-3, "a frame without a key");
    sure(readFileSync(join(dir, "knife.mdl")).equals(mdl), "the source model was written to");
    // an animation the game mixes from two: its motion is refused, its speed is not, and it keeps both
    const key = { set: [{ path: ["anims", 1, "keys", "hand", "6"], value: [8, 0, 0, 0, 0.9, 0.3] }], what: "a key", by: "person" }; let refused = "";
    try { await call("patch", { model: "aim.mdl" }, key); } catch (e) { refused = e.message; } sure(/mixes/.test(refused), "a key on a mixed animation was taken");
    await call("patch", { model: "aim.mdl" }, { set: [{ path: ["anims", 1, "fps"], value: 20 }], what: "slower", by: "person" });
    const aim = S.sequences(readFileSync((await call("bake", { model: "aim.mdl" }, {})).out))[1]; sure(aim.blends === 2 && aim.fps === 20, `the mixed animation came out with ${aim.blends} and ${aim.fps} fps`);
    sure(/<canvas/.test(await (await fetch(at + "/")).text()), "the page");
  } finally { server.close(); }
  passed++; console.log("ok    the editor keys, bakes and leaves a mixed animation whole");
} catch (e) { failed.push("the editor"); console.log(`FAIL  the editor keys, bakes and leaves a mixed animation whole\n      ${e.message}`); }

console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join(", ")}` : ""}   (Node ${process.version}; files in ${tmp})`);
process.exit(failed.length ? 1 : 0);
