/**
 * Bidirectional A* on cell states.
 *
 * Two frontiers grow, one from each end, and stop when their bounds cross.
 * Cell states have no incoming direction, so the turn penalty cannot be applied
 * here — the strategy card says so instead of quietly dropping it.
 */
import { MinHeap } from '../heap'
import type { CardId, CardsState, GridMap, PlanResult, Point } from '../types'
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

interface Item {
  cell: number
  g: number
  h: number
  f: number
  seq: number
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx)
  const dy = Math.abs(ay - by)
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
}

export function planBidirectional(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  const width = map.width
  const size = width * map.height
  const dirs = cards.diagonal.enabled ? ALL_DIRS : ORTHO_DIRS
  const budget = cards.budget.enabled ? Math.round(cards.budget.value) : 200000

  const gF = new Float64Array(size).fill(Number.POSITIVE_INFINITY)
  const gB = new Float64Array(size).fill(Number.POSITIVE_INFINITY)
  const pF = new Int32Array(size).fill(-1)
  const pB = new Int32Array(size).fill(-1)
  const closedF = new Uint8Array(size)
  const closedB = new Uint8Array(size)

  const startCell = map.start.y * width + map.start.x
  const goalCell = map.goal.y * width + map.goal.x
  const startH = octile(map.start.x, map.start.y, map.goal.x, map.goal.y)

  let sequence = 0
  const heapF = new MinHeap<Item>((a, b) =>
    Math.abs(a.f - b.f) > 1e-9 ? a.f - b.f : a.seq - b.seq,
  )
  const heapB = new MinHeap<Item>((a, b) =>
    Math.abs(a.f - b.f) > 1e-9 ? a.f - b.f : a.seq - b.seq,
  )
  gF[startCell] = 0
  heapF.push({ cell: startCell, g: 0, h: startH, f: startH, seq: sequence })
  sequence += 1
  gB[goalCell] = 0
  heapB.push({ cell: goalCell, g: 0, h: startH, f: startH, seq: sequence })
  sequence += 1

  const events: PlanResult['events'] = []
  let expanded = 0
  let best = Number.POSITIVE_INFINITY
  let meeting = -1

  const relax = (
    heap: MinHeap<Item>,
    g: Float64Array,
    parent: Int32Array,
    closed: Uint8Array,
    from: number,
    to: number,
    step: number,
    h: number,
  ) => {
    if (closed[to] === 1) return
    const tentative = g[from] + step
    if (tentative + 1e-9 >= g[to]) return
    g[to] = tentative
    parent[to] = from
    heap.push({ cell: to, g: tentative, h, f: tentative + h, seq: sequence })
    sequence += 1
  }

  while ((heapF.size > 0 || heapB.size > 0) && expanded < budget) {
    const topF = heapF.size > 0 ? heapF.pop() as Item : null
    if (topF) {
      if (closedF[topF.cell] === 1) {
        // stale duplicate
      } else if (topF.g > gF[topF.cell] + 1e-9) {
        // dominated entry
      } else {
        closedF[topF.cell] = 1
        expanded += 1
        const x = topF.cell % width
        const y = Math.floor(topF.cell / width)
        events.push({ x, y, g: topF.g, h: topF.h, f: topF.f, openSize: heapF.size + heapB.size })
        if (gB[topF.cell] < Number.POSITIVE_INFINITY) {
          const total = topF.g + gB[topF.cell]
          if (total < best) {
            best = total
            meeting = topF.cell
          }
        }
        for (const dir of dirs) {
          const nx = x + DX[dir]
          const ny = y + DY[dir]
          if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue
          if (isBlocked(map, cards, nx, ny)) continue
          if (dir % 2 === 1 && !cards.cornerCut.enabled) {
            if (isBlocked(map, cards, x + DX[dir], y)) continue
            if (isBlocked(map, cards, x, y + DY[dir])) continue
          }
          relax(
            heapF,
            gF,
            pF,
            closedF,
            topF.cell,
            ny * width + nx,
            plainStepCost(map, cards, nx, ny, dir % 2 === 1),
            octile(nx, ny, map.goal.x, map.goal.y),
          )
        }
      }
    }

    const topB = heapB.size > 0 ? heapB.pop() as Item : null
    if (topB) {
      if (closedB[topB.cell] === 1) {
        // stale
      } else if (topB.g > gB[topB.cell] + 1e-9) {
        // dominated
      } else {
        closedB[topB.cell] = 1
        expanded += 1
        const x = topB.cell % width
        const y = Math.floor(topB.cell / width)
        events.push({ x, y, g: topB.g, h: topB.h, f: topB.f, openSize: heapF.size + heapB.size })
        if (gF[topB.cell] < Number.POSITIVE_INFINITY) {
          const total = topB.g + gF[topB.cell]
          if (total < best) {
            best = total
            meeting = topB.cell
          }
        }
        for (const dir of dirs) {
          const nx = x + DX[dir]
          const ny = y + DY[dir]
          if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue
          if (isBlocked(map, cards, nx, ny)) continue
          if (dir % 2 === 1 && !cards.cornerCut.enabled) {
            if (isBlocked(map, cards, x + DX[dir], y)) continue
            if (isBlocked(map, cards, x, y + DY[dir])) continue
          }
          relax(
            heapB,
            gB,
            pB,
            closedB,
            topB.cell,
            ny * width + nx,
            plainStepCost(map, cards, nx, ny, dir % 2 === 1),
            octile(nx, ny, map.start.x, map.start.y),
          )
        }
      }
    }

    const nextF = heapF.peek() ?? null
    const nextB = heapB.peek() ?? null
    const boundF = nextF ? nextF.f : Number.POSITIVE_INFINITY
    const boundB = nextB ? nextB.f : Number.POSITIVE_INFINITY
    if (meeting >= 0 && boundF + boundB >= best) break
    if (!nextF && !nextB) break
  }

  const trace = {
    kind: 'bidirectional' as const,
    loopLabel: 'WHILE open_f ∩ open_b = ∅',
    init: ['open_f ← {S} · open_b ← {G}', 'g_f(S)=0 · g_b(G)=0'],
    loop: ['n ← 从较小的frontier弹出', '交替扩张两端', '相遇节点 → 记录 g_f + g_b'],
    terminate: meeting >= 0 ? ['return join(path_f, path_b)'] : ['return ∅'],
  }

  const note = '双向搜索在格状态上扩张，不编码朝向：转角、最大转角、禁止掉头对它不生效。'

  if (meeting < 0 || !Number.isFinite(best)) {
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
      openAtEnd: heapF.size + heapB.size,
      note,
    })
  }

  const forward: Point[] = []
  let cursor = meeting
  let guard = 0
  while (cursor >= 0 && guard < size + 2) {
    forward.push({ x: cursor % width, y: Math.floor(cursor / width) })
    cursor = pF[cursor]
    guard += 1
  }
  forward.reverse()

  const backward: Point[] = []
  cursor = pB[meeting]
  guard = 0
  while (cursor >= 0 && guard < size + 2) {
    backward.push({ x: cursor % width, y: Math.floor(cursor / width) })
    cursor = pB[cursor]
    guard += 1
  }

  return buildSuccess({
    map,
    cards,
    order,
    rawPath: [...forward, ...backward],
    startedAt,
    solver: spec.id,
    label: spec.label,
    space: 'grid2d',
    continuous: false,
    trace,
    events,
    expanded,
    expandedCells: events.length,
    openAtEnd: heapF.size + heapB.size,
    note,
  })
}
