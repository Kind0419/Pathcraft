import type {
  CardId,
  CardsState,
  CostBreakdown,
  GridMap,
  PlanResult,
  Point,
  SearchEvent,
} from './types'

const SAFE_CLEARANCE = 3.2
const CLEARANCE_SCALE = 1.6

interface TreeNode {
  x: number
  y: number
  parent: number
  cost: number
}

function strategyMode(cards: CardsState): number {
  return cards.strategy.enabled ? Math.round(cards.strategy.value) : 0
}

function cardValue(cards: CardsState, id: CardId): number {
  return cards[id].enabled ? cards[id].value : 0
}

function lengthScale(cards: CardsState): number {
  return cards.lengthWeight.enabled
    ? Math.max(0.05, cards.lengthWeight.value)
    : 1
}

function safetyRadius(cards: CardsState): number {
  return cards.collision.enabled ? cards.collision.value : 0
}

function pointFree(
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

function cellFree(map: GridMap, cards: CardsState, x: number, y: number): boolean {
  if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) return false
  const index = y * map.width + x
  if (map.cells[index] === 1) return false
  const radius = safetyRadius(cards)
  return radius <= 0 || map.clearance[index] >= radius - 1e-6
}

function segmentClear(
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

function edgeCost(
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
        clearanceWeight *
        deficit *
        deficit *
        CLEARANCE_SCALE *
        (distance / samples)
    }
  }
  return cost
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function smoothLineOfSight(
  map: GridMap,
  cards: CardsState,
  points: Point[],
): Point[] {
  if (points.length <= 2) return points
  const result: Point[] = [points[0]]
  let anchor = 0
  while (anchor < points.length - 1) {
    let next = points.length - 1
    while (next > anchor + 1 && !segmentClear(map, cards, points[anchor], points[next])) {
      next -= 1
    }
    result.push(points[next])
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
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
    }
    next.push(current[current.length - 1])
    current = next
  }
  return current
}

function pathIsClear(
  map: GridMap,
  cards: CardsState,
  points: Point[],
): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (!segmentClear(map, cards, points[i - 1], points[i])) return false
  }
  return true
}

function simplifyPath(
  map: GridMap,
  cards: CardsState,
  points: Point[],
  tolerance: number,
): Point[] {
  if (points.length <= 2) return [...points]
  const result = [...points]
  let changed = true
  while (changed) {
    changed = false
    for (let i = 1; i < result.length - 1; i += 1) {
      const a = result[i - 1]
      const p = result[i]
      const b = result[i + 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy)
      const perpendicular =
        length < 1e-9
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / length
      if (
        perpendicular <= tolerance + 1e-9 &&
        segmentClear(map, cards, a, b)
      ) {
        result.splice(i, 1)
        changed = true
        i -= 1
      }
    }
  }
  return result
}

function evaluatePath(
  map: GridMap,
  cards: CardsState,
  points: Point[],
): { length: number; minClearance: number; cost: CostBreakdown } {
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
    const segmentLength = distance(a, b)
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
      bias: 0,
    },
  }
}

function roundCorners(
  map: GridMap,
  cards: CardsState,
  points: Point[],
  radius: number,
): Point[] {
  if (points.length <= 2) return points
  const result: Point[] = [points[0]]
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    const c = points[i + 1]
    const l1 = distance(a, b)
    const l2 = distance(b, c)
    if (l1 < 1e-6 || l2 < 1e-6) {
      result.push(b)
      continue
    }
    let rounded: Point[] | null = null
    for (const scale of [1, 0.68, 0.42, 0.22]) {
      const r = Math.min(radius * scale, l1 * 0.45, l2 * 0.45)
      if (r < 0.03) continue
      const p1 = {
        x: b.x + ((a.x - b.x) * r) / l1,
        y: b.y + ((a.y - b.y) * r) / l1,
      }
      const p2 = {
        x: b.x + ((c.x - b.x) * r) / l2,
        y: b.y + ((c.y - b.y) * r) / l2,
      }
      const samples = Math.max(5, Math.ceil(r * 14))
      const curve: Point[] = []
      for (let step = 0; step <= samples; step += 1) {
        const t = step / samples
        const u = 1 - t
        curve.push({
          x: u * u * p1.x + 2 * u * t * b.x + t * t * p2.x,
          y: u * u * p1.y + 2 * u * t * b.y + t * t * p2.y,
        })
      }
      if (pathIsClear(map, cards, curve)) {
        rounded = curve
        break
      }
    }
    if (rounded) result.push(...rounded)
    else result.push(b)
  }
  result.push(points[points.length - 1])
  return pathIsClear(map, cards, result) ? result : points
}

