/**
 * Space-adapter verification.
 *
 * Run with: npx tsx scripts/space.ts
 *
 * Five claims, each checked against something independent:
 *   1. the O(N) EDT reproduces the map builder's brute-force clearance field;
 *   2. `stepCostOf` reproduces `gridStepCost` term for term on real maps;
 *   3. a generic search over the 2D lattice matches the frozen A* path;
 *   4. the same generic search on a voxel lattice finds a route the 2D lattice
 *      cannot take (that is the whole point of 3D);
 *   5. an analytic SDF lattice matches its own closed-form clearance.
 */
import { MAPS } from '../src/lib/maps'
import { createDefaultCards } from '../src/lib/cards'
import { cardValue, gridStepCost, heuristicOf, lengthScale, isBlocked } from '../src/lib/core/costs'
import {
  ALL_DIRS,
  DX,
  DY,
  ORTHO_DIRS,
} from '../src/lib/core/costs'
import {
  DIRS_2D,
  octile,
  stepCostOf,
  costModelFrom,
  gridLattice,
  makeLattice,
  buildVolume,
  volumeFromMap,
  voxelLattice,
  fieldLattice,
  fieldDistance,
  edtClearance,
  squaredEDT,
  signedDistance,
} from '../src/lib/core/space'
import type { FieldSpace, Vec3 } from '../src/lib/core/space'
import { searchLattice } from '../src/lib/solvers/generic'
import { planGraph } from '../src/lib/solvers/graph'
import { SOLVER_BY_ID } from '../src/lib/solvers/registry'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

function polylineLength(points: Vec3[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
      points[i].z - points[i - 1].z,
    )
  }
  return total
}

// ---------------------------------------------------------------------------
// 1. EDT vs brute force
// ---------------------------------------------------------------------------
console.log('\n[1] Euclidean distance transform')
for (const map of MAPS) {
  const edt = edtClearance(map.cells, { width: map.width, height: map.height, depth: 1 }, 999)
  let worst = 0
  for (let i = 0; i < edt.length; i += 1) {
    worst = Math.max(worst, Math.abs(edt[i] - map.clearance[i]))
  }
  check(`${map.name} 2D clearance matches builder`, worst < 1e-4, `max Δ ${worst.toExponential(2)}`)
}

{
  // Small 3D volume against a brute-force triple loop.
  const w = 9
  const h = 8
  const d = 5
  const cells = new Uint8Array(w * h * d)
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < cells.length; i += 1) if (rand() < 0.12) cells[i] = 1
  const fast = edtClearance(cells, { width: w, height: h, depth: d }, 999)
  let worst = 0
  for (let z = 0; z < d; z += 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let best = Number.POSITIVE_INFINITY
        for (let zz = 0; zz < d; zz += 1) {
          for (let yy = 0; yy < h; yy += 1) {
            for (let xx = 0; xx < w; xx += 1) {
              if (cells[zz * w * h + yy * w + xx] !== 1) continue
              best = Math.min(best, Math.hypot(xx - x, yy - y, zz - z))
            }
          }
        }
        const index = z * w * h + y * w + x
        worst = Math.max(worst, Math.abs(fast[index] - Math.min(best, 999)))
      }
    }
  }
  check('3D clearance matches brute force', worst < 1e-4, `max Δ ${worst.toExponential(2)}`)
}

// ---------------------------------------------------------------------------
// 2. step cost equivalence
// ---------------------------------------------------------------------------
console.log('\n[2] cost model equivalence')
{
  const cards = createDefaultCards()
  // Exercise the optional terms too, otherwise the default zeros hide a bug.
  cards.clearance = { enabled: true, value: 0.9 }
  cards.turn = { enabled: true, value: 0.45 }
  cards.diagonalBias = { enabled: true, value: 0.2 }
  const scale = lengthScale(cards)
  for (const map of MAPS) {
    const cost = costModelFrom(cards, { x: map.goal.x, y: map.goal.y, z: 0 }, scale)
    let worst = 0
    for (let y = 1; y < map.height - 1; y += 3) {
      for (let x = 1; x < map.width - 1; x += 3) {
        for (const dir of ALL_DIRS) {
          for (const previous of [8, 0, 1, 2, 5]) {
            const fromCards = gridStepCost(map, cards, x, y, dir, previous)
            const fromModel = stepCostOf(
              cost,
              map.clearance[y * map.width + x],
              dir,
              previous === 8 ? -1 : previous,
              2,
            )
            worst = Math.max(worst, Math.abs(fromCards - fromModel))
          }
        }
      }
    }
    check(`${map.name} step cost`, worst < 1e-9, `max Δ ${worst.toExponential(2)}`)

    // Heuristic: same octile distance, same weight, same tolerance.
    let hWorst = 0
    for (let y = 1; y < map.height - 1; y += 4) {
      for (let x = 1; x < map.width - 1; x += 4) {
        const cardH = heuristicOf(map, cards, x, y)
        const modelH =
          cost.heuristicWeight * cost.lengthScale *
          Math.max(0, octile(map.goal.x - x, map.goal.y - y, 0, cards.diagonal.enabled) - cost.goalTolerance)
        hWorst = Math.max(hWorst, Math.abs(cardH - modelH))
      }
    }
    check(`${map.name} heuristic`, hWorst < 1e-9, `max Δ ${hWorst.toExponential(2)}`)
  }
}

