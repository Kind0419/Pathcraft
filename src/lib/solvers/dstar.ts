/**
 * D* Lite with cross-run reuse.
 *
 * The classic use case is a robot that keeps its goal and moves its start: the
 * first run costs a full backward pass, every later run only repairs the keys
 * affected by the move. That is why the first run looks expensive here and the
 * second one is almost free — it is the algorithm, not a cache trick.
 *
 * Scope note: this build reuses the distance field per (map content, goal,
 * cost settings). Moving the start is free; repainting a wall invalidates the
 * field and rebuilds it, because the app edits walls in whole-map steps.
 */
import { MinHeap } from '../heap'
import type { CardId, CardsState, GridMap, PlanResult, Point, SearchEvent } from '../types'
import {
  ALL_DIRS,
  DX,
  DY,
  ORTHO_DIRS,
  isBlocked,
  plainStepCost,
} from '../core/costs'
import { buildFailure, buildSuccess } from './shared'
import type { SolverSpec } from './registry'

interface DNode {
  cell: number
  k1: number
  k2: number
  seq: number
}

interface DStarCache {
  g: Float64Array
  rhs: Float64Array
  queued: Uint8Array
  km: number
  lastStart: number
  queue: MinHeap<DNode>
  sequence: number
  computed: boolean
}

const CACHE_LIMIT = 4
const cache = new Map<string, DStarCache>()

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx)
  const dy = Math.abs(ay - by)
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
}

