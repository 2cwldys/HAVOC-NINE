// A GoldSrc BSP (version 30) read for what spawn placement needs: the entities, and the map's own collision hulls.
//
//   hull 1  the standing player's box (32 x 32 x 72): "is a player's ORIGIN here inside the world?" is one walk down a short tree
//   hull 0  the exact surfaces: a line of sight, by sampling a segment
//
// The world is model 0. Every brush entity (func_wall, func_door, ...) is a model of its own at its own place, so a place is only
// open when the world AND every solid brush entity near it say so. A spatial grid keeps that cheap on a map with hundreds of them.
import fs from 'node:fs'

export const CONTENTS_SOLID = -2
export const CONTENTS_SKY = -6

// brush entities a player cannot stand inside. func_illusionary and the trigger_ family are left out: they do not block.
export const SOLID_CLASSES = new Set([
  'func_wall', 'func_wall_toggle', 'func_door', 'func_door_rotating', 'func_breakable', 'func_pushable', 'func_plat',
  'func_platrot', 'func_train', 'func_tracktrain', 'func_rotating', 'func_conveyor', 'func_button', 'func_rot_button',
  'func_healthcharger', 'func_recharge', 'func_vehicle', 'func_guntarget', 'func_pendulum',
])

const CELL = 256 // the grid's cell, units

export function parseEntities(text) {
  const out = []
  for (const m of text.matchAll(/\{([^}]*)\}/g)) {
    const e = {}
    for (const kv of m[1].matchAll(/"([^"]*)"\s+"([^"]*)"/g)) e[kv[1]] = kv[2]
    out.push(e)
  }
  return out
}

export class Bsp {
  constructor(file) {
    const b = fs.readFileSync(file)
    const version = b.readInt32LE(0)
    if (version !== 30) throw new Error(`${file} is BSP version ${version}, not 30`)
    const lump = (i) => {
      const o = b.readInt32LE(4 + 8 * i)
      const l = b.readInt32LE(8 + 8 * i)
      return b.subarray(o, o + l)
    }
    this.file = file

    const ent = lump(0)
    const nul = ent.indexOf(0)
    this.entities = parseEntities(ent.subarray(0, nul < 0 ? ent.length : nul).toString('latin1'))

    const pl = lump(1)
    const np = pl.length / 20
    this.planeN = new Float32Array(np * 3)
    this.planeD = new Float32Array(np)
    this.planeT = new Int32Array(np)
    for (let i = 0; i < np; i++) {
      this.planeN[3 * i] = pl.readFloatLE(20 * i)
      this.planeN[3 * i + 1] = pl.readFloatLE(20 * i + 4)
      this.planeN[3 * i + 2] = pl.readFloatLE(20 * i + 8)
      this.planeD[i] = pl.readFloatLE(20 * i + 12)
      this.planeT[i] = pl.readInt32LE(20 * i + 16)
    }

    // hull 1, 2 and 3 share this array (a model's headnode[hull] says where its tree starts)
    const cn = lump(9)
    const nc = cn.length / 8
    this.clipP = new Int32Array(nc)
    this.clipC0 = new Int16Array(nc)
    this.clipC1 = new Int16Array(nc)
    for (let i = 0; i < nc; i++) {
      this.clipP[i] = cn.readInt32LE(8 * i)
      this.clipC0[i] = cn.readInt16LE(8 * i + 4)
      this.clipC1[i] = cn.readInt16LE(8 * i + 6)
    }

    // hull 0: the nodes and leafs
    const nd = lump(5)
    const nn = nd.length / 24
    this.nodeP = new Int32Array(nn)
    this.nodeC0 = new Int16Array(nn)
    this.nodeC1 = new Int16Array(nn)
    for (let i = 0; i < nn; i++) {
      this.nodeP[i] = nd.readInt32LE(24 * i)
      this.nodeC0[i] = nd.readInt16LE(24 * i + 4)
      this.nodeC1[i] = nd.readInt16LE(24 * i + 6)
    }
    const lf = lump(10)
    const nl = lf.length / 28
    this.leafContents = new Int32Array(nl)
    for (let i = 0; i < nl; i++) this.leafContents[i] = lf.readInt32LE(28 * i)

    const md = lump(14)
    this.models = []
    for (let i = 0; i < md.length / 64; i++) {
      const o = 64 * i
      this.models.push({
        mins: [md.readFloatLE(o), md.readFloatLE(o + 4), md.readFloatLE(o + 8)],
        maxs: [md.readFloatLE(o + 12), md.readFloatLE(o + 16), md.readFloatLE(o + 20)],
        head0: md.readInt32LE(o + 36),
        head1: md.readInt32LE(o + 40),
      })
    }

    // the world, and every solid brush entity: its trees, where it stands, and the box it can be met in
    this.world = { head0: this.models[0].head0, head1: this.models[0].head1 }
    this.blockers = []
    for (const e of this.entities) {
      const mk = e.model || ''
      if (!mk.startsWith('*') || !SOLID_CLASSES.has(e.classname)) continue
      const idx = Number(mk.slice(1))
      if (!(idx >= 1 && idx < this.models.length)) continue
      const org = (e.origin || '0 0 0').split(/\s+/).map(Number)
      const o = org.length === 3 && org.every(Number.isFinite) ? org : [0, 0, 0]
      const m = this.models[idx]
      this.blockers.push({
        cls: e.classname,
        head0: m.head0, head1: m.head1, org: o,
        // padded: a player's origin can be this far from a surface and still be inside it, in hull 1
        lo: [m.mins[0] + o[0] - 40, m.mins[1] + o[1] - 40, m.mins[2] + o[2] - 40],
        hi: [m.maxs[0] + o[0] + 40, m.maxs[1] + o[1] + 40, m.maxs[2] + o[2] + 40],
      })
    }
    this.grid = new Map()
    this.blockers.forEach((bl, i) => {
      for (let cx = Math.floor(bl.lo[0] / CELL); cx <= Math.floor(bl.hi[0] / CELL); cx++) {
        for (let cy = Math.floor(bl.lo[1] / CELL); cy <= Math.floor(bl.hi[1] / CELL); cy++) {
          const k = cx + ',' + cy
          if (!this.grid.has(k)) this.grid.set(k, [])
          this.grid.get(k).push(i)
        }
      }
    })
  }

