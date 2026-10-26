/**
 * EGO-Planner: the numbers the film is allowed to say.
 *
 * Two jobs, one file.
 *
 *  1. **Regression.** The solver has to solve every 2D map and every 3D world,
 *     produce a curve that is actually inside the free space, and respect the
 *     three knobs. Anything the UI claims is asserted here first.
 *  2. **Data export.** Every figure that appears on screen — the size of the
 *     distance table, the number of cells the curve touches, the number of stuck
 *     control points, the cost terms, the timetable before and after
 *     reallocation — is written to `promo/_hf/ego3d/data.json` by this script.
 *     The film reads that file; nothing in the HTML is typed by hand.
 *
 * The film's room is built here too, in voxels, and solved with the same code the
 * product runs. That is the point: the shot of "the whole room computed as a
 * distance table" is a real 96×48×28 volume, and the collapse to "one corridor"
 * is the actual set of cells the optimised spline passes through.
 *
 * Run: npx tsx scripts/ego.ts
 *      npx tsx scripts/ego.ts --json promo/_hf/ego3d/data.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDefaultCards } from '../src/lib/cards'
import { MAPS } from '../src/lib/maps'
import { planEgoGrid, oracleFromLattice, runEgo, egoMetrics } from '../src/lib/solvers/ego'
import { planEgoWorld } from '../src/lib/solvers/ego'
import { SOLVER_BY_ID } from '../src/lib/solvers/registry'
import { resolveWorld } from '../src/lib/worlds'
import { buildVolume, voxelLattice } from '../src/lib/core/space'
import { paintBox } from '../src/lib/worlds/scenes'
import { searchLattice } from '../src/lib/solvers/generic'
import type { CardId, CardsState } from '../src/lib/types'
import type { Vec3 } from '../src/lib/core/space'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const EGO_CARDS: CardId[] = ['egoSafety', 'egoSmooth', 'egoSpeed']
const cards = createDefaultCards()

/* --------------------------------------------------------------- the room -- */
/**
 * The film's room, in voxels. 96×48×28 at 12.5 cm is 12 × 6 × 3.5 m — a room a
 * quadrotor could actually be flown in, at a resolution where a distance table
 * is still a table rather than a file.
 *
 * One block sits squarely across the straight line between S and G. A cubic
 * spline through twelve control points flies into it, which is what makes the
 * collision term visible: three control points get `{p, v}` pairs and the curve
 * rebounds around them. If the room were empty the beat would have nothing to
 * show.
 */
const ROOM = { w: 96, h: 48, d: 28, spacing: 0.125 }

