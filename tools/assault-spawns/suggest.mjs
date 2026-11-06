// Where capture points could go on a map that has none yet: open floor with room for a point's whole reach, spread between the
// two sides' bases. A START for a person or an AI to judge on the plan picture, never an answer: the BSP says where a player
// can stand, not where a fight is worth having.
//
//   1. The map's floor is sampled on a grid (every 128 units over the world's bounds, at every height a player could rest).
//   2. A floor's ROOM is how much open floor (same height, 24 units either way) lies within the point's reach round it.
//   3. Points are taken in bands along the way from one base to the other, the roomiest of each band, never nearer than
//      `apart` units to one another, never in a base's own room.
import { dirTo } from './place.mjs'

export const SUGGEST_DEFAULTS = {
  count: 5, // points wanted
  reach: 384, // the radius they will have
  grid: 128, // sampling step over the world, units
  zStep: 48, // heights probed under each grid cell
  apart: 700, // never nearer than this to another point
  lateral: 0.7, // how far off the line between the bases a point may be, in halves of that line's length
  margin: 0.12, // keep this fraction of the line at either end clear (the bases' own rooms)
  needRoom: 0.55, // a floor's room must be this fraction of the roomiest floor seen
  zBand: 250, // a point's floor is within this many units above the higher base or below the lower one (no roofs, no sub-floors)
}

/** The floor cells of the whole map: [{ x, y, z }]. */
export function sampleFloors(bsp, o = {}) {
  const { grid, zStep } = { ...SUGGEST_DEFAULTS, ...o }
  const { mins, maxs } = bsp.bounds()
  const out = []
  for (let x = Math.ceil(mins[0] / grid) * grid; x < maxs[0]; x += grid) {
    for (let y = Math.ceil(mins[1] / grid) * grid; y < maxs[1]; y += grid) {
      let last = null
      for (let z = maxs[2]; z > mins[2]; z -= zStep) {
        const f = bsp.floorAt(x, y, z, zStep / 2)
        if (f === null) continue
        if (last !== null && Math.abs(f - last) < 8) continue // the same floor found again from the next probe
        out.push({ x, y, z: f })
        last = f
      }
    }
  }
  return out
}

/** Capture points between the bases: [{ n, x, y, z, radius, room, t }] numbered from side 1's base to side 2's. */
export function suggestPoints(bsp, bases, opts = {}) {
  const o = { ...SUGGEST_DEFAULTS, ...opts }
  if (!bases[1] || !bases[2]) throw new Error('suggestPoints needs both sides\' bases')
  const floors = sampleFloors(bsp, o)

  // room: the floors at the same height within the reach (a grid of buckets keeps it cheap)
  const key = (x, y) => Math.floor(x / o.reach) + ',' + Math.floor(y / o.reach)
  const buckets = new Map()
  for (const f of floors) {
    const k = key(f.x, f.y)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(f)
  }
  const room = (f) => {
    let n = 0
    const cx = Math.floor(f.x / o.reach)
    const cy = Math.floor(f.y / o.reach)
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const g of buckets.get(cx + i + ',' + (cy + j)) || []) {
          if (Math.abs(g.z - f.z) <= 24 && Math.hypot(g.x - f.x, g.y - f.y) <= o.reach) n++
        }
      }
    }
    return n
  }

  const A = { x: bases[2].x - bases[1].x, y: bases[2].y - bases[1].y }
  const len = Math.hypot(A.x, A.y)
  if (len < 200) throw new Error('the two bases are less than 200 units apart: no line to put points on')
  const ux = A.x / len
  const uy = A.y / len
  const zLo = Math.min(bases[1].z, bases[2].z) - o.zBand
  const zHi = Math.max(bases[1].z, bases[2].z) + o.zBand
  const cells = []
  for (const f of floors) {
    if (f.z < zLo || f.z > zHi) continue
    const dx = f.x - bases[1].x
    const dy = f.y - bases[1].y
    const t = (dx * ux + dy * uy) / len // 0 at side 1's base, 1 at side 2's
    const lat = Math.abs(-dx * uy + dy * ux) / (len / 2)
    if (t < o.margin || t > 1 - o.margin || lat > o.lateral) continue
    cells.push({ ...f, t, lat, room: room(f) })
  }
  if (cells.length === 0) return []
  const best = Math.max(...cells.map((c) => c.room))
  const roomy = cells.filter((c) => c.room >= best * o.needRoom)

  // one point to a band along the way, the roomiest (nearest the line breaks a tie), then the spacing rule across bands
  const apart = Math.min(o.apart, len / (o.count + 1)) // a short line between the bases has room for fewer, closer points
  const chosen = []
  for (let b = 0; b < o.count; b++) {
    const lo = o.margin + ((1 - 2 * o.margin) * b) / o.count
    const hi = o.margin + ((1 - 2 * o.margin) * (b + 1)) / o.count
    const inBand = roomy.filter((c) => c.t >= lo && c.t < hi && chosen.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= apart))
    inBand.sort((a, c) => c.room - a.room || a.lat - c.lat)
    if (inBand.length) chosen.push(inBand[0])
  }
  return chosen.map((c, i) => ({ n: i + 1, x: c.x, y: c.y, z: c.z - 21, radius: o.reach, room: c.room, t: c.t }))
}

export { dirTo }
