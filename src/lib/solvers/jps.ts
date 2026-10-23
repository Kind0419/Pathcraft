/**
 * Jump Point Search.
 *
 * JPS only works when every step costs the same, because it prunes neighbours
 * that are provably dominated under uniform cost. With a clearance penalty or a
 * turn penalty that proof breaks, so those cards are declared inapplicable
 * instead of producing a silently wrong "optimal" path.
 */
import { MinHeap } from '../heap'
import type { CardId, CardsState, GridMap, PlanResult, Point } from '../types'
import { cardValue, isBlocked } from '../core/costs'
import { buildFailure, buildSuccess } from './shared'
import type { SolverSpec } from './registry'

const STEPS: Array<[number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

interface Node {
  x: number
  y: number
  g: number
  h: number
  f: number
  parent: number
  index: number
  seq: number
}

export function planJps(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  const width = map.width
  const walk = (x: number, y: number) => !isBlocked(map, cards, x, y)
  const goal = map.goal
  const tolerance = cardValue(cards, 'goalTolerance')

  const octile = (x: number, y: number) => {
    const dx = Math.abs(goal.x - x)
    const dy = Math.abs(goal.y - y)
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
  }

  function forced(x: number, y: number, dx: number, dy: number): boolean {
    if (dx !== 0 && dy !== 0) {
      return (
        (!walk(x - dx, y) && walk(x - dx, y + dy)) ||
        (!walk(x, y - dy) && walk(x + dx, y - dy))
      )
    }
    if (dx !== 0) {
      return (
        (!walk(x, y + 1) && walk(x + dx, y + 1)) ||
        (!walk(x, y - 1) && walk(x + dx, y - 1))
      )
    }
    if (dy !== 0) {
      return (
        (!walk(x + 1, y) && walk(x + 1, y + dy)) ||
        (!walk(x - 1, y) && walk(x - 1, y + dy))
      )
    }
    return false
  }

  function jump(x: number, y: number, dx: number, dy: number): Point | null {
    let cx = x + dx
    let cy = y + dy
    let guard = 0
    while (guard < map.width + map.height + 4) {
      guard += 1
      if (!walk(cx, cy)) return null
      if (cx === goal.x && cy === goal.y) return { x: cx, y: cy }
      if (forced(cx, cy, dx, dy)) return { x: cx, y: cy }
      if (dx !== 0 && dy !== 0) {
        // A diagonal stretch only counts as a jump point if one of its axial
        // sub-stretches hits a jump point first.
        if (jump(cx, cy, dx, 0)) return { x: cx, y: cy }
        if (jump(cx, cy, 0, dy)) return { x: cx, y: cy }
      }
      cx += dx
      cy += dy
    }
    return null
  }

  function successors(x: number, y: number, dx: number, dy: number): Array<[number, number]> {
    if (dx === 0 && dy === 0) return STEPS
    if (dx !== 0 && dy !== 0) {
      const out: Array<[number, number]> = [
        [dx, 0],
        [0, dy],
        [dx, dy],
      ]
      if (!walk(x - dx, y)) out.push([-dx, dy])
      if (!walk(x, y - dy)) out.push([dx, -dy])
      return out
    }
    if (dx !== 0) {
      const out: Array<[number, number]> = [[dx, 0]]
      if (!walk(x, y + 1)) out.push([dx, 1])
      if (!walk(x, y - 1)) out.push([dx, -1])
      return out
    }
    const out: Array<[number, number]> = [[0, dy]]
    if (!walk(x + 1, y)) out.push([1, dy])
    if (!walk(x - 1, y)) out.push([-1, dy])
    return out
  }

  const nodes: Node[] = [
    {
      x: map.start.x,
      y: map.start.y,
      g: 0,
      h: octile(map.start.x, map.start.y),
      f: octile(map.start.x, map.start.y),
      parent: -1,
      index: 0,
      seq: 0,
    },
  ]
  const indexByCell = new Map<number, number>([[map.start.y * width + map.start.x, 0]])
  let sequence = 1
  const heap = new MinHeap<Node>((a, b) => {
    if (Math.abs(a.f - b.f) > 1e-9) return a.f - b.f
    if (Math.abs(a.h - b.h) > 1e-9) return a.h - b.h
    return a.seq - b.seq
  })
  heap.push(nodes[0])

  const events: PlanResult['events'] = []
  const budget = cards.budget.enabled ? Math.round(cards.budget.value) : 6000
  let expanded = 0
  let goalIndex = -1
  let openAtEnd = 0

  while (heap.size > 0) {
    const current = heap.pop() as Node
    expanded += 1
    events.push({
      x: current.x,
      y: current.y,
      g: current.g,
      h: current.h,
      f: current.f,
      openSize: heap.size,
    })
    if (Math.hypot(current.x - goal.x, current.y - goal.y) <= tolerance + 1e-9) {
      goalIndex = current.index
      openAtEnd = heap.size
      break
    }
    if (expanded > budget) {
      openAtEnd = heap.size
      break
    }

    // Direction of travel into this node, recovered from the parent.
    const parent = current.parent >= 0 ? nodes[current.parent] : null
    const inDx = parent ? Math.sign(current.x - parent.x) : 0
    const inDy = parent ? Math.sign(current.y - parent.y) : 0

    for (const [dx, dy] of successors(current.x, current.y, inDx, inDy)) {
      const point = jump(current.x, current.y, dx, dy)
      if (!point) continue
      const key = point.y * width + point.x
      const g =
        current.g + Math.hypot(point.x - current.x, point.y - current.y)
      const existing = indexByCell.get(key)
      if (existing !== undefined && nodes[existing].g <= g + 1e-9) continue
      const h = octile(point.x, point.y)
      const node: Node = {
        x: point.x,
        y: point.y,
        g,
        h,
        f: g + h,
        parent: current.index,
        index: existing !== undefined ? existing : nodes.length,
        seq: sequence,
      }
      sequence += 1
      if (existing !== undefined) {
        nodes[existing] = node
      } else {
        nodes.push(node)
      }
      indexByCell.set(key, node.index)
      heap.push(node)
    }
  }

  const trace = {
    kind: 'jps' as const,
    loopLabel: 'WHILE OPEN ≠ ∅',
    init: ['open ← {S}', 'jump point: 对称路径只保留转折处'],
    loop: ['n ← pop_min(open)', 'for d in pruned(n): jump(n, d)', 'forced(n, d) → 收下跳跃点'],
    terminate: goalIndex >= 0 ? ['return jumpPoints(S → G)'] : ['return ∅'],
  }

  const note = 'JPS 要求均匀步长代价：间隙、转角、长度权重不参与搜索；安全膨胀仍作为可通行判定，切角强制关闭。'

  if (goalIndex < 0) {
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
      openAtEnd,
      note,
    })
  }

  const rawPath: Point[] = []
  let cursor = goalIndex
  let guard = 0
  while (cursor >= 0 && guard < nodes.length + 2) {
    rawPath.push({ x: nodes[cursor].x, y: nodes[cursor].y })
    cursor = nodes[cursor].parent
    guard += 1
  }
  rawPath.reverse()

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
    openAtEnd,
    note,
  })
}
