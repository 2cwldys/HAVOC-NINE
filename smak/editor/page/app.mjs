// The editor's page: what is shown, and every edit turned into a patch (core.mjs) that the server makes on the project
// file. The page keeps nothing of its own but what is on the screen: the project is the file, and when an agent changes
// it from a terminal the page takes the new one up within a second.
import * as core from "/core.mjs";
import { createView } from "/page/view.mjs";

const $ = (id) => document.getElementById(id), Q = new URLSearchParams(location.search), DEG = core.DEG;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const S = { id: null, scene: null, project: null, ctx: null, bases: new Map(), geo: new Map(), texKeys: new Map(), worn: new Set(), n: 0, frame: 0, playing: false, bone: -1, mode: "rotate", spread: "", picks: [], skin: 0,
  tab: Q.get("tab") ?? "pose", undo: [], redo: [], clip: null, live: null, pending: null, anim: null, frames: [], world: [], tex: Number(Q.get("tex") ?? -1), uv: Q.get("uv") === "1", saved: null, evSel: -1, dirty: true, giz: null, hover: -1, thinNote: "", ready: false, busy: 0, first: true };
const view = createView($("gl")), over = $("over"), octx = over.getContext("2d"), track = $("track"), tctx = track.getContext("2d");
const TABS = [["pose", "Pose"], ["anim", "Animation"], ["events", "Events"], ["textures", "Textures"], ["save", "Save"]];

function status(text, bad = false) { $("status").textContent = text; $("status").className = bad ? "bad" : ""; $("status").title = text; }
async function api(name, q = {}, body) {
  const r = await fetch(`/api/${name}?${new URLSearchParams(q)}`, body === undefined ? undefined : { method: "POST", body: body instanceof ArrayBuffer ? body : JSON.stringify(body) }), j = await r.json();
  if (j.error) throw new Error(j.error); return j;
}
const fail = (e) => { console.error(e); status(e.message, true); };

// ── opening ────────────────────────────────────────────────────────────────
async function openModel(id) {
  S.ready = false; status(`opening ${id}`);
  const sc = await api("open", { model: id });
  Object.assign(S, { id, scene: sc, project: sc.project, bases: new Map(), geo: new Map(), texKeys: new Map(), undo: [], redo: [], live: null, pending: null, bone: -1, saved: null, skin: 0, thinNote: "" });
  S.ctx = { bones: sc.bones, seqs: sc.seqs, base: (n) => { const f = S.bases.get(n); if (!f) throw new Error(`the frames of animation ${n} are not here yet`); return f; } };
  S.depth = []; sc.bones.forEach((b, i) => { S.depth[i] = b.parent < 0 ? 0 : S.depth[b.parent] + 1; });
  const body = S.first && Q.has("body") ? Number(Q.get("body")) : null;
  S.picks = sc.bodyparts.map((bp) => (body !== null ? Math.floor(body / bp.base) % bp.models.length : Math.max(0, bp.models.findIndex((m) => m.tris > 0))));
  view.cam.mode = sc.viewModel ? "first" : "orbit";          // a weapon in the hands as the player sees it, anything else from outside
  $("model").value = id; renderBodies(); await loadGeometry();
  const list = core.animList(S.project, S.ctx), want = S.first && Q.has("anim") ? core.animAt(S.project, S.ctx, Q.get("anim")) : (list.find((a) => !a.outside)?.n ?? 0);
  await selectAnim(want);
  if (S.first) {
    if (Q.has("frame")) S.frame = Math.min(S.anim.count - 1, Number(Q.get("frame")));
    if (Q.has("bone")) S.bone = sc.bones.findIndex((b) => b.name.toLowerCase() === Q.get("bone").toLowerCase());
    if (Q.has("cam")) view.cam.mode = Q.get("cam") === "first" ? "first" : "orbit";
    for (const [k, id2] of [["bones", "showBones"], ["onion", "showOnion"], ["compare", "showCompare"], ["smooth", "showLinear"]]) if (Q.has(k)) $(id2).checked = Q.get(k) === "1";
  }
  S.first = false; if (S.tex < 0 || !sc.textures[S.tex]) S.tex = [...S.worn][0] ?? 0;
  frameOrbit(); renderAll(); status(`${id}: ${sc.bones.length} bones, ${sc.seqs.length} animations, ${sc.textures.length} textures${sc.notes.length ? `; ${sc.notes.join("; ")}` : ""}`); S.ready = true;
}
const bodyNumber = () => S.scene.bodyparts.reduce((a, bp, i) => a + S.picks[i] * bp.base, 0);
async function loadGeometry() {
  const meshes = [];
  for (const [i] of S.scene.bodyparts.entries()) {
    const k = `${i}/${S.picks[i]}`; if (!S.geo.has(k)) S.geo.set(k, (await api("geometry", { model: S.id, bp: i, sub: S.picks[i] })).meshes);
    for (const m of S.geo.get(k)) { const n = (S.scene.skins[S.skin] ?? S.scene.skins[0] ?? [])[m.skinref], t = S.scene.textures[n]; meshes.push({ ...m, tex: t ? { n, ...t } : null }); }
  }
  view.setMeshes(meshes); S.worn = new Set(meshes.filter((m) => m.tex).map((m) => m.tex.n)); await refreshTextures(); S.dirty = true;
}
const texUrl = (n, adjust, extra = {}) => `/api/texture?${new URLSearchParams({ model: S.id, i: n, ...(adjust ? { adjust: JSON.stringify(adjust) } : {}), ...extra, v: `${S.project.rev}.${JSON.stringify(S.project.textures?.[n] ?? 0).length}` })}`;
/** The pictures of the textures the shown shapes wear, fetched again where the project now says something else of them. */
function refreshTextures(trial) {
  return Promise.all([...S.worn].map((n) => {
    const adj = trial?.n === n ? trial.adjust : null, key = JSON.stringify(S.project.textures?.[n] ?? null) + JSON.stringify(adj);
    if (S.texKeys.get(n) === key) return null; S.texKeys.set(n, key);
    return new Promise((done) => { const img = new Image(); img.onload = () => { if (S.texKeys.get(n) === key) { view.setTexture(n, img, S.scene.textures[n].flags); S.dirty = true; } done(); }; img.onerror = done; img.src = texUrl(n, adj, { t: Date.now() }); });
  }));
}
async function ensureBase(n) {
  const b = n >= S.scene.seqs.length ? S.project.anims?.[n]?.copyOf : n;
  if (b !== undefined && !S.bases.has(b)) S.bases.set(b, (await api("seq", { model: S.id, n: b })).frames);
}
/** How many animations the game mixes into this one (a player's aim up and down); none for most. Such a one is not posed here. */
const mixed = () => (S.n < S.scene.seqs.length && S.scene.seqs[S.n].blends > 1 ? S.scene.seqs[S.n].blends : 0);
const mixedSay = () => status(`${S.anim.name} is ${mixed()} animations that the game mixes: its motion is not changed here (its speed, looping and events can be). Duplicate it in the Animation tab to pose a copy`, true);
async function selectAnim(n) { await ensureBase(n); S.n = n; S.frame = 0; S.playing = false; S.evSel = -1; S.thinNote = ""; recompute(); renderAll(); if (S.ready && mixed()) mixedSay(); }
function recompute() {
  S.anim = core.animOf(S.live ?? S.project, S.ctx, S.n); S.frames = core.bakeAnim(S.anim, S.ctx);
  S.frame = Math.max(0, Math.min(S.frame, S.anim.count - 1)); S.dirty = true;
}
/** The pose at a moment (a frame, or between two, as the engine mixes them). */
function poseAt(frame) {
  const N = S.frames.length, i = Math.max(0, Math.min(N - 1, Math.floor(frame))), k = frame - i, j = i + 1 < N ? i + 1 : ($("loop").checked ? 0 : i), A = S.frames[i], B = S.frames[j];
  const values = k > 1e-6 ? A.map((v, b) => core.mix(v, B[b], k)) : A;
  return { values, world: core.worldOf(S.ctx.bones, values) };
}
function frameOrbit() {
  const w = poseAt(0).world; let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const m of view.meshes) for (let i = 0; i < m.count; i += 7) { const p = core.mpt(w[m.bone[i]], [m.src[i * 3], m.src[i * 3 + 1], m.src[i * 3 + 2]]); for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); } }
  if (mn[0] > mx[0]) { mn = [-10, -10, -10]; mx = [10, 10, 10]; }
  view.cam.target = mn.map((v, a) => (v + mx[a]) / 2); view.cam.dist = Math.max(10, Math.hypot(...sub(mx, mn)) * 1.7);
}

