/**
 * Classic graph search: A*, Dijkstra, greedy, BFS, DFS and weighted A*.
 *
 * These six share one engine on purpose. The only difference between them is
 * the number that goes into the priority queue, which is exactly the lesson the
 * strategy card is trying to teach.
 */
import { MinHeap } from '../heap'
import type { CardId, CardsState, GridMap, PlanResult } from '../types'
import {
  ALL_DIRS,
  DX,
  DY,
  ORTHO_DIRS,
  cardValue,
  gridStepCost,
  heuristicOf,
  isBlocked,
  reconstructGridPath,
} from '../core/costs'
import { buildFailure, buildSuccess } from './shared'
import type { SolverSpec } from './registry'

interface HeapItem {
  key: number
  x: number
  y: number
  dir: number
  g: number
  h: number
  f: number
  priority: number
  seq: number
}

export function graphLabel(cards: CardsState, spec: SolverSpec): string {
  let label = spec.label
  if (spec.id === 'astar') {
    const weight = cardValue(cards, 'heuristic')
    if (weight <= 0.001) label = 'Dijkstra'
    else if (weight > 1.05) label = `加权 A* ${weight.toFixed(2)}×`
    else if (weight < 0.95) label = 'A* · 弱启发'
  }
  const bridges: string[] = []
  if (cards.smooth.enabled) bridges.push('拉直')
  if (cards.round.enabled) bridges.push('圆角')
  if (cards.simplify.enabled) bridges.push('抽稀')
  return bridges.length > 0 ? `${label} + ${bridges.join(' + ')}` : label
}

export function planGraph(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  const width = map.width
  const cellCount = width * map.height
  const stateCount = cellCount * 9
  const gScore = new Float64Array(stateCount)
  gScore.fill(Number.POSITIVE_INFINITY)
  const closed = new Uint8Array(stateCount)
  const parent = new Int32Array(stateCount)
  parent.fill(-1)
  const eventSeen = new Uint8Array(cellCount)

  const mode = spec.value
  const hEnabled = mode === 0 || mode === 2 || mode === 5
  const startKey = (map.start.y * width + map.start.x) * 9 + 8
  const startH = hEnabled ? heuristicOf(map, cards, map.start.x, map.start.y) : 0
  let sequence = 0
  const startPriority =
    mode === 1
      ? 0
      : mode === 2
        ? startH
        : mode === 3 || mode === 4
          ? 0
          : mode === 5
            ? startH * 1.5
            : startH
  const heap = new MinHeap<HeapItem>((a, b) => {
    if (Math.abs(a.priority - b.priority) > 1e-9) return a.priority - b.priority
    if (a.seq !== b.seq) return a.seq - b.seq
    return a.key - b.key
  })
  gScore[startKey] = 0
  heap.push({
    key: startKey,
    x: map.start.x,
    y: map.start.y,
    dir: 8,
    g: 0,
    h: startH,
    f: startPriority,
    priority: startPriority,
    seq: sequence,
  })
  sequence += 1

  const events: PlanResult['events'] = []
  let expanded = 0
  let expandedCells = 0
  let goalKey = -1
  let openAtEnd = 0
  const dirs = cards.diagonal.enabled ? ALL_DIRS : ORTHO_DIRS

  while (heap.size > 0) {
    const current = heap.pop() as HeapItem
    if (closed[current.key] === 1) continue
    if (current.g > gScore[current.key] + 1e-9) continue
    closed[current.key] = 1
    expanded += 1

    const cellIndex = current.y * width + current.x
    if (eventSeen[cellIndex] === 0) {
      eventSeen[cellIndex] = 1
      events.push({
        x: current.x,
        y: current.y,
        g: current.g,
        h: current.h,
        f: current.f,
        openSize: heap.size,
      })
      expandedCells += 1
    }

    const goalTolerance = cardValue(cards, 'goalTolerance')
    if (
      Math.hypot(current.x - map.goal.x, current.y - map.goal.y) <=
      goalTolerance + 1e-9
    ) {
      goalKey = current.key
      openAtEnd = heap.size
      break
    }

    if (cards.budget.enabled && expanded > cards.budget.value) {
      openAtEnd = heap.size
      break
    }

    for (const dir of dirs) {
      const nx = current.x + DX[dir]
      const ny = current.y + DY[dir]
      if (isBlocked(map, cards, nx, ny)) continue
      if (dir % 2 === 1 && !cards.cornerCut.enabled) {
        if (isBlocked(map, cards, current.x + DX[dir], current.y)) continue
        if (isBlocked(map, cards, current.x, current.y + DY[dir])) continue
      }

      if (current.dir !== 8) {
        const rawDelta = Math.abs(dir - current.dir)
        const delta = Math.min(rawDelta, 8 - rawDelta)
        if (cards.noUTurn.enabled && delta === 4) continue
        if (cards.maxTurn.enabled && delta * 45 > cards.maxTurn.value + 1e-6) continue
      }

      const nextKey = (ny * width + nx) * 9 + dir
      if (closed[nextKey] === 1) continue

      const tentative = current.g + gridStepCost(map, cards, nx, ny, dir, current.dir)
      if (tentative + 1e-9 >= gScore[nextKey]) continue

      gScore[nextKey] = tentative
      parent[nextKey] = current.key
      const h = hEnabled ? heuristicOf(map, cards, nx, ny) : 0
      let priority = tentative + h
      if (mode === 1) priority = tentative
      else if (mode === 2) priority = h
      else if (mode === 3) priority = sequence
      else if (mode === 4) priority = -sequence
      else if (mode === 5) priority = tentative + h * 1.5
      heap.push({
        key: nextKey,
        x: nx,
        y: ny,
        dir,
        g: tentative,
        h,
        f: priority,
        priority,
        seq: sequence,
      })
      sequence += 1
    }
  }

  const label = graphLabel(cards, spec)
  const trace = {
    kind: 'graph' as const,
    loopLabel: 'WHILE OPEN ≠ ∅',
    init: [
      'open ← {(S, dir=∅, g=0)}',
      'closed ← ∅ · parent ← ∅',
    ],
    loop: [
      'n ← pop_min(open)',
      'if closed[n]: continue',
      'if dist(n, G) ≤ ε: break',
      'for m in δ(n): relax(m)',
    ],
    terminate: goalKey >= 0 ? ['return reconstruct(parent, n_goal)'] : ['return ∅'],
  }

  if (goalKey < 0) {
    return buildFailure({
      map,
      cards,
      order,
      startedAt,
      solver: spec.id,
      label,
      space: 'grid2d',
      continuous: false,
      trace,
      events,
      expanded,
      expandedCells,
      openAtEnd,
    })
  }

  return buildSuccess({
    map,
    cards,
    order,
    rawPath: reconstructGridPath(parent, goalKey, width),
    startedAt,
    solver: spec.id,
    label,
    space: 'grid2d',
    continuous: false,
    trace,
    events,
    expanded,
    expandedCells,
    openAtEnd,
  })
}
