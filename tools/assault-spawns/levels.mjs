// The floors of a map as one walkable graph, and what that says about where capture points can go: which floor each base can walk
// to and how far, the map's LEVELS (the heights most of its walkable floor lies at: a city's street, the sewers under it, a pit
// under those), and capture points spread over them. A START for a person or an AI to judge on the overview picture (plan.mjs,
// renderLevels), never an answer: the BSP says where a player can walk, not where a fight is worth having.
//
//   1. The floor is sampled on a grid (default 64 units) at every height a player could rest.
//   2. From each base the walk is followed over neighbouring cells (stairs and ramps taken, a drop taken never): the floor a player of
//      that side can reach, and the length of the walk. A cell neither base reaches is no place for a point.
//   3. The levels are the heights where the reachable floor gathers; the busiest are kept (the three of a three-floor city).
//   4. Points are shared among the levels by how much floor each has (every level at least one), each spread along the walk from one
//      base to the other (a point's TP: its walk from side 1's base over both walks), the roomiest floor of its band, and never
//      near another point of its level.
import { sampleFloors } from './suggest.mjs'

/** Brush entities a walk between two parts of a map goes through: a player opens a door, breaks a pane, presses a button. */
export const OPENABLE = new Set(['func_door', 'func_door_rotating', 'func_breakable', 'func_wall_toggle', 'func_button', 'func_rot_button'])

export const LEVEL_DEFAULTS = {
  grid: 64, // floor sampling step, units
  zStep: 48, // heights probed under each grid cell
  dropMax: 80, // a drop a player walks off without a second thought (no damage under about 130): between two samples 8 units apart
  stepUp: 18, // the step a player climbs or drops while walking (TS's sv_stepsize), between two samples 8 units apart
  stepZ: 90, // the most a neighbouring floor may differ in height and still be walked to: a ramp or flight of stairs climbs up to 1.25 units for each unit along it, and a cell is a grid step (64) from the next
  minGap: 160, // two levels are at least this far apart in height
  minShare: 0.05, // a level holds at least this share of the reachable floor
  band: 48, // a cell belongs to a level when it is within this of the level's height
  levels: 3, // how many levels are kept when they are found by themselves
  count: 7, // points to propose
  reach: 384, // their radius
  apart: 700, // never nearer than this to another point of the same level
  crossApart: 260, // nor than this to a point of another level
  margin: 0.1, // keep this fraction of the walk clear at either end (the bases' own rooms)
  needRoom: 0.5, // a floor's room is at least this fraction of the roomiest floor of its level
}

const heapPush = (h, item) => {
  h.push(item)
  let i = h.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (h[p][0] <= h[i][0]) break
    ;[h[p], h[i]] = [h[i], h[p]]
    i = p
  }
}
const heapPop = (h) => {
  const top = h[0]
  const last = h.pop()
  if (h.length) {
    h[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < h.length && h[l][0] < h[m][0]) m = l
      if (r < h.length && h[r][0] < h[m][0]) m = r
      if (m === i) break
      ;[h[m], h[i]] = [h[i], h[m]]
      i = m
    }
  }
  return top
}

/**
 * The floor cells of the map with each base's walk to them: [{ x, y, z, dA, dB }], dA from side 1's tier 0 spawns and dB from side 2's
 * (Infinity: that side cannot walk there). `spawns` is parseSpawnCfg's list.
 */
export function walkGraph(bsp, spawns, opts = {}) {
  const o = { ...LEVEL_DEFAULTS, ...opts }
  // the walk goes through doors and panes a player can open or break; the map's own collision stays what it was afterwards
  const before = bsp.passable
  bsp.passable = OPENABLE
  try {
    return walkGraphOpen(bsp, spawns, o)
  } finally {
    bsp.passable = before
  }
}

