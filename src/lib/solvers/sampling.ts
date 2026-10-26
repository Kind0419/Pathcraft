/**
 * Sampling-based planners: RRT, RRT*, PRM and the visibility graph.
 *
 * All four build a graph in float coordinates and never touch the cell grid for
 * expansion — collision is still checked against the grid so `r_safe` holds.
 */
import type { CardId, CardsState, GridMap, PlanResult, Point } from '../types'
import { pointFree, segmentClear, segmentCost } from '../core/costs'
import { lengthScale } from '../core/costs'
import { distance, makeRng } from '../core/geometry'
import { buildFailure, buildSuccess, tunedValue } from './shared'
import type { SolverSpec } from './registry'

interface TreeNode {
  x: number
  y: number
  parent: number
  cost: number
}

function sampleBudget(cards: CardsState, fallback: number, cap = 2400): number {
  if (!cards.budget.enabled) return fallback
  return Math.max(120, Math.min(cap, Math.round(cards.budget.value)))
}

function rrt(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
  optimize: boolean,
): PlanResult {
  const startedAt = performance.now()
  const start = { x: map.start.x + 0.5, y: map.start.y + 0.5 }
  const goal = { x: map.goal.x + 0.5, y: map.goal.y + 0.5 }
  // Growth distance and goal bias were constants here. They are the two knobs
  // that decide *what kind of tree* this is — a sprawling uniform one or a
  // tunnel toward the goal — so they belong to the recipe, not to the source.
  const step = Math.max(0.2, tunedValue(cards, order, 'sampleStep', 1.7))
  const goalBias = Math.min(0.95, Math.max(0, tunedValue(cards, order, 'goalBias', 0.12)))
  // Rewiring exists only in the * variant; in plain RRT this is never read
  // because `optionalCards` and `cardApplies` keep the card off the recipe.
  const rewireRadius = step * Math.max(0.01, tunedValue(cards, order, 'rewireRadius', 2.6))
  const maxSamples = sampleBudget(cards, optimize ? 1900 : 1400)
  const nodes: TreeNode[] = [{ ...start, parent: -1, cost: 0 }]
  const events: PlanResult['events'] = [
    {
      x: start.x,
      y: start.y,
      g: 0,
      h: distance(start, goal),
      f: distance(start, goal),
      openSize: 1,
    },
  ]
  const rng = makeRng(0x51ed270b)
  let goalIndex = -1

  for (let iteration = 0; iteration < maxSamples && goalIndex < 0; iteration += 1) {
    let sample: Point | null = null
    for (let attempts = 0; attempts < 30; attempts += 1) {
      if (rng() < goalBias) {
        sample = goal
      } else {
        const point = { x: 1 + rng() * (map.width - 2), y: 1 + rng() * (map.height - 2) }
        if (pointFree(map, cards, point.x, point.y)) {
          sample = point
          break
        }
      }
      if (sample) break
    }
    if (!sample) continue

    let nearest = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < nodes.length; i += 1) {
      const d = distance(nodes[i], sample)
      if (d < nearestDistance) {
        nearestDistance = d
        nearest = i
      }
    }
    const from = nodes[nearest]
    const direction = distance(from, sample)
    if (direction < 1e-6) continue
    const ratio = Math.min(step, direction) / direction
    const next = {
      x: from.x + (sample.x - from.x) * ratio,
      y: from.y + (sample.y - from.y) * ratio,
    }
    if (!pointFree(map, cards, next.x, next.y)) continue
    if (!segmentClear(map, cards, from, next)) continue

    let parent = nearest
    let bestCost = from.cost + segmentCost(map, cards, from, next)
    if (optimize) {
      for (let i = 0; i < nodes.length; i += 1) {
        if (i === nearest) continue
        const candidate = nodes[i]
        if (distance(candidate, next) > rewireRadius) continue
        const cost = candidate.cost + segmentCost(map, cards, candidate, next)
        if (cost < bestCost && segmentClear(map, cards, candidate, next)) {
          parent = i
          bestCost = cost
        }
      }
    }

    const newIndex = nodes.length
    nodes.push({ x: next.x, y: next.y, parent, cost: bestCost })
    events.push({
      x: next.x,
      y: next.y,
      g: bestCost,
      h: distance(next, goal),
      f: bestCost + distance(next, goal),
      openSize: nodes.length,
    })

    if (optimize) {
      for (let i = 0; i < nodes.length - 1; i += 1) {
        const node = nodes[i]
        if (node.parent < 0) continue
        if (distance(node, next) > rewireRadius) continue
        const candidateCost = bestCost + segmentCost(map, cards, next, node)
        if (candidateCost + 1e-9 < node.cost && segmentClear(map, cards, next, node)) {
          node.parent = newIndex
          node.cost = candidateCost
        }
      }
    }

    if (distance(next, goal) <= step * 1.25 && segmentClear(map, cards, next, goal)) {
      goalIndex = nodes.length
      nodes.push({
        x: goal.x,
        y: goal.y,
        parent: newIndex,
        cost: bestCost + segmentCost(map, cards, next, goal),
      })
      events.push({
        x: goal.x,
        y: goal.y,
        g: nodes[goalIndex].cost,
        h: 0,
        f: nodes[goalIndex].cost,
        openSize: nodes.length,
      })
    }
  }

  const label = optimize ? 'RRT*' : 'RRT'
  const trace = {
    kind: 'sampling' as const,
    loopLabel: 'WHILE samples < N',
    // The numbers are printed from the values actually in use, so the panel
    // cannot claim a step size the search is not walking.
    init: [`tree ← {S} · Δq = ${step.toFixed(2)}`, `p_goal = ${goalBias.toFixed(2)}`],
    loop: optimize
      ? [
          'q_near ← nearest(tree, q_rand)',
          'q_new ← steer(q_near, q_rand)',
          'collision(q_new)? 丢弃',
          `rewire(r = ${rewireRadius.toFixed(2)})`,
        ]
      : ['q_near ← nearest(tree, q_rand)', 'q_new ← steer(q_near, q_rand)', 'collision(q_new)? 丢弃'],
    terminate: goalIndex >= 0 ? ['return reconstruct(tree, G)'] : ['return ∅'],
  }

  if (goalIndex < 0) {
    return buildFailure({
      map,
      cards,
      order,
      startedAt,
      solver: spec.id,
      label,
      space: 'sampling2d',
      continuous: true,
      trace,
      events,
      expanded: nodes.length,
      openAtEnd: nodes.length,
    })
  }

  const path: Point[] = []
  let cursor = goalIndex
  let guard = 0
  while (cursor >= 0 && guard < nodes.length + 4) {
    path.push({ x: nodes[cursor].x, y: nodes[cursor].y })
    cursor = nodes[cursor].parent
    guard += 1
  }
  path.reverse()

  return buildSuccess({
    map,
    cards,
    order,
    rawPath: path,
    startedAt,
    solver: spec.id,
    label,
    space: 'sampling2d',
    continuous: true,
    trace,
    events,
    expanded: nodes.length,
    openAtEnd: nodes.length,
  })
}