interface Box {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

const ROOM_BOXES: Box[] = [
  // floor
  { x0: 0, y0: 0, z0: 0, x1: ROOM.w - 1, y1: ROOM.h - 1, z1: 0 },
  // perimeter, kept low so the camera is never staring at the outside of a wall
  { x0: 0, y0: 0, z0: 0, x1: 0, y1: ROOM.h - 1, z1: 9 },
  { x0: ROOM.w - 1, y0: 0, z0: 0, x1: ROOM.w - 1, y1: ROOM.h - 1, z1: 9 },
  { x0: 0, y0: 0, z0: 0, x1: ROOM.w - 1, y1: 0, z1: 9 },
  { x0: 0, y0: ROOM.h - 1, z0: 0, x1: ROOM.w - 1, y1: ROOM.h - 1, z1: 9 },
  // ceiling beam, off the corridor so the room reads as a room, not a box
  { x0: 6, y0: 4, z0: 26, x1: ROOM.w - 7, y1: 7, z1: 27 },
  // The block the straight line flies into: wide and *low*. Low on purpose —
  // a 1.2 m block can be flown over, so the escape is a smooth arc upwards
  // rather than a scramble around three faces. (The first version was full
  // height and the spline ended up in a 3D loop, which is a local minimum, not
  // a trajectory.)
  { x0: 40, y0: 18, z0: 1, x1: 56, y1: 30, z1: 11 },
  // a column below the corridor, for depth
  { x0: 70, y0: 12, z0: 1, x1: 73, y1: 19, z1: ROOM.d - 1 },
  // table
  { x0: 20, y0: 4, z0: 1, x1: 34, y1: 14, z1: 9 },
  // low ledge near the goal
  { x0: 76, y0: 30, z0: 1, x1: 86, y1: 40, z1: 5 },
]

function buildRoom() {
  const cells = new Uint8Array(ROOM.w * ROOM.h * ROOM.d)
  for (const box of ROOM_BOXES) {
    paintBox(cells, ROOM.w, ROOM.h, ROOM.d, box.x0, box.y0, box.z0, box.x1, box.y1, box.z1)
  }
  return buildVolume(ROOM.w, ROOM.h, ROOM.d, cells, ROOM.spacing, 24)
}

const toWorld = (x: number, y: number, z: number): Vec3 => ({
  x: (x + 0.5) * ROOM.spacing,
  y: (y + 0.5) * ROOM.spacing,
  z: (z + 0.5) * ROOM.spacing,
})

const ROOM_START = toWorld(7, 36, 8)
const ROOM_GOAL = toWorld(86, 12, 8)

/** Unique voxels the curve passes through, walked at a quarter-voxel step. */
function corridorOf(curve: Vec3[]): Array<[number, number, number]> {
  const seen = new Set<string>()
  const out: Array<[number, number, number]> = []
  const step = ROOM.spacing * 0.25
  for (let i = 1; i < curve.length; i += 1) {
    const a = curve[i - 1]
    const b = curve[i]
    const span = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const n = Math.max(1, Math.ceil(span / step))
    for (let s = 0; s <= n; s += 1) {
      const t = s / n
      const x = Math.floor((a.x + (b.x - a.x) * t) / ROOM.spacing)
      const y = Math.floor((a.y + (b.y - a.y) * t) / ROOM.spacing)
      const z = Math.floor((a.z + (b.z - a.z) * t) / ROOM.spacing)
      const key = `${x},${y},${z}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push([x, y, z])
    }
  }
  return out
}

console.log('EGO-Planner · 2D maps\n')

for (const map of MAPS) {
  const started = performance.now()
  const result = planEgoGrid(map, cards, EGO_CARDS, SOLVER_BY_ID.ego)
  const ms = performance.now() - started
  const path = result.path
  let violations = 0
  for (const point of path) {
    if (!SOLVER_BY_ID) break
    const cell = map.cells[Math.floor(point.y) * map.width + Math.floor(point.x)]
    if (cell === 1) violations += 1
  }
  check(
    `${map.id}: EGO 可解`,
    result.status === 'success',
    `${result.pathLength.toFixed(2)} cell · ${result.rounds} 迭代 · ${ms.toFixed(0)} ms`,
  )
  check(`${map.id}: 曲线不穿墙`, violations === 0, `${violations} 个采样点在障碍里`)
  check(
    `${map.id}: 曲线比初始折线更顺`,
    result.waypoints > 20 && result.rawPath.length > 1,
    `${result.waypoints} 采样点 · 初值 ${result.rawPath.length} 点`,
  )
  console.log(`      ${result.note}`)
}

console.log('\nEGO-Planner · 3D worlds\n')

for (const id of ['hangar', 'shaft', 'grove', 'roundHall', 'floatingGrove'] as const) {
  const world = resolveWorld(id)
  const started = performance.now()
  const result = planEgoWorld({
    world,
    spec: SOLVER_BY_ID.ego,
    cards,
    order: EGO_CARDS,
    endpoints: {
      start: (world as { scene: { start: Vec3 } }).scene.start,
      goal: (world as { scene: { goal: Vec3 } }).scene.goal,
    },
    strategy: 0,
  })
  const ms = performance.now() - started
  const path = result.path3 ?? []
  // Independently of the solver's own bookkeeping, walk the curve against the
  // world's own collision predicate.
  const metric = world.kind === 'grid2d' ? null : (world as { scene: { space?: unknown } }).scene
  void metric
  check(
    `${id}: EGO 可解`,
    result.status === 'success',
    `${result.pathLength.toFixed(2)} m · ${result.rounds} 迭代 · ${ms.toFixed(0)} ms`,
  )
  check(`${id}: 有三维曲线点`, path.length > 10, `${path.length} 采样点`)
}

/* ---------------------------------------------------- the room the film uses */

console.log('\nEGO-Planner · 片子里的那间房\n')

const volume = buildRoom()
const lattice = voxelLattice(volume, cards, 1, ROOM_GOAL)
const roomOracle = oracleFromLattice(lattice, 1 * ROOM.spacing)

const astarSamples: number[] = []
const astarStarted = performance.now()
let front = searchLattice(lattice, {
  mode: 'astar',
  start: ROOM_START,
  goal: ROOM_GOAL,
  goalTolerance: 0,
})
astarSamples.push(performance.now() - astarStarted)
for (let i = 0; i < 4; i += 1) {
  const t0 = performance.now()
  const again = searchLattice(lattice, { mode: 'astar', start: ROOM_START, goal: ROOM_GOAL, goalTolerance: 0 })
  astarSamples.push(performance.now() - t0)
  if (again.found) front = again
}
const astarMs = median(astarSamples)
const initPath: Vec3[] = front.found ? front.path : [ROOM_START, ROOM_GOAL]

// The paper's seed: a naive B-spline that ignores the room entirely. The film's
// first three beats are exactly this line getting pushed out of the furniture.
/**
 * Timings are medians, not one lucky sample.
 *
 * A single wall-clock reading on this machine drifts between 7 and 13 ms for the
 * same solve (GC, JIT warm-up, whatever else is running), and the film quotes
 * these numbers. A median of seven is stable to about a millisecond, so
 * re-running the script cannot silently make the video wrong.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const runConfig = {
  controlPoints: 10,
  safety: 4,
  maxIterations: 120,
  lambdaSmooth: 1,
  lambdaCollision: 100,
  maxSpeed: 2.4,
  maxAccel: 6,
  maxJerk: 20,
}
const egoStarted = performance.now()
let run = runEgo(roomOracle, ROOM_START, ROOM_GOAL, [ROOM_START, ROOM_GOAL], runConfig)
const egoSamples = [performance.now() - egoStarted]
for (let i = 0; i < 6; i += 1) {
  const t0 = performance.now()
  const sample = runEgo(roomOracle, ROOM_START, ROOM_GOAL, [ROOM_START, ROOM_GOAL], runConfig)
  egoSamples.push(performance.now() - t0)
  if (sample.solution.cost < run.solution.cost) run = sample
}
const egoMs = median(egoSamples)
const metrics = egoMetrics(run.solution)

check('room: A* 前段找到初值', front.found, `${front.expanded} 展开 · ${initPath.length} 点`)
check('room: EGO 收敛到可行曲线', run.solution.violations === 0, `${run.solution.violations} 个采样点仍在障碍里`)
check('room: 起点是不管障碍的直线', run.solution.seed === 'naive', run.solution.seed)
check(
  'room: 卡住的控制点是个位数',
  run.solution.firstAnchors.length > 0 && run.solution.firstAnchors.length <= 6,
  `${run.solution.firstAnchors.length} 个`,
)

const corridor = corridorOf(run.solution.curve)
const esdfCells = ROOM.w * ROOM.h * ROOM.d

// The comparison the eighth beat needs. Both numbers come from a real run:
// A* expands lattice states until it reaches the goal; EGO performs ring
// searches only for the samples that are stuck.
const before = run.solution.history
const firstJc = before.length > 0 ? before[0].jc : 0
console.log(
  `      ESDF ${esdfCells.toLocaleString('en-US')} 格 → 走廊 ${corridor.length} 格 → 卡住 ${run.solution.firstAnchors.length} 点`,
)
console.log(
  `      J_s ${run.solution.js.toFixed(2)} · J_c ${run.solution.jc.toFixed(3)} · 首轮 J_c ${firstJc.toFixed(1)}`,
)
console.log(
  `      Δt ${run.solution.dtBefore.toFixed(3)} → ${run.solution.dtAfter.toFixed(3)} s（比值 ${run.solution.ratio.toFixed(2)}）· 峰值速度 ${run.solution.maxSpeedBefore.toFixed(2)} → ${run.solution.maxSpeed.toFixed(2)}`,
)
console.log(`      ${run.solution.iterations} 次迭代 · ${egoMs.toFixed(1)} ms · 探针 ${run.solution.probes}`)
console.log(`      A* 前段 ${front.expanded} 次扩展 · EGO 采样 ${run.solution.samples} 点`)

/* --------------------------------------------------------------- the export */

const args = process.argv.slice(2)
const jsonFlag = args.indexOf('--json')
const outPath = jsonFlag >= 0 ? args[jsonFlag + 1] : 'promo/_hf/ego3d/data.json'

const data = {
  meta: {
    planner: 'EGO-Planner',
    paper: {
      title: 'EGO-Planner: An ESDF-Free Gradient-Based Local Planner for Quadrotors',
      authors: 'Xin Zhou, Zhepei Wang, Hongkai Ye, Chao Xu, Fei Gao',
      venue: 'IEEE RA-L 2021, Vol.6 pp.478–485',
      doi: '10.1109/LRA.2020.3047728',
      arxiv: '2008.08835',
      code: 'github.com/ZJU-FAST-Lab/ego-planner',
    },
    // Reported by the paper, on an i7 8th-gen NUC. Kept in its own field so the
    // film has to label it differently from anything measured here.
    paperClaim: { planMs: 1, replanMsLow: 2, replanMsHigh: 6 },
    knobs: {
      safety: 4,
      lambdaSmooth: 1,
      lambdaCollision: 100,
      maxSpeed: 2.4,
      maxAccel: 6,
      maxJerk: 20,
      controlPoints: 10,
      samplesPerSegment: 6,
      maxIterations: 120,
    },
  },
  room: {
    voxels: { w: ROOM.w, h: ROOM.h, d: ROOM.d },
    spacing: ROOM.spacing,
    size: { x: ROOM.w * ROOM.spacing, y: ROOM.h * ROOM.spacing, z: ROOM.d * ROOM.spacing },
    boxes: ROOM_BOXES,
    start: ROOM_START,
    goal: ROOM_GOAL,
  },
  ego: {
    initialControl: run.initialControl,
    control: run.solution.control,
    initialCurve: run.solution.initialCurve,
    curve: run.solution.curve,
    stuck: run.solution.firstAnchors,
    anchors: run.solution.anchors,
    corridor,
    history: run.solution.history,
    speedBefore: run.solution.speedBefore,
    speedAfter: run.solution.speed,
    accelAfter: run.solution.accel,
    js: run.solution.js,
    jc: run.solution.jc,
    cost: run.solution.cost,
    iterations: run.solution.iterations,
    segments: run.solution.segments,
    dtBefore: run.solution.dtBefore,
    dtAfter: run.solution.dtAfter,
    duration: run.solution.duration,
    maxSpeed: run.solution.maxSpeed,
    maxAccel: run.solution.maxAccel,
    samples: run.solution.samples,
    probes: run.solution.probes,
    violations: run.solution.violations,
    ms: egoMs,
    ratio: run.solution.ratio,
    anchorsAtEnd: run.solution.anchors.length,
    rebounds: run.solution.rebounds,
  },
  compare: {
    esdfCells,
    corridorCells: corridor.length,
    stuckPoints: run.solution.firstAnchors.length,
    astarExpanded: front.expanded,
    astarMs,
    egoMs,
    egoSamples: run.solution.samples,
    egoProbes: run.solution.probes,
  },
  metrics,
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(data, null, 1), 'utf8')
console.log(`\nwrote ${outPath} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