// ---------------------------------------------------------------------------
// 3. generic search vs frozen A*
// ---------------------------------------------------------------------------
console.log('\n[3] generic lattice A* vs frozen A*')
{
  for (const map of MAPS) {
    const cards = createDefaultCards()
    const order: never[] = []
    const frozen = planGraph(map, cards, order as never, SOLVER_BY_ID.astar)
    const lattice = gridLattice(map, cards, lengthScale(cards))
    const outcome = searchLattice(lattice, {
      mode: 'astar',
      start: { x: map.start.x, y: map.start.y, z: 0 },
      goal: { x: map.goal.x, y: map.goal.y, z: 0 },
    })
    const generic = polylineLength(outcome.path)
    check(
      `${map.name} same length`,
      outcome.found && Math.abs(generic - frozen.pathLength) < 1e-6,
      `generic ${generic.toFixed(4)} · frozen ${frozen.pathLength.toFixed(4)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 4. 3D goes over what 2D has to go around
// ---------------------------------------------------------------------------
console.log('\n[4] voxel space')
{
  const map = MAPS[0] // 凹槽: a C-shaped wall
  const cards = createDefaultCards()
  const depth = 12
  const isFrame = (x: number, y: number) =>
    x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1
  const volume = volumeFromMap(map, depth, (x, y, blocked) => {
    if (!blocked) return 0
    return isFrame(x, y) ? depth : 2 // interior walls are only 2 voxels tall
  })

  const twoD = searchLattice(gridLattice(map, cards, lengthScale(cards)), {
    mode: 'astar',
    start: { x: map.start.x, y: map.start.y, z: 0 },
    goal: { x: map.goal.x, y: map.goal.y, z: 0 },
  })
  const lattice3d = voxelLattice(volume, cards, lengthScale(cards), {
    x: map.goal.x,
    y: map.goal.y,
    z: 0,
  })
  const threeD = searchLattice(lattice3d, {
    mode: 'astar',
    start: { x: map.start.x + 0.5, y: map.start.y + 0.5, z: 0.5 },
    goal: { x: map.goal.x + 0.5, y: map.goal.y + 0.5, z: 0.5 },
  })

  const flat = polylineLength(twoD.path)
  const lifted = polylineLength(threeD.path)
  const maxZ = Math.max(...threeD.path.map((p) => p.z))
  check('2D detours around the C', twoD.found && flat > 30, `2D ${flat.toFixed(2)}`)
  check('3D flies over it', threeD.found && maxZ > 2, `3D ${lifted.toFixed(2)}, max z ${maxZ.toFixed(1)}`)
  check('3D is shorter', threeD.found && lifted < flat - 5, `Δ ${(flat - lifted).toFixed(2)}`)
}

// ---------------------------------------------------------------------------
// 5. analytic SDF
// ---------------------------------------------------------------------------
console.log('\n[5] continuous field')
{
  const space: FieldSpace = {
    dim: 2,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 30, z: 0 } },
    primitives: [
      { kind: 'disc', x: 12, y: 15, r: 3 },
      { kind: 'capsule', ax: 20, ay: 4, bx: 20, by: 12, r: 1.2 },
      { kind: 'box', x0: 26, y0: 16, x1: 30, y1: 26 },
    ],
  }

  // Closed-form checks: on the surface the distance is 0, and a point 5 units
  // to the right of a radius-3 disc is at 2.
  check('disc surface', Math.abs(signedDistance(space.primitives[0], { x: 15, y: 15, z: 0 })) < 1e-9)
  check(
    'disc clearance',
    Math.abs(fieldDistance(space, { x: 17, y: 15, z: 0 }) - 2) < 1e-9,
    String(fieldDistance(space, { x: 17, y: 15, z: 0 })),
  )
  check(
    'capsule clearance',
    Math.abs(fieldDistance(space, { x: 25, y: 8, z: 0 }) - 3.8) < 1e-9,
  )

  const cards = createDefaultCards()
  const lattice = fieldLattice(
    space,
    { resolution: 0.5, width: 80, height: 60 },
    cards,
    lengthScale(cards),
    { x: 38, y: 15, z: 0 },
  )
  const outcome = searchLattice(lattice, {
    mode: 'astar',
    start: { x: 2, y: 15, z: 0 },
    goal: { x: 38, y: 15, z: 0 },
  })
  const length = polylineLength(outcome.path)
  check('SDF lattice finds a route', outcome.found, `length ${length.toFixed(2)} m`)

  // Every sampled point on the route must be outside every primitive.
  let worstPenetration = 0
  for (const point of outcome.path) {
    worstPenetration = Math.min(worstPenetration, fieldDistance(space, point))
  }
  check('route keeps out of the primitives', worstPenetration >= -1e-9, `min sdf ${worstPenetration.toFixed(3)}`)

  // Resolution is a runtime knob: halving it must not change feasibility.
  const fine = fieldLattice(
    space,
    { resolution: 0.25, width: 160, height: 120 },
    cards,
    lengthScale(cards),
    { x: 38, y: 15, z: 0 },
  )
  const fineOutcome = searchLattice(fine, {
    mode: 'astar',
    start: { x: 2, y: 15, z: 0 },
    goal: { x: 38, y: 15, z: 0 },
  })
  // Resolution is a runtime choice, so the two runs are allowed to disagree on
  // length — a finer lattice hugs the obstacle more closely. What must hold is
  // that both are feasible against the analytic field.
  let finePenetration = 0
  for (let i = 1; i < fineOutcome.path.length; i += 1) {
    const a = fineOutcome.path[i - 1]
    const b = fineOutcome.path[i]
    for (let s = 0; s <= 8; s += 1) {
      const t = s / 8
      finePenetration = Math.min(
        finePenetration,
        fieldDistance(space, {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: 0,
        }),
      )
    }
  }
  check(
    'resolution only refines the answer',
    fineOutcome.found && finePenetration >= -1e-9,
    `0.5 m ${length.toFixed(2)} → 0.25 m ${polylineLength(fineOutcome.path).toFixed(2)}, min sdf ${finePenetration.toFixed(3)}`,
  )
}

// ---------------------------------------------------------------------------
// 6. the 2D lattice still refuses blocked nodes
// ---------------------------------------------------------------------------
console.log('\n[6] lattice guards')
{
  const map = MAPS[1]
  const cards = createDefaultCards()
  cards.collision = { enabled: true, value: 1 }
  const lattice = gridLattice(map, cards, lengthScale(cards))
  let blockedSeen = 0
  let leaked = 0
  for (let i = 0; i < lattice.length; i += 1) {
    if (!lattice.blocked(i)) continue
    blockedSeen += 1
    const cell: Vec3 = { x: 0, y: 0, z: 0 }
    lattice.cellOf(i, cell)
    if (!isBlocked(map, cards, cell.x, cell.y)) leaked += 1
  }
  check('blocked set matches isBlocked', blockedSeen > 0 && leaked === 0, `${blockedSeen} blocked, ${leaked} leaked`)

  // And nothing is blocked that isBlocked would allow — the sets must be equal,
  // not merely "ours is smaller".
  let missing = 0
  for (let y = 1; y < map.height - 1; y += 1) {
    for (let x = 1; x < map.width - 1; x += 1) {
      if (isBlocked(map, cards, x, y) && !lattice.blocked(y * map.width + x)) missing += 1
    }
  }
  check('nothing free that the radius forbids', missing === 0, `${missing} missing`)
  void DX
  void DY
  void ORTHO_DIRS
  void DIRS_2D
  void squaredEDT
  void buildVolume
  void makeLattice
  void cardValue
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
if (failures > 0) process.exitCode = 1
