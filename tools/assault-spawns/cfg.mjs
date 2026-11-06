// The files an Assault map is described by, read and written: the capture points, the sides' bases and the spawn lines.
//
//   configs/tsm_assault_<map>.cfg   tsm_as_zone <n> <x> <y> <z> [radius]
//   configs/tsm_spawns_<map>.cfg    tsm_spawn <team> <x> <y> <z> <pitch> <yaw> [tier]   (tier 0 is a side's base; tier N is capture point N's set)
//
// Both are console files: "//" starts a comment, anywhere on a line.
import { parseEntities } from './bsp.mjs'

export const DEFAULT_RADIUS = 384 // tsm_as_radius

const tokens = (line) => line.split('//')[0].trim().split(/\s+/).filter(Boolean)

/** tsm_as_zone lines of a tsm_assault_<map>.cfg: [{ n, x, y, z, radius }] */
export function parseZoneCfg(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const t = tokens(line)
    if (t[0] === 'tsm_as_zone' && t.length >= 5) {
      out.push({ n: Number(t[1]), x: Number(t[2]), y: Number(t[3]), z: Number(t[4]), radius: t[5] !== undefined ? Number(t[5]) : DEFAULT_RADIUS })
    }
  }
  return out.filter((z) => Number.isInteger(z.n) && z.n >= 1 && z.n <= 24 && [z.x, z.y, z.z, z.radius].every(Number.isFinite))
}

/**
 * The capture points a map carries itself: any entity with the targetname tsm_as_1 .. tsm_as_24. A point entity's origin is the
 * point's middle (radius tsm_as_radius, unless it has a "radius" key); a brush's box is its footprint (the middle of its box at
 * its floor, as wide as it is), as ts_assault reads them.
 */
export function zonesFromEntities(bsp, defaultRadius = DEFAULT_RADIUS) {
  const out = []
  for (const e of bsp.entities) {
    const m = /^tsm_as_(\d+)$/.exec(e.targetname || '')
    if (!m) continue
    const n = Number(m[1])
    if (n < 1 || n > 24) continue
    const mk = e.model || ''
    const brush = mk.startsWith('*') ? bsp.models[Number(mk.slice(1))] : null
    if (brush && brush.maxs[0] - brush.mins[0] > 4 && brush.maxs[1] - brush.mins[1] > 4) {
      out.push({
        n, x: (brush.mins[0] + brush.maxs[0]) / 2, y: (brush.mins[1] + brush.maxs[1]) / 2, z: brush.mins[2],
        radius: Math.max(brush.maxs[0] - brush.mins[0], brush.maxs[1] - brush.mins[1]) / 2,
      })
    } else {
      const o = (e.origin || '0 0 0').split(/\s+/).map(Number)
      out.push({ n, x: o[0], y: o[1], z: o[2], radius: e.radius ? Number(e.radius) : defaultRadius })
    }
  }
  return out.sort((a, b) => a.n - b.n)
}

/** tsm_spawn lines: [{ team, x, y, z, pitch, yaw, tier }] */
export function parseSpawnCfg(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const t = tokens(line)
    if (t[0] === 'tsm_spawn' && t.length >= 4) {
      out.push({
        team: Number(t[1]), x: Number(t[2]), y: Number(t[3]), z: Number(t[4]),
        pitch: Number(t[5] || 0), yaw: Number(t[6] || 0), tier: t[7] !== undefined ? Number(t[7]) : 0,
      })
    }
  }
  return out.filter((s) => (s.team === 1 || s.team === 2) && [s.x, s.y, s.z].every(Number.isFinite))
}

/**
 * Where each side starts: the middle of its tier 0 spawn lines, else of the map's own info_player_team1 / info_player_team2.
 * { 1: { x, y, z, count, source }, 2: { ... } }, a side with neither left null.
 */
export function readBases(spawns, bsp) {
  const out = { 1: null, 2: null }
  for (const team of [1, 2]) {
    let pts = spawns.filter((s) => s.team === team && s.tier === 0)
    let source = 'tsm_spawns tier 0'
    if (pts.length === 0 && bsp) {
      pts = bsp.entities.filter((e) => e.classname === `info_player_team${team}` && e.origin)
        .map((e) => { const o = e.origin.split(/\s+/).map(Number); return { x: o[0], y: o[1], z: o[2] } })
      source = `info_player_team${team}`
    }
    if (pts.length === 0) continue
    const sum = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: a.z + p.z }), { x: 0, y: 0, z: 0 })
    out[team] = { x: sum.x / pts.length, y: sum.y / pts.length, z: sum.z / pts.length, count: pts.length, source }
  }
  return out
}

// ---- the generated block in a spawn file ----

export const markBegin = (map) =>
  `// ---- assault spawn sets: written by tools/assault-spawns from tsm_assault_${map}.cfg; rewritten each run, hand edits go outside these lines`
export const MARK_END = '// ---- end assault spawn sets'

/**
 * The text of a spawn file with its generated block or blocks (from whichever run or version of the tool: each runs from a line
 * starting "// ---- assault spawn sets:" to the end marker) replaced by one block of `lines`, line endings kept.
 */
export function mergeBlock(text, map, lines) {
  const crlf = text.includes('\r\n')
  let t = text.replace(/\r\n/g, '\n')
  const begin = markBegin(map)
  for (;;) {
    const a = t.search(/^\/\/ ---- assault spawn sets:/m)
    if (a < 0) break
    const b = t.indexOf(MARK_END, a)
    t = t.slice(0, a).replace(/\n+$/, '\n') + (b >= 0 ? t.slice(b + MARK_END.length).replace(/^\n+/, '') : '')
  }
  t = t.replace(/\n+$/, '\n') + '\n' + begin + '\n' + lines.join('\n') + '\n' + MARK_END + '\n'
  return crlf ? t.replace(/\n/g, '\r\n') : t
}

/** The tsm_spawn lines of sets: sets is [{ n, team, places: [{ x, y, z, yaw }] }]. */
export function spawnLines(sets) {
  const out = []
  for (const s of sets) {
    for (const p of s.places) out.push(`tsm_spawn ${s.team} ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} 0.00 ${p.yaw.toFixed(2)} ${s.n}`)
  }
  return out
}

export { parseEntities }
