// node --test tools/assault-spawns/assault-spawns.test.mjs
//
// The pure parts are tested on made-up text; the map parts run against the shipped Assault maps in H9XASH when they are there (and say
// so when they are not), because the only honest test of a BSP reader is a BSP.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseZoneCfg, parseSpawnCfg, readBases, mergeBlock, spawnLines, markBegin, MARK_END } from './cfg.mjs'
import { Bsp } from './bsp.mjs'
import { placeAll, dirTo } from './place.mjs'
import { mapPaths, checkSpawns, generateForMap, suggestPoints, suggestLevelPoints, suggestPads } from './index.mjs'

const GAME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'H9XASH')

test('zone lines: comments, a missing radius, junk', () => {
  const z = parseZoneCfg('// x\ntsm_as_zone 1 10 20 30 288   // the bay\ntsm_as_zone 2 -5.5 0 8\ntsm_as_zone 99 0 0 0\ntsm_as_zone x 1 2 3\n')
  assert.deepEqual(z.map((a) => [a.n, a.x, a.y, a.z, a.radius]), [[1, 10, 20, 30, 288], [2, -5.5, 0, 8, 384]])
})

test('spawn lines: tier is optional and 0, a side must be 1 or 2', () => {
  const s = parseSpawnCfg('tsm_spawn 1 1 2 3 0 90\ntsm_spawn 2 4 5 6 0 -90 3 // set 3\ntsm_spawn 3 1 1 1\n// tsm_spawn 1 9 9 9\n')
  assert.deepEqual(s.map((a) => [a.team, a.x, a.y, a.z, a.yaw, a.tier]), [[1, 1, 2, 3, 90, 0], [2, 4, 5, 6, -90, 3]])
})

test('bases are the middle of tier 0, not of the sets', () => {
  const b = readBases(parseSpawnCfg('tsm_spawn 1 0 0 0\ntsm_spawn 1 100 0 0\ntsm_spawn 1 900 900 900 0 0 2\ntsm_spawn 2 5 5 5\n'), null)
  assert.deepEqual([b[1].x, b[1].y, b[1].count, b[2].x], [50, 0, 2, 5])
})

test('the generated block is replaced, never doubled, whoever wrote the old one, and line endings are kept', () => {
  const lines = ['tsm_spawn 1 1.00 2.00 3.00 0.00 90.00 1']
  const once = mergeBlock('// header\r\ntsm_spawn 1 0 0 0 0 0\r\n', 'm', lines)
  assert.ok(once.includes(markBegin('m')) && once.endsWith(MARK_END + '\r\n') && !/[^\r]\n/.test(once))
  const twice = mergeBlock(once, 'm', ['tsm_spawn 2 9.00 9.00 9.00 0.00 0.00 4'])
  assert.equal(twice.split('assault spawn sets:').length - 1, 1)
  assert.ok(twice.includes('tsm_spawn 1 0 0 0 0 0') && twice.includes('tsm_spawn 2 9.00') && !twice.includes('1.00 2.00 3.00'))
  const legacy = mergeBlock('a\n// ---- assault spawn sets: written by some older tool\ntsm_spawn 1 7 7 7 0 0 1\n// ---- end assault spawn sets\nb\n', 'm', lines)
  assert.ok(!legacy.includes('7 7 7') && legacy.includes('\nb\n') && legacy.split('assault spawn sets:').length - 1 === 1)
})

test('spawnLines writes tier N lines for each side', () => {
  const out = spawnLines([{ n: 3, team: 2, places: [{ x: 1, y: 2.5, z: 3, yaw: -45 }] }])
  assert.deepEqual(out, ['tsm_spawn 2 1.00 2.50 3.00 0.00 -45.00 3'])
})

test('dirTo: nothing for no base or a base straight above', () => {
  assert.equal(dirTo({ x: 0, y: 0 }, null), null)
  assert.equal(dirTo({ x: 0, y: 0 }, { x: 10, y: 10 }), null)
  const d = dirTo({ x: 0, y: 0 }, { x: 0, y: -200 })
  assert.deepEqual([d.x, d.y], [0, -1])
})

