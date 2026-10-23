/**
 * Sampling planners in a spatial world.
 *
 * RRT and RRT* do not need a lattice to *search*; they need one to answer two
 * questions — "is this point free?" and "is this straight segment free?" — and
 * every space in the app answers both through `SpaceMetric`. So the tree lives in
 * float coordinates and the resolution of the underlying lattice only bounds how
 * faithfully those two predicates are evaluated. That is also why this file can
 * serve a voxel volume and an analytic distance field with no branching: the
 * space is a metric, and RRT is a metric algorithm.
 *
 * What it cannot serve is the cost model's turn term: RRT edges have arbitrary
 * headings, and the turn table is indexed by the 26 lattice directions. Charging
 * turns would mean discretising the new heading, which would be inventing a cost
 * the planner never optimised. So the note says so, and the breakdown reports
 * turn as zero rather than a made-up number.
 */
import type { CardId, CardsState, PlanResult, SearchEvent } from '../types'
import type { SpaceKind } from '../types'
import type { Lattice, SpaceMetric, Vec3 } from '../core/space'
import { CLEARANCE_SCALE, SAFE_CLEARANCE } from '../core/costs'
import { buildLattice, type LatticePlanInput } from './lattice3d'

interface TreeNode {
  p: Vec3
  parent: number
  cost: number
}

function length(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

/** Deterministic PRNG: a share link must reproduce the same tree on reload. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * Nudge an endpoint out of the safety margin, onto the nearest free cell.
 *
 * A lattice search tolerates a start that sits inside the inflation radius — it
 * relaxes outwards and finds a legal neighbour. RRT has no such step: a tree
 * rooted in a blocked cell grows nothing at all and reports "infeasible" in zero
 * milliseconds, which reads as a broken planner rather than an unlucky endpoint.
 * So the root and the target are snapped first, by expanding rings of cells.
 */
function snapFree(lattice: Lattice, metric: SpaceMetric, point: Vec3): Vec3 {
  if (metric.free(point)) return { ...point }
  const cell = { x: 0, y: 0, z: 0 }
  lattice.cellOf(lattice.nearest(point), cell)
  const { width, height, depth, spacing } = lattice
  const plane = width * height
  for (let r = 1; r <= 14; r += 1) {
    for (let dz = -r; dz <= r; dz += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
          const x = cell.x + dx
          const y = cell.y + dy
          const z = cell.z + dz
          if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) continue
          if (lattice.blocked(z * plane + y * width + x)) continue
          return { x: (x + 0.5) * spacing, y: (y + 0.5) * spacing, z: (z + 0.5) * spacing }
        }
      }
    }
  }
  return { ...point }
}

