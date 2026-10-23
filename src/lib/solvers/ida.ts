/**
 * IDA*: iterative deepening on a rising f threshold, keeping only the current
 * path in memory.
 *
 * Two concessions to the grid setting, both stated in the UI:
 *  1. successors are visited in heuristic order, so the depth-first dive heads
 *     toward the goal instead of sweeping east first;
 *  2. the first threshold comes from one greedy dive, not from h(S). On an
 *     8-connected grid with clearance costs, h(S) is far below the real cost and
 *     a pure ramp needs dozens of full re-expansions.
 * The answer is the first solution inside the threshold, so it can be slightly
 * suboptimal — that is the honest trade for near-constant memory.
 */
import type { CardId, CardsState, GridMap, PlanResult, Point } from '../types'
import {
  ALL_DIRS,
  DX,
  DY,
  ORTHO_DIRS,
  cardValue,
  gridStepCost,
  heuristicOf,
  isBlocked,
} from '../core/costs'
import { buildFailure, buildSuccess } from './shared'
import { planGraph } from './graph'
import type { SolverSpec } from './registry'

/** Direction index from a unit step, matching the E, SE, S, … order in costs.ts. */
const DIR_OF = new Map<string, number>([
  ['1,0', 0],
  ['1,1', 1],
  ['0,1', 2],
  ['-1,1', 3],
  ['-1,0', 4],
  ['-1,-1', 5],
  ['0,-1', 6],
  ['1,-1', 7],
])

interface Frame {
  key: number
  x: number
  y: number
  dir: number
  g: number
  f: number
  next: number
}

