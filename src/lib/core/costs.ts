/**
 * Shared cost / collision model.
 *
 * Every solver in `src/lib/solvers` talks to the map through this module, so
 * `w_c`, `w_t`, `r_safe` and the rest mean exactly the same thing no matter
 * which algorithm produced the path. Keeping one copy also means the numbers
 * in the metrics panel are comparable across algorithms.
 */
import type { CardId, CardsState, CostBreakdown, GridMap, Point } from '../types'

export const SQRT2 = Math.SQRT2
export const SAFE_CLEARANCE = 3.2
export const CLEARANCE_SCALE = 1.6

/** Direction order: E, SE, S, SW, W, NW, N, NE. `dir & 1` is diagonal. */
export const DX = [1, 1, 0, -1, -1, -1, 0, 1]
export const DY = [0, 1, 1, 1, 0, -1, -1, -1]
export const ALL_DIRS = [0, 1, 2, 3, 4, 5, 6, 7]
export const ORTHO_DIRS = [0, 2, 4, 6]

export function cardValue(cards: CardsState, id: CardId): number {
  const card = cards[id]
  return card.enabled ? card.value : 0
}

export function lengthScale(cards: CardsState): number {
  return cards.lengthWeight.enabled
    ? Math.max(0.05, cards.lengthWeight.value)
    : 1
}

export function safetyRadius(cards: CardsState): number {
  return cards.collision.enabled ? cards.collision.value : 0
}

export function isBlocked(
  map: GridMap,
  cards: CardsState,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true
  const index = y * map.width + x
  if (map.cells[index] === 1) return true
  const radius = cardValue(cards, 'collision')
  return radius > 0 && map.clearance[index] < radius
}

/** Octile distance, minus goal tolerance, scaled by `w_h` and `w_g`. */
export function heuristicOf(
  map: GridMap,
  cards: CardsState,
  x: number,
  y: number,
): number {
  const weight = cardValue(cards, 'heuristic')
  if (weight <= 0) return 0
  const dx = Math.abs(map.goal.x - x)
  const dy = Math.abs(map.goal.y - y)
  const distance = cards.diagonal.enabled
    ? Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy)
    : dx + dy
  const tolerance = cardValue(cards, 'goalTolerance')
  return weight * lengthScale(cards) * Math.max(0, distance - tolerance)
}

/** Cost of stepping into `(x, y)` with direction `dir` from `previousDir`. */
export function gridStepCost(
  map: GridMap,
  cards: CardsState,
  x: number,
  y: number,
  dir: number,
  previousDir: number,
): number {
  const diagonal = dir % 2 === 1
  const step = diagonal ? SQRT2 : 1
  let cost = step * lengthScale(cards)

  if (cards.diagonalBias.enabled && !diagonal) {
    cost += cards.diagonalBias.value
  }

  const clearanceWeight = cardValue(cards, 'clearance')
  if (clearanceWeight > 0) {
    const clearance = map.clearance[y * map.width + x]
    const deficit = Math.max(0, SAFE_CLEARANCE - clearance)
    cost += clearanceWeight * deficit * deficit * step * CLEARANCE_SCALE
  }

  const turnWeight = cardValue(cards, 'turn')
  if (turnWeight > 0 && previousDir !== 8) {
    const raw = Math.abs(dir - previousDir)
    const delta = Math.min(raw, 8 - raw)
    cost += turnWeight * (delta / 2)
  }

  return cost
}

/**
 * Direction-free step cost. Used by algorithms that search on cell states
 * (D* Lite, bidirectional) and therefore cannot express a turn penalty.
 */
export function plainStepCost(
  map: GridMap,
  cards: CardsState,
  x: number,
  y: number,
  diagonal: boolean,
): number {
  const step = diagonal ? SQRT2 : 1
  let cost = step * lengthScale(cards)
  if (cards.diagonalBias.enabled && !diagonal) cost += cards.diagonalBias.value
  const clearanceWeight = cardValue(cards, 'clearance')
  if (clearanceWeight > 0) {
    const clearance = map.clearance[y * map.width + x]
    const deficit = Math.max(0, SAFE_CLEARANCE - clearance)
    cost += clearanceWeight * deficit * deficit * step * CLEARANCE_SCALE
  }
  return cost
}

/** Uniform step cost: what JPS needs to keep its pruning rules valid. */
export function uniformStepCost(diagonal: boolean): number {
  return diagonal ? SQRT2 : 1
}