// ── keys of the bone in hand ───────────────────────────────────────────────
function boneKeys(b) {
  const k = S.anim.keys[S.ctx.bones[b].name];
  if (k && Object.keys(k).length) { const f = Object.keys(k).map(Number).sort((x, y) => x - y); return { f, touched: true, dense: f.length >= S.anim.count && S.anim.count > 2 }; }
  return { f: Array.from({ length: S.anim.count }, (_, i) => i), touched: false, dense: S.anim.count > 2 };
}
const spreadFor = (b) => (S.spread === "" ? (boneKeys(b).dense ? Math.max(3, Math.round(S.anim.count / 6)) : 0) : Math.max(0, Number(S.spread) || 0));
const atFrame = () => Math.round(S.frame);
const valuesNow = (b = S.bone) => core.valuesAt(S.project, S.ctx, S.n, b, atFrame());

// ── edits ──────────────────────────────────────────────────────────────────
async function send(patch) { S.busy++; try { return await api("patch", { model: S.id }, { set: patch.set, what: patch.what, by: "person" }); } finally { S.busy--; } }
/** An edit made: sent to the server, kept for undoing. */
async function commit(op) {
  if (!op?.set?.length) { status(op?.what ?? "nothing to change"); return; }
  try { const r = await send(op); S.undo.push({ what: op.what, set: r.inverse }); S.redo = []; S.project = r.project; status(op.what); } catch (e) { fail(e); }
  await afterProject();
}
async function unredo(from, to, word) {
  const u = from.pop(); if (!u) return;
  try { const r = await send({ set: u.set, what: `${word}: ${u.what}` }); to.push({ what: u.what, set: r.inverse }); S.project = r.project; status(`${word}: ${u.what}`); } catch (e) { fail(e); }
  await afterProject();
}
async function afterProject() {
  S.live = null; S.pending = null;
  const list = core.animList(S.project, S.ctx); if (!list.some((a) => a.n === S.n)) S.n = list[0].n;
  await ensureBase(S.n); recompute(); refreshTextures(); renderAll();
}
const tryOp = (make) => { try { return make(); } catch (e) { fail(e); return null; } };
const edit = (make) => { const op = tryOp(make); return op ? commit(op) : null; };
function setKey(values, note) { S.playing = false; S.frame = atFrame(); return edit(() => core.opKey(S.project, S.ctx, S.n, S.bone, S.frame, values, spreadFor(S.bone))); }

