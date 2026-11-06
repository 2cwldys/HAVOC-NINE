// One 512x512 picture for a bought model's many materials, each material's used part of its own picture
// copied into a cell of a size in keeping with the surface it covers. UVs are brought onto the cell.
import { unpng, unjpeg, rgbOf, shrink } from "file:///D:/Downloads/TSM/smak/src/index.mjs";

const FLAT = 8;

/** An image of a material: its picture decoded and made no larger than `most` a side, or its flat colour. */
function materialImage(scene, material, most) {
  if (material?.image !== undefined) {
    const entry = scene.images?.[material.image];
    const bytes = entry?.bytes;
    if (bytes) {
      const file = Buffer.from(bytes);
      let image;
      if (file.toString("latin1", 0, 2) === "BM") {
        throw new Error("atlas: a BMP inside an FBX is not expected here");
      } else if (file[0] === 0xff && file[1] === 0xd8) {
        image = rgbOf(unjpeg(file));
      } else {
        image = rgbOf(unpng(file));
      }
      const factor = Math.max(1, Math.ceil(Math.max(image.width, image.height) / most));
      return factor > 1 ? shrink(image, factor) : image;
    }
  }
  const colour = material?.colour ?? [0.8, 0.8, 0.8];
  const rgb = new Uint8Array(FLAT * FLAT * 3);
  for (let i = 0; i < FLAT * FLAT; i++)
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(colour[c] * 255)));
  return { width: FLAT, height: FLAT, rgb };
}

/** The box of a run's picture coordinates, and the surface it covers. */
function usedOf(tris) {
  const mn = [Infinity, Infinity];
  const mx = [-Infinity, -Infinity];
  let area = 0;
  for (const tri of tris) {
    const [a, b, c] = tri.map((corner) => corner.p);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    for (const corner of tri) {
      mn[0] = Math.min(mn[0], corner.uv[0]);
      mn[1] = Math.min(mn[1], corner.uv[1]);
      mx[0] = Math.max(mx[0], corner.uv[0]);
      mx[1] = Math.max(mx[1], corner.uv[1]);
    }
  }
  const width = Math.max(1e-6, mx[0] - mn[0]);
  const height = Math.max(1e-6, mx[1] - mn[1]);
  return { mn, mx, width, height, area };
}

function sample(image, x, y, out, at) {
  const { width, height, rgb } = image;
  x = Math.max(0, Math.min(width - 1.001, x));
  y = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const a = rgb[(y0 * width + x0) * 3 + c] * (1 - fx) + rgb[(y0 * width + x1) * 3 + c] * fx;
    const b = rgb[(y1 * width + x0) * 3 + c] * (1 - fx) + rgb[(y1 * width + x1) * 3 + c] * fx;
    out[at + c] = Math.round(a * (1 - fy) + b * fy);
  }
}

/**
 * Cells packed into a square of `usable` a side, largest first, each in the free rectangle whose shorter
 * leftover side is least (maxrects). Returns a Map(name -> { x, y, w, h }) or null when one does not fit.
 */
function pack(wanted, usable, margin) {
  const free = [{ x: 0, y: 0, w: usable, h: usable }];
  const placed = new Map();
  const order = [...wanted].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
  for (const m of order) {
    const fw = m.w + margin;
    const fh = m.h + margin;
    let best = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    for (const r of free) {
      if (fw > r.w || fh > r.h) continue;
      const short = Math.min(r.w - fw, r.h - fh);
      const long = Math.max(r.w - fw, r.h - fh);
      if (short < bestShort || (short === bestShort && long < bestLong)) {
        best = r;
        bestShort = short;
        bestLong = long;
      }
    }
    if (!best) return null;
    placed.set(m.name, { x: best.x + margin / 2, y: best.y + margin / 2, w: m.w, h: m.h });
    const at = { x: best.x, y: best.y, w: fw, h: fh };
    const left = [];
    for (const r of free) {
      if (at.x >= r.x + r.w || at.x + at.w <= r.x || at.y >= r.y + r.h || at.y + at.h <= r.y) {
        left.push(r);
        continue;
      }
      if (at.x > r.x) left.push({ x: r.x, y: r.y, w: at.x - r.x, h: r.h });
      if (at.x + at.w < r.x + r.w) left.push({ x: at.x + at.w, y: r.y, w: r.x + r.w - (at.x + at.w), h: r.h });
      if (at.y > r.y) left.push({ x: r.x, y: r.y, w: r.w, h: at.y - r.y });
      if (at.y + at.h < r.y + r.h) left.push({ x: r.x, y: at.y + at.h, w: r.w, h: r.y + r.h - (at.y + at.h) });
    }
    // a free rectangle wholly inside another is no use
    const kept = left.filter(
      (r, i) =>
        !left.some(
          (o, j) => i !== j && o.x <= r.x && o.y <= r.y && o.x + o.w >= r.x + r.w && o.y + o.h >= r.y + r.h,
        ),
    );
    free.length = 0;
    free.push(...kept);
  }
  return placed;
}