function applyPostProcess(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  raw: Point[],
): Point[] {
  // Continuous planners always get one line-of-sight pass: a tree path full
  // of unit-length twigs is not useful as a final trajectory.
  let path = smoothLineOfSight(map, cards, raw)
  for (const id of order) {
    if (!cards[id]?.enabled) continue
    if (id === 'smooth') path = smoothLineOfSight(map, cards, path)
    if (id === 'round') {
      const passes = Math.max(1, Math.min(4, Math.round(cards.round.value)))
      const rounded = chaikin(path, passes)
      if (pathIsClear(map, cards, rounded)) path = rounded
    }
    if (id === 'simplify') {
      const simplified = simplifyPath(map, cards, path, cards.simplify.value)
      if (pathIsClear(map, cards, simplified)) path = simplified
    }
  }
  // Continuous output should read as a trajectory, not a polyline of hard
  // corners. Round each corner as far as clearance allows.
  if (!cards.round.enabled) {
    for (const radius of [0.8, 0.55, 0.35]) {
      const rounded = roundCorners(map, cards, path, radius)
      if (rounded !== path) {
        path = rounded
        break
      }
    }
  }
  return path
}

function buildResult(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  rawPath: Point[],
  events: SearchEvent[],
  expanded: number,
  openAtEnd: number,
  label: string,
  solveTime: number,
): PlanResult {
  const path = applyPostProcess(map, cards, order, rawPath)
  const evaluation = evaluatePath(map, cards, path)
  return {
    status: 'success',
    continuous: true,
    path,
    rawPath,
    events,
    expanded,
    expandedCells: events.length,
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
    smoothed: true,
    algorithmLabel: label,
    openAtEnd,
  }
}

function failResult(
  map: GridMap,
  cards: CardsState,
  events: SearchEvent[],
  expanded: number,
  openAtEnd: number,
  label: string,
  solveTime: number,
): PlanResult {
  return {
    status: 'infeasible',
    continuous: true,
    path: [],
    rawPath: [],
    events,
    expanded,
    expandedCells: events.length,
    pathLength: 0,
    minClearance: 0,
    totalCost: 0,
    cost: { length: 0, clearance: 0, turn: 0, bias: 0 },
    solveTime,
    waypoints: 0,
    smoothed: false,
    algorithmLabel: label,
    openAtEnd,
  }
}

function sampleBudget(
  cards: CardsState,
  fallback: number,
  cap = 2400,
): number {
  if (!cards.budget.enabled) return fallback
  return Math.max(120, Math.min(cap, Math.round(cards.budget.value)))
}