function prm(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  const start = { x: map.start.x + 0.5, y: map.start.y + 0.5 }
  const goal = { x: map.goal.x + 0.5, y: map.goal.y + 0.5 }
  const count = sampleBudget(cards, 420, 620)
  const rng = makeRng(0x2f6e2b1)
  const nodes: Point[] = [start, goal]
  const events: PlanResult['events'] = [
    { x: start.x, y: start.y, g: 0, h: distance(start, goal), f: distance(start, goal), openSize: 1 },
  ]
  for (let i = 0; i < count; i += 1) {
    for (let attempts = 0; attempts < 20; attempts += 1) {
      const point = { x: 1 + rng() * (map.width - 2), y: 1 + rng() * (map.height - 2) }
      if (pointFree(map, cards, point.x, point.y)) {
        nodes.push(point)
        events.push({
          x: point.x,
          y: point.y,
          g: 0,
          h: distance(point, goal),
          f: distance(point, goal),
          openSize: nodes.length,
        })
        break
      }
    }
  }

  const adjacency: Array<Array<{ to: number; cost: number }>> = nodes.map(() => [])
  // Longest edge the roadmap may contain. Unlimited unless the card is in the
  // recipe, so "PRM as it was" is still reachable.
  const maxEdge = tunedValue(cards, order, 'connectRadius', Number.POSITIVE_INFINITY)
  const radiusGraph = Number.isFinite(maxEdge)
  let edges = 0
  for (let i = 0; i < nodes.length; i += 1) {
    const nearest: Array<{ index: number; distance: number }> = []
    for (let j = 0; j < nodes.length; j += 1) {
      if (i === j) continue
      const gap = distance(nodes[i], nodes[j])
      if (gap > maxEdge) continue
      nearest.push({ index: j, distance: gap })
    }
    nearest.sort((a, b) => a.distance - b.distance)
    // A radius graph connects to *everything* inside the radius; the nine-nearest
    // cap only exists to bound the default (unbounded-radius) case. Keeping the
    // cap while the card is in play would make the slider saturate at whatever
    // radius first admits nine neighbours — a slider that stops moving halfway.
    const limit = radiusGraph ? nearest.length : Math.min(9, nearest.length)
    for (let k = 0; k < limit; k += 1) {
      const j = nearest[k].index
      if (!segmentClear(map, cards, nodes[i], nodes[j])) continue
      const cost = segmentCost(map, cards, nodes[i], nodes[j])
      adjacency[i].push({ to: j, cost })
      adjacency[j].push({ to: i, cost })
      edges += 1
    }
  }

  const dist = new Float64Array(nodes.length).fill(Number.POSITIVE_INFINITY)
  const previous = new Int32Array(nodes.length).fill(-1)
  const visited = new Uint8Array(nodes.length)
  dist[0] = 0
  for (let iteration = 0; iteration < nodes.length; iteration += 1) {
    let current = -1
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < nodes.length; i += 1) {
      if (visited[i] === 0 && dist[i] < best) {
        best = dist[i]
        current = i
      }
    }
    if (current < 0) break
    if (current === 1) break
    visited[current] = 1
    for (const edge of adjacency[current]) {
      const next = dist[current] + edge.cost
      if (next < dist[edge.to]) {
        dist[edge.to] = next
        previous[edge.to] = current
      }
    }
  }

  const trace = {
    kind: 'sampling' as const,
    loopLabel: 'BUILD → QUERY',
    init: [
      'V ← {S, G} ∪ sampleFreeSpace(n)',
      Number.isFinite(maxEdge)
        ? `E ← 可见边 · ‖e‖ ≤ ${maxEdge.toFixed(1)}`
        : 'E ← k-nearest 可见边',
    ],
    loop: ['Dijkstra(V, E)', '按代价松弛'],
    terminate: ['return path(S → G)'],
  }

  if (!Number.isFinite(dist[1])) {
    return buildFailure({
      map,
      cards,
      order,
      startedAt,
      solver: spec.id,
      label: 'PRM',
      space: 'sampling2d',
      continuous: true,
      trace,
      events,
      expanded: nodes.length,
      openAtEnd: edges,
    })
  }

  const path: Point[] = []
  let cursor = 1
  let guard = 0
  while (cursor >= 0 && guard < nodes.length + 2) {
    path.push(nodes[cursor])
    cursor = previous[cursor]
    guard += 1
  }
  path.reverse()

  return buildSuccess({
    map,
    cards,
    order,
    rawPath: path,
    startedAt,
    solver: spec.id,
    label: 'PRM',
    space: 'sampling2d',
    continuous: true,
    trace,
    events,
    expanded: nodes.length,
    openAtEnd: edges,
  })
}

