/**
 * Space adapters: the seam between "what the world looks like" and "how a
 * solver walks it".
 *
 * The 2D grid you see in the UI is one implementation of three ideas that are
 * otherwise independent:
 *
 *   1. **Metric**   — the geometry: where obstacles are, how far the nearest one
 *                     is, whether a straight segment is free. No sampling, no
 *                     resolution. A raster, a voxel volume and an analytic SDF
 *                     all answer the same three questions.
 *   2. **Lattice**  — a discretisation of that metric into integer nodes.
 *                     A 44×28 grid, a 44×28×12 voxel block and a *virtual*
 *                     lattice over an SDF are the same object to a search loop.
 *   3. **Cost**     — `lengthScale` / `w_c` / `w_t` … captured once as data so a
 *                     worker or a server can rebuild the exact same objective
 *                     without importing this module's UI state.
 *
 * Why the split matters:
 *
 *  - Graph search (A*, Dijkstra, JPS, D* Lite, IDA*, Beam, bidirectional) needs
 *    a **Lattice**. It never touches the metric directly.
 *  - Sampling (RRT*, PRM, visibility) needs the **Metric** only. It should not
 *    be forced through a grid, which is why continuous maps work at all.
 *  - A continuous smooth map (SDF / primitive soup) has no cells. To run a graph
 *    search on it you ask for a **virtual lattice** at some resolution; the
 *    resolution becomes a runtime knob instead of baked-in data. That is the
 *    answer to "how do we handle continuous maps" — you don't rasterise the
 *    world, you rasterise the question.
 *
 * Everything here is dimension-agnostic: `dim` is 2 or 3, coordinates are `Vec3`
 * with `z = 0` in 2D. The existing 2D solvers keep their own tight loops (they
 * are numerically frozen and fast); the adapters exist so that new solvers, the
 * worker and a future server share one contract, and so 3D can be added without
 * touching any of the 2D code.
 */
import type { SpaceKind } from '../../types'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export function vec3(x: number, y: number, z = 0): Vec3 {
  return { x, y, z }
}

export function copyVec3(p: Vec3): Vec3 {
  return { x: p.x, y: p.y, z: p.z }
}

export interface Bounds {
  min: Vec3
  max: Vec3
}

/** Value a "no previous step" sentinel takes; one past the last direction. */
export const NO_DIR = -1

/**
 * The objective, as data.
 *
 * `gridStepCost` reads the same numbers out of `CardsState`, so a lattice built
 * from this struct reproduces the 2D solvers' costs exactly (verified in
 * `scripts/space.ts`). Keeping it as a plain object is also what makes the
 * worker / HTTP payload self-describing: the server never has to know what a
 * "card" is.
 */
export interface CostModel {
  /** Multiplier on every step length (`w_l`). */
  lengthScale: number
  /** Weight of the clearance deficit term (`w_c`); 0 disables it. */
  clearanceWeight: number
  /** Distance at which the clearance term is satisfied; below it costs money. */
  clearanceSafe: number
  /** Vertical scale of the clearance term. */
  clearanceScale: number
  /** Weight of the turn term (`w_t`); 0 disables it. */
  turnWeight: number
  /** Flat surcharge on orthogonal steps (`w_b`), used to prefer diagonals. */
  diagonalBias: number
  /** Heuristic multiplier (`w_h`); 0 makes the search uniform-cost. */
  heuristicWeight: number
  /** Free distance to the goal before the heuristic starts charging (`w_g`). */
  goalTolerance: number
  /** Whether diagonal / face-diagonal moves exist at all. */
  allowDiagonal: boolean
  /** Safety radius; nodes closer than this to an obstacle are impassable. */
  radius: number
  /** Allow squeezing between two blocked cells that touch only at a corner. */
  cornerCut: boolean
  /** Forbid reversing the previous move. */
  noUTurn: boolean
  /** Max heading change per node, in degrees; 0 disables the limit. */
  maxTurn: number
  /** Goal in *world* coordinates. */
  goal: Vec3
}

export interface Neighbor {
  index: number
  dir: number
  step: number
  cost: number
}

/**
 * Geometry only. No resolution, no indices.
 *
 * `clearanceAt` returns distance in **world units**, with 0 on an obstacle
 * surface and `clearanceCap` used to clamp the far field (a nearest-obstacle
 * query is unbounded, but nothing downstream cares past the safe distance).
 */
export interface SpaceMetric {
  readonly dim: 2 | 3
  readonly kind: SpaceKind
  readonly bounds: Bounds
  readonly clearanceCap: number
  free(point: Vec3, pad?: number): boolean
  clearanceAt(point: Vec3): number
  segmentFree(a: Vec3, b: Vec3, pad?: number): boolean
}

/**
 * A discretisation of a metric. Node ids are dense integers so `Float64Array`
 * and `Int32Array` can be indexed directly — no Map lookups in the inner loop.
 *
 * Distances returned by `clearance` and `stepCost` are in **lattice units**
 * (one cell = one unit), matching the 2D solvers, so `clearanceSafe = 3.2`
 * means "3.2 cells away from a wall" on every kind of lattice.
 */
export interface Lattice {
  readonly dim: 2 | 3
  readonly kind: SpaceKind
  readonly width: number
  readonly height: number
  /** 1 for 2D lattices. */
  readonly depth: number
  readonly length: number
  readonly spacing: number
  readonly dirCount: number
  readonly metric: SpaceMetric
  readonly cost: CostModel
  /** Integer cell coordinates of a node. */
  cellOf(index: number, out: Vec3): Vec3
  /** Node id for an integer cell; -1 when out of bounds. */
  indexOf(cell: Vec3): number
  /** World-space centre of a node. */
  pointOf(index: number): Vec3
  /** Nearest node to a world point. */
  nearest(point: Vec3): number
  blocked(index: number): boolean
  clearance(index: number): number
  /** Fills `out` and returns how many successors were written. */
  neighbors(index: number, previousDir: number, out: Neighbor[]): number
  heuristic(index: number): number
  /** Cost of entering `index` moving along `dir` after `previousDir`. */
  stepCost(index: number, dir: number, previousDir: number): number
}

export const D2_TURN: number[][] = []
export const D3_TURN: number[][] = []
