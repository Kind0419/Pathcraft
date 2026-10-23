/**
 * Continuous smooth space.
 *
 * A map with no cells: obstacles are analytic primitives (discs, capsules,
 * boxes) and the only question the planner can ask is "how far is the nearest
 * surface". Two consequences, and this file is mostly about the second:
 *
 * 1. **Sampling planners need nothing else.** RRT*, PRM and the visibility
 *    graph only ever call `free` and `segmentFree`, so they run on this metric
 *    unchanged. That is why `core/geometry.ts` was written against a predicate
 *    instead of a grid.
 *
 * 2. **Graph planners need a lattice, and that lattice is a choice.** There is
 *    no "the" resolution for an SDF, so it becomes a runtime parameter:
 *    `fieldLattice(metric, resolution)`. Coarse is fast and may miss a gap;
 *    fine is slow and may not fit in memory. Making the choice explicit (rather
 *    than hidden in an asset) is the honest design, and it costs nothing to
 *    change per run.
 *
 * The signed distance is exact for these primitives, so `clearanceAt` is the
 * true clearance instead of a value sampled from a raster — the reason to model
 * a space this way at all.
 */
import type { CardsState } from '../../types'
import { costModelFrom } from './cost'
import { makeLattice, type LatticeData } from './lattice'
import { sampleSegmentFree } from './grid'
import type { Lattice, SpaceMetric, Vec3 } from './types'

export type Primitive =
  | { kind: 'disc'; x: number; y: number; r: number }
  | { kind: 'capsule'; ax: number; ay: number; bx: number; by: number; r: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'sphere'; x: number; y: number; z: number; r: number }
  | { kind: 'capsule3'; a: Vec3; b: Vec3; r: number }
  | { kind: 'box3'; min: Vec3; max: Vec3 }

/** Signed distance to one primitive: negative inside, exact outside. */
export function signedDistance(primitive: Primitive, p: Vec3): number {
  switch (primitive.kind) {
    case 'disc':
      return Math.hypot(p.x - primitive.x, p.y - primitive.y) - primitive.r
    case 'capsule': {
      const { ax, ay, bx, by, r } = primitive
      const vx = bx - ax
      const vy = by - ay
      const wx = p.x - ax
      const wy = p.y - ay
      const lengthSq = vx * vx + vy * vy
      const t = lengthSq < 1e-12 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq))
      return Math.hypot(wx - vx * t, wy - vy * t) - r
    }
    case 'box': {
      const cx = (primitive.x0 + primitive.x1) / 2
      const cy = (primitive.y0 + primitive.y1) / 2
      const hx = Math.abs(primitive.x1 - primitive.x0) / 2
      const hy = Math.abs(primitive.y1 - primitive.y0) / 2
      const dx = Math.abs(p.x - cx) - hx
      const dy = Math.abs(p.y - cy) - hy
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
      return outside + Math.min(Math.max(dx, dy), 0)
    }
    case 'sphere':
      return Math.hypot(p.x - primitive.x, p.y - primitive.y, p.z - primitive.z) - primitive.r
    case 'capsule3': {
      const { a, b, r } = primitive
      const vx = b.x - a.x
      const vy = b.y - a.y
      const vz = b.z - a.z
      const wx = p.x - a.x
      const wy = p.y - a.y
      const wz = p.z - a.z
      const lengthSq = vx * vx + vy * vy + vz * vz
      const t =
        lengthSq < 1e-12 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy + wz * vz) / lengthSq))
      return Math.hypot(wx - vx * t, wy - vy * t, wz - vz * t) - r
    }
    case 'box3': {
      const { min, max } = primitive
      const cx = (min.x + max.x) / 2
      const cy = (min.y + max.y) / 2
      const cz = (min.z + max.z) / 2
      const hx = Math.abs(max.x - min.x) / 2
      const hy = Math.abs(max.y - min.y) / 2
      const hz = Math.abs(max.z - min.z) / 2
      const dx = Math.abs(p.x - cx) - hx
      const dy = Math.abs(p.y - cy) - hy
      const dz = Math.abs(p.z - cz) - hz
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0))
      return outside + Math.min(Math.max(dx, Math.max(dy, dz)), 0)
    }
  }
}

export interface FieldSpace {
  dim: 2 | 3
  primitives: Primitive[]
  bounds: { min: Vec3; max: Vec3 }
}

/**
 * Distance to the union of primitives. The union is the minimum, which is
 * correct for clearance but means the field is not differentiable at Voronoi
 * boundaries — fine for these planners, worth knowing if you add a gradient
 * method later.
 */
export function fieldDistance(space: FieldSpace, p: Vec3): number {
  let best = Number.POSITIVE_INFINITY
  for (const primitive of space.primitives) {
    const value = signedDistance(primitive, p)
    if (value < best) best = value
  }
  return best
}

export function fieldMetric(space: FieldSpace, radius: number, resolution = 0.5): SpaceMetric {
  const { bounds } = space
  return {
    dim: space.dim,
    kind: space.dim === 3 ? 'field3d' : 'field2d',
    bounds,
    clearanceCap: 64,
    free(point, pad = radius) {
      if (point.x < bounds.min.x || point.y < bounds.min.y || point.x > bounds.max.x || point.y > bounds.max.y) {
        return false
      }
      if (space.dim === 3 && (point.z < bounds.min.z || point.z > bounds.max.z)) return false
      return fieldDistance(space, point) >= pad
    },
    clearanceAt(point) {
      return fieldDistance(space, point)
    },
    segmentFree(a, b, pad = radius) {
      return sampleSegmentFree(this, a, b, pad, resolution * 0.5)
    },
  }
}

export interface FieldLatticeOptions {
  resolution: number
  width: number
  height: number
  depth?: number
}

/**
 * Rasterise the question, not the world.
 *
 * Clearance is stored divided by `resolution` so one lattice unit still means
 * "one step", which keeps `clearanceSafe = 3.2` meaningful across 0.1 m and
 * 1 m resolutions. A cell is blocked when it is inside an obstacle or closer
 * than the safety radius — the same rule `gridLattice` uses, just evaluated
 * analytically instead of read from a precomputed field.
 */
export function fieldLattice(
  space: FieldSpace,
  options: FieldLatticeOptions,
  cards: CardsState,
  lengthScale: number,
  goal: Vec3,
): Lattice {
  const { resolution, width, height } = options
  const depth = options.depth ?? 1
  const cost = costModelFrom(cards, goal, lengthScale)
  const blocked = new Uint8Array(width * height * depth)
  const clearance = new Float32Array(width * height * depth)
  const plane = width * height
  const point: Vec3 = { x: 0, y: 0, z: 0 }
  // A voxel is blocked when its centre is inside an obstacle or inside the
  // safety radius. `cost.radius` is in lattice units, so convert to world.
  const pad = Math.max(0, cost.radius) * resolution

  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        point.x = (x + 0.5) * resolution
        point.y = (y + 0.5) * resolution
        point.z = (z + 0.5) * resolution
        const value = fieldDistance(space, point)
        const index = z * plane + y * width + x
        clearance[index] = Math.max(0, value) / resolution
        if (value < pad) blocked[index] = 1
      }
    }
  }

  const data: LatticeData = {
    dim: space.dim,
    kind: space.dim === 3 ? 'field3d' : 'field2d',
    width,
    height,
    depth,
    spacing: resolution,
    blocked,
    clearance,
    metric: fieldMetric(space, cost.radius, resolution),
    cost,
  }
  return makeLattice(data)
}
