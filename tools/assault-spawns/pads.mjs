// Where each side's flag pad goes on a Capture the Flag map: a flat, open patch of floor in its own base, a little to the rear of the
// middle of the base's spawns (away from the other base), clear of every spawn, with room all round for the pad's reach. A START for a
// person or an AI to judge on the overview picture (plan.mjs, renderLevels), never an answer: the BSP says where a flag could stand,
// not where a fight over it is worth having.
//
//   1. Candidates: every 24 units over the ground within `search` of the middle of the base's spawns, at the base's own height.
//   2. A candidate must stand on floor (the map's own hull), have flat walkable floor all round it out to the pad's reach, and be
//      further than `clear` from every spawn of its side.
//   3. The best is the one with the most open floor round it (rings out to `room` times the reach), then the furthest to the rear.
import { dirTo } from './place.mjs'

export const PAD_DEFAULTS = {
  reach: 72, // the radius a carrier must be within to turn a flag in (tsm_cf_pad_radius)
  room: 2.2, // open floor is looked for out to this many times the reach
  flat: 10, // the floor round the pad may differ from the pad's by this much (a step, a ramp's foot)
  clear: 56, // never nearer than this to a spawn of its side
  search: 520, // candidates within this of the middle of the base's spawns
  step: 24,
  rear: 0.5, // how much being to the rear counts against being open (0 to 1)
}

/** Each side's pad: { 1: { x, y, z, open }, 2: ... } with z the floor under the flag (a standing player's origin 34 above it), or null for a side without a base. */
export function suggestPads(bsp, bases, spawns, opts = {}) {
  const o = { ...PAD_DEFAULTS, ...opts }
  const out = { 1: null, 2: null }
  for (const side of [1, 2]) {
    const b = bases[side]
    if (!b) continue
    const mine = spawns.filter((s) => s.team === side && s.tier === 0)
    const foe = dirTo(b, bases[3 - side])
    let best = null
    for (let dx = -o.search; dx <= o.search; dx += o.step) {
      for (let dy = -o.search; dy <= o.search; dy += o.step) {
        const x = b.x + dx
        const y = b.y + dy
        const z = bsp.floorAt(x, y, b.z, 140)
        if (z === null) continue
        if (mine.some((s) => Math.hypot(s.x - x, s.y - y) < o.clear && Math.abs(s.z - z) < 80)) continue
        // flat floor all round, out to the reach, and how much open floor there is out to `room` times it
        let flatOk = true
        let open = 0
        let total = 0
        for (let r = o.reach * 0.5; r <= o.reach * o.room + 1e-9; r += o.reach * 0.35) {
          for (let a = 0; a < 360; a += 30) {
            const px = x + r * Math.cos((a * Math.PI) / 180)
            const py = y + r * Math.sin((a * Math.PI) / 180)
            const fz = bsp.floorAt(px, py, z, 24)
            total++
            if (fz !== null && Math.abs(fz - z) <= o.flat && bsp.walkOpen([x, y, z], [px, py, fz])) open++
            else if (r <= o.reach) flatOk = false
          }
        }
        if (!flatOk) continue
        const openness = open / total
        const away = foe ? -((x - b.x) * foe.x + (y - b.y) * foe.y) / o.search : 0 // 1 at the rear edge, -1 toward the other base
        const score = openness + o.rear * away
        if (!best || score > best.score) best = { x, y, z: z - 34, open: openness, score }
      }
    }
    out[side] = best && { x: best.x, y: best.y, z: best.z, open: best.open }
  }
  return out
}