// ── the lists ──────────────────────────────────────────────────────────────
function renderBodies() {
  $("bodies").innerHTML = S.scene.bodyparts.map((bp, i) => `<select data-set="pick:${i}" title="${esc(bp.name)}: which submodel is shown (its body number)">${bp.models.map((m, k) => `<option value="${k}"${k === S.picks[i] ? " selected" : ""}>${esc(bp.name)} ${k * bp.base}: ${esc(m.name)}${m.tris ? "" : " (empty)"}</option>`).join("")}</select>`).join("")
    + (S.scene.skins.length > 1 ? `<select data-set="skin" title="Skin">${S.scene.skins.map((_, k) => `<option value="${k}">skin ${k}</option>`).join("")}</select>` : "");
}
function renderAnims() {
  $("anims").innerHTML = core.animList(S.project, S.ctx).map((a) => `<div class="row${a.n === S.n ? " sel" : ""}${a.outside ? " off" : ""}" ${a.outside ? 'title="kept in another file: cannot be read"' : `data-act="anim:${a.n}"`}>${a.n} <b>${esc(a.name)}</b> <small>${a.frames} at ${+a.fps.toFixed(2)}${a.loops ? " loop" : ""}</small>${a.added ? ' <span class="mark">new</span>' : a.edited ? ' <span class="mark">edited</span>' : ""}</div>`).join("");
}
function renderTree() {
  const find = $("boneFilter").value.trim().toLowerCase();
  $("tree").innerHTML = S.ctx.bones.map((b, i) => {
    if (find && !b.name.toLowerCase().includes(find)) return "";
    const k = S.anim.keys[b.name], n = k ? Object.keys(k).length : 0;
    return `<div class="row${i === S.bone ? " sel" : ""}" data-act="bone:${i}" style="padding-left:${10 + (find ? 0 : S.depth[i] * 9)}px" title="bone ${i}">${esc(b.name)}${n > 2 ? ` <span class="mark">${n >= S.anim.count ? "all" : n}</span>` : n ? " <small>" + n + "</small>" : ""}</div>`;
  }).join("");
  $("tree").querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

// ── the panes on the right ─────────────────────────────────────────────────
const PANES = {
  pose() {
    if (S.bone < 0) return `<h3>Pose</h3><p>Click a part of the model, a joint of the skeleton, or a name in the list on the left: that is the bone you pose.</p><p class="dim">Then drag a ring to turn it (or <kbd>G</kbd> and an arrow to move it). That sets a key for that bone at the frame the timeline is on.</p>
      <div class="btns"><button data-act="copy">Copy pose</button><button data-act="paste"${S.clip ? "" : " disabled"}>Paste pose</button><button data-act="pasteMirror"${S.clip ? "" : " disabled"}>Paste mirrored</button></div>`;
    const b = S.ctx.bones[S.bone], k = boneKeys(S.bone), f = atFrame(), has = k.f.includes(f), other = core.mirrorMap(S.ctx.bones)[S.bone];
    return `${mixed() ? `<p class="err">This animation is ${mixed()} that the game mixes (a player's aim up and down): it is not posed here. Its speed, looping and events can be changed; <i>Duplicate at the end</i> (Animation tab) gives a copy to pose.</p>` : ""}<h3>Bone ${S.bone}</h3><p><b>${esc(b.name)}</b> <small>${b.parent >= 0 ? `on ${esc(S.ctx.bones[b.parent].name)}` : "a root"}${other !== S.bone ? `; other side: ${esc(S.ctx.bones[other].name)}` : ""}</small></p>
      <div class="btns"><button data-act="mode:rotate" class="${S.mode === "rotate" ? "on" : ""}">Turn (R)</button><button data-act="mode:move" class="${S.mode === "move" ? "on" : ""}">Move (G)</button><button data-act="bone:-1">Let go (Esc)</button></div>
      <table><tr><th></th><th class="x">x</th><th class="y">y</th><th class="z">z</th></tr>
        <tr><td>turn, degrees</td>${[3, 4, 5].map((i) => `<td><input type="number" step="1" data-val="${i}"></td>`).join("")}</tr>
        <tr><td>place, units</td>${[0, 1, 2].map((i) => `<td><input type="number" step="0.1" data-val="${i}"></td>`).join("")}</tr></table>
      <p><label title="Carry the change, fading out, onto this bone's other keys this many frames either side. Empty: by itself (a bone with a key on every frame gets a sixth of the animation; a bone with few keys gets none). 0: this frame only.">spread <input type="number" min="0" step="1" data-set="spread" value="${esc(S.spread)}" placeholder="auto ${spreadFor(S.bone)}"> frames</label></p>
      <p id="keyNote">${k.touched ? (k.dense ? `A key on <b>every frame</b> (${k.f.length}).` : `<b>${k.f.length} keys</b>: ${k.f.slice(0, 40).join(", ")}${k.f.length > 40 ? "..." : ""}`) : `As the file has it: a key on <b>every frame</b> (${k.f.length}).`}${k.dense ? ' <span class="dim">A change here is spread over the frames about it; to shape the motion by hand from a few keys, thin them.</span>' : ""}</p>
      <div class="btns"><button data-act="key" title="Fix the bone as it is now at this frame (K)">Key here</button><button data-act="unkey" title="Remove this frame's key: the bone is interpolated here (Delete)"${has && k.f.length > 1 ? "" : " disabled"}>Remove key</button><button data-act="thinBone" title="Keep the fewest keys that give this bone's motion back">Thin this bone</button><button data-act="revertBone"${k.touched ? "" : " disabled"} title="Drop every key of this bone: it plays the original's frames again">Bone as original</button></div>
      <h3>Whole pose</h3><div class="btns"><button data-act="copy" title="Ctrl+C">Copy pose</button><button data-act="paste" title="Ctrl+V"${S.clip ? "" : " disabled"}>Paste pose</button><button data-act="pasteMirror" title="Left and right changed over (Ctrl+Shift+V)"${S.clip ? "" : " disabled"}>Paste mirrored</button></div>
      <p class="dim">Drag a ring: a turn about the bone's own axis of that colour. <kbd>Shift</kbd> steps by 5 degrees. The arrows move it along its parent's axes.</p>`;
  },
  anim() {
    const a = S.anim, src = S.ctx.seqs[a.baseN], keyed = Object.values(a.keys).filter((k) => Object.keys(k).length), total = keyed.reduce((s, k) => s + Object.keys(k).length, 0);
    const same = a.count === a.base.length ? core.poseError(S.ctx.bones, a.base, S.frames) : null;
    return `<h3>Animation ${a.n}</h3><p><b>${esc(a.name)}</b> <small>${a.added ? `new, begun as a copy of ${a.baseN} ${esc(src.name)}` : `in the file: ${src.frames} frames at ${+src.fps.toFixed(2)}`}</small></p>
      <table><tr><td>frames</td><td><input type="number" id="aFrames" min="1" step="1" value="${a.count}"> <button data-act="stretch" title="The whole animation, its keys and events, stretched or squeezed to this many frames">Stretch</button></td></tr>
        <tr><td>frames a second</td><td><input type="number" min="1" step="1" data-set="fps" value="${+a.fps.toFixed(3)}"> <small>${(Math.max(1, a.count - 1) / a.fps).toFixed(2)} s long</small></td></tr>
        <tr><td>looping</td><td><input type="checkbox" data-set="loops"${a.loops ? " checked" : ""}></td></tr>
        <tr><td>between keys</td><td><select data-set="interp"><option value="smooth"${a.smooth ? " selected" : ""}>a curve through them</option><option value="linear"${a.smooth ? "" : " selected"}>straight</option></select></td></tr></table>
      ${a.count !== src.frames && !a.added ? `<p class="warn">The game may time things by this animation's length (${src.frames} frames in the file).</p>` : ""}
      <h3>Keys</h3><p>${keyed.length ? `${keyed.length} of ${S.ctx.bones.length} bones have keys of their own, ${total} in all; the others play the original's frames.` : "Untouched: every bone plays the original's frames, which is a key on every frame."}</p>
      <p>${same ? `Furthest from the original now: <b>${same.units.toFixed(3)} units</b>, ${same.degrees.toFixed(2)} degrees${same.units > 1e-6 ? ` (frame ${same.frame}, ${esc(same.bone)})` : ""}.` : "Its length differs from the original's: no comparison."}</p>
      <p>Thin within <input type="number" id="thinRot" min="0" step="0.25" value="0.5"> degrees, <input type="number" id="thinPos" min="0" step="0.01" value="0.02"> units</p>
      <div class="btns"><button data-act="thin" title="Every bone keeps the fewest keys that give its motion back within that">Thin the keys</button><button data-act="revertAnim"${a.entry && !a.added ? "" : " disabled"} title="Forget everything the project says of this animation">Animation as original</button></div>
      <p class="warn">${esc(S.thinNote)}</p>
      <h3>Duplicate</h3><p><input type="text" id="dupName" maxlength="31" value="${esc((a.name + "_b").slice(0, 31))}"> <button data-act="dup" title="The same animation again under this name, after the last one: the others keep their numbers">Duplicate at the end</button></p>
      <p class="dim">Animations are never removed or moved: the game plays them by number.</p>`;
  },
  events() {
    const a = S.anim;
    return `<h3>Events of ${esc(a.name)}</h3><p class="dim">What the animation sets off at a frame: a sound, a flash. The game's code knows them by number: 5004 plays the sound named in the text, on the client.</p>
      <table class="ev"><tr><th>frame</th><th>event</th><th>text</th><th></th></tr>${a.events.map((e, i) => `<tr class="${i === S.evSel ? "sel" : ""}"><td><input type="number" min="0" max="${a.count - 1}" step="1" value="${e.frame}" data-ev="${i}:frame"></td><td><input type="number" step="1" value="${e.event}" data-ev="${i}:event" style="width:58px"></td><td><input type="text" maxlength="63" value="${esc(e.options)}" data-ev="${i}:options"></td><td><button data-act="evGo:${i}" title="Go to its frame">go</button><button data-act="evDel:${i}" title="Remove it">x</button></td></tr>`).join("")}</table>
      ${a.events.length ? "" : "<p>None.</p>"}<div class="btns"><button data-act="evAdd">Add one at frame ${atFrame()}</button><button data-act="evRevert"${a.entry?.events && !a.added ? "" : " disabled"}>Events as original</button></div>
      <p class="dim">On the timeline: drag a flag to move it, double click the events row to add one.</p>`;
  },
  textures() {
    const t = S.scene.textures[S.tex]; if (!t) return "<h3>Textures</h3><p>This model has none inside it.</p>";
    const e = S.project.textures?.[S.tex] ?? {}, adj = e.adjust ?? {}, FL = [[1, "flat"], [2, "chrome"], [4, "full bright"], [32, "additive (a glow)"], [64, "masked (index 255 is a hole)"]].filter(([f]) => t.flags & f).map((x) => x[1]).join(", ");
    const order = [...S.scene.textures.keys()].sort((a, b) => (S.worn.has(b) - S.worn.has(a)) || a - b), slider = (k, lo, hi, label) => `<tr><td>${label}</td><td><input type="range" min="${lo}" max="${hi}" step="1" value="${adj[k] ?? 0}" data-adj="${k}" title="Drag it, or click it and step with the arrow keys"> <input type="number" min="${lo}" max="${hi}" step="1" value="${adj[k] ?? 0}" data-num="${k}" title="The same value, to type: ${lo} to ${hi}"></td></tr>`;
    const tint = adj.tint ?? [255, 255, 255], hex = "#" + tint.map((v) => v.toString(16).padStart(2, "0")).join("");
    return `<h3>Texture</h3><select data-set="tex" style="max-width:100%">${order.map((n) => `<option value="${n}"${n === S.tex ? " selected" : ""}>${S.worn.has(n) ? "* " : ""}${n} ${esc(S.scene.textures[n].name)}${S.project.textures?.[n]?.file || Object.keys(S.project.textures?.[n]?.adjust ?? {}).length ? " (changed)" : ""}</option>`).join("")}</select>
      <p><small>${t.width}x${t.height}${FL ? `, ${FL}` : ""}${S.worn.has(S.tex) ? ", worn by what is shown" : ", not worn by what is shown"}${e.file ? `; replaced by ${esc(e.file)}` : ""}</small></p>
      <label><input type="checkbox" data-set="uv"${S.uv ? " checked" : ""}> the triangles that wear it</label>
      <img id="texImg" alt="" src="${texUrl(S.tex, null, S.uv ? { uv: 1 } : {})}">
      <div id="drop">Drop a PNG or BMP here to replace it, or <input type="file" id="texFile" accept=".png,.bmp" style="width:190px"></div>
      <div class="btns"><a href="${texUrl(S.tex, null, { as: "png" })}" download><button>Export PNG</button></a><a href="${texUrl(S.tex, null, { as: "bmp" })}" download><button title="8 bits with its palette, index for index">Export BMP</button></a><button data-act="texUnfile"${e.file ? "" : " disabled"}>Original picture</button></div>
      <h3>Whole picture, through its palette</h3><table>${slider("brightness", -100, 100, "brightness")}${slider("contrast", -100, 100, "contrast")}${slider("saturation", -100, 100, "colour")}${slider("hue", -180, 180, "hue")}${slider("tintAmount", 0, 100, "tint")}
        <tr><td>tint colour</td><td><input type="color" value="${hex}" data-adj="tint" style="padding:0;width:44px;height:22px"> <input type="text" value="${hex}" data-hex maxlength="7" spellcheck="false" title="The same colour as hex digits, to type: #rrggbb"></td></tr></table>
      <div class="btns"><button data-act="texReset"${Object.keys(adj).length ? "" : " disabled"}>No adjustments</button></div>
      <p class="dim">A replacement of any size is brought down to 256 colours; the model's corners follow its size. No painting here.</p>`;
  },
  save() {
    const r = S.saved, log = [...(S.project.log ?? [])].reverse().slice(0, 25), items = (list, cls) => list.map((x) => `<li class="${cls}">${esc(x)}</li>`).join("");
    return `<h3>Save</h3><p>The project is baked onto the <b>original</b> model every time and written beside the project. The original is never written over.</p>
      <table><tr><td>engine</td><td><select data-set="engine"><option value="xash"${S.project.engine !== "goldsrc" ? " selected" : ""}>Xash3D</option><option value="goldsrc"${S.project.engine === "goldsrc" ? " selected" : ""}>GoldSrc (Half-Life's own)</option></select></td></tr>
        <tr><td>file</td><td><input type="text" data-set="output" value="${esc(S.project.output)}" style="width:210px"></td></tr></table>
      <div class="btns"><button data-act="save" class="go">Save model (Ctrl+S)</button></div>
      ${r ? `<p class="${r.errors.length ? "err" : "fine"}">${r.errors.length ? "Written, with errors: the game may not load it." : "Written and checked."} <small>${esc(r.out)}, ${r.bytes} bytes, checked for ${r.engine}</small></p><ul>${items(r.errors, "err")}${items(r.warnings, "warn")}${items(r.notes, "warn")}${items(r.facts, "dim")}</ul>` : ""}
      <h3>Project</h3><p><small>${esc(S.scene.projectPath)}<br>revision ${S.project.rev}; source ${esc(S.project.source.path)}</small></p>
      <h3>Who did what</h3>${log.length ? `<ul>${log.map((l) => `<li><small>${l.rev} ${esc(l.by)}</small> ${esc(l.what)}</li>`).join("")}</ul>` : '<p class="dim">Nothing yet.</p>'}`;
  },
};
function renderPane() {
  $("tabs").innerHTML = TABS.map(([k, name]) => `<button data-act="tab:${k}" class="${k === S.tab ? "on" : ""}">${name}</button>`).join("");
  // a box of the texture's adjustments that has the keyboard keeps it through the redraw, and, while an edit of it is still on its way to the server, its value
  const a = document.activeElement, d = a && $("pane").contains(a) ? a.dataset : {}, held = d.adj ? `[data-adj="${d.adj}"]` : d.num ? `[data-num="${d.num}"]` : d.hex !== undefined ? "[data-hex]" : null, value = a?.value;
  const scroll = $("right").scrollTop; $("pane").innerHTML = (PANES[S.tab] ?? PANES.pose)(); $("right").scrollTop = scroll; S.shownFrame = -1;
  const again = held && $("pane").querySelector(held); if (again) { if (S.busy && again.value !== value) { again.value = value; pairAdjust(again); } again.focus(); }
}
function renderAll() {
  renderAnims(); renderTree(); renderPane();
  $("undo").disabled = !S.undo.length; $("redo").disabled = !S.redo.length; $("undo").title = S.undo.length ? `Undo: ${S.undo[S.undo.length - 1].what} (Ctrl+Z)` : "Nothing to undo";
  $("camFirst").className = view.cam.mode === "first" ? "on" : ""; $("camOrbit").className = view.cam.mode === "orbit" ? "on" : "";
  $("frame").max = S.anim.count - 1; $("of").textContent = `of ${S.anim.count - 1}`; S.dirty = true; compareSoon();
}
/** What changes with the frame alone: the numbers of the bone in hand, the frame's box, the play button. */
function renderFrame() {
  const f = atFrame(); $("play").textContent = S.playing ? "Pause" : "Play";
  if (document.activeElement !== $("frame")) $("frame").value = f;
  if (S.shownFrame === f && !S.live) return; S.shownFrame = f;
  if (S.tab === "pose" && S.bone >= 0) {
    const v = S.frames[f][S.bone];
    for (const el of $("pane").querySelectorAll("[data-val]")) if (document.activeElement !== el) { const i = Number(el.dataset.val); el.value = i < 3 ? +v[i].toFixed(3) : +(v[i] / DEG).toFixed(2); }
  }
  if (S.tab === "events") { const b = $("pane").querySelector('[data-act="evAdd"]'); if (b) b.textContent = `Add one at frame ${f}`; }
}
let cmpTimer = 0;
function compareSoon() {
  const on = $("showCompare").checked; $("cmp").hidden = !on; if (!on || !S.anim) return;
  clearTimeout(cmpTimer); cmpTimer = setTimeout(() => {
    const c = view.camera(), first = view.cam.mode === "first";
    $("cmpImg").src = `/api/render?${new URLSearchParams({ model: S.id, anim: S.n, frame: atFrame(), body: bodyNumber(), skin: S.skin, view: first ? "first" : "orbit", w: Math.round(view.cssW ?? 640), h: Math.round(view.cssH ?? 480), fov: first ? c.hfov : 90, yaw: view.cam.yaw, pitch: view.cam.pitch, v: S.project.rev })}`;
  }, 300);
}

// ── what the buttons do ────────────────────────────────────────────────────
const evList = () => S.anim.events.map((e) => ({ ...e }));
const ACT = {
  tab: (k) => { S.tab = k; renderPane(); },
  anim: (n) => selectAnim(Number(n)).catch(fail),
  bone: (i) => { S.bone = Number(i); renderTree(); renderPane(); S.dirty = true; },
  mode: (m) => { S.mode = m; renderPane(); S.dirty = true; },
  cam: (m) => { view.cam.mode = m; renderAll(); },
  undo: () => unredo(S.undo, S.redo, "undo"), redo: () => unredo(S.redo, S.undo, "redo"),
  play: () => { S.playing = !S.playing; if (S.playing && S.frame >= S.anim.count - 1) S.frame = 0; if (!S.playing) { S.frame = atFrame(); compareSoon(); } S.dirty = true; },
  first: () => go(0), last: () => go(S.anim.count - 1), prev: () => go(atFrame() - 1), next: () => go(atFrame() + 1),
  prevKey: () => { if (S.bone < 0) return go(atFrame() - 1); const f = boneKeys(S.bone).f.filter((x) => x < atFrame()); go(f.length ? f[f.length - 1] : 0); },
  nextKey: () => { if (S.bone < 0) return go(atFrame() + 1); const f = boneKeys(S.bone).f.find((x) => x > atFrame()); go(f ?? S.anim.count - 1); },
  key: () => S.bone >= 0 && edit(() => core.opKey(S.project, S.ctx, S.n, S.bone, atFrame(), valuesNow(), 0)),
  unkey: () => S.bone >= 0 && edit(() => core.opDeleteKey(S.project, S.ctx, S.n, S.bone, atFrame())),
  revertBone: () => S.bone >= 0 && edit(() => core.opDeleteKey(S.project, S.ctx, S.n, S.bone, "all")),
  revertAnim: () => commit({ what: `${S.anim.name} as the original`, set: [{ path: ["anims", S.n], value: null }] }),
  thinBone: () => thin([S.ctx.bones[S.bone].name]), thin: () => thin(),
  copy: () => { S.clip = S.frames[atFrame()].map((v) => v.slice()); status(`pose of frame ${atFrame()} copied`); renderPane(); },
  paste: () => S.clip && edit(() => core.opPaste(S.project, S.ctx, S.n, atFrame(), S.clip)),
  pasteMirror: () => S.clip && edit(() => core.opPaste(S.project, S.ctx, S.n, atFrame(), core.mirrorPose(S.ctx.bones, S.clip))),
  stretch: () => edit(() => core.opSettings(S.project, S.ctx, S.n, { frames: Number($("aFrames").value) })),
  dup: async () => { const op = tryOp(() => core.opDuplicate(S.project, S.ctx, S.n, $("dupName").value)); if (!op) return; await commit(op); await selectAnim(op.n); },
  evAdd: (_, __, frame = atFrame()) => { const list = evList(), last = list[list.length - 1]; list.push({ frame, event: last?.event ?? 5004, type: 0, options: last?.event === 5004 || !last ? "weapons/swingsmall.wav" : "" }); S.tab = "events"; return edit(() => core.opEvents(S.project, S.ctx, S.n, list)); },
  evDel: (i) => { const list = evList(); list.splice(Number(i), 1); S.evSel = -1; return edit(() => core.opEvents(S.project, S.ctx, S.n, list)); },
  evGo: (i) => { S.evSel = Number(i); go(S.anim.events[i].frame); renderPane(); },
  evRevert: () => commit({ what: `events of ${S.anim.name} as the original`, set: [{ path: ["anims", S.n, "events"], value: null }] }),
  texUnfile: () => commit({ what: `texture ${S.scene.textures[S.tex].name}: the original picture`, set: [{ path: ["textures", S.tex, "file"], value: null }] }),
  texReset: () => commit({ what: `texture ${S.scene.textures[S.tex].name}: no adjustments`, set: [{ path: ["textures", S.tex, "adjust"], value: null }] }),
  save: async () => {
    status("baking and checking..."); S.tab = "save";
    try { S.saved = await api("bake", { model: S.id }, {}); status(`saved ${S.saved.out}: ${S.saved.errors.length} errors, ${S.saved.warnings.length} warnings`, S.saved.errors.length > 0); } catch (e) { fail(e); }
    renderPane();
  },
};
function go(f) { S.playing = false; S.frame = Math.max(0, Math.min(S.anim.count - 1, Math.round(f))); S.dirty = true; compareSoon(); }
async function thin(bones) {
  const rot = Number($("thinRot")?.value ?? 0.5), pos = Number($("thinPos")?.value ?? 0.02), was = S.frames, op = tryOp(() => core.opThin(S.project, S.ctx, S.n, { rot, pos, bones })); if (!op) return;
  await commit(op); const e = core.poseError(S.ctx.bones, was, S.frames);
  S.thinNote = `${op.before} keys to ${op.after}. The thinned animation is at most ${e.units.toFixed(3)} units and ${e.degrees.toFixed(2)} degrees from what it was${e.units > 1e-6 ? ` (frame ${e.frame}, ${e.bone})` : ""}.`; status(S.thinNote); renderPane();
}
const SET = {
  pick: async (v, el) => { S.picks[Number(el.dataset.set.split(":")[1])] = Number(v); await loadGeometry(); renderPane(); compareSoon(); },
  skin: async (v) => { S.skin = Number(v); await loadGeometry(); compareSoon(); },
  spread: (v) => { S.spread = v; },
  fps: (v) => edit(() => core.opSettings(S.project, S.ctx, S.n, { fps: Number(v) })),
  loops: (_, el) => edit(() => core.opSettings(S.project, S.ctx, S.n, { loops: el.checked })),
  interp: (v) => edit(() => core.opSettings(S.project, S.ctx, S.n, { interp: v })),
  tex: (v) => { S.tex = Number(v); renderPane(); }, uv: (_, el) => { S.uv = el.checked; renderPane(); },
  engine: (v) => commit({ what: `engine: ${v}`, set: [{ path: ["engine"], value: v }] }),
  output: (v) => commit({ what: `output: ${v}`, set: [{ path: ["output"], value: v.trim() }] }),
};
document.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (!b || b.disabled || !S.scene) return; const [name, arg] = b.dataset.act.split(":"); Promise.resolve(ACT[name]?.(arg, b)).catch(fail); });
document.addEventListener("change", (e) => {
  const el = e.target; if (!S.scene) return;
  if (el.dataset.set) return void Promise.resolve(SET[el.dataset.set.split(":")[0]]?.(el.value, el)).catch(fail);
  if (el.dataset.val !== undefined && S.bone >= 0) { const v = valuesNow(), i = Number(el.dataset.val); v[i] = i < 3 ? Number(el.value) : Number(el.value) * DEG; return void setKey(v); }
  if (el.dataset.ev) { const [i, k] = el.dataset.ev.split(":"), list = evList(); list[Number(i)][k] = k === "options" ? el.value : Number(el.value); S.evSel = -1; return void edit(() => core.opEvents(S.project, S.ctx, S.n, list)); }
  if (el.dataset.adj || el.dataset.num || el.dataset.hex !== undefined) return void commitAdjust(el);
  if (el.id === "texFile" && el.files[0]) return void upload(el.files[0]);
  if (el.id === "model") return void openModel(el.value).catch(fail);
  if (el.id === "frame") return go(Number(el.value));
  if (el.id === "showCompare") { if (el.checked) view.cam.mode = "first"; renderAll(); }
  if (el.id === "showLinear") view.linear = el.checked;
  S.dirty = true;
});
$("boneFilter").addEventListener("input", renderTree);
// a texture's adjustments: tried as the slider moves or a value is typed, written when it is let go or the box is left
const adjustNow = () => { const adj = {}; for (const el of $("pane").querySelectorAll("[data-adj]")) { if (el.type === "color") { const t = [1, 3, 5].map((i) => parseInt(el.value.slice(i, i + 2), 16)); if (t.some((v) => v !== 255)) adj.tint = t; } else if (Number(el.value)) adj[el.dataset.adj] = Number(el.value); } return adj; };
/** The two boxes of one adjustment made alike from the one just changed: a slider and its number, the colour and its hex digits. False while what is typed is not a value. */
function pairAdjust(el) {
  const pane = $("pane"), d = el.dataset;
  if (d.num) { const s = pane.querySelector(`[data-adj="${d.num}"]`), v = Number(el.value); if (!s || el.value.trim() === "" || isNaN(v)) return false; s.value = Math.max(Number(s.min), Math.min(Number(s.max), Math.round(v))); }
  else if (d.hex !== undefined) { const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(el.value.trim()), c = pane.querySelector('[data-adj="tint"]'); if (!m || !c) return false; c.value = "#" + (m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1]).toLowerCase(); }
  else if (el.type === "color") { const t = pane.querySelector("[data-hex]"); if (t) t.value = el.value; }
  else { const n = pane.querySelector(`[data-num="${d.adj}"]`); if (n) n.value = el.value; }
  return true;
}
let adjTimer = 0, adjSent = null;
document.addEventListener("input", (e) => {
  const d = e.target.dataset ?? {}; if (!d.adj && !d.num && d.hex === undefined) return; if (!pairAdjust(e.target)) return; const adj = adjustNow();
  clearTimeout(adjTimer); adjTimer = setTimeout(() => { refreshTextures({ n: S.tex, adjust: adj }); const img = $("texImg"); if (img && !S.uv) img.src = texUrl(S.tex, adj, { t: Date.now() }); }, 120);
});
function commitAdjust(el) {
  // a typed value is taken as the slider or the colour box took it (rounded, kept within its range); what is not a value is put back
  if (el && !pairAdjust(el)) status(`${el.value || "nothing"} is not ${el.dataset.num ? "a number" : "a colour: six hex digits, as #c08040"}`, true);
  if (el?.dataset.num) el.value = $("pane").querySelector(`[data-adj="${el.dataset.num}"]`)?.value ?? el.value; else if (el && el.dataset.hex !== undefined) el.value = $("pane").querySelector('[data-adj="tint"]')?.value ?? el.value;
  const adj = adjustNow(), t = S.scene.textures[S.tex], same = (x) => JSON.stringify([S.tex, Object.entries(x ?? {}).sort()]), key = same(adj);
  if (key === (adjSent ?? same(S.project.textures?.[S.tex]?.adjust))) return null;          // what the project says already, or is being told: one change is one line of its log
  adjSent = key;
  return commit({ what: `texture ${t.name} adjusted: ${Object.entries(adj).map(([k, v]) => `${k} ${v}`).join(", ") || "back to none"}`, set: [{ path: ["textures", S.tex, "name"], value: t.name }, { path: ["textures", S.tex, "adjust"], value: Object.keys(adj).length ? adj : null }] }).finally(() => { if (adjSent === key) adjSent = null; });
}
async function upload(file) {
  try { S.busy++; const r = await api("upload", { model: S.id, i: S.tex, name: file.name }, await file.arrayBuffer()); S.undo.push({ what: `texture replaced from ${file.name}`, set: r.inverse }); S.redo = []; S.project = r.project; status(`texture ${S.scene.textures[S.tex].name} replaced from ${file.name}`); } catch (e) { fail(e); } finally { S.busy--; }
  await afterProject();
}
$("right").addEventListener("dragover", (e) => { if (S.tab === "textures") { e.preventDefault(); $("drop")?.classList.add("over"); } });
$("right").addEventListener("dragleave", () => $("drop")?.classList.remove("over"));
$("right").addEventListener("drop", (e) => { if (S.tab !== "textures") return; e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) upload(f); });

