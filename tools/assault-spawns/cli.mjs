#!/usr/bin/env node
// Writes (or checks, or draws) an Assault map's respawn sets.
//
//   node tools/assault-spawns/cli.mjs <map> [<map> ...] [options]
//
//   --game <folder>   the game folder holding ts/maps and ts/addons/amxmodx/configs (default: H9XASH beside tools/, or H9_GAME)
//   --check           only test this tool's reading of the map against the map's own tier 0 spawns; write nothing
//   --dry             place the sets and report them, write nothing
//   --plan <folder>   also draw <map>-assault-spawns.png there: one panel for each capture point, blue side 1, red side 2
//   --per <n>         places in a set (default 8)
//   --json            print the sets as JSON instead of the report
//   --suggest <n>     a map with no capture points yet: propose n of them between the two bases (open floor with room for the
//                     whole reach, one to a band along the line), print them as tsm_as_zone lines and, with --plan, draw them
//   --reach <r>       the radius of a suggested point (default 384)
//   --write           with --suggest: write them to configs/tsm_assault_<map>.cfg (refused when that file exists, unless --force)
//   --levels <how>    with --suggest: a map of several floors (a city with sewers under it): spread the points over its levels, each
//                     reachable by walking from both bases. <how> is auto (the three busiest levels), a number (that many), or
//                     <z>:<count>,<z>:<count>... (standing heights and how many points on each, the nearest level found is taken)
//   --overview <dir>  also draw <map>-assault-levels.png there: one band for each level, with its points, the bases and the sets
//   --pads            a Capture the Flag map: propose each side's flag pad (flat open floor in its base, to the rear of the spawns),
//                     print them as tsm_cf_pad lines and, with --overview <dir>, draw <map>-ctf-pads.png; --write puts them in
//                     configs/tsm_ctf_<map>.cfg (refused when that file exists, unless --force)
//
// Exit code 1 when --check finds a spawn it cannot account for, or a point ends with fewer places than --per.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateForMap, checkSpawns, mapPaths, Bsp, parseSpawnCfg, readBases, placeAll, renderPlan, renderLevels, suggestPoints, suggestLevelPoints, suggestPads, PAD_DEFAULTS } from './index.mjs'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const valued = new Set(['game', 'plan', 'per', 'suggest', 'reach', 'levels', 'overview'])  // --pads and --write take no value
const maps = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && valued.has(argv[i - 1].slice(2))))
if (maps.length === 0) {
  console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(2)
}
const game = path.resolve(opt('game', process.env.H9_GAME || path.join(HERE, '..', '..', 'H9XASH')))
const per = Number(opt('per', 8))
let failed = false

