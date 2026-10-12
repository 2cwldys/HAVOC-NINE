#!/usr/bin/env node
// The editor from a terminal: everything the page does to a project, for an agent (editor/AGENTS.md).
//   node editor/cli.mjs new <model.mdl> <project.smakproj.json> [--engine xash|goldsrc]
//   node editor/cli.mjs <project> <command> ...
// Every change is one patch on the project file, made under the same lock and by the same code as the page's, and
// noted in the project's log as the agent's. A page that has the project open shows it within a second.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { newProject, readProject, patchProject, sourceOf, bakeProject, saveBake, textureFor, smak } from "./project.mjs";
import * as core from "./core.mjs";

const HELP = `node editor/cli.mjs new <model.mdl> <project.json> [--engine xash|goldsrc]     begin a project (the model is only read)
node editor/cli.mjs <project.json> <command>:
  show [--json]                                   the model's animations, bones and textures, and what the project changes
  keys <anim> [bone]                              which bones have keys, or one bone's keys (degrees)
  pose <anim> <frame> [bone]                      the values at a frame as the project has them (x y z, then degrees)
  key <anim> <bone> <frame> [--rot dx,dy,dz] [--move dx,dy,dz] [--set x,y,z,rx,ry,rz] [--spread n]
                                                  a key: a turn about the bone's own axes (degrees) and a move (units, in its
                                                  parent's space) from where it is, or the six values outright (degrees)
  unkey <anim> <bone> <frame|all>                 a key removed; all: the bone plays the source's frames again
  movekey <anim> <bone> <from> <to>               a key taken to another frame
  thin <anim> [--tol 0.5] [--pos 0.02] [--bone name]...   keys thinned within so many degrees and units
  set <anim> [--frames n] [--fps f] [--loops yes|no] [--interp smooth|linear]   length (stretched), rate, looping
  dup <anim> <new name>                           the animation again, after the last one
  events <anim> [--add frame,event,text] [--del i] [--move i,frame] [--text i,text] [--clear] [--source]
  texture <texture> [--file picture.png|bmp] [--brightness n] [--contrast n] [--saturation n] [--hue deg]
                    [--tint r,g,b,amount] [--no-adjust] [--no-file] [--export out.png|bmp]
  diff <anim>                                     how far the animation is from the source's
  bake [-o out.mdl] [--engine xash|goldsrc]       bake onto the source, write, check; exit code 1 on an error
  render -o p.png --anim a --frame f [--view first|orbit] [--body n] [--yaw d] [--pitch d] [--width w] [--height h] [--source]
  strip -o p.png --anim a [--count 12] [--cols 4] [--from f] [--to f] [--view first] [--body n] [--compare]
                                                  frames of an animation in one picture; --compare: the source above
<anim> and <texture> are numbers or names; <bone> is a name ("Bip01 R Hand") or a number.`;

const args = process.argv.slice(2), flags = {}, rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-o") flags.o = args[++i];
  else if (a.startsWith("--")) { const k = a.slice(2), bare = ["json", "compare", "source", "clear", "no-adjust", "no-file"].includes(k), v = bare ? true : args[++i]; if (k in flags) flags[k] = [].concat(flags[k], v); else flags[k] = v; }
  else rest.push(a);
}
const nums = (s, n) => { const v = String(s).split(",").map(Number); if (v.length !== n || v.some(Number.isNaN)) throw new Error(`${s}: ${n} numbers with commas between`); return v; };
const deg = (v) => v.map((x, i) => (i < 3 ? +x.toFixed(3) : +(x / core.DEG).toFixed(2)));
const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 1));

