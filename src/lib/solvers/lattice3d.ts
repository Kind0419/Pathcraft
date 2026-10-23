/**
 * Graph search on a 3D world.
 *
 * The 2D engine (`graph.ts`) is frozen: it is fast, its numbers are published,
 * and it bakes `width * y + x` into its inner loop. Rather than teach it a third
 * dimension, a 3D world is turned into a `Lattice` and handed to the one
 * dimension-agnostic loop in `generic.ts`. Everything that differs between a
 * voxel volume and an analytic SDF lives in `core/space`, so this file is only
 * translation: world → lattice → `PlanResult`.
 *
 * Two invariants worth stating, because they are what make the result honest:
 *
 *  - **No smoothing.** The path is the one the search actually walked. Every
 *    reported number (length, cost breakdown, clearance) is measured on that
 *    same polyline, so they cannot disagree with each other.
 *  - **Cost is decomposed, not approximated.** `stepCostOf` is evaluated four
 *    times per edge with one term masked out each time, so the breakdown adds up
 *    to `totalCost` exactly, including in 3D where the turn table has 26 entries.
 */
import type { CardId, CardsState, PlanResult, SearchEvent, SpaceKind } from '../types'
import { lengthScale } from '../core/costs'
import {
  dirsFor,
  fieldLattice,
  stepCostOf,
  voxelLattice,
  type CostModel,
  type Lattice,
  type Vec3,
} from '../core/space'
import { searchLattice, type SearchMode } from './generic'
import type { SolverSpec } from './registry'
import type { World } from '../worlds'

/** Strategy card index → search mode, for the six graph engines. */
export const GRAPH_MODES: SearchMode[] = ['astar', 'dijkstra', 'greedy', 'bfs', 'dfs', 'astar']

export interface Endpoints {
  start: Vec3
  goal: Vec3
}

export function buildLattice(world: World, cards: CardsState, goal: Vec3): Lattice {
  const scale = lengthScale(cards)
  if (world.kind === 'grid2d') {
    // A caller bug, not a user-facing case: 2D goes through `solveWith`.
    throw new Error('buildLattice expects a 3D or field world')
  }
  if (world.kind === 'voxel3d') {
    return voxelLattice(world.scene.volume, cards, scale, goal)
  }
  const resolution = world.scene.resolution
  const { min, max } = world.scene.space.bounds
  const width = Math.max(2, Math.ceil((max.x - min.x) / resolution))
  const height = Math.max(2, Math.ceil((max.y - min.y) / resolution))
  const depth =
    world.kind === 'field3d' ? Math.max(2, Math.ceil((max.z - min.z) / resolution)) : 1
  return fieldLattice(
    world.scene.space,
    { resolution, width, height, depth },
    cards,
    scale,
    goal,
  )
}

function directionIndex(lattice: Lattice): Map<number, number> {
  const map = new Map<number, number>()
  const dirs = dirsFor(lattice.dim)
  for (let dir = 0; dir < dirs.length; dir += 1) {
    const v = dirs[dir]
    map.set((v.x + 1) * 9 + (v.y + 1) * 3 + (v.z + 1), dir)
  }
  return map
}

function stepLengthOf(dx: number, dy: number, dz: number): number {
  return Math.hypot(dx, dy, dz)
}

interface Breakdown {
  length: number
  clearance: number
  turn: number
  bias: number
}

/**
 * Re-walk the chosen nodes and split every edge into its terms.
 *
 * Masking one weight at a time keeps this in sync with `stepCostOf` by
 * construction: if the cost model changes, the breakdown follows, and the sum
 * still equals the search's own `g`.
 */
function breakdownOf(
  lattice: Lattice,
  nodes: number[],
  dirOf: Map<number, number>,
): Breakdown {
  const cost = lattice.cost
  const out: Breakdown = { length: 0, clearance: 0, turn: 0, bias: 0 }
  const cellA: Vec3 = { x: 0, y: 0, z: 0 }
  const cellB: Vec3 = { x: 0, y: 0, z: 0 }
  const noTurn: CostModel = { ...cost, turnWeight: 0 }
  const noTurnNoBias: CostModel = { ...noTurn, diagonalBias: 0 }
  const bare: CostModel = { ...noTurnNoBias, clearanceWeight: 0 }

  let previousDir = -1
  for (let i = 1; i < nodes.length; i += 1) {
    lattice.cellOf(nodes[i - 1], cellA)
    lattice.cellOf(nodes[i], cellB)
    const dx = cellB.x - cellA.x
    const dy = cellB.y - cellA.y
    const dz = cellB.z - cellA.z
    const dir = dirOf.get((dx + 1) * 9 + (dy + 1) * 3 + (dz + 1))
    if (dir === undefined) continue
    const gap = lattice.clearance(nodes[i])
    const full = stepCostOf(cost, gap, dir, previousDir, lattice.dim)
    const turnless = stepCostOf(noTurn, gap, dir, previousDir, lattice.dim)
    const plain = stepCostOf(noTurnNoBias, gap, dir, previousDir, lattice.dim)
    const bareCost = stepCostOf(bare, gap, dir, previousDir, lattice.dim)
    out.length += bareCost
    out.bias += plain - bareCost
    out.clearance += turnless - plain
    out.turn += full - turnless
    previousDir = dir
  }
  return out
}

