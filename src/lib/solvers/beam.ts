/**
 * Beam search: a best-first search that keeps only the best `m` successors per
 * layer. Cheap, and honestly incomplete — the pruned branch may hold the only
 * feasible answer, which is worth seeing on purpose.
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
import type { SolverSpec } from './registry'

interface BeamNode {
  x: number
  y: number
  dir: number
  g: number
  h: number
  f: number
  parent: number
}

export function planBeam(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  const width = map.width
  const dirs = cards.diagonal.enabled ? ALL_DIRS : ORTHO_DIRS
  const beamWidth = cards.swarmWidth.enabled
    ? Math.max(2, Math.round(cards.swarmWidth.value))
    : 20
  const maxExpanded = cards.budget.enabled ? Math.round(cards.budget.value) : 4000
  const tolerance = cardValue(cards, 'goalTolerance')

  const nodes: BeamNode[] = [
    {
      x: map.start.x,
      y: map.start.y,
      dir: 8,
      g: 0,
      h: heuristicOf(map, cards, map.start.x, map.start.y),
      f: heuristicOf(map, cards, map.start.x, map.start.y),
      parent: -1,
    },
  ]
  let layer = [0]
  const bestG = new Map<number, number>([[nodes[0].y * width + nodes[0].x, 0]])
  const events: PlanResult['events'] = []
  let expanded = 0
  let goalIndex = -1
  let depth = 0

  while (layer.length > 0 && expanded < maxExpanded && goalIndex < 0) {
    depth += 1
    const children: number[] = []

    for (const index of layer) {
      const node = nodes[index]
      if (Math.hypot(node.x - map.goal.x, node.y - map.goal.y) <= tolerance + 1e-9) {
        goalIndex = index
        break
      }
      expanded += 1
      events.push({
        x: node.x,
        y: node.y,
        g: node.g,
        h: node.h,
        f: node.f,
        openSize: layer.length,
      })
      if (expanded >= maxExpanded) break

      for (const dir of dirs) {
        const nx = node.x + DX[dir]
        const ny = node.y + DY[dir]
        if (isBlocked(map, cards, nx, ny)) continue
        if (dir % 2 === 1 && !cards.cornerCut.enabled) {
          if (isBlocked(map, cards, node.x + DX[dir], node.y)) continue
          if (isBlocked(map, cards, node.x, node.y + DY[dir])) continue
        }
        if (node.dir !== 8) {
          const rawDelta = Math.abs(dir - node.dir)
          const delta = Math.min(rawDelta, 8 - rawDelta)
          if (cards.noUTurn.enabled && delta === 4) continue
          if (cards.maxTurn.enabled && delta * 45 > cards.maxTurn.value + 1e-6) continue
        }
        const g = node.g + gridStepCost(map, cards, nx, ny, dir, node.dir)
        const key = (ny * width + nx) * 9 + dir
        const seen = bestG.get(key)
        if (seen !== undefined && seen <= g + 1e-9) continue
        bestG.set(key, g)
        const h = heuristicOf(map, cards, nx, ny)
        nodes.push({ x: nx, y: ny, dir, g, h, f: g + h, parent: index })
        children.push(nodes.length - 1)
      }
    }

    if (goalIndex >= 0) break
    children.sort((a, b) => nodes[a].f - nodes[b].f || nodes[a].h - nodes[b].h)
    layer = children.slice(0, beamWidth)
  }

  const trace = {
    kind: 'beam' as const,
    loopLabel: 'WHILE layer ≠ ∅',
    init: [`layer ← {S} · m = ${beamWidth}`, '每层只保留 m 个候选'],
    loop: ['for n in layer: expand(n)', 'children ← 去重后按 f 排序', 'layer ← children[0..m]'],
    terminate: goalIndex >= 0 ? ['return reconstruct(best)'] : ['return ∅'],
  }

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
      openAtEnd: layer.length,
      rounds: depth,
      note: '束搜索会剪掉较差的整层候选，找不到路不代表地图无解。',
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
    openAtEnd: layer.length,
    rounds: depth,
  })
}