function visibilityGraph(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  const startedAt = performance.now()
  // Extra "across the open floor" links per vertex, on top of the 8-neighbour
  // grid edges. Deliberately *not* a card: on an 8-connected grid a staircase
  // of diagonals already costs exactly what one long edge costs, so this number
  // changes how the path is drawn but never how long it is — which is the
  // definition of a decorative parameter.
  const extraLinks = 5
  const nodes: Point[] = []
  const indexByCell = new Int32Array(map.width * map.height).fill(-1)
  let startIndex = -1
  let goalIndex = -1
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 1; x += 1) {
      const cell = y * map.width + x
      if (map.cells[cell] === 1) continue
      if (!pointFree(map, cards, x + 0.5, y + 0.5)) continue
      indexByCell[cell] = nodes.length
      nodes.push({ x: x + 0.5, y: y + 0.5 })
      if (x === map.start.x && y === map.start.y) startIndex = nodes.length - 1
      if (x === map.goal.x && y === map.goal.y) goalIndex = nodes.length - 1
    }
  }

  const trace = {
    kind: 'sampling' as const,
    loopLabel: 'BUILD → QUERY',
    init: ['V ← 所有可通行格中心', 'E ← 互视顶点连线'],
    loop: ['邻接 8 邻域', `再连 ${extraLinks} 个最近可见点`, 'Dijkstra(V, E)'],
    terminate: ['return path(S → G)'],
  }

  if (startIndex < 0 || goalIndex < 0) {
    return buildFailure({
      map,
      cards,
      order,
      startedAt,
      solver: spec.id,
      label: '可见性图',
      space: 'sampling2d',
      continuous: true,
      trace,
      events: [],
      expanded: 0,
      openAtEnd: 0,
    })
  }

  const adjacency: Array<Array<{ to: number; cost: number }>> = nodes.map(() => [])
  let edges = 0
  const link = (i: number, j: number) => {
    if (i < 0 || j < 0 || i === j) return
    if (!segmentClear(map, cards, nodes[i], nodes[j])) return
    const cost = distance(nodes[i], nodes[j]) * lengthScale(cards)
    adjacency[i].push({ to: j, cost })
    adjacency[j].push({ to: i, cost })
    edges += 1
  }

  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 1; x += 1) {
      const i = indexByCell[y * map.width + x]
      if (i < 0) continue
      for (const [dx, dy] of [
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
      ]) {
        const nx = x + dx
        const ny = y + dy
        if (nx <= 0 || ny <= 0 || nx >= map.width - 1 || ny >= map.height - 1) continue
        link(i, indexByCell[ny * map.width + nx])
      }
    }
  }

  if (nodes.length <= 1000) {
    for (let i = 0; i < nodes.length && extraLinks > 0; i += 1) {
      const nearest: Array<{ index: number; distance: number }> = []
      for (let j = 0; j < nodes.length; j += 1) {
        if (i === j) continue
        nearest.push({ index: j, distance: distance(nodes[i], nodes[j]) })
      }
      nearest.sort((a, b) => a.distance - b.distance)
      for (let k = 0; k < Math.min(extraLinks, nearest.length); k += 1) {
        link(i, nearest[k].index)
      }
    }
  }

  const events: PlanResult['events'] = nodes.map((point, index) => ({
    x: point.x,
    y: point.y,
    g: 0,
    h: distance(point, nodes[goalIndex]),
    f: distance(point, nodes[goalIndex]),
    openSize: index + 1,
  }))

  const dist = new Float64Array(nodes.length).fill(Number.POSITIVE_INFINITY)
  const previous = new Int32Array(nodes.length).fill(-1)
  const visited = new Uint8Array(nodes.length)
  dist[startIndex] = 0
  for (let iteration = 0; iteration < nodes.length; iteration += 1) {
    let current = -1
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < nodes.length; i += 1) {
      if (visited[i] === 0 && dist[i] < best) {
        best = dist[i]
        current = i
      }
    }
    if (current < 0) break
    if (current === goalIndex) break
    visited[current] = 1
    for (const edge of adjacency[current]) {
      const next = dist[current] + edge.cost
      if (next < dist[edge.to]) {
        dist[edge.to] = next
        previous[edge.to] = current
      }
    }
  }

  if (!Number.isFinite(dist[goalIndex])) {
    return buildFailure({
      map,
      cards,
      order,
      startedAt,
      solver: spec.id,
      label: '可见性图',
      space: 'sampling2d',
      continuous: true,
      trace,
      events,
      expanded: nodes.length,
      openAtEnd: edges,
    })
  }

  const path: Point[] = []
  let cursor = goalIndex
  let guard = 0
  while (cursor >= 0 && guard < nodes.length + 2) {
    path.push(nodes[cursor])
    cursor = previous[cursor]
    guard += 1
  }
  path.reverse()

  return buildSuccess({
    map,
    cards,
    order,
    rawPath: path,
    startedAt,
    solver: spec.id,
    label: '可见性图',
    space: 'sampling2d',
    continuous: true,
    trace,
    events,
    expanded: nodes.length,
    openAtEnd: edges,
  })
}

export function planSampling(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  spec: SolverSpec,
): PlanResult {
  if (spec.id === 'prm') return prm(map, cards, order, spec)
  if (spec.id === 'visibility') return visibilityGraph(map, cards, order, spec)
  return rrt(map, cards, order, spec, spec.id === 'rrtstar')
}