/**
 * A picture of `size` a side holding every material's used part, and the cells it was laid in.
 * Returns { image, cells: Map(material -> { x, y, w, h, mn, width, height }), said }.
 */
export function buildAtlas(scene, { size = 512, margin = 4, border = 2, most = 512, fill = 0.8, weightPower = 0.85, boost = {} } = {}) {
  const byMaterial = new Map();
  for (const group of scene.groups) {
    const name = group.material || "";
    if (!byMaterial.has(name)) byMaterial.set(name, []);
    byMaterial.get(name).push(...group.tris);
  }
  const materials = [...byMaterial.keys()].map((name) => {
    const tris = byMaterial.get(name);
    const material = scene.materials.find((entry) => entry.name === name);
    const image = materialImage(scene, material, most);
    const used = usedOf(tris);
    const aspect = (used.width * image.width) / (used.height * image.height);
    return { name, tris, image, used, aspect: Math.max(0.2, Math.min(5, aspect)), weight: Math.max(0.5, used.area) ** weightPower * (boost[name] ?? 1) };
  });
  const totalWeight = materials.reduce((sum, m) => sum + m.weight, 0);
  const usable = size - margin * 2;

  let cells = null;
  let scale = 1;
  for (let attempt = 0; attempt < 80 && !cells; attempt++) {
    const wanted = materials.map((m) => {
      const area = (usable * usable * fill * m.weight * scale) / totalWeight;
      const h = Math.max(8, Math.sqrt(area / m.aspect));
      const w = Math.max(8, h * m.aspect);
      return { ...m, w: Math.min(usable, Math.round(w)), h: Math.min(usable, Math.round(h)) };
    });
    cells = pack(wanted, usable, margin);
    if (!cells) scale *= 0.94;
  }
  if (!cells) throw new Error("atlas: no packing found");

  // the picture: black where nothing is laid; each cell and a border about it
  const rgb = new Uint8Array(size * size * 3);
  for (const m of materials) {
    const cell = cells.get(m.name);
    const image = m.image;
    const { mn, width, height } = m.used;
    for (let dy = -border; dy < cell.h + border; dy++)
      for (let dx = -border; dx < cell.w + border; dx++) {
        const u = Math.max(0, Math.min(1, (dx + 0.5) / cell.w));
        const v = Math.max(0, Math.min(1, (dy + 0.5) / cell.h));
        const sx = (mn[0] + u * width) * image.width;
        const sy = (mn[1] + v * height) * image.height;
        const at = ((cell.y + dy) * size + (cell.x + dx)) * 3;
        sample(image, sx, sy, rgb, at);
      }
    cell.mn = mn;
    cell.width = width;
    cell.height = height;
  }
  const cellsOut = new Map(materials.map((m) => [m.name, cells.get(m.name)]));
  return {
    image: { width: size, height: size, rgb },
    cells: cellsOut,
    said: materials
      .map((m) => `${m.name || "none"} ${cells.get(m.name).w}x${cells.get(m.name).h}`)
      .join(", "),
  };
}

/** A corner's picture coordinates brought onto its material's cell. */
export function remapUV(corner, cell, size) {
  const u = Math.max(0, Math.min(1, (corner.uv[0] - cell.mn[0]) / cell.width));
  const v = Math.max(0, Math.min(1, (corner.uv[1] - cell.mn[1]) / cell.height));
  const pad = 0.5;
  const x = Math.max(cell.x + pad, Math.min(cell.x + cell.w - pad, cell.x + u * cell.w));
  const y = Math.max(cell.y + pad, Math.min(cell.y + cell.h - pad, cell.y + v * cell.h));
  return [x / size, y / size];
}
