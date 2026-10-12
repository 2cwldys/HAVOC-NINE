// The model editor's server: the page, and the model work the page asks for, done here in Node with smak.
//   node bin/smak.mjs edit <folder of models, or one model> [--port 8097] [--work folder] [--engine goldsrc|xash]
// The folder of models is only read. Projects (<name>.smakproj.json), the pictures that replace textures and the saved
// models (<name>.out.mdl) go to the work folder (default smak-projects, where the command is run), under the same
// sub-folders as the models. `engine` is the one a new project's saved model is checked for. Listens on 127.0.0.1 only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, extname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { newProject, readProject, patchProject, sourceAt, sourceOf, textureFor, bakedOf, saveBake, smak } from "./project.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css" };
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** Starts the editor over a folder of models (or one model: its folder, and that model opened first). Resolves to the server once it listens. */
export function serve(models, { port = 8097, work = "smak-projects", engine = "goldsrc" } = {}) {
  models = resolve(models); work = resolve(work);
  const first = statSync(models).isDirectory() ? null : basename(models); if (first) models = dirname(models);
  const list = (dir, depth = 0) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (depth < 3 ? list(join(dir, e.name), depth + 1) : []) : /\.mdl$/i.test(e.name) ? [relative(models, join(dir, e.name)).replace(/\\/g, "/")] : [])).sort();
  const modelPath = (id) => { const p = resolve(models, id); if (relative(models, p).startsWith("..") || !/\.mdl$/i.test(p) || !existsSync(p)) throw new Error(`no model ${id}`); return p; };
  const projPath = (id) => join(work, id.replace(/\.mdl$/i, "") + ".smakproj.json");
  const projectOf = (id) => readProject(projPath(id)) ?? newProject(modelPath(id), projPath(id), engine);
  const patch = (id, body) => { const r = patchProject(projPath(id), body, newProject(modelPath(id), projPath(id), engine)); return { project: r.project, inverse: r.inverse }; };
  const image = (res, img) => res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(smak.png(img.width, img.height, img.rgba));

  const api = {
    models: () => ({ folder: models, work, first, models: list(models).map((id) => ({ id, project: existsSync(projPath(id)), bytes: statSync(join(models, id)).size })) }),
    /** Everything the page needs of a model but its shapes, pictures and frames, and the project as it stands. */
    open: (q) => {
      const src = sourceAt(modelPath(q.model)), b = src.buf, info = src.info;
      return {
        id: q.model, path: src.path, projectPath: projPath(q.model), bytes: src.bytes, notes: src.notes, viewModel: src.viewModel,
        bones: src.ctx.bones.map((x) => ({ name: x.name, parent: x.parent, pos: x.pos, rot: x.rot })), seqs: src.ctx.seqs,
        textures: info.textures.map((t) => ({ name: t.name, flags: t.flags, width: t.width, height: t.height })), skins: smak.skinFamilies(b),
        bodyparts: info.bodyparts.map((bp) => ({ name: bp.name, base: bp.base, models: bp.models.map((m) => ({ name: m.name, verts: m.numverts, tris: m.meshes.reduce((a, x) => a + x.numtris, 0), meshes: m.meshes.map((x) => ({ skinref: x.skinref, tris: x.numtris })) })) })),
        attachments: smak.attachments(b), project: projectOf(q.model),
      };
    },
    /** One submodel's triangles, mesh by mesh, corner by corner: points and normals in their bones' space, texture pixels, bones. */
    geometry: (q) => {
      const src = sourceAt(modelPath(q.model)), m = src.info.bodyparts[Number(q.bp)]?.models[Number(q.sub)]; if (!m) throw new Error("no such submodel");
      return { meshes: m.meshes.filter((x) => x.numtris).map((x) => { const tris = smak.readMesh(src.buf, m, x), c = tris.flat(); return { skinref: x.skinref, p: c.flatMap((k) => k.p.map(r4)), n: c.flatMap((k) => k.n.map(r4)), uv: c.flatMap((k) => [k.s, k.t]), bone: c.map((k) => k.bone) }; }) };
    },
    seq: (q) => ({ frames: sourceAt(modelPath(q.model)).ctx.base(Number(q.n)).map((f) => f.map((v) => v.map((x) => Math.round(x * 1e7) / 1e7))) }),
    project: (q) => projectOf(q.model),
    rev: (q) => { const p = projPath(q.model); return existsSync(p) ? { rev: readProject(p).rev, mtime: statSync(p).mtimeMs } : { rev: 0, mtime: 0 }; },
    patch: (q, body) => patch(q.model, JSON.parse(body.toString("utf8"))),
    /** A picture dropped on a texture: kept beside the project, and the project told of it. */
    upload: (q, body) => {
      const src = sourceAt(modelPath(q.model)), i = Number(q.i), t = src.info.textures[i]; if (!t) throw new Error("no such texture");
      const ext = body.toString("latin1", 0, 2) === "BM" ? ".bmp" : ".png"; if (ext === ".png") smak.unpng(body); else smak.unbmp(body);
      const dir = projPath(q.model).replace(/\.smakproj\.json$/, ".tex"), name = `${i}_${t.name.replace(/\.bmp$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_")}_${Date.now().toString(36)}${ext}`;
      mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), body);
      const now = projectOf(q.model), set = [{ path: ["textures", i, "file"], value: `${basename(dir)}/${name}` }];
      if (!now.textures?.[i]?.name) set.unshift({ path: ["textures", i, "name"], value: t.name });
      return patch(q.model, { set, what: `texture ${t.name} replaced from ${q.name ?? "a picture"}`, by: q.by ?? "person" });
    },
    bake: (q, body) => { const o = body.length ? JSON.parse(body.toString("utf8")) : {}; return saveBake(projectOf(q.model), projPath(q.model), { out: o.out || undefined, engine: o.engine || undefined }); },
  };
  const pictures = {
    /** A texture as the project has it (`orig`: as the source has it; `adjust`: with these adjustments instead; `uv`: enlarged, with the triangles that wear it). */
    texture: (q) => {
      const src = sourceAt(modelPath(q.model)), i = Number(q.i), entry = q.orig ? null : { ...(projectOf(q.model).textures?.[i] ?? {}), ...(q.adjust ? { adjust: JSON.parse(q.adjust) } : {}) };
      const t = textureFor(src, i, entry, projPath(q.model));
      if (q.uv) return smak.uvMap(smak.replaceTexture(src.buf, i, t), i);
      if (q.as === "bmp") return { file: smak.bmp(t), name: t.name.replace(/\.bmp$/i, "") + ".bmp", type: "image/bmp" };
      const img = { width: t.width, height: t.height, rgba: smak.rgbaOf(t, Boolean(t.flags & 64)) };
      return q.as === "png" ? { file: smak.png(img.width, img.height, smak.rgbaOf(t)), name: t.name.replace(/\.bmp$/i, "") + ".png", type: "image/png" } : img;
    },
    /** smak's own picture of the model as the project bakes it (`orig`: of the source): what an agent sees. */
    render: (q) => {
      const project = projectOf(q.model), mdl = q.orig ? sourceOf(project, projPath(q.model)).buf : bakedOf(project, projPath(q.model)).mdl, num = (k, d) => (q[k] === undefined ? d : Number(q[k]));
      return smak.render(mdl, { view: q.view ?? (sourceAt(modelPath(q.model)).viewModel ? "first" : "orbit"), seq: num("anim", 0), frame: num("frame", 0), body: num("body", 0), skin: num("skin", 0), width: num("w", 640), height: num("h", 480), fov: num("fov", 90), yaw: num("yaw", 30), pitch: num("pitch", 15) });
    },
  };

  return new Promise((ready) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://x"), path = decodeURIComponent(url.pathname), q = Object.fromEntries(url.searchParams);
      try {
        if (path.startsWith("/api/")) {
          const name = path.slice(5), chunks = []; for await (const c of req) chunks.push(c);
          if (pictures[name]) { const r = pictures[name](q); if (r.file) res.writeHead(200, { "content-type": r.type, "content-disposition": `attachment; filename="${r.name}"` }).end(r.file); else image(res, r); return; }
          if (!api[name]) { res.writeHead(404).end("no such call"); return; }
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(api[name](q, Buffer.concat(chunks))));
          return;
        }
        const file = path === "/" ? "page/index.html" : path.slice(1);
        if (!/^(page\/[\w.-]+|core\.mjs)$/.test(file)) { res.writeHead(404).end("not found"); return; }
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(await readFile(join(HERE, file)));
      } catch (e) {
        if (!res.headersSent) res.writeHead(path.startsWith("/api/") ? 400 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }).listen(port, "127.0.0.1", () => { console.log(`smak editor: http://127.0.0.1:${port}/${first ? `?model=${encodeURIComponent(first)}` : ""}   (Ctrl+C stops it)\n  models from ${models} (only read)\n  projects and saved models in ${work}, checked for ${engine}`); ready(server); });
  });
}
