#!/usr/bin/env node
// SMAK from the command line: look at a model, check it, draw it, and take its textures out and put them back.
// Anything finer (a new mesh, a new animation) is a short script over src/index.mjs: see AGENTS.md and examples/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import * as S from "../src/index.mjs";

const HELP = `smak <command> <model.mdl> [...]        (node bin/smak.mjs ...)

  info <mdl> [--json]                       what is in it: bones, bodyparts and their body numbers, textures, animations, events
  check <mdl> [--engine goldsrc|xash]       what would break or draw wrong in the game (exit code 1 on an error)
  render <mdl> -o out.png                   one picture       [--view orbit|first] [--yaw 30] [--pitch 15] [--zoom 1]
  sheet <mdl> -o out.png                    six views in one  [--size 384]
  strip <mdl> -o out.png --seq <name|n>     an animation, frame by frame   [--count 12] [--cols 4] [--from f] [--to f] [--view first]
        (render, sheet and strip all take --seq --frame --body --skin --width --height --no-light --no-cull)
  textures <mdl> -o <folder> [--bmp]        every texture as a file (PNG; --bmp: 8-bit BMP with its palette as it is)
  uv <mdl> -o <folder> [--texture name|n]   every texture (or one) enlarged, with the triangles that wear it drawn over it
  retexture <mdl> <texture name|n> <picture.png|.bmp> -o out.mdl [--holes] [--flags n]
                                            another picture on that texture (any size; cut to 256 colours unless an 8-bit BMP)
  sequence <mdl> <name|n> -o seq.json       an animation as numbers: for each frame, for each bone, [x, y, z, about x, about y, about z]
  sequence-set <mdl> <name|n> seq.json -o out.mdl      the same file put back (frames, fps, loops), in the place it had
  sequence-add <mdl> seq.json -o out.mdl    as a new animation after the others (seq.json: { name, fps, loops, frames })
  inline <mdl> -o out.mdl                   a model whose textures are in <name>t.mdl, with them put inside it
  pieces <mdl> [--min 6] [--seq n]          its loose pieces (a pouch, a plate, a pack), each with its number, place and size
  view <folder|mdl> [more ...] [--port 8098]   a page in the browser: any two models side by side, turned and animated together
`;

