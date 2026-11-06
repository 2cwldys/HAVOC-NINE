import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync("D:/Downloads/TSM/laserrifle/out2/gun.json", "utf8"));
const lod = process.argv[2] ?? "p";
const tris = data.lods[lod].tris;
const rows = [];
for (const t of tris) {
  const [a, b, c] = t.map((q) => q.p);
  const e = [Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]), Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2])];
  const L = Math.max(...e);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  const h = (2 * area) / Math.max(L, 1e-9);
  rows.push({ part: t[0].part, mat: t[0].mat, L, h, aspect: L / Math.max(h, 1e-9), area, c: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
}
const bad = rows.filter((r) => r.L > 1.0 && r.aspect > 14).sort((x, y) => y.L - x.L);
console.log(lod, "triangles", rows.length, "slivers (L>1, aspect>14):", bad.length);
const by = new Map();
for (const r of bad) { const k = `${r.part}|${r.mat}`; by.set(k, (by.get(k) ?? 0) + 1); }
console.log([...by].map(([k, n]) => `${k}:${n}`).join("  "));
for (const r of bad.slice(0, 25)) console.log(`${r.part}|${r.mat}`.padEnd(22), "L", r.L.toFixed(2), "h", r.h.toFixed(3), "at", r.c.map((x) => x.toFixed(1)).join(","));