export function reconstructGridPath(
  parent: Int32Array,
  goalKey: number,
  width: number,
): Point[] {
  const path: Point[] = []
  let key = goalKey
  let guard = 0
  while (key >= 0 && guard < 100000) {
    const cell = Math.floor(key / 9)
    path.push({ x: cell % width, y: Math.floor(cell / width) })
    key = parent[key]
    guard += 1
  }
  path.reverse()
  return path
}

/** Cell-aligned line of sight, used by grid post-processing. */
export function gridLineClear(
  map: GridMap,
  cards: CardsState,
  a: Point,
  b: Point,
): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const distance = Math.hypot(dx, dy)
  const steps = Math.max(2, Math.ceil(distance * 7))
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const x = Math.round(a.x + dx * t)
    const y = Math.round(a.y + dy * t)
    if (isBlocked(map, cards, x, y)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Continuous space
// ---------------------------------------------------------------------------

export function pointFree(
  map: GridMap,
  cards: CardsState,
  x: number,
  y: number,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  if (x < 0.2 || y < 0.2 || x > map.width - 0.2 || y > map.height - 0.2) {
    return false
  }
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (ix < 1 || iy < 1 || ix >= map.width - 1 || iy >= map.height - 1) {
    return false
  }
  const index = iy * map.width + ix
  if (map.cells[index] === 1) return false
  const radius = safetyRadius(cards)
  return radius <= 0 || map.clearance[index] >= radius - 1e-6
}

export function cellFree(
  map: GridMap,
  cards: CardsState,
  x: number,
  y: number,
): boolean {
  if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) return false
  const index = y * map.width + x
  if (map.cells[index] === 1) return false
  const radius = safetyRadius(cards)
  return radius <= 0 || map.clearance[index] >= radius - 1e-6
}

/**
 * Segment collision by grid traversal (Amanatides–Woo). Sampling the segment
 * sparsely misses thin walls at low density, so this walks the cells instead.
 */
export function segmentClear(
  map: GridMap,
  cards: CardsState,
  a: Point,
  b: Point,
): boolean {
  if (!pointFree(map, cards, a.x, a.y) || !pointFree(map, cards, b.x, b.y)) {
    return false
  }
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

  let guard = 0
  while ((x !== endX || y !== endY) && guard < map.width + map.height + 8) {
    guard += 1
    if (Math.abs(tMaxX - tMaxY) < 1e-9) {
      x += stepX
      y += stepY
      tMaxX += tDeltaX
      tMaxY += tDeltaY
      if (!cellFree(map, cards, x, y)) return false
      if (!cellFree(map, cards, x - stepX, y)) return false
      if (!cellFree(map, cards, x, y - stepY)) return false
    } else if (tMaxX < tMaxY) {
      x += stepX
      tMaxX += tDeltaX
      if (!cellFree(map, cards, x, y)) return false
    } else {
      y += stepY
      tMaxY += tDeltaY
      if (!cellFree(map, cards, x, y)) return false
    }
  }
  return true
}

export function segmentCost(
  map: GridMap,
  cards: CardsState,
  a: Point,
  b: Point,
): number {
  const distance = Math.hypot(b.x - a.x, b.y - a.y)
  let cost = distance * lengthScale(cards)
  const clearanceWeight = cardValue(cards, 'clearance')
  if (clearanceWeight > 0 && distance > 0) {
    const samples = Math.max(2, Math.ceil(distance * 4))
    for (let i = 0; i < samples; i += 1) {
      const t = (i + 0.5) / samples
      const x = Math.floor(a.x + (b.x - a.x) * t)
      const y = Math.floor(a.y + (b.y - a.y) * t)
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue
      const clearance = map.clearance[y * map.width + x]
      const deficit = Math.max(0, SAFE_CLEARANCE - clearance)
      cost +=
        clearanceWeight * deficit * deficit * CLEARANCE_SCALE * (distance / samples)
    }
  }
  return cost
}

export interface PathEvaluation {
  length: number
  minClearance: number
  cost: CostBreakdown
}

function emptyEvaluation(): PathEvaluation {
  return {
    length: 0,
    minClearance: 0,
    cost: { length: 0, clearance: 0, turn: 0, bias: 0 },
  }
}