export interface LatticePlanInput {
  world: World
  spec: SolverSpec
  cards: CardsState
  order: CardId[]
  endpoints: Endpoints
  /** Strategy card index; only 0–5 (graph engines) are meaningful here. */
  strategy: number
}

export function planLatticeWorld(input: LatticePlanInput): PlanResult {
  const { world, spec, cards, endpoints, strategy } = input
  const startedAt = performance.now()
  const lattice = buildLattice(world, cards, endpoints.goal)
  const mode = GRAPH_MODES[Math.max(0, Math.min(GRAPH_MODES.length - 1, strategy))] ?? 'astar'
  const space: SpaceKind = world.kind

  const outcome = searchLattice(lattice, {
    mode,
    start: endpoints.start,
    goal: endpoints.goal,
    goalTolerance: lattice.cost.goalTolerance,
    trace: true,
  })

  const spacing = lattice.spacing
  const half = spacing * 0.5
  const pointOf = (index: number): Vec3 => {
    const cell = lattice.cellOf(index, { x: 0, y: 0, z: 0 })
    return {
      x: cell.x * spacing + half,
      y: cell.y * spacing + half,
      z: lattice.dim === 3 ? cell.z * spacing + half : 0,
    }
  }

  const events: SearchEvent[] = (outcome.trace ?? []).map((step) => {
    const point = pointOf(step.index)
    return {
      x: point.x,
      y: point.y,
      z: point.z,
      g: step.g,
      h: step.h,
      f: step.f,
      openSize: step.open,
    }
  })

  const path3 = outcome.nodes.map(pointOf)
  let pathLength = 0
  for (let i = 1; i < path3.length; i += 1) {
    const a = path3[i - 1]
    const b = path3[i]
    pathLength += stepLengthOf(b.x - a.x, b.y - a.y, b.z - a.z)
  }

  let minClearance = Number.POSITIVE_INFINITY
  for (const index of outcome.nodes) {
    minClearance = Math.min(minClearance, lattice.clearance(index))
  }
  if (!Number.isFinite(minClearance)) minClearance = 0

  const breakdown = outcome.found
    ? breakdownOf(lattice, outcome.nodes, directionIndex(lattice))
    : { length: 0, clearance: 0, turn: 0, bias: 0 }

  const neighbours = lattice.dim === 3 ? 26 : cards.diagonal.enabled ? 8 : 4
  const elapsed = performance.now() - startedAt

  return {
    status: outcome.found ? 'success' : 'infeasible',
    continuous: false,
    // The 2D canvas never renders these; `path3` is the real geometry.
    path: [],
    rawPath: [],
    path3,
    events,
    expanded: outcome.expanded,
    expandedCells: outcome.expanded,
    pathLength,
    minClearance: minClearance * spacing,
    totalCost: outcome.cost,
    cost: {
      length: breakdown.length,
      clearance: breakdown.clearance,
      turn: breakdown.turn,
      bias: breakdown.bias,
    },
    solveTime: elapsed,
    waypoints: path3.length,
    smoothed: false,
    algorithmLabel: spec.label,
    openAtEnd: outcome.openAtEnd,
    solver: spec.id,
    space,
    note:
      world.kind === 'voxel3d'
        ? `${lattice.width}×${lattice.height}×${lattice.depth} 体素 · ${neighbours} 邻域 · 路径为搜索实际走过，未做平滑`
        : `${lattice.width}×${lattice.height}${lattice.dim === 3 ? `×${lattice.depth}` : ''} 虚拟栅格 @ ${spacing.toFixed(2)} · 规划在解析距离场上`,
    trace: {
      kind: 'graph',
      loopLabel: 'WHILE OPEN ≠ ∅',
      init: [
        `LATTICE ← ${lattice.width}×${lattice.height}${lattice.dim === 3 ? `×${lattice.depth}` : ''}`,
        `MODE ← ${mode.toUpperCase()}`,
        'g[s] ← 0；OPEN ← { s }',
      ],
      loop: [
        'n ← argmin f( OPEN )',
        `FOR EACH m ∈ ${neighbours}(n)`,
        'IF g[m] > g[n] + w(n→m) THEN 更新并记录父节点',
        'IF m ∈ GOAL THEN 回溯父链',
      ],
      terminate: ['OPEN = ∅ 且未达目标 → 无解', '到达目标 → 回溯得到路径'],
    },
  }
}
