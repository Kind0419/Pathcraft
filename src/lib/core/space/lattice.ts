/**
 * One lattice implementation for every space.
 *
 * A grid, a voxel block and a virtual raster over an SDF differ only in how
 * `blocked` / `clearance` were produced and how many dimensions they have. The
 * movement rules — which directions exist, what a move costs, when a diagonal
 * squeeze is illegal, how hard a turn is — are identical, so they live here
 * once. That is the whole reason to have a `Lattice` interface at all: a new
 * space is a new pair of typed arrays, not a new solver.
 */
import type { CostModel, Lattice, Neighbor, SpaceMetric, Vec3 } from './types'
import { dirsFor, octile, stepLength, turnTableFor } from './dirs'
import { stepCostOf } from './cost'

export interface LatticeData {
  dim: 2 | 3
  kind: Lattice['kind']
  width: number
  height: number
  /** 1 for 2D. */
  depth: number
  /** World units per node. 1 for a cell grid, metres for a voxel volume. */
  spacing: number
  blocked: Uint8Array
  /** Distance to the nearest obstacle, in lattice units. */
  clearance: Float32Array
  metric: SpaceMetric
  cost: CostModel
}

/**
 * Fold the safety radius into the obstacle set.
 *
 * `clearance` stays untouched — the clearance *cost* term must see the real
 * distance — but a node closer than `radius` becomes impassable, which is what
 * `isBlocked` does for the 2D solvers. Doing it once here means every lattice
 * consumer gets the same rule without remembering to check.
 */
export function blockedWithRadius(
  cells: Uint8Array,
  clearance: Float32Array,
  radius: number,
): Uint8Array {
  if (!(radius > 0)) return cells
  const out = new Uint8Array(cells.length)
  for (let i = 0; i < cells.length; i += 1) {
    out[i] = cells[i] === 1 || clearance[i] < radius ? 1 : 0
  }
  return out
}

export function makeLattice(data: LatticeData): Lattice {
  const { dim, width, height, depth, spacing, blocked, clearance, metric, cost } = data
  const allDirs = dirsFor(dim)
  const turn = turnTableFor(dim)
  const plane = width * height
  const length = plane * depth

  // `allowDiagonal` prunes whole tiers: in 2D that is the four diagonals, in 3D
  // the 18 moves that change more than one axis.
  const allowed: number[] = []
  for (let dir = 0; dir < allDirs.length; dir += 1) {
    const v = allDirs[dir]
    const tier = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z)
    if (tier > 1 && !cost.allowDiagonal) continue
    allowed.push(dir)
  }

  const indexOfCell = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) return -1
    return z * plane + y * width + x
  }

  const scratch: Vec3 = { x: 0, y: 0, z: 0 }

  const cellOf = (index: number, out: Vec3): Vec3 => {
    const z = depth > 1 ? Math.floor(index / plane) : 0
    const rest = index - z * plane
    out.z = z
    out.x = rest % width
    out.y = (rest - out.x) / width
    return out
  }

  const lattice: Lattice = {
    dim,
    kind: data.kind,
    width,
    height,
    depth,
    length,
    spacing,
    dirCount: allDirs.length,
    metric,
    cost,

    cellOf,
    indexOf: (cell) => indexOfCell(cell.x, cell.y, cell.z),
    pointOf: (index) => {
      cellOf(index, scratch)
      return { x: scratch.x * spacing, y: scratch.y * spacing, z: scratch.z * spacing }
    },
    nearest: (point) => {
      const x = Math.round(point.x / spacing)
      const y = Math.round(point.y / spacing)
      const z = depth > 1 ? Math.round(point.z / spacing) : 0
      const clampedX = Math.max(0, Math.min(width - 1, x))
      const clampedY = Math.max(0, Math.min(height - 1, y))
      const clampedZ = Math.max(0, Math.min(depth - 1, z))
      return clampedZ * plane + clampedY * width + clampedX
    },
    blocked: (index) => blocked[index] === 1,
    clearance: (index) => clearance[index],

    neighbors(index, previousDir, out) {
      cellOf(index, scratch)
      const cx = scratch.x
      const cy = scratch.y
      const cz = scratch.z
      let count = 0

      for (let i = 0; i < allowed.length; i += 1) {
        const dir = allowed[i]
        const v = allDirs[dir]
        const nx = cx + v.x
        const ny = cy + v.y
        const nz = cz + v.z
        const next = indexOfCell(nx, ny, nz)
        if (next < 0 || blocked[next] === 1) continue

        if (!cost.cornerCut) {
          // A move that changes two axes may not slip between two blocked
          // cells that only touch at an edge. In 2D this is the familiar
          // "no diagonal corner cutting"; in 3D it generalises to checking
          // every single-axis prefix of the move.
          let squeezed = false
          if (v.x !== 0) {
            const side = indexOfCell(nx, cy, cz)
            if (side < 0 || blocked[side] === 1) squeezed = true
          }
          if (!squeezed && v.y !== 0) {
            const side = indexOfCell(cx, ny, cz)
            if (side < 0 || blocked[side] === 1) squeezed = true
          }
          if (!squeezed && v.z !== 0) {
            const side = indexOfCell(cx, cy, nz)
            if (side < 0 || blocked[side] === 1) squeezed = true
          }
          if (squeezed) continue
        }

        if (previousDir >= 0 && (cost.noUTurn || cost.maxTurn > 0)) {
          const heading = turn[previousDir][dir]
          if (cost.noUTurn && heading > 1.5) continue
          if (cost.maxTurn > 0 && heading * 90 > cost.maxTurn + 1e-6) continue
        }

        out[count] = {
          index: next,
          dir,
          step: stepLength(v),
          cost: stepCostOf(cost, clearance[next], dir, previousDir, dim),
        }
        count += 1
      }
      return count
    },

    heuristic(index) {
      if (cost.heuristicWeight <= 0) return 0
      cellOf(index, scratch)
      const span = octile(
        cost.goal.x / spacing - scratch.x,
        cost.goal.y / spacing - scratch.y,
        cost.goal.z / spacing - scratch.z,
        cost.allowDiagonal,
      )
      const distance = Math.max(0, span - cost.goalTolerance)
      return cost.heuristicWeight * cost.lengthScale * distance
    },

    stepCost(index, dir, previousDir) {
      return stepCostOf(cost, clearance[index], dir, previousDir, dim)
    },
  }

  return lattice
}
