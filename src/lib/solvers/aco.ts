/**
 * Ant colony optimisation on the grid graph.
 *
 * Each round, `m` ants walk from the start by sampling neighbours in proportion
 * to pheromone^α · (1/distance)^β. Short tours get more pheromone, so later
 * rounds are increasingly biased toward the good corridor. It is a stochastic
 * search: two runs with the same settings give the same answer only because the
 * RNG is seeded, not because the method is deterministic.
 */
import type { CardId, CardsState, GridMap, PlanField, PlanResult, Point } from '../types'
import {
  ALL_DIRS,
  DX,
  DY,
  ORTHO_DIRS,
  gridLineClear,
  isBlocked,
  plainStepCost,
} from '../core/costs'
import { lineOfSight, makeRng } from '../core/geometry'
import {
  buildFailure,
  buildSuccess,
  stepProgress,
  tunedValue,
  type ProgressFn,
} from './shared'
import type { SolverSpec } from './registry'

const ALPHA = 1
const BETA = 3.0
const RHO = 0.28
const Q = 24
const EPS = 1e-6

export function planAco(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
  onProgress?: ProgressFn,
): PlanResult {
  const startedAt = performance.now()
  const width = map.width
  const size = width * map.height
  const dirs = cards.diagonal.enabled ? ALL_DIRS : ORTHO_DIRS
  const ants = Math.max(4, Math.round(tunedValue(cards, order, 'swarmWidth', 26)))
  const rounds = Math.max(4, Math.round(tunedValue(cards, order, 'iterations', 34)))
  // Evaporation and the heuristic exponent. These two decide whether the
  // colony converges on one corridor or keeps exploring, so leaving them at
  // the module constants meant "ACO" was one fixed animal. Clamped rather than
  // free: rho = 1 wipes the trail every round, beta = 0 has no goal term at
  // all, and both read as "the algorithm is broken" rather than "tuned".
  const rho = Math.min(0.85, Math.max(0.02, tunedValue(cards, order, 'evaporate', RHO)))
  const beta = Math.min(9, Math.max(0, tunedValue(cards, order, 'beta', BETA)))
  const maxSteps = Math.round((map.width + map.height) * 1.9)
  const rng = makeRng(0x9e3779b9)
  const tau = new Float32Array(size).fill(0.6)
  const best = { path: [] as number[], cost: Number.POSITIVE_INFINITY }
  const events: PlanResult['events'] = []
  let expanded = 0

  const startCell = map.start.y * width + map.start.x
  const goalCell = map.goal.y * width + map.goal.x

  const freeNeighbors = (cell: number): Array<{ cell: number; step: number }> => {
    const x = cell % width
    const y = Math.floor(cell / width)
    const out: Array<{ cell: number; step: number }> = []
    for (const dir of dirs) {
      const nx = x + DX[dir]
      const ny = y + DY[dir]
      if (isBlocked(map, cards, nx, ny)) continue
      if (dir % 2 === 1 && !cards.cornerCut.enabled) {
        if (isBlocked(map, cards, x + DX[dir], y)) continue
        if (isBlocked(map, cards, x, y + DY[dir])) continue
      }
      out.push({
        cell: ny * width + nx,
        step: plainStepCost(map, cards, nx, ny, dir % 2 === 1),
      })
    }
    return out
  }

  // Neighbour table is reused across rounds and ants.
  const neighborCache = new Map<number, Array<{ cell: number; step: number }>>()
  const neighborsOf = (cell: number) => {
    let list = neighborCache.get(cell)
    if (!list) {
      list = freeNeighbors(cell)
      neighborCache.set(cell, list)
    }
    return list
  }

  for (let round = 0; round < rounds; round += 1) {
    const roundPaths: Array<{ path: number[]; cost: number }> = []

    for (let ant = 0; ant < ants; ant += 1) {
      const path: number[] = [startCell]
      let cell = startCell
      let previous = -1
      let cost = 0
      let reached = false

      for (let step = 0; step < maxSteps; step += 1) {
        if (cell === goalCell) {
          reached = true
          break
        }
        const all = neighborsOf(cell)
        const forward = all.filter((option) => option.cell !== previous)
        const choices = forward.length > 0 ? forward : all
        if (choices.length === 0) break

        // A small share of greedy ants keeps the colony from following a bad
        // pheromone trail into a dead end.
        let chosen = choices[0]
        if (rng() < 0.12) {
          let best = Number.POSITIVE_INFINITY
          for (const option of choices) {
            const cx = option.cell % width
            const cy = Math.floor(option.cell / width)
            const d = Math.hypot(cx - map.goal.x, cy - map.goal.y)
            if (d < best) {
              best = d
              chosen = option
            }
          }
        } else {
          let total = 0
          const weights: number[] = []
          for (const option of choices) {
            const cx = option.cell % width
            const cy = Math.floor(option.cell / width)
            const toGoal = Math.hypot(cx - map.goal.x, cy - map.goal.y)
            const attraction = 1 / (toGoal + 0.6)
            const weight =
              Math.pow(tau[option.cell] + EPS, ALPHA) * Math.pow(attraction, beta)
            weights.push(weight)
            total += weight
          }
          let pick = rng() * total
          for (let i = 0; i < choices.length; i += 1) {
            pick -= weights[i]
            if (pick <= 0) {
              chosen = choices[i]
              break
            }
          }
        }
        cost += chosen.step
        previous = cell
        cell = chosen.cell
        path.push(cell)
      }
      expanded += path.length
      if (reached) roundPaths.push({ path, cost })
    }

    for (const tour of roundPaths) {
      const deposit = Q / Math.max(1, tour.cost)
      for (const cell of tour.path) tau[cell] += deposit
    }
    for (let i = 0; i < size; i += 1) {
      tau[i] = Math.max(0.02, tau[i] * (1 - rho))
    }

    let roundBest: { path: number[]; cost: number } | null = null
    for (const tour of roundPaths) {
      if (!roundBest || tour.cost < roundBest.cost) roundBest = tour
    }
    if (roundBest && roundBest.cost < best.cost) {
      best.path = roundBest.path
      best.cost = roundBest.cost
    }

    stepProgress(onProgress, (round + 1) / rounds)
    const shown = best.path.length > 0 ? best.path : roundBest?.path ?? []
    if (shown.length > 0) {
      const stride = Math.max(1, Math.ceil(shown.length / 36))
      for (let i = 0; i < shown.length; i += stride) {
        const gx = shown[i] % width
        const gy = Math.floor(shown[i] / width)
        const toGoal = Math.hypot(gx - map.goal.x, gy - map.goal.y)
        events.push({
          x: gx,
          y: gy,
          g: i,
          h: toGoal,
          f: i + toGoal,
          openSize: ants,
        })
      }
    }
  }

  const trace = {
    kind: 'meta' as const,
    loopLabel: `FOR round < ${rounds}`,
    init: [
      `τ ← 0.6 · ants = ${ants}`,
      `β = ${beta.toFixed(2)} · ρ = ${rho.toFixed(2)}`,
    ],
    loop: [
      '每只蚂蚁按 τ^α·η^β 抽样前进',
      '到达终点 → 记录路径长度',
      `蒸发 τ ← ${(1 - rho).toFixed(2)}τ，再按 Q/L 沉积`,
    ],
    terminate: best.path.length > 0 ? ['return bestTour'] : ['return ∅'],
  }

  const note = `ACO 用信息素概率游走：${ants} 只蚂蚁 × ${rounds} 轮，β = ${beta.toFixed(2)}，ρ = ${rho.toFixed(2)}；结果不保证最优，转角约束不适用。`

  if (best.path.length === 0) {
    return buildFailure({
      map,
      cards,
      order,
      startedAt,
      solver: spec.id,
      label: spec.label,
      space: 'grid2d',
      continuous: false,
      trace,
      events,
      expanded,
      expandedCells: events.length,
      openAtEnd: ants,
      rounds,
      note,
    })
  }

  // Ant tours are cell chains; one shortcut pass turns them into a route the
  // eye can follow, and matches what the other grid planners output.
  const toured: Point[] = best.path.map((cell) => ({
    x: cell % width,
    y: Math.floor(cell / width),
  }))
  const rawPath = lineOfSight(toured, (a, b) => gridLineClear(map, cards, a, b))

  let max = 0
  for (let i = 0; i < size; i += 1) if (tau[i] > max) max = tau[i]
  const field: PlanField = {
    kind: 'pheromone',
    width: map.width,
    height: map.height,
    values: tau,
    max: max || 1,
  }

  return buildSuccess({
    map,
    cards,
    order,
    rawPath,
    startedAt,
    solver: spec.id,
    label: spec.label,
    space: 'grid2d',
    continuous: false,
    trace,
    events,
    expanded,
    expandedCells: events.length,
    openAtEnd: ants,
    rounds,
    note,
    field,
  })
}