for (const map of ['h9_as_drainage', 'h9_as_lift']) {
  const p = mapPaths(GAME, map)
  const here = fs.existsSync(p.bsp) && fs.existsSync(p.zones) && fs.existsSync(p.spawns)

  test(`${map}: the reader agrees with the map's own tier 0 spawns`, { skip: !here && 'the map is not in H9XASH' }, () => {
    const bsp = new Bsp(p.bsp)
    assert.equal(bsp.solid(0, 0, -9000), true, 'far outside the world is solid')
    const c = checkSpawns(bsp, parseSpawnCfg(fs.readFileSync(p.spawns, 'latin1')))
    assert.ok(c.total > 20)
    assert.deepEqual([c.inside, c.noFloor], [0, 0])
  })

  test(`${map}: every set has places a player fits, apart, on the holder's side`, { skip: !here && 'the map is not in H9XASH' }, () => {
    const r = generateForMap({ game: GAME, map, dry: true })
    const bsp = r.bsp
    assert.equal(r.result.sets.length, r.zones.length * 2)
    for (const s of r.result.sets) {
      assert.ok(s.places.length >= 6, `point ${s.n} side ${s.team} has ${s.places.length} places`)
      for (const pl of s.places) {
        assert.equal(bsp.solid(pl.x, pl.y, pl.z), false, 'in the open')
        assert.equal(bsp.solid(pl.x, pl.y, pl.z - 3), true, 'floor under it')
      }
      const yaws = new Set(s.places.map((pl) => pl.yaw.toFixed(1)))
      assert.equal(yaws.size, 1, 'one way of facing for a whole set')
      for (let i = 0; i < s.places.length; i++) for (let j = i + 1; j < s.places.length; j++) {
        assert.ok(Math.hypot(s.places[i].x - s.places[j].x, s.places[i].y - s.places[j].y) >= 39, 'no two places on top of each other')
      }
    }
    // on a map whose sides are north and south of each other the holder's rear is its own half
    if (map === 'h9_as_drainage') {
      for (const s of r.result.sets) {
        const z = r.zones.find((q) => q.n === s.n)
        const mean = s.places.reduce((a, pl) => a + (pl.y - z.y), 0) / s.places.length
        assert.ok(s.team === 1 ? mean > 0 : mean < 0, `point ${s.n} side ${s.team}: places ${mean.toFixed(0)} units on the wrong side of the point`)
      }
    }
  })
}

test('placeAll without any base still places (no rear, facing the point)', { skip: !fs.existsSync(mapPaths(GAME, 'h9_as_drainage').bsp) && 'the map is not in H9XASH' }, () => {
  const p = mapPaths(GAME, 'h9_as_drainage')
  const bsp = new Bsp(p.bsp)
  const r = placeAll(bsp, [{ n: 1, x: 0, y: 640, z: 0, radius: 384 }], { 1: null, 2: null })
  assert.equal(r.sets.length, 2)
  assert.ok(r.sets.every((s) => s.places.length >= 6))
})

test('suggestPoints on the city map: points between the bases, apart, on floor at the bases height', { skip: !fs.existsSync(mapPaths(GAME, 'h9_te_neuropolis').bsp) && 'the map is not in H9XASH' }, () => {
  const p = mapPaths(GAME, 'h9_te_neuropolis')
  const bsp = new Bsp(p.bsp)
  const bases = readBases(parseSpawnCfg(fs.readFileSync(p.spawns, 'latin1')), bsp)
  const pts = suggestPoints(bsp, bases, { count: 5 })
  assert.equal(pts.length, 5)
  pts.forEach((q, i) => {
    assert.equal(q.n, i + 1)
    assert.ok(q.t > 0.1 && q.t < 0.9, 'between the bases')
    assert.notEqual(bsp.floorAt(q.x, q.y, q.z + 21, 6), null, 'floor under the point')
    assert.ok(q.z + 21 > Math.min(bases[1].z, bases[2].z) - 250 && q.z + 21 < Math.max(bases[1].z, bases[2].z) + 250, 'at the bases height, no roof')
    for (const r of pts.slice(i + 1)) assert.ok(Math.hypot(q.x - r.x, q.y - r.y) >= 500, 'points apart')
  })
  assert.ok(pts.every((q, i) => i === 0 || q.t > pts[i - 1].t), 'numbered from side 1 to side 2')
})

