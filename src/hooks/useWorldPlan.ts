/**
 * Picks the right engine for the world on screen.
 *
 * A grid world goes through the frozen 2D pipeline untouched — that is the whole
 * point of keeping `usePlan` exactly as it was. Every other world is solved
 * against a `Lattice`: a voxel volume, or a virtual raster over an analytic
 * distance field. RRT and RRT* take the same lattice but only use it as a
 * collision oracle, so their trees are continuous. One hook, three engines, and
 * no flags leaking into the solvers.
 *
 * Unsupported combinations return a result instead of throwing, because the UI
 * needs something to render: a share link from a 2D run can point at a 3D world
 * whose algorithm does not exist there, and "no answer, here is why" is a better
 * state than a blank canvas.
 */
import { useMemo } from 'react'
import { usePlan, type PlanState } from './usePlan'
import { planLatticeWorld } from '../lib/solvers/lattice3d'
import { planSampleWorld } from '../lib/solvers/sampling3d'
import { planEgoWorld } from '../lib/solvers/ego'
import { solverFor, supportsDim, type SolverSpec } from '../lib/solvers/registry'
import type { World } from '../lib/worlds'
import type { CardId, CardsState, GridMap, PlanResult } from '../lib/types'
import type { Vec3 } from '../lib/core/space'

export interface Endpoints3 {
  start: Vec3
  goal: Vec3
}

function unsupported(solver: SolverSpec, dim: 2 | 3): PlanResult {
  return {
    status: 'infeasible',
    continuous: false,
    path: [],
    rawPath: [],
    path3: [],
    events: [],
    expanded: 0,
    expandedCells: 0,
    pathLength: 0,
    minClearance: 0,
    totalCost: 0,
    cost: { length: 0, clearance: 0, turn: 0, bias: 0 },
    solveTime: 0,
    waypoints: 0,
    smoothed: false,
    algorithmLabel: solver.label,
    openAtEnd: 0,
    solver: solver.id,
    space: dim === 3 ? 'voxel3d' : 'field2d',
    reason: 'unsupported',
    note: `${solver.label} 只有 2D 实现，${dim === 3 ? '3D 场景' : '连续空间'}里请改用 A*、Dijkstra、贪心、BFS、DFS、加权 A* 或 RRT*`,
  }
}

/**
 * One plan, no hooks, no state: the same dispatch the hook performs, exposed for
 * callers that must not trigger a render — the 3D drag preview asks for a route
 * on every cell crossing, and routing that through React re-rendered the whole
 * workbench 20 times a second (p95 frame gap 116 ms, measured).
 *
 * Returns null for a world/algorithm pair that cannot be planned; the caller
 * decides whether that means "nothing to draw" or "show the reason".
 */
export function planSpatial(
  world: World,
  cards: CardsState,
  order: CardId[],
  endpoints: Endpoints3,
  strategy: number,
): PlanResult | null {
  if (world.kind === 'grid2d') return null
  const solver = solverFor(cards)
  const dim: 2 | 3 = world.kind === 'voxel3d' || world.kind === 'field3d' ? 3 : 2
  if (!supportsDim(solver, dim)) return null
  if (solver.id === 'rrt' || solver.id === 'rrtstar') {
    return planSampleWorld({ world, spec: solver, cards, order, endpoints, strategy })
  }
  // EGO is the third family: it does not search, so the strategy index (which
  // selects a graph mode) means nothing to it.
  if (solver.id === 'ego') {
    return planEgoWorld({ world, spec: solver, cards, order, endpoints, strategy })
  }
  if (strategy > 5) return null
  return planLatticeWorld({ world, spec: solver, cards, order, endpoints, strategy })
}

export function useWorldPlan(
  world: World,
  map2d: GridMap,
  cards: CardsState,
  order: CardId[],
  endpoints: Endpoints3,
  strategy: number,
): PlanState {
  // Always called: hooks cannot be conditional, and a grid world must keep using
  // the exact same code path it used before 3D existed.
  const base = usePlan(map2d, cards, order)
  const solver = base.solver
  const dim: 2 | 3 = world.kind === 'voxel3d' || world.kind === 'field3d' ? 3 : 2

  const spatial = useMemo<PlanResult | null>(() => {
    if (world.kind === 'grid2d') return null
    if (!supportsDim(solver, dim)) return unsupported(solver, dim)
    // Two families of spatial planner: the graph engines search a lattice, the
    // sampling ones grow a tree in continuous coordinates. Both answer to the
    // same `SpaceMetric`, which is why neither needs to know which world it is in.
    return planSpatial(world, cards, order, endpoints, strategy)
    // Endpoint identity changes every render; its components are the real keys.
  }, [
    world,
    solver,
    cards,
    order,
    strategy,
    dim,
    endpoints.start.x,
    endpoints.start.y,
    endpoints.start.z,
    endpoints.goal.x,
    endpoints.goal.y,
    endpoints.goal.z,
  ])

  if (!spatial) return base
  return { ...base, result: spatial, pending: false, progress: 0, transport: 'inline', error: null }
}
