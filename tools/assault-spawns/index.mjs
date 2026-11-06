// assault-spawns: the respawn places of an Assault map's capture points, from the map's own collision geometry.
//
//   import { generateForMap } from './tools/assault-spawns/index.mjs'
//   const r = generateForMap({ game: 'D:/Downloads/TSM/H9XASH', map: 'h9_as_lift', plan: 'D:/temp' })
//
// docs/ai_context/ASSAULT_SPAWNS.txt is the guide: what a good set is, the order to do it in on a new map, how to check it.
import fs from 'node:fs'
import path from 'node:path'
import { Bsp } from './bsp.mjs'
import { parseZoneCfg, zonesFromEntities, parseSpawnCfg, readBases, mergeBlock, spawnLines } from './cfg.mjs'
import { placeAll, DEFAULTS } from './place.mjs'
import { renderPlan, renderLevels } from './plan.mjs'
import { suggestPoints, sampleFloors, SUGGEST_DEFAULTS } from './suggest.mjs'
import { walkGraph, detectLevels, shareOut, suggestLevelPoints, LEVEL_DEFAULTS } from './levels.mjs'
import { suggestPads, PAD_DEFAULTS } from './pads.mjs'

export { Bsp, parseZoneCfg, zonesFromEntities, parseSpawnCfg, readBases, mergeBlock, spawnLines, placeAll, renderPlan, renderLevels, DEFAULTS,
  suggestPoints, sampleFloors, SUGGEST_DEFAULTS, walkGraph, detectLevels, shareOut, suggestLevelPoints, LEVEL_DEFAULTS, suggestPads, PAD_DEFAULTS }

/** Where a game folder (H9XASH, or a server's) keeps a map's files. */
export function mapPaths(game, map) {
  const cfg = path.join(game, 'ts', 'addons', 'amxmodx', 'configs')
  return {
    bsp: path.join(game, 'ts', 'maps', `${map}.bsp`),
    zones: path.join(cfg, `tsm_assault_${map}.cfg`),
    spawns: path.join(cfg, `tsm_spawns_${map}.cfg`),
    pads: path.join(cfg, `tsm_ctf_${map}.cfg`),
  }
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'latin1') : null)

/**
 * Tier 0 spawns the map's builder placed must all read as places a player fits with floor under them: the tool's own test of its
 * reading of the map. { total, inside, noFloor } (both 0 is right).
 */
export function checkSpawns(bsp, spawns) {
  const base = spawns.filter((s) => s.tier === 0)
  let inside = 0
  let noFloor = 0
  for (const s of base) {
    if (bsp.solid(s.x, s.y, s.z)) inside++
    else if (bsp.floorAt(s.x, s.y, s.z, 6) === null) noFloor++
  }
  return { total: base.length, inside, noFloor }
}

/**
 * One map: reads its BSP, its capture points (configs/tsm_assault_<map>.cfg, else tsm_as_N entities in the BSP) and its sides' bases
 * (tier 0 of configs/tsm_spawns_<map>.cfg), places the sets, and (unless dry) writes them into the spawn file between its marker
 * lines. Returns { paths, zones, zonesFrom, bases, result, lines, written }.
 */
export function generateForMap({ game, map, dry = false, plan = null, options = {} }) {
  const paths = mapPaths(game, map)
  if (!fs.existsSync(paths.bsp)) throw new Error(`no BSP at ${paths.bsp}`)
  const bsp = new Bsp(paths.bsp)

  let zones = []
  let zonesFrom = ''
  const zoneText = read(paths.zones)
  if (zoneText !== null) {
    zones = parseZoneCfg(zoneText)
    zonesFrom = paths.zones
  }
  if (zones.length === 0) {
    zones = zonesFromEntities(bsp)
    zonesFrom = 'tsm_as_N entities in the BSP'
  }
  if (zones.length === 0) throw new Error(`${map} has no capture points: neither tsm_as_zone lines in ${paths.zones} nor tsm_as_N entities in the BSP`)

  const spawnText = read(paths.spawns)
  const spawns = spawnText === null ? [] : parseSpawnCfg(spawnText)
  const bases = readBases(spawns, bsp)

  const result = placeAll(bsp, zones, bases, options)
  const lines = spawnLines(result.sets)
  let written = null
  if (!dry) {
    const base = spawnText !== null ? spawnText
      : `// ts_matchmode spawn points for ${map}\n// tsm_spawn <team> <x> <y> <z> <pitch> <yaw> <tier>\n`
    fs.mkdirSync(path.dirname(paths.spawns), { recursive: true })
    fs.writeFileSync(paths.spawns, mergeBlock(base, map, lines), 'latin1')
    written = paths.spawns
  }
  let planFile = null
  if (plan) {
    fs.mkdirSync(plan, { recursive: true })
    planFile = renderPlan(bsp, result, path.join(plan, `${map}-assault-spawns.png`))
  }
  return { paths, bsp, zones, zonesFrom, bases, result, lines, written, planFile }
}