function hashCells(cells: Uint8Array): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < cells.length; i += 1) {
    hash ^= cells[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function cacheKey(map: GridMap, cards: CardsState): string {
  return [
    map.id,
    map.width,
    map.height,
    hashCells(map.cells),
    map.goal.x,
    map.goal.y,
    cards.diagonal.enabled ? 1 : 0,
    cards.cornerCut.enabled ? 1 : 0,
    cards.collision.enabled ? cards.collision.value : 0,
    cards.clearance.enabled ? cards.clearance.value : 0,
    cards.lengthWeight.enabled ? cards.lengthWeight.value : 1,
    cards.diagonalBias.enabled ? cards.diagonalBias.value : 0,
  ].join('|')
}

export function resetDStar(): void {
  cache.clear()
}

export function planDStar(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  const width = map.width
  const size = width * map.height
  const goalCell = map.goal.y * width + map.goal.x
  const startCell = map.start.y * width + map.start.x
  const dirs = cards.diagonal.enabled ? ALL_DIRS : ORTHO_DIRS
  const reuse = !order.includes('incremental') || cards.incremental.enabled
  const key = cacheKey(map, cards)

  let state = reuse ? cache.get(key) : undefined
  const cold = !state || state.g.length !== size
  if (!state || cold) {
    state = {
      g: new Float64Array(size).fill(Number.POSITIVE_INFINITY),
      rhs: new Float64Array(size).fill(Number.POSITIVE_INFINITY),
      queued: new Uint8Array(size),
      km: 0,
      lastStart: startCell,
      queue: new MinHeap<DNode>((a, b) =>
        a.k1 !== b.k1 ? a.k1 - b.k1 : a.k2 !== b.k2 ? a.k2 - b.k2 : a.seq - b.seq,
      ),
      sequence: 0,
      computed: false,
    }
    state.rhs[goalCell] = 0
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, state)
  } else if (state.lastStart !== startCell) {
    state.km += octile(
      state.lastStart % width,
      Math.floor(state.lastStart / width),
      startCell % width,
      Math.floor(startCell / width),
    )
    state.lastStart = startCell
  }

  const g = state.g
  const rhs = state.rhs
  const queue = state.queue
  const events: SearchEvent[] = []
  let expanded = 0
  let rounds = 0
  const startX = startCell % width
  const startY = Math.floor(startCell / width)

  const neighbors = (cell: number): Array<{ cell: number; diagonal: boolean }> => {
    const x = cell % width
    const y = Math.floor(cell / width)
    const out: Array<{ cell: number; diagonal: boolean }> = []
    for (const dir of dirs) {
      const nx = x + DX[dir]
      const ny = y + DY[dir]
      if (isBlocked(map, cards, nx, ny)) continue
      if (dir % 2 === 1 && !cards.cornerCut.enabled) {
        if (isBlocked(map, cards, x + DX[dir], y)) continue
        if (isBlocked(map, cards, x, y + DY[dir])) continue
      }
      out.push({ cell: ny * width + nx, diagonal: dir % 2 === 1 })
    }
    return out
  }

  const keyOf = (cell: number): { k1: number; k2: number } => {
    const m = Math.min(g[cell], rhs[cell])
    return {
      k1: m + octile(cell % width, Math.floor(cell / width), startX, startY) + state!.km,
      k2: m,
    }
  }

  const push = (cell: number) => {
    const node = keyOf(cell)
    if (!Number.isFinite(node.k1)) return
    queue.push({ cell, k1: node.k1, k2: node.k2, seq: state!.sequence })
    state!.sequence += 1
    state!.queued[cell] = 1
  }

  const updateVertex = (cell: number) => {
    if (cell !== goalCell) {
      let best = Number.POSITIVE_INFINITY
      for (const edge of neighbors(cell)) {
        const step = plainStepCost(
          map,
          cards,
          edge.cell % width,
          Math.floor(edge.cell / width),
          edge.diagonal,
        )
        const candidate = step + g[edge.cell]
        if (candidate < best) best = candidate
      }
      rhs[cell] = best
    }
    if (Math.abs(g[cell] - rhs[cell]) > 1e-12) push(cell)
  }

  if (!state.computed) {
    updateVertex(goalCell)
    state.computed = true
  }

  const goalKey = { k1: octile(startX, startY, map.goal.x, map.goal.y) + state.km, k2: 0 }
  let guard = 0
  const guardLimit = Math.max(4000, size * 8)
  while (queue.size > 0 && guard < guardLimit) {
    guard += 1
    rounds += 1
    const top = queue.peek() as DNode
    const consistent = Math.abs(rhs[startCell] - g[startCell]) < 1e-9
    const beforeKey =
      top.k1 < goalKey.k1 ||
      (Math.abs(top.k1 - goalKey.k1) < 1e-12 && top.k2 < goalKey.k2)
    if (consistent && !beforeKey) break

    queue.pop()
    // Duplicate entries are expected without a decrease-key: the flag makes
    // every cell count once, and stale copies are dropped instead of being
    // re-pushed forever.
    if (state.queued[top.cell] === 0) continue
    state.queued[top.cell] = 0
    const current = keyOf(top.cell)
    const outdated =
      current.k1 > top.k1 + 1e-12 ||
      (Math.abs(current.k1 - top.k1) < 1e-12 && current.k2 > top.k2 + 1e-12)
    if (outdated) {
      push(top.cell)
      continue
    }

    if (events.length < 8000) {
      const x = top.cell % width
      const y = Math.floor(top.cell / width)
      const cost = Number.isFinite(g[top.cell]) ? g[top.cell] : rhs[top.cell]
      events.push({
        x,
        y,
        g: cost,
        h: octile(x, y, map.goal.x, map.goal.y),
        f: cost,
        openSize: queue.size,
      })
    }
    expanded += 1

    if (g[top.cell] > rhs[top.cell]) {
      g[top.cell] = rhs[top.cell]
      for (const edge of neighbors(top.cell)) updateVertex(edge.cell)
    } else {
      g[top.cell] = Number.POSITIVE_INFINITY
      updateVertex(top.cell)
      for (const edge of neighbors(top.cell)) updateVertex(edge.cell)
    }
  }

  const trace = {
    kind: 'incremental' as const,
    loopLabel: 'WHILE key(top) < key(S)',
    init: ['rhs(G) ← 0 · queue ← {G}', '从终点反算，km 记录起点位移'],
    loop: ['u ← pop_min(queue)', 'k_old > key(u) → 重新入队', 'g(u) 与 rhs(u) 不一致 → 修复邻居'],
    terminate: ['return descend(S → G)'],
  }

  const tolerance = cards.goalTolerance.enabled ? cards.goalTolerance.value : 0
  const withinGoal = Math.hypot(startX - map.goal.x, startY - map.goal.y) <= tolerance + 1e-9
  const reachable = withinGoal || Number.isFinite(rhs[startCell])

  // Only the start moved, so the distance field is still valid and the queue
  // can be dropped. A wall edit changes the cache key and rebuilds instead.
  if (reachable) {
    while (queue.size > 0) queue.pop()
    state.queued.fill(0)
  }

  const note = cold
    ? `首轮从终点反算整个可达空间（${expanded} 次扩展）；之后移动起点直接复用。`
    : reuse
      ? `复用上一轮距离场：起点变化没有触发重算（本轮 ${expanded} 次扩展）。`
      : `已关闭增量复用：本轮重新反算（${expanded} 次扩展）。`

  if (!reachable) {
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
      openAtEnd: queue.size,
      rounds,
      note: 'D* Lite 从终点反算，本轮未连到起点。',
    })
  }

  const rawPath: Point[] = [{ x: map.start.x, y: map.start.y }]
  if (!withinGoal) {
    let cursor = startCell
    let steps = 0
    while (cursor !== goalCell && steps < size) {
      steps += 1
      let best = Number.POSITIVE_INFINITY
      let nextCell = -1
      for (const edge of neighbors(cursor)) {
        const cost =
          plainStepCost(
            map,
            cards,
            edge.cell % width,
            Math.floor(edge.cell / width),
            edge.diagonal,
          ) + g[edge.cell]
        if (cost < best) {
          best = cost
          nextCell = edge.cell
        }
      }
      if (nextCell < 0) break
      cursor = nextCell
      rawPath.push({ x: cursor % width, y: Math.floor(cursor / width) })
    }
    if (cursor !== goalCell) {
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
        openAtEnd: queue.size,
        rounds,
        note,
      })
    }
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
    openAtEnd: queue.size,
    rounds,
    note,
  })
}
