import { MinHeap } from './heap'
import type {
  CardId,
  CardsState,
  CostBreakdown,
  GridMap,
  PlanResult,
  Point,
  SearchEvent,
} from './types'

const SQRT2 = Math.SQRT2
const DX = [1, 1, 0, -1, -1, -1, 0, 1]
const DY = [0, 1, 1, 1, 0, -1, -1, -1]
const ALL_DIRS = [0, 1, 2, 3, 4, 5, 6, 7]
const ORTHO_DIRS = [0, 2, 4, 6]
export const SAFE_CLEARANCE = 3.2
const CLEARANCE_SCALE = 1.6

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

function strategyMode(cards: CardsState): number {
  return cards.strategy.enabled ? Math.round(cards.strategy.value) : 0
}

function cardValue(cards: CardsState, id: CardId): number {
  const card = cards[id]
  return card.enabled ? card.value : 0
}

function isBlocked(map: GridMap, x: number, y: number, cards: CardsState): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true
  const index = y * map.width + x
  if (map.cells[index] === 1) return true
  const radius = cardValue(cards, 'collision')
  return radius > 0 && map.clearance[index] < radius
}

function lengthScale(cards: CardsState): number {
  return cards.lengthWeight.enabled
    ? Math.max(0.05, cards.lengthWeight.value)
    : 1
}

function heuristic(map: GridMap, x: number, y: number, cards: CardsState): number {
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

function edgeCost(
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

function reconstructPath(parent: Int32Array, goalKey: number, width: number): Point[] {
  const path: Point[] = []
  let key = goalKey
  let guard = 0
  while (key >= 0 && guard < 10000) {
    const cell = Math.floor(key / 9)
    path.push({ x: cell % width, y: Math.floor(cell / width) })
    key = parent[key]
    guard += 1
  }
  path.reverse()
  return path
}

function lineClear(map: GridMap, cards: CardsState, a: Point, b: Point): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const distance = Math.hypot(dx, dy)
  const steps = Math.max(2, Math.ceil(distance * 7))
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const x = Math.round(a.x + dx * t)
    const y = Math.round(a.y + dy * t)
    if (isBlocked(map, x, y, cards)) return false
  }
  return true
}

function smoothPath(map: GridMap, cards: CardsState, raw: Point[]): Point[] {
  if (raw.length <= 2) return raw
  const result: Point[] = [raw[0]]
  let anchor = 0
  while (anchor < raw.length - 1) {
    let next = raw.length - 1
    while (next > anchor + 1 && !lineClear(map, cards, raw[anchor], raw[next])) {
      next -= 1
    }
    result.push(raw[next])
    anchor = next
  }
  return result
}

function chaikin(points: Point[], iterations: number): Point[] {
  let current = points
  for (let pass = 0; pass < iterations; pass += 1) {
    if (current.length < 3) break
    const next: Point[] = [current[0]]
    for (let i = 0; i < current.length - 1; i += 1) {
      const a = current[i]
      const b = current[i + 1]
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25,
      })
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75,
      })
    }
    next.push(current[current.length - 1])
    current = next
  }
  return current
}

function pathIsClear(map: GridMap, cards: CardsState, points: Point[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (!lineClear(map, cards, points[i - 1], points[i])) return false
  }
  return true
}

function simplifyPath(
  map: GridMap,
  cards: CardsState,
  points: Point[],
): Point[] {
  const result = [...points]
  let changed = true
  while (changed) {
    changed = false
    for (let i = 1; i < result.length - 1; i += 1) {
      if (lineClear(map, cards, result[i - 1], result[i + 1])) {
        result.splice(i, 1)
        changed = true
        i -= 1
      }
    }
  }
  return result
}

interface PathEvaluation {
  length: number
  minClearance: number
  cost: CostBreakdown
}