// ── the 3D view: what is drawn over it, and the mouse ──────────────────────
const AXIS = ["#ff6b6b", "#6bd96b", "#6b9cff"];
function gizmoOf() {
  if (S.bone < 0 || !$("showBones").checked && false) return null;
  const W = S.world[S.bone], c = [W[3], W[7], W[11]], sc = view.project(c); if (!sc) return null;
  const r = 62 * view.unitsPerPixel(c), bn = S.ctx.bones[S.bone], F = S.mode === "rotate" ? W : (bn.parent >= 0 ? S.world[bn.parent] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  const ax = [0, 1, 2].map((k) => [F[k], F[4 + k], F[8 + k]]);
  const parts = ax.map((a, k) => {
    if (S.mode !== "rotate") { const tip = view.project(c.map((x, j) => x + r * a[j])); return tip ? [sc, tip] : []; }
    const u = ax[(k + 1) % 3], v = ax[(k + 2) % 3], pts = [];
    for (let i = 0; i <= 48; i++) { const t = i / 48 * 2 * Math.PI, p = view.project(c.map((x, j) => x + r * (Math.cos(t) * u[j] + Math.sin(t) * v[j]))); if (p) pts.push(p); }
    return pts;
  });
  return { c, sc, r, ax, parts };
}
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0; return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); }
function gizmoHit(x, y) { let best = 9, hit = -1; S.giz?.parts.forEach((pts, k) => { for (let i = 0; i + 1 < pts.length; i++) { const d = segDist([x, y], pts[i], pts[i + 1]); if (d < best) { best = d; hit = k; } } }); return hit; }
function drawOverlay() {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = over.clientWidth, h = over.clientHeight;
  if (over.width !== Math.round(w * dpr) || over.height !== Math.round(h * dpr)) { over.width = Math.round(w * dpr); over.height = Math.round(h * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, w, h); octx.lineCap = "round";
  if (view.cam.mode === "first" && w / h > 4 / 3 + 0.01) { const gw = h * 4 / 3, x0 = (w - gw) / 2; octx.strokeStyle = "#ffffff30"; octx.setLineDash([4, 6]); octx.lineWidth = 1; octx.strokeRect(x0, -1, gw, h + 2); octx.setLineDash([]); octx.fillStyle = "#ffffff50"; octx.font = "11px system-ui"; octx.fillText("4:3", x0 + 4, h - 6); }
  S.joints = S.world.map((W) => view.project([W[3], W[7], W[11]]));
  if ($("showBones").checked) {
    const keyed = S.ctx.bones.map((b) => Boolean(S.anim.keys[b.name] && Object.keys(S.anim.keys[b.name]).length));
    octx.lineWidth = 1.5;
    S.ctx.bones.forEach((b, i) => { const a = S.joints[i], p = b.parent >= 0 ? S.joints[b.parent] : null; if (!a || !p) return; octx.strokeStyle = i === S.bone ? "#ffffff" : keyed[i] ? "#e2c47acc" : "#c8d2e080"; octx.beginPath(); octx.moveTo(p[0], p[1]); octx.lineTo(a[0], a[1]); octx.stroke(); });
    S.joints.forEach((a, i) => { if (!a) return; octx.fillStyle = i === S.bone ? "#ffffff" : keyed[i] ? "#e2c47a" : "#c8d2e0b0"; octx.beginPath(); octx.arc(a[0], a[1], i === S.bone ? 4.5 : 2.6, 0, 7); octx.fill(); });
  }
  S.giz = gizmoOf();
  if (S.giz) {
    S.giz.parts.forEach((pts, k) => {
      if (pts.length < 2) return; const hot = S.drag?.axis === k || (!S.drag && S.hover === k);
      octx.strokeStyle = AXIS[k]; octx.lineWidth = hot ? 5 : 2.5; octx.globalAlpha = S.drag && !hot ? 0.25 : 1; octx.beginPath(); pts.forEach((p, i) => (i ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1]))); octx.stroke();
      if (S.mode !== "rotate") { const t = pts[1]; octx.fillStyle = AXIS[k]; octx.beginPath(); octx.arc(t[0], t[1], hot ? 7 : 5, 0, 7); octx.fill(); }
    });
    octx.globalAlpha = 1; const [x, y] = S.giz.sc, name = S.ctx.bones[S.bone].name; octx.font = "12px system-ui"; const tw = octx.measureText(name).width;
    octx.fillStyle = "#000a"; octx.fillRect(x + 10, y - 22, tw + 10, 17); octx.fillStyle = "#fff"; octx.fillText(name, x + 15, y - 9);
  }
}
const at = (e) => { const r = over.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
over.addEventListener("contextmenu", (e) => e.preventDefault());
over.addEventListener("pointerdown", (e) => {
  if (!S.ready) return; over.setPointerCapture(e.pointerId); const [x, y] = at(e), k = e.button === 0 ? gizmoHit(x, y) : -1;
  if (k >= 0 && mixed()) { mixedSay(); S.drag = null; return; }
  if (k >= 0) {
    S.playing = false; S.frame = atFrame(); const v0 = valuesNow(), g = S.giz, toward = dot(g.ax[k], sub(view.basis.eye, g.c)) > 0, tip = S.mode === "rotate" ? null : view.project(g.c.map((c, j) => c + g.ax[k][j]));
    S.drag = { kind: S.mode, axis: k, v0, q0: core.qOf(v0[3], v0[4], v0[5]), toward, last: Math.atan2(y - g.sc[1], x - g.sc[0]), acc: 0, x, y, per: tip ? [tip[0] - g.sc[0], tip[1] - g.sc[1]] : null, spread: spreadFor(S.bone) };
  } else S.drag = { kind: "cam", x, y, lx: x, ly: y, moved: false, pan: e.button !== 0 || e.shiftKey };
});
over.addEventListener("pointermove", (e) => {
  const [x, y] = at(e), d = S.drag;
  if (!d) { const k = gizmoHit(x, y); if (k !== S.hover) { S.hover = k; S.dirty = true; } over.style.cursor = k >= 0 ? "grab" : "default"; return; }
  if (d.kind === "cam") {
    if (Math.hypot(x - d.x, y - d.y) > 4) d.moved = true;
    if (d.moved && view.cam.mode === "orbit") {
      const c = view.cam, dx = x - d.lx, dy = y - d.ly;
      if (d.pan) { const b = view.basis, u = view.unitsPerPixel(c.target); c.target = c.target.map((v, k) => v - b.right[k] * dx * u + b.up[k] * dy * u); } else { c.yaw -= dx * 0.4; c.pitch = Math.max(-89, Math.min(89, c.pitch + dy * 0.4)); }
      S.dirty = true;
    }
    d.lx = x; d.ly = y; return;
  }
  let values;
  if (d.kind === "rotate") {
    const a = Math.atan2(y - S.giz.sc[1], x - S.giz.sc[0]); let step = a - d.last; step -= 2 * Math.PI * Math.round(step / (2 * Math.PI)); d.acc += step; d.last = a;
    let ang = d.toward ? -d.acc : d.acc; if (e.shiftKey) ang = Math.round(ang / (5 * DEG)) * 5 * DEG;
    const axis = [0, 0, 0]; axis[d.axis] = 1; d.note = `${(ang / DEG).toFixed(1)} degrees about ${"xyz"[d.axis]}`;
    values = [d.v0[0], d.v0[1], d.v0[2], ...core.eulerOfQ(core.qMul(d.q0, core.qAxis(axis, ang)))];
  } else {
    let u = ((x - d.x) * d.per[0] + (y - d.y) * d.per[1]) / Math.max(1e-6, d.per[0] ** 2 + d.per[1] ** 2); if (e.shiftKey) u = Math.round(u * 4) / 4;
    values = d.v0.slice(); values[d.axis] += u; d.note = `${u.toFixed(2)} units along ${"xyz"[d.axis]}`;
  }
  const op = tryOp(() => core.opKey(S.project, S.ctx, S.n, S.bone, S.frame, values, d.spread)); if (!op) return;
  S.pending = op; S.live = core.applyPatch(S.project, op.set).project; recompute(); status(`${S.ctx.bones[S.bone].name}: ${d.note}${d.spread ? `, spread over ${d.spread} frames either side` : ""}`);
});
over.addEventListener("pointerup", (e) => {
  const d = S.drag; S.drag = null; S.dirty = true; if (!d) return;
  if (d.kind !== "cam") { if (S.pending) commit(S.pending); return; }
  if (d.moved || e.button !== 0) return;
  const [x, y] = at(e); let best = 11, hit = -1;
  if ($("showBones").checked) S.joints.forEach((p, i) => { if (!p) return; const dd = Math.hypot(p[0] - x, p[1] - y); if (dd < best) { best = dd; hit = i; } });
  if (hit < 0) hit = view.pick(x, y);
  ACT.bone(hit);
});
over.addEventListener("wheel", (e) => { e.preventDefault(); if (view.cam.mode === "orbit") { view.cam.dist = Math.max(2, Math.min(4000, view.cam.dist * Math.exp(e.deltaY * 0.0012))); S.dirty = true; } }, { passive: false });

// ── the timeline ───────────────────────────────────────────────────────────
const TL = { pad: 10, ruler: 18, ev: 44, keys: 74 };
const tlX = (f) => TL.pad + (f + 0.5) * (track.clientWidth - 2 * TL.pad) / S.anim.count, tlF = (x) => Math.max(0, Math.min(S.anim.count - 1, Math.floor((x - TL.pad) / ((track.clientWidth - 2 * TL.pad) / S.anim.count))));
function drawTimeline() {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = track.clientWidth, h = track.clientHeight, c = tctx, N = S.anim.count, cw = (w - 2 * TL.pad) / N;
  if (track.width !== Math.round(w * dpr) || track.height !== Math.round(h * dpr)) { track.width = Math.round(w * dpr); track.height = Math.round(h * dpr); }
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h); c.font = "10px system-ui"; c.textBaseline = "middle";
  c.fillStyle = "#262b33"; c.fillRect(0, TL.ruler, w, TL.ev - TL.ruler); c.fillStyle = "#1d2127"; c.fillRect(0, TL.ev, w, h - TL.ev);
  const every = [1, 2, 5, 10, 20, 50, 100, 200].find((s) => s * cw >= 34) ?? 500;
  for (let f = 0; f < N; f++) { const x = tlX(f); c.fillStyle = f % every ? "#3a414b" : "#6c7684"; if (cw >= 3 || f % every === 0) c.fillRect(Math.round(x), f % every ? 12 : 6, 1, f % every ? 6 : 12); if (f % every === 0) { c.fillStyle = "#9aa4b2"; c.fillText(f, x + 3, 7); } }
  c.fillStyle = "#6c7684"; c.fillText("events", 4, TL.ruler + 6); c.fillText(S.bone >= 0 ? `keys: ${S.ctx.bones[S.bone].name}` : "keys: all bones", 4, TL.ev + 7);
  // the keys of every bone that has its own (a tick, taller with more bones), then the bone in hand's (diamonds)
  const counts = new Array(N).fill(0); let any = false;
  for (const k of Object.values(S.anim.keys)) { const fs = Object.keys(k); if (fs.length) any = true; for (const f of fs) if (f < N) counts[f]++; }
  if (!any) { c.fillStyle = "#8a93a0"; c.fillText("every frame is a key, as the file has it: pose a bone and the change is spread about the frame, or thin the keys (Animation) to shape it from a few", 110, TL.ev + 7); }
  for (let f = 0; f < N; f++) if (counts[f]) { const hh = Math.min(14, 3 + counts[f]); c.fillStyle = "#7d6f45"; c.fillRect(tlX(f) - Math.max(1, Math.min(3, cw / 2 - 1)), h - 4 - hh, Math.max(2, Math.min(6, cw - 2)), hh); }
  if (S.bone >= 0) {
    const k = boneKeys(S.bone), y = TL.ev + 24, r = Math.max(2.5, Math.min(6, cw * 0.45)), moving = S.tdrag?.kind === "key" ? S.tdrag : null;
    for (const f of k.f) { const x = tlX(moving && f === moving.from ? moving.to : f); c.fillStyle = k.touched ? (k.dense ? "#b9963c" : "#ffd766") : "#77808c"; c.beginPath(); c.moveTo(x, y - r - 1); c.lineTo(x + r, y); c.lineTo(x, y + r + 1); c.lineTo(x - r, y); c.fill(); }
  }
  S.anim.events.forEach((e, i) => {
    const f = S.tdrag?.kind === "event" && S.tdrag.i === i ? S.tdrag.to : e.frame, x = tlX(f), text = `${e.event === 5004 ? "" : e.event + " "}${String(e.options).split("/").pop()}`;
    c.fillStyle = i === S.evSel ? "#ffd766" : "#69b7e8"; c.fillRect(x - 1, TL.ruler + 2, 2, TL.ev - TL.ruler - 4); c.beginPath(); c.moveTo(x, TL.ruler + 3); c.lineTo(x + 9, TL.ruler + 8); c.lineTo(x, TL.ruler + 13); c.fill();
    c.fillText(text, Math.min(x + 12, w - c.measureText(text).width - 4), TL.ruler + (i % 2 ? 19 : 8));
  });
  const x = tlX(S.frame); c.fillStyle = "#ff5a4d"; c.fillRect(x - 1, 0, 2, h); c.beginPath(); c.moveTo(x - 6, 0); c.lineTo(x + 6, 0); c.lineTo(x, 9); c.fill();
  $("tlNote").textContent = `${S.anim.name}: ${S.anim.count} frames at ${+S.anim.fps.toFixed(2)}, ${(Math.max(1, S.anim.count - 1) / S.anim.fps).toFixed(2)} s`;
}
const tat = (e) => { const r = track.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
track.addEventListener("pointerdown", (e) => {
  if (!S.ready) return; track.setPointerCapture(e.pointerId); const [x, y] = tat(e), f = tlF(x), near = Math.max(7, (track.clientWidth - 2 * TL.pad) / S.anim.count / 2 + 1);
  const i = y >= TL.ruler && y < TL.ev ? S.anim.events.findIndex((ev) => Math.abs(tlX(ev.frame) - x) < near || (x > tlX(ev.frame) && x < tlX(ev.frame) + 12 && y < TL.ruler + 14)) : -1;
  if (i >= 0) { S.tdrag = { kind: "event", i, to: S.anim.events[i].frame }; S.evSel = i; }
  else if (y >= TL.ev + 12 && y < TL.ev + 38 && S.bone >= 0 && boneKeys(S.bone).f.includes(f)) { S.tdrag = { kind: "key", from: f, to: f }; go(f); }
  else { S.tdrag = { kind: "scrub" }; go(f); }
  S.dirty = true;
});
track.addEventListener("pointermove", (e) => { const d = S.tdrag; if (!d) return; const f = tlF(tat(e)[0]); if (d.kind === "scrub") go(f); else d.to = f; S.dirty = true; });
track.addEventListener("pointerup", () => {
  const d = S.tdrag; S.tdrag = null; S.dirty = true; if (!d) return;
  if (d.kind === "event") { if (d.to !== S.anim.events[d.i].frame) { const list = evList(); list[d.i].frame = d.to; S.evSel = -1; edit(() => core.opEvents(S.project, S.ctx, S.n, list)); } else { S.tab = "events"; go(d.to); renderPane(); } }
  if (d.kind === "key" && d.to !== d.from) edit(() => core.opMoveKey(S.project, S.ctx, S.n, S.bone, d.from, d.to)).then(() => go(d.to));
});
track.addEventListener("dblclick", (e) => { const [x, y] = tat(e); if (y >= TL.ruler && y < TL.ev) ACT.evAdd(null, null, tlF(x)); });

// ── keys of the keyboard ───────────────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  if (!S.ready) return; const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== "checkbox" && e.target.type !== "range", ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl && k === "s") { e.preventDefault(); return void ACT.save(); }
  const sliding = e.target.type === "range" && /^(Arrow|Home$|End$|Page|Escape$)/.test(e.key);       // a slider that has the keyboard is moved by these, as anywhere: they are not the timeline's then
  if (typing || sliding) { if (e.key === "Escape") e.target.blur(); return; }
  const run = (f) => { e.preventDefault(); Promise.resolve(f()).catch(fail); };
  if (ctrl && k === "z") return run(e.shiftKey ? ACT.redo : ACT.undo); if (ctrl && k === "y") return run(ACT.redo);
  if (ctrl && k === "c") return run(ACT.copy); if (ctrl && k === "v") return run(e.shiftKey ? ACT.pasteMirror : ACT.paste);
  if (ctrl || e.altKey) return;
  const keys = { " ": ACT.play, arrowleft: e.shiftKey ? ACT.prevKey : ACT.prev, arrowright: e.shiftKey ? ACT.nextKey : ACT.next, home: ACT.first, end: ACT.last, r: () => ACT.mode("rotate"), g: () => ACT.mode("move"), k: ACT.key, delete: ACT.unkey, escape: () => ACT.bone(-1),
    1: () => ACT.cam("first"), 2: () => ACT.cam("orbit"), b: () => { $("showBones").checked = !$("showBones").checked; S.dirty = true; }, o: () => { $("showOnion").checked = !$("showOnion").checked; S.dirty = true; } };
  if (keys[k]) run(keys[k]);
});