test('suggestLevelPoints on the city: the points lie on its three floors, each floor reachable on foot, points of one floor a reach and a quarter apart', { skip: !fs.existsSync(mapPaths(GAME, 'h9_te_neuropolis').bsp) && 'the city map is not in this game folder' }, () => {
  const p = mapPaths(GAME, 'h9_te_neuropolis')
  const bsp = new Bsp(p.bsp)
  const spawns = parseSpawnCfg(fs.readFileSync(p.spawns, 'latin1'))
  const r = suggestLevelPoints(bsp, spawns, { count: 7, reach: 384 })
  assert.equal(r.points.length, 7)
  assert.equal(new Set(r.points.map((q) => q.level)).size, 3, 'a point on each of the three floors the city has (street, undercity, shanty)')
  r.points.forEach((q, i) => {
    assert.equal(q.n, i + 1)
    assert.notEqual(bsp.floorAt(q.x, q.y, q.z + 21, 6), null, 'floor under the point')
    for (const o of r.points.slice(i + 1)) {
      if (o.level === q.level) assert.ok(Math.hypot(q.x - o.x, q.y - o.y) >= 384 * 1.25, 'points of one floor apart')
    }
  })
  assert.ok(r.points.every((q, i) => i === 0 || q.tp >= r.points[i - 1].tp), 'numbered from side 1 to side 2 along the walk')
})

test('suggestPads on the drainage works: each side\'s pad is open floor in its own base, to the rear of it, the two far apart', { skip: !fs.existsSync(mapPaths(GAME, 'h9_up_drainage').bsp) && 'the drainage map is not in this game folder' }, () => {
  const p = mapPaths(GAME, 'h9_up_drainage')
  const bsp = new Bsp(p.bsp)
  const spawns = parseSpawnCfg(fs.readFileSync(p.spawns, 'latin1'))
  const bases = readBases(spawns, bsp)
  const pads = suggestPads(bsp, bases, spawns)
  for (const s of [1, 2]) {
    const q = pads[s]
    assert.ok(q, 'a pad for side ' + s)
    assert.notEqual(bsp.floorAt(q.x, q.y, q.z + 21, 12), null, 'floor under the pad')
    assert.ok(Math.hypot(q.x - bases[s].x, q.y - bases[s].y) < Math.hypot(q.x - bases[3 - s].x, q.y - bases[3 - s].y), 'nearer its own base than the enemy\'s')
    assert.ok(Math.hypot(q.x - bases[3 - s].x, q.y - bases[3 - s].y) > Math.hypot(bases[s].x - bases[3 - s].x, bases[s].y - bases[3 - s].y), 'to the rear: farther from the enemy than the base\'s middle')
  }
  assert.ok(Math.hypot(pads[1].x - pads[2].x, pads[1].y - pads[2].y) > 1000, 'the pads far apart')
})

test('rule 6: no place of a set lies inside the reach of another point', { skip: !fs.existsSync(mapPaths(GAME, 'h9_as_lift').bsp) && 'the lift map is not in this game folder' }, () => {
  const p = mapPaths(GAME, 'h9_as_lift')
  const bsp = new Bsp(p.bsp)
  const zones = parseZoneCfg(fs.readFileSync(p.zones, 'latin1'))
  const bases = readBases(parseSpawnCfg(fs.readFileSync(p.spawns, 'latin1')), bsp)
  const r = placeAll(bsp, zones, bases)
  const inside = []
  for (const set of r.sets) {
    for (const q of set.places) {
      for (const z of zones) {
        if (z.n !== set.n && Math.hypot(q.x - z.x, q.y - z.y) < z.radius && Math.abs(q.z - z.z) < 168) inside.push([set.n, set.team, z.n])
      }
    }
  }
  assert.deepEqual(inside, [], 'places inside another point: ' + JSON.stringify(inside.slice(0, 4)))
})
