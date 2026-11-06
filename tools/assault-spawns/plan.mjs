// A picture of where the sets went, one panel for each capture point: the floor a player can stand on round it (light), the point's
// reach (yellow circle), which way each side's base lies (a line in its colour from the middle), and every place of each side's set
// (a square in its colour with a line for the way it faces). Side 1 is blue, side 2 red, as in the game.
import fs from 'node:fs'
import { Canvas } from './png.mjs'

const BLUE = [0, 170, 255]
const RED = [255, 70, 60]
const YELLOW = [255, 220, 0]
const FLOOR = [205, 205, 205]
const VOID = [34, 34, 44]
const WHITE = [255, 255, 255]

/**
 * The map's levels in one picture, one band for each: the floor a player can stand on at that height (light), the capture points of that
 * level (yellow circle, number), each side's base where it is on the level (a cross in its colour) and, given opts.sets (placeAll's), the
 * places of the sets of that level's points (squares). `levels` is [{ z }], standing heights; `points` [{ n, x, y, z, radius }].
 */
export function renderLevels(bsp, levels, points, bases, file, opts = {}) {
  const { mins, maxs } = bsp.bounds()
  const U = opts.unitsPerPixel || 12
  const W = Math.ceil((maxs[0] - mins[0]) / U)
  const H = Math.ceil((maxs[1] - mins[1]) / U)
  const gap = 6
  const cv = new Canvas(W + 2 * gap, levels.length * (H + gap) + gap, [10, 10, 14])
  levels.forEach((lv, k) => {
    const oy = gap + k * (H + gap)
    const X = (x) => gap + (x - mins[0]) / U
    const Y = (y) => oy + (maxs[1] - y) / U
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const x = mins[0] + (px + 0.5) * U
        const y = maxs[1] - (py + 0.5) * U
        cv.rect(gap + px, oy + py, 1, 1, bsp.floorAt(x, y, lv.z, 24) !== null ? FLOOR : VOID)
      }
    }
    const here = points.filter((p) => Math.abs(p.z + 21 - lv.z) <= 60)
    for (const p of here) {
      for (const s of (opts.sets || []).filter((q) => q.n === p.n)) {
        const col = s.team === 1 ? BLUE : RED
        for (const pl of s.places) cv.rect(Math.round(X(pl.x)) - 2, Math.round(Y(pl.y)) - 2, 5, 5, col)
      }
      cv.circle(X(p.x), Y(p.y), p.radius / U, YELLOW)
      cv.rect(Math.round(X(p.x)) - 2, Math.round(Y(p.y)) - 2, 5, 5, YELLOW)
      cv.number(Math.round(X(p.x)) + 5, Math.round(Y(p.y)) - 14, p.n, WHITE, 2)
    }
    for (const team of [1, 2]) {
      const b = bases[team]
      if (!b || Math.abs(b.z - lv.z) > 140) continue
      const col = team === 1 ? BLUE : RED
      cv.line(X(b.x) - 7, Y(b.y), X(b.x) + 7, Y(b.y), col)
      cv.line(X(b.x), Y(b.y) - 7, X(b.x), Y(b.y) + 7, col)
    }
    cv.number(gap + 6, oy + 6, k + 1, WHITE, 3)
  })
  fs.writeFileSync(file, cv.png())
  return file
}

/** Draws result (placeAll's) over the map and writes a PNG to `file`. Returns the file. */
export function renderPlan(bsp, result, file, opts = {}) {
  const P = opts.panel || 380
  const pts = result.points.filter((p) => p.hub)
  if (pts.length === 0) throw new Error('no capture point has any floor to draw')
  const cols = Math.min(3, pts.length)
  const rows = Math.ceil(pts.length / cols)
  const cv = new Canvas(cols * P + (cols + 1) * 4, rows * P + (rows + 1) * 4, [10, 10, 14])

  pts.forEach((p, k) => {
    const ox = 4 + (k % cols) * (P + 4)
    const oy = 4 + Math.floor(k / cols) * (P + 4)
    const half = Math.min(420, Math.max(300, p.zone.radius * 1.15)) // units from the middle to the panel's edge
    const s = P / (2 * half)
    const X = (x) => ox + P / 2 + (x - p.zone.x) * s
    const Y = (y) => oy + P / 2 - (y - p.zone.y) * s

    // the floor at the point's own height, at half the panel's resolution
    for (let py = 0; py < P; py += 2) {
      for (let px = 0; px < P; px += 2) {
        const x = p.zone.x + (px + 1 - P / 2) / s
        const y = p.zone.y - (py + 1 - P / 2) / s
        cv.rect(ox + px, oy + py, 2, 2, bsp.floorAt(x, y, p.hub[2], 24) !== null ? FLOOR : VOID)
      }
    }
    if (p.zone.radius * s < P / 2 - 2) cv.circle(X(p.zone.x), Y(p.zone.y), p.zone.radius * s, YELLOW)
    cv.rect(Math.round(X(p.zone.x)) - 2, Math.round(Y(p.zone.y)) - 2, 5, 5, YELLOW)

    for (const team of [1, 2]) {
      const col = team === 1 ? BLUE : RED
      const own = p.sides[team] && p.sides[team].own
      if (own) cv.line(X(p.zone.x), Y(p.zone.y), X(p.zone.x) + own.x * 46, Y(p.zone.y) - own.y * 46, col)
      const set = result.sets.find((q) => q.n === p.zone.n && q.team === team)
      if (!set) continue
      for (const pl of set.places) {
        const x = X(pl.x)
        const y = Y(pl.y)
        cv.rect(Math.round(x) - 3, Math.round(y) - 3, 7, 7, col)
        const a = (pl.yaw * Math.PI) / 180
        cv.line(x, y, x + Math.cos(a) * 16, y - Math.sin(a) * 16, WHITE)
      }
    }
    cv.number(ox + 6, oy + 6, p.zone.n, WHITE, 3)
  })
  fs.writeFileSync(file, cv.png())
  return file
}
