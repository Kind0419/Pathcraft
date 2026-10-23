/**
 * The 2D raster, expressed as a metric + a lattice.
 *
 * **World units here are cells, not metres.** One lattice unit is one cell, so
 * a path point `(6, 14)` is the same number the canvas draws and `clearance` is
 * the same array the UI has always used. `cellSize` (0.2 m) only matters when a
 * label converts a length for humans. Every 2D solver already works this way;
 * writing it down is what makes the voxel and SDF adapters comparable.
 */
import type { CardsState, GridMap } from '../../types'
import { cardValue } from '../costs'
import { costModelFrom } from './cost'
import { blockedWithRadius, makeLattice, type LatticeData } from './lattice'
import type { Lattice, SpaceMetric, Vec3 } from './types'

const MARGIN = 0.2

export function gridMetric(map: GridMap, radius: number): SpaceMetric {
  const { width, height, cells, clearance } = map

  const free = (point: Vec3, pad = radius): boolean => {
    const { x, y } = point
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x < MARGIN || y < MARGIN || x > width - MARGIN || y > height - MARGIN) return false
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    if (ix < 1 || iy < 1 || ix >= width - 1 || iy >= height - 1) return false
    const index = iy * width + ix
    if (cells[index] === 1) return false
    return pad <= 0 || clearance[index] >= pad - 1e-6
  }

  /**
   * Cell walk (Amanatides–Woo), the same traversal as `segmentClear` but with
   * the safety radius as a parameter instead of read from the cards. Keeping a
   * private copy avoids the alternative — stashing a fake `CardsState` in module
   * scope, which breaks the moment two maps are solved concurrently.
   */
  const walk = (a: Vec3, b: Vec3, pad: number): boolean => {
    if (!free(a, pad) || !free(b, pad)) return false
    let x = Math.floor(a.x)
    let y = Math.floor(a.y)
    const endX = Math.floor(b.x)
    const endY = Math.floor(b.y)
    if (x === endX && y === endY) return true

    const dx = b.x - a.x
    const dy = b.y - a.y
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
    const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx)
    const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy)
    let tMaxX =
      stepX === 0
        ? Number.POSITIVE_INFINITY
        : stepX > 0
          ? (x + 1 - a.x) / dx
          : (a.x - x) / -dx
    let tMaxY =
      stepY === 0
        ? Number.POSITIVE_INFINITY
        : stepY > 0
          ? (y + 1 - a.y) / dy
          : (a.y - y) / -dy

    const cellFree = (cx: number, cy: number) => free({ x: cx + 0.5, y: cy + 0.5, z: 0 }, pad)

    let guard = 0
    while ((x !== endX || y !== endY) && guard < width + height + 8) {
      guard += 1
      if (Math.abs(tMaxX - tMaxY) < 1e-9) {
        x += stepX
        y += stepY
        tMaxX += tDeltaX
        tMaxY += tDeltaY
        if (!cellFree(x, y) || !cellFree(x - stepX, y) || !cellFree(x, y - stepY)) return false
      } else if (tMaxX < tMaxY) {
        x += stepX
        tMaxX += tDeltaX
        if (!cellFree(x, y)) return false
      } else {
        y += stepY
        tMaxY += tDeltaY
        if (!cellFree(x, y)) return false
      }
    }
    return true
  }

  return {
    dim: 2,
    kind: 'grid2d',
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: width, y: height, z: 0 } },
    clearanceCap: 32,
    free,
    clearanceAt(point) {
      const x = Math.max(0, Math.min(width - 1, Math.floor(point.x)))
      const y = Math.max(0, Math.min(height - 1, Math.floor(point.y)))
      return clearance[y * width + x]
    },
    segmentFree(a, b, pad = radius) {
      return walk(a, b, pad)
    },
  }
}

/** Dense-sampled segment test, for adapters whose obstacle test is analytic. */
export function sampleSegmentFree(
  metric: SpaceMetric,
  a: Vec3,
  b: Vec3,
  pad: number,
  step: number,
): boolean {
  const span = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  const count = Math.max(2, Math.ceil(span / Math.max(1e-6, step)))
  const point: Vec3 = { x: 0, y: 0, z: 0 }
  for (let i = 0; i <= count; i += 1) {
    const t = i / count
    point.x = a.x + (b.x - a.x) * t
    point.y = a.y + (b.y - a.y) * t
    point.z = a.z + (b.z - a.z) * t
    if (!metric.free(point, pad)) return false
  }
  return true
}

/** Lattice over the raster: 8-connected (or 4), clearance straight from the map. */
export function gridLattice(map: GridMap, cards: CardsState, lengthScale: number): Lattice {
  const cost = costModelFrom(cards, { x: map.goal.x, y: map.goal.y, z: 0 }, lengthScale)
  const data: LatticeData = {
    dim: 2,
    kind: 'grid2d',
    width: map.width,
    height: map.height,
    depth: 1,
    spacing: 1,
    blocked: blockedWithRadius(map.cells, map.clearance, cost.radius),
    clearance: map.clearance,
    metric: gridMetric(map, cost.radius),
    cost,
  }
  return makeLattice(data)
}

export function gridSpace(map: GridMap, cards: CardsState): SpaceMetric {
  return gridMetric(map, cardValue(cards, 'collision'))
}