for (const map of maps) {
  console.log(map)
  if (Number(opt('suggest', 0)) > 0) {
    const p = mapPaths(game, map)
    const bsp = new Bsp(p.bsp)
    const bases = readBases(fs.existsSync(p.spawns) ? parseSpawnCfg(fs.readFileSync(p.spawns, 'latin1')) : [], bsp)
    const spawnList = fs.existsSync(p.spawns) ? parseSpawnCfg(fs.readFileSync(p.spawns, 'latin1')) : []
    const howLevels = opt('levels', null)
    let pts
    let found = null
    if (howLevels) {
      const lo = { count: Number(opt('suggest', 7)), reach: Number(opt('reach', 384)) }
      if (/^\d+$/.test(howLevels)) lo.levels = Number(howLevels)
      else if (howLevels !== 'auto') lo.levelSpec = howLevels.split(',').map((t) => { const [z, count] = t.split(':').map(Number); return { z, count } })
      const r = suggestLevelPoints(bsp, spawnList, lo)
      pts = r.points
      found = r.levels
      for (const lv of found) console.log(`  level ${lv.index + 1}: floor at standing height ${Math.round(lv.z)}, ${lv.cells} reachable cells, ${lv.points} point(s)`)
    } else {
      pts = suggestPoints(bsp, bases, { count: Number(opt('suggest', 5)), reach: Number(opt('reach', 384)) })
    }
    console.log(`  bases: side 1 ${bases[1] ? [bases[1].x, bases[1].y, bases[1].z].map(Math.round).join(' ') : '?'}, side 2 ${bases[2] ? [bases[2].x, bases[2].y, bases[2].z].map(Math.round).join(' ') : '?'}`)
    const lines = pts.map((q) => `tsm_as_zone ${q.n} ${q.x.toFixed(2)} ${q.y.toFixed(2)} ${q.z.toFixed(2)} ${q.radius.toFixed(2)}   // ` +
      (q.level !== undefined ? `level ${q.level + 1} (floor ${Math.round(q.levelZ - 36)}), ${Math.round(q.tp * 100)}% of the walk, room ${q.room}` : `${Math.round(q.t * 100)}% of the way, room ${q.room}`))
    lines.forEach((l) => console.log('  ' + l))
    if (pts.length < Number(opt('suggest', 5))) console.log(`  only ${pts.length} point(s) found: widen --reach down, or place the rest by hand`)
    const zonesOut = pts.map((q) => ({ n: q.n, x: q.x, y: q.y, z: q.z, radius: q.radius }))
    if (opt('plan', null) || opt('overview', null)) {
      const placed = placeAll(bsp, zonesOut, bases, { per })
      if (opt('plan', null)) {
        fs.mkdirSync(opt('plan'), { recursive: true })
        console.log(`  plan: ${renderPlan(bsp, placed, path.join(opt('plan'), `${map}-assault-points.png`))}`)
      }
      if (opt('overview', null)) {
        fs.mkdirSync(opt('overview'), { recursive: true })
        const lv = found ? found.map((l) => ({ z: l.z })) : [{ z: bases[1] ? bases[1].z : 36 }]
        console.log(`  overview: ${renderLevels(bsp, lv, zonesOut, bases, path.join(opt('overview'), `${map}-assault-levels.png`), { sets: placed.sets })}`)
      }
    }
    if (flag('write')) {
      if (fs.existsSync(p.zones) && !flag('force')) {
        console.log(`  ${p.zones} exists: not overwritten (--force does)`)
        failed = true
      } else {
        fs.writeFileSync(p.zones, [`// ts_assault capture points for ${map} -- suggested by tools/assault-spawns (--suggest ${pts.length}); move them by hand where the map wants`,
          '// tsm_as_zone <n> <x> <y> <z> <radius>   (point n\'s spawn set is tier n of the map\'s tsm_spawns file)', ...lines, ''].join('\r\n'), 'latin1')
        console.log(`  wrote ${p.zones}`)
      }
    }
    continue
  }
  if (flag('pads')) {
    const p = mapPaths(game, map)
    const bsp = new Bsp(p.bsp)
    const spawnList = fs.existsSync(p.spawns) ? parseSpawnCfg(fs.readFileSync(p.spawns, 'latin1')) : []
    const bases = readBases(spawnList, bsp)
    const pads = suggestPads(bsp, bases, spawnList)
    const lines = []
    for (const s of [1, 2]) {
      const q = pads[s]
      if (!q) { console.log(`  side ${s}: no base, no pad`); failed = true; continue }
      console.log(`  side ${s}: pad at ${q.x.toFixed(0)} ${q.y.toFixed(0)} ${q.z.toFixed(0)}, ${Math.round(q.open * 100)}% of the floor round it open`)
      lines.push(`tsm_cf_pad ${s} ${q.x.toFixed(2)} ${q.y.toFixed(2)} ${q.z.toFixed(2)}`)
    }
    lines.forEach((l) => console.log('  ' + l))
    if (opt('overview', null) && lines.length === 2) {
      fs.mkdirSync(opt('overview'), { recursive: true })
      const pts = [1, 2].map((s) => ({ n: s, x: pads[s].x, y: pads[s].y, z: pads[s].z + 13, radius: PAD_DEFAULTS.reach }))
      const lv = [...new Set([1, 2].map((s) => Math.round((pads[s].z + 34) / 8) * 8))].map((z) => ({ z }))
      console.log(`  overview: ${renderLevels(bsp, lv, pts, bases, path.join(opt('overview'), `${map}-ctf-pads.png`))}`)
    }
    if (flag('write') && lines.length === 2) {
      if (fs.existsSync(p.pads) && !flag('force')) {
        console.log(`  ${p.pads} exists: not overwritten (--force does)`)
        failed = true
      } else {
        fs.writeFileSync(p.pads, [`// ts_ctf flag pads for ${map} -- proposed by tools/assault-spawns (--pads); move them by hand where the map wants`,
          '// tsm_cf_pad <side 1|2> <x> <y> <z>   (the floor where that side\'s flag stands and its carrier turns the enemy\'s in)', ...lines, ''].join('\r\n'), 'latin1')
        console.log(`  wrote ${p.pads}`)
      }
    }
    continue
  }
  if (flag('check')) {
    const p = mapPaths(game, map)
    const bsp = new Bsp(p.bsp)
    const text = fs.existsSync(p.spawns) ? fs.readFileSync(p.spawns, 'latin1') : ''
    const c = checkSpawns(bsp, parseSpawnCfg(text))
    console.log(`  ${c.total} tier 0 spawns: ${c.inside} inside the world, ${c.noFloor} with no floor under them (0 and 0 is right)`)
    console.log(`  ${bsp.blockers.length} solid brush entities, ${bsp.clipP.length} clip nodes`)
    if (c.inside || c.noFloor) failed = true
    continue
  }
  const r = generateForMap({ game, map, dry: flag('dry') || flag('json'), plan: opt('plan', null), options: { per } })
  if (flag('json')) {
    console.log(JSON.stringify({ zones: r.zones, bases: r.bases, sets: r.result.sets }, null, 1))
    continue
  }
  console.log(`  capture points from ${r.zonesFrom}: ${r.zones.length}`)
  for (const t of [1, 2]) {
    const b = r.bases[t]
    console.log(`  side ${t} base: ${b ? `${b.x.toFixed(0)} ${b.y.toFixed(0)} ${b.z.toFixed(0)} (${b.count} places of ${b.source})` : 'unknown'}`)
  }
  for (const line of r.result.report) console.log('  ' + line)
  for (const s of r.result.sets) if (s.places.length < per) failed = true
  console.log(r.written ? `  wrote ${r.lines.length} lines to ${r.written}` : '  nothing written')
  if (r.planFile) console.log(`  plan: ${r.planFile}`)
  if (opt('overview', null)) {
    // the levels the points are on: their heights, nearest together
    const heights = [...new Set(r.zones.map((z) => Math.round((z.z + 21) / 8) * 8))].sort((a, b) => b - a)
    const lv = []
    for (const h of heights) if (!lv.some((l) => Math.abs(l.z - h) < 100)) lv.push({ z: h })
    fs.mkdirSync(opt('overview'), { recursive: true })
    console.log(`  overview: ${renderLevels(r.bsp, lv, r.zones, r.bases, path.join(opt('overview'), `${map}-assault-levels.png`), { sets: r.result.sets })}`)
  }
}
process.exit(failed ? 1 : 0)
