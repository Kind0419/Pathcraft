/**
 * Result assembly shared by all solvers.
 *
 * Every solver returns the same `PlanResult` shape so the canvas, metrics panel
 * and flow panel never need to know which algorithm produced it. Post-processing
 * order still follows the user's recipe, not the solver.
 */
import type {
  CardId,
  CardsState,
  GridMap,
  PlanField,
  PlanResult,
  Point,
  SearchEvent,
  SpaceKind,
  TraceSpec,
} from '../types'
import {
  evaluateContinuousPath,
  evaluateGridPath,
  gridLineClear,
  segmentClear,
  totalOf,
} from '../core/costs'
import {
  chaikin,
  lineOfSight,
  pathClear,
  roundCorners,
  simplifyPolyline,
} from '../core/geometry'

export type ProgressFn = (fraction: number) => void

let lastProgressAt = 0

/**
 * Throttled progress, used by the iterative metaheuristics. The worker forwards
 * these to the UI so the progress line moves instead of just spinning.
 */
export function stepProgress(onProgress: ProgressFn | undefined, fraction: number): void {
  if (!onProgress) return
  const now = performance.now()
  if (fraction < 1 && now - lastProgressAt < 60) return
  lastProgressAt = now
  onProgress(Math.max(0, Math.min(1, fraction)))
}

export interface SolveMeta {
  solver: string
  label: string
  space: SpaceKind
  continuous: boolean
  trace: TraceSpec
  events: SearchEvent[]
  expanded: number
  expandedCells?: number
  openAtEnd: number
  note?: string
  field?: PlanField
  rounds?: number
  /** Some algorithms need a different post chain (JPS / ACO already shortcut). */
  skipLineOfSight?: boolean
}

interface BuildOptions extends SolveMeta {
  map: GridMap
  cards: CardsState
  order: CardId[]
  rawPath: Point[]
  startedAt: number
}

function applyGridPost(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  raw: Point[],
): Point[] {
  const clear = (a: Point, b: Point) => gridLineClear(map, cards, a, b)
  let path = raw
  for (const id of order) {
    if (!cards[id]?.enabled) continue
    if (id === 'smooth') path = lineOfSight(path, clear)
    if (id === 'round') {
      const passes = Math.max(1, Math.min(4, Math.round(cards.round.value)))
      const rounded = chaikin(path, passes)
      if (pathClear(rounded, clear)) path = rounded
    }
    if (id === 'simplify') {
      const simplified = simplifyPolyline(path, Math.max(0, cards.simplify.value), clear)
      if (pathClear(simplified, clear)) path = simplified
    }
  }
  return path
}

function applyContinuousPost(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  raw: Point[],
  skipLineOfSight: boolean,
): Point[] {
  const clear = (a: Point, b: Point) => segmentClear(map, cards, a, b)
  // A tree or ant path is a chain of unit steps; without one sighting pass the
  // output looks like a staircase rather than a trajectory.
  let path = skipLineOfSight ? raw : lineOfSight(raw, clear)
  for (const id of order) {
    if (!cards[id]?.enabled) continue
    if (id === 'smooth') path = lineOfSight(path, clear)
    if (id === 'round') {
      const passes = Math.max(1, Math.min(4, Math.round(cards.round.value)))
      const rounded = chaikin(path, passes)
      if (pathClear(rounded, clear)) path = rounded
    }
    if (id === 'simplify') {
      const simplified = simplifyPolyline(path, Math.max(0, cards.simplify.value), clear)
      if (pathClear(simplified, clear)) path = simplified
    }
  }
  if (!cards.round.enabled) {
    for (const radius of [0.8, 0.55, 0.35]) {
      const rounded = roundCorners(path, radius, clear)
      if (rounded !== path) {
        path = rounded
        break
      }
    }
  }
  return path
}

function evaluate(
  map: GridMap,
  cards: CardsState,
  path: Point[],
  continuous: boolean,
) {
  return continuous
    ? evaluateContinuousPath(map, cards, path)
    : evaluateGridPath(map, cards, path)
}

export function buildSuccess(options: BuildOptions): PlanResult {
  const { map, cards, order, rawPath, continuous } = options
  const path = continuous
    ? applyContinuousPost(map, cards, order, rawPath, Boolean(options.skipLineOfSight))
    : applyGridPost(map, cards, order, rawPath)
  const evaluation = evaluate(map, cards, path, continuous)
  return {
    status: 'success',
    continuous,
    path,
    rawPath,
    events: options.events,
    expanded: options.expanded,
    expandedCells: options.expandedCells ?? options.events.length,
    pathLength: evaluation.length,
    minClearance: evaluation.minClearance,
    totalCost: totalOf(evaluation),
    cost: evaluation.cost,
    solveTime: performance.now() - options.startedAt,
    waypoints: path.length,
    smoothed: continuous || cards.smooth.enabled || cards.round.enabled,
    algorithmLabel: options.label,
    openAtEnd: options.openAtEnd,
    solver: options.solver,
    space: options.space,
    trace: options.trace,
    field: options.field,
    note: options.note,
    rounds: options.rounds,
  }
}

export function buildFailure(options: Omit<BuildOptions, 'rawPath'>): PlanResult {
  const { map, cards, continuous } = options
  const evaluation = evaluate(map, cards, [], continuous)
  return {
    status: 'infeasible',
    continuous,
    path: [],
    rawPath: [],
    events: options.events,
    expanded: options.expanded,
    expandedCells: options.expandedCells ?? options.events.length,
    pathLength: 0,
    minClearance: 0,
    totalCost: totalOf(evaluation),
    cost: evaluation.cost,
    solveTime: performance.now() - options.startedAt,
    waypoints: 0,
    smoothed: false,
    algorithmLabel: options.label,
    openAtEnd: options.openAtEnd,
    solver: options.solver,
    space: options.space,
    trace: options.trace,
    field: options.field,
    note: options.note,
    rounds: options.rounds,
  }
}

/** Walks a parent index array backwards and flips it into travel order. */
export function traceParents(
  parent: Int32Array,
  end: number,
  get: (index: number) => Point,
  limit = 100000,
): Point[] {
  const path: Point[] = []
  let cursor = end
  let guard = 0
  while (cursor >= 0 && guard < limit) {
    path.push(get(cursor))
    cursor = parent[cursor]
    guard += 1
  }
  path.reverse()
  return path
}

/**
 * Reads a knob that only some algorithms use.
 *
 * Cards that are not in the recipe are forced `enabled = false` upstream, so
 * `enabled` cannot be used to tell "absent" from "switched off". Presence in the
 * order is the real signal; absent means "use the algorithm default".
 */
export function tunedValue(
  cards: CardsState,
  order: CardId[],
  id: CardId,
  fallback: number,
): number {
  if (!order.includes(id)) return fallback
  const value = cards[id]?.value
  return Number.isFinite(value) ? value : fallback
}
