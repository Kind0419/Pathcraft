/**
 * The 3D camera, round-tripped.
 *
 * Picking is only correct if `unprojectIn` is the exact inverse of what
 * `projectIn` drew. They were not the inverse of each other for several
 * releases — the forward pass stretched z by `Z_LIFT`, the inverse did not — and
 * the symptom was "I drag it here and it lands there", which looked like a
 * gesture bug and was a missing factor.
 *
 * So the pair gets asserted here instead of eyeballed in a browser. Everything
 * is pure maths, no canvas: this runs in Node in a few milliseconds.
 */
import {
  Z_LIFT,
  fitView,
  projectIn,
  unprojectIn,
  viewRay,
  type Bounds,
} from '../src/lib/projection'

const EPS = 1e-6

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function maxError(pairs: Array<[number, number]>): number {
  return pairs.reduce((worst, [a, b]) => Math.max(worst, Math.abs(a - b)), 0)
}

/** A volume with a non-square footprint, so an axis swap cannot hide. */
const bounds: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 26, y: 17, z: 6 } }

const WIDTH = 900
const HEIGHT = 620

/* --------------------------------------------------- 1. plane round-trip --- */

const planes = [0, 0.5, 1, 3, 5.5]
const pitches = [0.16, 0.42, 0.86, 1.2, 1.42]
const yaws = [-2.4, -0.66, 0, 0.9, 3.1]
const pans: Array<[number, number]> = [
  [0, 0],
  [63, -41],
  [-140, 88],
]

let worstRoundTrip = 0
for (const pitch of pitches) {
  for (const yaw of yaws) {
    for (const [panX, panY] of pans) {
      for (const zoom of [0.55, 1, 2.7]) {
        const frame = fitView(bounds, WIDTH, HEIGHT, yaw, pitch, zoom, panX, panY)
        for (const planeZ of planes) {
          // Sweep the picture, not just the centre: the error the old code had
          // grew with distance from the origin, so sampling one point would
          // have passed while every drop near the edge was off by half a cell.
          for (let i = 0; i <= 6; i += 1) {
            for (let j = 0; j <= 6; j += 1) {
              const sx = (WIDTH * i) / 6
              const sy = (HEIGHT * j) / 6
              const world = unprojectIn(frame, sx, sy, planeZ)
              const back = projectIn(frame, world)
              worstRoundTrip = Math.max(
                worstRoundTrip,
                Math.abs(back.x - sx),
                Math.abs(back.y - sy),
              )
            }
          }
        }
      }
    }
  }
}
check(
  'screen → world → screen stays put (0.05 px)',
  worstRoundTrip < 0.05,
  `worst ${worstRoundTrip.toExponential(2)} px over ${planes.length} planes × ${pitches.length} pitches × ${yaws.length} yaws`,
)

/* ------------------------------------------------- 2. world round-trip ----- */

let worstForward = 0
for (const pitch of pitches) {
  const frame = fitView(bounds, WIDTH, HEIGHT, -0.66, pitch, 1.3)
  for (const z of planes) {
    for (let x = 0; x <= bounds.max.x; x += 3.25) {
      for (let y = 0; y <= bounds.max.y; y += 3.4) {
        const world = { x, y, z }
        const at = projectIn(frame, world)
        const back = unprojectIn(frame, at.x, at.y, z)
        worstForward = Math.max(
          worstForward,
          Math.abs(back.x - x),
          Math.abs(back.y - y),
          Math.abs(back.z - z),
        )
      }
    }
  }
}
check('world → screen → world is exact (1e-6 cells)', worstForward < EPS, `worst ${worstForward.toExponential(2)}`)

/* ------------------------------------------------------- 3. the view ray --- */

// Marching along `viewRay` must keep the pixel. This is what `pickPoint` walks
// through the volume, so a lean that disagrees with the projection puts the
// start marker on a different voxel than the one under the cursor.
let worstRay = 0
for (const pitch of pitches) {
  for (const yaw of yaws) {
    const frame = fitView(bounds, WIDTH, HEIGHT, yaw, pitch, 1)
    const dir = viewRay(frame)
    const base = { x: 9.4, y: 6.1, z: 0.5 }
    const at = projectIn(frame, base)
    for (const t of [-4, -1.5, 0.75, 2, 5.5]) {
      const moved = projectIn(frame, {
        x: base.x + dir.x * t,
        y: base.y + dir.y * t,
        z: base.z + dir.z * t,
      })
      worstRay = Math.max(worstRay, Math.abs(moved.x - at.x), Math.abs(moved.y - at.y))
    }
  }
}
check('view ray holds the pixel (1e-6 px)', worstRay < EPS, `worst ${worstRay.toExponential(2)} px`)

/* --------------------------------------- 4. the bug this file exists for --- */

// Regression guard. If someone drops `Z_LIFT` from the inverse again, the
// round-trip above fails — but it fails with a number, which is easy to shrug
// at. Assert the size of that mistake so the failure is legible.
//
// The old inverse gave `ry_old = ry + z · (Z_LIFT − 1) · cot(pitch)`: a pure
// sideways drift along the screen-vertical, growing one-to-one with altitude.
// 0.19 cells per storey at the default pitch. That is small on the floor, which
// is exactly why it survived review, and it is a whole cell by the sixth.
const pitch = 0.86
const frame = fitView(bounds, WIDTH, HEIGHT, -0.66, pitch, 1)
const driftAt = (z: number) => z * (Z_LIFT - 1) * (frame.cp / frame.sp)
const screenDriftAt = (z: number) => driftAt(z) * frame.sp * frame.scale

check(
  'the old inverse did drift with altitude',
  driftAt(5.5) > 0.5,
  `${driftAt(0.5).toFixed(3)} cells at z = 0.5 → ${driftAt(5.5).toFixed(2)} cells at z = 5.5`,
)
check(
  'and that drift was visible on screen at the top layer (> 6 px)',
  screenDriftAt(5.5) > 6,
  `${screenDriftAt(0.5).toFixed(1)} px at z = 0.5 → ${screenDriftAt(5.5).toFixed(1)} px at z = 5.5`,
)

/* ------------------------------------------------ 5. drop lands on a cell --- */

// The acceptance criterion for the drag: the marker is drawn at the snapped
// cell, so the drop and the picture have to agree. Cell centres, projected and
// picked back, must resolve to the same cell.
const spacing = 1
let cellMisses = 0
let totalCells = 0
for (let cz = 0; cz <= 5; cz += 1) {
  const planeZ = cz * spacing + 0.5
  for (let cx = 0; cx < 26; cx += 1) {
    for (let cy = 0; cy < 17; cy += 1) {
      const centre = { x: cx + 0.5, y: cy + 0.5, z: planeZ }
      const at = projectIn(frame, centre)
      const back = unprojectIn(frame, at.x, at.y, planeZ)
      totalCells += 1
      if (
        Math.floor(back.x) !== cx ||
        Math.floor(back.y) !== cy ||
        Math.abs(back.z - planeZ) > EPS
      ) {
        cellMisses += 1
      }
    }
  }
}
check(
  'every snapped cell centre picks back to itself',
  cellMisses === 0,
  `${totalCells} cells across 6 layers`,
)

/* ---------------------------------------------------------------- done --- */

console.log(
  failures === 0
    ? `\nok — camera round-trips exactly (Z_LIFT ${Z_LIFT})`
    : `\n${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