try {
  if (!rest.length || rest[0] === "help") { out(HELP); process.exit(0); }
  if (rest[0] === "new") {
    const [, model, projPath] = rest; if (!model || !projPath) throw new Error("new <model.mdl> <project.json>");
    if (existsSync(projPath)) throw new Error(`${projPath} is there already`);
    const p = newProject(model, projPath, flags.engine ?? "xash"); mkdirSync(dirname(resolve(projPath)), { recursive: true });
    const r = patchProject(resolve(projPath), { set: [], what: `project begun on ${basename(model)}`, by: "agent" }, p);
    out(`${resolve(projPath)}: revision ${r.project.rev}, source ${r.project.source.path}`); process.exit(0);
  }
  const projPath = resolve(rest[0]), cmd = rest[1] ?? "show", a = rest.slice(2);
  let project = readProject(projPath); if (!project) throw new Error(`no project at ${projPath}: begin one with "new <model.mdl> ${rest[0]}"`);
  const src = sourceOf(project, projPath), ctx = src.ctx;
  const change = (op) => { if (!op.set.length) { out(`nothing to change (${op.what})`); return; } const r = patchProject(projPath, { ...op, by: "agent" }); project = r.project; out(`revision ${project.rev}: ${op.what}`); };
  const texAt = (which) => { const i = /^\d+$/.test(String(which)) ? Number(which) : src.info.textures.findIndex((t) => t.name.toLowerCase() === String(which).toLowerCase()); if (!src.info.textures[i]) throw new Error(`no texture ${which}`); return i; };
  const anim = () => core.animAt(project, ctx, a[0] ?? flags.anim ?? 0);
  const image = (img, to) => { if (!to) throw new Error("-o <picture.png>"); mkdirSync(dirname(resolve(to)), { recursive: true }); writeFileSync(to, smak.png(img.width, img.height, img.rgba)); out(resolve(to)); };

  const commands = {
    show() {
      const list = core.animList(project, ctx);
      if (flags.json) return out({ project: projPath, rev: project.rev, source: src.path, sourceChanged: project.source.sha1 !== src.sha1, engine: project.engine, output: project.output, bones: ctx.bones.map((b, i) => ({ i, name: b.name, parent: b.parent })), animations: list.map((x) => ({ ...x, keyed: Object.fromEntries(Object.entries(project.anims[x.n]?.keys ?? {}).map(([k, v]) => [k, Object.keys(v).length])), events: project.anims[x.n]?.events ?? ctx.seqs[x.n]?.events ?? [] })), textures: src.info.textures.map((t, i) => ({ i, name: t.name, width: t.width, height: t.height, flags: t.flags, ...(project.textures[i] ?? {}) })), log: project.log });
      out(`${projPath}\n  revision ${project.rev}, engine ${project.engine}, output ${project.output}\n  source ${src.path} (${src.bytes} bytes)${project.source.sha1 !== src.sha1 ? "  CHANGED since the project was begun" : ""}`);
      out(`\nANIMATIONS (${list.length}; * the project changes it, + the project adds it)`);
      for (const x of list) { const e = project.anims[x.n], keyed = Object.entries(e?.keys ?? {}).filter(([, v]) => Object.keys(v).length); out(`  ${e ? (x.added ? "+" : "*") : " "} ${String(x.n).padStart(3)} ${x.name.padEnd(24)} ${String(x.frames).padStart(4)} frames at ${+x.fps.toFixed(2)} fps${x.loops ? ", loops" : ""}${x.outside ? "  (in another file: cannot be changed)" : ""}${keyed.length ? `   keys: ${keyed.filter(([, v]) => Object.keys(v).length > 2).map(([k, v]) => `${k} ${Object.keys(v).length}`).join(", ")}${keyed.some(([, v]) => Object.keys(v).length <= 2) ? ` and ${keyed.filter(([, v]) => Object.keys(v).length <= 2).length} bones with 1 or 2` : ""}` : ""}${e?.events ? `   events: ${e.events.map((v) => `${v.frame}:${v.event} ${v.options}`).join(", ") || "none"}` : ""}`); }
      const tex = Object.entries(project.textures).filter(([, t]) => t.file || Object.keys(t.adjust ?? {}).length);
      out(`\nTEXTURES changed (${tex.length} of ${src.info.textures.length})`); for (const [i, t] of tex) out(`  ${i} ${src.info.textures[i]?.name}${t.file ? `  from ${t.file}` : ""}${t.adjust ? `  ${JSON.stringify(t.adjust)}` : ""}`);
      out(`\nLAST CHANGES`); for (const l of project.log.slice(-10)) out(`  ${String(l.rev).padStart(4)} ${l.by.padEnd(7)} ${l.at}  ${l.what}`);
      out(`\n${ctx.bones.length} bones: "node smak/bin/smak.mjs info <model>" lists them, with the body numbers`);
    },
    keys() {
      const n = anim(), an = core.animOf(project, ctx, n);
      if (a[1] === undefined) { out(`${an.name} (${n}): ${an.count} frames; ${an.smooth ? "a curve through the keys" : "straight between keys"}`); for (const [k, v] of Object.entries(an.keys)) out(`  ${k.padEnd(26)} ${Object.keys(v).length === an.count ? "every frame" : Object.keys(v).join(" ")}`); if (!Object.keys(an.keys).length) out("  no bone has keys of its own: every bone plays the source's frames"); return; }
      const name = ctx.bones.find((b, i) => b.name.toLowerCase() === a[1].toLowerCase() || String(i) === a[1])?.name, keys = an.keys[name];
      if (!keys) return out(`${a[1]} has no keys of its own in ${an.name}: it plays the source's frames (a key on every frame)`);
      for (const f of Object.keys(keys).map(Number).sort((x, y) => x - y)) out(`  ${String(f).padStart(4)}  ${deg(keys[f]).join("  ")}`);
    },
    pose() {
      const n = anim(), f = Number(a[1] ?? 0);
      const one = (b) => `${String(b).padStart(3)} ${ctx.bones[b].name.padEnd(26)} ${deg(core.valuesAt(project, ctx, n, b, f)).join("  ")}`;
      if (a[2] !== undefined) return out(one(ctx.bones.findIndex((b, i) => b.name.toLowerCase() === a[2].toLowerCase() || String(i) === a[2])));
      ctx.bones.forEach((_, b) => out(one(b)));
    },
    key() {
      const n = anim(), bone = /^\d+$/.test(a[1]) ? Number(a[1]) : a[1], f = Number(a[2]), spread = Number(flags.spread ?? 0);
      if (flags.set) { const v = nums(flags.set, 6); return change(core.opKey(project, ctx, n, bone, f, [v[0], v[1], v[2], v[3] * core.DEG, v[4] * core.DEG, v[5] * core.DEG], spread)); }
      change(core.opNudge(project, ctx, n, bone, f, { rot: flags.rot ? nums(flags.rot, 3) : [0, 0, 0], move: flags.move ? nums(flags.move, 3) : [0, 0, 0] }, spread));
    },
    unkey() { change(core.opDeleteKey(project, ctx, anim(), /^\d+$/.test(a[1]) ? Number(a[1]) : a[1], a[2] === "all" ? "all" : Number(a[2]))); },
    movekey() { change(core.opMoveKey(project, ctx, anim(), /^\d+$/.test(a[1]) ? Number(a[1]) : a[1], Number(a[2]), Number(a[3]))); },
    thin() {
      const n = anim(), was = core.bakeAnim(core.animOf(project, ctx, n), ctx);
      change(core.opThin(project, ctx, n, { rot: Number(flags.tol ?? 0.5), pos: Number(flags.pos ?? 0.02), bones: flags.bone ? [].concat(flags.bone) : undefined }));
      const e = core.poseError(ctx.bones, was, core.bakeAnim(core.animOf(project, ctx, n), ctx)); out(`  at most ${e.units.toFixed(3)} units and ${e.degrees.toFixed(2)} degrees from what it was (frame ${e.frame}, ${e.bone || "no bone"})`);
    },
    set() { change(core.opSettings(project, ctx, anim(), { frames: flags.frames === undefined ? undefined : Number(flags.frames), fps: flags.fps === undefined ? undefined : Number(flags.fps), loops: flags.loops === undefined ? undefined : /^(yes|true|1)$/i.test(flags.loops), interp: flags.interp })); },
    dup() { const op = core.opDuplicate(project, ctx, anim(), a[1]); change(op); },
    events() {
      const n = anim(); let list = core.animOf(project, ctx, n).events.map((e) => ({ ...e })), touched = false;
      if (flags.source) return change({ what: `events of ${ctx.seqs[n]?.name ?? n} as the source's`, set: [{ path: ["anims", n, "events"], value: null }] });
      if (flags.clear) { list = []; touched = true; }
      for (const d of [].concat(flags.del ?? []).map(Number).sort((x, y) => y - x)) { if (!list[d]) throw new Error(`no event ${d}`); list.splice(d, 1); touched = true; }
      for (const m of [].concat(flags.move ?? [])) { const [i, f] = nums(m, 2); if (!list[i]) throw new Error(`no event ${i}`); list[i].frame = f; touched = true; }
      for (const t of [].concat(flags.text ?? [])) { const k = t.indexOf(","), i = Number(t.slice(0, k)); if (!list[i]) throw new Error(`no event ${i}`); list[i].options = t.slice(k + 1); touched = true; }
      for (const ad of [].concat(flags.add ?? [])) { const [f, ev, ...text] = ad.split(","); list.push({ frame: Number(f), event: Number(ev), type: 0, options: text.join(",") }); touched = true; }
      if (touched) change(core.opEvents(project, ctx, n, list));
      core.animOf(project, ctx, n).events.forEach((e, i) => out(`  ${i}: frame ${e.frame}, event ${e.event}, "${e.options}"`));
    },
    texture() {
      const i = texAt(a[0]), t = src.info.textures[i], set = [{ path: ["textures", i, "name"], value: t.name }], said = [];
      if (flags.file) {
        smak.textureFrom(readFileSync(flags.file), t.name);   // refused here, not at the bake, when it cannot be read
        const dir = projPath.replace(/\.smakproj\.json$/, "") + ".tex", name = `${i}_${basename(flags.file)}`;
        mkdirSync(dir, { recursive: true }); copyFileSync(flags.file, join(dir, name)); set.push({ path: ["textures", i, "file"], value: `${basename(dir)}/${name}` }); said.push(`replaced from ${basename(flags.file)}`);
      }
      if (flags["no-file"]) { set.push({ path: ["textures", i, "file"], value: null }); said.push("the source's picture"); }
      const adj = { ...(project.textures[i]?.adjust ?? {}) }; let adjusted = false;
      for (const k of ["brightness", "contrast", "saturation", "hue"]) if (flags[k] !== undefined) { adj[k] = Number(flags[k]); if (!adj[k]) delete adj[k]; adjusted = true; }
      if (flags.tint) { const v = nums(flags.tint, 4); adj.tint = v.slice(0, 3); adj.tintAmount = v[3]; adjusted = true; }
      if (flags["no-adjust"]) { set.push({ path: ["textures", i, "adjust"], value: null }); said.push("no adjustments"); } else if (adjusted) { set.push({ path: ["textures", i, "adjust"], value: Object.keys(adj).length ? adj : null }); said.push(`adjusted ${JSON.stringify(adj)}`); }
      if (said.length) change({ what: `texture ${t.name}: ${said.join(", ")}`, set });
      if (flags.export) { const tex = textureFor(src, i, project.textures[i], projPath); mkdirSync(dirname(resolve(flags.export)), { recursive: true }); writeFileSync(flags.export, /\.bmp$/i.test(flags.export) ? smak.bmp(tex) : smak.png(tex.width, tex.height, smak.rgbaOf(tex))); out(resolve(flags.export)); }
      if (!said.length && !flags.export) out(`${i} ${t.name} ${t.width}x${t.height} flags ${t.flags}  ${JSON.stringify(project.textures[i] ?? {})}`);
    },
    diff() {
      const n = anim(), an = core.animOf(project, ctx, n); if (an.count !== an.base.length) return out(`${an.name}: ${an.count} frames where the source has ${an.base.length}: no frame by frame comparison`);
      const e = core.poseError(ctx.bones, an.base, core.bakeAnim(an, ctx)); out(`${an.name}: at most ${e.units.toFixed(3)} units and ${e.degrees.toFixed(2)} degrees from the source's (frame ${e.frame}, ${e.bone || "no bone"})`);
    },
    bake() {
      const r = saveBake(project, projPath, { out: flags.o, engine: flags.engine });
      out(`${r.out}: ${r.bytes} bytes, checked for ${r.engine}`); for (const x of r.errors) out(`  ERROR    ${x}`); for (const x of r.warnings) out(`  warning  ${x}`); for (const x of r.notes) out(`  note     ${x}`); for (const x of r.facts) out(`  ${x}`);
      out(`  ${r.anims.length} animations written from the project: ${r.anims.map((x) => `${x.n} ${x.name}`).join(", ") || "none"}`);
      if (r.errors.length) process.exitCode = 1;
    },
    render() {
      const mdl = flags.source ? src.buf : bakeProject(project, projPath).mdl, n = core.animAt(project, ctx, flags.anim ?? 0);
      image(smak.render(mdl, { view: flags.view ?? (src.viewModel ? "first" : "orbit"), seq: flags.source ? Math.min(n, ctx.seqs.length - 1) : n, frame: Number(flags.frame ?? 0), body: Number(flags.body ?? 0), yaw: Number(flags.yaw ?? 30), pitch: Number(flags.pitch ?? 15), width: flags.width ? Number(flags.width) : undefined, height: flags.height ? Number(flags.height) : undefined }), flags.o);
    },
    strip() {
      const mdl = bakeProject(project, projPath).mdl, n = core.animAt(project, ctx, flags.anim ?? 0), o = { seq: n, view: flags.view ?? (src.viewModel ? "first" : "orbit"), body: Number(flags.body ?? 0), count: Number(flags.count ?? 12), cols: Number(flags.cols ?? Math.min(6, Number(flags.count ?? 12))), from: flags.from === undefined ? undefined : Number(flags.from), to: flags.to === undefined ? undefined : Number(flags.to), yaw: Number(flags.yaw ?? 30), pitch: Number(flags.pitch ?? 15) };
      const now = smak.strip(mdl, o); if (!flags.compare || n >= ctx.seqs.length) return image(now, flags.o);
      const was = smak.strip(src.buf, o); if (was.width !== now.width) return image(now, flags.o);
      const both = { width: now.width, height: was.height + now.height, rgba: new Uint8Array(now.width * (was.height + now.height) * 4) }; both.rgba.set(was.rgba, 0); both.rgba.set(now.rgba, was.rgba.length);
      smak.label(both, "source", 6, was.height - 18); smak.label(both, "project", 6, was.height + now.height - 18); image(both, flags.o);
    },
    "undo-last"() { out("Undo is not offered here: the page undoes the person's own edits, and an agent undoes its own by making the opposite change (unkey, set, events --source, texture --no-adjust). See editor/AGENTS.md."); },
  };
  if (!commands[cmd]) throw new Error(`no command ${cmd}\n\n${HELP}`);
  commands[cmd]();
} catch (e) { console.error(`editor: ${e.message}`); process.exit(1); }
