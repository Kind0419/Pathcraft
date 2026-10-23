/**
 * Sanity checks for the 3D worlds and the lattice solver.
 *
 * These are the claims the UI will make, so they get asserted rather than
 * eyeballed: the path is feasible against the volume, it never walks through a
 * blocked voxel, and it actually uses the vertical axis (otherwise "3D" is just
 * a slower 2D).
 */
import { createDefaultCards } from '../src/lib/cards'
import { resolveWorld } from '../src/lib/worlds'
import { planLatticeWorld } from '../src/lib/solvers/lattice3d'
import { SOLVER_BY_ID } from '../src/lib/solvers/registry'
import type { Vec3 } from '../src/lib/core/space'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const cards = createDefaultCards()

for (const id of ['hangar', 'shaft', 'grove'] as const) {
  const world = resolveWorld(id)
  if (world.kind !== 'voxel3d') throw new Error('expected voxel world')
  const scene = world.scene
  const result = planLatticeWorld({
    world,
    spec: SOLVER_BY_ID.astar,
    cards,
    order: [],
    endpoints: { start: scene.start, goal: scene.goal },
    strategy: 0,
  })

  const path = result.path3 ?? []
  const length = result.pathLength
  let above = 0
  let violations = 0
  let minClear = Number.POSITIVE_INFINITY

  const { width, height, depth, cells } = scene.volume
  const plane = width * height
  for (let i = 0; i < path.length; i += 1) {
    const p = path[i]
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    const z = Math.floor(p.z)
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) {
      violations += 1
      continue
    }
    if (cells[z * plane + y * width + x] === 1) violations += 1
    if (z > 0) above += 1
    if (i > 0) {
      const q = path[i - 1]
      const steps = 8
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps
        const mx = Math.floor(q.x + (p.x - q.x) * t)
        const my = Math.floor(q.y + (p.y - q.y) * t)
        const mz = Math.floor(q.z + (p.z - q.z) * t)
        if (mx < 0 || my < 0 || mz < 0 || mx >= width || my >= height || mz >= depth) {
          violations += 1
          continue
        }
        if (cells[mz * plane + my * width + mx] === 1) violations += 1
      }
    }
  }
  minClear = result.minClearance

  check(`${id}: 找到路径`, result.status === 'success', `${length.toFixed(2)} m · ${result.expanded} 展开`)
  check(`${id}: 路径不穿模`, violations === 0, `${violations} 个采样点落在障碍里`)
  check(`${id}: 用到垂直维度`, above > 0, `${above} 个节点 z > 0`, )

  if (id === 'hangar') {
    const topZ = Math.max(...path.map((p) => p.z))
    check('hangar: 飞越三格矮墙', topZ > 4.5, `最高 ${topZ.toFixed(2)}`)
  }
  if (id === 'shaft') {
    const topZ = Math.max(...path.map((p) => p.z))
    check('shaft: 到达顶层', topZ > 13, `最高 ${topZ.toFixed(2)}`)
  }
  console.log(
    `      clearance ${minClear.toFixed(2)} · waypoints ${path.length} · cost ${result.totalCost.toFixed(2)}`,
  )
}

/* Continuous fields: the same claims, but the obstacle test is analytic. */
const { fieldMetric } = await import('../src/lib/core/space/field')
for (const id of ['roundHall', 'floatingGrove'] as const) {
  const world = resolveWorld(id)
  if (world.kind !== 'field2d' && world.kind !== 'field3d') throw new Error('expected field world')
  const scene = world.scene
  const result = planLatticeWorld({
    world,
    spec: SOLVER_BY_ID.astar,
    cards,
    order: [],
    endpoints: { start: scene.start, goal: scene.goal },
    strategy: 0,
  })
  const metric = fieldMetric(scene.space, 0, scene.resolution)
  const path = result.path3 ?? []
  let outside = 0
  let segments = 0
  for (let i = 0; i < path.length; i += 1) {
    if (metric.clearanceAt(path[i]) <= 0) outside += 1
    if (i > 0 && !metric.segmentFree(path[i - 1], path[i], 0)) segments += 1
  }
  check(`${id}: 找到路径`, result.status === 'success', `${result.pathLength.toFixed(2)} m · ${result.expanded} 展开`)
  check(`${id}: 路径在自由空间内`, outside === 0, `${outside} 个节点落在障碍内`)
  check(`${id}: 连线不穿越障碍`, segments === 0, `${segments} 段穿过障碍`)
}

/* Sampling planners: they must solve every spatial world, and improve with RRT*. */
const { planSampleWorld } = await import('../src/lib/solvers/sampling3d')
for (const id of ['hangar', 'shaft', 'grove', 'roundHall', 'floatingGrove'] as const) {
  const world = resolveWorld(id)
  const scene = (world as { scene: { start: Vec3; goal: Vec3 } }).scene
  const endpoints = { start: scene.start, goal: scene.goal }
  const rrt = planSampleWorld({ world, spec: SOLVER_BY_ID.rrt, cards, order: [], endpoints, strategy: 0 })
  const rrtStar = planSampleWorld({
    world,
    spec: SOLVER_BY_ID.rrtstar,
    cards,
    order: [],
    endpoints,
    strategy: 0,
  })
  check(`${id}: RRT 可解`, rrt.status === 'success', `${rrt.pathLength.toFixed(2)} m · ${rrt.expanded} 节点`)
  check(
    `${id}: RRT* 可解且不劣于 RRT`,
    rrtStar.status === 'success' && rrtStar.pathLength <= rrt.pathLength + 1e-6,
    `${rrtStar.pathLength.toFixed(2)} m vs ${rrt.pathLength.toFixed(2)} m`,
  )
}

/* 2D regression: the same three maps must still solve through the old path. */
const { plan } = await import('../src/lib/solvers')
for (const id of ['notch', 'gate', 'clutter'] as const) {
  const world = resolveWorld(id)
  if (world.kind !== 'grid2d') throw new Error('expected grid world')
  const result = plan(world.map, cards)
  check(`2D ${id}: 仍然可解`, result.status === 'success', `${result.pathLength.toFixed(2)} m`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
if (failures > 0) process.exit(1)
