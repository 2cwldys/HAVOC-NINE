import { readFileSync } from "node:fs";
import { readFbx } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const scene = readFbx(readFileSync("D:/Downloads/TSM/laserrifle/source/RifleNewTextures.fbx"));
const g = scene.groups.find((x) => x.object === "Optic.001" && x.material === "OpticLens");
const pts = new Map();
for (const t of g.tris) for (const c of t) pts.set(c.p.map((v) => v.toFixed(1)).join(","), c.p);
const byX = {};
for (const p of pts.values()) (byX[Math.round(p[0])] ??= []).push(p);
for (const [x, list] of Object.entries(byX)) console.log("x", x, "points", list.length, list.slice(0, 14).map((p) => `(${p[1].toFixed(1)},${p[2].toFixed(1)})`).join(" "));
// the optic body's rear rim: points with x > 52
const o = scene.groups.find((x) => x.object === "Optic" && x.material === "Optic");
const rim = new Map();
for (const t of o.tris) for (const c of t) if (c.p[0] > 52.5) rim.set(c.p.map((v) => v.toFixed(1)).join(","), c.p);
console.log("optic rear rim points", rim.size, [...rim.values()].slice(0, 40).map((p) => `(${p[1].toFixed(1)},${p[2].toFixed(1)})`).join(" "));
const small = scene.groups.find((x) => x.object === "Optic" && x.material === "OpticLens");
const sp = new Map(); for (const t of small.tris) for (const c of t) sp.set(c.p.map((v) => v.toFixed(1)).join(","), c.p);
console.log("small lens points", [...sp.values()].map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)},${p[2].toFixed(1)})`).join(" "));