function rrt(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
  optimize: boolean,
): PlanResult {
  const startedAt = performance.now()
  const start = { x: map.start.x + 0.5, y: map.start.y + 0.5 }
  const goal = { x: map.goal.x + 0.5, y: map.goal.y + 0.5 }
  const step = 1.7
  const maxSamples = sampleBudget(cards, optimize ? 1900 : 1400)
  const nodes: TreeNode[] = [{ ...start, parent: -1, cost: 0 }]
  const events: SearchEvent[] = [
    { x: start.x, y: start.y, g: 0, h: distance(start, goal), f: distance(start, goal), openSize: 1 },
  ]
  const rng = makeRng(0x51ed270b)
  const goalBias = 0.12
  let goalIndex = -1

  for (let iteration = 0; iteration < maxSamples && goalIndex < 0; iteration += 1) {
    let sample: Point | null = null
    for (let attempts = 0; attempts < 30; attempts += 1) {
      if (rng() < goalBias) {
        sample = goal
      } else {
        const point = {
          x: 1 + rng() * (map.width - 2),
          y: 1 + rng() * (map.height - 2),
        }
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
    let bestCost = from.cost + edgeCost(map, cards, from, next)
    if (optimize) {
      const rewireRadius = step * 2.6
      for (let i = 0; i < nodes.length; i += 1) {
        if (i === nearest) continue
        const candidate = nodes[i]
        if (distance(candidate, next) > rewireRadius) continue
        const cost = candidate.cost + edgeCost(map, cards, candidate, next)
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
      const rewireRadius = step * 2.6
      for (let i = 0; i < nodes.length - 1; i += 1) {
        const node = nodes[i]
        if (node.parent < 0) continue
        if (distance(node, next) > rewireRadius) continue
        const candidateCost =
          bestCost + edgeCost(map, cards, next, node)
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
        cost: bestCost + edgeCost(map, cards, next, goal),
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

  const solveTime = performance.now() - startedAt
  const label = optimize ? 'RRT*' : 'RRT'
  if (goalIndex < 0) {
    return failResult(map, cards, events, nodes.length, nodes.length, label, solveTime)
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
  return buildResult(
    map,
    cards,
    order,
    path,
    events,
    nodes.length,
    nodes.length,
    label,
    solveTime,
  )
}

function prm(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
): PlanResult {
  const startedAt = performance.now()
  const start = { x: map.start.x + 0.5, y: map.start.y + 0.5 }
  const goal = { x: map.goal.x + 0.5, y: map.goal.y + 0.5 }
  const count = sampleBudget(cards, 420, 620)
  const rng = makeRng(0x2f6e2b1)
  const nodes: Point[] = [start, goal]
  const events: SearchEvent[] = [
    { x: start.x, y: start.y, g: 0, h: distance(start, goal), f: distance(start, goal), openSize: 1 },
  ]
  for (let i = 0; i < count; i += 1) {
    for (let attempts = 0; attempts < 20; attempts += 1) {
      const point = {
        x: 1 + rng() * (map.width - 2),
        y: 1 + rng() * (map.height - 2),
      }
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
  let edges = 0
  for (let i = 0; i < nodes.length; i += 1) {
    const nearest: Array<{ index: number; distance: number }> = []
    for (let j = 0; j < nodes.length; j += 1) {
      if (i === j) continue
      nearest.push({ index: j, distance: distance(nodes[i], nodes[j]) })
    }
    nearest.sort((a, b) => a.distance - b.distance)
    const limit = Math.min(9, nearest.length)
    for (let k = 0; k < limit; k += 1) {
      const j = nearest[k].index
      if (!segmentClear(map, cards, nodes[i], nodes[j])) continue
      const cost = edgeCost(map, cards, nodes[i], nodes[j])
      adjacency[i].push({ to: j, cost })
      adjacency[j].push({ to: i, cost })
      edges += 1
    }
  }

  const dist = new Float64Array(nodes.length)
  dist.fill(Number.POSITIVE_INFINITY)
  const previous = new Int32Array(nodes.length)
  previous.fill(-1)
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

  const solveTime = performance.now() - startedAt
  if (!Number.isFinite(dist[1])) {
    return failResult(map, cards, events, nodes.length, edges, 'PRM', solveTime)
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
  return buildResult(
    map,
    cards,
    order,
    path,
    events,
    nodes.length,
    edges,
    'PRM',
    solveTime,
  )
}

function visibilityGraph(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
): PlanResult {
  const startedAt = performance.now()
  const nodes: Point[] = []
  const indexByCell = new Int32Array(map.width * map.height)
  indexByCell.fill(-1)
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
  if (startIndex < 0 || goalIndex < 0) {
    return failResult(map, cards, [], 0, 0, '可见性图', performance.now() - startedAt)
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
        if (nx <= 0 || ny <= 0 || nx >= map.width - 1 || ny >= map.height - 1) {
          continue
        }
        link(i, indexByCell[ny * map.width + nx])
      }
    }
  }

  // Add a few longer visibility shortcuts so the roadmap is not just a grid.
  // Skip this on large maps: the nearest-neighbour sort dominates and the
  // line-of-sight post-process already removes most staircase artifacts.
  if (nodes.length <= 1000) {
    for (let i = 0; i < nodes.length; i += 1) {
      const nearest: Array<{ index: number; distance: number }> = []
      for (let j = 0; j < nodes.length; j += 1) {
        if (i === j) continue
        nearest.push({ index: j, distance: distance(nodes[i], nodes[j]) })
      }
      nearest.sort((a, b) => a.distance - b.distance)
      for (let k = 0; k < Math.min(5, nearest.length); k += 1) {
        link(i, nearest[k].index)
      }
    }
  }

  const events: SearchEvent[] = nodes.map((point, index) => ({
    x: point.x,
    y: point.y,
    g: 0,
    h: distance(point, nodes[goalIndex]),
    f: distance(point, nodes[goalIndex]),
    openSize: index + 1,
  }))

  const dist = new Float64Array(nodes.length)
  dist.fill(Number.POSITIVE_INFINITY)
  const previous = new Int32Array(nodes.length)
  previous.fill(-1)
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

  const solveTime = performance.now() - startedAt
  if (!Number.isFinite(dist[goalIndex])) {
    return failResult(
      map,
      cards,
      events,
      nodes.length,
      edges,
      '可见性图',
      solveTime,
    )
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
  return buildResult(
    map,
    cards,
    order,
    path,
    events,
    nodes.length,
    edges,
    '可见性图',
    solveTime,
  )
}

export function planContinuous(
  map: GridMap,
  cards: CardsState,
  order: CardId[],
): PlanResult {
  const mode = strategyMode(cards)
  if (mode === 7) return rrt(map, cards, order, true)
  if (mode === 8) return prm(map, cards, order)
  if (mode === 9) return visibilityGraph(map, cards, order)
  return rrt(map, cards, order, false)
}