const argv = process.argv.slice(2), flags = {}, args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-o") flags.o = argv[++i];
  else if (a.startsWith("--no-")) flags[a.slice(5)] = false;
  else if (a.startsWith("--")) flags[a.slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith("--") || argv[i + 1] === "-o" ? true : argv[++i];
  else args.push(a);
}
const [cmd, file, ...rest] = args;
const fail = (m) => { console.error(m); process.exit(1); };
if (!cmd || cmd === "help" || flags.help) { console.log(HELP); process.exit(0); }
if (!file) fail(HELP);
if (!existsSync(file)) fail(`no such file: ${file}`);
if (cmd === "view") { const { view } = await import("../viewer/serve.mjs"); for (const r of rest) if (!existsSync(r)) fail(`no such file: ${r}`); await view([file, ...rest], Number(flags.port) || 8098); await new Promise(() => {}); }
const num = (v) => (v === undefined || v === true ? undefined : isNaN(v) ? v : Number(v));
const which = (v) => (/^\d+$/.test(String(v)) ? Number(v) : v);
const save = (to, data) => { mkdirSync(dirname(to) || ".", { recursive: true }); writeFileSync(to, data); };
const need = (v, what) => v ?? fail(`${cmd}: ${what}`);
const safe = (s) => s.replace(/\.(bmp|png|tga)$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_");

let src = readFileSync(file);
// a model whose textures are in the file beside it is read with them
const tfile = file.replace(/\.mdl$/i, "t.mdl");
if (cmd !== "inline" && src.length > 184 && !src.readInt32LE(180) && existsSync(tfile)) { src = S.withTextures(src, readFileSync(tfile)); console.error(`(textures read from ${basename(tfile)})`); }
const viewOpts = () => ({ view: flags.view, seq: flags.seq === undefined ? (S.sequences(src).length ? 0 : null) : flags.seq === "rest" ? null : which(flags.seq), frame: num(flags.frame) ?? 0, body: num(flags.body) ?? 0, skin: num(flags.skin) ?? 0,
  yaw: num(flags.yaw), pitch: num(flags.pitch), zoom: num(flags.zoom), fov: num(flags.fov), width: num(flags.width), height: num(flags.height), size: num(flags.size), count: num(flags.count), cols: num(flags.cols), from: num(flags.from), to: num(flags.to),
  light: flags.light !== false, cull: flags.cull !== false });
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const picture = (img) => { const to = need(flags.o, "-o out.png"); save(to, S.png(img.width, img.height, img.rgba)); console.log(`${to}  ${img.width}x${img.height}`); };

switch (cmd) {
  case "info": {
    const info = S.readMdl(src), seqs = S.sequences(src), bn = S.bones(src), att = S.attachments(src), fams = S.skinFamilies(src);
    const data = {
      file, bytes: src.length, name: src.toString("latin1", 8, 72).replace(/\0.*$/s, ""),
      bones: bn.map((b, i) => ({ i, name: b.name, parent: b.parent, pos: b.pos.map((v) => +v.toFixed(3)), rot: b.rot.map((v) => +v.toFixed(4)) })),
      bodyparts: info.bodyparts.map((bp) => ({ name: bp.name, base: bp.base, models: bp.models.map((m, k) => ({ body: k * bp.base, name: m.name, verts: m.numverts, meshes: m.meshes.map((x) => ({ tris: x.numtris, texture: x.texture?.name ?? null })) })) })),
      textures: info.textures.map((t, i) => ({ i, name: t.name, width: t.width, height: t.height, flags: t.flags })), skinFamilies: fams.length,
      sequences: seqs.map((s, i) => ({ i, name: s.name, frames: s.frames, fps: s.fps, loops: s.loops, blends: s.blends, external: Boolean(s.group), events: S.events(src, i) })),
      attachments: att.map((a) => ({ ...a, bone: bn[a.bone]?.name ?? a.bone })), hitboxes: S.hitboxes(src).length,
    };
    if (flags.json) { console.log(JSON.stringify(data, null, 1)); break; }
    const flagNames = (f) => Object.entries(S.TEXTURE).filter(([, v]) => f & v).map(([k]) => k).join("+");
    console.log(`${file}: "${data.name}", ${src.length} bytes`);
    console.log(`\nBONES (${bn.length})`); bn.forEach((b, i) => console.log(`  ${String(i).padStart(3)} ${b.name.padEnd(28)} parent ${String(b.parent).padStart(3)}  at ${b.pos.map((v) => v.toFixed(2)).join(" ")}`));
    console.log(`\nBODYPARTS (${info.bodyparts.length})   a body number is the sum of one "body" from each part`);
    for (const bp of data.bodyparts) { console.log(`  ${bp.name}`); for (const m of bp.models) console.log(`    body ${String(m.body).padStart(4)}  ${m.name.padEnd(28)} ${String(m.verts).padStart(5)} points  ${m.meshes.map((x) => `${x.tris} on ${x.texture}`).join(", ") || "(empty)"}`); }
    console.log(`\nTEXTURES (${info.textures.length}${fams.length > 1 ? `, ${fams.length} skin families` : ""})`); data.textures.forEach((t) => console.log(`  ${String(t.i).padStart(3)} ${t.name.padEnd(32)} ${t.width}x${t.height}${t.flags ? `  ${flagNames(t.flags) || ""} (flags ${t.flags})` : ""}`));
    console.log(`\nANIMATIONS (${seqs.length})   the game asks for them by number: keep their order`);
    data.sequences.forEach((s) => { console.log(`  ${String(s.i).padStart(3)} ${s.name.padEnd(28)} ${String(s.frames).padStart(4)} frames at ${s.fps} fps${s.loops ? ", loops" : ""}${s.blends > 1 ? `, ${s.blends} blends` : ""}${s.external ? ", KEPT IN ANOTHER FILE" : ""}`); for (const e of s.events) console.log(`        frame ${e.frame}: event ${e.event}${e.options ? ` "${e.options}"` : ""}`); });
    if (att.length) { console.log(`\nATTACHMENTS (${att.length})`); data.attachments.forEach((a, i) => console.log(`  ${i} on ${a.bone} at ${a.pos.map((v) => v.toFixed(2)).join(" ")}`)); }
    console.log(`\n${data.hitboxes} hit boxes`);
    break;
  }
  case "check": {
    const engine = flags.engine === true || !flags.engine ? "goldsrc" : flags.engine, r = S.check(src, engine);
    for (const f of r.facts) console.log(`      ${f}`);
    for (const w of r.warnings) console.log(`WARN  ${w}`);
    for (const e of r.errors) console.log(`ERROR ${e}`);
    console.log(r.errors.length ? `${r.errors.length} errors: not fit for ${engine}` : `fit for ${engine}${r.warnings.length ? `, with ${r.warnings.length} warnings` : ""}`);
    process.exit(r.errors.length ? 1 : 0);
    break;
  }
  case "render": case "sheet": case "strip": {
    const o = clean(viewOpts());
    if (!S.posed(src, o).tris.length) fail(`body ${o.body} shows no triangles. Its body numbers:\n${S.readMdl(src).bodyparts.map((bp) => `  ${bp.name}: ${bp.models.map((m, k) => `${k * bp.base}=${m.name}`).join(" ")}`).join("\n")}`);
    picture(cmd === "render" ? S.render(src, o) : cmd === "sheet" ? S.sheet(src, o) : S.strip(src, o));
    break;
  }
  case "textures": {
    const dir = need(flags.o, "-o <folder>"), info = S.readMdl(src);
    info.textures.forEach((_, i) => { const t = S.textureOf(src, i), to = join(dir, `${String(i).padStart(2, "0")}_${safe(t.name)}.${flags.bmp ? "bmp" : "png"}`); save(to, flags.bmp ? S.bmp(t) : S.png(t.width, t.height, S.rgbaOf(t, Boolean(t.flags & S.TEXTURE.masked)))); console.log(`${to}  ${t.width}x${t.height}${t.flags ? ` flags ${t.flags}` : ""}`); });
    break;
  }
  case "uv": {
    const dir = need(flags.o, "-o <folder>"), info = S.readMdl(src), list = flags.texture === undefined ? info.textures.map((_, i) => i) : [which(flags.texture)];
    for (const w of list) { const m = S.uvMap(src, w), to = join(dir, `uv_${safe(m.texture.name)}.png`); save(to, S.png(m.width, m.height, m.rgba)); console.log(`${to}  ${m.texture.width}x${m.texture.height} x${m.scale}, ${m.triangles} triangles of ${m.meshes} meshes`); }
    break;
  }
  case "retexture": {
    const [tex, pic] = rest; need(pic, "<texture name|n> <picture.png|.bmp>");
    const old = S.textureOf(src, which(tex)), t = S.textureFrom(readFileSync(pic), old.name, { holes: Boolean(flags.holes) || Boolean(old.flags & S.TEXTURE.masked) });
    const out = S.replaceTexture(src, which(tex), { ...t, flags: num(flags.flags) ?? old.flags }), to = need(flags.o, "-o out.mdl");
    save(to, out); console.log(`${to}: ${old.name} ${old.width}x${old.height} -> ${t.width}x${t.height}`);
    break;
  }
  case "sequence": {
    const s = S.readSequence(src, which(need(rest[0], "<animation name|n>"))), to = need(flags.o, "-o seq.json");
    save(to, JSON.stringify({ name: s.name, index: s.index, fps: s.fps, loops: s.loops, bones: S.bones(src).map((b) => b.name), frames: s.frames.map((f) => f.map((v) => v.map((x) => +x.toFixed(5)))) }));
    console.log(`${to}: ${s.name}, ${s.frames.length} frames of ${s.frames[0]?.length ?? 0} bones at ${s.fps} fps`);
    break;
  }
  case "sequence-set": case "sequence-add": {
    const add = cmd === "sequence-add", json = JSON.parse(readFileSync(need(add ? rest[0] : rest[1], "seq.json"), "utf8")), to = need(flags.o, "-o out.mdl");
    const out = add ? S.addSequence(src, json) : S.replaceSequence(src, which(rest[0]), { frames: json.frames, fps: json.fps, loops: json.loops });
    save(to, out); console.log(`${to}: ${add ? `${json.name} added as animation ${S.sequences(out).length - 1}` : `animation ${rest[0]} now ${json.frames.length} frames`}`);
    break;
  }
  case "inline": {
    if (!existsSync(tfile)) fail(`no ${tfile} beside it`);
    const out = S.withTextures(src, readFileSync(tfile)), to = need(flags.o, "-o out.mdl");
    save(to, out); console.log(`${to}: ${S.readMdl(out).textures.length} textures inside`);
    break;
  }
  case "pieces": {
    const min = num(flags.min) ?? 6, list = S.pieces(src, { seq: flags.seq === undefined ? (S.sequences(src).length ? 0 : null) : which(flags.seq) }).list;
    console.log("  id  texture                 tris   middle (x y z)        size (x y z)");
    for (const p of list.filter((x) => x.tris >= min)) console.log(`${String(p.id).padStart(4)}  ${String(p.tex).padEnd(22)} ${String(p.tris).padStart(5)}   ${p.mid.join(" ").padEnd(20)}  ${p.mx.map((v, a) => (v - p.mn[a]).toFixed(1)).join(" ")}`);
    console.log(`${list.length} pieces, ${list.filter((x) => x.tris < min).length} of them under ${min} triangles and not listed`);
    break;
  }
  default: fail(`no command ${cmd}\n\n${HELP}`);
}

