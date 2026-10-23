/**
 * Cost model as data, plus the one function every lattice shares.
 *
 * `stepCostOf` is the single implementation of "what does this move cost".
 * For a 2D lattice built from a `GridMap` it is numerically identical to
 * `gridStepCost` — same terms, same order of operations, same turn table
 * (which is `delta / 2` re-derived from the angle). That equivalence is what
 * lets the 2D solvers stay frozen while new spaces reuse the objective.
 */
import type { CardsState } from '../../types'
import { cardValue, CLEARANCE_SCALE, SAFE_CLEARANCE } from '../costs'
import type { CostModel, Vec3 } from './types'
import { dirsFor, stepLength, turnTableFor } from './dirs'

export function costModelFrom(cards: CardsState, goal: Vec3, lengthScale: number): CostModel {
  return {
    lengthScale,
    clearanceWeight: cardValue(cards, 'clearance'),
    clearanceSafe: SAFE_CLEARANCE,
    clearanceScale: CLEARANCE_SCALE,
    turnWeight: cardValue(cards, 'turn'),
    diagonalBias: cardValue(cards, 'diagonalBias'),
    heuristicWeight: cardValue(cards, 'heuristic'),
    goalTolerance: cardValue(cards, 'goalTolerance'),
    allowDiagonal: cards.diagonal.enabled,
    radius: cardValue(cards, 'collision'),
    cornerCut: cards.cornerCut.enabled,
    noUTurn: cards.noUTurn.enabled,
    maxTurn: cardValue(cards, 'maxTurn'),
    goal,
  }
}

/**
 * Cost of entering a node with `clearance` (lattice units) along `dir`,
 * having arrived at the previous node along `previousDir` (`-1` at the start).
 */
export function stepCostOf(
  cost: CostModel,
  clearance: number,
  dir: number,
  previousDir: number,
  dim: 2 | 3,
): number {
  const vector = dirsFor(dim)[dir]
  const step = stepLength(vector)
  let total = step * cost.lengthScale

  const diagonal = Math.abs(vector.x) + Math.abs(vector.y) + Math.abs(vector.z) > 1
  if (cost.diagonalBias !== 0 && !diagonal) total += cost.diagonalBias

  if (cost.clearanceWeight > 0) {
    const deficit = Math.max(0, cost.clearanceSafe - clearance)
    total += cost.clearanceWeight * deficit * deficit * step * cost.clearanceScale
  }

  if (cost.turnWeight > 0 && previousDir >= 0) {
    total += cost.turnWeight * turnTableFor(dim)[previousDir][dir]
  }

  return total
}