function walkGraphOpen(bsp, spawns, o) {
  const floors = sampleFloors(bsp, { grid: o.grid, zStep: o.zStep })
  const cells = floors.map((f, i) => ({ x: f.x, y: f.y, z: f.z, i, dA: Infinity, dB: Infinity }))
  const col = new Map()
  const key = (ix, iy) => ix + ',' + iy
  for (const c of cells) {
    const k = key(Math.round(c.x / o.grid), Math.round(c.y / o.grid))
    if (!col.has(k)) col.set(k, [])
    col.get(k).push(c)
  }
  const near = (x, y, z) => {
    let best = null
    let bd = Infinity
    const ix = Math.round(x / o.grid)
    const iy = Math.round(y / o.grid)
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const c of col.get(key(ix + i, iy + j)) || []) {
          if (Math.abs(c.z - z) > 24) continue
          const d = Math.hypot(c.x - x, c.y - y)
          if (d < bd) { bd = d; best = c }
        }
      }
    }
    return best
  }

  for (const side of [1, 2]) {
    const field = side === 1 ? 'dA' : 'dB'
    const heap = []
    for (const s of spawns.filter((q) => q.team === side && q.tier === 0)) {
      const c = near(s.x, s.y, s.z)
      if (c && c[field] > 0) {
        c[field] = 0
        heapPush(heap, [0, c])
      }
    }
    while (heap.length) {
      const [d, c] = heapPop(heap)
      if (d > c[field]) continue
      const ix = Math.round(c.x / o.grid)
      const iy = Math.round(c.y / o.grid)
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          if (!i && !j) continue
          const step = Math.hypot(i, j) * o.grid
          for (const n of col.get(key(ix + i, iy + j)) || []) {
            if (Math.abs(n.z - c.z) > o.stepZ || d + step >= n[field]) continue
            const z2 = bsp.walkTo([c.x, c.y, c.z], [n.x, n.y, n.z], o.stepUp, o.dropMax)
            if (z2 === null || Math.abs(z2 - n.z) > 12) continue
            n[field] = d + step
            heapPush(heap, [n[field], n])
          }
        }
      }
    }
  }
  return cells
}

/** The levels of a graph: [{ z, cells }] by height, highest first. `levels` is how many to keep (the busiest). */
export function detectLevels(cells, opts = {}) {
  const o = { ...LEVEL_DEFAULTS, ...opts }
  const ok = cells.filter((c) => Number.isFinite(c.dA) && Number.isFinite(c.dB))
  if (!ok.length) return []
  const bins = new Map()
  for (const c of ok) {
    const b = Math.round(c.z / 16)
    bins.set(b, (bins.get(b) || 0) + 1)
  }
  const smooth = (b) => (bins.get(b - 1) || 0) + (bins.get(b) || 0) + (bins.get(b + 1) || 0)
  const order = [...bins.keys()].sort((a, b) => smooth(b) - smooth(a) || a - b)
  const picked = []
  for (const b of order) {
    if (smooth(b) < o.minShare * ok.length) break
    if (picked.some((p) => Math.abs(p - b) * 16 < o.minGap)) continue
    picked.push(b)
    if (picked.length >= o.levels) break
  }
  return picked
    .map((b) => {
      const inBand = ok.filter((c) => Math.abs(c.z - b * 16) <= o.band)
      const z = inBand.reduce((a, c) => a + c.z, 0) / Math.max(1, inBand.length)
      return { z, cells: ok.filter((c) => Math.abs(c.z - z) <= o.band) }
    })
    .sort((a, b) => b.z - a.z)
}

/** How many of `total` each level gets: by its floor, every level at least one, the largest remainders taking the rest. */
export function shareOut(levels, total) {
  const n = levels.length
  if (!n) return []
  const all = levels.reduce((a, l) => a + l.cells.length, 0)
  const give = levels.map(() => 1)
  let left = total - n
  const want = levels.map((l) => (l.cells.length / all) * (total - n))
  want.forEach((w, i) => { give[i] += Math.floor(w); left -= Math.floor(w) })
  const rem = want.map((w, i) => [w - Math.floor(w), i]).sort((a, b) => b[0] - a[0])
  for (let k = 0; left > 0 && k < rem.length; k++, left--) give[rem[k][1]]++
  return give
}

