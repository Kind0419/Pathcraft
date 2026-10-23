import type { CardId, CardsState, GridMap, PlanResult } from '../types'
import { solverFor, type SolverId, type SolverSpec } from './registry'
import { planGraph } from './graph'
import { planJps } from './jps'
import { planIda } from './ida'
import { planBidirectional } from './bidirectional'
import { planBeam } from './beam'
import { planDStar } from './dstar'
import { planAco } from './aco'
import { planGa } from './ga'
import { planSampling } from './sampling'

import type { ProgressFn } from './shared'

export function solveWith(
  spec: SolverSpec,
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  onProgress?: ProgressFn,
): PlanResult {
  switch (spec.id as SolverId) {
    case 'astar':
    case 'dijkstra':
    case 'greedy':
    case 'bfs':
    case 'dfs':
    case 'weighted':
      return planGraph(map, cards, order, spec)
    case 'rrt':
    case 'rrtstar':
    case 'prm':
    case 'visibility':
      return planSampling(map, cards, order, spec)
    case 'jps':
      return planJps(map, cards, order, spec)
    case 'ida':
      return planIda(map, cards, order, spec)
    case 'bidirectional':
      return planBidirectional(map, cards, order, spec)
    case 'beam':
      return planBeam(map, cards, order, spec)
    case 'dstar':
      return planDStar(map, cards, order, spec)
    case 'aco':
      return planAco(map, cards, order, spec, onProgress)
    case 'ga':
      return planGa(map, cards, order, spec, onProgress)
    default:
      return planGraph(map, cards, order, spec)
  }
}

/**
 * Synchronous entry point kept for the feasibility scan, the CLI check and the
 * inline branch of the runtime. Heavy solvers go through `solveJob` instead.
 */
export function plan(
  map: GridMap,
  cards: CardsState,
  order: CardId[] = ['smooth', 'round'],
): PlanResult {
  return solveWith(solverFor(cards), map, cards, order)
}

export { solverFor }
export type { SolverSpec, SolverId }
export type { ProgressFn }
