// The project file and the model it is about, in Node: read, patched under a lock, and baked onto the ORIGINAL model
// with smak. The server (serve.mjs) and the command line (cli.mjs) both do everything through here, so a person in the
// page and an agent in a terminal change one file by the same steps.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, openSync, closeSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, relative, basename, isAbsolute } from "node:path";
import * as smak from "../src/index.mjs";
import { FORMAT, applyPatch, animOf, animList, bakeAnim, adjustPalette } from "./core.mjs";

const slash = (p) => p.replace(/\\/g, "/");
export const sha1 = (buf) => createHash("sha1").update(buf).digest("hex");

// ── the source model ───────────────────────────────────────────────────────
const sources = new Map();
/** A model file read (its textures put inside when they are kept in <name>t.mdl), with what the editor needs to know of it. Kept until the file changes. */
export function sourceAt(path) {
  const at = resolve(path), stamp = statSync(at).mtimeMs, had = sources.get(at);
  if (had && had.stamp === stamp) return had;
  const raw = readFileSync(at); let buf = raw; const notes = [];
  const tfile = at.replace(/\.mdl$/i, "t.mdl");
  if (!smak.readMdl(buf).textures.length && existsSync(tfile)) { buf = smak.withTextures(buf, readFileSync(tfile)); notes.push(`its textures are kept in ${basename(tfile)}: the saved model has them inside`); }
  const frames = new Map(), seqs = smak.sequences(buf).map((s, n) => ({ ...s, events: smak.events(buf, n) }));
  const ctx = { bones: smak.bones(buf), seqs, base: (n) => { if (!frames.has(n)) frames.set(n, smak.readSequence(buf, n).frames); return frames.get(n); } };
  // a view model (the weapon in the player's hands) is looked at from the eye, anything else from outside. GoldSrc names them v_<name>.mdl
  const src = { path: at, stamp, buf, sha1: sha1(raw), bytes: raw.length, ctx, notes, info: smak.readMdl(buf), viewModel: /^v_/i.test(basename(at)) || /viewmodel/i.test(slash(at)) };
  sources.set(at, src); return src;
}

// ── the project file ───────────────────────────────────────────────────────
/** A project for a model, not yet written: `projPath` is where it will be kept (the source's path is written relative to it). */
export function newProject(modelPath, projPath, engine = "xash") {
  const src = sourceAt(modelPath), rel = slash(relative(dirname(resolve(projPath)), src.path));
  return { format: FORMAT, rev: 0, source: { path: rel, sha1: src.sha1, bytes: src.bytes }, output: basename(src.path).replace(/\.mdl$/i, "") + ".out.mdl", engine, anims: {}, textures: {}, log: [] };
}
export function readProject(projPath) {
  if (!existsSync(projPath)) return null;
  const p = JSON.parse(readFileSync(projPath, "utf8"));
  if (p.format !== FORMAT) throw new Error(`${projPath}: its format is "${p.format}", and this editor reads "${FORMAT}"`);
  p.anims ??= {}; p.textures ??= {}; p.log ??= []; return p;
}
export const sourcePathOf = (project, projPath) => (isAbsolute(project.source.path) ? project.source.path : resolve(dirname(resolve(projPath)), project.source.path));
export const sourceOf = (project, projPath) => sourceAt(sourcePathOf(project, projPath));
export const outputPathOf = (project, projPath, out) => resolve(dirname(resolve(projPath)), out ?? project.output);

/**
 * An animation the game plays as several mixed (a player's aim up and down): written from one set of frames it would be
 * left with one, so its motion is not changed here. Its speed, looping and events are; a copy of it is free to change.
 */
export const mixedOf = (ctx, n) => (n < ctx.seqs.length && ctx.seqs[n].blends > 1 ? ctx.seqs[n].blends : 0);
const movesIt = (e, s) => Boolean(e) && (Object.values(e.keys ?? {}).some((k) => Object.keys(k).length) || (e.frames !== undefined && e.frames !== s.frames));
function refuseMixed(project, projPath, set) {
  const said = set.filter((p) => p.path[0] === "anims"); if (!said.length) return;
  const ctx = sourceOf(project, projPath).ctx, which = said.some((p) => p.path.length < 2) ? Object.keys(project.anims ?? {}) : said.map((p) => p.path[1]);
  for (const k of new Set(which.map(Number))) if (mixedOf(ctx, k) && movesIt(project.anims?.[k], ctx.seqs[k]))
    throw new Error(`${ctx.seqs[k].name} is ${ctx.seqs[k].blends} animations that the game mixes (a player's aim up and down, say): its motion is not changed here, since it would be left with one. Its speed, looping and events can be changed; or duplicate it and work on the copy`);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function locked(projPath, work) {
  const lock = projPath + ".lock"; mkdirSync(dirname(projPath), { recursive: true });
  for (let tries = 0; ; tries++) {
    try { closeSync(openSync(lock, "wx")); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock); } catch { /* gone already */ }
      if (tries > 200) throw new Error(`${projPath} is locked by another writer`);
      sleep(25);
    }
  }
  try { return work(); } finally { try { unlinkSync(lock); } catch { /* nothing to remove */ } }
}
/**
 * One change to the project file: read as it is on the disk now, patched, numbered, noted in its log, and written whole
 * (to a temporary file, then renamed over it). `by`: "person" or "agent". `fresh`: the project to start from when the
 * file is not there yet. Returns { project, inverse }: the `set` that undoes exactly what this one changed.
 */