export function planSampleWorld(input: LatticePlanInput): PlanResult {
  const { world, spec, cards, endpoints, strategy } = input
  const startedAt = performance.now()
  const lattice = buildLattice(world, cards, endpoints.goal)
  const { metric, cost, spacing } = lattice
  const bounds = metric.bounds
  const optimize = spec.id === 'rrtstar'

  // Two metres of growth per sample in a room-scale world; scaled by the lattice
  // so a 0.5 m raster does not need four times as many samples.
  const step = Math.max(0.8, spacing * 3)
  const budget = cards.budget.enabled
    ? Math.max(200, Math.min(6000, Math.round(cards.budget.value)))
    : optimize
      ? 2600
      : 1800
  const goalBias = 0.1
  const rng = makeRng(0x9e3779b9)
  const start = snapFree(lattice, metric, endpoints.start)
  const goal = snapFree(lattice, metric, endpoints.goal)

  const clearanceOf = (p: Vec3) => lattice.clearance(lattice.nearest(p))

  /** Edge cost in the same currency as the lattice search, minus turns. */
  const edgeCost = (a: Vec3, b: Vec3): number => {
    const span = length(a, b)
    let total = span * cost.lengthScale
    if (cost.clearanceWeight > 0) {
      const deficit = Math.max(0, SAFE_CLEARANCE - clearanceOf(b))
      total += cost.clearanceWeight * deficit * deficit * span * CLEARANCE_SCALE
    }
    return total
  }

  const tree: TreeNode[] = [{ p: { ...start }, parent: -1, cost: 0 }]
  const events: SearchEvent[] = []
  const pushEvent = (p: Vec3, g: number) => {
    const h = length(p, goal)
    events.push({ x: p.x, y: p.y, z: p.z, g, h, f: g + h, openSize: tree.length })
  }
  pushEvent(start, 0)

  let goalIndex = -1
  let best = Number.POSITIVE_INFINITY
  let cursor = 0
  let expanded = 0

  for (let iteration = 0; iteration < budget; iteration += 1) {
    // Goal bias makes RRT converge instead of wandering; RRT* still needs it,
    // because an unbounded search never stops refining.
    const sample: Vec3 = {
      x: bounds.min.x + rng() * (bounds.max.x - bounds.min.x),
      y: bounds.min.y + rng() * (bounds.max.y - bounds.min.y),
      z: bounds.min.z + rng() * (bounds.max.z - bounds.min.z),
    }
    const target = rng() < goalBias ? goal : sample
    if (!metric.free(target) && target !== goal) continue

    // Nearest neighbour by straight-line distance. A k-d tree would be the right
    // structure at ten thousand nodes; at two thousand, the constant factor of
    // building one is larger than the scan it saves.
    let nearest = 0
    let nearestGap = Number.POSITIVE_INFINITY
    for (let i = 0; i < tree.length; i += 1) {
      const gap = length(tree[i].p, target)
      if (gap < nearestGap) {
        nearestGap = gap
        nearest = i
      }
    }
    if (nearestGap < 1e-6) continue

    const from = tree[nearest].p
    const ratio = Math.min(1, step / nearestGap)
    const next: Vec3 = {
      x: from.x + (target.x - from.x) * ratio,
      y: from.y + (target.y - from.y) * ratio,
      z: from.z + (target.z - from.z) * ratio,
    }
    if (!metric.free(next) || !metric.segmentFree(from, next)) continue

    let parent = nearest
    let nodeCost = tree[nearest].cost + edgeCost(from, next)

    if (optimize) {
      // Rewire: adopt any nearby node that reaches this point more cheaply.
      const radius = Math.min(step * 2.4, spacing * 8)
      for (let i = 0; i < tree.length; i += 1) {
        const candidate = tree[i]
        if (length(candidate.p, next) > radius) continue
        const via = candidate.cost + edgeCost(candidate.p, next)
        if (via + 1e-9 < nodeCost && metric.segmentFree(candidate.p, next)) {
          parent = i
          nodeCost = via
        }
      }
    }

    tree.push({ p: next, parent, cost: nodeCost })
    expanded += 1
    pushEvent(next, nodeCost)

    if (metric.segmentFree(next, goal) && length(next, goal) <= step * 1.5) {
      const total = nodeCost + edgeCost(next, goal)
      if (total < best) {
        best = total
        goalIndex = tree.length
        tree.push({ p: { ...goal }, parent: tree.length - 1, cost: total })
        pushEvent(goal, total)
      }
      // Plain RRT stops at the first connection; RRT* keeps sampling to improve.
      if (!optimize) break
    }

    // Yield-free progress bookkeeping: `cursor` is only used so the note can
    // report how much of the budget the answer actually needed.
    cursor = iteration
  }

  const path3: Vec3[] = []
  if (goalIndex >= 0) {
    let at = goalIndex
    while (at >= 0 && path3.length < tree.length + 1) {
      path3.push(tree[at].p)
      at = tree[at].parent
    }
    path3.reverse()
  }

  let pathLength = 0
  let minClearance = Number.POSITIVE_INFINITY
  for (let i = 0; i < path3.length; i += 1) {
    if (i > 0) pathLength += length(path3[i - 1], path3[i])
    minClearance = Math.min(minClearance, metric.clearanceAt(path3[i]))
  }
  if (!Number.isFinite(minClearance)) minClearance = 0

  const breakdown = {
    length: pathLength * cost.lengthScale,
    clearance: Math.max(0, best - pathLength * cost.lengthScale),
    turn: 0,
    bias: 0,
  }
  const elapsed = performance.now() - startedAt
  const space: SpaceKind = world.kind

  return {
    status: goalIndex >= 0 ? 'success' : 'infeasible',
    continuous: true,
    path: [],
    rawPath: [],
    path3,
    events,
    expanded,
    expandedCells: expanded,
    pathLength,
    minClearance,
    totalCost: goalIndex >= 0 ? best : 0,
    cost: breakdown,
    solveTime: elapsed,
    waypoints: path3.length,
    smoothed: false,
    algorithmLabel: spec.label,
    openAtEnd: tree.length,
    solver: spec.id,
    space,
    rounds: cursor + 1,
    note: `${tree.length} 个采样点 · 步长 ${step.toFixed(1)} m · 转弯代价不计（采样边角度连续，不属于 26 邻域代价表）`,
    trace: {
      kind: 'graph',
      loopLabel: 'FOR n = 1 … BUDGET',
      init: ['TREE ← { s }', `STEP ← ${step.toFixed(1)}`, 'BUDGET ← ' + budget],
      loop: [
        'q ← 随机采样（10% 概率直接取目标）',
        'n ← argmin |q − TREE|',
        'x ← n + STEP · (q − n) / |q − n|',
        'IF 线段 n→x 无碰撞 THEN 加入 TREE',
        optimize ? '在半径 r 内比较代价，必要时改父（rewire）' : 'IF 与目标相连 THEN 结束',
      ],
      terminate: ['连到目标 → 回溯父链', '预算耗尽 → 返回已找到的最优解或报告不可行'],
    },
  }
}
