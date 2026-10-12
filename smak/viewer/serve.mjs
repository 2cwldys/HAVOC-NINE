// The viewer: a page that shows any two models side by side, turning and playing their animations together.
//
//   node bin/smak.mjs view <folder or model> [more ...] [--port 8098]        then open http://127.0.0.1:8098/
//
// This server reads the .mdl files with the kit and hands the page triangles already posed, frame by frame; the page
// (view.html) only draws them, so what it shows is what the kit reads. Every .mdl under the folders given is listed,
// and a file written later shows up after a reload. It listens on this machine only.
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as K from "../src/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// every .mdl under a folder, but for the side files of another model beside them: <name>t.mdl (its textures) and <name>01.mdl (its animations)
const walk = (dir) => {
  const all = readdirSync(dir, { withFileTypes: true }), here = new Set(all.filter((e) => !e.isDirectory()).map((e) => e.name.toLowerCase()));
  const side = (n) => { const m = /^(.+?)(t|\d\d)\.mdl$/i.exec(n); return Boolean(m) && here.has(`${m[1].toLowerCase()}.mdl`); };
  return all.flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.mdl$/i.test(e.name) && !side(e.name) ? [join(dir, e.name)] : []));
};

/** Starts the viewer over `roots` (folders, or single .mdl files). Resolves to the server once it listens. */
export function view(roots, port = 8098) {
  roots = roots.map((r) => resolve(r));
  const models = () => roots.flatMap((root, n) => {
    if (!statSync(root).isDirectory()) return [{ id: `${n}/${basename(root)}`, group: basename(dirname(root)), name: basename(root).replace(/\.mdl$/i, ""), file: root }];
    return walk(root).map((f) => { const rel = relative(root, f).replace(/\\/g, "/"), sub = rel.includes("/") ? rel.split("/")[0] : "";       // grouped by the first folder under the root
      return { id: `${n}/${rel}`, group: !sub ? basename(root) : roots.length > 1 ? `${basename(root)} / ${sub}` : sub, name: basename(f).replace(/\.mdl$/i, ""), file: f }; });
  });

  // one model, read once and kept while its file does not change
  const kept = new Map();
  function open(id) {
    const m = models().find((x) => x.id === id); if (!m) return null;
    const stamp = statSync(m.file).mtimeMs, had = kept.get(id); if (had?.stamp === stamp) return had;
    let src = readFileSync(m.file); const tfile = m.file.replace(/\.mdl$/i, "t.mdl");
    if (src.length > 184 && !src.readInt32LE(180) && existsSync(tfile)) src = K.withTextures(src, readFileSync(tfile));        // textures kept in the file beside it
    const info = K.readMdl(src), seqs = K.sequences(src), names = info.textures.map((t) => t.name), texOf = (t) => (t.tex ? names.indexOf(t.tex.name) : -1);
    // the triangles in the order the page draws them: by texture, so that each texture is one run
    const first = K.posed(src, { seq: seqs.length ? 0 : null }).tris, order = first.map((t, i) => i).sort((a, b) => texOf(first[a]) - texOf(first[b]) || a - b);
    const runs = []; for (const i of order) { const t = texOf(first[i]), last = runs.at(-1); if (last?.tex === t) last.count += 3; else runs.push({ tex: t, start: runs.reduce((a, r) => a + r.count, 0), count: 3 }); }
    const uv = new Float32Array(order.length * 6); order.forEach((i, k) => first[i].c.forEach((c, j) => { const tex = first[i].tex; uv[k * 6 + j * 2] = tex ? c.u / tex.width : 0; uv[k * 6 + j * 2 + 1] = tex ? c.v / tex.height : 0; }));
    const one = { stamp, src, info, seqs, order, runs, uv, frames: new Map(), bytes: src.length, check: K.check(src, "goldsrc") };
    kept.set(id, one); return one;
  }
  function frame(one, seq, fr) {
    const key = `${seq}:${fr}`; if (one.frames.has(key)) return one.frames.get(key);
    const tris = K.posed(one.src, { seq: one.seqs.length && !one.seqs[seq]?.group ? seq : null, frame: fr }).tris, out = new Float32Array(one.order.length * 18);
    one.order.forEach((i, k) => tris[i].c.forEach((c, j) => { out.set(c.p, k * 18 + j * 6); out.set(c.n, k * 18 + j * 6 + 3); }));
    if (one.frames.size > 400) one.frames.clear();
    one.frames.set(key, out); return out;
  }

  return new Promise((ready) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://x"), q = url.searchParams, send = (type, body) => res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
      try {
        if (url.pathname === "/") return send("text/html; charset=utf-8", readFileSync(join(HERE, "view.html")));
        if (url.pathname === "/api/models") return send("application/json", JSON.stringify(models().map(({ id, group, name }) => ({ id, group, name }))));
        const one = open(q.get("id")); if (!one) { res.writeHead(404).end("no such model"); return; }
        if (url.pathname === "/api/model") {
          const submodels = one.info.bodyparts.flatMap((bp) => bp.models.map((m) => ({ part: bp.name, name: m.name, points: m.numverts, triangles: m.meshes.reduce((a, x) => a + x.numtris, 0) })));
          return send("application/json", JSON.stringify({ bytes: one.bytes, bones: one.info.bones.length, triangles: one.order.length, runs: one.runs, uv: Array.from(one.uv, (v) => Math.round(v * 1e4) / 1e4),
            textures: one.info.textures.map((t) => ({ name: t.name, width: t.width, height: t.height, flags: t.flags })), sequences: one.seqs.map((s) => ({ name: s.name, frames: s.frames, fps: s.fps, loops: s.loops })), submodels, check: one.check }));
        }
        if (url.pathname === "/api/texture") { const t = K.textureOf(one.src, Number(q.get("n"))); return send("image/png", K.png(t.width, t.height, K.rgbaOf(t, Boolean(t.flags & 64)))); }
        if (url.pathname === "/api/frame") { const f = frame(one, Number(q.get("seq")), Number(q.get("frame"))); return send("application/octet-stream", Buffer.from(f.buffer, f.byteOffset, f.byteLength)); }
        res.writeHead(404).end("not found");
      } catch (e) { res.writeHead(500).end(String(e?.stack ?? e)); }
    }).listen(port, "127.0.0.1", () => { console.log(`smak viewer: http://127.0.0.1:${port}/   (${models().length} models; Ctrl+C stops it)`); ready(server); });
  });
}