/** Evaluation for cell-centre paths: points are sampled at rounded cells. */
export function evaluateGridPath(
  map: GridMap,
  cards: CardsState,
  points: Point[],
): PathEvaluation {
  if (points.length === 0) return emptyEvaluation()

  const clearanceWeight = cardValue(cards, 'clearance')
  const turnWeight = cardValue(cards, 'turn')
  let length = 0
  let clearanceCost = 0
  let turnCost = 0
  let biasCost = 0
  let minClearance = Number.POSITIVE_INFINITY

  const inspect = (x: number, y: number) => {
    const cx = Math.max(0, Math.min(map.width - 1, Math.round(x)))
    const cy = Math.max(0, Math.min(map.height - 1, Math.round(y)))
    const value = map.clearance[cy * map.width + cx]
    if (value < minClearance) minClearance = value
  }

  for (const point of points) inspect(point.x, point.y)

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const segmentLength = Math.hypot(dx, dy)
    length += segmentLength
    if (
      cards.diagonalBias.enabled &&
      (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6)
    ) {
      biasCost += cards.diagonalBias.value
    }

    if (clearanceWeight > 0 && segmentLength > 0) {
      const samples = Math.max(2, Math.ceil(segmentLength * 6))
      for (let s = 0; s < samples; s += 1) {
        const t = (s + 0.5) / samples
        const x = a.x + dx * t
        const y = a.y + dy * t
        inspect(x, y)
        const cx = Math.max(0, Math.min(map.width - 1, Math.round(x)))
        const cy = Math.max(0, Math.min(map.height - 1, Math.round(y)))
        const clearance = map.clearance[cy * map.width + cx]
        const deficit = Math.max(0, SAFE_CLEARANCE - clearance)
        clearanceCost +=
          clearanceWeight *
          deficit *
          deficit *
          CLEARANCE_SCALE *
          (segmentLength / samples)
      }
    }
  }

  if (turnWeight > 0) {
    for (let i = 1; i < points.length - 1; i += 1) {
      const prev = points[i - 1]
      const current = points[i]
      const next = points[i + 1]
      const a1 = Math.atan2(current.y - prev.y, current.x - prev.x)
      const a2 = Math.atan2(next.y - current.y, next.x - current.x)
      let delta = Math.abs(a2 - a1)
      if (delta > Math.PI) delta = Math.PI * 2 - delta
      turnCost += turnWeight * (delta / (Math.PI / 2))
    }
  }

  return {
    length,
    minClearance: Number.isFinite(minClearance) ? minClearance : 0,
    cost: {
      length: length * lengthScale(cards),
      clearance: clearanceCost,
      turn: turnCost,
      bias: biasCost,
    },
  }
}

/** Evaluation for float paths: clearance is sampled along each segment. */
export function evaluateContinuousPath(
  map: GridMap,
  cards: CardsState,
  points: Point[],
): PathEvaluation {
  if (points.length === 0) return emptyEvaluation()
  const clearanceWeight = cardValue(cards, 'clearance')
  const turnWeight = cardValue(cards, 'turn')
  let length = 0
  let clearanceCost = 0
  let turnCost = 0
  let minClearance = Number.POSITIVE_INFINITY

  const inspect = (point: Point) => {
    const x = Math.max(0, Math.min(map.width - 1, Math.floor(point.x)))
    const y = Math.max(0, Math.min(map.height - 1, Math.floor(point.y)))
    const value = map.clearance[y * map.width + x]
    if (value < minClearance) minClearance = value
  }

  for (const point of points) inspect(point)
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    const segmentLength = Math.hypot(b.x - a.x, b.y - a.y)
    length += segmentLength
    if (clearanceWeight > 0 && segmentLength > 0) {
      const samples = Math.max(4, Math.ceil(segmentLength * 12))
      for (let s = 0; s < samples; s += 1) {
        const t = (s + 0.5) / samples
        const point = {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
        }
        inspect(point)
        const x = Math.floor(point.x)
        const y = Math.floor(point.y)
        const clearance = map.clearance[y * map.width + x]
        const deficit = Math.max(0, SAFE_CLEARANCE - clearance)
        clearanceCost +=
          clearanceWeight * deficit * deficit * CLEARANCE_SCALE * (segmentLength / samples)
      }
    }
  }
  if (turnWeight > 0) {
    for (let i = 1; i < points.length - 1; i += 1) {
      const prev = points[i - 1]
      const current = points[i]
      const next = points[i + 1]
      const a1 = Math.atan2(current.y - prev.y, current.x - prev.x)
      const a2 = Math.atan2(next.y - current.y, next.x - current.x)
      let delta = Math.abs(a2 - a1)
      if (delta > Math.PI) delta = Math.PI * 2 - delta
      turnCost += turnWeight * (delta / (Math.PI / 2))
    }
  }
  return {
    length,
    minClearance: Number.isFinite(minClearance) ? minClearance : 0,
    cost: {
      length: length * lengthScale(cards),
      clearance: clearanceCost,
      turn: turnCost,
      bias: 0,
    },
  }
}

export function totalOf(evaluation: PathEvaluation): number {
  return (
    evaluation.cost.length +
    evaluation.cost.clearance +
    evaluation.cost.turn +
    evaluation.cost.bias
  )
}
