// Where an Assault capture point's respawn places go.
//
// WHAT A GOOD SET IS (the rules, in the order they matter; docs/ai_context/ASSAULT_SPAWNS.txt has the reasons):
//   1. ON THE HOLDER'S OWN SIDE. A set belongs to the side that holds the point, so its places are on the side of the point toward
//      that side's base (the "rear"), never on the side the enemy comes from: a wave must not land in the enemy's face.
//   2. HIDDEN FROM THE ENEMY'S WAY IN. Places the enemy side of the point can see are worse than ones it cannot (line of sight is
//      tested on the map's exact surfaces from a handful of vantage points on the enemy side).
//   3. CLOSE TO THE POINT. Near it, between the rear and the middle, so the wave reinforces the point it respawns at.
//   4. SPREAD, AND ALL FACING THE SAME WAY. Never nearer than 72 units to another place of the set (52, then 40, only where the room
//      is too small), and every place faces the front, so a wave does not stand in a ring staring at itself.
//   5. NOT IN THE ENEMY'S SET'S FACE. A place within 180 units of, and in sight of, a place of an enemy set of ANOTHER point is
//      dropped while the set keeps six.
//   6. NOT INSIDE ANOTHER POINT. A place within the reach of a different capture point (across the floor and near its height) puts a
//      wave in a point the side may not hold: such a place is taken only when the set cannot be filled without it.
//   Every place is a position where a standing player's whole box fits (the map's own hull) with floor under it, reached by a clear
//   straight walk from the point.
import { Bsp } from './bsp.mjs'

export const DEFAULTS = {
  per: 8, // places in a set (the plugin hands a wave out one to a player: more places, fewer stacked players)
  rings: [60, 100, 140, 180, 220, 260, 300], // distances from the point's middle that are tried, units (never past its radius)
  stepDeg: 10, // angle between tries on a ring
  // [widest angle from the way to the own base, nearest two places may be]: tried in this order until the set is full
  passes: [[90, 72], [120, 72], [120, 52], [180, 52], [180, 40]],
  weights: { ring: 0.8, angle: 1.4, exposure: 1.0 }, // lower score wins
  eye: 17, // a standing player's eye above the origin
  enemyClear: 180, // rule 5's distance
  keepAtLeast: 6, // a set pruned by rule 5, or short of places outside every other point, keeps at least this many places
  otherDz: 168, // rule 6: how far above or below another point's floor still counts as inside it (the plugin's 128 and a standing player's 40)
  vantageRing: 0.9, // enemy-side vantage points are on this fraction of the radius (150 to 320 units), on the arc facing the enemy
  vantageSpanDeg: 80,
  vantageStepDeg: 20,
}

const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Unit xy vector from a point toward a base, or null when there is no base or it is straight above or below. */
export function dirTo(zone, base) {
  if (!base) return null
  const dx = base.x - zone.x
  const dy = base.y - zone.y
  const len = Math.hypot(dx, dy)
  return len < 48 ? null : { x: dx / len, y: dy / len }
}

/** Where a walk from the point starts: its own floor, or where its middle is inside something (a machine), the open floor nearest it. */
export function hubFor(bsp, zone) {
  const z0 = zone.z + 21 // a point's marker stands 16 above the floor; a player rests 36 above it
  const base = bsp.floorAt(zone.x, zone.y, z0, 40)
  if (base !== null) return [zone.x, zone.y, base]
  for (let r = 20; r < 320; r += 20) {
    for (let d = 0; d < 360; d += 15) {
      const x = zone.x + r * Math.cos(rad(d))
      const y = zone.y + r * Math.sin(rad(d))
      const z = bsp.floorAt(x, y, z0, 40)
      if (z !== null) return [x, y, z]
    }
  }
  return null
}

function vantagePoints(bsp, zone, hub, foe, o) {
  const r = clamp(zone.radius * o.vantageRing, 150, 320)
  const out = []
  const centre = foe ? deg(Math.atan2(foe.y, foe.x)) : 0
  const span = foe ? o.vantageSpanDeg : 180
  const step = foe ? o.vantageStepDeg : 40
  for (let d = -span; d <= span + 1e-9; d += step) {
    const a = rad(centre + d)
    const x = zone.x + r * Math.cos(a)
    const y = zone.y + r * Math.sin(a)
    const z = bsp.floorAt(x, y, hub[2], 40)
    if (z !== null) out.push([x, y, z])
  }
  return out
}