// ── every frame of the screen ──────────────────────────────────────────────
let then = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - then) / 1000); then = now;
  if (S.ready && S.anim) {
    if (S.playing) {
      S.frame += dt * S.anim.fps * Number($("speed").value); const N = S.anim.count;
      if ($("loop").checked) { if (S.frame >= N) S.frame %= N; } else if (S.frame >= N - 1) { S.frame = N - 1; S.playing = false; }
      S.dirty = true;
    }
    if (S.dirty || over.clientWidth !== S.lastW || over.clientHeight !== S.lastH) {
      S.dirty = false; S.lastW = over.clientWidth; S.lastH = over.clientHeight;
      const p = poseAt(S.playing ? S.frame : atFrame()); S.world = p.world; const ghosts = [];
      if ($("showOnion").checked && !S.playing) {
        const f = atFrame(), k = S.bone >= 0 ? boneKeys(S.bone) : null, sparse = k && !k.dense, before = sparse ? [...k.f].reverse().find((x) => x < f) : f - 3, after = sparse ? k.f.find((x) => x > f) : f + 3;
        if (before !== undefined && before >= 0) ghosts.push({ pose: poseAt(before).world, colour: [0.35, 0.6, 1, 0.3] });
        if (after !== undefined && after < S.anim.count) ghosts.push({ pose: poseAt(after).world, colour: [1, 0.62, 0.3, 0.3] });
      }
      view.draw(S.world, ghosts); drawOverlay(); drawTimeline(); renderFrame();
      const k = S.bone >= 0 ? boneKeys(S.bone) : null;
      $("tag").textContent = `${S.id}  /  ${S.anim.n} ${S.anim.name}  /  frame ${S.playing ? S.frame.toFixed(1) : atFrame()} of ${S.anim.count - 1}  /  ${view.cam.mode === "first" ? "first person, as the game shows it" : "orbit"}`;
      $("hint").textContent = S.bone >= 0 && k.dense && S.spread === "0" ? "This bone has a key on every frame and spread is 0: only this frame will change." : "";
    }
  }
  requestAnimationFrame(tick);
}

// ── taking up what somebody else did to the project ────────────────────────
setInterval(async () => {
  if (!S.ready || S.busy || S.drag) return;
  try {
    const r = await api("rev", { model: S.id }); if (S.busy || r.rev === S.project.rev) return;
    S.project = await api("project", { model: S.id }); const l = S.project.log?.[S.project.log.length - 1];
    await afterProject(); status(`changed from outside${l ? ` by ${l.by}: ${l.what}` : ""} (revision ${S.project.rev})`);
  } catch { /* the server is away: the next turn tries again */ }
}, 1000);

const list = await api("models");
$("model").innerHTML = list.models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}${m.project ? " *" : ""}</option>`).join("");
window.ed = { S, view, core, ACT, go, commit, selectAnim, openModel, api };
requestAnimationFrame(tick);
if (list.models.length) openModel(list.models.some((m) => m.id === Q.get("model")) ? Q.get("model") : list.models.some((m) => m.id === list.first) ? list.first : list.models[0].id).catch(fail); else status(`no .mdl files in ${list.folder}`, true);