function evaluatePath(map: GridMap, cards: CardsState, points: Point[]): PathEvaluation {
  if (points.length === 0) {
    return {
      length: 0,
      minClearance: 0,
      cost: { length: 0, clearance: 0, turn: 0, bias: 0 },
    }
  }

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

function algorithmLabel(cards: CardsState): string {
  const mode = strategyMode(cards)
  const weight = cardValue(cards, 'heuristic')
  let label = 'A*'
  if (mode === 1) label = 'Dijkstra'
  else if (mode === 2) label = '贪心最佳优先'
  else if (mode === 3) label = 'BFS'
  else if (mode === 4) label = 'DFS'
  else if (mode === 5) label = '加权 A* 1.50×'
  else if (weight <= 0.001) label = 'Dijkstra'
  else if (weight > 1.05) label = `加权 A* ${weight.toFixed(2)}×`
  else if (weight < 0.95) label = 'A* · 弱启发'
  const bridges: string[] = []
  if (cards.smooth.enabled) bridges.push('拉直')
  if (cards.round.enabled) bridges.push('圆角')
  if (cards.simplify.enabled) bridges.push('抽稀')
  if (bridges.length > 0) label += ` + ${bridges.join(' + ')}`
  return label
}

export function plan(
  map: GridMap,
  cards: CardsState,
  order: CardId[] = ['smooth', 'round'],
): PlanResult {
  const startedAt = performance.now()
  const width = map.width
  const height = map.height
  const cellCount = width * height
  const stateCount = cellCount * 9
  const gScore = new Float64Array(stateCount)
  gScore.fill(Number.POSITIVE_INFINITY)
  const closed = new Uint8Array(stateCount)
  const parent = new Int32Array(stateCount)
  parent.fill(-1)
  const eventSeen = new Uint8Array(cellCount)

  const mode = strategyMode(cards)
  const hEnabled = mode === 0 || mode === 2 || mode === 5
  const startKey = (map.start.y * width + map.start.x) * 9 + 8
  const startH = hEnabled ? heuristic(map, map.start.x, map.start.y, cards) : 0
  let sequence = 0
  const startPriority =
    mode === 1
      ? 0
      : mode === 2
        ? startH
        : mode === 3
          ? 0
          : mode === 4
            ? 0
            : mode === 5
              ? startH * 1.5
              : startH
  const heap = new MinHeap<HeapItem>((a, b) => {
    if (Math.abs(a.priority - b.priority) > 1e-9) {
      return a.priority - b.priority
    }
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

  const events: SearchEvent[] = []
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
      if (isBlocked(map, nx, ny, cards)) continue
      if (dir % 2 === 1 && !cards.cornerCut.enabled) {
        if (isBlocked(map, current.x + DX[dir], current.y, cards)) continue
        if (isBlocked(map, current.x, current.y + DY[dir], cards)) continue
      }

      if (current.dir !== 8) {
        const rawDelta = Math.abs(dir - current.dir)
        const delta = Math.min(rawDelta, 8 - rawDelta)
        if (cards.noUTurn.enabled && delta === 4) continue
        if (cards.maxTurn.enabled && delta * 45 > cards.maxTurn.value + 1e-6) {
          continue
        }
      }

      const nextKey = (ny * width + nx) * 9 + dir
      if (closed[nextKey] === 1) continue

      const tentative =
        current.g + edgeCost(map, cards, nx, ny, dir, current.dir)
      if (tentative + 1e-9 >= gScore[nextKey]) continue

      gScore[nextKey] = tentative
      parent[nextKey] = current.key
      const h = hEnabled ? heuristic(map, nx, ny, cards) : 0
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

  const solveTime = performance.now() - startedAt

  if (goalKey < 0) {
    return {
      status: 'infeasible',
      path: [],
      rawPath: [],
      events,
      expanded,
      expandedCells,
      pathLength: 0,
      minClearance: 0,
      totalCost: 0,
      cost: { length: 0, clearance: 0, turn: 0, bias: 0 },
      solveTime,
      waypoints: 0,
      smoothed: false,
      algorithmLabel: algorithmLabel(cards),
      openAtEnd,
    }
  }

  const rawPath = reconstructPath(parent, goalKey, width)
  let path = rawPath
  for (const id of order) {
    if (!cards[id]?.enabled) continue
    if (id === 'smooth') path = smoothPath(map, cards, path)
    if (id === 'round') {
      const rounded = chaikin(path, 2)
      if (pathIsClear(map, cards, rounded)) path = rounded
    }
    if (id === 'simplify') {
      const simplified = simplifyPath(map, cards, path)
      if (pathIsClear(map, cards, simplified)) path = simplified
    }
  }
  const evaluation = evaluatePath(map, cards, path)

  return {
    status: 'success',
    path,
    rawPath,
    events,
    expanded,
    expandedCells,
    pathLength: evaluation.length,
    minClearance: evaluation.minClearance,
    totalCost:
      evaluation.cost.length +
      evaluation.cost.clearance +
      evaluation.cost.turn +
      evaluation.cost.bias,
    cost: evaluation.cost,
    solveTime,
    waypoints: path.length,
    smoothed: cards.smooth.enabled || cards.round.enabled,
    algorithmLabel: algorithmLabel(cards),
    openAtEnd,
  }
}