/** Every place a standing player fits near a point and can walk to it from the point, scored for each side. */
export function analysePoint(bsp, zone, bases, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const hub = hubFor(bsp, zone)
  if (!hub) return { zone, hub: null, cands: [], sides: {} }

  const cands = []
  for (const r of o.rings) {
    if (r > zone.radius) continue
    for (let d = 0; d < 360; d += o.stepDeg) {
      const x = zone.x + r * Math.cos(rad(d))
      const y = zone.y + r * Math.sin(rad(d))
      const z = bsp.floorAt(x, y, hub[2], 24)
      if (z === null || !bsp.walkOpen(hub, [x, y, z])) continue
      // rule 6: inside the reach of a different capture point
      const inOther = (o.others || []).some((q) => q.n !== zone.n && Math.hypot(x - q.x, y - q.y) <= q.radius && Math.abs(z - (q.z + 21)) <= o.otherDz)
      cands.push({ x, y, z, r, a: d, inOther })
    }
  }

  const dir = { 1: dirTo(zone, bases[1]), 2: dirTo(zone, bases[2]) }
  // both bases the same way from the point (decks one above the other): there is no rear to prefer, only a way to face
  const flat = !!(dir[1] && dir[2] && dir[1].x * dir[2].x + dir[1].y * dir[2].y > Math.cos(rad(30)))
  const targetRing = clamp(zone.radius * 0.5, 110, 190)

  const sides = {}
  for (const team of [1, 2]) {
    const own = flat ? null : dir[team]
    const foe = flat ? null : dir[3 - team]
    const face = dir[3 - team] // the way the side looks, whatever the layout: toward the enemy's base
    const vantage = vantagePoints(bsp, zone, hub, foe, o)
    sides[team] = {
      own, foe, vantage: vantage.length,
      scored: cands.map((c, idx) => {
        const phi = own ? deg(Math.acos(clamp(((c.x - zone.x) * own.x + (c.y - zone.y) * own.y) / Math.max(1e-9, Math.hypot(c.x - zone.x, c.y - zone.y)), -1, 1))) : 0
        let seen = 0
        for (const v of vantage) if (bsp.sightClear([c.x, c.y, c.z + o.eye], [v[0], v[1], v[2] + o.eye])) seen++
        const exposure = vantage.length ? seen / vantage.length : 0.5
        const score = o.weights.ring * (Math.abs(c.r - targetRing) / zone.radius) + o.weights.angle * (phi / 90) + o.weights.exposure * exposure
        // one way for the whole set: toward the enemy's base, so a wave looks the same way and not at itself (no base: at the point)
        const yaw = face ? deg(Math.atan2(face.y, face.x)) : deg(Math.atan2(zone.y - c.y, zone.x - c.x))
        return { idx, c, phi, exposure, score, yaw }
      }),
    }
  }
  return { zone, hub, cands, sides, flat }
}

/** The indices of a set: best scores first, each pass relaxing how far from the rear and how close to its neighbours a place may be. */
export function selectSet(side, exclude, o) {
  const order = side.scored.filter((s) => !exclude.has(s.idx)).sort((a, b) => a.score - b.score || a.idx - b.idx)
  const fill = (pool) => {
    const chosen = []
    for (const [hemi, apart] of o.passes) {
      for (const s of pool) {
        if (chosen.length >= o.per) break
        if (chosen.includes(s) || s.phi > hemi) continue
        if (chosen.every((t) => Math.hypot(s.c.x - t.c.x, s.c.y - t.c.y) >= apart)) chosen.push(s)
      }
    }
    return chosen
  }
  // rule 6: outside every other point first; the places inside one only when that leaves the set short
  const outside = fill(order.filter((s) => !s.c.inOther))
  return outside.length >= Math.min(o.per, o.keepAtLeast) ? outside : fill(order)
}

const place = (s) => ({
  x: s.c.x, y: s.c.y, z: s.c.z, yaw: s.yaw, r: s.c.r, phi: s.phi, exposure: s.exposure, score: s.score, idx: s.idx,
})