/**
 * Capture points spread over the levels of a map: [{ n, x, y, z, radius, room, tp, level, levelZ }] numbered from side 1's base to
 * side 2's by the walk (tp, 0 at side 1's base and 1 at side 2's). `levels` is a number (the busiest that many), or [{ z, count }] to
 * choose both (z is a standing height; the nearest found level is taken).
 */
export function suggestLevelPoints(bsp, spawns, opts = {}) {
  const o = { ...LEVEL_DEFAULTS, ...opts }
  const cells = walkGraph(bsp, spawns, o)
  const reachable = cells.filter((c) => Number.isFinite(c.dA) && Number.isFinite(c.dB))
  if (!reachable.length) throw new Error('neither base can walk anywhere: no floor to put points on (are there tier 0 spawns?)')
  const found = detectLevels(cells, { ...o, levels: Array.isArray(o.levelSpec) ? 8 : o.levels })
  let levels = found
  let counts
  if (Array.isArray(o.levelSpec)) {
    levels = []
    counts = []
    for (const s of o.levelSpec) {
      const l = [...found].sort((a, b) => Math.abs(a.z - s.z) - Math.abs(b.z - s.z))[0]
      if (l && !levels.includes(l)) { levels.push(l); counts.push(s.count) }
    }
  } else {
    counts = shareOut(levels, o.count)
  }

  // room: the floor of the same level within the reach, over every reachable cell (a grid of buckets keeps it cheap)
  const bucket = new Map()
  const bk = (x, y) => Math.floor(x / o.reach) + ',' + Math.floor(y / o.reach)
  for (const c of reachable) {
    const k = bk(c.x, c.y)
    if (!bucket.has(k)) bucket.set(k, [])
    bucket.get(k).push(c)
  }
  const room = (f) => {
    let n = 0
    const cx = Math.floor(f.x / o.reach)
    const cy = Math.floor(f.y / o.reach)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const g of bucket.get(cx + i + ',' + (cy + j)) || []) {
        if (Math.abs(g.z - f.z) <= 24 && Math.hypot(g.x - f.x, g.y - f.y) <= o.reach) n++
      }
    }
    return n
  }

  const chosen = []
  levels.forEach((lv, li) => {
    const cand = lv.cells
      .map((c) => ({ ...c, tp: c.dA / (c.dA + c.dB), room: room(c) }))
      .filter((c) => c.tp >= o.margin && c.tp <= 1 - o.margin)
    if (!cand.length) return
    const best = Math.max(...cand.map((c) => c.room))
    const roomy = cand.filter((c) => c.room >= best * o.needRoom)
    const lo = Math.min(...roomy.map((c) => c.tp))
    const hi = Math.max(...roomy.map((c) => c.tp))
    const n = counts[li] || 0
    // a short stretch of a level has room for fewer, closer points, but two points of one level are never nearer than a reach and a
    // quarter (their circles would lie on each other): a level entered at one spot is a short stretch of the walk and a big room
    const apart = Math.max(o.reach * 1.25, Math.min(o.apart, ((hi - lo) * 4000) / (n + 1)))
    for (let b = 0; b < n; b++) {
      const a0 = lo + ((hi - lo) * b) / n
      const a1 = lo + ((hi - lo) * (b + 1)) / n
      const pool = roomy.filter((c) => c.tp >= a0 && (c.tp < a1 || (b === n - 1 && c.tp <= a1)) &&
        chosen.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= (p.level === li ? apart : o.crossApart)))
      // the roomiest, the walk nearest to equal from both bases breaking a tie
      pool.sort((x, y) => y.room - x.room || Math.abs(x.dA - x.dB) - Math.abs(y.dA - y.dB))
      if (pool.length) chosen.push({ ...pool[0], level: li, levelZ: lv.z })
    }
  })
  chosen.sort((a, b) => a.tp - b.tp)
  return {
    points: chosen.map((c, i) => ({ n: i + 1, x: c.x, y: c.y, z: c.z - 21, radius: o.reach, room: c.room, tp: c.tp, level: c.level, levelZ: c.levelZ })),
    levels: levels.map((l, i) => ({ index: i, z: l.z, cells: l.cells.length, points: counts[i] || 0 })),
    cells,
  }
}