export function planIda(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  const width = map.width
  const dirs = cards.diagonal.enabled ? ALL_DIRS : ORTHO_DIRS
  const budget = cards.budget.enabled ? Math.round(cards.budget.value) : 200000
  const tolerance = cardValue(cards, 'goalTolerance')
  const events: PlanResult['events'] = []
  const eventCap = 4000
  const startKey = (map.start.y * width + map.start.x) * 9 + 8

  const clears = (x: number, y: number) => !isBlocked(map, cards, x, y)
  const stepOk = (x: number, y: number, dir: number, prevDir: number): boolean => {
    if (dir % 2 === 1 && !cards.cornerCut.enabled) {
      if (!clears(x - DX[dir], y)) return false
      if (!clears(x, y - DY[dir])) return false
    }
    if (prevDir !== 8) {
      const rawDelta = Math.abs(dir - prevDir)
      const delta = Math.min(rawDelta, 8 - rawDelta)
      if (cards.noUTurn.enabled && delta === 4) return false
      if (cards.maxTurn.enabled && delta * 45 > cards.maxTurn.value + 1e-6) return false
    }
    return true
  }

  // Expanding the direction that decreases h first is what makes the depth-first
  // dive usable; otherwise it sweeps east across the whole map before turning.
  const orderDirs = (x: number, y: number, g: number, prevDir: number): number[] => {
    const scored = dirs.map((dir) => {
      const nx = x + DX[dir]
      const ny = y + DY[dir]
      return {
        dir,
        f: g + gridStepCost(map, cards, nx, ny, dir, prevDir) + heuristicOf(map, cards, nx, ny),
      }
    })
    scored.sort((a, b) => a.f - b.f)
    return scored.map((item) => item.dir)
  }

  let expanded = 0
  const reached = (x: number, y: number) =>
    Math.hypot(x - map.goal.x, y - map.goal.y) <= tolerance + 1e-9

  /**
   * Upper bound for the first threshold: one greedy best-first run on the same
   * cost model. A depth-first dive is cheaper but wanders badly in a notch, and
   * a loose bound then lets IDA* return that wandering path.
   */
  function greedyBound(): number {
    const greedyCards: CardsState = {
      ...cards,
      strategy: { enabled: true, value: 2 },
      smooth: { ...cards.smooth, enabled: false },
      round: { ...cards.round, enabled: false },
      simplify: { ...cards.simplify, enabled: false },
    }
    const probe = planGraph(map, greedyCards, [], { ...spec, id: 'greedy', value: 2 })
    if (probe.status !== 'success') return Number.NaN
    const points = probe.rawPath
    let total = 0
    for (let i = 1; i < points.length; i += 1) {
      const dx = points[i].x - points[i - 1].x
      const dy = points[i].y - points[i - 1].y
      const dir = DIR_OF.get(`${Math.sign(dx)},${Math.sign(dy)}`)
      const prevDir =
        i > 1
          ? DIR_OF.get(
              `${Math.sign(points[i - 1].x - points[i - 2].x)},${Math.sign(points[i - 1].y - points[i - 2].y)}`,
            ) ?? 8
          : 8
      total += gridStepCost(map, greedyCards, points[i].x, points[i].y, dir ?? 8, prevDir)
    }
    return total
  }

  const bound = greedyBound()
  let threshold = Number.isFinite(bound) ? bound : heuristicOf(map, cards, map.start.x, map.start.y)
  let path: Point[] | null = null
  let rounds = 0
  let aborted = false

  const passBest = new Float64Array(map.width * map.height * 9)
  const stack: Frame[] = []

  while (rounds < 64 && !path && !aborted) {
    rounds += 1
    let nextThreshold = Number.POSITIVE_INFINITY
    stack.length = 0
    passBest.fill(Number.POSITIVE_INFINITY)
    stack.push({
      key: startKey,
      x: map.start.x,
      y: map.start.y,
      dir: 8,
      g: 0,
      f: threshold,
      next: 0,
    })
    passBest[startKey] = 0
    const localDirs = new Map<number, number[]>()

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (reached(frame.x, frame.y)) {
        path = stack.map((item) => ({ x: item.x, y: item.y }))
        break
      }
      if (frame.next >= dirs.length) {
        stack.pop()
        continue
      }
      if (frame.next === 0) {
        localDirs.set(frame.key, orderDirs(frame.x, frame.y, frame.g, frame.dir))
      }
      const list = localDirs.get(frame.key) as number[]
      if (frame.next >= list.length) {
        stack.pop()
        continue
      }
      const dir = list[frame.next]
      frame.next += 1
      const nx = frame.x + DX[dir]
      const ny = frame.y + DY[dir]
      if (!clears(nx, ny)) continue
      if (!stepOk(nx, ny, dir, frame.dir)) continue

      const g = frame.g + gridStepCost(map, cards, nx, ny, dir, frame.dir)
      const h = heuristicOf(map, cards, nx, ny)
      const f = g + h
      if (f > threshold + 1e-9) {
        if (f < nextThreshold) nextThreshold = f
        continue
      }
      const key = (ny * width + nx) * 9 + dir
      if (passBest[key] <= g + 1e-9) continue

      expanded += 1
      if (expanded > budget) {
        aborted = true
        break
      }
      if (events.length < eventCap) {
        events.push({ x: nx, y: ny, g, h, f, openSize: stack.length })
      }
      passBest[key] = g
      stack.push({ key, x: nx, y: ny, dir, g, f, next: 0 })
    }

    if (path || aborted) break
    if (!Number.isFinite(nextThreshold)) break
    threshold = nextThreshold
  }

  const trace = {
    kind: 'iterative' as const,
    loopLabel: 'WHILE f ≤ threshold',
    init: ['threshold ← 贪心上界', 'path ← {S} · 只保留当前路径'],
    loop: ['按 h 排序后继，深潜', 'f(n) > threshold → 记最小超限值', '本层耗尽 → 抬阈值重来'],
    terminate: path ? ['return path'] : ['return ∅'],
  }

  const note = 'IDA* 只保留当前路径，内存近似常数；阈值由一次贪心解给出，返回阈值内第一个解，可能略次优。'

  if (!path) {
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
      openAtEnd: stack.length,
      rounds,
      note: aborted ? '达到扩展预算，IDA* 提前退出。' : note,
    })
  }

  return buildSuccess({
    map,
    cards,
    order,
    rawPath: path,
    startedAt,
    solver: spec.id,
    label: spec.label,
    space: 'grid2d',
    continuous: false,
    trace,
    events,
    expanded,
    expandedCells: events.length,
    openAtEnd: stack.length,
    rounds,
    note,
  })
}