/**
 * The sets of every point of a map: [{ n, team, places: [{ x, y, z, yaw, r, phi, exposure }] }], and a report: one line a point and side
 * and one for each thing worth reading (a point with no floor, a small set, a rule-5 prune). `bases` is { 1: {x,y,z}|null, 2: ... }.
 */
export function placeAll(bsp, zones, bases, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const report = []
  const pts = zones.map((z) => analysePoint(bsp, z, bases, { ...o, others: zones }))
  const pick = new Map() // `${n}/${team}` -> chosen scored entries
  for (const p of pts) {
    if (!p.hub) {
      report.push(`point ${p.zone.n}: no open floor near (${p.zone.x} ${p.zone.y} ${p.zone.z}), no set`)
      continue
    }
    for (const team of [1, 2]) pick.set(`${p.zone.n}/${team}`, selectSet(p.sides[team], new Set(), o))
  }

  // rule 5: a place near, and in sight of, an enemy set's place of another point
  const eye = o.eye
  const near = (a, b) => Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y, a.c.z - b.c.z) < o.enemyClear
  const bad = new Map()
  for (const p of pts) for (const q of pts) {
    if (!p.hub || !q.hub || p.zone.n === q.zone.n) continue
    const A = pick.get(`${p.zone.n}/1`) || []
    const B = pick.get(`${q.zone.n}/2`) || []
    for (const a of A) for (const b of B) {
      if (!near(a, b) || !(p.hub && q.hub)) continue
      if (!bsp.sightClear([a.c.x, a.c.y, a.c.z + eye], [b.c.x, b.c.y, b.c.z + eye])) continue
      for (const [key, s] of [[`${p.zone.n}/1`, a], [`${q.zone.n}/2`, b]]) {
        if (!bad.has(key)) bad.set(key, new Set())
        bad.get(key).add(s.idx)
      }
    }
  }
  for (const [key, ex] of bad) {
    const [n, team] = key.split('/').map(Number)
    const p = pts.find((x) => x.zone.n === n)
    const again = selectSet(p.sides[team], ex, o)
    if (again.length >= o.keepAtLeast) {
      report.push(`point ${n} side ${team}: ${ex.size} place(s) were within ${o.enemyClear} units of, and in sight of, an enemy set of another point; set again (${again.length} places)`)
      pick.set(key, again)
    } else {
      report.push(`point ${n} side ${team}: ${ex.size} place(s) are within ${o.enemyClear} units of an enemy set of another point and no clear set is left (${again.length}): kept as they were, check this by eye`)
    }
  }

  const sets = []
  for (const p of pts) {
    if (!p.hub) continue
    for (const team of [1, 2]) {
      const chosen = pick.get(`${p.zone.n}/${team}`) || []
      const side = p.sides[team]
      report.push(`point ${p.zone.n} side ${team}: ${chosen.length} of ${p.cands.length} places` +
        `${side.own ? ` (rear ${Math.round(Math.atan2(side.own.y, side.own.x) * 180 / Math.PI)} deg` : p.flat ? ' (bases the same way: no rear' : ' (no base known: no rear'}` +
        `${side.vantage ? `, ${side.vantage} vantage points` : ''})`)
      if (chosen.length < o.per) report.push(`point ${p.zone.n} side ${team}: only ${chosen.length} places fit; a wave of more players stacks on them`)
      const inside = chosen.filter((s) => s.c.inOther).length
      if (inside) report.push(`point ${p.zone.n} side ${team}: ${inside} place(s) lie inside the reach of another point (no room outside them): a wave there stands in a point the side may not hold`)
      let gap = Infinity
      for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) gap = Math.min(gap, Math.hypot(chosen[i].c.x - chosen[j].c.x, chosen[i].c.y - chosen[j].c.y))
      if (chosen.length > 1 && gap < o.passes[0][1]) report.push(`point ${p.zone.n} side ${team}: a small room, the nearest two places are ${Math.round(gap)} units apart (${o.passes[0][1]} where there is room)`)
      sets.push({ n: p.zone.n, team, places: chosen.map(place) })
    }
  }
  return { sets, report, points: pts, options: o }
}

export { Bsp }