export function patchProject(projPath, { set, what, by = "agent" }, fresh = null) {
  return locked(projPath, () => {
    const now = readProject(projPath) ?? fresh; if (!now) throw new Error(`no project at ${projPath}`);
    const { project, inverse } = applyPatch(now, set);
    refuseMixed(project, projPath, set);
    project.rev = (now.rev ?? 0) + 1;
    project.log = [...(now.log ?? []), { rev: project.rev, by, at: new Date().toISOString(), what: String(what ?? "edit").slice(0, 300) }].slice(-60);
    const tmp = `${projPath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(project, null, 1)); renameSync(tmp, projPath);
    return { project, inverse };
  });
}

// ── textures ───────────────────────────────────────────────────────────────
/** A texture as the project has it: the source's, or the picture that replaces it, with the adjustments made to its palette. */
export function textureFor(src, i, entry, projPath) {
  const old = smak.textureOf(src.buf, i), holes = Boolean(old.flags & 64); let t = old;
  if (entry?.file) {
    const buf = readFileSync(resolve(dirname(resolve(projPath)), entry.file)), isBmp = buf.toString("latin1", 0, 2) === "BM";
    if (holes && !isBmp) t = smak.masked(smak.unpng(buf), old.name);          // the last colour stays the hole's, used or not
    else t = smak.textureFrom(buf, old.name);
    t = { ...t, name: old.name, flags: old.flags };
  }
  if (entry?.adjust && Object.keys(entry.adjust).length) t = { ...t, palette: adjustPalette(t.palette, entry.adjust, holes) };
  return t;
}

// ── baking ─────────────────────────────────────────────────────────────────
/**
 * The project baked onto its source model, from the start every time: { mdl (a Buffer), notes, anims: [{ n, name, frames }] }.
 * Textures first, then each animation the project says anything of, in order of number: the source's replaced where they
 * stand, the added ones after the last.
 */
export function bakeProject(project, projPath) {
  const src = sourceOf(project, projPath), ctx = src.ctx, notes = [...src.notes], done = [];
  if (project.source.sha1 && project.source.sha1 !== src.sha1) notes.push(`the source model is not the file the project was begun on (its hash differs): the keys are laid on it by bone name all the same`);
  let mdl = src.buf;
  for (const [k, entry] of Object.entries(project.textures ?? {})) {
    const i = Number(k); if (!src.info.textures[i] || (!entry.file && !Object.keys(entry.adjust ?? {}).length)) continue;
    mdl = smak.replaceTexture(mdl, i, textureFor(src, i, entry, projPath));
  }
  const list = animList(project, ctx); let count = ctx.seqs.length;
  for (const k of Object.keys(project.anims ?? {}).map(Number).sort((a, b) => a - b)) {
    const e = project.anims[k], item = list.find((x) => x.n === k);
    if (!item) { notes.push(`animation ${k} of the project is skipped: it copies an animation the model has not got`); continue; }
    for (const name of Object.keys(e.keys ?? {})) if (!ctx.bones.some((b) => b.name === name)) notes.push(`${item.name}: keys for a bone the model has not got, ${name}`);
    const a = animOf(project, ctx, k), keyed = Object.values(a.keys).some((x) => Object.keys(x).length), frames = keyed || a.count !== a.base.length || a.added ? bakeAnim(a, ctx) : undefined;
    if (a.added) {
      if (k !== count) { notes.push(`animation ${k} (${a.name}) is skipped: added animations have to follow on from ${count}`); continue; }
      mdl = smak.addSequence(mdl, { name: a.name, fps: a.fps, loops: a.loops, frames, events: a.events, like: a.baseN }); count++;
    } else {
      if (ctx.seqs[k].group) { notes.push(`${a.name} is kept in another file and cannot be changed`); continue; }
      const mixed = frames && mixedOf(ctx, k);
      if (mixed) notes.push(`${a.name} is ${mixed} animations that the game mixes: its motion is left as it was`);
      mdl = smak.replaceSequence(mdl, k, { frames: mixed ? undefined : frames, fps: e.fps, loops: e.loops });
      if (e.events) mdl = smak.setEvents(mdl, k, a.events);
      if (a.count !== a.base.length) notes.push(`${a.name} is ${a.count} frames long where it was ${a.base.length}: whatever the game times by it changes with it`);
    }
    done.push({ n: k, name: a.name, frames: a.count, fps: a.fps });
  }
  return { mdl, notes, anims: done };
}
const baked = new Map();
/** The baked model for a project as it stands (kept until its rev or its source changes). */
export function bakedOf(project, projPath) {
  const key = resolve(projPath), src = sourceOf(project, projPath), stamp = `${project.rev}:${src.stamp}`, had = baked.get(key);
  if (had?.stamp === stamp) return had.result;
  const result = bakeProject(project, projPath); baked.set(key, { stamp, result }); return result;
}
/** Bakes and writes the model, and checks it: { out, bytes, engine, errors, warnings, facts, notes, anims }. Never onto the source. */
export function saveBake(project, projPath, { out, engine } = {}) {
  const to = outputPathOf(project, projPath, out), src = sourceOf(project, projPath); engine ??= project.engine ?? "xash";
  if (to.toLowerCase() === src.path.toLowerCase()) throw new Error("that is the source model: the editor never writes over it");
  if (!/\.mdl$/i.test(to)) throw new Error("the output's name has to end in .mdl");
  const { mdl, notes, anims } = bakeProject(project, projPath), report = smak.check(mdl, engine);
  mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, mdl);
  return { out: to, bytes: mdl.length, engine, ...report, notes, anims };
}
export { smak };