  // ---- the trees ----

  hull1(head, x, y, z) {
    let n = head
    while (n >= 0) {
      const p = this.clipP[n]
      const t = this.planeT[p]
      const d = t < 3 ? (t === 0 ? x : t === 1 ? y : z) - this.planeD[p]
        : this.planeN[3 * p] * x + this.planeN[3 * p + 1] * y + this.planeN[3 * p + 2] * z - this.planeD[p]
      n = d < 0 ? this.clipC1[n] : this.clipC0[n]
    }
    return n
  }

  hull0(head, x, y, z) {
    let n = head
    while (n >= 0) {
      const p = this.nodeP[n]
      const t = this.planeT[p]
      const d = t < 3 ? (t === 0 ? x : t === 1 ? y : z) - this.planeD[p]
        : this.planeN[3 * p] * x + this.planeN[3 * p + 1] * y + this.planeN[3 * p + 2] * z - this.planeD[p]
      n = d < 0 ? this.nodeC1[n] : this.nodeC0[n]
    }
    return this.leafContents[-1 - n]
  }

  near(x, y) {
    return this.grid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || []
  }

  // ---- questions ----

  /** True when a standing player's origin at (x, y, z) is inside the world or a solid brush entity. */
  solid(x, y, z) {
    let c = this.hull1(this.world.head1, x, y, z)
    if (c === CONTENTS_SOLID || c === CONTENTS_SKY) return true
    for (const i of this.near(x, y)) {
      const b = this.blockers[i]
      if (z < b.lo[2] || z > b.hi[2]) continue
      if (this.passable && this.passable.has(b.cls)) continue
      c = this.hull1(b.head1, x - b.org[0], y - b.org[1], z - b.org[2])
      if (c === CONTENTS_SOLID || c === CONTENTS_SKY) return true
    }
    return false
  }

  /** True when a ray's point (x, y, z) is inside a surface (hull 0). */
  opaque(x, y, z) {
    let c = this.hull0(this.world.head0, x, y, z)
    if (c === CONTENTS_SOLID || c === CONTENTS_SKY) return true
    for (const i of this.near(x, y)) {
      const b = this.blockers[i]
      if (z < b.lo[2] || z > b.hi[2]) continue
      c = this.hull0(b.head0, x - b.org[0], y - b.org[1], z - b.org[2])
      if (c === CONTENTS_SOLID || c === CONTENTS_SKY) return true
    }
    return false
  }

  /**
   * The height a standing player rests at near z0: open at it, solid 3 units under, nearest z0 first.
   * null when there is no floor within `reach` units of z0 there.
   */
  floorAt(x, y, z0, reach = 24, down = reach) {
    for (let k = 0; k <= Math.max(reach, down); k++) {
      for (const z of k === 0 ? [z0] : [k <= reach ? z0 + k : null, k <= down ? z0 - k : null]) {
        if (z === null) continue
        if (!this.solid(x, y, z) && this.solid(x, y, z - 3)) return z
      }
    }
    return null
  }

  /**
   * A straight walk from a to b in the standing hull, tested every 8 units with the floor it rests on (a step up of `reach` at most
   * between two of them, and a step or short drop down of `down`): the standing height it ends at, or null when something blocks it
   * or the floor gives out.
   */
  walkTo(a, b, reach = 10, down = reach) {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const steps = Math.max(1, Math.floor(Math.hypot(dx, dy) / 8))
    let z = a[2]
    for (let i = 1; i <= steps; i++) {
      const fz = this.floorAt(a[0] + (dx * i) / steps, a[1] + (dy * i) / steps, z, reach, down)
      if (fz === null) return null
      z = fz
    }
    return z
  }

  /** A straight walk from a to b in the standing hull, open all the way (walkTo, without where it ends). */
  walkOpen(a, b) {
    return this.walkTo(a, b) !== null
  }

  /** True when nothing blocks the line from a to b (eye positions), sampled every 4 units on the exact surfaces. */
  sightClear(a, b) {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    const steps = Math.max(1, Math.floor(Math.hypot(dx, dy, dz) / 4))
    for (let i = 1; i < steps; i++) {
      if (this.opaque(a[0] + (dx * i) / steps, a[1] + (dy * i) / steps, a[2] + (dz * i) / steps)) return false
    }
    return true
  }

  /** The world's own bounds, for drawing. */
  bounds() {
    return { mins: this.models[0].mins, maxs: this.models[0].maxs }
  }
}
